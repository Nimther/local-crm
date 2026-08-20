---
phase: 18-dependency-hygiene-advisory-gate
plan: 04
subsystem: ci-quality-gates
tags: [dependency-hygiene, npm-audit, ci-gate, tdd, github-actions, scheduled-workflow]
status: complete
dependency-graph:
  requires:
    - phase: 18-dependency-hygiene-advisory-gate
      provides: "scripts/check-dependency-advisories.mjs (check:dependency-advisories gate), GREEN baseline (18-01/18-03)"
  provides:
    - ".github/workflows/advisory-scan.yml (daily scheduled advisory scan, dedup'd issue surfacing)"
    - "dependency-advisory GitHub issue label (consumed at creation/search time)"
  affects: []
tech-stack:
  added: []
  patterns:
    - "workflow drift test: plain string/regex processing over two workflow files as text, no YAML dependency (matches scripts/__tests__/check-web-chunks.test.mjs's zero-dependency convention)"
    - "re-invoke the identical gate script a second time (not a divergent implementation) solely to capture stdout to a file, so the primary gate step's run: line stays byte-identical to ci.yml's for the drift test's strict-equality assertion"
key-files:
  created:
    - .github/workflows/advisory-scan.yml
    - scripts/__tests__/advisory-scan-workflow.test.mjs
  modified:
    - SPECIFICATION.md (section 7: new subsection on the PR-blocking gate + scheduled scan as one observability mechanism)
decisions:
  - "The gate step in advisory-scan.yml is byte-for-byte identical to ci.yml's `run: npm run check:dependency-advisories` line, with no continue-on-error and no output redirection on that line -- this is what the drift test's strict string-equality assertion proves. Output capture for the issue body happens via a SEPARATE follow-up step (`if: failure()`) that re-invokes the same script with stdout redirected to a file. This was necessary because the plan's own drift-test design (`assert the two invocation strings are identical`) precludes modifying the gate step's run: text to add redirection, while D-13 still requires the issue body to name the specific package/advisory that failed."
  - "The dedup label is defined once as a JS `const label = \"dependency-advisory\"` inside the github-script step (structural drift protection: search and creation both reference the same variable, so they cannot diverge at the code level) AND the literal string also appears once in the header comment (documentation, and satisfies the drift test's textual grep-count>=2 assertion) -- two different senses of 'cannot drift apart' satisfied by two different mechanisms."
  - "actions/github-script@v9 (commit 3a2844b7e9c422d3c10d287c895573f7108da1b3) resolved fresh via `gh api repos/actions/github-script/commits/v9` at implementation time -- this is the only action pinned that isn't reused verbatim from ci.yml/images.yml, since neither existing workflow uses github-script."
metrics:
  duration: ~35 minutes
  completed: 2026-08-20
---

# Phase 18 Plan 04: Scheduled Dependency Advisory Scan Summary

Gave the dependency advisory gate a heartbeat: `.github/workflows/advisory-scan.yml` runs the byte-identical `check:dependency-advisories` npm script daily on master (plus on-demand via `workflow_dispatch`), and a failure opens or updates one labelled, deduplicated GitHub issue naming the failing package and advisory id -- proven mechanically by a drift test that derives both workflows' invocation strings and asserts equality.

## What Was Built

**Task 1 (RED, committed `12d958d`):** `scripts/__tests__/advisory-scan-workflow.test.mjs` -- 9 test cases asserting the scheduled workflow's invariants before the workflow file existed: file exists; exactly one daily `cron:` (day-of-month and month wildcards, minute/hour fixed); `workflow_dispatch:` present; top-level `permissions:` block with exactly `{contents: read, issues: write}` (key set asserted exactly, not just presence); every `uses:` line pinned to a 40-character commit SHA with a trailing version comment; the gate invocation derived from both `ci.yml` and `advisory-scan.yml` and asserted string-equal (not hardcoded); an `if: failure()` guard on the issue-surfacing step; the dedup label literal (`dependency-advisory`) appearing at least twice in the file; `node-version-file: .nvmrc` present. All 9 failed with the workflow file absent -- confirmed via `npx vitest run --root scripts __tests__/advisory-scan-workflow.test.mjs` (exit 1, `/tmp/scan-red.txt`).

**Task 2 (GREEN, committed `64047e9`):**
- `.github/workflows/advisory-scan.yml` -- name `Advisory scan`. Header comment cites D-12 (separate workflow, not a `schedule:` on `ci.yml`, so a daily tick doesn't spin the Postgres/Redis/browser matrix), D-13 (labelled issue, not an operator-alert email, and why), D-14 (daily cadence makes accept-list expiry self-enforcing with zero PR activity, and is also SC3's mechanism for surfacing a newly-published advisory with no code change). Triggers: `schedule:` (`cron: "17 3 * * *"`, off-peak UTC, hour explicitly documented as not load-bearing) + `workflow_dispatch:`. `concurrency:` group `${{ github.workflow }}-${{ github.ref }}` with `cancel-in-progress: true`, matching `ci.yml`/`images.yml`. Top-level `permissions: {contents: read, issues: write}` -- the only two scopes, explicit (unlike `ci.yml`, which relies on the default token). One job (`scan`): `actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5` and `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4` (both SHAs reused verbatim from `ci.yml`) with `node-version-file: .nvmrc`, `npm ci`, then the gate step `run: npm run check:dependency-advisories` (byte-identical to `ci.yml`'s `static` job step of the same name), then (both `if: failure()`) a capture step that re-invokes the same script with stdout redirected to `/tmp/advisory-gate-output.txt`, then `actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9` (resolved fresh via `gh api repos/actions/github-script/commits/v9`) which searches `issues.listForRepo({state: "open", labels: "dependency-advisory"})`, creates a new labelled issue (label attached at creation) naming the run URL and captured findings if none is open, or `issues.createComment` on the existing one otherwise. No try/catch around the GitHub API calls -- a failure there fails the step loudly (T-18-19).
- `SPECIFICATION.md` section 7 -- new subsection "Dependency advisory gate: CI-blocking check + daily scheduled scan (Phase 18, планы 18-01/18-04)" describing both halves (PR-blocking `static`-job step and the new scheduled scan) as one mechanism, naming the workflow file, the label, the permissions scope, the SHA-pinning provenance, and D-14's self-enforcing expiry behaviour.

## Verification

- `npx vitest run --root scripts __tests__/advisory-scan-workflow.test.mjs` -- 9/9 passed (RED at Task 1, GREEN at Task 2)
- `npm run check:dependency-advisories` -- exits 0, `1 advisory examined, 0 accept-list entries applied, 0 blocking finding(s)` (unaffected by this plan's changes, still the 18-03 GREEN baseline)
- `npm run lint` -- exits 0 (whole-repo, `eslint . --max-warnings=0`)
- `npm run check:spec-env-coverage` -- exits 0, `54 name(s) checked, all present in SPECIFICATION.md`
- All of Task 2's acceptance-criteria shell one-liners re-run individually and confirmed: `workflow-exists`, `workflow_dispatch` count 1, `cron:` count 1, `same-path-ok` (identical `npm run check:dependency-advisories` substring in both files), `pinned-ok` (3/3 `uses:` lines SHA-pinned), `perms-count-ok` (exactly 2 permission keys) + `issues: write` present, `if: failure()` count 3, dedup label count 2, `node-version-file: .nvmrc` count 1, `D-(12|13|14)` citation count 6
- YAML syntactically validated with Node's `yaml` package (parses cleanly; `on`/`permissions`/`jobs.scan.steps` structure inspected and confirmed correct)

## Deferred to Phase Verification (human-check, per plan's own TIMING note)

The plan's Task 2 `<verify><human-check>` is explicitly scheduled for **after** this phase's PR merges `advisory-scan.yml` to `master` -- GitHub only offers "Run workflow" for a workflow present on the default branch, and dispatching an earlier attempt returns a 404 that is not evidence of a defect. This plan's own `human_verify_mode` config is `end-of-phase`, matching this deferral. Not run in this worktree execution; the live dispatch (scratch branch with a deliberately-expired accept-list entry, two dispatches, confirming exactly one issue opens and the second run comments rather than duplicating) remains to be exercised at phase-end verification, with the issue number and both run URLs recorded there.

## Deviations from Plan

### Auto-fixed Issues

None -- both tasks executed within their own scope; no bugs, missing functionality, or blocking issues were discovered in code this plan did not touch.

### Design decision: gate step output capture via a second invocation, not the same step's stdout

The plan's Task 2 `<action>` text says to "give the gate step an id and capture its stdout to a file or step output," while the same plan's Task 1 `<action>` and Task 2 acceptance criteria require the gate invocation strings in `ci.yml` and `advisory-scan.yml` to be asserted as string-EQUAL by the drift test ("assert the two invocation strings are identical... so a rename or divergence fails CI"). GitHub Actions does not expose a bare `run:` step's stdout as a step output without modifying that step's `run:` text (e.g. appending `| tee file.txt`), and any such modification would break the required byte-for-byte equality with `ci.yml`'s line. Resolved by keeping the gate step's `run:` line untouched (satisfying the equality requirement) and adding a second, `if: failure()`-guarded step that re-invokes the identical npm script with output redirected to a file purely for issue-body construction. This is not a second, divergent GATE implementation (the thing T-18-20/the prohibition actually guards against) -- it is the same script, same code path, executed a second time within the same job only when the first invocation already failed. Documented here as a deliberate reconciliation of two plan constraints that were in tension, not a silent deviation.

### SPECIFICATION.md placement

Filed under section 7 «Наблюдаемость» as instructed (a new CI-level observability mechanism), as one subsection covering BOTH the pre-existing PR-blocking gate (18-01) and this plan's scheduled scan, rather than two separate entries -- matches the plan's own framing ("describing the dependency advisory gate as a CI-level observability mechanism -- the PR-blocking step... the daily scheduled scan... the deduplicated labelled GitHub issue... and the accept-list's expiry-driven red-build behaviour"). Section 6 (HTTP entry points) left untouched, as instructed -- no HTTP surface was added.

## Auth Gates

None encountered. `gh auth status` was already authenticated in this environment (used read-only to resolve the `actions/github-script` commit SHA via the public GitHub API; no write/push operation performed against GitHub from this session).

## Known Stubs

None. The scheduled workflow is a complete, production-quality implementation -- not a placeholder pending a later plan.

## Threat Flags

None beyond what this plan's own `<threat_model>` (T-18-15 through T-18-20) already enumerated and mitigated as specified: explicit two-key `permissions:` block (T-18-15), full-SHA pinning on every `uses:` line (T-18-16), label-scoped dedup with label-at-creation (T-18-17), advisory-only issue body content -- package names, GHSA ids, run link, no lockfile/env/secret content (T-18-18, accepted), no swallowed GitHub API errors (T-18-19), byte-identical gate invocation proven by the drift test (T-18-20).

## Self-Check: PASSED

- `.github/workflows/advisory-scan.yml` -- FOUND
- `scripts/__tests__/advisory-scan-workflow.test.mjs` -- FOUND
- `SPECIFICATION.md` section 7 subsection -- FOUND (grep-confirmed)
- Commit `12d958d` -- FOUND
- Commit `64047e9` -- FOUND
