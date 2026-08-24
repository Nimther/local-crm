# Phase 22: Workspace Quiesce & Physical Purge - Pattern Map

**Mapped:** 2026-08-23
**Files analyzed:** 16 (new + modified)
**Analogs found:** 16 / 16 (all have at least a role-match; several are exact/near-exact generalizations of a single existing precedent)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/worker/src/queues/workspace-purge.worker.ts` (new) | service/worker | batch (destructive) | `apps/worker/src/queues/erasure-scrub.worker.ts` (checkpointed multi-table walk) + `apps/worker/src/queues/partition-maintenance.worker.ts` (scheduled tick + dead-man's-switch) | exact (compose two analogs) |
| `apps/worker/src/queues/workspace-purge-checkpoint.ts` (new) | utility | CRUD (checkpoint read/write) | `apps/worker/src/queues/erasure-scrub-checkpoint.ts` | role-match (storage location differs: platform table, not tenant row) |
| `apps/worker/src/queues/workspace-purge-tables.ts` or similar (new) — per-table batched DELETE primitives | utility | batch (destructive DELETE) | `packages/db/src/partitions/relocate-default.ts` (`relocateMonth`'s CTE-DELETE-with-`FOR UPDATE SKIP LOCKED` batch loop) | exact (adapt DELETE-only, no INSERT/ATTACH) |
| `apps/worker/src/env.ts` (new — first ever for apps/worker) | config | request-response (boot validation) | `apps/api/src/env.ts` (`z.coerce.number().int().refine()` floor pattern) | exact |
| `packages/db/src/schema/purge-records.ts` (new) | model | CRUD | `packages/db/src/schema/ops-alert-state.ts` / `packages/db/src/schema/erasure-records.ts` | exact (evidence-record + no-RLS platform table shape) |
| `packages/db/migrations/00NN_purge_records.sql` (new) | migration | — | `packages/db/migrations/0064_ops_alert_state_and_rollup_watermark.sql` | role-match |
| `packages/db/migrations/00NN_relax_erasure_records_contact_fk.sql` (new) | migration | — | `packages/db/migrations/0059_contact_erasure.sql` (constraint being relaxed) | exact (inverse of existing constraint) |
| `packages/db/migrations/00NN_scan_policy_deleted_at.sql` (new) | migration | — | `packages/db/migrations/0042_scan_role_grants_and_policies.sql` | exact |
| `apps/worker/src/queues/campaign-scheduler.worker.ts` (modified) | service/worker | request-response (discovery query) | itself — no external analog needed, policy predicate change only | n/a (in-place) |
| `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` (modified) | service/worker | request-response | itself | n/a |
| `apps/worker/src/queues/flows/flow-reconciliation.worker.ts` (modified) | service/worker | request-response | itself | n/a |
| `apps/worker/src/queues/analytics-reconciliation.worker.ts` (modified) | service/worker | batch | itself (add `WHERE "deletedAt" IS NULL`) | n/a |
| `apps/worker/src/queues/send-dispatch.ts` (modified — D-01/D-03 dispatch-gate + D-04 test-send path) | service | event-driven | `packages/delivery-core/src/send-ledger.ts`'s `recordExcluded` / `evaluatePreSendGate` call sites already in this file | exact |
| `apps/api/src/modules/events/events-api.routes.ts` (modified) | route/middleware | request-response | `apps/api/src/modules/tenancy/workspaces.ts` (`deletedAt` read-side check, lines ~108-114) | role-match |
| `apps/api/src/modules/webhooks/webhooks.routes.ts` (modified) | route | request-response | same `workspaces.ts` `deletedAt` check + existing "unknown pathToken → generic 404" branch in this file | role-match |
| `packages/db/scripts/restore-workspace.ts` (new CLI) | utility/CLI | request-response (one-shot) | `packages/db/scripts/relocate-default-partition-rows.ts` (operator CLI shape) | exact |
| `packages/db/scripts/workspace-purge-report.ts` (new CLI, D-07 on-demand report) | utility/CLI | request-response | same `relocate-default-partition-rows.ts` CLI shape | exact |
| `apps/worker/src/queues/__tests__/workspace-purge.test.ts` (new) | test | — | `apps/worker/src/queues/__tests__/erasure-scrub.test.ts` | exact |
| `apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts` (new) | test | — | `apps/worker/src/queues/__tests__/failure-injection/erasure-scrub-resume.test.ts` | exact |
| `packages/db/src/partitions/__tests__/*purge-neighbour-safety*.test.ts` (new) | test | — | existing 38 negative cross-tenant tests (genre); `boundary-crossing-late-automation.test.ts` for the relocate-shaped test harness | role-match |

## Pattern Assignments

### `apps/worker/src/queues/workspace-purge.worker.ts` (service, batch)

**Analogs:** `erasure-scrub.worker.ts` (checkpointed multi-table walk, status state machine) + `partition-maintenance.worker.ts` (scheduled tick, dedicated pool, dead-man's-switch)

**Imports pattern** (from `erasure-scrub.worker.ts` lines 1-21):
```typescript
import { Worker, type ConnectionOptions, type Job } from "bullmq";
import type { PoolClient } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildJobOptions, buildRedisConnectionOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import type { BuiltJobOptions } from "@mega-crm/queue-core";
import { wrapProcessor } from "../processor-wrapper.js";
import { logger } from "../logger.js";
```
Combine with `partition-maintenance.worker.ts`'s dedicated non-tenant pool for cross-workspace discovery (lines 92-99):
```typescript
const workspacePurgePool = createPgPool({
  connectionString: process.env.DATABASE_URL ?? "",
  name: "worker-workspace-purge",
});
```

**Status state-machine pattern** (from `erasure-scrub.worker.ts` lines 289-332, `markScrubStartedIfPending`/`markScrubComplete`/`markScrubFailed`):
```typescript
async function markPurgeStartedIfPending(client: PoolClient, workspaceId: string): Promise<void> {
  await client.query(
    `UPDATE purge_records SET status = 'purging' WHERE workspace_id = $1 AND status = 'reported'`,
    [workspaceId]
  );
}
// mirror markScrubComplete / markScrubFailed shape exactly, writing purged_at / purge_error
```
A record already `complete` returns immediately without resetting anything — same replay-is-a-no-op rule as `erasure-scrub.worker.ts` lines 381-383.

**Per-table walk-to-exhaustion loop** (from `erasure-scrub.worker.ts` lines 262-287, generalize `walkTableToExhaustion` from 2 tables to ~13 tables in the FK order RESEARCH.md's "FK Graph and Deletion Ordering" section specifies): each table gets its own page function and its own cursor column (or a shared `purge_records.checkpoint jsonb` keyed by table name), looped until a page returns 0 rows, each page inside its own `withTenant`/`withTenantTransaction`.

**Scheduled-tick registration** (from `partition-maintenance.worker.ts` lines 274-291, `upsertJobScheduler` + fire-and-forget with try/catch/finally, never crash the process on registration failure):
```typescript
await queue.upsertJobScheduler(
  JOB_SCHEDULER_ID,
  { pattern: WORKSPACE_PURGE_CRON, tz: "UTC" },
  { name: JOB_NAME, opts: DEFAULT_JOB_OPTIONS }
);
```

**Error handling pattern** (from `erasure-scrub.worker.ts` lines 398-417): on unrecoverable error, mark `failed` with error message recorded, then RE-THROW so BullMQ retries and the dead-letter path still fires; the mark-failed write itself is wrapped so a failure to record the failure never masks the original error.

---

### `apps/worker/src/queues/workspace-purge-checkpoint.ts` (utility, CRUD)

**Analog:** `apps/worker/src/queues/erasure-scrub-checkpoint.ts`

**Key structural difference (call out explicitly in the plan):** `erasure-scrub-checkpoint.ts` stores its cursor ON the tenant-scoped `erasure_records` row (lines 1-31 doc comment explains why that works there). The purge CANNOT reuse that storage location — the tables it walks are themselves being destroyed, and even `erasure_records` itself is evidence that must survive with a *stable* row, not one accumulating 13 tables' worth of scrub-cursor columns. Store checkpoint state instead on the NEW platform-level `purge_records` table (see Code Examples in RESEARCH.md), one `jsonb` cursor column keyed by table name, or one row-per-table shape — planner's discretion, but it must **not** live on any tenant table.

**Function signature pattern to copy** (from `erasure-scrub-checkpoint.ts` lines 88-132):
```typescript
export async function loadWorkspacePurgeCheckpoint(
  client: PoolClient,
  workspaceId: string,
  table: PurgeTable
): Promise<PurgeCursor | null> { /* same column-name-from-whitelist discipline, never interpolate external input */ }

export async function advanceWorkspacePurgeCheckpoint(
  client: PoolClient,
  workspaceId: string,
  table: PurgeTable,
  cursor: PurgeCursor,
  processedInPage: number
): Promise<void> { /* single UPDATE advances cursor + count atomically, same transaction as the page's DELETE */ }
```
The `ScrubCursorInProgress | ScrubCursorDone` discriminated-union shape (lines 47-70) is directly reusable — copy the `{ done: false, ... } | { done: true }` pattern so "not started" (`null`) is distinguishable from "finished."

---

### Per-table batched DELETE primitive (utility, batch/destructive)

**Analog:** `packages/db/src/partitions/relocate-default.ts`'s `relocateMonth` batch loop (lines 155-217)

**Core pattern to copy** (CTE DELETE with `FOR UPDATE SKIP LOCKED`, lines 179-192) — adapt to DELETE-only (no INSERT/ATTACH, since purge destroys rather than relocates):
```typescript
await conn.query("BEGIN");
try {
  const { rows } = await conn.query(
    `DELETE FROM ${tableName}
      WHERE ctid IN (
        SELECT ctid FROM ${tableName}
         WHERE workspace_id = $1
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
     RETURNING id`,
    [workspaceId, PURGE_BATCH_SIZE]
  );
  await conn.query("COMMIT");
} catch (err) {
  await conn.query("ROLLBACK").catch(() => undefined);
  throw err;
}
```
**Table identifiers must come from a frozen allowlist constant** (never interpolated from a discovery-query result) — same discipline as `relocate-default.ts`'s header comment on Threat T-09-17.

**Advisory-lock single-flight guard** (from `relocate-default.ts` lines 244, 284-347, `RELOCATE_ADVISORY_LOCK_KEY` + `pg_try_advisory_lock`/`pg_advisory_unlock` on a dedicated connection, released explicitly before `conn.release()`): copy this exact pattern with a NEW distinct advisory-lock int8 key for the purge's own claim primitive (PRG-05's "eligibility re-check inside every batch" + PRG-03's resumability both need single-flight per workspace).

**PII-scope note:** each batch's own `WHERE workspace_id = $1` re-scoping IS the per-batch eligibility re-check (PRG-05) — additionally join/subquery `organization` inside the same batch statement to refuse (not silently skip) a restored workspace, per D-14's point-of-no-return discipline.

---

### `apps/worker/src/env.ts` (config, request-response/boot)

**Analog:** `apps/api/src/env.ts` (grep-confirmed pattern by RESEARCH.md; exact lines not re-read here, but pattern is well-established codebase-wide)

**Pattern to copy** — Zod-based boot-validated env with a floor via `.refine()`:
```typescript
const envSchema = z.object({
  WORKSPACE_PURGE_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .refine((n) => n >= 7, "WORKSPACE_PURGE_RETENTION_DAYS must be >= 7 (D-06 floor)")
    .default(30),
  // if privilege-model option (b) is chosen: AUTH_DATABASE_URL: z.string().url(),
});
export const env = envSchema.parse(process.env);
```
This is `apps/worker`'s FIRST env-validation module — RESEARCH.md flags this as an explicit task, not incidental.

---

### `packages/db/src/schema/purge-records.ts` (model, CRUD)

**Analog:** `packages/db/src/schema/ops-alert-state.ts` (no-RLS platform table shape) + `packages/db/src/schema/erasure-records.ts` (evidence-record shape)

**Full shape to copy** (already drafted in RESEARCH.md's Code Examples section, reproduced here verbatim as the concrete pattern):
```typescript
export const purgeRecords = pgTable("purge_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(), // no FK -- survives independently
  softDeletedAt: timestamp("soft_deleted_at", { withTimezone: true }).notNull(),
  eligibleAt: timestamp("eligible_at", { withTimezone: true }).notNull(),
  reportedAt: timestamp("reported_at", { withTimezone: true }), // D-07 announce-then-act
  firstDestructiveBatchAt: timestamp("first_destructive_batch_at", { withTimezone: true }), // D-14 point of no return
  purgedAt: timestamp("purged_at", { withTimezone: true }),
  status: text("status").notNull().default("pending"), // pending | reported | purging | complete | failed
  tableCounts: jsonb("table_counts"),
  purgeError: text("purge_error"),
});
// No ENABLE ROW LEVEL SECURITY -- "role identity is the boundary" precedent.
```

---

### RLS policy migration for `campaigns_scan`/`flows_scan`/`flow_runs_scan` (migration)

**Analog:** `packages/db/migrations/0042_scan_role_grants_and_policies.sql`

**Pattern to copy** (already drafted in RESEARCH.md's Code Examples, verbatim):
```sql
DROP POLICY campaigns_scan ON campaigns;
CREATE POLICY campaigns_scan ON campaigns
  FOR SELECT TO mega_crm_scan
  USING (
    status = 'scheduled' AND scheduled_at <= now()
    AND NOT EXISTS (
      SELECT 1 FROM organization o
      WHERE o.id = campaigns.workspace_id AND o."deletedAt" IS NOT NULL
    )
  );
-- Repeat identically for flows_scan and flow_runs_scan in the SAME migration.
```
Column is quoted camelCase `"deletedAt"` (better-auth additionalField), NOT `deleted_at` — verified gotcha from RESEARCH.md Pitfall 3.

---

### `erasure_records.contact_id` FK-relax migration

**Analog:** `packages/db/migrations/0059_contact_erasure.sql` (the constraint being relaxed)

**Pattern** (RESEARCH.md Code Examples, verbatim — verify constraint name against `pg_constraint` first, do not assume default naming since 0059 is hand-written SQL):
```sql
ALTER TABLE erasure_records ALTER COLUMN contact_id DROP NOT NULL;
ALTER TABLE erasure_records DROP CONSTRAINT erasure_records_contact_id_fkey; -- verify name first
ALTER TABLE erasure_records
  ADD CONSTRAINT erasure_records_contact_id_fkey
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
```

---

### `send-dispatch.ts` D-01/D-03 dispatch-gate + D-04 test-send quiesce (modified, event-driven)

**Analog:** the file's own existing `evaluatePreSendGate` call sites + `recordExcluded`

**Exclusion-fact pattern to copy** (`packages/delivery-core/src/send-ledger.ts` lines 322-337):
```typescript
export async function recordExcluded(
  client: PoolClient,
  params: { workspaceId: string; campaignId: string; contactId: string },
  reason: string
): Promise<void> {
  // INSERT ... VALUES ('excluded', reason, ...) ON CONFLICT DO UPDATE SET status='excluded', exclusion_reason=...
  // WHERE sends.status NOT IN ('sent','dispatching','failed','reconciling','unknown')
}
```
Add a new reason literal (e.g. `"workspace_deleted"`) and call this exact function from the campaign/flow dispatch paths' existing gate chain (`send-dispatch.ts` lines ~290, ~330, ~487, ~781 — grep-confirmed call sites of `recordExcluded`/`claimResult.kind === "excluded"`).

**Pitfall 4 (test-send path has no `sends` row):** the `kind === 'test'` branch (lines ~612-618) bypasses `evaluatePreSendGate` and the ledger insert entirely — do NOT attempt `recordExcluded` there (no row exists to attach it to). Give this branch its own lightweight `organization.deletedAt IS NOT NULL` lookup that short-circuits to a typed refusal/log line instead.

---

### Ingestion quiesce — events API + webhook route (modified, request-response)

**Analog:** `apps/api/src/modules/tenancy/workspaces.ts` lines 108-114 (existing `deletedAt` read-side check)
```typescript
// `deletedAt` (a project-added additionalField), so the check happens
if (!org || (org as { deletedAt?: Date | string | null }).deletedAt) { /* refuse */ }
```

**Events API:** insert the same `deletedAt` check as an `onRequest`/`preHandler` step immediately after `apiKeyAuth` resolves `workspaceId`, returning a typed 4xx BEFORE the batch reaches `eventsIngestQueue`.

**Webhook route:** check `deletedAt` immediately after `findWebhookEndpointByToken(pathToken)` resolves `endpoint.workspaceId`, returning the SAME generic 404 the existing "unknown pathToken" branch already returns — do not invent a distinguishable status (no enumeration oracle). This check happens BEFORE signature verification is reached only in the sense that it uses data already available pre-parse; CLAUDE.md's rule ("never parse webhook body before signature verification") is not violated since no body parsing occurs for this check — signature verification still runs for any live workspace exactly as today.

---

### Restore CLI (new, request-response/one-shot)

**Analog:** `packages/db/scripts/relocate-default-partition-rows.ts` (operator-CLI shape: non-zero exit on refusal, single callable entrypoint shared between the CLI and its test)

**Pattern:** one exported function (e.g. `restoreWorkspace(workspaceId, deps)`) that:
1. Checks `purge_records.first_destructive_batch_at IS NOT NULL` (D-14 point of no return) → refuse with typed error, non-zero exit.
2. Otherwise `UPDATE organization SET deletedAt = NULL WHERE id = $1`.
3. In the SAME transaction, flips any overdue `scheduled` campaigns for this workspace back to `draft` (D-15) — never rely on the scheduler's own re-check alone (race).
The CLI wrapper script just calls this function and prints/exit-codes the result — same separation `relocate-default-partition-rows.ts` uses against `relocateAllDefaultRows`.

---

## Shared Patterns

### Checkpointed, resumable batch loop (PRG-03)
**Source:** `apps/worker/src/queues/erasure-scrub-checkpoint.ts` + `erasure-scrub.worker.ts`'s `walkTableToExhaustion`
**Apply to:** `workspace-purge.worker.ts`'s per-table walk, `workspace-purge-checkpoint.ts`
Key rule: cursor advance and row mutation/deletion MUST commit in the same transaction — never two separate commits, or a kill between them either double-processes (safe, idempotent) or silently skips (unacceptable PII leak / undercounted evidence).

### Batched, `SKIP LOCKED`-safe destructive DML inside shared structures (PRG-04)
**Source:** `packages/db/src/partitions/relocate-default.ts`
**Apply to:** every per-table DELETE the purge issues
Never DROP/DETACH/TRUNCATE. Table identifiers only from a frozen allowlist. Advisory lock for single-flight per workspace.

### Scheduled-tick worker + dead-man's-switch (D-05, D-08)
**Source:** `apps/worker/src/queues/partition-maintenance.worker.ts`
**Apply to:** `workspace-purge.worker.ts`'s tick registration; wire a companion API-side watchdog reading `ops_alert_state` for stuck/failed purges (mirrors `apps/api/src/modules/ops/partition-watchdog.ts`).

### Fail-closed exclusion-fact recording (D-03)
**Source:** `packages/delivery-core/src/send-ledger.ts`'s `recordExcluded`
**Apply to:** `send-dispatch.ts`'s campaign/flow dispatch paths under D-01's kill switch.

### Anonymized tombstone over hard delete (D-09)
**Source:** Phase 13's contact-anonymization model (same UPDATE-not-DELETE discipline `relocate-default.ts`'s own header warns about for cascades) — no single file to copy verbatim; the load-bearing rule is: **never** issue `DELETE FROM organization`, only `UPDATE`.

### Boot-validated env floor (D-06)
**Source:** `apps/api/src/env.ts`'s `z.coerce.number().int().refine()` pattern
**Apply to:** the new `apps/worker/src/env.ts`.

## No Analog Found

None — every file has at least a role-match analog in-tree. The purge worker itself is a compositional pattern (no single existing file does everything it needs), documented above as "compose two analogs."

## Metadata

**Analog search scope:** `apps/worker/src/queues/`, `packages/db/src/partitions/`, `packages/db/src/schema/`, `packages/delivery-core/src/`, `apps/api/src/modules/tenancy/`, `apps/api/src/modules/events/`, `apps/api/src/modules/webhooks/`, `packages/db/scripts/`, `packages/db/migrations/`
**Files scanned:** ~15 read/greped directly this session, cross-referenced against RESEARCH.md's own grep-verified findings (Sources section)
**Pattern extraction date:** 2026-08-23
