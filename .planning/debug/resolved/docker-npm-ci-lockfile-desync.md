# Debug: Docker npm ci lockfile desync (G-14-4)

**Status:** root cause found
**Phase:** 14-deployment-database-durability
**Gap:** G-14-4 — Docker builds of api/worker/web fail at root `npm ci` (EUSAGE, lockfile out of sync)
**Investigated:** 2026-08-13 (gsd-debugger, isolated worktree at 02de23f)

## Symptoms

- `docker build -f docker/Dockerfile.api …` (and worker/web) fails: `npm ci` exits EUSAGE, "package.json and package-lock.json are out of sync: Missing: esbuild@0.28.2 from lock file" plus 26 `@esbuild/<platform>@0.28.2` entries.
- Local `npm ls esbuild --all` reports esbuild@0.25.12 invalid for vite's `^0.27.0 || ^0.28.0`.
- Local dev and CI (`npm ci`) are green.

## Root Cause

A two-condition AND — no manifest was edited without a lockfile regen; the lockfile has carried a latent npm-version-dependent inconsistency since day 1, and Phase 14 introduced the first consumer that trips on it.

1. **package-lock.json is npm-11-shaped.** vite 8.1.3 (pinned in `apps/web/package.json` since commit `cec5281`, 2026-07-03, phase 1) declares esbuild `^0.27.0 || ^0.28.0` as an *optional peer dependency* (vite 8 is Rolldown-based; esbuild demoted from regular dep). The only esbuild visible to vite in the lockfile is the hoisted `node_modules/esbuild@0.25.12` — placed there for drizzle-kit@0.31.10's `esbuild ^0.25.4` (in the lockfile since `0445177`, 2026-07-03). npm 11 (dev + CI, Node 26 per `.nvmrc`) tolerates the invalid-but-optional peer, so every gate passed; `npm ls esbuild --all` merely flags 0.25.12 "invalid".
2. **Phase 14's Dockerfiles deliberately pin `FROM node:22-slim`** (14-06, to dodge the drizzle-kit hang under Node 26), whose bundled **npm 10** builds an ideal tree that *includes* esbuild@0.28.2 + its 26 `@esbuild/*` platform packages (repair of the invalid optional peer, resolving registry-latest of `^0.27||^0.28`). Those entries are missing from the lockfile → `npm ci` aborts with EUSAGE. npm 11's ideal tree does not include them → exit 0.

There is no "desync-introducing commit" during phase 14 — the defect surfaced at UAT because the Docker build is the first-ever npm-10 consumer, and no pre-merge gate exercises npm 10 (`ci.yml` uses `.nvmrc` → npm 11; `images.yml` triggers only on master push).

## Evidence

- **Deterministic differential repro on the byte-identical lockfile:** `npx npm@10.9.4 ci --dry-run` → exit 1, EUSAGE, `Missing: esbuild@0.28.2 from lock file` + exactly 26 `@esbuild/<platform>@0.28.2` (all 27 Missing lines are esbuild-family, nothing else) — byte-alike to the user's Docker error. `npm ci --dry-run` under npm 11.12.1 → exit 0.
- **Lockfile graph read directly:** hoisted `node_modules/esbuild` = 0.25.12 (drizzle-kit `^0.25.4`); `node_modules/tsx/node_modules/esbuild` = 0.28.1 (tsx `~0.28.0`); `apps/web/node_modules/vite` = 8.1.3 and `node_modules/vitest/node_modules/vite` = 8.1.3, both with peer `esbuild ^0.27.0 || ^0.28.0` marked `optional: true`. No 0.27/0.28-range esbuild visible to vite; no esbuild@0.28.2 anywhere. **No package.json in any of the 15 workspaces declares esbuild at all** — purely transitive, eliminating "manifest edited without lockfile regen".
- **Fix direction verified in the disposable worktree, then reverted:** `npx npm@10.9.4 install --package-lock-only` exit 0; diff purely additive — adds `node_modules/vitest/node_modules/esbuild@0.28.2` + 26 platform packages, zero removals/version churn elsewhere. After regen, **both** npm 10.9.4 and npm 11.12.1 `ci --dry-run` exit 0.

## Files Involved

- `package-lock.json`: npm-11-shaped — lacks any vite-compatible (0.27/0.28) esbuild entry that npm 10's ideal tree requires; the file to regenerate.
- `docker/Dockerfile.api`, `docker/Dockerfile.worker`, `docker/Dockerfile.web`: pin `node:22-slim` (npm 10) and run root `npm ci` (Dockerfile.api line 36) — the only npm-10 consumers; the pin is intentional and correct per its own header comment (drizzle-kit hangs under Node 26), not the thing to change.
- `.nvmrc` (=26), `.github/workflows/ci.yml` (all 4 jobs `npm ci` via setup-node/.nvmrc), `.github/workflows/images.yml` (master-push-only): why no gate caught it pre-merge.

## Suggested Fix Direction

Regenerate the lockfile under npm 10 — `npx npm@10 install --package-lock-only` (or regen inside node:22) — a verified purely-additive change accepted by both npm majors. **The recurrence guard is part of the fix, not optional:** npm 11's ideal tree doesn't require the added entries, so any routine `npm install <pkg>` under dev/CI npm 11 can silently drop them and reintroduce the failure post-merge — add a pre-merge CI step running `npm ci --dry-run` under the same node:22 image the Dockerfiles use (or `npx npm@10`). Acceptance test should be at least one end-to-end Docker image build, which also exercises the npm-10 `npm prune --omit=dev` step (Dockerfile.api line 64), not `ci --dry-run` alone.

Caveats: npm 10.9.4-via-npx is a same-major proxy for node:22-slim's bundled npm (error signature matched byte-alike); "0.28.2" is registry-latest at regen time — a future regen pinning 0.28.3+ is expected and fine.
