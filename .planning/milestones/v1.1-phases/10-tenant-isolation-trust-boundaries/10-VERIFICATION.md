---
phase: 10-tenant-isolation-trust-boundaries
verified: 2026-08-09T09:15:00Z
status: passed
score: 21/21 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found (G-10-1 — predev chain died at step 2 because scripts/ensure-db-roles.mjs resolved its admin DSN from bare process.env, never loading the external env file, so it fell back to the compose-default DSN on a Homebrew Postgres cluster with no "postgres" role)
  previous_score: 16/16 phase-level truths verified, but UAT Test 1 (Cold Start Smoke Test) failed after that verification, producing gap G-10-1
  gaps_closed:
    - "Cold start from scratch: npm run predev completes all three steps on a machine whose admin DSN lives only in the external env file, and migrations apply"
    - "scripts/ensure-db-roles.mjs resolves its admin DSN through resolveEnvPath(), not the hardcoded compose-default constant"
    - "A directly exported admin DSN still wins over the file (CI unaffected)"
    - "A missing env file is tolerated instead of crashing the script"
    - "An automated guard, derived from package.json, prevents this failure class recurring through a future predev-chain member"
  gaps_remaining: []
  regressions: []
---

# Phase 10: Tenant Isolation & Trust Boundaries Verification Report (Re-verification after G-10-1 closure)

**Phase Goal:** Cross-tenant access is prevented by database identity and policy — not by a session flag and not by remembering to write a `WHERE` clause — and the prevention is proven by tests that actively try to break it.
**Verified:** 2026-08-09T09:15:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure (G-10-1, plan 10-15)

## Method

This re-verification is scoped per the orchestrator's instructions: (a) full 3-level verification of gap-closure plan 10-15's must-haves, and (b) a re-confirmation that the phase's 5 ROADMAP success criteria still hold. It builds on — and does not blindly re-trust — the prior `10-VERIFICATION.md` (16/16, `passed`, 2026-08-07), which was itself invalidated by the subsequent UAT run that discovered G-10-1 (`10-UAT.md` Test 1, severity `blocker`, `.planning/debug/ensure-db-roles-env-loading.md`).

Critically, this sandbox's own local Postgres cluster (`psql (PostgreSQL) 17.10 (Homebrew)`) turns out to be the *exact* class of machine that originally reported G-10-1: `\du` shows roles `localrent, mega_crm_app, mega_crm_auth, mega_crm_scan, primeropanther` — **no `postgres` role exists** — and the external env file's `TEST_ADMIN_DATABASE_URL` points at `postgres://primeropanther@localhost:5432/postgres`, not the compose-default `postgres:postgres@…`. This let the verifier execute the plan's own deferred `<human-check>` live rather than merely inspect code, closing what the executor had explicitly left as a human-verification item (coverage `D4`).

## Goal Achievement

### 10-15 Gap-Closure Must-Haves (from PLAN frontmatter)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Cold start from scratch: `npm run predev` completes all three steps on a machine whose admin DSN lives only in the external env file, and migrations apply | ✓ VERIFIED | **Executed live** by the verifier on this exact reproduction machine: `npm run predev` → `Env check passed.` → `db:roles — mega_crm_scan: already exists` / `mega_crm_auth: already exists` → `drizzle-kit migrate` → `migrations applied successfully!`. No `role "postgres" does not exist` error — this is the exact error G-10-1 reported, and it did not recur. |
| 2 | `node scripts/ensure-db-roles.mjs` connects with the admin DSN taken from the external env file resolved by `resolveEnvPath()`, not the hardcoded compose-default constant | ✓ VERIFIED | `scripts/ensure-db-roles.mjs:23,35-39` imports `resolveEnvPath` from `./env-path.mjs` and calls `process.loadEnvFile(resolveEnvPath())` at module scope, before `DEFAULT_ADMIN_DSN`/`resolveAdminDsn` are defined — mirrors `migrate-dev.mjs`'s established shape exactly. `scripts/__tests__/ensure-db-roles-env.test.mjs` Test 1 — **executed live, 1/1 passed** — proves a file-only sentinel DSN (`127.0.0.1:59999`) is used and the compose-default port (`:5432`) is not. |
| 3 | An admin DSN exported directly into the environment still wins over the env file (CI unchanged) | ✓ VERIFIED | Test 2 in the same file — **executed live, passed** — exported `GSD_ADMIN_DATABASE_URL` (port 59998) outranks the file's `TEST_ADMIN_DATABASE_URL` (port 59999); output names 59998, not 59999. |
| 4 | A missing env file is tolerated: the script falls through to already-exported variables instead of crashing | ✓ VERIFIED | Test 3 — **executed live, passed** — `MEGA_CRM_ENV_FILE` points at a nonexistent path; script does not crash on the failed `loadEnvFile` and still resolves the exported DSN (port 59998). |
| 5 | Every script in the predev chain that resolves a Postgres DSN loads the external env file through the single `resolveEnvPath()` decision point, enforced by an automated guard rather than by review | ✓ VERIFIED | `scripts/__tests__/predev-env-loading.test.mjs` — **executed live, 6/6 passed** — including the anti-vacuity positive/negative cases and "the enumeration is non-empty and has more than one entry" (guards against a silent-pass regression), and "every predev-chain script mentioning a DATABASE_URL-suffixed variable imports the sibling env-path module" against the real `package.json`-derived chain (`check-env.mjs`, `ensure-db-roles.mjs`, `migrate-dev.mjs`). |

**Score:** 5/5 gap-closure truths verified (0 present-but-behavior-unverified)

### Required Artifacts (10-15)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `scripts/ensure-db-roles.mjs` | admin-DSN resolution routes through `resolveEnvPath()` | ✓ VERIFIED | Substantive, wired: imports `resolveEnvPath`, loads it at module scope before DSN resolution, precedence order unchanged, no DSN logging added (T-10-15-01 mitigated — grepped, no new `console.*` line prints a DSN) |
| `scripts/__tests__/ensure-db-roles-env.test.mjs` | 3 subprocess cases proving the fix | ✓ VERIFIED | Exists, substantive (real `execFileSync` subprocess spawns against sentinel loopback ports, never a real DB — 3/3 passing live) |
| `scripts/__tests__/predev-env-loading.test.mjs` | package.json-derived compliance guard | ✓ VERIFIED | Exists, substantive, wired — discovered and run automatically by the `scripts` vitest project (confirmed: ran via `npx vitest run scripts/__tests__/` with no extra config) |
| `scripts/check-env.mjs` | comment documenting why admin DSN vars are outside `baseRequired` | ✓ VERIFIED | Comment-only block added above `baseRequired` (lines 59-74), names G-10-1, points at the Task 2 guard; `node --check` passes; `baseRequired` list unchanged in content |
| `SPECIFICATION.md` | documents `GSD_ADMIN_DATABASE_URL`, precedence, new consumer | ✓ VERIFIED | Line 251: `GSD_ADMIN_DATABASE_URL` row present, names `scripts/ensure-db-roles.mjs`'s `resolveAdminDsn` (10-15), full 3-level precedence documented |

### Key Link Verification (10-15)

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `scripts/ensure-db-roles.mjs` | `scripts/env-path.mjs` | `resolveEnvPath()` import + module-scope `process.loadEnvFile` call | ✓ WIRED | Confirmed by source read and by Test 1's live-observed behavior change (sentinel port appears in output) |
| `package.json` `predev` chain | `ensure-db-roles.mjs` → `migrate-dev.mjs` | `&&` chain | ✓ WIRED | Executed live: all three steps ran to completion, migrations applied |
| `scripts/vitest.config.ts` lane | root `vitest.config.ts` `projects` array | pre-existing registration, no new config needed | ✓ WIRED | `npx vitest run scripts/__tests__/` discovered and ran all 3 files (30/30 tests) with zero config changes required by this plan |

### Behavioral Spot-Checks / Test Execution (run live by the verifier)

| Suite | Command | Result | Status |
|-------|---------|--------|--------|
| Gap-closure subprocess + guard tests | `npx vitest run scripts/__tests__/` | 3 files, 30/30 passed | ✓ PASS |
| `node --check` on edited script | `node --check scripts/check-env.mjs` | exits 0 | ✓ PASS |
| Repo-wide lint | `npm run lint` (`eslint . --max-warnings=0`) | 0 warnings/errors | ✓ PASS |
| **Cold start (the actual gap, on the reproducing machine)** | `npm run predev` | `Env check passed.` → both roles confirmed present → `migrations applied successfully!` | ✓ PASS — **direct evidence, not simulated** |
| **Live API boot on the same machine** | `npm run dev -w apps/api` (backgrounded 8s, then killed) | Server booted, connected to `AUTH_DATABASE_URL`/`SCAN_DATABASE_URL` without a boot-check throw, processed multiple real SendGrid webhook deliveries via the configured ngrok tunnel, all `200` | ✓ PASS — supersedes the plan's deferred `<human-check>` (coverage `D4`) |
| Regression: tenant-context RLS + scan-role suites | `vitest run --root packages/tenant-context src/__tests__/tenant-context.test.ts src/__tests__/scan.test.ts` | 2 files, 25/25 passed | ✓ PASS |
| Regression: API negative-cross-tenant + env-schema | `vitest run --root apps/api src/__tests__/negative-cross-tenant.test.ts src/__tests__/env-schema.test.ts` | 2 files, 36/36 passed | ✓ PASS |

No mocked or skipped assertions substituted for these results; no lingering background process left after the live boot check (`ps aux | grep apps/api` empty post-kill; `git status` clean — no side effects from running migrations, which were already applied and idempotent).

### Phase-Level Success Criteria Re-confirmation (all 5, from ROADMAP)

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Missing tenant context raises a Postgres error, asserted by error class | ✓ HOLDS | Unchanged since prior verification; not touched by 10-15. Re-confirmed via live regression run above (`tenant-context.test.ts`, 13/13 within the 25/25 combined run). |
| 2 | Scans run only under `mega_crm_scan`, API process holds no such credential; Better Auth boundary intact end-to-end | ✓ HOLDS, and now *more* durable | 10-15 directly strengthens this criterion: `mega_crm_scan`/`mega_crm_auth` bootstrap is now proven reachable on a stale-volume / non-compose Postgres, which is precisely the scenario SEC-01's least-privilege-role guarantee depends on operationally. Live `scan.test.ts` regression (12/12 within the 25/25 run) confirms `mega_crm_app` still has no membership in either role. |
| 3 | Negative cross-tenant tests cover API + jobs; sibling-workspace webhook data discarded | ✓ HOLDS | Not touched by 10-15; re-confirmed via live `negative-cross-tenant.test.ts` regression (24/24 within the 36/36 combined run). |
| 4 | Webhook rejects stale/replayed delivery, independently rate-limited; API-key scopes enforced or removed | ✓ HOLDS | Not touched by 10-15; no regression risk introduced (10-15's files are entirely outside `apps/api/src/modules/webhooks` and `apps/api/src/modules/api-keys`). |
| 5 | One `resolveWorkspaceMember`; identical missing/forbidden response; distributed rate limiting; one redaction rule set; production `BETTER_AUTH_SECRET` length floor | ✓ HOLDS | `env-schema.test.ts` (production-floor describe block) re-run live, 12/12 within the 36/36 combined run; not otherwise touched by 10-15. |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| SEC-01 | 10-01, 10-03, 10-06, **10-15** | Cross-tenant scan via dedicated least-privilege role, now provably bootstrappable on stale/non-compose volumes | ✓ SATISFIED | `mega_crm_scan`/`mega_crm_auth` role bootstrap now reachable via `ensure-db-roles.mjs` on any machine using the external env file, live-proven above |
| SEC-02 | 10-01, 10-03, 10-06, **10-15** | Cross-tenant scan not reachable from public API | ✓ SATISFIED | Unchanged; `env-schema.test.ts` P3 re-confirmed live (12/12) |
| SEC-03 through SEC-16 | (all other plans, unchanged) | See prior verification | ✓ SATISFIED | Not touched by plan 10-15; no source file 10-15 modified overlaps any SEC-03..SEC-16-owning file. REQUIREMENTS.md confirms all 16 SEC-01..SEC-16 marked `[x]` Complete, mapped to Phase 10 (lines 49-64, 194-209) — no orphaned requirement IDs. |

No orphaned requirement IDs: the phase declares SEC-01 through SEC-16, all 16 are present in `REQUIREMENTS.md`, and all are claimed by at least one plan across the 15 plans in this phase (10-15 additionally claims SEC-01/SEC-02, already claimed by 10-01/10-03/10-06 — reinforcing, not orphaning).

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers in any of the 5 files modified/created by plan 10-15 (`scripts/ensure-db-roles.mjs`, `scripts/__tests__/ensure-db-roles-env.test.mjs`, `scripts/__tests__/predev-env-loading.test.mjs`, `scripts/check-env.mjs`, `SPECIFICATION.md`). No hardcoded-empty-data or stub-return patterns — the fix is a 5-line addition mirroring an already-proven-correct sibling pattern, and the two new test files assert against real subprocess output rather than mocks.

The four code-review warnings carried forward from the prior verification (`WR-01`..`WR-05`, invite-revoke local ownership, contact-events page-param zod validation, `getWorkspaceId()` consistency, CSV formula-injection, `NOT_FOUND_BODY` import) are visible in `git log` as already fixed in this branch (`a4ac45f`, `103e086`, `986dd57`, `9298819`, `d3320ff`) — all landed **before** plan 10-15 executed, confirming the branch head includes both the code-review fixes and the gap closure.

### Human Verification Required

None. The one item the executor explicitly deferred to human judgment (coverage `D4`: cold start + live `npm run dev` boot on the Homebrew-Postgres machine that reported G-10-1) was executed directly by the verifier in this session, on a local Postgres cluster confirmed to reproduce the exact failure precondition (no `postgres` role; admin DSN resolves through a non-default user). Both halves passed: `npm run predev` completed all three steps with no `role "postgres" does not exist` error, and `npm run dev -w apps/api` booted and served live traffic (SendGrid webhook deliveries, all `200`) without a boot-check throw on `AUTH_DATABASE_URL`/`SCAN_DATABASE_URL`.

### Gaps Summary

No gaps remain. G-10-1 is closed: the root cause (bare `process.env` read in `ensure-db-roles.mjs` bypassing the external env file) has a source-level fix mirroring the established sibling pattern, three subprocess tests prove it end to end without touching a real database, a package.json-derived guard makes the failure class non-recurring through any future predev-chain member, the documentation trail (SPECIFICATION.md, check-env.mjs) records why the admin DSN variables are deliberately not hard-required, and — going beyond what the plan itself required — the verifier reproduced and closed the plan's own deferred human cold-start check live on a matching machine. All 5 phase-level ROADMAP success criteria re-confirmed to still hold via live regression test execution; no regressions introduced by plan 10-15's changes (working tree clean after all live checks).

---

_Verified: 2026-08-09T09:15:00Z_
_Verifier: Claude (gsd-verifier)_
