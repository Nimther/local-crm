---
phase: 18-dependency-hygiene-advisory-gate
verified: 2026-08-20T11:43:53Z
status: human_needed
score: 33/37 must-haves verified
behavior_unverified: 4 # 18-04's issue-surfacing runtime behaviors: opened-on-first-failure, commented-not-duplicated-on-second-failure, label-attached-at-creation (end-to-end), cron-catches-a-lapsed-entry-within-24h
overrides_applied: 0
re_verification: null
human_verification:
  - test: "Prerequisite: create the `dependency-advisory` label in Settings -> Labels (confirmed absent via `gh label list` at verification time — the plan's own note says this is deliberately not something the unattended cron job does)."
    expected: "Label exists before the dispatch exercise below, or the first real failure creates an issue with no label, breaking the next run's dedup search."
    why_human: "GitHub repository configuration; not code."
  - test: "18-04's deferred live dispatch (plan's own TIMING note): after this phase's PR merges advisory-scan.yml to master — (1) cut a scratch branch from master, add one .advisory-accept-list.json entry with an already-past expiry (other 4 fields valid) to force the gate red for the expiry reason; (2) in GitHub Actions, open 'Advisory scan', Run workflow against the scratch branch; (3) confirm a new issue opens, carries the dependency-advisory label as a chip (not just body text), and its body names the offending entry and links the failing run; (4) run the workflow a second time against the same branch — confirm NO second issue opens and the existing issue gets a new comment instead; (5) close the issue and delete the scratch branch. Report the issue number and both run URLs."
    expected: "Exactly one labelled issue opens on first failure; the second failure comments on the same issue rather than duplicating; the label is present as a chip at creation, not added after the fact."
    why_human: "GitHub Actions workflow_dispatch can only target a workflow file present on the default branch — dispatching before the phase PR merges returns a 404, confirmed impossible to exercise from this worktree (no PR exists for this branch: `gh pr status` shows none). This is the only path that exercises actions/github-script's real GitHub API calls; the drift test proves the workflow's static text (triggers, permissions, SHA pins, byte-identical gate invocation) but cannot execute issues.create/issues.createComment against the live API."
  - test: "SC3's literal scenario: a cron run on master, with no code change on the branch, surfaces an advisory newly published against an already-installed dependency, through the same gate script and the same issue path."
    expected: "The daily 03:17 UTC tick (or a manual dispatch on a day when the npm registry publishes a new advisory against one of this repo's already-installed packages) goes red and opens/updates the labelled issue with no PR involved."
    why_human: "This truth is authored as `verification: backstop` in 18-04-PLAN.md's own must_haves because it requires the npm advisory database to actually publish a new advisory during observation — it cannot be manufactured on demand or proven by static analysis. Every mechanical link in the chain (daily cron trigger, identical gate script, issue-surfacing path) is independently verified below; only the live registry-publishes-something-new event is unprovable without waiting and watching."
  - test: "CR-01 fix ratification (18-REVIEW-FIX.md's own request): confirm by inspection that the UTC-day-inclusive expiry semantics `selectBlockingFindings` now shares with `validateAcceptListEntry` genuinely match the intended D-05 contract (an accept-list entry is valid through the end of its expiry date, inclusive, regardless of what time of day UTC midnight has passed)."
    expected: "Reading scripts/check-dependency-advisories.mjs's shared parseExpiryUtcDayMs/toUtcDayMs helpers (used by both validateAcceptListEntry and selectBlockingFindings) confirms one shared UTC-day comparison, no drift between the two call sites."
    why_human: "The phase's own code-fixer flagged this as `fixed: requires human verification` (a logic-correctness fix to a date-comparison boundary, not a syntax change) despite the regression suite passing — this verifier independently reproduced the review's exact repro script against noon-UTC-on-the-expiry-day (see Behavioral Spot-Checks) and confirmed the entry is now suppressed correctly, which is strong supporting evidence, but the fixer's own charter asks for a human read of the shared-helper contract, not just a passing test."
  - test: "Ratify two flagged interpretive assumptions carried through all four plans: (a) DEP-01/DEP-02's edge classification against REQUIREMENTS.md is unresolved because the deterministic classifier is English-keyed and REQUIREMENTS.md is Russian (a known, expected project condition, not a defect); (b) DEP-02's literal Russian wording 'PR-diff + scheduled full-scan' is satisfied by D-02's no-diff-by-construction design (the gate fails on ANY blocking finding not accept-listed, with 'new/untriaged' implied by the clean DEP-01 baseline) rather than literal git-diff-against-master machinery."
    expected: "A human with the original Russian requirement text confirms the no-diff-by-construction interpretation satisfies the intent of 'PR-diff', or flags it for a plan revision."
    why_human: "Both are explicitly surfaced, not resolved, in every plan's own <flagged_assumptions> block — by design, per this project's known edge-probe classifier limitation (see project memory: 'Edge-probe English-keyed classifier')."
  - test: "Ratify the four judgment-tier prohibitions as resolved, with the evidence gathered below (not a rubber stamp — each has independent mechanical evidence, listed under Anti-Patterns/Prohibitions)."
    expected: "18-01: no continue-on-error/`|| true` in the static job (confirmed: 0 matches). 18-02: accept-list is never used to bridge a reachable finding (confirmed: .advisory-accept-list.json ships {\"entries\": []} and raw npm audit is 0 high/0 critical — nothing needed bridging). 18-03: gate reached green via real upgrades, not a weakened threshold/scope/accept-list (confirmed: raw npm audit metadata shows 0 high/0 critical directly, independent of the gate's own config). 18-04: scheduled scan is not a second gate implementation (confirmed: drift test asserts the two workflows' gate invocation strings are byte-identical, and this verifier read both files and confirmed the `npm run check:dependency-advisories` line is identical)."
    why_human: "Prohibitions are judgment-tier (`verification: judgment` in every plan's frontmatter) — per the escalation-gate protocol, judgment-tier items route through the end-of-phase human checkpoint even when supporting evidence is strong, never a silent pass."
---

# Phase 18: Dependency Hygiene & Advisory Gate Verification Report

**Phase Goal:** Vulnerable runtime dependencies are fixed, and a new untriaged HIGH advisory can no
longer reach master unnoticed — while findings proven unreachable are accepted explicitly, with an
owner and an expiry, instead of being ignored.

**Verified:** 2026-08-20T11:43:53Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths — ROADMAP Success Criteria

| # | Truth (ROADMAP SC) | Status | Evidence |
|---|---|---|---|
| SC1 | Every applicable HIGH advisory in a reachable production path is fixed by an actual upgrade; each still present carries a written reachability analysis | ✓ VERIFIED | Live `npm audit --json` metadata on the current tree: `{"high":0,"critical":0,"moderate":4,"total":4}`. All 9 pre-fix HIGH GHSA ids across 7 leaf packages are gone. The one remaining finding (drizzle-kit's moderate `@esbuild-kit` chain) is moderate, non-blocking, and carries a written reachability analysis in the gate script's own header comment (D-10, confirmed present: optional peerDependency of better-auth, unused by its shipped `dist/`). No HIGH/CRITICAL survivor exists, so the "each one still present carries a reachability analysis" clause is vacuously satisfied. |
| SC2 | A PR introducing a dependency with a new untriaged HIGH advisory fails CI, naming the package and advisory id — proven by a fail-first run against the pre-fix state | ✓ VERIFIED | `scripts/__fixtures__/dependency-advisories/pre-fix-audit.json` is the committed real captured pre-fix audit; `check-dependency-advisories.test.mjs`'s Tests 1-11 assert `collectAdvisories`/`selectBlockingFindings` reproduce exactly 9 blocking findings across 7 leaf packages against it, byte-stable. 18-01-SUMMARY.md records the live RED run's verbatim output (gate exit non-zero, all 9 GHSA ids and 7 packages named) as fail-first evidence. Gate is wired as a bare `run:` (no `continue-on-error`, no `\|\| true`) inside `ci.yml`'s `static` job — independently confirmed: `awk '/^  static:/,/^  test:/' .github/workflows/ci.yml \| grep -c 'npm run check:dependency-advisories'` returns `1`. |
| SC3 | A scheduled full scan surfaces an advisory newly published against an already-installed dependency, with no code change on the branch, through the same reporting path | ⚠️ PARTIAL — mechanically verified, live behavior unverified | The daily-cron + identical-script + issue-surfacing mechanism is fully built and its static shape is proven by a drift test (`advisory-scan-workflow.test.mjs`, 9/9 passing) that derives both workflows' gate-invocation strings and asserts byte equality. The literal "newly published advisory, no code change" scenario is authored as a `verification: backstop` truth in 18-04's own must_haves and cannot be manufactured on demand — routed to human verification. The end-to-end issue-creation/dedup runtime behavior is also unverified (workflow not yet on master; see Human Verification). |
| SC4 | An accept-list entry without justification, owner or expiry — or with an expiry that has passed — is rejected by the gate | ✓ VERIFIED | Live, independently reproduced against the current codebase (not test-suite-only): missing owner, short justification, non-email owner, and an expired date (yesterday relative to an injected `now`) are each rejected with a field-specific message (see Behavioral Spot-Checks below). Boundary cases independently confirmed live: expiry exactly `now`+90 days accepted, `now`+91 days rejected as exceeding the cap. |

### Observable Truths — Plan-Level Must-Haves (merged, deduplicated against SC1-4 above)

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | Gate names the LEAF package owning each advisory, not the compound parent | ✓ VERIFIED | Test suite: `concurrently` (compound parent) owns 0 records; `shell-quote` owns `GHSA-395f-4hp3-45gv`. |
| 2 | A package with only moderate/low advisories never appears in the blocking set, even if npm's rollup reads high | ✓ VERIFIED | Test suite pins `GHSA-fxqj-rqcc-2cmp` (postcss's moderate advisory) absent from `selectBlockingFindings` output; independently, live `npm audit` shows postcss no longer even carries this — moot post-upgrade but the mechanism is unit-tested against the fixture. |
| 3 | `via[]` string recursion resolves correctly; a cyclic reference terminates | ✓ VERIFIED | Test suite drives a deliberate cycle and asserts completion + each advisory appearing once. |
| 4 | npm audit's normal non-zero "found vulnerabilities" exit is parsed normally; only unparseable/empty output is a tool failure | ✓ VERIFIED | Test suite exercises `runNpmAuditWithRetries` against a non-zero-exit child process delivering a valid report on stdout. |
| 5 | Unparseable/empty audit output fails closed after the retry budget, never a pass | ✓ VERIFIED | Test suite asserts the thrown error names the attempt count; no skip path exists in the source. |
| 6 | Report ordering is deterministic (package, then advisory id) | ✓ VERIFIED | Test suite asserts sort order given shuffled input; live gate re-run twice historically confirmed byte-identical (18-01-SUMMARY.md `stable-ok`). |
| 7 | Gate runs as a step of ci.yml's `static` job, already a required status check | ✓ VERIFIED | Independently re-confirmed live: `awk` boundary check above returns `1`; no `continue-on-error`/`\|\| true` anywhere in the `static` job block (grep returns `0`). |
| 8 | Accept-list entry validation: mandatory fields, justification length, email-shaped owner, GHSA-shaped id, inclusive-expiry / 90-day-cap boundaries, missing-file-as-empty, malformed-JSON/non-array-entries/duplicate-pair-as-failure, exact (advisoryId+package) suppression matching, stale-entry-as-warning-not-failure | ✓ VERIFIED | Independently reproduced live against the current `scripts/check-dependency-advisories.mjs` (not just re-reading the 75-test suite): missing owner, short justification, non-email owner, expired-yesterday, today+90-accepted, today+91-rejected, and missing-file-returns-empty all reproduced with the exact expected messages (see Behavioral Spot-Checks). |
| 9 | CR-01: `selectBlockingFindings` and `validateAcceptListEntry` agree on the inclusive-UTC-day expiry boundary (post-review-fix) | ✓ VERIFIED (behaviorally) + routed to human ratification | Independently reproduced the review's exact repro script (noon UTC on the expiry day): pre-fix this returned a spurious blocking finding; post-fix it correctly returns `[]` (suppressed). Fixer's own charter still requests human read of the shared-helper contract — carried to Human Verification. |
| 10 | WR-01: severity comparison is case/type-normalized | ✓ VERIFIED | Independently reproduced: a `severity: "High"` (mixed case) finding is still correctly classified as blocking after the fix. |
| 11 | The three direct pins (postcss, react-router in apps/web; concurrently at root) are bumped to the exact planned versions | ✓ VERIFIED | Live `node -e` read of both package.json files: `postcss=8.5.26`, `react-router=8.3.0`, `concurrently=10.0.5` — exact match to plan targets. |
| 12 | Transitive advisories resolved via plain `npm audit fix`, removing nothing from the tree | ✓ VERIFIED (via outcome) | SUMMARY documents zero package removals were confirmed at execution time; independently confirmed via outcome: raw `npm audit` metadata shows exactly 4 moderate / 0 high / 0 critical remaining (matches the documented "before: 8 high 0 critical 4 moderate" minus the 8 fixed highs), consistent with a fix-not-remove operation. Not independently re-run (would require reverting the tree); relying on the SUMMARY's documented lockfile diff inspection plus the outcome check. |
| 13 | drizzle-kit's installed version is unchanged, not forced to 0.18.1 | ✓ VERIFIED | Live `npm ls drizzle-kit --json`: `0.31.10` at both `apps/api -> better-auth` and `packages/db` — single consistent version, not `0.18.1`. |
| 14 | package-lock.json still satisfies npm 10 | ✓ VERIFIED | Live `npm run check:lockfile-npm10` exits with pass message: "npm 10.9.9 accepts package-lock.json under docker/Dockerfile.{api,worker,web}'s node:22-slim pin." |
| 15 | Every workspace still typechecks/lints/tests, web chunk boundary gate still passes | UNVERIFIED (relied on SUMMARY/CI) — not a gap | Not independently re-run in this verification pass (full workspace build + `npm run coverage` + `check:web-chunks` are multi-minute, heavy operations out of scope for a fast verification pass, and 18-03-SUMMARY.md documents two full foreground `npm run coverage` runs with only the two known pre-existing environmental `sentry.test.ts` failures surviving). This verifier did independently re-run the lighter, fast checks: `npm run check:lockfile-npm10` (pass) and whole-repo `npm run lint` (pass, exit 0 — notably better than 18-01/18-02-SUMMARY's documented pre-existing failure, which appears to have been resolved by unrelated work since). CI's `test` job on the eventual PR remains the declared authority for the full suite, per the plan's own `<verification>` block. |
| 16 | SPECIFICATION.md records exact installed versions in both the dependency inventory (section 2) and the divergence table (section 8) | ✓ VERIFIED | Live grep: `postcss`, `react-router`, `concurrently` each appear with correct versions in both the section-2 inventory (lines 123, 188, 198) and the section-8 divergence table (lines 1575, 1580, 1582). Section 7 also updated (lines 1541-1545) describing the CI-blocking gate + scheduled scan as one observability mechanism, naming the workflow file and label. |
| 17 | Scheduled workflow runs daily on master, executes the identical npm script the PR gate runs | ✓ VERIFIED | Drift test (`advisory-scan-workflow.test.mjs`) derives both invocation strings from `ci.yml` and `advisory-scan.yml` and asserts equality — 9/9 passing, independently re-run. Read both files directly: both contain the byte-identical line `run: npm run check:dependency-advisories 2>&1 \| tee /tmp/advisory-gate-output.txt` with `shell: bash`. |
| 18 | workflow_dispatch present, so the path is exercisable on demand | ✓ VERIFIED | `.github/workflows/advisory-scan.yml` line 56: `workflow_dispatch:` present; drift test asserts it. |
| 19 | Scheduled workflow declares a minimal permissions block: exactly `contents: read` + `issues: write` | ✓ VERIFIED | Read `.github/workflows/advisory-scan.yml` lines 75-77: exactly those two keys. Drift test asserts the key SET is exactly two, not merely presence. |
| 20 | Every action pinned to a full 40-char commit SHA with trailing version comment | ✓ VERIFIED | Read the file: `actions/checkout@fbc6f...09 # v5`, `actions/setup-node@49933e...20 # v4`, `actions/github-script@3a2844...b3 # v9` — all 3 pinned. Drift test asserts every `uses:` line matches this shape. |
| 21 | Failed run opens a labelled GitHub issue naming the package and advisory id (D-13) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Code present and wired (reads `/tmp/advisory-gate-output.txt`, builds a body naming the run URL and captured findings, calls `issues.create` with `labels: [label]` in the same call). No test exercises the real GitHub API call — routed to human dispatch. |
| 22 | A second failed run comments on the same open issue instead of opening a duplicate | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | `issues.listForRepo({state:"open", labels: label})` followed by a branch to `issues.createComment` when `existing.data.length > 0` is present and wired in code. No live second-dispatch has been run — routed to human dispatch. |
| 23 | The issue is created WITH the dedup label attached at creation time (not after) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Code inspection confirms `labels: [label]` is passed in the same `issues.create` call (not a separate `addLabels` call afterward) — this is a strong static guarantee, but the end-to-end proof that the resulting issue actually carries the label chip (not just the API parameter) requires a live dispatch — routed to human dispatch per the plan's own explicit instruction to check "the issue's label chips, not just the body text." |
| 24 | An accept-list entry that lapses during a quiet period turns the scheduled run red within one cadence interval (D-14) | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Mechanically implied by SC4's expiry rejection (verified) plus the daily cron (verified) plus the identical gate script (verified) — but no live cron tick or dispatch has actually been observed to go red for this reason. Routed to human dispatch (the plan's own human-check step 1 constructs exactly this scenario). |
| 25 | SC3's literal "newly published advisory, no code change" scenario | insufficient_spec / backstop | Authored as `verification: backstop` in 18-04-PLAN.md's must_haves — abstains per Step 3.5b; routed to human verification, never marked VERIFIED or FAILED. |

**Score:** 33/37 truths verified (4 present + wired, behavior not exercised by any test — see `behavior_unverified_items`).

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `scripts/check-dependency-advisories.mjs` | Zero-dependency gate script | ✓ VERIFIED | Exists, all imports are `node:` built-ins (`total`==`builtin` grep check passes), exports confirmed live via dynamic import (`collectAdvisories`, `runNpmAuditWithRetries`, `selectBlockingFindings`, `formatFailureReport`, `BLOCKING_SEVERITIES`, `loadAcceptList`, `validateAcceptListEntry`, `MAX_EXPIRY_DAYS`, `MIN_JUSTIFICATION_LENGTH`, `ACCEPT_LIST_FILENAME` all present and behave as documented). |
| `scripts/__tests__/check-dependency-advisories.test.mjs` | Regression suite | ✓ VERIFIED | 82/82 tests pass, live re-run. |
| `scripts/__fixtures__/dependency-advisories/pre-fix-audit.json` | Real captured pre-fix npm audit output | ✓ VERIFIED | Present, referenced and consumed by the test suite's fixture-based assertions. |
| `.advisory-accept-list.json` | Empty, schema-valid accept-list | ✓ VERIFIED | `{"entries": []}` confirmed live. |
| `.github/workflows/advisory-scan.yml` | Daily scheduled scan workflow | ✓ VERIFIED | Present, read in full; matches SUMMARY's description exactly. |
| `scripts/__tests__/advisory-scan-workflow.test.mjs` | Workflow invariant drift test | ✓ VERIFIED | 9/9 tests pass, live re-run. |
| `SPECIFICATION.md` sections 2, 7, 8 | Dependency inventory, observability, divergence table updated | ✓ VERIFIED | All three sections confirmed to contain the correct entries via live grep. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `package.json` `check:dependency-advisories` script | `scripts/check-dependency-advisories.mjs` | npm script invocation | ✓ WIRED | Confirmed live: script exists and runs successfully. |
| `.github/workflows/ci.yml` `static` job | `npm run check:dependency-advisories` | CI step | ✓ WIRED | Confirmed live via `awk` boundary check; no soft-fail modifier. |
| `scripts/check-dependency-advisories.mjs` | `.advisory-accept-list.json` | repo-root read at gate time | ✓ WIRED | Confirmed: gate reads and validates the file (live malformed-entry test in 18-02-SUMMARY, independently re-derivable via `loadAcceptList`). |
| `.github/workflows/advisory-scan.yml` | `npm run check:dependency-advisories` | identical invocation to ci.yml's static-job step | ✓ WIRED | Confirmed live: byte-identical `run:` line in both files, drift test passing. |
| gate step failure | `actions/github-script` issue-surfacing step | `if: failure() && steps.gate.outcome == 'failure'` (WR-02 fix) | ✓ WIRED (statically) / ⚠️ runtime unverified | Code present and correctly scoped to the gate step's own outcome (post-WR-02 fix, narrower than plan's original job-wide `if: failure()`). Runtime execution unverified — see behavior_unverified_items. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Gate is GREEN on current tree | `npm run check:dependency-advisories` | `1 advisory examined, 0 accept-list entries applied, 0 blocking finding(s)` | ✓ PASS |
| Raw npm audit has 0 high/critical | `npm audit --json \| metadata.vulnerabilities` | `{"high":0,"critical":0,"moderate":4,"total":4}` | ✓ PASS |
| Full regression suite (gate) | `npx vitest run --root scripts __tests__/check-dependency-advisories.test.mjs` | 82/82 passed | ✓ PASS |
| Full regression suite (workflow drift) | `npx vitest run --root scripts __tests__/advisory-scan-workflow.test.mjs` | 9/9 passed | ✓ PASS |
| CR-01 fix: noon-UTC-on-expiry-day entry suppresses correctly | reproduced review's exact repro script | `validateAcceptListEntry: []`, `selectBlockingFindings: []` (correctly suppressed; pre-fix this returned the un-suppressed finding) | ✓ PASS |
| WR-01 fix: mixed-case severity still blocks | reproduced with `severity: "High"` | finding correctly retained as blocking | ✓ PASS |
| SC4: missing owner rejected | `validateAcceptListEntry({...base, owner: ""}, NOW)` | `["field \"owner\" is required..."]` | ✓ PASS |
| SC4: short justification rejected | `validateAcceptListEntry({...base, justification: "no"}, NOW)` | `["field \"justification\" must be at least 80 characters..."]` | ✓ PASS |
| SC4: non-email owner rejected | `validateAcceptListEntry({...base, owner: "not-an-email"}, NOW)` | `["field \"owner\" must be an email-shaped..."]` | ✓ PASS |
| SC4: expired entry rejected | `validateAcceptListEntry({...base, expiry: "2026-01-14"}, NOW)` (NOW=Jan 15 noon) | `["field \"expiry\" (2026-01-14) has passed..."]` | ✓ PASS |
| SC4: expiry boundary today+90 accepted, today+91 rejected | `validateAcceptListEntry` at both boundaries | `today+90: []`, `today+91: ["...exceeding the 90-day cap"]` | ✓ PASS |
| SC4: missing accept-list file treated as empty | `loadAcceptList("/tmp/does-not-exist...")` | `{fileExisted: false, entries: [], problems: []}` | ✓ PASS |
| drizzle-kit unchanged | `npm ls drizzle-kit --json` | `0.31.10` at both dependent paths | ✓ PASS |
| Lockfile still npm-10 compatible | `npm run check:lockfile-npm10` | pass | ✓ PASS |
| Whole-repo lint | `npm run lint` | exit 0 (no errors) | ✓ PASS — better than SUMMARY's documented pre-existing failure; see Anti-Patterns note |
| `dependency-advisory` GitHub label exists | `gh label list \| grep dependency-advisory` | no match | ✗ NOT YET CREATED — prerequisite for the human dispatch check |
| PR/branch state for live dispatch exercise | `gh pr status`, `git log origin/master..HEAD` | no PR exists for this branch; branch has unmerged commits | confirms the plan's own TIMING deferral is currently accurate — the workflow genuinely cannot be dispatched yet |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| DEP-01 | 18-03 (also touched by 18-01's fixture/header) | Все применимые HIGH advisories в достижимых production paths исправлены; остальные имеют документированный reachability-анализ и ограниченное по сроку исключение | ✓ SATISFIED | 0 high/0 critical in raw npm audit; drizzle-kit's remaining moderate finding carries a written reachability analysis (D-10). Human ratification requested only for the interpretive assumption around the Russian-text edge classification (see human_verification), not for the technical outcome. |
| DEP-02 | 18-01 (PR-gate half), 18-04 (scheduled-scan half) | CI блокирует появление новых неразобранных HIGH advisories (PR-diff + scheduled full-scan) | ✓ SATISFIED (with interpretation flagged) | PR-gate half fully live-verified (SC2). Scheduled-scan half mechanically verified (drift test, identical script, daily cron); end-to-end issue-surfacing runtime and the literal "PR-diff" wording vs. D-02's no-diff-by-construction design are both routed to human ratification. |
| DEP-03 | 18-02 | Доказанно недостижимые tooling-only findings принимаются через явный accept-list с justification и expiry (без формального zero-HIGH требования) | ✓ SATISFIED | Full schema validation independently reproduced live (see Behavioral Spot-Checks): all 5 mandatory fields, justification length, email-shaped owner, GHSA-shaped id, inclusive-expiry, 90-day cap, missing-file-as-empty, malformed-file-as-failure, exact suppression matching, stale-entry-as-warning. No orphaned requirement — all three IDs are claimed by at least one plan's `requirements:` frontmatter and REQUIREMENTS.md lists no additional Phase 18 ID beyond DEP-01/02/03. |

No orphaned requirements found.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| — | — | No TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER debt markers found in any phase-18-created/modified file (`scripts/check-dependency-advisories.mjs`, its test file, `advisory-scan.yml`, its test file) | — | ℹ️ Info — clean |
| `.planning/phases/18-dependency-hygiene-advisory-gate/18-REVIEW-FIX.md` | line ~32 | Internal documentation inconsistency: states test count "79→82(after WR-01)→91(after WR-02, unchanged)" but WR-02 only touched `advisory-scan.yml`/`ci.yml`, not `check-dependency-advisories.test.mjs` — live re-run confirms 82 tests, not 91 | ℹ️ Info | Doc-only drift in a fix report, not the codebase; does not affect gate correctness (independently re-verified: 82/82 passing). |
| `COVERAGE.md` | line 10 | Lists `issues.update` (title/body refresh) as `INTEGRATE`, but `advisory-scan.yml` only calls `listForRepo`/`create`/`createComment` — no `issues.update` call exists in the shipped workflow | ℹ️ Info | Doc drift in the API coverage matrix, not a functional gap: the must-have ("second run updates the issue") is satisfied by `createComment`, which does update the issue (adds visible new content to it). |
| `.github/workflows/ci.yml` static job | 166-168 | `Dependency advisory gate (DEP-01/02/03)` step | — | ✓ No `continue-on-error`, no `\|\| true`, no conditional — confirmed live, satisfies the 18-01 prohibition. |

No blocker-level anti-patterns found.

### Deferred Items

None — all items not fully verified are either explicit `backstop`/behavior-unverified truths routed to human verification, or heavy re-runs explicitly out of scope for this pass (see truth #15's evidence column), not items deferred to a later milestone phase.

## Prohibitions (judgment-tier — routed to human checkpoint per escalation protocol)

| Plan | Prohibition | Evidence gathered |
|---|---|---|
| 18-01 | MUST NOT make the CI step soft-failable (no `continue-on-error`, no `\|\| true`, no kill-switch) | Live grep of the `static` job block: `continue-on-error\|\|\| true` count is `0`. |
| 18-02 | MUST NOT accept-list a reachable advisory (accept-list is for proven-unreachable findings only) | `.advisory-accept-list.json` is `{"entries": []}` — nothing was ever accept-listed; raw `npm audit` is 0 high/0 critical, so nothing needed bridging. |
| 18-03 | MUST NOT reach green by weakening the gate (no threshold raise, no accept-listing a reachable finding, no forced downgrade, no scope narrowing) | Raw `npm audit --json` metadata (independent of the gate's own configuration) directly shows 0 high/0 critical — the green state is the actual dependency tree's actual state, not a gate reconfiguration. `drizzle-kit` confirmed unchanged at 0.31.10 (not forced to 0.18.1). |
| 18-04 | MUST NOT let the scheduled scan become a second, divergent gate implementation | Drift test asserts byte-equality of both workflows' gate-invocation lines; independently read both files and confirmed the lines are identical. |

All four carry hard mechanical evidence and are ready for a human rubber-stamp at the end-of-phase checkpoint — not silently passed.

### Human Verification Required

See the `human_verification` list in this file's YAML frontmatter for the full detail of each item (prerequisite label creation, the deferred live dispatch exercise, SC3's backstop scenario, CR-01's fixer-requested ratification, the two flagged interpretive assumptions, and the four judgment-tier prohibitions).

### Gaps Summary

No blocking gaps. Every roadmap Success Criterion has either live, independently-reproduced evidence (SC1, SC2, SC4) or a fully-built, drift-tested mechanism whose only unproven element is a live GitHub Actions API round trip that cannot be exercised until this phase's PR merges to master (SC3, plus the 4 issue-surfacing truths bucketed under `behavior_unverified_items`). This is not a code defect — it is the plan's own documented TIMING deferral (18-04-PLAN.md's `<human-check>` block), correctly carried forward to end-of-phase verification exactly as designed. Status is `human_needed`, not `passed`, because that human verification set is non-empty; it is also not `gaps_found`, because no truth actually failed against the codebase — everything the codebase itself controls is present, wired, and functioning as claimed.

---

_Verified: 2026-08-20T11:43:53Z_
_Verifier: Claude (gsd-verifier)_
