---
phase: 15-observability-alerting-frontend-resilience
verified: 2026-08-16T13:20:00Z
status: gaps_found
score: 4/5 must-haves verified
behavior_unverified: 2
overrides_applied: 0
gaps:
  - truth: "OPS-11: request_id, tenant_id (workspaceId), job_id AND send_id thread through HTTP, queue and worker"
    status: failed
    reason: >-
      requestId/jobId/workspaceId genuinely flow end-to-end (proven: campaign
      test-send route -> withCorrelation -> email-broadcast job ->
      processor-wrapper.ts -> Postgres application_name -> both Pino loggers'
      mixin()). sendId does not. `CorrelationStore.sendId` is declared in
      packages/tenant-context/src/index.ts and ARCHITECTURE.md §18 asserts
      "every log line in both processes carries the same four fields," but
      grep across apps/worker/src and apps/api/src shows zero non-test call
      site ever calls withCorrelation({ sendId: ... }) or logger.child({
      sendId }). apps/worker/src/queues/send-dispatch.ts and
      apps/worker/src/queues/webhook-events.worker.ts both use `sendId`
      extensively as a plain domain value (function returns, DB query
      params) but never bind it into the ALS correlation store or a
      structured log line; webhook-events.worker.ts has zero logger calls
      in the entire file. The only real bindings of sendId are inside
      packages/tenant-context's own unit tests. A send therefore cannot
      actually be correlated by send_id across worker log lines, contrary
      to OPS-11's literal text and ARCHITECTURE.md's own claim.
    artifacts:
      - path: packages/tenant-context/src/index.ts
        issue: "CorrelationStore.sendId is declared but has no non-test writer"
      - path: apps/worker/src/queues/send-dispatch.ts
        issue: "sendId threaded through return values/DB params only, never into withCorrelation or logger.child"
      - path: apps/worker/src/queues/webhook-events.worker.ts
        issue: "sendId used as domain value throughout; file contains zero structured logger calls, so sendId never reaches a log line"
    missing:
      - "Bind sendId into withCorrelation(...) (or logger.child({ sendId })) once a send is dispatched (send-dispatch.ts, after claim/sendId is known) and/or when webhook-events.worker.ts resolves an event to a known sendId, so send_id actually appears in structured worker log lines."
  - truth: "15-18's must_have: ARCHITECTURE.md describes the correlation model accurately"
    status: failed
    reason: >-
      ARCHITECTURE.md §18 states apps/worker's processor-wrapper.ts "opens a
      correlation scope keyed by job.data.requestId when the job schema
      carries one, falling back to the job's own id for jobs with no
      originating HTTP request." That fallback (`extractRequestId(job.data)
      ?? job.id`) was deliberately REMOVED by the post-review WR-03 fix
      (commit eaaafe0) specifically because it blurred requestId/jobId --
      current apps/worker/src/processor-wrapper.ts:196 reads
      `const requestId = extractRequestId(job.data);` with no `?? job.id`
      fallback, confirmed by reading the file and by the fix commit's own
      diff. Neither ARCHITECTURE.md nor SPECIFICATION.md was updated in
      that fix commit (`git show eaaafe0 --stat` touches only worker
      source/tests), so this section now documents behavior the codebase no
      longer has. Same section's "every log line...carries the same four
      fields" claim is also inaccurate per the sendId gap above.
    artifacts:
      - path: ARCHITECTURE.md
        issue: "§18 describes the pre-WR-03-fix requestId fallback (job.id) as current behavior, and overclaims sendId propagation"
    missing:
      - "Update ARCHITECTURE.md §18 to state requestId stays genuinely absent (not job.id) when a job payload carries none, and correct or scope down the 'four fields on every log line' claim to reflect that sendId is not currently bound anywhere."
  - truth: "CLAUDE.md's mandatory same-change documentation rule: SPECIFICATION.md must reflect current secrets-delivery mechanism"
    status: failed
    reason: >-
      SPECIFICATION.md §3 (line 483, SENTRY_DSN_API row) states the value is
      "Передаётся ЯВНО в docker-compose.prod.yml's api.environment (не через
      неявный env_file-проброс)" -- this describes the PRE-CR-01-fix
      mechanism. The CR-01 fix (commit 32d2b22) deliberately removed
      SENTRY_DSN_API/SENTRY_DSN_WORKER/SENTRY_ENVIRONMENT from the
      `environment:` blocks entirely, letting `env_file:` supply them
      instead -- confirmed by reading the current docker-compose.prod.yml
      (no SENTRY_* keys under either service's `environment:` block) and by
      `git show 32d2b22 --stat` (SPECIFICATION.md not in that commit's file
      list). The documented mechanism is the literal opposite of the
      current, actually-secure mechanism. This is a security-relevant
      secrets-delivery description read by whoever operates a real deploy.
    artifacts:
      - path: SPECIFICATION.md
        issue: "§3, SENTRY_DSN_API/SENTRY_DSN_WORKER rows describe the compose-level ${VAR} interpolation mechanism CR-01 removed"
    missing:
      - "Update SPECIFICATION.md §3's SENTRY_DSN_API/SENTRY_DSN_WORKER/SENTRY_ENVIRONMENT rows to state they are supplied exclusively via env_file: ${MEGA_CRM_ENV_FILE}, matching the current docker-compose.prod.yml."
behavior_unverified_items:
  - truth: "A render error inside any feature route is caught by RouteErrorBoundary, rendering a contained panel while the shell stays usable (15-11 truth)"
    test: "Force a render throw inside a lazy-loaded feature route (e.g. component that throws in render) while running the app in a browser/jsdom, and observe the error panel + intact nav/workspace shell"
    expected: "Contained error panel renders in place of the failing route; navigation and workspace shell remain interactive; reload/back recovers"
    why_human: "15-11's own SUMMARY (coverage D2) flags this as human_judgment: true -- no DOM test environment (jsdom/happy-dom) is installed in apps/web (vitest runs with environment: \"node\"), so only source-level wiring (grep for boundary placement, Suspense/boundary ordering in App.tsx) was verified, not an actual click-through. Verifier confirmed the same absence of a DOM env in this session."
  - truth: "Navigating away from the flow canvas with unsaved changes opens a blocking dialog; beforeunload fires natively; a failed save shows a persistent banner with working Retry (15-09 truths)"
    test: "Run apps/web/e2e/flow-unsaved-changes.spec.ts (npm run test:e2e -w apps/web -- flow-unsaved-changes.spec.ts) against a provisioned e2e database"
    expected: "4/4 Playwright tests pass (in-app nav blocked+dialog, saved-state no dialog, failed-save persistent banner+retry, native beforeunload prompt)"
    why_human: "15-09-SUMMARY.md documents this was run and passed (4/4, run twice) during execution, but the verifier did not independently re-run it in this session -- it requires provisioning a live e2e database and a real browser, outside the read-only/no-side-effect spot-check budget (Step 7b). The unit-level guard hook (useUnsavedChangesGuard) and its 84-test web suite were independently re-run and passed; the full e2e click-through was not."
human_verification:
  - test: "Force a render throw inside a lazy feature route in a real browser session and observe RouteErrorBoundary's contained panel + intact shell/navigation"
    expected: "Contained, recoverable error panel; shell/nav stay usable; no full-page blank"
    why_human: "No DOM test environment in this repo (apps/web vitest runs with environment: \"node\"); 15-11's own SUMMARY flags this exact gap as human_judgment: true"
  - test: "Run apps/web/e2e/flow-unsaved-changes.spec.ts against a live e2e database"
    expected: "4/4 Playwright tests pass, matching 15-09-SUMMARY.md's documented run"
    why_human: "Requires a provisioned e2e database and a real browser -- outside this verification session's read-only/no-side-effect budget; SUMMARY claims a passing run but that claim was not independently reproduced here"
  - test: "Provision real Sentry DSNs (SENTRY_DSN_API, SENTRY_DSN_WORKER, VITE_SENTRY_DSN) in the operator's Sentry org and confirm a real event reaches each of the three projects, tagged with workspace_id/request_id and scrubbed"
    expected: "An intentionally-thrown test error in each process appears in its own Sentry project with no secret/PII field and the correct tags"
    why_human: "Live DSNs are operator-supplied at deploy time (decision: proceed-live-dsn) -- cannot be exercised from a code-only verification pass"
  - test: "Provision Grafana Cloud Loki push credentials and the two documented backstop alert rules (no-logs dead-man's-switch, error-rate spike), then confirm logs actually arrive and both rules fire correctly"
    expected: "Loki receives structured JSON log lines from all three prod-compose services via Alloy; both alert rules trigger on their documented conditions"
    why_human: "Live Grafana Cloud stack/credentials provisioning is an operator setup step outside this repository's automatable scope"
---

# Phase 15: Observability, Alerting & Frontend Resilience Verification Report

**Phase Goal:** The system reports its true state — to an operator through structured logs, correlated traces and alerts, and to a user through honest error, empty and stale states.
**Verified:** 2026-08-16
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A single send can be followed from HTTP request through queue job to Postgres query using one correlation identifier, in structured API/worker logs reaching the hosted log provider | ✓ VERIFIED (with one named-field gap, see Requirements Coverage OPS-11) | `packages/tenant-context/src/index.ts`'s `withCorrelation`/`withTenantTransaction` merge-forward ALS; `apps/api/src/server.ts:159-177` binds `requestId` via `genReqId`/`withCorrelation` on every request; `apps/api/src/modules/campaigns/campaigns.routes.ts:477-486` carries it onto the enqueued `email-broadcast` job; `apps/worker/src/processor-wrapper.ts:196-202` rebinds `{jobId, requestId}` for every job; both Pino loggers' `mixin()` stamp it on every line; `withTenantTransaction` composes it into Postgres `application_name`. `docker/alloy/config.alloy` ships stdout to Grafana Cloud Loki. **Gap:** `send_id`, the fourth identifier OPS-11 names explicitly, is declared on `CorrelationStore` but never bound by any production call site (see gaps). |
| 2 | An exception from frontend/API/worker reaches Sentry tagged with tenant+request, and a test proves no SendGrid key/contact email/freeform JSONB reaches it | ✓ VERIFIED | `packages/redaction/src/sentry-scrub.ts`'s `sentryBeforeSend` delegates to depth-unbounded `scrub()`; `packages/redaction/src/__tests__/sentry-scrub-fixtures.test.ts` (234 lines) fixtures a decrypted SendGrid key, contact email/phone, and freeform nested JSONB and asserts zero plaintext survives; wired as a blocking CI step (`ci.yml` "Sentry redaction fixture gate (OPS-09)"); `apps/api/src/sentry.ts`/`apps/worker/src/sentry.ts`/`apps/web/src/lib/sentry.ts` all pass `sentryBeforeSend` as `beforeSend`/`beforeSendTransaction`; tags read from ALS correlation context. All 29 `packages/redaction` tests pass (re-run this session). |
| 3 | Alerts fire on queue depth, oldest job age, webhook lag, failed-send share; Bull Board reachable only behind admin access; a runbook exists per alert | ✓ VERIFIED | All 9 watchdogs (5 pre-existing + 4 new: `queue-depth-watchdog.ts`, `oldest-job-age-watchdog.ts`, `webhook-lag-watchdog.ts`, `failed-send-share-watchdog.ts`) wired at API boot in `apps/api/src/server.ts`, sharing `claimOpsAlertSlot` (migration 0064, `ops_alert_state`). Bull Board mounted read-only (`readOnlyMode: true`, `apps/worker/src/bull-board.ts:42`) on the worker's loopback-only (`127.0.0.1`, never `0.0.0.0`) health listener; `docker-compose.prod.yml` publishes no port for `worker`; access is SSH-tunnel only per `docs/runbooks/bull-board-access.md`. `node scripts/check-runbook-coverage.mjs` passes (exit 0): all 4 new alert names have a matching runbook. `npm run verify:prod-compose` passes (43 invariants). |
| 4 | The app loads with route-level code splitting — canvas/heavy-dashboard chunks arrive only when opened | ✓ VERIFIED | All 25 feature routes in `apps/web/src/App.tsx` use `React.lazy`. Real production build (`npm run build -w apps/web`, re-run this session) emits distinct `canvas-vendor-*.js` (81.22 kB) and `charts-vendor-*.js` (240.89 kB) chunks; `dist/index.html`'s only script tag is the entry bundle — neither vendor chunk is referenced there. `node scripts/check-web-chunks.mjs` passes (exit 0, re-run this session). |
| 5 | A failed API call, empty list, paginated list, stale analytics and unsaved canvas changes each show the user what is true, not a blank/silently-wrong screen | ✓ VERIFIED | `QueryErrorState`/`EmptyState` (visually/textually distinct: destructive border+Retry vs plain card, no Retry) used across contacts/segments/send-log/campaigns/flows/dashboard/team/settings pages; `ContactsListPage.tsx`/`SendLogPage.tsx` pagination disables at both bounds (`disabled={page <= 1}` / `disabled={page >= totalPages}`) and reports real totals. `StaleDataBanner`/`DataAsOfLabel` read real DB-sourced `lagMinutes`/`dataAsOf` from `dashboard.repository.ts`'s live `dirtied_at`/watermark queries, never render stale on a quiet workspace (`lagMinutes === null` check), never hide the numbers. `useUnsavedChangesGuard` (data-router `useBlocker` + `beforeunload`) and `SaveErrorBanner` (persistent, Retry, never a toast) wired into `FlowCanvas.tsx`. All three post-review fixes (WR-01 `App.tsx` RootRedirect isError branch, WR-02 `FlowAnalyticsTable` isFullyErrored/isStaleErrored split) confirmed present in current source. **Two behaviors present+wired but not behaviorally re-proven this session** — see behavior_unverified_items (error boundary click-through, canvas e2e). |

**Score:** 4/5 truths cleanly verified; SC1 verified with one named-field gap (send_id) tracked separately under Requirements Coverage/gaps rather than failing the whole criterion (requestId/jobId/workspaceId correlation is real and proven end-to-end).

### Required Artifacts (spot-checked, not exhaustive — 18 plans, ~100+ files)

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/tenant-context/src/index.ts` | Merge-safe correlation ALS store | ✓ VERIFIED | `withTenant`/`withCorrelation` spread-forward confirmed by reading source; `application_name` byte-budget truncation present |
| `apps/api/src/logger.ts`, `apps/worker/src/logger.ts` | Pino + redaction + correlation mixin | ✓ VERIFIED | Byte-identical construction confirmed by reading both files |
| `apps/worker/src/processor-wrapper.ts` | Single instrumentation point, control-flow allowlist, error-reporter seam | ✓ VERIFIED (post WR-03 fix) | No `?? job.id` fallback; re-throws unchanged on every path; confirmed by reading current source |
| `packages/redaction/src/sentry-scrub.ts` + fixture test | Depth-unbounded Sentry scrub, blocking CI gate | ✓ VERIFIED | Fixture test 234 lines, CI step confirmed in `ci.yml`, 29/29 redaction tests pass |
| `apps/api/src/sentry.ts`, `apps/worker/src/sentry.ts` | DSN-optional init, redaction wired, `\|\|` not `??` for environment fallback (CR-01) | ✓ VERIFIED | Both files use `\|\|` (line 96/87); `docker-compose.prod.yml` no longer routes these 3 vars through `environment:` |
| `apps/web/src/lib/sentry.ts`, `RouteErrorBoundary.tsx` | Errors-only capture, contained route boundary | ✓ VERIFIED (wiring); ⚠️ click-through unverified | Source-level wiring confirmed; runtime click-through not re-run (see behavior_unverified_items) |
| `apps/api/src/modules/ops/{queue-depth,oldest-job-age,webhook-lag,failed-send-share}-watchdog.ts` | 4 new OPS-13 watchdogs | ✓ VERIFIED | All wired in `server.ts`; shared `claimOpsAlertSlot` |
| `apps/worker/src/bull-board.ts`, `health-server.ts` | Read-only board on loopback listener | ✓ VERIFIED | `readOnlyMode: true`; `WORKER_HEALTH_HOST = "127.0.0.1"`; no published port in compose |
| `docker/alloy/config.alloy` | Log shipping to Grafana Cloud Loki | ✓ VERIFIED (config); ? provisioning unverified | Config correct (https, no literal token, low-cardinality labels); live push requires operator-provisioned Loki credentials |
| `docs/runbooks/*.md` + `scripts/check-runbook-coverage.mjs` | Runbook per alert, CI-enforced coverage | ✓ VERIFIED | Gate passes (4/4 alerts covered); re-run this session |
| `apps/web/src/App.tsx`, `vite.config.ts`, `scripts/check-web-chunks.mjs` | Route-level code splitting | ✓ VERIFIED | Real build + chunk-boundary script both re-run and passed this session |
| `apps/web/src/components/{QueryErrorState,EmptyState,StaleDataBanner,DataAsOfLabel}.tsx` | Shared error/empty/staleness UI | ✓ VERIFIED | Distinct styling confirmed by reading source; real DB-backed data flow traced through `dashboard.repository.ts` |
| `apps/web/src/features/flows/canvas/{useUnsavedChangesGuard.ts,UnsavedChangesDialog.tsx,SaveErrorBanner.tsx}` | Unsaved-changes guard + save-error banner | ✓ VERIFIED (wiring + unit tests); ⚠️ e2e not re-run | Guard hook logic matches must_haves exactly; e2e claimed-passing in SUMMARY, not independently re-executed |
| `ARCHITECTURE.md` §18 (correlation model) | Accurate description of correlation model | ✗ STALE | Describes a `requestId ?? job.id` fallback the WR-03 fix (commit `eaaafe0`) removed, and overclaims "every log line...carries the same four fields" (sendId is not actually bound anywhere) |
| `SPECIFICATION.md` §3 (Sentry secrets) | Accurate description of secrets delivery | ✗ STALE | Describes the pre-CR-01-fix compose-level `environment:` delivery mechanism the CR-01 fix (commit `32d2b22`) removed |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `apps/api/src/server.ts` onRequest hook | `packages/tenant-context` ALS | `withCorrelation({requestId: request.id})` | ✓ WIRED | Confirmed line 177 |
| `campaigns.routes.ts` test-send route | `email-broadcast` BullMQ queue | `requestId` on enqueued job payload | ✓ WIRED | Lines 477-486 |
| `apps/worker/src/queues/*.worker.ts` factories | `processor-wrapper.ts`'s `wrapProcessor` | Every `create*Worker` routes through it | ✓ WIRED | Per 15-08 plan's own enumeration test (not independently re-run, but source-confirmed via processor-wrapper.ts inspection) |
| `send-dispatch.ts` / `webhook-events.worker.ts` | correlation ALS (`sendId`) | `withCorrelation({sendId})` or `logger.child({sendId})` | ✗ NOT WIRED | Zero non-test call sites bind `sendId` anywhere (see gaps) |
| `sentryBeforeSend` | `scrub()` (packages/redaction) | Direct delegation, no second implementation | ✓ WIRED | Confirmed by reading `sentry-scrub.ts` |
| `apps/worker`'s watchdogs | `apps/api` process (not `apps/worker`) | All 9 watchdogs live in `apps/api/src/server.ts` | ✓ WIRED | Confirmed — dead-man's-switch discipline preserved |
| `WorkspaceDashboard.tsx` | `dashboard.repository.ts`'s live `dirtied_at`/watermark query | `lagMinutes`/`dataAsOf` fields | ✓ WIRED, data flowing | Real DB query (`min(dirtied_at)`, rollup watermark reduce), not static |
| `useUnsavedChangesGuard` | React Router `useBlocker` | Requires data router (15-03 migration) | ✓ WIRED | `createBrowserRouter`/`RouterProvider` confirmed in place, prerequisite satisfied |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `WorkspaceDashboard.tsx` | `data.lagMinutes`, `data.dataAsOf` | `apps/api/src/modules/analytics/dashboard.repository.ts` (`min(dirtied_at)`, rollup watermark reduce over real rows) | Yes | ✓ FLOWING |
| `bull-board.ts` | Queue job counts | Real `Queue` handles constructed from `board-queues.ts`'s queue-name constants | Yes | ✓ FLOWING |
| `queue-depth-watchdog.ts` / `oldest-job-age-watchdog.ts` | BullMQ counts/ages | Real `queue-monitor.ts` reads against live Redis-backed queues | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Worker processor-wrapper WR-03 fix + Sentry tag + correlation tests | `npx vitest run --root apps/worker src/__tests__/{processor-wrapper,sentry,correlation-tracer}.test.ts` | 3 files, 17 tests passed | ✓ PASS |
| Full apps/web unit suite (includes App.tsx/FlowAnalyticsTable fix regression) | `npx vitest run --root apps/web` | 13 files, 84 tests passed | ✓ PASS |
| Redaction (pino + Sentry scrub fixtures) full suite | `npx vitest run --root packages/redaction` | 5 files, 29 tests passed | ✓ PASS |
| Migration 0064/0065 correctness | `npm run test:migrations` | 27 passed / 1 skipped (28 files), 224 passed / 2 skipped | ✓ PASS |
| Prod compose invariants (incl. CR-01 fix) | `npm run verify:prod-compose` | 8 services, 43 invariants OK | ✓ PASS |
| Runbook coverage gate | `node scripts/check-runbook-coverage.mjs` | 4/4 alerts covered, exit 0 | ✓ PASS |
| Web production build + chunk boundary gate | `npm run build -w apps/web && node scripts/check-web-chunks.mjs` | canvas-vendor/charts-vendor isolated, exit 0 | ✓ PASS |
| Debt-marker scan (TBD/FIXME/XXX) over 104 reviewed files | `grep -E "TBD\|FIXME\|XXX"` | No matches | ✓ PASS |
| RouteErrorBoundary click-through | n/a — requires DOM env / browser | not run | ? SKIP (see human_verification) |
| Canvas unsaved-changes e2e (Playwright) | `npm run test:e2e -w apps/web -- flow-unsaved-changes.spec.ts` | not run (requires live e2e DB) | ? SKIP (see human_verification) |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| OPS-06 | 15-01, 15-02, 15-08 | Worker logs structurally via Pino | ✓ SATISFIED | `apps/worker/src/logger.ts` + `processor-wrapper.ts` instrumentation |
| OPS-07 | 15-04 | Redaction uniform across worker/API | ✓ SATISFIED | `rules-parity.test.ts`/`logger-uniformity.test.ts` pass (part of 29/29 redaction suite) |
| OPS-08 | 15-01, 15-10, 15-11 | Sentry captures frontend/API/worker exceptions | ✓ SATISFIED | 3 SDK inits confirmed; CR-01 fix confirmed applied |
| OPS-09 | 15-06 | Secrets/PII proven absent from Sentry by test | ✓ SATISFIED | Fixture test + blocking CI gate confirmed |
| OPS-10 | 15-17 | Logs reach hosted provider with alerts configured | ✓ SATISFIED (config); provisioning unverified | Alloy config correct; live push is operator setup (human_verification) |
| OPS-11 | 15-02 | request_id/tenant_id/job_id/**send_id** thread through HTTP, queue, worker | ⚠️ PARTIAL | requestId/jobId/workspaceId proven end-to-end; **send_id never bound in any production call site** (gap) |
| OPS-12 | 15-02 | Trace correlation links HTTP/job/Postgres | ✓ SATISFIED | `application_name` composition confirmed |
| OPS-13 | 15-12, 15-13, 15-14 | Alerts on queue depth/oldest job age/webhook lag/failed-send share | ✓ SATISFIED | All 4 watchdogs wired, shared dedup primitive confirmed |
| OPS-14 | 15-01, 15-16 | Bull Board behind closed admin access | ✓ SATISFIED | Read-only, loopback-only, no published port |
| OPS-15 | 15-18 | Runbooks describe incidents/recovery | ⚠️ PARTIAL | Runbook coverage gate passes for the 4 alert runbooks, but the ARCHITECTURE.md must-have this same plan owns ("describes the correlation model...") is stale post-fix (gap) |
| OPS-16 | 15-03 | Route-level code splitting | ✓ SATISFIED | Build + gate script both re-run, passed |
| OPS-17 | 15-05, 15-07, 15-11 | Frontend handles errors/empty/pagination correctly | ✓ SATISFIED | Shared components + fixes (WR-01/WR-02) confirmed in current source |
| OPS-18 | 15-12, 15-15 | Stale analytics shown honestly | ✓ SATISFIED | Real watermark/lag data flow confirmed |
| OPS-19 | 15-09 | Unsaved canvas changes warn; save errors visible | ✓ SATISFIED (wiring); e2e re-confirmation pending | Guard hook + banner logic confirmed; e2e not independently re-run this session |

No orphaned requirements — all 14 IDs mapped to REQUIREMENTS.md Phase 15 row are claimed by at least one plan.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `ARCHITECTURE.md` | §18 (~l.371) | Stale description of `processor-wrapper.ts`'s `requestId` fallback (removed by WR-03 fix, doc not updated) | 🛑 Treated as gap (tied to 15-18 must-have) | Misleads an operator reading the correlation-model doc about actual current behavior |
| `SPECIFICATION.md` | §3, l.483 | Stale description of `SENTRY_DSN_API`/`SENTRY_DSN_WORKER` delivery mechanism (pre-CR-01, doc not updated in the same fix commit) | 🛑 Treated as gap (violates CLAUDE.md's mandatory same-change documentation rule) | Misleads an operator about the actual (now-correct) secrets delivery path |
| `apps/api/src/modules/ops/webhook-lag-watchdog.ts` | 104-198 | Platform-wide `MAX(last_event_at)` signal can mask one dead tenant webhook behind another healthy one (REVIEW.md IN-01) | ℹ️ Info (deliberate, documented scope choice) | Runbook should note this limitation; not a functional defect |
| `packages/db/src/migration-tiers.ts` | 63-64 | Stale file-count comment (63 vs actual 65) (REVIEW.md IN-02) | ℹ️ Info (cosmetic) | No behavior depends on it |
| `apps/web/src/features/campaigns/TemplateSenderPickers.tsx` | 67-114, 180-226 | Duplicate error-state render when popover open + empty (REVIEW.md IN-03) | ℹ️ Info (cosmetic) | Minor UI duplication, not a correctness defect |

No TBD/FIXME/XXX debt markers found across the 104 phase-reviewed source files (re-scanned this session).

### Human Verification Required

1. **RouteErrorBoundary click-through** — Force a render error inside a lazy feature route in a real browser and confirm the contained panel + intact shell. No DOM test env exists in this repo (`environment: "node"` for `apps/web` vitest); 15-11's own SUMMARY already flags this as `human_judgment: true`.
2. **Canvas unsaved-changes e2e** — Run `apps/web/e2e/flow-unsaved-changes.spec.ts` against a provisioned e2e database and confirm 4/4 pass, matching what 15-09-SUMMARY.md documents but this session did not independently reproduce.
3. **Live Sentry DSN provisioning** — Configure real DSNs for the three Sentry projects and confirm a real event reaches each, tagged correctly, with nothing sensitive leaking (operator-supplied, decision: proceed-live-dsn).
4. **Live Grafana Cloud/Loki provisioning** — Configure real Loki push credentials and the two documented backstop alert rules, and confirm both logs arrival and alert firing (operator setup, outside repo scope).

### Gaps Summary

Three concrete gaps block a clean pass, all narrower than the phase's overall architecture (which is sound and well-tested):

1. **OPS-11's send_id is a declared-but-dead field.** The correlation model genuinely threads `requestId`/`jobId`/`workspaceId` end-to-end (proven by tests and by reading the actual call sites), but `send_id` — the fourth identifier the requirement names explicitly — is never bound by any production code path. `send-dispatch.ts` and `webhook-events.worker.ts` both manipulate `sendId` as a plain database/domain value but never route it through `withCorrelation` or a structured log line. An operator cannot actually grep a Loki correlation query by `sendId` today, despite ARCHITECTURE.md claiming otherwise.
2. **Two docs went stale because their owning fix commits didn't update them in the same change**, violating this project's own CLAUDE.md mandate ("при добавлении/изменении ... дописать в SPECIFICATION.md в том же изменении"): ARCHITECTURE.md §18 still describes a `requestId ?? job.id` fallback the WR-03 fix removed, and SPECIFICATION.md §3 still describes the pre-CR-01-fix Sentry-DSN delivery mechanism the CR-01 fix replaced. Both are one-paragraph corrections, not code changes.
3. Two behaviors are **present and wired but not behaviorally re-confirmed this session** (route error boundary click-through, canvas e2e) — these are `human_needed` items, not gaps, since the underlying code is genuinely there and (per SUMMARY, for the e2e case) was previously exercised; they're listed for completeness since they factor into overall status.

Everything else — the correlation backbone (minus send_id), Sentry+redaction gate, all 4 new alert watchdogs + Bull Board access control + runbook coverage, route-level code splitting, and the frontend error/empty/pagination/staleness/unsaved-changes UI (including all three post-review fixes CR-01/WR-01/WR-02/WR-03) — is verified against the current codebase, not just SUMMARY claims, including re-running the relevant test suites, the production build, and the CI gate scripts in this session.

---

_Verified: 2026-08-16_
_Verifier: Claude (gsd-verifier)_
