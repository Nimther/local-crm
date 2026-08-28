---
status: resolved
trigger: flow-run-advance-shared-redis-isolation
created: 2026-08-28
updated: 2026-08-28
tdd_phase: green
---

## Symptoms

DATA_START
- expected: `flow-run-advance.test.ts` and `flow-run-advance-integration.test.ts` (apps/worker/src/queues/__tests__/) pass reliably in full-suite runs (root aggregate / `npm run coverage` / CI job `test`), same as they do in isolation.
- actual: flow-run-advance tests flake under full-suite load; they pass when the file is run in isolation (isolation-pass = flake signature). Flakes reproduce locally even with the dev stack stopped, and appear alongside advisory-lock test flakes.
- errors: intermittent test failures in flow-run-advance suites during multi-file runs (exact assertion output to be captured during reproduction).
- timeline: ongoing, known flake recorded in project notes at least since ~2026-08-20 (`ci-tenant-fairness-double-run` era); never fully stabilized.
- reproduction: run the full worker suite (or root aggregate with coverage) repeatedly; flake is load-dependent, not deterministic. Single-file runs pass.
- user hypothesis (from trigger description): shared Redis isolation — worker tests default `REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1"` (apps/worker/vitest.base.config.ts:137), so real BullMQ Queue/Worker pairs in flow-run-advance-integration share one Redis logical DB with anything else using it (other app suites, leftover keys from prior runs). `fileParallelism: false` already mitigates intra-worker-suite job stealing, but cross-suite / cross-run Redis state is still shared.
- prior related work: vitest.base.config.ts comments document that flow-run-advance-integration.test.ts previously stole sibling files' jobs (fixed via fileParallelism: false); CI notes also record a "temp-redis port-1" flake signature where vitest fails with all tests passing.
DATA_END

## Current Focus

bug_class: Mandelbug (load-dependent, non-deterministic under full-suite; deterministic once the interfering state is seeded explicitly). SBFL not applicable (no per-test coverage lane for a flake).

hypothesis (H1, starvation): CONFIRMED. flow-run-advance-integration.test.ts registers a real BullMQ Worker with DEFAULT concurrency (1) on the globally-shared FLOW_RUN_ADVANCE_QUEUE, on a shared Redis logical DB (db 1) with no per-run prefix and no cleanup. Its own advance jobs are therefore FIFO-queued BEHIND every foreign/residual `wait` job on that queue (never-consumed leftovers from prior runs, dominant; siblings' un-consumed advance jobs from the same run, minor). Each foreign job costs a serial Postgres transaction, so a large enough backlog pushes the test's own hops past its 10s `waitFor` deadline -> "waitFor: condition not met within 10000ms".
test: seeded 12000 schema-valid foreign advance jobs onto bull:flow-run-advance on db 1, then ran flow-run-advance-integration.test.ts in ISOLATION; plus an N=0 control run.
expecting: seeded = RED with a waitFor timeout; N=0 control = GREEN.
result: EXACTLY that. Control (wait=0) GREEN in 1.43s. Seeded (wait=12000) RED — BOTH scenarios failed with the verbatim reported symptom `waitFor: condition not met within 10000ms`. See Evidence.

tdd_checkpoint:
  test_file: "apps/worker/src/queues/__tests__/flow-run-advance-queue-isolation.test.ts"
  test_name: "flow-run-advance: shared-Redis queue isolation" (2 cases: clock-free invariant + symptom-level budget)
  status: "green"
  confirmed_by: "debug-session-manager, independent foreground re-run 2026-08-28 (see final Evidence entry). Deterministic; real assertion output; not a harness confounder. Cleared to proceed to GREEN."
  failure_output: |
    × the real Worker starts on a queue with no foreign jobs on it
      AssertionError: foreign jobs left on the shared flow-run-advance queue are inherited
      as this suite's own serial workload: expected 12000 to be +0
    × advances its own run within the same 10s budget the integration suite uses, with residue present
      Error: waitFor: flow run did not reach 'completed' within 10000ms
      (status=advancing, foreign jobs still queued ahead of it=7396, node=send-1)
  green_output: |
    Test Files  1 passed (1)
         Tests  2 passed (2)
      Duration  3.14s   (RED was 12.81s -- the 10s waitFor was being consumed by the backlog)

reasoning_checkpoint:
  hypothesis: "Foreign BullMQ jobs accumulated on the shared, never-cleaned test Redis logical DB (db 1) are inherited as serial workload by flow-run-advance-integration.test.ts — the suite's ONLY real consumer of that globally-shared queue, running at BullMQ's default concurrency of 1 — so the test's own advance jobs sit behind that backlog in the FIFO wait list and miss their 10s waitFor deadline."
  confirming_evidence:
    - "Direct observation: seeding 12000 foreign jobs and running the untouched flaking file in ISOLATION reproduces the verbatim reported symptom on both scenarios ('waitFor: condition not met within 10000ms'), while the same file on an empty queue passes in 1.43s."
    - "Direct measurement: 2.15 ms/job drain rate (2000 foreign jobs drained in 4310ms) at concurrency 1 => ~4650 jobs exhaust a 10s budget on an IDLE machine, less under load."
    - "Direct observation of the live shared DB: unbounded never-consumed accumulation across every queue (webhook-events wait=21973, flow-trigger-evaluator 3180, email-triggered 2911, erasure-scrub 2881, ...), and 752 waiting flow-run-advance jobs present before this session drained them."
    - "Code: createFlowRunAdvanceWorker passes `{ connection }` only — BullMQ default concurrency 1. No Redis cleanup exists anywhere in the harness (grep for flushdb/flushall/obliterate/drain/clean over test-support + worker test dirs returns nothing); globalSetup guards Postgres only."
  falsification_test: "Run the untouched integration file in isolation against an EMPTY flow-run-advance queue. If H1 were false it would still fail (or seeding 12000 jobs would not make it fail). It passed clean at N=0 and failed at N=12000 — H1 survives; the converse would have killed it."
  fix_rationale: "The defect is a test-harness isolation gap, not a production defect — a shared production queue legitimately has a backlog, and processFlowRunAdvance handles foreign/stale jobs correctly (fast no-op via the queue-as-doorbell guards). What is wrong is that the suite starts a real consumer on a shared keyspace it never isolates. Emptying the flow-run-advance queue immediately BEFORE the Worker is constructed removes both inflows (cross-run residue AND same-run sibling backlog) at the one instant that matters, and touches no production code."
  blind_spots:
    - "H2 (below) is not excluded: pure Postgres/coverage load could independently exhaust the 10s budget with an EMPTY queue. This fix removes one sufficient cause; it cannot prove it was the only one."
    - "The 752-job pre-existing backlog was destroyed by this session's own baseline drain before it could be captured as a full keyspace dump — the count is recorded, the payloads are not."
    - "Only apps/worker was exercised. apps/api points at the same db 1 but its config states tests never open a real socket; not empirically verified."
  candidate_causes:
    - "config: shared Redis logical DB 1 across all projects/runs, no per-run BullMQ prefix, no cleanup in globalSetup (CONFIRMED — dominant)"
    - "code: createFlowRunAdvanceWorker's default concurrency of 1 makes every foreign job a serial cost (CONFIRMED — necessary co-factor)"
    - "environment: machine/CI load + v8 coverage instrumentation inflating per-job cost (CONTRIBUTING — sets where the threshold lands)"
    - "data: unbounded monotonic growth of residual jobs, with a positive feedback loop — a run that times out leaves most of its inherited backlog behind for the next run (CONFIRMED: the seeded RED run left 7106 waiting jobs behind)"
  and_gate: "YES — this failure requires >1 condition simultaneously: (a) foreign backlog on the shared queue AND (b) a serial concurrency-1 consumer AND (c) a fixed 10s deadline AND (d) enough per-job cost for backlog x cost to exceed the deadline. Remove any one and the flake disappears, which is why it presents as load-dependent rather than deterministic. The fix targets (a) because it is the only one that is purely accidental — (b)/(c) are legitimate test design and (d) is the environment."

hypothesis (H2, standing alternative — NOT excluded): with an EMPTY queue, Postgres/coverage load alone (the same load that produces the co-occurring advisory-lock flakes) exhausts the 10s waitFor. If the flake signature survives the H1 fix, this is the next branch — NOT a regression of the H1 fix, and H1 should not be re-litigated. Note the scope asymmetry: H1's cross-run residue is a LOCAL-ONLY mechanism (CI's own "temp-redis port-1" signature implies a fresh per-run Redis, and flow-run-advance is absent from the recorded CI flake list), which is consistent with this flake being recorded against local full-suite runs. H2 would apply in both environments.

branch state: the RED test is UNTRACKED on `fix/uuid-redacted-as-phone` — the branch of an already-resolved, unrelated bug. Nothing is committed. The green phase must branch deliberately before committing; an untracked file survives a branch switch, so no action is needed beforehand.

next_action: RESOLVED — three post-fix root aggregate coverage runs completed on 2026-08-28 without a recurrence of the flow-run-advance timeout. One run was fully green; the other two failed only in independent Sentry and cross-tenant fixture tests. Archive this session, keep the class-level Redis cleanup follow-up as WINDOWS id 14, and deliver commit 3e9941e.

## Evidence

- timestamp: 2026-08-28
  checked: `.planning/debug/knowledge-base.md` (Phase 0) for prior matches on the flake keywords.
  found: `ci-tenant-fairness-double-run` (2026-08-20) is the closest prior entry — it records that the aggregate run executes on top of "the Postgres/Redis state ~60 sibling worker test files have already accumulated in the shared ephemeral database", and that flow-run-advance-integration.test.ts previously STOLE sibling files' jobs (fixed with `fileParallelism: false`).
  implication: shared, uncleaned Redis state on db 1 is already an acknowledged property of this suite. The prior fix addressed one DIRECTION of the interference (integration worker eats siblings' jobs); it did not address the reverse direction (siblings' + prior runs' jobs eat the integration worker's throughput).

- timestamp: 2026-08-28
  checked: `apps/worker/vitest.base.config.ts:137`, `apps/api/vitest.config.ts:40`, root `vitest.config.ts`, `packages/test-support/src/global-setup.ts`, and every `packages/*/vitest.config.ts`.
  found: REDIS_URL for BOTH apps/worker and apps/api defaults to `redis://localhost:6379/1`. There is no per-run BullMQ `prefix`, no per-run logical DB, and NO Redis cleanup anywhere: `grep -rn "flushdb|flushall|obliterate|drain|clean("` over packages/test-support and apps/worker/test returns nothing. globalSetup mentions Redis not at all — it only guards the ephemeral Postgres DB.
  implication: Postgres is per-run ephemeral; Redis is NOT. Every test run inherits the previous run's queue state. This is the isolation asymmetry at the root of the hypothesis.

- timestamp: 2026-08-28
  checked: live keyspace on `redis://localhost:6379/1` (`redis-cli -n 1 --scan --pattern 'bull:*'`).
  found: 21980 `bull:webhook-events` keys, 3188 `bull:flow-trigger-evaluator`, 2921 `bull:email-triggered`, 889 `bull:flow-run-advance`, plus ~20 dead `bull:fairness-broadcast-*` queues from long-finished load tests. Of the 889 flow-run-advance keys, 752 are orphaned job hashes of shape `<uuid>-<13-digit ms>` (the post-CR-01 unique-per-wake jobId) and ~130 are BARE-UUID job hashes (`bull:flow-run-advance:<uuid>` = the PRE-CR-01 `jobId: flowRunId` shape, i.e. leftovers predating the 06-12 fix). State lists right now: wait 0, active 0, paused 0, failed 0, completed 0, delayed 31.
  implication: months of accumulated cross-run residue confirmed on the shared DB, and it is unbounded — nothing ever removes it. `wait` reading 0 is consistent with the mechanism rather than against it: the integration test's own Worker is the ONLY consumer of that queue in the whole suite, so it drains whatever is waiting at the moment it starts — the cost lands on the test that does the draining.

- timestamp: 2026-08-28
  checked: `createFlowRunAdvanceWorker` in `apps/worker/src/queues/flows/flow-run-advance.worker.ts` (last lines) — the Worker options the integration test constructs.
  found: `new Worker(FLOW_RUN_ADVANCE_QUEUE, wrapProcessor(...), { connection })` — no `concurrency`, so BullMQ's default of 1 applies. Every job (foreign or own) is processed strictly serially, and each one opens a `withTenantTransaction` Postgres transaction.
  implication: throughput is 1 job per DB round-trip. A backlog of foreign jobs translates directly into wall-clock delay ahead of the test's own hops, and the test's budget is a 10s `waitFor` per hop.

- timestamp: 2026-08-28
  checked: every producer onto FLOW_RUN_ADVANCE_QUEUE (`grep -rln enqueueFlowRunAdvance|flowRunAdvanceQueue`) and the sibling assertions at flow-trigger-evaluator.test.ts:163, flow-segment-trigger.test.ts:301, flow-run-advance.test.ts:370/415.
  found: producers are flow-run-advance.worker.ts (forward nudges), handlers/delay-node.ts + handlers/send-node.ts, flow-trigger-evaluator.worker.ts, flow-enroll-existing.worker.ts, flow-reconciliation.worker.ts, plus the three sibling TEST files. The integration test is the ONLY consumer in the suite. All four sibling assertions filter by `data.flowRunId` (`.find((j) => j.data?.flowRunId === ...)`), so they are count-collision-safe.
  implication: two conclusions. (1) The sibling tests are NOT the flaking assertions — rules out shared-queue count collisions as the mechanism. (2) Producer/consumer asymmetry is total: many files enqueue, exactly one file consumes, nothing cleans up. Whatever the siblings and prior runs leave behind is paid for, serially, by flow-run-advance-integration.test.ts.

- timestamp: 2026-08-28
  checked: MEASUREMENT ERROR CORRECTION. The first state-depth sweep used `redis-cli llen bull:$q:wait` — the documented zsh colon-modifier trap (`"bull:$q:wait"` mangles the expansion). Re-measured with `"bull:${q}:wait"`.
  found: the original sweep's "wait=0" readings were false. Correct depths on db 1: webhook-events wait=21973, flow-trigger-evaluator wait=3180, email-triggered wait=2911, erasure-scrub wait=2881, flow-segment-sweep-flow wait=1269, email-broadcast wait=941, campaign-kickoff wait=429, imports-csv wait=375. The 752 `<uuid>-<ms>` flow-run-advance job hashes seen earlier were WAITING jobs (they vanished when this session's probe called `drain(true)`, which only touches wait/paused/prioritized/delayed — that is what identifies them); the 130 surviving bare-uuid hashes are retained COMPLETED jobs from the pre-CR-01 `jobId: flowRunId` era.
  implication: this is the core datum. Every test run leaves waiting BullMQ jobs on the shared logical DB permanently. For 8 of these 9 queues that residue is inert (the suite has no consumer for them). flow-run-advance is the sole exception — it is the one queue with a real Worker in the suite, so its residue is not dead weight but WORK, performed serially, inside a 10s deadline, by the flaking test itself.

- timestamp: 2026-08-28
  checked: drain-rate sizing probe (throwaway test, since deleted): seed N schema-valid foreign advance jobs whose runs are absent from this run's ephemeral DB, start the real Worker via `createFlowRunAdvanceWorker`, poll until waiting+active reach 0.
  found: 2000 jobs seeded in 223ms, drained in 4310ms => 2.15 ms/job on an IDLE machine. Implied threshold: ~4650 foreign jobs exhaust a 10s `waitFor` budget with zero load.
  implication: quantifies the mechanism. The observed 752-job backlog costs ~1.6s idle — invisible. Under v8 coverage instrumentation plus concurrent Postgres load (3-10x per-job cost) the same backlog costs 5-16s and starts crossing the 10s deadline. That is precisely a load-dependent flake that passes in isolation.

- timestamp: 2026-08-28
  checked: intra-run contribution. Baseline drained to 0, then ran the four sibling producer files (flow-run-advance, flow-trigger-evaluator, flow-segment-trigger, flow-send-idempotency) with the integration file EXCLUDED, then measured.
  found: 28 tests passed; residual wait=17, delayed=4.
  implication: the same-run sibling backlog is negligible (~37ms of drain). The dominant inflow is CROSS-RUN accumulation. Both are removed by the same fix (empty the queue at Worker start), but this rules out "sibling files this run" as the primary term and identifies unbounded cross-run residue as the real one.

- timestamp: 2026-08-28
  checked: DIRECT SYMPTOM REPRODUCTION on the actual flaking file, untouched, run in ISOLATION. (a) control: empty queue. (b) seeded: 12000 foreign jobs pre-seeded via a standalone bullmq script.
  found: (a) `Test Files 1 passed`, `Tests 2 passed`, 1.43s. (b) `Test Files 1 failed`, BOTH scenarios failed with the verbatim symptom `Error: waitFor: condition not met within 10000ms` at flow-run-advance-integration.test.ts:241 (Scenario A via :256, Scenario B via :298). Not a harness confounder: real assertion output, tests reported failed (the documented temp-redis/pg confounders fail vitest with all tests PASSING).
  implication: root cause proven. The single variable changed between GREEN and RED was the depth of the foreign backlog on the shared Redis DB. This is also the assertion output the Symptoms block listed as "to be captured during reproduction" — it matches.

- timestamp: 2026-08-28
  checked: the shared DB after the seeded RED run of the integration file.
  found: 7106 waiting jobs left behind — the file has no queue cleanup, so a run that times out abandons most of the backlog it inherited.
  implication: explains "never fully stabilized". There is a positive feedback loop: once the backlog is large enough to cause a timeout, the failing run leaves it in place for the next run, which fails again — until some run happens to be fast enough to drain it fully. The flake is self-sustaining, not merely random.

- timestamp: 2026-08-28
  checked: INDEPENDENT RED VERIFICATION by the debug session manager (not the investigating agent). Re-ran `npx vitest run src/queues/__tests__/flow-run-advance-queue-isolation.test.ts` from apps/worker in the foreground, on a queue verified clean beforehand (`bull:flow-run-advance` wait=0 delayed=0).
  found: `Test Files 1 failed`, `Tests 2 failed (2)` in 12.81s. Case 1 (clock-free): `AssertionError: ... expected 12000 to be +0` at :131. Case 2 (budget): `waitFor: flow run did not reach 'completed' within 10000ms (status=advancing, foreign jobs still queued ahead of it=8377, node=send-1)` at :159. Both fail for the stated reason. Tests are reported FAILED with real assertion output — this is NOT the documented "temp-redis port-1"/pg confounder signature (those exit non-zero with all tests PASSING).
  implication: RED is confirmed deterministically and reproducibly by a second party, with no repeat-until-it-fails and no load dependence. The residue depth in case 2 differed from the investigator's run (8377 vs 7396) exactly as expected for a drain-rate-dependent number, while the clock-free case 1 reproduced the identical 12000 — corroborating the oracle design (case 1 is the boundary-robust gate, case 2 proves the symptom). Independently corroborated the cross-run residue mechanism at the same time: `bull:webhook-events:wait` still holds 21973 waiting jobs (inert — no consumer in the suite), while flow-run-advance had been drained to 0. Post-run the new file left the queue clean (wait=0 active=0 delayed=0), i.e. it self-cleans in teardown — the abandoned-backlog feedback loop belongs to the integration file, which has no cleanup.

- timestamp: 2026-08-28 (GREEN phase)
  checked: `.planning/WINDOWS.md` (the broken-windows ledger), while looking for where to file the deferred prevention item.
  found: ledger entry **id 5 IS THIS EXACT BUG**, and it has been sitting `open` since 2026-08-10. Phase 12, kind `unrun-verify`, file `apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts`: "Timing flake under full-suite parallel load: waitFor 10s timeout when other suites contend on shared Redis (failed once in wave-4 post-merge gate; passed in isolation and on full re-run). Same family as webhooks-signature.test.ts contamination noted in 12-11-SUMMARY.md. **Candidate for a shared-Redis isolation fix.**"
  implication: strong independent corroboration — the ledger reached the same diagnosis direction ("shared-Redis isolation") 18 days before this session confirmed the mechanism, and named the same file and the same 10s waitFor. This fix resolves ledger entry 5. NOT marked fixed in this session: the human-verify checkpoint has not been answered yet, and `open_count` gates `/gsd-ship`, so flipping it is the operator's call. Also noted while there: entry id 8 is the UUID-shaped-value/phone-rule flake, i.e. the separate bug fixed on the unrelated `fix/uuid-redacted-as-phone` branch — also still `open` in the ledger.

- timestamp: 2026-08-28 (GREEN phase)
  checked: BullMQ's own type declarations, before writing the helper — `node_modules/bullmq/dist/esm/classes/queue.d.ts` and `queue-getters.d.ts`.
  found: `drain(delayed?: boolean): Promise<void>` — drain does NOT resolve to a removed count, contrary to the shape suggested in `next_action`. `getJobCounts(...types: JobType[])` is available for a pre-sample.
  implication: the helper had to sample-then-drain rather than return the drain. Recorded because the naive `return queue.drain(true)` is a `void`-as-`number` bug that no test in this suite would have caught (esbuild strips types without checking) — only the typecheck gate catches it. Also confirms the "before the Worker" ordering constraint from the other direction: `drain` removes wait/paused/prioritized/delayed and never `active`.

- timestamp: 2026-08-28
  checked: INDEPENDENT GREEN VERIFICATION by the debug session manager (second party, after the fix commits landed). Foreground `npx vitest run src/queues/__tests__/flow-run-advance-queue-isolation.test.ts src/queues/__tests__/flow-run-advance-integration.test.ts` from apps/worker. Also verified repo state after the last git operation: branch `fix/flow-run-advance-shared-redis` at b727e1a/3e9941e cut from origin/master @ 5973d20, worktree clean, `fix/uuid-redacted-as-phone` still holding its 2 unrelated unmerged commits untouched, and `.planning/WINDOWS.md` entries 5 and 14 both still present (checked AFTER the last git op, per the known tracked-.planning clobber hazard).
  found: `Test Files 2 passed (2)`, `Tests 4 passed (4)` in 4.74s. The isolation gate that this same manager measured as `2 failed` at 15:29 (12.81s, `expected 12000 to be +0` + a 10s waitFor timeout) is now passing at 15:45 — and it still seeds 12000 foreign jobs internally, so the drain seam is doing the work, not a weakened assertion. Redis left clean afterwards: `bull:flow-run-advance` wait=0 active=0 delayed=0.
  implication: GREEN confirmed by a party other than the agent that wrote the fix, on the same machine and the same shared Redis DB that produced the RED. RED->GREEN on the identical unchanged assertion, with the seed depth unchanged, is the strongest available single-run evidence. It remains a single run: absence of a load-dependent flake cannot be proven by one green pass, which is why the session stays at `awaiting_human_verify` for non-recurrence across the user's next several full-suite runs.

- timestamp: 2026-08-28 (human verification)
  checked: three consecutive root `npm run coverage` aggregate runs after reinstalling the lockfile-pinned ARM dependencies and allowing access to the local Postgres/Redis test services. The two verification runs after environment normalization explicitly set `SENTRY_DSN_API` and `SENTRY_DSN_WORKER` empty so local secrets could not initialize Sentry.
  found: flow-run-advance did not fail in any run. Run 1: 278 files / 2517 tests passed, with only two independent Sentry initialization failures. Run 2: fully green, 280 files / 2519 tests passed (one file and two tests skipped). Run 3: 279 files / 2518 tests passed, with only one independent `negative-cross-tenant-jobs.test.ts` segment-fixture failure. None showed the 10-second flow-run-advance timeout, a non-empty flow-run-advance queue at Worker start, or the H2 empty-queue timing signature.
  implication: the requested non-recurrence checkpoint is satisfied across repeated full aggregate runs, including one completely green run. Human verdict: confirmed fixed. WINDOWS id 5 is closed; id 14 remains the deliberately separate class-level prevention item.

## Eliminated

- hypothesis: shared-queue COUNT COLLISION in sibling assertions — residual/foreign jobs on the global queue break sibling tests that enumerate it.
  evidence: all four enumeration sites (flow-trigger-evaluator.test.ts:163, flow-segment-trigger.test.ts:301, flow-run-advance.test.ts:370 and :415) filter by their own `data.flowRunId` via `.find(...)`/`.some(...)`; none asserts on a total count. They are collision-safe by construction, and none of them is the reported flaking test.
  timestamp: 2026-08-28

- hypothesis: jobId collision — `enqueueFlowRunAdvance`'s `${flowRunId}-${Date.now()}` reuses an id within the same millisecond, so BullMQ's `add()` no-ops and a wake is silently dropped.
  evidence: possible in principle, but not the mechanism here: the two enqueues for the same run in Scenario B are separated by at least one 150ms `waitFor` poll, and the reproduction succeeds/fails purely as a function of foreign backlog depth with the enqueue path unchanged. Recorded as a latent, separate concern — not this bug.
  timestamp: 2026-08-28

- hypothesis: cross-project job stealing in the root aggregate — another vitest project's worker consumes the integration test's jobs.
  evidence: the suite contains exactly one consumer of FLOW_RUN_ADVANCE_QUEUE (the integration file's own Worker); apps/api's config states its tests never open a real socket, and no other project references the queue. Producer/consumer map verified by grep across apps/ and packages/.
  timestamp: 2026-08-28

- hypothesis: delayed-job ORDERING — `getJobs(["delayed"])` returns delay-1's nudge before delay-2's, making Scenario B's `expect(jobIdAfterDelay2).not.toBe(jobIdAfterDelay1)` fail.
  evidence: BullMQ's `getJobs(types, start, end, asc)` defaults `asc` to false (ZREVRANGE), so the highest-score = latest-wake job is returned first, and both assertions filter by `data.flowRunId` anyway. The control run passes this assertion cleanly; the seeded run fails earlier, at the waitFor.
  timestamp: 2026-08-28

## Resolution

root_cause: Test-harness isolation gap on the shared Redis logical DB, requiring several conditions simultaneously (AND-gate = yes). (1) CONFIG: every worker/api test process points at ONE shared Redis logical DB (`redis://localhost:6379/1`, apps/worker/vitest.base.config.ts:137) with no per-run BullMQ `prefix` and no cleanup anywhere in the harness — `globalSetup` provisions an ephemeral Postgres database per run but never touches Redis, so BullMQ jobs survive from run to run indefinitely (measured: 21973 waiting webhook-events jobs, 752 waiting flow-run-advance jobs). (2) CODE: `createFlowRunAdvanceWorker` passes `{ connection }` only, so the real Worker that `flow-run-advance-integration.test.ts` registers — the suite's ONLY consumer of that globally-shared queue — runs at BullMQ's default concurrency of 1, making every foreign job a serial `withTenantTransaction` round trip (2.15 ms/job idle) ahead of the test's own job in the FIFO wait list. (3) ENVIRONMENT: full-suite load plus v8 coverage instrumentation inflates that per-job cost several-fold, which is what moves the crossing point below the test's fixed 10s `waitFor` budget. (4) DATA: the residue grows monotonically and self-sustains — a run that times out abandons the backlog it inherited (7106 jobs observed) for the next run. Production is NOT affected: `processFlowRunAdvance`'s queue-as-doorbell guards handle foreign/stale wakes correctly as fast no-ops, and a real deployment's worker fleet is not operating under a 10s test deadline.

fix: [APPLIED — commit 3e9941e on branch `fix/flow-run-advance-shared-redis`, cut from origin/master @ 5973d20] A shared harness seam that empties the flow-run-advance queue immediately before the real Worker is constructed, called from both files that start one. No production code touched.

  1. NEW `apps/worker/src/test/queue-fixture.ts` exporting `isolateFlowRunAdvanceQueueForTest(): Promise<number>`. IMPLEMENTATION NOTE (deviation from the suggested one-liner, forced by the BullMQ API): `Queue.drain()` is typed `Promise<void>`, NOT a count — verified at `node_modules/bullmq/dist/esm/classes/queue.d.ts:360`. So the helper samples `getJobCounts("wait","paused","prioritized","delayed")` FIRST (exactly the states `drain(true)` removes, so the number is what was actually destroyed rather than an approximation), then drains, then returns the sum. `return flowRunAdvanceQueue.drain(true)` would have been a `void`-as-`number` bug that vitest could not catch (esbuild strips types without checking) — caught by the typecheck gate instead.

  2. `flow-run-advance-queue-isolation.test.ts` beforeAll: helper called between the seed loop and the `getWaitingCount()` sample. The pre-existing baseline `drain(true)` at the top of beforeAll was left in place — its comment documents it as deliberately not-the-seam.

  3. `flow-run-advance-integration.test.ts` beforeAll: helper called immediately BEFORE `createFlowRunAdvanceWorker` — before, because a constructed Worker starts consuming at once and may already have moved jobs into `active`, which `drain` does not remove.

  Safe under `fileParallelism: false`: no other file executes during these beforeAll hooks, and all four sibling enumeration sites are within-file and filter by their own flowRunId, so nothing another file still needs is destroyed (empirically confirmed — see verification check 4). Deliberately NOT a per-run BullMQ prefix threaded through every production Queue/Worker construction site — far broader than the mechanism requires.

  MANDATORY additional part of the fix — close the circularity hole: the new isolation test samples the queue depth after a drain IT ITSELF calls, so it proves the helper works when invoked but does NOT protect the integration file's call site. If a later edit drops the drain from flow-run-advance-integration.test.ts's beforeAll, the new test stays green and this flake returns silently. So the integration file's call site is self-enforcing: immediately after the drain in its beforeAll it samples `getWaitingCount()` and throws a directive error if nonzero ("Do not delete the isolateFlowRunAdvanceQueueForTest() call above"). Deterministic there — `fileParallelism: false` means no other file executes concurrently, and `drain(true)` removes delayed jobs too, so nothing can repopulate the queue between the drain and the sample. APPLIED, and empirically proven to bite — see verification check 5.

  One assertion added beyond the RED file's original two, in the clock-free case: `expect(residueRemoved).toBeGreaterThanOrEqual(RESIDUE_JOBS)`. Reason: a depth of 0 is the correct answer for two very different reasons — the seam removed the residue, or the seed loop silently enqueued nothing — and only the first is evidence. Without this, case 1 could pass vacuously if the seeding ever broke.

oracle_type: PAIRED, and deliberately so — neither case alone is sufficient.
  - clock-free case ("the real Worker starts on a queue with no foreign jobs on it") = DERIVED (contract/invariant oracle): asserts the harness invariant the suite depends on, with no clock and no load dependence. This is also the boundary-robust assertion — it fails identically at any residue depth >= 1, so it cannot be tuned away by a machine that happens to be fast.
  - budget case ("advances its own run within the same 10s budget") = SPECIFIED: the 10s hop budget is the one the integration suite itself documents and uses, not a number invented for this test. It is the only case that proves the SYMPTOM, but it is timing-based and therefore weaker as a permanent gate.
  Neither is implicit (crash-only).

verification: ALL FOUR CHECKS PASS, plus two additional signals. Every run was FOREGROUND with an explicit generous timeout (never backgrounded — documented local hazard), and every verdict is read off ASSERTION OUTPUT, never exit code. Queue depths measured two independent ways that agreed on every reading: BullMQ `getJobCounts` via a scratchpad script, and `redis-cli -n 1` with BRACED keys (`"bull:${q}:wait"` — the unbraced form is the documented zsh colon-modifier trap that produced one false measurement during RED).

  guardrail_verdict: accepted

  (1) NEW ISOLATION TEST — PASS. `Test Files 1 passed (1)`, `Tests 2 passed (2)`, 3.14s (RED: 2 failed, 12.81s). Clock-free case went 12000 -> 0; budget case passes. The 12.81s -> 3.14s drop is itself corroborating: under RED the wall clock was being consumed by serial backlog drain inside the 10s waitFor.

  (2) LOAD-BEARING CHECK — PASS. 12000 foreign jobs pre-seeded via a standalone bullmq script (same payload shape and jobId scheme as the RED reproduction), depth confirmed at exactly `wait=12000` by BOTH measurement paths, then flow-run-advance-integration.test.ts run in isolation: `Test Files 1 passed (1)`, `Tests 2 passed (2)`, 2.88s. This is the exact experiment that before the fix produced the verbatim reported symptom (`waitFor: condition not met within 10000ms`) on BOTH scenarios. Post-run depth `wait=0` — the seam consumed the whole backlog in the beforeAll.

  (3) CONTROL (empty queue) — PASS. `Tests 2 passed (2)`, 2.56s. Note a detail worth recording: post-run depth showed `delayed=2` — Scenario B's two 30-minute nudges, which the integration file still never cleans up in teardown. That is fine and does not need a teardown fix, because `drain(true)` in the beforeAll removes delayed jobs too, so the next run's seam absorbs them. This is precisely how the self-sustaining feedback loop identified in Evidence gets broken.

  (4) FOUR SIBLING PRODUCER FILES — PASS. flow-run-advance, flow-trigger-evaluator, flow-segment-trigger, flow-send-idempotency: `Test Files 4 passed (4)`, `Tests 28 passed (28)` — identical to the 28-test baseline recorded in the RED-phase Evidence entry. The drain destroys nothing they rely on. Residue left behind wait=17 delayed=6, matching the ~17 measured during RED.

  (5) MUTATION CHECK ON THE GUARD ITSELF (not in the original plan; run because an untested guard is not a guard). Removed ONLY the `await isolateFlowRunAdvanceQueueForTest();` line from the integration file's beforeAll, left the guard in place, seeded 500 jobs (depth 517 with sibling residue), ran the file. Result: FAILED with exactly the intended diagnostic — "flow-run-advance queue isolation failed: 517 foreign jobs remain on the shared Redis DB after the drain. ... Do not delete the isolateFlowRunAdvanceQueueForTest() call above." at :61. Then restored the line from the commit (`git checkout --`, verified 0 mutation markers remain and the call is back at :51) and re-ran against the SAME 517-job residue: `Tests 2 passed (2)`. So the guard demonstrably bites on the one mutation that matters, and is not merely decorative.

  (6) COMBINED MULTI-FILE RUN — PASS. All six flow files in ONE vitest run (the real full-suite shape under `fileParallelism: false`), starting from the natural sibling residue left by check 4 (wait=17 delayed=6): `Test Files 6 passed (6)`, `Tests 32 passed (32)`, 9.00s.

  (7) TYPECHECK — PASS. `npx tsc --noEmit -p tsconfig.json` in apps/worker: exit 0, no output. This is the gate that would have caught the `drain()`-returns-void signature trap.

  H2 DID NOT SURFACE. No timing assertion failed anywhere in the above, including the empty-queue control and the 6-file combined run, so there is no residual-failure signal to attribute to H2. H2 remains a standing, un-excluded alternative (this fix removes one sufficient cause and cannot prove it was the only one) — it is simply not observable on this machine at this load level. If the flake ever recurs with the queue verifiably empty at Worker start, that is H2, not a regression of this fix.

  REDIS LEFT CLEAN. Final `bull:flow-run-advance` depths, both measurement paths agreeing: wait=0 active=0 delayed=0 paused=0 prioritized=0. (completed=130 remains — the inert pre-CR-01 bare-uuid retained-completed hashes documented in Evidence; `drain` does not touch completed by design, and they are not work.) The other queues on db 1 are untouched and still hold their inert residue (webhook-events ~21973 etc.) — that is the deliberately-deferred prevention item below, not this fix's scope.

files_changed:
  - apps/worker/src/test/queue-fixture.ts (NEW — the shared harness seam, 62 lines)
  - apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts (MODIFIED — seam call before Worker construction + self-enforcing depth guard, +31 lines)
  - apps/worker/src/queues/__tests__/flow-run-advance-queue-isolation.test.ts (NEW — the regression gate, 189 lines; RED file plus the seam call and the anti-vacuous-pass assertion)
  commit: 3e9941e on `fix/flow-run-advance-shared-redis` (branched from origin/master @ 5973d20 — deliberately NOT onto fix/uuid-redacted-as-phone, which carries 2 unrelated unmerged commits). Not pushed, no PR.

follow_up (prevention, deliberately NOT folded into this fix): the shared test Redis DB accumulates unboundedly across ALL queues (21973 waiting webhook-events jobs today) and nothing ever cleans it. The recurrence guard for the whole class is a fail-closed test-Redis cleanup in `packages/test-support/src/global-setup.ts`, mirroring the existing fail-closed test-DATABASE guard in that same file: refuse to run unless the resolved Redis URL names an explicit logical DB index >= 1 (never db 0, the dev worker's), then clear it once per run. That would have prevented this flake and prevents the next test that adds a real consumer to any other shared queue from inheriting the same trap.
