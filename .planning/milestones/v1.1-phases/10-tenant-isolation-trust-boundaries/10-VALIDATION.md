---
phase: 10
slug: tenant-isolation-trust-boundaries
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-07
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.9 |
| **Config file** | per-workspace `vitest.config.ts` (existing; not modified by this phase) |
| **Quick run command** | `npm run test --workspace=<affected-package> -- <file>` |
| **Full suite command** | `npm run coverage` (root — `vitest run --coverage --testTimeout=60000`, aggregated across workspaces) |
| **Estimated runtime** | ~60–120 seconds (full aggregate; targeted runs seconds) |

---

## Sampling Rate

- **After every task commit:** Run targeted `vitest run <changed test file>` against a real ephemeral Postgres (this phase is almost entirely RLS/grant-dependent — no meaningful mock exists for any of it)
- **After every plan wave:** Run `npm run coverage` (full aggregate)
- **Before `/gsd-verify-work`:** Full suite must be green, PLUS the new bare-`SET`/`SET ROLE` CI audit script/rule passing on the whole tree
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 10-07 Task 1-3 | 07 | 4 | SEC-03, SEC-04 | T-10-07-01..06 | Unset GUC and empty-string GUC both throw; catalog has zero `NULLIF` policies, all 22 `workspace_isolation` policies share one bare-cast predicate | integration (real Postgres) | `npx vitest run --root packages/tenant-context src/__tests__/tenant-context.test.ts` | ✅ | ✅ green |
| 10-01/10-03/10-06 | 01, 03, 06 | 1, 2, 3 | SEC-01, SEC-02 | T-10-01-01..06, T-10-03-01..05, T-10-06-01..05 | Scan role `NOBYPASSRLS`, owns no tables; `mega_crm_scan` reached only via `withCrossWorkspaceScan`, never `SET app.admin_scan`; API process cannot reach scan credentials; the legacy marker GUC is fully retired (migration 0043) and grants nothing where it still lingers in test assertions | integration + catalog assertion | `npx vitest run --root packages/tenant-context src/__tests__/scan.test.ts` | ✅ | ✅ green |
| 10-09 Task 1-3 | 09 | 6 | SEC-05, SEC-12 | T-10-09-01..06 | Login/signup/invite-accept pass end-to-end through the `mega_crm_auth`-backed `authDb`; `mega_crm_app` holds zero privilege on `session`/`account`/`verification`; short `BETTER_AUTH_SECRET` refused in production | integration | `npx vitest run --root apps/api src/modules/auth/__tests__/auth-boundary.test.ts` | ✅ | ✅ green |
| 10-10 Task 1-3 | 10 | 7 | SEC-06 | T-10-10-01..05 | Missing/empty API-key scope refused per route with one vocabulary-free 403; every pre-existing key keeps working via the same-migration backfill; a route-enumeration assertion fails if a future `/v1/*` route ships without a scope | integration | `npx vitest run --root apps/api src/modules/api-keys/__tests__/api-key-scopes.test.ts` | ✅ | ✅ green |
| 10-11 Task 1-2 | 11 | 8 | SEC-07 | T-10-11-01..06 | 600s accept / 601s reject / malformed reject / missing reject / future-dated reject / replay-after-window reject, all byte-identical to a bad-signature 400 | unit + integration | `npx vitest run --root apps/api src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts` | ✅ | ✅ green |
| 10-12 Task 1-3 | 12 | 9 | SEC-08, SEC-11 | T-10-12-01..06 | Independent webhook rate-limit bucket, isolated in both directions; two-instance shared exact-count enforcement; Redis-down loud fail-open (requests proceed, named error logged) | integration | `npx vitest run --root apps/api src/__tests__/rate-limit-distributed.test.ts` | ✅ | ✅ green |
| 10-08 Task 1-2 | 08 | 5 | SEC-09 | T-10-08-01..06 | Mixed batch: own events persist, sibling-workspace events absent, drop counted per owning workspace, no payload logged, D-15 orphan behaviour unchanged | integration | `npx vitest run --root apps/worker src/queues/__tests__/webhook-events-sibling-drop.test.ts` | ✅ | ✅ green |
| 10-04 Task 1-2 | 04 | 2 | SEC-10, SEC-15 | T-10-04-01..05 | Byte-identical 404 for missing vs forbidden across 9 resource kinds + 2 workspace-level cases; invite preview responses identical for nonexistent-vs-org-gone ids | integration, parameterized | `npx vitest run --root apps/api src/__tests__/anti-enumeration-sweep.test.ts` | ✅ | ✅ green |
| 10-13 Task 1-3 | 13 | 10 | SEC-13 | T-10-13-01..06 | Redaction reaches nested JSONB at unbounded depth; pino (`apps/api`) and `scrubbedConsole` (`apps/worker`) consumers produce identical redaction from one shared rule table | unit | `npx vitest run --root packages/redaction` | ✅ | ✅ green |
| 10-02 Task 1-2 | 02 | 1 | SEC-14 | T-10-02-01..04 | `resolveWorkspaceMember` duplicates gone (grep assertion: exactly one implementation in the tree); identical missing/forbidden behavior across the nine former copies' call sites | static + integration | `npx vitest run --root apps/api src/modules/tenancy/__tests__/resolve-workspace-member.test.ts` | ✅ | ✅ green |
| 10-05/10-14 | 05, 14 | 2, 11 | SEC-16 | T-10-05-01..05, T-10-14-01..06 | Bare-`SET`/`SET ROLE` CI audit passes on the whole tree (309+ files, zero violations); negative cross-tenant suite actively attempts (not merely asserts) denial across every session-authenticated API route module and every background-job family, with a coverage assertion that fails on an uncovered module/family | static (CI script) + integration | `npm run lint:session-state && npx vitest run --root apps/api src/__tests__/negative-cross-tenant.test.ts && npx vitest run --root apps/worker src/queues/__tests__/negative-cross-tenant-jobs.test.ts` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `packages/tenant-context/src/__tests__/scan.test.ts` — SEC-01/02 catalog + negative assertions. Satisfied by plan 10-01's tracer slice, extended by 10-03's additional grants/policies, and closed by 10-06's marker-GUC retirement (three plans, not one, since the tracer pattern deliberately proved one consumer end-to-end before extending to the rest).
- [x] `packages/redaction/` — whole new package + its test suite (SEC-13). Satisfied by plan 10-13 exactly as predicted.
- [x] `apps/api/src/__tests__/rate-limit-*.test.ts` — SEC-08/11 two-instance + fail-open tests. Satisfied by plan 10-12's `rate-limit-distributed.test.ts` exactly as predicted.
- [x] Cross-route 404-sweep test file — SEC-10/15. Satisfied by plan 10-04's `anti-enumeration-sweep.test.ts` exactly as predicted.
- [x] CI bare-`SET`/`SET ROLE` audit script or ESLint rule + its own violating-fixture test — SEC-16. Satisfied by plan 10-05's `scripts/lint-session-state.mjs` (a standalone Node-builtins-only script wired into the `static` CI job, not an ESLint rule) — the plan's own "script or rule" phrasing left this open, and a script was chosen since it needed filesystem-wide SQL-string-literal scanning rather than an AST-node-level check ESLint is naturally suited for.
- [x] `docker/init-app-role.sql` extension (or equivalent) for the two new roles — precondition for every integration test above running against a correctly provisioned ephemeral DB. Satisfied differently than predicted: plan 10-01 extended `docker/init-app-role.sql` for fresh volumes AND added `scripts/ensure-db-roles.mjs` (`npm run db:roles`) plus `packages/test-support`'s `ensureClusterRoles`, wired into `createEphemeralDatabase` — so every test-suite-provisioned ephemeral database self-provisions both new roles automatically, closing the precondition note about `createEphemeralDatabase` only creating databases, not roles.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| A staging/production Postgres cluster with a pre-existing data volume needs the `mega_crm_scan`/`mega_crm_auth` roles created out of band | SEC-01, SEC-05 | `docker/init-app-role.sql` only runs on first volume init; ephemeral test databases self-provision via `ensureClusterRoles` (plan 10-01), but a real staging/prod cluster with data already on it does not run that path | Run `npm run db:roles` (superuser DSN via `GSD_ADMIN_DATABASE_URL`/`TEST_ADMIN_DATABASE_URL`), or the equivalent `CREATE ROLE` block from `docker/init-app-role.sql` manually as a superuser, before applying migrations 0041 onward |
| An operator running the DEFAULT-partition relocation CLI must supply `PARTITION_RELOCATION_ADMIN_DATABASE_URL` in their own shell | SEC-01, SEC-02 | Plan 10-06's non-empty-ATTACH step needs a BYPASSRLS/superuser-class DSN that must never live in any service (`apps/api`/`apps/worker`) environment — a deliberate, permanently-manual operator boundary, not a gap to close | Set `PARTITION_RELOCATION_ADMIN_DATABASE_URL` before running `npm run relocate:default-partition-rows`; confirm the CLI fails fast with a descriptive error when it's absent (proven automatically by `relocate-default-partition-rows.test.ts`'s P3-style structural check, but the actual operator shell state on a real cluster is outside source control) |
| `AUTH_DATABASE_URL`/`SCAN_DATABASE_URL` must be present in the correct service's env file only (API needs `AUTH_DATABASE_URL`, worker needs `SCAN_DATABASE_URL`, neither needs the other) | SEC-01, SEC-02, SEC-05 | Structural source-level tests (the P3 pattern) prove the CODE never reads the wrong variable, but the actual env file content per real deployment is an operator action `scripts/check-env.mjs` can only refuse to boot without, not provision itself | Confirm `npm run predev`/`scripts/check-env.mjs` fails loudly on a fresh environment missing either variable in the wrong (or right) process; this was exercised locally during plans 10-01/10-09 (see their SUMMARY "User Setup Required" sections) but not against a real staging/production deployment in this phase |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 120s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-08-09 by `/gsd-validate-phase`

---

## Validation Audit 2026-08-09

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |

All 11 Per-Task Verification Map rows re-verified after the phase 10 code-review fix pass (commits 777d8d4..d3320ff touched invites/campaigns/flows/contacts/csv-import routes, webhook-endpoint repository, and the base db pool). Re-run results against real Postgres:

- `packages/tenant-context` — 2 files, 25 tests passed (scan.test.ts, tenant-context.test.ts)
- `apps/api` — 7 mapped files, 71 tests passed (auth-boundary, api-key-scopes, webhook-timestamp-window, rate-limit-distributed, anti-enumeration-sweep, resolve-workspace-member, negative-cross-tenant)
- `apps/worker` — 2 files, 20 tests passed (webhook-events-sibling-drop, negative-cross-tenant-jobs)
- `packages/redaction` — 2 files, 10 tests passed
- `npm run lint:session-state` — 327 files checked, no violations

Total: 126 tests green + static audit clean. No auditor spawn required (zero gaps). Manual-Only table unchanged — all three entries remain deliberate operator boundaries, not gaps.
