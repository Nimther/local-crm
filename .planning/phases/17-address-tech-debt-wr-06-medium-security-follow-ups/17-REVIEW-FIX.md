---
phase: 17-address-tech-debt-wr-06-medium-security-follow-ups
fixed_at: 2026-08-20T03:36:35Z
review_path: .planning/phases/17-address-tech-debt-wr-06-medium-security-follow-ups/17-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 17: Code Review Fix Report

**Fixed at:** 2026-08-20T03:36:35Z
**Source review:** .planning/phases/17-address-tech-debt-wr-06-medium-security-follow-ups/17-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 4 (fix_scope: critical_warning -- WR-01 through WR-04; IN-01 excluded)
- Fixed: 4
- Skipped: 0

## Fixed Issues

### WR-01: `createPgPool`'s new `options` passthrough is unguarded against the same DSN-override hazard the file documents for `ssl`

**Files modified:** `packages/db/src/pool.ts`, `packages/db/src/__tests__/pool-factory.test.ts`
**Commit:** `109ca47`
**Applied fix:** Added `assertDsnOmitsOptionsParam(dsn)`, called unconditionally (every environment, not gated on `NODE_ENV` like the TLS check) inside `createPgPool`, before pool construction. It throws if the DSN carries its own `options` query parameter, which would otherwise silently override the `-c TimeZone=UTC` startup-parameter pin via the same `Object.assign({}, config, parse(connectionString))` merge documented for `ssl`. Extended the module header comment with an "`options`: exactly one mechanism, guarded" section mirroring the existing TLS rationale. Added tests: (1) `assertDsnOmitsOptionsParam` returns normally / throws; (2) `createPgPool` throws instead of silently letting a DSN's `options=` win; (3) a test against pg's own real `ConnectionParameters` resolver (not `pool.options`, which only proves the pre-merge config) documenting the exact hazard the guard closes, and a companion test proving the guard's own resolved value survives the same real merge. Verified with `npx tsc --noEmit` (clean) and `npx vitest run src/__tests__/pool-factory.test.ts` (24/24 passed).

### WR-02: The `dashboard.repository.ts` "read-path WR-06 fix" is a behavioral no-op; the closure narrative overstates what changed

**Files modified:** `apps/api/src/modules/analytics/dashboard.repository.ts`, `apps/api/src/modules/analytics/__tests__/dashboard-timezone.test.ts`, `SPECIFICATION.md`
**Commit:** `4bb0ed3`
**Applied fix:** Reframed the claim in `dashboard.repository.ts`'s header comment and in `SPECIFICATION.md` (§5.17, §8.6 item 2, §9 item 23) from "closes/fixes read-path WR-06" to "the plain `created_at::date` cast this change replaced was already session-independent; the double-hop anchor is a regression guard against a future simplification toward the genuinely session-dependent single-hop form, not a behavior fix." Added Test 5 to `dashboard-timezone.test.ts`, comparing the new double-hop `GROWTH_BY_DAY_SQL` against the ORIGINAL plain-cast expression it replaced (`PLAIN_CAST_GROWTH_SQL`, added only in the test file) under a non-UTC (America/New_York) reading session -- the exact comparison 17-REVIEW.md identified as missing (Test 3 only compared double-hop against single-hop, and only under a UTC session). Verified with `npx tsc --noEmit` (clean). Live-database execution of `dashboard-timezone.test.ts` was not performed in this environment (no Postgres/dev-stack container running here); the test follows the exact structure and helpers of the existing Test 1-4 in the same file, which the phase's own execution already exercised against a real database.

### WR-03: `check-web-chunks.mjs`'s new cycle-detection logic has no unit test coverage

**Files modified:** `scripts/check-web-chunks.mjs`, `scripts/__tests__/check-web-chunks.test.mjs` (new)
**Commit:** `6fa6fb9`
**Applied fix:** Extracted the cycle-vs-`strictExecutionOrder` suppression decision that `main()` previously inlined into a new exported pure function, `evaluateCycleBoundary(manifest, webDir)`, mirroring the existing `evaluateInvariants`/`runValidation` split in `validate-prod-compose.mjs`. `main()` now calls this function instead of duplicating the logic -- behavior unchanged (confirmed via a smoke-test CLI run against a repo with no build manifest, identical error message/exit code to before the change). Added `scripts/__tests__/check-web-chunks.test.mjs` with in-memory manifest fixtures and `vite.config.ts` fixture directories covering all four cases the finding asked for: (1) a 2-node mutual-import cycle -- `findChunkImportCycle` returns it; (2) an acyclic manifest -- returns `null`; (3) a cyclic manifest + a `strictExecutionOrder: true` fixture -- `evaluateCycleBoundary` suppresses the violation; (4) the same cycle without that flag -- a violation naming the cycle is raised. Also added coverage for a 3-node cycle, a dangling import reference, and `viteConfigHasStrictExecutionOrder`'s file-not-found and full-line-comment-stripping behavior. Verified with `node -c` (syntax OK) and `npx vitest run __tests__/check-web-chunks.test.mjs` (12/12 passed).

### WR-04: `docs/runbooks/backups.md`'s WAL-archiving health check contradicts the phase's own ratified production reality

**Files modified:** `docs/runbooks/backups.md`
**Commit:** `2451a65`
**Applied fix:** Replaced the "`failed_count` should stay at zero" instruction in the "Confirming WAL archiving is keeping up" section with the ratified criterion from `17-05-SUMMARY.md`: `archived_count` should strictly increase; `failed_count` should not increase from a recorded baseline reading; `last_failed_time`/`last_failed_wal` should not advance. Added an explicit note that this host's `failed_count` has held at 67 since the 2026-08-14 pgBackRest stanza bring-up (cumulative-since-`stats_reset` semantics), so a nonzero value alone is not an incident signal on this host. Verified by re-reading the modified section (Tier 1 -- markdown has no applicable syntax checker, Tier 3 fallback accepted).

## Skipped Issues

None -- all in-scope findings were fixed.

---

_Fixed: 2026-08-20T03:36:35Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
