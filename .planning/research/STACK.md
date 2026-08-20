# Stack Research

**Domain:** v1.2 milestone additions — DSR export, workspace purge, unsubscribe-secret rotation, dependency-vulnerability CI gating, campaign template-selection correctness (added onto an existing production Fastify/Drizzle/Postgres/BullMQ/React platform)
**Researched:** 2026-08-20
**Confidence:** MEDIUM (headline finding — no new runtime deps — is HIGH confidence; the CI-tool maintenance-status verdict is cross-checked against primary sources; a few CLI-flag details are flagged LOW/unverified and marked "verify at implementation time")

## Headline Finding

**This milestone needs exactly one new addition to the stack: a CI-only vulnerability-scanning tool (OSV-Scanner, invoked as a GitHub Action/CLI binary, not an npm package).** Every other v1.2 feature is achievable with what's already in `package.json` plus `node:crypto` — do not add a runtime dependency for template correctness, DSR export, workspace purge, or secret rotation. Saying "no new dependency" for four of the five features is itself the research finding, not a gap.

## Recommended Additions

### CI Tooling (not a runtime dependency)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **OSV-Scanner** (`google/osv-scanner`) | v2.5.1 (verified via GitHub API — released 2026-08-17, 3 days before this research) | Dependency-vulnerability CI gate for feature 5 | Actively maintained by Google (near-weekly releases through 2026), queries a federated vulnerability DB (OSV.dev + GHSA + NVD — broader than npm's own advisory DB alone), and its native `osv-scanner.toml` config has an `IgnoreVulns` block with `id` + `ignoreUntil` (expiry) + `reason` fields — this is a direct, purpose-built match for "explicit acceptance of proven-unreachable tooling-only findings," not something to bolt on. Ships two reusable GitHub Actions workflows that map cleanly onto the two halves of the requirement (see Integration below). |
| **`google/osv-scanner-action`** | Pin to `v2.5.1` (verified: tag exists in this repo too, same release date — or use a commit SHA, see house convention below) | The GitHub Actions wrapper around the OSV-Scanner binary | Same project, same release cadence; using the reusable workflow avoids hand-rolling install/cache logic for the Go binary in CI. |

### What is explicitly NOT needed

| Feature | Verdict | Why |
|---------|---------|-----|
| Campaign template correctness (feature 1) | No new dependency | Bug fix in existing code path — the launch/schedule/test-send flow must read the confirmed-saved `template_id` from the persisted campaign record (post-save), not from in-memory dropdown/form state at click time. Pure application-logic fix inside the existing Fastify + Drizzle + Zod stack. |
| DSR contact-data export (feature 2) | No new dependency | Fastify's built-in `reply.header()` + `reply.type()` + `reply.send()` is sufficient: `reply.header('Content-Disposition', 'attachment; filename="contact-<id>-export.json"').type('application/json').send(payload)`. This is a single contact's data (profile, custom properties, consent history, events, send-related PII) — not a bulk multi-tenant export — so no streaming/zip library (`archiver`, `csv-stringify`) is warranted. If a contact's `events` history is ever large enough to matter, Fastify's native `reply.send(stream)` (a readable stream) covers that without adding a dependency; verify size in practice before reaching for one. |
| Workspace purge (feature 3) | No new dependency | This is the same shape of problem the platform already solved in Phase 13: checkpointed, resumable, idempotent scrub over an evidence-allowlist, run from a BullMQ worker job (`@mega-crm/queue-core`), guarded by `tenant_id`/`workspace_id` scoping and RLS. Extend that existing pattern (checkpoint table + bounded batch + reclaim-worker-for-interrupted-runs) to cover "delete the workspace's row set + KMS-wrapped tenant secrets" rather than introducing new infrastructure. |
| Unsubscribe-secret rotation (feature 4) | No new dependency | `node:crypto`'s `createHmac`/`timingSafeEqual` (already used for the existing single-secret `UNSUBSCRIBE_TOKEN_SECRET` HMAC and for the SendGrid webhook ECDSA verification) is sufficient — see Integration below for the pattern. |

## Installation

```bash
# Runtime dependencies: none for any of the five v1.2 features.

# CI-only addition — no npm install. Reference the pinned action directly
# in a workflow file, e.g. .github/workflows/osv-scan-pr.yml and
# .github/workflows/osv-scan-scheduled.yml:
#
#   uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable-pr.yml@v2.5.1
#   uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.5.1
#
# Add osv-scanner.toml at the repo root for the accept-list (IgnoreVulns).
```

## Integration Notes (the load-bearing detail per feature)

### Dependency hygiene (feature 5) — OSV-Scanner

- **Scope of scan:** OSV-Scanner reads the root `package-lock.json` directly — one lockfile already covers every workspace in an npm-workspaces monorepo (`apps/api`, `apps/worker`, `apps/web`, and all `packages/*`). No per-workspace invocation is needed, unlike tools that shell out to `npm audit --workspaces`.
- **"NEW" has two distinct meanings — cover both with two workflows:**
  1. *Newly introduced by a PR* (a dependency bump adds a vulnerable package) → use the **PR-diff reusable workflow** (`google/osv-scanner-action/.github/workflows/osv-scanner-reusable-pr.yml`), which scans target-branch vs. feature-branch and reports only the delta. This is a fast, low-noise PR gate.
  2. *Newly published against an existing, unchanged dependency* (an advisory drops for a package already in `package-lock.json`) → the PR-diff workflow will **not** catch this (both branches already have the vuln, so the diff is empty). This requires the **scheduled/push full-scan reusable workflow** (`osv-scanner-reusable.yml`) running on a cron (e.g. daily) plus `master` pushes.
  - Run both. The milestone's "CI-контроль новых неразобранных HIGH advisories" requirement is only fully met by the combination.
- **The accept-list mechanism *is* `osv-scanner.toml`:** an `IgnoreVulns` entry per accepted finding, each carrying `id` (GHSA/CVE/OSV id), optional `ignoreUntil` (forces re-triage after a date — use this for anything "temporarily accepted"), and `reason` (free text — put the "proven unreachable / tooling-only" justification here). "Untriaged" in the requirement's sense = "not yet present in `osv-scanner.toml`" — anything absent from the file fails the gate by default; this is the correct default-fail-closed posture and needs no extra state tracking.
- **Findings will include devDependency/tooling-only packages** (build tools, test runners, linters) because the scan covers the whole lockfile — this is expected, not scope creep. Each such finding either gets fixed (bump) or gets an `IgnoreVulns` entry with a reason establishing it's unreachable at runtime (e.g. "dev-only, never bundled/shipped").
- **Severity threshold ("HIGH and above") — verify at implementation time, do not assume a ready-made flag exists.** Search results surfaced `--min-severity` documented under the `osv-scanner fix` (guided remediation) subcommand, and an open upstream issue (#1400, "Configurable CVSS Threshold in config.toml") implying the plain `scan`/CI path may not have a first-class severity-threshold flag as of this writing. Plan for one of two implementation paths and pick whichever the current CLI actually supports when the phase executes: (a) a thin (~20–30 line) post-filter script over `--format json` output, filtering on the CVSS/severity field the JSON already carries (≥ 7.0 = HIGH+), gating CI on that script's exit code; or (b) gate on all severities returned (simpler, stricter than the requirement, acceptable if the volume of MEDIUM/LOW findings is small enough not to create allowlist churn). Do not build the gate against an assumed flag without checking `osv-scanner --help` / current docs first.
- **SARIF upload defaults on — check before enabling.** Both reusable workflows default `upload-sarif: true`, which pushes results to GitHub's Code Scanning (Security tab). SARIF upload from a *private* repository requires GitHub Advanced Security. Set `upload-sarif: false` explicitly unless GHAS is confirmed enabled for this repo, or the workflow run will fail/no-op on day one for a reason unrelated to the actual vulnerability gate.
- **Pin the action**, consistent with the project's existing "immutable tags everywhere" convention (GHCR SHA-tags, compose immutability gate): reference `google/osv-scanner-action/...@v2.5.1` or a commit SHA, not `@main` or a floating major tag.
- **Do not add `npm audit` as a second/competing gate.** It's useful as a fast local pre-commit check (`npm audit --omit=dev --audit-level=high`, and it natively supports `--workspaces`), but as a CI *gate* it duplicates OSV-Scanner with a narrower advisory database and no accept-list mechanism — one source of truth is simpler to keep an allowlist file honest against.

### Unsubscribe-secret rotation (feature 4) — pattern, not a library

- Current state: single `UNSUBSCRIBE_TOKEN_SECRET` env var, HMAC signs/verifies unsubscribe links.
- Target pattern (dual-phase rotation, standard for HMAC key rotation): change the env shape from one secret to an **ordered list** of secrets (e.g. `UNSUBSCRIBE_TOKEN_SECRETS` as a comma- or JSON-array-encoded list, first entry = primary). Sign new links only with the primary (first) secret. Verify incoming tokens by trying each secret in the list in order until one succeeds (or fails closed if none match) — because the existing token format has no embedded key-id, this ordered-list-and-try approach is required for backward compatibility with already-sent links, not optional.
- Use `crypto.timingSafeEqual` for the comparison step (already the correct pattern elsewhere in this codebase's HMAC/signature verification code) to avoid timing attacks during the multi-secret verification loop.
- Optional forward-looking improvement (not required to ship v1.2, worth a one-line design note): new tokens could embed a short key identifier so future verification can jump straight to the right secret instead of trying the list — only worth it once the secret list grows past two or three entries.
- No `node-jose`, `jose`, or similar JWT/JWK library is warranted here — the existing links are bespoke HMAC tokens, not JWTs, and introducing a JOSE library to solve a single-purpose rotation problem would be a scope increase without benefit.

## Alternatives Considered

| Recommended | Alternative | Why Not (verified) |
|-------------|-------------|---------------------|
| OSV-Scanner | `audit-ci` (IBM) | On paper, a strong fit: supports npm/yarn/pnpm/bun, `audit-ci.jsonc` allowlist with per-advisory expiry+reason, `npm audit --workspaces` monorepo support. **Verified directly via GitHub API: last release `v7.1.0` and last commit both `2024-07-03` — no commits or releases in over 2 years as of 2026-08-20**, 17 open issues, 3 unmerged PRs. Wraps `npm audit` under the hood, so its vulnerability coverage is bounded by npm's own advisory DB. Not recommended for new adoption on a project with a "dependency hygiene" milestone as its explicit motivation — you'd be adding a stale tool to fix a staleness problem. |
| OSV-Scanner | `better-npm-audit` | Same category of tool (wraps `npm audit`, adds an ignore-list), same problem: **verified last npm publish `2024-09-09` (v3.11.0)**, ~2 years stale. Narrower feature set than audit-ci even when both were current. |
| OSV-Scanner | GitHub Dependabot alerts + auto-triage rules | Legitimate complementary signal (native dismissal reasons like `tolerable_risk`, `not_used` map well onto "accepted findings"), but it is GitHub-platform-coupled state living outside the repo, harder to review in a PR diff, and isn't a portable CI-gate script the way a config file checked into the repo is. Consider enabling Dependabot alerts *in addition to* the OSV-Scanner CI gate as a second signal, not as a replacement — but the CI gate itself should be the repo-local, PR-reviewable `osv-scanner.toml`. |
| `node:crypto` HMAC (ordered-secret-list rotation) | `jose` / JWT-based token rewrite | Would require re-issuing every already-sent unsubscribe link (defeats the "previous secrets still verify old links" requirement) and pulls in a general-purpose JWT library to solve a narrower problem than JWT is built for. |
| Fastify built-in `reply.send()` | `archiver` / `csv-stringify` / streaming export libraries | Only relevant for bulk, multi-file, or multi-tenant exports — DSR export here is one contact's record, well within the size where a plain JSON `reply.send()` is correct. Adding a zip/streaming library for a single-record export would be unjustified complexity. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|--------------|
| `audit-ci` | Dormant since 2024-07-03 (verified: no commits/releases in 2+ years) — adopting it to solve a "dependency hygiene" requirement is self-defeating | OSV-Scanner |
| `better-npm-audit` | Dormant since 2024-09-09 (verified via npm registry) | OSV-Scanner |
| Bare `npm audit` as the CI *gate* | No allowlist/triage mechanism, npm-advisory-DB-only coverage — can't satisfy "accepted-findings mechanism for proven-unreachable findings" on its own | OSV-Scanner CI gate; keep `npm audit --omit=dev --audit-level=high` only as a fast local dev-loop check, not the CI source of truth |
| `archiver`, `csv-stringify`, zip/streaming export libs for DSR export | Solves a bulk-export problem this feature doesn't have (single contact) | Fastify native `reply.send()` with a plain JSON payload |
| `jose` / JWT libraries for unsubscribe-secret rotation | Existing tokens are bespoke HMAC, not JWT; a rewrite would invalidate previously-sent links, which is the exact failure mode this feature exists to avoid | `node:crypto` `createHmac` + `timingSafeEqual` over an ordered secret list |
| Reinventing workspace purge as new infrastructure | Phase 13 already built and proved (checkpointed scrub worker, evidence-allowlist, reclaim-worker-for-interrupted-runs, `erasure_records`-style audit trail) the exact resumable/idempotent/tenant-safe shape this feature needs | Extend the existing erasure/scrub worker pattern in `@mega-crm/queue-core` + the erasure records table shape |

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `google/osv-scanner-action@v2.5.1` | GitHub Actions (any runner) | Verified via GitHub API: this tag exists in `google/osv-scanner-action` (not just in the scanner binary's own repo) and shares the same release date. Pin to this tag or a commit SHA per house convention (immutable references, matching the GHCR SHA-tag / compose-immutability pattern already used for the postgres image). Re-verify the pinned version periodically — the project releases frequently (v2.5.0 → v2.5.1 within roughly a week in the observed history). |
| `osv-scanner.toml` | Root of npm-workspaces monorepo | One file at repo root covers all workspaces since there is one `package-lock.json`; no per-package config needed. |

## Sources

- [IBM/audit-ci GitHub repo](https://github.com/IBM/audit-ci) — MEDIUM confidence (verified directly via GitHub REST API: `releases/latest` and `commits/main` both return `2024-07-03`, cross-checked against npm registry `time.modified` for the same date)
- [better-npm-audit npm package page](https://www.npmjs.com/package/better-npm-audit) — MEDIUM confidence (verified via `npm view better-npm-audit time.modified` → `2024-09-09`)
- [google/osv-scanner GitHub repo](https://github.com/google/osv-scanner) / [releases](https://github.com/google/osv-scanner/releases) — MEDIUM confidence (verified via GitHub REST API: latest release `v2.5.1` published `2026-08-17`, i.e. 3 days before this research date)
- [google/osv-scanner-action GitHub repo](https://github.com/google/osv-scanner-action) — MEDIUM confidence (verified via GitHub REST API `tags` and `releases/latest`: `v2.5.1` exists in this repo too, published the same date as the scanner's own release)
- [OSV-Scanner configuration docs](https://google.github.io/osv-scanner/configuration/) — MEDIUM confidence, WebSearch-derived summary of `IgnoreVulns`/`PackageOverrides` schema; recommend a direct doc read at implementation time to confirm exact field names before writing `osv-scanner.toml`
- [OSV-Scanner GitHub Action docs](https://google.github.io/osv-scanner/github-action/) — LOW/MEDIUM confidence, WebSearch-derived; the two reusable-workflow paths (`osv-scanner-reusable-pr.yml` vs `osv-scanner-reusable.yml`) and `upload-sarif`/`fail-on-vuln` inputs were reported consistently across the fetch, but exact current flag names should be re-confirmed against the live docs page at implementation time
- [OSV-Scanner usage docs](https://google.github.io/osv-scanner/usage/) + [GitHub issue #1400](https://github.com/google/osv-scanner/issues/1400) — LOW confidence on the specific claim that plain `scan` lacks a built-in severity-threshold flag; `--min-severity` was found documented only under `osv-scanner fix` (guided remediation) in what was fetched. **Flagged explicitly above as "verify at implementation time"** rather than treated as settled.
- [Fastify Reply reference](https://fastify.dev/docs/latest/Reference/Reply/) and community file-download examples — LOW confidence, WebSearch-derived, but consistent with Fastify's documented `reply.header()`/`reply.type()`/`reply.send()` API already in use elsewhere in this codebase
- General HMAC key-rotation pattern (dual-phase: sign-with-primary, verify-against-list) — LOW confidence, general security-engineering consensus from WebSearch, not a single authoritative source; treated as a well-established pattern rather than a novel claim
- `npm view audit-ci`, `npm view better-npm-audit`, `curl https://api.github.com/repos/...` — HIGH confidence, direct primary-source registry/API queries run during this research session (2026-08-20)

---
*Stack research for: Mega CRM v1.2 Data Lifecycle & Delivery Trust milestone*
*Researched: 2026-08-20*
