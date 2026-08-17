---
phase: 15-observability-alerting-frontend-resilience
verified: 2026-08-17T08:30:00Z
status: human_needed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/5
  gaps_closed:
    - "G-15-4 (OPS-10): docker/alloy/config.alloy used `#` comment tokens Grafana Alloy's lexer rejects (illegal character U+0023 at 1:1), restart-looping the production alloy sidecar and silently stopping all log delivery. Closed by plan 15-22: 88 `#` lines converted to `//`, a new scripts/validate-alloy-config.mjs gate (static comment/string-aware scanner + real-binary `alloy fmt` parse under the exact image docker-compose.prod.yml pins) wired into CI's `static` required job with a fail-closed ALLOY_VALIDATE_REQUIRE_BINARY switch."
  gaps_remaining: []
  regressions: []
overrides: []
human_verification:
  - test: "Operator-side, at the next production deploy: redeploy the prod compose stack with the committed docker/alloy/config.alloy and confirm the `alloy` container reaches and stays in a running state (not restarting), and that log lines continue to arrive in Loki."
    expected: "The `alloy` container runs (not `Restarting`) and structured log lines keep arriving in Grafana Cloud Loki with the documented labels."
    why_human: "The operator's UAT confirmation (15-UAT.md test 4) was against a temporary //-corrected config applied ad hoc during UAT, not byte-identical to the file now committed (which also gained a 16-line explanatory header paragraph in Task 2). This session independently proved the committed file parses cleanly under the real pinned grafana/alloy:v1.18.1 binary (exit 0, zero diagnostics) — the parse-level risk is effectively closed — but an actual production redeploy confirmation of this exact committed file is a live-infrastructure step this repository cannot exercise, and the plan's own <human-check> block scopes exactly this residual as outstanding."
---

# Phase 15: Observability, Alerting & Frontend Resilience Verification Report

**Phase Goal:** The system reports its true state — to an operator through structured logs, correlated traces and alerts, and to a user through honest error, empty and stale states.
**Verified:** 2026-08-17
**Status:** human_needed
**Re-verification:** Yes — after gap closure (plan 15-22, closing G-15-4)

## Re-Verification Summary

The prior verification (`15-VERIFICATION.md`, superseded, committed 2026-08-16) found `status: human_needed` with 5/5 roadmap truths verified but 4 outstanding human-verification items, one of which (live Grafana Cloud/Loki provisioning) was subsequently exercised via UAT (`15-UAT.md`, 2026-08-17) and found a blocker: `docker/alloy/config.alloy` shipped with shell/YAML-style `#` comments that Grafana Alloy's lexer rejects at the very first byte, restart-looping the production `alloy` sidecar under `restart: unless-stopped` and silently stopping all log delivery — logged as gap `G-15-4`.

Plan 15-22 (gap closure, `gap_ids: [G-15-4]`, `requirements: [OPS-10]`) executed to close it. This session independently re-verified the closure against the actual current codebase — not the SUMMARY's claims — by running the real gate, the real pinned Alloy binary, the full test suite, and every named regression gate directly.

**G-15-4 is genuinely closed.** Independent evidence gathered this session (not reproduced from the SUMMARY):

| Check | Command (run this session) | Result |
|---|---|---|
| Real pinned binary parses the committed file | `ALLOY_VALIDATE_REQUIRE_BINARY=1 node scripts/validate-alloy-config.mjs` | Exit 0. Output: `resolved image: grafana/alloy:v1.18.1` / `ran the real Alloy binary (alloy fmt) against the committed config` / `all checks OK.` — the *exact* command class that reproduced `illegal character U+0023 '#'` at 1:1 on the pre-fix file now succeeds. |
| Leading `#` comment lines in config.alloy | `grep -nc '^\s*#' docker/alloy/config.alloy` | 0 (was 88) |
| Leading `//` comment lines in config.alloy | `grep -nc '^\s*//' docker/alloy/config.alloy` | 104 (88 converted + 16 new header lines) |
| Gate test suite | `npx vitest run --root scripts __tests__/validate-alloy-config.test.mjs` | 18/18 PASS |
| Fail-first fixture still reproduces the shipped defect | Ran `scanIllegalCommentTokens` directly against `hash-comment-header.alloy` | Violation at line 1, column 1 — matches the original defect exactly |
| Comment/string-awareness (false-positive guard) | Ran `scanIllegalCommentTokens` against `valid-with-slash-comments.alloy` (names `#` in `//` comment, block comment, and a quoted URL fragment `https://example.invalid/push#fragment`) | 0 violations |
| `package.json` script wired | `grep -n "verify:alloy-config" package.json` | `"verify:alloy-config": "node scripts/validate-alloy-config.mjs"` present |
| CI wiring, `static` job | Read `.github/workflows/ci.yml` directly | Step "Alloy config gate (OPS-10)" at line 163, inside the `static` job (lines 48-222+), with `ALLOY_VALIDATE_REQUIRE_BINARY: "1"` in its `env:` |
| `static` is a required status check | Confirmed via `.github/workflows/ci.yml` comment (line 35: "`static`, `test` and `failure-injection` are the required status checks") and `SPECIFICATION.md` line 83 ("Required status checks на `master`: `static`, `test`, `failure-injection`") | Confirmed — the gate is blocking with no branch-protection admin action needed |
| Image resolved from compose, not hardcoded | Exported-helper import check: `grep -n "import.*validate-prod-compose" scripts/validate-alloy-config.mjs` | Imports `parseEnvFile`, `resolveViaYamlFallback` from `validate-prod-compose.mjs`; confirmed both exist as named exports there |
| Docker-unreachable fail-closed behavior | Read the vitest subprocess test (line 153) and confirmed it passed in the 18/18 run | Test asserts: no `docker` on PATH + `ALLOY_VALIDATE_REQUIRE_BINARY=1` exits non-zero naming `alloy-binary-check-unavailable` |
| Regression: SPECIFICATION.md env coverage (this diff touched SPECIFICATION.md) | `npm run check:spec-env-coverage` | 53 names, all present, exit 0 |
| Regression: runbook coverage (this diff touched the runbook) | `node scripts/check-runbook-coverage.mjs` | 4/4 alerts covered, exit 0 |
| Regression: prod-compose invariants (docker-compose.prod.yml untouched by this plan) | `npm run verify:prod-compose` | 8 services, 43 invariants OK, exit 0 |
| Debt markers in the 10 files this plan touched | `grep -nE "TBD|FIXME|XXX"` over all 10 `files_modified` | 0 hits |
| SPECIFICATION.md and runbook actually describe the gate | Read both files directly | SPECIFICATION.md §7/§8.2 describe the gate, the image reuse, and cite the exact defect; the runbook's "No-logs-received fired" section adds the restart-loop symptom, reproduction command, and gate pointer |

**No regressions found.** All gates unaffected by this diff (spec-env-coverage, runbook-coverage, prod-compose invariants) were independently re-run this session and pass.

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A single send can be followed from HTTP request through queue job to Postgres query using one correlation identifier, in structured API/worker logs reaching the hosted log provider | ✓ VERIFIED | Unchanged from prior verification (all four identifiers: requestId/jobId/workspaceId/sendId proven end-to-end in the 2026-08-16 session). This diff (15-22) touches zero correlation-tracer files. |
| 2 | An exception from frontend/API/worker reaches Sentry tagged with tenant+request, and a test proves no SendGrid key/contact email/freeform JSONB reaches it | ✓ VERIFIED | Unchanged. |
| 3 | Alerts fire on queue depth, oldest job age, webhook lag, failed-send share; Bull Board reachable only behind admin access; a runbook exists per alert | ✓ VERIFIED | Unchanged; re-ran `node scripts/check-runbook-coverage.mjs` this session — 4/4 alerts covered, exit 0. |
| 4 | The app loads with route-level code splitting — canvas/heavy-dashboard chunks arrive only when opened | ✓ VERIFIED | Unchanged (this diff touches zero `apps/web` files). |
| 5 | A failed API call, empty list, paginated list, stale analytics and unsaved canvas changes each show the user what is true, not a blank/silently-wrong screen | ✓ VERIFIED | Unchanged — code confirmed present+wired in the prior session. **Both previously behavior-unverified sub-items (RouteErrorBoundary click-through, canvas unsaved-changes e2e) are now human-confirmed**: `15-UAT.md` records test 1 (RouteErrorBoundary) `result: pass` and test 2 (canvas e2e, `flow-unsaved-changes.spec.ts`) `result: pass`, run 2026-08-17. `behavior_unverified` accordingly drops to 0 this session (was 2). |

**Score:** 5/5 truths verified. Roadmap SC1-SC5 all clean; the two truths carried forward as behavior-unverified in the prior report are now closed via the 2026-08-17 UAT session, not by this gap-closure diff itself, but that evidence exists in the repository (`15-UAT.md`) and this session confirmed it directly.

### Gap Closure Detail (G-15-4, this session's independent verification)

See table above ("Re-Verification Summary"). Summary: the committed `docker/alloy/config.alloy` parses cleanly under the exact pinned `grafana/alloy:v1.18.1` binary (verified by running the gate myself, not trusting the SUMMARY), the gate's regression-lock fixture still reproduces the original defect at 1:1, the comment/string-awareness guard correctly ignores `#` inside `//` comments and inside a quoted URL, and the gate is wired into `static` — already a required status check — with a fail-closed require-binary switch, verified present in both the CI YAML text and the passing subprocess test.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `scripts/validate-alloy-config.mjs` | Static scanner + real-binary orchestration | ✓ VERIFIED | Exists, substantive (14KB, exported pure helpers + CLI guard mirroring `validate-prod-compose.mjs`), ran successfully this session with exit 0 |
| `scripts/__tests__/validate-alloy-config.test.mjs` | Full test suite incl. regression lock | ✓ VERIFIED | 18/18 pass, re-run this session |
| `scripts/__fixtures__/alloy-config/hash-comment-header.alloy` | Fail-first fixture reproducing the shipped defect | ✓ VERIFIED | Confirmed 1:1 violation via direct scanner invocation this session |
| `scripts/__fixtures__/alloy-config/hash-trailing-comment.alloy` | Mid-line variant | ✓ VERIFIED (via passing test suite) | |
| `scripts/__fixtures__/alloy-config/valid-with-slash-comments.alloy` | False-positive guard fixture | ✓ VERIFIED | Confirmed 0 violations via direct scanner invocation this session, including a quoted-string case (`#fragment` in a URL) |
| `docker/alloy/config.alloy` | Corrected config, no `#` comments | ✓ VERIFIED | 0 leading `#` lines, 104 `//` lines; parses under the real pinned binary (exit 0) |
| `package.json` | `verify:alloy-config` script | ✓ VERIFIED | Present, wired |
| `.github/workflows/ci.yml` | Blocking `static`-job step with require-binary switch | ✓ VERIFIED | Present at line 163-166, inside `static` (a required check) |
| `SPECIFICATION.md` §7/§8 | Describes the gate as built | ✓ VERIFIED | Confirmed by direct read — cites the gate, the image reuse, and the exact defect |
| `docs/runbooks/log-shipping-and-backstop-alerts.md` | Recovery section updated with restart-loop symptom | ✓ VERIFIED | Confirmed by direct read |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `scripts/validate-alloy-config.mjs` | `scripts/validate-prod-compose.mjs`'s `parseEnvFile`/`resolveViaYamlFallback` | named import | ✓ WIRED | Confirmed both exports exist in `validate-prod-compose.mjs` (lines 104, 273) and are imported (line 42) |
| `scripts/validate-alloy-config.mjs`'s image resolution | `docker/docker-compose.prod.yml`'s `alloy` service `image:` | `resolveAlloyImageRef` | ✓ WIRED | Gate run this session resolved `grafana/alloy:v1.18.1` — matches the compose file's pinned tag, not hardcoded |
| `.github/workflows/ci.yml` `static` job | `npm run verify:alloy-config` | CI step | ✓ WIRED | Confirmed present at the correct job scope; asserted by the wiring-lock test which passed |
| `ALLOY_VALIDATE_REQUIRE_BINARY=1` (CI step env) | `runValidation`'s fail-closed branch | env var read | ✓ WIRED | Confirmed present in CI YAML and exercised by a passing subprocess test in the 18/18 run |
| `scripts/validate-alloy-config.mjs` test suite (mutable-tag assertion) | `validate-prod-compose.mjs`'s `extractImageTag`/`isMutableTag` | named import in test file | ✓ WIRED | Confirmed import at test file line 29, assertion at lines 79-80 |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Real pinned Alloy binary parses the committed config | `ALLOY_VALIDATE_REQUIRE_BINARY=1 node scripts/validate-alloy-config.mjs` (Docker daemon reachable on this machine) | Exit 0, "all checks OK" | ✓ PASS |
| Gate test suite | `npx vitest run --root scripts __tests__/validate-alloy-config.test.mjs` | 18/18 pass | ✓ PASS |
| Fail-first fixture reproduces original defect | Direct `scanIllegalCommentTokens` call against `hash-comment-header.alloy` | Violation at 1:1 | ✓ PASS |
| False-positive guard (comment/string-aware) | Direct `scanIllegalCommentTokens` call against `valid-with-slash-comments.alloy` | 0 violations | ✓ PASS |
| SPECIFICATION.md env coverage (regression, file touched this diff) | `npm run check:spec-env-coverage` | 53 names, all present, exit 0 | ✓ PASS |
| Runbook coverage (regression, file touched this diff) | `node scripts/check-runbook-coverage.mjs` | 4/4 alerts covered, exit 0 | ✓ PASS |
| Prod-compose invariants (regression, unrelated file) | `npm run verify:prod-compose` | 8 services, 43 invariants OK, exit 0 | ✓ PASS |
| Debt markers on the 10 touched files | `grep -nE "TBD\|FIXME\|XXX"` | 0 hits | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| OPS-06 | 15-01, 15-02, 15-08 | Worker logs structurally via Pino | ✓ SATISFIED | Unchanged |
| OPS-07 | 15-04 | Redaction uniform across worker/API | ✓ SATISFIED | Unchanged |
| OPS-08 | 15-01, 15-10, 15-11, 15-21 | Sentry captures frontend/API/worker exceptions | ✓ SATISFIED | Unchanged |
| OPS-09 | 15-06 | Secrets/PII proven absent from Sentry by test | ✓ SATISFIED | Unchanged |
| OPS-10 | 15-17, 15-22 | Logs reach hosted provider with alerts configured | ✓ SATISFIED (was ✓ config-only; live path now closed) | **G-15-4 closed this session** — the config that ships to production now parses under the real pinned binary; live Loki arrival + both backstop alert rules were confirmed by the operator during UAT (test 3/4 in `15-UAT.md`, against a temporary corrected config) — the outstanding item is confirming the exact *committed* file behaves identically at the next production redeploy (human_verification, below) |
| OPS-11 | 15-02, 15-19, 15-20 | request_id/tenant_id/job_id/send_id thread through HTTP, queue, worker | ✓ SATISFIED | Unchanged |
| OPS-12 | 15-02 | Trace correlation links HTTP/job/Postgres | ✓ SATISFIED | Unchanged |
| OPS-13 | 15-12, 15-13, 15-14 | Alerts on queue depth/oldest job age/webhook lag/failed-send share | ✓ SATISFIED | Unchanged |
| OPS-14 | 15-01, 15-16 | Bull Board behind closed admin access | ✓ SATISFIED | Unchanged |
| OPS-15 | 15-18, 15-21 | Runbooks describe incidents/recovery | ✓ SATISFIED | Unchanged; the log-shipping runbook additionally gained the G-15-4 recovery procedure this diff |
| OPS-16 | 15-03 | Route-level code splitting | ✓ SATISFIED | Unchanged |
| OPS-17 | 15-05, 15-07, 15-11 | Frontend handles errors/empty/pagination correctly | ✓ SATISFIED | RouteErrorBoundary click-through now human-confirmed via UAT test 1 |
| OPS-18 | 15-12, 15-15 | Stale analytics shown honestly | ✓ SATISFIED | Unchanged |
| OPS-19 | 15-09 | Unsaved canvas changes warn; save errors visible | ✓ SATISFIED | Canvas e2e now human-confirmed via UAT test 2 |

No orphaned requirements — all 14 IDs mapped to REQUIREMENTS.md Phase 15 row (`.planning/REQUIREMENTS.md` line 282) are claimed by at least one plan.

**Note on REQUIREMENTS.md checkboxes:** the milestone-tracking checkbox list (lines 118-131) shows only OPS-10 checked `[x]`; OPS-06/07/08/09/11-19 remain `[ ]`. This is a bookkeeping-convention artifact, not a functional gap — the traceability table (lines 251-264) and this verification's code-level evidence are what establish SATISFIED status; per this repository's own pattern, per-requirement checkboxes appear to be flipped at milestone-close time rather than per-plan. Not treated as a gap; flagged here for the record.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `scripts/validate-alloy-config.mjs` | 85-148 | Static scanner's four-state walk (code/string/lineComment/blockComment) has no backtick-delimited raw-string state; River (Alloy's config language) supports backtick raw strings. `15-REVIEW.md` WR-01 empirically proved both a false positive (`regex = \`a#b\`` — legal Alloy, real binary accepts it, static scanner flags it) and a false negative (an unescaped `"` inside a backtick string desyncs the scanner into permanent string-state, silently swallowing a real illegal `#` later in the file) | ⚠️ Warning (carried from code review, not newly found) | Neither direction lets the actual production defect class go undetected: CI's `ALLOY_VALIDATE_REQUIRE_BINARY=1` real-binary layer is the authoritative parser and backstops both — a false positive fails loud (blocks a legal config, availability/DX cost) and a false negative in the static scan is still caught because `alloy fmt` itself rejects genuinely invalid syntax. The committed `config.alloy` contains no backtick strings today, so this is a latent robustness gap for future edits, not a live defect. Confirmed this session: the must-have's actual wording ("a `//` comment or a **quoted string**") is satisfied — I independently verified the double-quoted case (`#fragment` in a URL) returns 0 violations; backtick strings are outside that stated scope. |
| `scripts/validate-alloy-config.mjs` | 258-311 | `runValidation`'s branch order has an untested combination (Docker reachable + image resolution fails) that doesn't explicitly check `requireBinary`, unlike the symmetric Docker-unreachable branch (`15-REVIEW.md` WR-02) | ⚠️ Warning (carried from code review) | Currently masked/non-exploitable — `resolveAlloyImageRef` always throws before `imageRef` can be `undefined` in this branch, so the violations array is still non-empty and CI still exits non-zero. Untested edge case, not a live fail-open bug. |
| `scripts/__tests__/validate-alloy-config.test.mjs` | 83-88 | The "throws a named error when compose declares no alloy service" test hits a bare `ENOENT` before reaching the code path it claims to test; `AlloyImageResolutionError` is never imported or asserted via `instanceof` (`15-REVIEW.md` WR-03) | ⚠️ Warning (carried from code review) | Test doesn't prove what it claims; a regression in the "no alloy service"/"no image" detection logic would not be caught |
| `docs/runbooks/log-shipping-and-backstop-alerts.md` | 156-159 | Recovery command hardcodes `grafana/alloy:v1.18.1` literally, contradicting the runbook's own stated "restate nothing, link instead" convention (`15-REVIEW.md` WR-04) | ⚠️ Warning (carried from code review) | Currently correct (matches the pinned tag) but would silently validate against a stale image if the tag is ever bumped without this runbook being updated in lockstep — this is specifically the production-incident recovery path |
| `scripts/validate-alloy-config.mjs` | 217-234 | `execFileSync` timeout in `runAlloyFmt` is reported identically to a real parse failure, not distinguished (`15-REVIEW.md` IN-01) | ℹ️ Info (carried from code review) | Fails safe (CI still goes red) but misdirects investigation toward config typos rather than image-pull/network health |
| `scripts/__tests__/validate-alloy-config.test.mjs` | 179-183 | Container-path drift test only checks substring presence, not that it appears as the specific mount target and command argument (`15-REVIEW.md` IN-02) | ℹ️ Info (carried from code review) | Weaker guarantee than the doc comment claims; not a live defect |
| `apps/web/src/lib/sentry.ts`, `apps/worker/src/__tests__/correlation-tracer.test.ts` | various | Two pre-existing lint errors unrelated to this plan's files (logged in `deferred-items.md`) | ℹ️ Info (carried forward, out of 15-22's scope) | `npx eslint` on 15-22's own new files is clean; these predate this plan (15-11, 15-19) |

No TBD/FIXME/XXX debt markers found in any of the 10 files this plan's diff touches (re-scanned this session).

### Human Verification Required

1. **Production redeploy confirmation of the committed config.alloy** — At the next production deploy, redeploy the prod compose stack and confirm the `alloy` container reaches and stays in a running state (not restarting), and that log lines continue to arrive in Loki. Expected: container runs (not `Restarting`), structured logs keep arriving with the documented labels. Why human: this session's own real-binary parse (exit 0, zero diagnostics) makes the parse-level risk near-zero, but the operator's UAT confirmation of live shipping was against a temporary corrected config, not byte-identical to the file now committed (which gained a 16-line explanatory header). The plan's own `<human-check>` block scopes exactly this residual as outstanding, and an actual production redeploy is outside this repository's automatable scope.

### Gaps Summary

**No gaps remain.** G-15-4 is independently confirmed closed this session by running the real gate and the real pinned Alloy binary directly (not by trusting the SUMMARY) — the committed `docker/alloy/config.alloy` parses cleanly, the regression-lock fixture still reproduces the original shipped defect exactly, the false-positive guard is confirmed for the must-have's stated scope (quoted strings), and the gate is wired into a required, fail-closed CI check. All three regression gates touched by this diff (spec-env-coverage, runbook-coverage, prod-compose invariants) were re-run this session and pass. No debt markers found.

Status remains `human_needed` rather than `passed` for exactly one reason: an actual production redeploy of the committed configuration has not been confirmed in this repository (the plan's own `<human-check>` scopes this precisely). This is a live-infrastructure confirmation step, not a code-level gap — the automated evidence for it is as strong as this repository can produce without deploying.

The code review (`15-REVIEW.md`) surfaced four Warning and two Info findings in the new gate's own robustness (backtick raw-string blind spot, an untested branch, a weak test assertion, a hardcoded image tag in a runbook example) — none of these undermine G-15-4's closure, because CI's real-binary layer is the authoritative parser and backstops the actual defect class in both directions. They are recorded as Anti-Patterns for a future cleanup pass, not as blocking gaps.

---

_Verified: 2026-08-17_
_Verifier: Claude (gsd-verifier)_
