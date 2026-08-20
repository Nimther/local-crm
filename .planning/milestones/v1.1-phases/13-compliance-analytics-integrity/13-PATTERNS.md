# Phase 13: Compliance & Analytics Integrity - Pattern Map

**Mapped:** 2026-08-11
**Files analyzed:** 17
**Analogs found:** 17 / 17

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `packages/delivery-core/src/unsubscribe-apply.ts` (NEW) | service | request-response (tx helper) | `apps/api/src/modules/delivery/unsubscribe.routes.ts` (tx block, lines 191-219) + `apps/worker/src/queues/webhook-events.worker.ts` `applyUnsubscribe`/`setFactColumnOnce` | exact (merges two existing call sites) |
| `apps/api/src/modules/delivery/unsubscribe.routes.ts` (MODIFIED) | route | request-response | itself (existing file) | exact |
| `apps/worker/src/queues/webhook-events.worker.ts` (MODIFIED — `extractEventRow`, dedup INSERT, quarantine call) | worker | event-driven | itself (existing file) | exact |
| `apps/api/src/modules/webhooks/ingress-journal.ts` (NEW) | service/repository | file-I/O (durable write) | `apps/worker/src/queues/flows/flow-segment-sweep-checkpoint.ts` (transaction-scoped read/write helpers) | role-match |
| `apps/api/src/modules/webhooks/quarantine.ts` (NEW) | service/repository | CRUD (insert-only) | `apps/worker/src/queues/dead-letter/dead-letter-writer.ts` (sibling: durable non-happy-path row writer) | role-match |
| `apps/api/src/modules/webhooks/webhooks.routes.ts` (MODIFIED — add journal write after verify) | route | request-response | itself (existing file) | exact |
| `apps/api/src/modules/contacts/contact.repository.ts` (MODIFIED — `deleteContact` → anonymize) | repository | CRUD | itself (existing file, `deleteContact`/`createContact`/`updateContact`) | exact |
| `apps/worker/src/queues/erasure-scrub.worker.ts` (NEW) | worker | batch | `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` + `flow-segment-sweep-checkpoint.ts` | exact (Phase 12 sweep template) |
| `apps/worker/src/queues/webhook-replay-sweep.worker.ts` (NEW) | worker | batch | `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` (checkpointed sweep) + `apps/worker/src/queues/analytics-reconciliation.worker.ts` (`upsertJobScheduler` tick) | role-match |
| `apps/worker/src/queues/reputation-tick.worker.ts` (NEW) | worker | batch/event-driven | `apps/worker/src/queues/analytics-reconciliation.worker.ts` (scheduled tick reading fact columns) | role-match |
| `apps/worker/src/queues/analytics-reconciliation.worker.ts` (MODIFIED — UTC casts, dirty-day sweep) | worker | batch | itself (existing file) | exact |
| `apps/api/src/modules/ops/reputation-watchdog.ts` (NEW) | service (watchdog) | event-driven (poll) | `apps/api/src/modules/ops/dead-letter-watchdog.ts` | exact |
| `apps/api/src/modules/ops/ingestion-health-watchdog.ts` (NEW) | service (watchdog) | event-driven (poll) | `apps/api/src/modules/ops/dead-letter-watchdog.ts` / `send-reconciler-watchdog.ts` | exact |
| `packages/db/migrations/0055_ingress_journal.sql` (NEW) | migration | file-I/O (DDL) | `packages/db/migrations/0054_dead_letter_jobs.sql` (tenant-scoped variant needed — see note) | role-match |
| `packages/db/migrations/0056_send_events_quarantine.sql` (NEW) | migration | DDL | `packages/db/migrations/0054_dead_letter_jobs.sql` | role-match |
| `packages/db/migrations/0057_send_events_dedup_rebase.sql` (NEW, high-risk) | migration | DDL + data migration | `packages/db/migrations/0053_flow_segment_sweep_checkpoint.sql` (tenant-RLS pattern) — no direct analog for partitioned-unique-index rebuild; see RESEARCH.md Pattern 1/Code Example 2 | partial (novel migration shape) |
| `packages/db/migrations/0060_reputation_alert_state.sql` (NEW, keyed not singleton) | migration | DDL | `packages/db/migrations/0054_dead_letter_jobs.sql` (`dead_letter_alert_state`) — must NOT copy singleton `id=1` shape; key by `(workspace_id, metric)` instead | inverse-analog (copy structure, invert key shape) |

## Pattern Assignments

### `packages/delivery-core/src/unsubscribe-apply.ts` (service, request-response)

**Analogs:** `apps/api/src/modules/delivery/unsubscribe.routes.ts` lines 191-219 (route-side tx) and `apps/worker/src/queues/webhook-events.worker.ts` `applyUnsubscribe`/`setFactColumnOnce` (worker-side tx).

**Core pattern to extract and merge** (route side, `unsubscribe.routes.ts:191-219`):
```typescript
await withTenant(payload.workspaceId, () =>
  withTenantTransaction(async (client) => {
    const { rows } = await client.query<{ subscriptionStatus: string }>(
      `SELECT subscription_status as "subscriptionStatus" FROM contacts WHERE id = $1`,
      [payload.contactId]
    );
    const existingStatus = rows[0]?.subscriptionStatus ?? null;

    await client.query(
      `UPDATE contacts SET subscription_status = 'unsubscribed', updated_at = now() WHERE id = $1`,
      [payload.contactId]
    );

    if (existingStatus !== null && existingStatus !== "unsubscribed") {
      await recordSubscriptionStatusChange(client, {
        workspaceId: payload.workspaceId,
        contactId: payload.contactId,
        oldStatus: existingStatus,
        newStatus: "unsubscribed",
        source: "unsubscribe_route",
      });
    }
  })
);
```

**`setFactColumnOnce` idempotent-gate shape** — grep confirms the worker calls it repeatedly like:
```typescript
const justSet = await setFactColumnOnce(client, send.id, "unsubscribed_at", event.occurredAt);
if (justSet) { /* increment campaign counter + rollup */ }
```
The new `applyUnsubscribeWithSendFact(client, { contactId, sendId, workspaceId, occurredAt, source })` must: (1) read prior status, (2) UPDATE contacts, (3) `recordSubscriptionStatusChange` gated on real change, (4) `setFactColumnOnce(client, sendId, "unsubscribed_at", occurredAt)`, (5) increment counter/rollup only `if (justSet)`. Both call sites (`unsubscribe.routes.ts` and `webhook-events.worker.ts`'s `unsubscribe`/`group_unsubscribe` cases) call this one function inside their own already-open `withTenantTransaction`.

**Import convention:** `import { recordSubscriptionStatusChange } from "@mega-crm/contacts-core";` — this new helper lives in `delivery-core` (not `contacts-core`) since it also writes to `sends` and delivery-core already owns send-side vocabulary.

---

### `apps/api/src/modules/webhooks/ingress-journal.ts` (NEW) (repository, file-I/O)

**Analog:** `apps/worker/src/queues/flows/flow-segment-sweep-checkpoint.ts` — transaction-scoped, `PoolClient`-first-arg helpers, no own connection.

**Pattern to copy** (checkpoint load/advance/reset shape → journal insert/mark-complete/query-stuck):
```typescript
export async function writeIngressJournal(
  client: PoolClient,
  workspaceId: string,
  rawBatch: unknown
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ingress_journal (workspace_id, raw_batch) VALUES ($1, $2) RETURNING id`,
    [workspaceId, JSON.stringify(rawBatch)]
  );
  return rows[0].id;
}

export async function markIngestionComplete(client: PoolClient, journalId: string): Promise<void> {
  await client.query(
    `UPDATE ingress_journal SET ingestion_completed_at = now() WHERE id = $1`,
    [journalId]
  );
}
```
Every call site must already be inside `withTenant`/`withTenantTransaction` for RLS scoping (per the checkpoint file's header comment) — this table carries tenant PII (raw SendGrid payloads with recipient emails), so RLS is REQUIRED here (unlike `dead_letter_jobs`, which deliberately has none — do not copy that "no RLS" shape).

**Fail-closed policy (RESEARCH.md Pattern 3):** journal write is a precondition for accepting the webhook — if the INSERT fails, return 5xx from `webhooks.routes.ts`, do not enqueue.

---

### `apps/api/src/modules/webhooks/quarantine.ts` (NEW) (repository, CRUD insert-only)

**Analog:** `apps/worker/src/queues/dead-letter/dead-letter-writer.ts` (durable non-happy-path row writer — sibling problem: "this thing failed normal processing, write it somewhere durable instead of dropping it").

**Pattern:** insert-only, one row per rejected event, never throws (must not fail the whole webhook batch — CONTEXT.md CMP-05 requirement: "one malformed event must never fail the whole webhook batch"). Mirrors `dead_letter_jobs`' shape: `payload jsonb`, `error_message/reason text`, `received_at`/`rejected_at timestamptz DEFAULT now()`. Recommended as its OWN table (per RESEARCH.md "Alternatives Considered" table), not a `quarantined boolean` column on `send_events` (avoids widening the hot partitioned table).

---

### `apps/api/src/modules/webhooks/webhooks.routes.ts` (MODIFIED)

**Analog:** itself. Existing structure to extend (lines 86-132): the handler currently does verify signature → verify freshness → fail closed 400 → `JSON.parse` → `enqueueWebhookBatch` → 200 ack. The journal write is inserted between "verified + fresh" and "JSON.parse/enqueue" — i.e. AFTER `verifyWebhookSignature`/`isWebhookTimestampFresh` both pass, BEFORE `enqueueWebhookBatch`:
```typescript
const isValid = verifyWebhookSignature(endpoint.publicKey, rawBody, signature, timestamp);
const isFresh = isWebhookTimestampFresh(timestamp, env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS);
if (!isValid || !isFresh) {
  return reply.code(400).send();
}
// NEW: journal write here (fail closed — journal failure must not fall through to enqueue)
let events: unknown[];
try {
  const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
  events = Array.isArray(parsed) ? parsed : [parsed];
} catch {
  return reply.code(400).send();
}
await enqueueWebhookBatch(endpoint.workspaceId, events);
return reply.code(200).send();
```
Never journal before signature verification (explicit CLAUDE.md/CONTEXT.md rule already governing this route).

---

### `apps/api/src/modules/contacts/contact.repository.ts` (MODIFIED — `deleteContact`)

**Analog:** itself (existing `deleteContact`, lines 382-407) plus `packages/kms/src/client.ts` for the HMAC key material pattern.

**Current shape to replace** (hard DELETE + plaintext suppression insert):
```typescript
export async function deleteContact(id: string): Promise<boolean> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<{ email: string | null; subscriptionStatus: SubscriptionStatus }>(
      `DELETE FROM contacts WHERE workspace_id = $1 AND id = $2
       RETURNING email, subscription_status as "subscriptionStatus"`,
      [workspaceId, id]
    );
    const deleted = rows[0];
    if (!deleted) return false;
    if (deleted.email && (deleted.subscriptionStatus === "unsubscribed" || deleted.subscriptionStatus === "suppressed")) {
      await client.query(
        `INSERT INTO workspace_suppressions (workspace_id, email, reason)
         VALUES ($1, $2, 'contact_deleted')
         ON CONFLICT (workspace_id, email) DO NOTHING`,
        [workspaceId, deleted.email]
      );
    }
    return true;
  });
}
```
**New shape (D-01/D-02):** replace `DELETE FROM contacts` with an anonymizing `UPDATE contacts SET email = NULL, first_name = NULL, last_name = NULL, phone = NULL, attributes = '{}', anonymized_at = now() WHERE ... RETURNING email, subscription_status`, then hash the captured email via HMAC (using `@mega-crm/kms`'s `decryptTenantSecret` to unwrap the per-workspace HMAC key — same envelope-encryption call shape already used for tenant SendGrid keys) before the `workspace_suppressions` INSERT, then insert an `erasure_records` row (`status='pending'`) and enqueue the scrub job. Follow `createContact`'s existing convention of reading/writing inside one `withTenantTransaction`, `getWorkspaceId()` for scoping, and throwing typed errors (`ContactConflictError`/`ContactValidationError`) for any validation failure — mirror that class shape if erasure needs its own error type.

**KMS reuse pattern** (`packages/kms/src/client.ts` lines 46-63, `encryptTenantSecret`) — same call shape for wrapping/unwrapping the per-workspace HMAC key:
```typescript
const provider = await loadProvider();
const { plaintextDek, wrappedDek } = await provider.generateDataKey(workspaceId);
try {
  /* use plaintextDek as HMAC key material */
} finally {
  plaintextDek.fill(0); // zero after use — copy this defensive pattern for the HMAC key too
}
```

---

### `apps/worker/src/queues/erasure-scrub.worker.ts` (NEW) (worker, batch)

**Analog:** `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` + `flow-segment-sweep-checkpoint.ts` (Phase 12 bounded/resumable sweep template — explicitly named in RESEARCH.md "Don't Hand-Roll").

**Checkpoint pattern to copy** (from `flow-segment-sweep-checkpoint.ts`):
```typescript
export async function loadSweepCheckpoint(client: PoolClient, workspaceId: string, key: string): Promise<string | null> { /* ... */ }
export async function advanceSweepCheckpoint(client: PoolClient, workspaceId: string, key: string, cursor: string): Promise<void> { /* ON CONFLICT DO UPDATE */ }
```
Checkpoint write must commit in the SAME transaction as that page's scrub UPDATE (D-09 precedent) — never a separate transaction, or a kill between them either re-does a page or silently skips it. Use `@mega-crm/queue-core`'s job factory (`buildJobOptions`, `STANDARD_JOB_RETENTION`) — see `packages/queue-core/src/queue-options.ts` — for queue definition, per Phase 12's single-definition rule.

**PII field detection:** reuse `@mega-crm/redaction`'s `REDACTION_RULES` (`keyRules`/`valueRules`) rather than writing new PII regex — already tuned against `send_events.payload`/`events.properties` shapes.

---

### `apps/worker/src/queues/webhook-replay-sweep.worker.ts` (NEW) (worker, batch)

**Analog:** `apps/worker/src/queues/analytics-reconciliation.worker.ts` for the `upsertJobScheduler` recurring-tick registration shape, combined with the checkpointed-sweep pattern above for the actual page-walk over `ingress_journal`.

---

### `apps/worker/src/queues/reputation-tick.worker.ts` (NEW) (worker, batch/event-driven)

**Analog:** `apps/worker/src/queues/analytics-reconciliation.worker.ts` (scheduled tick reading fact columns) + `apps/api/src/modules/ops/dead-letter-watchdog.ts`'s `claimDeadLetterAlertSlot` pattern, KEYED not singleton.

**Alert-claim pattern to copy and re-key** (`dead-letter-watchdog.ts` lines 165-182):
```typescript
export async function claimDeadLetterAlertSlot(
  client: DeadLetterJobsClient,
  now: Date,
  dedupHours: number,
  newestFailedAt: Date | null = null,
): Promise<boolean> {
  const { rows } = await client.query(
    `UPDATE dead_letter_alert_state
        SET last_alert_sent_at = $1::timestamptz, last_seen_failed_at = $3::timestamptz, updated_at = now()
      WHERE id = 1
        AND (last_alert_sent_at IS NULL OR last_alert_sent_at < $1::timestamptz - make_interval(hours => $2))
      RETURNING last_alert_sent_at`,
    [now, dedupHours, newestFailedAt],
  );
  return rows.length > 0;
}
```
**Re-keyed for CMP-09** (per RESEARCH.md Pattern 5): replace `WHERE id = 1` with `WHERE workspace_id = $1 AND metric = $2`, and add tier-escalation re-fire logic (warn→critical inside cooldown still fires) — this escalation branch is NEW logic, no existing watchdog has tiers.

---

### `apps/worker/src/queues/analytics-reconciliation.worker.ts` (MODIFIED)

**Analog:** itself. Fix every `::date` cast to `(col AT TIME ZONE 'UTC')::date` (D-13/Pitfall 1). Add dirty-day sweep query:
```sql
SELECT workspace_id, day FROM workspace_daily_rollup WHERE dirtied_at IS NOT NULL
```
alongside the existing `recentDays(RECONCILE_WINDOW_DAYS)` loop, and clear conditionally after sweep:
```sql
UPDATE workspace_daily_rollup SET dirtied_at = NULL
WHERE dirtied_at IS NOT NULL AND dirtied_at <= $sweepStartTime
```

---

### `apps/api/src/modules/ops/reputation-watchdog.ts` and `ingestion-health-watchdog.ts` (NEW) (watchdog, poll)

**Analog:** `apps/api/src/modules/ops/dead-letter-watchdog.ts` (full file read — copy this file's entire shape: interval constant, dedup-hours constant, `Client` interface, `readXHealth`, `renderXAlertText`, `claimXAlertSlot`, `checkXHealthAndAlert`, `startXWatchdog`).

**Structure to copy verbatim (only the query/table/keying changes):**
```typescript
export const REPUTATION_WATCHDOG_INTERVAL_MS = 5 * 60_000; // pick per D-10 cadence
export const REPUTATION_ALERT_DEDUP_HOURS = 6; // or per-tier cooldown

export interface ReputationClient {
  query<T = Record<string, unknown>>(queryText: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export async function checkReputationHealthAndAlert(deps: ReputationWatchdogDeps): Promise<void> {
  // 1. read snapshot (complaint_rate, hard_bounce_rate per workspace)
  // 2. for each workspace/metric crossing warn/critical: claim alert slot (keyed, see reputation-tick pattern above)
  // 3. sendMail to BOTH operator (deps.operatorEmail, existing OPERATOR_ALERT_EMAIL channel)
  //    AND tenant workspace members (platform-mail machinery — NOT tenant's BYO SendGrid key)
}

export function startReputationWatchdog(deps: StartReputationWatchdogDeps): NodeJS.Timeout {
  return setInterval(() => {
    void checkReputationHealthAndAlert({ ...deps, now: new Date() }).catch((err: unknown) => {
      scrubbedConsole.error("reputation-watchdog: health check failed", err);
    });
  }, REPUTATION_WATCHDOG_INTERVAL_MS);
}
```
Import `scrubbedConsole` from `@mega-crm/redaction` (exact import used by the analog). NOT wired into `server.ts` by this module itself — boot wiring is a separate task, mirroring the analog's own explicit comment.

**`ingestion-health-watchdog.ts`** follows the identical shape, reading `ingress_journal` for stuck rows (`WHERE ingestion_completed_at IS NULL AND received_at < now() - interval '<threshold>'`) instead of `dead_letter_jobs`.

---

### Migrations

**`0055_ingress_journal.sql`, `0056_send_events_quarantine.sql`:** Follow `0054_dead_letter_jobs.sql`'s structure (CREATE TABLE + COMMENT ON TABLE explaining tenancy shape + supporting index) but INVERT the RLS decision: `ingress_journal` and quarantine rows DO carry tenant PII (raw payloads with recipient emails) and MUST get ordinary `workspace_isolation` RLS (`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`), unlike `dead_letter_jobs` which deliberately has none. Cite `0054`'s own header comment as the explicit "when RLS is/isn't needed" precedent in the new migration's comments.

**`0060_reputation_alert_state.sql`:** Copy `0054`'s `dead_letter_alert_state` table shape column-for-column (`last_alert_sent_at`, `updated_at`) but change the PRIMARY KEY from the `id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1)` singleton to `PRIMARY KEY (workspace_id, metric)` — this is the explicit anti-pattern warning in RESEARCH.md Pattern 5 ("must NOT copy the singleton shape"). No unconditional seed INSERT needed (unlike `0054`'s dead-man's-switch seed) since rows are created lazily per workspace/metric on first alert.

**`0057_send_events_dedup_rebase.sql`:** No direct in-repo analog — novel migration combining a partitioned-table concurrent-index build with a pre-migration dedup step. Follow RESEARCH.md's own Code Example 2 exactly (dry-run duplicate count → resolve duplicates in bounded/batched loop per Phase 12 sweep conventions → `CREATE INDEX ... ON ONLY` parent → per-partition `CREATE INDEX CONCURRENTLY` + `ATTACH PARTITION` → `ADD CONSTRAINT ... UNIQUE USING INDEX` → `DROP CONSTRAINT` old). Sequence as its own migration/task, never combined with other migrations in this phase.

## Shared Patterns

### Watchdog / Alerting
**Source:** `apps/api/src/modules/ops/dead-letter-watchdog.ts` (full file)
**Apply to:** `reputation-watchdog.ts`, `ingestion-health-watchdog.ts`, and the keyed-claim half of `reputation-tick.worker.ts`
- Single conditional `UPDATE ... RETURNING` for cross-replica dedup (never SELECT-then-UPDATE)
- `startXWatchdog` returns interval handle, caller owns clearing; not wired into `server.ts` by the watchdog module itself
- Rejected `sendMail` releases the claimed slot before rethrowing (`WHERE ... last_alert_sent_at = $1` guard)
- `scrubbedConsole.error` from `@mega-crm/redaction` for uncaught check failures inside the interval

### Checkpointed Batch Sweep
**Source:** `apps/worker/src/queues/flows/flow-segment-sweep-checkpoint.ts`
**Apply to:** `erasure-scrub.worker.ts`, `webhook-replay-sweep.worker.ts`
- All functions take `PoolClient` first, never open own connection
- Checkpoint write commits in the SAME transaction as that page's work
- `ON CONFLICT (workspace_id, key) DO UPDATE` upsert for cursor advance; explicit reset (not permanent cursor) when the underlying matching set can change between ticks

### Recurring Job Registration
**Source:** `apps/worker/src/queues/analytics-reconciliation.worker.ts` (existing `upsertJobScheduler` usage)
**Apply to:** `webhook-replay-sweep.worker.ts`, `reputation-tick.worker.ts`
- Stable scheduler id, `queue.upsertJobScheduler(stableId, {every}, ...)` — never a new cron-like mechanism

### KMS Envelope Encryption Reuse
**Source:** `packages/kms/src/client.ts` (`encryptTenantSecret`/`decryptTenantSecret`)
**Apply to:** `contact.repository.ts` (HMAC suppression hash), any suppression pre-send check in `delivery-core`/send-dispatch
- `loadProvider()` dispatch by `KMS_PROVIDER`, zero plaintext key material in a `finally` block immediately after use — copy exactly, do not re-derive KMS integration

### Fastify Route Structure (public, unauthenticated, raw-body)
**Source:** `apps/api/src/modules/webhooks/webhooks.routes.ts`, `apps/api/src/modules/delivery/unsubscribe.routes.ts`
**Apply to:** any modification of these two files this phase touches
- `addContentTypeParser` scoped to the route module (never global) when raw bytes matter for signature verification
- Fail-closed: ambiguous/invalid cases collapse to the SAME response, no distinguishing branch

## No Analog Found

None — every file classified above has at least a role-match analog in the existing codebase (confirmed via RESEARCH.md's own "Don't Hand-Roll" table, which independently reaches the same conclusion: every one of this phase's five new concerns has a structurally identical sibling already built in Phases 9-12).

## Metadata

**Analog search scope:** `apps/api/src/modules/ops/`, `apps/api/src/modules/webhooks/`, `apps/api/src/modules/delivery/`, `apps/api/src/modules/contacts/`, `apps/worker/src/queues/`, `apps/worker/src/queues/flows/`, `apps/worker/src/queues/dead-letter/`, `packages/kms/src/`, `packages/queue-core/src/`, `packages/db/migrations/`
**Files scanned:** dead-letter-watchdog.ts, flow-segment-sweep-checkpoint.ts, 0054_dead_letter_jobs.sql, webhooks.routes.ts, unsubscribe.routes.ts, contact.repository.ts, kms/client.ts, webhook-events.worker.ts (grep), analytics-reconciliation.worker.ts (referenced), queue-core file listing
**Pattern extraction date:** 2026-08-11
