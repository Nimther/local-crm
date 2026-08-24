# Phase 18: Dependency Hygiene & Advisory Gate - Pattern Map

**Mapped:** 2026-08-20
**Files analyzed:** 8 (2 new source, 1 new test, 1 new config, 1 new workflow, 3 modified version-bump files)
**Analogs found:** 7 / 8

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `scripts/check-dependency-advisories.mjs` | utility (CI gate script) | batch (subprocess invoke → parse → validate → exit code) | `scripts/check-lockfile-npm10.mjs` | exact |
| `scripts/__tests__/check-dependency-advisories.test.mjs` | test | transform (fixture in → assertion out) | `scripts/__tests__/validate-alloy-config.test.mjs` (+ `check-runbook-coverage` shape) | exact |
| `.advisory-accept-list.json` | config | — | none (new config shape, but schema modeled on decisions) | no analog (see below) |
| `.github/workflows/advisory-scan.yml` | config (CI workflow) | event-driven (cron trigger → job → conditional GitHub API call) | `.github/workflows/images.yml` (permissions block, matrix-less single job, GHCR-style conditional step) + `.github/workflows/ci.yml` (`static` job step wiring) | role-match |
| `.github/workflows/ci.yml` (modified: new step in `static` job) | config (CI workflow) | request-response (step invocation) | itself — existing `static` job steps (`check:web-chunks` step) | exact |
| `package.json` (root, modified: new `check:*` script + `concurrently` bump) | config | — | existing `check:*` script entries (line 22-71) | exact |
| `apps/web/package.json` (modified: `postcss`, `react-router` bump) | config | — | itself, version bump only | exact |
| `SPECIFICATION.md` (modified: §2, §7) | config/docs | — | prior phase's edits to same sections (not re-read; follow existing table format in file) | role-match |

## Pattern Assignments

### `scripts/check-dependency-advisories.mjs` (utility, batch/subprocess)

**Analog:** `scripts/check-lockfile-npm10.mjs` (256 lines) — closest match: a zero-dependency `.mjs` gate that shells out to a package-manager subcommand, captures output even on non-zero exit, and reports a readable pass/fail. Secondary analog for fail-closed-on-unavailable-tooling: `scripts/validate-alloy-config.mjs` (`ALLOY_VALIDATE_REQUIRE_BINARY` pattern). Secondary analog for "derive findings from source, never a hardcoded list, and treat an empty enumeration as a hard failure": `scripts/check-runbook-coverage.mjs`.

**Header comment convention** (`check-lockfile-npm10.mjs` lines 1-35): every gate opens with a comment block naming the phase/plan, the root-cause it guards against, and an explicit "No dependencies — Node built-ins only" line. Copy this convention verbatim for the new gate, replacing the specifics with DEP-01/02/03 references.

**Imports pattern** (lines 37-40):
```javascript
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
```
Use exactly this REPO_ROOT resolution idiom — do not hardcode `process.cwd()`.

**Subprocess-capture-even-on-nonzero-exit pattern** (lines 172-183, `runCapture`):
```javascript
function runCapture(cmd, cmdArgs, options) {
  try {
    const stdout = execFileSync(cmd, cmdArgs, { encoding: "utf8", ...options });
    return { exitCode: 0, output: stdout };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}${err.status == null ? String(err.message ?? err) : ""}`,
    };
  }
}
```
This is directly reusable/adaptable for `npm audit --json`, which — per Pitfall 4 in RESEARCH.md — exits non-zero whenever ANY vulnerability is found. The gate MUST capture `err.stdout` and attempt `JSON.parse` on it before treating the run as a genuine failure. RESEARCH.md's `runNpmAuditWithRetries` (its own Pattern 2, lines 256-276) is the retry-wrapped variant to actually copy — it layers exactly this stdout-capture-on-throw idiom with a `maxRetries` loop, satisfying D-03's fail-closed-after-retries requirement.

**CLI-guard / direct-invocation pattern** (lines 185-189, repeated identically across `check-root-hygiene.mjs` lines 60-64 and `check-runbook-coverage.mjs` lines 107-111 — this is the fixed repo convention, copy verbatim):
```javascript
function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}
```
(Note: `check-lockfile-npm10.mjs` uses `pathToFileURL`; `check-root-hygiene.mjs`/`check-runbook-coverage.mjs` use the string-template `file://${path.resolve(entry)}` form. Either is accepted in this codebase — prefer the `pathToFileURL` form as the more robust/newer one.)

**Exported-pure-function + guarded-main pattern** (`main()` at lines 191-252, called only under `if (isDirectInvocation()) { main(); }` at lines 254-256): every check script exports its core logic (`checkRunbookCoverage`, `resolveNodeMajorFromDockerfiles`, etc.) as plain functions taking explicit parameters (never reading `process.env`/`process.cwd()` implicitly inside the pure logic), so tests can call them directly with fixtures without spawning a subprocess. Structure the new gate the same way:
- `collectAdvisories(vulnerabilities)` — pure, exported (copy shape from RESEARCH.md Pattern 1, lines 224-247)
- `loadAcceptList(path)` / `validateAcceptListEntry(entry, now)` — pure, exported
- `runNpmAuditWithRetries(cwd, maxRetries)` — exported, the one function that does I/O
- `main()` — CLI orchestration only, guarded by `isDirectInvocation()`

**Fail-loud/actionable-error-message pattern** (`check-lockfile-npm10.mjs` lines 233-247, `check-root-hygiene.mjs` lines 80-92, `check-runbook-coverage.mjs` lines 127-134): every failure path prints (a) what failed, (b) the raw evidence, (c) an explicit "Remediation:" section with the exact command or file to fix. Apply this to both failure modes: untriaged HIGH found (print package name + GHSA id + a `npm audit fix` / bump hint) and malformed accept-list entry (print which field, which entry, why it's invalid).

**Vacuous-pass guard** (`check-runbook-coverage.mjs` lines 116-125): treat "zero advisories found AND zero accept-list entries" as a legitimate pass but explicitly do NOT treat "npm audit returned unparseable output" as a pass — this is the fail-closed distinction D-03 requires. Do not copy the runbook-coverage "empty enumeration is a hard failure" rule literally (an empty *findings* list is a valid clean state per D-02's baseline), but do copy its discipline of never silently downgrading an error into a pass.

---

### `scripts/__tests__/check-dependency-advisories.test.mjs` (test)

**Analog:** `scripts/__tests__/validate-alloy-config.test.mjs` and `scripts/__tests__/check-lockfile-npm10.test.mjs` — both exercise the exported pure functions directly with fixture strings/objects, plus a smaller number of CLI-level integration assertions. Use `scripts/vitest.config.ts`'s existing project registration (already wired into root `vitest.config.ts`'s `projects` array per RESEARCH.md) — no new Vitest config needed.

**Fixture-driven unit test shape** (same idiom used throughout `scripts/__tests__/`): construct a synthetic `npm audit --json`-shaped object literal (per RESEARCH.md's exact schema examples — `vulnerabilities.<pkg>.via[]` mixing strings and advisory-detail objects) and assert `collectAdvisories()` output, rather than mocking `execFileSync` at the module level. Reserve execFileSync-mocking (if needed at all) for the retry/fail-closed path only.

**Required fixture cases** (from RESEARCH.md's Validation Architecture table, DEP-01/02/03 mapping):
- untriaged HIGH not in accept-list → gate fails, message names package + GHSA id
- accept-list entry with expiry already in the past → fails
- accept-list entry with expiry > 90 days out → fails
- accept-list entry missing a mandatory field (advisoryId/package/justification/owner/expiry) → fails
- accept-list entry with a trivially short justification → fails (D-06)
- moderate/low-only findings → passes (never blocks, D-09)
- registry/parse failure (malformed/empty stdout) → fails closed, not skipped (D-03)

---

### `.advisory-accept-list.json` (config)

**No analog** — this is a new config-file shape with no precedent elsewhere in the repo (closest sibling repo-root JSON configs are `package.json`/`tsconfig.json`, not useful as pattern sources). Follow the schema exactly as specified by D-04 through D-07 and reproduced in RESEARCH.md's Code Examples section:
```json
{
  "entries": [
    {
      "advisoryId": "GHSA-xxxx-xxxx-xxxx",
      "package": "some-tooling-only-package",
      "justification": "Reachability analysis (min length enforced by gate, D-06): ...",
      "owner": "someone@example.com",
      "expiry": "2026-11-18"
    }
  ]
}
```
Per RESEARCH.md's Summary and Wave-0-gaps section, expect this file to ship as `{"entries": []}` — SC4/DEP-03 is proven by the gate's own unit-test fixtures, not by a manufactured live entry. Do not add a drizzle-kit entry (Pitfall 3 — its advisory is MODERATE, below the blocking threshold; document the reachability finding in prose, e.g. in the plan's SUMMARY or a code comment near the gate, not as an accept-list entry).

---

### `.github/workflows/advisory-scan.yml` (config, event-driven)

**Analog:** `.github/workflows/images.yml` for the `permissions:` block placement and single-job structure; `.github/workflows/ci.yml`'s `static` job for the `checkout` + `setup-node` + `npm ci` step sequence.

**Permissions block pattern** (`images.yml` lines 92-94):
```yaml
permissions:
  contents: read
  packages: write
```
Adapt for this workflow per RESEARCH.md's threat-pattern table: `contents: read` + `issues: write` (NOT `packages: write`). Do this explicitly at the workflow (or job) level — `ci.yml` has no top-level `permissions:` block by design (relies on default token scope) and RESEARCH.md flags that the NEW workflow should not silently inherit that implicit-default pattern given it needs Issues write access.

**Trigger + concurrency pattern** (`ci.yml` lines 21-29, `images.yml` lines 1-6 mirror the same shape): both existing workflows use `on: push/pull_request` plus a `concurrency: { group: ..., cancel-in-progress: true }` block. For the new workflow, replace the trigger with `schedule: - cron: "..."` (daily, exact hour at discretion per Assumption A2) and keep the same concurrency-group idiom to prevent overlapping cron runs.

**Action-pinning convention** (`ci.yml` header comment lines 40-42, `images.yml` lines 105, 107, 109 — every `uses:` line is a full commit SHA with the version in a trailing `#` comment):
```yaml
- uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
- uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
```
Apply identically to `actions/github-script` — resolve the current release commit SHA at implementation time (RESEARCH.md Assumption A1) and pin it the same way, never a floating tag (`@v7`).

**Step sequence to copy** (`ci.yml` `static` job, lines 48-60): `checkout` → `setup-node` (with `node-version-file: .nvmrc`, `cache: npm`) → `npm ci` → then the gate script step, then a conditional `actions/github-script` step gated on the gate step's failure (`if: failure()`), implementing the search-existing-issue-by-label → create-or-update logic described in RESEARCH.md's Don't-Hand-Roll table (use `octokit.rest.issues.listForRepo({ labels: [...], state: "open" })`, not a custom dedup file).

---

### `.github/workflows/ci.yml` (modified — new step in `static` job)

**Analog:** itself — the existing `check:web-chunks` step (lines 71-78), which is the most recently added `check:*`-script CI step and documents its own rationale inline.

**Pattern to copy** (lines 77-78):
```yaml
      - name: Web chunk boundary + cycle gate (OPS-16)
        run: npm run check:web-chunks
```
Add a new step of the identical shape immediately after (or near) this one, inside the `static` job (per RESEARCH.md's stated rationale: `static` inherits required-check status with no branch-protection admin action, matching the repo's own recorded Sentry-redaction-gate / pool-factory-audit precedent):
```yaml
      - name: Dependency advisory gate (DEP-01/02/03)
        run: npm run check:dependency-advisories
```

---

### `package.json` (root — new script entry + `concurrently` bump)

**Analog:** existing `check:*` script block (lines 22-71).

**Pattern** (line 22 shown as the template):
```json
"check:lockfile-npm10": "node scripts/check-lockfile-npm10.mjs",
```
Add: `"check:dependency-advisories": "node scripts/check-dependency-advisories.mjs",` in the same alphabetically-adjacent block. Bump `"concurrently": "10.0.3"` (line 77) → `"10.0.5"`.

### `apps/web/package.json` (version bumps only)

`"react-router": "8.1.0"` (line 47) → `"8.3.0"`; `"postcss": "8.5.16"` (line 62) → `"8.5.26"`. No pattern extraction needed — pure version-string edits, run `npm install <pkg>@<version> -w apps/web` per RESEARCH.md's Installation section rather than hand-editing (keeps `package-lock.json` in sync), matching D-01's non-major, direct-pin bump path.

---

## Shared Patterns

### Zero-dependency Node-builtins-only convention
**Source:** every file in `scripts/` (see `check-lockfile-npm10.mjs` line 35, `check-root-hygiene.mjs` line 23, `validate-alloy-config.mjs` lines 30-32 — each states this explicitly in its header comment)
**Apply to:** `scripts/check-dependency-advisories.mjs` and its test file. Do NOT import `zod` even though it resolves via node_modules hoisting (RESEARCH.md's explicit Anti-Pattern warning) — hand-roll accept-list field validation the same way `check-lockfile-npm10.mjs` hand-rolls Dockerfile-tag validation.

### Fail-closed-on-unavailable-tooling
**Source:** `scripts/validate-alloy-config.mjs` lines 236-306 (`ALLOY_VALIDATE_REQUIRE_BINARY` env-flag pattern)
```javascript
const raw = process.env.ALLOY_VALIDATE_REQUIRE_BINARY;
// ...
"Docker is unreachable and ALLOY_VALIDATE_REQUIRE_BINARY is set -- the real-binary layer is required but could not run",
```
**Apply to:** `check-dependency-advisories.mjs`'s registry-retry logic (D-03) — model the "N retries, then throw a FAILED CLOSED error" shape directly on RESEARCH.md's `runNpmAuditWithRetries` example, itself derived from this analog.

### CLI direct-invocation guard
**Source:** `scripts/check-lockfile-npm10.mjs` lines 185-189 (also `check-root-hygiene.mjs`, `check-runbook-coverage.mjs`)
**Apply to:** every new `.mjs` script in this phase — copy verbatim, do not reinvent.

### Action pinning to commit SHA
**Source:** `.github/workflows/ci.yml` header comment (lines 40-42) and every `uses:` line in `ci.yml`/`images.yml`
**Apply to:** `advisory-scan.yml`'s `actions/checkout`, `actions/setup-node`, and `actions/github-script` steps.

### SPECIFICATION.md same-change documentation rule
**Source:** `.claude/CLAUDE.md` "Project Specification" section (hard project rule, not a codebase file to pattern-match against)
**Apply to:** every version bump (postcss, react-router, concurrently, and whatever `npm audit fix` resolves the transitive four to) must be recorded in `SPECIFICATION.md` §2 with the exact installed version from `package.json`/`package-lock.json`; the new gate + scheduled workflow belongs in §7 «Наблюдаемость» as a new CI-level observability mechanism (per RESEARCH.md's explicit mapping, which already resolves this ambiguity — §6 is N/A since no new HTTP entry point is added).

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `.advisory-accept-list.json` | config | — | No existing repo-root JSON config of this shape (entries array with justification/owner/expiry fields) exists to pattern-match against; schema is fully specified by CONTEXT.md D-04..D-07 and RESEARCH.md's Code Examples section instead. |

## Metadata

**Analog search scope:** `scripts/`, `scripts/__tests__/`, `.github/workflows/`, root `package.json`, `apps/web/package.json`
**Files scanned:** `check-lockfile-npm10.mjs`, `check-root-hygiene.mjs`, `check-runbook-coverage.mjs`, `validate-alloy-config.mjs`, `ci.yml`, `images.yml`, `package.json` (root + apps/web), `scripts/__tests__/` directory listing
**Pattern extraction date:** 2026-08-20
