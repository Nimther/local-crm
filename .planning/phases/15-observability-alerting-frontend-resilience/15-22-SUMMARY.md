---
phase: 15-observability-alerting-frontend-resilience
plan: 22
subsystem: observability / CI quality-gates
tags: [gap-closure, ops-10, alloy, ci, g-15-4]
dependency-graph:
  requires: ["15-17", "15-18"]
  provides:
    - "scripts/validate-alloy-config.mjs (verify:alloy-config gate)"
    - "corrected docker/alloy/config.alloy (illegal `#` comment token removed)"
    - "CI static-job blocking check for Alloy config syntax"
  affects:
    - "docker/alloy/config.alloy"
    - "package.json (verify:alloy-config script)"
    - ".github/workflows/ci.yml (static job)"
    - "SPECIFICATION.md §7/§8"
    - "docs/runbooks/log-shipping-and-backstop-alerts.md"
tech-stack:
  added: []
  patterns:
    - "Hand-rolled scoped parser (four-state comment/string walk), same class as scripts/lint-session-state.mjs / scripts/lint-pg-pool-factory.mjs / scripts/validate-prod-compose.mjs's YAML subset -- owns exactly one defect class, never becomes a general grammar"
    - "Image reference resolved at run time via validate-prod-compose.mjs's own exported parseEnvFile/resolveViaYamlFallback, never hardcoded, so the gate can never drift from the deployed image"
    - "Injectable dockerAvailable/runFmt seams on runValidation, same dependency-seam convention as ProcessSendJobDeps.sendMail"
key-files:
  created:
    - scripts/validate-alloy-config.mjs
    - scripts/__tests__/validate-alloy-config.test.mjs
    - scripts/__fixtures__/alloy-config/hash-comment-header.alloy
    - scripts/__fixtures__/alloy-config/hash-trailing-comment.alloy
    - scripts/__fixtures__/alloy-config/valid-with-slash-comments.alloy
  modified:
    - docker/alloy/config.alloy
    - package.json
    - .github/workflows/ci.yml
    - SPECIFICATION.md
    - docs/runbooks/log-shipping-and-backstop-alerts.md
    - .planning/REQUIREMENTS.md (OPS-10 marked complete)
decisions:
  - "No new npm dependency of any kind (T-15-SC) -- validate-alloy-config.mjs is Node built-ins only, reusing validate-prod-compose.mjs's exported helpers rather than adding a YAML/grammar library"
  - "Real-binary layer runs `alloy fmt` (never `-w`) inside --network none with a single read-only mount, no docker-socket -- strictly less capability than the production sidecar (T-15-69)"
  - "ALLOY_VALIDATE_REQUIRE_BINARY fail-closed switch: unset locally (binary layer optional when Docker is unreachable), set to \"1\" on the CI static-job step (binary layer mandatory -- an unreachable daemon becomes a violation, not a silent skip)"
metrics:
  duration: "~55min"
  tasks: 3
  files: 10
  completed: "2026-08-17"
status: complete
---

# Phase 15 Plan 22: Alloy-config syntax gate (gap closure G-15-4) Summary

Built a comment-aware, string-aware static scanner plus a real-`alloy fmt`
parse gate (`scripts/validate-alloy-config.mjs`, `npm run verify:alloy-config`)
that proved and then closed gap G-15-4: `docker/alloy/config.alloy` shipped
with a shell/YAML-style `#` comment token that Alloy's lexer rejects at the
very first byte, restart-looping the production log-shipping sidecar under
`restart: unless-stopped` and silently stopping all log delivery to Grafana
Cloud — with both backstop alert rules (dead-man's-switch, error-rate-spike)
reading an empty stream the entire time. The gate is now wired into the CI
`static` job (already a required status check on `master`) with a
fail-closed `ALLOY_VALIDATE_REQUIRE_BINARY` switch, so this defect class
cannot merge again.

## Task 1 RED evidence (fail-first proof, captured before Task 2's fix)

Running `node scripts/validate-alloy-config.mjs` against the repository
as it stood after Task 1 (gate built, real file not yet corrected) exited 1
with **89 violations**: 88 `illegal-comment-token` hits (one per `#`
comment line in the committed header/inline blocks) plus one
`alloy-binary-parse-failed` violation whose detail carried the real
`grafana/alloy:v1.18.1` binary's own stderr:

```
/etc/alloy/config.alloy:1:1: illegal character U+0023 '#'
/etc/alloy/config.alloy:1:1: expected identifier, got ILLEGAL
...
Error: encountered errors during formatting
```

This matches `.planning/debug/alloy-config-hash-comments.md`'s reproduction
exactly (`illegal character U+0023 '#'` at 1:1) and confirms the gate
catches the exact defect that shipped, before any fix was applied.

## Task 2: exact conversion count

`grep -nc '^\s*#' docker/alloy/config.alloy` on the pre-fix file returned
**88** — all 88 were true leading-marker comment lines (verified with an
awk pass confirming none were mid-line or inside quoted values). The
mechanical `sed -E 's/^([[:space:]]*)#/\1\/\//'` substitution converted
exactly these 88 lines (confirmed: `git diff` showed 88 deletions / 104
insertions, where 104 = 88 converted lines + 16 new header-paragraph lines
including one blank separator). `git diff docker/alloy/config.alloy`
confirmed every changed line is a comment line (`#`/`//`-prefixed) — no
functional block (`discovery.docker`, `discovery.relabel`,
`loki.source.docker`, `loki.process`, `loki.write`) was touched.

`docker run --rm --network none -v "$PWD/docker/alloy/config.alloy:/etc/alloy/config.alloy:ro" grafana/alloy:v1.18.1 fmt /etc/alloy/config.alloy`
— the exact command that reproduced the illegal-character error on the
pre-fix file — now exits 0 with zero diagnostics.

## Task 3: CI wiring

`verify:alloy-config` added to `package.json` adjacent to
`verify:prod-compose`. A new "Alloy config gate (OPS-10)" step added to
`.github/workflows/ci.yml`'s `static` job immediately after "Production
compose invariants", with `ALLOY_VALIDATE_REQUIRE_BINARY: "1"` in the
step's `env:` — `static` is already a required status check on `master`,
so this becomes blocking with no branch-protection admin action. A wiring
lock in `validate-alloy-config.test.mjs` asserts both the `package.json`
script entry and the CI step + variable are present as text, so a future
edit that silently drops either fails a test rather than degrading the
gate to advisory.

SPECIFICATION.md §7 (plan-15-17 Alloy paragraph) and §8.2 (the
`grafana/alloy` row) both updated to describe the gate as built. No §3
change — `ALLOY_VALIDATE_REQUIRE_BINARY` is a CI step variable, never an
application/operator secret in `docker/prod.env.example`.
`docs/runbooks/log-shipping-and-backstop-alerts.md`'s "No-logs-received
fired" recovery section gained a new first check for the restart-looping
symptom, its reproduction command, and the pre-deploy gate pointer.

## Verification

- `npm run verify:alloy-config` — exit 0, resolved image
  `grafana/alloy:v1.18.1` (read from `docker-compose.prod.yml` at run
  time, never hardcoded), reports the real binary ran.
- `npx vitest run --root scripts __tests__/validate-alloy-config.test.mjs`
  — **18/18 tests pass**, including the regression-lock assertion that
  `scanIllegalCommentTokens` over the real committed file returns `[]`.
- `npm run check:spec-env-coverage` — unaffected (53 names checked, all
  present).
- `npm run check:runbook-coverage` — unaffected (4 alerts checked, all
  have runbooks).
- `npm run verify:prod-compose` — pre-existing, environment-local failure
  unrelated to this plan (stale `apps/worker` build in this sandbox;
  `print-stop-grace-period.mjs` needs a fresh `npm run build -w
  apps/worker` first) — not introduced by this plan's changes.

## Human-observed truth (not machine-checked by this repository)

Per the plan's own scope discipline: **the live half of G-15-4's truth —
logs actually reaching Grafana Cloud Loki and both backstop alert rules
actually being provisioned and observing that stream — was confirmed by
the operator during UAT against a corrected configuration, not by any
automated check in this repository.** This plan's job was narrower and
now complete: make the corrected config the committed one, and add a
real-binary CI gate so the specific defect class (an illegal comment
token) cannot regress silently. `docker/docker-compose.prod.yml` was
intentionally left unchanged (context only — its `restart: unless-stopped`
is what made the original parse failure visible as a restart loop, not
itself part of the defect).

## Deviations from Plan

### Auto-fixed Issues

None beyond the plan's own scope — Rules 1-3 were not triggered; the plan's
`<action>` blocks were followed as written.

### Out-of-scope discovery (Rule out of SCOPE BOUNDARY — not fixed here)

`npm run lint` reports two pre-existing errors in files this plan did not
touch:
- `apps/web/src/lib/sentry.ts:98,99,121` — `@typescript-eslint/no-unsafe-*`
  on `import.meta.env` access (last touched by plan 15-11).
- `apps/worker/src/__tests__/correlation-tracer.test.ts:231` —
  `@typescript-eslint/require-await` (last touched by plan 15-19).

`npx eslint scripts/validate-alloy-config.mjs
scripts/__tests__/validate-alloy-config.test.mjs --max-warnings=0` passes
cleanly with zero errors — this plan's own files are clean. Logged to
`.planning/phases/15-observability-alerting-frontend-resilience/deferred-items.md`
per the executor's scope boundary rather than fixed here (out of scope:
neither file was created or modified by plan 15-22).

## Known Stubs

None. This plan adds a backend/CI gate and a config-file fix; no UI
surface is introduced.

## Self-Check: PASSED

All created files verified present on disk:
- `scripts/validate-alloy-config.mjs` — FOUND
- `scripts/__tests__/validate-alloy-config.test.mjs` — FOUND
- `scripts/__fixtures__/alloy-config/hash-comment-header.alloy` — FOUND
- `scripts/__fixtures__/alloy-config/hash-trailing-comment.alloy` — FOUND
- `scripts/__fixtures__/alloy-config/valid-with-slash-comments.alloy` — FOUND

All commits verified present in `git log --oneline`:
- `9212880` test(15-22): add failing tests + fixtures for alloy-config gate (RED) — FOUND
- `1821abf` feat(15-22): implement alloy-config gate (GREEN) — FOUND
- `a6d1f21` fix(15-22): correct config.alloy's illegal # comment token (G-15-4) — FOUND
- `0708517` chore(15-22): wire alloy-config gate into required CI check (G-15-4) — FOUND
