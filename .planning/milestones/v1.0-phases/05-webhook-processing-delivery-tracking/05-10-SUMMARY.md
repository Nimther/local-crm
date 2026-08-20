---
phase: 05-webhook-processing-delivery-tracking
plan: 10
subsystem: infra
tags: [docs, env-checker, sendgrid, webhooks, uat, ngrok, cloudflared]

# Dependency graph
requires:
  - phase: 05-webhook-processing-delivery-tracking
    provides: "05-08's redacted-logging + typed provisioning-error persistence, 05-09's UI surfacing of provisioning warnings/reasons"
provides:
  - "docs/webhook-live-uat.md — the operational runbook for running the Phase 5 live UAT with a public tunnel and a correctly-scoped SendGrid key"
  - "scripts/check-env.mjs non-fatal localhost heads-up for PUBLIC_APP_URL, pointing at the runbook"
affects: [webhook-processing-delivery-tracking, sendgrid-integration, onboarding]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Non-fatal console.warn heads-up in the pre-dev env checker for environment values that are valid-but-risky (as opposed to missing/invalid, which stays a hard fail)"

key-files:
  created:
    - docs/webhook-live-uat.md
  modified:
    - scripts/check-env.mjs

key-decisions:
  - "PUBLIC_APP_URL localhost detection is a non-fatal warning only — local dev of every other feature is fine on localhost; only live SendGrid webhook delivery requires a public tunnel"
  - "Runbook uses placeholders only for API keys/tunnel URLs and explicitly instructs never to commit a real tenant SendGrid key"

patterns-established:
  - "Operational runbooks for environment-dependent live UAT live under docs/, cross-referenced from the relevant env-checker comment"

requirements-completed: [WBHK-01]

coverage:
  - id: D1
    description: "docs/webhook-live-uat.md documents the tunnel + PUBLIC_APP_URL + SendGrid key-scope preconditions and the Test 1-3 steps"
    requirement: "WBHK-01"
    verification:
      - kind: other
        ref: "test -f docs/webhook-live-uat.md && grep -q PUBLIC_APP_URL docs/webhook-live-uat.md && grep -qi 'ngrok\\|cloudflared' docs/webhook-live-uat.md && grep -qi 'Mail Settings\\|Webhook' docs/webhook-live-uat.md"
        status: pass
    human_judgment: false
  - id: D2
    description: "scripts/check-env.mjs carries a PUBLIC_APP_URL doc-comment and a non-fatal localhost heads-up warning pointing to the runbook, without changing hard-failure behavior for missing vars"
    requirement: "WBHK-01"
    verification:
      - kind: other
        ref: "node --check scripts/check-env.mjs && grep -q webhook-live-uat scripts/check-env.mjs"
        status: pass
      - kind: manual_procedural
        ref: "node scripts/check-env.mjs <scratch-env-with-PUBLIC_APP_URL=http://localhost:4000> -> prints localhost warning, exit 0; scratch-env missing all required vars -> hard fail, exit 1 (unchanged)"
        status: pass
    human_judgment: false

# Metrics
duration: 10min
completed: 2026-07-09
status: complete
---

# Phase 05 Plan 10: Live Webhook UAT Runbook + Localhost Env Warning Summary

**Documents the tunnel + correctly-scoped-SendGrid-key preconditions the live webhook UAT actually needs, and adds a non-fatal localhost heads-up to the pre-dev env checker pointing at that runbook.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-07-09T12:22:35Z
- **Completed:** 2026-07-09T12:25:38Z
- **Tasks:** 2 completed
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments

- Authored `docs/webhook-live-uat.md`: explains why a `localhost` `PUBLIC_APP_URL` makes live webhook provisioning/delivery impossible (SendGrid calls the callback URL from the public internet), walks through starting an `ngrok`/`cloudflared` tunnel and updating `PUBLIC_APP_URL`, documents the exact SendGrid Restricted-Access key scopes required (Mail Send + Mail Settings/Event Webhook), and maps the runbook's test procedure to 05-UAT.md Tests 1-3.
- Added a non-fatal `console.warn` heads-up to `scripts/check-env.mjs`: if `PUBLIC_APP_URL` matches `localhost`/`127.0.0.1`, the checker warns and points at the runbook — without changing the exit code, since localhost is fine for every feature except live webhook delivery. Verified functionally against a scratch env file (warning fires, exit 0) and confirmed the existing hard-failure path for genuinely missing vars is untouched (exit 1, unchanged message).
- This closes the operational-precondition gaps identified by the two prior UAT gap-closure debug sessions (`sendgrid-webhook-not-provisioned.md`, `enable-delivery-tracking-error.md`): the live UAT that failed Tests 1-3 was run with `PUBLIC_APP_URL=http://localhost:4000` and, most likely, a Mail-Send-only key — both of which now have a documented, discoverable fix path.

## Task Commits

1. **Task 1: Author the live webhook UAT runbook** - `206cb28` (docs)
2. **Task 2: Annotate the env checker + add a non-fatal localhost warning for PUBLIC_APP_URL** - `6aef245` (chore)

_No TDD tasks in this plan (docs + a small non-behavioral checker annotation)._

## Files Created/Modified

- `docs/webhook-live-uat.md` — new operational runbook: why localhost fails, tunnel setup, SendGrid key scope requirements, Test 1-3 procedure, failure-diagnosis pointer to 05-08's logging, and a security note on ECDSA verification + never committing real keys.
- `scripts/check-env.mjs` — added a doc-comment above the `PUBLIC_APP_URL` `baseRequired` entry and a post-missing-vars-check non-fatal `console.warn` branch for a localhost/127.0.0.1 value.

## Decisions Made

- PUBLIC_APP_URL's localhost check is a **warning, not a hard failure** — every other feature (auth, contacts, segments, campaigns, non-webhook sends) works fine with a localhost `PUBLIC_APP_URL` in local dev; only live SendGrid webhook create/PATCH and event delivery require a public URL. Failing the whole `predev` check would block ordinary local development for no benefit.
- The runbook explicitly forbids ever pasting a real tenant SendGrid API key into any committed file, addressing threat T-05-10-01 from the plan's threat model directly in the artifact itself rather than relying on reviewers to catch it.

## Deviations from Plan

None — plan executed exactly as written. Both tasks' automated verify commands and the optional functional check (Task 2's scratch-env run) passed as specified.

## User Setup Required (not performed by this plan)

This plan's frontmatter declares `user_setup` that only a human can perform (the executor is hard-denied from editing `.env*` files and cannot run interactive tunnel/dashboard steps):

1. Start a public tunnel (`ngrok http 4000` or `cloudflared tunnel --url http://localhost:4000`) and keep it running for the UAT session.
2. Set `PUBLIC_APP_URL` in `.env` to the tunnel's `https://` forwarding URL, then restart `npm run dev`.
3. Create or supply a tenant SendGrid Restricted Access API key with **both** Mail Send and Mail Settings/Event Webhook scopes (a Mail-Send-only key fails provisioning with `missing_scope`).

`docs/webhook-live-uat.md` is the single reference for all three steps. Once done, the Phase 5 live UAT (Tests 1-3 in `05-UAT.md`) can be re-run.

## Self-Check: PASSED

- `docs/webhook-live-uat.md` — FOUND (created, verify greps pass)
- `scripts/check-env.mjs` — FOUND (modified, `node --check` exits 0, functional scratch-env checks confirm both the new warning and unchanged hard-failure path)
- Commit `206cb28` — FOUND in `git log`
- Commit `6aef245` — FOUND in `git log`
