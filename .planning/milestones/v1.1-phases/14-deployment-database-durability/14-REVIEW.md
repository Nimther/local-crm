---
phase: 14-deployment-database-durability
reviewed: 2026-08-13T15:10:00Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - .github/workflows/ci.yml
  - .github/workflows/images.yml
  - package.json
  - scripts/__tests__/check-lockfile-npm10.test.mjs
  - scripts/check-lockfile-npm10.mjs
  - SPECIFICATION.md
findings:
  critical: 0
  warning: 2
  info: 3
  total: 5
status: issues_found
---

# Phase 14: Code Review Report (re-review, gap-closure plan 14-14)

**Reviewed:** 2026-08-13T15:10:00Z
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues_found

## Summary

Scope: the three new/changed files from the G-14-4 gap-closure execution (`scripts/check-lockfile-npm10.mjs`, its test, and the `.github/workflows/{ci,images}.yml` wiring), plus the small, targeted additions to `package.json` and `SPECIFICATION.md`. This is a re-review after an earlier full review + fix cycle already committed for this phase; no structural pre-pass was supplied for this execution.

Verified empirically, not just read:
- The full test file (`scripts/__tests__/check-lockfile-npm10.test.mjs`) passes, including Test 9, which runs the real CLI with no override against this repo's actual `package-lock.json` under a real `npx npm@10` — confirming the guard currently passes against the real lockfile and Dockerfiles.
- The apparent `npm error Usage:` dump surfaced while running Test 6 (desynced fixture) is npm's own `EUSAGE`-class output for a lockfile-desync failure (the guard's own header names this exact "EUSAGE error signature"); the `Missing: left-pad` detail lines were above the `tail` window used to capture output, not missing from the real run — the test's `/left-pad/` and `/Missing/` assertions passed. Not a defect.
- `git status` after both test runs is clean — the guard's `npm ci --dry-run` leaves no side effects in the working tree.
- The privilege boundary called out in the review scope holds: `images.yml`'s `build-only` job (pull_request, including forked PRs) overrides the workflow-level `packages: write` down to job-level `permissions: contents: read`, has no `docker/login-action` step, and passes `push: false` — a fork PR can build an image but cannot authenticate to any registry. `build-and-push` (the job that *can* publish) is gated `if: github.event_name == 'push'` and is the only job with `packages: write`, inherited from workflow level. All three reused action SHAs (`actions/checkout`, `docker/setup-buildx-action`, `docker/build-push-action`) are byte-identical between `build-and-push` and the new `build-only` job, matching the header comment's claim that Task 3 reused them verbatim rather than re-resolving.
- `SPECIFICATION.md`'s two edits (the `static` job step table, and the "Dev/CI-only npm-scripts" list) accurately describe the new `check:lockfile-npm10` step and script; `package.json`'s only change is the one new script entry, correctly wired to `scripts/check-lockfile-npm10.mjs`.

No Critical issues found. Two Warnings and three Info-level observations below — none blocks this change; the Warnings are worth fixing before this pattern is reused elsewhere.

## Warnings

### WR-01: `isDirectInvocation()` silently no-ops on any repo path containing a space or other URL-reserved character

**File:** `scripts/check-lockfile-npm10.mjs:185-189`
**Issue:** The CLI-entry-point guard compares `import.meta.url` against a hand-built `file://` string:

```js
function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${path.resolve(entry)}`;
}
```

`import.meta.url` is always percent-encoded by Node; `` `file://${path.resolve(entry)}` `` is a raw string concatenation and is not. Verified empirically: for a real `.mjs` file at a path containing a space, `import.meta.url` reports `.../space%20test/foo.mjs` while the concatenated comparison string is `.../space test/foo.mjs` — they never match. Any checkout path containing a space (or any other character Node's URL encoder escapes) makes `isDirectInvocation()` return `false` even when the script genuinely was invoked directly, so `main()` never runs and the process exits `0` with no output — the "green gate that examined nothing" failure mode this same repo's `lint:floor` step exists to catch for ESLint, reproduced here for this guard. This is latent, not currently triggered (this repo's checkout paths in CI and locally are clean), but the guard is wired into `static`, a required status check, specifically to be fail-loud (per its own header comment) — a silent pass on this specific edge case defeats that design goal for anyone whose environment (e.g. a local `~/My Projects/mega-crm` clone, or a CI runner workspace with a space in the path) triggers it.

**Fix:** Use `pathToFileURL` from `node:url`, which produces the same encoding Node uses for `import.meta.url`, instead of a manual string concat:

```js
import { fileURLToPath, pathToFileURL } from "node:url";

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}
```

### WR-02: `check:lockfile-npm10`'s default invocation requires npm-registry network access, and it runs inside a required status check

**File:** `scripts/check-lockfile-npm10.mjs:221-223`; wired at `.github/workflows/ci.yml:107-108` (step `npm-10 lockfile guard`, inside job `static`)
**Issue:** With no `--npm-command` override (the path both the `npm run check:lockfile-npm10` script and the CI step take), the guard defaults to `["npx", "--yes", "npm@10"]`. `npx --yes npm@10` needs to resolve and fetch the `npm@10` package from the registry (or an already-warm local `_npx` cache) before it can run `--version`/`ci --dry-run`. `static` is one of the three required status checks on `master` (per this repo's own branch protection, referenced in `images.yml`'s header comment) — a registry hiccup or an air-gapped/offline CI runner now fails a required check for a reason that has nothing to do with lockfile correctness, blocking every merge until the registry (or npx's local package cache) is reachable again. This is a real, if low-probability, availability risk specifically because the check is required, not merely informational.
**Fix:** No change strictly required for correctness, but consider one of: (a) documenting the network dependency explicitly in the step's CI comment (currently only the script's own header discusses it) so a future on-call engineer diagnosing a red `static` job knows to check registry/npx-cache health before suspecting the lockfile itself; or (b) pre-warming `npm@10` into the `actions/setup-node` npm cache (or a dedicated `actions/cache` step keyed on the npm major) so the CI path never needs a live registry round-trip on a warm cache.

## Info

### IN-01: Test 9's own hermeticity claim in the file header is inaccurate for that test

**File:** `scripts/__tests__/check-lockfile-npm10.test.mjs:10-18` (header) vs. `:143-148` (Test 9)
**Issue:** The file header states: "Hermetic by construction: every CLI case below either runs entirely offline (the `--plan` mode and the tag-mismatch fixture, both of which never invoke npm) or points `--npm-command` at this environment's own `npm` binary against a fixture lockfile...". Test 9 ("the real repo root's own npm-10 dry-run (no override)") does neither: it calls `runCli([])` with no `--npm-command`, so it exercises the default `npx --yes npm@10` path described in WR-02, which needs registry/npx-cache access at least once. This is the same underlying network dependency as WR-02, but here it's specifically a comment-vs-behavior mismatch inside the test file itself, worth fixing independently of whether WR-02's CI-level risk is addressed.
**Fix:** Either narrow the header's "hermetic by construction" claim to explicitly except Test 9 (e.g. "...except Test 9, which deliberately exercises the real `npx npm@10` path end-to-end and therefore needs registry or npx-cache access at least once"), or move Test 9's rationale into its own `describe` comment so the file-level claim isn't contradicted by one of its own cases.

### IN-02: `build-and-push` never consumes the GHA cache scope `build-only` writes — currently safe, but the boundary is easy to erode later

**File:** `.github/workflows/images.yml:110-122` (`build-and-push`) vs. `:148-159` (`build-only`)
**Issue:** `build-only` (runs on `pull_request`, including forked PRs, with no registry credentials) writes to the GitHub Actions cache backend (`cache-to: type=gha,mode=max,scope=${{ matrix.app }}`). `build-and-push` (the job that publishes to GHCR, gated to `push` events only) currently has no `cache-from`/`cache-to` at all, so it never reads cache entries a fork-originated PR build could have written — there is no cache-poisoning path into a published image today. This is correct as written; flagging only because the two jobs share a `scope` key by app name, and a future change that adds `cache-from: type=gha,scope=${{ matrix.app }}` to `build-and-push` "to speed up master builds" would silently start trusting build-layer cache written by unauthenticated fork PR runs, without that being an obvious review point at the time (it would look like a pure performance change).
**Fix:** No action needed now. If `build-and-push` ever gains a `cache-from`, use a distinct scope (e.g. `scope=${{ matrix.app }}-push`) so it never reads cache entries `build-only` (PR-writable, fork-reachable) produced.

### IN-03: Pre-existing `SPECIFICATION.md` staleness on the `ci.yml` push trigger, unrelated to this change

**File:** `SPECIFICATION.md:60`
**Issue:** Line 60 still describes `ci.yml`'s `push` trigger as "без фильтра веток" (unscoped). The actual `.github/workflows/ci.yml` (unchanged by this execution, confirmed via `git diff` against `diff_base`) scopes `push` to `branches: [master]`, per its own header comment explaining the earlier fix for the double-run-on-open-PR bug. This line was not touched by the reviewed diff (only the `static` row and two other lines were edited in this execution, confirmed via `git diff`), so it's out of this review's fix scope, but noting it here since it's a real, currently-existing inaccuracy in the same document this execution edited nearby.
**Fix:** Out of scope for this diff; worth a follow-up one-line correction to `SPECIFICATION.md:60` ("push (branches: [master])") whenever that section is next touched.

---

_Reviewed: 2026-08-13T15:10:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
