# Phase 18: Dependency Hygiene & Advisory Gate - Context

**Gathered:** 2026-08-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Fix every applicable HIGH advisory in a reachable production path by actual upgrades, and put dependency advisories under CI control: a PR that introduces a dependency with a new untriaged HIGH advisory fails CI (naming package + advisory id, proven fail-first), a scheduled full scan surfaces advisories newly published against already-installed dependencies through the same reporting path, and findings proven unreachable are accepted explicitly via an accept-list whose entries require justification, owner, and expiry — an expired or malformed entry is rejected by the gate. Requirements: DEP-01, DEP-02, DEP-03. No formal zero-HIGH requirement.

Builds on the shipped v1.1 CI quality-gate machinery from Phase 8. Does not touch runtime application behavior except where dependency upgrades require it.

</domain>

<decisions>
## Implementation Decisions

### Scanner tooling
- **D-01:** Gate is a custom wrapper script over `npm audit --json` (a `check:*`-style npm script, matching the 15 existing gate scripts). No new scanner dependency (osv-scanner and audit-ci rejected). Advisory identity = GHSA ids as reported by npm audit.
- **D-02:** No diff machinery. The gate fails on ANY blocking-severity advisory not on the accept-list. "New/untriaged" is implied by construction: DEP-01 makes the baseline clean first (everything present is either fixed or accept-listed), so any subsequent failure IS new. No master-state fetch, fully deterministic.
- **D-03:** Registry/endpoint failure at CI time = fail closed after a few retries — consistent with the established gate pattern (unavailable tooling is a violation, never a skip, per the Alloy-gate precedent).

### Accept-list design
- **D-04:** Accept-list is a JSON file at repo root (e.g. `.advisory-accept-list.json`), schema-validated by the gate itself. Mandatory fields per entry: advisory id (GHSA), package, justification, owner, expiry. A malformed entry (missing/empty field) fails the gate — SC4.
- **D-05:** Expiry cap: 90 days. The gate rejects entries whose expiry is more than 90 days in the future. Renewal = a reviewed PR touching the entry. — **Reversibility:** reversible — a constant in the gate script.
- **D-06:** The `justification` field IS the DEP-01 reachability analysis — one artifact, one review surface. The gate enforces a non-trivial minimum length so a one-word justification cannot pass. No separate per-advisory analysis docs.
- **D-07:** `owner` field = git author email of the accountable person (matches repo attribution conventions).

### Scan scope & severity
- **D-08:** Scan the FULL dependency tree including devDependencies (NOT `--omit=dev`). Tooling-only HIGHs get triaged like everything else: fixed if cheap, accept-listed with reachability analysis otherwise. This is what makes DEP-03 meaningful — a prod-only scan would leave it a dead letter.
- **D-09:** Blocking threshold: HIGH and CRITICAL. Moderate/low never block (matches DEP-02 wording; keeps signal clean). At discussion time the prod tree had 6 HIGH advisories, all with non-major fixes available: brace-expansion, fast-uri, find-my-way, nanoid, postcss, react-router.
- **D-10:** drizzle-kit (roadmap plan-time decision): direct dependency placement is ALREADY resolved — `drizzle-kit@0.31.10` sits in `devDependencies` of `packages/db`. However, advisory triage remains OPEN: the production tree still includes drizzle-kit transitively via `apps/api → better-auth@1.6.23 → drizzle-kit` (verified with `npm ls drizzle-kit --omit=dev`). The planner must verify runtime reachability of that transitive copy and then either upgrade or add a time-limited accept-list entry.
- **D-11:** Semver-major fix policy: a reachable HIGH always forces the upgrade immediately, even when the only fix is a semver-major bump — no accept-list bridging for reachable production-path findings. (User explicitly chose the strongest posture over the recommended bridge option.)

### Scheduled scan surfacing
- **D-12:** Scheduled scan lives in a SEPARATE workflow (`.github/workflows/advisory-scan.yml`) with a daily cron on master — not a `schedule:` trigger on ci.yml (which would run the full CI matrix per tick). It runs the exact same gate script as the PR gate, satisfying SC3's "same reporting path".
- **D-13:** Human surfacing: a failed scheduled run auto-opens (or updates) a labeled GitHub issue naming the package and advisory id, deduplicated so repeat runs update one issue instead of spamming. Operator-alert email path explicitly rejected (wires CI into app infrastructure; that email path itself is unobserved tech debt).
- **D-14:** Daily cadence. Side effect intentionally relied upon: an accept-list entry that expires during a quiet period turns the cron red within ≤24h — expiry is enforced even with zero PR activity.

### Claude's Discretion
- Exact script/file names, CI job placement (existing `static` job vs its own job), retry counts/backoff for D-03, issue label naming, and JSON schema details — planner/executor decide within the decisions above.
- Fail-first proof mechanics for SC2 (proving the gate red against the pre-fix state before fixing) — follow the established Phase 8/15 fail-first evidence pattern.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — DEP-01, DEP-02, DEP-03 (lines under "Dependency hygiene")
- `.planning/ROADMAP.md` — Phase 18 section: goal, 4 success criteria (incl. fail-first proof for SC2), plan-time decision on drizzle-kit (now refined by D-10)

### As-built documentation to update in the same change
- `SPECIFICATION.md` §2 «Зависимости и версии» — every version bump from DEP-01 fixes must be reflected here (hard project rule from `.claude/CLAUDE.md`); the new gate belongs in §6/§7 as applicable
- `.claude/CLAUDE.md` — "Project Specification" section defines exactly where new tooling/env vars/CI entries get documented

### Existing gate machinery (pattern source)
- `.github/workflows/ci.yml` — 4 existing jobs (static, test, failure-injection, e2e); the PR gate joins this file
- `scripts/check-lockfile-npm10.mjs`, `scripts/validate-alloy-config.mjs`, `scripts/check-web-chunks.mjs` — closest analogs: standalone `check:*` gate scripts with fail-closed semantics and fail-first proofs

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- 15 existing `check:*`/`verify:*`/`lint:*` gate scripts in `scripts/` — the new `check:dependency-advisories` (name at discretion) follows this exact shape: standalone `.mjs`, npm script, wired as a required CI step
- `scripts/check-lockfile-npm10.mjs` — existing lockfile hygiene gate; the advisory gate is adjacent (both read the lockfile-resolved tree)
- Phase 15's Alloy-gate precedent (`ALLOY_VALIDATE_REQUIRE_BINARY=1`) — fail-closed-when-tooling-unavailable pattern reused for D-03

### Established Patterns
- Fail-first proof: every gate lands with recorded RED evidence against the pre-fix state (Phase 8/15 convention) — SC2 explicitly demands this
- Source-derived enumeration over hardcoded lists (runbook-coverage gate) — the advisory gate derives findings from `npm audit --json`, never a snapshot
- Monorepo: npm workspaces (`apps/*`, `packages/*`); root `npm audit` covers all workspaces from the single root lockfile

### Integration Points
- `.github/workflows/ci.yml` — PR gate step (required check via existing branch protection with admin enforcement)
- New `.github/workflows/advisory-scan.yml` — daily cron + GitHub issue creation (needs `issues: write` permission)
- Root `package.json` scripts block + repo-root accept-list JSON file

### Current audit state (evidence, 2026-08-20)
- `npm audit --omit=dev`: 6 HIGH / 0 CRITICAL / 4 moderate. All 6 HIGHs have fixes available, none semver-major: brace-expansion, fast-uri, find-my-way, nanoid, postcss (→8.5.26), react-router (→8.3.0)
- `npm ls drizzle-kit --omit=dev`: `@mega-crm/api → better-auth@1.6.23 → drizzle-kit@0.31.10` (transitive prod-tree presence despite devDep placement)

</code_context>

<specifics>
## Specific Ideas

- The bar for acceptance is deliberately high: user chose "upgrade immediately, always" for reachable HIGHs (D-11) over the recommended accept-list bridge — the accept-list exists for *unreachable* findings only, not as a snooze button.
- SC3's "same reporting path" is interpreted as: the scheduled workflow executes the identical gate script, not a parallel implementation.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 18-Dependency Hygiene & Advisory Gate*
*Context gathered: 2026-08-20*
