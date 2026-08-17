# Failed Send Share Alert Runbook

Implements requirement **OPS-15** for the **failed-send-share** alert
(`apps/api/src/modules/ops/failed-send-share-watchdog.ts`, plan 15-14).
Follow this on receiving an email whose subject is "Mega CRM
failed-send-share alert".

## What this alert means

Every 15 minutes (`FAILED_SEND_SHARE_WATCHDOG_INTERVAL_MS`), this watchdog
measures the **share of terminal send attempts that failed**, over a rolling
6-hour window (`FAILED_SEND_SHARE_ROLLING_WINDOW_HOURS`), platform-wide. It
answers a different question than the other three OPS-13 alerts: not "is a
queue backing up" or "has delivery evidence stopped arriving," but **"of the
sends SendGrid actually attempted, what fraction did it reject."**

**The denominator is deliberately narrow.** Only `sent` and `failed` sends
count — `dispatching` (still in flight, or deliberately deferred under
per-tenant rate-limiter backpressure — normal operation, not a failure),
`reconciling`/`unknown` (still finding out, or ambiguous — counting either
here would double-count against `oldest-job-age-alert.md`'s own signal or
hide a genuine unresolved loss), and `excluded` (never reached SendGrid at
all — suppressed/unsubscribed/frequency-capped before the pre-send gate) are
all excluded from **both** sides of the ratio. This is why the alert body
only ever reports two integers and a percentage — there is no ambiguity
about what a "terminal send" means here.

**Below the minimum sample size, this alert is unconditionally healthy** —
a single unlucky bounce on a two-send tenant would otherwise be a 50%
"failure share" and trip this constantly.

## What the email body's reasons correspond to

- `failed-send-share: <failed>/<denominator> terminal sends failed
  (<share>%), exceeds threshold <threshold>%` — the only reason line this
  alert ever produces. `<failed>` and `<denominator>` (= `sent + failed`)
  are platform-wide counts over the rolling window; the email never names a
  specific workspace, contact, or send id (T-15-42) — **this alert cannot
  tell you, on its own, whether one tenant or many are responsible for the
  spike.** The per-workspace breakdown query below is how you find out.

## How to confirm the condition independently

**Reproduce the platform-wide ratio the watchdog computed** (adjust the
interval to roughly match `FAILED_SEND_SHARE_ROLLING_WINDOW_HOURS = 6`):

```bash
docker compose -f docker/docker-compose.prod.yml exec -T db \
  psql -U postgres -d mega_crm -c \
  "SELECT status, COUNT(*) FROM sends
   WHERE queued_at >= now() - interval '6 hours'
   GROUP BY status;"
```

Compute `failed / (sent + failed)` from the result and compare against the
threshold in the email.

**Find out whether this is one tenant or many** — the email body cannot
tell you this, so run the same query broken down by workspace:

```bash
docker compose -f docker/docker-compose.prod.yml exec -T db \
  psql -U postgres -d mega_crm -c \
  "SELECT workspace_id, status, COUNT(*) FROM sends
   WHERE queued_at >= now() - interval '6 hours'
     AND status IN ('sent', 'failed')
   GROUP BY workspace_id, status
   ORDER BY workspace_id;"
```

A failure share concentrated in one or two `workspace_id` values is a
tenant-specific problem (their key, their sender identity, their list
hygiene). A failure share spread evenly across many workspaces is a
platform-wide problem (a SendGrid account-level issue on the platform's own
side, or a shared dependency failing). **The recovery path differs
completely between these two cases** — read the breakdown before choosing
a recovery action below.

## Recovery actions, least to most disruptive

### If concentrated in one or a small number of workspaces (tenant-specific)

1. **Check that tenant's SendGrid account activity feed directly** (requires
   the tenant's own SendGrid credentials, or the tenant reporting the issue)
   for the actual rejection reason — a suspended sender, a de-verified
   domain, or a revoked API key all produce a burst of `failed` sends with
   different underlying causes that only SendGrid's own activity feed
   distinguishes.
2. **Verify the tenant's sender identity/domain is still verified** in
   their SendGrid account — a domain that fails DNS re-verification (an
   expired DKIM record, a changed DNS provider) causes every subsequent send
   to fail permanently until re-verified.
3. **Confirm the tenant's SendGrid API key has not been revoked or
   rate-limited by SendGrid itself** (as opposed to this platform's own
   per-tenant token-bucket throttling, which defers rather than fails a
   send — see `ARCHITECTURE.md` §10's tenant-fairness section for that
   distinction). A revoked key surfaces as a 401/403 from SendGrid on every
   attempt, which this platform's dispatch path records as `failed`.

### If spread across many workspaces (platform-wide)

1. **Check whether the platform's own SendGrid usage is itself
   affected** — this alert covers tenant BYO-key sends, but a broad,
   evenly-distributed failure spike suggests a shared-infrastructure cause:
   confirm outbound network connectivity from the VPS to
   `api.sendgrid.com`, and check SendGrid's own status page for a
   provider-side incident.
2. **Check recent deploys** (`docs/runbooks/deploy-and-rollback.md`) for a
   change to the dispatch path itself — a bug in `send-dispatch.ts`'s unit 2
   (the SendGrid call) that misclassifies a transient error as permanent
   would produce exactly this platform-wide pattern. If a recent deploy
   correlates with the onset, that deploy's own rollback procedure is the
   fastest recovery.
3. **Confirm Redis and Postgres themselves are healthy** — a dispatch path
   that cannot complete its own claim/record transaction due to a backing
   service problem can misclassify results in ways that inflate `failed`
   counts; `docs/runbooks/production-topology.md`'s health-check section is
   the starting point.

## What to check afterwards to confirm recovery

- Re-run the platform-wide ratio query above; the share should be trending
  back down toward baseline, not merely below threshold on a single query
  (a 6-hour rolling window moves slowly — recovery is gradual by
  construction, not instantaneous).
- Re-run the per-workspace breakdown; if the fix was tenant-specific,
  confirm that specific workspace's own share has dropped while others
  remain unaffected — a fix that reduces the platform-wide number without
  actually resolving the named tenant's problem is a coincidence, not a
  confirmed recovery.

## How to tune the threshold

Three related constants live together in
`apps/api/src/modules/ops/failed-send-share-watchdog.ts`, each a first
estimate (15-14-PLAN.md's own flagged-assumption note):

- **`FAILED_SEND_SHARE_ALERT_THRESHOLD = 0.1`** (10%) — chosen well above
  SendGrid's typical steady-state permanent-rejection rate for a verified
  sender with clean list hygiene, while still catching a real degradation
  long before it silently drains an entire campaign.
- **`FAILED_SEND_SHARE_MIN_SAMPLE_SIZE = 20`** — below this many terminal
  outcomes in the rolling window, the evaluation is unconditionally healthy
  regardless of the observed share. Raising this reduces false alarms on
  very-low-volume tenants at the cost of taking longer to notice a real
  problem on them; lowering it does the reverse.
- **`FAILED_SEND_SHARE_ROLLING_WINDOW_HOURS = 6`** — widening this smooths
  out short-lived spikes (fewer false alarms, slower detection); narrowing
  it does the reverse. `sends.status` reaches a terminal value almost
  immediately after SendGrid's synchronous response, so a much shorter
  window is technically viable if faster detection is worth the added
  noise from small-sample volatility.

Tune any of these only with evidence from real operation — a versioned edit
to the constant with a comment recording what evidence justified the
change, never a runtime setting. The dedup window
(`FAILED_SEND_SHARE_ALERT_DEDUP_HOURS = 6`) and poll interval
(`FAILED_SEND_SHARE_WATCHDOG_INTERVAL_MS`, 15 minutes) are separate
constants in the same file.

## Related runbooks

- `docs/runbooks/webhook-lag-alert.md` — a different signal (delivery
  *evidence* arriving, not send *attempts* failing outright).
- `docs/runbooks/reprovision-webhook-event-types.md` — if a tenant's
  webhook also needs attention alongside a send-failure investigation.
