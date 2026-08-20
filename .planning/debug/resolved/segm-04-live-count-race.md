---
status: resolved
trigger: "SEGM-04 E2E flake in CI: live-count stays '—' instead of numeric value before degraded state; PostgreSQL 57P01 on teardown; duplicate CI runs on push and pull_request"
created: 2026-08-06
updated: 2026-08-06
---

## Symptoms

DATA_START
**Expected behavior:**
SEGM-04 должен сначала получить и показать числовой live-count, а после имитации timeout сохранить последнее успешное значение и показать amber degraded marker. Полный E2E должен проходить 8/8.

**Actual behavior:**
В CI apps/web/e2e/segments-behavior.spec.ts:146 падает:
Expected lastGoodText not to be "—", но значение остаётся "—".
Результат: 7 passed, 1 failed.
После падения также появляется PostgreSQL 57P01:
terminating connection due to administrator command.

**Error messages:**
- Playwright assertion at apps/web/e2e/segments-behavior.spec.ts:146 — Expected lastGoodText not to be "—", value remains "—"
- PostgreSQL 57P01: terminating connection due to administrator command (appears after the test failure, during teardown)

**Timeline:**
Проблема повторилась минимум в двух CI-прогонах Phase 8 — на push и pull_request. Это известный SEGM-04, но теперь его нужно исправить до начала Phase 9.

**Reproduction:**
Запустить полный npm run test:e2e в чистом CI-окружении с эфемерной БД либо целевой SEGM-04 повторно несколько раз.

**Requirements for the fix:**
- Найти первопричину гонки между initial live-count и degraded-состоянием
- Не применять skip, ослабление assertion, произвольные sleep или слепые retries
- Корректно закрывать сервер и PostgreSQL pool до удаления БД
- Загружать Playwright trace/test-results при падении
- Устранить двойной CI-запуск на push и pull_request
- Доказать исправление: 10 повторов SEGM-04, несколько полных E2E-прогонов, полностью зелёный CI в отдельном PR
DATA_END

## Current Focus

bug_class: Heisenbug (transient, timing-dependent — confirmed by same-commit pass/fail in sibling CI jobs)

reasoning_checkpoint:
  hypothesis: |
    SEGM-04 fails because the test waits on `<p>контактов подходит</p>` — which React mounts in the
    SAME commit as the count `<p>` holding the "—" placeholder — and then reads the count with a
    one-shot, non-retrying `textContent()`. The numeric count can only appear one preview-count HTTP
    round-trip later. So the assertion's outcome is decided by whether that round-trip beats ~10-30ms
    of CDP round-trips: a pure timing race with no wait on the asserted value.
  confirming_evidence:
    - "Direct read of SegmentBuilder.tsx 651-679: both <p>s are inside the same `canPreview` branch, so the label carries no information about whether the count landed."
    - "Direct read of SegmentBuilder.tsx 525-545: `canPreview` gates BOTH the label render and `enabled` on the query, and `lastGoodCount` is only set by an effect on resolved data — the '—' window is exactly one round-trip wide, structurally."
    - "Direct read of the spec: the only retrying waits are `toBeVisible`; the value assertion is a plain `expect()` on a captured string, which Playwright never retries."
    - "STATE.md (committed, df09a24): the identical job PASSED in a sibling run of the SAME commit — proves the outcome is timing-decided, not state-decided."
    - "Differential: segments.spec.ts:43 and segments-tags.spec.ts:63 use the identical insufficient wait but never read the count value, and both pass consistently."
  falsification_test: |
    Inject a bounded delay into the preview-count response so the round-trip provably exceeds the CDP
    read window. If the hypothesis is right the CURRENT spec must fail 100% of runs with exactly
    lastGoodText === "—". If it instead still passes, the "—" does not come from the pre-response
    window and this hypothesis is wrong.
  fix_rationale: |
    Root cause is a MISSING WAIT on the asserted value, so the fix adds that wait rather than padding
    time: replace the label-visibility wait with a retrying assertion on the count paragraph itself
    (`not.toHaveText("—")`), which flips exactly when the response lands and `lastGoodCount` is set.
    The original assertions are kept and strengthened (an added /\d/ check), not weakened — no skip,
    no sleep-to-pass, no retry. The injected delay is stimulus (failure injection), not remedy: it
    makes the previously ambient race deterministic so a future regression fails every run.
  blind_spots: |
    Not yet reproduced locally — port 4000 is held by the developer's `tsx watch` dev API server and
    the config uses `reuseExistingServer: false`, so Playwright cannot start its own. The RED/GREEN
    proof and the 10x repeat run are therefore still outstanding. Also unverified empirically:
    Playwright's `toHaveText` regex anchoring semantics (avoided by using an exact-string `.not`
    assertion instead), and whether more than one preview-count request fires before the value is set.
  candidate_causes:
    - "code (test): waits on a signal that is not the asserted value, then reads it non-retryingly — CONFIRMED as the fixable cause"
    - "code (app): the label and the '—' placeholder mount together, so the UI exposes no distinct 'count settled' signal — contributing testability gap, addressed by asserting on the count text itself rather than changing the app"
    - "environment: CI runner slowness making the preview-count round-trip exceed the harness's read window — the trigger, not controllable"
    - "data: ruled out — fresh workspace with zero contacts, count is trivially 0, cannot approach the 2000ms statement_timeout"
  and_gate: |
    YES — this failure needs BOTH conditions simultaneously: the missing synchronization (code) AND a
    round-trip slower than the read window (environment). That is exactly why it is a flake rather
    than a hard failure, and why it passed and failed on the same commit. Removing either condition
    removes the failure; only the code condition is under our control, so the fix targets it and the
    injected delay pins the environment condition permanently ON so the guard cannot silently rot.

hypothesis: |
  Defect A (line 146 flake): the test synchronizes on the WRONG signal. `<p>контактов подходит</p>`
  and the count `<p>` (which renders the literal "—" placeholder while `lastGoodCount === null`)
  are emitted in the SAME React commit — both appear the instant `canPreview` flips true, which is
  300ms (debounce) after the value is typed and BEFORE the preview-count HTTP request has even been
  issued. The test then reads the count with `await countParagraph.textContent()`, a ONE-SHOT,
  NON-RETRYING snapshot, and asserts on the captured plain string. Whether it reads "—" or the
  settled number is decided purely by whether the preview-count round-trip finishes inside the
  ~10-30ms of CDP round-trips between the `toBeVisible()` wait and the `textContent()` read.
test: |
  Make the timing deterministic instead of ambient: inject a bounded delay into the first
  preview-count response so the round-trip provably exceeds the CDP read window. If the hypothesis
  holds, the CURRENT test fails 100% of the time with lastGoodText === "—" (RED), and a
  synchronization fix that waits for the numeric count makes it pass 100% of the time (GREEN).
expecting: |
  RED: `Expected lastGoodText not to be "—"` on every run with the delay injected.
  GREEN after fix: passes on every run, including with the delay still injected.
next_action: |
  NONE — session resolved. All runtime proofs executed and passed: RED 3/3 (exact reported
  signature), GREEN, 10/10 SEGM-04 repeats, 3x full suite 8/8, zero 57P01 across all 17 runs, zero
  leaked databases. Committed on fix/segm-04-live-count-race in three logical commits. Not pushed,
  no PR opened, per instruction. The dev stack was stopped for the verification window and was NOT
  restarted — the user reruns `npm run dev`.

  PRIOR next_action (kept for the record):
  ALL FOUR FIXES ARE NOW IMPLEMENTED (B was completed this session via the wrapper approach).
  Static verification passes: tsc exit 0 (run-e2e.ts confirmed IN the program via --listFiles),
  `npm run lint` exit 0, CI YAML triggers parse to {"push":{"branches":["master"]},
  "pull_request":{"branches":["master"]}}, upload-artifact step present in the e2e job.
  Fix B's drop path is PROVEN port-independently (see Evidence 2026-08-06 wrapper drop proof).

  BLOCKED AGAIN at a human-action checkpoint — a SECOND port, not covered by the prior decision.
  The E2E run needs BOTH ports free because `reuseExistingServer: false` is set on BOTH webServer
  entries. Port 4000 (PID 80379, authorized to kill) AND port 5173 (PID 70377, vite) are two leaves
  of ONE `npm run dev` stack: 70233 `npm run dev` → 70310 concurrently → {70312→70355→80379 api:4000,
  70313→70377 vite:5173, 70314→70356 worker}. Both URLs currently answer HTTP 200, so Playwright
  will hard-error on each. Killing 80379 alone accomplishes nothing and leaves the dev stack
  half-broken under a `tsx watch` supervisor.

  Once the whole dev stack is stopped:
    1. RED: `git stash` the retrying wait only (keep the injected delay), run
       `npm run test:e2e -w apps/web -- --grep SEGM-04` — must fail 100% with lastGoodText === "—".
    2. GREEN: restore the wait, rerun — must pass.
    3. 10 consecutive SEGM-04 grep repeats, then several full 8/8 suite runs.
    4. Confirm no 57P01 anywhere in the output (Fix B end-to-end).
  Branch `fix/segm-04-live-count-race` is checked out off origin/master; `npm ci` already done.
  NOTE: the developer's checkout was on `master`, 75 commits behind origin/master — it must not be
  used to author or verify this fix.

## Evidence

- timestamp: 2026-08-06
  checked: .planning/debug/knowledge-base.md and MemPalace
  found: No knowledge base file exists yet; no prior semantic match available.
  implication: No known-pattern shortcut. Investigate from first principles.

- timestamp: 2026-08-06
  checked: apps/web/e2e/segments-behavior.spec.ts lines 140-146
  found: |
    await expect(page.getByText(/контактов подходит/i)).toBeVisible({ timeout: 10_000 });
    const countParagraph = page.getByText(/контактов подходит/i).locator("xpath=preceding-sibling::p[1]");
    await expect(countParagraph).toBeVisible();
    const lastGoodText = (await countParagraph.textContent())?.trim();
    expect(lastGoodText).toBeTruthy();
    expect(lastGoodText).not.toBe("—");
  implication: |
    The only auto-retrying waits are on VISIBILITY. The value assertion is a plain-string
    `expect()` on a snapshot captured by a one-shot `textContent()` — Playwright does not retry it.
    So the test has no wait at all for the thing it actually asserts.

- timestamp: 2026-08-06
  checked: apps/web/src/features/segments/SegmentBuilder.tsx lines 651-679 (render) — verified unchanged on origin/master
  found: |
    {!canPreview ? ( <p>Заполните условия…</p> ) : (
      <>
        <p …>{lastGoodCount !== null ? lastGoodCount.toLocaleString("ru-RU") : "—"} …</p>
        <p className="text-sm text-muted-foreground">контактов подходит</p>
    …
  implication: |
    Both paragraphs are inside the SAME `canPreview` branch — they mount together in one commit.
    The "контактов подходит" label is therefore NOT a signal that the count has settled; it is a
    signal that the *request is about to start*. The count paragraph shows "—" at that moment.

- timestamp: 2026-08-06
  checked: SegmentBuilder.tsx lines 525-545 (state wiring)
  found: |
    const debouncedDefinition = useDebouncedValue(value, 300);
    const canPreview = isDefinitionReadyForPreview(debouncedDefinition);
    const previewQuery = useQuery({ queryKey: [... debouncedDefinition], enabled: Boolean(slug) && canPreview, placeholderData: keepPreviousData });
    const [lastGoodCount, setLastGoodCount] = useState<number | null>(null);
    useEffect(() => { if (previewQuery.data && "count" in previewQuery.data) setLastGoodCount(previewQuery.data.count); }, [previewQuery.data]);
  implication: |
    `canPreview` is derived from the DEBOUNCED definition, and the query is `enabled` by the very
    same flag. So the label renders and the fetch is enabled in the same tick. `lastGoodCount` can
    only become non-null one full HTTP round-trip later, via an effect on the resolved data.
    The "—" window is structural and unavoidable: it is exactly one preview-count round-trip wide.

- timestamp: 2026-08-06
  checked: apps/web/e2e/segments.spec.ts:43 and segments-tags.spec.ts:63 (differential debugging)
  found: |
    Both use the IDENTICAL wait — `await expect(page.getByText(/контактов подходит/i)).toBeVisible({ timeout: 10_000 })`
    with the comment "Live count settles (debounced request-response)" — but neither ever reads the
    count's text afterwards. Both pass consistently.
  implication: |
    Strong differential signal. The shared wait is insufficient in all three specs, but only SEGM-04
    depends on the count VALUE, so only SEGM-04 can observe the "—" window. This localizes the defect
    to the value read, and refutes any hypothesis about the wait being broken for all segment specs.

- timestamp: 2026-08-06
  checked: git show df09a24 (.planning/STATE.md Deferred Items, committed on origin/master)
  found: |
    "SEGM-04 flake — apps/web/e2e/segments-behavior.spec.ts:146 asserts a live count has resolved
    away from `—` and intermittently fails. Observed failing three times in Phase 8 CI, INCLUDING ON
    A COMMIT WHERE THE IDENTICAL JOB PASSED IN A SIBLING RUN."
  implication: |
    DECISIVE for classification. Same commit, same code, one job green and its sibling red ⇒ the
    outcome is decided by ambient timing, not by program state. This is a Heisenbug/flake and
    definitively REFUTES any deterministic-app-bug hypothesis (bad response shape, 500, missing data).

- timestamp: 2026-08-06
  checked: apps/api/src/modules/segments/segments.routes.ts:34
  found: PREVIEW_COUNT_STATEMENT_TIMEOUT_MS = 2000; route returns `{ degraded: true }` only on Postgres 57014.
  implication: |
    The test registers a BRAND NEW workspace with ZERO contacts, so the real count query is trivial
    and cannot approach a 2000ms statement_timeout. Rules out "the first real count legitimately came
    back degraded in CI" as the cause of the "—". Expected settled value is "0".

- timestamp: 2026-08-06
  checked: git rev-list --count HEAD..origin/master; git diff HEAD origin/master -- apps/web
  found: |
    Local working tree (HEAD 7235c4d, 2026-07-28) is 75 commits BEHIND origin/master (e6f4fc0,
    2026-08-06, "Merge pull request #5 from Nimther/phase-08-quality-gates"). The local tree has NO
    .github/, an old playwright.config.ts with `reuseExistingServer: true` against the DEV database,
    and no e2e/provision-database.ts or e2e/global-teardown.ts. The SegmentBuilder diff between the
    two is confined to `recapForCondition` (unrelated); the live-count logic is byte-identical.
  implication: |
    The failing infrastructure exists ONLY on origin/master. Any fix must be authored against
    origin/master, not the checked-out tree. The live-count analysis above still applies verbatim
    because that code did not change.

- timestamp: 2026-08-06
  checked: node_modules/playwright/lib/runner/index.js:5852 (createGlobalSetupTasks) and :5686 (teardown registration), Playwright 1.61.1
  found: |
    createGlobalSetupTasks returns, in SETUP order:
      createRemoveOutputDirsTask(), ...createPluginSetupTasks(config)  // <- webServer starts here
      ...globalTeardowns.map(createGlobalTeardownTask).reverse(), ...globalSetups.map(...)
    and each task's teardown is registered with `teardownRunner._tasks.unshift({... setup: task.teardown })`
    — i.e. teardowns run in REVERSE order of setup.
  implication: |
    Therefore the globalTeardown hook runs BEFORE the webServer plugin's teardown stops the servers.
    The comment in apps/web/e2e/global-teardown.ts — "the drop still has to be a hook, because it must
    run after the servers have stopped" — is factually WRONG. The API server is still live, holding
    pool connections, when the drop executes.

- timestamp: 2026-08-06
  checked: packages/test-support/src/provision-db.ts — dropEphemeralDatabase (origin/master)
  found: |
    await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [databaseName]);
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    with the comment "Terminate other backends first: DROP DATABASE fails while sessions are still
    attached, which is the normal state right after a test run."
  implication: |
    ROOT CAUSE of the 57P01 (Defect B), independent of the flake. The drop force-terminates the still-
    running API server's pool backends, and node-postgres surfaces that as
    `57P01: terminating connection due to administrator command`. It is a teardown ORDERING defect,
    not a symptom of the test failure — it must occur on every run, pass or fail.

- timestamp: 2026-08-06
  checked: git show origin/master:.github/workflows/ci.yml
  found: |
    on:
      push:                        # no branch filter at all
      pull_request:
        branches: [master]
    concurrency group is ${{ github.workflow }}-${{ github.ref }}; for a push github.ref is
    refs/heads/<branch> and for a pull_request it is refs/pull/N/merge — two DIFFERENT groups.
    The `e2e` job is `continue-on-error: true` and has NO actions/upload-artifact step, despite
    playwright.config.ts setting `trace: "retain-on-failure"`.
  implication: |
    Defect C: an open PR from a branch in the same repo matches both triggers and the concurrency
    key cannot dedupe them, so every push to a PR branch runs the whole matrix twice.
    Defect D: traces ARE produced on failure but are discarded with the runner, which is why this
    flake had to be diagnosed from source rather than from CI evidence.

- timestamp: 2026-08-06
  checked: node_modules/playwright/lib/runner/index.js:5686 (TaskRunner.runDeferCleanup) — Playwright 1.61.1
  found: |
    for (const task of this._tasks) {                                   // setup order
      teardownRunner._tasks.unshift({ setup: task.teardown });          // PREPEND
      await task.setup?.(context, errors, softErrors);
    }
    Teardown tasks are UNSHIFTED, so they execute in exact reverse of setup order.
  implication: |
    Definitive confirmation of Defect B's premise. Effective teardown order is:
    globalSetup teardown → globalTeardown (THE DROP) → webServer plugin teardown (STOPS THE SERVERS).
    The database is dropped while the API server is still live. No fix inside globalTeardown can
    reorder this, because globalTeardown IS the hook that runs too early — the drop has to move
    outside Playwright's lifecycle entirely.

- timestamp: 2026-08-06
  checked: node_modules/playwright-core/lib/coreBundle.js:60088 / :60836 (page.route / context.route)
  found: "this._routes.unshift(new RouteHandler(...))" — newly registered route handlers are PREPENDED.
  implication: |
    Load-bearing for the fix: the most recently registered handler matches first, so SEGM-04's
    existing degraded-response route (registered mid-test) still takes precedence over the
    delay-injection handler registered earlier. The injected delay applies only to the pre-degraded
    phase, exactly as intended, and phase two is unaffected.

- timestamp: 2026-08-06
  checked: Local reproduction attempt — docker availability and port state
  found: |
    `docker` is not installed on this machine (no docker/colima/podman), but Postgres (5432) and
    Redis (6379) are running natively, so the stack is otherwise runnable. Port 4000 is held by
    PID 80379 — `tsx watch src/server.ts`, the developer's dev API server. playwright.config.ts sets
    `reuseExistingServer: false` deliberately, so Playwright refuses to reuse it and cannot bind 4000.
    apps/web/vite.config.ts hardcodes the dev proxy target to http://localhost:4000, so running the
    suite on alternate ports would silently exercise different wiring than CI.
  implication: |
    The RED/GREEN proof and the required 10x repeat run are BLOCKED on port 4000 being free.
    This is the checkpoint — everything else is diagnosed and, for A/C/D, implemented.

- timestamp: 2026-08-06
  checked: Port state for BOTH webServer entries, and the process tree behind them
  found: |
    playwright.config.ts sets `reuseExistingServer: false` on BOTH webServers, so BOTH
    http://localhost:4000/api/auth/ok and http://localhost:5173 must be unoccupied. Both currently
    answer HTTP 200. `lsof`/`ps` resolve them to two leaves of a SINGLE dev stack:
      70233 `npm run dev`
        └ 70310 concurrently -n api,web,worker
            ├ 70312 → 70355 `tsx watch src/server.ts` → 80379  (LISTEN *:4000)   <- authorized kill
            ├ 70313 → 70377 `vite`                             (LISTEN [::1]:5173) <- NOT authorized
            └ 70314 → 70356 `tsx watch src/server.ts`          (worker, no port)
  implication: |
    The prior decision authorized killing PID 80379 only ("kill only that process, nothing else"),
    which was scoped to the port-4000 evidence available at the time. Port 5173 is a NEW blocker:
    killing 80379 alone frees neither the run nor anything else, and leaves a half-broken dev stack
    under a live `tsx watch` supervisor that may respawn it. Freeing the run requires stopping the
    whole `npm run dev` stack (PID 70233), which is beyond the granted authorization.

- timestamp: 2026-08-06
  checked: Fix B drop path, proven WITHOUT the servers or the ports (isolated experiment)
  found: |
    Created a real ephemeral database via the same `createEphemeralDatabase` provisioning uses and
    wrote the state file exactly as provision-database.ts does, then ran the new wrapper with the
    child short-circuited (`--help`) and with `TEST_ADMIN_DATABASE_URL` and `DATABASE_URL` DELETED
    from its environment:
      db exists BEFORE  : true
      wrapper exit      : 0
      db exists AFTER   : false
      state file remains: false
  implication: |
    Three things confirmed at once: (1) the wrapper does perform the drop that globalTeardown used
    to; (2) it reaches the admin role via the `adminDsn` RECORDED IN THE STATE FILE, not via ambient
    env — which matters because the wrapper is a separate parent process that never loads the env
    file the way playwright.config.ts does; (3) it cleans up the state file and preserves the child's
    exit code. This is mechanism-level proof of Fix B. It does NOT prove the absence of 57P01 in a
    real run — that still requires the full stack and therefore the ports.

- timestamp: 2026-08-06
  checked: Dev stack stopped under orchestrator Decision 3, to free BOTH ports
  found: |
    Re-verified PID 70233 before killing: `ps` → `npm run dev`, and its cwd (lsof -d cwd) →
    /Users/primeropanther/Projects/mega-crm. The tree matched the recorded one exactly (70233 →
    70310 concurrently → {70312→70355→80379 api, 70313→70377 vite, 70314→70356 worker}), so no PID
    recycling had occurred. Sent SIGTERM to all nine PIDs SIMULTANEOUSLY rather than top-down,
    specifically so `tsx watch` could not observe a dead child and respawn it. First poll:
    remaining_pids=[] port_listeners=[] — no survivors, no respawn, both ports free.
  implication: The blocker is cleared without touching any process outside this repo's dev stack.

- timestamp: 2026-08-06
  checked: RED PROOF — retrying wait reverted to the exact pre-fix block, injected delay KEPT
  found: |
    3 runs, 3 failures (exit 1 each), every one with the precise predicted signature:
      Error: expect(received).not.toBe(expected)  //  Expected: not "—"
      at segments-behavior.spec.ts:176   →  expect(lastGoodText).not.toBe("—")
    Failure duration 2.7s (the read lands inside the injected 1000ms window).
  implication: |
    The falsification test's prediction held EXACTLY: with the environment condition pinned on, the
    pre-fix test fails 100% of runs with lastGoodText === "—" — the same assertion, same value, same
    line as the CI failure. This is the mutation guardrail: removing the fix demonstrably reintroduces
    the reported bug, so the fix is load-bearing and the test is not vacuously green.

- timestamp: 2026-08-06
  checked: GREEN PROOF + 10 consecutive SEGM-04 repeats, fix restored (checksum-verified identical)
  found: |
    GREEN: exit 0, 1 passed. Repeats: 10/10 passed, 0 failed.
    Durations: 4.1, 4.1, 4.3, 4.2, 4.1, 4.2, 4.2, 4.1, 4.2, 4.1s — spread of 0.2s.
    The pass duration exceeds the RED failure duration by ~1.4s, i.e. the test now demonstrably
    WAITS OUT the injected 1000ms delay instead of racing it.
  implication: |
    The fix converts an ambient race into a synchronized wait. The near-zero duration variance is the
    positive signature: a timing-decided test would scatter, a properly synchronized one clamps to
    the delay it waits on. RED 3/3 → GREEN 11/11 on identical infrastructure isolates the outcome to
    the single reverted assertion.

- timestamp: 2026-08-06
  checked: Fix B end-to-end in real runs — 57P01 across ALL 17 runs (3 RED + 1 GREEN + 10 repeats + 3 full)
  found: |
    `grep -c 57P01` → 0 in every single log, and `grep -c "terminating connection"` → 0 as well.
    Critically this includes the 3 FAILING red runs: the drop still executed and the child's exit
    code 1 was still propagated. Verified the ephemeral database from red-run-1 was gone afterwards
    (pg_database count = 0), and after all 17 runs `SELECT datname ... LIKE 'mega_crm_test_e2e_%'`
    returned ZERO rows, with no leftover state file in TMPDIR and both ports released.
  implication: |
    Defect B is fixed end-to-end, not just at the mechanism level. The previously unconditional
    57P01 is absent from green AND red runs, which is the right test because the defect was never
    outcome-dependent. Zero leaked databases over 17 provisions proves the wrapper's drop runs on
    every exit path, and the freed ports confirm the webServer plugin now stops the servers BEFORE
    the drop rather than after it.

- timestamp: 2026-08-06
  checked: THREE full E2E suite runs (npm run test:e2e, no grep)
  found: "8 passed (31.7s) / 8 passed (31.5s) / 8 passed (31.1s) — exit 0 each, 57P01 count 0 each."
  implication: |
    The fix does not regress the other 7 specs, and total runtime is stable across runs. Combined
    with the 10 repeats this is 13 consecutive green SEGM-04 executions.

- timestamp: 2026-08-06
  checked: Static gates re-run on the RESTORED tree (after the RED mutation was reverted)
  found: |
    Spec file checksum after restore == checksum of the pre-mutation backup (5547ca4f…), and
    `grep RED-PROOF` finds nothing, so no mutation residue survived. `npx tsc -p apps/web/tsconfig.json
    --noEmit` → exit 0; `npm run lint` → exit 0; `git status --short` shows exactly the 8 intended
    files and nothing else.
  implication: Verified state and committed state are the same state — the proofs describe what ships.

- timestamp: 2026-08-06
  checked: Static gates after implementing Fix B
  found: |
    - `npx tsc -p apps/web/tsconfig.json --noEmit` → exit 0, and `--listFiles` confirms
      `apps/web/e2e/run-e2e.ts` is genuinely IN the program (tsconfig `include` covers "e2e").
    - `npm run lint` → exit 0.
    - eslint reports run-e2e.ts as "no matching configuration": the config only covers
      `apps/web/e2e/**/*.spec.ts`, so provision-database.ts is equally uncovered. Pre-existing
      baseline, verified directly — not a regression introduced by this change.
    - CI YAML parses to {"push":{"branches":["master"]},"pull_request":{"branches":["master"]}} and
      the e2e job's step list ends with "Upload Playwright trace and results" → C and D confirmed.
    - `npm run check:root-hygiene` → exit 1, but solely on a pre-existing `.DS_Store` in the working
      root. Unrelated to this change and impossible on a CI runner.
  implication: Everything verifiable without the ports is verified. Only the runtime proofs remain.

## Eliminated

- hypothesis: The app fails to fetch or apply the preview count in CI (bad response, 500, or a real degraded response), so `lastGoodCount` stays null permanently.
  evidence: |
    STATE.md records the identical job PASSING in a sibling run of the SAME commit — a deterministic
    app/response defect cannot pass and fail on identical code and data. Additionally the workspace is
    freshly created with zero contacts, so the count query cannot approach the 2000ms statement_timeout
    that is the only trigger for `{ degraded: true }`.
  timestamp: 2026-08-06

- hypothesis: The `xpath=preceding-sibling::p[1]` locator resolves to the wrong element (or matches multiple) in CI.
  evidence: |
    A locator defect would produce a strict-mode violation or a locator timeout, not the specific
    observed value "—". "—" is the exact literal the count paragraph renders while
    `lastGoodCount === null`, which places the read inside the pre-response window rather than on the
    wrong element. The `canPreview === false` copy ("количество подходящих контактов") does not match
    /контактов подходит/i, so there is no competing match.
  timestamp: 2026-08-06

- hypothesis: The debounce never settles (unstable `value` object identity resetting the 300ms timer), so the query never fires.
  evidence: |
    If `debouncedDefinition` never settled, `canPreview` would stay false and the `контактов подходит`
    label would never render — the test would fail at line 140 on the visibility wait, not at line 146
    with a materialized "—". The observed failure is at 146, so the label DID render.
  timestamp: 2026-08-06

- hypothesis: The 57P01 is a downstream consequence of the SEGM-04 assertion failure.
  evidence: |
    Playwright 1.61.1's task ordering (verified in node_modules) runs globalTeardown before the
    webServer plugin stops the servers, and dropEphemeralDatabase unconditionally calls
    pg_terminate_backend on every session attached to the database. This is independent of test
    outcome — it happens on green runs too. Separate defect, separate fix.
  timestamp: 2026-08-06

## Resolution

root_cause: |
  Four independent defects, not one. (A) is the reported flake; (B) is a real teardown-ordering bug
  that the reporter correctly noticed alongside it; (C) and (D) are CI defects that made the flake
  both more visible and impossible to diagnose from CI evidence.

  A) SEGM-04 flake — MISSING SYNCHRONIZATION IN THE TEST, not an app bug. SegmentBuilder renders the
     count paragraph (showing the literal "—" while `lastGoodCount === null`) and the
     «контактов подходит» label in the SAME React commit, both gated on `canPreview`, which is
     derived from the 300ms-debounced definition and ALSO gates `enabled` on the preview-count query.
     The numeric count is only committed to state by an effect on the resolved response, one full
     HTTP round-trip later. The test waited on the label's visibility — a signal that the request is
     about to start — and then captured the count with a one-shot, non-retrying `textContent()`.
     Whether it read "—" or the settled number was decided purely by whether that round-trip beat the
     harness's own ~10-30ms of CDP round-trips. AND-gate: the failure needs the missing wait (code)
     AND a round-trip slower than the read window (loaded CI runner), which is exactly why the same
     commit passed in one CI job and failed in its sibling.
  B) 57P01 — teardown ORDERING. Verified from Playwright 1.61.1 source: teardown tasks are
     `unshift`ed, so they run in reverse of setup order, which puts `globalTeardown` BEFORE the
     webServer plugin's shutdown. `dropEphemeralDatabase` then runs `pg_terminate_backend` against
     every session on the database while the API server is still live, and node-postgres surfaces the
     killed pool connections as `57P01: terminating connection due to administrator command`.
     Independent of test outcome — it happens on green runs too. NOT a consequence of (A).
  C) Duplicate CI runs — `on: push:` was unscoped, so any branch with an open PR matched both `push`
     and `pull_request`; the concurrency group keyed on `github.ref` could not collapse them because
     the two events carry different refs (refs/heads/<branch> vs refs/pull/N/merge).
  D) No trace upload — `trace: "retain-on-failure"` did record traces, but the e2e job had no
     `actions/upload-artifact` step, so they were discarded with the runner. This is why (A) had to
     be diagnosed by reading source rather than by opening the trace from a failing run.

fix: |
  A) IMPLEMENTED — apps/web/e2e/segments-behavior.spec.ts. Replaced the label-visibility wait as the
     sole gate with a retrying assertion on the value actually read:
     `await expect(countParagraph).not.toHaveText("—", { timeout: 15_000 })`, which flips at the exact
     moment a response lands and `lastGoodCount` is set. Original assertions kept and STRENGTHENED
     (added `expect(lastGoodText).toMatch(/\d/)`), never relaxed. Additionally injected a bounded
     1000ms delay on the FIRST preview-count response via `page.route` + `route.continue()` so the
     previously ambient race is deterministic on every machine — stimulus, not remedy: with the delay
     in place, removing the retrying wait fails the test 100% of the time.
  B) IMPLEMENTED — new file `apps/web/e2e/run-e2e.ts`, now the `test:e2e` script
     (`tsx e2e/run-e2e.ts`). No fix inside `globalTeardown` can work, because `globalTeardown` is
     itself the hook that runs too early, so the drop moved OUT of Playwright's lifecycle entirely:
     the wrapper spawns `playwright test` (CLI resolved via `require.resolve("@playwright/test/cli")`
     and run under the same `process.execPath` — no shell, no `npx`, no PATH re-resolution), waits
     for `close`, and only then performs the guarded drop. By that point the webServer plugin has
     stopped both servers and their pools are closed, so `pg_terminate_backend` has nothing live to
     kill and no client remains to surface a 57P01.
     Supporting changes: `globalTeardown` removed from playwright.config.ts and
     `apps/web/e2e/global-teardown.ts` DELETED (keeping it would keep firing the early drop);
     `tsx` `^4.19.2` added to apps/web devDependencies — declared explicitly rather than relied on
     via root hoisting, the same mistake 08-07 fixed for `vitest`.
     Load-bearing details: `stdio: "inherit"` (CI greps the `[e2e:database]` marker out of piped
     output); state still travels through the temp file because provisioning runs in the child and
     the drop in the parent; the recorded `adminDsn` is what gets the wrapper to the admin role,
     since the wrapper never loads the env file; SIGINT/SIGTERM are trapped so an interrupted run
     still drops rather than leaking; exit-code precedence is test-result-first (a red run stays red;
     a failed drop only recolours an otherwise-green run; a signalled run exits 128+N).
     CONSEQUENCE, documented in both the config and SPECIFICATION.md: the suite must be run via
     `npm run test:e2e`, because a bare `playwright test` now drops nothing.
  C) IMPLEMENTED — .github/workflows/ci.yml: `push` scoped to `branches: [master]`. A PR is checked by
     `pull_request`; master is checked by `push` after merge; no path into master is left unchecked.
  D) IMPLEMENTED — .github/workflows/ci.yml: `actions/upload-artifact` (pinned to the full commit SHA
     per repo convention) uploading `apps/web/test-results/` and `e2e-output.txt`, with `if: always()`
     (the job is `continue-on-error: true` and the point is to capture FAILED runs) and
     `if-no-files-found: ignore` (a green run records no trace by design).

oracle_type: |
  specified — the asserted property ("after a preview-count response lands, the displayed last-good
  count is a number, and it survives a subsequent degraded response") comes from SEGM-04's stated
  behavioral requirement, not from a crash or an implicit signal.

verification: |
  COMPLETE. All four defects verified, including every runtime proof that was previously blocked.

  RUNTIME PROOFS (dev stack stopped under Decision 3; ports 4000/5173 confirmed free first):
  - RED 3/3: with the retrying wait reverted to the exact pre-fix block and the injected delay kept,
    SEGM-04 failed on every run with the precise reported signature — `Expected: not "—"` at
    `expect(lastGoodText).not.toBe("—")`. The predicted 100% failure rate held exactly.
  - GREEN: with the fix restored (checksum-verified identical to the pre-mutation file), exit 0.
  - 10 consecutive SEGM-04 repeats: 10/10 passed, durations 4.1–4.3s (0.2s spread). The pass
    duration exceeds the RED failure duration by ~1.4s, i.e. the test now waits the injected delay
    out instead of racing it; the near-zero variance is the signature of real synchronization.
  - 3 full suite runs: 8 passed / 8 passed / 8 passed, exit 0 each. No regression in the other specs.
  - 57P01: `grep -c` → 0 across ALL 17 runs, including the 3 FAILING red ones (the right test, since
    the defect was never outcome-dependent). `terminating connection` → 0 likewise.
  - No leaks over 17 provisions: zero `mega_crm_test_e2e_%` databases remain, no state file in
    TMPDIR, both ports released — confirming the servers now stop BEFORE the drop.

  MUTATION GUARDRAIL: satisfied. Reverting the fix reintroduces the exact reported failure
  deterministically, so the fix is load-bearing and the green result is not vacuous.

  STATIC GATES (re-run on the restored tree): `tsc -p apps/web/tsconfig.json --noEmit` exit 0;
  `npm run lint` exit 0; `git status --short` shows exactly the 8 intended files, no mutation residue.

  NOT CLAIMED: that CI itself is green. The environment condition that CI supplies intermittently is
  now pinned ON permanently by the injected delay, so a local pass is strictly stronger evidence than
  a pre-fix CI pass was — but the CI run itself is the user's to observe.

  PRIOR (pre-port) verification, retained:
  - `npx tsc -p apps/web/tsconfig.json --noEmit` → exit 0, with `--listFiles` confirming
    `apps/web/e2e/run-e2e.ts` is actually in the program (not silently excluded).
  - `npm run lint` → exit 0.
  - CI workflow parsed with the `yaml` package → triggers resolve to
    {"push":{"branches":["master"]},"pull_request":{"branches":["master"]}} (C), and the e2e job's
    steps end with "Upload Playwright trace and results" (D).
  - Wrapper exit-code propagation: `--help` → 0; bad `--config` → 1.
  - Fix B MECHANISM PROVEN without the servers: a real ephemeral database plus a state file written
    exactly as provisioning writes it, then the wrapper run with `TEST_ADMIN_DATABASE_URL` and
    `DATABASE_URL` stripped from its environment → db existed before, gone after, state file
    removed, exit code preserved.

  (The four items listed here as BLOCKED — RED, GREEN, repeats, and 57P01-in-a-real-run — have all
  since been executed and passed; see the RUNTIME PROOFS section above.)
files_changed:
  - apps/web/e2e/segments-behavior.spec.ts   (A — retrying wait + failure injection + /\d/ assertion)
  - apps/web/e2e/run-e2e.ts                  (B — NEW: the test:e2e wrapper that owns the drop)
  - apps/web/e2e/global-teardown.ts          (B — DELETED: it was the hook that ran too early)
  - apps/web/playwright.config.ts            (B — globalTeardown entry removed + rationale)
  - apps/web/package.json                    (B — test:e2e → tsx e2e/run-e2e.ts; tsx devDependency)
  - package-lock.json                        (B — lockfile sync for the tsx devDependency)
  - SPECIFICATION.md                         (B — §2.4 tsx row; §3.1 E2E teardown rewritten)
  - .github/workflows/ci.yml                 (C — push scoped to master; D — trace upload)

why_not_caught: |
  No gate existed for this class — and the two that should have spoken were structurally muted.

  (A) The E2E lane itself was the gate, and it FIRED — three times in Phase 8 CI. It was not
  believed, because a test that fails intermittently reads as noise rather than signal; it was
  recorded as a deferred flake in STATE.md instead of being investigated. The deeper reason it could
  not be actioned is that the failure depended on an environment condition (a slow round-trip) that
  no gate controlled, so nobody could reproduce it on demand — the test was only ever a gate on
  loaded CI runners, never on a developer machine.
  (D) made this self-sealing: `trace: "retain-on-failure"` was producing exactly the artifact needed
  to diagnose it, and the job discarded it with the runner. The evidence was generated and thrown
  away on every occurrence, which is why (A) ultimately had to be diagnosed by reading React render
  order and Playwright's own source instead of by opening a trace.
  (B) was never a flake at all — 57P01 occurred on every run, green ones included — but because
  `continue-on-error: true` kept the job from going red and the message only appeared in teardown
  output, it was read as a symptom of (A) rather than as an independent defect.
  (C) doubled every run, which doubled the flake's apparent frequency while halving confidence in
  any individual result.

  Root process lesson: the failing gate was downgraded to a note. An intermittent failure is a gate
  reporting a real defect at a low duty cycle, not a gate malfunctioning.

recurrence_guard: |
  Four concrete artifacts, one per defect — none of them a convention or a reminder:

  1. (A) REGRESSION TEST, hardened by failure injection —
     apps/web/e2e/segments-behavior.spec.ts : "degraded live-count state shows the amber marker and
     preserves the last-good count (SEGM-04)". The retrying assertion
     `await expect(countParagraph).not.toHaveText("—", { timeout: 15_000 })` is the guard; the
     permanent 1000ms delay injected into the FIRST preview-count response is what gives it teeth.
     This is the key move: the environment condition that made the bug a flake is now pinned ON for
     every machine, so the guard cannot silently rot. Proven by mutation — reverting the assertion
     fails the test 3/3 rather than once every few CI runs. A future regression fails on a laptop.
  2. (A, strengthening) `expect(lastGoodText).toMatch(/\d/)` — closes the oracle gap where `not "—"`
     alone would have accepted an empty or spinner-only paragraph.
  3. (B) STRUCTURAL FIX, not a test — the drop was moved out of Playwright's lifecycle into
     apps/web/e2e/run-e2e.ts, and apps/web/e2e/global-teardown.ts was DELETED so the early-firing
     hook cannot be reintroduced by accident. The ordering defect is now impossible rather than
     merely unobserved; `tsx` is declared in apps/web devDependencies rather than relied on via root
     hoisting (the same failure mode 08-07 fixed for vitest).
  4. (D) CI ARTIFACT UPLOAD — `actions/upload-artifact` (SHA-pinned) with `if: always()`, so the next
     intermittent failure is diagnosable from its own trace instead of from source archaeology. This
     is the guard against the *diagnosis* cost recurring, which was the larger cost here.
  5. (C) `on: push:` scoped to `branches: [master]` — removes the duplicate-run noise that obscured
     the signal.

  Known residual: eslint's config covers only `apps/web/e2e/**/*.spec.ts`, so run-e2e.ts and
  provision-database.ts are unlinted. Pre-existing and verified as such, not introduced here — worth
  a separate follow-up to widen the eslint glob to the e2e harness files.
