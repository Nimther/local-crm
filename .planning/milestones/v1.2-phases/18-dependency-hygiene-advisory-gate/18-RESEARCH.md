# Phase 18: Dependency Hygiene & Advisory Gate - Research

**Researched:** 2026-08-20
**Domain:** npm dependency vulnerability scanning, CI gate scripting, GitHub Actions issue automation
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Gate is a custom wrapper script over `npm audit --json` (a `check:*`-style npm script, matching the 15 existing gate scripts). No new scanner dependency (osv-scanner and audit-ci rejected). Advisory identity = GHSA ids as reported by npm audit.
- **D-02:** No diff machinery. The gate fails on ANY blocking-severity advisory not on the accept-list. "New/untriaged" is implied by construction: DEP-01 makes the baseline clean first (everything present is either fixed or accept-listed), so any subsequent failure IS new. No master-state fetch, fully deterministic.
- **D-03:** Registry/endpoint failure at CI time = fail closed after a few retries — consistent with the established gate pattern (unavailable tooling is a violation, never a skip, per the Alloy-gate precedent).
- **D-04:** Accept-list is a JSON file at repo root (e.g. `.advisory-accept-list.json`), schema-validated by the gate itself. Mandatory fields per entry: advisory id (GHSA), package, justification, owner, expiry. A malformed entry (missing/empty field) fails the gate — SC4.
- **D-05:** Expiry cap: 90 days. The gate rejects entries whose expiry is more than 90 days in the future. Renewal = a reviewed PR touching the entry. — Reversibility: reversible — a constant in the gate script.
- **D-06:** The `justification` field IS the DEP-01 reachability analysis — one artifact, one review surface. The gate enforces a non-trivial minimum length so a one-word justification cannot pass. No separate per-advisory analysis docs.
- **D-07:** `owner` field = git author email of the accountable person (matches repo attribution conventions).
- **D-08:** Scan the FULL dependency tree including devDependencies (NOT `--omit=dev`). Tooling-only HIGHs get triaged like everything else: fixed if cheap, accept-listed with reachability analysis otherwise. This is what makes DEP-03 meaningful — a prod-only scan would leave it a dead letter.
- **D-09:** Blocking threshold: HIGH and CRITICAL. Moderate/low never block (matches DEP-02 wording; keeps signal clean). At discussion time the prod tree had 6 HIGH advisories, all with non-major fixes available: brace-expansion, fast-uri, find-my-way, nanoid, postcss, react-router.
- **D-10:** drizzle-kit (roadmap plan-time decision): direct dependency placement is ALREADY resolved — `drizzle-kit@0.31.10` sits in `devDependencies` of `packages/db`. However, advisory triage remains OPEN: the production tree still includes drizzle-kit transitively via `apps/api → better-auth@1.6.23 → drizzle-kit` (verified with `npm ls drizzle-kit --omit=dev`). The planner must verify runtime reachability of that transitive copy and then either upgrade or add a time-limited accept-list entry. **Research resolves this** — see Pitfall 3: drizzle-kit's own advisory is MODERATE (below the D-09 blocking threshold) and better-auth's peer dependency on it is optional/unimported at runtime; no upgrade or accept-list entry is required today.
- **D-11:** Semver-major fix policy: a reachable HIGH always forces the upgrade immediately, even when the only fix is a semver-major bump — no accept-list bridging for reachable production-path findings. (User explicitly chose the strongest posture over the recommended bridge option.) **Research note:** none of the confirmed HIGHs in this repo currently require a semver-major bump, so this policy does not fire this phase — document it in the gate regardless, since it governs future findings.
- **D-12:** Scheduled scan lives in a SEPARATE workflow (`.github/workflows/advisory-scan.yml`) with a daily cron on master — not a `schedule:` trigger on ci.yml (which would run the full CI matrix per tick). It runs the exact same gate script as the PR gate, satisfying SC3's "same reporting path".
- **D-13:** Human surfacing: a failed scheduled run auto-opens (or updates) a labeled GitHub issue naming the package and advisory id, deduplicated so repeat runs update one issue instead of spamming. Operator-alert email path explicitly rejected (wires CI into app infrastructure; that email path itself is unobserved tech debt).
- **D-14:** Daily cadence. Side effect intentionally relied upon: an accept-list entry that expires during a quiet period turns the cron red within ≤24h — expiry is enforced even with zero PR activity.

### Claude's Discretion

- Exact script/file names, CI job placement (existing `static` job vs its own job), retry counts/backoff for D-03, issue label naming, and JSON schema details — planner/executor decide within the decisions above.
- Fail-first proof mechanics for SC2 (proving the gate red against the pre-fix state before fixing) — follow the established Phase 8/15 fail-first evidence pattern.

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-------------------|
| DEP-01 | Все применимые HIGH advisories в достижимых production paths исправлены; остальные имеют документированный reachability-анализ и ограниченное по сроку исключение | Full 8-HIGH inventory verified (Standard Stack, Code Examples); reachability traced per-package via `npm ls --omit=dev` (brace-expansion confirmed prod-reachable via bull-board; drizzle-kit confirmed non-blocking, see Pitfall 3); remediation commands verified non-major for all confirmed findings |
| DEP-02 | CI блокирует появление новых неразобранных HIGH advisories (PR-diff + scheduled full-scan) | Architecture Patterns (System Architecture Diagram, Pattern 1/2) gives the exact parsing/fail-closed logic; CI placement recommendation (static job) backed by repo's own recorded precedent; Validation Architecture maps DEP-02 to concrete test fixtures |
| DEP-03 | Доказанно недостижимые tooling-only findings принимаются через явный accept-list с justification и expiry (без формального zero-HIGH требования) | Accept-list JSON shape (Code Examples) derived directly from D-04..D-07; Common Pitfalls/Validation Architecture cover schema-validation test fixtures (malformed/expired/no-owner); Summary flags the accept-list will likely start empty — SC4 proven by unit tests, not a live entry |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **SPECIFICATION.md same-change rule (hard project rule):** any new npm package, env var, CI entry, or divergence from the Technology Stack section must be filed into `SPECIFICATION.md` in the same change. For this phase specifically:
  - §2 «Зависимости и версии» — record the exact bumped versions (`postcss`, `react-router`, `concurrently`, and whatever `npm audit fix` resolves the transitive four to) as they land in `package.json`/`package-lock.json` — the exact installed version, not the research-time target.
  - §6 «Публичные точки входа» — N/A unless the new GitHub Actions workflow is considered a "public entry point" (it is not; it's CI-internal). No new HTTP route/plugin is added.
  - §7 «Наблюдаемость» — the new advisory gate and its GitHub-issue-on-failure behavior belongs here as a new CI-level observability mechanism.
  - §8 «Расхождения» — only applicable if any recommendation here diverges from `.claude/CLAUDE.md`'s Technology Stack section; none currently does (no new library is being added).
- **Zero-dependency `scripts/*.mjs` convention:** not from CLAUDE.md directly but from `.claude/CLAUDE.md`'s "What NOT to Use" spirit (avoid hand-rolling and unnecessary dependencies) combined with the codebase's own unbroken pattern across 15 existing gates — treated as binding for this phase's implementation (see Anti-Patterns to Avoid).
- **GSD Workflow Enforcement:** file-changing work for this phase must go through `/gsd-execute-phase` per `.claude/CLAUDE.md`'s workflow-enforcement section — this research does not itself modify source files.

## Summary

This phase does not need library documentation research — it needs live repo forensics. Every load-bearing fact below comes from running `npm audit --json`, `npm ls`, and `npm view` directly against this repository's actual lockfile and node_modules, which is more authoritative than any external doc for a task that is entirely "what does THIS tree's advisory state actually look like." All external search providers are disabled in `.planning/config.json` (brave/firecrawl/exa/tavily/ref/perplexity/jina all `false`); the only two claims sourced externally (GitHub issue-dedup pattern, npm audit JSON schema) were cross-checked by WebSearch and match the direct tool evidence exactly.

Three findings materially change what the planner should assume going in. First, the CONTEXT.md evidence table of "6 HIGH advisories" undercounts: a full-tree scan (mandated by D-08) surfaces **8** HIGHs — `concurrently`/`shell-quote` only appear when devDependencies are included, and per D-08 they must be triaged like everything else. Second, `brace-expansion` — which a lockfile glance would attribute to eslint tooling — is actually **production-reachable** via `apps/worker → @bull-board/fastify → @fastify/static → glob → minimatch`, so it is a mandatory upgrade under D-11, not a tooling-only accept-list candidate. Third, the ROADMAP's open plan-time question about `drizzle-kit` is answered by direct inspection: it reaches the prod tree only through `better-auth`'s `peerDependenciesMeta.drizzle-kit.optional = true` (never imported by better-auth's runtime `dist/`), and drizzle-kit's own advisory is **MODERATE**, below the D-09 HIGH/CRITICAL blocking threshold — so today it needs neither an upgrade nor an accept-list entry, only a documented reachability note closing the open item.

**Primary recommendation:** Build `scripts/check-dependency-advisories.mjs` as a zero-dependency Node script (matching all 15 existing `check:*` gates), fix all 8 real HIGHs via `npm audit fix` (transitive four) plus three explicit `package.json` version bumps (`postcss@8.5.26`, `react-router@8.3.0`, `concurrently@10.0.5` — all confirmed non-major), wire the gate into the existing `static` CI job (auto-inherits required-check status, zero admin action), and expect the accept-list to land **empty** — SC4/DEP-03 are proven by gate unit-test fixtures (malformed/expired/no-owner entries), not by a manufactured live entry.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Dependency vulnerability scan | CI / Build tooling | — | Runs at `npm ci` time against the resolved lockfile tree; no application runtime involvement |
| PR-gate blocking on new HIGH advisories | CI / Build tooling | — | Extends `.github/workflows/ci.yml`'s existing `static` job (required status check) |
| Scheduled full-tree scan | CI / Build tooling | GitHub API (Issues) | Separate cron workflow; on failure, calls the GitHub REST API to open/update an issue — the only capability in this phase that talks to an external service |
| Accept-list storage & validation | Repo config (JSON file) | CI / Build tooling | `.advisory-accept-list.json` at repo root, schema-validated by the same gate script that reads it |
| Actual dependency upgrades | Application dependency tree | Browser/API/Worker runtime (where the fixed package executes) | `postcss`/`react-router` affect the web build; `fastify`/`bull-board` deps affect the API/worker runtime |

## Standard Stack

### Core

No new runtime library is introduced by this phase — this section documents what the gate is built FROM, not a new dependency.

| Tool | Version | Purpose | Why Standard |
|------|---------|---------|---------------|
| `npm audit --json` | npm 11.12.1 (bundled with Node 26, per `.nvmrc`) [VERIFIED: `npm -v` in this repo, 2026-08-20] | Advisory source of truth | D-01 locks this in — no new scanner dependency (osv-scanner, audit-ci explicitly rejected by the user). Schema is `auditReportVersion: 2` (stable since npm 9+) [CITED: docs.npmjs.com/cli/audit] |
| Node.js built-ins (`node:fs`, `node:child_process`, `node:path`) | Node 26 (`.nvmrc`) [VERIFIED: `node -v`, 2026-08-20] | Gate script implementation | Every one of the 15 existing `check:*`/`verify:*` scripts in `scripts/` is built with zero npm dependencies — this is a hard repo convention, not a suggestion (see `scripts/check-lockfile-npm10.mjs`, `scripts/validate-alloy-config.mjs` header comments) |
| Vitest 4.1.9 | already root devDependency [VERIFIED: package.json] | Gate script's own test file | `scripts/vitest.config.ts` is registered in the root aggregate (`vitest.config.ts` → `projects: [..., "scripts/vitest.config.ts"]`); every existing check script ships a matching `scripts/__tests__/<name>.test.mjs` |
| `actions/github-script` | pin to a commit SHA at implementation time (verify current release SHA when writing the workflow — do not hardcode a SHA in this research) | Scheduled-scan issue creation/update (D-13) | Official GitHub action, matches this repo's own convention of pinning every third-party/GitHub action to a full commit SHA with a version comment (see `ci.yml` header: "Every third-party action is pinned to a full commit SHA"). Preferred over a third-party issue-creation action (`peter-evans/create-issue-from-file`, `JasonEtco/create-an-issue`) specifically because it is first-party and the repo has zero precedent for trusting third-party actions in this codebase — `.github/workflows/` currently contains only `actions/checkout` and `actions/setup-node`, both official |

### Supporting

| Package (being upgraded, not newly added) | Current → Target | Purpose | When to Use |
|---------|---------|---------|-------------|
| `postcss` | 8.5.16 → 8.5.26 [VERIFIED: npm audit fixAvailable, npm view postcss version] | CSS transform pipeline (Tailwind/autoprefixer chain) | Direct pin in `apps/web/package.json:62`; upgrade closes 2 GHSAs, non-major |
| `react-router` | 8.1.0 → 8.3.0 [VERIFIED: npm audit fixAvailable] | Web app routing | Direct pin in `apps/web/package.json:47`; non-major |
| `concurrently` | 10.0.3 → 10.0.5 [VERIFIED: npm audit fixAvailable] | `npm run dev` process orchestration (root devDependency) | Non-major; the only path to fixing `shell-quote`'s HIGH, which is a nested dependency of `concurrently` and cannot be bumped independently |
| `brace-expansion`, `fast-uri`, `find-my-way`, `nanoid` (postcss's nested copy) | current pinned-transitive → npm-audit-selected patch | Transitive deps of `eslint-plugin-import-x`(dev), `fastify`/`@fastify/swagger`(prod), `fastify`(prod), `postcss`(prod, web) respectively | Fixed automatically by plain `npm audit fix` (no `--force` needed) — none are direct dependencies |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `npm audit --json` | `osv-scanner`, `audit-ci` | User explicitly rejected both (D-01) — adds a new dependency/binary for a signal `npm audit` already provides natively from the same registry data |
| Gate lives in `static` job | New dedicated CI job | New job requires manual branch-protection admin action to become a required check; `static` inherits required status automatically. Repo's own recorded precedent (Sentry-redaction gate, pool-factory audit) explicitly chose `static` for this exact reason — "becomes blocking immediately with no repository-admin action" |
| `actions/github-script` for issue creation | `peter-evans/create-issue-from-file`, `JasonEtco/create-an-issue` | Third-party actions; no existing trust precedent in this repo's `.github/workflows/`. `github-script` is official and lets the dedup-by-label search-then-create-or-update logic live as plain JS, auditable inline in the workflow file like everything else here |

**Installation:**
```bash
# No new packages. Version bumps only:
npm install postcss@8.5.26 -w apps/web
npm install react-router@8.3.0 -w apps/web
npm install concurrently@10.0.5
npm audit fix   # resolves brace-expansion, fast-uri, find-my-way, nanoid transitively — NEVER with --omit=dev (see Pitfall 1)
```

**Version verification:** All target versions confirmed live against the npm registry on 2026-08-20:
```
$ npm view postcss version       → 8.5.26
$ npm view react-router version  → 8.3.0
$ npm view concurrently version  → 10.0.5
$ npm view fast-uri version      → 4.1.2 (major; NOT the target — target is the 3.x patch npm audit fix resolves to, 3.1.5, satisfying GHSA range ">=3.0.0 <3.1.5")
```

## Package Legitimacy Audit

**No new npm packages are introduced by this phase.** Every table entry above is a version bump of an already-installed, already-audited dependency (`postcss`, `react-router`, `concurrently` are long-established, high-download packages already in `package-lock.json`). The only new external reference is `actions/github-script`, a GitHub Action (not an npm package) published by GitHub itself — not subject to the npm-registry legitimacy gate.

| Package | Registry | Disposition |
|---------|----------|-------------|
| postcss, react-router, concurrently, fast-uri, find-my-way, nanoid, brace-expansion, shell-quote | npm | Existing dependencies, version bump only — not a new-package legitimacy question |
| `actions/github-script` | GitHub Actions Marketplace | Official GitHub-published action; pin to commit SHA per repo convention, no `package-legitimacy check` applicable (not an npm ecosystem package) |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────┐        ┌──────────────────────────┐
│   Pull Request opened    │        │  Daily cron (00:00 UTC)   │
│   / pushed to            │        │  .github/workflows/       │
│   .github/workflows/     │        │  advisory-scan.yml        │
│   ci.yml (static job)    │        └──────────────┬────────────┘
└──────────┬───────────────┘                       │
           │                                        │
           ▼                                        ▼
   ┌───────────────────────────────────────────────────────┐
   │  npm ci  (installs full tree, incl. devDependencies)   │
   └──────────────────────┬──────────────────────────────────┘
                           ▼
   ┌───────────────────────────────────────────────────────┐
   │  npm run check:dependency-advisories                   │
   │  (scripts/check-dependency-advisories.mjs)              │
   │                                                          │
   │  1. Run `npm audit --json` (full tree, NO --omit=dev)   │
   │  2. Assert auditReportVersion === 2 (fail closed if not)│
   │  3. Flatten vulnerabilities → recurse through `via[]`,  │
   │     resolving string references to other package keys, │
   │     collecting each individual advisory object          │
   │     (never trust the package-level rolled-up severity)  │
   │  4. Filter to severity in {high, critical}              │
   │  5. Load + schema-validate .advisory-accept-list.json   │
   │     (mandatory fields, ≤90-day expiry, non-expired,     │
   │     non-trivial justification length)                   │
   │  6. For each blocking advisory NOT covered by a valid   │
   │     accept-list entry → FAIL, print package + GHSA id   │
   │  7. Registry/network failure during npm audit → retry   │
   │     N times, then FAIL CLOSED (never skip)               │
   └──────────────────────┬────────────────────────────────┘
                           │
             ┌─────────────┴─────────────┐
             ▼ (PR path)                 ▼ (cron path, on FAIL only)
   ┌──────────────────┐        ┌────────────────────────────────┐
   │ CI status check   │        │ actions/github-script:          │
   │ fails, PR blocked │        │  search open issues by label →  │
   └──────────────────┘        │  create new OR update existing  │
                                │  issue naming package+GHSA id   │
                                └────────────────────────────────┘
```

### Recommended Project Structure
```
scripts/
├── check-dependency-advisories.mjs        # the gate — pure functions + CLI guard, same shape as every sibling check
└── __tests__/
    └── check-dependency-advisories.test.mjs

.advisory-accept-list.json                 # repo root, schema-validated by the gate

.github/workflows/
├── ci.yml                                 # add one step to the existing `static` job
└── advisory-scan.yml                      # NEW — daily cron, runs the SAME npm script, opens/updates GH issue on failure
```

### Pattern 1: Recursive `via[]` resolution (do not trust package-level `severity`)

**What:** `npm audit --json`'s `vulnerabilities.<pkg>` object has a top-level `severity` field that is the MAX across all advisories affecting that package — not a single advisory's severity. The `via` array mixes two shapes: advisory-detail objects (leaf findings, with their own `severity`/`url`/`range`) and plain strings that are package-name references to ANOTHER key in the same `vulnerabilities` object (a "depends on vulnerable version of X" compound relationship).

**When to use:** Always, when parsing `npm audit --json` output for a per-advisory blocking decision. A shallow read of `vulnerabilities.<pkg>.severity` is not sufficient to decide whether a SPECIFIC GHSA id is HIGH — you must walk into `via[]`.

**Example (verified against this repo's real audit output, 2026-08-20):**
```json
// vulnerabilities.concurrently — a compound reference, no advisory of its own
{
  "name": "concurrently",
  "severity": "high",
  "via": ["shell-quote"],
  "fixAvailable": { "name": "concurrently", "version": "10.0.5", "isSemVerMajor": false }
}
// vulnerabilities.shell-quote — the actual leaf advisory concurrently's entry points at
{
  "name": "shell-quote",
  "severity": "high",
  "via": [{
    "source": "...", "name": "shell-quote",
    "url": "https://github.com/advisories/GHSA-395f-4hp3-45gv",
    "severity": "high", "range": "<=1.8.4"
  }]
}
```
```javascript
// Source: scripts/check-dependency-advisories.mjs (recommended shape)
function collectAdvisories(vulnerabilities) {
  const advisories = [];
  const seen = new Set();
  function walk(pkgName) {
    if (seen.has(pkgName)) return;
    seen.add(pkgName);
    const entry = vulnerabilities[pkgName];
    if (!entry) return;
    for (const via of entry.via) {
      if (typeof via === "string") {
        walk(via); // compound reference — recurse into the referenced package
      } else {
        advisories.push({
          package: pkgName,
          ghsaId: via.url.split("/").pop(), // e.g. "GHSA-395f-4hp3-45gv"
          severity: via.severity,           // the LEAF severity, never the rollup
          title: via.title,
        });
      }
    }
  }
  for (const pkgName of Object.keys(vulnerabilities)) walk(pkgName);
  return advisories;
}
```

### Pattern 2: Fail-closed registry probe (D-03)

**What:** `npm audit` needs registry/network access. A registry outage must fail the gate, not silently pass.
**When to use:** Wrap the `npm audit --json` `execFileSync`/`spawnSync` call with retry-then-fail-closed semantics, mirroring `scripts/validate-alloy-config.mjs`'s `runValidation()` fail-closed branch (an unreachable Docker daemon becomes a violation, not a silent skip, when `ALLOY_VALIDATE_REQUIRE_BINARY` is set).
**Example:**
```javascript
// Source: pattern established in scripts/validate-alloy-config.mjs (adapt, don't copy verbatim)
function runNpmAuditWithRetries(cwd, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const output = execFileSync("npm", ["audit", "--json"], { cwd, encoding: "utf8" });
      return JSON.parse(output);
    } catch (err) {
      // npm audit exits non-zero when vulnerabilities are found — that is
      // EXPECTED and the JSON on stdout is still valid. Only a genuinely
      // unparseable/empty stdout (registry unreachable, DNS failure) is a
      // real failure worth retrying.
      if (err.stdout) {
        try { return JSON.parse(err.stdout); } catch { /* fall through to retry */ }
      }
      lastError = err;
    }
  }
  throw new Error(`check:dependency-advisories FAILED CLOSED: npm audit unreachable after ${maxRetries} attempts. ${lastError?.message}`);
}
```
**Important verified detail:** `npm audit` exits with a NON-ZERO status code whenever vulnerabilities are found — this is normal, expected behavior, not a registry failure. The gate script must capture stdout from the child process even on non-zero exit (`err.stdout`, matching the `runCapture` helper pattern already used in `scripts/check-lockfile-npm10.mjs`) and only treat a genuinely unparseable/empty response as the fail-closed registry-failure case.

### Anti-Patterns to Avoid
- **`npm audit fix --omit=dev`:** [VERIFIED: ran this exact command against this repo, 2026-08-20] — it does NOT just fix the prod-tree advisories. It triggered removal of `vite`, `@vitejs/plugin-react`, `@vitest/eslint-plugin`, and multiple `@typescript-eslint/*` packages — a large, unintended devDependency tree churn caused by `--omit=dev` interacting badly with npm's fix-resolution algorithm. Use plain `npm audit fix` (full tree) for the automatic fixes, and targeted `npm install <pkg>@<version> -w <workspace>` for the three direct-pin bumps that need `--force`-equivalent handling.
- **Hardcoding drizzle-kit into the accept-list "because the roadmap mentions it":** its own advisory is MODERATE (via `@esbuild-kit/esm-loader`), below the D-09 HIGH/CRITICAL blocking threshold — it will not fail the gate today. Document the reachability finding (optional peerDependency, unimported by better-auth's runtime) and move on; do not manufacture an accept-list entry for a non-blocking finding just to "close" D-10 with a visible artifact.
- **Importing `zod` in the gate script:** it resolves from root `node_modules` only because it is hoisted from `apps/api`'s dependency — not because `scripts/` itself declares it. Every existing `scripts/*.mjs` gate is Node-built-ins-only by explicit convention; relying on hoisting for schema validation is fragile (a future dedup/hoisting change silently breaks the gate) and breaks the established pattern. Hand-roll the accept-list field validation the same way `check-lockfile-npm10.mjs` hand-rolls its Dockerfile-tag validation.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Advisory database / CVE feed | A custom vulnerability database or GHSA API client | `npm audit --json` | D-01 locked decision — npm audit already talks to the registry's advisory bulk data; building a parallel client duplicates a solved problem for zero benefit |
| Semver comparison for expiry-cap enforcement | Custom date-string parsing | `Date.parse()` / `Date` arithmetic (Node built-in) — no `date-fns`/`dayjs` needed for a single "is this ISO date > now + 90 days" check | Single comparison, not worth a dependency; matches zero-dependency convention |
| GitHub issue dedup logic | A custom "has this been reported" state file committed to the repo | GitHub Issues search API via `actions/github-script` (`octokit.rest.issues.listForRepo({ labels: ..., state: "open" })`) | GitHub already tracks issue state authoritatively; a parallel dedup file would drift from reality (an issue closed by a human wouldn't be reflected) |

**Key insight:** This phase's entire value is a thin, deterministic wrapper around tools the ecosystem already provides (npm's own audit database, GitHub's own Issues API). The temptation to add "just one small dependency" (a JSON schema validator, a semver library, a GHSA API client) should be resisted — every sibling gate script in this repo proves zero dependencies is sufficient for this class of problem, and D-01's explicit rejection of osv-scanner/audit-ci signals the user wants this pattern continued.

## Common Pitfalls

### Pitfall 1: `npm audit fix --omit=dev` causes unintended devDependency churn
**What goes wrong:** Running the "obvious" fix command scoped to production deps triggers npm to recompute the ENTIRE resolution tree without devDependencies in the calculation, which can cascade into removing/reinstalling unrelated devDependencies (verified: it attempted to remove `vite`, `@vitejs/plugin-react`, and the full `@typescript-eslint/*` chain in this repo).
**Why it happens:** npm's fix algorithm resolves against the full declared dependency graph; `--omit=dev` changes what's considered "installed" mid-resolution in a way that doesn't cleanly map to "only touch prod deps."
**How to avoid:** Use plain `npm audit fix` (full tree) for automatic transitive fixes. For the three direct-pin bumps (`postcss`, `react-router`, `concurrently`) that npm reports as "outside stated dependency range," bump the exact version in the relevant `package.json` and run `npm install` (workspace-scoped with `-w`), then verify with a fresh `npm audit --json`.
**Warning signs:** `npm audit fix --dry-run` output listing `remove <unrelated-package>` lines for packages that have nothing to do with the advisories being fixed.

### Pitfall 2: `npm audit`'s package-level `severity` field is a rollup, not per-advisory
**What goes wrong:** A gate that reads `vulnerabilities.<pkg>.severity` directly and matches it against a single GHSA id in the accept-list can silently accept-list (or fail to detect) the WRONG advisory if a package has multiple advisories at different severities.
**Why it happens:** npm's schema reports the package's highest severity at the top level; the accept-list is (correctly, per D-04) keyed per advisory-id + package, so the gate's internal matching must walk into `via[]` per Pattern 1 above.
**How to avoid:** Always resolve to individual GHSA ids via the recursive `via[]` walk (Pattern 1) before comparing against accept-list entries.
**Warning signs:** A gate that "passes" after only ONE of two advisories on the same package is fixed, because the package-level severity rollup already dropped once the higher one was resolved.

### Pitfall 3: `drizzle-kit`'s prod-tree presence is a hoisting artifact, not a real runtime dependency edge
**What goes wrong:** `npm ls drizzle-kit --omit=dev` shows `@mega-crm/api → better-auth@1.6.23 → drizzle-kit@0.31.10`, which looks like better-auth genuinely depends on drizzle-kit at runtime. It does not.
**Why it happens:** `drizzle-kit` is declared in `better-auth`'s `peerDependencies` with `peerDependenciesMeta.drizzle-kit.optional = true` [VERIFIED: `node_modules/better-auth/package.json` lines 527, 578-582]. `packages/db` already declares `drizzle-kit` as a `devDependency` (D-10's first half, already resolved), and npm workspace hoisting places that single physical copy at the shared root `node_modules/drizzle-kit`. Because the file happens to exist there, `npm ls`'s peer-satisfaction check reports the edge — even though better-auth's actual runtime code (checked via `grep -rl "drizzle-kit" node_modules/better-auth/dist`, zero matches) never imports it.
**How to avoid:** Don't reflexively upgrade or accept-list a package just because `npm ls --omit=dev` shows a path to it. Check whether the edge is a hard `dependencies` entry or an optional `peerDependency`, and whether the dependent's own `dist`/build output actually imports the package.
**Warning signs:** A `npm ls <pkg> --omit=dev` path that resolves through another package's `peerDependencies` rather than its `dependencies`.

### Pitfall 4: `npm audit` exits non-zero on found vulnerabilities — this is not a tool failure
**What goes wrong:** A naive `execFileSync("npm", ["audit", "--json"])` throws on non-zero exit, and a script that treats every thrown error as "npm audit itself failed" will fail-closed on every run that finds ANY vulnerability — including moderate/low ones that shouldn't block.
**Why it happens:** npm's CLI convention is to signal "audit found something" via exit code, with the JSON report still written to stdout.
**How to avoid:** Capture stdout even on non-zero exit (`err.stdout`) and attempt to parse it before deciding the run genuinely failed (registry unreachable / malformed response). This repo's own `runCapture` helper in `scripts/check-lockfile-npm10.mjs` already establishes this exact pattern for a different subprocess call.
**Warning signs:** The gate script fails on every single run regardless of severity, even for a lone moderate-only finding that should be a silent pass under D-09.

## Code Examples

### Locating the exact HIGH/CRITICAL advisories currently in this repo (verified, 2026-08-20)

```bash
# Source: direct execution against this repo's live lockfile, 2026-08-20
npm audit --json | node -e '
let data = "";
process.stdin.on("data", d => data += d);
process.stdin.on("end", () => {
  const d = JSON.parse(data);
  for (const [name, v] of Object.entries(d.vulnerabilities)) {
    if (v.severity === "high" || v.severity === "critical") {
      console.log(name, v.severity, JSON.stringify(v.fixAvailable));
    }
  }
});
'
```
Verified output — 8 packages, 0 CRITICAL, 8 HIGH:
```
brace-expansion  high  true
concurrently     high  {"name":"concurrently","version":"10.0.5","isSemVerMajor":false}
fast-uri         high  true
find-my-way      high  true
nanoid           high  true
postcss          high  {"name":"postcss","version":"8.5.26","isSemVerMajor":false}
react-router     high  {"name":"react-router","version":"8.3.0","isSemVerMajor":false}
shell-quote      high  {"name":"concurrently","version":"10.0.5","isSemVerMajor":false}
```

### Confirming reachability of a suspect finding

```bash
# Source: direct execution, 2026-08-20 — this is how brace-expansion's
# prod-reachability was established (contradicting a naive "it's from eslint" assumption)
npm ls brace-expansion --all --omit=dev
# → mega-crm@0.1.0
#   └─┬ @mega-crm/worker@0.1.0 -> ./apps/worker
#     └─┬ @bull-board/fastify@8.6.1
#       └─┬ @fastify/static@10.1.3
#         └─┬ glob@13.0.6
#           └─┬ minimatch@10.2.6
#             └── brace-expansion@5.0.8
```

### Accept-list JSON shape (D-04 through D-07)

```json
// Source: derived directly from D-04..D-07 decisions in 18-CONTEXT.md
{
  "entries": [
    {
      "advisoryId": "GHSA-xxxx-xxxx-xxxx",
      "package": "some-tooling-only-package",
      "justification": "Reachability analysis (min length enforced by gate, D-06): this package is imported only by scripts/some-dev-tool.mjs, which never runs in a deployed process — verified via `grep -r \"require('some-tooling-only-package')\" apps/ packages/` returning zero matches outside scripts/.",
      "owner": "someone@example.com",
      "expiry": "2026-11-18"
    }
  ]
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `npm audit` schema v1 (numeric advisory IDs) | Schema v2 (`auditReportVersion: 2`, package-name-keyed `vulnerabilities` object) | npm 9+ (this repo runs npm 11.12.1) | Any gate script parsing older v1-shaped examples from pre-2023 blog posts will not match this repo's actual output — always verify against a live `npm audit --json` run, not cached documentation |

**Deprecated/outdated:**
- Nothing being deprecated within this phase's scope; the phase adds a new gate, it doesn't retire an old one.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The exact commit SHA to pin `actions/github-script` to must be resolved at implementation time (not fixed in this research, to avoid recommending a stale/incorrect SHA) | Standard Stack, Architecture Patterns | Low — the planner/executor resolves this the same way `ci.yml`'s existing pinned actions were resolved; no architectural risk, just a lookup step |
| A2 | Daily cron time (D-14 confirms cadence, not exact hour) — this research assumes 00:00 UTC as a placeholder | Architecture Patterns diagram | Low — cosmetic; Claude's Discretion per CONTEXT.md covers exact scheduling detail |

**If this table is empty:** N/A — two low-risk scheduling/pinning details remain open by design (explicitly deferred to implementation time), not because they weren't researchable.

## Open Questions (RESOLVED)

1. **Does `better-auth`'s optional `drizzle-kit` peerDependency ever get invoked at runtime under ANY code path this app actually uses (e.g., a lazy `require` inside a CLI-only export that isn't imported by the running server)?**
   - What we know: `grep -rl "drizzle-kit" node_modules/better-auth/dist` returns zero matches — no static import anywhere in better-auth's shipped build output.
   - What's unclear: A fully dynamic `require("drizzle-kit")` string-concatenated at runtime (not statically greppable) is theoretically possible, though better-auth's own `peerDependenciesMeta.optional: true` strongly signals it's opt-in CLI-only tooling (their `@better-auth/cli` schema-generation command), not server-runtime code.
   - Recommendation: The static-grep evidence plus the optional-peer declaration is sufficient confidence for DEP-01's "reachable" bar (D-11's threshold is about the ADVISORY being in a reachable path, and today there is no HIGH/CRITICAL advisory on drizzle-kit to even apply that bar to — see Pitfall 3). Document this finding in the reachability note; no further verification needed unless a future advisory scan surfaces a HIGH against drizzle-kit itself, at which point the dynamic-require question would matter and should be re-checked.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| npm registry (network) | `npm audit --json`, `npm ci` | Assumed available in GitHub Actions runners (same assumption `npm ci` in every existing job already makes) | — | D-03: retry N times then fail closed — no fallback, by design |
| Node.js | Gate script runtime | ✓ | 26.0.0 (`.nvmrc`) [VERIFIED] | — |
| npm | Gate script's `npm audit` invocation | ✓ | 11.12.1 (bundled with Node 26) [VERIFIED] — NOTE: differs from the npm 10 the Docker images bundle (`node:22-slim`); `check:lockfile-npm10` already guards this drift for `npm ci`-lockfile compatibility, and any package.json edit in this phase must keep that gate green | — |
| GitHub REST API (Issues) | Scheduled-scan issue creation (D-13) | Assumed available via `actions/github-script`'s pre-authenticated Octokit client | — | None needed — a failed issue-creation call would itself need to fail the cron job loudly (not silently swallow), consistent with D-03's fail-closed posture |

**Missing dependencies with no fallback:** none identified — this phase's tooling is entirely built from what's already present (npm, Node, GitHub Actions' built-in `GITHUB_TOKEN`).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.9 [VERIFIED: package.json] |
| Config file | `scripts/vitest.config.ts` (registered as a `projects` entry in root `vitest.config.ts`) |
| Quick run command | `npx vitest run --root scripts __tests__/check-dependency-advisories.test.mjs` |
| Full suite command | `npm run coverage` (aggregate run includes `scripts/vitest.config.ts`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DEP-01 | Every reachable HIGH/CRITICAL in prod path is fixed or has a documented reachability analysis | integration (real `npm audit --json` against the post-fix lockfile) | `npm run check:dependency-advisories` (fail-first proof: run the identical command against the PRE-fix lockfile first, recording the 8-HIGH RED baseline, per Phase 8/15 fail-first convention) | ❌ Wave 0 |
| DEP-02 | PR introducing a new untriaged HIGH fails CI naming package + advisory id | unit (fixture: a synthetic `npm audit --json` payload with one new HIGH not in the accept-list) | `npx vitest run --root scripts __tests__/check-dependency-advisories.test.mjs -t "blocks untriaged HIGH"` | ❌ Wave 0 |
| DEP-02 | Scheduled full scan surfaces newly-published advisory with no code change | unit (fixture: accept-list entry with an already-expired date) + workflow-level manual trace of `advisory-scan.yml` | `npx vitest run --root scripts __tests__/check-dependency-advisories.test.mjs -t "cron path"` | ❌ Wave 0 |
| DEP-03 | Malformed/expired/no-owner accept-list entry is rejected | unit (fixtures: missing field, >90-day expiry, already-past expiry, one-word justification) | `npx vitest run --root scripts __tests__/check-dependency-advisories.test.mjs -t "accept-list schema"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --root scripts __tests__/check-dependency-advisories.test.mjs`
- **Per wave merge:** `npm run coverage` (full aggregate, includes the scripts lane)
- **Phase gate:** `npm run check:dependency-advisories` must be green against the actual repo state before `/gsd-verify-work`; SC2's fail-first RED evidence must be captured and referenced in the plan's verification artifacts

### Wave 0 Gaps
- [ ] `scripts/check-dependency-advisories.mjs` — the gate itself (source, not test)
- [ ] `scripts/__tests__/check-dependency-advisories.test.mjs` — covers DEP-01/02/03 fixture behaviors
- [ ] `.advisory-accept-list.json` — repo-root config file (starts as `{"entries": []}` unless drizzle-kit's non-blocking status changes before implementation)
- [ ] `.github/workflows/advisory-scan.yml` — new workflow file
- Framework install: none — Vitest is already present, `scripts/vitest.config.ts` already exists and just needs the new test file discovered by its existing glob

**Note:** `scripts/**` is deliberately excluded from `vitest.config.ts`'s `coverage.include` (per that file's own header comment) — the new gate script's tests run in the aggregate but do NOT count toward `coverage:gate`/`coverage:ratchet` percentages, consistent with every other `scripts/*.mjs` check.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | no | This phase touches no auth flow |
| V3 Session Management | no | N/A |
| V4 Access Control | no | N/A |
| V5 Input Validation | yes | The accept-list JSON is untrusted-ish repo-authored input parsed by the gate — validate every field's presence/type/length by hand (Node built-ins), reject on any schema violation (fail closed, matches D-04's "malformed entry fails the gate" requirement) |
| V6 Cryptography | no | N/A — this phase does not touch KMS/DEK/secrets |

### Known Threat Patterns for this phase's stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Supply-chain vulnerability reaching production undetected | Tampering / Elevation of Privilege | This entire phase IS the mitigation — DEP-01/02/03 close exactly this gap |
| Accept-list used as a permanent "ignore" mechanism (silent scope creep) | Repudiation | D-05's 90-day expiry cap + D-04's mandatory owner/justification fields, enforced by the gate itself (an expired entry stops passing the gate — self-enforcing, not policy-only) |
| Overly-broad `GITHUB_TOKEN` permissions on the new scheduled workflow | Elevation of Privilege | Explicit `permissions:` block scoped to exactly `contents: read` + `issues: write` — the existing `ci.yml` has no top-level `permissions:` block (relies on default token scope); the NEW `advisory-scan.yml` should not inherit that implicit-default pattern given it needs write access to Issues, which `ci.yml`'s jobs never do |
| A compromised/malicious third-party GitHub Action running with this repo's token | Tampering / Elevation of Privilege | Pin `actions/github-script` (official) to a full commit SHA with a version comment, per this repo's own established convention in `ci.yml`'s header comment — do not use a floating tag |

## Sources

### Primary (HIGH confidence — direct tool verification against this repo, 2026-08-20)
- `npm audit --json` / `npm audit --omit=dev --json` — full and prod-only advisory trees
- `npm ls <pkg> --all [--omit=dev]` — reachability tracing for brace-expansion, drizzle-kit, esbuild, fast-uri, find-my-way, nanoid, postcss, react-router, concurrently, shell-quote
- `npm view <pkg> version` — target-version confirmation for postcss, react-router, concurrently, fast-uri, find-my-way, minimatch
- `npm audit fix --dry-run` / `npm audit fix --omit=dev --dry-run` — remediation-command behavior, including the discovered `--omit=dev` tree-churn pitfall
- `node_modules/better-auth/package.json`, `node_modules/better-auth/dist` (grep) — drizzle-kit optional-peer + zero-import confirmation
- `.github/workflows/ci.yml`, `scripts/check-lockfile-npm10.mjs`, `scripts/validate-alloy-config.mjs`, `scripts/check-root-hygiene.mjs`, `scripts/check-runbook-coverage.mjs`, `vitest.config.ts`, `scripts/vitest.config.ts`, `.gitignore` — direct repo pattern reading

### Secondary (MEDIUM confidence — WebSearch cross-check of external claims)
- [npm-audit | npm Docs](https://docs.npmjs.com/cli/audit/) — confirmed schema v2 stability and `fixAvailable` field semantics, matching direct-tool observation exactly
- GitHub Actions issue-creation/dedup patterns (general `actions/github-script` + label-search approach) — no single authoritative example combining scheduled-failure + dedup-by-label + github-script found; pattern synthesized from repo's own conventions rather than copied from an external template

### Tertiary (LOW confidence)
- None used as load-bearing claims in this document

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every version number and reachability claim is a direct tool-verified fact against this exact repo, not training-data recall
- Architecture: HIGH — CI job placement and workflow structure follow an explicitly-documented, already-precedented pattern in this same codebase (the Sentry-gate/pool-factory-audit comments in `ci.yml`)
- Pitfalls: HIGH — all four pitfalls were reproduced by actually running the commands against this repo, not inferred

**Research date:** 2026-08-20
**Valid until:** 7 days — the advisory landscape (npm registry state) is inherently time-sensitive; DEP-02/DEP-03's entire purpose is to keep re-checking this, so treat the specific "8 HIGH" enumeration as a point-in-time snapshot that the gate itself will supersede once implemented
