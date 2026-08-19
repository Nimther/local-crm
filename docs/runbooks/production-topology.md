# Production Topology Runbook

Implements requirements **OPS-01**, **OPS-02**, **DB-13** and decisions
**D-01**, **D-09**, **D-10** (`.planning/phases/14-deployment-database-durability/14-CONTEXT.md`).
This is a reference for `docker/docker-compose.prod.yml` itself — how the six
services fit together, where every secret and sizing value comes from, and
how to change a sizing value safely. **Deploy and rollback procedures belong
to plan 14-09's own runbook** — this file is cross-referenced from there,
not duplicated into it.

## The six services

| Service | Image | Purpose | Published ports |
|---|---|---|---|
| `db` | `postgres:17` | Primary datastore, TLS-serving (DB-13), role bootstrap on first boot | none |
| `redis` | `redis:7` | BullMQ queue backend, same durability config as development (Phase 8, WRK-12) | none |
| `api` | `ghcr.io/<owner>/<repo>/api:<sha>` | Fastify HTTP API | none |
| `worker` | `ghcr.io/<owner>/<repo>/worker:<sha>` | BullMQ workers (triggered + broadcast sends, partition maintenance, dead-letter) | none |
| `web` | `ghcr.io/<owner>/<repo>/web:<sha>` | Caddy: SPA bundle + reverse proxy | **80, 443** |
| `migrate` | `ghcr.io/<owner>/<repo>/api:<sha>` (same image as `api`, different command) | One-shot migration runner (`node scripts/migrate-runner.mjs`), never a long-lived container | none |

## Why only `web` publishes a port

`web` (Caddy) is the **only** service with a `ports:` mapping, and it maps
exactly `80` and `443` — 80 because Caddy's ACME client needs the HTTP-01
challenge path, 443 because that is the served site. Every other service is
reachable **only** on the compose network:

- `db`/`redis` have no legitimate reason to be reachable from outside the
  compose network at all — publishing either would expose an
  unauthenticated data store to the internet (T-14-43).
- `api`'s HTTP port and `worker`'s health port (`127.0.0.1:4100`, plan 14-04,
  D-14) are reached by Caddy and by Docker's own container healthcheck
  respectively, both from **inside** the container/network namespace — never
  from the host. Publishing `worker`'s health port specifically would expose
  an unauthenticated liveness/readiness probe endpoint publicly.

`scripts/validate-prod-compose.mjs`'s CI gate asserts this invariant on every
change: any service other than `web` declaring a `ports:` mapping fails the
gate.

## Where secrets come from

Every genuine secret — Postgres role passwords, the SendGrid API key, the
Better Auth secret, the KMS key ID, database DSNs — is read from
`${MEGA_CRM_ENV_FILE}`, the operator's own **externally-resolved** env file
(a path outside any git working tree, e.g. `/etc/mega-crm/production.env` on
the VPS). This is the exact convention every secret in this project has
followed since Phase 8 (`scripts/env-path.mjs`) — a file holding real
platform secrets sitting inside a git working tree is readable by every
tool, script, editor extension and agent operating on that checkout, and
being gitignored does not change that.

`docker/prod.env.example` documents **every** variable
`docker-compose.prod.yml` and the applications require, each with a comment
saying what it is and where its real value comes from — but it is
documentation, not configuration, and carries **no real value** for any
genuine secret. The two exceptions are non-secret operational tuning knobs
(memory limits, connection/buffer sizing, the stop-grace-period placeholder)
and the `IMAGE_TAG`/`SITE_ADDRESS`/`GHCR_IMAGE_BASE` deploy-identity
variables, which are shown with real (or placeholder-shaped, non-credential)
values so that `docker compose ... --env-file docker/prod.env.example
config` resolves cleanly for local/CI validation without a real secrets file
existing.

`docker-compose.prod.yml`'s `env_file:` entries for `api`/`worker`/`migrate`
use the long-form `path: ${MEGA_CRM_ENV_FILE}` / `required: false` syntax
**deliberately** — `required: false` is what lets this example file (and any
CI run using it) resolve without a real file at that path existing; at a
real deploy, the path **must** exist and be readable, or those three
containers start with none of their application secrets.

## Sizing (the checkpoint decision and its arithmetic)

This plan's own execution hit a blocking `checkpoint:decision`: no VPS had
been provisioned yet, so no artifact in the repository knew the host's RAM.
The **`parameterize-with-minimum`** option was selected: every sizing value
below is an environment variable with a conservative default (never a
hardcoded literal in `docker-compose.prod.yml` itself), and this section
records both the derivation and a defensible minimum viable VPS size.

**This is a real risk, stated explicitly rather than left implicit: a
default that is never revisited becomes the production value by omission.**
Every number below is a starting point for a host that does not exist yet,
not a measured fact about a real deployment. Revisit every one of them once
the real VPS is provisioned — see "Revisit triggers" at the end of this
section.

### Per-container memory limits (`mem_limit`)

| Service | Default | Why |
|---|---|---|
| `db` (`DB_MEM_LIMIT`) | `2048m` | Sized against `PG_MAX_CONNECTIONS`'s own default (200) at a conservative ~10MB/connection overhead budget, plus headroom for `shared_buffers` (below) and OS page cache Postgres relies on beyond `shared_buffers`. |
| `redis` (`REDIS_MEM_LIMIT`) | `768m` | `docker/redis.conf`'s own `maxmemory 512mb` (a fixed, non-parameterized dev/prod-shared ceiling — see that file's own comment: sizing it against the production VPS is explicitly Phase 15's concern, not this plan's) plus headroom for Redis's own process overhead above its data ceiling. **The container limit must always exceed the in-Redis `maxmemory` ceiling**, or the container gets OOM-killed before Redis's own eviction/refusal policy ever engages. |
| `api` (`API_MEM_LIMIT`) | `512m` | A single Fastify process's ordinary heap footprint under this workload; no in-process cache of unbounded size exists in this codebase. |
| `worker` (`WORKER_MEM_LIMIT`) | `1024m` | Twenty registered BullMQ `Worker` instances in one process (per-tenant fairness, partition maintenance, dead-letter) — more headroom than `api` for concurrent job-processing memory, still well under `db`'s allocation. |
| `web` (`WEB_MEM_LIMIT`) | `256m` | Caddy serving a static SPA bundle plus reverse-proxying — the lightest footprint of the six. |
| `migrate` (`MIGRATE_MEM_LIMIT`) | `512m` | Same image as `api`, but running only `scripts/migrate-runner.mjs` — a single dedicated `pg.Client` and drizzle's migrator, briefly, never concurrently with itself. |

### Postgres connection/buffer sizing

- **`PG_MAX_CONNECTIONS` (default `200`).** The floor is **84** — plan
  14-03's `PG_POOL_SIZES` summed total for one instance each of `apps/api`
  and `apps/worker` (see `14-03-SUMMARY.md`'s own table). `200` is not merely
  "above 84" — it leaves headroom for two things the single-instance sum
  does not account for: (1) the deploy script (plan 14-09) may briefly run
  both the old and new containers during a rolling restart, which would
  transiently **double** the steady-state connection demand toward ~168;
  (2) a handful of `packages/db/scripts` operator CLIs (each
  `PG_POOL_DEFAULT_MAX=2`) run concurrently with the live system during
  routine operations. `200` comfortably covers `168 + superuser_reserved(3)
  + migrate's own connection(1) + several concurrent operator scripts`.
  `scripts/validate-prod-compose.mjs`'s CI gate fails if this value ever
  resolves to `84` or below — **strictly greater than**, never merely equal.
- **`PG_SHARED_BUFFERS` (default `512MB`).** ~25% of `DB_MEM_LIMIT`'s own
  default (`2048m`) — the standard Postgres tuning guideline for a
  single-instance deployment with no separate pgBouncer/connection-pooler
  memory budget to account for (D-09 defers pgBouncer). **Keep this
  proportional to `DB_MEM_LIMIT` if that value changes** — a `shared_buffers`
  left at an old, disproportionate value after a memory-limit change is
  exactly the kind of drift this runbook exists to call out explicitly.

### `oom_score_adj` (Pitfall 19)

`db` carries `DB_OOM_SCORE_ADJ=-500` (negative — favors survival); `api` and
`worker` carry no `oom_score_adj` at all (the kernel default, `0`). **Both
halves are required, and neither works alone**: an unset `mem_limit` means a
container can exhaust host RAM long before the kernel ever compares
`oom_score_adj` values between processes, so the score adjustment on `db`
would achieve nothing without every service's `mem_limit` also being set.
`-500` (not `-1000`) is a deliberate middle ground: `-1000` means "never
kill," which risks a genuinely leaking Postgres process freezing the whole
host with nothing left for the kernel's OOM killer to reap; `-500` (the same
value `dockerd` itself runs at, per community operational writeups) still
strongly favors Postgres's survival without disabling the safety valve
entirely. `scripts/validate-prod-compose.mjs`'s CI gate fails if `db`'s
`oom_score_adj` is absent or non-negative, or if `api`/`worker` ever carries
a negative one.

### Minimum viable VPS — the arithmetic

Summing every service's steady-state default `mem_limit` (the five
always-running services; `migrate` is one-shot and profile-excluded, but its
own limit briefly coexists with the others during a deploy window):

```
db      2048 MiB
redis    768 MiB
api      512 MiB
worker  1024 MiB
web      256 MiB
--------------------
steady-state sum   4608 MiB  (~4.5 GiB)

+ migrate's transient peak (512 MiB, briefly alongside the others
  during a deploy) = 5120 MiB (~5.0 GiB) worst-case committed limit
```

Postgres benefits heavily from OS page cache beyond `shared_buffers`, the
host's own kernel/services need RAM the container limits above do not
account for, and a host running exactly at its committed sum has zero burst
capacity for a load spike. Applying a conservative ~40% headroom above the
worst-case committed sum (`5120 / 0.6 ≈ 8533 MiB`) and rounding to a clean
provider tier:

**Minimum viable VPS: 8 GB RAM, 2 vCPU.** 4 vCPU is recommended, not just
the floor — concurrent Postgres query execution, Node's event loop under
load, and Caddy's TLS termination all benefit from more than 2 cores; 2 is
the arithmetic floor this derivation supports, not a comfortable target.

### Revisit triggers

Every default above is a starting point, not a measured fact. Revisit them
when:

- **The real VPS is provisioned.** Re-derive `DB_MEM_LIMIT`/`shared_buffers`
  from the ACTUAL RAM, not this section's assumed minimum — if the real host
  has more than 8 GB, there is real headroom to raise every limit
  proportionally, not just `db`'s.
- **D-09 (PgBouncer deferral) is revisited** — the deferral was justified on
  `PG_MAX_CONNECTIONS` headroom above the pool-sum floor being a *configured
  fact* (this plan's own contribution), not merely an assumption. If real
  connection-count pressure is observed (via Postgres's own
  `pg_stat_activity`), that is the signal to revisit, not a fixed calendar
  date.
- **D-10 (self-signed TLS / `verify-full` deferral) is revisited** — see
  "TLS posture" below.
- **`SENDGRID_TIMEOUT_MS`/`CLAIM_TX_MARGIN_MS`/`RECORD_TX_MARGIN_MS` change**
  — `WORKER_STOP_GRACE_PERIOD_SECONDS` is never hand-typed (see below), so
  this one self-corrects; it is listed here only so an operator knows why the
  deploy script's printed number might change between deploys.

## The worker's stop-grace-period

`ARCHITECTURE.md` §10 states the container's stop-grace-period **MUST** be
set from `apps/worker/src/shutdown-budget.ts`'s published constant, never a
runtime default or a hand-typed literal — Docker's own unconfigured default
(10s) is already shorter than the SendGrid call timeout alone, before either
transaction margin is added (Pitfall 7).
`docker-compose.prod.yml`'s `worker.stop_grace_period` is therefore always
`${WORKER_STOP_GRACE_PERIOD_SECONDS}s` — an interpolated variable, never a
number written into the YAML. The deploy script (plan 14-09) sets this
variable, every time, from:

```bash
npm run build -w apps/worker && node scripts/print-stop-grace-period.mjs
```

`scripts/validate-prod-compose.mjs`'s CI gate re-runs that exact command on
every invocation and fails if the compose file's resolved value ever
disagrees with it — this is the single strictest invariant the gate checks,
because a hand-typed value that silently drifts from the constant after a
future change to `SENDGRID_TIMEOUT_MS` is exactly the failure mode Pitfall 7
describes: the symptom appears months later as ambiguous sends after a
routine deploy, with nothing in the compose file itself hinting at why.

## TLS posture (DB-13, D-10)

`docker/postgres/prod-tls-entrypoint.sh` generates a self-signed certificate
on first boot (into the dedicated `mega_crm_db_certs_prod` volume, never the
data directory) and serves Postgres with `ssl=on`. Every application DSN in
the operator's env file must carry `sslmode=require&uselibpqcompat=true` —
**not** `sslmode=require` alone. Plan 14-03's own finding, verified against
the installed `pg-connection-string@2.14.0` source rather than assumed from
libpq documentation: a bare `sslmode=require` aliases to `verify-full`
(full certificate-chain validation against the system trust store) on this
codebase's installed driver version, and **fails the handshake outright**
against a self-signed certificate.

**This self-signed posture is D-10's recorded interim step, not the final
state.** The revisit trigger: move to `verify-full` (a real CA-issued
certificate, or an operator-managed CA the DSN trusts explicitly) once
Postgres has a real network path worth defending against (e.g. if `db` is
ever moved off the single VPS this topology assumes — see the
`<reversibility>` note on plan 14-08's own compose-authoring task; moving
Postgres off-host re-opens this exact question).

## Sharing versus splitting the dev/prod TLS entrypoint scripts

`docker/postgres/prod-tls-entrypoint.sh` is a **separate** script from
`docker/pg-tls-entrypoint.sh` (the dev/CI entrypoint plan 14-03 wrote), not a
shared script with an environment branch. The TLS certificate-generation
mechanism is identical between the two (self-signed cert into a dedicated
volume, `chown`/`chmod` the key, exec `docker-entrypoint.sh postgres -c
ssl=on ...`) — the difference is that the production script ALSO owns the
`max_connections`/`shared_buffers` `-c` overrides this plan's checkpoint
decision requires, which have nothing to do with dev/CI's fixed-defaults
posture (`docker/redis.conf`'s own comment makes the identical call for
Redis: "sizing it against the production VPS belongs to Phase 15... is
deliberately NOT parameterized" for dev). Two small, independently
reviewable scripts — one dev, one production — carry less drift risk here
than one script with a runtime branch: the production posture (the one that
matters during an incident) stays reviewable on its own, without reasoning
through a dev-only branch to find it.

## The `migrate` service

`migrate` runs the **same `api` image**, with a different `command`
(`node scripts/migrate-runner.mjs`, i.e. `npm run migrate:prod` — plan
14-01) and no build of its own. It carries the `manual` compose
[profile](https://docs.docker.com/compose/how-tos/profiles/) — no other
service declares that profile, so a plain `docker compose up` never starts
it. The deploy script (plan 14-09) invokes it explicitly:

```bash
docker compose -f docker/docker-compose.prod.yml run --rm --no-deps migrate
```

`docker compose run` targets a named service **regardless of its profile
activation**, which is exactly the mechanism this depends on. This is
deliberate, not an oversight: RESEARCH.md's own Pitfall C documents that
`depends_on: { condition: service_completed_successfully }` on a one-shot
container is a documented-buggy Compose behavior that can re-run a completed
container on a later `up`. Never add that condition anywhere referencing
`migrate` — the deploy script's own exit-code check (plus plan 14-01's
`pg_try_advisory_lock` as the defense of last resort, not the primary
mechanism) is the correct, safe sequencing.

## Changing a sizing value safely

1. Edit the value in the operator's own `MEGA_CRM_ENV_FILE` (never
   `docker/prod.env.example`, which is documentation only).
2. Re-run `npm run verify:prod-compose` locally against the real file
   (`docker/validate-prod-compose.mjs` accepts the default paths; point a
   copy of the real env file at `docker/prod.env.example`'s path temporarily
   if validating a real value, or extend the script's `envFileRel` option).
3. If raising `DB_MEM_LIMIT`, raise `PG_SHARED_BUFFERS` proportionally (see
   "Postgres connection/buffer sizing" above) — the CI gate does not itself
   assert this proportionality, only that `shared_buffers` resolves to a
   valid value; keeping the two in step is a review discipline, not a
   machine-checked one, and is worth revisiting as a future gate addition if
   this ever drifts in practice.
4. Deploy normally (plan 14-09) — the new value takes effect on the next
   `docker compose up`, no image rebuild required.

## Related runbooks

- `docs/runbooks/container-images.md` — the three images this compose file
  references, their build mechanism, and the SHA tag scheme.
- Plan 14-09's own runbook (deploy/rollback procedures) — not yet written at
  the time this file was authored; cross-reference forward once it exists.

## File-backed production KEK boundary

The DigitalOcean single-VPS deployment uses `KMS_PROVIDER=file`. The
base64-encoded 32-byte KEK lives at `/etc/mega-crm/kek` as a root-owned
regular file with numeric group `1999` and exact mode `0440`. Compose binds
it read-only at `/run/secrets/mega-crm-kek` and adds group 1999 to **api and
worker only**. Both images remain `USER node`; `migrate`, db, redis, web,
pgBackRest, and Alloy receive neither the mount nor the group.

This protects tenant SendGrid keys from a **database-only compromise**:
the database contains ciphertext and a wrapped DEK, not the KEK. It does
not protect against full VPS/root compromise or compromise of an api/worker
process, all of which can read the mounted KEK. That residual risk is an
explicit property of this single-host design.
