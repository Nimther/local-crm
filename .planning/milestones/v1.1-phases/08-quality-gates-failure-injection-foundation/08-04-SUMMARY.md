---
phase: 08-quality-gates-failure-injection-foundation
plan: 04
subsystem: infra
tags: [redis, bullmq, docker-compose, durability, aof, noeviction, ci, testing]

requires:
  - phase: 08-01
    provides: CI workflow with docker compose services; the recorded local/Docker environment divergence this plan had to resolve
provides:
  - Version-controlled docker/redis.conf (maxmemory 512mb, noeviction, appendonly yes, appendfsync everysec)
  - scripts/verify-redis-config.mjs — one environment-agnostic verifier taking REDIS_URL from outside
  - packages/test-support/src/harness/temp-redis.ts — throwaway redis-server harness with guaranteed teardown
  - compose redis service command: override + read-only config mount
  - CI step invoking the same verifier against the container
affects: [08-13, 08-18, phase-12-worker-reliability, phase-15-production-hardening]

tech-stack:
  added: []
  patterns:
    - "One gate script, environment supplied from outside: the check has no CI branch and no default target, so local and CI run identical code"
    - "Throwaway service harness: boot a private instance from the versioned config on a reserved port with a temp data dir rather than mutating a developer's system service"

key-files:
  created:
    - scripts/verify-redis-config.mjs
    - scripts/verify-redis-config.d.mts
    - packages/test-support/src/harness/temp-redis.ts
    - packages/test-support/src/__tests__/redis-config.test.ts
    - docker/redis.conf
  modified:
    - docker-compose.yml
    - packages/test-support/src/index.ts
    - package.json
    - SPECIFICATION.md
    - .github/workflows/ci.yml

key-decisions:
  - "docker/redis.conf is the single source both boot paths read: the compose container mounts it, the local harness boots redis-server from it — the file, not a duplicated value list, is what makes the environments equivalent"
  - "The system Homebrew Redis on 6379 is never mutated or restarted (user directive); local verification uses a private redis-server on a reserved free port with a temp data dir and guaranteed teardown"
  - "The verifier requires REDIS_URL and has no default address, so it cannot silently check the wrong server — this also removes any path by which it could reach the developer's own Redis"
  - "Implemented on Node built-ins (minimal RESP client over node:net) rather than ioredis, matching the dependency-free convention of the other scripts/*.mjs gates"
  - "A missing redis-server binary raises a hard error naming the install command; unreachable Redis exits non-zero. Neither is a skip, because a skip exits 0 and CI reads that as success"
  - "The fail-first proof is a permanent test that boots an unconfigured server on every run, not a one-time transcript"

patterns-established:
  - "Environment-agnostic gate script: REDIS_URL/DSN injected by the caller, zero environment detection inside the script"
  - "Guaranteed-teardown service harness with a process-exit safety net, exported from @mega-crm/test-support for reuse by 08-12 and 08-13"

requirements-completed: [WRK-12]

coverage:
  - id: D1
    description: "Four-directive assertion against a live server, run as the same script in every environment with REDIS_URL supplied from outside"
    requirement: WRK-12
    verification:
      - kind: integration
        ref: "packages/test-support/src/__tests__/redis-config.test.ts#passes when redis-server is booted from docker/redis.conf"
        status: pass
      - kind: unit
        ref: "packages/test-support/src/__tests__/redis-config.test.ts#checkRedisConfig — a policy-only assertion would be vacuous"
        status: pass
    human_judgment: false
  - id: D2
    description: "Fail-first proof: the assertion rejects an unconfigured redis-server, observed before docker/redis.conf existed and re-proven on every run"
    requirement: WRK-12
    verification:
      - kind: integration
        ref: "packages/test-support/src/__tests__/redis-config.test.ts#fails against a stock redis-server, naming maxmemory and appendonly"
        status: pass
    human_judgment: false
  - id: D3
    description: "An unverifiable Redis is a failure, never a skip — unreachable server and unset REDIS_URL both exit non-zero"
    requirement: WRK-12
    verification:
      - kind: integration
        ref: "packages/test-support/src/__tests__/redis-config.test.ts#an unverifiable server is a failure, never a skip"
        status: pass
    human_judgment: false
  - id: D4
    description: "Throwaway redis-server harness on a reserved port with a temp data dir, guaranteed teardown, never touching the system Redis on 6379"
    verification:
      - kind: integration
        ref: "packages/test-support/src/__tests__/redis-config.test.ts (all 12 tests boot and tear down instances)"
        status: pass
      - kind: manual_procedural
        ref: "redis-cli -p 6379 CONFIG GET maxmemory/appendonly after the run — still 0 / no; no /tmp/mega-crm-redis-* left behind"
        status: pass
    human_judgment: false
  - id: D5
    description: "compose redis service applies docker/redis.conf via an explicit command: override and a read-only bind mount"
    requirement: WRK-12
    verification:
      - kind: integration
        ref: ".github/workflows/ci.yml step `Verify Redis configuration` — REDIS_URL=redis://localhost:6379 npm run verify:redis-config"
        status: unknown
    human_judgment: true
    rationale: "Docker is not installed on this machine, so the container application mechanism cannot be exercised locally at all. The compose file was verified only by YAML parse and directive-level review; the step that proves it is wired but has not yet run on a GitHub runner (nothing was pushed)."
  - id: D6
    description: "SPECIFICATION.md §1.3 and §5.3 record the Redis configuration, both application paths, and what stays unverifiable locally"
    verification: []
    human_judgment: true
    rationale: "Prose accuracy against the as-built system; SPEC assigns documents to the judgment tier."

duration: 43 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 04: Redis Durability Configuration Summary

**A version-controlled `docker/redis.conf` that both the compose container and a throwaway local `redis-server` boot from, asserted by one environment-agnostic verifier that was observed rejecting an unconfigured server before the config existed.**

## Performance

- **Duration:** 43 min
- **Started:** 2026-07-28T06:44:00Z
- **Completed:** 2026-07-28T07:27:00Z
- **Tasks:** 3
- **Files modified:** 10 (5 created, 5 modified)

## Accomplishments

- **`docker/redis.conf` under version control** with exactly four directives — `maxmemory 512mb`, `maxmemory-policy noeviction`, `appendonly yes`, `appendfsync everysec` — applied to the compose `redis` service by an explicit `command:` override plus a `:ro` bind mount.
- **One verifier, two environments.** `scripts/verify-redis-config.mjs` reads `CONFIG GET` from a live server and asserts all four values. It takes `REDIS_URL` from outside and has no default address and no environment branch, so CI and local runs execute identical code against different targets.
- **A local path that does not exist in the plan as written.** Docker is not installed here, so the container mount cannot be applied locally. Rather than branch the check, `packages/test-support/src/harness/temp-redis.ts` boots a private `redis-server` **from the same `docker/redis.conf`** on a reserved free port with a temporary data directory, and guarantees teardown. The developer's Redis on 6379 is never read, reconfigured or restarted — confirmed unchanged after the run.
- **Fail-first proven, and kept proven.** The assertion was observed failing against a stock server before `docker/redis.conf` existed. That proof is not a stored transcript: the first test boots an unconfigured server on every run and asserts rejection.
- **No skip surface.** An unreachable server, an unset `REDIS_URL`, and a missing `redis-server` binary all fail loudly. A skip would exit 0, which CI reads as success — the precise hole SPEC R7's negative criterion names.

### The RED transcript (SPEC R7 fail-first evidence)

Stock `redis-server`, no config file:

```
verify:redis-config — redis://127.0.0.1:6399
  maxmemory          = 0
  maxmemory-policy   = noeviction
  appendonly         = no
  appendfsync        = everysec

verify:redis-config FAILED: 2 directive(s) wrong.
  maxmemory: expected > 0 (a real ceiling; without one `noeviction` can never trigger), observed 0
  appendonly: expected yes, observed no
exit 1
```

This is the whole point of R7: **`maxmemory-policy` already read `noeviction`** on a completely unconfigured server. A policy-only assertion would have passed here and proven nothing.

### The GREEN transcript

`redis-server` booted from `docker/redis.conf`:

```
verify:redis-config — redis://127.0.0.1:6398
  maxmemory          = 536870912
  maxmemory-policy   = noeviction
  appendonly         = yes
  appendfsync        = everysec
verify:redis-config — all four directives OK
exit 0
```

Suite: **12 passed (12)**. Monorepo typecheck clean. ESLint clean on all changed files.

## Task Commits

1. **Task 1 (RED): verifier + throwaway-server harness, observed failing** — `435de71` (test)
2. **Task 2 (GREEN): versioned docker/redis.conf + compose mount** — `b7e91b0` (feat)
3. **Task 3: SPECIFICATION.md + CI step** — `0939955` (docs)

## Files Created/Modified

- `docker/redis.conf` — the four directives, with a header explaining why `maxmemory` and `maxmemory-policy` are inseparable, why 512mb is a dev figure, and why `everysec` over `always`
- `scripts/verify-redis-config.mjs` — environment-agnostic verifier; minimal RESP client on `node:net`, no dependencies
- `scripts/verify-redis-config.d.mts` — type declarations so the type-checked test can import the pure evaluator
- `packages/test-support/src/harness/temp-redis.ts` — throwaway `redis-server` on a reserved port + temp dir, SIGTERM→SIGKILL teardown, `rm -rf` of the dir, process-exit safety net
- `packages/test-support/src/__tests__/redis-config.test.ts` — 12 assertions: fail-first, green, not-a-skip, and the pure vacuous-check discrimination
- `docker-compose.yml` — `redis` service gains `command:` and the `:ro` mount; image, ports, restart policy and healthcheck untouched
- `packages/test-support/src/index.ts` — exports `startTempRedis` for 08-12/08-13
- `package.json` — `verify:redis-config` script
- `SPECIFICATION.md` — §1.3 (compose service, the conf file, both application paths, the verifier contract), §2.5 (stale dependency claim corrected), §5.3 (durability posture and its interaction with `removeOnFail: false`)
- `.github/workflows/ci.yml` — `Verify Redis configuration` step

## Decisions Made

- **The config file, not a value list, is the shared artifact.** Both paths boot from `docker/redis.conf`, so there is no second place for the values to drift.
- **`REDIS_URL` is required with no fallback.** Beyond preventing a silent wrong-target check, this removes any route by which the verifier could reach the developer's own Redis.
- **Node built-ins over `ioredis`.** A four-value `CONFIG GET` does not justify a root dependency, and `scripts/*.mjs` in this repo are dependency-free by convention. `ioredis` therefore remains declared-but-unused in `packages/test-support` — SPECIFICATION.md §2.5 corrected accordingly.
- **`maxmemory` deliberately not parameterized.** `redis.conf` has no variable substitution; an entrypoint wrapper to add one would reintroduce exactly the local/CI divergence D-25 exists to prevent.

## Deviations from Plan

### 1. [Rule 4 — Architectural, user-approved] The plan's GREEN path has no local execution mechanism

- **Found during:** Task 1 precondition check, before any file was written.
- **Issue:** Tasks 1 and 2 are written against `docker compose up -d --wait redis` / `--force-recreate` and `docker compose exec -T redis redis-cli CONFIG GET`. Docker is not installed on this machine — the condition 08-01 recorded and explicitly deferred to this plan ("Open risk for 08-04 and 08-13"). A bind mount cannot reach the Homebrew Redis, and that Redis holds real state on 6379.
- **Resolution:** Escalated per Rule 4 and stopped. User directed: do not modify or restart the system Redis; boot a separate temporary `redis-server` from `docker/redis.conf` on a free port with a temp data directory and guaranteed teardown; call one `verify-redis-config` script from both local and CI with `REDIS_URL` supplied externally; no CI-only branches in the verifier; a missing `redis-server` must fail with a clear error rather than skip.
- **Effect on the artifact:** stronger than planned, not weaker. In the plan, `docker/redis.conf` governed only the container and the local path had none; now the one file governs both, which is what D-25's "identical locally and in CI" actually asks for.
- **Files modified:** all created files, plus `docker-compose.yml`.
- **Verification:** RED and GREEN transcripts above; system Redis on 6379 re-read after the run and unchanged (`maxmemory` 0, `appendonly` no); no leftover temp directories.
- **Committed in:** `435de71`, `b7e91b0`

### 2. [Rule 2 — Missing Critical, user-approved] CI step added outside the plan's `files_modified`

- **Found during:** Task 3.
- **Issue:** The user's contract is that the same verifier runs locally **and in CI**. `ci.yml`'s only test step is `npm run test -w apps/worker`, and the verifier lives in `packages/test-support`, so nothing in CI would have invoked it. Without the step, the container path (`command:` + `:ro` mount) is exercised nowhere at all, since it cannot be exercised locally.
- **Fix:** One step in the existing `test` job, after the compose services come up, with `REDIS_URL: redis://localhost:6379`.
- **Scope note:** `.github/workflows/ci.yml` is not in this plan's `files_modified`; 08-18 owns the workflow's expansion into four jobs and will absorb this step.
- **Verification:** YAML parses; step ordering confirmed (services → verify → typecheck → test). Not yet executed on a runner — nothing was pushed.
- **Committed in:** `0939955`

### 3. [Rule 1 — Bug, in own work] Anti-skip assertion matched the verifier's own explanatory prose

- **Found during:** Task 1, first RED run.
- **Issue:** `expect(run.output).not.toMatch(/skip/i)` failed against the verifier's message, which contains the word "skipped" while explaining that the result is *not* a skip. A wording check was the wrong proxy for the contract.
- **Fix:** Asserted the behavioural contract instead — a skip exits 0, so a non-zero exit code *is* the anti-skip proof — plus a check that the failure names the actual connection error.
- **Verification:** RED reduced to exactly the two intended failures (missing `docker/redis.conf`).
- **Committed in:** `435de71`

### 4. [Rule 1 — Bug, pre-existing doc error] Stale dependency claim in SPECIFICATION.md §2.5

- **Found during:** Task 3.
- **Issue:** §2.5 stated `pg`, `ioredis` and `execa` were "declared but not yet used" in `packages/test-support`, and named the Redis config check as `ioredis`'s future consumer. `pg` has been in use since 08-02/08-06, and this plan's check does not use `ioredis`. Leaving the sentence half-true was not an option once this plan's clause in it became wrong.
- **Fix:** Corrected all three claims against actual imports.
- **Verification:** `grep -rl` for each package across `packages/test-support/src/`.
- **Committed in:** `0939955`

---

**Total deviations:** 1 architectural (escalated, user-approved), 1 missing-critical (user-approved), 2 auto-fixed bugs.
**Impact on plan:** No scope reduction — every planned artifact exists. The mechanism for local verification changed, and the resulting configuration coverage is broader than planned. One file beyond `files_modified` (`ci.yml`), taken deliberately with user approval.

## Issues Encountered

- **Two pre-existing test failures in `packages/test-support`, unrelated to this plan.** `provision-db.test.ts` and `db-fixture-isolation.test.ts` fail locally with `role "postgres" does not exist` — `provision-db.ts`'s `DEFAULT_ADMIN_DSN` is `postgres://postgres:postgres@localhost:5432/postgres`, and the Homebrew instance has no `postgres` role (the same 08-01 divergence, SPECIFICATION.md §1.3). **Confirmed pre-existing** by running both files in a clean worktree at `b99719e`, the commit before this plan: identical failures. Not touched — outside this plan's scope. They pass in CI, where the compose `db` service does have that role. Worth a small carry-forward: an overridable admin DSN would make the whole `test-support` suite runnable locally.

## User Setup Required

None — no external service configuration required. `redis-server` must be on `PATH` for local verification; it already is (8.8.0 via Homebrew), and the harness raises a clear error naming the install command if it ever is not.

## Next Phase Readiness

- **`startTempRedis` is exported from `@mega-crm/test-support`** and is the natural substrate for **08-13** (Redis restart / job survival), which has the same Docker blocker recorded in 08-01. A restart against a throwaway instance booted from `docker/redis.conf` — with AOF and `everysec` now actually configured — is testable locally; a `docker restart` of the *container* still is not.
- **08-18** should absorb the `Verify Redis configuration` step when it splits the workflow into four jobs, and should keep it in a blocking job.
- **Open and deliberately unclosed:** the container application mechanism (`command:` + `:ro` mount) has not executed anywhere yet. It is wired and reviewed, not proven. The first CI run on this branch is what closes it — coverage entry `D5` is marked `unknown`/`human_judgment: true` for exactly this reason.
- **Phase 12** inherits the note that BullMQ can raise `OOM command not allowed` from internal Lua scripts, not only `queue.add`, once the ceiling is reachable — recorded in SPECIFICATION.md §5.3 and explicitly out of scope here.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
