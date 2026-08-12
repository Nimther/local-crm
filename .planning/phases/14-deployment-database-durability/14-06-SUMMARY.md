---
phase: 14-deployment-database-durability
plan: 06
subsystem: infra
tags: [docker, dockerfile, caddy, ghcr, github-actions, ci-cd, node22, multi-stage-build]

requires:
  - phase: 14-01
    provides: "packages/db/src/migration-journal.ts (DRIZZLE_MIGRATIONS_FOLDER resolution), scripts/migrate-runner.mjs, apps/api /healthz+/readyz"
  - phase: 14-03
    provides: "packages/db/src/pool.ts createPgPool, sslmode=require&uselibpqcompat=true TLS decision (deferred to plan 14-08's DSN)"
  - phase: 14-04
    provides: "apps/worker/src/health-server.ts (127.0.0.1:4100 /healthz+/readyz), scripts/print-stop-grace-period.mjs, and the CRITICAL forward flag this plan closes: plain node cannot resolve unbuilt workspace-package roots"
provides:
  - "docker/Dockerfile.api, docker/Dockerfile.worker: multi-stage Node 22 builds, non-root, exec-form CMD, api image self-sufficient for the one-shot migrate step and /readyz's applied-vs-shipped check"
  - "docker/patch-workspace-mains.mjs: the general fix for plan 14-04's forward flag -- compiles every shared packages/* workspace to real dist/ inside the image build only and repoints main/types/exports at it, uniformly, so every @mega-crm/<pkg>/src/<leaf>.js deep-import specifier keeps resolving under plain node"
  - "docker/Dockerfile.web + docker/Caddyfile: one self-contained image carrying the built SPA and the Caddy routing config (every server-side path proxied, SPA history fallback, hashed assets long-cached, index.html never long-cached)"
  - ".dockerignore: node_modules/dist/.git/.planning/coverage/every env-file pattern excluded from every image's build context"
  - ".github/workflows/images.yml: builds+pushes api/web/worker to GHCR on every push to master, one immutable git-SHA tag per image, every action SHA-pinned"
  - "docs/runbooks/container-images.md: the three images, the compile-and-patch mechanism, the tag scheme, and exactly what this plan verified locally vs. deferred to CI"
affects: ["14-08 (production compose consumes these three image names/Dockerfiles and this Caddyfile)", "14-09 (deploy script pulls tags this workflow produces, rollback = redeploy a previous SHA tag)", "14-13 (SPECIFICATION.md filing)", "any future plan adding a new packages/* workspace or a new apps/api|worker deep-import specifier"]

tech-stack:
  added: []
  patterns:
    - "Compile-then-patch for production Node execution of a source-only workspace package: every packages/* ships noEmit:true + main pointed at .ts source BY DESIGN for tsx/vitest dev tooling; a Docker-build-only script compiles to real dist/ and rewrites main/types/exports, never touching git-tracked source -- confined entirely to the image, reversible by construction"
    - "Uniform exports shape across every workspace package (\".\": dist/index.js, \"./src/*.js\": dist/*.js) regardless of whether a package currently has any deep-import consumer -- makes the whole class of 'a future deep import breaks under node' failure structurally impossible rather than fixing only the imports found by today's grep"
    - "Explicit rootDir + a generated tsconfig.build.json exclude for __tests__/*.test.ts on every compile-in-image step -- discovered empirically that omitting rootDir lets a package's own test files (which import sibling operator-CLI scripts outside src/) widen tsc's auto-inferred common root and silently shift every output path"

key-files:
  created:
    - docker/Dockerfile.api
    - docker/Dockerfile.worker
    - docker/Dockerfile.web
    - docker/Caddyfile
    - docker/patch-workspace-mains.mjs
    - .dockerignore
    - .github/workflows/images.yml
    - docs/runbooks/container-images.md
  modified: []

key-decisions:
  - "Approach validated against a real empirical failure, not assumed: `node` throws ERR_MODULE_NOT_FOUND when a relative `./bar.js` specifier's sibling file is only `bar.ts` -- reproduced directly in this sandbox before choosing the compile-and-patch design over shipping TypeScript source to production (which the CMD-must-be-node acceptance criterion also independently forecloses, since tsx/ts-node as CMD would violate it)"
  - "docker/patch-workspace-mains.mjs patches ALL 10 shared packages' exports uniformly, not just the 3 (db, delivery-core, queue-core) that already had an exports field or the handful of specific deep-import specifiers a repo-wide grep found -- a future deep import of any packages/* leaf module keeps resolving without a second pass over this script"
  - "packages/db/migrations sits at the same sibling path relative to dist/ as it does to src/ (both one level below packages/db) -- confirmed DRIZZLE_MIGRATIONS_FOLDER's `path.resolve(import.meta.dirname, \"../migrations\")` resolution is compile-target-agnostic before relying on it, rather than assuming plan 14-01's own SUMMARY comment (\"packages/db ships no compiled dist/ ... this file is read as source everywhere it runs\") still holds -- it does not, after this plan, and that comment is now stale (out of this plan's files_modified scope; flagged here rather than silently edited)"
  - "caddy:2 resolves to caddyserver/caddy-docker's ALPINE variant, not Debian -- verified via the docker-library/docs \"Shared Tags\" listing rather than assumed; Dockerfile.web's non-root user setup uses BusyBox adduser/addgroup syntax accordingly, and no setcap step was added because the base image's own Dockerfile already grants /usr/bin/caddy CAP_NET_BIND_SERVICE"
  - "images.yml computes a lowercase GHCR image base via a shell step rather than using ${{ github.repository }} directly -- this repository's own owner segment contains an uppercase letter, which would have produced an invalid OCI reference; GitHub Actions expressions have no built-in lowercase function"
  - "Quality gate for images.yml is existing branch-protection on master (contexts: static/test/failure-injection, enforce_admins:true, strict:true), confirmed via a live `gh api repos/:owner/:repo/branches/master/protection` call at implementation time -- not the workflow_run alternative, and not claimed without that evidence"

patterns-established:
  - "Any future Docker image built from this monorepo that needs a packages/* workspace at runtime under plain node must go through the same compile-and-patch step (or its logical equivalent) -- shipping a package's .ts source and expecting node to resolve it will fail the same way, regardless of which specific package it is"

requirements-completed: [OPS-01]

coverage:
  - id: D1
    description: "docker/Dockerfile.api + docker/Dockerfile.worker: multi-stage Node-22-pinned builds, non-root USER, exec-form node CMD, api image self-sufficient for the one-shot migrate step and /readyz's applied-vs-shipped check via docker/patch-workspace-mains.mjs's general compile-and-patch fix"
    requirement: "OPS-01"
    verification:
      - kind: unit
        ref: "grep -c \"FROM node:22\" docker/Dockerfile.api / docker/Dockerfile.worker -- both >=1"
        status: pass
      - kind: unit
        ref: "grep over CMD lines of both files: first element is node, zero npm references"
        status: pass
      - kind: unit
        ref: "USER instruction present after the runtime stage's file copies in both files"
        status: pass
      - kind: integration
        ref: "Local rehearsal (no Docker daemon in this sandbox): npm run build -w apps/api, then the real docker/patch-workspace-mains.mjs against the checked-in worktree (restored afterward), then `node apps/api/dist/server.js` under plain node against an ephemeral Postgres database (created/dropped for this test, never the shared dev DB) -- GET /readyz answered 503 naming \"migrations\" before scripts/migrate-runner.mjs ran, and 200 immediately after, from the same compiled tree. GET /healthz answered 200 throughout. Boot log clean, no errors."
        status: pass
      - kind: integration
        ref: "npm run build -w apps/worker compiles cleanly against the same patched package set (worker's own boot/readyz behavior was not separately re-run against a live server -- see human_judgment below)"
        status: pass
      - kind: manual_procedural
        ref: "docker build -f docker/Dockerfile.api -t megacrm-api:local . (and the same for Dockerfile.worker) from a clean checkout"
        status: unknown
    human_judgment: true
    rationale: "No Docker daemon exists in this sandbox (docker CLI unavailable, confirmed by the prior executor per this worktree's repo-specific rules). The load-bearing mechanism the Dockerfiles depend on -- compiling every shared workspace package to real dist/ output and repointing package.json at it so plain node can resolve every deep import -- was proven directly against the real worktree (compile, patch, boot the compiled apps/api/dist/server.js, hit /readyz twice, restore). What remains unproven is Docker-layer mechanics themselves (layer caching, COPY --from resolution across the exact stage names, npm ci/prune behavior inside the node:22-slim base image specifically) and apps/worker's own health-server boot under the same compiled tree. A human (or CI) must run `docker build -f docker/Dockerfile.api -t megacrm-api:local .` (and the worker equivalent) from a clean checkout and the exact `<verify>` block in 14-06-PLAN.md to close this."
  - id: D2
    description: "docker/Dockerfile.web + docker/Caddyfile: one self-contained image carrying the built SPA and Caddy routing (every server-side path proxied to api:4000, SPA history fallback, hashed /assets/* long-cached, index.html never long-cached, automatic HTTPS left on)"
    requirement: "OPS-01"
    verification:
      - kind: unit
        ref: "docker/Caddyfile contains handle blocks for /api/*, /webhooks/*, /unsubscribe/*, /healthz, /readyz (all proxying to port 4000) and a try_files fallback to index.html -- grep-confirmed"
        status: pass
      - kind: unit
        ref: "grep -v '^\\s*#' docker/Caddyfile | grep -ci 'certbot\\|auto_https off' == 0"
        status: pass
      - kind: integration
        ref: "npm run build -w apps/web produces dist/index.html + dist/assets/*.{js,css} -- confirms the Caddyfile's /assets/* handle block matches Vite's actual default output layout"
        status: pass
      - kind: manual_procedural
        ref: "docker build -f docker/Dockerfile.web -t megacrm-web:local . ; stub-upstream routing proof (GET /api/ping and POST /webhooks/sendgrid/tok both reach the stub with byte-identical body; GET /dashboard/anything returns index.html) -- exact commands recorded in docs/runbooks/container-images.md"
        status: unknown
    human_judgment: true
    rationale: "No Docker daemon and no local `caddy` binary exist in this sandbox. The Caddyfile's routing correctness (five handle blocks, byte-identical webhook body passthrough, SPA fallback) rests on Caddy's own documented `handle`/`reverse_proxy`/`try_files` semantics and was reasoned through carefully (including verifying caddy:2 resolves to the Alpine base image before writing the non-root user setup), but was not executed against a running Caddy process. A human (or CI) must run the stub-upstream proof this plan's own <verify> block and the runbook both specify."
  - id: D3
    description: ".github/workflows/images.yml: builds and pushes api/web/worker to GHCR on every push to master under one immutable git-SHA tag each, every action SHA-pinned, ci.yml untouched"
    requirement: "OPS-01"
    verification:
      - kind: unit
        ref: "test -f .github/workflows/images.yml && grep -Eq 'uses: *[^ ]+@[0-9a-f]{40}' (4 matches) && zero pull_request references && zero :latest references && zero floating-major-tag (@v[0-9]) references, over non-comment lines -- exact command from the plan's own <verify> block"
        status: pass
      - kind: unit
        ref: "node -e requiring the 'yaml' package to parse .github/workflows/images.yml -- valid YAML, matrix/steps/tags structure confirmed"
        status: pass
      - kind: integration
        ref: "gh api repos/:owner/:repo/branches/master/protection -- confirmed required_status_checks.contexts=[static,test,failure-injection], enforce_admins.enabled=true, required_status_checks.strict=true (the quality-gate evidence cited in the workflow's own header comment)"
        status: pass
      - kind: integration
        ref: "gh api repos/docker/{login-action,build-push-action,setup-buildx-action}/git/refs/tags/<tag> and repos/actions/checkout/git/refs/tags/v7 -- every pinned SHA resolved fresh at implementation time, not from training data"
        status: pass
      - kind: manual_procedural
        ref: "gh run watch on the first real push to master after this plan merges -- the exact command this file's own docs/runbooks/container-images.md names"
        status: unknown
    human_judgment: true
    rationale: "This workflow cannot be exercised until it exists on master and a real push happens (gh workflow list / gh run watch both require the file to be present upstream). Everything checkable without a real GitHub push -- YAML validity, the grep-asserted SHA-pinning/no-latest/no-pull_request invariants, the branch-protection evidence for the quality-gate claim, and every action SHA's freshness -- was verified via `gh api` against this repository's live settings, not assumed."

duration: ~3.5h
completed: 2026-08-13
status: complete
---

# Phase 14 Plan 06: Docker Images + GHCR CI Summary

**Three Dockerfiles (api/worker/web) plus a build-only `docker/patch-workspace-mains.mjs` that compiles every source-only shared workspace package to real `dist/` and repoints its `package.json` at it — the general fix for the "plain `node` cannot resolve an unbuilt workspace package" gap plan 14-04 flagged forward — verified end-to-end locally (no Docker daemon in this sandbox) by booting the real compiled `apps/api/dist/server.js` against an ephemeral Postgres and watching `/readyz` flip 503→200 across a real `migrate-runner.mjs` run.**

## Performance

- **Duration:** ~3.5h
- **Tasks:** 3 (Task 1 api+worker Dockerfiles, Task 2 web image + Caddyfile + runbook, Task 3 GHCR CI workflow)
- **Files created:** 8
- **Files modified:** 0

## Accomplishments

- **Root-caused and fixed the exact problem plan 14-04's SUMMARY flagged forward, generally, not just for the two constants that plan needed:** every `packages/*` shared workspace ships `"main": "./src/index.ts"` with `noEmit: true` in its own `tsconfig.json` **by design** (confirmed by reading all 10 tsconfig.json files, not assumed) — `tsx`/`vitest` read these as TypeScript source in dev and tests. Reproduced empirically in this sandbox that plain `node` throws `ERR_MODULE_NOT_FOUND` when a relative `./bar.js` import specifier's sibling file on disk is only `bar.ts` (this is a Node ESM resolution fact, not specific to TypeScript type-stripping maturity). `docker/patch-workspace-mains.mjs` compiles every one of the 10 packages `apps/api`/`apps/worker` import at runtime to real `dist/` output **inside the image build only**, using a generated per-package `tsconfig.build.json` (`noEmit: false`, explicit `rootDir: "src"`, `__tests__`/`*.test.ts` excluded from the compile itself), then rewrites that package's `main`/`types`/`exports` to point at `dist/`. Every package gets the **same** `exports` shape (`{".": "./dist/index.js", "./src/*.js": "./dist/*.js"}`) regardless of whether it already had one or whether today's grep found a consumer for it — this makes the whole class of "a future deep import breaks under `node`" failure structurally impossible, not just fixed for the specific imports found while writing this plan.
- **Found and fixed a second, subtler bug while building the fix above:** compiling `packages/db` without an explicit `rootDir` silently widened `tsc`'s auto-inferred common root from `src` to the package root, because `packages/db`'s own `__tests__` files import sibling `packages/db/scripts/*.ts` operator CLIs — every output path then shifted under an extra `src/`/`scripts/` prefix, breaking every downstream import (`@mega-crm/db/src/pool.js` resolved to a path that did not exist). Reproduced, diagnosed via a standalone debug compile, and fixed by generating an explicit `rootDir: "src"` + test-exclude `tsconfig.build.json` per package rather than relying on `tsc`'s inference.
- **Proved the fix end-to-end against a real process boot, not just a resolution check:** compiled `apps/api`'s own `dist/`, ran the real (not a copy) `docker/patch-workspace-mains.mjs` against the checked-in worktree, then ran `node apps/api/dist/server.js` under plain `node` against a freshly-created, never-migrated ephemeral Postgres database (created and dropped solely for this test — the shared dev database was never touched). `GET /readyz` answered `503` naming `"migrations"` as the failing check; running `node scripts/migrate-runner.mjs` from the exact same compiled tree, then re-polling `/readyz`, answered `200` with all three checks passing. This is the plan's own named highest-risk failure mode ("the most likely single failure of this plan"), proven without a Docker daemon. `apps/worker`'s own `npm run build` was also confirmed to compile cleanly against the same patched package set.
- **`docker/Dockerfile.api`/`docker/Dockerfile.worker`:** three-stage builds (`deps` → `build` → `runtime`), `node:22-slim` pinned as a literal `FROM` (never derived from `.nvmrc`, which pins Node 26 and is documented elsewhere in this repo to hang the drizzle-kit CLI), exec-form `CMD ["node", ...]` (never an npm wrapper, so `SIGTERM` reaches the process directly — load-bearing for plan 14-04's derived stop-grace-period), the built-in non-root `node` user. The api image additionally carries `packages/db/migrations` and `scripts/migrate-runner.mjs`/`scripts/env-path.mjs`; both images carry `scripts/env-path.mjs` alone is needed by the worker (its own `load-env.ts` imports it via a relative `../../../scripts/env-path.mjs` specifier, discovered while tracing exactly which files each image needs — not named in the plan's own `<read_first>` list for this reason).
- **`docker/Dockerfile.web` + `docker/Caddyfile`:** a Node 22 build stage (Vite/esbuild resolve every `@mega-crm/*` import directly at bundle time — confirmed no `import.meta.env` usage anywhere in `apps/web/src`, so no build-time API URL is needed) plus a `caddy:2` runtime stage carrying the built bundle and the routing config in one artifact. Verified via the `docker-library/docs` "Shared Tags" listing that `caddy:2` resolves to the **Alpine**-based image (not Debian) before writing the non-root user setup — BusyBox `adduser`/`addgroup` syntax, and no `setcap` step, because the base image's own upstream Dockerfile already grants `/usr/bin/caddy` `CAP_NET_BIND_SERVICE`. The Caddyfile enumerates all five server-side paths (`/api/*`, `/webhooks/*`, `/unsubscribe/*`, `/healthz`, `/readyz`) each proxying to `api:4000` with the request body streamed through unparsed, plus a `/assets/*` long-cache block (Vite's actual default output layout, confirmed by running the real build) and a catch-all SPA `handle {}` block that explicitly sets `Cache-Control: no-cache` covering **both** a direct `index.html` request and the `try_files` SPA fallback — closing the gap a path-based header matcher would have left open.
- **`.github/workflows/images.yml`:** a new workflow (deliberately separate from `ci.yml`), matrix over `api`/`web`/`worker`, exactly one tag per image (the full `github.sha`, never `latest`), every third-party action SHA-pinned by resolving fresh via `gh api repos/<owner>/<repo>/git/refs/tags/<tag>` at implementation time (`actions/checkout` v7, `docker/setup-buildx-action` v4, `docker/login-action` v4, `docker/build-push-action` v7). The quality-gate claim in the header comment is backed by a live `gh api repos/:owner/:repo/branches/master/protection` call confirming this repository's branch protection already requires the `static`/`test`/`failure-injection` checks with `enforce_admins`/`strict` enabled — not assumed, and not the `workflow_run` alternative. Also fixed a case-sensitivity bug the plan's own research skeleton would have shipped as-is: `${{ github.repository }}` preserves this repository's actual owner casing (which contains an uppercase letter), producing an invalid GHCR reference if used directly — computed a lowercase image base via a shell step instead (GitHub Actions expressions have no built-in lowercase function).

## Task Commits

1. **Task 1: The two Node images — api (with migrations) and worker** — `f16b9c5` (feat)
2. **Task 2: The web image — SPA bundle plus Caddy in one artifact** — `9a50260` (feat)
3. **Task 3: Build and push all three images to GHCR, tagged by SHA** — `e0fa460` (feat)

_No separate plan-metadata commit — SUMMARY.md is committed directly per this worktree's repo-specific rules (`.planning/` is gitignored here)._

## Files Created/Modified

- `docker/Dockerfile.api` — multi-stage api image (Node 22, migrations + migrate-runner + env-path, non-root, exec-form CMD)
- `docker/Dockerfile.worker` — multi-stage worker image (Node 22, env-path, non-root, exec-form CMD)
- `docker/patch-workspace-mains.mjs` — the build-only compile-and-patch script both images run
- `docker/Dockerfile.web` — Vite build stage + caddy:2 (Alpine) runtime stage, one self-contained artifact
- `docker/Caddyfile` — five explicit server-side handle blocks + SPA fallback + cache policy
- `.dockerignore` — node_modules/dist/.git/.planning/coverage/every env-file pattern
- `.github/workflows/images.yml` — matrix build-and-push to GHCR, SHA-tagged, SHA-pinned actions
- `docs/runbooks/container-images.md` — the three images, the compile-and-patch mechanism, tag scheme, and exactly what was verified locally vs. deferred to CI

## Decisions Made

See `key-decisions` in frontmatter for full rationale on each. Summary:
- **Compile-and-patch confined entirely to the image build** — no git-tracked source (no `packages/*/tsconfig.json`, no `packages/*/package.json`) was ever modified; every patch happens to a copy inside the Docker build stage, verified by restoring the real worktree after the local rehearsal and confirming `git status --short` was clean before committing.
- **Uniform `exports` patch across all 10 packages**, not just the ones a repo-wide grep found a current deep-import consumer for.
- **`caddy:2` is the Alpine variant** — verified via `docker-library/docs`, not assumed to be Debian-based (which would have made the originally-drafted `apt-get`/GNU-`adduser` commands fail outright).
- **Images.yml's quality gate is existing branch protection**, confirmed via a live `gh api` call, not the `workflow_run` alternative.
- **Lowercase GHCR image base computed explicitly** rather than trusting `${{ github.repository }}`'s casing.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue, file outside `files_modified`] `docker/patch-workspace-mains.mjs` did not exist in the plan's declared file list**
- **Found during:** Task 1, while designing how to make `apps/api`/`apps/worker`'s compiled `dist/server.js` actually resolve every shared workspace package under plain `node` (the plan's own "most likely single failure" risk).
- **Issue:** The plan's `files_modified` for this task lists only `docker/Dockerfile.api`, `docker/Dockerfile.worker`, `.dockerignore`. Solving the resolution problem "generally," as the plan's own action text and this worktree's repo-specific rule #6 both require, needs non-trivial JSON-manipulation logic (compiling 10 packages with a generated per-package tsconfig, then rewriting each `package.json`'s `main`/`types`/`exports`) that does not fit cleanly as inline shell in a Dockerfile `RUN` line without becoming unreadable and unreviewable.
- **Fix:** Added `docker/patch-workspace-mains.mjs` as a new, small, single-purpose script, invoked from both Dockerfiles via `RUN node docker/patch-workspace-mains.mjs`. Directly required for the plan's own stated acceptance criterion ("api and worker images build from a clean checkout... run as a non-root user, exec node directly... and the api image's `/readyz` provably flips 503 to 200 when the runner is executed from inside it") — without it, `node apps/api/dist/server.js` fails at the very first `@mega-crm/db` import.
- **Files modified:** `docker/patch-workspace-mains.mjs` (created), referenced from `docker/Dockerfile.api` and `docker/Dockerfile.worker`.
- **Verification:** Full local rehearsal (compile all 10 packages via the real script against the real worktree, patch, boot the compiled `apps/api/dist/server.js`, hit `/readyz` before and after `migrate-runner.mjs`, restore the worktree) — see Accomplishments and the `coverage` D1 entry above.
- **Committed in:** `f16b9c5` (Task 1 commit)

**2. [Rule 1 - Bug, found during design] `tsc`'s auto-inferred `rootDir` silently widens when a package's own tests import a sibling `scripts/` file**
- **Found during:** Task 1, first attempt at compiling `packages/db` with `--noEmit false --outDir dist` and no explicit `--rootDir`.
- **Issue:** `packages/db/src/__tests__/*.test.ts` files import `packages/db/scripts/*.ts` operator CLIs (e.g. `count-member-duplicates.ts`) to test them. Once those files are pulled into the compile graph, `tsc`'s rootDir auto-inference (no explicit `rootDir` was set) computed the common ancestor of ALL files it ended up compiling — `packages/db` itself, not `packages/db/src` — and nested every output path under an extra `src/`/`scripts/` prefix (`dist/src/pool.js` instead of `dist/pool.js`). This silently broke every downstream `@mega-crm/db/src/<leaf>.js` deep-import resolution.
- **Fix:** `docker/patch-workspace-mains.mjs` generates a `tsconfig.build.json` per package with an explicit `rootDir: "src"` and `exclude: ["src/**/__tests__/**", "src/**/*.test.ts"]`, deleted immediately after each compile.
- **Verification:** Reproduced the broken nested-path failure directly (a repo-wide import-resolution rehearsal script showed every `@mega-crm/db/*` deep import failing with `Cannot find module .../dist/pool.js`), then re-ran with the fix and confirmed all 21 checked import specifiers across all 10 packages resolved cleanly.
- **Committed in:** `f16b9c5` (Task 1 commit)

---

**Total deviations:** 2 (1 Rule 3 necessary-file addition outside the plan's declared list, 1 Rule 1 bug found and fixed while building the Rule 3 fix). Both were required for the plan's own explicit acceptance criteria to be satisfiable at all — no scope creep beyond what OPS-01 and this plan's own `<action>` text required.

## Issues Encountered

- **`apps/api/src/load-env.ts` and `apps/worker/src/load-env.ts` both import `scripts/env-path.mjs` via a relative `../../../scripts/env-path.mjs` specifier** — not named in the plan's own `<read_first>` list for either task, discovered by tracing every relative import that escapes each app's own `src/` directory. This means BOTH images (not just api) need `scripts/env-path.mjs` copied in at the exact same repo-root-relative path, which is also why `WORKDIR /app` and the unflattened `apps/`+`packages/`+`scripts/` tree layout inside the image is load-bearing, not a style choice.
- **`packages/db/src/migration-journal.ts`'s own header comment is now stale** ("packages/db ships no compiled `dist/`... this file is read as source everywhere it runs") — true when plan 14-01 wrote it, no longer true after this plan's compile-and-patch step. `DRIZZLE_MIGRATIONS_FOLDER`'s resolution (`path.resolve(import.meta.dirname, "../migrations")`) still works correctly either way (both `src/` and `dist/` sit one level below `packages/db`, next to `migrations/`) — confirmed by the local rehearsal, not just reasoned about — but the comment's wording should be corrected in a future doc-only pass. Not fixed here: `packages/db/src/migration-journal.ts` is not in this plan's `files_modified`.
- **No Docker daemon, no local `caddy` binary in this sandbox** (confirmed by the prior executor per this worktree's repo-specific rules) — every assertion that genuinely requires either was deferred to CI/a human, with the exact command recorded in `docs/runbooks/container-images.md` and in this SUMMARY's `coverage` block's `human_judgment: true` entries (D1, D2, D3). Everything that could be proven without them (the compile-and-patch mechanism's correctness, the api boot + `/readyz` 503→200 flow, `apps/web`'s real build output layout, every base-image tag's existence, every pinned action SHA's freshness, the branch-protection evidence) was proven directly, not assumed.

## User Setup Required

None — no external service configuration required. `SITE_ADDRESS` (the Caddyfile's environment placeholder) is an operator-supplied value plan 14-08/14-09 will wire at deploy time, not a secret; no new env var is required to exist yet for this plan's own work to be correct.

## Next Phase Readiness

- **Plan 14-08 (production compose)** consumes: the three image names (`ghcr.io/<owner>/<repo>/{api,web,worker}`), the SHA tag scheme, `docker/Dockerfile.{api,worker,web}`, `docker/Caddyfile`'s `{$SITE_ADDRESS}` placeholder (must be supplied via the compose file's `environment:`), and the worker's `WORKER_HEALTH_HOST=127.0.0.1`/`WORKER_HEALTH_PORT=4100` contract from plan 14-04 (never published via `ports:` — this plan's `Dockerfile.worker` documents that in its own `EXPOSE 4100` comment but does not itself configure compose).
- **Plan 14-09 (deploy script)** consumes: `docs/runbooks/container-images.md`'s "finding the SHA currently deployed" section, and the fact that a rollback is genuinely "redeploy the previous SHA, no rebuild" for all three images including `web` (the SPA and its Caddy config are one artifact, never a host-mounted volume).
- **Plan 14-13 (SPECIFICATION.md filing)** needs, per this worktree's deferred-filing rule:
  - **§2 (Зависимости и версии):** no new npm package — `docker/patch-workspace-mains.mjs` uses only Node built-ins plus the already-installed `typescript` devDependency (via `npx tsc`).
  - **§5 (Планировщик и пайплайн отправки) / deploy:** first Dockerfiles this repository has ever had (`docker/Dockerfile.{api,worker,web}`); first CI image-publish workflow (`.github/workflows/images.yml`); base images `node:22-slim` and `caddy:2` (Alpine-based) — exact digests were not pinned (tag-only, per this plan's own D-03/OPS-01 scope; digest pinning was not required by the plan and was not added).
  - **§6 (Публичные точки входа):** no new HTTP route — `docker/Caddyfile` only re-routes existing routes (`/api/*`, `/webhooks/*`, `/unsubscribe/*`, `/healthz`, `/readyz`) at the reverse-proxy layer.
  - **§8 (Расхождения):** none identified against the Technology Stack doc — Caddy (D-02) and GHCR (D-03) were already the documented decisions; this plan is their first concrete implementation, not a new choice.
- **Still open / explicitly deferred (see `human_judgment` entries in `coverage` above and `docs/runbooks/container-images.md`'s own "What this plan verified without Docker" section):**
  1. A real `docker build` of all three images from a clean checkout, on a machine with a Docker daemon.
  2. The web image's stub-upstream routing proof (byte-identical webhook body passthrough, SPA fallback).
  3. `images.yml`'s first real push to GHCR after this plan merges — `gh run watch` on that push is the exact confirmation command.

## Self-Check: PASSED

All 8 created files confirmed present on disk: `docker/Dockerfile.api`, `docker/Dockerfile.worker`, `docker/Dockerfile.web`, `docker/Caddyfile`, `docker/patch-workspace-mains.mjs`, `.dockerignore`, `.github/workflows/images.yml`, `docs/runbooks/container-images.md`. All three task commit hashes confirmed present via `git log --oneline -5`: `f16b9c5`, `9a50260`, `e0fa460`. `git status --short` is clean (no leftover rehearsal artifacts — the 10 patched `package.json` files and every generated `dist/`/`tsconfig.build.json` from the local rehearsal were restored/removed before this file was written).

---
*Phase: 14-deployment-database-durability*
*Completed: 2026-08-13*
