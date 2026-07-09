---
phase: 05-webhook-processing-delivery-tracking
reviewed: 2026-07-09T17:45:55Z
depth: standard
files_reviewed: 68
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
  - apps/worker/src/queues/__tests__/webhook-events-attribution.test.ts
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
  warning: 10
  info: 11
  total: 21
status: issues_found
---

# Phase 05: Code Review Report

**Reviewed:** 2026-07-09T17:45:55Z
**Depth:** standard
**Files Reviewed:** 68
**Status:** issues_found

## Summary

Re-review of Phase 05 (webhook processing & delivery tracking) after gap-closure round 5 (plan 05-13, flattened webhook custom-arg attribution). All 68 changed source files were read in full, with particular attention to the round-5 change: `extractEventRow` now reads `send_id` from the event object's TOP LEVEL (SendGrid's real flattened shape, confirmed against live UAT payloads) with the nested `custom_args` read retained as a fallback, plus the new `webhook-events-attribution.test.ts` suite exercising the verbatim flattened shape end to end.

The round-5 change itself is correctly implemented: attribution resolves against the flattened `send_id`, UUID-shape validation prevents a 22P02 batch abort, non-live send ids are nulled before the FK insert, and the three attribution tests prove fact columns and campaign counters now fire for real payloads. The receiver's security posture remains sound (raw-body Buffer capture in an encapsulated plugin scope, ECDSA verification before any `JSON.parse`, fail-closed 400s, enumeration-safe 404s, workspaceId from the pathToken never the payload), and the worker's dedup insert + first-write-wins fact columns + exactly-once counters are correct under BullMQ redelivery.

No Critical findings. Ten Warnings: the most significant new one is a direct consequence of the flattening work — the worker now *reads* the flattened `send_id` but still *ignores* the flattened `workspace_id`, so a shared-SendGrid-account setup (explicitly supported by the workspace-scoped `friendly_name` design) persists workspace A's raw event payloads into workspace B's `send_events`. Also new: a 401-vs-403 misclassification that gives users actively wrong remediation, an unguarded `suppressed -> unsubscribed` status downgrade, and worker UPDATEs relying on RLS alone contra the project's stated defense-in-depth convention. Five prior-round warnings (replay/health-signal spoof, endpoint upsert race, case-variant scheme guards, silent best-effort catch, trailing-slash callback) were re-verified against the current code and remain unfixed.

## Warnings

### WR-01: Worker stores foreign-workspace events when one SendGrid key backs multiple workspaces (flattened `workspace_id` is read by tests but never checked by the worker)

**File:** `apps/worker/src/queues/webhook-events.worker.ts:38-110, 323-395`
**Issue:** The platform explicitly supports connecting one BYO SendGrid key to multiple workspaces — that is the entire rationale for the workspace-scoped `friendly_name` (`sendgrid-webhook-provision.ts:19-27`) and its sibling-workspace test. SendGrid delivers **every** account event to **every** enabled Event Webhook, so workspace B's endpoint receives workspace A's events. Every platform send stamps a `workspace_id` custom arg (`send-mail.ts:62`) that arrives flattened on the event — the new attribution fixtures even include it — but `extractEventRow` never compares it against the receiving endpoint's workspace. Result: workspace A's raw payloads (recipient emails, bounce reasons, message ids) are permanently persisted into workspace B's `send_events` rows (side effects don't fire because A's `send_id` doesn't resolve in B, but the full `payload` jsonb is stored verbatim), and B's `last_event_at` health signal is refreshed by A's traffic. Workspaces are the platform's tenancy boundary; the doc comment for `send_events` already names the contact timeline as a future read surface, which would expose A's contact emails inside B.
**Fix:** Drop events whose flattened `workspace_id` marker is present and does not match the job's `workspaceId`:
```ts
const eventWorkspaceId =
  typeof event.workspace_id === "string"
    ? event.workspace_id
    : typeof customArgs?.workspace_id === "string" ? customArgs.workspace_id : undefined;
if (eventWorkspaceId && eventWorkspaceId !== expectedWorkspaceId) return null;
```
(Pass the job's workspaceId into `extractEventRow`. Events with no marker — a tenant's own non-platform traffic — keep the current store-with-null-send_id behavior.)

### WR-02: `upsertWebhookEndpoint` SELECT-then-branch race — the single-row-per-workspace invariant is not enforced anywhere

**File:** `apps/api/src/modules/webhooks/webhook-endpoint.repository.ts:100-145` (and `packages/db/migrations/0021_webhook_endpoints.sql:6-17`)
**Issue:** (Carried from the previous review round — still present.) The doc comment justifies the non-atomic SELECT-then-INSERT/UPDATE with "never concurrently," but nothing enforces that: three routes call it (key connect, key recheck, webhook-reconnect) and two Owner/Admin sessions (or one user in two tabs) can race. Both transactions SELECT zero rows, both INSERT — the workspace ends up with two endpoint rows carrying different `pathToken`s, and potentially two duplicate SendGrid webhooks (the second call's listing pre-flight may not see the first's just-created webhook). `getWebhookEndpointByWorkspace` then returns `rows[0]` of an **unordered** result, so health, reconnect, and the receiver can disagree about which endpoint is authoritative.
**Fix:** Add `UNIQUE (workspace_id)` in a follow-up migration and make the write atomic:
```sql
INSERT INTO workspace_webhook_endpoints (workspace_id, path_token, sendgrid_webhook_id, public_key, provision_status, provision_error)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (workspace_id) DO UPDATE SET
  path_token = EXCLUDED.path_token, sendgrid_webhook_id = EXCLUDED.sendgrid_webhook_id,
  public_key = EXCLUDED.public_key, provision_status = EXCLUDED.provision_status,
  provision_error = EXCLUDED.provision_error, updated_at = now()
```

### WR-03: No webhook timestamp freshness check — replayed signed requests spoof the delivery-health signal

**File:** `apps/api/src/modules/webhooks/webhooks.routes.ts:61`; `apps/worker/src/queues/webhook-events.worker.ts:297-305, 417-418`
**Issue:** (Carried — still present.) `verifyWebhookSignature` verifies the ECDSA signature over `timestamp + rawBody` but never checks freshness. Anyone who observed one legitimately signed request (tunnel/proxy logs during the live UAT) can replay it forever: it passes verification, returns 200, and is enqueued. The `ON CONFLICT DO NOTHING` dedup makes the insert a no-op, but `debounceWebhookHealth` runs unconditionally per batch — even when `insertedRows.length === 0` — so `last_event_at` (the webhook-health card and onboarding checklist signal) can be kept looking healthy indefinitely by replaying a months-old capture, masking a genuinely dead webhook.
**Fix:** Reject stale timestamps after verification (`Math.abs(Date.now()/1000 - Number(timestamp)) > 600 -> 400`), and/or only call `debounceWebhookHealth` when `insertedRows.length > 0`.

### WR-04: 401 responses are misclassified as `missing_scope` — a revoked key on reconnect yields actively wrong user guidance

**File:** `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:80-82`; `apps/api/src/modules/webhooks/webhook-settings.routes.ts:99-121`
**Issue:** `errorForStatus` maps both 401 and 403 to `"missing_scope"`. On connect/recheck the key was just validated, so 401 is unlikely there — but `POST /webhook-reconnect` never re-validates the stored key. A revoked/rotated key makes every SendGrid call return 401, which is persisted as `provisionError: 'missing_scope'` and rendered as WEBHOOK_MISSING_SCOPE_WARNING ("нет прав на управление вебхуками... Создайте ключ с правами Webhooks Settings") — telling the user to recreate the key with more scopes when the real problem is a dead key requiring a completely different action (reconnecting a valid key).
**Fix:** Split the mapping (`401 -> "invalid_key"` as a new `ProvisionEventWebhookError` member with its own copy; `403 -> "missing_scope"`), or have the reconnect route run `validateTenantSendGridKey(plaintext)` first (mirroring recheck) and short-circuit with the invalid-key copy.

### WR-05: `provisionWebhookBestEffort`'s outer catch swallows the exception with zero logging and can leave stale endpoint state

**File:** `apps/api/src/modules/tenancy/sendgrid-key.ts:91-94`
**Issue:** (Carried — still present.) The defense-in-depth catch exists specifically for "a bug in the endpoint-repository writes" — yet when that failure occurs, the error is discarded (`catch { return WEBHOOK_PROVISION_FAILED_WARNING; }`): no log line, no persisted `provisionStatus: 'error'`. This re-opens the silent-failure class 05-08 explicitly closed for non-ok SendGrid responses. If the repository write failed after a previously successful provision, the row can still read `provisionStatus: 'active'` while the user was just told provisioning failed — the health card and the toast contradict each other.
**Fix:**
```ts
} catch (err) {
  logger.error({ err: redactApiKey(err, apiKey), workspaceId }, "provisionWebhookBestEffort failed");
  return WEBHOOK_PROVISION_FAILED_WARNING;
}
```

### WR-06: `applyUnsubscribe` downgrades a `suppressed` contact to `unsubscribed` with no status guard

**File:** `apps/worker/src/queues/webhook-events.worker.ts:170-175` (also reachable via the `dropped`/`Unsubscribed Address` path at 265-271 and the unsubscribe branch at 285-293)
**Issue:** `UPDATE contacts SET subscription_status = 'unsubscribed' WHERE id = $1` runs unconditionally. A contact already `suppressed` (hard bounce / spam report — a deliverability-protection state) whose unsubscribe event arrives later (or out of order) is downgraded to plain `unsubscribed`. The `workspace_suppressions` row survives, so the pre-send gate likely still blocks by email — but the contact record now misrepresents its state, and any future resubscribe flow permitting `unsubscribed -> subscribed` would re-enable a hard-bounced address at the status level. The fact columns were carefully designed first-write-wins for exactly this out-of-order safety; the contact status writes were not.
**Fix:** `UPDATE contacts SET subscription_status = 'unsubscribed', updated_at = now() WHERE id = $1 AND subscription_status <> 'suppressed'`. (Suppression escalating over `unsubscribed` in `applySuppression` is the correct direction and can stay unconditional.)

### WR-07: Worker UPDATE statements rely on RLS alone — no application-level `workspace_id` predicate, contra the project convention

**File:** `apps/worker/src/queues/webhook-events.worker.ts:119-139, 149-175, 237-241`
**Issue:** `setFactColumnOnce` (`UPDATE sends ... WHERE id = $1`), `incrementCampaignCounter` (`UPDATE campaigns ... WHERE id = $1`), and `applySuppression`/`applyUnsubscribe`/the soft-bounce streak increment (`UPDATE contacts ... WHERE id = $1`) all omit `workspace_id`. CLAUDE.md's "What NOT to Use" is explicit that RLS is "defense-in-depth on top of (not instead of) application-level filtering" — here RLS is the *sole* tenant guard on every write in the phase's highest-throughput path, while the SELECTs in the same file all include `workspace_id = $2`. The ids originate from workspace-scoped queries today, but one future call-site change turns any of these into a potential cross-tenant write. Secondarily, these helpers interpolate column names into SQL (`SET ${column} = ...`); all current call sites pass fixed literals, but nothing constrains the parameter type.
**Fix:** Thread `workspaceId` into each helper and add `AND workspace_id = $n` to every UPDATE; constrain `column` to a typed union of the known fact/counter column literals so the interpolation is provably closed.

### WR-08: Scheme checks are case-sensitive and mutually inconsistent across the three 05-12 guard layers

**File:** `apps/api/src/env.ts:60`; `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:289`; `scripts/check-env.mjs:112`
**Issue:** (Carried — still present.) URL schemes are case-insensitive and `z.string().url()` accepts mixed case. `env.ts` uses `startsWith("http://")` — `PUBLIC_APP_URL=HTTP://app.example.com` bypasses the production fail-fast entirely. `provisionEventWebhook` uses `!callbackUrl.startsWith("https://")` — a case-variant `Https://` URL is misclassified as `insecure_url` with copy that falsely claims the URL "использует http". Only `check-env.mjs` uses a case-insensitive regex — the strictest environment (production boot) has the weakest check. Fail-closed overall, but the layered guards disagree.
**Fix:** Normalize in both TypeScript guards: `new URL(u).protocol === "https:"` (wrapped in try/catch returning false).

### WR-09: Trailing slash in `PUBLIC_APP_URL` produces a `//webhooks/...` callback that 404s on every delivery while status reports 'active'

**File:** `apps/api/src/modules/tenancy/sendgrid-key.ts:63`; `apps/api/src/modules/webhooks/webhook-settings.routes.ts:114`
**Issue:** (Carried — still present.) `` `${env.PUBLIC_APP_URL}/webhooks/sendgrid/${pathToken}` `` with `PUBLIC_APP_URL=https://host/` (a trivially common paste error; the runbook only documents "no trailing slash", nothing enforces it) provisions `https://host//webhooks/sendgrid/<token>`. SendGrid accepts it, `provisionStatus` becomes `active` — but Fastify does not ignore duplicate slashes by default (`ignoreDuplicateSlashes` unset in `server.ts`), so every delivery 404s. This reproduces the exact "healthy-looking provisioning, zero events" failure signature rounds 4-5 were closing, one config typo away.
**Fix:** Normalize where the callback is built (shared helper): `env.PUBLIC_APP_URL.replace(/\/+$/, "")`; optionally reject a trailing slash in `env.ts`'s superRefine and/or set `ignoreDuplicateSlashes: true`.

### WR-10: Public webhook receiver has no rate limiting — unauthenticated per-request DB transaction

**File:** `apps/api/src/modules/webhooks/webhooks.routes.ts:46-84`; `apps/api/src/server.ts:47`
**Issue:** `@fastify/rate-limit` is registered `global: false` and this route does not opt in. Every POST — including garbage tokens from unauthenticated internet scanners — costs a pooled-connection DB transaction (`findWebhookEndpointByToken`: BEGIN / set_config / SELECT / COMMIT) before the 404, competing with real traffic for the shared pool; with a valid token, an ECDSA verification on up to 1 MB of body. Signature verification protects integrity, not resource consumption; CLAUDE.md explicitly positions `@fastify/rate-limit` as abuse protection for ingestion endpoints.
**Fix:** Opt the route into `config: { rateLimit: { max: 600, timeWindow: "1 minute" } }` (per-IP). SendGrid treats 429 as retryable and the DB dedup absorbs redelivery, so a briefly throttled legitimate burst is not lost.

## Info

### IN-01: `PROVISION_ERROR_REASONS` is a hand-maintained mirror of the `ProvisionEventWebhookError` union

**File:** `apps/api/src/modules/webhooks/webhook-settings.routes.ts:15-20`
**Issue:** `ReadonlySet<ProvisionEventWebhookError>` type-checks even for a *subset* of the union — a future fifth error reason compiles cleanly while `provisionErrorMessage` silently returns `null` for it in the health endpoint (round 4 had to remember to add `insecure_url` here by hand).
**Fix:** `const REASONS: Record<ProvisionEventWebhookError, true> = { missing_scope: true, cap_reached: true, failed: true, insecure_url: true };` — a missing key becomes a compile error — then check `value in REASONS`.

### IN-02: `createWebhook`'s reuse-path PATCH discards the `recoverable` marker

**File:** `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:178-182`
**Issue:** When a friendly-name-matched webhook's URL is stale, `createWebhook` returns `patchWebhook(...)` directly. If that webhook was deleted between LIST and PATCH (404), the result carries `recoverable: true` but no caller inspects it — provisioning fails with `failed` instead of falling through to a fresh CREATE the way the stored-id path (lines 296-302) does. Rare TOCTOU; self-heals on the next reconnect.
**Fix:** Handle the recoverable 404 inside `createWebhook`'s reuse branch by falling through to the POST-create path.

### IN-03: `console.warn`/`console.error` in an app served by pino

**File:** `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:103, 318`
**Issue:** The API's logging is pino (`server.ts` `loggerInstance`); these provisioning diagnostics bypass it — no level, no JSON structure, invisible to any pipeline filtering the pino stream. These are precisely the lines the runbook's "check the API process logs" step depends on.
**Fix:** Accept a logger parameter (or module-level pino child): `log.warn({ status, body }, "provisionEventWebhook non-ok response")`.

### IN-04: `check-env.mjs` does not strip surrounding quotes, so quoted values evade both PUBLIC_APP_URL warnings

**File:** `scripts/check-env.mjs:34-36, 94-123`
**Issue:** dotenv-style quoting (`PUBLIC_APP_URL="http://localhost:4000"`) keeps the quote characters in this hand parser (Node's own `loadEnvFile` strips them), so `publicAppUrl` starts with `"` and neither the localhost regex nor the `/^http:\/\//i` check fires — the loud pre-dev warning is silently skipped for an ordinary `.env` style.
**Fix:** `const value = trimmed.slice(eqIndex + 1).trim().replace(/^(['"])(.*)\1$/, "$2");`

### IN-05: `WEBHOOK_INSECURE_URL_WARNING` surfaces operator internals to tenant-facing UI

**File:** `apps/api/src/modules/webhooks/webhook-warning-copy.ts:25-26`
**Issue:** The copy names the platform env var (`PUBLIC_APP_URL`), instructs a server restart, and cites a repo-internal doc path — and is returned by the member-readable health endpoint to any workspace member. Appropriate for the current self-hosted/UAT stage; in a multi-tenant SaaS deployment this is deployment-configuration disclosure to customers who cannot act on it.
**Fix:** Keep the actionable detail in server logs; show tenants a shorter "обратитесь к администратору платформы" message (or gate the detailed copy on a deployment flag).

### IN-06: Unchecked cast of a free-text DB column into the response enum

**File:** `apps/api/src/modules/webhooks/webhook-settings.routes.ts:73`
**Issue:** `endpoint.provisionStatus as WebhookHealthResponse["provisionStatus"]` — `provision_status` is `text` in Postgres; any unexpected stored value flows straight into a response the shared schema declares as `z.enum(["pending","active","error"])`, silently violating the contract clients (`KeyStatusBadge` branching, `OnboardingChecklist`'s `=== "active"` check) rely on.
**Fix:** Map unknown values to `"pending"`, or parse the body with `webhookHealthResponseSchema` before sending.

### IN-07: `removeOnFail: false` retains failed webhook jobs (with raw event PII) in Redis indefinitely

**File:** `apps/api/src/modules/webhooks/enqueue.ts:47`
**Issue:** After 5 exhausted attempts, permanently failed batches — whose payloads contain full raw SendGrid event batches including recipient emails — accumulate in the failed set with no age/count bound and no bull-board wired yet for inspection/cleanup.
**Fix:** `removeOnFail: { age: 7 * 86400, count: 5000 }` — retain enough for diagnosis, bounded.

### IN-08: `send_events` pre-creates only 2026-07/2026-08 partitions; the DEFAULT partition becomes a trap after August

**File:** `packages/db/migrations/0020_send_events_partitioned.sql:52-63`
**Issue:** From 2026-09-01 every event lands in `send_events_default`. Correctness is preserved, but once DEFAULT holds September rows, attaching a monthly partition covering that range requires moving those rows out under lock — increasingly expensive on the fastest-growing table in the system (CLAUDE.md calls monthly partitioning of event tables the highest-leverage decision at target scale).
**Fix:** Track the partition-rollover job (pg_partman or a scheduled migration) as a hard pre-GA item with a deadline before 2026-09-01; pre-create several more months now as cheap insurance.

### IN-09: `normalizeEventType` doc comment contradicts actual storage behavior

**File:** `packages/delivery-core/src/event-normalize.ts:21-26`; `apps/worker/src/queues/webhook-events.worker.ts:326-395`
**Issue:** The doc says out-of-scope events (`processed`, `deferred`, ...) are acked and dropped, "never storing or acting on them" — but the worker inserts every extracted row into `send_events` regardless of `normalizedType` (only side effects are skipped). Provisioning doesn't subscribe to those types so they rarely arrive, but a tenant-modified webhook config would make them flow and be stored, contradicting the documented contract.
**Fix:** Align one side: skip-insert `normalizedType === null` rows in the worker, or correct the doc comment to "stored raw, no side effects."

### IN-10: `@sendgrid/eventwebhook` uses a caret range while the rest of the manifest pins exact versions

**File:** `apps/api/package.json:26`
**Issue:** `"@sendgrid/eventwebhook": "^8.0.0"` (and `fastify-plugin: ^5.0.1`) break the exact-pin convention every other production dependency follows — and this is the package performing signature verification, where an unreviewed transitive bump is worth avoiding most.
**Fix:** Pin to the exact installed version per the lockfile.

### IN-11: Web `CampaignResponse.createdByUserId` typed `string | null` while the API always returns a string

**File:** `apps/web/src/features/campaigns/api.ts:38`
**Issue:** The interface claims to mirror `toCampaignResponse` "field-for-field," but the server type is non-nullable (`campaign.repository.ts:27`, `created_by_user_id text NOT NULL`). Harmless today, but the hand-maintained mirror has already drifted once — evidence for moving this shape into `@mega-crm/shared-schemas` as the file's own comment anticipates.
**Fix:** Change to `createdByUserId: string;` or add a shared `campaignResponseSchema` and infer both sides from it.

---

_Reviewed: 2026-07-09T17:45:55Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
