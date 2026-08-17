---
status: resolved
trigger: "UAT Phase 15 gap G-15-4: docker/alloy/config.alloy uses # comments; grafana/alloy:v1.18.1 rejects them (illegal character U+0023), so the production Alloy container restart-loops. With a temporary //-corrected config, Loki shipping/correlation works and Grafana rules/contact are provisioned."
created: 2026-08-17T00:00:00Z
updated: 2026-08-17T03:45:00Z
---

## Current Focus

hypothesis: CONFIRMED — "docker/alloy/config.alloy is written with shell/YAML-style `#` comments, but Alloy configuration syntax only supports `//` and `/* */` comments — the lexer rejects the very first byte of line 1 (`#` = U+0023), so the container can never load config and restart-loops"
test: "Empirically reproduced with the real binary: `docker run --rm -v .../config.alloy:/etc/alloy/config.alloy:ro grafana/alloy:v1.18.1 fmt /etc/alloy/config.alloy`"
expecting: n/a — confirmed
next_action: "Return ROOT CAUSE FOUND diagnosis (goal: find_root_cause_only — no fix applied)"

known_pattern_candidate: none
bug_class: Bohrbug (deterministic — lexer rejects same byte on every container start)

## Symptoms
<!-- pre-filled from UAT, symptoms_prefilled: true -->

expected: "Provision Grafana Cloud Loki push credentials and the two documented backstop alert rules; Loki receives structured JSON log lines from all three prod-compose services via Alloy, and both rules fire on their documented conditions."
actual: "docker/alloy/config.alloy uses # comments; grafana/alloy:v1.18.1 rejects them (illegal character U+0023), so the production Alloy container restart-loops. With a temporary //-corrected config, Loki shipping/correlation works and Grafana rules/contact are provisioned."
errors: "illegal character U+0023 from grafana/alloy:v1.18.1 at container startup"
reproduction: "Test 4 in 15-UAT.md — start the prod compose stack with the committed docker/alloy/config.alloy"
started: "Discovered during UAT on 2026-08-16"

## Evidence

- checked: "docker/alloy/config.alloy (full read, 137 lines)" — found: "Lines 1-69 (file header block), 75-78, 94-98, 106-111, 124-127 are all comments starting with `#` (88 lines total). U+0023 IS the `#` character. Alloy configuration syntax supports only `//` line comments and `/* */` block comments — `#` is not a comment token, so the lexer fails on the first character of line 1. The functional blocks themselves (discovery.docker, discovery.relabel, loki.source.docker, loki.process, loki.write) are syntactically valid Alloy." → root cause is comment-token syntax only
- checked: "find repo for *.alloy files" — found: "Exactly one: docker/alloy/config.alloy" → fix scope for config files is a single file
- checked: "docker/docker-compose.prod.yml alloy service (lines 464-506)" — found: "Image pinned to grafana/alloy:v1.18.1 with restart: unless-stopped; config mounted at ./alloy/config.alloy:/etc/alloy/config.alloy:ro; command runs `run --server.http.listen-addr=127.0.0.1:12345 /etc/alloy/config.alloy`" → the committed broken file is exactly the one the prod container loads; restart: unless-stopped explains the restart loop
- checked: ".planning/phases/15-.../15-17-SUMMARY.md line 159 (executor self-report)" — found: "Executor authored config.alloy from component names cross-checked against Grafana docs navigation but could NOT scrape argument-level syntax from JS-rendered pages, and explicitly flagged: 'This file is not executed by any automated check in this repository (no real Alloy binary runs against it in CI)'" → WHY the bug shipped: config never parsed by a real Alloy binary; gap-closure should add a CI/validation step alongside the syntax fix
- checked: "Empirical reproduction: docker run --rm -v <committed config>:/etc/alloy/config.alloy:ro grafana/alloy:v1.18.1 fmt /etc/alloy/config.alloy" — found: "Fails with '/etc/alloy/config.alloy:1:1: illegal character U+0023 '#'' followed by the same error on every #-comment line (plus cascade errors: illegal ':', illegal single-quoted string — all inside would-be comment text). Exactly matches the UAT-reported error" → root cause reproduced deterministically with the exact pinned image version
- checked: "Counter-test: sed 's|^(ws)#|\\1//|' copy of config.alloy run through the same alloy fmt" — found: "Exit 0, zero errors — the //-corrected file parses cleanly" → fix scope is comments-only; all functional blocks valid; matches user report that //-corrected config shipped logs end-to-end
- checked: "Propagation sweep: grep for alloy/river code fences and pipeline block names across docs/ and .planning/phases/" — found: "No ```alloy or ```river code fences anywhere. docs/runbooks/log-shipping-and-backstop-alerts.md and docs/observability/grafana-cloud-alerts.md reference the alloy container operationally but embed NO config snippets. Planning artifacts mention component names in prose/diagrams only." → no copy-paste propagation risk — the # bug lives in exactly one artifact

## Eliminated

- hypothesis: "Environment category — wrong/incompatible Alloy image version (comment syntax changed between versions)"
  evidence: "U+0023 has never been a comment token in Alloy/River syntax (only // and /* */); the pinned v1.18.1 binary itself rejects the file, and the //-corrected file parses on the SAME image — image version is not a contributing cause"
- hypothesis: "Config category — deeper structural errors in the pipeline blocks beyond comments (executor flagged unverified argument-level syntax)"
  evidence: "alloy fmt exits 0 on the //-corrected copy with zero diagnostics, and the user's UAT run with a //-corrected config shipped logs to Loki end-to-end with rules provisioned"
- hypothesis: "AND-gate check — multiple contributing conditions required simultaneously?"
  evidence: "No. Single condition: fixing only the comment token makes the parser accept the file and the pipeline work end-to-end (both alloy fmt and the user's live UAT confirm). The absent-CI-validation finding is a 'why not caught' process gap, not a runtime co-cause"

## Resolution

root_cause: "docker/alloy/config.alloy uses shell/YAML-style `#` comments on 88 lines (header block lines 1-69 and inline blocks at 75-78, 94-98, 106-111, 124-127); Grafana Alloy's configuration language supports only `//` and `/* */` comments, so grafana/alloy:v1.18.1's lexer rejects the first `#` byte (illegal character U+0023 at 1:1), the process exits at config load, and `restart: unless-stopped` restart-loops the container. Contributing process gap (why not caught): no automated check parses config.alloy with a real Alloy binary — 15-17-SUMMARY.md explicitly pre-flagged this."
fix: "NOT APPLIED (goal: find_root_cause_only). Direction: mechanical `#` → `//` on comment lines of docker/alloy/config.alloy (verified: sed-corrected copy passes `alloy fmt` with exit 0 on the pinned image); recommend adding a validation step (e.g., `docker run --rm -v ...config.alloy:/etc/alloy/config.alloy:ro grafana/alloy:v1.18.1 fmt /etc/alloy/config.alloy` in CI or scripts/validate-prod-compose.mjs) so the config is parsed by the real binary before deploy."
verification: "Root cause verified by deterministic reproduction (alloy fmt on committed file reproduces exact UAT error at 1:1) + counter-test (comment-only correction parses cleanly) + user's live UAT confirmation that a //-corrected config ships logs end-to-end."
files_changed: []
