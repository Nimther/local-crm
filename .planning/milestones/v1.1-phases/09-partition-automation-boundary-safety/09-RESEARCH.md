# Phase 9: Partition Automation & Boundary Safety - Research

**Researched:** 2026-08-06
**Domain:** PostgreSQL declarative partitioning automation (BullMQ repeatable job) + dead-man's-switch alerting across two processes
**Confidence:** HIGH

## Summary

This phase closes a hard external deadline: `events` and `send_events` have monthly partitions only through August 2026 (`packages/db/migrations/0007_events_partitioned.sql`, `0020_send_events_partitioned.sql`), and both tables already have a `DEFAULT` catch-all partition (`0010_events_workspace_scoped_pk.sql`). From 2026-09-01, any un-created month routes new rows into `DEFAULT`, and — per PostgreSQL's own documented behavior, verified directly against `postgresql.org/docs/current/ddl-partitioning.html` and `sql-altertable.html` — every subsequent `ATTACH PARTITION` then pays a full scan of `DEFAULT` under an `ACCESS EXCLUSIVE` lock to prove it holds no rows in the new range. That is the ingestion outage this phase exists to prevent.

The codebase already has four working repeatable-tick BullMQ workers (`campaign-scheduler.worker.ts`, `analytics-reconciliation.worker.ts`, `flows/flow-reconciliation.worker.ts`, `flows/flow-segment-sweep.worker.ts`) that establish the exact shape this phase's fifth worker follows: a self-produced/self-consumed tick queue, idempotent registration on every boot, a processor that scans-and-acts, self-healing on restart. BullMQ 5.79.1 (already pinned) supports `queue.upsertJobScheduler(schedulerId, repeatOpts, jobTemplate)` — the modern cron-pattern scheduling API CONTEXT.md's D-13 explicitly prefers over the legacy `add(name, data, { repeat })` shape the four existing workers still use; this phase's new worker is the first to actually adopt it.

The two genuinely new pieces of infrastructure are: (1) an idempotent `ensurePartitions(client, now, lookahead)` function in `packages/db`, the single source of partition DDL, invoked from the new worker (repeatable + one boot-time immediate run) AND from `packages/test-support`'s db-fixture so ephemeral test databases stay on the same rolling horizon as production; and (2) a two-process dead-man's-switch — the worker writes health state (last-run timestamp, months-of-buffer-remaining, DEFAULT row counts) to a new Postgres table every run, and a **separate watchdog inside `apps/api`** (not the worker) is the sole sender of operator alert email, polling that table on its own interval. This single-sender design (detailed in Architecture Patterns) resolves an ambiguity CONTEXT.md leaves open (D-01's "воркеру понадобится доступ к тому же ключу (**или** отправка через API-сторожа)") in favor of the second option: it avoids installing `@sendgrid/mail` a second time in `apps/worker`, and keeps the "watcher lives in a different process than what it watches" property (D-02's own stated principle) for every alert condition, not only "job stopped."

One material correction to CONTEXT.md's `canonical_refs`: **Bull Board is not actually installed in this repository.** `apps/worker/src/server.ts` only *mentions* it in a comment ("kept for... a future @bull-board wiring") — `@bull-board/api`/`@bull-board/fastify` are absent from every `package.json` in the repo. D-01's "failed job виден в Bull Board" is therefore not true today; a failed maintenance job is currently visible only via direct Redis/BullMQ inspection, not a UI. OPS-14 (Bull Board under admin access) is explicitly Phase 15 scope — this phase must not install it. The operator email channel is therefore the ONLY loud signal this phase actually ships; see Assumptions Log A1.

**Primary recommendation:** Ship the one-time catch-up migration (D-06) FIRST, independent of the job — it is the artifact that makes 2026-09-01 safe even if nothing else in the phase is finished. Build `ensurePartitions` in `packages/db` next (consumed by both the worker and the test fixture), then the worker, then the health-state table + API watchdog, then the DEFAULT-relocation script + its boundary test last (it depends on the CHECK-constraint-first attach logic already existing inside `ensurePartitions`, since the relocation script's final ATTACH step reuses it).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Partition DDL (`ensurePartitions`) | Database / Storage (packages/db) | — | Idempotent function is the single source of partition-creation SQL; consumed by both the worker and test fixtures, never duplicated |
| Daily partition maintenance tick | API / Backend (apps/worker, BullMQ) | Database / Storage | Same repeatable-tick pattern as the four existing workers; runs inside the worker process, writes to Postgres |
| Health-state persistence (last-run, buffer, DEFAULT counts) | Database / Storage | API / Backend (worker writer, API reader) | Postgres is the durable cross-process signal — the worker writer and API-process watchdog reader must never share in-memory state |
| Dead-man's-switch / alert dispatch | API / Backend (apps/api watchdog) | — | Must live in a *different* process than the job it watches (D-02's own principle); also the sole SendGrid-key holder for this phase, avoiding a second key/client copy in the worker |
| DEFAULT-relocation procedure | Database / Storage (npm script + runbook) | API / Backend (invocation only) | Batched SQL run by an operator; no application-tier logic beyond the CLI entrypoint |
| Boundary-crossing test | Database / Storage (packages/db or apps/worker test) | — | Exercises `ensurePartitions` and the relocation script directly against an ephemeral DB; no HTTP/UI surface involved |

## User Constraints

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Канал алерта (до инфраструктуры Phase 15)**
- **D-01:** Alert = email to operator via the existing `PLATFORM_SENDGRID_API_KEY` (same key that sends verification/invite email) plus a loud failure of the job itself (failed job visible in Bull Board). Recipient address is a new env var in the externally-resolved env file (`MEGA_CRM_ENV_FILE`), name at implementer's discretion (e.g. `OPERATOR_ALERT_EMAIL`). — Reversibility: reversible — Phase 15 wires real alerting to the same signal; the email channel stays or goes.
- **D-02:** "Job stopped running entirely" is caught by an **API-side watchdog**: the job writes a last-run timestamp to Postgres; a separate API process (a genuine dead hand) periodically checks it and sends the alert email itself if the last run is older than a threshold (~26h for a once-daily cron; exact value at implementer's discretion).
- **D-03:** Repeat alerts — **every run while state stays unhealthy** (daily email). Single operator, rare event, must not be missed; repetition is cheaper than dedup/state-tracking logic.
- **D-04:** Email is **plain-text, no Dynamic Template**: numbers (table, months of buffer, rows in DEFAULT) directly in the body. The emergency channel must not depend on a template existing in the platform's SendGrid account.

**Источник DDL и отношения с миграциями**
- **D-05:** Partition-creation logic is an **idempotent function `ensurePartitions(now, lookahead)` in `packages/db`**, the single source of partition DDL. Called by: (a) the maintenance job in prod, (b) the db-fixture/provisioning of ephemeral DBs after migrations run — a fresh test DB gets current partitions from the same code path as prod; migrations don't multiply monthly. — Reversibility: costly — the fixture in `packages/test-support` and Phase 8's migration tests start depending on calling this function; reverting would reintroduce test/prod schema drift.
- **D-06:** In addition to the runtime function — a **one-time hand-written catch-up migration**, creating partitions out to the horizon (per the 0007/0020 precedent: `CREATE TABLE ... PARTITION OF ... FOR VALUES FROM ... TO ...`, no drizzle-kit snapshot). The 2026-09-01 deadline is closed by the fact of the migration's deploy, even if the job never once runs. The job then maintains the horizon forever after.
- **D-07:** `ensurePartitions` runs **both at worker boot** (an immediate one-off job at registration, in addition to the repeatable schedule) — after any downtime, the buffer is restored within seconds, not up to a day later.

**Процедура переноса из DEFAULT (DB-03)**
- **D-08:** Form — an **executable npm script + runbook**. Script: batched transfer of rows out of `DEFAULT` + CHECK-constraint-first attach (Pitfall 13), short transactions, no long-held `ACCESS EXCLUSIVE`. Run deliberately by an operator, not background magic. Runbook documents when/how to run it. **The automated test for criterion 3 ("automation ran late, DEFAULT already holds rows") runs this exact script** — procedure and test cannot diverge.
- **D-09:** Rows with `occurred_at` far outside the expected window (e.g. year 2031): **relocate everything** — the script creates a monthly partition for every month actually present in the data and moves all rows. `DEFAULT` ends empty after the run → CHECK-first attach is always possible; a stray `*_2031_04` partition is harmless and visible. (Phase 13 / CMP-05 will later bound input timestamps at the door.)
- **D-10:** The daily job **counts rows in both DEFAULT partitions every run**; >0 → the same alert channel (email + job failure) with an explicit instruction to run the relocation procedure. Closes the loop: detection → operator → script. Normally DEFAULT is empty; COUNT is cheap.

**Lookahead, пороги, расписание**
- **D-11:** Numbers: **create partitions +3 months ahead, alert when buffer <2 months**. A full month of slack between normal and threshold — the job can stay silent for up to ~30 days before the "at least 2 months at all times" criterion is actually violated, and the alert fires well before any row reaches DEFAULT.
- **D-12:** Lookahead, alert threshold and schedule are **versioned constants in code with a rationale comment** (the existing ticks' convention: `SCAN_INTERVAL_MS` etc. referencing a plan number). Not env: a lookahead change must be visible in a diff, per Phase 8's "any gate weakening is visible in a diff or a failing check" philosophy — threshold and horizon sit next to each other, so drift is caught by review.
- **D-13:** Schedule — a **BullMQ cron pattern (`repeat: { pattern }`) at a fixed UTC hour** (e.g. 03:00), not `every` from boot time. Predictable for the operator and gives the API watchdog a clean "last run older than 26h" threshold. Registration should prefer `upsertJobScheduler` with a stable ID, per WRK-13's note, if the repo's BullMQ version supports it (**confirmed: BullMQ 5.79.1 does**).

### Claude's Discretion

- Names for the operator-address env var, the last-run table/columns, the exact watchdog threshold, the cron hour.
- Batched-relocation mechanics (batch size, `LIMIT`-loop `INSERT ... DELETE RETURNING` vs. an intermediate table) — subject to the invariant "no long-held exclusive lock."
- Boundary-test design (clock injection vs. a controlled partition window in an ephemeral DB) — must cover both the normal month transition and the "ran late, DEFAULT holds rows" case (criterion 3).
- Where the runbook lives (e.g. `docs/runbooks/` or beside `ARCHITECTURE.md`) — subject to Phase 8's binding-update rule.

### Deferred Ideas (OUT OF SCOPE)

- **Bounding provider-supplied `occurred_at` on input** — Phase 13 (CMP-05); Phase 9 only avoids *assuming* the value is valid.
- **Real alerting (Sentry, hosted logs, queue-depth alerts)** — Phase 15; this phase's email channel is a bridge to it — the signal (buffer, DEFAULT count, last-run) is already structured for reconnection.
- **Retention/deletion of old partitions** — Phase 14 (DB-11); this phase only creates and relocates, never deletes.
- **`/readyz` integration with partition status** — Phase 14 (OPS-05) may read the same last-run timestamp later, if it wants to.
</user_constraints>

## Phase Requirements

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DB-01 | Партиции `events`/`send_events` создаются автоматически на 2-3 месяца вперёд (дедлайн 2026-09-01) | `ensurePartitions(client, now, lookahead)` in `packages/db` (D-05) + one-time catch-up migration (D-06) + daily BullMQ repeatable tick (D-13); lookahead=+3mo, buffer alert <2mo (D-11). See Architecture Patterns Pattern 1, Code Examples. |
| DB-02 | Отсутствие следующей партиции вызывает алерт (дедлайн 2026-09-01) | Two independent alert paths converging on one email channel: worker-run buffer/DEFAULT-count check (D-10) and API-side last-run watchdog (D-02). See Architecture Patterns Pattern 2, Common Pitfalls (Bull Board gap). |
| DB-03 | Процедура переноса данных из DEFAULT без длительной блокировки | npm script + runbook, batched DELETE...RETURNING/INSERT into a freestanding partition table, CHECK-constraint-first ATTACH (D-08, D-09). See Code Examples "Relocating rows out of DEFAULT". |
| DB-04 | Переход через границу месяца покрыт тестом | Boundary test injects `now` into `ensurePartitions` against an ephemeral DB (no fixed-clock dependency needed since the function already takes `now` as a parameter per D-05); a second test pre-seeds rows into DEFAULT before calling the relocation script, per D-08's "test and procedure are the same code." See Validation Architecture. |
</phase_requirements>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| PostgreSQL | 17 (confirmed: `docker-compose.yml` pins `postgres:17`, local `psql 17.10`) | Partitioned tables, native declarative partitioning | Already the project's database; native `RANGE` partitioning + `DEFAULT` partition + `NOT VALID`/`VALIDATE CONSTRAINT` are all stable PG 11+ features, no extension needed |
| BullMQ | 5.79.1 (confirmed via `node_modules/bullmq/package.json`, matches CLAUDE.md's pinned 5.79.x) | Repeatable job scheduling for the maintenance tick | Already the project's queue; `upsertJobScheduler` (Job Schedulers API, BullMQ 5.16+) is present at this version — `grep` of `node_modules/bullmq/dist/esm/classes/queue.d.ts` confirms the method exists [VERIFIED: node_modules] |
| pg (node-postgres) | 8.22.0 (confirmed: `packages/db/package.json`, `packages/tenant-context/package.json`) | Raw SQL execution for partition DDL and the relocation script | Already the project's driver; DDL statements need no ORM abstraction |
| @sendgrid/mail | 8.1.6 (confirmed via `npm view`, matches the version already pinned in `apps/api/package.json`) | Sends the operator alert email from the API-process watchdog | Already used in `apps/api/src/modules/platform-mail/client.ts` for verification/reset/invite email through the same `PLATFORM_SENDGRID_API_KEY`; the watchdog reuses this exact pattern, not a new dependency for `apps/worker` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| zod | 4.4.x (project-pinned) | Validate the new `OPERATOR_ALERT_EMAIL` env var if the watchdog lives in `apps/api` (which already has a zod `envSchema` in `apps/api/src/env.ts`) | Only if the env var is read by `apps/api`; `apps/worker` currently has no zod env schema and reads `process.env.X` directly with manual fail-fast checks (see `apps/worker/src/server.ts`'s `UNSUBSCRIBE_TOKEN_SECRET`/`PUBLIC_APP_URL` checks) — match whichever process actually owns the variable |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-written `ensurePartitions` + BullMQ repeatable job | `pg_partman` | Explicitly ruled out by CONTEXT.md and `.planning/REQUIREMENTS.md`'s Out of Scope table: requires a custom Postgres image + extension dependency + a second scheduling paradigm alongside BullMQ. Not reconsidered here. |
| Watchdog inside `apps/api` sends all alert email | Worker sends its own email via a duplicated `@sendgrid/mail` client | Rejected in this research (see Summary) — avoids a second SendGrid client/key-holder and keeps "watcher in a different process" true for every alert condition, not only "job stopped." This is the one place this research goes beyond CONTEXT.md's explicit decisions; flagged in Assumptions Log. |
| `upsertJobScheduler` for the new worker's schedule | `queue.add(name, data, { repeat: { pattern }, jobId })` (the four existing workers' shape) | The legacy `add(...,{repeat})` form still works in 5.79.1 and is what all four precedents use — consistent with existing code, but CONTEXT.md's D-13 explicitly asks to prefer `upsertJobScheduler` here since the version supports it (WRK-13 forward-guidance). Recommend `upsertJobScheduler` for this NEW worker; do not retrofit the four existing ones (out of phase scope). |

**Installation:**

No new root-level npm packages. `@sendgrid/mail@8.1.6` is added to `apps/api/package.json` ONLY if it is not already a dependency there for the watchdog module (it already is, for `platform-mail`) — no `npm install` needed for that half. If the planner instead chooses to have the worker send its own email (the alternative this research recommends against), `@sendgrid/mail@8.1.6` would need adding to `apps/worker/package.json` as a new workspace dependency.

**Version verification:** All versions above were checked directly: `node_modules/bullmq/package.json` → `5.79.1`; `npm view @sendgrid/mail version` → `8.1.6`; `docker-compose.yml` → `postgres:17`; `packages/db/package.json` / `packages/tenant-context/package.json` → `pg@8.22.0`. No package.json edits are anticipated for `packages/db` beyond the new `ensurePartitions` module and, if a health-state table is added there, a new Drizzle schema file for type inference only (no new dependency).

## Package Legitimacy Audit

This phase installs no genuinely new npm packages — `@sendgrid/mail` is already a vetted dependency of `apps/api` at the exact version checked below, and is only being *reused* (via the watchdog design this research recommends) rather than freshly introduced into a new workspace.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| @sendgrid/mail | npm | published 2025-09-19 (this version), package itself is long-established (SendGrid's official SDK) | 4,504,277/week | github.com/sendgrid/sendgrid-nodejs | OK | Approved — already in use, no new install for the recommended (API-watchdog-sends) design |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none.

Ran via `gsd-tools query package-legitimacy check --ecosystem npm @sendgrid/mail` → `{"verdict":"OK","signals":{"exists":true,"weeklyDownloads":4504277,"repoUrl":"git://github.com/sendgrid/sendgrid-nodejs.git","deprecated":false,"postinstall":null}}` [VERIFIED: npm registry + package-legitimacy seam].

## Architecture Patterns

### System Architecture Diagram

```
                    ┌──────────────────────────────────────────────────┐
                    │              apps/worker (BullMQ)                  │
                    │                                                    │
   boot ──────────► │  createPartitionMaintenanceWorker()                │
                    │    ├─ upsertJobScheduler(cron @ 03:00 UTC)         │
                    │    └─ queue.add(one-off, immediate)  ◄── D-07      │
                    │            │                                       │
                    │            ▼                                       │
                    │  Worker processor (per run):                       │
                    │    1. ensurePartitions(pool, now, +3mo)  ── D-05   │
                    │       (packages/db — same fn test-fixture calls)   │
                    │    2. COUNT(*) events_default / send_events_default│
                    │    3. compute "months of buffer remaining"         │
                    │    4. UPSERT partition_maintenance_runs            │
                    │       (last_run_at, buffer_months, default_counts) │
                    └───────────────────────┬────────────────────────────┘
                                             │ writes
                                             ▼
                    ┌──────────────────────────────────────────────────┐
                    │                    PostgreSQL                     │
                    │  events (PARTITION BY RANGE) ── events_2026_09,   │
                    │    events_2026_10, ..., events_default            │
                    │  send_events (same shape)                         │
                    │  partition_maintenance_runs (new, platform-level, │
                    │    no RLS — not tenant data)                      │
                    └───────────────────────┬────────────────────────────┘
                                             │ reads (polls)
                                             ▼
                    ┌──────────────────────────────────────────────────┐
                    │                  apps/api (Fastify)                │
                    │                                                    │
                    │  Watchdog (setInterval, own process) ── D-02       │
                    │    reads partition_maintenance_runs                │
                    │    unhealthy if: last_run_at older than threshold  │
                    │                  OR buffer_months < 2              │
                    │                  OR default_row_count > 0          │
                    │            │                                       │
                    │            ▼ (D-03: every check while unhealthy)   │
                    │  platformMail-style sendMail()                     │
                    │    via PLATFORM_SENDGRID_API_KEY → OPERATOR_ALERT_ │
                    │    EMAIL, plain text (D-04)                        │
                    └──────────────────────────────────────────────────┘

   ── separate, operator-run, out-of-band ──
   npm run relocate-default-partition-rows (D-08):
     1. find distinct months present in events_default / send_events_default
     2. for each month: batched DELETE...RETURNING out of DEFAULT,
        INSERT into a freestanding (not-yet-attached) partition table
        (short transactions, no long ACCESS EXCLUSIVE — D-09: covers ANY
        month found, including wild/out-of-window timestamps)
     3. once DEFAULT holds zero rows for that month:
        ALTER TABLE ... ADD CONSTRAINT ... NOT VALID (fast, metadata only)
        ALTER TABLE ... VALIDATE CONSTRAINT (SHARE UPDATE EXCLUSIVE, scans
          but does not block reads/writes)
        ALTER TABLE events ATTACH PARTITION ... (fast — DEFAULT scan
          skipped because the CHECK constraint already proves it's empty
          for this range)
   Same script is invoked by the DB-04 boundary test (criterion 3) — see
   Validation Architecture.
```

### Recommended Project Structure

```
packages/db/
├── src/
│   ├── partitions/
│   │   ├── ensure-partitions.ts     # D-05: idempotent DDL fn, generic {query} client param
│   │   └── __tests__/
│   │       └── ensure-partitions.test.ts   # DB-04's boundary test lives here
│   └── schema/
│       └── partition-maintenance-runs.ts   # type-inference-only Drizzle schema (D-02's table)
├── migrations/
│   └── 0038_partition_catchup_and_maintenance_runs.sql   # D-06, hand-written like 0007/0020
└── scripts/                          # or tools/ at repo root — planner's call
    └── relocate-default-partition-rows.mjs   # D-08's operator script

apps/worker/src/queues/
└── partition-maintenance.worker.ts    # D-13: upsertJobScheduler + one-off boot job

apps/api/src/modules/ops/
└── partition-watchdog.ts              # D-02: setInterval, reads last-run, sends alert

docs/runbooks/
└── relocate-default-partition-rows.md # D-08's runbook, binding-update rule applies
```

### Pattern 1: Idempotent partition-ensuring function, shared between prod job and test fixture

**What:** A single function `ensurePartitions(client, tableConfigs, now, lookaheadMonths)` that, for each configured partitioned table (`events`, `send_events`), computes the set of `YYYY_MM` partitions that should exist between the current month and `lookaheadMonths` ahead, and `CREATE TABLE IF NOT EXISTS ... PARTITION OF ... FOR VALUES FROM ... TO ...` any that are missing. Accepts a generic `{ query(sql): Promise<unknown> }` client (same shape as `packages/test-support/src/migration-runner.ts`'s `MigrationClient` interface) rather than importing a specific `Pool`, so it is trivially callable from the worker's own pool, from `packages/test-support`'s fixture pool, and from a unit test's ephemeral pool.

**When to use:** Called from three places, per D-05/D-07: (1) the maintenance worker's repeatable tick, (2) the maintenance worker's one-off immediate boot job, (3) `packages/test-support/src/db-fixture.ts`'s `applyPendingMigrations`, after the migration loop finishes — so every ephemeral test database gets partitions covering "real now" through +3 months, not just the frozen `2026_07`/`2026_08` months the migrations create. Without step (3), tests would still pass (the `DEFAULT` partition catches everything), but every insert into `events`/`send_events` in a test running after 2026-11-30 would silently land in `DEFAULT` instead of a dated partition, defeating any test that asserts partition routing.

**Example:**
```sql
-- What ensurePartitions executes per missing month (mirrors 0007/0020's
-- hand-written precedent exactly — CREATE TABLE ... PARTITION OF, no
-- drizzle-kit involvement):
CREATE TABLE IF NOT EXISTS events_2026_11 PARTITION OF events
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
```
```typescript
// Source: pattern derived from packages/db/migrations/0007_events_partitioned.sql
// + packages/test-support/src/migration-runner.ts's MigrationClient interface
export interface PartitionClient {
  query(queryText: string, params?: unknown[]): Promise<unknown>;
}

export interface PartitionedTableConfig {
  parentTable: string;      // "events" | "send_events"
  partitionPrefix: string;  // "events_" | "send_events_"
}

export async function ensurePartitions(
  client: PartitionClient,
  tables: PartitionedTableConfig[],
  now: Date,
  lookaheadMonths: number,
): Promise<{ table: string; created: string[] }[]> {
  // for each table, for m in [0..lookaheadMonths] months from now:
  //   compute [start, end) as first-of-month Date pair
  //   CREATE TABLE IF NOT EXISTS <prefix><YYYY_MM> PARTITION OF <parentTable>
  //     FOR VALUES FROM (<start>) TO (<end>)
  // returns which partitions were actually created this call, for the
  // worker's "months of buffer remaining" log line.
}
```

### Pattern 2: Two-process dead-man's-switch with Postgres as the shared signal

**What:** The worker never sends email. Every run it writes ONE row (upsert on a fixed key, or a fresh row plus "read the latest") into a new `partition_maintenance_runs` table: `last_run_at`, `buffer_months_remaining`, `events_default_count`, `send_events_default_count`. A `setInterval` (or the API's existing periodic-task mechanism, if any is added later) inside `apps/api`'s own process polls this table on a fixed interval and decides "unhealthy" from three independent conditions (last-run staleness, low buffer, non-zero DEFAULT count) — sending the SAME plain-text alert email (D-04) regardless of which condition tripped, with the specific numbers in the body.

**When to use:** This is the mechanism for DB-02 in full — both "the job stopped" (D-02's literal scope) and "the job ran but found a problem" (D-10's buffer/DEFAULT-count checks) collapse into the same watchdog-reads-Postgres-and-emails design, rather than D-02's watchdog and D-10's "job sends its own email" being two separate code paths with two separate SendGrid clients.

**Example:**
```typescript
// apps/api/src/modules/ops/partition-watchdog.ts
// Source: pattern derived from apps/api/src/modules/platform-mail/client.ts
// (same PLATFORM_SENDGRID_API_KEY/PLATFORM_MAIL_FROM, plain-text send per D-04)
// and apps/worker/src/queues/analytics-reconciliation.worker.ts's
// "poll on an interval, self-heal on restart" shape (translated from a BullMQ
// tick to a plain setInterval since this is NOT a queue-backed job -- D-02
// explicitly wants a mechanism independent of the worker/BullMQ process it watches).

const WATCHDOG_INTERVAL_MS = 15 * 60_000; // check every 15 min
const STALE_THRESHOLD_HOURS = 26;         // D-02: ~26h for a once-daily 03:00 UTC cron

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
  if (unhealthy) await sendOperatorAlert(row); // plain-text, D-03: every check while unhealthy
}
```

### Pattern 3: CHECK-constraint-first ATTACH (Pitfall 13)

**What:** Before attaching a new partition to a table with a `DEFAULT` partition, add a `NOT VALID` CHECK constraint on `DEFAULT` that excludes the new partition's range, `VALIDATE` it (non-blocking scan), THEN attach — Postgres skips its own `ACCESS EXCLUSIVE`-locked scan of `DEFAULT` because the constraint already proves it. This is PostgreSQL's own documented technique, not a project invention.

**When to use:** Every `ATTACH PARTITION` against `events`/`send_events` once `DEFAULT` is non-empty (i.e., always, defensively, inside the relocation script — `ensurePartitions`'s normal monthly attaches don't need this AS LONG AS `DEFAULT` stays empty, which is DB-02's whole point).

**Example:**
```sql
-- Source: postgresql.org/docs/current/ddl-partitioning.html (5.12) +
-- sql-altertable.html — quoted directly, verified 2026-08-06:
-- "if the partitioned table has a DEFAULT partition, it is recommended to
--  create a CHECK constraint which excludes the to-be-attached partition's
--  constraint. If this is not done, the DEFAULT partition will be scanned
--  to verify that it contains no records which should be located in the
--  partition being attached. This operation will be performed whilst
--  holding an ACCESS EXCLUSIVE lock on the DEFAULT partition."
--
-- Lock levels (sql-altertable.html, verified 2026-08-06):
--   ADD CONSTRAINT ... NOT VALID  -> ACCESS EXCLUSIVE, but brief (no scan)
--   VALIDATE CONSTRAINT           -> SHARE UPDATE EXCLUSIVE (non-blocking scan)
--   ATTACH PARTITION              -> SHARE UPDATE EXCLUSIVE on parent,
--                                     ACCESS EXCLUSIVE on the new partition
--                                     AND on DEFAULT (skipped if the CHECK
--                                     constraint above already proves it)

-- 1. Fast, metadata-only (no scan):
ALTER TABLE events_default ADD CONSTRAINT excl_2026_11
  CHECK (occurred_at < '2026-11-01' OR occurred_at >= '2026-12-01') NOT VALID;

-- 2. Scans events_default, but under SHARE UPDATE EXCLUSIVE
--    (concurrent reads/writes continue):
ALTER TABLE events_default VALIDATE CONSTRAINT excl_2026_11;

-- 3. Now fast -- Postgres trusts the validated constraint, skips the
--    DEFAULT scan entirely:
ALTER TABLE events ATTACH PARTITION events_2026_11
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

-- 4. Optional cleanup -- redundant once the partition boundary itself
--    enforces the same thing:
ALTER TABLE events_default DROP CONSTRAINT excl_2026_11;
```

### Anti-Patterns to Avoid

- **Attaching a new partition without first checking whether `DEFAULT` holds rows in that range:** This is Pitfall 13 exactly — even a single-row `DEFAULT` triggers the full `ACCESS EXCLUSIVE` scan. `ensurePartitions` should defensively run the CHECK-constraint-first sequence for every attach once the phase ships, not just from the relocation script — cheap insurance (a `NOT VALID` constraint on an empty `DEFAULT` validates near-instantly) against the exact deadline-miss scenario this phase exists to prevent.
- **The worker sending its own alert email:** Duplicates the SendGrid client/key-holding logic that already exists in `apps/api`'s `platform-mail` module, and breaks the "watcher lives in a different process" property for the buffer/DEFAULT-count alert paths (D-10), even though it holds for the "job stopped" path (D-02). Route ALL alert conditions through one watchdog, one sender.
- **Treating "Bull Board shows the failed job" as an actual operational signal:** It's not installed (see Summary). Do not rely on it as part of DB-02's "loud" requirement; the email channel alone must be sufficient.
- **A relocation script that assumes `occurred_at` is inside the "current" window:** D-09 is explicit — `send_events.occurred_at` is provider-supplied and can be arbitrarily wrong; the script must discover actual distinct months present in `DEFAULT` via a query (`SELECT DISTINCT date_trunc('month', occurred_at) FROM events_default`), not assume a fixed set of "recent" months.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Partition maintenance scheduling/extension automation | A custom cron daemon, `pg_cron`, or `pg_partman`'s `run_maintenance_proc` | The project's existing BullMQ repeatable-tick pattern | Explicitly ruled out in ROADMAP.md/REQUIREMENTS.md's Out of Scope: `pg_partman`/`pg_cron` require a custom Postgres image and a second scheduling paradigm alongside BullMQ, which the project already runs four other repeatable jobs on |
| Cron expression parsing/scheduling | Hand-rolled interval math | BullMQ's built-in cron pattern support (`repeatOpts.pattern` + `tz`) via `upsertJobScheduler` | BullMQ already vendors cron-parser internally; no new dependency needed, and the four existing tick workers already rely on BullMQ's `repeat` machinery for their own (interval-based) scheduling |
| Dead-man's-switch / staleness detection | A custom polling framework | A plain `setInterval` in the API process comparing `last_run_at` against a threshold constant | This is intentionally the simplest possible mechanism — D-02 asks for a "genuine dead hand," and the project has no existing generic scheduled-task abstraction in `apps/api` to reuse (worth noting: `apps/api` currently has zero periodic background mechanisms; this is the first one) |
| Avoiding the `DEFAULT`-partition scan on `ATTACH` | A homegrown "check emptiness then attach" retry loop | PostgreSQL's own documented `NOT VALID` + `VALIDATE CONSTRAINT` + `ATTACH PARTITION` sequence (Pattern 3 above) | This is the officially documented technique (quoted directly from `postgresql.org/docs/current/ddl-partitioning.html`), not a project-specific workaround — reinventing it risks missing the exact CHECK-constraint shape Postgres's planner needs to prove the range disjoint |

**Key insight:** Every piece of new infrastructure in this phase already has a close in-repo precedent (repeatable tick, hand-written partition migration, `MigrationClient`-shaped generic SQL client, plain-text platform email) — the risk in this phase is architectural inconsistency (a sixth pattern where a fifth one already exists), not missing library choices.

## Common Pitfalls

### Pitfall 1: Attaching a partition while `DEFAULT` holds rows takes a full-table `ACCESS EXCLUSIVE` scan (Pitfall 13 from `.planning/research/PITFALLS.md`)

**What goes wrong:** Documented above in Pattern 3 — this is the single most consequential mechanical fact in the phase. Verified directly against PostgreSQL's official docs (`ddl-partitioning.html`, `sql-altertable.html`), not just the project's own pitfalls doc.
**Why it happens:** `ATTACH PARTITION` must prove the new partition's range doesn't overlap what's already routed to `DEFAULT`; without a constraint proving it, Postgres has to scan.
**How to avoid:** CHECK-constraint-first (Pattern 3). Apply it defensively inside `ensurePartitions` itself, not only inside the D-08 relocation script — an attach that runs against an accidentally non-empty `DEFAULT` (e.g., the automation shipped a few hours late) should still be cheap.
**Warning signs:** Any `ATTACH PARTITION` that measurably blocks ingestion when run in production; a partition-creation job with no monitoring on whether it actually ran.

### Pitfall 2: "Months of buffer remaining" is a computed metric that can silently disagree with the actual partition set

**What goes wrong:** D-11's alert threshold (<2 months) depends on correctly counting *consecutive* existing future partitions starting from next month — not merely "how many partition rows exist total." If a gap exists (e.g., a partition for month N+1 is missing but N+2 exists — possible if a manual `ATTACH` was run out of order, or if the catch-up migration created a non-contiguous set), a naive `COUNT(*)` over future partitions would overstate the buffer and mask an imminent DEFAULT-routing failure for month N+1.
**Why it happens:** Partition tables list is easy to count; partition table list *contiguity* is easy to forget to check.
**How to avoid:** Compute buffer as "count of consecutive months starting at current-month+1 that already have a partition, stopping at the first gap" — not a raw count. `ensurePartitions`'s own creation loop already walks months in order; reuse that same walk for the buffer computation so the two can never diverge (compute buffer as a side effect of the same loop, not a separate query).
**Warning signs:** A buffer number that doesn't change when a gap is manually introduced in a test; an alert that fails to fire when one specific month is missing but later months exist.

### Pitfall 3: Bull Board is referenced in CONTEXT.md's canonical_refs as already wired, but is not installed

**What goes wrong:** D-01 states "failed job виден в Bull Board" as an existing, no-new-infrastructure signal. `grep` across every `package.json` in the repo and `apps/worker/src/server.ts` (which only *comments* about "a future @bull-board wiring") confirms `@bull-board/api`/`@bull-board/fastify` are not dependencies anywhere. If the planner takes D-01's Bull Board claim at face value and treats the email channel as merely a *supplement* to an already-visible UI signal, DB-02's "loud" requirement is weaker than intended in practice — nobody is looking at a UI that doesn't exist.
**Why it happens:** CONTEXT.md was likely written assuming a piece of infrastructure that was scoped/discussed but never actually implemented in an earlier phase.
**How to avoid:** Treat the plain-text email (D-01/D-04) as the SOLE loud signal this phase delivers. Do not add a task to install Bull Board — that's explicitly OPS-14/Phase 15 scope, and would violate this phase's own "don't fold other work in" boundary note. Just don't rely on it as backup.
**Warning signs:** A plan or verification step that says "confirm the failed job appears in Bull Board" as a pass criterion — there is no Bull Board to check.

### Pitfall 4: A relocation script that only handles "recent" months misses the D-09 wild-timestamp case

**What goes wrong:** `send_events.occurred_at` is provider-supplied (SendGrid webhook `timestamp` field) and unvalidated until Phase 13/CMP-05 — a single malformed or malicious event could land far outside any expected month. A relocation script hard-coded to "last N months" would leave such rows in `DEFAULT` forever, permanently defeating the CHECK-constraint-first attach optimization for all future normal months too (since `DEFAULT` never reaches zero).
**Why it happens:** It's natural to think of "the DEFAULT cleanup" as "catching up a few recently-missed months," not "handling arbitrary timestamps."
**How to avoid:** D-09 is explicit — discover actual distinct months present via `SELECT DISTINCT date_trunc('month', occurred_at) FROM events_default` (and the `send_events` equivalent), and create+attach a partition for every one found, however far outside the normal window. A `*_2031_04` partition is harmless.
**Warning signs:** A relocation script parameterized only by "how many months back to check"; `DEFAULT` row count staying non-zero after a relocation run that "succeeded."

### Pitfall 5: Worker's per-request pool differs from the test fixture's pool — `ensurePartitions` must not assume a specific `Pool` type

**What goes wrong:** `apps/worker/src/server.ts`'s own doc comment on `WorkerRuntime` notes that BullMQ bundles its own internal `ioredis` at a version that creates a TypeScript nominal-type mismatch with the workspace's own `ioredis` — the same class-identity trap can bite a `pg.Pool` if `ensurePartitions` is typed against a specific `Pool` class import rather than a minimal structural interface, especially once it's called from `packages/test-support`'s pool (a different `pg` import graph than `packages/db`'s).
**Why it happens:** It's the path of least resistance to type a new DB function against the concrete `Pool`/`PoolClient` type from `pg`.
**How to avoid:** Match `migration-runner.ts`'s existing precedent exactly — a minimal structural `{ query(sql, params?): Promise<unknown> }` interface, not a `pg.Pool` import. This is D-05's actual design constraint (shared between prod job and test fixture) made concrete.
**Warning signs:** A TypeScript error about incompatible `Pool`/`PoolClient` types when wiring `ensurePartitions` into `packages/test-support`; an `import type { Pool } from "pg"` in the new `packages/db/src/partitions/ensure-partitions.ts` file (should not be needed).

## Code Examples

### Relocating rows out of DEFAULT in short, batched transactions

```typescript
// Source: pattern derived from crunchydata.com/blog/postgres-partitioning-with-a-default-partition
// (batched DELETE/INSERT is the standard approach; no PostgreSQL built-in
// "move partition row" primitive exists) + the project's own SKIP LOCKED
// convention already used in apps/worker/src/queues/campaign-scheduler.worker.ts
// and flows/flow-reconciliation.worker.ts for "claim a batch without blocking
// a concurrent run."
const BATCH_SIZE = 500;

async function relocateMonth(pool: Pool, tableName: string, monthStart: Date, monthEnd: Date): Promise<number> {
  const targetPartition = `${tableName}_${formatYyyyMm(monthStart)}`;
  // Freestanding table -- NOT yet attached to the parent (0007's precedent
  // for LIKE ... INCLUDING ALL, see postgresql.org's own measurement_y2008m02 example)
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${targetPartition} (LIKE ${tableName} INCLUDING ALL)`
  );

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
             LIMIT $3
             FOR UPDATE SKIP LOCKED
           )
           RETURNING *
         )
         INSERT INTO ${targetPartition} SELECT * FROM moved RETURNING 1`,
        [monthStart, monthEnd, BATCH_SIZE]
      );
      await client.query("COMMIT");
      totalMoved += rows.length;
      if (rows.length < BATCH_SIZE) break; // fewer than a full batch -- done
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

### BullMQ Job Scheduler registration (D-13)

```typescript
// Source: docs.bullmq.io/guide/job-schedulers/ (WebFetch-verified 2026-08-06)
// Deliberately upsertJobScheduler, NOT the legacy tickQueue.add(name,{},{repeat,jobId})
// shape the four existing workers use -- CONTEXT.md D-13 explicitly asks for
// this given the repo's BullMQ version (5.79.1) supports it.
export function createPartitionMaintenanceWorker(connection: ConnectionOptions): Worker {
  const queue = new Queue(PARTITION_MAINTENANCE_QUEUE, { connection });

  // Recurring: fixed UTC hour, cron pattern (D-13). "0 3 * * *" = 03:00 UTC daily.
  void queue.upsertJobScheduler(
    "partition-maintenance-daily",           // stable scheduler id
    { pattern: PARTITION_MAINTENANCE_CRON, tz: "UTC" },
    { name: "run-partition-maintenance", opts: DEFAULT_JOB_OPTIONS }
  );

  // Immediate one-off at boot (D-07) -- NOT part of the scheduler, so it
  // runs right away rather than waiting for the next cron tick. Unique
  // jobId per boot avoids colliding with a still-running prior boot's job.
  void queue.add("run-partition-maintenance", {}, { jobId: `boot-${Date.now()}` });

  return new Worker(PARTITION_MAINTENANCE_QUEUE, async () => {
    const result = await ensurePartitions(pool, PARTITIONED_TABLES, new Date(), LOOKAHEAD_MONTHS);
    const bufferMonths = computeBufferMonths(result);
    const defaultCounts = await countDefaultRows(pool);
    await recordMaintenanceRun(pool, { bufferMonths, ...defaultCounts });
  }, { connection });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `queue.add(name, data, { repeat: { every } })` for recurring jobs | `queue.upsertJobScheduler(schedulerId, repeatOpts, jobTemplate)` | BullMQ 5.16 (per docs.bullmq.io) | Legacy form still works and is what all four of this project's existing tick workers use (built before this recommendation existed in the codebase's timeline); this phase's new worker is the first to adopt the newer API per D-13/WRK-13 |

**Deprecated/outdated:**
- `repeat: { utc: true }`: removed legacy BullMQ option; use `tz: 'UTC'` explicitly (confirmed via docs.bullmq.io fetch).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Bull Board is not actually installed in this repository (only referenced in a code comment as a future wiring) | Summary, Common Pitfalls Pitfall 3 | If wrong (i.e., it actually IS installed somewhere this research's `grep` missed), the planner would be over-cautious in treating email as the sole loud signal — low-risk direction to be wrong in. Verified via `grep -rln "bull-board\|BullBoard"` across `apps/**/*.ts` and every `package.json` in the repo; both came back empty except the one comment in `server.ts`. Confidence: HIGH this is accurate, but flagged as ASSUMED-adjacent since it's a negative claim about the whole repo rather than one file. |
| A2 | The worker should NOT send its own alert email; only the `apps/api` watchdog should | Summary, Pattern 2, Don't Hand-Roll | CONTEXT.md's D-01 explicitly leaves this open ("воркеру понадобится доступ к тому же ключу (**или** отправка через API-сторожа)") — this research picks the second branch and gives rationale, but it is a recommendation, not a locked decision. If the planner or a reviewer prefers the worker to send its own email directly (e.g., to avoid any polling latency between "job detects DEFAULT>0" and "operator is emailed"), that's a legitimate alternative CONTEXT.md still permits. Risk if this research's recommendation is wrong: an extra `@sendgrid/mail` dependency in `apps/worker` and a duplicated sender, not a correctness problem either way. |
| A3 | The new `partition_maintenance_runs` table needs no RLS (platform-level operational metadata, not tenant data) | Architecture Patterns Pattern 2, Recommended Project Structure | If this table were ever extended to carry tenant-identifying information, it would need the same RLS treatment as every other `workspace_id`-bearing table (Phase 8's `migrate-from-empty.test.ts` already asserts ALL such tables have RLS enabled+forced) — low risk given the table's stated columns (timestamps, counts) carry no tenant data by design. |

**If this table is empty:** N/A — see above; A1-A3 all carry LOW-to-none practical risk but are noted since they involve design choices this research made beyond CONTEXT.md's explicit text.

## Open Questions (RESOLVED)

Both questions below were decided at planning time. Neither is outstanding; the resolving
plan and the exact value chosen are cited inline.

1. **Should `ensurePartitions`'s defensive CHECK-constraint-first sequence run unconditionally on every attach, or only when a `DEFAULT` count check first confirms non-zero rows?**
   - What we know: The CHECK-constraint-first sequence is cheap when `DEFAULT` is actually empty (the `VALIDATE CONSTRAINT` scan is fast against zero/few rows) but is still three extra DDL statements per attach versus a bare `ATTACH PARTITION`.
   - What's unclear: Whether the extra DDL round-trips matter at the scale of "one attach per month, three months ahead" — almost certainly not, given the low frequency, but worth the planner explicitly deciding rather than defaulting silently either way.
   - Recommendation: Default to unconditional (always CHECK-first) inside `ensurePartitions` — it is the safer default given the whole phase exists because "should have been safe by default" already failed once (partitions ran out with no automation). The relocation script (D-08) already needs the full sequence regardless.
   - **[RESOLVED: `09-01-PLAN.md` task 1 — unconditional, recommendation taken.]** `attachPartitionCheckFirst` is invoked for **every** attach, never gated on a DEFAULT row count, and the five-statement sequence is wrapped in one transaction per month. Recorded as threat **T-09-06** ("CHECK-constraint-first attach applied unconditionally on every attach, not only when a DEFAULT count first shows rows — the phase exists because 'safe by default' already failed once") and asserted by the `grep -q 'NOT VALID'` / `grep -q 'VALIDATE CONSTRAINT'` / `grep -q 'ATTACH PARTITION'` verify gates. `09-04-PLAN.md` task 1 reuses the same helper for the relocation path (`grep -q 'attachPartitionCheckFirst'`), so there is exactly one attach sequence in the codebase.

2. **Exact catch-up migration horizon (D-06) — how many months beyond August 2026 should the one-time migration create?**
   - What we know: Existing partitions cover through August 2026 (0007/0020). Today's date is 2026-08-06; the 2026-09-01 deadline is roughly 3.5 weeks out. D-11's steady-state target is +3 months from "now."
   - What's unclear: The migration will be *written* on some date during this ~4-week window and *deployed* on a possibly later date — "3 months from today" and "3 months from deploy day" can differ by weeks. If the migration only reaches exactly +3 months from the day it's authored, and deployment slips by a few weeks, the buffer could already be below D-11's 2-month alert threshold at the moment of first deploy.
   - Recommendation: Give the catch-up migration a few months of extra margin beyond the bare minimum — e.g., partitions through mid-2027 rather than stopping at exactly November 2026 — so the deadline-closing artifact (D-06's own stated purpose: "дедлайн закрывается артефактом деплоя, а не поведением рантайма") has slack independent of exactly when the job's first tick runs. This is a planner-level number choice, not a research blocker.
   - **[RESOLVED: `09-01-PLAN.md` task 1 — horizon set to 2027-06 inclusive.]** Migration `0038_partition_catchup_and_maintenance_runs.sql` creates monthly partitions for both `events` and `send_events` from **2026-09 through 2027-06 inclusive** (10 months per table, 20 `CREATE TABLE … PARTITION OF` statements), with bounds written as explicit UTC timestamps. That is ~7 months of slack beyond D-11's +3-month steady state, deliberately overshooting it so the deadline-closing artifact carries margin independent of the deploy date and of when the job's first tick runs. Verified by `09-05-PLAN.md` task 3, which asserts 10 attached partitions per table over exactly that range against a migrated database (threat **T-09-27** — the deadline must be confirmed closed by the partitions existing, not by the automation existing).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| PostgreSQL | Partition DDL, health-state table | ✓ | 17.10 (local), `postgres:17` (docker-compose) | — |
| BullMQ / Redis | Repeatable maintenance job | ✓ | BullMQ 5.79.1, Redis via existing `REDIS_URL` | — |
| @sendgrid/mail (platform key) | Operator alert email | ✓ (already a dependency of `apps/api`) | 8.1.6 | — |
| Bull Board | (NOT required — see Pitfall 3) | ✗ | — | Not needed; email is the sole loud signal this phase ships |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** Bull Board absence has no fallback needed because this phase does not depend on it (see above) — listed here only to make the gap explicit for the planner, not because it blocks anything.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.x (project-pinned), same `@mega-crm/test-support` ephemeral-DB fixture used by every other backend test suite |
| Config file | `packages/db/vitest.config.ts` (new tests likely live in `packages/db/src/partitions/__tests__/` or `packages/db/src/__tests__/`, mirroring `migrate-from-empty.test.ts`'s placement) |
| Quick run command | `npm run test -w packages/db` (or the equivalent vitest invocation for the affected workspace) |
| Full suite command | `npm test` (root) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DB-01 | `ensurePartitions` creates missing months up to lookahead, idempotently (calling twice creates nothing new the second time) | unit/integration (ephemeral DB) | `vitest run packages/db/src/partitions/__tests__/ensure-partitions.test.ts` | ❌ Wave 0 |
| DB-02 | Watchdog flags unhealthy when last_run_at is stale, buffer<2, or DEFAULT>0; healthy otherwise | unit (mocked/seeded `partition_maintenance_runs` rows) | `vitest run apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts` | ❌ Wave 0 |
| DB-03 | Relocation script moves all DEFAULT rows (including wild-timestamp months) into correctly attached partitions, DEFAULT ends at zero rows | integration (ephemeral DB, seeded DEFAULT rows) | `vitest run packages/db/src/partitions/__tests__/relocate-default.test.ts` (or wherever the script's core logic is factored for testability — the script itself should be a thin CLI wrapper around an exported, directly-callable function) | ❌ Wave 0 |
| DB-04 | Boundary-crossing test: (a) `ensurePartitions` called with `now` advanced past a month rollover creates the new month's partition without disturbing existing ones; (b) the SAME relocation script from DB-03's test handles the "automation ran late, DEFAULT already holds rows for the new month" case | integration (ephemeral DB, `now` injected as a function parameter — no fake-timer library needed since `ensurePartitions(client, tables, now, lookahead)` already takes `now` explicitly per D-05) | same files as DB-01/DB-03 above, plus an explicit boundary-crossing scenario test | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `vitest run packages/db/src/partitions/__tests__/` (fast, ephemeral-DB-scoped)
- **Per wave merge:** `npm test` (root, full suite — this phase touches `packages/db`, `packages/test-support`, `apps/worker`, `apps/api`)
- **Phase gate:** Full suite green before `/gsd-verify-work`, per Phase 8's QG-01/QG-05 CI gates already in place

### Wave 0 Gaps

- [ ] `packages/db/src/partitions/__tests__/ensure-partitions.test.ts` — covers DB-01, DB-04(a)
- [ ] `packages/db/src/partitions/__tests__/relocate-default.test.ts` — covers DB-03, DB-04(b); MUST invoke the exact same exported function the npm script's CLI entrypoint calls (D-08's "test and procedure are the same code")
- [ ] `apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts` — covers DB-02
- [ ] No new test framework or config needed — `@mega-crm/test-support`'s existing `ensureTestDbMigrated()`/`createTestPool()`/`createEphemeralDatabase()` fixtures (Phase 8) cover every scenario above; the ephemeral DB will pick up the new catch-up migration (D-06) automatically since it's just another file in `packages/db/migrations/`

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No new authenticated surface; the maintenance worker and watchdog are internal processes, not user-facing endpoints |
| V3 Session Management | no | N/A |
| V4 Access Control | no | The relocation npm script is operator-run locally/via deploy shell, not exposed as an HTTP endpoint; no new access-control surface |
| V5 Input Validation | partial | The relocation script's month-discovery query reads `occurred_at` values that are ultimately provider-supplied (send_events) — but it only *reads* them to compute partition boundaries for DDL it constructs from parameterized date math, never interpolates raw event data into SQL identifiers. Table/partition names are constructed from computed `YYYY_MM` strings (from `Date` math, not user input), not from any field in the row data itself — no injection surface via a malicious `occurred_at` value. |
| V6 Cryptography | no | No new secrets beyond reusing the existing `PLATFORM_SENDGRID_API_KEY` (already KMS/env-managed per Phase 1's design) — no new cryptographic material introduced this phase |

### Known Threat Patterns for this phase's stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via a maliciously-crafted `occurred_at` value influencing a dynamically-built partition/table name | Tampering | Never build a partition-name string from row data — only from computed calendar math (`Date` → `YYYY_MM`), which this research's Code Examples already do; parameterize every WHERE-clause date bound (`$1`, `$2`) rather than string-interpolating dates |
| Denial of service via an attacker flooding `DEFAULT` with rows carrying wildly varying `occurred_at` months, forcing the relocation script to create an unbounded number of tiny partitions | Denial of Service | Out of this phase's scope to fully solve (Phase 13/CMP-05 bounds `occurred_at` at ingestion) — this phase's D-09 accepts creating a partition per distinct month found as the correct behavior for now; note this as a known limitation the relocation script inherits, not a new gap this phase introduces |
| Watchdog email flooding if D-03's "every check while unhealthy" combines with a very short watchdog interval | (not STRIDE, an operational risk) | D-03 explicitly ties repeat-alert cadence to "every run" of the DAILY job (once/day), not the watchdog's own polling interval (recommended 15 min in this research) — the watchdog should only actually SEND when its own state check crosses from healthy→unhealthy or once per its own day-scale cadence, not on every 15-minute poll; this needs explicit dedup-by-day logic even though D-03 says "cheaper than dedup" (D-03 is about not needing to dedup *across runs of the underlying job*, not about the watchdog's polling frequency — the planner should clarify this distinction in the plan) |

## Sources

### Primary (HIGH confidence)
- `packages/db/migrations/0007_events_partitioned.sql`, `0010_events_workspace_scoped_pk.sql`, `0020_send_events_partitioned.sql` — existing partition DDL precedent, read directly
- `apps/worker/src/queues/campaign-scheduler.worker.ts`, `analytics-reconciliation.worker.ts`, `flows/flow-reconciliation.worker.ts` — existing repeatable-tick pattern, read directly
- `apps/worker/src/server.ts` — worker registration point, confirmed Bull Board is NOT installed
- `packages/test-support/src/{db-fixture,migration-runner,provision-db,global-setup}.ts` — ephemeral-DB test infrastructure, read directly
- `packages/db/src/__tests__/migrate-from-empty.test.ts` — confirms partition/RLS assertions already in place, read directly
- `apps/api/src/modules/platform-mail/client.ts`, `apps/api/src/env.ts` — existing platform SendGrid email pattern, read directly
- `node_modules/bullmq/package.json`, `node_modules/bullmq/dist/esm/classes/{queue,job-scheduler}.d.ts` — confirmed `5.79.1` and `upsertJobScheduler` presence directly via grep
- `docker-compose.yml`, local `psql --version` — confirmed PostgreSQL 17
- `npm view @sendgrid/mail version` / `gsd-tools query package-legitimacy check` — confirmed `8.1.6`, OK verdict

### Secondary (MEDIUM confidence)
- [PostgreSQL 5.12 Table Partitioning docs](https://www.postgresql.org/docs/current/ddl-partitioning.html) — WebFetch-verified quote on CHECK-constraint-first ATTACH technique and DEFAULT-scan behavior
- [PostgreSQL ALTER TABLE docs](https://www.postgresql.org/docs/current/sql-altertable.html) — WebFetch-verified quote on exact lock levels for ATTACH PARTITION / ADD CONSTRAINT NOT VALID / VALIDATE CONSTRAINT
- [BullMQ Job Schedulers docs](https://docs.bullmq.io/guide/job-schedulers/) — WebFetch-verified `upsertJobScheduler` signature, cron pattern + `tz` usage, legacy-option deprecation note
- [Crunchy Data: Postgres Partitioning with a Default Partition](https://www.crunchydata.com/blog/postgres-partitioning-with-a-default-partition) — WebFetch-verified confirmation that no lock-free batch-move primitive exists; batched DELETE/INSERT is the standard practice

### Tertiary (LOW confidence)
- None used as authoritative — all external technical claims in this document were WebFetch-verified against first-party documentation (postgresql.org, docs.bullmq.io) rather than left as unconfirmed WebSearch snippets.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - every version number confirmed directly against installed `node_modules`, `package.json`, `npm view`, or `docker-compose.yml`; no reliance on training-data version guesses
- Architecture: HIGH - every pattern is either a direct extension of an existing, working in-repo pattern (repeatable tick, hand-written partition migration, generic SQL client interface) or a first-party-documented PostgreSQL technique quoted verbatim
- Pitfalls: HIGH - Pitfall 13's mechanics were independently re-verified against official PostgreSQL docs (not just restated from `.planning/research/PITFALLS.md`); the Bull Board gap (Pitfall 3) was discovered via direct repo grep, not assumed

**Research date:** 2026-08-06
**Valid until:** 2026-09-06 (30 days — stable, mature technology; the one date-sensitive element, the exact catch-up migration horizon in Open Question 2, is inherently time-bound to the 2026-09-01 deadline and should be recomputed at plan/execute time regardless of this document's staleness window)
