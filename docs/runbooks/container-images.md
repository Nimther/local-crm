# Container Images Runbook

Implements requirement **OPS-01** and decision **D-03** (`.planning/phases/14-deployment-database-durability/14-CONTEXT.md`).
This is a short reference — the deploy and rollback procedures that consume
these images belong to plan 14-09's own runbook, not this one.

## The three images

| Image | Dockerfile | Contains | Does NOT contain |
|-------|-----------|----------|-------------------|
| `api` | `docker/Dockerfile.api` | Compiled `apps/api`, every `packages/*` shared workspace it imports (compiled to `dist/`, see below), `packages/db/migrations`, `scripts/migrate-runner.mjs`, `scripts/env-path.mjs` | `apps/worker`/`apps/web` source, devDependencies, test files, any env file |
| `worker` | `docker/Dockerfile.worker` | Compiled `apps/worker`, the same shared `packages/*` workspaces, `packages/db/migrations`, `scripts/env-path.mjs` | `apps/api`/`apps/web` source, `scripts/migrate-runner.mjs`, devDependencies, test files, any env file |
| `web` | `docker/Dockerfile.web` | The built SPA bundle (`apps/web/dist`) **and** `docker/Caddyfile` in one artifact | Any server-side application code; Caddy never serves a bind-mounted volume for this bundle |

Every image pins **Node 22 LTS** (`node:22-slim`) as a literal `FROM` line —
never derived from this repo's `.nvmrc`, which pins Node 26 for dev/CI and is
documented elsewhere in this repo (STATE.md, Phase 12) as hanging the
drizzle-kit CLI. If a future change ever tries to unify the Node version
across dev and production images, re-read that note first — it is the reason
these two versions are deliberately different.

Every process in every image runs as a non-root user: the `node:22-slim`
base image's own built-in `node` user for `api`/`worker`, and a dedicated
`caddyweb` user (BusyBox `adduser`/`addgroup`, since `caddy:2` resolves to
the Alpine-based image) for `web` — the base Alpine image already grants the
`caddy` binary `CAP_NET_BIND_SERVICE`, so binding ports 80/443 needs no root.

## Why `api`/`worker` need a compile-and-patch step the `web` image does not

Every `packages/*` shared workspace ships `"main": "./src/index.ts"` with
`noEmit: true` in its own `tsconfig.json`, by design — `tsx`/`vitest` read
these packages as TypeScript source in dev and in tests, and a bundler
(`vite`, used by the `web` image) resolves `.ts` imports directly at bundle
time regardless. Plain `node`, running the API/worker's own compiled
`dist/server.js` in production, cannot: it does not remap a relative
`./foo.js` import specifier to a sibling `foo.ts` file the way `tsx`/`vitest`
do (confirmed empirically against this repo's own Node version — see
14-06-SUMMARY.md).

`docker/patch-workspace-mains.mjs` runs inside the `api`/`worker` image build
only, never against the checked-in repo: it compiles every needed
`packages/*` workspace to a real `dist/` (overriding `noEmit: true` for that
one build) and rewrites that package's `main`/`types`/`exports` to point at
`dist/` instead of `src/`, uniformly — every package gets the same
`"./src/*.js" -> "./dist/*.js"` wildcard, so any deep-import specifier of the
form `@mega-crm/<pkg>/src/<path>.js` (this repo's established convention —
e.g. `scripts/migrate-runner.mjs`, `apps/worker/src/shutdown-budget.ts`)
keeps resolving.

`packages/db/src/migration-journal.ts`'s `DRIZZLE_MIGRATIONS_FOLDER` resolves
to `../migrations` relative to wherever `migration-journal.js` is loaded
from. That resolution holds whether the file is loaded from `src/` or
`dist/` — both sit one level below `packages/db`, next to `migrations/` — so
the compile-and-patch step does not break it; the images just need to keep
`packages/db/migrations` copied in at the same sibling path.

## Tag scheme

Every image is tagged by the **full git SHA** of the commit it was built
from, and only that — never `latest`, never a branch name. This is the
entirety of OPS-03's rollback story: "redeploy the previous SHA" is only
true if a tag names exactly one immutable build. `.github/workflows/images.yml`
enforces this by construction (one tag per image, `${{ github.sha }}`), and
grep-asserts no `:latest` reference exists in the workflow file.

Image names: `ghcr.io/<owner>/<repo>/api`, `ghcr.io/<owner>/<repo>/web`,
`ghcr.io/<owner>/<repo>/worker`.

## Building an image locally

```bash
docker build -f docker/Dockerfile.api -t megacrm-api:local .
docker build -f docker/Dockerfile.worker -t megacrm-worker:local .
docker build -f docker/Dockerfile.web -t megacrm-web:local .
```

All three build from the repository root (the build context is `.`, filtered
by `.dockerignore`) — never from inside `docker/`.

## Finding the SHA currently deployed

Once plan 14-08/14-09 wire the production compose file, the SHA in use is
whatever tag the compose file's `image:` lines currently pin — `docker
compose config | grep image:` on the VPS, or `docker inspect <container> |
grep Image` for a running container, both print the full
`ghcr.io/<owner>/<repo>/<app>:<sha>` reference including the SHA.

## Verifying the api image's migration/readiness contract

This is the plan's own highest-risk claim, and it was verified as a real
process boot against a real (ephemeral) Postgres, not by reasoning about the
Dockerfile:

```bash
docker run --rm megacrm-api:local id -u                       # non-zero uid
docker run --rm megacrm-api:local sh -lc \
  'test -f scripts/migrate-runner.mjs && test -f packages/db/migrations/meta/_journal.json && echo layout-ok'
```

Then, against a reachable Postgres:

```bash
# with the container's env pointed at an UN-migrated database:
curl -s -o - -w '\n%{http_code}\n' http://<container>:4000/readyz   # expect 503, "migrations" failing
docker run --rm -e DATABASE_URL=... megacrm-api:local node scripts/migrate-runner.mjs
curl -s -o - -w '\n%{http_code}\n' http://<container>:4000/readyz   # expect 200
```

## What this plan verified without Docker (no daemon in this sandbox)

`docker build`/`docker run` could not be executed here. Everything the
Dockerfiles depend on structurally was instead proven directly against the
worktree:

- Ran `apps/api`'s own `npm run build`, then the real
  `docker/patch-workspace-mains.mjs` against the checked-in packages
  (restored afterward — see 14-06-SUMMARY.md's Self-Check), then booted the
  compiled `apps/api/dist/server.js` under plain `node` against an ephemeral
  Postgres database created and dropped for this purpose (never the shared
  dev database): `/readyz` answered `503` naming `migrations` before
  `scripts/migrate-runner.mjs` ran, and `200` immediately after, from the
  same compiled tree.
- Confirmed `apps/worker`'s own `npm run build` compiles cleanly against the
  same patched package set.
- Confirmed `node:22-slim` and `caddy:2` both currently exist and are active
  on Docker Hub, and that `caddy:2` resolves to the Alpine-based image (via
  the official `docker-library/docs` "Shared Tags" listing) — the
  `adduser`/`addgroup` invocations in `Dockerfile.web` are written for that
  distro's BusyBox applets, not Debian's, on that basis.

**Deferred to CI / a human with Docker** (`human_judgment`, matching plan
14-03's precedent for the same missing-daemon constraint):

- The actual `docker build` of all three images from a clean checkout.
- The `web` image's Caddy routing proof with a stub upstream (no local
  `caddy` binary in this sandbox either) — run:
  ```bash
  docker run -d --name stub-api -p 4000:4000 <any-http-echo-image>
  docker run --rm -e SITE_ADDRESS=:80 --link stub-api:api -p 8080:80 megacrm-web:local
  curl http://localhost:8080/api/ping            # must reach the stub, 1:1 body bytes for /webhooks/*
  curl http://localhost:8080/dashboard/anything   # must return index.html
  ```
- `.github/workflows/images.yml`'s first real push to GHCR — `gh run watch`
  on the first push to `master` after this plan merges is the exact
  verification command; see that workflow's own header comment for the
  quality-gate mechanism it relies on and the evidence recorded for it.
