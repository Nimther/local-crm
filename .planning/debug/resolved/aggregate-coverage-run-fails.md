---
status: resolved
trigger: "Исправить падение обязательного aggregate coverage-прогона на ветке Phase 10 — npm run coverage падает (6 тестов в 3 файлах apps/worker), при том что npm run test полностью проходит"
created: 2026-08-09
updated: 2026-08-09
resolved: 2026-08-09
---

## Symptoms

DATA_START
**Expected behavior:**
`npm run coverage` должен запускать все backend-проекты в одном Vitest aggregate run, формировать единый coverage report и завершаться успешно. Нельзя отключать тесты, ослаблять coverage/redaction или разбивать единый coverage denominator.

**Actual behavior:**
Обычный `npm run test` проходит полностью: 136 test-файлов, 891 тест. Typecheck и lint также проходят. Но `npm run coverage` стабильно падает: 3 test-файла failed, 6 тестов failed, 850 passed.

**Error messages / failures:**

1. `apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts`
   4 теста падают с:
   `TypeError: Cannot read properties of undefined (reading 'map')`
   в `packages/segments-core/src/compile.ts:19`, потому что `def.groups` оказывается undefined.

2. `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts`
   Тест segment sweep падает с той же ошибкой `def.groups.map`.

3. `apps/worker/src/queues/__tests__/webhook-events-sibling-drop.test.ts`
   Ожидается исходный `siblingWorkspaceId`, но `payload.owningWorkspaceId` неожиданно равен `[REDACTED]`.

**Timeline:**
Наблюдается на ветке `gsd/phase-10-tenant-isolation-trust-boundaries`. Проблема воспроизводится только в корневом aggregate coverage run. Workspace-тесты, включая полный `apps/worker` suite, проходят отдельно. Похожий конфликт segment sweep уже зафиксирован в `.planning/phases/10-tenant-isolation-trust-boundaries/deferred-items.md`.

**Reproduction:**
1. Убедиться, что локальные PostgreSQL и Redis доступны.
2. Запустить `npm run test` — проходит.
3. Запустить `npm run coverage` — перечисленные 6 падений.

**Probable investigation directions (user-supplied, unverified):**
- утечка или перезапись `TEST_DATABASE_URL` между Vitest projects/globalSetup;
- несколько проектов или тестов фактически используют одну физическую ephemeral DB;
- fixtures разных segment-sweep тестов видят чужие flows/segments;
- глобальный `console` mock или redaction wrapper протекает между проектами при aggregate run;
- различие поведения Vitest projects под `--coverage`.

**Fix constraints (hard requirements):**
- `npm run coverage` проходил стабильно;
- каждый проект/fixture работал с корректной ephemeral DB;
- aggregate coverage оставался единым (единый coverage denominator, без разбиения);
- тесты не отключались и assertions не ослаблялись;
- production-поведение segment sweep и redaction не менялось ради маскировки тестового конфликта.
DATA_END

## Current Focus

bug_class: Cause A = Bohrbug (deterministic in aggregate run, 100% reproducible).
  Cause B = Heisenbug (probabilistic, ~4% per run, value-dependent on a random UUID).
next_action: NONE — session resolved. Human verification granted 2026-08-09 (agent
  evidence accepted for the fix; the open `{9,}` digit ceiling on the phone rule
  explicitly signed off as-is). Committed in 3 atomic commits on
  gsd/phase-10-tenant-isolation-trust-boundaries; archived to resolved/.

reasoning_checkpoint:
  hypothesis: >
    TWO INDEPENDENT root causes, both confirmed by direct observation.
    (A) packages/test-support/src/global-setup.ts publishes its per-project ephemeral
    DSN by mutating the SHARED parent process.env. Vitest runs every project's
    globalSetup sequentially in the SAME parent process before forking any test
    worker (Vitest 4.1.9, TestProject._initializeGlobalSetup, cli-api L13745), so with
    5 projects declaring that file the LAST writer wins: N databases are provisioned,
    but every project's workers inherit ONE DSN. All projects then share one physical
    database. apps/worker's runFlowSegmentSweepTick() is a deliberately CROSS-TENANT
    scan, so it discovers packages/tenant-context's fixtures — whose segment
    `definition` is `{operator:"and",conditions:[]}` (not a SegmentDefinition, which is
    `{version,groups[]}`) — and compileSegmentDefinition crashes on `def.groups.map`.
    (B) The redaction `phone` valueRule /\+?\(?\d(?:[\s().-]*\d){9,14}\b/ matches ~4%
    of random v4 UUIDs, so scrub() replaces owningWorkspaceId with "[REDACTED]".
  confirming_evidence:
    - "Probe: two globalSetups ran; #2 observed prevTEST already pointing at #1's DB."
    - "Probe test: tenant-context's worker read TEST_DATABASE_URL = ..._mega_crm_worker_c4457b4d."
    - "`vitest run scan.test.ts flow-segment-trigger.test.ts` = 4 failures, exact reported stack."
    - "`vitest run --project @mega-crm/worker flow-segment-trigger.test.ts` = 8/8 pass."
    - "Failures reproduce WITHOUT --coverage -> coverage is not a cause."
    - "Measured: 12067/300000 (4.0%) random v4 UUIDs match the phone rule."
  falsification_test: >
    (A) would be refuted if running the worker sweep tests together with tenant-context
    still passed, or if tenant-context's workers saw their own DSN. Both checked; neither
    holds. (B) would be refuted if a UUID that matches the phone regex were NOT redacted
    by scrub() — scrub applies valueRules to every string, and owningWorkspaceId is not a
    keyRule, so [REDACTED] can only come from a valueRule; phone is the only one that can
    match a bare UUID.
  fix_rationale: >
    (A) Publish the DSNs into the PER-PROJECT `project.config.env` (which Vitest merges
    over inherited process.env when forking that project's workers) instead of relying
    only on the shared process.env. This restores the design intent already encoded in
    createEphemeralDatabase's `mega_crm_test_<workspace>_<runId>` naming: one DB per
    project. Verified experimentally that the mechanism works. Also stop clobbering
    GSD_DEV_DATABASE_URL on the 2nd..Nth invocation — today both fail-closed guard
    layers silently compare an ephemeral DSN against another ephemeral DSN in an
    aggregate run, i.e. the guard stops guarding.
    (B) Anchor the phone pattern with non-alphanumeric-and-non-hyphen boundaries so a
    canonical UUID has no valid start position, while every realistic phone format
    still matches. This is a correctness fix to a false positive the rule's own comment
    claims to have already eliminated — not a masking change: redacting workspace ids
    destroys the very signal SEC-09/WR-01 exists to emit.
  blind_spots:
    - "project.config.env is a resolved-config field, not a documented globalSetup API; a future Vitest major could change it. Mitigated by a fail-closed assertion + regression test."
    - "Per-project DBs make projects concurrent against a SHARED Redis (db 1); must confirm the full aggregate run has no queue cross-talk."
    - "Other groups-less segment fixtures exist elsewhere; only scan.test.ts attaches one to a LIVE segment-triggered flow."
  candidate_causes:
    - "code: global-setup.ts writes per-project state to a process-global (CONFIRMED)"
    - "code: redaction phone valueRule false-positives on UUIDs (CONFIRMED)"
    - "config: root vitest.config.ts fans 5 projects onto one globalSetup (CONTRIBUTING)"
    - "data: scan.test.ts seeds an invalid SegmentDefinition on a live segment flow (CONTRIBUTING)"
    - "environment: --coverage flag (ELIMINATED — failure reproduces without it)"
  and_gate: >
    YES for failures 1-2: requires (shared physical DB) AND (an invalid segment
    definition reachable by the cross-tenant sweep) simultaneously. Removing either
    makes them pass — proven both ways. NO for failure 3: cause B is independent and
    fires on its own with ~4% probability per run.

## Evidence

- timestamp: 2026-08-09
  checked: root package.json scripts
  found: `npm run test` = `npm run test --workspaces --if-present` (N separate vitest
    processes, one per workspace). `npm run coverage` = `vitest run --coverage
    --testTimeout=60000` from the repo root (ONE vitest process, 12 projects).
  implication: The differentiator under test is AGGREGATE vs PER-WORKSPACE, not
    coverage-vs-no-coverage. `--coverage` is likely a red herring; must verify by
    running bare root `vitest run` without --coverage.

- timestamp: 2026-08-09
  checked: grep globalSetup across all vitest.config.ts
  found: 5 projects declare the SAME file `packages/test-support/src/global-setup.ts`
    — apps/api, apps/worker, packages/db, packages/delivery-core,
    packages/tenant-context.
  implication: In an aggregate run that file may execute up to 5 times (once per
    project) unless Vitest dedupes by resolved path.

- timestamp: 2026-08-09
  checked: packages/test-support/src/global-setup.ts
  found: setup() takes `project?: { name?: string }`, derives `workspace` from it
    (falling back to basename(cwd)), creates a per-workspace ephemeral DB, then
    UNCONDITIONALLY assigns process.env.TEST_DATABASE_URL, DATABASE_URL,
    SCAN_DATABASE_URL, AUTH_DATABASE_URL. No guard against a prior invocation.
  implication: Concurrent/sequential multi-project invocation = last-writer-wins on
    process.env; the other N-1 provisioned databases are orphaned and every project
    shares one physical DB.

- timestamp: 2026-08-09
  checked: Vitest 4.1.9 internals (node_modules/vitest/dist/chunks/cli-api.24X8XwN1.js)
  found: L13741-13745 `initializeGlobalSetup` loops projects SEQUENTIALLY, all before
    `runFiles`. L10746 calls `globalSetupFile.setup?.(this)` with the TestProject
    instance. L3649-3655 builds each project's forked-worker env as
    `{...process.env, ...options.env, ...ctx.config.env, ...project.config.env}` and
    memoizes it PER PROJECT, lazily at pool-run time. L9232 `serializeConfig` sets
    `env: {...viteConfig?.env, ...config.env}`, applied inside the worker by
    `setupCommonEnv`.
  implication: `project.config.env` is a per-project channel evaluated AFTER globalSetup
    and it OVERRIDES inherited process.env — the correct place to publish a per-project
    DSN. `process.env` is the wrong channel for per-project values.

- timestamp: 2026-08-09
  checked: REPRODUCTION — `npx vitest run --testTimeout=60000 scan.test.ts flow-segment-trigger.test.ts`
  found: 4 failed / 17 passed, `TypeError: Cannot read properties of undefined (reading
    'map')` at compile.ts:19 via flow-segment-sweep.worker.ts:98 — byte-identical to the
    reported stack. NO `--coverage` flag was used.
  implication: `--coverage` is NOT a cause. The differentiator is the aggregate run.
    Symptom's framing ("only under coverage") is an artifact of coverage being the only
    aggregate entrypoint anyone runs.

- timestamp: 2026-08-09
  checked: CONTROL — `npx vitest run --project '@mega-crm/worker' flow-segment-trigger.test.ts`
  found: 8/8 passed.
  implication: The worker project's own fixtures are all valid. The poison comes from
    another project sharing the database.

- timestamp: 2026-08-09
  checked: PROBE in global-setup.ts logging workspace + created DB + prior TEST_DATABASE_URL
  found: |
    [PROBE] workspace=@mega-crm/tenant-context created=mega_crm_test__mega_crm_tenant_context_ec0000a1 prevTEST=<dev>
    [PROBE] workspace=@mega-crm/worker created=mega_crm_test__mega_crm_worker_7eb95b09 prevTEST=<...tenant_context_ec0000a1>
  implication: DIRECT CONFIRMATION of last-writer-wins. Two DBs provisioned; the second
    invocation observed the first's DSN already in process.env and overwrote it.

- timestamp: 2026-08-09
  checked: PROBE assertions inside each project's own test worker
  found: with the DSN ALSO written to `project.config.env` as GSD_PROBE_DSN,
    tenant-context's worker read GSD_PROBE_DSN = ...tenant_context_fdaeda6e (CORRECT)
    while in the SAME run reading process.env.TEST_DATABASE_URL = ..._mega_crm_worker_c4457b4d
    (WRONG — another project's database).
  implication: Confirms both halves at once: (1) the defect is real at the worker level,
    (2) `project.config.env` is a working per-project channel and is the fix mechanism.

- timestamp: 2026-08-09
  checked: packages/tenant-context/src/__tests__/scan.test.ts seedSegmentFlow()
  found: inserts `definition = {operator:"and", conditions:[]}` — NOT a SegmentDefinition
    (`{version, groups[]}`) — then a flow with status 'live', trigger_type 'segment',
    trigger_segment_id set and live_version_id set. Called 4x with status 'live'
    (L251, L252, L387, L388).
  implication: These rows match findLiveSegmentTriggeredFlows()'s WHERE clause exactly.
    Once the DB is shared, the worker's sweep compiles them and crashes on def.groups.
    This is the second half of the AND-gate.

- timestamp: 2026-08-09
  checked: guard chain in global-setup.ts (assertTestDatabaseUrl + GSD_DEV_DATABASE_URL stash)
  found: invocation #2 runs `assertTestDatabaseUrl(dsn2, process.env.DATABASE_URL)` where
    DATABASE_URL has ALREADY been replaced by dsn1, then overwrites GSD_DEV_DATABASE_URL
    with dsn1 as well.
  implication: SEPARATE LATENT DEFECT — in an aggregate run both fail-closed guard layers
    (D-14 a and b) compare one ephemeral DSN against another instead of against the real
    dev DSN. The guard silently stops guarding for projects 2..N.

- timestamp: 2026-08-09
  checked: packages/redaction/src/rules.ts phone valueRule vs random v4 UUIDs
  found: /\+?\(?\d(?:[\s().-]*\d){9,14}\b/ matched 12067/300000 = 4.0% of randomUUID()
    values. `organization.id` is `uuid DEFAULT gen_random_uuid()`, and scrub() applies
    valueRules to EVERY string value regardless of key, so owningWorkspaceId becomes
    "[REDACTED]" ~4% of runs. The rule's own comment claims the widened digit floor
    already eliminated this.
  implication: Failure 3 is an INDEPENDENT ~4%-per-run flaky defect, not aggregate-related
    — and a production defect: workspace ids are randomly scrubbed from operational logs.

- timestamp: 2026-08-09
  checked: candidate fix regex /(?<![0-9A-Za-z-])\+?\(?\d(?:[\s().-]*\d){9,14}(?![0-9A-Za-z-])/
  found: 0/300000 random UUIDs matched; all 10 realistic phone formats still matched
    (+14155550199, +1 415-555-0199, (415) 555-0199, tel:+1-415-555-0199, +7 (999) 123-45-67,
    embedded-in-sentence, etc.); 9-digit "123456789" still below the floor.
  implication: In a canonical UUID every digit run is preceded by a hex letter or '-',
    so no valid start position exists — the false positive is eliminated by construction,
    not by probability.

## Eliminated

## Resolution

root_cause: >
  TWO independent causes.

  (A) Failures 1-2 (6 -> 5 of the reported failures): an AND-gate of two conditions.
  (A1, code) packages/test-support/src/global-setup.ts published a PER-PROJECT ephemeral
  DSN by mutating the SHARED parent process.env. Vitest executes every project's
  globalSetup sequentially in one parent process before forking any test worker
  (Vitest 4.1.9, Vitest.initializeGlobalSetup / TestProject._initializeGlobalSetup), so
  with 5 projects registering that hook it is last-writer-wins: 5 databases provisioned,
  every project's workers handed the 5th one's DSN, all projects sharing one physical
  database. (A2, data) packages/tenant-context/src/__tests__/scan.test.ts seeded
  `definition = {operator:"and",conditions:[]}` — not a SegmentDefinition ({version,
  groups[]}) — onto flows with status='live', trigger_type='segment' and a
  live_version_id, i.e. exactly the rows findLiveSegmentTriggeredFlows() selects. With
  the database shared, apps/worker's deliberately cross-tenant runFlowSegmentSweepTick()
  compiled them and threw `def.groups.map`. Removing EITHER condition makes the failures
  disappear — verified in both directions.

  (A3, latent) The same last-writer-wins also clobbered GSD_DEV_DATABASE_URL on the
  2nd..Nth invocation, so in an aggregate run BOTH fail-closed guard layers (D-14 a and b)
  compared one ephemeral DSN against another instead of against the real dev DSN — the
  guard silently stopped guarding for 4 of 5 projects.

  (B) Failure 3, INDEPENDENT and probabilistic (~4% per run): the `phone` valueRule in
  packages/redaction/src/rules.ts, /\+?\(?\d(?:[\s().-]*\d){9,14}\b/, matched 4.0% of
  random v4 UUIDs (measured 12067/300000) because `-` is one of its own separators and a
  trailing \b let the match start mid-token inside a hex group. scrub() applies valueRules
  to every string regardless of key, so owningWorkspaceId came back "[REDACTED]".
  `--coverage` was NOT a cause of anything: all failures reproduce without it.

fix: >
  (A1) global-setup.ts publishes the DSN set into vitest's PER-PROJECT `project.config.env`
  channel (merged over inherited process.env when that project's workers are spawned) as
  well as into process.env (still needed for the Playwright entrypoint and single-project
  runs). This restores the one-database-per-project intent already encoded in
  buildEphemeralDatabaseName's `mega_crm_test_<workspace>_<runId>` scheme. Scan/auth DSNs
  are now derived from the freshly provisioned dsn via provision-db's new buildTestRoleDsn
  instead of being read back out of process.env, removing the ordering coupling.
  (A3) The true dev DSN is resolved as GSD_DEV_DATABASE_URL ?? DATABASE_URL and the stash
  is written once per run, so the guard keeps comparing against the real dev database.
  (NEW, D-14 layer c) The second provisioning project poisons the shared
  process.env.GSD_TEST_PROJECT with AMBIGUOUS_PROJECT_MARKER; getTestDatabaseUrl() fails
  closed on it. Only a worker the per-project channel failed to reach can observe it, so a
  future regression announces itself explicitly instead of surfacing as a TypeError in
  unrelated code.
  (A2) scan.test.ts's live segment-flow fixture now stores a real SegmentDefinition
  (defense in depth — closes the other half of the AND-gate).
  (B) The phone pattern is anchored between non-alphanumeric, non-hyphen boundaries:
  /(?<![0-9A-Za-z-])\+?\(?\d(?:[\s().-]*\d){9,}(?![0-9A-Za-z-])/. Inside a canonical UUID
  every digit run is preceded by a hex letter or '-', so no legal start position exists —
  the false positive is gone by construction, not made rarer. The digit ceiling is opened
  ({9,} vs {9,14}) because with a start anchor the pattern can no longer slide forward,
  and a capped version would have stopped matching 16+ digit runs the old one did catch.

verification:
  signal_1_original_issue: "PASS — `npm run coverage` exit 0, 135/135 files, 868/868 tests (was 3 files / 6 tests failing). Minimal repro `vitest run scan.test.ts flow-segment-trigger.test.ts` 21/21 (was 4 failing)."
  signal_2_regression_tests_red_first: "PASS — global-setup-project-isolation.test.ts 4 failed/1 passed before fix, 5/5 after. scrub-identifier-false-positive.test.ts 5 failed/2 passed before fix, 7/7 after."
  signal_3_mutation: "PASS — Mutation A (disable the config.env publication): isolation suite 4/5 fail AND the aggregate repro fails loudly with the D-14 layer c message even though the A2 fixture is already corrected, proving the new guard detects the isolation break on its own. Mutation B (restore the old phone regex): 5/7 fail. Both reverted."
  signal_4_not_deletion_only: "PASS — no test disabled, no assertion weakened; assertions added (12 new tests). The only pre-existing test touched is db-fixture-advisory-unlock.test.ts, which gains one `delete process.env.GSD_TEST_PROJECT` in the env-curation block it already had."
  signal_5_other_gates: "PASS — npm run test (per-workspace, 12 workspaces) exit 0; npm run lint exit 0; npm run build (this repo's typecheck, per ci.yml D-04) exit 0; npm run coverage:gate OK (0.8468 vs threshold 0.8126, single unified denominator 4614 lines preserved)."
  signal_6_stability: "PASS — 3 consecutive full `npm run coverage` runs, all exit 0 (cause B was a ~4%/run flake, so repetition is the only way to speak to it; the deterministic UUID literals in the regression suite are the real guard)."
  guardrail_verdict: accepted
  oracle_type: "specified (SPECIFICATION.md §5.9 states the drop signal's three fields pass through scrub untouched; §3.2.1 now states the per-project DSN contract) + derived (the SegmentDefinition schema defines what `definition` must contain)"
  human_verification: "GRANTED 2026-08-09. Q1 (fix verified): user accepted the agent's
    self-verified evidence in lieu of a manual re-run — 3 consecutive green `npm run
    coverage`, coverage:gate OK, test/lint/build green, both fixes mutation-tested.
    Q2 (phone-rule sign-off): the open digit ceiling `{9,}` together with the lookaround
    anchors APPROVED as-is; no further change to the rule."

files_changed:
  - packages/test-support/src/global-setup.ts
  - packages/test-support/src/db-fixture.ts
  - packages/test-support/src/provision-db.ts
  - packages/test-support/src/__tests__/global-setup-project-isolation.test.ts (new)
  - packages/test-support/src/__tests__/db-fixture-advisory-unlock.test.ts
  - packages/redaction/src/rules.ts
  - packages/redaction/src/__tests__/scrub-identifier-false-positive.test.ts (new)
  - packages/tenant-context/src/__tests__/scan.test.ts
  - SPECIFICATION.md
  - .planning/phases/10-tenant-isolation-trust-boundaries/deferred-items.md

commits:
  branch: gsd/phase-10-tenant-isolation-trust-boundaries
  - ec7f5f6 "fix(test-support): publish ephemeral DSN per vitest project"
    (cause A1 + A3 + new D-14 layer c; global-setup.ts, db-fixture.ts,
    provision-db.ts, global-setup-project-isolation.test.ts,
    db-fixture-advisory-unlock.test.ts, SPECIFICATION.md §3.2.1)
  - c975a1f "test(tenant-context): seed a compilable SegmentDefinition in scan fixture"
    (cause A2 — the other half of the AND-gate; scan.test.ts)
  - 3cd3f0c "fix(redaction): anchor phone rule so it cannot match inside a UUID"
    (cause B, independent; rules.ts, scrub-identifier-false-positive.test.ts,
    SPECIFICATION.md §7 redaction caveat)
  note: >
    SPECIFICATION.md was split across commits by hunk — the §3.2.1 two-channel DSN
    contract rides with cause A, the phone-rule caveat with cause B — so neither
    commit documents a change it does not contain. `.planning/` is gitignored in
    this repo, so the session file and deferred-items.md are not tracked.

## Prevention

blameless_5_whys:
  branch_code_A1: >
    Failures 1-2 in apps/worker -> the worker's cross-tenant sweep read another
    project's rows -> all 5 vitest projects shared one physical database ->
    global-setup.ts published a per-project value (the DSN) into a process-global
    (process.env) -> WHY POSSIBLE: process.env is the only publication channel
    that is obvious from inside a globalSetup hook; the per-project channel
    (project.config.env) is a resolved-config field, not a documented globalSetup
    API. The hook was written and reviewed when the invariant "one vitest process
    = one project" silently held, and nothing re-checked it when the aggregate
    coverage entrypoint was added. Actionable condition: a per-project value had
    no per-project channel, and no assertion detected the collapse.
  branch_data_A2: >
    The sweep crashed rather than merely reading foreign rows -> it compiled a
    segments.definition with no `groups` -> scan.test.ts seeded a placeholder
    shape -> WHY POSSIBLE: `definition` is a jsonb column with no CHECK
    constraint and no zod parse at the INSERT boundary, so an arbitrary object is
    accepted; a fixture author has no local signal that this row is reachable by
    another package's cross-tenant scan. Actionable condition: an invalid
    SegmentDefinition is representable in the database.
  branch_config: >
    The aggregate run fans 5 projects onto one shared globalSetup file (root
    vitest.config.ts). CONTRIBUTING, not causal — the same file used per-project
    channels would have been correct at any project count. Left as-is
    deliberately: a single shared hook is the right design; the defect was its
    publication channel.
  branch_code_B: >
    owningWorkspaceId logged as [REDACTED] -> the phone valueRule matched a UUID
    -> `-` is one of the rule's own separators, and a trailing \b permitted a
    mid-token start -> the previous fix raised the digit FLOOR, which made the
    collision rarer (~4%) instead of impossible -> WHY POSSIBLE: the earlier fix
    was validated against the one UUID that had failed in CI, not against a
    sampled population, so a probabilistic residue read as a clean fix. The
    rule's own comment then asserted the false positive was eliminated, which
    made re-checking it look unnecessary. Actionable condition: a probabilistic
    defect was verified with a single example.
  and_gate_recap: >
    Failures 1-2 required (shared physical DB) AND (an invalid segment definition
    reachable by the cross-tenant sweep) — both were fixed, either alone
    suffices. Failure 3 was independent and single-cause. Categories touched:
    code (A1, B), data (A2), config (contributing). environment (--coverage) was
    ELIMINATED by direct experiment.

why_not_caught: >
  Every gate that exists passed. `npm run test` is the gate that should have
  caught A1, and it is structurally incapable of doing so: it runs
  `--workspaces`, i.e. one vitest process per workspace, so exactly one project
  ever registers the globalSetup and last-writer-wins cannot occur. The only
  entrypoint that exercises the multi-project path is `npm run coverage`, which
  had no test asserting the isolation it depends on — db-fixture-isolation.test.ts
  asserts a test is in AN ephemeral database, never that it is in ITS OWN. So the
  gate for this class did not exist rather than having failed. Typecheck could not
  help (both DSNs are `string`; `definition` is untyped jsonb). Review could not
  help either: the defect is invisible in the diff and only appears in Vitest's
  scheduling semantics. For B, the pre-existing test (webhook-events-sibling-drop
  Test 4) DID cover the assertion, but with a random UUID, so it was a ~4%-per-run
  flake that read as noise instead of as the standing signal it was.

recurrence_guard:
  - "packages/test-support/src/__tests__/global-setup-project-isolation.test.ts
     (5 tests, verified passing at HEAD) — drives the hook with two stub projects,
     exactly as an aggregate run does, and asserts each gets its OWN database in
     its OWN config.env. This is the gate that did not exist; it now runs inside
     the ordinary per-workspace `npm run test`, so the multi-project path is
     covered without needing the aggregate entrypoint."
  - "ASSERTION (strongest guard here, D-14 layer c): AMBIGUOUS_PROJECT_MARKER in
     global-setup.ts + the fail-closed check in db-fixture.ts's
     getTestDatabaseUrl(). Only a worker the per-project channel failed to reach
     can observe the marker, so if a future Vitest release changes
     project.config.env semantics, the failure announces itself by name at
     runtime instead of resurfacing as a TypeError in an unrelated package. This
     directly addresses the recorded blind spot about relying on an undocumented
     field."
  - "packages/redaction/src/__tests__/scrub-identifier-false-positive.test.ts
     (7 tests, verified passing at HEAD) — pins DETERMINISTIC UUID literals that
     the pre-fix pattern matched, converting a 4%-per-run flake into a standing
     assertion, plus a 5000-sample sweep and boundary neighbours (9 vs 10 digits,
     16+ digit runs). Test 7 asserts the rule cannot match at ANY start position
     inside a canonical UUID — the by-construction property, not the symptom."
  - "SPECIFICATION.md §3.2.1 documents the two-channel DSN contract and §7 the
     valueRule-applies-to-every-string caveat, so the next author of either does
     not rediscover this by debugging."
  - "This knowledge-base entry, so a future Phase-0 recall surfaces the pattern
     'aggregate/multi-project run behaves differently from per-workspace run' and
     'identifier came back [REDACTED]' before re-investigating from scratch."
