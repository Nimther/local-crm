# Deferred Items — Phase 16 (out-of-scope discoveries)

## 16-01: pre-existing repo-wide `npm run lint` failure (unrelated to this plan)

- **Found during:** Task 1 verification (`npm run lint`).
- **File:** `apps/worker/src/__tests__/correlation-tracer.test.ts:231:122`
- **Error:** `@typescript-eslint/require-await` — `Async arrow function 'sendMail' has no 'await' expression`.
- **Introduced by:** commit `b22e045` (`feat(15-19): bind sendId into correlation store on all three dispatch paths`), part of Phase 15, before this plan touched anything.
- **Confirmed pre-existing:** `git status --short` shows this file with zero local modifications; the error reproduces on a clean checkout at `HEAD` before any 16-01 change.
- **Scope decision:** out of scope for 16-01 per the executor's SCOPE BOUNDARY rule — this file is not in 16-01's `files_modified` list and the bug was not introduced by this plan's changes. Not fixed here.
- **Effect on this plan's own verification:** `npm run lint` (repo-wide) currently exits non-zero because of this ONE pre-existing error, unrelated to `scripts/uat-verify.mjs`. Isolated verification confirms 16-01's own files are clean:
  ```
  npx eslint scripts/uat-verify.mjs scripts/__tests__/uat-verify.test.mjs
  ```
  exits 0 with zero errors/warnings.
- **Precedent:** matches the class of issue WINDOWS.md rows 6/7 record from Phase 12 (`graceful-shutdown.test.ts`/`shared-error-listener.test.ts` — pre-existing `require-await` errors discovered by a plan executor, fixed by the orchestrator post-wave, not by the plan itself).
- **Recommended follow-up:** fix at the wave/phase level (remove `async` from the `sendMail` stub at that line, or add an `await`), then re-verify `npm run lint` exits 0 repo-wide.

## 16-02: repo-wide `npm run lint` blocked by a sibling worktree's tsconfig.json (mixed-wave environmental collision, not caused by this plan)

- **Found during:** Task 1 verification (`npm run lint`).
- **Symptom:** `eslint . --max-warnings=0` reports 480 `Parsing error: No tsconfigRootDir was set, and multiple candidate TSConfigRootDirs are present` errors, across BOTH files this plan touched (`scripts/uat-verify.mjs`) AND files it never touched (`scripts/validate-alloy-config.mjs`, `scripts/validate-prod-compose.mjs`, `scripts/verify-redis-config.mjs`, `vitest.config.ts`).
- **Root cause:** this session's mixed wave runs a second executor for plan 16-03 inside an isolated worktree at `.claude/worktrees/agent-a4c11ea04669a2a92`, which is nested INSIDE this repo's own directory tree and carries its own full set of `tsconfig.json` files (one per workspace). typescript-eslint's root-dir auto-detection, when scanning from the repo root, finds two candidate roots (this checkout and the nested worktree) and refuses to guess — an ambiguity, not a code defect.
- **Confirmed pre-existing/environmental, not plan-caused:** the same parsing error hits files this plan never modified (`validate-alloy-config.mjs` etc.), proving the failure is unrelated to `scripts/uat-verify.mjs`'s content.
- **Scope decision:** out of scope for 16-02 — fixing it would mean either deleting/relocating the sibling worktree (not this plan's to touch — it is the parallel 16-03 executor's isolated workspace) or editing the repo's root ESLint config to pin `tsconfigRootDir` (an architectural change to shared tooling config, Rule 4, requiring a separate decision — not something to fix mid-plan). Not fixed here.
- **Effect on this plan's own verification:** isolated verification confirms 16-02's own files are clean:
  ```
  npx eslint scripts/uat-verify.mjs scripts/__tests__/uat-verify.test.mjs
  ```
  exits 0 with zero errors/warnings/parsing-errors.
- **Recommended follow-up:** re-run `npm run lint` repo-wide once the mixed wave completes and the sibling worktree (`.claude/worktrees/agent-a4c11ea04669a2a92`) is cleaned up by the orchestrator's wave-cleanup step.
