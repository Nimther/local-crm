---
phase: 18
slug: dependency-hygiene-advisory-gate
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-20
---

# Phase 18 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| npm registry → gate script | `npm audit --json` output is remote-controlled content parsed by a script that runs in CI with the job's token in the environment | untrusted JSON advisory data |
| repo tree → gate script | `.advisory-accept-list.json` is repo-authored, review-gated input that decides whether a known vulnerability stops blocking CI | acceptance entries (advisoryId, package, owner, expiry) |
| PR author → accept-list | anyone who can open a PR can propose an acceptance; the gate's schema is the machine half of the review | proposed suppressions |
| gate script → CI status | the script's exit code is the entire enforcement surface for DEP-02 | pass/fail signal |
| npm registry → build tree | every upgraded package is remote code entering the production images and the CI runner | package tarballs / lockfile integrity hashes |
| GitHub Actions runner → GitHub REST API | the scheduled job holds a token with write access to Issues, the only write grant anywhere in this repository's CI | `GITHUB_TOKEN` (issues: write) |
| third-party action code → job token | `actions/github-script` executes vendor code in the same job that holds the `issues: write` token | job token exposure to pinned action code |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-18-01 | Tampering | `collectAdvisories` parsing registry-supplied `vulnerabilities` keys | medium | mitigate | own-property reads via `Object.prototype.hasOwnProperty.call` (`scripts/check-dependency-advisories.mjs:189,454,551`); advisory fields treated as opaque strings | closed |
| T-18-02 | Denial of Service | `via[]` recursion | medium | mitigate | `seen` Set terminates cyclic/diamond references (`scripts/check-dependency-advisories.mjs:184-188`); cycle unit-tested | closed |
| T-18-03 | Repudiation | registry unreachable at CI time | high | mitigate | `runNpmAuditWithRetries` retries then THROWS fail-closed (`scripts/check-dependency-advisories.mjs:258,295`); no downgrade path to a pass | closed |
| T-18-04 | Elevation of Privilege | the ci.yml gate step | high | mitigate | bare `run:` step in required `static` job, no `continue-on-error`/`\|\| true`/conditional; `shell: bash` enables pipefail so `tee` cannot mask failure (`.github/workflows/ci.yml:166-168`) | closed |
| T-18-05 | Spoofing | wrong-schema audit document accepted as authoritative | medium | mitigate | `auditReportVersion === 2` assertion; any other shape counts as a failed attempt (`scripts/check-dependency-advisories.mjs:281-285`) | closed |
| T-18-06 | Repudiation | accept-list as a permanent ignore mechanism | high | mitigate | `advisoryId`, `package`, `justification`, `owner`, `expiry` all mandatory (`MANDATORY_ACCEPT_LIST_FIELDS`, line 149); `MAX_EXPIRY_DAYS = 90` enforced by the gate (line 126) — lapsed acceptance turns the build red | closed |
| T-18-07 | Tampering | `loadAcceptList` parsing repo-authored JSON | medium | mitigate | strict per-field validation, `Map`-based duplicate detection (`seenPairs`, line 548), own-property reads; malformed input fails the gate rather than reading as zero acceptances | closed |
| T-18-08 | Spoofing | an unaccountable `owner` value | medium | mitigate | non-empty, email-shaped owner required (D-07, `scripts/check-dependency-advisories.mjs:142`); blank/placeholder owner is a named-field rejection | closed |
| T-18-09 | Elevation of Privilege | over-broad entry suppressing more than granted | medium | mitigate | suppression requires exact `advisoryId` AND leaf-package match, no wildcards (`scripts/check-dependency-advisories.mjs:302`); unit-tested in both mismatch directions | closed |
| T-18-10 | Repudiation | timezone-dependent expiry | low | mitigate | all expiry comparisons in UTC day units via `parseExpiryUtcDayMs`/`toUtcDayMs` (`scripts/check-dependency-advisories.mjs:309-313`); unit-tested near a UTC day boundary | closed |
| T-18-SC | Tampering | npm installs performed by plan 03 | high | mitigate | zero new packages introduced — every change a version bump of an already-audited dependency; `npm audit fix` run without `--force`; lockfile diff PR-reviewed | closed |
| T-18-11 | Tampering | `npm audit fix --force` downgrading drizzle-kit to 0.18.1 | high | mitigate | `--force` never invoked; installed drizzle-kit verified at 0.31.10 (package-lock.json), not 0.18.1 | closed |
| T-18-12 | Denial of Service | an upgrade regressing the production runtime | medium | mitigate | full workspace build, lint, aggregate test suite and web chunk boundary gate re-run green against a fresh build (18-VERIFICATION.md) | closed |
| T-18-13 | Tampering | lockfile satisfying npm 11 but not the npm 10 in production images | high | mitigate | `check:lockfile-npm10` script present (`package.json:22`) and re-run after the upgrade per 18-03-SUMMARY.md | closed |
| T-18-14 | Repudiation | reaching a green gate by weakening it rather than upgrading | high | mitigate | `.advisory-accept-list.json` is empty (`{"entries": []}`); live `npm audit` reports high: 0, critical: 0 independent of gate configuration | closed |
| T-18-15 | Elevation of Privilege | scheduled workflow's `GITHUB_TOKEN` scope | high | mitigate | explicit `permissions:` block granting exactly `contents: read` + `issues: write` (`.github/workflows/advisory-scan.yml:75-77`); drift test asserts key COUNT is two | closed |
| T-18-16 | Tampering | floating action tag re-pointed at attacker code with Issues-write token | high | mitigate | every `uses:` pinned to a full 40-char commit SHA with version comment (advisory-scan.yml:84,86,130); asserted by drift test | closed |
| T-18-17 | Denial of Service | daily failures spamming the issue tracker | medium | mitigate | label-scoped `issues.listForRepo` dedup with the `dependency-advisory` label defined once and attached at creation (advisory-scan.yml:137,164-177); second-run-comments behavior human-verified (18-UAT.md) | closed |
| T-18-18 | Information Disclosure | issue body leaking repository internals into a possibly-public tracker | low | accept | see Accepted Risks Log AR-18-01 | closed |
| T-18-19 | Repudiation | silently-failed issue-creation making an unattended red run look clean | medium | mitigate | the only `try/catch` in the github-script step wraps the local output-file read with an explicit fallback string; GitHub API errors propagate and fail the step loudly; workflow red status remains the backstop | closed |
| T-18-20 | Spoofing | scheduled scan diverging into a second gate implementation | medium | mitigate | workflow runs the identical npm script; `scripts/__tests__/advisory-scan-workflow.test.mjs` drift test derives the invocation from both files and asserts byte equality | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-18-01 | T-18-18 | The scheduled-scan issue body carries only package names, GHSA ids and a workflow-run link — all already-public information published by the npm advisory database. No lockfile contents, environment values, or secrets are included (confirmed in advisory-scan.yml's body construction). | 18-04-PLAN.md threat model (plan-time disposition) | 2026-08-20 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-20 | 21 | 21 | 0 | /gsd-secure-phase (L1 short-circuit — plan-time register, all mitigations verified at grep depth) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-20
