---
status: resolved
trigger: "alloy-not-durable-in-production-deploy"
created: 2026-08-28
updated: 2026-08-28
---

## Symptoms

DATA_START
**Expected behavior:**
Routine production deploy explicitly and idempotently converges the Alloy log-shipping service (starts it if absent, updates it if config/image changed) without recreating db/redis, and fails clearly when required Loki configuration is unavailable.

**Actual behavior:**
The standard production deploy does not converge the Alloy service at all. `docker/docker-compose.prod.yml` defines Alloy, but `scripts/deploy.sh` never starts or updates it. Consequences:
- If Alloy is already running, an app deploy may leave it running (appears healthy, proves nothing about lifecycle durability).
- On a fresh host, after manual removal, or when Alloy was never created, routine deploy completes without an Alloy container.
- Application services are healthy, but no logs reach Grafana Cloud Loki until an operator manually starts Alloy.

NOT the issue: Alloy WAL/positions persistence. The failing state is that the container is absent, not crashing or losing state.

**Error messages:**
None — the failing state is container absence, not a crash. Concrete evidence:
- `docker/docker-compose.prod.yml` defines the `alloy` service.
- `scripts/deploy.sh` contains zero references to alloy and never runs a compose up for it.
- During the Phase 17 live checkpoint, the intended "verify Alloy is still running" step failed conceptually: Alloy had never been durably deployed by the routine workflow — the step had to become "establish then verify".
- The operator had to provision Loki credentials and start Alloy manually. After that manual start, Alloy was healthy: expected Loki labels present, RestartCount 0.

**Timeline:**
Never verified — Alloy deploy-survival/convergence was never explicitly part of the deploy workflow. Discovered via production inspection plus deploy-script inspection during Phase 17.

**Reproduction:**
Deterministic reproduction requires a state where Alloy is absent (fresh host or isolated compose-project test fixture):
1. Confirm no Alloy container exists.
2. Run the standard `scripts/deploy.sh` workflow.
3. Deploy completes and starts/updates web, api, migrate, worker.
4. Alloy remains absent because deploy.sh never converges that service.
5. New application logs are not shipped to Loki.

CONSTRAINT: Do NOT reproduce by removing the live production Alloy container. Prove with deploy-script tests or an isolated compose project, then use a controlled production deploy as final UAT.
DATA_END

## Current Focus

bug_class: Bohrbug (deterministic — the omission is static in the script text; every routine deploy reproduces it)

hypothesis: scripts/deploy.sh's service-convergence step enumerates only application services (web, api, migrate, worker) and never includes the alloy sidecar, so a routine deploy cannot create or update Alloy — the fix is to make deploy.sh idempotently converge alloy (without touching db/redis) and fail clearly when required Loki env vars are missing
test: `grep -c -i alloy scripts/deploy.sh` plus a full read of the script's compose surface; cross-read docker/docker-compose.prod.yml's alloy service and docker/alloy/config.alloy env() requirements
expecting: zero alloy references and a compose surface strictly limited to api/worker/web/migrate
next_action: RESOLVED — production UAT passed on 2026-08-28 for master SHA f59bf1ab0d654a64ca634ef257d821e74d7aea55. The real deploy completed, Alloy was recreated by the dedicated convergence leg, remained running with RestartCount 0, and its internal Loki metrics proved 201 fresh entries / 35,220 bytes accepted after startup catch-up. Session archived; WINDOWS id 10 may be closed.

reasoning_checkpoint:
  hypothesis: "scripts/deploy.sh's compose surface omits the `alloy` service entirely, so no routine deploy can create, update, or observe the log-shipping sidecar; compounding it, the service's `env_file: { required: false }` plus Alloy's empty-tolerant `env()` mean absent Loki credentials fail nothing anywhere, so the pipeline can also be 'deployed' yet shipping nowhere."
  confirming_evidence:
    - "`grep -c -i alloy scripts/deploy.sh` = 0 and `grep -c -i grafana scripts/deploy.sh` = 0 — direct observation, not inference"
    - "Full read of the script: the complete mutating compose surface is `pull api worker web`, `run --rm --no-deps migrate`, `up -d --no-deps web api`, `stop --timeout worker`, `up -d --no-deps worker`. print_dry_run mirrors exactly those five."
    - "docker-compose.prod.yml declares `alloy` with `env_file: { path: ${MEGA_CRM_ENV_FILE}, required: false }` — compose is contractually forbidden from failing on a missing credential file"
    - "docker/alloy/config.alloy reads exactly three `env()` names; docker/prod.env.example ships all three BLANK, so a copied-but-unfilled env file is the default failure shape"
    - "scripts/validate-prod-compose.mjs already lists alloy in EXPECTED_SERVICES and FIRST_PARTY_IMAGE_SERVICES — the compose-side contract knows about alloy; the gap is one-sided, deploy.sh does not"
  falsification_test: "If deploy.sh contained any alloy convergence at all — an explicit `up`, a service list including it, or a `--profile` that pulls it in — the hypothesis is wrong. Grep returned zero occurrences of both the service name and its credential prefix; a full read of all 432 lines found no indirect path (no service-array variable, no wildcard `up -d` without an explicit service list). Refuted only by finding a convergence path outside this file, and the operator's own live finding (Alloy had to be started by hand) is independent confirmation there is none."
  fix_rationale: "Three legs, each addressing a confirmed cause rather than the symptom. (1) Credential preflight reading MEGA_CRM_ENV_FILE for the three GRAFANA_* keys (non-empty + https push URL, T-15-64), before any mutation — closes the config-category cause that compose's `required: false` deliberately leaves open. (2) `compose up -d --no-deps alloy` unconditionally in the real deploy, after the worker leg, plus `alloy` appended to the pull list — closes the code-category cause; `--no-deps` preserves the leg-isolation contract established after the 17-05 live db-cutover finding. Bind-mounted config.alloy changes do NOT re-trigger a compose recreate on their own, so an `ALLOY_CONFIG_HASH` computed by deploy.sh and interpolated into the alloy service's `environment:` makes compose's own config-hash convergence fire exactly when the config content or image changed — this is what makes it an UPDATE and not merely a start. (3) Post-convergence verification on State.Running plus a RestartCount DELTA (not `== 0`) — the service declares no healthcheck, so container-existence is the only thing compose proves, and G-15-4 showed existence is compatible with shipping nothing."
  blind_spots:
    - "The docker-stub tests cannot prove compose's recreate-on-config-hash-change semantics. That claim rides on compose's documented contract; GREEN must additionally prove the interpolation lands via a mutation-free `docker compose config` render with ALLOY_CONFIG_HASH set."
    - "RestartCount delta over a bounded window catches a fast restart loop; a loop with Docker's maximum ~60s exponential backoff could sample as stable inside a short window. Accepted: G-15-4's real signature was a tight loop, and the alternative (RestartCount == 0) is over-strict, which the guard test at the boundary pins."
    - "Not yet exercised against a real Alloy binary or a real Docker daemon — no daemon in this sandbox (repo rule #5), and the hard constraint forbids touching the live container."
    - "Whether the operator's real MEGA_CRM_ENV_FILE quotes its values (`KEY=\"value\"`) is unverified; the preflight's non-empty match must tolerate quoted and unquoted forms."
  candidate_causes:
    - "code: scripts/deploy.sh's compose surface enumerates api/worker/web/migrate and omits alloy (CONFIRMED — grep = 0)"
    - "config: docker-compose.prod.yml's alloy `env_file: required: false` + Alloy's empty-tolerant `env()` make absent Loki credentials a silent no-op rather than a loud failure (CONFIRMED — read directly from both files)"
    - "environment: RULED OUT as a cause — the fresh-host/absent-container state is a CONSEQUENCE of the code cause, not an independent contributor; the same omission reproduces on any host"
    - "data: N/A — no data path is involved in service convergence"
  and_gate: "yes. The reported symptom is 'apps healthy, zero logs, zero errors'. The code cause alone yields an absent container. The config cause alone yields a present-but-silent container. BOTH must be closed for the stated expected behavior ('starts it if absent, updates it if config/image changed, AND fails clearly when required Loki configuration is unavailable') to hold — which is why the fix has two independent legs mapped one-to-one onto the two causes, plus a verification leg that makes the convergence claim falsifiable."

fix_contract:
  # The exact behavioral contract the RED tests encode. GREEN implements to this.
  preflight: "Real-deploy path only (never --dry-run). Read $MEGA_CRM_ENV_FILE; require GRAFANA_LOKI_PUSH_URL, GRAFANA_LOKI_USER, GRAFANA_CLOUD_API_TOKEN each present AND non-empty; require the push URL to begin with https://. On failure: exit non-zero, stderr names the offending key, ZERO docker invocations, no record file written. Placement: alongside check_required_env/validate_host_kek, before any mutation."
  pull: "`compose pull api worker web alloy` — alloy appended to the existing list (existing substring assertions still match)."
  converge: "`compose up -d --no-deps alloy`, after the worker leg, UNCONDITIONAL — outside the skip_worker_replace guard, so a same-SHA re-run is a working repair path. Before the SHA record write."
  config_hash: "deploy.sh computes a hash of docker/alloy/config.alloy (node + crypto — node is already a stated dependency; avoids sha256sum/shasum portability) and exports ALLOY_CONFIG_HASH. docker-compose.prod.yml's alloy service gains one mapping-style `environment:` entry `ALLOY_CONFIG_HASH: ${ALLOY_CONFIG_HASH:-}` so compose's own config-hash recreates the container exactly when the config content or image changed. Mapping-style `environment:` (not `labels:`) because scripts/validate-prod-compose.mjs's hand-rolled parser explicitly supports it (findEnvironmentMap)."
  verify: "Bounded poll, knobs ALLOY_STABLE_TIMEOUT_SECONDS / ALLOY_STABLE_POLL_INTERVAL_SECONDS, on `docker inspect --format '{{.State.Running}} {{.RestartCount}}' $(compose ps -q alloy)`. Accept when Running is true and RestartCount is stable across samples. Reject when not running, or when RestartCount climbs between samples. On failure: exit non-zero naming alloy, SHA NOT recorded (same late-leg semantics as the worker-healthy timeout). MUST NOT reject a stable container whose RestartCount is merely non-zero."
  green_phase_gates:
    - "npx vitest run --config scripts/vitest.config.ts scripts/__tests__/deploy-script.test.mjs → 36/36"
    - "node scripts/validate-prod-compose.mjs (compose edit)"
    - "npm run verify:alloy-config"
    - "ALLOY_CONFIG_HASH=deadbeef docker compose -f docker/docker-compose.prod.yml config → prove the interpolation lands (mutation-free render, no container touched). NOTE: also needs GHCR_IMAGE_BASE / SITE_ADDRESS / MEGA_CRM_ENV_FILE / IMAGE_TAG set to render cleanly — dummy values suffice, the render is the point, not the values."
    - "node scripts/check-spec-env-coverage.mjs — ALLOY_CONFIG_HASH is a NEW compose-interpolated variable and that gate exists to catch env vars missing from SPECIFICATION.md; its enumeration source is unverified for this case, so run it rather than discover it in CI"
    - "SPECIFICATION.md: ALLOY_CONFIG_HASH into the interpolated-var list beside ALLOY_MEM_LIMIT (§5), and the deploy-pipeline section gains the alloy leg — project rule requires the doc update in the SAME change"
    - "docs/runbooks/deploy-and-rollback.md: a 'What to do when a stage fails' subsection for the alloy leg (not gate-blocking — check-runbook-coverage.mjs enumerates *_ALERT_NAME constants only — but the runbook's existing per-stage structure expects it)"

tdd_checkpoint:
  test_file: "scripts/__tests__/deploy-script.test.mjs"
  test_name: "alloy convergence: the log-shipping sidecar is part of the deploy contract (+ two extended leg-isolation assertions)"
  status: "green"
  green_output: "Test Files 1 passed (1) / Tests 36 passed (36), 41.9s. Both guard tests green: 'does not run the preflight under --dry-run' and 'accepts a stable container whose RestartCount is non-zero but no longer climbing'."
  failure_output: "Test Files 1 failed (1) / Tests 15 failed | 21 passed (36). All 19 pre-existing tests still pass — no collateral breakage. Representative failures: 'converges alloy in the real deploy, after the worker leg' → expected -1 to be greater than or equal to +0 (no `up -d --no-deps alloy` in the call log); 'aborts naming GRAFANA_LOKI_USER when that line is absent' → expected +0 not to be +0 (deploy exits 0 with no Loki credentials at all)."
  guard_tests_green_by_design:
    - "does not run the preflight under --dry-run — passes now, MUST stay green (dry-run may never require environment)"
    - "accepts a stable container whose RestartCount is non-zero but no longer climbing — passes now, MUST stay green (pins the delta check against an over-strict `RestartCount == 0`)"

## Evidence

- timestamp: 2026-08-28 (phase 0)
  checked: `.planning/debug/knowledge-base.md` for alloy/loki/deploy keyword overlap
  found: zero matches
  implication: no known-pattern shortcut; investigate from first principles

- timestamp: 2026-08-28
  checked: `grep -c -i alloy scripts/deploy.sh` and `grep -c -i grafana scripts/deploy.sh`
  found: 0 and 0 — the script never names the service or its credentials
  implication: CONFIRMS the hypothesis directly. Not an ordering/conditional bug — the service is absent from the deploy contract entirely.

- timestamp: 2026-08-28
  checked: full read of scripts/deploy.sh (432 lines) — every compose invocation
  found: the complete mutating compose surface is `pull api worker web`, `run --rm --no-deps migrate`, `up -d --no-deps web api`, `stop --timeout ... worker`, `up -d --no-deps worker`. print_dry_run mirrors exactly those. check_required_env validates only GHCR_IMAGE_BASE / SITE_ADDRESS / MEGA_CRM_ENV_FILE.
  implication: alloy can only ever exist in production via an out-of-band manual `docker compose up -d alloy`. Nothing in the routine workflow creates, updates, or even observes it.

- timestamp: 2026-08-28
  checked: docker/docker-compose.prod.yml lines 453-509 (alloy service)
  found: service exists, `image: grafana/alloy:v1.18.1` (pinned), `restart: unless-stopped`, no `depends_on`, no `healthcheck`, no `ports`, config bind-mounted read-only from `./alloy/config.alloy`, credentials via `env_file: { path: ${MEGA_CRM_ENV_FILE}, required: false }`
  implication: (a) the service is fully deployable with `up -d --no-deps alloy`; (b) NO healthcheck exists, so post-up verification must use container State.Running/RestartCount, not Docker health status (unlike the worker leg); (c) `required: false` means a missing/blank Loki credential is silently tolerated by compose — nothing fails loudly.

- timestamp: 2026-08-28
  checked: docker/alloy/config.alloy credential reads
  found: exactly three `env()` calls — GRAFANA_LOKI_PUSH_URL (loki.write endpoint.url), GRAFANA_LOKI_USER and GRAFANA_CLOUD_API_TOKEN (basic_auth). Header records T-15-64: the push endpoint MUST be https.
  implication: these three names are the complete "required Loki configuration" set the fix must preflight. They live in MEGA_CRM_ENV_FILE (blank in docker/prod.env.example), NOT in the deploy shell environment — so the preflight must read the env file, not `${VAR:?}` the shell.

- timestamp: 2026-08-28
  checked: config.alloy header (G-15-4) and docs/runbooks/log-shipping-and-backstop-alerts.md
  found: a prior production incident where alloy restart-looped forever under `restart: unless-stopped` (illegal `#` comment token), silently stopping all log delivery while appearing "deployed"
  implication: "container exists" is NOT a sufficient post-deploy assertion for this service. Convergence verification must distinguish running-and-stable from restart-looping.

- timestamp: 2026-08-28
  checked: scripts/validate-prod-compose.mjs
  found: `EXPECTED_SERVICES` already includes "alloy" (8 services) and `FIRST_PARTY_IMAGE_SERVICES` includes "alloy" (immutable-tag gate)
  implication: the compose-side contract already treats alloy as a first-class production service. The gap is one-sided: compose knows about alloy, deploy.sh does not.

- timestamp: 2026-08-28
  checked: scripts/__tests__/deploy-script.test.mjs (488 lines)
  found: a PATH-injected `docker` stub logs every invocation to DEPLOY_TEST_LOG; existing tests assert exact compose call sequencing (including the "--no-deps on every mutating invocation" leg-isolation test added after the 17-05 live db-cutover finding). No test mentions alloy.
  implication: a RED regression test is cheap and high-fidelity here — assert `up -d --no-deps alloy` appears in both the real-deploy call log and the --dry-run plan. The existing leg-isolation test also constrains the fix: any new alloy invocation MUST carry --no-deps.

- timestamp: 2026-08-28 (RED phase)
  checked: `npx vitest run --config scripts/vitest.config.ts scripts/__tests__/deploy-script.test.mjs` after adding the alloy-convergence tests
  found: 15 failed | 21 passed (36). All 19 pre-existing tests pass unchanged. The 15 failures are exactly the new/extended assertions; the 2 new guard tests pass by design.
  implication: the bug is now reproducible as a test, and the reproduction is behavioral (call-log + exit code), not a re-statement of the source text. RED established.

- timestamp: 2026-08-28 (GREEN phase)
  checked: implemented the three fix legs, then re-ran the RED command
  found: 36/36 pass (was 15 failed | 21 passed). Both load-bearing guard tests green. `bash -n scripts/deploy.sh` exits 0.
  implication: GREEN established. The behavioural contract in fix_contract is now met by the implementation, proven by the same call-log/exit-code assertions that failed in RED.

- timestamp: 2026-08-28 (GREEN phase, blind-spot closure)
  checked: `ALLOY_CONFIG_HASH=deadbeef GHCR_IMAGE_BASE=... SITE_ADDRESS=... MEGA_CRM_ENV_FILE=/dev/null IMAGE_TAG=... POSTGRES_IMAGE_TAG=... WORKER_STOP_GRACE_PERIOD_SECONDS=60 docker compose -f docker/docker-compose.prod.yml config` (mutation-free render, no container touched)
  found: the render emits `ALLOY_CONFIG_HASH: deadbeef` under `services.alloy.environment` (line 9). Note the render additionally requires WORKER_STOP_GRACE_PERIOD_SECONDS — a PRE-EXISTING requirement of this compose file (worker.stop_grace_period), unrelated to this fix; validate-prod-compose.mjs supplies it itself.
  implication: closes the recorded blind spot "the docker-stub tests cannot prove the interpolation lands". The compose-side half of the config-hash mechanism is now empirically verified. What remains unproven here is only compose's RECREATE-on-hash-change behaviour, which needs a real daemon.

- timestamp: 2026-08-28 (GREEN phase, fix-acceptance guardrail)
  checked: mutation testing at the fix site — 3 targeted mutations, each run against the full suite, deploy.sh restored from a backup copy after each
  found: 3/3 killed, each by exactly its designated test and each leaving the other 35 green. (A) `if [[ "$running" == "true" ]]` → `if true` kills "fails naming alloy when the container is not running". (B) delta → `RestartCount == 0` kills the "non-zero but no longer climbing" guard test. (C) alloy `up` moved inside the skip_worker_replace guard kills "the repair path".
  implication: the tests are not vacuous — each load-bearing design decision (running-guard, delta-not-zero, unconditional placement) is independently pinned. Signal 3 of the fix-acceptance guardrail passes.

- timestamp: 2026-08-28 (GREEN phase, adjacent gates)
  checked: validate-prod-compose.mjs, verify:alloy-config, check-spec-env-coverage.mjs, check-runbook-coverage.mjs, and the two sibling vitest suites
  found: all pass — 8 services/61 invariants (resolved via the real `docker compose config` path, not the YAML fallback); real pinned Alloy binary parses config.alloy; 57 env names covered; 5 alerts covered; 52/52 sibling tests
  implication: no collateral breakage from either the compose edit or the SPECIFICATION.md edit. ALLOY_CONFIG_HASH correctly does NOT trip check-spec-env-coverage, because that gate is one-directional (prod.env.example → SPEC) and the variable is deliberately absent from prod.env.example (deploy.sh computes it; there is no operator value).

- timestamp: 2026-08-28 (blind-spot check)
  checked: scripts/check-runbook-coverage.mjs
  found: it enumerates `*_ALERT_NAME` constants in apps/api/src/modules/ops/*.ts only, and its header explicitly disclaims responsibility for log-shipping runbooks
  implication: adding a deploy stage does NOT trip this gate — no CI block. The runbook update is still warranted by the runbook's own per-stage structure, but it is not gate-enforced.

## Eliminated

- hypothesis: "Alloy is deployed but loses WAL/positions state across deploys (persistence bug)"
  evidence: explicitly excluded by the reported symptoms and confirmed by inspection — the failing state is container ABSENCE, and deploy.sh contains no alloy lifecycle code at all, so no deploy-time action can be disturbing its state. There is no positions volume to lose because there is no deploy-managed container.
  timestamp: 2026-08-28

- hypothesis: "deploy.sh converges alloy but the step is conditional / mis-ordered / silently skipped"
  evidence: `grep -c -i alloy scripts/deploy.sh` = 0 and a full 432-line read found no service-list variable, no wildcard `up -d` without an explicit service list, and no profile mechanism. There is no step to be conditional on.
  timestamp: 2026-08-28

- hypothesis: "the environment (fresh host / manual removal) is an independent contributing cause"
  evidence: the omission is static in the script text and reproduces identically on any host; host state only determines whether the pre-existing container happens to survive. It is a consequence-revealer, not a contributor — recorded in the AND-gate as ruled out.
  timestamp: 2026-08-28

## Resolution

root_cause: (AND-gate fired — two confirmed contributing causes, both required for the reported symptom) 1. CODE — scripts/deploy.sh's compose surface enumerates only api/worker/web/migrate; the `alloy` service declared in docker/docker-compose.prod.yml appears nowhere in the script (`grep -c -i alloy` = 0), so no routine deploy can create, update, or observe the log-shipping sidecar, and its production existence depends entirely on an out-of-band manual `docker compose up -d alloy`; 2. CONFIG — the alloy service's `env_file: { path: ${MEGA_CRM_ENV_FILE}, required: false }` combined with Alloy's empty-tolerant `env()` means absent or blank Loki credentials fail nothing anywhere in the stack, so even a converged container can push nowhere silently (docker/prod.env.example ships all three GRAFANA_* keys blank, making the unfilled copy the default failure shape).
fix: |
  Two independent legs mapped one-to-one onto the two confirmed causes, plus a verification leg that makes the
  convergence claim falsifiable.
  1. CODE (scripts/deploy.sh) — `alloy` appended to `compose pull api worker web alloy`; `compose up -d --no-deps alloy`
     runs UNCONDITIONALLY after the worker leg, deliberately OUTSIDE the `skip_worker_replace` guard so that re-running
     the deploy for the same SHA is a working repair path; `--no-deps` honours the leg-isolation contract established
     after the 17-05 live db-cutover finding.
  2. CONFIG (scripts/deploy.sh + docker/docker-compose.prod.yml) — `check_loki_credentials()` reads $MEGA_CRM_ENV_FILE
     (via `read_env_file_value()`, tolerant of `export `, quoting, CRLF and duplicate keys) and requires all three
     GRAFANA_* keys non-empty with an https:// push endpoint (T-15-64). Fails loudly naming the offending key BEFORE any
     mutation — zero docker invocations, no SHA recorded. Compose cannot do this itself: `env_file: { required: false }`
     plus Alloy's empty-tolerant `env()` make a blank credential a silent no-op.
     Additionally deploy.sh computes ALLOY_CONFIG_HASH (sha256 of docker/alloy/config.alloy via node:crypto) and exports
     it; the alloy service gained one mapping-style `environment:` entry `ALLOY_CONFIG_HASH: ${ALLOY_CONFIG_HASH:-}`.
     This injects the bind-mounted config's CONTENT into compose's own service config hash, which is what makes
     `up -d` a genuine UPDATE (recreate on changed config/image) rather than merely start-if-absent.
  3. VERIFY (scripts/deploy.sh) — `wait_for_alloy_stable()` polls
     `docker inspect --format '{{.State.Running}} {{.RestartCount}}' $(compose ps -q alloy)` and accepts only TWO
     CONSECUTIVE RUNNING samples with an unchanged RestartCount. Deliberately a DELTA, never `RestartCount == 0`
     (a sidecar that restarted once at a host reboot is healthy). `prev_count` is reset on any non-running sample so a
     stopped container's frozen counter can never satisfy the "unchanged" half. Knobs
     ALLOY_STABLE_TIMEOUT_SECONDS/ALLOY_STABLE_POLL_INTERVAL_SECONDS (prod defaults 60/5). On failure: exit non-zero
     naming alloy, print the rollback command, SHA NOT recorded — same late-leg semantics as the worker-healthy timeout.
verification:
  guardrail_verdict: accepted
  signal_1_regression_test: PASS — `npx vitest run --config scripts/vitest.config.ts scripts/__tests__/deploy-script.test.mjs` → 36/36 (was 15 failed | 21 passed in RED). All 19 pre-existing tests still green; no test was weakened or rewritten.
  signal_2_guard_tests: PASS — both load-bearing guards green. "does not run the preflight under --dry-run" (dry-run may never require environment) and "accepts a stable container whose RestartCount is non-zero but no longer climbing" (pins the delta check against an over-strict == 0 that would fail deploys after a host reboot).
  signal_3_mutation_at_fix_site: PASS — 3 mutations applied to the fix site, 3/3 killed by their designated test, each leaving the other 35 green (so each test bites precisely, not diffusely). (A) drop the `running == "true"` guard → "fails naming alloy when the container is not running" fails. (B) replace the delta with `RestartCount == 0` → the non-zero-but-stable guard test fails. (C) move the alloy `up` inside the skip_worker_replace guard → "still converges alloy when re-running an already-deployed SHA -- the repair path" fails. deploy.sh restored from backup and re-verified 36/36 + `bash -n` after each.
  signal_4_no_deletion_only_diff: PASS — 486 insertions / 6 deletions across 5 files; the 6 deletions are the pull-list line, the dry-run pull line and adjacent edited lines, not removed assertions.
  signal_5_adjacent_gates: PASS — `node scripts/validate-prod-compose.mjs` (8 services, 61 invariants, resolved via the REAL `docker compose config` path); `npm run verify:alloy-config` (real pinned Alloy binary, `alloy fmt`); `node scripts/check-spec-env-coverage.mjs` (57 names); `node scripts/check-runbook-coverage.mjs` (5 alerts); sibling suites validate-prod-compose.test.mjs + validate-alloy-config.test.mjs → 52/52.
  signal_6_interpolation_render: PASS — mutation-free `ALLOY_CONFIG_HASH=deadbeef ... docker compose -f docker/docker-compose.prod.yml config` renders `ALLOY_CONFIG_HASH: deadbeef` under `services.alloy.environment` (line 9 of the render). Closes the blind spot that the docker-stub tests cannot reach compose's own config-hash layer. No container touched.
  production_uat: PASS — controlled deploy of master SHA f59bf1ab0d654a64ca634ef257d821e74d7aea55 on the real VPS completed through scripts/deploy.sh. The three required GRAFANA_* values were present, compose recreated docker-alloy-1 in the dedicated "converging the alloy log-shipping sidecar" leg, the bounded stability gate passed, and post-deploy inspection reported running=true, RestartCount=0. Alloy initially replayed historical Docker logs and Loki rejected 88,472 entries older than its ingestion window; that finite startup backlog then drained with no further errors. Internal live metrics subsequently reported loki_write_sent_entries_total=201 and loki_write_sent_bytes_total=35220, proving fresh production log delivery with the real write-only credentials. API /healthz=200, /readyz=200 (postgres/redis/migrations all true), and api/web/worker all healthy at the deployed SHA.
files_changed:
  - scripts/deploy.sh (three fix legs + two timeout knobs + three helpers; the only behavioural change)
  - docker/docker-compose.prod.yml (one mapping-style `environment:` entry on the alloy service + its rationale comment)
  - scripts/__tests__/deploy-script.test.mjs (RED regression tests, written in the prior phase — unchanged during GREEN)
  - SPECIFICATION.md (ALLOY_CONFIG_HASH in the deploy-identity table incl. the CR-01 second-exception rationale; ALLOY_STABLE_* in the operator-override list; the alloy deploy leg recorded in the §7 Alloy paragraph)
  - docs/runbooks/deploy-and-rollback.md (two new "What to do when a stage fails" subsections: Loki credential preflight, Alloy convergence; plus the manual-`up`-recreates-once note)
oracle_type: specified — the expected behaviour was stated up front in the symptom report ("starts it if absent, updates it if config/image changed, fails clearly when required Loki configuration is unavailable") and encoded directly as call-log/exit-code assertions, not inferred from the implementation.

prevention:
  why_not_caught: |
    No gate existed for this class. Every gate in the repo was one-sided. `scripts/validate-prod-compose.mjs` already
    listed `alloy` in EXPECTED_SERVICES and FIRST_PARTY_IMAGE_SERVICES, so the COMPOSE side of the contract knew the
    service was production-critical — but nothing anywhere asserted that `scripts/deploy.sh` converges the services
    compose declares. The deploy-script test suite (488 lines, thorough on ordering and leg isolation) asserted only
    what the script already did; it had no notion of a service the script had never mentioned. A test suite written
    against the implementation cannot detect an omission from the implementation.
    Compounding it, the failure was designed to be silent at every layer: `env_file: { required: false }` is compose
    explicitly promising not to fail, and Alloy's `env()` returns "" rather than erroring. Human review missed it twice
    (15-17 authored the service, 15-22 fixed its config) because both plans were scoped to the compose/config files and
    neither had reason to open deploy.sh.
  five_whys: |
    (branching, per RCA — two root causes, not one chain)
    Branch A (code): No logs in Loki → the alloy container was absent → routine deploy never created it → deploy.sh
      never named the service → the plan that added `alloy` to compose (15-17) treated "declared in compose" as
      equivalent to "deployed", and no gate tests that equivalence → ROOT: compose-declares and deploy-converges were
      two independent lists with no machine-checked correspondence between them.
    Branch B (config): Even a converged container could ship nothing → blank GRAFANA_* credentials are tolerated →
      `env_file: required: false` (deliberate, so the example env file validates in CI) + empty-tolerant `env()` →
      the "make local/CI validation work" decision silently also removed the only place production could fail loudly →
      ROOT: a validation-convenience default was never paired with a production-path check that re-imposed the
      requirement.
    AND-gate: both were required to produce the reported "apps healthy, zero logs, zero errors" — A alone gives an
      absent container, B alone a present-but-silent one.
  recurrence_guard: |
    PRIMARY (executable): scripts/__tests__/deploy-script.test.mjs — the describe block
    "alloy convergence: the log-shipping sidecar is part of the deploy contract" (17 assertions across 15 tests),
    notably: "converges alloy in the real deploy, after the worker leg"; "still converges alloy when re-running an
    already-deployed SHA -- the repair path"; the six preflight tests (absent AND blank shape, per key); "rejects a
    plaintext push endpoint (T-15-64)"; "fails naming alloy when the container is restart-looping"; and the two guard
    tests that pin the boundary from the other side. Mutation-verified: 3/3 mutations at the fix site killed.
    SECONDARY (structural): the leg-isolation test was extended with alloy assertions, so any future alloy invocation
    that drops `--no-deps` fails too — the new leg inherits the 17-05 db-cutover protection rather than sitting
    outside it.
    DOC: docs/runbooks/deploy-and-rollback.md now has a per-stage failure entry for both new legs, matching the
    runbook's existing structure (note: check-runbook-coverage.mjs enumerates *_ALERT_NAME constants only, so this is
    structure-driven, not gate-enforced).
    RESIDUAL GAP (worth a follow-up, deliberately NOT bundled into this fix): there is still no gate asserting that
    every service in validate-prod-compose's EXPECTED_SERVICES is converged by deploy.sh. That check would have caught
    this class generically rather than one service at a time. `db`/`redis`/`pgbackrest` are legitimately NOT converged
    by deploy.sh (operator-gated cutover, by design), so such a gate needs an explicit allowlist with a stated reason
    per exclusion — a small design task, not a mechanical one.
