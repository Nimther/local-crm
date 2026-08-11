---
status: resolved
trigger: "PR #8 CI has two clean-runner blockers: Playwright cannot resolve @mega-crm/db source subpaths, and aggregate coverage times out in the campaign-scheduler active pickup probe"
created: 2026-08-11
updated: 2026-08-11
---

## Symptoms

DATA_START
**Expected behavior:**
The required GitHub Actions `e2e` job checks out the PR on a clean runner, installs dependencies, provisions an ephemeral database, and runs the Playwright suite successfully before PR #8 is merged.

**Actual behavior:**
The E2E process exits while Playwright loads its configuration/test-support imports. No ephemeral-database marker is printed and no browser test starts.

The aggregate coverage job independently times out after 60 seconds in
`worker-autorun-default.test.ts` while waiting for the campaign-scheduler
`pickup-probe` job's `active` event. Two consecutive CI runs failed at the
same assertion while the other 1241 tests passed.

**Error messages:**
`ERR_MODULE_NOT_FOUND: Cannot find module node_modules/@mega-crm/db/src/partitions/ensure-partitions.js imported from packages/test-support/src/db-fixture.ts`.

`Test timed out in 60000ms` at
`apps/worker/src/queues/__tests__/worker-autorun-default.test.ts:211`.

**Timeline:**
Observed on 2026-08-11 in both push/PR CI runs for commit `d240c66` on `gsd/phase-12-worker-reliability-tenant-fairness`. Workspace/unit/failure-injection checks pass; the failure appears on a clean install where source `.ts` has not been emitted as `.js`.

**Reproduction:**
Run `npm run test:e2e` from a clean checkout/install matching GitHub Actions (Node 26). The import is resolved through the npm workspace symlink for `@mega-crm/db` and requests a non-existent source `.js` file.

**Constraints:**
- Keep E2E on an isolated ephemeral database and preserve the fail-closed database guard.
- Do not weaken or skip the E2E check.
- Prefer the established monorepo import/build pattern; avoid generated artifacts committed solely for CI.
- Add a regression check that fails before the fix and passes afterward.
DATA_END

## Current Focus

hypothesis: confirmed — the test allowed the factory's unrelated boot scan to become the worker's first active job; with concurrency 1, a slow/blocked boot scan kept the autorun probe waiting even though autorun was healthy.
test: complete — an ACCESS EXCLUSIVE campaigns-table lock makes boot-first ordering fail deterministically and probe-first ordering pass with the same production-shape factory.
expecting: verified
next_action: archived

## Evidence

- RED, deterministic module-resolution repro: from `apps/web`,
  `npx playwright test --list` exited before provisioning with
  `ERR_MODULE_NOT_FOUND` for
  `node_modules/@mega-crm/db/src/partitions/ensure-partitions.js`.
- RED regression guard: the new web Vitest test runs a minimal Playwright
  config that imports `@mega-crm/test-support`. Before the manifest fix it
  failed with the identical stack and URL; after the fix it passes in ~1s.
- The workspace symlink contains `ensure-partitions.ts` only. `node --import
  tsx` can remap the `.js` specifier, but Playwright's config loader delegates
  package-subpath resolution to native ESM and cannot infer the source `.ts`
  target without a package export mapping.
- After the package-resolution fix, a full local E2E run reached the
  `[e2e:database]` marker and exposed a second isolation drift: the API received
  the ephemeral app-role `DATABASE_URL`, but inherited `AUTH_DATABASE_URL` from
  the developer environment. `database-isolation.spec.ts` observed the user in
  the other database (expected 1, received 0). Passing the auth-role DSN for
  the same ephemeral database made the full Playwright suite pass 8/8.
- The aggregate timeout matched the Phase 12 review advisory: the two early
  campaign-scheduler cases closed their Worker and tick Queue but left the
  factory-created, process-tracked kickoff Queue open. After each test stopped
  its throwaway Redis, those stale clients remained in the aggregate process.
  Both handles are now closed in `finally`, and the active-event promise has a
  dedicated 15s diagnostic timeout while still requiring the exact `active`
  event for the probe job.
- GREEN targeted worker suite: 1 file, 9/9 tests.
- GREEN aggregate coverage: 173/173 files, 1242/1242 tests, 142.16s;
  statements 84.91%, branches 74.78%, functions 83.64%, lines 86.36%.
- GREEN full Playwright E2E: 8/8 tests, ephemeral DSN marker printed; both app
  and auth pools were observed on the same `mega_crm_test_e2e_*` database.
- GREEN builds: `apps/web`, `packages/db`, and `packages/test-support`.
- GREEN lint for all touched lint-configured files (the E2E provisioning file
  remains outside the repository's ESLint include, as before).
- REOPENED: GitHub aggregate coverage on merged-with-master SHA `e253cd9`
  deterministically failed the same probe through the new 15s fail-fast:
  `timed out waiting for job pickup-probe to reach active` at line 136. The
  other 172 files / 1241 tests passed. This falsifies the claim that leaked
  kickoff Queue handles were the aggregate pickup root cause.
- The exact aggregate command on `e253cd9` remained locally green before the
  incremental fix (173/173, 1242/1242), confirming the symptom depends on
  runner contention rather than being a universally reproducible production
  failure.
- Deterministic RED harness: hold `LOCK TABLE campaigns IN ACCESS EXCLUSIVE
  MODE`, construct the production-shape scheduler, await its registration/boot
  enqueue, then add `pickup-probe`. The boot job becomes active and blocks in
  the campaign scan; BullMQ concurrency 1 leaves the probe waiting, producing
  the exact `timed out waiting for job pickup-probe to reach active` failure in
  15.2s (1 failed, 8 passed).
- Deterministic GREEN harness: under the same database lock, enqueue and assert
  the probe is `waiting` before constructing the exact single-argument
  production factory. The probe is therefore the first consumable job; the
  Worker's exact `active` event fires, proving autorun consumption independent
  of the later boot scan. Targeted suite: 9/9 in 3.38s and 9/9 in 4.56s on the
  cleanup-finalized version.
- Final exact aggregate after the incremental fix: `npm run coverage` passed
  173/173 files and 1242/1242 tests in 143.81s; statements 85.15%, branches
  74.78%, functions 84.00%, lines 86.57%.

## Eliminated

- Application/runtime partition code defect: the failure occurs before
  `provisionE2eDatabase()` executes and before any database connection exists.
- Missing source file: `ensure-partitions.ts` exists at the workspace target;
  only the requested `.js` package subpath was unresolved.
- Missing dependency install or stale local artifact: reproduction uses the
  live workspace symlink and passes without generated `.js` after adding the
  explicit export map.
- BullMQ autorun regression: the production-shape worker remains running and
  all 9 focused autorun cases pass. The aggregate-only hang was test-resource
  lifecycle debt, not a disabled processing loop.
- Weakening the pickup assertion to queue-state polling: rejected. The guard
  continues to require the worker's `active` event for the exact job id.
- Leaked kickoff Queue handles as the pickup timeout root cause: falsified by
  the same deterministic GitHub failure after both handles were explicitly
  closed. The cleanup remains correct test hygiene but is not causal.
- Worker readiness/autorun itself: eliminated by the deterministic probe-first
  test. The same factory and Redis instance emit `active` promptly even while
  the campaigns table prevents the processor from completing.

## Resolution

root_cause: `@mega-crm/db` exposed TypeScript source through `main` but had no `exports` rule mapping the repository's `.js` deep-import convention to `.ts`, which Playwright's native ESM config loader requires. E2E also inherited an auth-role DSN for another database instead of deriving it from the ephemeral app DSN. Independently, the aggregate autorun test constructed the scheduler before enqueueing its probe; the factory concurrently registers an unrelated boot job. Under CI database contention that boot scan could become active first and occupy BullMQ's sole concurrency slot, so the probe remained waiting even though the production run loop was healthy. Queue-handle leaks were real cleanup debt but not the timeout cause.
fix: Kept the prior package export, E2E DSN, Queue cleanup and bounded-wait fixes. Hardened the autorun test by pre-seeding `pickup-probe` and asserting it is waiting before constructing the exact single-argument production factory. Added a real Postgres table lock so a boot job overtaking the probe would fail deterministically; release and all Worker/Queue/Pool handles are unconditional in `finally`. The assertion still requires the Worker's exact `active` event for the probe id.
verification: Deterministic boot-first RED reproduced the exact 15s error; probe-first targeted suite passed 9/9 twice; exact `npm run coverage` passed 173/173 files and 1242/1242 tests in 143.81s. Prior E2E verification remains 8/8 and package-resolution regression 1/1.
files_changed: packages/db/package.json; apps/web/e2e/package-source-import.config.ts; apps/web/src/__tests__/playwright-package-source-import.test.ts; apps/web/src/__tests__/fixtures/playwright-source-import/source-import.spec.ts; apps/web/e2e/provision-database.ts; apps/web/playwright.config.ts; apps/worker/src/queues/__tests__/worker-autorun-default.test.ts
