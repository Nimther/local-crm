---
phase: 16-live-sendgrid-verification
plan: 06
subsystem: delivery-testing
tags: [sendgrid, bullmq, fault-injection, reconciliation, compose, uat]

# Dependency graph
requires:
  - phase: 16-live-sendgrid-verification
    provides: "16-03's tenant mail/send base-URL seam and deployed override warning"
  - phase: 16-live-sendgrid-verification
    provides: "16-04's retained live UAT workspace, real webhook endpoint and operator-controlled recipient"
provides:
  - "Dependency-free, one-shot, workspace-targeted SendGrid fault proxy with asymmetric 429 and timeout modes"
  - "UAT-05 state reporter joining the sends ledger, BullMQ attempt/state evidence and attributed send_events"
  - "Live proof that a provider 429 retries to one delivery and an ambiguous timeout resolves from webhook evidence without retry"
  - "Session-scoped compose override and mandatory teardown procedure with no published control port"
affects: [16-07-uat-report, sendgrid-failure-recovery, production-uat-runbook]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fault only requests whose custom_args.workspace_id matches the explicitly targeted UAT workspace; sibling requests neither fault nor consume the one-shot mode"
    - "Report provider deferral from BullMQ when the dispatching ledger claim has deliberately been released"
    - "Restart temporary UAT services with --no-deps so compose cannot recreate production database or Redis dependencies"

key-files:
  created:
    - scripts/uat-fault-proxy.mjs
    - scripts/__tests__/uat-fault-proxy.test.mjs
    - docker/docker-compose.uat-proxy.yml
  modified:
    - scripts/uat-verify.mjs
    - scripts/__tests__/uat-verify.test.mjs
    - docs/runbooks/uat-live-sendgrid.md
    - package.json
    - package-lock.json

key-decisions:
  - "A synthetic 429 never reaches SendGrid; a synthetic timeout always reaches SendGrid once and delays only the response back to the worker"
  - "Retry-After remains provider guidance: the production provider-backoff branch uses bounded BullMQ exponential retry, so attemptsMade=2 plus the first-attempt provider-backoff log is durable evidence when the short deferred window is missed"
  - "Frequency-cap headroom is a UAT precondition because the pre-send gate runs before the fault proxy; any temporary UAT-only cap change must be recorded and restored"
  - "Timeout success requires a real send_events row before reconciling may resolve to sent"

requirements-completed: [UAT-05]

coverage:
  - id: D1
    description: "The proxy implements and resets pass-through, rate-limit-once and timeout-once while preserving request bytes and headers"
    requirement: "UAT-05"
    verification:
      - kind: unit
        ref: "scripts/__tests__/uat-fault-proxy.test.mjs (10 cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A real 429 produced one bounded retry and exactly one real mailbox delivery"
    requirement: "UAT-05"
    verification:
      - kind: live
        ref: "send 0eb4edb8-94aa-5778-98bf-2fa4cd42c2cb: provider-backoff log, attemptCount=2, sent, processed+delivered"
        status: pass
      - kind: manual
        ref: "Operator mailbox thread delta, correlated with the two send-specific delivered events"
        status: pass
    human_judgment: true
  - id: D3
    description: "A real upstream request whose response exceeded the worker timeout became reconciling and resolved to sent from webhook evidence without retry"
    requirement: "UAT-05"
    verification:
      - kind: live
        ref: "send 150e82da-ca35-5b57-b0e9-3444c83f863e: attemptCount=1, reconciling at 10:02:38Z, reconciler resolvedSent=1 at 10:06:13Z"
        status: pass
    human_judgment: false
  - id: D4
    description: "The proxy remained internal and the endpoint override, temporary files and container were removed after the session"
    requirement: "UAT-05"
    verification:
      - kind: live
        ref: "off-host port 4180 closed; proxy absent; override variables absent; fresh worker warning absent; /readyz=200"
        status: pass
    human_judgment: false

# Metrics
duration: 74min
completed: 2026-08-18
status: complete
---

# Phase 16 Plan 06: Live 429 and Timeout Recovery Summary

**The deployed production send path now has live evidence for both failure branches: a provider 429 retried to one delivery, while a post-accept timeout stayed ambiguous until real webhook evidence resolved it — with exactly two new mailbox messages total and no duplicate.**

## Performance

- **Duration:** ~74 min
- **Started:** 2026-08-18T14:12:22+05:00
- **Completed:** 2026-08-18T15:26+05:00
- **Tasks:** 3 completed (including the real-host checkpoint)
- **Files modified:** 8

## Accomplishments

- Added a built-in-HTTP/fetch fault proxy with three exact modes: `pass-through`, `rate-limit-once`, and `timeout-once`. Rate-limit mode returns 429 and performs zero upstream calls; timeout mode forwards once, receives the upstream response, then delays its response beyond `SENDGRID_TIMEOUT_MS`.
- Scoped fault consumption to the retained UAT workspace. A sibling workspace request passes through and leaves the armed one-shot mode untouched. The compose override publishes no host port and is absent from the production compose file.
- Added `uat05-state`, which reports ledger presence/status, queue/job identity and state, `attemptsMade`, dispatch/reconciliation timestamps and every attributed `send_events` row. It synthesizes `deferred` only when the released ledger claim is backed by a retained delayed/waiting job.
- Exercised the real deployed worker against the real SendGrid account and webhook endpoint for both failure modes, then completed the mandatory teardown and external reachability checks.

## Live Evidence

### 429 leg

- Campaign: `17e3a2bb-ddff-44af-9e32-e62852caf016`
- Stable send id: `0eb4edb8-94aa-5778-98bf-2fa4cd42c2cb`
- First dispatch claim: 2026-08-18T09:57:07.461Z
- Synthetic provider response: 429; worker log recorded `provider backoff (suggested retry in ~10000ms)` at 09:57:07.609Z
- BullMQ retry began at 09:57:09.636Z; terminal report showed `attemptCount: 2`, queue `completed`, status `sent`
- Real events: `processed` at 09:57:10Z and `delivered` at 09:57:11Z
- Mailbox result: one new copy for this leg. The one-shot no-forward invariant plus the two-attempt terminal report rules out an upstream call on the injected attempt.

### Timeout leg

- The originally prepared timeout campaign (`cbbd761c-7978-495b-8786-8a720bdefaed`, send `2ceb98e8-1aa3-5a82-a952-12afee677867`) was correctly pre-gated as `excluded/frequency_cap`; it made no provider call and produced no mailbox copy.
- After temporarily raising only the dedicated UAT workspace cap from 3 to 10, the replacement campaign was created as `0c9095c2-4d4f-4117-9a41-e33fc857fcad`.
- Stable send id: `150e82da-ca35-5b57-b0e9-3444c83f863e`
- Queued: 2026-08-18T10:02:18.657Z; dispatch claimed: 10:02:18.682Z
- Real events arrived before the delayed response: `processed` at 10:02:19Z and `delivered` at 10:02:20Z
- At the 20-second abort boundary the worker logged `classification=ambiguous`; the report showed `reconciling` from 10:02:38.688Z, `attemptCount: 1`, and no automatic retry
- The normal scheduled reconciler ran at 10:06:13.691Z with `scanned=1`, `resolvedSent=1`, `markedUnknown=0`; the terminal report then showed `sent` with both event rows
- Mailbox result: one new copy for this leg

The Phase 16 UAT thread in the operator mailbox grew from three retained messages to five during this session; the newest message was shown at 15:02 local time. Coupled with one send-specific `delivered` event for each stable send id, this is exactly two new messages total — one per live leg.

## Task Commits

1. **Task 1 RED: proxy behavior contract** — `b5cc001` (`test(uat): specify fault proxy behavior`)
2. **Task 1 GREEN: asymmetric one-shot proxy** — `3f47f38` (`feat(uat): add one-shot SendGrid fault proxy`)
3. **Task 2: compose override, state reporter and runbook** — `d0cf18b` (`feat(uat): add live fault recovery harness`)
4. **Live-discovered hardening** — `ff9306c` (`fix(uat): harden live fault recovery procedure`)

## Decisions Made

- **Do not trust the ledger alone for released claims.** A 429 deliberately deletes the temporary `dispatching` row. The retained BullMQ job and its attempt counter are the authoritative retry evidence until the next claim recreates the stable send id.
- **Do not retry ambiguity.** The timeout leg's single attempt, committed reconciling row, real events, and later reconciler verdict are the exact production safety path; any second queue attempt would have failed the UAT.
- **Preflight the frequency cap.** The send gate executes before the proxy. The runbook now requires two remaining slots or a recorded, UAT-only temporary increase with mandatory restoration.
- **Never restart UAT worker dependencies.** Every proxy/worker `up` command now carries `--no-deps`, preventing an operator-only worker restart from recreating database or Redis containers.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Protect the live leg from the frequency cap**
- **Found during:** Task 3 timeout leg
- **Issue:** The first timeout campaign was excluded before the proxy because the retained UAT contact had reached the default cap of three sent messages in 24 hours.
- **Fix:** Verified `exclusion_reason=frequency_cap`, temporarily changed only this dedicated workspace from 3 to 10, created one replacement campaign, then restored and read back 3 during teardown. The excluded campaign made zero provider calls and did not add a mailbox copy.
- **Files modified:** `docs/runbooks/uat-live-sendgrid.md`
- **Verification:** Replacement reached `reconciling -> sent`; settings UI confirmed the restored value 3.
- **Committed in:** `ff9306c`

**2. [Rule 1 - Bug] Preserve production dependencies during worker restart**
- **Found during:** Task 3 proxy activation
- **Issue:** The original `compose up -d worker` command allowed Compose to recreate `db` and `redis`. Persistent volumes retained all data, but this was broader than the intended UAT restart.
- **Fix:** Immediately recreated DB with the correct production env values, verified the UAT data and service health, then changed proxy and worker start commands to `up -d --no-deps`. All later restarts touched only worker/proxy.
- **Files modified:** `docs/runbooks/uat-live-sendgrid.md`
- **Verification:** DB, Redis, API, web and worker healthy; UAT campaigns/contact retained; `/readyz=200` after teardown.
- **Committed in:** `ff9306c`

**3. [Rule 1 - Bug] Correct the observable 429 timing contract**
- **Found during:** Task 3 429 leg
- **Issue:** The plan assumed SendGrid's ten-second `Retry-After` controlled scheduling. Production deliberately records it only as guidance and uses BullMQ's bounded two-second initial exponential backoff, so the remote cold diagnostic missed the transient `deferred` window.
- **Fix:** The runbook now documents the real timing and requires durable fallback evidence: first-attempt provider-backoff log plus terminal `attemptCount: 2`. The proxy still returns the correct header and remains one-shot/no-forward.
- **Files modified:** `docs/runbooks/uat-live-sendgrid.md`
- **Verification:** Worker log contains the 429 failure then a second processing attempt; terminal state has attemptCount 2 and one delivered event/copy.
- **Committed in:** `ff9306c`

**4. [Rule 3 - Blocking] Declare the root script's internal runtime dependency**
- **Found during:** Final lint
- **Issue:** `scripts/uat-fault-proxy.mjs` correctly imports `SENDGRID_TIMEOUT_MS` from `@mega-crm/delivery-core`, but the root manifest did not declare that workspace package, so `import-x/no-extraneous-dependencies` failed.
- **Fix:** Added `@mega-crm/delivery-core@0.1.0` as a root devDependency and removed the now-unnecessary lint suppression on the same import in `uat-verify.mjs`. No external package was installed.
- **Files modified:** `package.json`, `package-lock.json`, `scripts/uat-verify.mjs`
- **Verification:** lint and npm-10 lockfile validation pass.
- **Committed in:** `ff9306c`

---

**Total deviations:** 4 auto-fixed (2 live safety gaps, 1 timing/documentation correction, 1 manifest declaration)
**Impact on plan:** All changes strengthen the planned UAT and teardown. No production send semantics, schema, provider key or public network surface changed.

## Issues Encountered

- The first teardown attempt could not remove the bind-copied verifier from the running API container as its non-root user. The retry used container root only for that exact temporary path; the file is absent afterward.
- The connected Gmail app belonged to a different account, so mailbox verification used the already authenticated operator-mailbox Chrome session. No mailbox labels or messages were changed.
- A complete parallel `npm test` run had three API Redis timing races (two global queue-count comparisons and one shared rate-limit bucket); the other 550 API tests and every other workspace passed. Both affected files then passed in isolation (7/7 and 5/5). A full sequential API rerun passed 552/553; its only failure was the Sentry no-DSN case because that rerun omitted the required blank `SENTRY_DSN_API`, and the case passed 4/4 immediately with the same empty-env contract used by the main suite.

## Verification

- `scripts/__tests__/uat-fault-proxy.test.mjs`: 10/10 passed
- `scripts/__tests__/uat-verify.test.mjs`: 56/56 passed
- `npm run verify:prod-compose`: 59 invariants passed
- `npm run check:runbook-coverage`: passed
- `npm run check:root-hygiene`: passed
- `npm run check:lockfile-npm10`: passed under npm 10.9.9 / Node 22 image
- `npm run lint`: passed
- Full workspace run: web 84/84; worker 645/645; DB 224 passed, 2 skipped; all remaining package suites passed
- Isolated retries for the three parallel API failures: webhook signature 7/7; distributed rate limiting 5/5
- Sequential API rerun: 552/553, with the sole environment-sensitive Sentry file then passing 4/4 under `SENTRY_DSN_API=`
- Live teardown: proxy container absent; temporary scripts absent; env override keys absent; worker healthy with no override warning; public `/readyz=200`; off-host port 4180 closed

## User Setup Required

None. The live session and teardown are complete. The retained UAT workspace/campaign evidence remains available for plan 16-07's final report.

## Next Phase Readiness

- UAT-05 has complete live, CI and mailbox evidence.
- Plan 16-07 can cite both stable send ids, the exact state transitions above, the mailbox delta and the reconciler health row.
- The deployed stack is back on the original production environment with no fault proxy or endpoint override.

## Self-Check: PASSED

- All proxy/report/runbook artifacts exist and are tracked.
- All four plan commits exist in branch history.
- Both live sends are terminal `sent`; neither is left reconciling/unknown/failed.
- Exactly two new messages were observed for the two real live legs.
- No proxy container, override variable, temporary verifier or externally reachable control port remains.

---
*Phase: 16-live-sendgrid-verification*
*Completed: 2026-08-18*
