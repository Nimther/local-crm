---
phase: 16-live-sendgrid-verification
plan: 01
subsystem: testing
tags: [sendgrid, uat, tenant-context, rls, scripted-assert, tsx, docker]

# Dependency graph
requires:
  - phase: 14-deployment-database-durability
    provides: deployed production VPS, verified platform sender, docker/docker-compose.prod.yml topology, docker/Dockerfile.api build (patch-workspace-mains.mjs)
  - phase: 13-compliance-data-lifecycle
    provides: send_events dedup key (workspace_id, send_id, event_type, occurred_at), migration 0057
  - phase: 10-tenant-isolation-trust-boundaries
    provides: withTenant/withTenantTransaction (@mega-crm/tenant-context), fail-closed RLS
  - phase: 11-delivery-correctness
    provides: sends schema (provider_message_id, status, campaign_id, flow_run_id), EVENT_FLAGS webhook provisioning
provides:
  - scripts/uat-verify.mjs send-attribution scripted-assert instrument (exit 0/1/2 semantics), reused unmodified by 16-02/16-04/16-06's future subcommands
  - docs/runbooks/uat-live-sendgrid.md — the phase's single operator document (workspace setup, BYO key entry, webhook provisioning, campaign setup, UAT-01 procedure)
  - one live-verified end-to-end send (BYO key -> SendGrid -> real inbox -> Event Webhook -> send_events), proving the whole pipeline against the real account/deployment for the first time in this project's history
  - UAT-01 closed (live); the `delivered` leg of UAT-02 closed (live)
affects: [16-02-event-coverage, 16-03-webhook-raw-capture, 16-04-dedup, 16-05-fixture-capture, 16-06-uat05-state, 16-07-uat-report]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Scripted-assert UAT instrument (D-13): every UAT verdict in this phase is a query result with an exit code (0=pass/1=expectation-mismatch/2=usage-error), never an eyeball impression; observed-row count always printed to avoid a vacuous pass"
    - "Dynamic import() deferral for tsx-only workspace packages consumed from scripts/**: a plain-node-invoked script that needs a @mega-crm/* workspace package whose package.json 'main' points at TS source must defer that import to inside its DB-access function, never at module top level, so usage-error paths still work under bare `node`"
    - "One shared query module per bind-mount: a script invoked in production via a single bind-mounted file into a running container must keep all its subcommands (this plan's send-attribution; 16-02/16-04/16-06's future ones) in ONE file, not split into a second module the bind mount would also need to cover"

key-files:
  created:
    - scripts/uat-verify.mjs
    - scripts/__tests__/uat-verify.test.mjs
    - docs/runbooks/uat-live-sendgrid.md
    - .planning/phases/16-live-sendgrid-verification/deferred-items.md
  modified:
    - package.json (added `uat:verify` npm script, invoking `tsx` not `node` — see Deviations)

key-decisions:
  - "uat:verify runs via tsx, not plain node (plan text said node) — plain node cannot resolve @mega-crm/tenant-context's internal TS-source import chain; confirmed empirically, matches docker/patch-workspace-mains.mjs's own documented finding"
  - "Production invocation form is a bind-mounted one-shot `api` container (docker compose run), never the VPS host directly — scripts/ is not copied into the runtime image and the host has no network path to the `db` service (only `web` publishes ports, T-14-43); inside the image plain `node` DOES resolve tenant-context because patch-workspace-mains.mjs already compiled it to dist/"
  - "sends.provider_message_id (not sg_message_id, which does not exist in the schema) is the column send-attribution reads, aliased AS sg_message_id in the query's own output"

patterns-established:
  - "Pattern: scripts/** files that need a @mega-crm/* workspace package unresolvable by plain node keep the import behind a dynamic import() inside a non-exported function, never at module top level — mirrors how scripts/migrate-runner.mjs already isolates its own DATABASE_URL requirement from parseArgs-equivalent pure logic"

requirements-completed: [UAT-01]

coverage:
  - id: D1
    description: "scripts/uat-verify.mjs send-attribution — scripted assert reporting a send's status, sg_message_id, and every attributed send_events row, with 0/1/2 exit-code semantics and an anti-vacuous-pass observed-row count"
    requirement: "UAT-01"
    verification:
      - kind: unit
        ref: "scripts/__tests__/uat-verify.test.mjs (12 tests, parseArgs/assertExpectations/formatReport)"
        status: pass
      - kind: other
        ref: "node scripts/uat-verify.mjs (no args) exits 2; node scripts/uat-verify.mjs send-attribution --workspace X (no selector) exits 2"
        status: pass
    human_judgment: false
  - id: D2
    description: "docs/runbooks/uat-live-sendgrid.md — the phase's single operator document (scope/safety, prerequisites, workspace creation, BYO key entry, webhook provisioning, contact/campaign setup, verification-command invocation, UAT-01 procedure)"
    requirement: "UAT-01"
    verification:
      - kind: other
        ref: "npm run check:runbook-coverage"
        status: pass
      - kind: other
        ref: "npm run check:root-hygiene"
        status: pass
      - kind: other
        ref: "grep -nEi 'SG\\.[A-Za-z0-9_-]{10,}|BEGIN [A-Z ]*PRIVATE KEY' docs/runbooks/uat-live-sendgrid.md (no match)"
        status: pass
    human_judgment: false
  - id: D3
    description: "One live campaign send, dispatched with the UAT tenant's own BYO SendGrid key through the UAT Dynamic Template, arrived in the operator's real mailbox with both handlebars substitutions rendered; the real Event Webhook returned a delivered row attributed to the send via send-attribution, exit 0"
    requirement: "UAT-01"
    verification:
      - kind: manual_procedural
        ref: "checkpoint:human-verify approval, Task 3 — operator confirmed real-mailbox arrival, rendered substitutions, clickable link present (unclicked), and `send-attribution --expect-status sent --expect-events delivered` exit 0"
        status: pass
    human_judgment: true
    rationale: "Physical mailbox arrival and genuine (non-placeholder) template rendering can only be confirmed by a human looking at the real received message — no automated check in this repository can observe an inbox. Two of the plan's own must_haves are explicitly flagged 'verification: backstop' for exactly this reason."

duration: ~65min
completed: 2026-08-17
status: complete
---

# Phase 16 Plan 01: Live SendGrid Tracer (UAT-01) Summary

**Scripted-assert UAT instrument (`scripts/uat-verify.mjs send-attribution`) plus the operator runbook, proven end-to-end with one live BYO-key send through a real SendGrid Dynamic Template into a real inbox, with `delivered` attributed back onto the send row via the real Event Webhook.**

## Performance

- **Duration:** ~65 min (excluding the operator's own live-send wait time, which happened outside this executor's process)
- **Tasks:** 3 (Task 1 TDD RED+GREEN, Task 2, Task 3 blocking checkpoint)
- **Files created:** 4 (`scripts/uat-verify.mjs`, `scripts/__tests__/uat-verify.test.mjs`, `docs/runbooks/uat-live-sendgrid.md`, `.planning/phases/16-live-sendgrid-verification/deferred-items.md`)
- **Files modified:** 1 (`package.json`)

## Accomplishments

- Built the one scripted-assert instrument (`scripts/uat-verify.mjs send-attribution`) every later plan in this phase reuses — exit codes 0/1/2, an anti-vacuous-pass observed-row count printed on every run, and a shared query module shaped for 16-02/16-04/16-06's future subcommands without restructuring.
- Wrote the phase's single operator runbook (`docs/runbooks/uat-live-sendgrid.md`), including the one real invocation form for the verification command discovered by reading `docker/Dockerfile.api` and `docker/patch-workspace-mains.mjs` directly rather than assuming.
- Ran the phase's tracer slice for real: a live campaign send using a tenant's own BYO SendGrid API key, rendered from a genuine SendGrid Dynamic Template, arrived in the operator's real mailbox with both handlebars substitutions rendered and the clickable link present — and the real Event Webhook's `delivered` event was attributed back onto the correct send row via `send-attribution`.

## Live UAT-01 Evidence (checkpoint approved)

Recorded at checkpoint resolution (operator-provided; exact UTC send instant not separately captured):

- **UAT_WORKSPACE_ID:** `171285c6-a489-46be-9ee9-ba4ed6964356`
- **SEND_ID:** `d9ac9629-1fb3-5521-9d4b-bdf625d8b9ca`
- **SG_MESSAGE_ID:** `iU2gsMMHQKyB2hMP89dmEQ`
- **Timestamp:** approved 2026-08-17 (exact send timestamp not captured at approval)
- **Operator confirmation:** followed `docs/runbooks/uat-live-sendgrid.md` §2–8; campaign delivered to the real mailbox with both handlebars substitutions rendered; clickable link present and not clicked (reserved for plan 16-02's `clicked` leg); §7's `send-attribution --expect-status sent --expect-events delivered` invocation exited 0 with a `delivered` row attributed to the send.

This closes **UAT-01** and the `delivered` leg of **UAT-02** (the remaining UAT-02 legs — `opened`/`clicked`/`bounced` — are later plans' own scope, per the plan's objective).

## Task Commits

1. **Task 1 (RED):** `test(16-01): add failing test for uat-verify send-attribution helpers` - `cd4230b` (test)
2. **Task 1 (GREEN):** `feat(16-01): implement scripts/uat-verify.mjs send-attribution instrument` - `5ab24ba` (feat)
3. **Task 2:** `docs(16-01): add uat-live-sendgrid runbook (workspace, BYO key, template, webhook, UAT-01)` - `6b7b050` (docs)
4. **Task 3:** blocking `checkpoint:human-verify` — no code changes; approved by the operator with the evidence values recorded above (no separate commit; this is the live tracer verification itself, not a code change)

**Plan metadata:** this SUMMARY's own commit (see below)

_Note: Task 1 is `tdd="true"` — RED (`cd4230b`, tests fail against a nonexistent module) then GREEN (`5ab24ba`, 12/12 tests pass) — the mandatory TDD gate sequence for this plan._

## Files Created/Modified

- `scripts/uat-verify.mjs` - the scripted-assert `send-attribution` CLI: pure `parseArgs`/`assertExpectations`/`formatReport` helpers plus a non-exported, dynamically-imported DB-access path
- `scripts/__tests__/uat-verify.test.mjs` - 12 tests covering every `<behavior>` line against the exported pure helpers only (no database)
- `docs/runbooks/uat-live-sendgrid.md` - the phase's single operator document: scope/safety, prerequisites, workspace creation, BYO key entry, webhook provisioning, contact/campaign setup, the one verification-command invocation form, and the UAT-01 procedure
- `package.json` - added the `uat:verify` npm script (`tsx scripts/uat-verify.mjs`, not `node` — see Deviations)
- `.planning/phases/16-live-sendgrid-verification/deferred-items.md` - logs one pre-existing, out-of-scope repo-wide lint failure discovered while verifying this plan (not fixed here — see Deviations)

## Decisions Made

- `uat:verify` invokes `tsx`, not `node` (plan text said `node`) — see Deviations, Rule 3.
- The production invocation form documented in the runbook is a bind-mounted one-shot `api` container via `docker compose run`, never a direct VPS-host invocation — `scripts/` is absent from the runtime image and the host has no network path to `db` (only `web` publishes ports).
- `sends.provider_message_id` (not a nonexistent `sg_message_id` column) is what the query reads, aliased `AS sg_message_id` in its own result shape.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue, empirically confirmed] `node` cannot resolve `@mega-crm/tenant-context`'s internal TS import chain**
- **Found during:** Task 1, while implementing `runSendAttribution`'s database access.
- **Issue:** The plan's action text specified `node scripts/uat-verify.mjs` for the `uat:verify` npm script and implied a static top-level import of `withTenant` from `@mega-crm/tenant-context`. Empirically confirmed (by directly running a probe script under plain `node` from this repo's own sandbox) that `@mega-crm/tenant-context`'s `"main": "./src/index.ts"` — read as real TypeScript source, with sibling `./foo.js`-specifier relative imports that only resolve to `./foo.ts` under tsx/vitest's loader — throws `ERR_MODULE_NOT_FOUND` under plain `node`, several imports deep (through `@mega-crm/redaction`). This exactly matches the finding `docker/patch-workspace-mains.mjs`'s own header already documents for the same reason at Docker image-build time.
- **Fix:** (1) Deferred the `@mega-crm/tenant-context` import to a dynamic `import()` inside `runSendAttribution` only — never at module top level — so the plain-`node`-invoked usage-error acceptance criteria (no args; missing send selector) still work correctly, since they never reach that import. (2) Pointed the `uat:verify` npm script at `tsx scripts/uat-verify.mjs` instead of `node`. (3) Documented in the runbook that the real production invocation is a bind-mounted one-shot `api` container, where plain `node` *does* resolve `tenant-context` because the image's own build already compiled it to `dist/` and repointed its `package.json` (`docker/patch-workspace-mains.mjs`).
- **Files modified:** `scripts/uat-verify.mjs`, `package.json`, `docs/runbooks/uat-live-sendgrid.md`.
- **Verification:** `node scripts/uat-verify.mjs` (no args) exits 2; `node scripts/uat-verify.mjs send-attribution --workspace X` (no selector) exits 2; `DATABASE_URL=<fake> npx tsx scripts/uat-verify.mjs send-attribution --workspace ws-1 --send-id abc` reaches the real connection attempt (`ECONNREFUSED`), proving the full dynamic-import module-resolution chain works under `tsx`.
- **Committed in:** `5ab24ba` (Task 1 GREEN commit).

**2. [Rule 1 - Schema-accuracy bug] `sends.sg_message_id` does not exist — the real column is `provider_message_id`**
- **Found during:** Task 1, while writing the `send-attribution` SQL query.
- **Issue:** The plan's action text names the column the query should select as `sg_message_id`; `packages/db/src/schema/sends.ts` has no such column — the actual column is `provider_message_id`.
- **Fix:** The query selects `provider_message_id AS sg_message_id`, so every consumer of the CLI's output (including the runbook and this SUMMARY) can keep using the `sgMessageId`/`sg_message_id` name that matches this repo's own SendGrid terminology, without the query itself referencing a nonexistent column.
- **Files modified:** `scripts/uat-verify.mjs`.
- **Verification:** confirmed against `packages/db/src/schema/sends.ts` directly (read, not assumed) before writing the query.
- **Committed in:** `5ab24ba` (Task 1 GREEN commit).

**3. [Out of scope — logged, not fixed] Pre-existing repo-wide `npm run lint` failure, unrelated to this plan**
- **Found during:** Task 1 verification (`npm run lint`).
- **Issue:** `apps/worker/src/__tests__/correlation-tracer.test.ts:231:122` — `@typescript-eslint/require-await` (`Async arrow function 'sendMail' has no 'await' expression`). Introduced by Phase 15 commit `b22e045`, confirmed via `git status`/`git log` to carry zero local modifications from this plan.
- **Fix:** Not fixed — this file is outside 16-01's `files_modified` list and the SCOPE BOUNDARY rule forbids fixing pre-existing failures in unrelated files. Logged to `.planning/phases/16-live-sendgrid-verification/deferred-items.md` for a future wave/phase-level fix.
- **Files modified:** none (documentation only, in `deferred-items.md`).
- **Verification:** isolated `npx eslint scripts/uat-verify.mjs scripts/__tests__/uat-verify.test.mjs` exits 0 with zero errors/warnings — confirming this plan's own files are clean and the repo-wide failure is unrelated.
- **Committed in:** not committed as a fix; logged only.

---

**Total deviations:** 2 auto-fixed (1 blocking-issue, 1 schema-accuracy bug), 1 out-of-scope item logged (not fixed).
**Impact on plan:** Both auto-fixes were necessary for correctness (the script would otherwise never run against a real database, or would query a nonexistent column) and directly caused by writing this plan's own files — no scope creep. The out-of-scope lint failure does not affect this plan's own deliverables, verified in isolation.

## Issues Encountered

- `npm run lint` (repo-wide) exits non-zero due to the pre-existing, out-of-scope `correlation-tracer.test.ts` failure above — not a regression introduced by this plan. See Deviations item 3.
- `npm test` (full aggregate) reports failures **only** in the pre-known, project-documented `apps/api`/`apps/worker` `sentry.test.ts` "no DSN configured" tests (this development machine's `~/.config/mega-crm/.env` carries real Sentry DSNs since a prior UAT session — these pass in CI). Confirmed as the *sole* failing test in each workspace: `apps/api` 533/534 passed, `apps/worker` 641/642 passed; every `packages/*` workspace (11 workspaces, including the new `scripts/` lane) passed 100%. Treated as a passing run per this project's own documented exception.

## User Setup Required

None beyond what the operator already performed live during Task 3's checkpoint (second SendGrid API key, UAT Dynamic Template, UAT workspace, BYO key entry, webhook provisioning) — all captured in `docs/runbooks/uat-live-sendgrid.md` and the evidence values recorded above.

## Next Phase Readiness

- `scripts/uat-verify.mjs`'s dispatch table and shared query module are shaped for 16-02 (`event-coverage`), 16-04 (`dedup`), and 16-06 (`uat05-state`) to add sibling subcommands without restructuring.
- The UAT workspace (`171285c6-a489-46be-9ee9-ba4ed6964356`) is retained as a standing canary per D-15 and is the value later plans set `WEBHOOK_RAW_CAPTURE_WORKSPACE_ID` to.
- `docs/runbooks/uat-live-sendgrid.md` is the single document later plans append their own sections to — no second UAT runbook should be created.
- No blockers. UAT-01 is live-closed; the `delivered` leg of UAT-02 is live-closed; `opened`/`clicked`/`bounced` remain open for later plans in this phase.

## Self-Check: PASSED

- `scripts/uat-verify.mjs` — FOUND
- `scripts/__tests__/uat-verify.test.mjs` — FOUND
- `docs/runbooks/uat-live-sendgrid.md` — FOUND
- `.planning/phases/16-live-sendgrid-verification/deferred-items.md` — FOUND
- Commit `cd4230b` — FOUND in `git log --oneline --all`
- Commit `5ab24ba` — FOUND in `git log --oneline --all`
- Commit `6b7b050` — FOUND in `git log --oneline --all`

---
*Phase: 16-live-sendgrid-verification*
*Completed: 2026-08-17*
