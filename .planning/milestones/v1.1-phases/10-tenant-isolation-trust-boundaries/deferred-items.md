# Deferred Items — Phase 10 Plan 10-07

## Pre-existing test-isolation flake under the full-repo `npm run coverage` aggregate run

**Found during:** Task 3's final `npm run coverage` verification pass.

**Symptom:** `apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts` — 4 of its 8
tests fail with `TypeError: Cannot read properties of undefined (reading 'map')` inside
`packages/segments-core/src/compile.ts`'s `compileSegmentDefinition`, meaning the
`definition` object read back from `segments.definition` for that test's own fixture is
missing its `groups` field at the moment `flow-segment-sweep.worker.ts`'s
`sweepOneFlow` reads it.

**Reproduced twice, deterministically** (same 4 test names, same file) under `npm run
coverage` at the repo root. The SAME file passes 8/8, reliably, every time, when run in
isolation (`cd apps/worker && npx vitest run
src/queues/__tests__/flow-segment-trigger.test.ts`) and as part of the full
`apps/worker` suite (`cd apps/worker && npx vitest run` — 125/125 passing).

**Why this is out of scope for plan 10-07 (SEC-03/SEC-04):**

- The failure signature has no connection to RLS: it is a plain JS `TypeError` on a
  missing object property, never a Postgres error, and never matches either of this
  plan's fail-closed error classes (`unrecognized configuration parameter` /
  `invalid input syntax for type uuid`).
- `flow-segment-sweep.worker.ts`'s read path is `withCrossWorkspaceScan()` (the
  `flows_scan` policy, `TO mega_crm_scan`, untouched by migration 0044) for
  cross-workspace discovery, then `withTenant(row.workspaceId) →
  withTenantTransaction()` (properly tenant-scoped, `TO mega_crm_app`) for
  `loadSegmentDefinition`. Migration 0044 only changes the fail-closed/fail-open
  behaviour of `workspace_isolation` for a connection with NO tenant context or a
  reverted-to-`''` one — a properly-scoped read (real workspaceId set) evaluates the
  exact same `workspace_id = current_setting(...)::uuid` comparison before and after
  this migration.
- Migration 0044 never touches `flows_scan`, `segments`, or any other scan-role
  policy — only `workspace_isolation` (22 tenant tables) and the two pre-tenant
  lookup policies (`api_key_runtime_lookup`, `webhook_endpoint_runtime_lookup`).
  `segments` carries no scan-role policy at all.
- Most likely mechanism (not confirmed further, out of scope to chase): the aggregate
  `npm run coverage` run exercises every package's test files together against one
  shared physical test database, and `flow-segment-sweep.worker.ts`'s cross-workspace
  scan has no way to filter to "only this test file's own fixtures" by design — a
  concurrently-running test file's own live, segment-triggered flow fixture could be
  picked up by this test's own sweep tick (or vice versa), a pre-existing test-harness
  isolation gap for any scan-based worker test run under the monorepo-wide aggregate,
  unrelated to this plan's RLS predicate change.

**Action:** Not fixed — out of scope per the Scope Boundary rule ("Only auto-fix issues
DIRECTLY caused by the current task's changes"). Every suite this plan's own
`<verification>` block enumerates individually (`packages/tenant-context`, `apps/api`,
`apps/worker`, `packages/db`) passes 100% cleanly in isolation, along with
`lint:migrations`, `lint:session-state`, and `lint`. Flagged here for a future phase
or a dedicated test-infrastructure fix (e.g., ephemeral per-file databases for
scan-based worker tests) rather than folded into this plan's own scope.

## Recurrence under plan 10-09 (SEC-05/SEC-12, Better Auth trust boundary)

**Found during:** plan 10-09's own final `npm run coverage` verification pass, run twice
for reproducibility.

**Same symptom, same 4 test names, same file, same error** as the entry above:
`apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts` fails 4/8 with the
identical `TypeError: Cannot read properties of undefined (reading 'map')` inside
`compileSegmentDefinition`, only under the full monorepo `npm run coverage` aggregate --
8/8 passing every time in isolation and as part of the full `apps/worker` suite
(verified 32/32 passing standalone during this plan's own work).

**Why this is out of scope for plan 10-09 (SEC-05/SEC-12) specifically:** migration 0045
touches only the seven better-auth tables' grants (`user`/`session`/`account`/
`verification`/`organization`/`member`/`invitation`); it grants or revokes nothing on
`segments`, `flows`, `flow_segment_membership_snapshot`, or any scan-role policy
`flow-segment-sweep.worker.ts` reads through. The failure is a plain JS `TypeError` on a
malformed in-memory object, not a permission or RLS error of any class this plan's own
grant matrix could produce. A `git worktree` diff-check against the pre-phase-10-09 base
commit was attempted to confirm pre-existence directly but was inconclusive (the
worktree's symlinked `node_modules` resolved workspace packages back to the live
checkout rather than the base commit's own sources) -- the prior, independently-arrived-at
10-07 root-cause analysis above is taken as authoritative instead, since it already rules
out every mechanism this plan's changes could plausibly have introduced.

**Action:** Not fixed, for the same reason as the 10-07 entry above. Every suite this
plan's own `<verification>` block enumerates individually (`npx vitest run --root
apps/api`, `npm run lint:migrations`, `npm run lint`,
`npm run build --workspaces --if-present`) passes 100% cleanly, and the full
`apps/worker` suite passes 32/32 standalone. Still flagged as an open
test-infrastructure gap for a future phase.

## `npm run test:e2e` fails to even load Playwright's config in this environment — pre-existing, unrelated to plan 10-09

**Found during:** plan 10-09's own `npm run test:e2e` verification pass.

**Symptom:** `playwright test` fails before running a single spec, with
`ERR_MODULE_NOT_FOUND` on `node_modules/@mega-crm/db/src/partitions/ensure-partitions.js`
(a deep-specifier `.ts` source import, per `packages/test-support/src/db-fixture.ts`'s
09-03 precedent, that Node's own ESM loader cannot resolve to the `.ts` file under this
Node runtime).

**Confirmed pre-existing and unrelated to this plan:** reproduced identically, byte-for-byte
same stack trace, with every one of this plan's working-tree changes stashed back to the
last committed state (`git stash` → `npm run test:e2e` → same `ERR_MODULE_NOT_FOUND` →
`git stash pop`). This plan's changes never touch
`packages/db/src/partitions/ensure-partitions.ts`, `packages/test-support/src/db-fixture.ts`,
or the Playwright config -- the failure is an environment/Node-version module-resolution
gap (`node --version` in this sandbox: v26.0.0) predating any work in this plan.

**Action:** Not fixed -- out of scope (Node runtime / module-resolution environment
concern, not a Better Auth trust-boundary code change). Flagged here rather than silently
skipped so a future phase's environment/tooling work can pick it up.

## RESOLVED — the two `flow-segment-trigger.test.ts` entries above (debug session `aggregate-coverage-run-fails`)

Both entries above are the same defect and are now fixed. The 10-07 entry's "most likely
mechanism (not confirmed further)" was correct — every project really was sharing one
physical test database — and this session confirmed it directly and found the reason.

**Root cause (confirmed, two conditions AND-ed):**

1. `packages/test-support/src/global-setup.ts` published its per-project ephemeral DSN by
   mutating the shared parent `process.env`. Vitest runs every project's `globalSetup`
   sequentially in ONE parent process before forking any worker
   (`Vitest.initializeGlobalSetup`), so with five projects registering that hook it was
   last-writer-wins: five databases provisioned, every project's workers handed the fifth
   one's DSN. Confirmed by probe — the second invocation observed the first's DSN already
   in `process.env`, and `packages/tenant-context`'s workers were measured reading
   `..._mega_crm_worker_<id>`.
2. `packages/tenant-context/src/__tests__/scan.test.ts` seeded `definition =
   {operator:"and",conditions:[]}` — not a `SegmentDefinition` — on flows that are
   `status='live' AND trigger_type='segment'` with a `live_version_id`, i.e. exactly the
   rows `findLiveSegmentTriggeredFlows()` selects. Once the database was shared,
   `apps/worker`'s deliberately cross-tenant sweep compiled them and threw.

Removing either condition makes the failure disappear — verified in both directions.
`--coverage` was never a factor: `npx vitest run scan.test.ts flow-segment-trigger.test.ts`
reproduces all four failures with no coverage flag. Coverage was simply the only aggregate
entrypoint anyone ran.

**Fix:** the DSNs are published into vitest's per-project `config.env` channel (see
SPECIFICATION.md §3.2.1), restoring the one-database-per-project intent that
`buildEphemeralDatabaseName`'s `mega_crm_test_<workspace>_<runId>` scheme has encoded since
08-02. `GSD_DEV_DATABASE_URL` is no longer overwritten on the 2nd..Nth invocation — that
overwrite had been silently making both fail-closed guard layers compare one ephemeral DSN
against another. A new D-14 layer c makes any future recurrence announce itself explicitly
instead of surfacing as a `TypeError` in unrelated code.

Also fixed in the same session: the third failure in that aggregate run
(`webhook-events-sibling-drop.test.ts` Test 4 seeing `owningWorkspaceId: "[REDACTED]"`) is
an INDEPENDENT ~4%-per-run defect — the `phone` valueRule matched ~4% of random v4 UUIDs.
See SPECIFICATION.md §7.

**Verification:** `npm run coverage` 135/135 files, 868/868 tests, exit 0, three
consecutive runs; `npm run test`, `npm run lint`, `npm run build` (typecheck) and
`npm run coverage:gate` all green.
