# Phase 10: Tenant Isolation & Trust Boundaries - Research

**Researched:** 2026-08-07
**Domain:** PostgreSQL Row-Level Security, least-privilege role separation, Better Auth trust boundaries, API-key/webhook hardening, Fastify security middleware
**Confidence:** HIGH (grounded in direct repo inspection + a live Postgres 17.10 reproduction of the two load-bearing RLS claims below — not training-data guesses)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**SEC-01 ADR — Scan-role connection shape**
- **D-01:** Separate pool + dedicated login credential. New login role (e.g. `mega_crm_scan`) — `NOBYPASSRLS`, owns no tables, minimal per-table grants — with its own DSN env variable present **only in the worker's env schema**. The API's env schema simply lacks the variable, which is itself part of the P3 proof ("API process holds neither the role's credentials nor membership"). `SET LOCAL ROLE` on the existing pool was rejected: it requires `GRANT scan TO mega_crm_app`, and the API connects as that same login role — P3's negative test would be unsatisfiable. Reversibility: costly.
- **D-02:** One shared `withCrossWorkspaceScan`-style helper in `packages/tenant-context`, next to `withTenantTransaction` — the single audited entry point for cross-tenant reads. Scan pool is lazily initialized from the worker-only env var, so API processes importing the package never construct it. All five consumers (campaign-scheduler, flow-segment-sweep, flow-reconciliation, partition maintenance/relocation, analytics-reconciliation) go through this helper; Phases 11/12 adopt the same entry point. Reversibility: costly.
- **D-03:** GUC-keyed scan policies (0018/0027/0032/0039) are replaced by role-scoped policies (`TO <scan role>`); role-scoping and predicate-narrowing of the previously predicate-free 0027/0032 policies are complementary — both must land. Exact predicates per table follow from what each consumer actually reads.

**SEC-05 ADR — Better Auth trust boundary**
- **D-04:** Dedicated `mega_crm_auth` login role + grant partitioning. Better Auth's `drizzleAdapter` pool gets its own DSN connecting as `mega_crm_auth`. Secret-bearing tables (`session`, `account`, `verification`) become reachable only by the auth role; `mega_crm_app` keeps read grants on the workspace-shaped tables (`organization`, `member`, `invitation`, `user`) that membership resolution and the tenancy modules genuinely query. Rejected alternatives (must be named in the ADR): RLS on auth tables (Better Auth sets no GUC — policies could only key on role, and Pitfall 12's silent-zero-rows login breakage), and an `auth.*` schema move (every tenant table FKs `organization(id)` — highest-risk migration for the same end state). Reversibility: one-way — grant revocations ship as forward-only migrations; the auth-flow e2e suite is the acceptance gate.
- **D-05:** Grant-matrix principle: write grants default to the auth role; `mega_crm_app` keeps only what live query sites prove it needs. Planner determines the per-table matrix from actual query sites in the tenancy modules.

**API key scopes (R4)**
- **D-06:** Taxonomy is `resource:action` pairs: `contacts:read`, `contacts:write`, `events:write` — covering the two API-key-authenticated route modules that exist today. Set-membership check per route; future routes add scopes to the vocabulary.
- **D-07:** Migration backfills all existing keys with the full scope set in the same change that starts enforcement — zero tenant breakage. New keys default to the full set at creation (no scope-picker UI in this phase — deferred). Reversibility: reversible.

**Redaction module (R9)**
- **D-08:** Hybrid rule source in a new small shared package (e.g. `packages/redaction`; follows the Phase 8 `packages/test-support` precedent — mandatory `SPECIFICATION.md` §2 entry). One rule table (key patterns + value regexes for SendGrid keys, auth secrets, email, phone) compiled two ways: (a) pino `redact.paths` for the API's hot path, (b) a recursive `scrub(value)` function with unlimited depth for freeform JSONB. The nested-JSONB backstop test passes by construction via the recursive form.
- **D-09:** Worker consumption now = wrapping its existing `console.log/error` surface with `scrub()`; Phase 15's worker-Pino rebuild and Sentry `beforeSend` reuse the same module.
- **D-10:** Codebase correction: `apps/api/src/logger.ts` already has a pino `redact` config (field paths for `sendgridKey`/`apiKey`/`password`/`token`, wildcards 2 levels deep). R9's work is centralizing it, adding PII + value-pattern coverage, unlimited depth, and worker consumption — the existing path list is absorbed into the shared rule table, not duplicated.

### Claude's Discretion

- Exact role names (`mega_crm_scan`, `mega_crm_auth`), env-variable names for the two new DSNs, and where role creation lives (migration vs `docker/init-app-role.sql` extension — note the init script only runs on first volume init).
- Per-table grant matrices for both new roles (derive from actual query sites; principle in D-03/D-05).
- Mechanism of the CI bare-`SET`/`SET ROLE` audit (ESLint rule vs standalone script) — must fail on a violating fixture per R11.
- Name/location of the redaction package and the worker's console-wrapper shape.
- Webhook rate-limit bucket sizing; Redis-backed store wiring details for `@fastify/rate-limit`.
- Shape of the parameterized anti-enumeration sweep test and the negative cross-tenant suite structure.

### Deferred Ideas (OUT OF SCOPE)

- Scope-picker UI at API-key creation (narrow scopes per key in the management UI) — R4 requires enforcement only; UI belongs to a future phase. New keys default to the full scope set until then.
- Splitting worker/API login roles for tenant-path access (beyond the scan role) — cleanest long-term identity separation, rejected as out of proportion for R2; revisit if Phase 14's pooling work touches connection identity anyway.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SEC-01 | Cross-tenant scanning runs via dedicated least-privilege DB role instead of session flag | § Architecture Patterns "Scan role"; § Common Pitfalls #1–3; verified live-Postgres proof that `TO <role>` scoping (not GUC gating) is the only deterministic isolation mechanism |
| SEC-02 | Cross-tenant scanning cannot be enabled from ordinary API — proven by test | § Architecture Patterns "Scan role"; D-01's env-schema-absence proof; § Code Examples |
| SEC-03 | RLS policies unified in fail-closed direction | § Common Pitfalls #1 (the load-bearing correction: bare-cast alone is *not* sufficient — `missing_ok` must also be dropped); full 22-table inventory below |
| SEC-04 | Query without tenant context errors, not zero rows — proven by test | Same as SEC-03; existing pinned baseline test at `packages/tenant-context/src/__tests__/tenant-context.test.ts` documents exactly what must invert |
| SEC-05 | Better Auth trust boundary defined and implemented | § Architecture Patterns "Auth role"; § Existing Code Insights (auth.ts, schema/auth.ts, packages/db/src/index.ts) |
| SEC-06 | API key scopes enforced per route or removed | § Existing Code Insights (api-key-auth.ts, api-keys schema); § Code Examples |
| SEC-07 | Webhook rejects stale timestamp | § Existing Code Insights (signature-verify.ts, webhooks.routes.ts); § Common Pitfalls #6 (two distinct timestamps) |
| SEC-08 | Webhook has its own rate limit | § Standard Stack (`@fastify/rate-limit` 11.1.0 already installed, Redis store support confirmed in local node_modules) |
| SEC-09 | Sibling-workspace events dropped under shared BYO key | § Common Pitfalls #4 (verified architectural dependency: R6 needs the scan role from R2 to distinguish "send_id doesn't exist" from "send_id belongs to a sibling workspace") |
| SEC-10 | Invite endpoint minimal data, identical response for existing/nonexistent | § Existing Code Insights (invites.ts current behavior); § Open Questions #1 |
| SEC-11 | Distributed API rate limit correct across replicas | § Standard Stack; `ioredis` 5.11.0 already a dependency of apps/api |
| SEC-12 | `BETTER_AUTH_SECRET` production length floor | § Existing Code Insights (env.ts currently `min(16)`, needs `min(32)` gated on `NODE_ENV=production`) |
| SEC-13 | Redaction centralized, covers API and worker | § Existing Code Insights (logger.ts's existing redact config); § Common Pitfalls #7 |
| SEC-14 | Single `resolveWorkspaceMember` | § Existing Code Insights (`getCallerRoles` + 9 duplicated 404-mapping blocks) |
| SEC-15 | Anti-enumeration identical everywhere | Same as SEC-10 |
| SEC-16 | Negative cross-tenant tests cover API + background jobs; bare-`SET`/`SET ROLE` audited in CI | § Common Pitfalls #8; § Validation Architecture |
</phase_requirements>

## Summary

This phase closes the gap between "RLS exists" and "RLS is the actual trust boundary." Two claims in the phase's own CONTEXT/SPEC needed verification against live Postgres before planning could proceed safely, and both changed what "the fix" actually is:

1. **"Unify to bare-cast" is not the same as "fail-closed."** The 12 tables already using the bare-cast form (`current_setting('app.current_workspace_id', true)::uuid`) do **not** throw on a connection where the GUC has never been touched at all — they silently return zero rows (`current_setting(key, true)` returns `NULL` when the placeholder GUC doesn't exist yet in that backend, and `NULL::uuid = anything` is `NULL`, which RLS treats as "no match," not an error). This is precisely what the codebase's own pinned "PRE-PHASE-10 baseline" test at `packages/tenant-context/src/__tests__/tenant-context.test.ts` (lines 164–197) documents and flags for this phase to move. Verified live: `current_setting('app.x', true)` → `NULL` (no error) on an untouched GUC; only removing the `missing_ok` argument entirely — `current_setting('app.current_workspace_id')::uuid` with **no second argument and no `NULLIF`** — makes *both* the never-touched case (`unrecognized configuration parameter`) and the reverted-to-`''` case (`invalid input syntax for type uuid`) throw. **The unification target for all 22 tenant tables is this bare, no-`missing_ok` form — not "keep the 12 as-is and just fix the 10 NULLIF ones."**

2. **Unscoped (`PUBLIC`) policies are unsafe once a second role exists, and the codebase already has a production incident (migration 0019) proving it.** None of the 22 `workspace_isolation` policies today carry a `TO <role>` clause, so they apply to every role including the forthcoming `mega_crm_scan` and `mega_crm_auth`. Verified live: when `workspace_isolation` is explicitly scoped `TO mega_crm_app`, Postgres excludes it entirely from a scan-role query's plan (deterministic, decided by role membership at query-rewrite time — no per-row evaluation, no short-circuit gamble). Every new/updated tenant policy in SEC-03 **and** every new scan-role policy in SEC-01/02 must carry an explicit `TO` clause, or the OR-combined-permissive-policies bug that produced migration 0019 recurs one layer up.

Beyond these two corrections, the rest of the phase is architecturally straightforward: a new login role per new trust boundary (scan, auth), grants instead of magic GUCs, one shared helper per capability, and negative tests that assert the specific Postgres error class rather than row counts. One genuinely cross-cutting dependency worth flagging up front: **SEC-09 (sibling-workspace webhook drop) cannot be built with tenant-scoped queries alone** — under RLS, "this `send_id` doesn't exist" and "this `send_id` exists in a sibling workspace" are indistinguishable from inside `withTenant(receivingWorkspaceId, ...)`. R6 needs a narrow, id-only cross-tenant lookup through the exact scan-role helper R2 builds — sequencing R2's helper before or alongside R6 is not optional.

No new external packages are required for this phase. `@fastify/rate-limit` (11.1.0) and `ioredis` (5.11.0) — both already dependencies of `apps/api` — already support everything SEC-08/SEC-11 need (Redis-backed store, `skipOnError`).

**Primary recommendation:** Treat SEC-03's RLS rewrite as one migration that touches all 22 tenant tables uniformly (drop `NULLIF` *and* drop `missing_ok`, add explicit `TO mega_crm_app`), land it before or together with the scan-role rollout (also `TO`-scoped), and build the scan-role helper (D-02) before touching SEC-09's sibling-drop logic.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Tenant row isolation (SEC-03/04) | Database / Storage | — | RLS policies are the enforcement mechanism by design; no other tier can substitute |
| Cross-tenant background scans (SEC-01/02) | Database / Storage | API/Backend (worker process identity) | Enforcement is DB-role-based; the worker process is merely the credential holder |
| Better Auth trust boundary (SEC-05) | Database / Storage | API/Backend (drizzleAdapter pool wiring) | Grant partitioning is a DB-level control; the pool selection is app-layer wiring around it |
| API key scopes (SEC-06) | API/Backend | — | Scope check is a request-time authorization decision in the Fastify hook layer |
| Webhook replay window + rate limit (SEC-07/08) | API/Backend | CDN/Static (none — no CDN in this project) | Signature/timestamp validation and rate limiting are HTTP-ingress concerns |
| Sibling-workspace event drop (SEC-09) | API/Backend (worker) | Database / Storage (scan-role lookup) | Decision logic lives in the worker; the underlying "which workspace owns this send_id" fact is DB-resident and requires the scan role |
| Anti-enumeration (SEC-10/15) | API/Backend | — | Response-shape uniformity is a route-handler concern |
| Distributed rate limit (SEC-11) | API/Backend | Database / Storage (Redis, not Postgres) | `@fastify/rate-limit`'s Redis store is the coordination point across replicas |
| Redaction (SEC-13) | API/Backend | — (worker consumes the same shared package) | Log-shaping happens at the point of emission in both processes |
| `resolveWorkspaceMember` (SEC-14) | API/Backend | — | Membership resolution is a request-time authorization concern, currently duplicated across route modules |
| Bare-`SET` CI audit (SEC-16) | CDN/Static (CI pipeline, closest available tier) | — | Static analysis over source, not a runtime tier — included here only because the output format requires an assignment |

## Standard Stack

### Core

No new runtime dependencies are required. Everything this phase needs is already installed:

| Library | Version (installed) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@fastify/rate-limit` | 11.1.0 `[VERIFIED: local node_modules + apps/api/package.json]` | Redis-backed distributed rate limiting (SEC-08/SEC-11) | Already in use with `global: false`; its README (present locally) documents a `redis: new Redis(...)` (ioredis instance) option plus `skipOnError` — exactly the fail-open-with-log shape SEC-11 needs |
| `ioredis` | 5.11.0 `[VERIFIED: local node_modules + apps/api/package.json]` | Redis client backing both BullMQ and the new rate-limit store | Already a dependency of `apps/api`; no new client library needed |
| `pg` | 8.22.0 `[VERIFIED: local node_modules]` | Postgres driver for the two new dedicated pools (scan, auth) | Already the project's sole Postgres driver — no alternative needed for two more `Pool` instances |
| `better-auth` | 1.6.23 `[VERIFIED: local node_modules]` | Auth/org/invite backbone whose Drizzle adapter pool is being re-pointed at the new `mega_crm_auth` role | Existing dependency; SEC-05 changes wiring, not the library |
| `drizzle-orm` | 0.45.2 `[VERIFIED: local node_modules]` | ORM for the auth-role Drizzle client | Existing dependency |
| `pino` | (per CLAUDE.md stack; already wired in `apps/api/src/logger.ts`) | Structured logging whose `redact.paths` config SEC-13 centralizes | Existing dependency; SEC-13 restructures configuration, not the library |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Node built-in `node:crypto` (`timingSafeEqual`, `createHash`) | — | Continuity for API-key hash comparison (unchanged by SEC-06) | Already used in `api-key-auth.ts`; scope check is additive, not a replacement of the auth mechanism |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@fastify/rate-limit`'s built-in Redis store | A hand-rolled `rate-limiter-flexible` token bucket (already a CLAUDE.md-recommended pattern for the *send pipeline's* per-tenant RPS) | `rate-limiter-flexible` is the right tool for per-tenant SendGrid RPS throttling (Phase 12 concern) but is the wrong tool here — SEC-08/11 are about *API request* rate limiting across replicas, which `@fastify/rate-limit`'s native Redis store already solves with zero new code |
| Separate pool + dedicated credential (D-01, locked) | `SET LOCAL ROLE mega_crm_scan` on the existing tenant pool | Rejected in CONTEXT — requires `GRANT mega_crm_scan TO mega_crm_app`, which means the app role always has latent membership in the scan role, making P3's "API process holds neither credentials nor membership" negative test unsatisfiable |
| Bare-cast-no-`missing_ok` RLS unification (this research's correction) | Leave the 12 already-bare-cast tables untouched, only fix the 10 NULLIF ones | Insufficient — as verified above, today's bare-cast form still returns zero rows (not an error) for a genuinely untouched GUC, which fails SEC-04's literal acceptance criterion ("GUC unset... raises a Postgres error") |

**Installation:** none required — no `npm install` step for this phase.

**Version verification:** All versions above were read directly from `node_modules/*/package.json` in the working tree (`[VERIFIED: local node_modules]`), not from the registry or training data, since every package is already installed and pinned in `package.json`.

## Package Legitimacy Audit

No new external packages are introduced by this phase. The Package Legitimacy Gate does not apply — every library referenced above is an existing, already-audited dependency of `apps/api`/`apps/worker`. The only new *code artifact* is an internal workspace package (`packages/redaction` or similar, per D-08), which is source the team writes, not a third-party install, and therefore carries no registry-legitimacy risk.

**Packages removed due to [SLOP] verdict:** none (no new packages).
**Packages flagged as suspicious [SUS]:** none (no new packages).

## Architecture Patterns

### System Architecture Diagram

```
                      ┌─────────────────────────────────────────────┐
                      │              apps/api (Fastify)              │
                      │                                               │
  HTTP request ──────▶│  onRequest: apiKeyAuth OR session cookie      │
                      │       │                                       │
                      │       ▼                                       │
                      │  resolveWorkspaceMember() ── SEC-14 ──┐        │
                      │       │                               │        │
                      │       ▼                               ▼        │
                      │  route handler ──▶ withTenantTransaction()    │
                      │       │                    │  (mega_crm_app,   │
                      │       │                    │   SET LOCAL GUC,  │
                      │       │                    │   TO-scoped RLS)  │
                      │       │                    ▼                   │
                      │       │              ┌───────────┐             │
                      │       │              │ Postgres  │             │
                      │       │              │ (tenant    │             │
                      │       │              │  tables)   │             │
                      │       │              └───────────┘             │
                      │       │                                        │
                      │  webhook route (no session) ──▶ signature +    │
                      │       timestamp-window check (SEC-07) ──▶      │
                      │       independent rate-limit bucket (SEC-08)   │
                      │       ──▶ enqueue raw batch (unchanged)        │
                      │                                                │
                      │  auth routes (/api/auth/*) ──▶ Better Auth     │
                      │       │           drizzleAdapter               │
                      │       ▼                                        │
                      │  ┌───────────────────┐                         │
                      │  │ mega_crm_auth pool │── SEC-05 ──▶ Postgres  │
                      │  │ (own DSN, own      │            (session/   │
                      │  │  login role)       │             account/   │
                      │  └───────────────────┘             verification│
                      │                                     — auth-role │
                      │                                     -only;      │
                      │                                     organization│
                      │                                     /member/    │
                      │                                     invitation/ │
                      │                                     user stay   │
                      │                                     mega_crm_app│
                      │                                     -readable)  │
                      │                                                │
                      │  env schema: NO scan DSN present here (P3)     │
                      └─────────────────────────────────────────────┘

                      ┌─────────────────────────────────────────────┐
                      │             apps/worker (BullMQ)              │
                      │                                               │
                      │  campaign-scheduler / flow-segment-sweep /    │
                      │  flow-reconciliation / partition-maintenance  │
                      │  (ensurePartitions, relocate-default-rows) /  │
                      │  analytics-reconciliation                      │
                      │       │                                        │
                      │       ▼                                        │
                      │  withCrossWorkspaceScan()  ── SEC-01/02/D-02 ─┐│
                      │       │  (lazy pool from worker-only          ││
                      │       │   SCAN DSN env var, mega_crm_scan     ││
                      │       │   login role, NOBYPASSRLS, owns no    ││
                      │       │   tables)                             ││
                      │       ▼                                        │
                      │  ┌───────────┐                                 │
                      │  │ Postgres  │◀── role-scoped policies         │
                      │  │ (scan-    │    (TO mega_crm_scan, no GUC)   │
                      │  │  visible  │                                 │
                      │  │  tables)  │                                 │
                      │  └───────────┘                                 │
                      │       │                                        │
                      │       ▼ (candidate ids only, id+workspace_id)  │
                      │  per-row withTenant(workspaceId) re-entry ──▶  │
                      │       normal tenant-scoped write path           │
                      │                                                │
                      │  webhook-events.worker.ts:                     │
                      │    withTenant(receivingWorkspaceId) insert     │
                      │    loop ── SEC-09 ──▶ before insert, resolve   │
                      │    candidate send_id's TRUE workspace via      │
                      │    withCrossWorkspaceScan() (id + workspace_id │
                      │    only, no payload) ── if truthy AND ≠        │
                      │    receivingWorkspaceId ──▶ DROP (count+log,   │
                      │    no payload) ── else ──▶ normal insert path  │
                      └─────────────────────────────────────────────┘
```

### Recommended Project Structure

```
packages/tenant-context/src/
├── index.ts                 # existing: pool, withTenant, withTenantTransaction
├── scan.ts                  # NEW: withCrossWorkspaceScan() (D-02), lazy scan pool
└── __tests__/
    ├── tenant-context.test.ts   # existing — its "PRE-PHASE-10 baseline" describe
    │                             #   block's two assertions get inverted here
    └── scan.test.ts             # NEW: P2/P3 negative tests

packages/redaction/            # NEW package (D-08), name at planner's discretion
├── src/
│   ├── rules.ts              # shared rule table (key patterns + value regexes)
│   ├── pino-redact.ts        # compiles rules → pino redact.paths
│   ├── scrub.ts              # recursive scrub(value) for JSONB/worker console
│   └── __tests__/
├── package.json
└── SPECIFICATION.md entry required (§2)

packages/db/migrations/
├── 00XX_workspace_isolation_bare_cast_unification.sql   # SEC-03, all 22 tables, TO mega_crm_app
├── 00XX_scan_role_grants.sql                            # SEC-01/02, GRANTs only (role itself NOT here — see Pitfall 5)
├── 00XX_scan_role_policies.sql                          # SEC-01/02, replaces 0018/0027/0032/0039 GUC policies
├── 00XX_auth_role_grants.sql                            # SEC-05, GRANTs only
├── 00XX_api_key_scopes_backfill.sql                     # SEC-06/D-07
└── ...

docker/init-app-role.sql      # EXTEND: CREATE ROLE mega_crm_scan / mega_crm_auth
                                #   (superuser-only step — see Pitfall 5)

apps/worker/src/
├── env.ts                     # NEW or extended ad-hoc checks: SCAN_DATABASE_URL required
└── queues/
    ├── campaign-scheduler.worker.ts        # swap pool.connect()+SET admin_scan → withCrossWorkspaceScan()
    ├── flows/flow-segment-sweep.worker.ts   # same
    ├── flows/flow-reconciliation.worker.ts  # same
    ├── analytics-reconciliation.worker.ts   # same (currently bare SELECT id FROM organization)
    └── webhook-events.worker.ts             # SEC-09: add sibling-workspace resolution before insert

packages/db/src/partitions/
├── ensure-partitions.ts        # attachPartitionCheckFirst: swap SET admin_scan → withCrossWorkspaceScan-provided client
└── scripts/relocate-default-partition-rows.ts  # same

apps/api/src/
├── env.ts                      # AUTH_DATABASE_URL added; SCAN DSN deliberately absent (P3)
├── modules/auth/auth.ts         # drizzleAdapter(authDb) instead of drizzleAdapter(db)
├── modules/tenancy/
│   ├── resolve-workspace-member.ts   # NEW: SEC-14, replaces ~9 duplicated blocks
│   └── member-roles.ts               # existing getCallerRoles — becomes an implementation detail of the above
├── modules/api-keys/api-key-auth.ts  # add scope parameter/decorator, SEC-06
├── modules/webhooks/
│   ├── signature-verify.ts     # add timestamp-window check, SEC-07
│   └── webhooks.routes.ts       # independent rate-limit bucket, SEC-08
└── server.ts                    # Redis-backed rate-limit store wiring, SEC-11
```

### Pattern 1: The unified fail-closed RLS predicate

**What:** Every tenant-scoped `workspace_isolation` policy uses the SAME bare, no-`missing_ok`, `TO`-scoped form.
**When to use:** All 22 current tenant tables (12 currently bare-cast-with-`missing_ok`, 10 currently NULLIF-guarded), plus every future tenant table.
**Verified locally** (Postgres 17.10, throwaway instance, `packages/db`'s exact GUC name and cast pattern):

```sql
-- Source: this research session — reproduced against a scratch Postgres 17.10
-- instance using this project's own GUC name and cast pattern.

-- OLD (12 tables) — returns zero rows (NOT an error) on a genuinely untouched
-- connection, because current_setting(key, true) returns NULL rather than
-- raising, and NULL::uuid = anything is NULL (excluded, not erroring):
--   workspace_id = current_setting('app.current_workspace_id', true)::uuid

-- OLD (10 tables) — same NULL-safe gap, PLUS silently excludes rows instead
-- of erroring on a recycled connection where the GUC reverted to '':
--   workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid

-- NEW (all 22 tables) — throws in BOTH cases:
--   * never touched:  ERROR: unrecognized configuration parameter "app.current_workspace_id"
--   * reverted to '': ERROR: invalid input syntax for type uuid: ""
ALTER POLICY workspace_isolation ON <table> TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);
```

The `TO mega_crm_app` clause is not cosmetic — see Pitfall 2 below for why it is required for this exact change to be safe once `mega_crm_scan`/`mega_crm_auth` exist.

### Pattern 2: Role-scoped, GUC-free scan policy

**What:** Cross-tenant discovery scans get their own permissive policy scoped `TO <scan role>`, with zero dependency on any session GUC.
**When to use:** Replaces migrations 0018 (`campaign_scheduler_due_scan`), 0027 (`flow_runs_due_scan`), 0032 (`flows_segment_sweep_scan`), 0039 (`partition_relocation_admin_scan` ×2), and the as-yet-unmigrated `attachPartitionCheckFirst` GUC touchpoint.

```sql
-- Source: derived from this project's own 0018/0027/0032/0039 precedent
-- (all four currently GUC-gated), rewritten role-scoped per D-03. Predicate
-- narrowing (Pitfall 3) is preserved from the ORIGINAL intent of each
-- consumer, not dropped just because the role scoping now does the
-- access-control work the GUC used to do.
CREATE POLICY campaign_scheduler_due_scan ON campaigns
  FOR SELECT TO mega_crm_scan
  USING (status = 'scheduled' AND scheduled_at <= now());

CREATE POLICY flow_runs_due_scan ON flow_runs
  FOR SELECT TO mega_crm_scan
  USING (status = 'waiting' AND next_wake_at <= now());

CREATE POLICY flows_segment_sweep_scan ON flows
  FOR SELECT TO mega_crm_scan
  USING (status = 'live' AND trigger_type = 'segment');

-- contacts/sends: partition-relocation needs unrestricted read (it cannot
-- predict which rows a DEFAULT-partition backlog references) -- this is
-- also the predicate SEC-09's sibling-workspace lookup on `sends` needs
-- (see Common Pitfalls #4), so one broad policy per table serves both
-- consumers rather than adding a second one.
CREATE POLICY scan_visibility ON contacts FOR SELECT TO mega_crm_scan USING (true);
CREATE POLICY scan_visibility ON sends FOR SELECT TO mega_crm_scan USING (true);
```

**Verified locally:** a query run as `scan_role` against a table carrying BOTH an unscoped, always-erroring `app_role`-shaped policy AND a `TO scan_role` policy sometimes succeeded and sometimes would not have, depending on plan shape — this is exactly the ambiguity migration 0019's own comment describes as a real production bug. Adding the explicit `TO scan_role` clause to the app-role's own policy removed the ambiguity entirely (confirmed: the scan-role query's plan never references the app-scoped policy at all once it carries a `TO` clause). Do not rely on OR short-circuiting for this security boundary.

### Pattern 3: One audited cross-tenant helper (D-02)

**What:** `withCrossWorkspaceScan(fn)` — mirrors `withTenantTransaction`'s shape exactly (BEGIN → run → COMMIT/ROLLBACK → release-with-error), but connects through a **separate, lazily-constructed pool** built from a worker-only env var, and never touches `app.current_workspace_id`.

```typescript
// Source: modeled directly on packages/tenant-context/src/index.ts's
// existing withTenantTransaction — same release-with-error discipline,
// same "throws if misused" posture, deliberately NO AsyncLocalStorage
// context (there is no "current cross-tenant scope" to leak across
// concurrent scans the way workspaceId could).
import { Pool } from "pg";
import type { PoolClient } from "pg";

let scanPool: Pool | undefined;

function getScanPool(): Pool {
  const dsn = process.env.SCAN_DATABASE_URL; // worker-only; absent in apps/api's env schema (P3)
  if (!dsn) {
    throw new Error(
      "SCAN_DATABASE_URL is required to run a cross-workspace scan -- this " +
      "process's env schema does not declare it if it should never run scans"
    );
  }
  if (!scanPool) {
    scanPool = new Pool({ connectionString: dsn });
    scanPool.on("error", (err) => {
      console.error("idle scan pool client error (connection dropped)", err);
    });
  }
  return scanPool;
}

export async function withCrossWorkspaceScan<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getScanPool().connect();
  let releaseWithError: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      releaseWithError = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.release(releaseWithError);
  }
}
```

Because `getScanPool()` reads `process.env.SCAN_DATABASE_URL` lazily (only on first call), importing `packages/tenant-context` from `apps/api` never constructs a scan pool — the constant is simply absent from the API's Zod-validated env schema, and the API process never calls `withCrossWorkspaceScan` at all (P3's negative test asserts both: the env var is absent from `apps/api/src/env.ts`'s schema, AND no route/module under `apps/api/src` imports `withCrossWorkspaceScan`).

### Anti-Patterns to Avoid

- **Standardizing on `NULLIF` "because it looks safer":** it is fail-*open* — a table using it silently returns zero rows instead of erroring, which every one of the 22 tenant tables must NOT do after this phase (Pitfall 1 / SEC-03's own explicit prohibition P2).
- **Leaving any `workspace_isolation`-shaped policy unscoped (`PUBLIC`):** once `mega_crm_scan`/`mega_crm_auth` exist, an unscoped policy is evaluated for their queries too, reintroducing the exact OR-combined-permissive-policy bug migration 0019 already fixed once (Pitfall 2).
- **Copy-pasting `workspace_isolation`-style RLS onto Better Auth tables:** `organization` has no `workspace_id` column, and Better Auth's own drizzleAdapter pool never sets any GUC — a naive policy either fails to compile or silently returns zero rows platform-wide on login (explicitly forbidden by CONTEXT D-04/Pitfall 12).
- **Running `CREATE ROLE` inside a numbered migration:** `mega_crm_app` is `NOCREATEROLE` (see `docker/init-app-role.sql`) — a migration applied as `mega_crm_app` (as CI and `test-support` both do) cannot create a role. Role creation is a superuser-only, cluster-level step (Pitfall 5).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Distributed API rate limiting | A custom Redis `INCR`/`EXPIRE` limiter for SEC-08/SEC-11 | `@fastify/rate-limit`'s built-in `redis` option (ioredis instance) | Already installed, already handles sliding windows, `skipOnError`, and per-route buckets — a hand-rolled version would just re-implement this with more surface for off-by-one bugs |
| ECDSA webhook signature parsing | Anything touching the DER/ASN.1 shape of SendGrid's public key | `@sendgrid/eventwebhook`'s `EventWebhook` class (already wired in `signature-verify.ts`) | Unchanged by this phase — SEC-07 only adds a timestamp-age check alongside the existing signature check, never re-implements the signature verification itself |
| Secret redaction regex library | A bespoke deep-object walker for JSONB redaction | The recursive `scrub()` function per D-08 — still hand-written, but as ONE audited implementation shared by both consumers rather than two independent guesses | Not a "don't build" in the sense of "use a library" (no mature npm package fits pino's `redact.paths` + a freeform recursive scrubber cleanly), but the phase's own design (D-08) already prevents duplication — do not let the worker grow a second, drifted implementation |
| Membership/authorization resolution | A bespoke membership cache/lookup layer for `resolveWorkspaceMember` | Better Auth's existing `auth.api.getActiveMemberRole` (already the mechanism `getCallerRoles` wraps) | The unification (SEC-14) is about collapsing ~9 copies of the SAME wrapper around this call into one — not about replacing the underlying Better Auth API |

**Key insight:** Every piece of this phase that looks like "build a new security primitive" is actually "make the DATABASE enforce something the application already assumes" (role-scoped grants, `TO`-scoped policies) or "collapse N copies of the same wrapper into one" (`resolveWorkspaceMember`, the redaction rule table). Nothing here calls for a new third-party dependency.

## Runtime State Inventory

This is not a rename/refactor phase, but it does introduce two new cluster-level Postgres roles whose creation mechanism has a real, easy-to-miss runtime-state gap worth documenting explicitly (Pitfall 5 below expands on this):

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — no existing rows reference a role name or need backfilling for the RLS/role changes themselves. `workspace_api_keys.scopes` DOES need a data backfill (D-07: every existing key gets the full scope array) — a migration `UPDATE`, not a runtime-state concern. | Data migration for `scopes`; no other data migration |
| Live service config | None — no external service (SendGrid, etc.) holds a reference to these role names | None |
| OS-registered state | None | None |
| Secrets/env vars | Two NEW env vars introduced (`SCAN_DATABASE_URL`, `AUTH_DATABASE_URL` or equivalent names, at planner's discretion) — worker-only for scan, both processes for auth (API needs it for `drizzleAdapter`, worker likely does not touch auth tables at all — verify at plan time). Existing `DATABASE_URL` continues unchanged as `mega_crm_app`'s DSN. | Code + env-file update; not a data migration |
| Build artifacts / installed packages | **Local dev Postgres data volume (`mega_crm_db_data`) persists across restarts.** `docker/init-app-role.sql` (mounted as `/docker-entrypoint-initdb.d/01-init-app-role.sql`) only runs on a container's FIRST volume initialization — extending it with `CREATE ROLE mega_crm_scan`/`CREATE ROLE mega_crm_auth` will NOT retroactively create those roles for any developer or environment with an existing `mega_crm_db_data` volume. CI is unaffected (its runner always starts from a fresh volume via `docker compose up -d --wait`), but every local dev environment and any already-provisioned staging/prod database needs either a volume reset or a one-time superuser script run. | Operator action required outside the migration chain — document in the plan's rollout steps, not assumed automatic |

**Nothing found in category "Live service config" / "OS-registered state":** verified by grep across `docker-compose.yml`, `docker/`, and the CI workflow — no external system stores these role names.

## Common Pitfalls

### Pitfall 1: "Bare-cast" alone does not satisfy SEC-03/SEC-04's fail-closed requirement
**What goes wrong:** A migration that only removes `NULLIF` from the 10 guarded policies (leaving the 12 already-bare-cast policies untouched) will pass a superficial "no NULLIF in `pg_policies`" catalog check, but will still fail SEC-04's actual acceptance criterion for the genuinely-unset-GUC case.
**Why it happens:** `current_setting(key, true)` (the `missing_ok = true` form used by ALL 22 policies today, bare-cast or NULLIF) returns `NULL` — not an error — when the named custom GUC has never been touched at all on that backend connection. `NULL::uuid` never throws; the comparison evaluates to `NULL`, which RLS treats as "row excluded," which is indistinguishable from "zero matching rows" to application code.
**How to avoid:** Rewrite all 22 policies to drop the `missing_ok` argument entirely: `current_setting('app.current_workspace_id')::uuid`, no second argument, no `NULLIF`. Verified live (Postgres 17.10, this project's exact GUC name): this single change makes both failure modes throw — `unrecognized configuration parameter` (never touched) and `invalid input syntax for type uuid` (touched once, then reverted to `''` on a recycled connection).
**Warning signs:** A negative test asserting `rows.length === 0` on a connection that has genuinely never called `withTenantTransaction` will PASS under both the old and the "half-fixed" form — it proves nothing. SEC-04's own acceptance text ("the test asserts the thrown error class, not `rows.length === 0`") is the guard against exactly this trap; the codebase's own pinned baseline test at `tenant-context.test.ts:164-197` currently asserts the OLD (wrong-for-this-phase) behavior and its own docstring says so — inverting those two specific assertions is a first-class deliverable of SEC-03/04, not incidental collateral.

### Pitfall 2: Unscoped RLS policies stop being safe the moment a second role exists
**What goes wrong:** All 22 `workspace_isolation` policies today have no `TO` clause, meaning they apply to `PUBLIC` — every role, including the forthcoming `mega_crm_scan` and `mega_crm_auth`. Once those roles exist and run queries against tables that also carry an app-scoped `workspace_isolation` policy, Postgres must evaluate (or, per this project's own migration-0019 incident, sometimes does evaluate and error on) that policy's predicate too, combined via OR — even though it should never apply to a non-app role.
**Why it happens:** RLS combines all PERMISSIVE policies applicable to a role with OR. "Applicable" is determined by the (optional) `TO` clause; when absent, Postgres treats the policy as applicable to every role, so a bare-cast (or the corrected no-`missing_ok` form from Pitfall 1) predicate that legitimately throws for a connection that never set the tenant GUC will be evaluated as part of the scan role's or auth role's query plan too, unless explicitly excluded via `TO`.
**How to avoid:** Every `CREATE POLICY`/`ALTER POLICY` touched in this phase — the 22 rewritten `workspace_isolation` policies (Pitfall 1) AND the new scan-role/auth-role policies — must carry an explicit `TO <role>` clause. Verified live: scoping the app-role's policy `TO mega_crm_app` removes it from a `scan_role`-issued query's applicable-policy set entirely (confirmed by querying as `scan_role` against a table whose OTHER policy, if evaluated, would error).
**Warning signs:** A scan-role or auth-role query that intermittently fails with `invalid input syntax for type uuid` or `unrecognized configuration parameter` despite the scan/auth role never touching `app.current_workspace_id` — this is precisely the 0019 bug shape recurring under a new role identity.

### Pitfall 3: Role-scoping and predicate-narrowing are complementary, not substitutes (carried from CONTEXT, reconfirmed)
**What goes wrong:** Replacing GUC-gating with `TO mega_crm_scan` alone, without restoring the ORIGINAL predicate each policy had before the GUC-only shortcut, silently widens visibility. Two of today's four scan policies (`flow_runs_due_scan` on 0027, `flows_segment_sweep_scan` on 0032) already have NO predicate beyond the GUC check — meaning the scan role, once granted, would see EVERY row in `flow_runs`/`flows` unconditionally, not just due ones.
**Why it happens:** The GUC check was originally meant to be the *access control*, with the row-narrowing predicate as a courtesy; two of the four scan policies never actually added the narrowing predicate (0018 and 0039 did; 0027 and 0032 did not).
**How to avoid:** When rewriting each scan policy to `TO mega_crm_scan`, restore/add the narrowing predicate that the ORIGINAL requirement (T-06-01-03, T-06-08-02) called for — `status = 'waiting' AND next_wake_at <= now()` for `flow_runs_due_scan`, `status = 'live' AND trigger_type = 'segment'` for `flows_segment_sweep_scan` — even though role-scoping alone would technically satisfy "not gated by a session flag."
**Warning signs:** A scan-role catalog assertion test that only checks `NOBYPASSRLS`/no-table-ownership (SEC-01's stated acceptance) without also asserting each policy's `USING` clause contains its original narrowing predicate would miss this regression entirely.

### Pitfall 4: SEC-09 (sibling-workspace drop) cannot be built without the SEC-01/02 scan role
**What goes wrong:** Planning R6 (sibling-workspace event drop) as a pure application-layer webhook fix, independent of R2's scan-role rollout, produces an unbuildable task — under RLS, a tenant-scoped query (`withTenant(receivingWorkspaceId, ...)`) genuinely cannot see rows belonging to a different workspace, so "does this `send_id` belong to a sibling workspace" and "does this `send_id` not exist at all" are indistinguishable from inside the normal tenant transaction (both resolve to zero rows).
**Why it happens:** `webhook-events.worker.ts`'s current dedup-insert loop resolves candidate `send_id`s via `SELECT id FROM sends WHERE workspace_id = $1 AND id = ANY($2::uuid[])` (workspace-scoped by construction) — a sibling's `send_id` simply doesn't appear in that result set, identically to a genuinely deleted/orphaned `send_id` (the existing D-15 precedent this code already handles).
**How to avoid:** SEC-09's implementation must, before the tenant-scoped insert, resolve each candidate `send_id`'s TRUE `workspace_id` via `withCrossWorkspaceScan()` — an `id`/`workspace_id`-only query (no payload columns) against `sends` under the new `mega_crm_scan` role (which needs the broad `scan_visibility` policy from Pattern 2 above, since it cannot predict `send_id`s in advance any more than the partition-relocation consumer can). If the resolved `workspace_id` is non-null and differs from the receiving endpoint's `workspaceId`, drop that event (increment a counter/structured log with workspace IDs only) rather than inserting it into `send_events` at all. If it resolves to null (genuinely no such send anywhere), keep the EXISTING D-15 behavior (store the event, skip side effects).
**Warning signs:** A plan that sequences R6 before R2, or that has R6 add its own separate ad-hoc cross-tenant query outside `withCrossWorkspaceScan()`, defeating D-02's "one audited entry point" goal and duplicating the exact role-grant surface R2 already had to design carefully.

### Pitfall 5: `CREATE ROLE` cannot live in a numbered migration
**What goes wrong:** A migration file containing `CREATE ROLE mega_crm_scan ...` will fail every time it runs, because migrations in this repo are applied as `mega_crm_app` (see `.github/workflows/ci.yml`'s `DATABASE_URL: postgres://mega_crm_app:...` and `packages/test-support/src/db-fixture.ts`'s `getTestDatabaseUrl()`), and `mega_crm_app` is explicitly `NOCREATEROLE` (`docker/init-app-role.sql`).
**Why it happens:** Role creation is a cluster-level privilege distinct from table/schema DDL. The existing `mega_crm_app` role itself is created the same way — via `docker/init-app-role.sql`, mounted as `/docker-entrypoint-initdb.d/01-init-app-role.sql`, which Postgres's container entrypoint runs as the bootstrap superuser (`postgres`), and ONLY on a fresh data volume.
**How to avoid:** Put `CREATE ROLE mega_crm_scan ...` / `CREATE ROLE mega_crm_auth ...` in an extension of `docker/init-app-role.sql` (Claude's Discretion per CONTEXT). GRANT statements on tables/schemas, by contrast, CAN live in normal numbered migrations, because `mega_crm_app` owns the database and every table in it (`ALTER DATABASE mega_crm OWNER TO mega_crm_app`), and table owners can `GRANT` on objects they own without `CREATEROLE`.
**Warning signs:** A migration that fails in CI (fresh volume — role WOULD exist if `init-app-role.sql` ran first, so this fails differently) vs. a migration that fails only in a developer's long-lived local Postgres (stale volume, role never created) — the two failure surfaces are different, and the plan should assume the second one WILL happen for existing local environments regardless of how it goes in CI (see Runtime State Inventory above).

### Pitfall 6: Two different "timestamp" concepts collide at the webhook endpoint (carried and reconfirmed)
**What goes wrong:** SEC-07's replay window (`x-twilio-email-event-webhook-timestamp` header, verified in `signature-verify.ts` via `verifyWebhookSignature`) and each individual event's own `timestamp` field (used to derive `occurred_at`, extracted in `webhook-events.worker.ts`'s `extractEventRow`) are structurally different values from different parts of the request — a fix that bounds one does not bound the other.
**Why it happens:** SendGrid signs the WHOLE batch once, with one signature timestamp header; each event inside the batch JSON array carries its OWN `timestamp` field, which can legitimately be older (delayed provider events, per CMP-03/CMP-08 in Phase 13) even when the signature itself is fresh.
**How to avoid:** SEC-07's window check belongs in/near `signature-verify.ts` or the route handler, gated on the HEADER timestamp only. Do not touch `extractEventRow`'s `event.timestamp` handling in this phase — that is explicitly Phase 13's CMP-05 territory (per CONTEXT's own cross-phase note).
**Warning signs:** A test that asserts a batch is rejected because one event's `timestamp` field is old — that is testing the wrong field for SEC-07.

### Pitfall 7: The existing pino `redact` config is a partial implementation, not a stale one
**What goes wrong:** Treating SEC-13 as "add a `redact` config from scratch" risks either duplicating `apps/api/src/logger.ts`'s existing `redact.paths` (currently covers `sendgridKey`/`apiKey`/`password`/`token` at 3 nesting depths) or accidentally narrowing it while "centralizing."
**Why it happens:** The existing config already works for the API's structured-log hot path; the gap is (a) no PII patterns (email/phone), (b) no unlimited-depth JSONB coverage, (c) no worker consumption at all (worker currently uses bare `console.log`/`console.error` everywhere — confirmed via `apps/worker/src/server.ts`'s plain `console.log`/`console.error` calls).
**How to avoid:** Per D-10 (locked), absorb the existing path list into the new shared rule table rather than writing a second, parallel list; verify via a test that both the pino-compiled form and the worker's `scrub()` form redact the SAME representative payload (SendGrid key, password, email) identically.
**Warning signs:** Two different regex/path lists for the "same" secret shape drifting apart over time — exactly what D-08's "dual-consumer test guards... against drift" is meant to catch.

### Pitfall 8: The bare-`SET`/`SET ROLE` CI audit needs to check ALL SIX GUC touchpoints, not five
**What goes wrong:** A plan that only migrates the five consumers CONTEXT explicitly names (campaign-scheduler, flow-segment-sweep, flow-reconciliation, partition maintenance/relocation, analytics-reconciliation) misses `attachPartitionCheckFirst`'s OWN `SET LOCAL app.admin_scan` call inside `packages/db/src/partitions/ensure-partitions.ts` (line 238, `await conn.query("SELECT set_config('app.admin_scan', 'true', true)")`) — a sixth, code-level touchpoint distinct from the five worker-level callers, confirmed present in the current source.
**Why it happens:** `attachPartitionCheckFirst` is a shared function called BY several of the five named consumers (partition-maintenance worker, the CLI relocation script, ensure-partitions' own callers) — it's easy to count "5 consumers migrated" and miss that the GUC-setting call itself lives one layer down, inside a function all of them share.
**How to avoid:** After migrating the five named consumers to `withCrossWorkspaceScan()`, ALSO update `attachPartitionCheckFirst` itself to accept/use a scan-role connection (or be called FROM inside a `withCrossWorkspaceScan` block) rather than setting `app.admin_scan` on whatever connection it's handed. The CI bare-`SET` audit (SEC-16/R11) should scan the whole `packages/db` + `apps/worker` + `apps/api` tree, not just the five named files, so this touchpoint fails the check if missed.
**Warning signs:** `grep -rn "set_config('app.admin_scan'" .` or `grep -rn '"SET '` returning any hit after the phase is "done" — this is exactly what R11's audit exists to make un-missable going forward.

## Code Examples

### API-key scope enforcement (SEC-06)

```typescript
// Source: extends apps/api/src/modules/api-keys/api-key-auth.ts's existing
// apiKeyAuth hook (unchanged auth mechanism) with a scope check, matching
// D-06's `resource:action` taxonomy.
declare module "fastify" {
  interface FastifyRequest {
    apiKeyWorkspaceId?: string;
    apiKeyScopes?: string[]; // NEW
  }
}

export function requireApiKeyScope(scope: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const scopes = request.apiKeyScopes ?? [];
    if (!scopes.includes(scope)) {
      // Same UNAUTHORIZED_BODY shape as apiKeyAuth's own failure paths --
      // a scope-lacking key and a wholly invalid key should be equally
      // uninformative to a caller probing for what scopes exist.
      await reply.code(403).send({ error: "Missing required API key scope" });
    }
  };
}

// Route registration (contacts-api.routes.ts):
scope.addHook("onRequest", apiKeyAuth);
scope.post("/v1/contacts", { onRequest: requireApiKeyScope("contacts:write") }, handler);
```

### Redis-backed rate limit with loud fail-open (SEC-08/SEC-11)

```typescript
// Source: apps/api/src/server.ts's existing @fastify/rate-limit registration
// (currently { global: false }, in-memory). @fastify/rate-limit@11.1.0's
// README (confirmed in local node_modules) documents `redis` + `skipOnError`
// directly -- no custom store needed.
import Redis from "ioredis";

const rateLimitRedis = new Redis(env.REDIS_URL, {
  // README's own stated recommendation: default ioredis settings are not
  // tuned for a rate limiter's latency profile.
  connectTimeout: 500,
  maxRetriesPerRequest: 1,
});
rateLimitRedis.on("error", (err) => {
  // Loud, per SEC-08's acceptance criterion ("Redis down: API fails open
  // and logs the limiter error") -- skipOnError alone swallows silently.
  logger.error({ err }, "rate-limit Redis connection error -- requests proceeding unthrottled");
});

await app.register(rateLimit, {
  global: false,
  redis: rateLimitRedis,
  skipOnError: true, // fail open, per SEC-08's documented tradeoff
});

// Webhook route gets its OWN bucket, independent of the global limiter:
fastify.post(
  "/webhooks/sendgrid/:pathToken",
  { config: { rateLimit: { max: 100, timeWindow: "1 minute" } } },
  handler
);
```

### `BETTER_AUTH_SECRET` production floor (SEC-12)

```typescript
// Source: extends apps/api/src/env.ts's existing .superRefine() block
// (which already gates KMS_PROVIDER and PUBLIC_APP_URL the same way).
// Current schema: BETTER_AUTH_SECRET: z.string().min(16, ...) -- the floor
// itself must move to 32 AND be conditioned on NODE_ENV === "production"
// (dev/test environments should not be forced onto a 32-char secret).
BETTER_AUTH_SECRET: z.string().min(16, "BETTER_AUTH_SECRET must be at least 16 characters"),
// ...
.superRefine((val, ctx) => {
  if (val.NODE_ENV === "production" && val.BETTER_AUTH_SECRET.length < 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "BETTER_AUTH_SECRET must be at least 32 characters when NODE_ENV=production",
      path: ["BETTER_AUTH_SECRET"],
    });
  }
  // ...existing KMS_PROVIDER / PUBLIC_APP_URL checks unchanged
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `app.admin_scan` session GUC set on the shared tenant pool | Dedicated login role (`mega_crm_scan`), `TO`-scoped policies, no GUC | This phase (SEC-01/02) | Any code holding the tenant pool can currently set `app.admin_scan='true'` and gain cross-tenant read on the tables that check it; after this phase, cross-tenant read requires a distinct credential the API process structurally cannot hold |
| Mixed bare-cast / NULLIF RLS policies, both using `missing_ok=true` | Uniform bare-cast, no `missing_ok`, `TO`-scoped | This phase (SEC-03/04) | Closes the "zero rows on a fresh connection" ambiguity this research verified live |
| Better Auth tables with zero DB-level boundary | `mega_crm_auth` role owning exclusive access to secret-bearing auth tables | This phase (SEC-05) | First DB-enforced boundary on `session`/`account`/`verification` since Phase 1 |

**Deprecated/outdated:** The `app.admin_scan` GUC pattern itself (migrations 0018/0027/0032/0039) is fully retired by this phase, not merely supplemented — CONTEXT is explicit that the pattern is deleted, "policies + code."

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Worker process needs `AUTH_DATABASE_URL` (or equivalent) in addition to API — this research did not find any worker code path that queries Better Auth tables directly (worker uses `pool.query("SELECT id FROM organization")`, which is a domain read, not a Better-Auth-adapter read) | Runtime State Inventory | If wrong, the worker needlessly holds auth-role credentials it never uses, mildly weakening the "least privilege" property SEC-05 is meant to establish — verify at plan time by grepping worker source for any `drizzleAdapter`/`@mega-crm/db`'s `auth` schema imports beyond `organization` |
| A2 | `mega_crm_app` should retain read (not write) grants on `organization`/`member`/`invitation`/`user` per D-05's "keeps only what live query sites prove it needs" — this research confirmed READ sites (`getCallerRoles`, `analytics-reconciliation.worker.ts`'s `SELECT id FROM organization`, `invites.ts`'s `db.query.organization.findFirst`) but did not exhaustively audit every WRITE site across all ~9 route modules for whether any of them write to these four tables outside Better Auth's own server API | Standard Stack / Architecture Patterns | If some route directly INSERTs/UPDATEs `member`/`invitation` outside Better Auth's API (bypassing `auth.api.*`), revoking `mega_crm_app`'s write grant on that table would break that route silently until caught by tests — grep for `db.insert(member)`/`db.update(invitation)` etc. at plan time before finalizing the grant matrix |
| A3 | The `scan_visibility ON contacts`/`ON sends` policy (Pattern 2, `USING (true)`) is acceptable because the scan role's ONLY consumers (partition relocation, SEC-09's sibling lookup) both need effectively unrestricted read and neither ever reaches application code that could leak full rows to an untrusted caller — this research verified the CURRENT partition-relocation need (0039's comment) but the SEC-09 need is this phase's OWN new addition, not yet implemented anywhere to cross-check against | Architecture Patterns Pattern 2 / Pitfall 4 | If SEC-09's implementation ends up needing more than `id`/`workspace_id` from `sends` (e.g., to construct a richer drop log), the "no payload" prohibition (P1) could be violated by an overly broad scan-role SELECT — plan-time task should explicitly restrict the SEC-09 query's SELECT list |

## Open Questions

1. **Does R7's "identical for existing and nonexistent invitations" mean the FULL response body, or just the not-found path?**
   - What we know: `GET /api/invites/:invitationId` currently returns an IDENTICAL `404 {"error":"Invitation not found"}` for both "no such id" and "id exists but its organization is gone" (verified in `invites.ts` lines 187-202) — this precedent already satisfies "byte-identical 404s" literally. For an invite that EXISTS but is expired/revoked/accepted, the route currently returns 200 with `email`, `role`, `organizationName`, `organizationSlug`, `status` — full preview data, by design, since a legitimate invitee needs to see who invited them before accepting.
   - What's unclear: SPEC's R7 acceptance text ("invite endpoint returns only minimal data and answers identically for existing and nonexistent invitations") could mean either (a) tighten the 404 case only (already close to done) or (b) something stronger — e.g., an expired/revoked invite should return LESS data than a pending one, to avoid leaking `organizationName`/`email` for an invite the caller can no longer act on.
   - Recommendation: Treat this as a plan-time clarification, not a research gap — the CONTEXT interview log (Round 2) locked "byte-identical 404 everywhere, invite included," which most directly maps to (a). If the planner wants (b) as well, it should be called out explicitly as an additional design decision, since it changes legitimate-invitee UX, not just attacker-facing behavior.

2. **Does the worker process need the `mega_crm_auth` DSN at all?**
   - What we know: No worker source file imports anything from `packages/db/src/schema/auth.ts` or `@mega-crm/db`'s `auth` schema exports beyond reading `organization.id` (a table D-05 keeps `mega_crm_app`-readable, not auth-role-only).
   - What's unclear: whether some future/overlooked worker path (e.g., a notification job that reads `user.email`) exists that this grep-based research missed.
   - Recommendation: confirm via `grep -rn "from \"@mega-crm/db\"" apps/worker/src` at plan time and decide whether `AUTH_DATABASE_URL` should exist in the worker's env checks at all (Assumption A1).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| PostgreSQL | RLS policies, all new roles/grants | ✓ | 17 (per `docker-compose.yml`'s `postgres:17` image; verified against a local Postgres 17.10 during this research) | — |
| Redis | `@fastify/rate-limit`'s distributed store (SEC-08/11), existing BullMQ usage | ✓ | 7.x per `docker-compose.yml` (`redis:7` image) | — |
| Docker / docker-compose | Local dev DB/Redis, and the `docker-entrypoint-initdb.d` mechanism role creation depends on | ✓ (per `docker-compose.yml`; not exercised as a live daemon during this research session — verified via file inspection, not a live container) | — | — |
| `@fastify/rate-limit` Redis store | SEC-08/SEC-11 | ✓ installed, 11.1.0 | 11.1.0 | — |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none — everything required is already present in the repository/toolchain.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.9 `[VERIFIED: apps/api/package.json]` |
| Config file | per-workspace `vitest.config.ts` (existing; not modified by this phase) |
| Quick run command | `npm run test --workspace=<affected-package> -- <file>` (existing convention) |
| Full suite command | `npm run coverage` (root) — `vitest run --coverage --testTimeout=60000`, aggregated across all workspaces per `08-11`'s design |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SEC-03/04 | Unset GUC and empty-string GUC both throw; catalog has zero `NULLIF` | integration (real Postgres) | `vitest run packages/tenant-context/src/__tests__/tenant-context.test.ts` | ✅ (existing file — its "PRE-PHASE-10 baseline" describe block needs inverting, see Pitfall 1) |
| SEC-01/02 | Scan role `NOBYPASSRLS`, owns no tables; `SET app.admin_scan` grants nothing; API process cannot reach scan credentials | integration + catalog assertion | new `packages/tenant-context/src/__tests__/scan.test.ts` | ❌ Wave 0 |
| SEC-05 | Login/signup/invite-accept pass end-to-end after auth-role boundary | integration (existing e2e-shaped tests, likely `apps/api/src/__tests__/*auth*`) | `vitest run apps/api` (auth suite) | ✅ existing files likely need updates, not new files — confirm exact paths at plan time |
| SEC-06 | Missing/empty scope refused per route | integration | new tests alongside `apps/api/src/modules/api-keys/*` and `contacts-api.routes`/`events-api.routes` suites | ❌ Wave 0 (new assertions in existing files) |
| SEC-07 | 600s accept / 601s reject / malformed reject / replay reject | unit + integration | extend `apps/api/src/modules/webhooks/*` test suite | Partial — signature tests likely exist; timestamp-window tests are new |
| SEC-08/11 | Independent bucket; two-instance N/N+1; Redis-down fail-open+log | integration | new `apps/api/src/__tests__/rate-limit-*.test.ts` | ❌ Wave 0 |
| SEC-09 | Mixed batch: own persist, sibling absent, drop counted, no payload logged | integration | extend `apps/worker` webhook-events test suite | Partial — existing suite covers dedup; sibling-drop is new |
| SEC-10/15 | Byte-identical 404 sweep; invite identical response | integration, parameterized | new cross-route sweep test | ❌ Wave 0 |
| SEC-13 | Redaction reaches nested JSONB; dual-consumer parity | unit | new `packages/redaction/src/__tests__/*` | ❌ Wave 0 (new package) |
| SEC-14 | Grep assertion duplicates gone; identical missing/forbidden | static + integration | grep-based test + route suite reuse | ❌ Wave 0 |
| SEC-16 | Bare-`SET` CI audit; negative cross-tenant suite (API + jobs) | static (CI script) + integration | new `scripts/lint-*` or ESLint rule + new negative-test files per module/job family | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** targeted `vitest run <changed file>` against a real ephemeral Postgres (this phase is almost entirely RLS/grant-dependent — no meaningful mock exists for any of it)
- **Per wave merge:** `npm run coverage` (full aggregate)
- **Phase gate:** full suite green before `/gsd-verify-work`, PLUS the new bare-`SET` CI audit script/rule passing on the whole tree

### Wave 0 Gaps

- [ ] `packages/tenant-context/src/__tests__/scan.test.ts` — SEC-01/02 catalog + negative assertions
- [ ] `packages/redaction/` (whole new package + its test suite) — SEC-13
- [ ] `apps/api/src/__tests__/rate-limit-*.test.ts` — SEC-08/11 two-instance + fail-open tests
- [ ] Cross-route 404-sweep test file — SEC-10/15
- [ ] CI bare-`SET`/`SET ROLE` audit script or ESLint rule + its own violating-fixture test — SEC-16
- [ ] `docker/init-app-role.sql` extension (or equivalent) for the two new roles — precondition for every integration test above running against a correctly provisioned ephemeral DB (verify `packages/test-support`'s `createEphemeralDatabase` still works unmodified once these roles exist at cluster level, since it only creates DATABASES, not roles)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Better Auth (unchanged mechanism) + API-key `timingSafeEqual` comparison (unchanged) — SEC-05 changes the DB boundary behind auth, not the auth mechanism itself |
| V3 Session Management | yes | Better Auth session table now behind `mega_crm_auth`-exclusive grants (SEC-05); `BETTER_AUTH_SECRET` production floor (SEC-12) |
| V4 Access Control | yes | This is the phase's core: RLS as the enforcement mechanism (SEC-03/04), role-based cross-tenant scan access (SEC-01/02), API-key scopes (SEC-06), membership resolution (SEC-14) |
| V5 Input Validation | yes | Webhook timestamp/signature validation (SEC-07) — existing Zod-based validation elsewhere is unchanged by this phase |
| V6 Cryptography | no change | Webhook ECDSA verification (`@sendgrid/eventwebhook`) and API-key SHA-256 hashing are unchanged by this phase — no new cryptographic primitive is introduced |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Cross-tenant data read via a forgotten `WHERE workspace_id = ...` | Information Disclosure | RLS as the last line of defense (existing pattern); this phase closes the two gaps (Pitfall 1, Pitfall 2) that made the existing RLS deployment less reliable than assumed |
| Privilege escalation via session-flag GUC (`app.admin_scan`) settable by any code on the shared pool | Elevation of Privilege | Replaced by role identity (SEC-01/02) — a credential the vulnerable process structurally cannot hold, not a value it merely shouldn't set |
| API-key scope bypass (scopes stored but never checked) | Elevation of Privilege | Enforced per-route scope check (SEC-06) |
| Webhook replay (same signed payload resent later) | Tampering / Spoofing | Timestamp-age window (SEC-07), independent of the payload-level `occurred_at` dedup (Phase 13) |
| Resource enumeration via response-shape difference (404 vs 403, or invite preview leaking existence) | Information Disclosure | Byte-identical responses across missing/forbidden (SEC-10/15) |
| Secret/PII leakage into logs or (future) Sentry | Information Disclosure | Centralized redaction rule set, dual-compiled for pino and worker `console` (SEC-13) |
| Cross-tenant sibling-workspace event injection under a shared BYO SendGrid key | Spoofing / Information Disclosure | Per-event workspace resolution + drop (SEC-09), dependent on the SEC-01/02 scan role (Pitfall 4) |

Canon-referred (not re-derived here): general OWASP/injection concerns → `/gsd-secure-phase` at phase close, per this project's standing convention.

## Sources

### Primary (HIGH confidence)
- Direct repository inspection: `packages/db/migrations/0001`, `0004`, `0006`, `0007`, `0009`, `0012`, `0013`, `0014`, `0015`, `0016`, `0018`, `0019`, `0020`, `0021`, `0026`, `0027`, `0032`, `0036`, `0037`, `0039` — full RLS policy inventory (22 tenant tables, exact predicate text)
- `packages/tenant-context/src/index.ts`, `packages/tenant-context/src/__tests__/tenant-context.test.ts` — existing GUC mechanism and its own documented pre-Phase-10 baseline
- `docker/init-app-role.sql`, `docker-compose.yml` — role provisioning mechanism and its first-volume-init limitation
- `packages/test-support/src/provision-db.ts`, `packages/test-support/src/migration-runner.ts`, `.github/workflows/ci.yml` — confirms migrations run as `mega_crm_app` (NOCREATEROLE), grounding Pitfall 5
- `apps/worker/src/queues/{campaign-scheduler,analytics-reconciliation}.worker.ts`, `apps/worker/src/queues/flows/{flow-segment-sweep,flow-reconciliation}.worker.ts`, `packages/db/src/partitions/ensure-partitions.ts` — all six GUC touchpoints, exact current pool usage
- `apps/worker/src/queues/webhook-events.worker.ts` — full sibling-workspace-drop code path, grounding Pitfall 4
- `packages/db/src/schema/auth.ts`, `packages/db/src/index.ts`, `apps/api/src/modules/auth/auth.ts` — Better Auth's current pool wiring and its "no RLS on these tables" documented rationale
- `apps/api/src/modules/api-keys/api-key-auth.ts`, `packages/db/src/schema/api-keys.ts` — current scope column state ("reserved for v2 and unused")
- `apps/api/src/modules/webhooks/{signature-verify,webhooks.routes}.ts` — current signature/timestamp handling
- `apps/api/src/logger.ts` — existing pino redact config
- `apps/api/src/server.ts` — current `@fastify/rate-limit` registration (`global: false`, no Redis store)
- `apps/api/src/modules/tenancy/{member-roles,invites}.ts` — current membership/invite response shapes
- `SPECIFICATION.md` §3.6, §4.1–4.3, §5.7, §6.1–6.4 — as-built cross-check; the 12-bare-cast/10-NULLIF split this research independently derived from migrations matches §4.3 exactly, and §3.6's "three independent pools" description confirms the current pool topology
- `node_modules/@fastify/rate-limit/README.md`, `node_modules/{pg,ioredis,better-auth,drizzle-orm}/package.json` — installed-version ground truth
- **Live Postgres 17.10 reproduction (this research session, scratch instance, discarded after use):** confirmed (a) `current_setting(key, true)` returns `NULL` (no error) on an untouched custom GUC; (b) `current_setting(key)` (no `missing_ok`) throws `unrecognized configuration parameter` on the same untouched GUC; (c) after a `SET LOCAL`+`COMMIT` cycle, the GUC reverts to `''` and both `current_setting(key)` and a bare `::uuid` cast on it throw `invalid input syntax for type uuid`; (d) a `TO <role>`-scoped policy is excluded from a differently-scoped role's query plan entirely, while an unscoped policy's erroring predicate can surface for that other role's query — reproducing the mechanism behind this project's own migration-0019 incident

### Secondary (MEDIUM confidence)
- None used beyond the primary sources above — this research was entirely groundable in the existing codebase and a live Postgres reproduction; no web search was required for correctness-critical claims.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; every version read directly from installed `node_modules`
- Architecture (RLS unification, scan role, auth role): HIGH — the two most load-bearing claims (fail-closed semantics, `TO`-scoping necessity) were verified against a live Postgres 17.10 instance using this project's own GUC name and cast pattern, not asserted from training knowledge
- Pitfalls: HIGH for #1, #2, #5 (all verified live or against direct repo evidence); MEDIUM-HIGH for #3, #4, #6, #7, #8 (grounded in direct repo inspection, but the SEC-09/SEC-14/SEC-16 implementations themselves don't exist yet, so some downstream specifics are necessarily inferred, not observed)
- Open Questions: intentionally left open where CONTEXT's locked decisions don't fully disambiguate (invite response shape) or where this research's grep-based coverage could not be exhaustive (worker auth-DSN necessity)

**Research date:** 2026-08-07
**Valid until:** 30 days (stable domain — Postgres RLS semantics don't change; the installed-package versions and exact file states could drift faster if other phases land first, but Phase 10 is next in sequence per STATE.md)
