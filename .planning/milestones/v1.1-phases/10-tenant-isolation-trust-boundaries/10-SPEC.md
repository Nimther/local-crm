# Phase 10: Tenant Isolation & Trust Boundaries — Specification

**Created:** 2026-08-07
**Ambiguity score:** 0.13 (gate: ≤ 0.20)
**Requirements:** 11 locked (covering SEC-01 … SEC-16)

## Goal

Cross-tenant access is prevented by database identity and policy — not by a session flag (`app.admin_scan`) and not by remembering a `WHERE` clause — and every prevention claim is proven by a negative test that actively tries to break it.

## Background

v1.0 shipped shared-schema multi-tenancy with RLS, but the audit found the boundary leaks at its edges:

- **Two RLS policy variants coexist**: 36 bare-cast `current_setting(...)::uuid` uses (fail-closed — throws without tenant context) and 20 NULLIF-guarded uses (fail-open — silently returns zero rows) across the migration history. Application code misreads zero rows as "record does not exist."
- **Cross-tenant scans ride a session flag**: `app.admin_scan` GUC is set from 4 code paths (`campaign-scheduler.worker.ts`, `flow-segment-sweep.worker.ts`, `flow-reconciliation.worker.ts`, `ensure-partitions.ts`/partition relocation) via scan policies in migrations 0018/0027/0032/0039 — any code holding the tenant pool can set it. Two scan policies (0027, 0032) have no predicate beyond the GUC check. `analytics-reconciliation.worker.ts` runs a bare `SELECT id FROM organization` on the tenant pool.
- **Better Auth tables** (`packages/db/src/schema/auth.ts`) sit behind no boundary at all; `BETTER_AUTH_SECRET` is validated as a plain `z.string()` with no length floor.
- **API key scopes** exist in `api-key-auth.ts`/`access-control.ts` but are not enforced per route.
- **Webhook ingress** verifies signatures (`signature-verify.ts`) but accepts stale/replayed timestamps, shares the global rate limit, and persists sibling-workspace events arriving under a shared BYO SendGrid key (Phase 5 review WR-01).
- **Membership resolution** is duplicated across ~9 route modules; anti-enumeration behavior differs between routes; no `redact` configuration exists anywhere in API or worker.

## Requirements

1. **R1 — Fail-closed RLS unification** (SEC-03, SEC-04): All tenant RLS policies use the bare-cast fail-closed variant; absent tenant context is an error, never an empty result.
   - Current: 22 policy sets split between bare-cast (throws) and NULLIF (returns zero rows); `contacts`, `sends`, `events`, `send_events` are fail-closed today and must stay so.
   - Target: Every tenant-scoped policy is bare-cast; zero `NULLIF` remains in any tenant policy in `pg_policies`. Unification ships as its own isolated, reviewed change.
   - Acceptance: A query against a tenant table with the GUC unset **and** with `app.tenant_id = ''` (empty string) both raise a Postgres error; the test asserts the thrown error class, not `rows.length === 0`. A catalog assertion proves no tenant policy contains `NULLIF`.

2. **R2 — Dedicated scan role, GUC deleted** (SEC-01, SEC-02): All cross-tenant background scans run under a dedicated least-privilege database role; the `app.admin_scan` GUC pattern is removed entirely.
   - Current: 4 GUC consumers + `analytics-reconciliation`'s bare `SELECT` on the tenant pool; scan policies keyed on the GUC (0018/0027/0032/0039), two with no predicate beyond it.
   - Target: One role (`NOBYPASSRLS`, owns no tables, minimal grants) serves all five consumers; GUC-keyed policies replaced by role-scoped, predicate-narrowed policies; the API process holds neither the role's credentials nor membership in it. Connection shape (separate pool vs `SET LOCAL ROLE`) is an ADR decided in discuss-phase.
   - Acceptance: All five consumers pass their existing tests under the new role; after migration, executing `SET app.admin_scan = 'true'` grants no additional access (negative test); a test proves no public-API code path can obtain cross-tenant read; catalog assertions prove the role is `NOBYPASSRLS` and owns no tables.

3. **R3 — Better Auth trust boundary** (SEC-05): The Better Auth tables sit behind a decided, implemented trust boundary that auth flows still pass through.
   - Current: 7 auth tables with no boundary; Better Auth issues SQL through a non-tenant pool that never sets the workspace GUC; `organization` has no `workspace_id` column.
   - Target: Boundary mechanism (dedicated `mega_crm_auth` role vs RLS vs `auth.*` schema move — open decision for discuss-phase) is chosen, recorded as an ADR, and implemented. Naive copy-paste RLS is explicitly forbidden (Pitfall 12 — breaks login silently).
   - Acceptance: Login, signup, and invite-accept pass end-to-end tests after the boundary is in place; the ADR exists and names the rejected alternatives.

4. **R4 — API key scopes enforced** (SEC-06): Every API-key-authenticated route declares a required scope and refuses keys lacking it (fork resolved: enforce, not remove).
   - Current: Scopes exist in `api-key-auth.ts`/`access-control.ts` but are not checked on every route.
   - Target: Per-route scope declaration; a key lacking the required scope receives 403 on every route; a key with an empty scope list is refused on all scoped routes.
   - Acceptance: A test per API-key route proves the missing-scope refusal; the empty-scope-list case has an explicit test.

5. **R5 — Webhook replay window + independent rate limit** (SEC-07, SEC-08): The webhook endpoint rejects stale or replayed deliveries and is rate-limited independently of the rest of the API.
   - Current: Signature verification exists (`signature-verify.ts`) with no timestamp age check; webhook route shares the global rate limit.
   - Target: Signature timestamp age ≤ 600 s accepted, > 600 s rejected (env-overridable window); malformed or missing timestamp rejected identically to a bad signature; webhook route has its own rate-limit bucket.
   - Acceptance: Tests at 600 s (accept), 601 s (reject), malformed timestamp (reject), and a replayed stale delivery (reject); a test proves the webhook limiter counts independently of the global API limiter. (Payload `occurred_at` bounding is Phase 13 / CMP-05 — different timestamp field, out of scope here.)

6. **R6 — Sibling-workspace events discarded** (SEC-09): Webhook events resolving to a different workspace than the receiving endpoint's are dropped, observably, without payload leakage.
   - Current: Worker ignores flattened `workspace_id`; sibling workspaces' raw event payloads are persisted into each other's `send_events` under a shared BYO key (Phase 5 WR-01).
   - Target: Per-event filtering — in a mixed batch the endpoint workspace's own events persist normally, sibling events are dropped and counted (counter/structured log with workspace IDs and counts only); one sibling event never fails the batch.
   - Acceptance: A mixed-batch test proves own-events-persist + sibling-events-absent from `send_events`; the drop signal is asserted; the log/metric assertion proves no payload contents are emitted.

7. **R7 — Anti-enumeration everywhere** (SEC-10, SEC-15): Missing and forbidden resources are indistinguishable on every route.
   - Current: Behavior differs per route module; invite endpoint response contract unaudited.
   - Target: A missing resource and a cross-tenant resource return byte-identical 404 responses on every route; the invite endpoint returns only minimal data and answers identically for existing and nonexistent invitations.
   - Acceptance: A parameterized test sweeps routes asserting byte-identical status + body for missing vs cross-tenant; invite endpoint has its own identical-response test.

8. **R8 — Distributed API rate limit** (SEC-11): The API rate limit is Redis-backed and provably correct across replicas.
   - Current: In-memory per-process store; a second replica would double every limit.
   - Target: `@fastify/rate-limit` on a Redis-backed store; Redis unreachable → fail-open with a loud error log (documented). Multi-replica *deployment* stays out of v1.1 scope; correctness is proven in-process.
   - Acceptance: A test runs two API instances against one Redis and proves request N passes and N+1 is rejected regardless of which instance receives it; a Redis-down test proves requests proceed and the error is logged.

9. **R9 — Centralized redaction + production secret floor** (SEC-12, SEC-13): One shared redaction rule set covers API and worker; weak `BETTER_AUTH_SECRET` is refused in production.
   - Current: No `redact` configuration exists in API or worker; `BETTER_AUTH_SECRET` is unvalidated beyond being a string.
   - Target: A shared rule-set module (secret shapes: SendGrid keys, auth secrets; PII: email, phone, freeform JSONB) consumed by the API pino config now and by whatever the worker serializes today; Phase 15's worker-Pino and Sentry `beforeSend` reuse the same module. `BETTER_AUTH_SECRET` < 32 chars refused at boot when `NODE_ENV=production`.
   - Acceptance: A test feeds representative payloads (decrypted SendGrid key in scope, contact object) through both consumers and asserts redaction; a boot test with a short secret and `NODE_ENV=production` asserts refusal; nested-JSONB depth handling is a held-out backstop test (edge probe).

10. **R10 — Single membership resolver** (SEC-14): Workspace membership resolution has exactly one implementation.
    - Current: Duplicated across ~9 route modules (contacts, csv-import, send-log, campaigns, flows, segments, 3× analytics).
    - Target: One shared `resolveWorkspaceMember`, used by every route module; built as the future attachment point for Phase 15's `workspace_id`/`request_id` tagging.
    - Acceptance: Grep-level assertion that the duplicated implementations are gone; all route tests still pass; the single implementation answers identically for missing and forbidden resources (feeds R7).

11. **R11 — Negative cross-tenant suite + session-state audit** (SEC-16): Cross-tenant denial is proven by tests that attempt the access, and no session-scoped state can leak across pooled connections.
    - Current: No negative cross-tenant tests for background jobs; bare-`SET` usage unaudited (Phase 9 added `SET LOCAL app.admin_scan` correctly, but the codebase-wide guarantee is unverified).
    - Target: Negative tests attempt cross-tenant reads/writes through API routes **and** background jobs; a codebase audit (enforced check, not one-time grep) finds no bare `SET`/`SET ROLE` outside `SET LOCAL` / `set_config(..., true)` — the precondition Phase 14 needs before introducing PgBouncer.
    - Acceptance: The negative suite covers at least one API route per module and each background-job family; the session-state check runs in CI and fails on a violating fixture.

## Boundaries

**In scope:**
- Bare-cast unification of all tenant RLS policies (single isolated reviewed change)
- Dedicated least-privilege scan role; migration of all five existing cross-tenant consumers; deletion of the `app.admin_scan` GUC pattern (policies + code)
- ADRs: admin-scan connection shape (SEC-01), Better Auth trust boundary mechanism (SEC-05) — decided in discuss-phase, implemented here
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

**Out of scope:**
- Multi-replica API/worker *deployment* — v1.1 exclusion; SEC-11 is proven by an in-process two-instance test
- Phase 11 reconciler / Phase 12 sweep — they *adopt* the role built here; their scan logic is their own phases' work
- Payload `occurred_at` bounding and dedup re-basing — Phase 13 (CMP-05/CMP-07); different timestamp field than SEC-07's signature timestamp
- Worker structured Pino logging — Phase 15 (OPS-06); this phase ships the rule set, not the worker logger rebuild
- Sentry integration — Phase 15 (OPS-09) reuses this phase's redaction module
- PgBouncer / connection pooling changes — Phase 14 (DB-14); this phase only delivers the bare-`SET` audit it depends on
- Live SendGrid webhook verification — Phase 16 (UAT-03)

## Constraints

- **Pitfall 11 (direction of unification):** unify toward bare-cast (fail-closed). SEC-04's test must assert the thrown error; a `rows.length === 0` assertion passes under either variant and catches nothing.
- **Pitfall 12:** no mechanical RLS on Better Auth tables; any change gated on the SEC-05 ADR and re-tested through the full auth flows before shipping.
- **Pitfall 9:** every new role gets `NOBYPASSRLS` explicitly and must own no tables; role-scoping and predicate-narrowing of the 0027/0032 scan policies are complementary — close both.
- **Pitfall 10:** the bare-`SET`/`SET ROLE` audit must pass before Phase 14 introduces pooling.
- **Sequencing:** this phase precedes Phase 11 (reconciler) and Phase 12 (sweep) so each writes its admin-scan usage once against the final role; SEC-13's rule set precedes Phase 15's Sentry `beforeSend`.
- RLS policy changes are forward-only migrations (documented as such per DB-07's two-tier rollback model).

## Acceptance Criteria

- [ ] Query on a tenant table with GUC unset raises a Postgres error; test asserts the error class
- [ ] Query with `app.tenant_id = ''` also raises; explicit test
- [ ] No tenant policy in `pg_policies` contains `NULLIF` (catalog assertion)
- [ ] Scan role is `NOBYPASSRLS`, owns no tables (catalog assertions)
- [ ] All five scan consumers (campaign-scheduler, flow-segment-sweep, flow-reconciliation, partition maintenance/relocation, analytics-reconciliation) run under the role; existing tests pass
- [ ] `SET app.admin_scan` grants no access post-migration (negative test)
- [ ] No public-API code path can obtain cross-tenant read (negative test)
- [ ] SEC-01 connection-shape ADR and SEC-05 Better Auth ADR exist
- [ ] Login, signup, invite-accept pass end-to-end after the Better Auth boundary lands
- [ ] `BETTER_AUTH_SECRET` < 32 chars + `NODE_ENV=production` refuses to boot (test)
- [ ] Every API-key route enforces its declared scope with 403; empty-scope key refused (tests)
- [ ] Webhook: 600 s accepted, 601 s rejected, malformed timestamp rejected, replayed stale delivery rejected (tests)
- [ ] Webhook rate limit counts independently of the global API limiter (test)
- [ ] Mixed webhook batch: own events persist, sibling events absent, drop counted, no payload in logs (test)
- [ ] Missing vs cross-tenant: byte-identical 404 across routes (parameterized test); invite endpoint identical for existing/nonexistent invite
- [ ] Two API instances + one Redis: request N passes, N+1 rejected on either instance (test)
- [ ] Redis down: API fails open and logs the limiter error (test)
- [ ] One `resolveWorkspaceMember`; duplicates removed
- [ ] Shared redaction module redacts representative payloads through API and worker consumers (tests)
- [ ] Negative cross-tenant suite covers API routes per module and each background-job family
- [ ] Bare-`SET`/`SET ROLE` check runs in CI and fails on a violating fixture
- [ ] MUST NOT: sibling-event drop path emits no payload content (negative test — P1)
- [ ] MUST NOT: no fail-closed policy converts to NULLIF (catalog negative test — P2)
- [ ] MUST NOT: API process holds scan-role credentials or membership (negative test — P3)

## Edge Coverage

**Coverage:** 36/36 applicable edges resolved (9 covered · 1 backstop · 26 dismissed) · 0 unresolved

| Category | Requirement | Status | Resolution / Reason |
|----------|-------------|--------|---------------------|
| empty | R1 | ✅ covered | Empty-string GUC raises like unset — explicit acceptance criterion |
| empty | R2 | ✅ covered | Post-migration `SET app.admin_scan` grants nothing; role `NOBYPASSRLS`, owns no tables |
| empty | R4 | ✅ covered | Empty-scope-list key refused on all scoped routes |
| boundary | R5 | ✅ covered | Exactly 600 s accepted; 601 s rejected |
| precision | R5 | ✅ covered | Malformed/missing timestamp rejected identically to bad signature |
| concurrency | R6 | ✅ covered | Mixed batch: own persist, siblings drop per-event; one sibling never fails the batch |
| empty | R7 | ✅ covered | Missing vs cross-tenant 404 bodies byte-identical |
| boundary | R8 | ✅ covered | N passes / N+1 rejected across two instances sharing one Redis |
| concurrency | R8 | ✅ covered | Redis unreachable → fail-open + loud error log |
| empty | R9 | 🧪 backstop | Held-out test: redaction reaches arbitrarily nested JSONB keys (carry into plan-phase must_haves) |
| adjacency/ordering | R1 | ⛔ dismissed | Policy predicate has no collection/ordering semantics |
| adjacency/ordering/concurrency | R2 | ⛔ dismissed | Role migration has no collection semantics; concurrency covered by existing consumer tests |
| boundary/precision | R3 | ⛔ dismissed | No numeric threshold in the boundary decision; auth-flow e2e is the acceptance itself |
| adjacency/ordering/concurrency | R4 | ⛔ dismissed | Scope check is a set-membership test per request; no ordering/concurrency contract |
| concurrency | R5 | ⛔ dismissed | Parallel deliveries governed by the independent rate limit (own acceptance) |
| adjacency/ordering/concurrency | R7 | ⛔ dismissed | Response-identity contract; no collection semantics |
| precision/idempotency | R8 | ⛔ dismissed | Counting is integral; repeated requests each count by design |
| adjacency/ordering/concurrency | R9 | ⛔ dismissed | Rule set is declarative config; no ordering/concurrency contract |
| adjacency/empty/ordering | R10 | ⛔ dismissed | Membership edge (missing/forbidden) subsumed by R7 |
| adjacency/empty/ordering/concurrency | R11 | ⛔ dismissed | R11 is itself the test suite; probing the probe adds nothing |

## Prohibitions (must-NOT)

**Coverage:** 3/3 applicable prohibitions resolved · 0 unresolved

| Prohibition (must-NOT statement) | Requirement | Status | Verification / Reason |
|----------------------------------|-------------|--------|------------------------|
| MUST NOT log or persist sibling-workspace payload content (contact emails, event bodies) on the drop path — counts and workspace IDs only | R6 | resolved | verification: test (negative assertion on log/metric output; check path captured at plan time — test does not exist yet) |
| MUST NOT convert any currently fail-closed (bare-cast) RLS policy to the NULLIF fail-open variant | R1 | resolved | verification: test (catalog assertion: no tenant policy contains `NULLIF` after migration) |
| MUST NOT place scan-role credentials or role membership in the API process | R2 | resolved | verification: test (env-schema negative assertion + grant check; exact form depends on SEC-01 ADR) |

Canon-referred (not minted here): SQL injection / OWASP / prototype pollution → `/gsd-secure-phase`; GDPR erasure semantics → Phase 13 (CMP-04).

## Ambiguity Report

| Dimension          | Score | Min  | Status | Notes                                        |
|--------------------|-------|------|--------|----------------------------------------------|
| Goal Clarity       | 0.90  | 0.75 | ✓      | Prevention by DB identity, proven by negative tests |
| Boundary Clarity   | 0.85  | 0.70 | ✓      | SEC-06 fork resolved; role-adoption scope locked; explicit out-of-scope list |
| Constraint Clarity | 0.85  | 0.65 | ✓      | Pitfalls 9–12 carried in as binding constraints |
| Acceptance Criteria| 0.85  | 0.70 | ✓      | 25 pass/fail criteria incl. 3 negative        |
| **Ambiguity**      | 0.13  | ≤0.20| ✓      |                                              |

## Interview Log

| Round | Perspective | Question summary | Decision locked |
|-------|-------------|------------------|-----------------|
| 1 | Researcher | SEC-06 fork: enforce scopes or remove? | Enforce on every route |
| 1 | Researcher | SEC-01 adoption scope: how many GUC consumers migrate? | Full migration — all five consumers, GUC pattern deleted |
| 1 | Researcher | SEC-11 meaning without multi-replica deploy | Redis store + two-instance in-process test |
| 2 | Boundary Keeper | SEC-09 "discarded" semantics | Drop + counted metric/log, no payload contents |
| 2 | Failure Analyst | SEC-07 replay window value | 10 minutes (600 s), env-overridable |
| 2 | Boundary Keeper | SEC-10/15 anti-enumeration response shape | Byte-identical 404 everywhere, invite included |
| 5.5 | Edge probe | Window boundary, Redis-down, mixed batch + batch of 5 specify / 26 dismiss | ≤600 s accept; fail-open + log; per-event filtering; batch accepted |
| 5.6 | Prohibition probe | P1 payload-free drop, P2 no NULLIF regression, P3 no scan creds in API | All three kept, test tier |

**Open decisions carried into discuss-phase (mechanism, not outcome):** SEC-05 Better Auth boundary mechanism (dedicated role / RLS / `auth.*` schema); SEC-01 connection shape (separate pool + credential vs `SET LOCAL ROLE`). Both recorded as ADRs when decided.

---

*Phase: 10-tenant-isolation-trust-boundaries*
*Spec created: 2026-08-07*
*Next step: /gsd-discuss-phase 10 — implementation decisions (SEC-05 mechanism, SEC-01 connection shape, redaction module shape, scope taxonomy)*
