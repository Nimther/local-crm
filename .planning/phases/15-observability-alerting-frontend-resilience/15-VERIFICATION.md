---
phase: 15-observability-alerting-frontend-resilience
verified: 2026-08-16T15:25:00Z
status: human_needed
score: 5/5 must-haves verified
behavior_unverified: 2
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/5
  gaps_closed:
    - "OPS-11: request_id, tenant_id (workspaceId), job_id AND send_id thread through HTTP, queue and worker (send_id half — closed by plans 15-19/15-20)"
    - "15-18's must_have: ARCHITECTURE.md describes the correlation model accurately (closed by plan 15-21, Task 1)"
    - "CLAUDE.md's mandatory same-change documentation rule: SPECIFICATION.md must reflect current secrets-delivery mechanism (closed by plan 15-21, Task 2)"
  gaps_remaining: []
  regressions: []
behavior_unverified_items:
  - truth: "A render error inside any feature route is caught by RouteErrorBoundary, rendering a contained panel while the shell stays usable (15-11 truth)"
    test: "Force a render throw inside a lazy-loaded feature route (e.g. component that throws in render) while running the app in a browser/jsdom, and observe the error panel + intact nav/workspace shell"
    expected: "Contained error panel renders in place of the failing route; navigation and workspace shell remain interactive; reload/back recovers"
    why_human: "15-11's own SUMMARY (coverage D2) flags this as human_judgment: true — no DOM test environment (jsdom/happy-dom) is installed in apps/web (vitest runs with environment: \"node\"), so only source-level wiring was verified, not an actual click-through. This gap-closure diff (e1ac2cc..HEAD) touches zero apps/web files, so this item carries forward unchanged from the prior verification."
  - truth: "Navigating away from the flow canvas with unsaved changes opens a blocking dialog; beforeunload fires natively; a failed save shows a persistent banner with working Retry (15-09 truths)"
    test: "Run apps/web/e2e/flow-unsaved-changes.spec.ts (npm run test:e2e -w apps/web -- flow-unsaved-changes.spec.ts) against a provisioned e2e database"
    expected: "4/4 Playwright tests pass (in-app nav blocked+dialog, saved-state no dialog, failed-save persistent banner+retry, native beforeunload prompt)"
    why_human: "15-09-SUMMARY.md documents this was run and passed (4/4, run twice) during execution, but this session did not independently re-run it — it requires provisioning a live e2e database and a real browser, outside the read-only/no-side-effect spot-check budget (Step 7b). This gap-closure diff touches zero apps/web files, so this item carries forward unchanged from the prior verification."
overrides: []
human_verification:
  - test: "Force a render throw inside a lazy feature route in a real browser session and observe RouteErrorBoundary's contained panel + intact shell/navigation"
    expected: "Contained, recoverable error panel; shell/nav stay usable; no full-page blank"
    why_human: "No DOM test environment in this repo (apps/web vitest runs with environment: \"node\"); 15-11's own SUMMARY flags this exact gap as human_judgment: true"
  - test: "Run apps/web/e2e/flow-unsaved-changes.spec.ts against a live e2e database"
    expected: "4/4 Playwright tests pass, matching 15-09-SUMMARY.md's documented run"
    why_human: "Requires a provisioned e2e database and a real browser — outside this verification session's read-only/no-side-effect budget; SUMMARY claims a passing run but that claim was not independently reproduced here"
  - test: "Provision real Sentry DSNs (SENTRY_DSN_API, SENTRY_DSN_WORKER, VITE_SENTRY_DSN) in the operator's Sentry org and confirm a real event reaches each of the three projects, tagged with workspace_id/request_id and scrubbed"
    expected: "An intentionally-thrown test error in each process appears in its own Sentry project with no secret/PII field and the correct tags"
    why_human: "Live DSNs are operator-supplied at deploy time (decision: proceed-live-dsn) — cannot be exercised from a code-only verification pass"
  - test: "Provision Grafana Cloud Loki push credentials and the two documented backstop alert rules (no-logs dead-man's-switch, error-rate spike), then confirm logs actually arrive and both rules fire correctly"
    expected: "Loki receives structured JSON log lines from all three prod-compose services via Alloy; both alert rules trigger on their documented conditions"
    why_human: "Live Grafana Cloud stack/credentials provisioning is an operator setup step outside this repository's automatable scope"
---

# Phase 15: Observability, Alerting & Frontend Resilience Verification Report

**Phase Goal:** The system reports its true state — to an operator through structured logs, correlated traces and alerts, and to a user through honest error, empty and stale states.
**Verified:** 2026-08-16
**Status:** human_needed
**Re-verification:** Yes — after gap closure (plans 15-19, 15-20, 15-21)

## Re-Verification Summary

The prior verification (superseded, committed at `e1ac2cc`) found `status: gaps_found` with three gaps (G-15-1 sendId dispatch+webhook, G-15-2 ARCHITECTURE.md §18 stale, G-15-3 SPECIFICATION.md §3 stale). This session independently re-verified all three closure plans (15-19, 15-20, 15-21) against the actual current codebase — not the SUMMARYs' claims — by reading the modified source, re-running every named test the plans reference, and re-running the doc-region grep/node-oneliner gates directly.

**All three gaps are closed.** No regressions found in the touched surface or in the broader test suites re-run this session (apps/web unit suite, packages/redaction suite, packages/tenant-context application-name suite, all send-dispatch and webhook-events regression suites).

**Scope of this diff** (`git diff --name-only e1ac2cc..HEAD -- . ':!.planning/'`): exactly 7 files — `ARCHITECTURE.md`, `SPECIFICATION.md`, `apps/worker/src/__tests__/correlation-tracer.test.ts`, `apps/worker/src/queues/__tests__/send-dispatch-error-listener.test.ts` (merge-conflict mock fix, see Anti-Patterns), `apps/worker/src/queues/__tests__/webhook-events-sendid-correlation.test.ts`, `apps/worker/src/queues/send-dispatch.ts`, `apps/worker/src/queues/webhook-events.worker.ts`. Nothing in `apps/web` changed, so the two behavior-unverified items from the prior report (RouteErrorBoundary click-through, canvas e2e) are unaffected and carry forward unchanged — they were never in scope for this gap-closure wave.

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A single send can be followed from HTTP request through queue job to Postgres query using one correlation identifier, in structured API/worker logs reaching the hosted log provider | ✓ VERIFIED (gap closed — all four identifiers) | `requestId`/`jobId`/`workspaceId` proven end-to-end as before. **`send_id` gap now closed**: `apps/worker/src/queues/send-dispatch.ts` opens 3 `withCorrelation({ sendId ... })` scopes (campaign L476, test L596, flow L764) each immediately followed by a `logger.info(...)` call (L477/597/765) and `handleAmbiguousSendMailError`'s `logger.warn` (L377) runs inside those scopes; `apps/worker/src/queues/webhook-events.worker.ts` opens 1 per-event `withCorrelation({ sendId: send.id })` scope (L810) immediately after the `if (!send) continue;` re-check (L804), with `logger.info` at L811. Independently re-ran `npx vitest run --root apps/worker src/__tests__/correlation-tracer.test.ts` (3/3 pass, including the new test asserting the log line's `sendId` is byte-identical to the SendGrid `custom_args.send_id`) and `npx vitest run --root apps/worker src/queues/__tests__/webhook-events-sendid-correlation.test.ts` (3/3 pass, including the two-distinct-sendId-per-batch proof). |
| 2 | An exception from frontend/API/worker reaches Sentry tagged with tenant+request, and a test proves no SendGrid key/contact email/freeform JSONB reaches it | ✓ VERIFIED | Unchanged since prior verification; re-ran `npx vitest run --root packages/redaction` this session — 5 files, 29/29 tests pass. |
| 3 | Alerts fire on queue depth, oldest job age, webhook lag, failed-send share; Bull Board reachable only behind admin access; a runbook exists per alert | ✓ VERIFIED | Unchanged since prior verification; re-ran `node scripts/check-runbook-coverage.mjs` this session — 4/4 alerts covered, exit 0. |
| 4 | The app loads with route-level code splitting — canvas/heavy-dashboard chunks arrive only when opened | ✓ VERIFIED | Unchanged since prior verification. Not rebuilt this session (this diff touches zero `apps/web` files — `git diff --name-only e1ac2cc..HEAD` confirms), but the apps/web unit suite was re-run green (84/84) as a regression check. |
| 5 | A failed API call, empty list, paginated list, stale analytics and unsaved canvas changes each show the user what is true, not a blank/silently-wrong screen | ✓ VERIFIED (two behaviors present+wired but not behaviorally re-proven — see below) | Unchanged since prior verification (this diff touches zero `apps/web` files). `QueryErrorState`/`EmptyState`/`StaleDataBanner`/`DataAsOfLabel`/`useUnsavedChangesGuard`/`SaveErrorBanner` all confirmed present and wired in the prior session. **Two behaviors remain present+wired but not behaviorally re-confirmed this session** (RouteErrorBoundary click-through, canvas e2e) — tracked under behavior_unverified_items, unaffected by this gap-closure wave. |

**Score:** 5/5 truths verified — up from 4/5 in the prior report. SC1 now cleanly closes (all four correlation identifiers proven, not three); SC5 keeps its two behavior-unverified sub-items tracked separately (they do not block SC5's own VERIFIED status, since the code they describe is present and wired — only the runtime click-through/e2e re-confirmation is outstanding).

### Gap Closure Detail (this session's independent verification)

**G-15-1 (OPS-11 send_id) — CLOSED.**

| Check | Command | Result |
|---|---|---|
| Dispatch bindings count | `grep -c 'withCorrelation({ sendId' apps/worker/src/queues/send-dispatch.ts` | 3 (campaign L476, test L596, flow L764) |
| Dispatch log call-sites | `grep -nE 'logger\.(info\|warn\|error)\('` (non-comment) over send-dispatch.ts | 4 (L377, L477, L597, L765) |
| No PII in dispatch log calls | `grep -cE 'claim\.to\|testTo\|dynamicTemplateData\|apiKey\|\.email'` over those 4 lines | 0 |
| `composeApplicationName` unaffected | node one-liner reading `packages/tenant-context/src/index.ts` | no `sendId` reference — unchanged |
| Dispatch test suite | `npx vitest run --root apps/worker src/__tests__/correlation-tracer.test.ts` | 3/3 PASS (re-run this session) |
| Webhook binding count | `grep -c 'withCorrelation({ sendId' apps/worker/src/queues/webhook-events.worker.ts` | 1 (L810) |
| Webhook log call-site | `grep -nE 'logger\.(info\|warn\|error)\('` (non-comment) over webhook-events.worker.ts | 1 (L811) |
| No PII in webhook log call | `grep -cE 'row\.reason\|row\.payload\|rawEvent\|\.email'` | 0 |
| `scrubbedConsole` site preserved | `grep -c 'scrubbedConsole'` | 5 (untouched) |
| Webhook binding placement | Read source directly (L775-818) | Scope opens exactly after the `if (!send) continue;` guard (L804), wraps only `applyEventSideEffects` |
| Webhook test suite | `npx vitest run --root apps/worker src/queues/__tests__/webhook-events-sendid-correlation.test.ts` | 3/3 PASS (re-run this session) |
| Regression: 4 pre-existing webhook suites | `npx vitest run` on webhook-events-status/idempotency/sibling-drop/open-click-counts | 22/22 PASS (re-run this session) |
| Regression: send-dispatch suites | durability + idempotency + error-listener | 11 + 3 = 14/14 PASS (re-run this session) |
| Regression: application-name suite | `packages/tenant-context/src/__tests__/application-name-correlation.test.ts` | 7/7 PASS (re-run this session) |
| Type-check | `npx tsc -p apps/worker/tsconfig.json --noEmit` | exits 0 |

**G-15-2 (ARCHITECTURE.md §18 stale) — CLOSED.**

Region-scoped node check over `## 18. The correlation model` .. `## 19. Error-tracking topology`: banned literals (`"falling back to the job"`, `"the same four fields"`) — both absent. Required citations (`processor-wrapper.ts`, `send-dispatch.ts`, `webhook-events.worker.ts`, `WR-03`, `req=-`) — all present. Read the section directly: it now states `requestId` stays genuinely unbound (no `job.id` substitution) when a job payload carries none, cites `processor-wrapper.ts:196` by name, and gives a per-field presence/absence table for `workspaceId`/`requestId`/`jobId`/`sendId` including the correct post-15-19/15-20 boundary (sendId bound in the 3 dispatch scopes + 1 webhook scope, absent from `wrapProcessor`'s own completion/failure lines and from all `apps/api` lines). Independently confirmed `processor-wrapper.ts:196` reads `const requestId = extractRequestId(job.data);` with no `?? job.id` fallback — matches the doc's claim exactly.

**G-15-3 (SPECIFICATION.md §3 stale) — CLOSED.**

Region-scoped node check over `## 3. Секреты` .. `## 4. Схема данных`: banned literals (`"Передаётся ЯВНО"`, `"не через неявный"`) — both absent. All three Sentry rows (`SENTRY_DSN_API`, `SENTRY_DSN_WORKER`, `SENTRY_ENVIRONMENT`) name `env_file`, name `MEGA_CRM_ENV_FILE`, and carry the `план 15-21` tag. `IMAGE_TAG` compose-interpolation exception still noted. No DSN-shaped literal anywhere in the file (`grep -cE 'https://[0-9a-zA-Z]+@[a-z0-9.-]*(sentry|ingest)'` → 0). Independently re-checked the underlying fact against `docker/docker-compose.prod.yml` directly (not just the doc's claim about it): zero non-comment lines assign any of the three names inside either service's `environment:` block — the doc now matches the actual compose file. `npm run check:spec-env-coverage` (53 names, all present) and `npm run verify:prod-compose` (8 services, 43 invariants) both re-run and pass.

### Required Artifacts (spot-checked, focused on the gap-closure diff)

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `apps/worker/src/queues/send-dispatch.ts` | 3 sendId correlation scopes + 4 log call sites | ✓ VERIFIED | Confirmed by direct read + grep; all inside scope, none logs PII |
| `apps/worker/src/queues/webhook-events.worker.ts` | 1 per-event sendId scope + 1 log call site | ✓ VERIFIED | Confirmed by direct read; placed exactly after live-send re-check |
| `apps/worker/src/__tests__/correlation-tracer.test.ts` | 3rd test proving sendId on captured log line | ✓ VERIFIED | Re-ran, 3/3 pass |
| `apps/worker/src/queues/__tests__/webhook-events-sendid-correlation.test.ts` | New suite, per-event proof | ✓ VERIFIED | Re-ran, 3/3 pass |
| `ARCHITECTURE.md` §18 | Accurate correlation model description | ✓ VERIFIED (was ✗ STALE) | Rewritten; matches `processor-wrapper.ts:196` and both new binding sites exactly |
| `SPECIFICATION.md` §7, §3 | Accurate correlation + Sentry-secrets description | ✓ VERIFIED (was ✗ STALE) | Both sections rewritten; matches `docker-compose.prod.yml` and the code exactly |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `send-dispatch.ts` (3 paths) | correlation ALS (`sendId`) | `withCorrelation({ sendId })` | ✓ WIRED (was ✗ NOT WIRED) | All 3 scopes confirmed opened at the correct point, each followed by a log call inside the scope |
| `webhook-events.worker.ts` per-event loop | correlation ALS (`sendId`) | `withCorrelation({ sendId: send.id })` | ✓ WIRED (was ✗ NOT WIRED) | Confirmed opened immediately after `if (!send) continue;`, wraps only `applyEventSideEffects` |
| `handleAmbiguousSendMailError` | inherited `sendId` scope | Called from inside campaign (L530) and flow (L812) `withCorrelation` scopes | ✓ WIRED | Confirmed both call sites sit inside their respective scopes |
| `ARCHITECTURE.md` §18 | `apps/worker/src/queues/send-dispatch.ts` / `webhook-events.worker.ts` | Doc cites both files by name with the correct per-field boundary | ✓ WIRED | Confirmed doc text matches code exactly, not paraphrased |
| `SPECIFICATION.md` §3 Sentry rows | `docker/docker-compose.prod.yml` | `env_file: ${MEGA_CRM_ENV_FILE}` | ✓ WIRED | Confirmed doc claim against the compose file directly — no `environment:` block assignment for any of the three names |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Dispatch-side sendId correlation (G-15-1 dispatch half) | `npx vitest run --root apps/worker src/__tests__/correlation-tracer.test.ts` | 3 tests passed | ✓ PASS |
| Webhook-side sendId correlation (G-15-1 webhook half) | `npx vitest run --root apps/worker src/queues/__tests__/webhook-events-sendid-correlation.test.ts` | 3 tests passed | ✓ PASS |
| Webhook regression (4 pre-existing suites) | `npx vitest run --root apps/worker src/queues/__tests__/webhook-events-{status,idempotency,sibling-drop}.test.ts src/queues/__tests__/webhook-open-click-counts.test.ts` | 22 tests passed | ✓ PASS |
| Send-dispatch regression (durability, idempotency, error-listener) | `npx vitest run --root apps/worker src/queues/__tests__/send-dispatch-{durability,idempotency,error-listener}.test.ts` | 14 tests passed | ✓ PASS |
| `application_name` composition unaffected | `npx vitest run --root packages/tenant-context src/__tests__/application-name-correlation.test.ts` | 7 tests passed | ✓ PASS |
| apps/web unit suite (regression — diff touches zero apps/web files) | `npx vitest run --root apps/web` | 84 tests passed | ✓ PASS |
| Redaction suite (regression) | `npx vitest run --root packages/redaction` | 29 tests passed | ✓ PASS |
| Worker type-check | `npx tsc -p apps/worker/tsconfig.json --noEmit` | exit 0 | ✓ PASS |
| `composeApplicationName` no sendId regression | node one-liner over `packages/tenant-context/src/index.ts` | no `sendId` reference | ✓ PASS |
| Runbook coverage gate (regression) | `node scripts/check-runbook-coverage.mjs` | 4/4 alerts covered, exit 0 | ✓ PASS |
| SPECIFICATION.md env coverage gate | `npm run check:spec-env-coverage` | 53 names, all present, exit 0 | ✓ PASS |
| Prod-compose invariants gate (regression) | `npm run verify:prod-compose` | 8 services, 43 invariants OK | ✓ PASS |
| ARCHITECTURE.md §18 region check | node one-liner (banned literals absent, required citations present) | pass | ✓ PASS |
| SPECIFICATION.md §7/§3 region checks | node one-liners (banned literals absent, plan tags present) | pass | ✓ PASS |
| RouteErrorBoundary click-through | n/a — requires DOM env / browser | not run | ? SKIP (see human_verification — unchanged from prior report) |
| Canvas unsaved-changes e2e (Playwright) | `npm run test:e2e -w apps/web -- flow-unsaved-changes.spec.ts` | not run (requires live e2e DB) | ? SKIP (see human_verification — unchanged from prior report) |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| OPS-06 | 15-01, 15-02, 15-08 | Worker logs structurally via Pino | ✓ SATISFIED | Unchanged; plus 5 new structured log call sites this session confirmed |
| OPS-07 | 15-04 | Redaction uniform across worker/API | ✓ SATISFIED | Re-ran 29/29 redaction tests this session |
| OPS-08 | 15-01, 15-10, 15-11, 15-21 | Sentry captures frontend/API/worker exceptions | ✓ SATISFIED | Plus SPECIFICATION.md §3's secrets-delivery description now corrected (G-15-3) |
| OPS-09 | 15-06 | Secrets/PII proven absent from Sentry by test | ✓ SATISFIED | Unchanged |
| OPS-10 | 15-17 | Logs reach hosted provider with alerts configured | ✓ SATISFIED (config); provisioning unverified | Unchanged — live push remains operator setup (human_verification) |
| OPS-11 | 15-02, 15-19, 15-20 | request_id/tenant_id/job_id/**send_id** thread through HTTP, queue, worker | ✓ SATISFIED (was ⚠️ PARTIAL) | **send_id now bound on both dispatch (3 scopes) and webhook (1 per-event scope) paths, proven by 2 independently re-run test suites this session** |
| OPS-12 | 15-02 | Trace correlation links HTTP/job/Postgres | ✓ SATISFIED | Unchanged |
| OPS-13 | 15-12, 15-13, 15-14 | Alerts on queue depth/oldest job age/webhook lag/failed-send share | ✓ SATISFIED | Unchanged |
| OPS-14 | 15-01, 15-16 | Bull Board behind closed admin access | ✓ SATISFIED | Unchanged |
| OPS-15 | 15-18, 15-21 | Runbooks describe incidents/recovery | ✓ SATISFIED (was ⚠️ PARTIAL) | Runbook coverage unchanged; **ARCHITECTURE.md §18 (the correlation-model doc this requirement's own must-have covers) now accurate — G-15-2 closed** |
| OPS-16 | 15-03 | Route-level code splitting | ✓ SATISFIED | Unchanged (diff touches zero apps/web files) |
| OPS-17 | 15-05, 15-07, 15-11 | Frontend handles errors/empty/pagination correctly | ✓ SATISFIED | Unchanged |
| OPS-18 | 15-12, 15-15 | Stale analytics shown honestly | ✓ SATISFIED | Unchanged |
| OPS-19 | 15-09 | Unsaved canvas changes warn; save errors visible | ✓ SATISFIED (wiring); e2e re-confirmation pending | Unchanged — code confirmed present+wired, e2e not independently re-run (human_verification) |

No orphaned requirements — all 14 IDs mapped to REQUIREMENTS.md Phase 15 row are claimed by at least one plan (confirmed by cross-reference: `.planning/REQUIREMENTS.md` lines 251-264, 282).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `apps/worker/src/queues/send-dispatch.ts` | 377 | `handleAmbiguousSendMailError` logs `"send outcome ambiguous"` unconditionally before branching, including on the `pre_connection_retryable` path which the function's own doc comment describes as NOT ambiguous (REVIEW.md IN-01, confirmed present in current source — not fixed) | ℹ️ Info | Message/field mismatch, not a correctness bug: the structured `classification` field disambiguates for any consumer filtering on it; only a message-text-matching alert/panel would over-count. Does not block. |
| `apps/api/src/modules/ops/webhook-lag-watchdog.ts` | 104-198 | Platform-wide `MAX(last_event_at)` signal can mask one dead tenant webhook behind another healthy one (REVIEW.md IN-01 from initial review) | ℹ️ Info (carried forward, deliberate documented scope choice) | Runbook should note this limitation; not a functional defect |
| `packages/db/src/migration-tiers.ts` | 63-64 | Stale file-count comment (carried forward from initial review) | ℹ️ Info (cosmetic) | No behavior depends on it |
| `apps/web/src/features/campaigns/TemplateSenderPickers.tsx` | 67-114, 180-226 | Duplicate error-state render when popover open + empty (carried forward from initial review) | ℹ️ Info (cosmetic) | Minor UI duplication, not a correctness defect |

No TBD/FIXME/XXX debt markers found in any of the 7 gap-closure-diff files (re-scanned this session: `send-dispatch.ts`, `webhook-events.worker.ts`, `correlation-tracer.test.ts`, `webhook-events-sendid-correlation.test.ts`, `send-dispatch-error-listener.test.ts`, `ARCHITECTURE.md`, `SPECIFICATION.md`).

**Note on diff scope:** `apps/worker/src/queues/__tests__/send-dispatch-error-listener.test.ts` appears in the gap-closure diff even though no gap-closure plan's `files_modified` lists it. Confirmed via `git log` this is a merge-conflict resolution (commit `2c0a6a1`, "fix: resolve post-merge conflicts from wave 1"): `send-dispatch.ts` now imports `../logger.js` (plan 15-19), which reads `PINO_REDACT_OPTIONS` from `@mega-crm/redaction` at module load, so the pre-existing test's `vi.mock("@mega-crm/redaction", ...)` needed to preserve the real module's other exports rather than fully replacing them. Behavior-preserving; re-ran this session, 3/3 pass.

### Human Verification Required

1. **RouteErrorBoundary click-through** — Force a render error inside a lazy feature route in a real browser and confirm the contained panel + intact shell. No DOM test env exists in this repo (`environment: "node"` for `apps/web` vitest); 15-11's own SUMMARY already flags this as `human_judgment: true`. Unchanged from the prior verification — this gap-closure diff touches zero `apps/web` files.
2. **Canvas unsaved-changes e2e** — Run `apps/web/e2e/flow-unsaved-changes.spec.ts` against a provisioned e2e database and confirm 4/4 pass, matching what 15-09-SUMMARY.md documents but this session did not independently reproduce. Unchanged from the prior verification.
3. **Live Sentry DSN provisioning** — Configure real DSNs for the three Sentry projects and confirm a real event reaches each, tagged correctly, with nothing sensitive leaking (operator-supplied, decision: proceed-live-dsn). Unchanged.
4. **Live Grafana Cloud/Loki provisioning** — Configure real Loki push credentials and the two documented backstop alert rules, and confirm both logs arrival and alert firing (operator setup, outside repo scope). Unchanged.

### Gaps Summary

**No gaps remain.** All three gaps from the prior verification (G-15-1 sendId dispatch+webhook halves, G-15-2 ARCHITECTURE.md §18 staleness, G-15-3 SPECIFICATION.md §3 staleness) are independently confirmed closed against the actual current codebase in this session — not merely claimed by the SUMMARYs. Every grep/node-oneliner gate the gap-closure plans specify was re-run directly against the current files and passed; every named test the plans reference was re-run in this session (not merely trusted from the SUMMARYs) and passed; the underlying facts the two doc fixes describe (docker-compose.prod.yml's environment blocks, processor-wrapper.ts:196's actual code) were independently re-checked against the source, not just against the doc's own claim about them.

Status is `human_needed`, not `passed`, solely because of the four carried-forward human-verification items (two in-repo runtime checks this repository cannot exercise without a DOM environment or a live e2e database, two operator-side provisioning steps for live Sentry/Grafana Cloud). None of these four items were touched by this gap-closure diff and none represent a regression — they were already `human_needed` in the prior report and remain exactly as they were.

---

_Verified: 2026-08-16_
_Verifier: Claude (gsd-verifier)_
