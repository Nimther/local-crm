---
phase: 05-webhook-processing-delivery-tracking
reviewed: 2026-07-09T14:55:53Z
depth: standard
files_reviewed: 63
files_reviewed_list:
  - apps/api/package.json
  - apps/api/src/__tests__/env-schema.test.ts
  - apps/api/src/env.ts
  - apps/api/src/modules/campaigns/__tests__/campaign-delivery-counters.test.ts
  - apps/api/src/modules/campaigns/campaign.repository.ts
  - apps/api/src/modules/campaigns/campaigns.routes.ts
  - apps/api/src/modules/tenancy/__tests__/sendgrid-key-webhook-provisioning.test.ts
  - apps/api/src/modules/tenancy/sendgrid-client.ts
  - apps/api/src/modules/tenancy/sendgrid-key.ts
  - apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts
  - apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts
  - apps/api/src/modules/webhooks/__tests__/webhook-warning-copy.test.ts
  - apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts
  - apps/api/src/modules/webhooks/enqueue.ts
  - apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts
  - apps/api/src/modules/webhooks/signature-verify.ts
  - apps/api/src/modules/webhooks/webhook-endpoint.repository.ts
  - apps/api/src/modules/webhooks/webhook-settings.routes.ts
  - apps/api/src/modules/webhooks/webhook-warning-copy.ts
  - apps/api/src/modules/webhooks/webhooks.routes.ts
  - apps/api/src/server.ts
  - apps/api/vitest.config.ts
  - apps/web/src/features/campaigns/CampaignDetailPage.tsx
  - apps/web/src/features/campaigns/CampaignProgress.tsx
  - apps/web/src/features/campaigns/api.ts
  - apps/web/src/features/onboarding/OnboardingChecklist.tsx
  - apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx
  - apps/web/src/features/sendgrid-key/__tests__/webhook-notice.test.ts
  - apps/web/src/features/sendgrid-key/webhook-notice.ts
  - apps/web/src/features/webhooks/webhook-health.api.ts
  - apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-status.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts
  - apps/worker/src/queues/send-dispatch.ts
  - apps/worker/src/queues/webhook-events.worker.ts
  - apps/worker/src/server.ts
  - docs/webhook-live-uat.md
  - packages/db/migrations/0020_send_events_partitioned.sql
  - packages/db/migrations/0021_webhook_endpoints.sql
  - packages/db/migrations/0022_sends_delivery_columns.sql
  - packages/db/migrations/0023_contacts_soft_bounce_streak.sql
  - packages/db/migrations/0024_campaigns_delivery_counters.sql
  - packages/db/migrations/0025_webhook_provision_error.sql
  - packages/db/migrations/meta/_journal.json
  - packages/db/src/index.ts
  - packages/db/src/schema/campaigns.ts
  - packages/db/src/schema/contacts.ts
  - packages/db/src/schema/send-events.ts
  - packages/db/src/schema/sends.ts
  - packages/db/src/schema/webhook-endpoints.ts
  - packages/delivery-core/src/__tests__/event-normalize.test.ts
  - packages/delivery-core/src/__tests__/send-mail.test.ts
  - packages/delivery-core/src/__tests__/send-status.test.ts
  - packages/delivery-core/src/__tests__/suppression-rules.test.ts
  - packages/delivery-core/src/event-normalize.ts
  - packages/delivery-core/src/index.ts
  - packages/delivery-core/src/send-mail.ts
  - packages/delivery-core/src/send-status.ts
  - packages/delivery-core/src/suppression-rules.ts
  - packages/shared-schemas/src/index.ts
  - packages/shared-schemas/src/queues.ts
  - packages/shared-schemas/src/webhook.ts
  - scripts/check-env.mjs
findings:
  critical: 0
  warning: 5
  info: 9
  total: 14
status: issues_found
---

# Phase 05: Code Review Report

**Reviewed:** 2026-07-09T14:55:53Z
**Depth:** standard
**Files Reviewed:** 63
**Status:** issues_found

## Summary

Re-review of Phase 05 (webhook processing & delivery tracking) after gap-closure round 4 (plan 05-12, https enforcement for the SendGrid webhook callback URL). All 63 changed source files were read in full, with particular attention to the round-4 additions: the `insecure_url` short-circuit in `sendgrid-webhook-provision.ts`, `WEBHOOK_INSECURE_URL_WARNING` copy, `PROVISION_ERROR_REASONS` recognition in `webhook-settings.routes.ts`, the `check-env.mjs` http warning, and the production non-https fail-fast in `apps/api/src/env.ts`.

The round-4 change itself is correctly wired end to end: the guard runs before the try block (a plain string test cannot throw), fires on connect, recheck, AND reconnect (all three flow through `provisionEventWebhook`), the stored `insecure_url` reason round-trips through the health endpoint to the curated copy, and the vitest config pins a deterministic https `PUBLIC_APP_URL` so test outcomes no longer depend on the developer machine's `.env`. The webhook receiver's security posture is sound (raw-body capture before signature verification, fail-closed 400, enumeration-safe 404s, workspace resolved from the pathToken rather than the payload), and the worker's dedup + first-write-wins fact columns + exactly-once counters are correct, including intra-batch duplicate handling (`ON CONFLICT DO NOTHING` tolerates same-command conflicts) and the parameterized multi-row insert.

No Critical findings. Five Warnings — most notably a webhook replay window that can spoof the delivery-health signal, an unenforced single-row invariant on `workspace_webhook_endpoints` that concurrent connect/recheck/reconnect requests can violate, and two residual misconfiguration paths (case-variant schemes, trailing-slash `PUBLIC_APP_URL`) that reproduce exactly the "provisionStatus active but nothing works" failure class round 4 was closing.

## Warnings

### WR-01: No webhook timestamp freshness check — replayed signed requests spoof the delivery-health signal

**File:** `apps/api/src/modules/webhooks/webhooks.routes.ts:61` (and `apps/worker/src/queues/webhook-events.worker.ts:287-294`)
**Issue:** `verifyWebhookSignature` verifies the ECDSA signature over `timestamp + rawBody` but never checks the timestamp's freshness. Anyone who ever observed one legitimately signed request (tunnel logs during the live UAT, proxy logs, a compromised intermediary) can replay it forever: the request passes verification, returns 200, and is enqueued. The `ON CONFLICT DO NOTHING` dedup makes the `send_events` insert a no-op, but `debounceWebhookHealth` still runs unconditionally per batch and refreshes `last_event_at` — so the webhook-health card ("Последнее событие получено: …") and the onboarding checklist can be kept looking healthy indefinitely by replaying a months-old capture, masking a genuinely dead webhook. Replays also consume queue/DB resources for free.
**Fix:** After signature verification, reject requests whose timestamp is outside a tolerance window:
```ts
const MAX_SKEW_SECONDS = 600;
if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) {
  return reply.code(400).send();
}
```
Alternatively (or additionally), only run `debounceWebhookHealth` when `insertedRows.length > 0` so replayed batches cannot refresh the health signal.

### WR-02: `upsertWebhookEndpoint` SELECT-then-branch race — the single-row-per-workspace invariant is not enforced anywhere

**File:** `apps/api/src/modules/webhooks/webhook-endpoint.repository.ts:100-145` (and `packages/db/migrations/0021_webhook_endpoints.sql:6-17`)
**Issue:** The doc-comment justifies the non-atomic SELECT-then-INSERT/UPDATE with "provisioning is only ever triggered synchronously from a single connect/recheck HTTP request for a given workspace, never concurrently" — but nothing enforces that. Three routes call it (key connect, key recheck, webhook-reconnect), and two Owner/Admin sessions (or one user in two tabs; the UI's `isPending` disable is per-tab) can race. Both transactions SELECT zero rows, both INSERT, and the workspace ends up with two endpoint rows carrying different `pathToken`s. `getWebhookEndpointByWorkspace` then returns `rows[0]` with no `ORDER BY` — an arbitrary row — so health/reconnect may read/patch the stale row while SendGrid delivers to the other one, and subsequent reconnects can flip-flop between tokens.
**Fix:** Add a DB-level invariant and make the write atomic:
```sql
ALTER TABLE workspace_webhook_endpoints
  ADD CONSTRAINT workspace_webhook_endpoints_workspace_unique UNIQUE (workspace_id);
```
```sql
INSERT INTO workspace_webhook_endpoints (...)
VALUES (...)
ON CONFLICT (workspace_id) DO UPDATE SET path_token = EXCLUDED.path_token, ...
```

### WR-03: Scheme checks are case-sensitive and mutually inconsistent across the three 05-12 guard layers

**File:** `apps/api/src/env.ts:60`, `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:289`
**Issue:** URL schemes are case-insensitive, and Zod's `z.string().url()` accepts mixed-case schemes. The three guards disagree:
- `env.ts` uses `val.PUBLIC_APP_URL.startsWith("http://")` — `PUBLIC_APP_URL=HTTP://app.example.com` bypasses the production fail-fast entirely.
- `sendgrid-webhook-provision.ts` uses `!callbackUrl.startsWith("https://")` — `Https://…` (or any non-http scheme Zod's url check tolerates) is misclassified as `insecure_url`, and the user-facing copy then falsely claims the URL "использует http".
- `scripts/check-env.mjs:112` correctly uses a case-insensitive regex (`/^http:\/\//i`), so the dev-time warning fires where the production hard-fail does not — the strictest environment has the weakest check.
**Fix:** Normalize in both TypeScript guards, e.g.:
```ts
const isHttps = (u: string) => { try { return new URL(u).protocol === "https:"; } catch { return false; } };
// env.ts:      if (val.NODE_ENV === "production" && !isHttps(val.PUBLIC_APP_URL)) { ... }
// provisioning: if (!isHttps(callbackUrl)) return { error: "insecure_url" };
```

### WR-04: `provisionWebhookBestEffort`'s outer catch swallows the exception with zero logging and can leave stale endpoint state

**File:** `apps/api/src/modules/tenancy/sendgrid-key.ts:91-94`
**Issue:** The defense-in-depth catch exists specifically for "a bug in the endpoint-repository writes" — yet when that exact failure occurs, the error is discarded (`catch { return WEBHOOK_PROVISION_FAILED_WARNING; }`): no log line, no persisted `provisionStatus: 'error'`. An operator sees the generic warning in the UI with nothing in the logs to diagnose — the same L2 silent-failure class 05-08 explicitly closed for non-ok SendGrid responses. Worse, if the repository write failed after a previously successful provision, the row can still read `provisionStatus: 'active'` while the user was just told provisioning failed — the health card and the toast contradict each other.
**Fix:**
```ts
} catch (err) {
  // eslint-disable-next-line no-console
  console.error("provisionWebhookBestEffort failed:", err instanceof Error ? err.message : err);
  return WEBHOOK_PROVISION_FAILED_WARNING;
}
```
(Redact `apiKey` from the message the same way `sendgrid-webhook-provision.ts`'s `redactApiKey` does; see also IN-03 for using pino instead of console.)

### WR-05: Trailing slash in `PUBLIC_APP_URL` produces a `//webhooks/...` callback that 404s on every delivery while status reports 'active'

**File:** `apps/api/src/modules/tenancy/sendgrid-key.ts:63`, `apps/api/src/modules/webhooks/webhook-settings.routes.ts:114`
**Issue:** `callbackUrl = \`${env.PUBLIC_APP_URL}/webhooks/sendgrid/${pathToken}\`` — with `PUBLIC_APP_URL=https://host/` (a trivially common paste error; the runbook only *documents* "no trailing slash" in Step 2, nothing enforces it) the provisioned URL is `https://host//webhooks/sendgrid/<token>`. SendGrid accepts it (a valid https URL), provisioning succeeds, `provisionStatus` becomes `active` — but Fastify's router does not ignore duplicate slashes by default (`ignoreDuplicateSlashes` is unset in `server.ts:38`), so every event delivery 404s. This silently reproduces the exact failure signature of the round-4 UAT gap (healthy-looking provisioning, zero events), one config typo away.
**Fix:** Normalize once where the callback is built (both call sites, or a small shared helper):
```ts
const base = env.PUBLIC_APP_URL.replace(/\/+$/, "");
const callbackUrl = `${base}/webhooks/sendgrid/${pathToken}`;
```
Optionally also reject a trailing slash in `env.ts`'s superRefine and/or set `ignoreDuplicateSlashes: true` in the router options.

## Info

### IN-01: `PROVISION_ERROR_REASONS` is a hand-maintained mirror of the `ProvisionEventWebhookError` union

**File:** `apps/api/src/modules/webhooks/webhook-settings.routes.ts:15-20`
**Issue:** `ReadonlySet<ProvisionEventWebhookError>` type-checks even if the set contains a *subset* of the union — a future fifth error reason added to `sendgrid-webhook-provision.ts` would compile cleanly while `provisionErrorMessage` silently returns `null` for it in the health endpoint (round 4 had to remember to add `insecure_url` here by hand; the next reason may not be remembered).
**Fix:** Derive membership exhaustively: `const REASONS: Record<ProvisionEventWebhookError, true> = { missing_scope: true, cap_reached: true, failed: true, insecure_url: true };` — a missing key becomes a compile error — then check `value in REASONS`.

### IN-02: `createWebhook`'s reuse-path PATCH discards the `recoverable` marker

**File:** `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:178-182`
**Issue:** When a friendly-name-matched webhook's URL is stale, `createWebhook` returns `patchWebhook(...)` directly. If that webhook was deleted between the LIST and the PATCH (404), the result carries `recoverable: true` but no caller of `createWebhook` inspects it — provisioning fails with `failed` instead of falling through to a fresh CREATE the way the stored-id path (lines 296-302) does. Rare TOCTOU; self-heals on the next reconnect.
**Fix:** Handle the recoverable 404 inside `createWebhook`'s reuse branch by falling through to the POST-create path instead of returning the error.

### IN-03: `console.warn`/`console.error` in an app served by pino

**File:** `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:103,318`
**Issue:** The API's logging is pino (`server.ts` `loggerInstance: logger`); these provisioning diagnostics bypass it — no level, no timestamp/JSON structure, invisible to any log pipeline filtering on the pino stream. These are precisely the lines an operator needs when following the runbook's "check the API process logs" step.
**Fix:** Accept a logger parameter (or use a module-level pino child) and log via `log.warn({ status, body }, "provisionEventWebhook non-ok response")`.

### IN-04: `check-env.mjs` does not strip surrounding quotes, so quoted values evade both PUBLIC_APP_URL warnings

**File:** `scripts/check-env.mjs:34-36,94-123`
**Issue:** dotenv-style `.env` files commonly quote values (`PUBLIC_APP_URL="http://localhost:4000"`), and Node's own `--env-file`/`loadEnvFile` strip the quotes — but this hand parser keeps them, so `publicAppUrl` starts with `"` and neither the localhost regex nor the new `/^http:\/\//i` check fires. The loud pre-dev warning this gap-closure added is silently skipped for a perfectly ordinary `.env` style.
**Fix:** `const value = trimmed.slice(eqIndex + 1).trim().replace(/^(['"])(.*)\1$/, "$2");`

### IN-05: `WEBHOOK_INSECURE_URL_WARNING` surfaces operator internals to tenant-facing UI

**File:** `apps/api/src/modules/webhooks/webhook-warning-copy.ts:25-26`
**Issue:** The copy names the platform's env var (`PUBLIC_APP_URL`), instructs a server restart, and cites a repo-internal doc path (`docs/webhook-live-uat.md`) — and it is returned by the member-readable health endpoint to any workspace member. Appropriate for the current self-hosted/UAT stage, but in a multi-tenant SaaS deployment this is deployment-configuration disclosure to customers who cannot act on it.
**Fix:** Keep the actionable detail in server logs; show tenants a shorter "адрес приложения настроен без https — обратитесь к администратору платформы" style message (or gate the detailed copy on a deployment flag).

### IN-06: Unchecked cast of a free-text DB column into the response enum

**File:** `apps/api/src/modules/webhooks/webhook-settings.routes.ts:73`
**Issue:** `endpoint.provisionStatus as WebhookHealthResponse["provisionStatus"]` — `provision_status` is `text` in Postgres; any unexpected stored value flows straight into a response the shared schema declares as `z.enum(["pending","active","error"])`, silently violating the contract clients (e.g. `KeyStatusBadge` branching, `OnboardingChecklist`'s `provisionStatus === "active"` check) rely on.
**Fix:** Validate/normalize: map unknown values to `"pending"`, or parse the response body with `webhookHealthResponseSchema` before sending.

### IN-07: Public webhook receiver has no rate limiting

**File:** `apps/api/src/modules/webhooks/webhooks.routes.ts:46` (and `apps/api/src/server.ts:47`)
**Issue:** `@fastify/rate-limit` is registered `global: false` and this route does not opt in. Every POST — including garbage tokens from an unauthenticated internet scanner — costs a pooled-connection DB transaction (`findWebhookEndpointByToken`) before the 404. Signature verification protects integrity but not resource consumption.
**Fix:** Opt the route into `config: { rateLimit: { ... } }` with a generous ceiling keyed by IP (SendGrid's own delivery cadence is modest).

### IN-08: `removeOnFail: false` retains failed webhook jobs in Redis indefinitely

**File:** `apps/api/src/modules/webhooks/enqueue.ts:47`
**Issue:** After 5 exhausted attempts, permanently failed batches accumulate in the failed set with no age/count bound — unbounded Redis growth with no cleanup/inspection story wired yet (no bull-board is registered).
**Fix:** `removeOnFail: { age: 7 * 86400, count: 5000 }` — retain enough for diagnosis, bounded.

### IN-09: `send_events` pre-creates only 2026-07/2026-08 partitions; the DEFAULT partition becomes a trap after August

**File:** `packages/db/migrations/0020_send_events_partitioned.sql:52-63`
**Issue:** From 2026-09-01 every event lands in `send_events_default`. Correctness is preserved (the CR-03 lesson), but once DEFAULT holds September rows, attaching a monthly partition covering that range fails until those rows are moved out under lock — the longer the acknowledged operational follow-up slips, the more expensive it gets, and this is the fastest-growing table in the system (CLAUDE.md calls monthly partitioning of event tables the highest-leverage decision at target scale).
**Fix:** Track the partition-rollover job (pg_partman or a scheduled migration) as a hard pre-GA item with a deadline before 2026-09-01; pre-create several more months now as cheap insurance.

---

_Reviewed: 2026-07-09T14:55:53Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
