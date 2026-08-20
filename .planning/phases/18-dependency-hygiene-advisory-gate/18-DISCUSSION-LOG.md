# Phase 18: Dependency Hygiene & Advisory Gate - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-20
**Phase:** 18-Dependency Hygiene & Advisory Gate
**Areas discussed:** Scanner tooling, Accept-list design, Scan scope & severity, Scheduled scan surfacing

---

## Scanner tooling

| Option | Description | Selected |
|--------|-------------|----------|
| npm audit + wrapper (Recommended) | Custom check:dependency-advisories script over `npm audit --json`; matches 15 existing check:* gates, zero new dependencies, native GHSA ids, workspace-aware | ✓ |
| osv-scanner | Google binary against OSV.dev (broader DB); new pinned external binary in CI; accept-list logic still custom | |
| audit-ci | Third-party npm package with built-in allowlist, but no owner/expiry semantics — would be wrapped anyway | |

**User's choice:** npm audit + wrapper

| Option | Description | Selected |
|--------|-------------|----------|
| Full scan, no diff (Recommended) | Gate fails on ANY HIGH not on the accept-list; DEP-01 makes the baseline clean, so any failure is new by construction | ✓ |
| True diff vs master | Compare PR-branch advisories vs master's; more code, tolerates untriaged advisories on master | |

**User's choice:** Full scan, no diff

| Option | Description | Selected |
|--------|-------------|----------|
| Fail closed + retry (Recommended) | Retry then fail the job on registry outage — consistent with the Alloy-gate fail-closed precedent | ✓ |
| Fail open with loud warning | Pass with a prominent warning on endpoint failure | |

**User's choice:** Fail closed + retry

---

## Accept-list design

| Option | Description | Selected |
|--------|-------------|----------|
| JSON file + schema check (Recommended) | Repo-root JSON validated by the gate; advisory id, package, justification, owner, expiry all mandatory; malformed entry = failure | ✓ |
| Markdown table doc | Human-first doc parsed by the gate; fragile parsing, weak schema enforcement | |
| Inline in package.json | Custom field in root package.json; mixes concerns | |

**User's choice:** JSON file + schema check

| Option | Description | Selected |
|--------|-------------|----------|
| 90-day cap (Recommended) | Gate rejects expiry >90 days out; quarterly re-triage; renewal via reviewed PR | ✓ |
| No cap, any future date | Owner picks any expiry; de-facto permanent acceptances possible | |
| 180-day cap | Semi-annual re-triage; less churn | |

**User's choice:** 90-day cap

| Option | Description | Selected |
|--------|-------------|----------|
| Inline justification field (Recommended) | Entry's justification IS the reachability analysis; required multi-sentence field, length-enforced | ✓ |
| Separate analysis doc per advisory | docs/advisories/GHSA-xxxx.md referenced from entry; two artifacts to keep in sync | |

**User's choice:** Inline justification field

| Option | Description | Selected |
|--------|-------------|----------|
| Git author email (Recommended) | Accountable person's git email; matches repo attribution | ✓ |
| GitHub username | Readable in PRs, not verifiable offline | |
| Free-text role | Survives personnel changes but nobody specific is accountable | |

**User's choice:** Git author email

---

## Scan scope & severity

| Option | Description | Selected |
|--------|-------------|----------|
| Full tree, accept-list tooling (Recommended) | Scan everything incl. devDependencies; tooling-only HIGHs triaged — makes DEP-03 meaningful | ✓ |
| Prod deps only (--omit=dev) | Simpler, but tooling compromises never surface and DEP-03 becomes dead letter | |

**User's choice:** Full tree

| Option | Description | Selected |
|--------|-------------|----------|
| HIGH + CRITICAL block (Recommended) | Matches DEP-02 wording; moderate/low never block | ✓ |
| HIGH+CRITICAL block, moderate reported | Same blocking plus non-blocking moderate summary in CI output | |
| Moderate+ blocks | Stricter than required; more noise | |

**User's choice:** HIGH + CRITICAL block

| Option | Description | Selected |
|--------|-------------|----------|
| Record as resolved (Recommended) | drizzle-kit already devDep; full-tree scan covers it like other tooling | |
| Keep open for planner | Planner re-verifies with runtime-import evidence | |

**User's choice:** Free-text (Other): direct placement resolved (devDep), but advisory triage remains open — the production tree still includes drizzle-kit transitively via better-auth (`npm ls drizzle-kit --omit=dev`); planner must verify runtime reachability, then upgrade or add a time-limited accept-list entry.
**Notes:** Chain verified during discussion: `@mega-crm/api → better-auth@1.6.23 → drizzle-kit@0.31.10`.

| Option | Description | Selected |
|--------|-------------|----------|
| Accept-list bridge, then upgrade (Recommended) | Immediate ≤90-day acceptance naming the pending major upgrade; upgrade lands within the window | |
| Upgrade immediately, always | A reachable HIGH always forces the major bump right away, however disruptive | ✓ |
| Case-by-case, no default | No recorded policy; fresh operator judgment each time | |

**User's choice:** Upgrade immediately, always (user chose stronger posture than the recommendation)

---

## Scheduled scan surfacing

| Option | Description | Selected |
|--------|-------------|----------|
| Separate workflow, cron (Recommended) | New advisory-scan.yml, daily cron on master, same gate script as PR gate (SC3 same reporting path) | ✓ |
| Cron trigger added to ci.yml | One file, but every tick runs the full CI matrix | |

**User's choice:** Separate workflow

| Option | Description | Selected |
|--------|-------------|----------|
| Red run + GitHub issue (Recommended) | Failure auto-opens/updates a deduped labeled issue naming package + advisory id | ✓ |
| Red run + operator alert email | Reuses platform operator-alert path; wires CI into app infra, path itself unobserved tech debt | |
| Red workflow run only | Default GitHub notification; easy to miss | |

**User's choice:** Red run + GitHub issue

| Option | Description | Selected |
|--------|-------------|----------|
| Daily (Recommended) | Exposure window ≤24h; expired accept-list entries turn cron red within a day | ✓ |
| Weekly | Less noise, up to 7 days unnoticed exposure | |

**User's choice:** Daily

---

## Claude's Discretion

- Exact script/file names, CI job placement, retry counts/backoff, issue label naming, JSON schema details
- Fail-first proof mechanics for SC2 (follow Phase 8/15 fail-first evidence pattern)

## Deferred Ideas

None — discussion stayed within phase scope.
