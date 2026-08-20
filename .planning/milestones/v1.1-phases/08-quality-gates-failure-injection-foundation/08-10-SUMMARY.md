---
phase: 08-quality-gates-failure-injection-foundation
plan: 10
subsystem: testing
tags: [playwright, e2e, rls, ephemeral-database, tenant-isolation, vite, fastify]

requires:
  - phase: 08-06
    provides: the consolidated db-fixture and the ephemeral-database provisioning this reuses verbatim
provides:
  - apps/web/e2e/global-setup.ts and global-teardown.ts — Playwright's ephemeral database, via the vitest code path
  - dev:e2e scripts in apps/api and apps/web, deliberately without --env-file
  - reuseExistingServer false on both webServer entries
  - The [e2e:database] marker line CI can assert on
affects: [08-18]

tech-stack:
  added: ["@mega-crm/test-support@0.1.0 linked into apps/web"]
  patterns:
    - "Playwright and vitest share one provisioning implementation; the Playwright half is a caller, never a copy"
    - "A test lane announces the connection string it used, so the claim is checkable rather than configured"

key-files:
  created:
    - apps/web/e2e/global-setup.ts
    - apps/web/e2e/global-teardown.ts
  modified:
    - apps/web/playwright.config.ts
    - apps/web/e2e/register-create-workspace.spec.ts
    - apps/api/package.json
    - apps/web/package.json
    - package.json
    - SPECIFICATION.md

key-decisions:
  - "DATABASE_URL is deliberately NOT listed in webServer.env — it is inherited from the process environment, where globalSetup put it. Naming it in the config would freeze the config-load-time value, which is before globalSetup runs"
  - "playwright.config.ts loads .env into the Playwright process (not the servers): TEST_ADMIN_DATABASE_URL is needed to provision at all, and DATABASE_URL is what the guard compares against — with nothing to compare to, that half of the check would pass vacuously"
  - "globalTeardown is a second file, not a returned function: Playwright's globalSetup and globalTeardown are independent module paths. State travels through a temp file rather than shared module scope"
  - "The failing spec's assertion moved to an owner-exclusive affordance rather than being deleted or the product changed"

patterns-established:
  - "E2E specs may assume a completely empty database; nothing seeded by a developer is available to them"

requirements-completed: [QG-04]

coverage:
  - id: D1
    description: "The Playwright E2E lane provisions and drops its own ephemeral database through the same functions the vitest suites use"
    requirement: QG-04
    verification:
      - kind: e2e
        ref: "npm run test:e2e -w apps/web — 7 passed, exit 0; marker line names mega_crm_test_e2e_037d7627"
        status: pass
      - kind: manual_procedural
        ref: "SELECT count(*) FROM pg_database WHERE datname LIKE 'mega_crm_test_e2e%' — 0 after the run"
        status: pass
    human_judgment: false
  - id: D2
    description: "An already-running dev stack cannot be reused — the run refuses rather than attaching"
    requirement: QG-04
    verification:
      - kind: e2e
        ref: "run attempted with the dev API listening on :4000 — Playwright aborted with 'http://localhost:4000/api/auth/ok is already used', before globalSetup, provisioning nothing"
        status: pass
    human_judgment: false
  - id: D3
    description: "The E2E servers receive no developer configuration — dev:e2e carries no --env-file and the plain dev scripts are untouched"
    requirement: QG-04
    verification:
      - kind: manual_procedural
        ref: "apps/api dev:e2e is `tsx watch src/server.ts`; grep -c env-file apps/api/package.json returns 1 (the untouched dev script)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The run announces which connection string it used, with the password redacted"
    requirement: QG-04
    verification:
      - kind: e2e
        ref: "stdout line: [e2e:database] postgres://mega_crm_app:***@localhost:5432/mega_crm_test_e2e_037d7627"
        status: pass
    human_judgment: false
  - id: D5
    description: "No guard, naming or provisioning logic is reimplemented on the Playwright side"
    requirement: QG-04
    verification:
      - kind: manual_procedural
        ref: "grep -cE 'mega_crm_test|normalizeDsn|LOOPBACK' apps/web/e2e/global-setup.ts — 0"
        status: pass
    human_judgment: false
  - id: D6
    description: "An E2E run started without a provisioned database aborts instead of reaching dev"
    verification: []
    human_judgment: true
    rationale: "Established by construction — dev:e2e has no --env-file and DATABASE_URL is not in webServer.env, so the API has no DSN unless globalSetup ran, and its Zod boot schema refuses to start without one. Not exercised as a negative test, because bypassing globalSetup means editing the config that is the artifact under test."

duration: 38 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 10: E2E Database Isolation Summary

**The Playwright lane provisions its own ephemeral database through the vitest code path, refuses to attach to a running dev stack, and prints which connection string it actually used — closing the largest remaining hole in QG-04.**

## Performance

- **Duration:** 38 min
- **Started:** 2026-07-28T09:35:00Z
- **Completed:** 2026-07-28T10:13:00Z
- **Tasks:** 3
- **Files modified:** 7 (2 created, 5 modified)

## Accomplishments

- **Every E2E spec used to write to the dev database.** `playwright.config.ts` booted `npm run dev -w apps/api`, whose `--env-file=../../.env` points there by definition, with `reuseExistingServer: true` so an already-running dev stack was attached to regardless. The config's own doc comment stated this outright.
- **`apps/web/e2e/global-setup.ts`** provisions through `@mega-crm/test-support` — `createEphemeralDatabase` → `assertTestDatabaseUrl` → `ensureTestDbMigrated`, the exact functions the vitest hook calls. No naming rule, DSN comparison or provisioning logic is written a second time.
- **`dev:e2e` scripts carry no `--env-file`.** The API's whole environment is the block enumerated from its own Zod boot schema plus the DSN `globalSetup` assigned. A run without provisioning has no DSN at all and refuses to boot.
- **`reuseExistingServer: false` on both entries**, verified against a real running dev stack.
- **The run announces its database.** `[e2e:database] postgres://mega_crm_app:***@localhost:5432/mega_crm_test_e2e_037d7627` — password redacted, marker stable and greppable. SPEC's QG-04 criterion is that CI can assert *which* database was touched; a config value nobody reads back is not evidence.

**Result: 7 passed, exit 0, no database left behind.**

### The anti-reuse property, demonstrated

Run attempted with the developer's dev API listening on `:4000`:

```
Error: http://localhost:4000/api/auth/ok is already used, make sure that nothing
is running on the port/url or set reuseExistingServer:true in config.webServer.
```

Playwright aborts **before `globalSetup`**, so nothing is provisioned and nothing leaks. This is T-08-10-02 mitigated in a stronger form than the plan anticipated — see Deviations.

### What isolating the lane immediately found

`register-create-workspace.spec.ts` asserted the role was visible at `/w/:slug`. It has been **failing since 14 July** and nobody knew.

Commit `aa1c09f` (07-07) swapped the workspace index route:

```diff
-            <Route index element={<WorkspaceHome />} />
+            <Route index element={<WorkspaceDashboard />} />
```

`WorkspaceHome` was the only component rendering `owner: "Владелец"` on that page; it is now imported nowhere and is dead code. The spec has not been touched since 01-02. It went unnoticed precisely because this lane is not in CI and running it locally attached to a dev stack.

Relocating the assertion to `/team` did not work either, and that is the more interesting half: **the app displays a solo owner's role nowhere at all.** `MemberRow` renders "Владелец", but `TeamPage` suppresses the entire table behind `members.length <= 1 && invites.length === 0`, so a freshly-registered owner sees an empty state instead of their own row.

The assertion therefore moved to an **owner-exclusive affordance** — the delete-workspace control, rendered under `viewerRole === "owner"` in `TeamPage.tsx:196`, the same value the original assertion was about. Intent preserved, no product change made, and the missing role display recorded rather than papered over.

## Task Commits

All three tasks landed in one commit, `a3aa6dc`, because Task 2 cannot be verified without Task 1 and the run that verifies both is the same run: the config change and the setup module are meaningless apart.

## Files Created/Modified

- `apps/web/e2e/global-setup.ts` — provision, guard, migrate, assign, announce
- `apps/web/e2e/global-teardown.ts` — drop, via state passed in a temp file
- `apps/web/playwright.config.ts` — `globalSetup`/`globalTeardown`, `dev:e2e`, `reuseExistingServer: false`, the enumerated `env` block, and a doc comment that no longer asserts the opposite of the truth
- `apps/web/e2e/register-create-workspace.spec.ts` — the relocated assertion
- `apps/api/package.json`, `apps/web/package.json` — `dev:e2e`; `dev` untouched
- `package.json` — root `test:e2e`
- `SPECIFICATION.md` — §3.1 (the lane's config-loading and lifecycle), §2.4 (`@mega-crm/test-support`, plus the `vitest` declaration 08-07 added and did not record)

## Decisions Made

- **`DATABASE_URL` is not in `webServer.env`.** The config object is built at load time, before `globalSetup` runs; naming it there would freeze a stale value. It is inherited from `process.env`, which `globalSetup` mutates — and Playwright starts the servers after `globalSetup` returns, verified empirically by the marker line matching the database the specs actually used.
- **The config loads `.env` into the Playwright process.** Two things need it: `TEST_ADMIN_DATABASE_URL`, without which nothing can be provisioned, and `DATABASE_URL`, which is what the guard compares the new DSN *against*. Without the latter that half of the check would pass vacuously. Neither reaches the servers.
- **Two files for setup and teardown**, with state in a temp file. Playwright's hooks are independent module paths; a shared module-level variable would be an assumption about its loader, and a file is not.

## Deviations from Plan

### 1. [Rule 2 — Missing Critical] `global-teardown.ts` is a second file

The plan's `files_modified` names only `global-setup.ts`, and its action says to "export a paired teardown ... and register it as Playwright's `globalTeardown`". Playwright 1.61's `globalTeardown` takes a *path*, not an export from the setup module (`globalSetup?: string | Array<string>`), so a second file is required by the API. Both acceptance greps still pass.

### 2. [Rule 4 — Architectural, user-approved] Acceptance criterion 9 is unsatisfiable as written

The criterion expects that, with a dev stack already listening, the E2E run "still provisions and uses its own database". Two processes cannot listen on one port, so with `reuseExistingServer: false` the run cannot start its own server on 4000 — it **refuses outright**. That is what the threat model actually asks for (T-08-10-02 is *silent attachment*), and it fails loudly, early, and without provisioning anything. Recorded rather than worked around; the criterion's intent is met in the stronger form.

The dev stack was stopped by the user before the green run, on request. Their processes were not touched.

### 3. [Rule 4 — Architectural, user-approved] The failing spec's assertion was relocated twice

Described above. The user chose relocation over leaving the lane red or restoring the role display. The first relocation (`/team`, role text) failed for a second reason — the solo-owner empty state — and the assertion landed on the owner-exclusive control instead. Restoring a role display is a product decision and was explicitly left to the user.

### 4. [Rule 1 — Environment] `docker compose up -d --wait` in the `<verify>` blocks

As in 08-08 and 08-09: native services on the same ports and DSNs.

---

**Total deviations:** 2 architectural (both surfaced to the user and decided by them), 1 missing-critical, 1 environmental.
**Impact on plan:** No scope reduction. One file beyond `files_modified` (`global-teardown.ts`, required by Playwright's API) and one spec file (the relocated assertion, required to satisfy the plan's own green-run criterion).

## Issues Encountered

- **A solo owner cannot see their own role anywhere in the application.** `WorkspaceHome` showed it until 07-07 replaced the route; `TeamPage` hides the member table when you are alone. This is a genuine UI gap, not a test problem, and it is left for a product decision — the E2E spec now proves Owner-ness through capability rather than through a label that does not exist.
- **`apps/web/src/features/workspace-home/WorkspaceHome.tsx` is dead code** — imported nowhere since `aa1c09f`. Not deleted here; deleting a component is outside this plan and belongs with whatever decides the point above.

## User Setup Required

The E2E lane needs ports 4000 and 5173 free — by design, since it starts its own servers and will not reuse yours. `npm run dev` is unaffected.

## Next Phase Readiness

- **08-18** can add the non-blocking `e2e` job and assert on the `[e2e:database]` line. The marker is stable and the redaction makes it safe to print into a public log.
- **QG-04 is not yet marked complete** — 08-15 also declares it, and the shared-ID gate holds it open until every declaring plan has a SUMMARY.
- **E2E specs may now assume an empty database.** Anything a spec needs, it must create. That is a real change in what specs may rely on, and worth knowing before writing the next one.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
