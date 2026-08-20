# Phase 8: Quality Gates & Failure-Injection Foundation - Research

**Researched:** 2026-07-28
**Domain:** CI/CD gating, ephemeral test infrastructure, failure injection, Redis durability, migration safety, repo hygiene
**Confidence:** HIGH for as-built facts (grounded directly in this repo's code) / MEDIUM for GH Actions & tooling mechanics (web-verified, not Context7-verified) / LOW-MEDIUM for a few specific tool APIs called out below

<user_constraints>
## User Constraints (from CONTEXT.md)

08-CONTEXT.md contains 33 locked decisions (D-01..D-33) plus a Claude's Discretion list and a Deferred list. They are **binding** and this research does not re-litigate them. Full text lives in `.planning/phases/08-quality-gates-failure-injection-foundation/08-CONTEXT.md` — the planner MUST read it directly (it is long; not fully re-quoted here to avoid drift between two copies). This research instead:

- Assumes every D-01..D-33 decision as given and researches **how to implement it precisely** against this repo's actual code/versions.
- Flags exactly one place where a D-22 mechanic needs a planner decision it doesn't fully specify (packages/test-support ↔ apps/worker import direction — see "Flag: D-22 mechanics gap" under Architecture Patterns).
- Does not restate the Claude's Discretion list or Deferred Ideas list verbatim (see CONTEXT.md `<decisions>` → `### Claude's Discretion` and `<deferred>` sections) — treat both as authoritative and unchanged.

**Locked decision index for cross-reference while planning** (topic → decision IDs, see CONTEXT.md for full text):
- Git/CI model & job split: D-01, D-02, D-03, D-04
- Lint: D-05, D-06, D-07, D-08
- Ephemeral DB / guard: D-09..D-15
- Coverage: D-16..D-20
- Failure-injection harness: D-21..D-24
- Redis / hygiene: D-25..D-29
- Migration linter / docs: D-30..D-33
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| QG-01 | CI runs tests/typecheck/build on every push+PR; red run blocks merge | GH Actions workflow shape, branch protection mechanics, tracer slice (below) |
| QG-02 | Lint configured, violations block CI | typescript-eslint flat-config mechanics, projectService gotcha for non-`src` files, file-count-floor pattern |
| QG-03 | Coverage measured, drop below baseline blocks CI | Vitest 4 `coverage.thresholds`/`json-summary`, custom gate script rationale (why not built-in thresholds — D-18), ratchet mechanics |
| QG-04 | Playwright E2E can't reach dev DB; fail-closed guard | DSN normalization algorithm, `globalSetup` mechanics for vitest + Playwright, two-layer guard (D-14) |
| QG-05 | Migrations tested from empty DB and incrementally | drizzle-kit 0.31 capabilities vs the repo's own from-scratch `db-fixture` runner, snapshot gaps (27/38 migrations) |
| QG-06 | 5 failure modes reproducible by one command each | DI-seam mechanics for timeout/429/reset (all three collapse to "injected rejection/resolution", not real network faults), real-process SIGKILL pattern, Redis-restart pattern |
| QG-07 | `.env`/`dump.rdb` out of working root | `process.loadEnvFile` code-path migration (D-27/D-28), blacklist CI check (D-29) |
| QG-08 | ARCHITECTURE.md exists | Compact 5-block structure (D-32), boundary vs SPECIFICATION.md |
| QG-09 | CONVENTIONS.md exists | Same as above, expand/contract rule text |
| QG-10 | CLAUDE.md doc-update rule covers all 3 docs | Extending existing `## Project Specification` section (D-33) |
| WRK-12 | Redis `noeviction` + persistence | `docker/redis.conf` content, BullMQ+OOM interaction, AOF/fsync mechanics |
| DB-08 | Expand/contract discipline enforced | Postgres `ALTER TYPE ... ADD VALUE` transaction restriction (verified), self-written linter algorithm |
</phase_requirements>

## Summary

This phase has almost no "pick a library" decisions left — CONTEXT.md's D-01..D-33 already made every architecturally significant choice. What remains is **mechanics**: the exact GitHub Actions YAML shape, the exact Vitest 4 config fields, the exact algorithm for a self-written migration linter, and — critically — reconciling five *specific, named* failure-injection scenarios with a codebase that has no real timeout/retry logic yet (that arrives in Phase 11). The single most important grounding fact from this repo: **`ProcessSendJobDeps.sendMail` is the only seam, and it is a function-level DI seam, not a network-level one.** SendGrid timeout, 429, and connection-reset therefore cannot be distinguished from each other by *mechanism* inside this harness — they are distinguished only by the **shape of what the injected fake returns or throws**, and by the **outcome the harness asserts** (which, since there is no `AbortController` timeout wired into `sendTenantMailV3` yet, is currently identical for "timeout" and "connection reset": an unhandled rejection that BullMQ retries, which the existing `interrupted` branch in `claimCampaignSend` resolves to `'failed'` — this is the *pre-Phase-11* correct behavior, and the harness must assert exactly that, not the future `'reconciling'` outcome).

CI itself is the other load-bearing piece: this repo has **zero** `.github/` history, so QG-01's "push and PR both trigger, and the same job name is a required status check" is a from-scratch wire-up, not a tune-up. The `docker compose up -d --wait` mechanic in D-03 is correct and necessary (GitHub's native `services:` block cannot mount `docker/redis.conf` or receive `docker restart`), but it means every service healthcheck in `docker-compose.yml` (already present for both `db` and `redis`) must stay accurate, since `--wait` polls exactly those.

**Primary recommendation:** Build the tracer slice first as a *maximally thin real slice* — one CI job that triggers on push+PR, brings up `docker compose` services, runs the *existing* 91-file suite pointed at a single hand-named ephemeral DB with the bare-minimum two-condition guard, and is registered as a GitHub required status check on a throwaway test PR. Every other requirement (lint-zero, coverage threshold, 5 failure scenarios, redis.conf, migration tests, hygiene, docs) is an additive layer on top of that proven pipe, not a parallel construction.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| CI gate (typecheck/lint/build/test) | CI/CD (GitHub Actions) | — | Runs outside any app process; gates the `master` branch, not a runtime tier |
| Ephemeral DB provisioning + guard | Test infrastructure (`packages/test-support`) | Database / Storage | Provisioning talks to Postgres directly via an admin DSN; guard logic is pure Node, invoked from `globalSetup` in every test runner |
| Coverage measurement + gate | CI/CD | Test infrastructure | Vitest instruments during `test` job; the gate script is a standalone Node script run as a CI step, not part of any app |
| Failure-injection harness (4 of 5 scenarios) | Test infrastructure | API/Backend (`apps/worker`) | In-process DI-seam scenarios (timeout/429/reset/redis-restart) run vitest against live Postgres/Redis but through the existing worker code, not a new tier |
| Failure-injection harness (SIGKILL scenario) | API/Backend (`apps/worker`, spawned as a real OS process) | Test infrastructure | Only scenario requiring a genuine separate process — the process being killed IS `apps/worker`'s dispatch code |
| Redis durability config | Database / Storage (Redis) | Infrastructure (docker-compose) | `maxmemory`/`noeviction`/AOF are server-side Redis config, mounted via docker-compose, not app code |
| Migration linter | CI/CD | Database / Storage | Static analysis of `packages/db/migrations/*.sql`; runs as a CI step with no live DB |
| `.env`/`dump.rdb` relocation | Infrastructure / Dev tooling | API/Backend (`apps/api`, `apps/worker` boot) | Changes how `server.ts` boot loads config, but the *decision* of where files live is a repo-hygiene/ops concern, not a runtime tier |
| ARCHITECTURE.md / CONVENTIONS.md / CLAUDE.md rule | Documentation (repo root) | — | No runtime component; consumed by humans and by future planning phases |

## Tracer Slice & TDD Shape

### Recommended Tracer Slice

**The thinnest complete vertical slice that proves the whole quality-gate chain end-to-end:**

1. `.github/workflows/ci.yml` with exactly one job (`test`), triggered on `push` (any branch) and `pull_request` (targeting `master`).
2. That job runs `docker compose -f docker-compose.yml up -d --wait` (both `db` and `redis` already have healthchecks — reuse as-is, no new compose file needed for this slice).
3. A **minimal** guard: a single new file (`packages/test-support/src/guard.ts`) exporting `assertTestDatabaseUrl(url: string, devUrl: string): void` that only checks the two SPEC-mandated conditions (prefix `mega_crm_test`, normalized host+port+db inequality) — wired into exactly one vitest config (`apps/worker/vitest.config.ts`, since it is smaller than `apps/api`'s) via a one-line `globalSetup`.
4. A hand-created ephemeral DB name for this slice only (e.g. `mega_crm_test_worker`, no run-id yet — that refinement is D-10's full form, added in a later task) — `TEST_DATABASE_URL` exported as a step env var in the workflow, `DATABASE_URL` (the "dev" one under guard) also exported so the guard has something real to compare against, sourced from `docker-compose.yml`'s existing `POSTGRES_USER=postgres`/`POSTGRES_PASSWORD=postgres`.
5. `npm run build --workspaces --if-present` (typecheck, D-04) then `npm run test -w apps/worker` (the existing 24-file suite, unmodified) in the same job.
6. Push a throwaway branch with one deliberately-broken worker test, open a PR, confirm the check shows red and — once branch protection is configured with `test` as a required status check — confirm GitHub's UI reports `merge blocked`. Revert the break, confirm `merge allowed`.

This single slice exercises: GH Actions triggering on both events (QG-01's easiest-to-miss failure mode — see Common Pitfalls), `docker compose --wait` service orchestration (needed by WRK-12, QG-05, QG-06 later), the guard's core two-condition logic (QG-04's spine), and branch protection wiring (QG-01) — without yet touching lint-zero-debt, coverage thresholds, the 5 failure scenarios, `redis.conf`, migration tests, or hygiene/docs. Everything else in the phase is an additive layer on this proven pipe: widen the job to `static`+`test`+`failure-injection` (D-02), replace the hand-named DB with per-run naming (D-10), add the `packages/test-support` consolidation (D-13), etc.

### TDD Shape by Requirement

| Requirement | TDD-natural? | Failing test first | Notes |
|---|---|---|---|
| QG-01 (CI gate) | No — infra config | N/A (config-only) | "Red PR blocks merge" is verified by a *manual* throwaway PR exercise (see tracer slice step 6), not a unit test. Do not force a fake unit test here. |
| QG-02 (lint) | Partially | A fixture file with one deliberate violation; `eslint.config.js` test asserting `npx eslint <fixture>` exits 1 | The bulk of the work (fixing existing violations) is not TDD-shaped — it is mechanical remediation, tracked as a violation-count-to-zero burn-down, not a red/green test. |
| QG-03 (coverage) | Yes | `packages/test-support/src/__tests__/coverage-gate.test.ts` — feed the gate script a fixture `coverage-summary.json` at `covered/total` one row below threshold, assert exit 1; a second fixture exactly at threshold, assert exit 0 | This is the SPEC's own boundary/precision edge cases (R3) — write these as unit tests against the gate script BEFORE wiring it into CI. |
| QG-04 (DB guard) | Yes | `packages/test-support/src/__tests__/guard.test.ts` — table-test the 4 SPEC acceptance rows (equal URLs, `127.0.0.1` vs `localhost` w/ different query params, unset `TEST_DATABASE_URL`, missing `mega_crm_test` prefix) asserting each throws before any DB touch | Pure function, trivially unit-testable, no DB needed. |
| QG-05 (migration tests) | Yes | `packages/db/src/__tests__/migrate-from-empty.test.ts` (RED: no such test exists) asserting all 38 files apply to a freshly created empty DB; `migrate-incremental.test.ts` asserting ≥1 migration applies on top of a seeded DB at a prior checkpoint | Both are genuinely new integration tests — natural TDD. |
| QG-06 (failure injection) | Yes, per-scenario | Each of the 5 npm scripts starts as a failing vitest file (assert the *current* behavior is even reachable) before the fixture/assertion is filled in | See Code Examples for the concrete assertion shape per scenario. |
| QG-07 (env/rdb hygiene) | Partially | `scripts/__tests__/root-blacklist.test.ts` (or a plain Node script executed as a CI step) — fixture directory with `.env` present asserts fail, clean fixture asserts pass | The `.env` *relocation itself* is not testable (operator-manual per constraint) — only the *check* is TDD-shaped. |
| QG-08/QG-09/QG-10 (docs) | No | N/A | Prose deliverables; acceptance is `judgment`-tier per SPEC's own Prohibitions table, not test-tier. |
| WRK-12 (Redis config) | Yes | `docker/__tests__/redis-config.test.ts` (RED against default `redis:7`: `CONFIG GET maxmemory` returns `0`) — SPEC explicitly requires this fail-first proof | See Code Examples. |
| DB-08 (migration linter) | Yes | `scripts/__tests__/migration-linter.test.ts` with the two fail-first fixtures SPEC names (bad enum-in-same-file, bad destructive-DDL-without-marker) plus a "passes on all 38 real migrations" assertion | Both fixtures are cheap to construct (fake `.sql` strings), no DB needed — pure static analysis. |

### Flag: D-22 mechanics gap (packages/test-support ↔ apps/worker import direction)

D-22 says the SIGKILL harness entrypoint "lives in `packages/test-support`" and drives `apps/worker`'s `send-dispatch.ts` via the existing `ProcessSendJobDeps.sendMail` seam. Taken literally, this means `packages/test-support` would need to `import { processSendJob } from "@mega-crm/worker"` — but **`apps/worker/package.json` has no `main`/`types` export field** (unlike every `packages/*` workspace, which all declare `"main": "./src/index.ts"`), and D-13's own Integration Points list only documents the dependency arrow `packages/test-support → apps/api, apps/worker, packages/delivery-core` in the sense of "these apps import test-support," not the reverse. A `packages/*` workspace importing from an `apps/*` workspace is unusual for this repo's existing dependency direction (every `apps/*` package.json lists `@mega-crm/*` packages as dependencies; no `packages/*` package.json lists an `apps/*` dependency anywhere in this codebase today).

**Recommendation for the planner:** keep the actual child-process entrypoint script that imports `processSendJob` physically inside `apps/worker` (e.g. `apps/worker/src/test/harness/sigkill-entrypoint.ts`), and let `packages/test-support` supply only the **generic, reusable** orchestration helpers (spawn a child with an IPC channel, wait for a "ready" message, `kill(pid, 'SIGKILL')`, assert exit code/signal) that `apps/worker`'s own SIGKILL test file (`apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts`) calls, passing the entrypoint's own path. This satisfies D-22's intent (harness *logic* is centralized and reusable, no new DI seam is introduced) without inventing a `packages → apps` import that does not exist anywhere else in the repo. If the planner instead wants the entrypoint script itself inside `packages/test-support`, `apps/worker/package.json` needs a `"main"`/`exports` field added first as its own small task — flag this explicitly as a decision point in the plan rather than silently picking one.

## Standard Stack

No new *architectural* dependency is being introduced — every addition below is test/CI tooling. All versions are matched against what `npm view <pkg> version` returns today and cross-checked for compatibility with this repo's existing `typescript@^5.9.3`, `vitest@4.1.9`, `eslint`-absent baseline.

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `eslint` | `10.8.0` [VERIFIED: npm registry] | Lint engine | Flat config is the only supported config format in ESLint 9+; this repo has zero legacy `.eslintrc` to migrate from, so there is no reason to pin an older major |
| `typescript-eslint` | `8.65.0` [VERIFIED: npm registry] | Type-aware TS linting (single meta-package: parser+plugin+configs) | D-05 locks `recommended-type-checked` + `projectService` — this is the current officially-recommended way to get type-aware lint rules (`no-floating-promises`, `no-misused-promises`, `await-thenable`, `require-await`) without hand-wiring `@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin` separately |
| `@vitest/coverage-v8` | `4.1.10` [VERIFIED: npm registry] | Coverage instrumentation | Must match the installed `vitest@4.1.9` major/minor family exactly (Vitest's own compatibility contract); D-16 already selects this over `@vitest/coverage-istanbul` |
| `@vitest/eslint-plugin` | `1.6.24` [VERIFIED: npm registry] | `vitest/no-focused-tests` rule (D-07's `.only` ban) | Official `vitest-dev` org package (successor to the community `eslint-plugin-vitest`); ships a `no-focused-tests` rule with a `fixable` option — set `fixable: false` so `eslint --fix` cannot silently strip a forgotten `.only` (which would defeat the exact anti-pattern D-07 exists to catch) |
| `eslint-plugin-react-hooks` | `7.1.1` [VERIFIED: npm registry] | Rules-of-hooks + exhaustive-deps for `apps/web` | Official Facebook/React package; only React-ecosystem plugin D-07 requires |
| `eslint-plugin-import` | `2.32.0` [VERIFIED: npm registry] | `import/no-extraneous-dependencies` (D-07) | Long-established, still-maintained; needed specifically for the extraneous-deps rule, not for `import/order` (explicitly out of scope per D-07/Deferred) |
| `eslint-plugin-no-only-tests` | `2.6.0` [VERIFIED: npm registry] | Alternative to `@vitest/eslint-plugin`'s `no-focused-tests` — framework-agnostic `.only` ban | D-07 names either option; `eslint-plugin-no-only-tests` also catches `.only` in `apps/web`'s Playwright specs (`@vitest/eslint-plugin`'s rule is vitest-specific and would not cover `apps/web/e2e/*.spec.ts`). **Recommend using both**: `@vitest/eslint-plugin` scoped to `**/*.test.ts` for vitest files, `eslint-plugin-no-only-tests` scoped to `apps/web/e2e/**` for Playwright specs — a `.only` in an E2E spec is exactly the same silent-green-CI risk. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `execa` | `10.0.0` [VERIFIED: npm registry] | Ergonomic child-process orchestration (Claude's Discretion in CONTEXT.md explicitly allows `node:child_process` OR `execa`) | Use for the SIGKILL harness's parent-side spawn/kill logic and the Redis-restart scenario's `docker restart` invocation — cleaner promise-based API and better stderr/stdout capture than raw `child_process.spawn`, at zero new architectural surface (it is a thin wrapper) |
| `fast-glob` | `9.0.x` [VERIFIED: npm registry] | File enumeration for the migration linter and the root-hygiene blacklist check, if a glob (rather than `readdirSync`) is preferred | Optional — `node:fs.readdirSync` is already the pattern this repo uses (`db-fixture.ts`'s `readdirSync(MIGRATIONS_DIR)`); a plain `readdirSync` + filter is sufficient for both new scripts and adds zero new dependency. Only reach for `fast-glob` if the hygiene check needs to *exclude* nested `node_modules`/`dist` — but D-29 already scopes that check to a **non-recursive** root listing, which `readdirSync(process.cwd())` handles natively with no glob library at all. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Self-written migration linter (D-30) | `squawk` (Postgres migration linter) | D-30 already rejected this: squawk has no rule for "enum value added and used in the same file" (the specific Postgres transaction restriction this phase must catch), so half the linter would still need to be hand-written; not worth a second tool for the other half |
| `docker compose up -d --wait` (D-03) | GitHub Actions native `services:` block | D-03 already rejected this: `services:` cannot override `command`/entrypoint, so `docker/redis.conf` (WRK-12) could never be applied, and `docker restart` (QG-06 scenario 5) has no target container reference in that model |
| `@vitest/eslint-plugin` for `.only` ban | `eslint-plugin-jest` (has a similar rule, framework mismatch) | Not applicable — this repo uses Vitest exclusively for unit/integration, Playwright for E2E; Jest tooling has zero footprint here |
| Vitest's built-in `coverage.thresholds` (D-18) | Custom gate script over `json-summary` | D-18 already rejected the built-in mechanism: it has no unrounded-comparison mode and no cross-branch ratchet capability without re-parsing the TS config from a second process |

**Installation:**
```bash
# Root devDependencies (lint tooling is shared across all workspaces via one root eslint.config.js)
npm install -D eslint typescript-eslint @vitest/eslint-plugin eslint-plugin-react-hooks eslint-plugin-import eslint-plugin-no-only-tests

# apps/api and apps/worker (coverage provider must be present wherever vitest.config.ts enables `test.coverage`)
npm install -D @vitest/coverage-v8 -w apps/api -w apps/worker

# packages/test-support (new workspace, D-13) — orchestration helper
npm install execa -w packages/test-support
```

**Version verification (run before locking the Standard Stack table into a plan):**
```bash
npm view eslint version
npm view typescript-eslint version
npm view @vitest/coverage-v8 version   # MUST match vitest's own installed minor (4.1.x) — verify against apps/api/package.json's vitest version at plan time
npm view @vitest/eslint-plugin version
npm view eslint-plugin-react-hooks version
npm view eslint-plugin-import version
npm view eslint-plugin-no-only-tests version
npm view execa version
```

## Package Legitimacy Audit

Ran `gsd-tools query package-legitimacy check` against every new package above. Several well-known, extremely high-download packages (`eslint`, `typescript-eslint`, `@vitest/coverage-v8`, `@vitest/eslint-plugin`, `execa`, `tsx`) returned a `SUS` verdict with reason `too-new` — this is a **false-positive pattern for actively-maintained, high-velocity packages**: the "too-new" signal fires on the *latest version's publish date*, not the package's age, and all six have weekly download counts in the tens-to-hundreds of millions and an official, matching source repo. Treated as `OK` below with the reason noted; `eslint-plugin-no-only-tests` and `eslint-plugin-import`/`eslint-plugin-react-hooks` returned clean `OK` verdicts outright.

| Package | Registry | Age signal | Downloads/wk | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `eslint` | npm | latest publish 2026-07-24 ("too-new") | 149,397,511 | github.com/eslint/eslint | SUS (too-new only) | **Approved** — official eslint org repo, massive download volume; false positive |
| `typescript-eslint` | npm | latest publish 2026-07-20 ("too-new") | 82,825,281 | github.com/typescript-eslint/typescript-eslint | SUS (too-new only) | **Approved** — official monorepo package, same reasoning |
| `@vitest/coverage-v8` | npm | latest publish 2026-07-06 ("too-new") | 31,736,491 | github.com/vitest-dev/vitest | SUS (too-new only) | **Approved** — official vitest-dev scoped package, must track vitest's own version anyway |
| `@vitest/eslint-plugin` | npm | latest publish 2026-07-24 ("too-new") | 3,409,970 | github.com/vitest-dev/eslint-plugin-vitest | SUS (too-new only) | **Approved** — official vitest-dev org scope |
| `execa` | npm | latest publish 2026-07-17 ("too-new") | 152,022,992 | github.com/sindresorhus/execa | SUS (too-new only) | **Approved** — extremely well-established sindresorhus package |
| `eslint-plugin-react-hooks` | npm | publish 2026-04-17 | 91,838,317 | github.com/facebook/react | OK | Approved |
| `eslint-plugin-import` | npm | publish 2025-06-20 | 57,359,213 | github.com/import-js/eslint-plugin-import | OK | Approved |
| `eslint-plugin-no-only-tests` | npm | publish 2026-04-29 | 2,690,314 | github.com/levibuzolic/eslint-plugin-no-only-tests | OK | Approved |
| `tsx` (already installed, re-checked as part of this phase's env-loading change, D-27) | npm | latest publish 2026-07-13 ("too-new") | 82,619,334 | github.com/privatenumber/tsx | SUS (too-new only) | **Approved** — already a devDependency in this repo at `^4.19.2`; no version change needed for D-27 |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** none requiring a `checkpoint:human-verify` — all six `SUS` verdicts above are the documented "too-new" false-positive pattern for high-download, officially-sourced packages, not slopsquat risk. No package name in this list was discovered via an unverified/ambiguous source; all were selected from official org scopes (`eslint`, `typescript-eslint`, `vitest-dev`, `sindresorhus`, `facebook`) already known from training data and confirmed to exist on the npm registry with matching official repos.

## Architecture Patterns

### System Architecture Diagram

```
PR opened / push to any branch
        │
        ▼
┌─────────────────────────── .github/workflows/ci.yml ───────────────────────────┐
│                                                                                  │
│  ┌──────────┐     ┌──────────────────────────┐     ┌─────────────────────────┐ │
│  │  static  │     │           test            │     │   failure-injection      │ │
│  │ (no svcs)│     │  docker compose up --wait │     │  docker compose up --wait │ │
│  │          │     │  (postgres:17, redis:7    │     │  (postgres:17, redis:7   │ │
│  │ typecheck│     │   w/ docker/redis.conf)   │     │   w/ docker/redis.conf)  │ │
│  │  (build) │     │                            │     │                          │ │
│  │  lint    │     │  provision ephemeral DB   │     │  5 npm run failure:*     │ │
│  │          │     │  (packages/test-support)  │     │  scripts, one per        │ │
│  │          │     │       │                    │     │  scenario                │ │
│  │          │     │       ▼                    │     │       │                  │ │
│  │          │     │  guard: assert DSN !=      │     │       ▼                  │ │
│  │          │     │  DATABASE_URL, prefix ok   │     │  processSendJob() via    │ │
│  │          │     │       │                    │     │  injected sendMail       │ │
│  │          │     │       ▼                    │     │  (4 scenarios) OR a real │ │
│  │          │     │  vitest run --workspaces   │     │  spawned worker process  │ │
│  │          │     │  (91 files, coverage on)   │     │  killed w/ SIGKILL       │ │
│  │          │     │       │                    │     │  (1 scenario)            │ │
│  │          │     │       ▼                    │     │       │                  │ │
│  │          │     │  coverage-gate.mjs vs      │     │       ▼                  │ │
│  │          │     │  coverage-baseline.json    │     │  assert sends/queue state│ │
│  │          │     │  + ratchet vs origin/master│     │  in Postgres/Redis       │ │
│  └────┬─────┘     └────────────┬───────────────┘     └────────────┬─────────────┘ │
│       │                        │                                   │              │
│       └────────────┬───────────┴───────────────────────────────────┘              │
│                     ▼                                                             │
│         branch protection on master requires: static, test, failure-injection      │
│         (e2e job runs but is NOT in the required list — QG-04's Playwright check   │
│          still asserts connection-string but never blocks merge)                   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
.github/
└── workflows/
    └── ci.yml                       # QG-01/02/03/04(assert)/06/07(check) — 4 jobs

docker/
├── init-app-role.sql                # existing
└── redis.conf                       # NEW — WRK-12

packages/
├── test-support/                    # NEW workspace — D-13
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                 # public exports
│   │   ├── guard.ts                 # QG-04 core: assertTestDatabaseUrl()
│   │   ├── provision-db.ts          # QG-04: createEphemeralDatabase/dropEphemeralDatabase
│   │   ├── db-fixture.ts            # consolidated from 3 copies (D-13)
│   │   ├── migration-lint.ts        # DB-08: the linter logic (also invoked from scripts/)
│   │   ├── coverage-gate.ts         # QG-03: threshold + ratchet comparison logic
│   │   ├── harness/
│   │   │   ├── spawn-and-kill.ts    # generic IPC spawn/await-ready/SIGKILL helper (see Flag above)
│   │   │   └── docker-restart.ts    # `docker restart <container>` wrapper via execa
│   │   └── __tests__/
│   │       ├── guard.test.ts
│   │       ├── coverage-gate.test.ts
│   │       └── migration-lint.test.ts
├── db/
│   └── src/__tests__/
│       ├── migrate-from-empty.test.ts     # QG-05 run A
│       └── migrate-incremental.test.ts    # QG-05 run B
└── (kms, tenant-context gain src/__tests__/*.test.ts — D-19's +1pp coverage tests)

apps/worker/src/queues/__tests__/failure-injection/
├── timeout.test.ts                  # failure:timeout
├── rate-limit-429.test.ts           # failure:429
├── connection-reset.test.ts         # failure:reset
├── sigkill.test.ts                  # failure:sigkill
└── redis-restart.test.ts            # failure:redis-restart

apps/worker/src/test/harness/
└── sigkill-entrypoint.ts            # real child-process entrypoint (see Flag above)

apps/web/e2e/
└── (existing specs unchanged; playwright.config.ts globalSetup gains guard + provisioning)

vitest.config.ts                     # NEW — root aggregator, test.projects (D-16)
coverage-baseline.json               # NEW — measured baseline + intentional bump (D-18/D-19)
eslint.config.js                     # NEW — flat config (D-05..D-08)
scripts/
├── check-env.mjs                    # updated for MEGA_CRM_ENV_FILE (D-27/D-28)
├── migrate-dev.mjs                  # updated for MEGA_CRM_ENV_FILE (D-27/D-28)
├── check-root-hygiene.mjs           # NEW — QG-07 blacklist check (D-29)
└── lint-migrations.mjs              # NEW — thin CLI wrapper around packages/test-support/migration-lint.ts

ARCHITECTURE.md                      # NEW — QG-08
CONVENTIONS.md                       # NEW — QG-09
.claude/CLAUDE.md                    # extended § Project Specification — QG-10
```

### Pattern 1: DI-seam failure injection is outcome-injection, not fault-injection

**What:** The DI seam `ProcessSendJobDeps.sendMail` receives a fake function that either **resolves** with a crafted `SendTenantMailResult` (`{status, headers, messageId}`) or **rejects** with a crafted `Error`. There is no real socket, no real timeout, no real 429 wire format involved for 4 of the 5 scenarios.

**When to use:** All in-process scenarios (timeout, 429, connection reset, and the setup half of the Redis-restart scenario). Only the SIGKILL scenario needs a real OS process.

**Example — 429 (this is already proven in the existing durability test, reuse the exact pattern):**
```typescript
// Source: apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts (existing, verbatim pattern)
function fakeSendMail(
  status: number,
  headers: Record<string, string> = {}
): (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult> {
  return async () => ({
    status,
    headers: new Headers(headers),
    messageId: status < 300 ? "sg-message-id-fixture" : null,
  });
}

// failure:429 — assert the claim is released and Retry-After drives the backoff
const result = await processSendJob(
  { workspaceId, campaignId, kind: "campaign", contactId },
  { sendMail: fakeSendMail(429, { "retry-after": "3" }), redisClient }
);
expect(result).toEqual({ outcome: "rate_limited", rateLimitMs: 3000 });
expect(await sendsRowCountFor(workspaceId, campaignId, contactId)).toBe(0); // claim released, no stranded row
```

**Example — timeout / connection reset (NEW — same shape, different rejection):**
```typescript
// failure:timeout — the injected sendMail throws an AbortError-shaped rejection,
// modeling what a FUTURE AbortController timeout (Phase 11, DLV-06) will throw.
// There is no AbortController in send-mail.ts today, so this scenario proves
// the CURRENT unhandled-rejection → BullMQ-retry → interrupted-branch chain,
// not a timeout classification (that assertion belongs to Phase 11).
const timeoutError = new DOMException("The operation was aborted", "AbortError");
async function throwingSendMail() { throw timeoutError; }

await expect(
  processSendJob({ workspaceId, campaignId, kind: "campaign", contactId }, { sendMail: throwingSendMail, redisClient })
).rejects.toThrow(timeoutError);
// the claim committed by unit 1 is now stranded at 'dispatching' -- assert that,
// then simulate the BullMQ retry by calling processSendJob AGAIN with a
// call-counting sendMail and assert it is called 0 times (the `interrupted`
// branch in claimCampaignSend intercepts the redelivery) and the row resolves
// to 'failed'.
expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("dispatching");
const counting = countingSendMail(202);
const retried = await processSendJob({ workspaceId, campaignId, kind: "campaign", contactId }, { sendMail: counting.fn, redisClient });
expect(counting.callCount()).toBe(0);
expect(retried.outcome).toBe("failed");

// failure:reset — same shape, different error identity, so the two scenarios
// are distinguishable in test output/CI logs even though the code path is
// identical today:
const resetError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
async function resettingSendMail() { throw resetError; }
```

### Pattern 2: `docker compose --wait` relies entirely on the compose file's `healthcheck:` blocks

**What:** Both `db` and `redis` already declare a `healthcheck:` in `docker-compose.yml` (`pg_isready -U postgres`, `redis-cli ping`). `docker compose up -d --wait` blocks until every service with a healthcheck reports `healthy` (or a service without one reports `running`), then returns 0; it returns non-zero if any service reports `unhealthy` before its timeout.

**When to use:** Every CI job that needs live Postgres/Redis (`test`, `failure-injection`).

**Example:**
```yaml
# Source: this repo's existing docker-compose.yml healthchecks (unmodified),
# invoked from CI exactly as D-03 requires -- same command locally and in CI.
- name: Start Postgres + Redis
  run: docker compose up -d --wait
- name: Run backend test suite
  env:
    DATABASE_URL: postgres://postgres:postgres@localhost:5432/mega_crm
  run: npm run test --workspaces --if-present
```

**Anti-Patterns to Avoid:**
- **Adding a `sleep 5` before running tests "just in case":** defeats the entire purpose of `--wait`; if a service needs longer, fix its `healthcheck.retries`/`interval`, don't paper over it with a timer (this is literally the anti-pattern DB-05/OPS-05 elsewhere in the roadmap warn against for migrations/readiness).
- **Giving the ephemeral test DB the same name across concurrent CI runs:** two PRs' `test` jobs running simultaneously against the same shared `db` service container (if ever moved to a shared runner) would collide on `mega_crm_test` — D-10's per-run-id naming (`mega_crm_test_<workspace>_<run-id>`) exists specifically to close SPEC's R1 backstop edge.
- **Trusting `eslint --format json`'s file count without a floor check:** an `ignores` glob typo can silently make ESLint check 0 files and exit 0 — D-08's version-controlled floor number is the only thing that catches this (SPEC's own "empty" edge case for R2).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Type-aware async-bug linting (`no-floating-promises` etc.) | A custom AST rule scanning for un-awaited promises | `typescript-eslint` `recommended-type-checked` | This exact rule class is what type-aware ESLint exists for; a hand-rolled version would need its own TypeScript type-checker integration |
| `.only` detection | A regex grep over test files as a CI step | `@vitest/eslint-plugin`'s `no-focused-tests` / `eslint-plugin-no-only-tests` | Both already handle `describe.only`, `it.only`, `test.only`, `.skip` variants, and nested cases a regex would miss |
| Coverage percentage computation | Parsing Istanbul/v8 raw coverage JSON by hand | `@vitest/coverage-v8`'s `json-summary` reporter, which already exposes `covered`/`total` per metric | Re-deriving percentages from raw coverage maps is exactly the kind of "looks simple, has edge cases" (branch coverage counting, uncovered-but-unreachable code) that a maintained instrumentation library already solves |
| Postgres migration drift detection | A hand-rolled schema-diff tool | `drizzle-kit generate --dry-run`-style empty-diff assertion as a smoke test (see Common Pitfalls — this only catches drift the *tool* can see, know its limits) | Don't reinvent schema diffing; but also don't over-trust it — see Pitfall below |
| TCP-level connection reset simulation | A custom raw-socket server that resets connections | Not needed in this phase at all — D-22 confirms the harness stays entirely on the DI seam (`sendMail` throws an `ECONNRESET`-shaped `Error`), never opens a real socket | Building `toxiproxy` or a raw TCP fault-injector would be introducing exactly the "new seam"/new infrastructure the phase boundary explicitly forbids (`packages/delivery-core/src/send-mail.ts`'s hardcoded SendGrid URL is why — see D-22) |

**Key insight:** Every "don't hand-roll" here trades a small amount of specificity (the harness can't literally reproduce a TCP RST packet) for staying inside this phase's explicit boundary (no new seam, no configurable SendGrid base URL until Phase 16). That tradeoff is already made by CONTEXT.md D-22 — this research just confirms it is the *sound* choice, not merely the locked one: a raw-socket fault injector would need its own maintenance and does not verify anything `send-dispatch.ts`'s actual code path can observe differently from a rejected promise.

## Common Pitfalls

### Pitfall 1: Workflow only triggers on `push`, not `pull_request` (or vice versa)
**What goes wrong:** The required status check never appears on the PR's checks list, and GitHub either shows the PR as permanently "pending" (if the check is required but never runs) or silently allows merge (if not required).
**Why it happens:** Easy to write `on: push:` and forget `pull_request:`, especially when copying a single-trigger example.
**How to avoid:** `on: { push: {}, pull_request: { branches: [master] } }` explicitly, matching D-01's "CI triggers on push into `phase-NN-*` AND on pull_request" requirement. Verify with the tracer slice's throwaway PR (step 6).
**Warning signs:** A PR shows no checks at all, or shows checks whose names don't match branch-protection's required list exactly (job name, not workflow name, is what branch protection matches against).

### Pitfall 2: `projectService: true` errors on files outside every `tsconfig.json`'s `include`
**What goes wrong:** Every `apps/*/tsconfig.json` and `packages/*/tsconfig.json` in this repo has `"include": ["src"]` — but `vitest.config.ts`, `drizzle.config.ts`, `playwright.config.ts`, `eslint.config.js` itself, and everything in `scripts/*.mjs` sit **outside** `src/`. `typescript-eslint`'s `projectService` will throw `Parsing error: ... was not found by the project service` for any of these files unless explicitly handled.
**Why it happens:** `projectService` (the modern typescript-eslint mechanism) auto-discovers the *nearest* `tsconfig.json` per file, but only files that tsconfig's `include` actually covers are considered "in project."
**How to avoid:** Add `languageOptions.parserOptions.projectService.allowDefaultProject: ["*.config.ts", "*.config.mjs", "*.config.js"]` (relative, per-directory glob, typescript-eslint's documented escape hatch for "a few stray files"), or scope the type-checked config block to `files: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"]` and apply only the non-type-checked `tseslint.configs.recommended` to everything else (config files, `scripts/*.mjs`). The second option is cleaner given how many config files this repo has scattered at workspace roots.
**Warning signs:** `npx eslint .` throwing parser errors (not lint violations) on `*.config.ts` files the moment the type-checked block is added.

### Pitfall 3: `drizzle-kit check` does not detect the drift this phase actually cares about
**What goes wrong:** `drizzle-kit check` validates the migration *journal's own internal consistency* (snapshot collisions, non-sequential numbers) — it does NOT compare live-DB state to `schema/*.ts`, and `drizzle-kit generate` can print "No schema changes" even when the schema and the actual applied migrations have drifted, per a documented upstream GitHub issue thread found during this research.
**Why it happens:** Drizzle's diffing is snapshot-to-snapshot, not introspection-to-schema; and this repo already has a known gap — only 11 of 38 migrations have a `meta/*_snapshot.json` (27 are "rukopisnye" per `SPECIFICATION.md` §4.6), so `generate`'s diff baseline is incomplete for most of migration history.
**How to avoid:** Do NOT rely on `drizzle-kit generate` producing an empty diff as QG-05's primary migration-test mechanism (SPEC already scopes QG-05 to "apply all 38 migrations to an empty DB" and "apply the incremental remainder to a seeded DB," which is exactly the from-scratch SQL-file-runner `db-fixture.ts` already implements — reuse that runner, don't introduce `drizzle-kit`'s own diffing as a load-bearing check in this phase).
**Warning signs:** A migration test that only asserts `drizzle-kit generate` output is empty will pass even when a hand-written migration diverges from `schema/*.ts` in ways the incomplete snapshot history can't see.

### Pitfall 4: Postgres forbids using a freshly-added enum value inside the transaction that added it
**What goes wrong:** `ALTER TYPE send_status ADD VALUE 'reconciling'; UPDATE sends SET status = 'reconciling' WHERE ...;` inside one transaction (or one migration file that Drizzle wraps in a transaction) throws `unsafe use of new value "reconciling" of enum type send_status` — verified against the Postgres documentation and confirmed by multiple independent bug-report threads during this research.
**Why it happens:** Postgres cannot guarantee the new enum value is durable until the `ADD VALUE` transaction commits; using it earlier could leave an index entry that survives a rollback of the type change itself. The one exception (not relevant here) is when the enum type itself was created in the same transaction.
**How to avoid:** This is exactly DB-08's reason for existing — enforce as a migration-linter rule (see Code Examples) that a single `.sql` file may not both `ALTER TYPE ... ADD VALUE` and reference that literal value in the same file. Phase 11's `'reconciling'` addition to `send_status` ships as its own standalone migration (confirmed applied) before any later migration or app code references it.
**Warning signs:** A migration test suite that runs the *whole* migration chain in one transaction (rather than one transaction per file, matching `drizzle-kit migrate`'s own per-file transaction behavior and this repo's `db-fixture.ts`'s per-file `client.query(sql)` calls) would mask this error until the literal deploy sequencing test.

### Pitfall 5: `noeviction` alone proves nothing without `maxmemory > 0`
**What goes wrong:** Redis 7's default `maxmemory` is `0` (no limit) — `noeviction` is *already* the default `maxmemory-policy`, so a test asserting only `CONFIG GET maxmemory-policy` returns `noeviction` would pass against a completely unconfigured `redis:7` and prove nothing (SPEC already calls this out explicitly as a "vacuous" check to avoid).
**Why it happens:** Confusing "the policy exists" with "the policy can ever trigger" — it cannot trigger without a memory ceiling to hit.
**How to avoid:** The WRK-12 test must assert **all three** values together (`maxmemory > 0`, `maxmemory-policy = noeviction`, `appendonly = yes`) and must be run once against a deliberately-unconfigured `redis:7` (fail-first proof) before `docker/redis.conf` exists, then again after — SPEC's own acceptance criterion.
**Warning signs:** A green WRK-12 test that was never run against the default config to confirm it can actually fail.

### Pitfall 6: BullMQ's own `Worker` internals can throw OOM errors on internal bookkeeping scripts, not just `queue.add()`
**What goes wrong:** Under `noeviction` + a full `maxmemory`, BullMQ's Lua scripts for job state transitions (not only enqueue) can throw `OOM command not allowed`, which surfaces as an unhandled Worker-level error, not a clean `queue.add()` rejection — confirmed by a real BullMQ GitHub issue found during this research.
**Why it happens:** BullMQ manages job state via Redis-side Lua scripts that both read and write; any of them can hit the memory ceiling, not only the initial `addJob`.
**How to avoid:** This phase does not need to *handle* that condition gracefully (that is Phase 12/worker-reliability territory) — but the harness/test for WRK-12 should not conflate "Redis correctly refuses writes under `noeviction`" (the thing this phase proves) with "BullMQ gracefully degrades under OOM" (explicitly out of scope, deferred). Scope the WRK-12 test to a direct `redis-cli`/ioredis `CONFIG GET` assertion, not a full BullMQ-under-memory-pressure simulation.
**Warning signs:** Scope creep — a WRK-12 task that starts trying to make BullMQ itself OOM-resilient is solving a Phase 12 problem inside Phase 8.

## Code Examples

### QG-04: DSN normalization guard (pure function, fully unit-testable)
```typescript
// Source: derived from 08-SPEC.md requirement 4's exact acceptance criteria
// (host/port/database normalization, localhost/127.0.0.1/::1 collapse,
// credentials and query params ignored). New file: packages/test-support/src/guard.ts
import { URL } from "node:url";

interface NormalizedDsn {
  host: string;
  port: string;
  database: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function normalizeDsn(raw: string): NormalizedDsn {
  const url = new URL(raw);
  const host = LOOPBACK_HOSTS.has(url.hostname) ? "loopback" : url.hostname.toLowerCase();
  const port = url.port || "5432";
  const database = url.pathname.replace(/^\//, "");
  return { host, port, database };
}

export function assertTestDatabaseUrl(testUrl: string | undefined, devUrl: string | undefined): void {
  if (!testUrl || testUrl.length === 0) {
    throw new Error(
      "FATAL: TEST_DATABASE_URL is unset or empty. Tests must never fall back to DATABASE_URL. " +
        "Run the provisioning script (packages/test-support/src/provision-db.ts) first."
    );
  }
  const testDsn = normalizeDsn(testUrl);
  if (!testDsn.database.startsWith("mega_crm_test")) {
    throw new Error(
      `FATAL: test database name "${testDsn.database}" does not start with the required "mega_crm_test" prefix.`
    );
  }
  if (devUrl) {
    const devDsn = normalizeDsn(devUrl);
    if (testDsn.host === devDsn.host && testDsn.port === devDsn.port && testDsn.database === devDsn.database) {
      throw new Error(
        `FATAL: TEST_DATABASE_URL resolves to the same host+port+database as DATABASE_URL ` +
          `(${testDsn.host}:${testDsn.port}/${testDsn.database}). Tests must never touch the dev database.`
      );
    }
  }
}
```

### QG-03: Coverage gate script (unrounded comparison, equal-passes semantics — D-18)
```typescript
// Source: derived from 08-SPEC.md requirement 3's exact acceptance criteria
// (unrounded covered/total comparison, equal-to-threshold passes).
// New file: packages/test-support/src/coverage-gate.ts
import { readFileSync } from "node:fs";

interface CoverageSummaryTotal {
  lines: { total: number; covered: number };
}
interface CoverageSummary {
  total: CoverageSummaryTotal;
}
interface Baseline {
  lines: number; // e.g. 0.7834 (unrounded fraction, NOT a percentage)
}

export function checkCoverageGate(summaryPath: string, baselinePath: string): { pass: boolean; actual: number; threshold: number } {
  const summary: CoverageSummary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const baseline: Baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const { total, covered } = summary.total.lines;
  const actual = covered / total; // UNROUNDED -- 84.996% must fail an 85% baseline, not round up
  return { pass: actual >= baseline.lines, actual, threshold: baseline.lines };
}
```

### DB-08: Migration linter core rules
```typescript
// Source: 08-SPEC.md requirement 8 + verified Postgres ALTER TYPE ADD VALUE
// restriction (Pitfall 4 above). New file: packages/test-support/src/migration-lint.ts
function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

interface LintViolation {
  file: string;
  rule: "enum-add-value-used-same-file" | "destructive-ddl-unmarked";
  detail: string;
}

/** Rule 1: a file that both ALTER TYPE ... ADD VALUE 'x' and references 'x' as a literal elsewhere. */
function checkEnumAddValueSameFile(file: string, rawSql: string): LintViolation | null {
  const sql = stripSqlComments(rawSql);
  const addValueMatch = sql.match(/ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE\s+'([^']+)'/i);
  if (!addValueMatch) return null;
  const addedValue = addValueMatch[1];
  // Count occurrences of the literal OUTSIDE the ADD VALUE statement itself.
  const withoutAddValueStatement = sql.replace(addValueMatch[0], "");
  const usagePattern = new RegExp(`'${addedValue}'`);
  if (usagePattern.test(withoutAddValueStatement)) {
    return { file, rule: "enum-add-value-used-same-file", detail: `'${addedValue}' used in the same file it was added` };
  }
  return null;
}

/** Rule 2: destructive DDL (DROP COLUMN, ALTER TABLE...ADD COLUMN/SET NOT NULL without DEFAULT)
 *  without an immediately-preceding "-- destructive: <reason>" marker comment (D-31). */
function checkDestructiveDdl(file: string, rawSql: string): LintViolation[] {
  const violations: LintViolation[] = [];
  const lines = rawSql.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isDrop = /DROP\s+COLUMN/i.test(line);
    const isUnsafeNotNull =
      /ALTER\s+TABLE/i.test(rawSql.slice(0, rawSql.indexOf(line))) === false
        ? false
        : /ADD\s+COLUMN[^,;]*NOT\s+NULL/i.test(line) && !/DEFAULT/i.test(line);
    if (!isDrop && !isUnsafeNotNull) continue;
    const priorLine = (lines[i - 1] ?? "").trim();
    if (!/^--\s*destructive:\s*\S/.test(priorLine)) {
      violations.push({
        file,
        rule: "destructive-ddl-unmarked",
        detail: `Line ${i + 1} is destructive DDL with no "-- destructive: <reason>" marker on the prior line`,
      });
    }
  }
  return violations;
}
```

### WRK-12: `docker/redis.conf` and the CONFIG GET assertion
```
# Source: 08-SPEC.md requirement 7 + verified Redis appendfsync/AOF semantics.
# New file: docker/redis.conf -- mounted the same way docker/init-app-role.sql
# already is (see docker-compose.yml's existing `db` service volume pattern).
maxmemory 512mb
maxmemory-policy noeviction
appendonly yes
appendfsync everysec
```
```yaml
# docker-compose.yml addition -- mirrors the existing db service's init-script mount pattern
redis:
  image: redis:7
  command: ["redis-server", "/usr/local/etc/redis/redis.conf"]
  volumes:
    - mega_crm_redis_data:/data
    - ./docker/redis.conf:/usr/local/etc/redis/redis.conf:ro
```
```typescript
// New test file: docker/__tests__/redis-config.test.ts (or packages/test-support equivalent)
// Must be run FIRST against an unconfigured redis:7 to prove it fails (SPEC fail-first requirement).
import { Redis } from "ioredis";

it("Redis is configured for noeviction with a real ceiling and AOF durability", async () => {
  const redis = new Redis(process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1");
  const [maxmemory] = await redis.config("GET", "maxmemory");
  const [, policy] = await redis.config("GET", "maxmemory-policy");
  const [, appendonly] = await redis.config("GET", "appendonly");
  expect(Number(maxmemory)).toBeGreaterThan(0); // fails against default redis:7 (maxmemory=0)
  expect(policy).toBe("noeviction");
  expect(appendonly).toBe("yes");
  await redis.quit();
});
```

### QG-06 scenario 4 (SIGKILL): IPC-signaled freeze, not a timer-based kill
```typescript
// Source: verified pattern from Node.js child_process IPC semantics research
// (SIGKILL cannot be intercepted; a "ready-to-kill" IPC message is the only
// deterministic way to guarantee the kill lands inside the intended window).
// apps/worker/src/test/harness/sigkill-entrypoint.ts (child process)
process.on("message", async (msg) => {
  if (msg !== "run") return;
  const neverResolvingSendMail = async (): Promise<never> => {
    process.send?.("claim-committed-about-to-call-sendgrid"); // signal BEFORE hanging
    return new Promise(() => {}); // never resolves -- process is frozen exactly inside
                                    // the window after claimCampaignSend's commit and
                                    // before the (never-reached) unit-3 record transaction
  };
  await processSendJob(JSON.parse(process.env.JOB_DATA!), { sendMail: neverResolvingSendMail });
});

// apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts (parent, using
// packages/test-support's generic spawnAndAwaitReady/kill helper)
const child = fork("apps/worker/src/test/harness/sigkill-entrypoint.ts", { env: { ...process.env, JOB_DATA: JSON.stringify(jobData) } });
await new Promise<void>((resolve) => {
  child.on("message", (msg) => {
    if (msg === "claim-committed-about-to-call-sendgrid") resolve();
  });
  child.send("run");
});
child.kill("SIGKILL");
await once(child, "exit");
expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("dispatching"); // stranded claim
// "restart" = re-run processSendJob in-process; interrupted branch must fire, 0 SendGrid calls
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `.eslintrc.json`/`.eslintrc.js` | Flat config (`eslint.config.js`) | ESLint 9 (2024) made flat config the default and only supported format for new projects | This repo has zero legacy config, so there is nothing to migrate — write flat config from the start, no `FlatCompat` shim needed |
| `@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin` as separate installs | Single `typescript-eslint` meta-package | typescript-eslint v8 | Simpler installation surface; the meta-package re-exports both plus `tseslint.config()` helper |
| `parserOptions.project: ["./tsconfig.json"]` (static list) | `parserOptions.projectService: true` (auto-discovery) | typescript-eslint v6+ | Removes the need to hand-maintain a project-array across 11 workspace tsconfigs — but introduces the "files outside any tsconfig include" gotcha (Pitfall 2 above) that the old static-array approach didn't have in the same way |
| `eslint-plugin-vitest` (community) | `@vitest/eslint-plugin` (official, `vitest-dev` org) | The official package superseded/absorbed the community one | Same relationship as the `reactflow`→`@xyflow/react` rename already documented in this project's CLAUDE.md — prefer the actively-maintained official scope |

**Deprecated/outdated:** none of the tooling recommended here is itself deprecated; the "old approaches" above are ESLint/typescript-eslint ecosystem history, not something this repo is migrating away from (it never adopted the old forms).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `docker compose up -d --wait`'s exit-code/blocking semantics (blocks until healthy, non-zero on unhealthy) were confirmed via WebSearch, not against Docker's own current CLI reference page directly | Architecture Patterns Pattern 2, Tracer Slice | If actual behavior differs (e.g., a timeout default that's too short for `postgres:17`'s cold-start), the tracer slice's first CI run may need a `--wait-timeout` tune — low risk, easily diagnosed on first real run |
| A2 | `typescript-eslint`'s `projectService.allowDefaultProject` glob syntax and behavior (Pitfall 2) is described from general typescript-eslint documentation knowledge, not verified against the exact `8.65.0` release notes | Common Pitfalls Pitfall 2 | If the API shape changed, the escape-hatch config snippet may need adjustment — the underlying problem (config files outside `src/` inclusion) is verified fact (this repo's own tsconfigs), only the exact fix syntax is assumption |
| A3 | `@vitest/coverage-v8`'s exact latest version (`4.1.10`) will still be current when this phase is executed; must re-verify against the exact installed `vitest` version at plan/execute time, not just "same major.minor" | Standard Stack | Installing a mismatched coverage-v8 minor against vitest could produce a runtime version-mismatch warning or failure — cheap to catch (`npm install` would surface a peer-dependency conflict) |
| A4 | BullMQ's own internal Lua scripts throwing OOM under `noeviction` (Pitfall 6) is based on a single GitHub issue found via WebSearch, not BullMQ's own documentation confirming this as expected/documented behavior | Common Pitfalls Pitfall 6 | If BullMQ actually handles OOM more gracefully than that issue suggests, the pitfall's severity is lower than stated — does not change this phase's scope either way (WRK-12's test only asserts Redis config, not BullMQ's OOM-handling behavior) |
| A5 | The recommendation to keep the SIGKILL entrypoint physically inside `apps/worker` rather than `packages/test-support` (the "Flag" section) is this research's own architectural judgment, resolving an ambiguity in D-22's wording — it is not itself a locked CONTEXT.md decision | Tracer Slice & TDD Shape → Flag | If the planner or a future reviewer intended `packages/test-support` to literally own the entrypoint file, `apps/worker/package.json` needs an added `main`/`exports` field first; low risk either way, just needs an explicit pick |

**All other claims in this research are either `[VERIFIED: npm registry]` (package versions/legitimacy, confirmed via `npm view` and `gsd-tools package-legitimacy check`), `[VERIFIED: local codebase]` (every as-built fact — file paths, existing test patterns, tsconfig contents, docker-compose contents — confirmed by directly reading this repo's files during this research session), or `[CITED: web]` (GitHub Actions / drizzle-kit / Postgres / Redis / undici mechanics, confirmed via WebSearch against official docs, GitHub issue threads, and independent technical blogs, cross-referenced across 2+ sources per topic where noted in Sources below).**

## Open Questions

1. **Should the root `vitest.config.ts` aggregator (D-16, `test.projects`) include `packages/segments-core` and `packages/shared-schemas`, which currently have a `test` script but no dedicated `vitest.config.ts`?**
   - What we know: both packages run `vitest run` today via their own `npm test` script with zero config (Vitest's own defaults apply); D-16 explicitly names them as packages whose tests should count toward the aggregated denominator.
   - What's unclear: whether "no config file" packages can be listed directly as a `test.projects` glob entry (pointing at their `package.json`/directory) the same way a package with an explicit `vitest.config.ts` can, per Vitest 4's exact `projects` field semantics.
   - Recommendation: verify Vitest 4's `projects` array accepts a bare directory glob (not just a config-file glob) before finalizing the root config; if it does not, add a minimal `vitest.config.ts` to both packages first (near-zero-cost, mirrors `packages/flows-core`'s existing minimal config) rather than fighting the aggregator.

2. **Exact `docker compose --wait` default timeout and whether `postgres:17`'s cold-start-plus-38-migrations time fits inside it on a GitHub-hosted runner.**
   - What we know: the healthchecks already have generous retry counts (`retries: 10`, `interval: 5s` = 50s ceiling); this is separate from `--wait`'s own timeout, which was not found precisely documented during this research pass.
   - What's unclear: whether GitHub-hosted runner disk I/O makes Postgres's first boot meaningfully slower than local dev, pushing past whatever `--wait`'s default timeout is.
   - Recommendation: the tracer slice (step 6) is exactly the mechanism to discover this empirically on the first real CI run; if it times out, add `--wait-timeout 120` explicitly rather than guessing a value now.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker / Docker Compose v2 | `test`, `failure-injection` CI jobs; local dev | ✓ (local, confirmed `docker-compose.yml` already in use) | not version-pinned in repo | GitHub-hosted `ubuntu-latest` runners ship Docker + Compose v2 plugin preinstalled — no fallback needed |
| Node.js | Everything | ✓ | `v26.0.0` (confirmed via `node -v`) — no `.nvmrc` exists yet | D-01's Claude's-Discretion item: pin CI to this exact version via `.nvmrc` + `actions/setup-node`, since `engines` in root `package.json` only declares `>=22` |
| GitHub Actions (hosted runners) | CI itself | ✓ (assumed — repo is on GitHub per `gh`-CLI conventions elsewhere in this environment) | — | If self-hosted runners are used instead, `docker compose` and `redis-cli`/`pg_isready` must be present on the runner image — verify before relying on GitHub-hosted defaults |
| `eslint`, `typescript-eslint`, `@vitest/coverage-v8`, etc. | QG-02, QG-03 | ✗ (none installed yet) | — | This entire phase's job is to install and wire these; no fallback, they are the deliverable |

**Missing dependencies with no fallback:** none — every missing tool above is a first-class deliverable of this phase, not an external blocker.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.9 (existing) + Playwright 1.61.1 (existing, E2E only) |
| Config file | Per-workspace `vitest.config.ts` (existing, 5 files) + NEW root `vitest.config.ts` aggregator (D-16) |
| Quick run command | `npm run test -w apps/worker` (24 files, ~seconds) during iterative development |
| Full suite command | `npm run test --workspaces --if-present` (91 files today, growing with this phase's new tests) against `docker compose up -d --wait` services |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| QG-01 | Red PR blocked, green PR allowed | manual/CI-config | throwaway PR exercise (tracer slice step 6) | ❌ N/A — not a repo test file |
| QG-02 | Lint fails on violation, 0 on clean tree | unit | `npx eslint <fixture-with-violation>` (exit 1) then clean tree (exit 0) | ❌ Wave 0 — `eslint.config.js` |
| QG-03 | Coverage gate boundary/precision | unit | `vitest run packages/test-support/src/__tests__/coverage-gate.test.ts` | ❌ Wave 0 |
| QG-04 | DSN guard 4 SPEC rows | unit | `vitest run packages/test-support/src/__tests__/guard.test.ts` | ❌ Wave 0 |
| QG-05 | Migrations from empty + incremental | integration | `vitest run packages/db/src/__tests__/migrate-from-empty.test.ts` / `migrate-incremental.test.ts` | ❌ Wave 0 |
| QG-06 (5x) | Each failure scenario, asserted outcome | integration | `npm run failure:timeout` / `failure:429` / `failure:reset` / `failure:sigkill` / `failure:redis-restart` | ❌ Wave 0 (fixtures exist to copy from — `send-dispatch-durability.test.ts`) |
| QG-07 | Root blacklist fail-first | unit | `node scripts/check-root-hygiene.mjs` against a fixture tree with `.env` present | ❌ Wave 0 |
| QG-08/09/10 | Docs exist, rule text present | judgment | manual review against SPEC acceptance criteria | ❌ N/A — prose deliverables |
| WRK-12 | Redis config asserted, fail-first proof | integration | `vitest run docker/__tests__/redis-config.test.ts` (run once before `docker/redis.conf`, once after) | ❌ Wave 0 |
| DB-08 | Migration linter fail-first + passes on 38 real files | unit | `vitest run packages/test-support/src/__tests__/migration-lint.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** relevant single-file `vitest run <path>` (fast feedback on the file just touched)
- **Per wave merge:** `npm run test --workspaces --if-present` against `docker compose up -d --wait` (full 91+ file suite)
- **Phase gate:** the `test` + `failure-injection` CI jobs green on the phase's own PR before `/gsd-verify-work`; branch protection confirmed on a real throwaway PR (tracer slice step 6) before declaring QG-01 done

### Wave 0 Gaps
- [ ] `packages/test-support/` workspace scaffold (package.json, tsconfig.json) — nothing exists yet (D-13)
- [ ] `eslint.config.js` — no ESLint config anywhere in the repo today
- [ ] `vitest.config.ts` (root aggregator) — does not exist; only per-workspace configs exist today
- [ ] `coverage-baseline.json` — cannot be written until coverage is first measured (chicken-and-egg: plan must sequence "install coverage provider → run once → record baseline → THEN add the gate" as ordered tasks, not parallel ones)
- [ ] `docker/redis.conf` — does not exist; `docker-compose.yml`'s `redis` service has no `command:` override today
- [ ] `.github/workflows/ci.yml` — `.github/` does not exist at all
- [ ] `ARCHITECTURE.md`, `CONVENTIONS.md` — neither file exists

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Phase does not touch auth surfaces |
| V3 Session Management | No | Not in scope |
| V4 Access Control | No | Not in scope |
| V5 Input Validation | Partial | The migration linter and root-hygiene checker both parse untrusted-shaped input (SQL file contents, directory listings) — treat as static analysis over trusted repo content, not attacker-controlled input; no new external input surface is created by this phase |
| V6 Cryptography | No | Not in scope; no secrets are newly introduced (the `.env` relocation changes *where* existing secrets live, not their handling — `MEGA_CRM_ENV_FILE` itself is a path, not a secret) |

### Known Threat Patterns for this stack (phase-relevant subset)

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| CI secrets exposure via a compromised third-party GitHub Action | Information Disclosure | Pin any third-party action used (`actions/checkout`, `actions/setup-node`, `docker/setup-buildx-action` if used) to a full commit SHA, not a floating tag — this phase's workflow should not need any third-party action beyond the official `actions/*` ones, since `docker compose` and `npm` are already on the runner |
| Ephemeral-DB provisioning script accidentally granted enough privilege to `DROP`/`TRUNCATE` a non-test database | Tampering / Elevation of Privilege | SPEC's own negative criterion (already covered above): the provisioning script must refuse `DROP`/`TRUNCATE` against any database name that fails the `mega_crm_test` prefix check — implement this as a hard-coded guard inside the drop function itself (not just at the call site), so no future caller can bypass it by constructing the DSN differently |
| `docker/redis.conf` accidentally exposing Redis on a public interface with no auth (this repo's dev Redis already has no `requirepass`, per `SPECIFICATION.md` §1.3) | Elevation of Privilege | Out of scope for this phase (dev-only compose file, not a production deployment artifact); flag as a pre-existing condition, not a regression this phase introduces or is responsible for fixing |

## Sources

### Primary (HIGH confidence)
- This repo's own source files, read directly during this research session: `package.json` (root + all 11 workspaces), `docker-compose.yml`, `docker/init-app-role.sql`, all `vitest.config.ts` files, all `tsconfig.json` files, `packages/db/drizzle.config.ts`, `packages/db/migrations/*.sql` (grepped for `$$`, `DROP COLUMN`, `ADD VALUE`), `apps/worker/src/queues/send-dispatch.ts`, `apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts`, `apps/api/src/test/db-fixture.ts`, `apps/worker/src/test/db-fixture.ts`, `packages/delivery-core/src/send-mail.ts`, `apps/web/playwright.config.ts`, `scripts/check-env.mjs`, `scripts/migrate-dev.mjs`, `.gitignore`, `.planning/config.json`
- `npm view <pkg> version` — direct registry queries for: eslint, typescript-eslint, @vitest/coverage-v8, eslint-plugin-react-hooks, eslint-plugin-import, @vitest/eslint-plugin, execa, eslint-plugin-no-only-tests, fast-glob, tsx, globby
- `gsd-tools query package-legitimacy check` — verdicts for all 11 new/re-checked packages above

### Secondary (MEDIUM confidence)
- [Vitest coverage config docs](https://vitest.dev/config/coverage) — cross-checked against a second independent source (nerdleveltech.com Vitest coverage tutorial) for `thresholds`/`perFile`/`autoUpdate` semantics
- [typescript-eslint Monorepo Configuration](https://typescript-eslint.io/troubleshooting/typed-linting/monorepos/) and [Linting with Type Information](https://typescript-eslint.io/getting-started/typed-linting/) — official docs, cross-checked against a Medium walkthrough for the exact `tseslint.config()` flat-config shape
- [Postgres ALTER TYPE documentation](https://www.postgresql.org/docs/current/sql-altertype.html) — official docs, cross-checked against the original 2017 postgresql.org mailing-list thread that introduced the "unsafe use of new value" restriction, and a 2026 payloadcms GitHub issue reproducing the exact error message
- [BullMQ Going to Production guide](https://docs.bullmq.io/guide/going-to-production) and [BullMQ Troubleshooting](https://docs.bullmq.io/guide/troubleshooting) — official docs confirming the `noeviction` requirement; cross-checked against a live GitHub issue (#3834) showing the OOM-on-Lua-script failure mode
- [Redis appendfsync durability guides](https://severalnines.com/blog/importance-append-only-file-redis/) — cross-checked against a second independent source (dev.to Redis+Docker Compose guide) for `everysec` vs `always` tradeoffs and SIGTERM shutdown behavior
- [undici MockAgent GitHub issues](https://github.com/nodejs/undici/issues/4107) — confirms MockAgent operates at the dispatcher/interceptor layer, not the socket layer (informs the "outcome-injection, not fault-injection" framing in this research, even though this phase ultimately does not use undici's MockAgent at all per D-22)

### Tertiary (LOW confidence)
- [GitHub required-status-checks troubleshooting discussion threads](https://github.com/orgs/community/discussions/167194) — community discussion, not official GitHub docs directly quoted; the core claim (job name must match, both triggers needed) is corroborated across 3 independent blog posts found in the same search but not verified against GitHub's own current branch-protection documentation page directly
- [drizzle-kit generate empty-diff / drift GitHub issue threads](https://github.com/drizzle-team/drizzle-orm/issues/5059) — feature-request/bug-report threads, not resolved documentation; treated as directional evidence for Pitfall 3, not a settled fact about current `drizzle-kit@0.31.10` behavior specifically
- [Node.js child_process SIGKILL/IPC WebSearch results](https://github.com/nodejs/help/issues/1790) — general community discussion of child-process signal semantics, not a documented crash-injection testing pattern from an authoritative source; the IPC-signal-before-hang pattern in this research is this document's own synthesis of verified primitives (SIGKILL is unconditional; IPC `process.send`/`on('message')` exists), not a copied pattern from a single citable source

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every package version verified via `npm view`, legitimacy checked via `gsd-tools`, and cross-referenced against this repo's actual installed `vitest`/`typescript` versions
- Architecture (CI shape, guard, coverage gate, migration linter): HIGH for what already exists in-repo and MEDIUM for GitHub Actions/drizzle-kit specific mechanics (web-verified, not hands-on-tested in this session)
- Failure-injection mechanics: HIGH for the DI-seam framing (directly grounded in reading `send-dispatch.ts` and its existing tests) and MEDIUM for the SIGKILL/IPC pattern specifics (synthesized from verified primitives, not copied from a single authoritative source)
- Pitfalls: MEDIUM-HIGH — Pitfalls 1, 2, 4, 5 are grounded in either this repo's own files or verified official documentation (Postgres enum restriction); Pitfall 3 (drizzle-kit drift) and Pitfall 6 (BullMQ OOM-on-Lua-script) rest on GitHub issue threads rather than resolved official documentation, flagged accordingly

**Research date:** 2026-07-28
**Valid until:** ~30 days for the architectural/mechanics guidance (stable domain: GitHub Actions, Postgres transaction semantics, Redis persistence config do not change quickly); ~7 days for the exact package version numbers quoted (eslint/typescript-eslint/vitest ecosystem releases frequently — re-run `npm view` at plan/execute time rather than trusting the versions pinned in this document if more than a few days have passed)
