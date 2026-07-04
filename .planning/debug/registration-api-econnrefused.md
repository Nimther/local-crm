---
status: diagnosed
trigger: "Submitting the registration form fails with a generic error toast; the vite dev-server proxy reports ECONNREFUSED for /api/auth/sign-up/email — the API server is unreachable from the web dev proxy during UAT of Phase 01."
created: 2026-07-03T00:00:00Z
updated: 2026-07-03T00:20:00Z
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: CONFIRMED — API crashes at env parse (apps/api/src/env.ts:44) on cold start because .env lacks PLATFORM_SENDGRID_API_KEY and PLATFORM_MAIL_FROM; server never listens on :4000; vite proxy gets ECONNREFUSED.
test: both experiments complete (crash reproduced with real .env; clean boot + HTTP 200 on /api/auth/ok with the two vars stubbed)
expecting: n/a — diagnosis complete
next_action: Return ROOT CAUSE FOUND to orchestrator (goal: find_root_cause_only — no fix applied)

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: Submitting the /register form signs the user in and routes to the create-workspace step (POST /api/auth/sign-up/email proxied by the vite dev server reaches the Fastify API and returns success).
actual: UI shows the generic failure toast ("Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу."). The web dev-server console shows a proxy failure.
errors: |
  [web] 6:43:04 PM [vite] http proxy error: /api/auth/sign-up/email
  [web] AggregateError [ECONNREFUSED]:
  [web]     at internalConnectMultiple (node:net:1193:18)
  [web]     at afterConnectMultiple (node:net:1783:7)
reproduction: UAT Test 2 — cold-start the stack (docker-compose up, migrations, API, web dev server), open /register, fill the form, submit. UAT Test 1 (cold start) "passed" but only proves vite served the login page — not that the API was listening.
started: Discovered during Phase 01 UAT (2026-07-03), immediately after a from-scratch cold start. All 38 API integration tests pass via in-process fastify injection (would not catch listen/host/port misconfig).

## Eliminated
<!-- APPEND only - prevents re-investigating -->

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-07-03T00:00:00Z
  checked: .planning/debug/knowledge-base.md
  found: Knowledge base does not exist — no known-pattern candidates.
  implication: Proceed with open investigation.

- timestamp: 2026-07-03T00:05:00Z
  checked: apps/web/vite.config.ts vs apps/api/src/server.ts
  found: Vite dev proxy targets http://localhost:4000; API listens on 0.0.0.0:env.API_PORT (default 4000, .env sets API_PORT=4000). No host/port/protocol mismatch. 0.0.0.0 covers 127.0.0.1, so AggregateError ECONNREFUSED (both ::1 and 127.0.0.1 refused) means nothing was listening at all — not an IPv6-only binding issue.
  implication: The API process was not listening. Focus on boot failure, not proxy config.

- timestamp: 2026-07-03T00:08:00Z
  checked: .env vs apps/api/src/env.ts required vars (values redacted; names only)
  found: .env contains DATABASE_URL, TEST_DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL, WEB_URL, API_PORT=4000, NODE_ENV=development. It does NOT contain PLATFORM_SENDGRID_API_KEY (required, z.string().min(1)) or PLATFORM_MAIL_FROM (required, z.string().email()), both added to env.ts by plan 01-03. .env.example has the exact same var list — the example file was never updated when 01-03/01-05 added new env requirements.
  implication: envSchema.parse(process.env) throws at import time on cold start; .env.example gives no hint the new vars are needed.

- timestamp: 2026-07-03T00:10:00Z
  checked: apps/api/src/kms/local-provider.ts
  found: KMS_LOCAL_KEK is validated lazily inside getLocalKek() (called per encrypt/decrypt), not at boot. Also absent from .env/.env.example.
  implication: Not a boot blocker, but a latent failure — UAT Test 9 (connect SendGrid key) will fail with "KMS_LOCAL_KEK must be set" once the boot issue is fixed.

- timestamp: 2026-07-03T00:12:00Z
  checked: "Experiment 1: tsx --env-file=.env src/server.ts (exact dev entrypoint, minus watch)"
  found: Process exits code 1 before listening. ZodError with exactly two issues — PLATFORM_SENDGRID_API_KEY "expected string, received undefined" and PLATFORM_MAIL_FROM "expected string, received undefined" — thrown from env.ts:44 during module import.
  implication: CONFIRMS hypothesis. Under `tsx watch` (root npm run dev), the watcher process stays alive after the crash waiting for file changes, so `concurrently` shows [api] output once and keeps running — explaining why UAT Test 1 looked like a pass while nothing listened on :4000.

- timestamp: 2026-07-03T00:16:00Z
  checked: "Experiment 2: same command with PLATFORM_SENDGRID_API_KEY=SG.dummy-for-diagnosis PLATFORM_MAIL_FROM=noreply@example.com stubbed inline"
  found: Server boots cleanly — pino logs "Server listening at http://127.0.0.1:4000"; lsof shows node LISTEN on *:4000; GET /api/auth/ok returns 200 through better-auth; GET /api/workspaces returns proper 401 Unauthorized JSON.
  implication: No second boot blocker. The isDirectRun guard works under tsx, API_PORT=4000 matches the vite proxy target, and 0.0.0.0 binding covers IPv4 localhost. The two missing env vars are the sole cause of the ECONNREFUSED.

- timestamp: 2026-07-03T00:18:00Z
  checked: Why the 38 passing API integration tests did not catch this
  found: Tests use in-process fastify injection (never call app.listen) and run under vitest with their own env setup — they exercise routes, not the cold-start boot path with the developer's .env.
  implication: Coverage gap is expected; a smoke check that the dev entrypoint actually listens (or a clearer boot-failure message) would have surfaced this.

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: |
  Cold-start env drift: plans 01-03 and 01-05 added new required environment
  variables to apps/api/src/env.ts (PLATFORM_SENDGRID_API_KEY,
  PLATFORM_MAIL_FROM — both hard-required; plus KMS_LOCAL_KEK, lazily
  required) but the root .env and .env.example were never updated. On cold
  start, envSchema.parse(process.env) at apps/api/src/env.ts:44 throws a
  ZodError during module import, so the Fastify server exits before ever
  calling listen(). `tsx watch` (invoked by root `npm run dev` via
  concurrently) stays alive after the crash waiting for file changes, so the
  dev stack looks "up" while nothing listens on :4000 — the vite proxy
  (target http://localhost:4000) then gets AggregateError ECONNREFUSED on
  both ::1 and 127.0.0.1 for POST /api/auth/sign-up/email. UAT Test 1
  "passed" only because vite serves the login page independently of API
  health. Verified empirically: with the two vars stubbed, the same command
  boots, listens on *:4000, and serves /api/auth/ok with HTTP 200.
fix: (not applied — goal find_root_cause_only)
verification: (n/a)
files_changed: []

latent_secondary_issue: |
  KMS_LOCAL_KEK is also absent from .env/.env.example. It is validated
  lazily in apps/api/src/kms/local-provider.ts:getLocalKek(), so it does not
  block boot — but UAT Test 9 (connect SendGrid key) will fail with
  "KMS_LOCAL_KEK must be set when KMS_PROVIDER=local" once boot is fixed.
  Likewise, PLATFORM_SENDGRID_API_KEY must be a real platform key (not a
  stub) for UAT Tests 4, 5, and 7 (real email delivery).
