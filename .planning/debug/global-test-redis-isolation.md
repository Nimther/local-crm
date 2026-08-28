---
status: verifying
trigger: "WINDOWS id 14: test harness never clears the shared Redis logical DB"
created: 2026-08-28
updated: 2026-08-28
tdd_phase: green
---

## Symptoms

DATA_START
- expected: Every Vitest run that uses the shared integration-test Redis starts from an empty, explicitly test-only logical database; the harness must refuse DB 0 or an implicit database before issuing any destructive command.
- actual: `packages/test-support/src/global-setup.ts` provisions and guards an ephemeral Postgres database but does not inspect or clear Redis. BullMQ jobs survive across local runs without bound on `redis://localhost:6379/1`.
- errors: No direct setup error. The residue becomes serial inherited workload when a test constructs a real Worker; this caused the resolved `flow-run-advance` timeout flake. The measured keyspace contained tens of thousands of waiting jobs across several queues.
- timeline: Pre-existing harness gap, recorded as `.planning/WINDOWS.md` id 14 after resolving the queue-specific flow-run fix.
- reproduction: Seed a BullMQ-like key in explicit test DB 1, invoke the global setup Redis preparation twice, and observe that today no cleanup path or fail-closed URL guard exists. Separately prove DB 0 and URLs without an explicit DB index are rejected before any Redis client is created.
DATA_END

## Current Focus

bug_class: Bohrbug (deterministic harness omission)
hypothesis: CONFIRMED. The global test setup had no Redis boundary; the fix adds a once-per-process preparation step that first validates an explicit logical DB index >= 1 and then issues FLUSHDB only for that database.
test: Add focused unit tests around a pure URL guard and an injected cleanup seam, plus an integration-style setup test proving cleanup happens once across multiple project setup calls.
expecting: RED because neither the guard nor the once-per-run cleanup exists.
next_action: Push the branch and let GitHub CI prove the full aggregate suite against its isolated Redis service. If green, mark WINDOWS id 14 fixed and archive this session.

## Evidence

- timestamp: 2026-08-28
  checked: `packages/test-support/src/global-setup.ts`
  found: Postgres is provisioned, guarded, published per project, and torn down; Redis is never referenced.
  implication: The class-level isolation gap in WINDOWS id 14 is present on current master.

- timestamp: 2026-08-28
  checked: `apps/worker/vitest.base.config.ts`, `apps/api/vitest.config.ts`, and CI env
  found: Integration tests resolve `REDIS_URL` from `TEST_REDIS_URL` with the explicit default `redis://localhost:6379/1`; CI also sets DB 1. The dev worker uses DB 0.
  implication: A fail-closed `db >= 1` rule matches the existing boundary and can reject the dangerous DB 0/implicit cases.

- timestamp: 2026-08-28 (RED)
  checked: `npm exec -- vitest run --root packages/test-support src/__tests__/test-redis-isolation.test.ts`
  found: 1 file failed; all 11 new tests failed against the deliberately unimplemented guard/preparer seams. Safe DB-1/DB-15 URLs were rejected, invalid/DB-0 cases did not emit the required fail-closed error, and once-per-run cleanup was absent.
  implication: The regression contract is executable and RED for the intended missing behavior rather than for an unrelated pre-existing failure.

- timestamp: 2026-08-28 (safety checkpoint)
  checked: proposed sentinel proof against the developer machine's shared Redis DB 1
  found: local destructive `FLUSHDB` verification was intentionally not performed because the database may contain other local test data.
  implication: Verify the real command against a throwaway `redis-server` instead; reserve the full shared-DB wiring proof for GitHub CI's isolated Redis service.

- timestamp: 2026-08-28 (GREEN)
  checked: the unchanged RED suite plus the real cleanup integration test
  found: 2 files passed, 12/12 tests passed. The integration test started a throwaway Redis on a random port, seeded DB 0 and DB 1, ran the real cleanup against DB 1, observed DB 1 empty, and observed the DB-0 sentinel unchanged.
  implication: The destructive primitive is bounded to the guarded logical database and the regression contract is GREEN.

- timestamp: 2026-08-28 (wiring + static gates)
  checked: `global-setup-project-isolation.test.ts`, package TypeScript build, and ESLint on all touched files
  found: wiring tests 6/6 passed; TypeScript build passed; ESLint passed with zero errors.
  implication: globalSetup resolves TEST_REDIS_URL into the preparation boundary without regressing per-project Postgres isolation.

## Eliminated

- hypothesis: A Redis cleanup already exists elsewhere in the test harness.
  evidence: Repository search found no `flushdb`, `flushall`, `obliterate`, or equivalent global cleanup in test-support or worker setup.
  timestamp: 2026-08-28

## Resolution

root_cause: "The shared test Redis logical DB survived across runs because global-setup guarded and recreated only Postgres; no Redis URL boundary or cleanup existed."
fix: "Guard an explicit redis/rediss logical DB index >= 1, run FLUSHDB once per parent process, fail on URL drift, and wire it before Postgres provisioning."
verification: "RED 11/11 -> GREEN 12/12 including an isolated real-Redis proof; wiring 6/6; TypeScript and ESLint green. Full aggregate CI pending."
files_changed:
  - packages/test-support/src/redis-guard.ts
  - packages/test-support/src/global-setup.ts
  - packages/test-support/src/__tests__/test-redis-isolation.test.ts
  - packages/test-support/src/__tests__/test-redis-cleanup.integration.test.ts
  - packages/test-support/src/__tests__/global-setup-project-isolation.test.ts
