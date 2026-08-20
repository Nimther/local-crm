# Phase 14: Deployment & Database Durability - Pattern Map

**Mapped:** 2026-08-12
**Files analyzed:** ~22 new/modified files (Dockerfiles, compose, deploy/migrate scripts, pool factory, health routes, worker health server, CI job, backup config, retention extension, constraint migration)
**Analogs found:** 18 / 22 (strong or partial); 4 have no in-repo analog (Dockerfiles, Caddyfile, pgbackrest.conf, deploy.sh — genuinely new infra classes; RESEARCH.md's Code Examples section is the fallback for these)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|---------------|
| `docker/Dockerfile.api` / `.web` / `.worker` | config | build/deploy | none in-repo | no analog — use RESEARCH.md Code Examples |
| `docker/docker-compose.prod.yml` | config | request-response (orchestration) | `docker-compose.yml` (root) | exact (same vocabulary, promoted) |
| `docker/Caddyfile` | config | request-response (reverse proxy) | none in-repo | no analog — use RESEARCH.md Caddyfile skeleton |
| `docker/pgbackrest/pgbackrest.conf` | config | batch/backup | none in-repo | no analog — use RESEARCH.md skeleton |
| `scripts/deploy.sh` | utility | event-driven (operator-triggered) | `scripts/migrate-dev.mjs` (predev bootstrap script shape) | partial — same "one script, propagate exit code, no swallow" convention |
| `scripts/migrate-runner.mjs` (or `.ts`) | migration | batch (one-shot) | `scripts/migrate-dev.mjs` + `packages/db/scripts/count-send-event-duplicates.ts`-style operator script | role-match — dedicated-connection lock semantics are new, but env/CLI conventions carry over |
| `packages/db/src/pool.ts` (`createPgPool`) | utility/service | CRUD (connection factory) | `packages/db/src/index.ts` (`pool.on("error", ...)`) + `packages/queue-core/src/connection.ts` (`buildRedisConnectionOptions`/`createRedisConnection` single-definition precedent) | exact — same "one factory, one error listener" shape, different resource type |
| `apps/api/src/modules/ops/health.ts` (`/healthz`, `/readyz`) | route | request-response | `apps/api/src/modules/campaigns/send-settings.routes.ts` (`registerXRoutes(fastify)` plugin shape) + `apps/api/src/modules/ops/partition-watchdog.ts` (ops-module precedent, reads DB state, no auth) | role-match |
| `apps/worker/src/health-server.ts` | service | request-response (localhost HTTP) | `apps/worker/src/server.ts` (`WorkerRuntime`, boot/shutdown ownership) | partial — new `node:http` surface, but lives in the same "single owner of process lifecycle" file |
| `.github/workflows/ci.yml` (new `build-and-push` job) | config | event-driven (CI trigger) | `.github/workflows/ci.yml` existing `static`/`test`/`failure-injection` jobs | exact — same file, same SHA-pinning convention |
| `apps/worker/src/queues/partition-maintenance.worker.ts` (extend for retention drop) | service (worker tick) | batch/event-driven | itself (existing tick) + Phase 9 `ensurePartitions`/`runPartitionMaintenance` | exact — same catalog-driven tick, opposite end of the timeline |
| DB-12 constraint migration (`00XX_member_unique_org_user.sql`) | migration | CRUD (schema DDL) | `packages/db/migrations/0057_send_events_dedup_rebase.sql` | exact — explicitly named precedent in CONTEXT.md/RESEARCH.md |
| DB-12 duplicate pre-check script | utility | batch (read-only report) | `packages/db/scripts/count-send-event-duplicates.ts` (companion to 0057) | exact |
| Snapshot backfill (`packages/db/migrations/meta/*_snapshot.json`) | migration | batch | existing 12 snapshot files (drizzle-kit generated) | exact — same generation mechanism, just filling gaps |
| Migration test suite extension (DB-07 rehearsal) | test | batch | existing `test:migrations` suite (full-chain-against-empty-DB) | exact |
| Failure-injection scenarios (unclean-death, two-version, mid-load SIGTERM) | test | event-driven | `packages/test-support` existing 13 scenarios | exact |
| `scripts/ensure-db-roles.mjs`-equivalent for prod | utility | CRUD (bootstrap) | `scripts/ensure-db-roles.mjs` + `docker/init-app-role.sql` | exact |

## Pattern Assignments

### `packages/db/src/pool.ts` (`createPgPool` factory)

**Analog:** `packages/db/src/index.ts` (pool construction + error listener) and `packages/queue-core/src/connection.ts` (single-definition factory precedent for Redis, WRK-11)

**Existing pool construction + error handler** (`packages/db/src/index.ts`, near top after schema assembly):
```typescript
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set to construct the Drizzle client (@mega-crm/db)");
}

const pool = new Pool({ connectionString: databaseUrl });

// CR-03 precedent (see authPool below / @mega-crm/tenant-context's pool.on):
// without this listener an idle-connection termination surfaces as an
// uncaught 'error' event and crashes the process.
pool.on("error", (err) => {
  console.error("idle pg pool client error (connection dropped)", err);
});

export const db = drizzle(pool, { schema });
```

**Lazy-construction precedent for a second, differently-credentialed pool** (`packages/db/src/index.ts`, `authPool`/`authDb`, Phase 10 SEC-05):
```typescript
// Built LAZILY (mirrors packages/tenant-context/src/scan.ts's getScanPool
// pattern), not at module load — the worker process imports @mega-crm/db too
// but no worker source imports the better-auth schema, so eager construction
// here would throw at worker boot for no reason.
let authPool: Pool | undefined;
let authDbInstance: ReturnType<typeof drizzle<typeof schema>> | undefined;
```
Use this same lazy-Proxy shape if `createPgPool()` call sites need to defer construction (e.g. worker vs api not both needing every pool eagerly).

**Single-definition factory precedent (WRK-11), to copy the *shape* from** (`packages/queue-core/src/connection.ts`, lines ~30-50):
```typescript
export function buildRedisConnectionOptions(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  const db = url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined;

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeCredential(url.username, "username") : undefined,
    password: url.password ? decodeCredential(url.password, "password") : undefined,
    db,
    maxRetriesPerRequest: null,
  };
}
```
`createPgPool()` should follow the identical "one function, documented rationale comments inline for every non-obvious config choice, `error` listener wired unconditionally" shape. RESEARCH.md's Code Examples § `createPgPool` factory skeleton is the concrete draft already aligned with this precedent — use it as the starting point, not `packages/db/src/index.ts`'s inline `new Pool` (which the factory replaces).

**Error handling convention:** every pool in this codebase gets `pool.on("error", ...)` routed through `scrubbedConsole` (queue-core) or `console.error` (older `packages/db/src/index.ts` code, pre-redaction-package). New code should route through `@mega-crm/redaction`'s `scrubbedConsole`, matching queue-core's more recent convention, not the older bare `console.error` in `packages/db/src/index.ts`.

---

### `scripts/migrate-runner.mjs` (D-12 one-shot migrate step)

**Analog:** `scripts/migrate-dev.mjs` (env resolution + exit-code propagation convention) + `scripts/env-path.mjs` (`MEGA_CRM_ENV_FILE` convention)

**Env loading + fail-loud convention** (`scripts/migrate-dev.mjs`, full file is ~35 lines):
```javascript
import { resolveEnvPath } from "./env-path.mjs";

try {
  process.loadEnvFile(resolveEnvPath());
} catch {
  // .env not present -- rely on already-exported environment variables
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required to apply migrations -- set it in .env");
  process.exit(1);
}

// Let a migrate failure propagate as a non-zero exit -- do not swallow it.
execSync("npm run db:migrate", { stdio: "inherit", env: process.env });
```
The new runner keeps this env-resolution and "propagate non-zero, never swallow" convention, but replaces the `execSync("npm run db:migrate")` CLI delegation with the in-process `drizzle-orm/node-postgres/migrator` call (RESEARCH.md Pattern 1 — dedicated `pg.Client`, bounded `pg_try_advisory_lock` retry loop, `migrate(db, { migrationsFolder })`, explicit unlock + `client.end()` in `finally`). No dependencies beyond what's already in `packages/db` — Node built-ins + `pg` + `drizzle-orm`, matching this repo's "no dependencies — Node built-ins only" preference for scripts (per `scripts/env-path.mjs` header comment) as far as possible.

**`MEGA_CRM_ENV_FILE` convention** (`scripts/env-path.mjs`, header + `resolveEnvPath`):
```javascript
// The default is deliberately OUTSIDE the repository... MEGA_CRM_ENV_FILE
// overrides it entirely, which is how CI... and any non-standard local
// setup opt out without editing code.
export function resolveEnvPath() {
  const override = process.env.MEGA_CRM_ENV_FILE;
  if (override && override.trim() !== "") return override;
  // XDG_CONFIG_HOME fallback...
}
```
Any new prod env var (S3 backup credentials, pgBackRest cipher passphrase, TLS cert paths) is resolved through this exact same file/convention — do not invent a second config-loading mechanism for deploy-time secrets.

---

### `apps/api/src/modules/ops/health.ts` (`/healthz`, `/readyz`)

**Analog:** `apps/api/src/modules/campaigns/send-settings.routes.ts` (Fastify plugin registration shape) + `apps/api/src/modules/ops/partition-watchdog.ts` (existing ops-module precedent — reads DB state, no auth, wired into boot)

**Route registration shape to copy** (`send-settings.routes.ts`, lines ~1-20):
```typescript
import type { FastifyInstance } from "fastify";

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract
export async function registerSendSettingsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/workspaces/:slug/send-settings", async (request, reply) => {
    // ... auth/lookup/response
    return reply.send(settings);
  });
}
```
`registerOpsHealthRoutes(fastify)` follows this identical `export async function register...Routes(fastify: FastifyInstance)` shape, registered in `apps/api/src/server.ts` alongside the other `await app.register(registerXRoutes)` calls (see lines ~202-215 of `server.ts` for the exact registration list and ordering convention). Unlike every other route in this list, `/healthz`/`/readyz` take NO `requirePermission`/tenant-lookup preHandler (D-13/D-14 — no auth) — this deviates intentionally from the `send-settings.routes.ts` pattern's auth/tenant lookup, matching instead the un-authenticated shape of existing infra endpoints (webhook ingestion routes are the closest "no per-request auth, but still Fastify" precedent if a second reference is needed).

**Ops-module conventions already established** (`apps/api/src/modules/ops/partition-watchdog.ts`, `ingestion-health-watchdog.ts`, `dead-letter-watchdog.ts`, `reputation-watchdog.ts`, `send-reconciler-watchdog.ts`) — this is the existing "ops" directory `health.ts` joins; each watchdog file independently reads a DB health-row/state table and exposes a read function. `/readyz`'s applied-vs-shipped migration check (RESEARCH.md Pattern 2) should follow the same "read one state table, compare against expectation, fail closed" shape these watchdogs already use, not invent a new idiom.

**Server registration site** (`apps/api/src/server.ts`, lines ~47-65 imports, ~202+ registration calls):
```typescript
import { registerAnalyticsRoutes } from "./modules/analytics/index.js";
import { registerSendLogRoutes } from "./modules/send-log/send-log.routes.js";
// ...
await app.register(registerAnalyticsRoutes);
await app.register(registerSendLogRoutes);
```
Add `registerOpsHealthRoutes` to this same import/register block.

---

### `apps/worker/src/health-server.ts` (D-14 localhost health server)

**Analog:** `apps/worker/src/server.ts` (`WorkerRuntime` — single owner of process lifecycle/boot/shutdown)

**Process-lifecycle-ownership convention** (`apps/worker/src/server.ts`, doc comment on `WorkerRuntime`):
```typescript
/**
 * The worker process's runtime handle: a standalone shared ioredis
 * connection (kept for process-level shutdown/inspection...) plus every
 * registered BullMQ Worker. ... this file stays the single place that
 * owns process-level startup/shutdown.
 */
export interface WorkerRuntime {
  connection: ReturnType<typeof createRedisConnection>;
  workers: Worker[];
  close: () => Promise<void>;
}
```
The new `node:http` health server should be constructed and its lifecycle (`listen`/`close`) owned inside this same `server.ts` boot/shutdown sequence — added to `WorkerRuntime`'s `close()` in the same explicit, ordered way the existing worker-close sequence is documented ("every registered Worker closes FIRST (draining any in-flight jobs) ..." — see the shutdown-ordering doc comment just below `WorkerRuntime`). No existing analog file uses raw `node:http` in this repo yet — RESEARCH.md's "Supporting" table confirms this is a deliberate zero-dependency choice consistent with `scripts/env-path.mjs`'s stated preference, not a gap to fill with an analog search.

---

### DB-12 constraint migration + duplicate pre-check

**Analog:** `packages/db/migrations/0057_send_events_dedup_rebase.sql` + its companion `packages/db/scripts/count-send-event-duplicates.ts` — explicitly named in CONTEXT.md/RESEARCH.md as the proven precedent; do not re-derive.

**Migration shape to copy** (`0057_send_events_dedup_rebase.sql`, structural pattern, header comment + step numbering):
```sql
-- =============================================================================
-- OPERATOR SEQUENCE (read this before applying, since a step lives outside SQL)
-- =============================================================================
-- 1. `npm run db:count-<x>-duplicates` -- read-only, reports the exact blast
--    radius.
-- 2. If non-zero, run `npm run db:resolve-<x>-duplicates` -- deletes all but
--    the earliest row per group, in bounded, committed batches.
-- 3. Apply this migration.
--
-- STEP 0 -- fail closed on any surviving duplicate under the NEW key
-- (a DO $$ ... END $$ block RAISEs and stops if duplicates remain)
--
-- STEP 1 -- CREATE UNIQUE INDEX CONCURRENTLY ...
-- STEP 2 -- ADD CONSTRAINT ... UNIQUE USING INDEX ...
-- STEP 3 -- assert pg_index.indisvalid, RAISE if not
```
For `member(organizationId, userId)`: same duplicate-pre-check-as-separate-script + `CREATE UNIQUE INDEX CONCURRENTLY` + `ADD CONSTRAINT ... UNIQUE USING INDEX` + `indisvalid` assertion shape. **Deviation to resolve before copying verbatim** (flagged in RESEARCH.md "DB-12 trust-boundary nuance"): `member`/`invitation` are Better Auth tables behind the `mega_crm_auth` role (`getAuthDb()` in `packages/db/src/index.ts`), not `mega_crm_app` — 0057's pre-check ran as `mega_crm_app` because `send_events` has `FORCE ROW LEVEL SECURITY` under that role; `member` has no RLS. The plan must decide which role runs the DB-12 pre-check/migration before reusing 0057's shape as-is.

**No-DELETE-in-migration convention** (0057's header): "This migration contains NO DELETE statement anywhere -- its only job regarding duplicates is to make skipping the resolve step impossible to do silently." Same rule applies to the DB-12 migration — any row-level cleanup goes in an operator-invoked script (Phase 9 D-08 `relocate-default-partition-rows.ts` precedent, restated in 0057's own header), never inside the migration file.

---

### `apps/worker/src/queues/partition-maintenance.worker.ts` (D-08 retention extension)

**Analog:** itself — the existing tick this phase extends, plus Phase 9's `ensurePartitions`/`runPartitionMaintenance`

**Existing tick registration shape** (`partition-maintenance.worker.ts`, lines ~1-45):
```typescript
import {
  BUFFER_ALERT_THRESHOLD_MONTHS,
  LOOKAHEAD_MONTHS,
  PARTITION_MAINTENANCE_CRON,
  type PartitionClient,
} from "@mega-crm/db/src/partitions/ensure-partitions.js";
import {
  runPartitionMaintenance,
  type MaintenanceRunSnapshot,
} from "@mega-crm/db/src/partitions/maintenance-run.js";

export const PARTITION_MAINTENANCE_QUEUE = "partition-maintenance";
const JOB_SCHEDULER_ID = "partition-maintenance-daily";
```
Registered via BullMQ's `upsertJobScheduler` API (fixed UTC hour, not interval-from-boot) — D-08's retention drop should join this same tick (same catalog-driven walk, "opposite end of the timeline" per CONTEXT.md) rather than spinning up a second scheduled job, unless the plan decides retention drop needs to be operator-confirmed (per Phase 9 D-08's precedent that destructive relocation was operator-only — flagged as an open planner decision in both CONTEXT.md and RESEARCH.md, not resolved here).

**Versioned-constant convention:** `BUFFER_ALERT_THRESHOLD_MONTHS`, `LOOKAHEAD_MONTHS` are the existing precedent for how the new retention-horizon constant (~12 months) should be declared — a named, exported, commented constant in the `@mega-crm/db/src/partitions/` module, not a magic number inline in the worker.

---

### `.github/workflows/ci.yml` (new `build-and-push` job)

**Analog:** the file's own existing `static`/`test`/`failure-injection` jobs

**SHA-pinning + trigger-scoping convention** (`ci.yml`, header comments + job structure):
```yaml
on:
  push:
    branches: [master]
  pull_request:
    branches: [master]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  static:
    name: static
    runs-on: ubuntu-latest
```
Every third-party action in this file is pinned to a full commit SHA with the tag in a trailing comment (explicit repo convention, stated in the file's own header). The new `build-and-push` job (RESEARCH.md's GHCR skeleton) must follow this same pinning convention for `actions/checkout`, `docker/login-action`, `docker/build-push-action` — do not copy floating-tag `@v4`-style refs from the RESEARCH.md skeleton verbatim; resolve current SHAs at implementation time as RESEARCH.md itself flags. New job should be gated `needs: [static, test, failure-injection]` and `if: github.ref == 'refs/heads/master'`, matching the existing "required checks on master" job split documented in the file's own header comment.

---

## Shared Patterns

### Pool error handler (mandatory on every pool)
**Source:** `packages/db/src/index.ts` (`pool.on("error", ...)`), `packages/queue-core/src/connection.ts` (equivalent for Redis, WRK-11 precedent)
**Apply to:** `createPgPool()` factory and every one of the ~8 `new Pool` call sites it absorbs (db index, tenant-context, scan, dead-letter writer, partition maintenance, operator scripts).
```typescript
pool.on("error", (err) => {
  scrubbedConsole.error("createPgPool: idle client error (connection dropped)", err);
});
```

### `MEGA_CRM_ENV_FILE` / env resolution
**Source:** `scripts/env-path.mjs`
**Apply to:** any new script or config that needs S3 credentials, pgBackRest cipher passphrase, TLS cert material, or `DATABASE_URL` — the migrate runner, deploy.sh, any operator CLI touching prod secrets.

### Fastify route registration (`registerXRoutes(fastify)`)
**Source:** every file in `apps/api/src/modules/*/*.routes.ts`, wired via `await app.register(registerXRoutes)` in `apps/api/src/server.ts`
**Apply to:** `apps/api/src/modules/ops/health.ts`'s `/healthz`/`/readyz` routes — same shape, but explicitly WITHOUT the `requirePermission`/tenant-lookup preHandler every other route in this list uses.

### Versioned constants with rationale comments
**Source:** `apps/worker/src/queues/partition-maintenance.worker.ts` (`BUFFER_ALERT_THRESHOLD_MONTHS`, `LOOKAHEAD_MONTHS`, `PARTITION_MAINTENANCE_CRON`), `apps/worker/src/shutdown-budget.ts` (Phase 12 drain-budget)
**Apply to:** retention horizon (~12 months), migration advisory-lock key, `/readyz` wait timeout, pool sizing defaults, container memory limits, `WORKER_STOP_GRACE_PERIOD_SECONDS` extraction into compose.

### Operator-invoked-only destructive operations
**Source:** Phase 9 D-08 `relocate-default-partition-rows.ts`, restated in migration 0057's header for `count-send-event-duplicates.ts --resolve`
**Apply to:** any DB-12 duplicate-resolution DELETE; the open question of whether D-08's scheduled partition-DROP retention crosses this same line (explicitly left to the planner in CONTEXT.md/RESEARCH.md).

### CI SHA-pinning + required-check job split
**Source:** `.github/workflows/ci.yml` header comments
**Apply to:** the new `build-and-push` image job.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `docker/Dockerfile.api` / `.web` / `.worker` | config | build/deploy | No Dockerfile exists anywhere in the repo yet (dev runs via `npm run dev`, not containers) — use RESEARCH.md's Standard Stack/Anti-Patterns sections (Node 22-slim, `CMD` direct binary, non-root, multi-stage) as the reference instead of an in-repo analog. |
| `docker/Caddyfile` | config | request-response (edge) | No reverse-proxy config exists in-repo (dev has no HTTPS termination layer) — use RESEARCH.md's Caddyfile skeleton (`caddyserver.com/docs/caddyfile/patterns`). |
| `docker/pgbackrest/pgbackrest.conf` | config | batch/backup | No backup tooling config exists in-repo (dev has no backup story) — use RESEARCH.md's pgbackrest.conf skeleton, verify exact keys against installed pgBackRest version at build time. |
| `scripts/deploy.sh` | utility | event-driven (operator-triggered) | No prior deploy script exists (no prior deployment target) — closest partial analog is `scripts/migrate-dev.mjs`'s "propagate exit code, don't swallow" convention; the `docker compose run --rm` vs `up` distinction (RESEARCH.md Pitfall C) has no in-repo precedent to copy from. |

## Metadata

**Analog search scope:** `packages/db/src`, `packages/queue-core/src`, `scripts/`, `apps/api/src/modules/ops`, `apps/api/src/modules/campaigns`, `apps/worker/src`, `.github/workflows/`, `docker-compose.yml`, `packages/db/migrations/0057_send_events_dedup_rebase.sql`
**Files scanned:** ~15 read directly (targeted, non-overlapping ranges); ~10 more located via grep/find for classification only
**Pattern extraction date:** 2026-08-12
