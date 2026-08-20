# Phase 11: Delivery Correctness - Pattern Map

**Mapped:** 2026-08-09
**Files analyzed:** 13 (new + modified)
**Analogs found:** 13 / 13

Note: RESEARCH.md for this phase already contains verbatim, line-grounded code excerpts for nearly every file in scope (Code Examples #1-4, Patterns 1-3). This PATTERNS.md cross-references those excerpts against direct reads of the actual analog files done in this pass, and adds the two additional analogs (`partition-maintenance.worker.ts`, `partition-watchdog.ts`) RESEARCH.md names but does not quote from directly.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/delivery-core/src/send-id.ts` (NEW) | utility | transform | none in-repo (new primitive) | no-analog — see below |
| `packages/delivery-core/src/send-ledger.ts` (MODIFIED) | service | CRUD | itself (existing functions being extended) | exact |
| `packages/delivery-core/src/send-mail.ts` (MODIFIED) | service | request-response | itself (existing `sendTenantMailV3`) | exact |
| `packages/delivery-core/src/transport-classify.ts` (NEW) | utility | transform | `apps/worker/src/queues/send-dispatch.ts`'s `parseRetryAfter` (small pure classifier function) | role-match |
| `apps/worker/src/queues/send-dispatch.ts` (MODIFIED) | controller/job-processor | request-response | itself (existing `processSendJob`) | exact |
| `apps/worker/src/queues/send-reconciler.worker.ts` (NEW) | worker/route (tick) | batch / event-driven | `apps/worker/src/queues/flows/flow-reconciliation.worker.ts` | exact |
| `apps/worker/src/queues/email-broadcast.worker.ts`, `email-triggered.worker.ts` (MODIFIED — add `lockDuration`) | worker | event-driven | themselves (existing thin Worker wrappers) | exact |
| `packages/db/migrations/00XX_send_status_reconciling.sql` (NEW) | migration | — | prior standalone enum-add migrations (Phase 8 D-30 convention, e.g. the last `ALTER TYPE ... ADD VALUE`) | exact |
| `packages/db/migrations/00XX_send_status_unknown.sql` (NEW) | migration | — | same as above | exact |
| `packages/db/migrations/00XX_send_reconciliation_columns.sql` (NEW) | migration | — | additive-column migrations elsewhere in `packages/db/migrations/` | role-match |
| `packages/db/src/schema/sends.ts` (MODIFIED) | model | CRUD | itself | exact |
| `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` (MODIFIED) | config/service | request-response | itself (`EVENT_FLAGS` object) | exact |
| `apps/api/src/modules/ops/partition-watchdog.ts` (extended for reconciler health) | controller/service | request-response | itself (existing Phase 9 watchdog) | exact |
| Reconciler health-row schema (mirrors `partition_maintenance_runs`) | model | CRUD | `packages/db/src/schema/partition-maintenance-runs.ts` | exact |

## Pattern Assignments

### `packages/delivery-core/src/send-ledger.ts` (service, CRUD) — MODIFIED

**Analog:** itself, current code read in full this session.

**Current 3-way status branch to extend to 4-way** (`dispatchSendGate`, lines 41-55; identical shape in `claimFlowSend`, lines 160-176):
```typescript
let sendId = rows[0]?.id;
if (!sendId) {
  const { rows: existing } = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3 FOR UPDATE`,
    [workspaceId, campaignId, contactId]
  );
  const existingStatus = existing[0]?.status;
  if (existingStatus === "sent" || existingStatus === "failed" || existingStatus === "excluded") {
    return "skipped";
  }
  sendId = existing[0]?.id;
  if (sendId && existingStatus === "dispatching") {
    return { sendId, interrupted: true };
  }
}
```
Add (DLV-04, RESEARCH.md Pattern 2) immediately after the `dispatching` branch, in BOTH `dispatchSendGate` and `claimFlowSend`:
```typescript
if (existingStatus === "reconciling" || existingStatus === "unknown") {
  return "skipped"; // never re-call SendGrid; only the reconciler leaves these states
}
```

**Deterministic id insertion (D-09) — replaces `gen_random_uuid()` at both insert sites** (lines 34-39 and 153-158):
```typescript
// CURRENT: VALUES (gen_random_uuid(), $1, $2, $3, 'dispatching', now())
// NEW: caller supplies id = deriveCampaignSendId(...) / deriveFlowSendId(...)
const { rows } = await client.query<{ id: string }>(
  `INSERT INTO sends (id, workspace_id, campaign_id, contact_id, status, queued_at)
   VALUES ($4, $1, $2, $3, 'dispatching', now())
   ON CONFLICT (workspace_id, campaign_id, contact_id) DO NOTHING
   RETURNING id`,
  [workspaceId, campaignId, contactId, sendId]
);
```
Note `kind='test'` sends are explicitly exempt (D-11) — keep `randomUUID()`/`gen_random_uuid()` for those.

**`recordSendResult`/`recordFlowStepResult` type-cast convention to copy for the new statuses** (lines 87-94, 204-211):
```typescript
// $2::send_status cast at BOTH usages -- Postgres otherwise throws
// "inconsistent types deduced for parameter $2" (this cast pattern
// must be preserved verbatim when adding 'reconciling' as a writable status)
await client.query(
  `UPDATE sends
   SET status = $2::send_status,
       provider_message_id = $3,
       sent_at = CASE WHEN $2::send_status = 'sent' THEN now() ELSE sent_at END
   WHERE id = $1`,
  [sendId, result.status, result.providerMessageId ?? null]
);
```
Extend `result.status` union from `"sent" | "failed"` to include `"reconciling"`; add `dispatchedAt`/`dispatchDurationMs` optional fields per D-17, written in the same UPDATE.

**Pitfall-3 guard to extend (`recordExcluded` line 123, `recordFlowExcluded` line 240)** — exact copy-paste target:
```typescript
// CURRENT
WHERE sends.status NOT IN ('sent', 'dispatching', 'failed')
// NEW (same change that adds reconciling/unknown-consuming code, not the enum-add migration itself)
WHERE sends.status NOT IN ('sent', 'dispatching', 'failed', 'reconciling', 'unknown')
```

**`incrementCampaignSendCounter`'s guard (D-12 target, lines 261-265)** — the reconciler needs an additional idempotent backfill path here; keep the existing `WHERE status = 'sending'` guard for the normal fan-out path and add a reconciler-only variant/parameter that also permits post-'sending'-completion increments guarded by a "not already counted" check (e.g. a boolean/timestamp column consumed once, mirroring `setFactColumnOnce`'s first-write gate named in CONTEXT.md).

---

### `packages/delivery-core/src/send-mail.ts` (service, request-response) — MODIFIED

**Analog:** itself, current code (132 lines, read in full).

**Current bare fetch with no timeout** (lines 115-132):
```typescript
export async function sendTenantMailV3(
  apiKey: string,
  payload: SendGridMailSendRequest
): Promise<SendTenantMailResult> {
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: res.status, headers: res.headers, messageId: res.headers.get("x-message-id") };
  } catch (err) {
    throw redactApiKey(err, apiKey);
  }
}
```
**Copy `redactApiKey` verbatim (lines 99-106)** — new timeout/abort code must still flow thrown errors through this before they escape, since an `AbortError`'s message never contains the key but any wrapping/rethrow must preserve the existing redaction discipline.

**Add (D-15/DLV-06):**
```typescript
const SENDGRID_TIMEOUT_MS = 20_000; // Phase 11 D-15 -- versioned constant, see ARCHITECTURE.md
// ... signal: AbortSignal.timeout(SENDGRID_TIMEOUT_MS) added to the existing fetch() call options
```
The function's existing single try/catch + `redactApiKey` wrapper is the correct place to also classify the thrown error via the new `transport-classify.ts` (see below) — do not add a second try/catch layer; extend the existing one's catch block.

---

### `packages/delivery-core/src/transport-classify.ts` (utility, transform) — NEW

**Analog:** `apps/worker/src/queues/send-dispatch.ts`'s `parseRetryAfter` (lines ~82-98) — closest existing precedent for a small, pure, header/error-shape-driven classifier function with no side effects, same file family.

**Pattern to copy (shape, not content):** a single exported pure function taking a raw value (there: `Headers`; here: a thrown `unknown`) and returning a narrow classification via `if`/`else` branches over `.code`/`.name`, with an explicit safe-default fallback (`parseRetryAfter` defaults to `2000` when neither header is present — the same fail-closed-default shape D-10 requires for ambiguous transport errors):
```typescript
// Pattern precedent (apps/worker/src/queues/send-dispatch.ts, parseRetryAfter)
function parseRetryAfter(headers: Headers): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) { /* ... */ }
  const resetHeader = headers.get("x-ratelimit-reset");
  if (resetHeader !== null) { /* ... */ }
  return 2000; // safe default
}
```
New function signature per RESEARCH.md Architecture Pattern 3's table:
```typescript
export type TransportClassification = "pre_connection_retryable" | "ambiguous";
export function classifyTransportError(err: unknown): TransportClassification {
  const code = (err as { code?: string })?.code;
  const name = (err as { name?: string })?.name;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED") {
    return "pre_connection_retryable";
  }
  // ECONNRESET, AbortError/TimeoutError, and anything unrecognized -> fail-closed default
  return "ambiguous";
}
```

---

### `apps/worker/src/queues/send-dispatch.ts` (controller/job-processor, request-response) — MODIFIED

**Analog:** itself (534 lines, imports/structure read this session).

**Existing import block to extend** (lines 1-30) — add `deriveCampaignSendId`/`deriveFlowSendId` and `classifyTransportError` to the existing `@mega-crm/delivery-core` named-import block:
```typescript
import {
  evaluatePreSendGate,
  dispatchSendGate,
  releaseDispatchClaim,
  recordSendResult,
  recordExcluded,
  recordFlowStepResult,
  incrementCampaignSendCounter,
  tryCompleteCampaign,
  buildContactTemplateData,
  buildMailSendRequest,
  sendTenantMailV3,
  signUnsubscribeToken,
  buildListUnsubscribeUrl,
  getWorkspaceSendSettings,
  type SendGridMailSendRequest,
  type SendTenantMailResult,
} from "@mega-crm/delivery-core";
```

**`SendJobResult` discriminated union to extend (lines ~42-47)** — add an `"ambiguous"`/`"reconciling"` outcome variant without breaking the existing shape (per CONTEXT.md's Claude's Discretion note that Phase 12 will later split `cause`):
```typescript
export type SendJobResult =
  | { outcome: "sent"; sendId: string; providerMessageId: string | null }
  | { outcome: "skipped" }
  | { outcome: "excluded"; reason: string }
  | { outcome: "failed"; sendId: string }
  | { outcome: "rate_limited"; rateLimitMs: number };
  // NEW: | { outcome: "reconciling"; sendId: string }
```

**`ProcessSendJobDeps.sendMail` seam (lines ~48-56)** — DO NOT create a new seam; DLV-08's crash scenarios inject through this exact field:
```typescript
export interface ProcessSendJobDeps {
  sendMail?: (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult>;
  redisClient?: Redis;
}
```

**Interrupted branch rewrite (DLV-02) — from RESEARCH.md Code Example #1, grounded in this file's actual `claimCampaignSend`/unit-3 shape:**
```typescript
// CURRENT
if (dispatchResult.interrupted) {
  await recordSendResult(client, dispatchResult.sendId, { status: "failed" });
  await incrementCampaignSendCounter(client, campaignId, "failed");
  await tryCompleteCampaign(client, campaignId);
  return { kind: "failed", sendId: dispatchResult.sendId };
}
// NEW
if (dispatchResult.interrupted) {
  await recordSendResult(client, dispatchResult.sendId, { status: "reconciling" });
  // no incrementCampaignSendCounter call -- reconciler backfills counters exactly once
  return { kind: "reconciling", sendId: dispatchResult.sendId };
}
```

**Duration measurement (DLV-09) — from RESEARCH.md Code Example #2, grounded in this file's unit 2/3 boundary:**
```typescript
const dispatchedAt = new Date();
const response = await sendMail(claim.apiKey, payload); // unit 2, unchanged
const dispatchDurationMs = Date.now() - dispatchedAt.getTime();
await withTenantTransaction(async (client) => {
  await recordSendResult(client, claim.sendId, {
    status: "sent",
    providerMessageId: response.messageId,
    dispatchedAt,
    dispatchDurationMs,
  });
});
```

**Existing `parseRetryAfter` (lines 82-98)** — keep for the header-parsing half of D-10's bounded-exponential-retry change; the *unbounded* loop this fed previously must be capped (attempts/backoff now via BullMQ job options, per Don't-Hand-Roll table, not a custom counter).

---

### `apps/worker/src/queues/send-reconciler.worker.ts` (worker/tick, batch) — NEW

**Analog:** `apps/worker/src/queues/flows/flow-reconciliation.worker.ts` (119 lines, read in full this session) — exact scan-then-claim + repeatable-tick shape to mirror line-for-line.

**Imports pattern to copy (lines 1-4):**
```typescript
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { FLOW_RECONCILIATION_QUEUE } from "@mega-crm/shared-schemas"; // -> new SEND_RECONCILER_QUEUE const
```

**Discovery scan pattern (lines 36-44) — unlocked, scan-role, no per-tenant knowledge yet:**
```typescript
export async function findDueFlowRunCandidates(): Promise<DueFlowRunRow[]> {
  return withCrossWorkspaceScan(async (client) => {
    const { rows } = await client.query<DueFlowRunRow>(
      `SELECT id, workspace_id as "workspaceId" FROM flow_runs
       WHERE status = 'waiting' AND next_wake_at <= now()`
    );
    return rows;
  });
}
```
Adapt to (per RESEARCH.md Pattern 1):
```typescript
export async function findReconcilableCandidates(): Promise<CandidateRow[]> {
  return withCrossWorkspaceScan(async (client) => {
    const { rows } = await client.query<CandidateRow>(
      `SELECT id, workspace_id as "workspaceId" FROM sends
       WHERE status IN ('reconciling', 'unknown')
          OR (status = 'dispatching' AND queued_at < now() - interval '2 hours')` // D-08 stale sweep, threshold at planner discretion
    );
    return rows;
  });
}
```

**Per-tenant claim pattern (lines 58-75) — `withTenant` + `withTenantTransaction` + `FOR UPDATE SKIP LOCKED`, re-verify status inside the lock:**
```typescript
export async function transitionAndNudge(row: DueFlowRunRow): Promise<boolean> {
  return withTenant(row.workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT fr.id FROM flow_runs fr JOIN flows f ON f.id = fr.flow_id
         WHERE fr.id = $1 AND fr.status = 'waiting' AND fr.next_wake_at <= now()
           AND f.status <> 'paused'
         FOR UPDATE OF fr SKIP LOCKED`,
        [row.id]
      );
      return rows.length > 0;
    })
  );
}
```
Adapt to the reconciler's classify-and-resolve shape (RESEARCH.md Pattern 1's `resolveOneSend`):
```typescript
export async function resolveOneSend(row: CandidateRow): Promise<boolean> {
  return withTenant(row.workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM sends WHERE id = $1
           AND status IN ('reconciling', 'unknown', 'dispatching')
         FOR UPDATE SKIP LOCKED`,
        [row.id]
      );
      if (rows.length === 0) return false;
      // classify from send_events, write terminal status + counter backfill
      return true;
    })
  );
}
```

**Repeatable-tick registration (lines 96-119)** — copy the idempotent-registration comment and `repeat: { every: ... }` shape verbatim:
```typescript
export function createFlowReconciliationWorker(connection: ConnectionOptions): Worker {
  const tickQueue = new Queue(FLOW_RECONCILIATION_QUEUE, { connection });
  void tickQueue.add(
    "scan-due-flow-runs",
    {},
    { repeat: { every: RECONCILIATION_INTERVAL_MS }, jobId: "scan-due-flow-runs" }
  );
  return new Worker(FLOW_RECONCILIATION_QUEUE, async () => { /* ... */ }, { connection });
}
```
D-16 prefers `upsertJobScheduler` (see `partition-maintenance.worker.ts` below) over this file's older `queue.add({ repeat })` form — use the newer scheduler-API pattern, not this one, per RESEARCH.md's explicit note that `upsertJobScheduler` is the more current convention for a NEW tick worker.

---

### `apps/worker/src/queues/send-reconciler.worker.ts` — scheduler-registration & health-row half

**Analog:** `apps/worker/src/queues/partition-maintenance.worker.ts` (257 lines, read in full) — the D-16 `upsertJobScheduler` pattern and D-14 health-row-writing pattern to copy.

**Stable-id idempotent scheduler registration (lines 44, 239-243):**
```typescript
const JOB_SCHEDULER_ID = "partition-maintenance-daily"; // -> "send-reconciler-tick" analog
// ...
await queue.upsertJobScheduler(
  JOB_SCHEDULER_ID,
  { pattern: PARTITION_MAINTENANCE_CRON, tz: "UTC" }, // -> { every: RECONCILER_TICK_MS } for D-16's ~5min cadence
  { name: JOB_NAME, opts: DEFAULT_JOB_OPTIONS },
);
```

**Fire-and-forget registration with try/catch/finally so a Redis hiccup at boot never crashes the whole worker process (lines 237-253) — copy verbatim shape:**
```typescript
const registration = (async () => {
  try {
    await queue.upsertJobScheduler(/* ... */);
    await queue.add(JOB_NAME, {}, { ...DEFAULT_JOB_OPTIONS, jobId: bootJobId });
  } catch (err) {
    scrubbedConsole.error("send-reconciler: scheduler registration failed", err);
  } finally {
    await queue.close().catch(() => undefined);
  }
})();
```

**Dedicated pool + `pool.on("error", ...)` guard (lines 88-97)** — only copy if the reconciler needs a dedicated pool outside `@mega-crm/tenant-context`'s shared pool; likely NOT needed here since the reconciler's per-tenant work already goes through `withTenant`/`withTenantTransaction` (unlike partition maintenance, which is deliberately platform-level/pool-direct). Note this distinction explicitly in the reconciler's own file-header comment so a future reader doesn't "fix" it by copying the dedicated-pool pattern unnecessarily.

**Health-row write pattern** — mirror `runPartitionMaintenance`'s snapshot-write shape (`packages/db/src/partitions/maintenance-run.ts`, not fully read this session but referenced in RESEARCH.md Sources) and `packages/db/src/schema/partition-maintenance-runs.ts` for the reconciler's own health-row schema (D-14's discretion item).

---

### `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` (config, request-response) — MODIFIED

**Analog:** itself — `EVENT_FLAGS` object (RESEARCH.md Code Example #4, exact current shape):
```typescript
const EVENT_FLAGS = {
  delivered: true,
  bounce: true,
  dropped: true,
  open: true,
  click: true,
  unsubscribe: true,
  group_unsubscribe: true,
  spam_report: true,
} as const;
```
Change (D-06):
```typescript
const EVENT_FLAGS = {
  processed: true, // Phase 11 D-06: primary acceptance evidence for the reconciler
  delivered: true,
  bounce: true,
  dropped: true,
  open: true,
  click: true,
  unsubscribe: true,
  group_unsubscribe: true,
  spam_report: true,
} as const;
```
Do NOT add `deferred` (explicit D-06 exclusion).

---

### `packages/db/migrations/00XX_send_status_reconciling.sql` / `00XX_send_status_unknown.sql` (migration) — NEW

**Analog:** the codebase's own most recent `ALTER TYPE send_status ADD VALUE` migration (per RESEARCH.md, next available numbers ~0047/0048). Pattern requirement (Pitfall 2, Phase 8 D-30 linter-enforced): each enum-add migration must be a STANDALONE file with NO code in the same file/deploy that references the new value — `scripts/lint-migrations.mjs`'s `enum-add-value-used-same-file` rule blocks violations mechanically.

```sql
-- 00XX_send_status_reconciling.sql (standalone, no other statements)
ALTER TYPE send_status ADD VALUE 'reconciling';
```
```sql
-- 00XX_send_status_unknown.sql (standalone, separate deploy after the above)
ALTER TYPE send_status ADD VALUE 'unknown';
```

### `packages/db/migrations/00XX_send_reconciliation_columns.sql` (migration) — NEW

**Analog:** any prior additive-columns migration in `packages/db/migrations/` (standard `ALTER TABLE ADD COLUMN` pattern already established in this repo for `sends`/similar tables).
```sql
ALTER TABLE sends ADD COLUMN reconciling_since timestamptz;
ALTER TABLE sends ADD COLUMN dispatched_at timestamptz;
ALTER TABLE sends ADD COLUMN dispatch_duration_ms integer;
```

### `packages/db/src/schema/sends.ts` (model, CRUD) — MODIFIED

**Analog:** itself (80 lines) — extend `send_status` pgEnum values array and add the three new Drizzle column definitions matching the migration above, mirroring this file's existing column-definition style (not separately excerpted here; read the file directly at plan time — it is short).

## Shared Patterns

### Scan-then-claim discovery (cross-cutting: reconciler)
**Source:** `apps/worker/src/queues/flows/flow-reconciliation.worker.ts` lines 36-75, `apps/worker/src/queues/campaign-scheduler.worker.ts` (named sibling, not re-read — same shape)
**Apply to:** `send-reconciler.worker.ts`'s discovery + per-tenant claim functions.
```typescript
// discovery: withCrossWorkspaceScan, unlocked, cross-tenant
// claim: withTenant + withTenantTransaction + FOR UPDATE SKIP LOCKED, re-verify status
```

### Idempotent repeatable-tick registration (cross-cutting: reconciler)
**Source:** `apps/worker/src/queues/partition-maintenance.worker.ts` lines 202-257 (`upsertJobScheduler` + fire-and-forget try/catch/finally)
**Apply to:** `send-reconciler.worker.ts`'s worker-construction function.

### Status-branch skip for non-actionable states (cross-cutting: DLV-04 exclusivity)
**Source:** `packages/delivery-core/src/send-ledger.ts` lines 48-54, 169-175 (`dispatchSendGate`/`claimFlowSend`)
**Apply to:** both claim functions — add the `reconciling`/`unknown` → `"skipped"` branch identically in both.

### Enum-cast discipline for `send_status` UPDATEs (cross-cutting)
**Source:** `packages/delivery-core/src/send-ledger.ts` lines 82-94 (comment + `$2::send_status` cast pattern)
**Apply to:** any new UPDATE statement writing `reconciling`/`unknown`/`sent` to `sends.status` (reconciler's terminal write, `recordSendResult`'s extended status union).

### Redaction wrapper on every thrown SendGrid-adjacent error
**Source:** `packages/delivery-core/src/send-mail.ts` lines 99-106 (`redactApiKey`)
**Apply to:** `sendTenantMailV3`'s timeout/abort catch path — any new error path must still flow through this before propagating.

### Fire-and-forget boot registration must never crash the worker process
**Source:** `apps/worker/src/queues/partition-maintenance.worker.ts` lines 224-253 (try/catch/finally around `upsertJobScheduler`/`queue.add`, `scrubbedConsole.error` on failure, `finally` always closes the queue handle)
**Apply to:** `send-reconciler.worker.ts`'s construction function.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `packages/delivery-core/src/send-id.ts` (`deriveCampaignSendId`/`deriveFlowSendId`, UUIDv5) | utility | transform | No existing deterministic-id derivation exists anywhere in the codebase (all prior `sends.id` values are `gen_random_uuid()`); RESEARCH.md's Code Example #3 is the only available template — use it directly rather than searching further, it is already a first-party-grounded design for this exact function. |
| Reconciler health-row schema | model | CRUD | No direct copy target — RESEARCH.md and this map both point at `partition_maintenance_runs` as the schema to *mirror*, not an existing table to reuse verbatim; the planner should adapt column names to reconciler-specific fields (rows resolved this tick, oldest `reconciling_since` seen, etc.) rather than force-fit partition-maintenance's specific columns. |

## Metadata

**Analog search scope:** `packages/delivery-core/src/`, `apps/worker/src/queues/`, `apps/worker/src/queues/flows/`, `packages/db/src/schema/`, `packages/db/migrations/`, `apps/api/src/modules/webhooks/`, `apps/api/src/modules/ops/`
**Files scanned directly this session:** `send-ledger.ts` (308 lines, full), `send-mail.ts` (132 lines, full), `flow-reconciliation.worker.ts` (119 lines, full), `partition-maintenance.worker.ts` (257 lines, full), `send-dispatch.ts` (first 120 of 534 lines — imports/header; remainder already fully quoted in RESEARCH.md's Code Examples #1/#2 and not re-read to avoid duplicate-range reads)
**Pattern extraction date:** 2026-08-09
