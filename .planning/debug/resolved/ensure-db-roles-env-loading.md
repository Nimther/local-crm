---
status: resolved
slug: ensure-db-roles-env-loading
phase: 10-tenant-isolation-trust-boundaries
gap_id: G-10-1
created: 2026-08-09
goal: find_root_cause_only
note: Reconstructed from the debug agent's return — the worktree-local original was
  removed with the worktree before it could be copied out.
---

## Symptoms

- **truth:** Cold start from scratch boots without errors: migrations apply and a primary query returns live data
- **expected:** Kill any running server/worker. Clear ephemeral state. Start the application from scratch — server boots without errors, migrations (incl. 0042 scan-role grants and 0046 API-key scope backfill) complete, and a health check / basic API call returns live data.
- **actual (verbatim user report):** "Cold start failed. scripts/ensure-db-roles.mjs does not load the external env file from resolveEnvPath(), so it ignores TEST_ADMIN_DATABASE_URL and falls back to postgres://postgres:postgres@localhost:5432/postgres. Homebrew PostgreSQL has no 'postgres' role. The script should load the same external env file as check-env.mjs and migrate-dev.mjs before resolving the admin DSN."
- **errors:** `db:roles failed: role "postgres" does not exist`, exit 1
- **reproduction:** Test 1 (Cold Start Smoke Test) in 10-UAT.md

## Root Cause

`scripts/ensure-db-roles.mjs` (new in Phase 10, wired as step 2 of the root `predev`
script, *before* migrations) resolves its admin DSN from bare `process.env` —
`process.env.GSD_ADMIN_DATABASE_URL || process.env.TEST_ADMIN_DATABASE_URL || DEFAULT_ADMIN_DSN`
at lines 25–27 — without first loading the external env file via
`process.loadEnvFile(resolveEnvPath())` the way every sibling DSN consumer does.
`TEST_ADMIN_DATABASE_URL` is present in the external env file
(`~/.config/mega-crm/.env`, presence-verified) but invisible to the script's process,
so it falls back to the hardcoded docker-compose DSN
`postgres://postgres:postgres@localhost:5432/postgres`. Homebrew PostgreSQL has no
`postgres` role, the connection fails, the script exits 1, and the `&&` chain in
`predev` aborts before `migrate-dev.mjs` — migrations 0042/0046 never apply and the
cold start dies.

This is a recurrence of the documented 08-07 failure class (SPECIFICATION.md:107):
the `TEST_ADMIN_DATABASE_URL`-override convention was copied from `provision-db.ts`
without the env-loading half of that pattern.

## Evidence

- Source read: `ensure-db-roles.mjs` imports only `pg` (line 21); no `./env-path.mjs`
  import, no `loadEnvFile` anywhere. Contrast `migrate-dev.mjs` lines 21–25
  (`try { process.loadEnvFile(resolveEnvPath()); } catch {}` before consuming
  `DATABASE_URL`) — the same pattern used in `packages/test-support/vitest.config.ts:22`
  and `apps/web/playwright.config.ts:14`. `check-env.mjs` reads the file only for
  validation and does not export values to subsequent processes, so each script in the
  chain must self-load.
- Deterministic reproduction:
  `env -u TEST_ADMIN_DATABASE_URL -u GSD_ADMIN_DATABASE_URL node scripts/ensure-db-roles.mjs`
  → `db:roles failed: role "postgres" does not exist`, exit 1 — exact reported error,
  first attempt (connection fails before any `CREATE ROLE`, so the repro mutated nothing).
- Differential confirmation: a probe process that loads `resolveEnvPath()`
  (`~/.config/mega-crm/.env`) shows `TEST_ADMIN_DATABASE_URL present: true` — the
  variable exists; the missing env-file load is the sole difference between failure and
  success. Invocation path confirmed at `package.json` line 13:
  `"predev": "node scripts/check-env.mjs && node scripts/ensure-db-roles.mjs && node scripts/migrate-dev.mjs"`.
- Sibling sweep: `ensure-db-roles.mjs` is the *only* script in `scripts/` resolving a
  Postgres DSN without loading the env file. `verify-redis-config.mjs` reads bare
  `process.env.REDIS_URL` by explicit documented design (no default, fails loud, not in
  the predev chain) — not a sibling gap. Secondary note: `check-env.mjs`'s required list
  does not cover the admin DSN vars, which is why predev step 1 passed while step 2's
  dependency was unmet (it cannot hard-require them — the compose default is valid in
  compose environments).

## Files Involved

- `scripts/ensure-db-roles.mjs`: lines 23–27 — hardcoded `DEFAULT_ADMIN_DSN` fallback
  reached because the external env file is never loaded before `resolveAdminDsn()`
- `scripts/migrate-dev.mjs`: lines 21–25 — the established env-loading pattern the fix
  should mirror (not itself broken)
- `scripts/env-path.mjs`: exports `resolveEnvPath()` (QG-07 single decision point)
- `package.json`: line 13 — `predev` chain placing the failing script before migrations

## Suggested Fix Direction

Add `import { resolveEnvPath } from "./env-path.mjs";` and
`try { process.loadEnvFile(resolveEnvPath()); } catch { /* rely on exported env */ }`
at the top of `scripts/ensure-db-roles.mjs`, before `resolveAdminDsn()` — the exact
`migrate-dev.mjs` pattern (also honors `MEGA_CRM_ENV_FILE` for CI, where the catch path
keeps directly-exported vars working). Optionally document in `check-env.mjs` why the
admin DSN vars are deliberately not hard-required.

AND-gate note for the planner: the failure needs both the missing load (code defect)
and an environment where the compose-default DSN is invalid (Homebrew PG —
documented-normal per SPECIFICATION.md:256), which is why compose/CI contexts never
surfaced it; only the code half needs fixing.
