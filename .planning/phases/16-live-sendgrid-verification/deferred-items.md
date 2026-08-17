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
