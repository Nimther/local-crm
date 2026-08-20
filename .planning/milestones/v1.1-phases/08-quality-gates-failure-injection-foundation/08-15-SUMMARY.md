---
phase: 08-quality-gates-failure-injection-foundation
plan: 15
subsystem: infra
tags: [secrets, configuration, env, hygiene, xdg, module-order]

requires:
  - phase: 08-06
    provides: the consolidated fixture whose vitest configs are among the load points redirected here
provides:
  - resolveEnvPath() — the one decision about where configuration lives
  - MEGA_CRM_ENV_FILE override
  - apps/api/src/load-env.ts and apps/worker/src/load-env.ts
  - scripts/check-root-hygiene.mjs and npm run check:root-hygiene
affects: [08-18]

tech-stack:
  added: []
  patterns:
    - "A path used from more than one place is resolved by a function, not repeated as a literal"
    - "A side-effect module imported first is how you get configuration loaded before a module-scope validator evaluates"
    - "A hygiene check takes entry NAMES, so its cases are assertions rather than filesystem mutations"

key-files:
  created:
    - scripts/env-path.mjs
    - scripts/env-path.d.mts
    - scripts/check-root-hygiene.mjs
    - scripts/check-root-hygiene.d.mts
    - apps/api/src/load-env.ts
    - apps/worker/src/load-env.ts
    - packages/test-support/src/__tests__/root-hygiene.test.ts
  modified:
    - scripts/check-env.mjs
    - scripts/migrate-dev.mjs
    - apps/api/src/server.ts
    - apps/worker/src/server.ts
    - apps/api/package.json
    - apps/worker/package.json
    - apps/api/vitest.config.ts
    - apps/worker/vitest.config.ts
    - apps/web/playwright.config.ts
    - packages/db/vitest.config.ts
    - packages/delivery-core/vitest.config.ts
    - packages/test-support/vitest.config.ts
    - package.json
    - SPECIFICATION.md

key-decisions:
  - "All NINE load points were redirected, not the six the plan enumerated — 08-07, 08-09 and 08-10 each added one after the plan was written, and leaving them would have made the single-decision claim false on the day it was made"
  - "./load-env.js is the FIRST import in both server.ts files; anywhere later and the zod schema has already read an empty environment"
  - "The hygiene scan is non-recursive and name-based; content scanning is a different class of check and stays Phase 13"
  - "checkRootHygiene takes entry names, not a path — the executor is tool-denied on the real configuration file and could not create one to test against"

patterns-established:
  - "New load points must call resolveEnvPath(); a literal path to the working root is now a regression"

requirements-completed: [QG-07]

coverage:
  - id: D1
    description: "The configuration location is decided in one function, honouring MEGA_CRM_ENV_FILE and defaulting outside the repository"
    requirement: QG-07
    verification:
      - kind: integration
        ref: "resolveEnvPath() returns ~/.config/mega-crm/.env; MEGA_CRM_ENV_FILE=/tmp/custom-config overrides it exactly"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every load point calls the resolver; no hardcoded path to the working root survives"
    requirement: QG-07
    verification:
      - kind: manual_procedural
        ref: "11 files reference resolveEnvPath (9 load points, the resolver, and check-env); grep for the old literals returns nothing"
        status: pass
    human_judgment: false
  - id: D3
    description: "Neither dev script passes --env-file; both entrypoints load in code early enough for the boot-time schema"
    requirement: QG-07
    verification:
      - kind: manual_procedural
        ref: "grep -c env-file returns 0 for both manifests; ./load-env.js is line 1 of each server.ts, ./env.js line 11 in apps/api"
        status: pass
      - kind: e2e
        ref: "operator confirmed npm run dev boots api, web and worker from the new location with the working root clean"
        status: pass
    human_judgment: false
  - id: D4
    description: "npm run dev and the full test lane work with no configuration file in the working root"
    requirement: QG-07
    verification:
      - kind: integration
        ref: "npm run test --workspaces --if-present — exit 0, nine workspaces, 635 tests, working root clean"
        status: pass
    human_judgment: false
  - id: D5
    description: "The hygiene check fails on a tree where the blacklisted files are back, and is proven fail-first"
    requirement: QG-07
    verification:
      - kind: unit
        ref: "packages/test-support/src/__tests__/root-hygiene.test.ts — 9 cases"
        status: pass
      - kind: integration
        ref: "fixture directory with .env + dump.rdb → exit 1 naming both; clean fixture → exit 0; real root with .env.backup → exit 1 naming it, exit 0 after removal"
        status: pass
    human_judgment: false
  - id: D6
    description: "The secrets file is out of the working root"
    requirement: QG-07
    verification:
      - kind: manual_procedural
        ref: "ls -a shows only .env.example; ~/.config/mega-crm/.env exists (871 bytes); check:root-hygiene reports 26 entries, none blacklisted"
        status: pass
    human_judgment: true
    rationale: "The move itself was the operator's — the agent is tool-denied on the file and verified the outcome by directory listing and by the check, never by reading it."

duration: 51 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 15: Configuration Path and Root Hygiene Summary

**Nine hardcoded paths to a secrets file in the working root became one function call outside it, the file moved, and a check that has been observed failing now stands guard over where it used to sit.**

## Performance

- **Duration:** 51 min (including the operator checkpoint)
- **Started:** 2026-07-28T12:28:00Z
- **Completed:** 2026-07-28T13:19:00Z
- **Tasks:** 4 (3 agent, 1 operator)
- **Files modified:** 21 (7 created, 14 modified)

## Accomplishments

- **`resolveEnvPath()` is the only decision.** `MEGA_CRM_ENV_FILE` when set, otherwise `$XDG_CONFIG_HOME/mega-crm/.env`, otherwise `~/.config/mega-crm/.env` — outside the repository either way. Being gitignored never made the file safe: an ignored file still sits on disk and is still readable by every tool, script, editor extension and agent working in this checkout.
- **Nine load points, not six.** The plan enumerated six; 08-07, 08-09 and 08-10 each added one after it was written (`packages/test-support`, `packages/db`, `apps/web/playwright.config.ts`). All nine now call the resolver. Redirecting six and leaving three would have made the single-decision claim false on the day it was made.
- **Both dev entrypoints load in code.** `--env-file` is gone from the `dev` scripts, and `./load-env.js` is the **first** import in each `server.ts`. That ordering is the whole mechanism: ES module evaluation follows import order, and `apps/api/src/env.ts` parses its zod schema at module evaluation. A load placed after that import reads an empty environment and the process dies with a validation error that looks like missing configuration rather than a load-ordering bug. `start` is untouched.
- **The blacklist check is proven in both directions**, not merely observed passing.
- **The file is out.** Working root now shows only `.env.example`; `check:root-hygiene` reports 26 entries, none blacklisted.

### Verified: this does not undo 08-10's E2E isolation

`load-env.ts` runs on **every** server start, including `dev:e2e`. That would have quietly re-introduced the developer's configuration into the E2E lane if `process.loadEnvFile` overrode already-set variables. It does not — probed directly rather than assumed:

```
FROM_FILE (only in file): file-value
BOTH (set in env first)  : environment-value
=> existing environment WINS
```

So `webServer.env` and the inherited `DATABASE_URL` still win. Recorded in SPECIFICATION.md §3.1, because the next person to add a load point needs to know this is load-bearing.

### The hygiene check, both transcripts

Fixture directory containing `.env` and `dump.rdb`:

```
check:root-hygiene FAILED: 2 blacklisted entries in /var/folders/.../tmp.OAfUoM2cK5:
  - .env  (configuration file — holds real platform secrets)
  - dump.rdb  (Redis snapshot — may contain queue payloads)
```

Clean fixture directory:

```
check:root-hygiene — 3 entries in /var/folders/.../tmp.opNJXKR828, none blacklisted. OK
```

And against the real tree after the move — `exit 0`; with a `.env.backup` present — `exit 1` naming it; after removing it — `exit 0` again.

Each blacklist entry carries its reason in the source, because a blacklist without reasons becomes a list nobody dares change.

## Task Commits

- **Tasks 1–3** — `c6120c2` (feat)
- **Task 4** — operator checkpoint, no commit; verified by directory listing and by the check.

## Decisions Made

- **`checkRootHygiene` takes entry names, not a path.** That is what makes the nine cases plain assertions instead of filesystem mutations — and it is not a stylistic preference: the executor is tool-denied on the real configuration file, so a test that had to create one could not have been written.
- **Non-recursive, by decision.** A recursive walk would flag `tools/lint-fixtures` and `tools/migration-fixtures` immediately, and the exclusion list needed to quiet it would grow until the check meant nothing. The working root is the specific place a secrets file must not sit.
- **`check-env.mjs` keeps its `argv[2]` override.** That argument is how a developer checks an arbitrary file; removing it would have broken an existing workflow for no gain. Its failure message now names the new location — leaving it pointing at the working root would have instructed the next developer to undo this plan.

## Deviations from Plan

### 1. [Rule 2 — Missing Critical] Three load points the plan did not know about

The plan's D-28 enumerates six. Three more existed by the time it ran, added by later plans in this same phase. All were redirected. Recorded rather than silently expanded, because the number six appears in the decision record and will not match the code.

### 2. [Rule 1 — Bug, in own work] Six orphaned `path` imports and one orphaned `resolve`

Replacing `path.resolve(import.meta.dirname, "../../.env")` with `resolveEnvPath()` left `import path from "node:path"` unused in all six config files, and `resolve` unused in `migrate-dev.mjs`. Caught by lint, removed. The stale comments describing "the repo-root .env" were corrected in the same pass — a comment that describes the old behaviour is worse than no comment.

### 3. [Rule 3 — Blocker, operator-resolved] `.env.example` is outside the agent's write access

Task 2 asked for a header block in `.env.example` naming the new location. That file is covered by the same tool-deny as the configuration file itself. Handed to the operator with the exact text as part of the checkpoint; confirmed applied (the file grew from 797 to 1784 bytes).

---

**Total deviations:** 1 missing-critical, 1 auto-fixed, 1 handed to the operator.
**Impact on plan:** No scope reduction. Five files beyond `files_modified` — three additional load points and two `.d.mts` declarations the repo's own typecheck requires.

## Issues Encountered

- **The test lane was broken between Task 2 and the checkpoint**, exactly as designed: `TEST_ADMIN_DATABASE_URL` lives in the configuration file, and once the readers pointed at a location that did not exist yet, the DB-touching suites failed with `role "postgres" does not exist`. Recorded here so the state is legible in the history rather than looking like a regression that was later fixed by accident.
- **`apps/api`'s `dev` and `dev:e2e` scripts are now byte-identical** (`tsx watch src/server.ts`). 08-10 created `dev:e2e` as "dev without `--env-file`", and this plan removed the flag from `dev` too. They are kept separate because `playwright.config.ts` names `dev:e2e` and the distinction is documented, but a future reader will reasonably ask why two names run the same command.

## User Setup Required

Done during this plan. For any other machine or a fresh clone:

```
mkdir -p ~/.config/mega-crm
cp .env.example ~/.config/mega-crm/.env   # then fill in real values
```

`MEGA_CRM_ENV_FILE` overrides the location entirely. In CI no file exists and every variable is exported directly — the load is wrapped in a try/catch precisely so that is a normal path, not an error.

## Next Phase Readiness

- **08-18** should add `check:root-hygiene` to the static job. It is fast, needs no services, and its failure message is self-explanatory.
- **QG-07 is complete.** The location is one function call, both `npm run dev` and the full test lane work with the working root clean, and the check that guards it has been observed failing.
- **A note for whoever adds the next load point:** a literal path to the working root is now a regression. There are eleven references to `resolveEnvPath` in the tree and no remaining literal.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
