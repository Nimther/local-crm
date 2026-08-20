# Phase 10: Tenant Isolation & Trust Boundaries - Context

**Gathered:** 2026-08-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Cross-tenant access is prevented by database identity and policy — not by a session flag (`app.admin_scan`) and not by remembering a `WHERE` clause — and every prevention claim is proven by a negative test that actively tries to break it. Covers SEC-01…SEC-16 (см. `.planning/REQUIREMENTS.md`).

Sequencing: this phase precedes Phase 11 (reconciler) and Phase 12 (sweep) so each writes its admin-scan usage once, against the final scan role. The bare-`SET`/`SET ROLE` CI audit delivered here is the precondition for Phase 14's PgBouncer work; the redaction rule set precedes Phase 15's Sentry `beforeSend`.

</domain>

<spec_lock>
## Requirements (locked via SPEC.md)

**11 requirements are locked.** See `10-SPEC.md` for full requirements, boundaries, and acceptance criteria (ambiguity score 0.13, gate ≤ 0.20).

Downstream agents MUST read `10-SPEC.md` before planning or implementing. Requirements are not duplicated here.

**In scope (from SPEC.md):**
- Bare-cast unification of all tenant RLS policies (single isolated reviewed change)
- Dedicated least-privilege scan role; migration of all five existing cross-tenant consumers; deletion of the `app.admin_scan` GUC pattern (policies + code)
- ADRs: admin-scan connection shape (SEC-01), Better Auth trust boundary mechanism (SEC-05) — **decided in this discussion, see D-01 and D-04; record as ADRs during implementation**
- Better Auth boundary implementation + full auth-flow regression (login/signup/invite-accept)
- Per-route API key scope enforcement
- Webhook signature-timestamp replay window (600 s) + independent webhook rate limit
- Sibling-workspace webhook event drop (per-event, counted, payload-free)
- Uniform anti-enumeration (byte-identical 404s) incl. invite endpoint
- Redis-backed API rate limit + two-instance proof
- Shared redaction rule-set module wired into API (and worker's existing logging surface)
- `BETTER_AUTH_SECRET` production length floor (≥ 32 chars)
- Single `resolveWorkspaceMember`
- Negative cross-tenant test suite (API + background jobs) + CI-enforced bare-`SET`/`SET ROLE` audit

**Out of scope (from SPEC.md):**
- Multi-replica API/worker *deployment* — SEC-11 proven by an in-process two-instance test
- Phase 11 reconciler / Phase 12 sweep — they *adopt* the role built here
- Payload `occurred_at` bounding and dedup re-basing — Phase 13 (CMP-05/CMP-07)
- Worker structured Pino logging — Phase 15 (OPS-06); this phase ships the rule set only
- Sentry integration — Phase 15 (OPS-09) reuses this phase's redaction module
- PgBouncer / connection pooling changes — Phase 14 (DB-14)
- Live SendGrid webhook verification — Phase 16 (UAT-03)

</spec_lock>

<decisions>
## Implementation Decisions

### SEC-01 ADR — Scan-role connection shape

- **D-01:** **Separate pool + dedicated login credential.** New login role (e.g. `mega_crm_scan`) — `NOBYPASSRLS`, owns no tables, minimal per-table grants — with its own DSN env variable present **only in the worker's env schema**. The API's env schema simply lacks the variable, which is itself part of the P3 proof ("API process holds neither the role's credentials nor membership"). `SET LOCAL ROLE` on the existing pool was rejected: it requires `GRANT scan TO mega_crm_app`, and the API connects as that same login role — P3's negative test would be unsatisfiable. — **Reversibility:** costly — Phases 11/12 write their scan usage against this shape; changing it later means re-touching every consumer plus the negative-test suite.
- **D-02:** **One shared `withCrossWorkspaceScan`-style helper in `packages/tenant-context`**, next to `withTenantTransaction` — the single audited entry point for cross-tenant reads. Scan pool is lazily initialized from the worker-only env var, so API processes importing the package never construct it. All five consumers (campaign-scheduler, flow-segment-sweep, flow-reconciliation, partition maintenance/relocation, analytics-reconciliation) go through this helper; Phases 11/12 adopt the same entry point. — **Reversibility:** costly — same adoption-surface argument as D-01.
- **D-03:** GUC-keyed scan policies (0018/0027/0032/0039) are replaced by **role-scoped policies** (`TO <scan role>`); per Pitfall 9, role-scoping and predicate-narrowing of the previously predicate-free 0027/0032 policies are complementary — both must land. Exact predicates per table follow from what each consumer actually reads (planner/researcher derive from the five consumers' queries).

### SEC-05 ADR — Better Auth trust boundary

- **D-04:** **Dedicated `mega_crm_auth` login role + grant partitioning.** Better Auth's `drizzleAdapter` pool gets its own DSN connecting as `mega_crm_auth`. Secret-bearing tables (`session`, `account`, `verification`) become reachable **only** by the auth role; `mega_crm_app` keeps read grants on the workspace-shaped tables (`organization`, `member`, `invitation`, `user`) that membership resolution and the tenancy modules genuinely query. Rejected alternatives (must be named in the ADR): RLS on auth tables (Better Auth sets no GUC, so policies could only key on role — grants expressed slower and with Pitfall 12's silent-zero-rows login breakage), and an `auth.*` schema move (every tenant table FKs `organization(id)` — highest-risk migration for the same end state). — **Reversibility:** one-way — grant revocations ship as forward-only migrations per DB-07's rollback model, and the auth-flow e2e suite (login/signup/invite-accept) is the acceptance gate.
- **D-05:** Grant-matrix principle: **write grants default to the auth role; `mega_crm_app` keeps only what live query sites prove it needs.** Planner determines the per-table matrix from actual query sites in the tenancy modules (writes issued through Better Auth's server API move to the auth pool naturally).

### API key scopes (R4)

- **D-06:** Taxonomy is **`resource:action` pairs**: `contacts:read`, `contacts:write`, `events:write` — covering the two API-key-authenticated route modules that exist today. Set-membership check per route; future routes add scopes to the vocabulary.
- **D-07:** **Migration backfills all existing keys with the full scope set** in the same change that starts enforcement — zero tenant breakage; the empty-scope refusal then only ever applies to keys deliberately stripped. New keys default to the full set at creation (no scope-picker UI in this phase — deferred). — **Reversibility:** reversible — narrowing later is a per-key update; the taxonomy strings are the only published contract.

### Redaction module (R9)

- **D-08:** **Hybrid rule source in a new small shared package** (name at planner's discretion, e.g. `packages/redaction`; follows the Phase 8 `packages/test-support` precedent — mandatory `SPECIFICATION.md` §2 entry). One rule table (key patterns + value regexes for SendGrid keys, auth secrets, email, phone) compiled two ways: (a) pino `redact.paths` for the API's hot path, (b) a recursive `scrub(value)` function with unlimited depth for freeform JSONB. The nested-JSONB backstop test (SPEC edge probe) passes by construction via the recursive form; R9's dual-consumer test guards the two compiled outputs against drift.
- **D-09:** Worker consumption now = **wrapping its existing `console.log/error` surface with `scrub()`**; Phase 15's worker-Pino rebuild and Sentry `beforeSend` reuse the same module (the `scrub()` function is exactly the shape `beforeSend` needs).
- **D-10:** Codebase correction to SPEC background: `apps/api/src/logger.ts` **already has** a pino `redact` config (field paths for `sendgridKey`/`apiKey`/`password`/`token`, wildcards 2 levels deep). R9's work is centralizing it, adding PII + value-pattern coverage, unlimited depth, and worker consumption — the existing path list is absorbed into the shared rule table, not duplicated.

### Claude's Discretion

- Exact role names (`mega_crm_scan`, `mega_crm_auth`), env-variable names for the two new DSNs, and where role creation lives (migration vs `docker/init-app-role.sql` extension — note the init script only runs on first volume init).
- Per-table grant matrices for both new roles (derive from actual query sites; principle in D-03/D-05).
- Mechanism of the CI bare-`SET`/`SET ROLE` audit (ESLint rule vs standalone script) — must fail on a violating fixture per R11.
- Name/location of the redaction package and the worker's console-wrapper shape.
- Webhook rate-limit bucket sizing; Redis-backed store wiring details for `@fastify/rate-limit`.
- Shape of the parameterized anti-enumeration sweep test and the negative cross-tenant suite structure.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements and phase boundaries
- `.planning/phases/10-tenant-isolation-trust-boundaries/10-SPEC.md` — **Locked requirements — MUST read before planning.** 11 requirements, boundaries, constraints, 25 acceptance criteria incl. 3 prohibitions (P1 payload-free drop, P2 no NULLIF regression, P3 no scan creds in API), edge coverage table
- `.planning/ROADMAP.md` § Phase 10 — phase goal, success criteria, sequencing notes (R-03: role before reconciler/sweep)
- `.planning/REQUIREMENTS.md` — SEC-01…SEC-16
- `.planning/AUDIT-2026-07-27-production-readiness.md` — v1.1 requirements source; tenant-isolation findings (§4.x)
- `.planning/research/PITFALLS.md` — Pitfalls 9 (NOBYPASSRLS + predicate narrowing), 10 (bare-SET audit before pooling), 11 (fail-closed unification direction), 12 (naive RLS on Better Auth breaks login silently)

### Existing trust-boundary code (as-is state)
- `packages/tenant-context/src/index.ts` — shared tenant pool + `withTenantTransaction` (`set_config(..., true)` discipline); the model for D-02's scan helper and the home it lands in
- `docker/init-app-role.sql` — the single existing role `mega_crm_app` (LOGIN, NOBYPASSRLS, owns database `mega_crm`); precedent for creating roles, but note it runs only on first volume init
- `packages/db/src/index.ts` — the Drizzle pool Better Auth rides today (same `DATABASE_URL`/role); comment explicitly notes it is the non-RLS client
- `packages/db/src/schema/auth.ts` — the 7 Better Auth tables (`user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`); `organization.id` IS the workspace_id every RLS policy casts
- `apps/api/src/modules/auth/auth.ts` — Better Auth config (`drizzleAdapter(db)`, organization plugin, uuid IDs)
- `apps/api/src/modules/api-keys/api-key-auth.ts` — `apiKeyAuth` onRequest hook (timing-safe, enumeration-safe 401); scope check attaches here
- `packages/db/src/schema/api-keys.ts` — `scopes text[] NOT NULL DEFAULT []`, "reserved for v2 and unused"; backfill target of D-07
- `apps/api/src/modules/webhooks/signature-verify.ts` — existing ECDSA raw-body verification; R5's timestamp window attaches here
- `apps/api/src/logger.ts` — existing pino `redact` config absorbed by D-08/D-10
- `packages/db/migrations/0018/0027/0032/0039` (admin-scan policies), plus the 36 bare-cast vs 20 NULLIF policy split across migration history — R1/R2 targets
- Five scan consumers: `apps/worker/src/queues/campaign-scheduler.worker.ts`, `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts`, `apps/worker/src/queues/flows/flow-reconciliation.worker.ts`, `packages/db/src/partitions/ensure-partitions.ts` (+ `packages/db/scripts/relocate-default-partition-rows.ts`), `apps/worker/src/queues/analytics-reconciliation.worker.ts` (bare `SELECT id FROM organization`)

### Phase 8/9 infrastructure this phase builds on
- `.planning/phases/08-quality-gates-failure-injection-foundation/08-CONTEXT.md` — `packages/test-support` (ephemeral DBs, D-11: tests run under non-superuser `mega_crm_app` so RLS enforces), migration linter, env outside root (`MEGA_CRM_ENV_FILE`)
- `.planning/phases/09-partition-automation-boundary-safety/09-CONTEXT.md` — `SET LOCAL app.admin_scan` precedent in `attachPartitionCheckFirst` (deviation 09-04) — a sixth GUC touchpoint to migrate/verify alongside the named five

### Documents that MUST be updated in the same change
- `SPECIFICATION.md` — §2 (new redaction package), §3 (two new DSN env vars + `BETTER_AUTH_SECRET` floor), §4 (RLS unification, new roles/policies), §6 (scope enforcement, webhook window, rate-limit changes) — per the binding rule in `.claude/CLAUDE.md`
- `ARCHITECTURE.md`, `CONVENTIONS.md` — binding update rule (Phase 8): trust-boundary/role changes are boundary changes; two new ADRs recorded

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`withTenantTransaction` pattern** (`packages/tenant-context`): the exact session-discipline template for the new scan helper — BEGIN → `set_config(..., true)`-equivalent identity → release-with-error on broken connections.
- **Multi-pool coexistence precedent**: tenant-context pool vs `@mega-crm/db` Drizzle pool already coexist against one database; `partition-maintenance.worker.ts:82` already builds a consumer-specific pool.
- **Enumeration-safe response precedent**: `api-key-auth.ts`'s single `UNAUTHORIZED_BODY` for all failure paths — the shape R7 generalizes to 404s platform-wide.
- **`packages/test-support` ephemeral DBs** (Phase 8): tests already run under non-superuser `mega_crm_app`, so RLS negative tests enforce for real; new roles must be created by the provisioning path too.
- **Existing pino `redact` config** (`apps/api/src/logger.ts`): seed content for the shared rule table.
- **Migration linter + `expand/contract` conventions** (Phase 8): will lint this phase's policy/grant migrations; forward-only RLS changes documented per DB-07.

### Established Patterns
- `SET LOCAL` / `set_config(..., true)` only — never bare `SET` (tenant-context comment, Phase 9 deviation 09-04); R11 turns this from convention into CI enforcement.
- Env schema as boundary: worker-only vs API-only env vars validated at boot (Phase 9's `OPERATOR_ALERT_EMAIL` precedent) — the mechanism P3's proof rides on.
- Hand-written SQL migrations for anything Drizzle can't express (partitions, policies) — role/grant/policy DDL follows the same precedent.

### Integration Points
- `packages/tenant-context` — scan helper + lazy scan pool (D-02).
- `apps/api/src/env.ts` / worker env schema — two new DSNs partitioned by process (P3 negative assertion lives here).
- `apps/api/src/modules/auth/auth.ts` + `packages/db/src/index.ts` — auth-role pool wiring for `drizzleAdapter`.
- `apps/api/src/modules/api-keys/api-key-auth.ts` + the contacts/events route modules — per-route scope declarations.
- `apps/api/src/server.ts` — Redis-backed `@fastify/rate-limit` store; separate webhook bucket.
- ~9 route modules — replaced by the single `resolveWorkspaceMember` (R10), which is also Phase 15's tagging attachment point.

</code_context>

<specifics>
## Specific Ideas

- **The boundary must be provable from the catalog and the env schema, not from code review**: P3 is satisfied structurally (API env schema lacks the scan DSN; API role lacks membership) — the negative tests assert absence, mirroring how the SPEC's acceptance criteria are all catalog/negative assertions.
- **One audited entry point per capability**: `withTenantTransaction` for tenant access, one scan helper for cross-tenant access, one `resolveWorkspaceMember` for membership — the phase's theme is collapsing duplicated security-relevant code paths into single greppable functions.
- **Sixth GUC touchpoint**: Phase 9's `attachPartitionCheckFirst` sets `SET LOCAL app.admin_scan` (deviation 09-04) — the GUC-deletion sweep must include it, not just the five named consumers.

</specifics>

<deferred>
## Deferred Ideas

- **Scope-picker UI at API-key creation** (narrow scopes per key in the management UI) — R4 requires enforcement only; UI belongs to a future phase. New keys default to the full scope set until then.
- **Splitting worker/API login roles for tenant-path access** (beyond the scan role) — cleanest long-term identity separation, rejected as out of proportion for R2; revisit if Phase 14's pooling work touches connection identity anyway.

</deferred>

---

*Phase: 10-tenant-isolation-trust-boundaries*
*Context gathered: 2026-08-07*
