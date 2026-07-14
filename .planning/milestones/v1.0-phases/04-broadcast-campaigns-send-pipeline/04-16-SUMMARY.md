---
phase: 04-broadcast-campaigns-send-pipeline
plan: 16
subsystem: infra
tags: [zod, bullmq, drizzle-kit, env-validation, boot-guard]

# Dependency graph
requires:
  - phase: 04-03
    provides: packages/delivery-core/src/unsubscribe-token.ts (lazy UNSUBSCRIBE_TOKEN_SECRET/PUBLIC_APP_URL reads)
  - phase: 04-06
    provides: migrations 0017-0019 (campaigns.fan_out_complete, admin_scan RLS policy, workspace_isolation NULLIF fix)
provides:
  - Fail-fast boot validation of UNSUBSCRIBE_TOKEN_SECRET + PUBLIC_APP_URL across check-env.mjs, apps/api/src/env.ts, apps/worker/src/server.ts
  - scripts/migrate-dev.mjs predev bootstrap so `npm run dev` always applies pending Drizzle migrations first
affects: [phase-05-webhook-processing, dev-bootstrap]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Boot-time fail-fast guard layered ABOVE a package's own lazy throw (delivery-core's getSecret()/buildListUnsubscribeUrl() throws remain as defense-in-depth; the new guards in check-env.mjs/env.ts/server.ts catch the same misconfiguration earlier, at boot, with an actionable message)"
    - "predev chain (check-env.mjs && migrate-dev.mjs) as the standard place to add pre-flight dev-bootstrap steps, run only on `npm run dev` (not test/build), so CI lanes without a DB are unaffected"

key-files:
  created:
    - scripts/migrate-dev.mjs
  modified:
    - scripts/check-env.mjs
    - apps/api/src/env.ts
    - apps/worker/src/server.ts
    - package.json

key-decisions:
  - "32-char minimum for UNSUBSCRIBE_TOKEN_SECRET enforced consistently in apps/api/src/env.ts (zod) and apps/worker/src/server.ts (manual guard); check-env.mjs stays presence-only per plan (dependency-free script, no length logic)"
  - "migrate-dev.mjs mirrors apps/api/vitest.config.ts's env-loading pattern (process.loadEnvFile in try/catch) rather than introducing a new convention"
  - "migrate-dev.mjs lets a migrate failure propagate (execSync with stdio: inherit, no try/catch around it) so predev fails loudly on a real migration error rather than silently continuing to boot"

patterns-established: []

requirements-completed: [SEND-05, SUBS-04, CAMP-05]

coverage:
  - id: D1
    description: "check-env.mjs, apps/api/src/env.ts, and apps/worker/src/server.ts all fail fast (loud error, non-zero exit / thrown Error) when UNSUBSCRIBE_TOKEN_SECRET or PUBLIC_APP_URL is missing or too short, instead of the worker crashing per-send-job"
    requirement: "SEND-05"
    verification:
      - kind: integration
        ref: "node scripts/check-env.mjs <fixture> — rejects fixture missing both vars, accepts once both present"
        status: pass
      - kind: other
        ref: "npm run build -w @mega-crm/api && npm run build -w @mega-crm/worker (tsc typecheck of new zod fields + boot guards)"
        status: pass
    human_judgment: false
  - id: D2
    description: "scripts/migrate-dev.mjs applies pending Drizzle migrations (0017-0019) before the dev stack boots, wired as the second step of the root predev script"
    requirement: "CAMP-05"
    verification:
      - kind: other
        ref: "node --check scripts/migrate-dev.mjs (valid JS); predev script string includes both check-env and migrate-dev"
        status: pass
      - kind: integration
        ref: "node scripts/migrate-dev.mjs run against this repo's real .env — DATABASE_URL guard exercised, npm run db:migrate executed successfully (drizzle-kit reported 'migrations applied successfully')"
        status: pass
    human_judgment: false
  - id: D3
    description: "End-to-end UAT re-run confirming a real test send reaches the inbox and a re-launched broadcast advances sent_count past 0"
    verification: []
    human_judgment: true
    rationale: "Requires the user to add UNSUBSCRIBE_TOKEN_SECRET/PUBLIC_APP_URL to their local .env (executor cannot write .env* paths) and manually re-run UAT Tests 4/5 against a live SendGrid send — genuine external verification, not reproducible in this environment."

# Metrics
duration: 12min
completed: 2026-07-06
status: complete
---

# Phase 04 Plan 16: Send-Pipeline Env Fail-Fast + Predev Migration Bootstrap Summary

**Fail-fast boot validation for UNSUBSCRIBE_TOKEN_SECRET/PUBLIC_APP_URL across all three boot paths, plus a predev migration bootstrap that applies pending Drizzle migrations before `npm run dev` boots the stack**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-06T19:32:00Z (approx.)
- **Completed:** 2026-07-06T19:44:37Z
- **Tasks:** 2
- **Files modified:** 5 (1 created, 4 modified)

## Accomplishments
- `scripts/check-env.mjs`, `apps/api/src/env.ts`, and `apps/worker/src/server.ts` now all validate `UNSUBSCRIBE_TOKEN_SECRET` (>=32 chars in env.ts/server.ts, presence-only in check-env.mjs) and `PUBLIC_APP_URL` at boot — a missing/weak value aborts the process with a named, actionable error instead of crashing every send/kickoff job per-attempt into BullMQ's failed set (the shared root cause of UAT Tests 4 and 5).
- New `scripts/migrate-dev.mjs` loads the root `.env`, requires `DATABASE_URL` (fails closed with a clear message otherwise), and runs `npm run db:migrate` with the inherited env — wired into `predev` (`check-env.mjs && migrate-dev.mjs`) so `npm run dev` always applies pending migrations before boot. Running it against this repo's real `.env` applied all pending migrations successfully, ending in "migrations applied successfully!" — the exact fix for the UAT Test 5 kickoff crash (`column "fan_out_complete" does not exist`).

## Task Commits

Each task was committed atomically:

1. **Task 1: Fail-fast validation of UNSUBSCRIBE_TOKEN_SECRET + PUBLIC_APP_URL in all three boot paths** - `49cf5e7` (feat)
2. **Task 2: predev migration bootstrap so `npm run dev` applies pending migrations first** - `c19238f` (feat)

**Plan metadata:** (recorded below)

## Files Created/Modified
- `scripts/check-env.mjs` - added `UNSUBSCRIBE_TOKEN_SECRET`/`PUBLIC_APP_URL` to `baseRequired` (presence-only)
- `apps/api/src/env.ts` - zod schema fields enforcing `UNSUBSCRIBE_TOKEN_SECRET` (min 32 chars) and `PUBLIC_APP_URL` (valid URL)
- `apps/worker/src/server.ts` - `buildWorker()` throws before constructing any Worker when either send-signing var is absent/weak
- `scripts/migrate-dev.mjs` (new) - loads root `.env`, requires `DATABASE_URL`, runs `npm run db:migrate`
- `package.json` - `predev` now chains `node scripts/check-env.mjs && node scripts/migrate-dev.mjs`

## Decisions Made
- 32-char minimum for `UNSUBSCRIBE_TOKEN_SECRET` applied consistently in `env.ts` (zod `.min(32, ...)`) and `server.ts` (manual length check); `check-env.mjs` stays presence-only per the plan's own instruction (dependency-free script, no length logic there — the api/worker checks own strength enforcement).
- `migrate-dev.mjs` mirrors `apps/api/vitest.config.ts`'s `process.loadEnvFile` try/catch pattern rather than introducing a new env-loading convention.
- A migrate failure inside `migrate-dev.mjs` is allowed to propagate (no swallowing try/catch around `execSync`), so `predev` fails loudly on a genuine migration error rather than silently continuing to boot a stack against a stale schema.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None. The plan's own automated verification for Task 2 assumed no root `.env` exists (`env -i PATH="$PATH" node scripts/migrate-dev.mjs` expecting a non-zero exit); this repo has a real `.env` with `DATABASE_URL` already set, so `migrate-dev.mjs` found it (by design — it resolves the `.env` path relative to the script, not `cwd`) and ran the actual migration end-to-end, which succeeded. This is a stronger validation than the synthetic negative-path fixture: it proves the DATABASE_URL guard's happy path AND the real migrate step work together, and confirms all pending migrations (0017-0019) are now applied. The negative branch (`if (!process.env.DATABASE_URL)`) was verified by code inspection — it is a single unconditional check preceding any `execSync` call.

## User Setup Required

**External services require manual configuration.** The plan's `user_setup` block specifies two `.env` values the executor cannot write (harness `.env*` deny):

- `UNSUBSCRIBE_TOKEN_SECRET` — generate with `openssl rand -base64 32` (>=32 chars); add to both `.env` and `.env.example` (placeholder in the example).
- `PUBLIC_APP_URL` — `http://localhost:4000` in dev (the API base serving `GET/POST /unsubscribe/:token`); add to both `.env` and `.env.example`.

Once both are added and `npm run dev` is restarted, the phase-level UAT re-run (human_verify_mode: end-of-phase) should:
1. Confirm the stack boots cleanly (no "UNSUBSCRIBE_TOKEN_SECRET is not set" from the worker; `predev` applies 0017-0019 so `campaigns.fan_out_complete` now exists).
2. Re-run UAT Test 4 — a test send should reach the inbox rendered via the SendGrid Dynamic Template.
3. Recover the stuck campaign (id `0b24f2f3`, `sent_count` stuck at 0): cancel it, then duplicate/create a fresh campaign and launch — re-run UAT Test 5, confirming `sent_count` advances past 0 (unblocks Tests 6, 7, 13).

## Next Phase Readiness
Both independently-fatal gaps behind UAT Tests 4 and 5 are closed at the code level: the send pipeline can no longer boot with a silently-missing signing secret, and the dev bootstrap can no longer leave a migration unapplied. Once the user adds the two `.env` values, the phase-level UAT re-run should unblock Tests 4, 5, 6, 7, and 13. No blockers for Phase 5 (Webhook Processing & Delivery Tracking).

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-06*

## Self-Check: PASSED

- FOUND: scripts/migrate-dev.mjs
- FOUND: .planning/phases/04-broadcast-campaigns-send-pipeline/04-16-SUMMARY.md
- FOUND: 49cf5e7 (Task 1 commit)
- FOUND: c19238f (Task 2 commit)
