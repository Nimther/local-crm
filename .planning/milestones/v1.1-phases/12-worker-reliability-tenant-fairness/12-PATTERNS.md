# Phase 12: Worker Reliability & Tenant Fairness - Pattern Map

**Mapped:** 2026-08-10
**Files analyzed:** 15 (new + modified)
**Analogs found:** 15 / 15

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `apps/worker/src/queues/email-broadcast.worker.ts` (EDIT — WRK-01 cause split + WRK-02 semaphore) | controller (job processor) | request-response | itself (current version) + `email-triggered.worker.ts` | exact |
| `apps/worker/src/queues/email-triggered.worker.ts` (EDIT — same) | controller (job processor) | request-response | itself (current version) + `email-broadcast.worker.ts` | exact |
| `packages/queue-core/src/tenant-fairness/tenant-lane-semaphore.ts` (NEW — WRK-02 concurrency cap) | utility/service | CRUD (acquire/release counter) | `apps/worker/src/queues/rate-limiter.ts` | role-match (sibling Redis primitive, different algorithm) |
| `apps/worker/src/queues/send-dispatch.ts` (EDIT — semaphore acquire/release call sites) | service | request-response | itself (current version, six `rate_limited` return sites) | exact |
| `packages/queue-core/src/connection.ts` (NEW — absorbs `apps/worker/src/queues/connection.ts`) | config/utility | request-response | `apps/worker/src/queues/connection.ts` | exact |
| `packages/queue-core/src/queue-options.ts` (NEW — absorbs Phase 11's `queue-options.ts` + 3 literal-copy sites) | config | request-response | `apps/worker/src/queues/queue-options.ts`, `apps/worker/src/queues/flows/flow-queues.ts` | exact |
| `packages/queue-core/src/error-listeners.ts` (NEW — WRK-08 shared listener) | utility | event-driven | none (net-new; nearest shape is `partitionMaintenancePool.on("error", ...)` in `partition-maintenance.worker.ts`) | partial-match |
| `apps/worker/src/queues/dead-letter/dead-letter-writer.ts` (NEW — WRK-09/10 DB write on terminal failure) | service | event-driven → CRUD (INSERT) | `apps/api/src/modules/ops/partition-watchdog.ts` (write-adjacent health-row shape) + `@mega-crm/redaction`'s `scrub` | role-match |
| `packages/db/migrations/00NN_dead_letter_jobs.sql` (NEW) | migration | CRUD | migration for `partition_maintenance_runs` (health-row table, platform-scoped not tenant-scoped) | role-match |
| `apps/api/src/modules/ops/dead-letter-watchdog.ts` (NEW — third watchdog) | service (background poll) | pub-sub / event-driven | `apps/api/src/modules/ops/partition-watchdog.ts`, `apps/api/src/modules/ops/send-reconciler-watchdog.ts` | exact |
| `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` (REWRITE — bounded, resumable, checkpointed) | controller (tick worker) | batch / event-driven | `apps/worker/src/queues/recipient-snapshot.ts` (keyset pagination) + itself (current discovery half, Pattern 2) | exact |
| `apps/worker/src/queues/flows/flow-segment-sweep-checkpoint.ts` (NEW — checkpoint table read/write) | model/service | CRUD | `apps/worker/src/queues/recipient-snapshot.ts`'s `materializeBatch`/cursor-on-`campaigns.snapshot_cursor` | exact |
| `packages/db/migrations/00NN_flow_segment_sweep_checkpoint.sql` (NEW) | migration | CRUD | `campaigns.snapshot_cursor` column precedent (same cursor-on-a-row shape, per-flow instead of per-campaign) | role-match |
| `apps/worker/src/server.ts` (EDIT — `WorkerRuntime.close()` tracks + closes tick Queues) | config/lifecycle | event-driven | itself (current `close` function + `workers: Worker[]` registry) | exact |
| `apps/worker/src/queues/campaign-scheduler.worker.ts`, `analytics-reconciliation.worker.ts`, `flows/flow-reconciliation.worker.ts` (EDIT — migrate to `upsertJobScheduler`) | controller (tick worker) | event-driven | `apps/worker/src/queues/partition-maintenance.worker.ts`, `apps/worker/src/queues/send-reconciler.worker.ts` | exact |
| `apps/api/src/modules/campaigns/campaign-queues.ts`, `apps/api/src/modules/contacts/imports-csv-queue.ts` (EDIT — swap to `queue-core` factory) | config | request-response | `apps/worker/src/queues/flows/flow-queues.ts` (singleton-Queue-module convention) | role-match |

## Pattern Assignments

### `apps/worker/src/queues/email-broadcast.worker.ts` / `email-triggered.worker.ts` (controller, request-response) — WRK-01 + WRK-02

**Analog:** the files themselves (Phase 11 state) — this is an edit, not a new-file creation.

**Current cause-split bug** (`email-broadcast.worker.ts` lines 28-36, identical in `email-triggered.worker.ts` lines 25-31):
```typescript
if (result.outcome === "rate_limited") {
  if (result.cause === "tenant_bucket") {
    // BUG (WRK-01): worker.rateLimit() pauses the WHOLE worker's draining,
    // not just this tenant's jobs -- wrong mechanism for a tenant-scoped cause.
    await worker.rateLimit(result.rateLimitMs);
    throw Worker.RateLimitError();
  }
  throw new Error(`SendGrid provider backoff (suggested retry in ~${result.rateLimitMs}ms)`);
}
```

**Target shape (WRK-01 fix, from RESEARCH.md Pattern 1, verified against BullMQ's own `process-step-jobs` doc):**
```typescript
import { DelayedError, Worker, type Job } from "bullmq";

export async function handleEmailBroadcastJob(
  job: Job<EmailBroadcastJob>,
  worker: Worker<EmailBroadcastJob>,
  deps: ProcessSendJobDeps = {}
): Promise<void> {
  // NOTE: token is the processor's own second argument in the real Worker
  // callback (`(job, token) => ...`) -- when calling this exported handler
  // from the Worker constructor, thread `token` through as a third param;
  // do not construct/derive it independently.
  const result = await processSendJob(job.data, deps);
  if (result.outcome === "rate_limited") {
    if (result.cause === "tenant_bucket") {
      await job.moveToDelayed(Date.now() + result.rateLimitMs, token);
      throw new DelayedError(); // no code path may run after this
    }
    // cause === "provider_backoff": unchanged, worker.rateLimit() + RateLimitError
    await worker.rateLimit(result.rateLimitMs);
    throw Worker.RateLimitError();
  }
}
```
Both Worker constructors (`createEmailBroadcastWorker`/`createEmailTriggeredWorker`, lines 65-74 / 54-63) must pass `token` into the exported handler: `(job, token) => handleEmailBroadcastJob(job, worker, deps, token)`.

**WRK-02 semaphore acquire/release (D-01/D-02) — same call site, added around the SendGrid dispatch inside `processSendJob` (`send-dispatch.ts`), not inside the Worker wrapper:**
```typescript
// send-dispatch.ts — sibling of consumeTenantToken (rate-limiter.ts), same
// keyed-by-(workspaceId, lane) shape, D-02's "tenant + queue" key.
const slot = await acquireTenantLaneSlot(redisClient, workspaceId, lane); // lane: "broadcast" | "triggered"
if (!slot.acquired) {
  return { outcome: "rate_limited", cause: "tenant_bucket", rateLimitMs: slot.retryAfterMs };
}
try {
  // ... existing consumeTenantToken(...) RPS check, then the SendGrid call ...
} finally {
  await releaseTenantLaneSlot(redisClient, workspaceId, lane, slot.token);
}
```

---

### `packages/queue-core/src/tenant-fairness/tenant-lane-semaphore.ts` (NEW — WRK-02)

**Analog:** `apps/worker/src/queues/rate-limiter.ts` (architectural sibling — same Redis client injection, same per-tenant keying, same discriminated-result-instead-of-throw convention; different algorithm: N-concurrent-holders instead of tokens-per-second).

**Imports/shape to mirror** (`rate-limiter.ts` lines 1-19, 41-46):
```typescript
import type { Redis } from "ioredis";

/** Per-lane cap, versioned constant with rationale, D-03 (env-overridable). */
export const DEFAULT_TENANT_LANE_CONCURRENCY = { broadcast: 5, triggered: 20 } as const; // exact values: planner discretion

export interface AcquireSlotResult {
  acquired: boolean;
  /** Present only when acquired -- pass back to release the SAME slot. */
  token?: string;
  /** Present only when NOT acquired -- same shape as ConsumeTokenResult.msBeforeNext. */
  retryAfterMs?: number;
}
```

**Core CRUD pattern (INCR/DECR+TTL Lua pair, or `redis-semaphore` package per RESEARCH.md's candidate — either satisfies D-01's acquire-before-dispatch shape):**
```typescript
// Key shape mirrors rate-limiter.ts's per-instance-per-value cache pattern,
// but keyed per (tenant, lane) per D-02 -- NOT tenant-only.
const SEMAPHORE_KEY_PREFIX = "tenant-lane-sem";

export async function acquireTenantLaneSlot(
  redisClient: Redis,
  workspaceId: string,
  lane: "broadcast" | "triggered",
  leaseTtlMs: number
): Promise<AcquireSlotResult> {
  const key = `${SEMAPHORE_KEY_PREFIX}:${workspaceId}:${lane}`;
  // Lua: INCR key; if > cap, DECR and return "reject"; else PEXPIRE key leaseTtlMs.
  // ... (exact Lua or redis-semaphore call, planner discretion) ...
}

export async function releaseTenantLaneSlot(
  redisClient: Redis,
  workspaceId: string,
  lane: "broadcast" | "triggered",
  token?: string
): Promise<void> {
  // DECR (or semaphore.release(token)) — always in a `finally` at the call site.
}
```

**Error handling:** same discriminated-result convention as `consumeTenantToken` (`rate-limiter.ts` lines 56-74) — a genuine Redis error propagates (never silently treated as "acquired"), since that would defeat the cap the module exists to enforce.

---

### `packages/queue-core/src/connection.ts` (NEW, absorbs `apps/worker/src/queues/connection.ts`)

**Analog:** `apps/worker/src/queues/connection.ts` (28 lines, copy near-verbatim into the new package; update import path at all call sites: `apps/worker/src/server.ts`, `apps/worker/src/queues/flows/flow-queues.ts`, `apps/api/src/modules/campaigns/campaign-queues.ts`, `apps/api/src/modules/contacts/imports-csv-queue.ts`).

**Full content to relocate** (`connection.ts` lines 1-28):
```typescript
import { Redis, type RedisOptions } from "ioredis";

export function buildRedisConnectionOptions(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  const db = url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined;
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    db,
    maxRetriesPerRequest: null, // REQUIRED by BullMQ
  };
}

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(buildRedisConnectionOptions(redisUrl));
}
```
Preserve the `maxRetriesPerRequest: null` comment verbatim — it documents a BullMQ requirement, not an arbitrary choice.

---

### `packages/queue-core/src/queue-options.ts` (NEW, absorbs Phase 11's constants + 3 literal copies)

**Analog:** `apps/worker/src/queues/queue-options.ts` (77 lines — move whole file, re-export from old path if needed for a transition period) + the retention-as-parameter requirement from `apps/worker/src/queues/flows/flow-queues.ts`.

**Constants to move verbatim** (`queue-options.ts` lines 27-77): `SEND_LOCK_DURATION_MS`, `CLAIM_TX_MARGIN_MS`, `RECORD_TX_MARGIN_MS`, `SEND_JOB_MAX_ATTEMPTS`, `SEND_JOB_BACKOFF_DELAY_MS`, `SEND_MAX_JOB_LIFETIME_MS` (and its `computeExponentialBackoffSumMs` helper).

**Retention-as-parameter factory shape (Pitfall 6 — do NOT bake in one retention shape), modeled on the two DIFFERENT existing shapes that must both remain expressible** (`flow-queues.ts` lines 12-18 vs 31-36):
```typescript
// Shared default (7 queues use this shape today):
export const STANDARD_JOB_OPTIONS = {
  attempts: SEND_JOB_MAX_ATTEMPTS,
  backoff: { type: "exponential" as const, delay: SEND_JOB_BACKOFF_DELAY_MS },
  removeOnComplete: { age: 86400 },
  removeOnFail: false, // WRK-09: this becomes a bounded age ONLY after the DLQ writer (WRK-10) is wired for that queue — Pitfall 7 sequencing
};

// flow-run-advance's deliberately DIFFERENT shape (CR-01 precedent, preserve exactly):
export const FLOW_RUN_ADVANCE_JOB_OPTIONS = {
  attempts: SEND_JOB_MAX_ATTEMPTS,
  backoff: { type: "exponential" as const, delay: SEND_JOB_BACKOFF_DELAY_MS },
  removeOnComplete: true,
  removeOnFail: { age: 86400 },
};

// Factory takes retention as a REQUIRED parameter, no shared default baked in:
export function buildJobOptions(retention: { removeOnComplete: unknown; removeOnFail: unknown }) {
  return { attempts: SEND_JOB_MAX_ATTEMPTS, backoff: { type: "exponential" as const, delay: SEND_JOB_BACKOFF_DELAY_MS }, ...retention };
}
```

---

### `packages/queue-core/src/error-listeners.ts` (NEW — WRK-08)

**Analog:** none exact in-repo (first `worker.on("error"/"failed")` listener anywhere in `apps/worker`); nearest precedent is `partitionMaintenancePool.on("error", ...)` in `partition-maintenance.worker.ts` (lines 90-97) for the "log, don't crash the process" shape, and `scrubbedConsole` as the established sink.

**Shape (RESEARCH.md Code Examples, exact target):**
```typescript
import type { Worker } from "bullmq";
import { scrubbedConsole } from "@mega-crm/redaction";

export function attachSharedErrorListeners(worker: Worker, queueName: string): void {
  worker.on("error", (err) => {
    scrubbedConsole.error(`${queueName}: worker error`, err);
  });
  worker.on("failed", (job, err) => {
    scrubbedConsole.error(`${queueName}: job failed`, { jobId: job?.id, err: err.message });
    // WRK-10: dead-letter write here, gated on job.attemptsMade >= (job.opts.attempts ?? 1)
    // -- a mid-retry "failed" event is NOT terminal.
  });
}
```
Call at every `new Worker(...)` construction site across `apps/worker` (15 workers).

---

### `apps/worker/src/queues/dead-letter/dead-letter-writer.ts` (NEW — WRK-09/10)

**Analog:** redaction call site pattern from RESEARCH.md Code Examples; DB-write shape mirrors `partition-maintenance.worker.ts`'s health-row write style (plain `Pool`, no `withTenant` — platform-scoped table like `partition_maintenance_runs`).

**Redaction (exact import, RESEARCH.md verified against `packages/redaction/src/index.ts` — note the real export is `scrub`, NOT `redactPayload`):**
```typescript
import { scrub } from "@mega-crm/redaction";
const redactedPayload = scrub(job.data);
```

**Terminal-failure gate (do not write on a mid-retry "failed" event):**
```typescript
export async function writeDeadLetterOnTerminalFailure(job: Job, err: Error, queueName: string): Promise<void> {
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return; // not terminal yet -- BullMQ will redeliver
  await pool.query(
    `INSERT INTO dead_letter_jobs (queue_name, job_id, job_name, payload, error, failed_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [queueName, job.id, job.name, JSON.stringify(scrub(job.data)), err.message]
  );
}
```
Wire into `attachSharedErrorListeners`'s `worker.on("failed", ...)` callback.

---

### `apps/api/src/modules/ops/dead-letter-watchdog.ts` (NEW — third watchdog, D-08)

**Analog:** `apps/api/src/modules/ops/partition-watchdog.ts` (267 lines) — copy structure exactly; `send-reconciler-watchdog.ts` is the second precedent confirming the pattern generalizes.

**`claimAlertSlot` atomic-dedup pattern to replicate** (`partition-watchdog.ts` lines 181-191, exact SQL shape to adapt to a `dead_letter_jobs`-appropriate condition table/row):
```typescript
export async function claimAlertSlot(client: PartitionClient, now: Date, dedupHours: number): Promise<boolean> {
  const { rows } = await client.query(
    `UPDATE <health_or_watermark_table>
        SET last_alert_sent_at = $1::timestamptz
      WHERE id = 1
        AND (last_alert_sent_at IS NULL OR last_alert_sent_at < $1::timestamptz - make_interval(hours => $2))
      RETURNING last_alert_sent_at`,
    [now, dedupHours]
  );
  return rows.length > 0;
}
```

**Check-and-alert + release-on-send-failure pattern** (`partition-watchdog.ts` lines 218-245) — copy the exact "claim BEFORE sendMail, release claim on sendMail rejection" ordering; this is the same CR-02 fix both existing watchdogs already encode.

**Poll-loop registration** (`partition-watchdog.ts` lines 260-266):
```typescript
export function startDeadLetterWatchdog(deps: StartDeadLetterWatchdogDeps): NodeJS.Timeout {
  return setInterval(() => {
    void checkDeadLetterHealthAndAlert({ ...deps, now: new Date() }).catch((err: unknown) => {
      console.error("dead-letter-watchdog: health check failed", err);
    });
  }, WATCHDOG_INTERVAL_MS);
}
```
Uses `OPERATOR_ALERT_EMAIL` + platform SendGrid key, same as the other two watchdogs. Wire into `apps/api/src/server.ts` boot alongside `startPartitionWatchdog`/`startSendReconcilerWatchdog` (not shown here — grep `apps/api/src/server.ts` for the exact two existing call sites at implementation time).

---

### `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` (REWRITE — WRK-05/06)

**Analog (discovery half, keep unchanged):** the file's own current `findLiveSegmentTriggeredFlows` (lines 51-63) — `withCrossWorkspaceScan`, do not touch.

**Analog (bounded per-flow walk, NEW):** `apps/worker/src/queues/recipient-snapshot.ts`'s `materializeBatch` (lines 42-76) is the structural template for keyset pagination + atomic cursor write in the same transaction as the page's other writes.

**Critical divergence from `recipient-snapshot.ts` (D-09/Pitfall 3 — do NOT copy this part verbatim):** `recipient-snapshot.ts`'s cursor is a permanent one-shot freeze (`campaigns.snapshot_cursor`, never reset). The sweep is perpetual — **reset the cursor to `NULL` on successful full completion of each walk**:
```typescript
if (lastContactId) {
  await client.query(
    `UPDATE flow_segment_sweep_checkpoint SET cursor = $2, updated_at = now() WHERE flow_id = $1`,
    [flowId, lastContactId]
  );
} else {
  // Walk complete this tick -- RESET so next tick re-walks from the start.
  await client.query(
    `UPDATE flow_segment_sweep_checkpoint SET cursor = NULL, updated_at = now() WHERE flow_id = $1`,
    [flowId]
  );
}
```

**Split discovery-and-enqueue from bounded walk (mirroring `campaign-scheduler` → `campaign-kickoff`):** the current `runFlowSegmentSweepTick` (lines 156-161) does discovery + full walk inline in one tick; split so discovery enqueues one bounded-walk job per flow with a deterministic `jobId` per flow (e.g. `sweep-${row.id}`) so a still-running sweep for that flow is never double-enqueued.

**Registration migration (WRK-13, target state — this file currently uses the OLD `tickQueue.add({repeat})` form, lines 170-182):**
```typescript
// CURRENT (to replace):
const tickQueue = new Queue(FLOW_SEGMENT_SWEEP_QUEUE, { connection });
void tickQueue.add("scan-segment-triggered-flows", {}, { repeat: { every: SWEEP_INTERVAL_MS }, jobId: "scan-segment-triggered-flows" });
return new Worker(FLOW_SEGMENT_SWEEP_QUEUE, runFlowSegmentSweepTick, { connection });
```
Replace with the `upsertJobScheduler` + try/catch/finally + `queue.close()` shape from `partition-maintenance.worker.ts` (see below).

---

### `apps/worker/src/queues/flows/flow-segment-sweep-checkpoint.ts` (NEW — D-09)

**Analog:** `apps/worker/src/queues/recipient-snapshot.ts`'s `loadSnapshotState`/cursor-column pattern (lines 78-97), adapted to a dedicated per-flow checkpoint table instead of a column on `campaigns` (D-09 explicitly rejects `job.updateData()` and a bare Redis key — the checkpoint MUST be a Postgres row, committed in the SAME transaction as that page's enrollment work).

```typescript
export async function loadSweepCheckpoint(client: PoolClient, flowId: string): Promise<string | null> {
  const { rows } = await client.query<{ cursor: string | null }>(
    `SELECT cursor FROM flow_segment_sweep_checkpoint WHERE flow_id = $1`,
    [flowId]
  );
  return rows[0]?.cursor ?? null;
}
```

---

### `apps/worker/src/server.ts` (EDIT — WRK-07, close all tick Queues)

**Analog:** the file itself (current `WorkerRuntime.close` lines 145-148 — closes only `workers: Worker[]`, never the internal tick `Queue`s six factories construct).

**Current gap (verbatim):**
```typescript
const close = async (): Promise<void> => {
  await Promise.all(workers.map((worker) => worker.close()));
  connection.disconnect();
};
```

**Target shape — extend `WorkerRuntime` to also track closeable `Queue` handles** (each factory that constructs an internal tick `Queue` — `send-reconciler`, `analytics-reconciliation`, `campaign-scheduler` (TWO handles: `tickQueue` AND the long-lived `kickoffQueue`), `partition-maintenance`, `flow-segment-sweep`, `flow-reconciliation` — must return that handle alongside its `Worker`, OR route construction through a `queue-core` self-registering helper):
```typescript
export interface WorkerRuntime {
  connection: ReturnType<typeof createRedisConnection>;
  workers: Worker[];
  queues: Queue[]; // NEW -- every tracked internal tick/producer Queue
  close: () => Promise<void>;
}
// ...
const close = async (): Promise<void> => {
  await Promise.all(workers.map((worker) => worker.close()));
  await Promise.all(queues.map((queue) => queue.close()));
  connection.disconnect();
};
```
Note: `partition-maintenance.worker.ts` and `send-reconciler.worker.ts`'s *registration* queues already self-close in their own `finally` (see below) — only the genuinely long-lived `kickoffQueue`-style handles need to be added to this new `queues` array.

---

### `campaign-scheduler.worker.ts`, `analytics-reconciliation.worker.ts`, `flow-reconciliation.worker.ts` (EDIT — WRK-13, migrate to `upsertJobScheduler`)

**Analog:** `apps/worker/src/queues/partition-maintenance.worker.ts` lines 237-253 (exact target shape, already the codebase's own precedent) and `send-reconciler.worker.ts` (second precedent).

**Full pattern to replicate verbatim (structure, not exact SQL/cron):**
```typescript
const registration = (async () => {
  try {
    await queue.upsertJobScheduler(
      JOB_SCHEDULER_ID,          // stable id, constant across every boot
      { every: TICK_INTERVAL_MS }, // or { pattern: CRON, tz: "UTC" } for a fixed-hour job
      { name: JOB_NAME, opts: DEFAULT_JOB_OPTIONS }
    );
    await queue.add(JOB_NAME, {}, { ...DEFAULT_JOB_OPTIONS, jobId: bootJobId });
  } catch (err) {
    scrubbedConsole.error(`${queueName}: scheduler registration failed`, err);
  } finally {
    await queue.close().catch(() => undefined);
  }
})();
```
This closes the RESEARCH.md Anti-Pattern: current four-worker form has no `try/finally` and never calls `queue.close()` at all, leaking a Redis connection for the life of the process (Pitfall 4).

## Shared Patterns

### Exported standalone processor (testability convention)
**Source:** `apps/worker/src/queues/email-broadcast.worker.ts` lines 16-46 (`handleEmailBroadcastJob`), `apps/worker/src/queues/partition-maintenance.worker.ts` lines 121-147 (`processPartitionMaintenance`)
**Apply to:** every edited/new worker processor — factor the per-job/per-tick body out of the `Worker` constructor callback so tests can invoke it directly with fake deps, without a live Queue/Redis round trip. Default `deps: SomeDeps = {}` so existing call sites are unaffected.

### `withCrossWorkspaceScan` for cross-tenant discovery, `withTenant`/`withTenantTransaction` for everything after
**Source:** `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` lines 38-63 (discovery) and lines 89-146 (`sweepOneFlow`'s re-entry into `withTenant`)
**Apply to:** the sweep rewrite must NOT change this half — the admin-scan exception grants nothing beyond initial discovery; every subsequent read/write re-enters normal RLS-scoped tenant context.

### Keyset pagination, never OFFSET
**Source:** `apps/worker/src/queues/recipient-snapshot.ts` lines 22-76 (`c.id > $cursor ORDER BY c.id ASC LIMIT`, `statement_timeout` scoped via `SELECT set_config('statement_timeout', $1, true)`)
**Apply to:** `flow-segment-sweep-checkpoint.ts`'s per-flow walk (WRK-05/06) and the stale-snapshot anti-join `DELETE` (already `LIMIT`-bounded per the current file, extend the same discipline).

### Fire-and-forget scheduler registration with try/catch/finally
**Source:** `apps/worker/src/queues/partition-maintenance.worker.ts` lines 217-253
**Apply to:** every WRK-13 migration target (`campaign-scheduler`, `analytics-reconciliation`, `flow-segment-sweep`, `flow-reconciliation`) — never let a rejecting `upsertJobScheduler`/`add` become an unhandled promise rejection (which crashes the WHOLE `apps/worker` process, all 15 workers, per CR-04's own documented history).

### Watchdog / `claimAlertSlot` / `OPERATOR_ALERT_EMAIL` dead-man's-switch
**Source:** `apps/api/src/modules/ops/partition-watchdog.ts` (whole file, 267 lines), `apps/api/src/modules/ops/send-reconciler-watchdog.ts` (second precedent)
**Apply to:** `dead-letter-watchdog.ts` (D-08) — third consumer of a twice-proven pattern; copy the atomic-claim-before-send + release-on-send-failure ordering exactly (CR-02).

### `scrubbedConsole` as the logging sink (Pino arrives Phase 15)
**Source:** used throughout `apps/worker/src/queues/partition-maintenance.worker.ts`, `apps/worker/src/server.ts`
**Apply to:** `error-listeners.ts`'s `attachSharedErrorListeners`, all edited worker files — never introduce `console.log`/`console.error` directly in `apps/worker` code (API-side watchdogs still use plain `console.error`, per existing precedent — do not "fix" that inconsistency in this phase, it is out of scope).

### Versioned constants with rationale comments (Phase 9 D-12 convention)
**Source:** `apps/worker/src/queues/queue-options.ts` (whole file — every exported constant has a multi-line rationale comment, several derived via a named helper function rather than hand-typed)
**Apply to:** `DEFAULT_TENANT_LANE_CONCURRENCY` (WRK-02 cap values), the fairness threshold percentage (D-05), `DEFAULT_TENANT_RPS`-adjacent load-test volumes (D-06), the derived drain-timeout value (WRK-07/Pitfall 5).

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `packages/queue-core/src/error-listeners.ts` | utility | event-driven | No `worker.on("error"/"failed")` listener exists anywhere in `apps/worker` today (confirmed by CONTEXT.md D-11) — RESEARCH.md's own Code Examples section is the closest available reference, itself derived from BullMQ's official docs rather than an in-repo precedent. |
| Two-tenant fairness load test (WRK-03/04, file location not yet named in CONTEXT.md — likely `apps/worker/src/queues/__tests__/tenant-fairness.test.ts` or similar) | test | batch | Phase 8's failure-injection harness (`packages/test-support`, fake `sendMail` seam) is the closest infrastructure precedent, but no existing test scenario measures relative-to-baseline throughput across two tenants — this is a genuinely new scenario shape per D-04/D-05, to be built on top of (not copied from) an existing failure-injection test file. Planner should reference `apps/worker/src/queues/__tests__/` and `apps/worker/src/test/failure-fixtures.ts` structurally, not for a specific test to clone. |
| `packages/queue-core/src/tenant-fairness/tenant-lane-semaphore.ts`'s exact Lua/library choice | utility | CRUD | Genuinely new primitive per RESEARCH.md — `rate-limiter-flexible` has no concurrency/semaphore class; `redis-semaphore` (candidate) has zero in-repo usage to copy from. Use `rate-limiter.ts`'s call-site conventions (Redis client injection, discriminated result) as the shape to match, not an algorithm to copy. |

## Metadata

**Analog search scope:** `apps/worker/src/queues/`, `apps/worker/src/queues/flows/`, `apps/worker/src/server.ts`, `apps/api/src/modules/ops/`, `apps/api/src/modules/campaigns/`, `apps/api/src/modules/contacts/`
**Files scanned:** 15 read in full (all ≤ 688 lines, single-pass reads, no re-reads)
**Pattern extraction date:** 2026-08-10
