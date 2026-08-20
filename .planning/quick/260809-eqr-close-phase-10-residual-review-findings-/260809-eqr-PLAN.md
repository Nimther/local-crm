---
phase: quick-260809-eqr
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/api/src/modules/contacts/csv-import.routes.ts
  - apps/api/src/modules/contacts/__tests__/csv-import.test.ts
  - scripts/__tests__/ensure-db-roles-env.test.mjs
  - .planning/STATE.md
autonomous: true
requirements: [QUICK-260809-EQR]

must_haves:
  truths:
    - "GET /api/workspaces/:slug/imports/:id/errors returns 400 for an :id that is not a canonical UUID, and sends no Content-Disposition header on that path"
    - "A :id containing a double-quote character cannot inject a second filename parameter into Content-Disposition, because the request is rejected before the header is built"
    - "The error-report happy path is unchanged: a valid UUID still returns 200, text/csv, and a filename of import-<id>-errors.csv"
    - "ensure-db-roles-env.test.mjs contains a case where the SAME key TEST_ADMIN_DATABASE_URL is set in the child process env AND in the loaded env file with a different value, and asserts the exported value's port wins"
    - ".planning/STATE.md names Phase 11 Delivery Correctness as the current phase everywhere, with no line still presenting Phase 10 as the current focus or resume point"
    - "npm run lint, npm run build --workspaces --if-present, npm test, and npm run coverage all complete, with their outcomes recorded in the SUMMARY"
  artifacts:
    - "apps/api/src/modules/contacts/csv-import.routes.ts (UUID guard on the error-report route)"
    - "apps/api/src/modules/contacts/__tests__/csv-import.test.ts (WR-06 regression tests: invalid UUID + double-quote injection attempt)"
    - "scripts/__tests__/ensure-db-roles-env.test.mjs (same-key env-vs-file precedence case)"
    - ".planning/STATE.md (synced to Phase 11)"
  key_links:
    - "The UUID guard must sit between resolveWorkspaceMember's success and the reply.header('Content-Disposition', ...) call -- the header value is the sink being protected"
    - "scripts/vitest.config.ts registers the scripts/ test lane in the root aggregate -> the new same-key case only runs because that lane exists"
    - "coverage-baseline.json is a ratchet: npm run coverage:gate compares against it and coverage:ratchet forbids lowering it in the same commit that breaks it"
---

<objective>
Close the two residual Warning findings from the Phase 10 review (`10-REVIEW.md`) and sync
`.planning/STATE.md` to the real project position.

Purpose: WR-06 is a live missing-input-validation gap — an unvalidated route param reaches a
`Content-Disposition` header value, where a literal `"` (which Node's header validator permits)
lets a caller append a second `filename` parameter to the response header. WR-07 is a test that
proves less than its title claims: it never exercises the same-key env-file precedence case it
is named for, so a Node behavior change in that area would pass silently. STATE.md still points
at Phase 10 as the current focus even though Phase 10 is complete.

Output: a validated `:id` on the CSV error-report route with two regression tests, a corrected
`ensure-db-roles-env.test.mjs` with a real same-key precedence case, a synced STATE.md, and a
full gate run (lint, typecheck, tests, aggregate coverage).
</objective>

<execution_context>
@/Users/primeropanther/.claude/gsd-core/workflows/execute-plan.md
@/Users/primeropanther/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/phases/10-tenant-isolation-trust-boundaries/10-REVIEW.md
@apps/api/src/modules/contacts/csv-import.routes.ts
@apps/api/src/modules/contacts/__tests__/csv-import.test.ts
@scripts/__tests__/ensure-db-roles-env.test.mjs

Verified at plan time (2026-08-09):

- The two findings are `10-REVIEW.md` lines 179-208 (WR-06) and 210-228 (WR-07). Read both
  verbatim before editing; the review states the sink and the exact attack shape.
- `csv-import.routes.ts` does NOT currently import `zod`. The nearest in-repo precedent for a
  UUID-shaped route/query param is `apps/api/src/modules/send-log/send-log.routes.ts:18-19`
  (`z.string().uuid()`); `apps/api/src/modules/delivery/unsubscribe.routes.ts` has a hand-rolled
  `isUuid` regex for a different reason (it guards a signed-token field, not a header sink).
  `zod@4.4.3` is already a direct dependency of `apps/api` — this adds no dependency.
- The error-report route today returns **200 with an empty CSV** for a well-formed but unknown
  import id (`getErrorRows` returns `[]`). That is pre-existing behavior and MUST NOT change —
  the only new rejection is on malformed-`:id` shape.
- `apps/api/src/__tests__/anti-enumeration-sweep.test.ts` exercises `/imports/:id` (the status
  route) with real UUIDs, not `/imports/:id/errors`, so a 400-on-malformed-shape on the errors
  route does not touch the SEC-10/SEC-15 byte-identical-404 invariant.
- `scripts/ensure-db-roles.mjs:36` calls `process.loadEnvFile(resolveEnvPath())` and
  `:43-44` resolves `GSD_ADMIN_DATABASE_URL || TEST_ADMIN_DATABASE_URL || DEFAULT_ADMIN_DSN`.
  Ports 59999 and 59998 are already taken by Tests 1-3; the new case uses 59997/59996.
- CI's four gates are, verbatim from `.github/workflows/ci.yml`:
  `npm run build --workspaces --if-present` (typecheck), `npm run lint`, `npm run coverage`,
  `npm run coverage:gate`, `npm run coverage:ratchet`.
- **No `SPECIFICATION.md` update is required by the CLAUDE.md maintenance rule**: this change
  adds no library, env var, secret, table, migration, RLS policy, queue, worker, route, Fastify
  plugin, body parser, auth mechanism, or rate limit. Do not edit it.

No tracer task: the architecture here already exists and is proven in production code. Each task
is a single-layer correction to an existing, already-wired path, so a thin end-to-end slice would
carry no new information.
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: WR-06 — validate :id as a UUID before it reaches the Content-Disposition header</name>
  <files>apps/api/src/modules/contacts/csv-import.routes.ts, apps/api/src/modules/contacts/__tests__/csv-import.test.ts</files>
  <precondition>Postgres and Redis are up for the apps/api test lane (`docker compose up -d --wait`), and `MEGA_CRM_ENV_FILE` resolves to the externally-located env file.</precondition>
  <behavior>
    Write these three assertions in `csv-import.test.ts` FIRST, inside the existing
    `describe("CSV contact import (CONT-02, D-15..D-20)")` block (it already provides the
    `owner()` / `uploadCsv()` fixtures), and confirm the first two FAIL before touching the route:

    - Test A (invalid UUID): an authenticated workspace owner requests
      `GET /api/workspaces/{slug}/imports/not-a-uuid/errors` -> status is 400, the JSON body
      carries an `error` field, and the response has NO `content-disposition` header at all.
    - Test B (double-quote injection): the same owner requests the errors route with an `:id`
      segment built as `encodeURIComponent('x"; filename="evil.html')` -> status is 400 and the
      response has NO `content-disposition` header, so no second `filename` parameter is ever
      emitted. Assert on the header's absence, not on its contents.
    - Test C (happy-path regression guard): extend the EXISTING D-18 test
      ("the error-report route returns a downloadable CSV of only the errored rows") with one
      added assertion — the `content-disposition` header equals
      `attachment; filename="import-{importId}-errors.csv"` for the real, valid import id.
      Do not change any of that test's existing assertions.
  </behavior>
  <action>
    Implement the guard in the `GET /api/workspaces/:slug/imports/:id/errors` handler in
    `csv-import.routes.ts` (currently the last route in the file).

    Add `import { z } from "zod";` to the imports, matching the `z.string().uuid()` precedent in
    `send-log.routes.ts`.

    Placement is load-bearing: run the guard AFTER `resolveWorkspaceMember` has returned a
    resolved member and BEFORE `getErrorRows` is called. Placing it after the membership check
    keeps the response an unauthenticated or non-member caller sees byte-identical to today's
    (the Phase 10 SEC-10/SEC-15 anti-enumeration invariant); placing it before `getErrorRows`
    keeps the raw param away from both the query and the header.

    Parse `id` with `z.string().uuid().safeParse(id)`. On failure, return
    `reply.code(400).send({ error: "Invalid import id" })`. On success, use the PARSED value
    (`parsed.data`) — not the raw route param — when interpolating the filename into the
    `Content-Disposition` header, so the header can never be built from an unvalidated string.

    Change nothing else on this route: the `Content-Type: text/csv` header, the `csvEscape`
    (WR-04) treatment of cell values, the header-column derivation, and the existing
    200-with-empty-CSV response for a well-formed but unknown import id all stay exactly as they
    are. Do not add a UUID guard to any other route in this file — WR-06 is scoped to this sink,
    and the constraint for this task is no production behavior change outside it.
  </action>
  <verify>
    <automated>npx vitest run --root apps/api src/modules/contacts/__tests__/csv-import.test.ts</automated>
  </verify>
  <done>Tests A, B, and C pass; every previously-existing test in `csv-import.test.ts` still passes; `git diff apps/api/src` touches only the errors route handler and the zod import.</done>
  <reversibility rating="reversible">A four-line input guard on one route handler; revert is a single-file `git revert`.</reversibility>
</task>

<task type="auto" tdd="true">
  <name>Task 2: WR-07 — prove same-key env-vs-file precedence in ensure-db-roles-env.test.mjs</name>
  <files>scripts/__tests__/ensure-db-roles-env.test.mjs</files>
  <behavior>
    Add a fourth case to `scripts/__tests__/ensure-db-roles-env.test.mjs` that exercises the
    SAME key in both places, which is the case WR-07 says is currently untested:

    - Write an env file containing
      `TEST_ADMIN_DATABASE_URL=postgres://sentinel_user:sentinel_pw@127.0.0.1:59997/sentinel_db_4_file`.
    - Build the child env from the existing `baseEnv()` helper (which deletes BOTH admin-DSN keys
      so a developer shell cannot decide the outcome), then set `MEGA_CRM_ENV_FILE` to that file
      AND set the same key `TEST_ADMIN_DATABASE_URL` in the child env to
      `postgres://sentinel_user:sentinel_pw@127.0.0.1:59996/sentinel_db_4_env`.
      Do NOT set `GSD_ADMIN_DATABASE_URL` in this case — its presence is exactly what makes the
      current Test 2 prove the wrong thing.
    - Assert: `exitCode` is non-zero (both sentinel ports are dead loopback ports, so
      node-postgres refuses the connection before any role DDL runs), the output contains
      `127.0.0.1:59996` (the exported value), and the output does NOT contain `59997` (the file
      value). Never assert on a full printed DSN — the script must not log resolved credentials,
      and Tests 1-3 already establish that rule.
  </behavior>
  <action>
    Follow the file's existing shape exactly: one `describe` per case, `writeFileSync` into the
    shared `tmpDir`, `runCli(env)` for the subprocess, port-substring assertions only.

    Also correct the mis-titled case WR-07 names. Retitle the existing Test 2 `describe` and its
    `it` so they state what that case actually proves — that `resolveAdminDsn()`'s `||` chain
    prefers `GSD_ADMIN_DATABASE_URL` over `TEST_ADMIN_DATABASE_URL` regardless of which one came
    from the file — and add a short comment recording that the env-file-precedence property it
    used to claim is now covered by the new same-key case. Leave Test 2's env setup and its
    assertions unchanged; only its naming and comments were wrong.

    Keep Tests 1 and 3 untouched, and change nothing in `scripts/ensure-db-roles.mjs` — this is a
    test-only correction, and the production script's resolution order is already right.

    If the new case FAILS, stop and report it. A failure means Node's documented
    "already-exported environment wins over the env file" behavior does not hold for this Node
    version, which is a genuine finding worth surfacing. Do not weaken or invert the assertion to
    make it green.
  </action>
  <verify>
    <automated>npx vitest run --root scripts __tests__/ensure-db-roles-env.test.mjs</automated>
  </verify>
  <done>Four cases run; the new same-key case passes and asserts port 59996 wins over 59997; Tests 1-3 still pass; `scripts/ensure-db-roles.mjs` is unmodified.</done>
</task>

<task type="auto">
  <name>Task 3: Sync STATE.md to Phase 11 and run the full gate suite</name>
  <files>.planning/STATE.md</files>
  <action>
    Edit `.planning/STATE.md` with scoped `Edit` calls (never a whole-file `Write` — the file
    carries a long per-plan metrics table that must survive verbatim):

    Frontmatter:
    - `stopped_at` -> `Phase 10 complete — Phase 11 not yet discussed`
    - `last_updated` -> today's ISO-8601 timestamp; `last_activity` -> `2026-08-09`
    - `progress.completed_phases` -> `3`; `progress.percent` -> `34`
      (34 is the requirements-based figure, 32/95; `total_phases: 9` stays)
    - `current_phase: 11` and `current_phase_name: Delivery Correctness` are already correct —
      leave them

    Body:
    - `## Project Reference`: the `**Current focus:**` line must name Phase 11 —
      Delivery Correctness instead of the Phase 10 slug
    - `## Current Position`: set the progress line to
      `Progress: [███████░░░░░░░░░░░░░] 34% (3/9 v1.1 phases, 32/95 requirements)`
      (7 filled blocks, 13 empty). Keep the Phase / Plan / Status / Last activity lines coherent
      with "Phase 10 complete, ready to plan Phase 11"; keep the Phase 9 deadline-closed note.
    - `### Pending Todos`: the two Phase 10 bullets (SEC-05 Better Auth trust boundary, SEC-01
      admin-scan connection shape) were decisions for Phase 10's discuss step and Phase 10 is
      complete. Verify that in `.planning/phases/10-tenant-isolation-trust-boundaries/10-CONTEXT.md`
      first; if both were decided, remove those two bullets and keep the Phase 12 / Phase 14 ones.
      If either is genuinely still open, leave it and say so in the SUMMARY.
    - `### Decisions`: add one pointer line for Phase 10 —
      `**Phase 10 decisions (2026-08-09):** see .planning/phases/10-tenant-isolation-trust-boundaries/10-CONTEXT.md and the phase plan summaries.`
      Do not attempt to restate the decisions.
    - `## Session Continuity`: update the stopped-at line to match the frontmatter, and point the
      resume file at `.planning/ROADMAP.md` (Phase 11 has no artifact yet).
    - `## Operator Next Steps`: replace the whole list with (a) a Phase 10 completion line —
      15/15 plans, review findings WR-06/WR-07 closed by this quick task; (b)
      `Next: /gsd-discuss-phase 11` -> `/gsd-plan-phase 11` — Delivery Correctness; (c) the
      Phase 11 pitfalls already recorded in `### Blockers/Concerns` (DLV-03 exclusive row claim,
      AbortController timeout below BullMQ `lockDuration`, no enum backfill in the same
      migration) carried as the things Phase 11's discuss must cover.
      Leave `### Blockers/Concerns` itself unchanged — its Phase 10 pitfall entries are
      historical record, not a claim about the current focus.

    Then run the four gates in CI's own order and record each result in the SUMMARY:
    1. `npm run lint`
    2. `npm run build --workspaces --if-present` (this is the typecheck gate)
    3. `npm test` (per-workspace test run, includes apps/web)
    4. `npm run coverage`, then `npm run coverage:gate`, then `npm run coverage:ratchet`

    If `coverage:gate` fails, report the actual unrounded fraction against the threshold in
    `coverage-baseline.json` and state whether this change moved it. Do NOT edit
    `coverage-baseline.json` — the ratchet exists precisely to stop a threshold from being
    lowered alongside the change that broke it.
  </action>
  <verify>
    <automated>grep -q 'current_phase: 11' .planning/STATE.md && grep -q 'current_phase_name: Delivery Correctness' .planning/STATE.md && grep -q 'completed_phases: 3' .planning/STATE.md && grep -q 'percent: 34' .planning/STATE.md && grep -q '/gsd-discuss-phase 11' .planning/STATE.md && grep -q '/gsd-plan-phase 11' .planning/STATE.md && ! grep -qE 'Current focus:\*\* Phase 10' .planning/STATE.md && ! grep -qE 'Resume file:.*10-CONTEXT\.md' .planning/STATE.md && npm run lint && npm run build --workspaces --if-present && npm test && npm run coverage && npm run coverage:gate && npm run coverage:ratchet</automated>
  </verify>
  <done>STATE.md presents Phase 11 as the current position with no line still framing Phase 10 as current focus or resume point; lint, typecheck, tests, and the aggregate coverage run all completed and their outcomes (including any pre-existing coverage-gate state) are recorded in the SUMMARY.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser -> API route param | `:id` on `/api/workspaces/:slug/imports/:id/errors` is attacker-controlled and, pre-fix, reaches a response header value |
| response header -> user agent | `Content-Disposition` parameters steer the downloaded filename in the caller's browser |
| shell/CI env -> ensure-db-roles.mjs | admin DSN resolution order across exported env vars and the external env file |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-Q0809-01 | Tampering | `csv-import.routes.ts` errors route `Content-Disposition` | medium | mitigate | Task 1: reject a non-UUID `:id` with 400 before the header is built, and interpolate only the zod-parsed value — a literal `"` can no longer append a second `filename` parameter |
| T-Q0809-02 | Information disclosure | errors route response shape | low | accept | The guard runs after `resolveWorkspaceMember`, so unauthenticated and non-member responses stay byte-identical to today; a 400 is only observable to a caller already proven to be a member of the workspace |
| T-Q0809-03 | Elevation of privilege | `ensure-db-roles.mjs` admin DSN resolution | low | mitigate | Task 2: assert an already-exported `TEST_ADMIN_DATABASE_URL` outranks the same key in a loaded env file, so an env file dropped next to the resolver cannot silently redirect role-creation DDL at a different database |
| T-Q0809-SC | Tampering | npm installs | low | accept | No package is added or upgraded by this task — `zod@4.4.3` is already a direct `apps/api` dependency, so no package-legitimacy checkpoint applies |
</threat_model>

<verification>
1. `npx vitest run --root apps/api src/modules/contacts/__tests__/csv-import.test.ts` — WR-06 tests A/B/C green, no pre-existing test regressed
2. `npx vitest run --root scripts __tests__/ensure-db-roles-env.test.mjs` — four cases green, same-key case proves 59996 over 59997
3. `npm run lint` — clean at `--max-warnings=0`
4. `npm run build --workspaces --if-present` — typecheck clean across all workspaces
5. `npm test` — all workspace test suites pass
6. `npm run coverage` then `npm run coverage:gate` then `npm run coverage:ratchet` — aggregate coverage run completes; gate/ratchet outcome recorded verbatim in the SUMMARY, `coverage-baseline.json` unmodified
7. `git diff --stat` lists exactly four files: the two source/test files, the scripts test, and `.planning/STATE.md`
</verification>

<success_criteria>
- The CSV error-report route rejects a malformed `:id` with 400 and never builds a header from an unvalidated value; a double-quote-bearing `:id` cannot inject a `filename` parameter
- The valid-UUID happy path is byte-for-byte unchanged (200, `text/csv`, `import-<id>-errors.csv`)
- `ensure-db-roles-env.test.mjs` proves same-key exported-over-file precedence, and its previously mis-titled case now describes what it actually asserts
- `.planning/STATE.md` reflects Phase 10 complete / Phase 11 current, 3/9 phases, 32/95 requirements, ~34%, with `/gsd-discuss-phase 11` -> `/gsd-plan-phase 11` as the operator next step
- No production behavior changed anywhere except the WR-06 guard
</success_criteria>

<output>
Create `.planning/quick/260809-eqr-close-phase-10-residual-review-findings-/260809-eqr-SUMMARY.md` when done
</output>
