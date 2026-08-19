# Phase 17: Address tech debt: WR-06 + medium security follow-ups - Research

**Researched:** 2026-08-19
**Domain:** Postgres session timezone semantics, CI-built Docker images (GHCR), restore-drill instrumentation, security-register closure
**Confidence:** HIGH (every load-bearing claim below was verified either by reading the actual installed dependency / actual repo file, or by running a live query against a real local Postgres 17 instance — not by training-data recall)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**WR-06 timezone hazard**

- **D-01:** Fix at both layers. Pin `TimeZone='UTC'` at the pool level in `packages/db/src/pool.ts` (the single mandatory pool factory enforced by the `lint:pg-pool-factory` CI gate) so every `now()`-derived naive-timestamp write repo-wide is provably UTC-anchored, AND add the read-site `(created_at AT TIME ZONE 'UTC')::date` cast to the growth-chart query, mirroring Phase 13's `reconcileWorkspaceDay` pattern. Defense in depth: the query stays correct even against a pool bypass or external client. **[Research finding: the literal single-hop cast text here is empirically wrong for this naive column — see Pitfall 1. The double-hop form fulfills this same stated intent correctly; the planner must direct the executor there, not to the literal expression.]**
- **D-02:** Regression proof = behavioral test against a deliberately non-UTC Postgres. The test runs with a session/server timezone set to something like `America/New_York` and proves the pin + cast still yield UTC day boundaries. This exercises the exact failure mode the review said no existing test can catch (CI/dev Postgres defaults to UTC, masking the bug). A mere `SHOW timezone` assertion was rejected as insufficient on its own.
- **D-03:** Sweep breadth = named site + recorded audit. Fix the growth-chart query and the adjacent baseline count in `apps/api/src/modules/analytics/dashboard.repository.ts`, then grep-audit all remaining bare `::date` casts on naive timestamp columns; fix any that affect user-visible day bucketing, and record the rest as verified-safe in the plan/summary. A mechanical repo-wide cast rewrite was rejected (touches stable reviewed queries for a hazard the pool pin already closes).
- **D-04:** No column-type migration. `contacts.created_at` and sibling columns stay `timestamp` without time zone; pin + casts close the hazard. Matches how Phase 13 handled the identical hazard on `sends`/`send_events`. — Reversibility: reversible — a `timestamptz` migration remains available later if wanted.

**DB image immutability (T-14-58 / T-14-88)**

- **D-05:** `megacrm-postgres` becomes CI-built and registry-pulled. Build in GitHub Actions like `api`/`worker`/`web`, push to GHCR on immutable SHA tags, drop the `build:` sections from `docker/docker-compose.prod.yml`, and add `db` + `pgbackrest` to `FIRST_PARTY_IMAGE_SERVICES` in `scripts/validate-prod-compose.mjs`. Closes both threat rows outright as mitigated. — Reversibility: costly.
- **D-06:** Tag scheme = same git SHA, built on every master merge, alongside the three app images. `deploy.sh <sha>` keeps its single-SHA interface; `POSTGRES_IMAGE_TAG` becomes that SHA.
- **D-07:** Production cutover happens in-phase via an operator blocking checkpoint (the proven Phase 14/16 pattern): pull the GHCR image, restart `db` + `pgbackrest`, verify Postgres healthy, RLS enabled+forced posture intact, and WAL archiving resuming. Threat rows close on live evidence, not on code landing alone.

**Restore-drill metrics (T-14-73)**

- **D-08:** A real drill runs in-phase, as a checkpointed operator step after the image cutover — it fills the runbook placeholder AND doubles as proof the CI-built image restores correctly via PITR.
- **D-09:** `scripts/restore-drill.sh` gains automatic self-recording of wall-clock duration and disk-usage sampling (high-water) into the drill output, so this drill and every future one records the figures without relying on operator memory.

**Closure evidence & register updates**

- **D-10:** Full documentation trail. Flip T-14-58/T-14-73/T-14-88 rows to closed in `14-SECURITY.md` citing evidence; annotate the WR-06 entry as closed in `v1.1-MILESTONE-AUDIT.md`; update `SPECIFICATION.md` (§2/§5/§6 as applicable) for the pool TimeZone pin, the CI-built postgres image, and the drill instrumentation.
- **D-11:** The Phase 15 alloy confirmation folds into the cutover checkpoint: during the same live session the operator verifies the alloy container stays running (not restarting) and log lines keep arriving in Loki.
- **D-12:** Register flips are signed off by a security-auditor re-run (`/gsd-secure-phase`), not the executor.

### Claude's Discretion

- Exact mechanism for the pool-level pin (`options: '-c TimeZone=UTC'` in Pool config vs connect-event `SET`), where the non-UTC test lives, and how the non-UTC Postgres is provisioned in CI. **[Researched: `options` config, session-scoped `ALTER DATABASE ... SET timezone` — see Architecture Patterns 1/3.]**
- CI workflow shape for the postgres image build (same workflow vs separate job), tag fallback behavior for dev compose, and whether the dev `docker-compose.yml` keeps a local build path. **[Researched: two standalone jobs in the existing `images.yml`; dev compose is unaffected — it never referenced `megacrm-postgres` — see Pitfall 2 and Alternatives Considered.]**
- Drill PITR target choice and the exact output format of the self-recorded metrics. **[Left to plan/operator time — see Open Question 1 and Assumption A1.]**
- Sequencing of the cutover checkpoint vs the drill within the phase (drill after cutover is fixed; the rest is planner's).

### Deferred Ideas (OUT OF SCOPE)

- Full `timestamptz` migration of naive timestamp columns — considered and rejected for this phase (D-04); may be evaluated in a future schema-hygiene pass if the pin+cast posture ever proves insufficient.
- Phase 13's five deferred live human-verification walkthroughs (unsubscribe atomicity, timezone-independence, erasure end-to-end, event integrity, backfill/reputation) — out of scope for this phase, tracked in the milestone audit only.
</user_constraints>

## Summary

This phase closes three pre-identified tech-debt items with no new libraries, no new architecture, and no new product surface: a UTC day-bucketing hazard on a naive `timestamp` column (WR-06), a mutable-tag gap in the production-image-immutability gate for the custom `megacrm-postgres` image (T-14-58/T-14-88), and a runbook placeholder for restore-drill duration/disk metrics (T-14-73). All three fixes extend **existing** mechanisms this codebase already has: `createPgPool` (the one mandatory pool factory), `.github/workflows/images.yml` (the existing GHCR build-and-push workflow), `scripts/validate-prod-compose.mjs`'s `FIRST_PARTY_IMAGE_SERVICES` gate, and `scripts/restore-drill.sh`.

**The single most important finding in this research is a correction to the literal fix mechanism CONTEXT.md's D-01 and the source review (13-REVIEW.md WR-06) both describe.** Both texts describe the read-site fix as "mirror `reconcileWorkspaceDay`'s `(col AT TIME ZONE 'UTC')::date` pattern despite the column being timestamp-without-timezone." **This literal single-hop expression is provably wrong when applied to a naive column** — it is correct only for `timestamptz` columns (which is what `sends.*_at` actually are). Verified empirically against a real local Postgres 17 (see Pitfall 1 below): applying `(naive_col AT TIME ZONE 'UTC')::date` to a naive `timestamp` column is **session-timezone-DEPENDENT** (wrong under `America/New_York`), while the codebase's own existing bare `naive_col::date` cast is already session-independent, and the **double-hop** form `((naive_col AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date` — already established in this exact codebase at `packages/db/src/partitions/relocate-default.ts` — is the one that is actually correct. D-02's own non-UTC behavioral test will catch this immediately if the single-hop form is implemented literally, so this is not a hypothetical: implementing the literal CONTEXT.md text will fail the test CONTEXT.md itself mandates. The planner must direct the executor to the double-hop form.

**Primary recommendation:** Pin `TimeZone` via `options: '-c TimeZone=UTC'` in the `Pool` config inside `createPgPool` (verified working against the actual installed `pg@8.22.0`, not the racier `pool.on('connect', ...)` pattern); use the double-hop `AT TIME ZONE 'UTC'` idiom (matching `relocate-default.ts`) at the growth-chart read site, not the single-hop form; provision the D-02 non-UTC test via `ALTER DATABASE <ephemeral-db> SET timezone TO 'America/New_York'` against the test's own already-isolated `createEphemeralDatabase()` database (never a container/server-level change, which would corrupt every concurrent CI test sharing the one Postgres service); add two new single-purpose jobs to the existing `.github/workflows/images.yml` (not a new workflow file) for the `db`/`pgbackrest` image, using its own `context`/`file` (they differ from the `api`/`worker`/`web` matrix shape); and add wall-clock + `docker exec ... du` disk sampling directly inside `scripts/restore-drill.sh`'s existing `run_real_drill` function.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| UTC timezone pin for all Postgres writes | API/Backend (connection-pool factory, `packages/db/src/pool.ts`) | Database | The fix is a connection-level Postgres session parameter set by every long-running process (api, worker) and every operator script that goes through the shared factory — a single choke point, not a per-service concern. |
| UTC-correct day bucketing (growth chart) | API/Backend (`apps/api/src/modules/analytics/dashboard.repository.ts`) | Database | Read-site SQL cast; the query itself decides correctness, independent of which session executes it. |
| Non-UTC behavioral regression test | API/Backend test suite (`packages/db` or `apps/api`, `__tests__`) | Database / CI | Exercises real Postgres session-timezone negotiation; must run against a real ephemeral Postgres database, not a mock. |
| CI-built, GHCR-pulled `megacrm-postgres` image | CI/CD (`.github/workflows/images.yml`) | Infra/Deploy (`docker-compose.prod.yml`, `deploy.sh`) | Same tier that already builds/pushes `api`/`worker`/`web`; the image-immutability invariant is enforced by `scripts/validate-prod-compose.mjs`, a CI/CD-tier gate. |
| Production cutover to the new image | Infra/Deploy (operator, live VPS) | — | A live production state change (container restart) — cannot be simulated in CI; requires the Phase 14/16 blocking-checkpoint pattern. |
| Restore-drill self-recorded metrics | Infra/Deploy (`scripts/restore-drill.sh`) | Database | The drill orchestrates Docker/pgBackRest and directly observes wall-clock time and container disk usage — it is the only place with both facts in scope. |
| Security register closure (D-10/D-12) | Documentation/Process (`14-SECURITY.md`, `SPECIFICATION.md`) | — | No code tier; a `gsd-secure-phase` auditor re-run per D-12. |

## Standard Stack

No new libraries. This phase changes configuration/SQL/CI-YAML/Bash inside the existing stack.

### Core (existing, unchanged versions — confirmed against installed `package.json`)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `pg` | 8.22.0 `[VERIFIED: packages/db/package.json + node_modules/pg]` | Postgres driver | Already the sole driver in the monorepo; `options` startup-parameter behavior was verified directly against this exact installed version (see Code Examples). |
| PostgreSQL | 17 (`postgres:17` dev/CI image; `megacrm-postgres` prod image built `FROM postgres:17`) `[VERIFIED: docker-compose.yml, docker/postgres/Dockerfile]` | Primary datastore | Unchanged. |
| pgBackRest | 2.59.0 `[CITED: docs/runbooks/backups.md, 14-SECURITY.md]` | Backup/PITR | Unchanged; the restore-drill instrumentation wraps its existing invocation, does not touch its config. |
| Vitest | (existing per-workspace `vitest.config.ts`) `[VERIFIED: 16 vitest.config.ts files found repo-wide]` | Test runner | D-02's behavioral test is a Vitest test, following the existing `packages/db/src/__tests__/pg-tls.test.ts` pattern exactly. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `options: '-c TimeZone=UTC'` in `Pool` config | `pool.on('connect', client => client.query("SET TIME ZONE 'UTC'"))` | **Rejected.** A real node-postgres issue (brianc/node-postgres#3265, "Timezone not set on pool event 'connect'") documents a race: the `SET` fires asynchronously and a query can reach the connection before it completes, so timezone silently fails to apply on some fraction of connections. The startup-parameter form is negotiated during the connection handshake itself, before any query can run — no race is possible. `[CITED: github.com/brianc/node-postgres/issues/3265]` |
| Session-level `SET TIME ZONE` for the D-02 non-UTC test | Container-level `TZ`/`PGTZ` env var, or a second Postgres service in CI | **Rejected for the primary mechanism.** `packages/test-support/src/provision-db.ts` provisions every ephemeral test database against **one shared Postgres cluster** (`DEFAULT_ADMIN_DSN = postgres://postgres:postgres@localhost:5432/postgres`). A container/server-level `TZ` change would flip the default for every concurrently-running test on that same cluster (Vitest runs suites in parallel workers), silently breaking any test that implicitly assumes a UTC default. `ALTER DATABASE <this-ephemeral-db> SET timezone TO 'America/New_York'` is scoped to exactly the one throwaway database this test provisions and owns — verified safe by reading `createEphemeralDatabase`'s per-run unique-naming scheme (`buildEphemeralDatabaseName`). |
| Single `images.yml` job with `app: [api, web, worker, db]` matrix | Extending the existing matrix job | **Rejected.** The matrix's steps hard-code `file: docker/Dockerfile.${{ matrix.app }}` and `context: .` (repo root) for a reason: `db`'s actual Dockerfile lives at `docker/postgres/Dockerfile` with build `context: docker/` (per `docker-compose.prod.yml`'s own `build:` block), and it needs no `npm ci`/`VITE_SENTRY_DSN` build-arg machinery the app images need. Forcing it into the same matrix means either inventing a symlink/rename (`docker/Dockerfile.db`) purely to satisfy the matrix's path convention, or branching the matrix step logic on `matrix.app == 'db'` — both add more incidental complexity than two small standalone jobs. |
| Row-changing `timestamptz` migration for `contacts.created_at` | Keep `timestamp` (naive) | Already decided (D-04, locked) — no column-type migration this phase. |

### Package Legitimacy Audit

**Not applicable.** This phase introduces zero new npm/pip/cargo packages. Every file touched (`pool.ts`, `dashboard.repository.ts`, `validate-prod-compose.mjs`, `docker-compose.prod.yml`, `restore-drill.sh`, `.github/workflows/images.yml`) is edited in place using only already-installed dependencies and Bash/YAML/SQL. No `Package Legitimacy Audit` table is required.

## Architecture Patterns

### System Architecture Diagram

```
                     ┌─────────────────────────────────────────────┐
                     │  Every long-running process / operator CLI  │
                     │  (apps/api, apps/worker, packages/db/scripts)│
                     └───────────────────┬───────────────────────────┘
                                          │ createPgPool({connectionString, name})
                                          ▼
                     ┌─────────────────────────────────────────────┐
                     │  packages/db/src/pool.ts  (single factory)   │
                     │  NEW: options: '-c TimeZone=UTC' in Pool cfg │
                     │  (applies to EVERY new physical connection   │
                     │   at handshake time, before any query runs) │
                     └───────────────────┬───────────────────────────┘
                                          │ every INSERT/UPDATE with now()/defaultNow()
                                          ▼
                     ┌─────────────────────────────────────────────┐
                     │  Postgres: naive `timestamp` columns now     │
                     │  ALWAYS store true UTC wall-clock values,    │
                     │  regardless of server/database default TZ   │
                     └───────────────────┬───────────────────────────┘
                                          │ read (any session, any TZ)
                                          ▼
    ┌───────────────────────────────────────────────────────────────────┐
    │ dashboard.repository.ts growth query                              │
    │ ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date         │
    │  -- double-hop: session-independent by construction (verified)    │
    └───────────────────────────────────────────────────────────────────┘

    ── separate, unrelated CI/deploy pipeline ──

.github/workflows/images.yml (push: master)
  ├─ build-and-push (matrix api/web/worker)      -- unchanged
  ├─ NEW build-and-push-postgres (single job)    -- context: docker/, file: postgres/Dockerfile
  │     tags: ${GHCR_BASE}/postgres:${{ github.sha }}   (same SHA as the 3 app images)
  └─ build-only-postgres (pull_request, no push) -- mirrors build-only

scripts/validate-prod-compose.mjs
  FIRST_PARTY_IMAGE_SERVICES: add "db", "pgbackrest"
  → gate now REJECTS docker-compose.prod.yml's old
    `image: megacrm-postgres:${POSTGRES_IMAGE_TAG:-local}` + `build:` sections

docker-compose.prod.yml: db/pgbackrest
  image: ${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG}   -- build: REMOVED

Operator checkpoint (D-07, D-11):
  pull image → restart db+pgbackrest → verify healthy/RLS/WAL →
  verify alloy still running + Loki receiving (folds in Phase 15 item)
  → run scripts/restore-drill.sh (now self-recording duration + disk high-water)
```

### Recommended Project Structure

No new files/directories beyond one new test file:

```
packages/db/src/
├── pool.ts                              # MODIFY: add options: '-c TimeZone=UTC'
└── __tests__/
    └── pg-timezone.test.ts              # NEW: D-02's non-UTC behavioral test
                                          #  (sibling of the existing pg-tls.test.ts,
                                          #   same style/precedent)

apps/api/src/modules/analytics/
└── dashboard.repository.ts              # MODIFY: growth query + baseline query casts

scripts/
├── validate-prod-compose.mjs            # MODIFY: FIRST_PARTY_IMAGE_SERVICES += db, pgbackrest
└── restore-drill.sh                     # MODIFY: add duration + disk high-water recording

docker/
└── docker-compose.prod.yml              # MODIFY: db/pgbackrest image ref, remove build:

docker/prod.env.example                  # MODIFY: POSTGRES_IMAGE_TAG default -> placeholder SHA

.github/workflows/
└── images.yml                           # MODIFY: 2 new jobs for the postgres image

.planning/phases/14-deployment-database-durability/14-SECURITY.md  # MODIFY: close 3 rows (D-12, auditor-signed)
.planning/v1.1-MILESTONE-AUDIT.md                                   # MODIFY: annotate WR-06 closed
SPECIFICATION.md                                                    # MODIFY: §2/§5/§6 per D-10
```

### PgBouncer interplay (research priority #1's explicit ask)

**Not applicable today.** `DB-14` (connection pooling) was explicitly resolved in Phase 14 as "deferred to SCALE-02 as an explicit accepted decision; revisit trigger = real `max_connections` pressure" `[VERIFIED: .planning/STATE.md § Pending Todos]` — there is no PgBouncer (or any external pooler) anywhere in this repo's dev, CI, or production topology; every pool is a direct `pg.Pool` from `createPgPool` straight to Postgres. The `options: '-c TimeZone=UTC'` startup-parameter pin therefore has no intermediary to interact with today.

**Revisit trigger, recorded for whenever SCALE-02 lands:** PgBouncer in transaction-pooling mode multiplexes many client sessions over few server connections and, depending on version/config, can restrict or drop non-default startup parameters via its own `ignore_startup_parameters` setting — this has NOT been tested against this project's stack and must not be assumed to keep working unchanged. When SCALE-02 introduces PgBouncer, re-verify `options: '-c TimeZone=UTC'` actually reaches the real backend connection under transaction-mode pooling (or fall back to an explicit `SET TIME ZONE` issued per checked-out connection at that time) before trusting the pin in that topology.

### Pattern 1: Explicit-per-connection Postgres session parameter via `options`

**What:** Pass a `-c NAME=VALUE`-shaped string through `Pool`'s `options` config key. node-postgres forwards it verbatim as the `options` field of the Postgres startup packet, which the server applies as `SET`-equivalent GUCs before the connection is usable — atomically, for every physical connection the pool opens, with no extra round trip and no race window.

**When to use:** Any session-level Postgres GUC that must be guaranteed for every connection a pool ever opens (this phase: `TimeZone`).

**Example (verified against the actual installed `pg@8.22.0` on a real local Postgres 17):**
```js
// Verified directly — ran against a live local Postgres 17:
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://user@localhost:5432/postgres',
  options: '-c TimeZone=UTC',
});
const { rows } = await pool.query('SHOW TimeZone');
// rows[0] === { TimeZone: 'UTC' }   <-- confirmed empirically, this session run
```

Applied to the factory (`packages/db/src/pool.ts`), inside `createPgPool`, alongside the existing `max`:
```ts
// packages/db/src/pool.ts — createPgPool, alongside the existing `max` resolution
const pool = new Pool({
  connectionString,
  max,
  // D-01: every physical connection this pool ever opens negotiates
  // TimeZone=UTC during the Postgres startup handshake itself — before any
  // query can run on it, unlike a `pool.on('connect', ...)` SET, which is a
  // documented race in node-postgres (brianc/node-postgres#3265: the SET can
  // still be in flight when the pool marks the connection ready for a query).
  options: '-c TimeZone=UTC',
});
```

### Pattern 2: Double-hop `AT TIME ZONE 'UTC'` for UTC-correct day bucketing on a NAIVE `timestamp` column

**What:** For a `timestamp without time zone` column, `col AT TIME ZONE 'UTC'` produces a `timestamptz` (it reinterprets the naive value as a UTC wall-clock instant — correct direction). But casting THAT `timestamptz` straight to `::date` re-introduces session-`TimeZone`-dependence, because Postgres converts a `timestamptz` to the session's `TimeZone` GUC before truncating to a `date`. A second `AT TIME ZONE 'UTC'` converts the `timestamptz` back into a naive `timestamp` (now unambiguously expressed as UTC wall-clock), and casting *that* to `::date` is a pure truncation with no timezone involved at all.

**When to use:** Any day-bucketing cast on a naive `timestamp` column, when a self-documenting explicit-UTC form is wanted (matching this codebase's convention of never relying on an implicit/undocumented cast behavior).

**Example — already established in this exact codebase** (`packages/db/src/partitions/relocate-default.ts:112`):
```sql
-- Existing precedent in this repo, for a DIFFERENT naive-timestamp use case
-- (partition month bucketing) — the SAME double-hop shape this phase's growth
-- query needs:
SELECT DISTINCT date_trunc('month', ${table.partitionKeyColumn} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS month_start
```

**Corrected growth-chart query** (`apps/api/src/modules/analytics/dashboard.repository.ts`, current lines ~185-197):
```sql
-- CURRENT (bare cast — already session-independent for a naive column, see
-- Pitfall 1, but gives no explicit self-documented UTC anchor):
SELECT created_at::date::text as day, count(*)::text as "newContacts"
FROM contacts
WHERE workspace_id = $1 AND created_at >= $2::date AND anonymized_at IS NULL
GROUP BY created_at::date

-- RECOMMENDED (double-hop — explicit, self-documenting, and empirically
-- confirmed session-independent; matches relocate-default.ts's own idiom):
SELECT ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date::text as day,
       count(*)::text as "newContacts"
FROM contacts
WHERE workspace_id = $1 AND created_at >= $2::date AND anonymized_at IS NULL
GROUP BY ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date
```
The baseline-count query (line ~195, `WHERE ... created_at < $2::date ...`) does not bucket by day — it is a `<` comparison of a naive column against a `date` literal (implicitly promoted to naive midnight, no timezone conversion at all). It is **already correct** and needs no change; record it in the D-03 grep-audit as verified-safe with this exact reasoning, not silently left alone.

### Pattern 3: Isolate a non-UTC Postgres session inside one ephemeral test database

**What:** `ALTER DATABASE <name> SET timezone TO 'America/New_York'` sets the *default* session `TimeZone` new connections to that one database inherit — scoped per-database on the shared cluster, not per-server. Any connection that explicitly overrides `TimeZone` (e.g. the factory's new `options: '-c TimeZone=UTC'`) still wins; only connections with no explicit override (simulating "no pin" / a bypass client) inherit the altered default.

**When to use:** D-02's behavioral regression test, or any future test needing a real non-UTC Postgres session without disturbing other concurrently-running tests on the shared CI/dev Postgres cluster.

**Example, modeled directly on the existing `packages/db/src/__tests__/pg-tls.test.ts` pattern:**
```ts
// packages/db/src/__tests__/pg-timezone.test.ts (NEW — mirrors pg-tls.test.ts's
// own "prove the real behavior, not config" philosophy)
import { Pool } from "pg";
import { createEphemeralDatabase, dropEphemeralDatabase } from "@mega-crm/test-support";
import { createPgPool } from "../pool.js";

const provisioned = await createEphemeralDatabase({ workspace: "pg-timezone" });

// Scoped to THIS ONE ephemeral database only — does not affect any other
// concurrently-running test's connections on the shared cluster.
const admin = new Pool({ connectionString: provisioned.adminDsn });
await admin.query(`ALTER DATABASE ${provisioned.databaseName} SET timezone TO 'America/New_York'`);
await admin.end();

describe("naive timestamp UTC pin survives a non-UTC database default (WR-06, D-01/D-02)", () => {
  it("a pool with no explicit TimeZone override inherits the non-UTC default (negative control)", async () => {
    const bypassPool = new Pool({ connectionString: provisioned.dsn }); // NOT createPgPool
    const { rows } = await bypassPool.query("SHOW TimeZone");
    expect(rows[0].TimeZone).toBe("America/New_York");
    await bypassPool.end();
  });

  it("createPgPool overrides the database default and writes true UTC wall-clock values", async () => {
    const pool = createPgPool({ connectionString: provisioned.dsn, name: "pg-timezone-test" });
    const { rows } = await pool.query("SHOW TimeZone");
    expect(rows[0].TimeZone).toBe("UTC");
    // ... insert a contacts row via defaultNow(), then assert its stored
    // naive value against an independently-computed UTC wall-clock string.
    await pool.end();
  });

  it("the growth-chart's day-bucketing SQL returns the correct UTC day even when READ from a non-UTC session", async () => {
    // Insert via the UTC-pinned pool (correct write), then run the EXACT
    // growth-query SQL fragment from dashboard.repository.ts against a raw
    // client on a NON-UTC session (`SET TIME ZONE 'America/New_York'` on this
    // one client) and assert the returned day is unaffected. This is the
    // test that fails on the single-hop `(col AT TIME ZONE 'UTC')::date`
    // form and passes on the double-hop form — see RESEARCH.md Pitfall 1.
  });
});
```

### Anti-Patterns to Avoid
- **Single-hop `AT TIME ZONE 'UTC'` on a naive column, believed to be "the same fix as `sends`":** `sends.*_at` are `timestamptz`; `contacts.created_at` is `timestamp`. The two column types need OPPOSITE-direction handling — this is Pitfall 1, the central finding of this research.
- **`pool.on('connect', client => client.query('SET TIME ZONE ...'))`:** documented race in node-postgres (issue #3265) — the connection can be handed out before the `SET` completes.
- **Changing the shared CI/dev Postgres container's own `TZ`/`PGTZ` env or `postgresql.conf` for the D-02 test:** breaks every other concurrently-running ephemeral-database test on that one shared cluster (`packages/test-support/src/provision-db.ts` provisions all ephemeral test DBs against ONE cluster).
- **Extending the `images.yml` matrix's `app` array to include `db`:** the matrix's steps hard-code `docker/Dockerfile.${{ matrix.app }}` and repo-root context — `db`'s actual Dockerfile/context differ structurally, not just by name.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Per-connection Postgres session parameters | A custom `Client` subclass overriding `getStartupConf()` (seen in upstream node-postgres discussion) | `options` config key on `Pool`/`Client` | Already a supported, working config key on the installed version (verified) — no subclassing needed. |
| Ephemeral non-UTC Postgres for testing | A second Postgres Docker service in CI, or a custom test-only Postgres image with `TZ` baked in | `ALTER DATABASE <ephemeral-db> SET timezone TO ...` against the existing `createEphemeralDatabase()` fixture | Zero new CI infrastructure; reuses the exact provisioning path every other test already depends on, scoped safely per-database. |
| Immutable-tag enforcement for a new image | A parallel, second immutability-checking mechanism specific to `db`/`pgbackrest` | Add `"db"`, `"pgbackrest"` to the existing `FIRST_PARTY_IMAGE_SERVICES` set in `scripts/validate-prod-compose.mjs` | The generic check (`extractImageTag` + `isMutableTag`) already works for any service name added to that set — it was scoped out of Phase 14 by declared file-scope, not because it needed new logic. |
| Restore-drill timing/disk metrics | A separate metrics-collection script/service | Wall-clock `date +%s` deltas and `docker exec $CONTAINER du -sh ...` polling, both directly inside `scripts/restore-drill.sh`'s existing `run_real_drill` | The script already has exclusive knowledge of exactly when the restore starts/ends and which container/volume to inspect; a separate collector would need to rediscover both facts. |

**Key insight:** every mechanism this phase needs already exists in the codebase in a form ready to extend (`createPgPool`, `createEphemeralDatabase`, `images.yml`'s build-and-push job shape, `FIRST_PARTY_IMAGE_SERVICES`, `restore-drill.sh`'s own instrumentation-ready structure). No new abstraction should be introduced.

## Runtime State Inventory

This phase is a tech-debt/hardening closure, not a rename/refactor/migration — the Runtime State Inventory trigger (rename, rebrand, string replacement, migration) does not apply. Skipped per the stated omission condition, EXCEPT for one item worth naming explicitly since it touches "live service config not in git":

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Live service config | The `POSTGRES_IMAGE_TAG` value the *currently running* production `db`/`pgbackrest` containers were started with (`local`, built on the VPS host, per D-05's own problem statement) lives only in that host's running container state / `docker-compose.prod.yml` at the time of last deploy — not reconstructible from git history alone. | The D-07 cutover checkpoint's live evidence step (pull GHCR image, verify healthy) is the record of this transition; no separate migration needed since Postgres data lives in a persistent named volume untouched by the image swap. |
| OS-registered state | None — this phase touches no OS-level task schedulers, pm2 processes, or systemd units. | — |
| Secrets/env vars | `POSTGRES_IMAGE_TAG` itself is a non-secret sizing/reference var (already documented in `docker/prod.env.example`); its *default* value changes (from `local` to a placeholder SHA, mirroring `IMAGE_TAG`'s existing `0000...0000` convention) but the variable name is unchanged. | Update `docker/prod.env.example` default + comment in the same change (D-10). |
| Build artifacts | None new. | — |

## Common Pitfalls

### Pitfall 1: The single-hop `(col AT TIME ZONE 'UTC')::date` cast is WRONG for a naive `timestamp` column (verified empirically)

**What goes wrong:** Applying the exact expression both 13-REVIEW.md's WR-06 fix suggestion and CONTEXT.md's D-01 describe — `(created_at AT TIME ZONE 'UTC')::date` — to `contacts.created_at` (a naive `timestamp`, NOT `timestamptz`) produces a day value that still depends on the READING session's `TimeZone` GUC. This is the exact class of bug the fix is supposed to close.

**Why it happens:** `naive_timestamp AT TIME ZONE 'UTC'` returns a `timestamptz` (it interprets the naive value AS a UTC instant — this part of 13-REVIEW.md's reasoning is correct). But casting a `timestamptz` to `date` in Postgres converts to the **session's current `TimeZone`** first, then truncates. A single `AT TIME ZONE 'UTC'` hop therefore lands you back in `timestamptz` land, one cast away from re-introducing session-dependence — exactly the same failure mode `analytics-reconciliation.worker.ts`'s own extensive comment warns about for `sends.*_at`, but that warning is about a DIFFERENT column type (`sends.*_at` really are `timestamptz` already, so a single `AT TIME ZONE 'UTC'` on THEM correctly converts timestamptz → naive-UTC-wall-clock, and `::date` on the result is then a pure, session-independent truncation — the two column types need opposite-direction fixes).

**How to avoid:** Use the double-hop `((col AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date` for a naive column (matches `relocate-default.ts`'s existing idiom), OR simply leave the bare `col::date` cast as-is (already session-independent for a naive column — proven below) and rely on the pool-level pin alone to close the write-side hazard. Either is correct; the single-hop form is not.

**Warning signs:** D-02's own non-UTC behavioral test (mandated by CONTEXT.md specifically because "a mere `SHOW timezone` assertion was rejected as insufficient") will fail immediately if the single-hop form is implemented — this IS the warning sign, built into the phase's own acceptance bar.

**Empirical proof** (run against a real local Postgres 17, `psql`, this research session):
```sql
CREATE TEMP TABLE tz_test (naive_col timestamp, tz_col timestamptz);
INSERT INTO tz_test VALUES ('2026-08-19 01:30:00', '2026-08-19 01:30:00+00');

SET TIME ZONE 'UTC';
SELECT naive_col::date,                                    -- 2026-08-19  (bare cast, session-independent)
       (naive_col AT TIME ZONE 'UTC')::date,                -- 2026-08-19  (single-hop, happens to match under UTC session)
       ((naive_col AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date,  -- 2026-08-19 (double-hop)
       (tz_col AT TIME ZONE 'UTC')::date                    -- 2026-08-19  (correct pattern FOR timestamptz)
FROM tz_test;

SET TIME ZONE 'America/New_York';
SELECT naive_col::date,                                    -- 2026-08-19  (bare cast: STILL correct)
       (naive_col AT TIME ZONE 'UTC')::date,                -- 2026-08-18  *** WRONG *** (single-hop breaks)
       ((naive_col AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date,  -- 2026-08-19 (double-hop: still correct)
       (tz_col AT TIME ZONE 'UTC')::date                    -- 2026-08-19  (timestamptz form: still correct)
FROM tz_test;
```
This also proves the true location of the WR-06 hazard: it is **entirely in the write path** (whatever session `TimeZone` was active when `now()` — itself a `timestamptz` — got coerced into the naive column at INSERT time). The read-side bare cast on a naive column was never actually session-dependent; the pool-level pin (D-01's other half) is what closes the real hazard. The read-site cast change is best understood as a self-documenting, defense-in-depth annotation (using the double-hop form), not as fixing an independently-exploitable read-time bug.

### Pitfall 2: `images.yml`'s existing matrix cannot be naively extended to the postgres image

**What goes wrong:** Adding `db` to `strategy.matrix.app: [api, web, worker]` produces a build step that looks for `docker/Dockerfile.db` (does not exist) built from repo-root context (wrong — the real Dockerfile is `docker/postgres/Dockerfile`, context `docker/`).

**Why it happens:** The matrix's `file:`/`context:` are hard-coded string-templated for the app-image naming convention only.

**How to avoid:** Add two small standalone jobs (`build-and-push-postgres` for `push`, `build-only-postgres` for `pull_request`) reusing the same pinned-SHA actions (`actions/checkout`, `docker/setup-buildx-action`, `docker/login-action`, `docker/build-push-action`) but with `context: docker`, `file: docker/postgres/Dockerfile`, and tag `${{ steps.image-base.outputs.base }}/postgres:${{ github.sha }}` (same SHA as the app images, per D-06).

### Pitfall 3: `POSTGRES_IMAGE_TAG`'s current `:-local` fallback becomes a silent footgun once `build:` is removed

**What goes wrong:** `docker/docker-compose.prod.yml` currently reads `image: megacrm-postgres:${POSTGRES_IMAGE_TAG:-local}` — once the `build:` section is deleted, an operator who forgets to export `POSTGRES_IMAGE_TAG` gets a `pull access denied` for a nonexistent `megacrm-postgres:local` image on a fresh host, or worse, silently reuses a STALE previously-pulled `:local` tag if one happens to exist from before this phase.

**How to avoid:** Change the image reference to the same `${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG}` shape the app images already use, and set `POSTGRES_IMAGE_TAG`'s default in `docker/prod.env.example` to the same deliberately-invalid placeholder convention `IMAGE_TAG` already uses (`0000000000000000000000000000000000000000`) — a real 40-char SHA is a hard, loud requirement, not a silent fallback.

### Pitfall 4: `deploy.sh`'s regular `compose pull api worker web` must NOT silently start pulling `db`/`pgbackrest`

**What goes wrong:** If `db`/`pgbackrest` are added to `deploy.sh`'s routine pull set, every ordinary app deploy would restart the database container — a correctness and availability risk `deploy.sh` was never designed for (its own header states `db`/`pgbackrest` restarts are a separate, checkpointed, human-gated event, not a per-deploy action).
**How to avoid:** Leave `deploy.sh`'s pull/up set untouched (`api worker web`); the D-07 cutover is a manually-invoked, one-time sequence (`docker compose pull db pgbackrest && docker compose up -d db pgbackrest`, or equivalent) documented in the runbook and executed once, live, as the operator checkpoint.

### Pitfall 5: `restore-drill.sh`'s disk sampling must not require host-level `docker volume inspect` filesystem permissions it might not have

**What goes wrong:** Reading a Docker named volume's `Mountpoint` (`docker volume inspect --format '{{ .Mountpoint }}'`) and then `du`-ing the host path directly can require elevated/root filesystem access on some hosts, depending on how the operator's shell user is set up relative to the Docker data root.
**How to avoid:** Sample disk usage via `docker exec $SCRATCH_CONTAINER_NAME du -sk /var/lib/postgresql/data` (a command already inside the container, whose filesystem the `postgres`/`gosu` user already has full access to) rather than reaching for the volume's host-side mountpoint — the script already uses `docker exec ... pg_isready` for the identical reason (container-internal check, no host-level Docker internals dependency).

## Code Examples

### Restore-drill: additive wall-clock duration + disk high-water sampling

```bash
# scripts/restore-drill.sh, inside run_real_drill(), bracketing the existing
# restore-and-wait section (between the existing "restoring backup set" echo
# and the existing "verifying the restored cluster" echo):

local restore_start restore_end duration_seconds disk_high_water_kb=0

restore_start="$(date +%s)"

# NOTE for the plan/executor: the sketch below inlines
# wait_for_scratch_ready's polling loop so disk sampling can share its
# cadence, but the ORIGINAL function has a timeout-failure branch (prints
# "READINESS TIMEOUT", calls print_cleanup_command, exit 1) that MUST be
# preserved on the `waited >= READY_TIMEOUT_SECONDS` exit path below -- this
# sketch omits it only for brevity. Recording the duration/disk figures on
# the FAILURE path too (not only on success) is worth keeping: a drill's
# resource envelope is most interesting exactly when it fails or times out.

# ... existing `docker run -d --name "$SCRATCH_CONTAINER_NAME" ...` unchanged ...

echo "restore-drill.sh: waiting for the scratch container to become ready"
# Sample disk usage concurrently with the existing readiness poll loop --
# reuses wait_for_scratch_ready's own polling cadence rather than a second
# background process, so there is exactly one place that owns "how often do
# we check."
local waited=0
while (( waited < READY_TIMEOUT_SECONDS )); do
  if docker exec "$SCRATCH_CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  local current_kb
  current_kb="$(docker exec "$SCRATCH_CONTAINER_NAME" du -sk /var/lib/postgresql/data 2>/dev/null | cut -f1)"
  if [[ -n "$current_kb" && "$current_kb" -gt "$disk_high_water_kb" ]]; then
    disk_high_water_kb="$current_kb"
  fi
  sleep "$READY_POLL_INTERVAL_SECONDS"
  waited=$(( waited + READY_POLL_INTERVAL_SECONDS ))
done

restore_end="$(date +%s)"
duration_seconds=$(( restore_end - restore_start ))

echo "restore-drill.sh: drill for target $target complete. Restore+promote duration: ${duration_seconds}s. Disk high-water (scratch PGDATA): ${disk_high_water_kb}KB."

# Self-recording (D-09): append one JSON line to a history file OUTSIDE the
# repo working tree, mirroring BASELINE_FILE's own XDG_STATE_HOME convention
# -- so every drill's figures accumulate without relying on operator memory.
METRICS_FILE="${RESTORE_DRILL_METRICS_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/mega-crm/restore-drill-history.ndjson}"
mkdir -p "$(dirname "$METRICS_FILE")"
printf '{"target":"%s","durationSeconds":%d,"diskHighWaterKb":%d,"recordedAt":"%s"}\n' \
  "$target" "$duration_seconds" "$disk_high_water_kb" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >> "$METRICS_FILE"
```

### `validate-prod-compose.mjs`: extending the immutability gate (one-line set change)

```js
// scripts/validate-prod-compose.mjs
// BEFORE:
const FIRST_PARTY_IMAGE_SERVICES = new Set(["api", "worker", "web", "migrate", "alloy"]);
// AFTER (D-05):
const FIRST_PARTY_IMAGE_SERVICES = new Set(["api", "worker", "web", "migrate", "alloy", "db", "pgbackrest"]);
```
No other code change is needed in this file — `extractImageTag`/`isMutableTag`/the mutable-tag `check(...)` call at line ~548 already iterate `FIRST_PARTY_IMAGE_SERVICES` generically. Existing negative-fixture tests under `scripts/__fixtures__/prod-compose/` that currently use `image: megacrm-postgres:local` (e.g. `pgbackrest-missing-data-volume.yml`) will need review — a `local` tag will now correctly trip the mutable-tag check too, which may require those fixtures to adopt a placeholder SHA-shaped tag to keep testing the ORIGINAL thing they were written to test (missing volume / port / mem-limit), not conflate it with a new mutable-tag failure.

### `.github/workflows/images.yml`: new postgres-image jobs (skeleton, SHA-pin the real actions from the existing file verbatim)

```yaml
  build-and-push-postgres:
    name: build-and-push (postgres)
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    steps:
      - uses: actions/checkout@<SAME SHA AS build-and-push>
      - uses: docker/setup-buildx-action@<SAME SHA>
      - uses: docker/login-action@<SAME SHA>
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Compute lowercase image base
        id: image-base
        run: echo "base=ghcr.io/$(echo '${{ github.repository }}' | tr '[:upper:]' '[:lower:]')" >> "$GITHUB_OUTPUT"
      - uses: docker/build-push-action@<SAME SHA>
        with:
          context: docker
          file: docker/postgres/Dockerfile
          push: true
          tags: ${{ steps.image-base.outputs.base }}/postgres:${{ github.sha }}

  build-only-postgres:
    name: build-only (postgres)
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<SAME SHA>
      - uses: docker/setup-buildx-action@<SAME SHA>
      - uses: docker/build-push-action@<SAME SHA>
        with:
          context: docker
          file: docker/postgres/Dockerfile
          push: false
          cache-from: type=gha,scope=postgres
          cache-to: type=gha,mode=max,scope=postgres
```
Reuse the EXACT same pinned commit SHAs already present in `images.yml`'s `build-and-push`/`build-only` jobs — do not re-resolve them; `images.yml`'s own header comment states every SHA was resolved fresh at authoring time and should be copied verbatim for a new job using the same actions.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `db`/`pgbackrest` built locally on the VPS host (`build:` in prod compose) | CI-built, GHCR-pushed, SHA-tagged, pull-only in production | This phase (D-05) | Closes T-14-58/T-14-88; brings the postgres image under the same "no unreviewed local tree in production" invariant `api`/`worker`/`web` already have. |
| Growth-chart day bucketing: bare `::date` on `contacts.created_at`, no explicit UTC anchor anywhere | Pool-level `TimeZone=UTC` pin + explicit double-hop UTC cast at the read site | This phase (D-01) | Closes WR-06; makes the UTC-day-boundary guarantee provable by a real non-UTC-session test, not merely true by accident of CI's own default. |
| Restore-drill duration/disk figures: manual, "capture at next scheduled drill" runbook placeholder | Self-recorded by the script itself, every run | This phase (D-09) | Closes T-14-73; removes the human-memory failure mode that produced the placeholder in the first place. |

**Deprecated/outdated:** None — no library version changes in this phase.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The exact stdout/record format for restore-drill's self-recorded metrics (an appended NDJSON history file under `XDG_STATE_HOME`) is a reasonable design choice, not something CONTEXT.md locks — left to planner/executor discretion per D-09/discretion list. | Restore-drill metrics, Code Examples | If the operator/runbook expects a different format (e.g., inline in `docs/runbooks/backups.md` only, no separate file), the plan should confirm the exact destination with the operator before finalizing — low risk, easily adjusted. |
| A2 | Placing the D-02 non-UTC test in `packages/db/src/__tests__/pg-timezone.test.ts` (sibling of `pg-tls.test.ts`) is correct, rather than in `apps/api/src/modules/analytics/__tests__/`. | Architecture Patterns, Pattern 3 | If the planner prefers exercising the exact HTTP-level growth-chart endpoint (not just the pool + SQL fragment), the test should live in `apps/api/src/modules/analytics/__tests__/` instead, following `dashboard.test.ts`'s existing `buildServer()`/`app.inject()` pattern. Either location satisfies D-02's substance; this is a file-placement judgment call, not a correctness question. |
| A3 | Two standalone `images.yml` jobs (rather than one workflow-level reusable-workflow split, or a wholly separate `postgres-image.yml` file) is the right shape for the CI discretion item. | Don't Hand-Roll, Pitfall 2 | If the team later wants the postgres image on a different cadence than app images (e.g., only on Dockerfile changes, via `paths:` filtering), a separate workflow file would be easier to scope independently — recorded as a revisit trigger, not a blocker for this phase (D-06 explicitly wants "same SHA, every master merge," which the same-workflow approach satisfies directly). |

## Open Questions (RESOLVED)

1. **Exact PITR target for the D-08 in-phase restore drill** *(RESOLVED in plan 17-05 Task 2 step 1 — operator picks the target from live `pgbackrest info` output immediately before the drill)*
   - What we know: `scripts/restore-drill.sh <utc-timestamp>` requires an explicit target inside the pgBackRest retention window (2 full backups, roughly two weeks per `docs/runbooks/backups.md`).
   - What's unclear: the specific timestamp to target depends on when the operator actually runs the drill during phase execution, and on production's actual backup/WAL state at that moment — not knowable at research/plan time.
   - Recommendation: the plan should direct the operator to run `pgbackrest --stanza=mega_crm info` first (as the script's own usage message already instructs) to pick a valid target immediately before the drill, rather than pre-specifying a timestamp in the plan.

2. **Whether the negative-fixture tests under `scripts/__fixtures__/prod-compose/*.yml` using `image: megacrm-postgres:local` need updating** *(RESOLVED in plan 17-03 Task 3 — fixtures reconciled with placeholder-SHA tags and the validator test suite re-run)*
   - What we know: these fixtures test OTHER invariants (missing data volume, published port, missing mem-limit) and currently use a `local` tag incidentally.
   - What's unclear: once `db` joins `FIRST_PARTY_IMAGE_SERVICES`, these fixtures will ALSO trip the (correct, expected) mutable-tag check — whether the existing fixture tests assert on a specific violation list (making an incidental second violation harmless) or an exact-match violation set (making it a test-breaking change) needs to be checked against `scripts/__tests__/validate-prod-compose.test.mjs` (or equivalent) during planning/execution, not assumed here.
   - Recommendation: planner should include a task step to run the existing prod-compose validator test suite after the `FIRST_PARTY_IMAGE_SERVICES` change and fix any fixture whose tag needs to become a placeholder SHA to keep testing its ORIGINAL intent.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Local Postgres (for research verification) | This research session's empirical proof of Pitfall 1 / Pattern 1 | ✓ | PostgreSQL (local, port 5432) | — |
| `docker` / `docker compose` | D-05 image build, D-07 cutover checkpoint, restore-drill | Not probed in this sandbox (`scripts/validate-prod-compose.mjs`'s own header states this exact sandbox has no `docker compose` subcommand) | — | The prod-compose validator already has a Docker-less fallback path (hand-rolled YAML parse); the actual image build/push/cutover/drill steps require a real Docker host — these are operator-executed checkpoints on the VPS or in GitHub Actions, not something this research/planning environment needs to run directly. |
| GitHub Actions / GHCR | D-05, D-06 | Assumed available (existing `images.yml` already builds/pushes 3 images there) | — | — |

**Missing dependencies with no fallback:** None that block planning — Docker/GHCR access is required only at execution/operator-checkpoint time, which is expected and already how Phase 14/16's equivalent checkpoints worked.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (per-workspace `vitest.config.ts`, 16 files repo-wide) `[VERIFIED]` |
| Config file | `packages/db/vitest.config.ts` (for the new pool/timezone test) |
| Quick run command | `npx vitest run --root packages/db src/__tests__/pg-timezone.test.ts` |
| Full suite command | `npm test` (repo root, per existing `ci.yml` `test` job) |

### Phase Requirements → Test Map

This phase has no mapped v1.1 requirement IDs (ROADMAP marks "Requirements: TBD (none mapped)" — it closes named tech-debt/review findings, not REQUIREMENTS.md rows). Mapping instead to CONTEXT.md's locked decisions:

| Decision | Behavior | Test Type | Automated Command | File Exists? |
|----------|----------|-----------|-------------------|-------------|
| D-01/D-02 | Naive-timestamp UTC pin survives a non-UTC database default; growth query returns correct UTC day regardless of reading session's TimeZone | integration (real Postgres) | `npx vitest run --root packages/db src/__tests__/pg-timezone.test.ts` | ❌ Wave 0 — new file |
| D-03 | Grep-audit of remaining bare `::date` casts on naive columns records verified-safe sites | manual (grep + written record in plan/SUMMARY) | `grep -rn "::date" apps/api/src apps/worker/src packages/db/src --include="*.ts"` | N/A — audit step, not a unit test |
| D-05 | `db`/`pgbackrest` rejected by `validate-prod-compose.mjs` when carrying a mutable tag | unit (existing gate + its own test suite) | existing `scripts/__tests__/*prod-compose*` suite, run after `FIRST_PARTY_IMAGE_SERVICES` change | ✅ existing suite, needs fixture review (see Open Question 2) |
| D-09 | `restore-drill.sh` emits duration + disk-usage figures on a real run | manual-only (operator-executed live drill, D-08) | `scripts/restore-drill.sh <target>` (real run, not `--dry-run`) | ❌ instrumentation is new; the underlying script's own test suite (`scripts/__tests__/restore-drill-script.test.mjs`, if it exists) should gain a unit test for the new helper functions (duration calc, disk parsing) that does NOT require Docker |

### Sampling Rate
- **Per task commit:** the new `pg-timezone.test.ts` file's own quick command above.
- **Per wave merge:** full repo `npm test`.
- **Phase gate:** full suite green before `/gsd-verify-work`; PLUS the D-07/D-08 live operator checkpoints (cannot be automated — matches Phase 14/16 precedent).

### Wave 0 Gaps
- [ ] `packages/db/src/__tests__/pg-timezone.test.ts` — new file, covers D-01/D-02.
- [ ] Any pure-logic helper extracted from `restore-drill.sh`'s new duration/disk-sampling code (if the plan chooses to make it independently unit-testable, following `stripComments`/`findBarePoolConstructions`-style exported-pure-function precedent from `lint-pg-pool-factory.mjs`) — optional, not required by CONTEXT.md.
- [ ] `scripts/__fixtures__/prod-compose/*.yml` fixtures using `megacrm-postgres:local` — review after the `FIRST_PARTY_IMAGE_SERVICES` change (Open Question 2).

## Security Domain

`security_enforcement` not found set to `false` in `.planning/config.json` context provided — treated as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No | Unchanged this phase. |
| V3 Session Management | No | Unchanged this phase. |
| V4 Access Control | No | Unchanged this phase (RLS/role posture untouched). |
| V5 Input Validation | No | No new external input surface. |
| V6 Cryptography | No | Unchanged (pgBackRest cipher config untouched). |
| V1 Architecture, Design and Threat Modeling | Yes | This phase closes three already-registered threat-model rows (T-14-58, T-14-73, T-14-88) via the existing `14-SECURITY.md` register and a `gsd-secure-phase` auditor re-run (D-12) — the standard control here IS the existing register process, not a new one. |
| V14 Configuration | Yes | Immutable-image-tag enforcement (`FIRST_PARTY_IMAGE_SERVICES`) is exactly a V14 "verify the deployed artifact matches the reviewed source" control; this phase extends an existing control to a previously-exempted service. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Host-built production image bypassing code review (T-14-58/T-14-88) | Tampering | CI-built, SHA-tagged, GHCR-pull-only — this phase's D-05/D-06 fix, extending the pattern `api`/`worker`/`web` already use. |
| Day-boundary/analytics-integrity drift from timezone misconfiguration (WR-06) | Tampering (data integrity) / Information Disclosure (misleading business metrics) | UTC pin at the connection-pool layer + explicit UTC-anchored read-site casts, proven by a real non-UTC-session behavioral test — this phase's D-01/D-02 fix. |
| Unrecorded/unverified restore-drill capacity figures (T-14-73) | Repudiation (no evidence the drill's resource envelope is known) | Self-recorded, machine-written duration/disk metrics on every drill run, removing reliance on operator memory — this phase's D-09 fix. |

## Sources

### Primary (HIGH confidence — direct code/dependency inspection or live empirical test, this session)
- `packages/db/src/pool.ts` — read in full; `createPgPool`, `PG_POOL_SIZES`, `assertDsnRequestsTls`.
- `apps/api/src/modules/analytics/dashboard.repository.ts` — read in full; exact growth/baseline queries.
- `apps/worker/src/queues/analytics-reconciliation.worker.ts` — read; the `sends.*_at` (`timestamptz`) single-hop UTC pattern and its rationale comment.
- `packages/db/src/partitions/relocate-default.ts` — grepped; the existing double-hop `AT TIME ZONE 'UTC'` idiom for a naive column.
- `packages/db/src/schema/contacts.ts`, `sends.ts` — read; confirmed `contacts.created_at` is naive `timestamp`, `sends.*_at` are `timestamptz`.
- `scripts/lint-pg-pool-factory.mjs` — read in full; confirmed `__tests__`/`test`/`__fixtures__` dirs and `packages/test-support` are exempt from the bare-`new Pool()` gate.
- `packages/test-support/src/provision-db.ts` — read in full; confirmed all ephemeral test DBs share one Postgres cluster (`DEFAULT_ADMIN_DSN`).
- `packages/db/src/__tests__/pg-tls.test.ts` — read in full; the direct structural precedent for the new D-02 test.
- `scripts/validate-prod-compose.mjs` — read the `FIRST_PARTY_IMAGE_SERVICES`/`MUTABLE_TAG_NAMES`/mutable-tag-check sections.
- `docker/docker-compose.prod.yml` — read the `db`/`pgbackrest`/`redis` service blocks in full.
- `docker-compose.yml` (dev) — grepped; confirmed dev never references `megacrm-postgres` (uses plain `postgres:17`).
- `.github/workflows/images.yml` — read the `build-and-push`/`build-only` jobs in full.
- `scripts/deploy.sh` — grepped the `compose pull`/image-related lines.
- `scripts/restore-drill.sh` — read in full (all 402 lines); exact `run_real_drill` structure, `du`-friendly container-exec pattern precedent (`pg_isready`).
- `docker/prod.env.example` — grepped `GHCR_IMAGE_BASE`/`IMAGE_TAG`/`POSTGRES_IMAGE_TAG` lines.
- `.planning/phases/14-deployment-database-durability/14-SECURITY.md` — read T-14-58/T-14-73/T-14-88 rows verbatim.
- `.planning/phases/13-compliance-analytics-integrity/13-REVIEW.md` — read WR-06 section verbatim.
- `docs/runbooks/backups.md` — read the forward-flag section (lines ~255-290).
- Empirical test against a live local PostgreSQL 17 instance (this session, via `psql`) — proved the single-hop vs. double-hop vs. bare-cast timezone-casting behavior described in Pitfall 1.
- Empirical test against the actual installed `pg@8.22.0` via a live local Postgres connection (this session, via `node -e`) — proved `options: '-c TimeZone=UTC'` correctly pins `SHOW TimeZone` to `UTC`.

### Secondary (MEDIUM confidence)
- [brianc/node-postgres issue #3265](https://github.com/brianc/node-postgres/issues/3265) — "Timezone not set on pool event 'connect'" — documents the race condition in the `pool.on('connect', ...)` SET-based alternative; fetched and summarized this session.

### Tertiary (LOW confidence)
- None used as a basis for any recommendation in this document — every claim above is either primary (direct inspection/empirical test) or secondary (a specific, fetched, first-party GitHub issue).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; all versions confirmed against `package.json`/`node_modules`.
- Architecture: HIGH — every pattern is either an already-existing repo idiom (relocate-default.ts, pg-tls.test.ts, images.yml's job shape) or empirically verified against a live Postgres/pg driver this session.
- Pitfalls: HIGH — Pitfall 1 (the central finding) is empirically proven with reproducible SQL, not inferred from documentation.

**Research date:** 2026-08-19
**Valid until:** 60 days (infra/config-only phase against a stable, already-installed stack; no fast-moving dependency surface) — but note this phase's own scope is one-time closure of named tech debt, not an ongoing capability, so "staleness" mostly means "re-verify the exact `pg`/Postgres versions if this research is reused for an unrelated future phase."
