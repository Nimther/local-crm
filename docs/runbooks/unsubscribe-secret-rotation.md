# Unsubscribe Secret Rotation Runbook

Implements requirements **ROT-01** and **ROT-02** and decisions **D-06**
through **D-09**
(`.planning/phases/19-unsubscribe-secret-graceful-rotation/19-CONTEXT.md`).
This is the reference for putting a new `UNSUBSCRIBE_TOKEN_SECRET` into
service without breaking a single already-mailed unsubscribe link — what to
change, in what order, and how to prove it worked before calling the
rotation done.

**This file does not cover** the SendGrid Event Webhook's own ECDSA signing
key, the platform SendGrid mail key (`PLATFORM_SENDGRID_API_KEY`), or any
tenant's BYO SendGrid key — none of those participate in the mechanism
below. **There is no automated rotation.** Nothing in this codebase rotates
`UNSUBSCRIBE_TOKEN_SECRET` on a schedule or in response to an event; this
runbook — an operator changing two environment variables and restarting
both services, in the order below — **is** the rotation mechanism.

## Why rotation is safe here

Signing always uses the primary secret only: `signUnsubscribeToken` reads
`UNSUBSCRIBE_TOKEN_SECRET` via `getPrimarySecret()` and never touches the
previous-secrets list. Verification tries the primary first, then each
secret in `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` in list order
(`verifyUnsubscribeToken`'s candidate loop,
`packages/delivery-core/src/unsubscribe-token.ts`) — so a link signed with a
now-retired secret still verifies as long as that secret is still listed.
Already-mailed links carry a **5-year TTL**
(`UNSUBSCRIBE_TOKEN_TTL_SECONDS`), so a retired secret must outlive the last
token it ever signed as primary — this is D-06's retention rule, below.

Both `apps/api` and `apps/worker` read `UNSUBSCRIBE_TOKEN_SECRET` and
`UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` from `process.env` **at boot only** —
there is no live-reload path for either variable. This is why every step
below ends in a restart: changing the environment file alone does nothing
to an already-running process.

## Prerequisites

- The environment file's real location is resolved outside this repository's
  working root (`scripts/env-path.mjs`'s `MEGA_CRM_ENV_FILE` convention,
  SPECIFICATION.md §3.1) — this runbook edits that file, never
  `docker/prod.env.example` itself.
- **API and worker must receive identical values** for both
  `UNSUBSCRIBE_TOKEN_SECRET` and `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS`. Both
  processes read the same `MEGA_CRM_ENV_FILE` via `env_file:` in
  `docker/docker-compose.prod.yml`, so this holds automatically as long as
  you edit that one file and restart both services — never set one only on
  `api` or only on `worker`.
- A new secret must be **at least 32 characters**, contain **no comma and no
  whitespace**, and **differ from the primary and from every existing
  previous-list entry**.
- At most **5 entries** (`MAX_UNSUBSCRIBE_PREVIOUS_SECRETS`) may be retained
  in `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` at once.

A violation of any rule above fails the affected process **at boot**, not at
first use — never silently accepted and only discovered when a link fails
to verify. All three sites enforce it independently:
`apps/api/src/env.ts`'s `superRefine`, `apps/worker/src/server.ts`'s
exported `assertUnsubscribeTokenSecrets()`, and `scripts/check-env.mjs`
(dev-only, `predev`).

## Step 1 — make the new secret verifiable everywhere

Generate the new secret (32+ random characters, no comma, no whitespace).
Append it to `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` — comma-separated, ordered
— in `MEGA_CRM_ENV_FILE`, on **every** service: both `api` and `worker`.
Restart both:

```bash
docker compose -f docker/docker-compose.prod.yml up -d --no-deps api
docker compose -f docker/docker-compose.prod.yml up -d --no-deps worker
```

Nothing signs with the new secret yet — `UNSUBSCRIBE_TOKEN_SECRET` (the
primary) is unchanged. After this step, every process can **verify** the
new secret, but nothing has ever mailed a link signed with it. This is the
invariant this step buys: **at no point is there a secret that some process
can verify and another cannot.**

## Step 2 — promote

Edit `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` and `UNSUBSCRIBE_TOKEN_SECRET`
**together, in the same file edit** — do not restart between these three
changes:

1. **Remove the new secret** (the one appended in Step 1) from
   `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS`.
2. Move the **current** primary (`UNSUBSCRIBE_TOKEN_SECRET`'s existing
   value) into `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS`, in the slot the new
   secret just vacated (prepend or append — list order does not affect
   correctness, only which candidate the loop tries first).
3. Set the new secret (from Step 1) as the new `UNSUBSCRIBE_TOKEN_SECRET`.

**A secret must never appear as both the primary and a previous-list entry
at the same time.** All three boot validators (see Prerequisites, above)
reject that configuration by design — skipping step 1 above, or doing it
out of order relative to steps 2–3, leaves the new primary duplicated in
`UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` and crash-loops both `api` and `worker`
on the restart below.

Restart every service again, same two commands as Step 1.

**Do this only after Step 1 has been applied and restarted on every
service.** Promoting the new primary before every process can already
verify it creates exactly the window this two-step procedure exists to
eliminate: a link mailed with the new primary, arriving at a process that
has not yet restarted with the new `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS`
entry, would fail to verify on redemption even though it was validly
signed.

## Step 3 — canary smoke of both link eras (D-09)

**Before Step 2**, capture a pre-rotation unsubscribe link from the
standing canary workspace (`fe8fbbc6-6b25-490b-b3f5-7c739e325c9a` — confirm
its current display name/slug directly in the workspace UI; the id is
stable). Do this **before** starting Step 2 — once the primary is promoted,
the canary's most recently sent link may already carry the new primary's
signature, and a link signed under the *old* primary is exactly what this
smoke needs to hold onto. The easiest capture point is an already-delivered
email still sitting in the operator's own inbox from before the rotation
began; if none exists, trigger one more send under the old primary
specifically for this purpose before Step 2.

After Step 2 completes and both services have restarted:

1. **Redeem a freshly generated post-rotation link.** Trigger a new send to
   the canary contact (or use any link already mailed after Step 2), open
   it, and confirm the canary contact's subscription status changes to
   unsubscribed. This proves the new primary both signs and verifies.
2. **Redeem the retained pre-rotation link, for a second canary contact.**
   Use the link captured before Step 2, against a contact that was still
   subscribed going into this smoke. Confirm its status also changes to
   unsubscribed.

The second redemption is the only real-path proof that previous-secret
verification actually works end to end — the first redemption alone would
pass even if the previous-secrets list were silently empty. **The smoke is
incomplete without it.**

## Evidence and the retirement decision

A successful verification via a non-primary secret emits exactly one
structured log line, carrying the matched list position and no secret
material:

```
{ secretPosition: <1-based position in UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS> }
"unsubscribe token verified via previous secret"
```

A primary-secret match emits no such line. Query for it the same way any
other structured log line is queried in this deployment's log-shipping
pipeline (`docs/observability/grafana-cloud-alerts.md`):

```
{service="api"} |= "unsubscribe token verified via previous secret"
```

**D-06 (retention rule):** a previous secret is retained until **5 years
after its last use as primary** — the TTL of the last token it ever signed.
**D-07 (recording/enforcement split):** the rule itself and each secret's
retirement date live in documentation — this runbook's rotation log below
and SPECIFICATION.md §3.7 — never in the environment; code enforces only
the maximum-list-length bound (`MAX_UNSUBSCRIBE_PREVIOUS_SECRETS = 5`).

This log line is what turns pruning from a calendar-only decision into an
evidence-based one: an operator can query it before removing a secret from
`UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS`. Seeing zero previous-slot
verifications for a given secret is a **necessary but not sufficient**
condition for pruning it before its 5-year window elapses — the absence of
observed traffic does not shorten the published retention window on its
own; a link can sit unopened in a mailbox for years and still be valid.

## Rotation log

No secret value is ever written in this table — slot identifiers and dates
only.

| Slot | Became primary | Demoted to previous | Earliest prune date (demotion + 5y) | Pruned |
|------|-----------------|----------------------|---------------------------------------|--------|
| example — secret-A | 2026-01-15 | 2026-08-21 | 2031-08-21 | — |

## Rollback

**A restart fails validation at boot.** The process refuses to start and
the failure names the offending variable and the specific rule it violated
(see Prerequisites — all three validation sites produce a descriptive
message, never a secret value). Correct the value in `MEGA_CRM_ENV_FILE`
and restart the affected service again.

**Promotion (Step 2) has already happened and must be undone.** Swap the
two values back: restore the previous `UNSUBSCRIBE_TOKEN_SECRET` as primary
and move the just-promoted secret back into
`UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS`. Restart every service. Because the old
primary was moved into the previous list during Step 2 rather than
discarded, it is still present and verifiable at this point — **no link is
ever invalidated by this reversal.**

## Verification of this runbook

`npm run check:runbook-coverage` does **not** and **cannot** cover this
file — that gate enumerates ops alert-name constants only
(`scripts/check-runbook-coverage.mjs`'s own header comment explicitly warns
future readers not to extend it to runbooks like this one). This runbook is
verified by review and by the canary smoke in Step 3, the same standard
`docs/runbooks/backups.md`, `docs/runbooks/restore-drill.md`,
`docs/runbooks/migration-rollback-and-roll-forward.md`, and
`docs/runbooks/data-retention.md` are held to.
