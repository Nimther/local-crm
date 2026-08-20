# Phase 9: Partition Automation & Boundary Safety - Pattern Map

**Mapped:** 2026-08-06
**Files analyzed:** 10
**Analogs found:** 10 / 10

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `packages/db/src/partitions/ensure-partitions.ts` | utility (idempotent DDL fn) | batch/transform | `packages/test-support/src/migration-runner.ts` (structural client interface) + `packages/db/migrations/0007_events_partitioned.sql` (DDL shape) | role-match (composite) |
| `packages/db/migrations/00XX_partition_catchup_and_maintenance_runs.sql` | migration | batch | `packages/db/migrations/0007_events_partitioned.sql`, `0010_events_workspace_scoped_pk.sql`, `0020_send_events_partitioned.sql` | exact |
| `packages/db/src/schema/partition-maintenance-runs.ts` | model (Drizzle type-inference only) | CRUD | `packages/db/src/schema/events.ts` (any existing schema file — type-inference-only convention) | role-match |
| `apps/worker/src/queues/partition-maintenance.worker.ts` | controller (BullMQ worker) | event-driven / batch | `apps/worker/src/queues/analytics-reconciliation.worker.ts` (repeatable tick + pool scan) | exact |
| `apps/worker/src/server.ts` (modified) | config (composition root) | request-response (registration) | same file, existing `buildWorker()` array | exact (self) |
| `packages/db/scripts/relocate-default-partition-rows.mjs` (or `.ts`) | utility (CLI script) | batch/file-I/O | code from `apps/worker/src/queues/campaign-scheduler.worker.ts` / `flow-reconciliation.worker.ts`'s `SKIP LOCKED` batching idiom + Pattern 3 DDL from `0007`/`0010`/`0020` | role-match |
| `apps/api/src/modules/ops/partition-watchdog.ts` | service (polling watchdog) | event-driven (setInterval) | `apps/api/src/modules/platform-mail/client.ts` (SendGrid send pattern) | role-match |
| `apps/api/src/env.ts` (modified) | config | request-response (boot validation) | same file, existing `envSchema` | exact (self) |
| `packages/db/src/partitions/__tests__/ensure-partitions.test.ts` | test | integration | `packages/db/src/__tests__/migrate-from-empty.test.ts` (ephemeral-DB fixture usage) | exact |
| `apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts` | test | unit | any existing `apps/api` module `__tests__` (mock/seed pattern) — none read directly; follow `migrate-from-empty.test.ts`'s vitest structure loosely | role-match |

## Pattern Assignments

### `packages/db/src/partitions/ensure-partitions.ts` (utility, batch/transform)

**Analog:** `packages/test-support/src/migration-runner.ts` (client interface) + `packages/db/migrations/0007_events_partitioned.sql` / `0020_send_events_partitioned.sql` (DDL shape)

**Structural client interface to copy** (`packages/test-support/src/migration-runner.ts` lines 19-21):
```typescript
/** Anything that can execute a raw SQL string — a `pg` Pool or PoolClient. */
export interface MigrationClient {
  query(queryText: string): Promise<unknown>;
}
```
Use the SAME shape (not `import type { Pool } from "pg"`) for `ensurePartitions`'s client param — Pitfall 5 in RESEARCH.md explicitly calls this out: a concrete `Pool` type import breaks when called from `packages/test-support`'s own pool (different `pg` import graph). Add a `params?: unknown[]` overload since `ensurePartitions` needs parameterized queries (Postgres date bounds), unlike the migration runner's plain-SQL-string case.

**Partition creation DDL shape** (`packages/db/migrations/0007_events_partitioned.sql` lines 27-31):
```sql
CREATE TABLE events_2026_07 PARTITION OF events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE events_2026_08 PARTITION OF events
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
```
`ensurePartitions` computes `[start, end)` per month and issues `CREATE TABLE IF NOT EXISTS <prefix><YYYY_MM> PARTITION OF <parentTable> FOR VALUES FROM ($1) TO ($2)` — parameterize the date bounds, never string-interpolate (V5 threat model in RESEARCH.md: table names are computed from `Date` math only, values are parameterized).

**DEFAULT-partition precedent** (`packages/db/migrations/0010_events_workspace_scoped_pk.sql` lines ~30-33 and `0020_send_events_partitioned.sql`'s trailing `send_events_default` block): both `events_default` and `send_events_default` already exist — `ensurePartitions` does not create these, only monthly partitions; it must be aware they exist for the CHECK-constraint-first defensive attach (Pattern 3, see below).

**CHECK-constraint-first ATTACH pattern** (from RESEARCH.md Pattern 3, verified against `postgresql.org` docs, apply defensively on every attach per RESEARCH.md's Pitfall 1 recommendation):
```sql
ALTER TABLE events_default ADD CONSTRAINT excl_2026_11
  CHECK (occurred_at < '2026-11-01' OR occurred_at >= '2026-12-01') NOT VALID;
ALTER TABLE events_default VALIDATE CONSTRAINT excl_2026_11;
ALTER TABLE events ATTACH PARTITION events_2026_11
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
ALTER TABLE events_default DROP CONSTRAINT excl_2026_11;
```

**Error handling / idempotency:** Follow the migration-runner precedent — no try/catch wrapper needed inside `ensurePartitions` itself; `CREATE TABLE IF NOT EXISTS` already makes creation idempotent. Callers (worker processor) wrap the whole call in their own try/catch per the worker pattern below.

---

### `packages/db/migrations/00XX_partition_catchup_and_maintenance_runs.sql` (migration, batch)

**Analog:** `packages/db/migrations/0007_events_partitioned.sql`, `0010_events_workspace_scoped_pk.sql`, `0020_send_events_partitioned.sql`

**Header comment convention to copy** (from `0007_events_partitioned.sql` lines 1-11):
```sql
-- HAND-WRITTEN (not drizzle-kit generate output): Postgres declarative
-- partitioning -- `PARTITION BY RANGE`, ... has no expression in Drizzle's
-- pgTable API ... packages/db/src/schema/<x>.ts declares the logical column
-- shape for type inference only; this migration owns the actual DDL, same
-- hand-written-migration pattern as 0004/0006/0007/0010/0020's ... (no
-- drizzle-kit meta snapshot accompanies this file).
```

**Attach-months-out-to-horizon pattern:** repeat the `CREATE TABLE <table>_YYYY_MM PARTITION OF <table> FOR VALUES FROM (...) TO (...)` block (0007 lines 27-31) for both `events` and `send_events`, extending past August 2026 out to the chosen horizon (RESEARCH.md Open Question 2 recommends generous margin, e.g. through mid-2027).

**New `partition_maintenance_runs` table** — this table carries NO `workspace_id` (platform-level, per RESEARCH.md Assumption A3), so it must NOT get the RLS treatment every tenant-scoped table in this codebase gets. Do not copy the `ENABLE ROW LEVEL SECURITY` / `FORCE ROW LEVEL SECURITY` / `CREATE POLICY workspace_isolation` block from `0007`/`0020` for this table — those apply only to `events`/`send_events` themselves (which already have RLS from 0007/0020, inherited by any newly-attached child partition automatically, no new policy needed here).

**Migration linter note (Phase 8, referenced in CONTEXT.md canonical_refs):** `CREATE TABLE ... PARTITION OF` and `CREATE TABLE partition_maintenance_runs` are additive/non-destructive DDL — no expand/contract marker comments required (unlike `ALTER TABLE ... DROP COLUMN` style migrations).

---

### `packages/db/src/schema/partition-maintenance-runs.ts` (model, CRUD)

**Analog:** any existing schema file in `packages/db/src/schema/` (e.g. `events.ts`) — the project convention is Drizzle schema files are type-inference only, physical DDL lives in migrations (per every migration's header comment above). Follow the same `pgTable(...)` declaration shape, no partition-specific expression needed since this table is a plain (non-partitioned) table.

---

### `apps/worker/src/queues/partition-maintenance.worker.ts` (controller/BullMQ worker, event-driven+batch)

**Analog:** `apps/worker/src/queues/analytics-reconciliation.worker.ts` (closest — repeatable tick scanning all workspaces/tables and self-healing) and `apps/worker/src/queues/campaign-scheduler.worker.ts` (repeatable-tick registration shape, `SKIP LOCKED`-adjacent batching idiom for the relocation script)

**Imports pattern** (`analytics-reconciliation.worker.ts` lines 1-3):
```typescript
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { PoolClient } from "pg";
import { pool, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
```
Note: this new worker does NOT need `withTenant`/`withTenantTransaction` — `events`/`send_events`/`partition_maintenance_runs` maintenance is platform-level, not tenant-scoped, so use `pool` directly (or the `PartitionClient` from `ensure-partitions.ts`), mirroring how `analytics-reconciliation.worker.ts` uses plain `pool.query` only for its own top-level `SELECT id FROM organization` enumeration step (lines ~113), not for the per-workspace body.

**Repeatable-tick registration to copy, BUT upgraded per D-13** (`campaign-scheduler.worker.ts` lines 100-104, legacy shape — DO NOT copy this exact call, see Code Examples below for the `upsertJobScheduler` replacement RESEARCH.md specifies):
```typescript
// LEGACY shape (existing 4 workers) — do NOT use for this new worker:
void tickQueue.add("scan-due-campaigns", {}, { repeat: { every: SCAN_INTERVAL_MS }, jobId: "scan-due-campaigns" });
```
Use instead (RESEARCH.md Code Examples, D-13, confirmed `upsertJobScheduler` exists in installed BullMQ 5.79.1):
```typescript
const queue = new Queue(PARTITION_MAINTENANCE_QUEUE, { connection });
void queue.upsertJobScheduler(
  "partition-maintenance-daily",
  { pattern: PARTITION_MAINTENANCE_CRON, tz: "UTC" },
  { name: "run-partition-maintenance", opts: DEFAULT_JOB_OPTIONS }
);
// D-07: immediate one-off at boot, in addition to the scheduler
void queue.add("run-partition-maintenance", {}, { jobId: `boot-${Date.now()}` });
```

**Constants-with-rationale-comment convention to copy** (`campaign-scheduler.worker.ts` line 7, `analytics-reconciliation.worker.ts` lines 8-9):
```typescript
const SCAN_INTERVAL_MS = 60_000;
/** A few minutes, per D-08b's stated freshness bound ... */
const RECONCILE_INTERVAL_MS = 3 * 60_000;
```
D-12 requires the SAME convention for `LOOKAHEAD_MONTHS`, `BUFFER_ALERT_THRESHOLD_MONTHS`, `PARTITION_MAINTENANCE_CRON` — versioned constants with a comment referencing the plan/decision number (e.g. `// D-11: +3 months lookahead, alert at <2 months buffer`).

**`DEFAULT_JOB_OPTIONS` to copy verbatim** (`campaign-scheduler.worker.ts` lines 9-14):
```typescript
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: { age: 86400 },
  removeOnFail: false,
};
```
`removeOnFail: false` is load-bearing here — DB-02's "failed job visible" signal (even though Bull Board itself is absent per RESEARCH.md Pitfall 3, a failed job still needs to persist in Redis for any future inspection/Bull Board wiring in Phase 15).

**Core processor pattern to copy the shape of** (`analytics-reconciliation.worker.ts` lines 96-115, self-healing scan-and-act body):
```typescript
return new Worker(
  ANALYTICS_RECONCILE_QUEUE,
  async () => {
    const { rows } = await pool.query<WorkspaceRow>(`SELECT id FROM organization`);
    for (const row of rows) {
      await reconcileWorkspace(row.id, RECONCILE_WINDOW_DAYS);
    }
  },
  { connection }
);
```
The new worker's processor body: `ensurePartitions(pool, PARTITIONED_TABLES, new Date(), LOOKAHEAD_MONTHS)` → compute buffer months (Pitfall 2: consecutive-months-from-current+1 walk, not raw count) → `COUNT(*)` both `_default` tables → upsert into `partition_maintenance_runs`. No try/catch needed inside the processor itself — an unhandled throw is what makes the BullMQ job land in the failed set (the loud signal), matching every existing worker's convention of NOT swallowing errors inside the processor callback.

**No error-swallowing convention:** none of the 4 existing workers wrap their processor body in try/catch — a thrown error naturally fails the BullMQ job (which is the point, per `DEFAULT_JOB_OPTIONS`'s `removeOnFail: false`). Do the same here; do not add a try/catch that would hide a partition-DDL failure from the failed-jobs signal.

---

### `apps/worker/src/server.ts` (modified — registration point)

**Analog:** same file, existing `buildWorker()` composition (lines 74-114)

**Pattern to copy** (lines 79-113, per-worker registration with a rationale comment):
```typescript
// ANLT-04 (07-06): periodic correctness backstop for workspace_daily_rollup
// -- overwrites each recent day's row from a fresh scan of `sends`,
// self-healing any drift from the webhook worker's incremental increments.
createAnalyticsReconciliationWorker(buildRedisConnectionOptions(redisUrl)),
```
Add `createPartitionMaintenanceWorker(buildRedisConnectionOptions(redisUrl))` to the `workers` array with a comment referencing DB-01/DB-02, and update the final `console.log` worker-name list (line ~136) to include `partition-maintenance`. Every worker gets its OWN `buildRedisConnectionOptions(redisUrl)` call — never a shared constructed `Redis` instance (nominal-type mismatch note, lines 27-35).

---

### `packages/db/scripts/relocate-default-partition-rows.mjs` (utility CLI, batch)

**Analog:** batching idiom from `apps/worker/src/queues/campaign-scheduler.worker.ts`'s `SELECT ... FOR UPDATE SKIP LOCKED` discovery pattern (lines 38-53), applied to `DELETE ... RETURNING` per RESEARCH.md's Code Example

**Core batched-transfer pattern** (RESEARCH.md Code Examples, `relocateMonth`, already verified against `0007`/`0010`'s `LIKE ... INCLUDING ALL` precedent):
```typescript
const BATCH_SIZE = 500;
async function relocateMonth(pool: Pool, tableName: string, monthStart: Date, monthEnd: Date): Promise<number> {
  const targetPartition = `${tableName}_${formatYyyyMm(monthStart)}`;
  await pool.query(`CREATE TABLE IF NOT EXISTS ${targetPartition} (LIKE ${tableName} INCLUDING ALL)`);
  let totalMoved = 0;
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `WITH moved AS (
           DELETE FROM ${tableName}_default
           WHERE ctid IN (
             SELECT ctid FROM ${tableName}_default
             WHERE occurred_at >= $1 AND occurred_at < $2
             LIMIT $3 FOR UPDATE SKIP LOCKED
           ) RETURNING *
         )
         INSERT INTO ${targetPartition} SELECT * FROM moved RETURNING 1`,
        [monthStart, monthEnd, BATCH_SIZE]
      );
      await client.query("COMMIT");
      totalMoved += rows.length;
      if (rows.length < BATCH_SIZE) break;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  return totalMoved;
}
```
**Transaction try/catch/rollback shape to copy directly** (`apps/worker/src/queues/campaign-scheduler.worker.ts` lines 37-53, the `findDueCampaignCandidates` pattern):
```typescript
const client = await pool.connect();
try {
  await client.query("BEGIN");
  ...
  await client.query("COMMIT");
  return rows;
} catch (err) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw err;
} finally {
  client.release();
}
```

**Month discovery (D-09, wild timestamps):** `SELECT DISTINCT date_trunc('month', occurred_at) FROM events_default` — do not hard-code "recent months," per RESEARCH.md Pitfall 4.

**Final attach step reuses Pattern 3 (CHECK-constraint-first) from `ensure-partitions.ts`** — the relocation script's last step per table/month is the SAME `ADD CONSTRAINT NOT VALID` / `VALIDATE CONSTRAINT` / `ATTACH PARTITION` sequence; factor it as an exported function in `ensure-partitions.ts` so both callers share it (avoids duplicating Pitfall 1's mitigation).

**D-08 requirement — script and test share code:** structure this as a thin CLI wrapper (`.mjs` or a `bin`-style TS entrypoint) around an exported, directly-callable function (e.g. `relocateAllDefaultRows(pool)`), so `packages/db/src/partitions/__tests__/relocate-default.test.ts` imports and calls the exact same function the CLI invokes — never re-implements the logic.

---

### `apps/api/src/modules/ops/partition-watchdog.ts` (service, event-driven/polling)

**Analog:** `apps/api/src/modules/platform-mail/client.ts` (SendGrid send pattern, same key)

**Imports and SendGrid dispatch pattern to copy** (`platform-mail/client.ts` lines 1-25):
```typescript
import sgMail from "@sendgrid/mail";
import { env } from "../../env.js";

sgMail.setApiKey(env.PLATFORM_SENDGRID_API_KEY);

async function dispatch(to: string, subject: string, html: string): Promise<void> {
  await sgMail.send({ to, from: env.PLATFORM_MAIL_FROM, subject, html });
}
```
**Adapt, not copy verbatim:** D-04 requires plain-text, not HTML — use `sgMail.send({ to, from: env.PLATFORM_MAIL_FROM, subject, text: body })` (the `text` field instead of `html`, no template import). Do not import any of `templates/verify-email.js` etc. — this is the ONE place in the codebase D-04 explicitly forbids the Dynamic-Template-adjacent HTML-template convention `platform-mail` otherwise establishes.

**Exported object shape to mirror** (`platform-mail/client.ts` lines 27-48, `export const platformMail = { async sendX(...) {...}, ... }`):
```typescript
export const partitionWatchdog = {
  async checkAndAlert(): Promise<void> { ... },
};
```

**No existing `setInterval`-based background task precedent in `apps/api`** (RESEARCH.md "Don't Hand-Roll" explicitly notes this is the first one) — a plain `setInterval(checkPartitionHealth, WATCHDOG_INTERVAL_MS)` registered at boot (near where `buildServer()`'s `app.listen(...)` is called, `apps/api/src/server.ts` line 102) is the correct level of complexity; do not import any queue/scheduling library for this.

**Query + health-check logic** (RESEARCH.md Pattern 2, Code Examples):
```typescript
const WATCHDOG_INTERVAL_MS = 15 * 60_000;
const STALE_THRESHOLD_HOURS = 26;

async function checkPartitionHealth(): Promise<void> {
  const { rows } = await pool.query<PartitionRunRow>(
    `SELECT last_run_at, buffer_months_remaining,
            events_default_count, send_events_default_count
     FROM partition_maintenance_runs ORDER BY last_run_at DESC LIMIT 1`
  );
  const row = rows[0];
  const unhealthy =
    !row ||
    Date.now() - row.last_run_at.getTime() > STALE_THRESHOLD_HOURS * 3_600_000 ||
    row.buffer_months_remaining < 2 ||
    row.events_default_count > 0 ||
    row.send_events_default_count > 0;
  if (unhealthy) await sendOperatorAlert(row);
}
```
**Alert-cadence caveat (RESEARCH.md Known Threat Patterns table, "watchdog email flooding"):** D-03's "every run while unhealthy" refers to the DAILY job's cadence, not the watchdog's own poll interval (recommended 15 min here) — the watchdog must NOT send on every 15-minute poll; gate actual sends to at most once per day-scale window (e.g., only send if no alert was sent in the last ~20h) even though the underlying "unhealthy" check runs every 15 min. This dedup-by-day logic is new — there is no existing precedent in this codebase to copy for it; implement explicitly and comment the rationale referencing D-03.

---

## Shared Patterns

### Structural `{ query(...): Promise<unknown> }` client interface (not `pg.Pool` import)
**Source:** `packages/test-support/src/migration-runner.ts` lines 19-21
**Apply to:** `ensure-partitions.ts`, `relocate-default-partition-rows.mjs`'s exported core function — anything callable from both `apps/worker`'s pool and `packages/test-support`'s pool. This is Pitfall 5's explicit mitigation.

### Versioned constants with rationale comment referencing the plan/decision number
**Source:** `apps/worker/src/queues/campaign-scheduler.worker.ts` line 7 (`SCAN_INTERVAL_MS`), `analytics-reconciliation.worker.ts` lines 8-9 (`RECONCILE_INTERVAL_MS` / `RECONCILE_WINDOW_DAYS`)
**Apply to:** `LOOKAHEAD_MONTHS`, `BUFFER_ALERT_THRESHOLD_MONTHS`, `PARTITION_MAINTENANCE_CRON`, `WATCHDOG_INTERVAL_MS`, `STALE_THRESHOLD_HOURS` — D-12 requires this exact convention, not env vars.

### BullMQ repeatable-tick registration is idempotent by construction (safe to call on every boot)
**Source:** `apps/worker/src/queues/campaign-scheduler.worker.ts` lines 100-102 comment: "BullMQ dedupes a repeatable job by its own repeat config + jobId, so calling this on every worker boot never creates a second competing repeatable schedule."
**Apply to:** `createPartitionMaintenanceWorker` — the same guarantee applies to `upsertJobScheduler` with a stable scheduler ID (`"partition-maintenance-daily"`).

### Transaction try/catch/rollback/finally shape
**Source:** `apps/worker/src/queues/campaign-scheduler.worker.ts` lines 37-53
**Apply to:** `relocate-default-partition-rows.mjs`'s per-batch transaction, any raw-pool multi-statement sequence in `ensure-partitions.ts`.

### No error-swallowing inside BullMQ processor callbacks
**Source:** all 4 existing worker files — none wrap the processor body in try/catch; an unhandled throw fails the job.
**Apply to:** `partition-maintenance.worker.ts`'s processor — DB-02's "loud failure" signal depends on this NOT being caught silently.

### Platform SendGrid key reuse, plain-text override
**Source:** `apps/api/src/modules/platform-mail/client.ts` (`sgMail.setApiKey(env.PLATFORM_SENDGRID_API_KEY)`)
**Apply to:** `partition-watchdog.ts` — same key/env var, but `text` body not `html` template, per D-04.

### Migration header-comment convention (hand-written, no drizzle-kit snapshot)
**Source:** `packages/db/migrations/0007_events_partitioned.sql` lines 1-11 (and identical framing in `0010`, `0020`)
**Apply to:** the new catch-up migration file — must explain why it's hand-written and reference the schema file it's paired with.

## No Analog Found

None — every file has at least a role-match analog; RESEARCH.md's own "Key insight" confirms every new piece of infrastructure has a close in-repo precedent.

## Metadata

**Analog search scope:** `apps/worker/src/queues/`, `apps/api/src/modules/`, `apps/api/src/`, `packages/db/migrations/`, `packages/db/src/schema/`, `packages/test-support/src/`
**Files scanned:** `campaign-scheduler.worker.ts`, `analytics-reconciliation.worker.ts`, `apps/worker/src/server.ts`, `0007_events_partitioned.sql`, `0010_events_workspace_scoped_pk.sql`, `0020_send_events_partitioned.sql`, `packages/test-support/src/migration-runner.ts`, `packages/test-support/src/db-fixture.ts`, `apps/api/src/modules/platform-mail/client.ts`, `apps/api/src/env.ts`, `apps/api/src/server.ts`, `packages/db/src/__tests__/migrate-from-empty.test.ts`, `packages/db/package.json`, `apps/worker/package.json`
**Pattern extraction date:** 2026-08-06
