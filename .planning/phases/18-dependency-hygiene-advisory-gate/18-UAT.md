---
status: complete
phase: 18-dependency-hygiene-advisory-gate
source: [18-VERIFICATION.md]
started: 2026-08-20T11:50:00Z
updated: 2026-08-20T14:35:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Create the `dependency-advisory` label in the GitHub repo
expected: Label exists in Settings → Labels before running test 2. (Repository configuration — deliberately not done by the unattended cron job.)
result: pass

### 2. Live advisory-scan dispatch exercise (plan 18-04's deferred TIMING check)
expected: |
  After this phase's PR merges advisory-scan.yml to master:
  (1) cut a scratch branch from master; add one `.advisory-accept-list.json` entry with an already-past expiry (other 4 fields valid) so the gate goes red;
  (2) GitHub Actions → "Advisory scan" → Run workflow against the scratch branch;
  (3) confirm a NEW issue opens, carries the `dependency-advisory` label as a chip (not just body text), and its body names the offending entry and links the failing run;
  (4) run the workflow a second time against the same branch — NO second issue opens; the existing issue gets a new comment;
  (5) close the issue, delete the scratch branch. Record the issue number and both run URLs.
result: pass
evidence: |
  Issue #21: https://github.com/Nimther/local-crm/issues/21
  First run (created the labelled issue): https://github.com/Nimther/local-crm/actions/runs/32379262881
  Second run (commented on #21 without creating a duplicate): https://github.com/Nimther/local-crm/actions/runs/32379397295
  Cleanup confirmed: issue #21 closed; remote and local scratch branch `codex/phase-18-advisory-uat` deleted.

### 3. SC3 backstop — cron surfaces a newly-published advisory (observational)
expected: |
  The daily 03:17 UTC tick (or a manual dispatch on a day the npm registry publishes a new
  advisory against an already-installed package) goes red and opens/updates the labelled issue
  with no code change on the branch. Cannot be manufactured on demand — observe over time;
  every mechanical link (cron trigger, identical gate script, issue path) is already verified.
result: pass

### 4. CR-01 fix ratification (requested by 18-REVIEW-FIX.md)
expected: |
  Reading scripts/check-dependency-advisories.mjs confirms one shared UTC-day comparison
  (parseExpiryUtcDayMs/toUtcDayMs) used by BOTH validateAcceptListEntry and
  selectBlockingFindings: an accept-list entry is valid through the END of its expiry date
  (inclusive), no drift between the two call sites. The verifier already reproduced the
  noon-UTC-on-expiry-day repro successfully — this is a human read of the contract.
result: pass

### 5. Ratify two interpretive assumptions (flagged in all four plans)
expected: |
  (a) DEP-01/DEP-02 edge classification vs the Russian REQUIREMENTS.md is unresolved because
  the deterministic classifier is English-keyed — known project condition, not a defect.
  (b) DEP-02's wording "PR-diff + scheduled full-scan" is satisfied by the no-diff-by-construction
  design (gate fails on ANY blocking finding not accept-listed; "new/untriaged" is implied by the
  clean DEP-01 baseline) rather than literal git-diff-against-master machinery.
  Confirm the interpretation matches the requirement's intent, or flag for plan revision.
result: pass

### 6. Ratify four judgment-tier prohibitions (evidence already gathered)
expected: |
  18-01: no continue-on-error/`|| true` in the static job (0 matches).
  18-02: accept-list never bridges a reachable finding (ships `{"entries": []}`; raw audit 0 high/0 critical).
  18-03: green reached via real upgrades, not weakening (raw npm audit: 0 high/0 critical, independent of gate config).
  18-04: scheduled scan is not a second gate implementation (drift test enforces byte-identical invocation).
result: pass

## Summary

total: 6
passed: 6
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps
