# Webhook Lag Alert Runbook

Implements requirement **OPS-15** for the **webhook-lag** alert
(`apps/api/src/modules/ops/webhook-lag-watchdog.ts`, plan 15-14). Follow this
on receiving an email whose subject is "Mega CRM webhook-lag alert".

## What this alert means

Every 5 minutes (`WEBHOOK_LAG_WATCHDOG_INTERVAL_MS`), this watchdog answers
one question distinct from every other alert in this phase: **is delivery
evidence still arriving from SendGrid at all**, as opposed to
`ingestion-health-watchdog.ts`'s "is an already-arrived batch stuck
mid-processing." A system can be perfectly healthy by
`ingestion-health-watchdog.ts`'s own measure (nothing stuck) while SendGrid
has stopped sending webhooks entirely — there is nothing stuck to report
because nothing new is arriving to get stuck.

**The healthy-when-quiet rule is what makes this alert usable at all:** a
workspace with **no sends outstanding awaiting evidence** is not lagging, it
is idle — this alert never fires purely because a low-volume tenant hasn't
had a webhook in a while. Only once at least one send is genuinely
outstanding (`sends.reconciling_since` is non-null for some row, checked
platform-wide) does the age of the newest recorded webhook event become the
signal.

## What the email body's reasons correspond to

- `webhook events have never been recorded, but sends are outstanding
  awaiting delivery evidence` — no workspace has ever recorded a webhook
  receipt at all (`workspace_webhook_endpoints.last_event_at` is null for
  every row), yet at least one send is sitting in `reconciling`. This is the
  more urgent of the two reasons: it suggests webhook delivery has never
  worked, not merely stopped.
- `newest webhook event is <N>min old, exceeds threshold <T>min, with sends
  outstanding awaiting delivery evidence` — webhooks were arriving at some
  point, but the newest one recorded platform-wide is older than the
  threshold, while sends remain outstanding.

Neither reason names a specific workspace or send id (T-15-42) — this is a
platform-wide signal by design, because a single tenant's webhook endpoint
failure is exactly `failed-send-share-alert.md`'s and
`reprovision-webhook-event-types.md`'s own concern, addressed per-tenant;
this alert is the platform-wide backstop for the case where the receipt
mechanism itself has gone quiet.

## How to confirm the condition independently

**The exact platform-wide signal this watchdog reads:**

```bash
docker compose -f docker/docker-compose.prod.yml exec -T db \
  psql -U postgres -d mega_crm -c \
  "SELECT MAX(last_event_at) AS newest_webhook_event, now() - MAX(last_event_at) AS age
   FROM workspace_webhook_endpoints;"
```

Cross-reference against the outstanding-sends signal
(`oldest-job-age-alert.md`'s own confirmation query, same table):

```bash
docker compose -f docker/docker-compose.prod.yml exec -T db \
  psql -U postgres -d mega_crm -c \
  "SELECT COUNT(*), MIN(reconciling_since) FROM sends WHERE status = 'reconciling';"
```

If the second query returns zero rows, the alert should not be firing at
all under the healthy-when-quiet rule above — if you received this email
with zero outstanding sends, re-run both queries a few minutes apart before
suspecting a bug in the watchdog itself (the two reads are not
transactionally consistent with each other, so a narrow race at the exact
tick boundary is possible but should not persist).

## Recovery actions, least to most disruptive

1. **Check whether SendGrid's own Event Webhook is still provisioned and
   enabled for the affected tenant(s).** Cross-reference against
   [`docs/runbooks/reprovision-webhook-event-types.md`](reprovision-webhook-event-types.md)
   — this platform already has a self-healing Reconnect path for exactly
   this failure mode (a de-provisioned webhook, a revoked signing key, a
   suspended tenant account). If a specific tenant's webhook needs
   re-provisioning, that runbook's own procedure is the fix; this runbook
   does not duplicate it.

2. **Confirm the platform's own webhook receipt endpoint is reachable from
   the public internet** — SendGrid delivers webhooks over the open
   internet, so this is checking the platform's own edge, not SendGrid's
   side:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://<hostname>/webhooks/sendgrid/<workspace-path-token>
   ```
   A non-2xx/3xx/4xx-for-bad-payload response (a connection failure, a 5xx,
   a timeout) at the edge means Caddy or `apps/api` itself is the problem,
   not SendGrid or the tenant's configuration — check
   `docs/runbooks/deploy-and-rollback.md`'s post-deploy verification section
   for the same `/readyz` and container-health checks used after every
   deploy.

3. **Confirm `apps/worker`'s `webhook-events` queue is running and
   consuming** — a webhook batch can be verified and journaled by
   `apps/api` (which already returns 2xx to SendGrid at that point,
   independent of this queue) yet never actually update
   `last_event_at`/process delivery facts if the consuming worker is down:
   ```bash
   docker compose -f docker/docker-compose.prod.yml ps worker
   ```
   Combine with `queue-depth-alert.md`'s own recovery steps if the
   `webhook-events` lane itself is also reported as backed up.

4. **Most disruptive — a full webhook backfill/replay for the affected
   tenant(s)**, only after confirming both the endpoint and the worker are
   healthy again: `docs/runbooks/reprovision-webhook-event-types.md`'s own
   replay-sweep and operator-invoked replay path recover any batch that
   arrived while the pipeline was down, once it is back up. Do not attempt
   a manual, ad-hoc replay outside that documented mechanism.

## What to check afterwards to confirm recovery

- Re-run the `MAX(last_event_at)` query above; its age should drop back
  under the threshold as new webhook batches arrive.
- Re-run the `reconciling` count query; it should trend toward zero (or a
  small, recently-dispatched steady state) as the reconciler resolves the
  backlog against newly-arriving evidence.
- If `oldest-job-age-alert.md`'s `reconciling_since` reason had also fired,
  expect that alert to clear on its own next tick once this one resolves —
  the two share the same underlying `oldest_reconciling_since` read
  (`readOldestReconcilingSince`, reused by both watchdogs).

## How to tune the threshold

**`WEBHOOK_LAG_ALERT_MINUTES = 60`**
(`apps/api/src/modules/ops/webhook-lag-watchdog.ts`) — a first estimate
(15-14-PLAN.md's own flagged-assumption note). `debounceWebhookHealth`
writes `last_event_at` at most once per 60 seconds per workspace whenever a
batch arrives, so under genuinely healthy delivery this age should almost
never approach even a fraction of this threshold. It is set generously
enough to tolerate a quiet stretch between legitimately infrequent webhook
batches and a brief worker restart, while still catching a genuinely
stopped Event Webhook well within SendGrid's own ~24h retry window.

Tune this value only with evidence from real operation: raise it if a
legitimate quiet period (a small tenant, an overnight lull across the whole
platform) is producing false alarms with sends genuinely still outstanding;
lower it if a real webhook outage is observed to persist for a meaningful
fraction of the current window before this alert fires. Edit the constant
directly, with a rationale comment recording the observed evidence — never
a runtime setting.

The dedup window (`WEBHOOK_LAG_ALERT_DEDUP_HOURS = 6`) and poll interval
(`WEBHOOK_LAG_WATCHDOG_INTERVAL_MS`, 5 minutes) are separate constants in
the same file.

## Related runbooks

- `docs/runbooks/reprovision-webhook-event-types.md` — the self-healing
  reconnect and replay path for a specific tenant's webhook.
- `docs/runbooks/oldest-job-age-alert.md` — shares the platform-wide
  `reconciling_since` signal this alert also reads.
- `docs/runbooks/deploy-and-rollback.md` — post-deploy `/readyz` verification
  if the platform's own edge is suspected.
