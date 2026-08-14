# Deploy and Rollback Runbook

Implements requirement **OPS-02** (a reproducible, operator-invoked deploy
command) and **OPS-03** (rollback without a rebuild), and decision **D-04**
(`.planning/phases/14-deployment-database-durability/14-CONTEXT.md`): the
deploy command is reproducible; a human decides **when**. This runbook
documents `scripts/deploy.sh`, written by plan 14-09, and answers the
questions an operator actually has, in the order they have them.

## How to deploy

```bash
./scripts/deploy.sh --dry-run <sha>   # read this first, especially the first few times
./scripts/deploy.sh <sha>             # the real thing
```

`<sha>` is the **full 40-character git commit SHA** whose images
`.github/workflows/images.yml` (plan 14-06) already built and pushed to
GHCR. Find it by looking at the `master` branch's commit history and
confirming the corresponding "Build and push images" GitHub Actions run
succeeded for that commit — `docs/runbooks/container-images.md`'s own tag
scheme section has the full detail. A branch name, a short SHA, or `latest`
is rejected by the script with a message naming what was rejected: those are
mutable references, and "deploy SHA X" only means anything if X can never
resolve to a different set of bytes later.

**Deploys are operator-triggered by decision (D-04).** There is no CI step
that deploys on merge to `master` — merging only builds and pushes images
(plan 14-06); a human runs this script when they decide to. CI auto-deploy
was considered and explicitly rejected for this phase: every merge becoming
a production deploy is heavier than a single-operator project needs while
still mid-hardening. **Revisit trigger:** when deploy frequency makes the
manual step an actual bottleneck, not before.

**Read the dry run before running anything for real**, especially the first
few times, or after not having deployed in a while:

```bash
./scripts/deploy.sh --dry-run <sha>
```

It prints the exact command sequence the real run would execute, one
command per line, with no side effects — no image is pulled, no container
is touched, no file is written. Reading it confirms three properties before
they matter: the image pulls happen before the migrate step, the migrate
step happens before anything that starts or replaces `api`/`worker`/`web`,
and the sequence waits on `/readyz` rather than sleeping for a guessed
duration.

**What each stage does, in order:**

1. **Record the previous SHA.** Reads whatever SHA is currently on record
   (see "Where the previous-SHA record lives" below) before touching
   anything.
2. **Pull the three images** (`api`, `worker`, `web`) for the target SHA.
   `migrate` reuses the `api` image — nothing separate to pull for it.
3. **Resolve the worker's stop-grace-period** by building the worker and
   running `scripts/print-stop-grace-period.mjs` (plan 14-04) — never a
   hand-typed number — and exports it for Compose to interpolate.
4. **Run the one-shot migrate step**
   (`docker compose -f docker/docker-compose.prod.yml run --rm migrate`) and
   check its exit code explicitly.
5. **Bring up `web` and `api`.**
6. **Wait for `api`'s `/readyz`** to return 200, polling on a bounded
   timeout — never a fixed sleep.
7. **Replace the worker**, stop-old-then-start-new (R-05): stop the old
   container, confirm it is actually gone, start the new one, then wait for
   its own Docker health status to report healthy.
8. **Record the new SHA** and print the rollback command for this deploy.

**If the target SHA is already the one on record**, the script still pulls
(a no-op against an already-pulled image) and still runs migrate (idempotent
by construction — plan 14-01), but **skips the worker replace entirely** —
there is nothing to replace, and skipping avoids an unnecessary queue pause.
This is what makes re-running the same deploy command safe.

## What to do when a stage fails

Each stage tells you, on failure, exactly what state the system is in and
what to do next. In every case, the previously-deployed SHA is still on
record and the rollback command is printed — even though most of these
failures need no rollback at all, because nothing was replaced yet.

### Pull fails

Nothing has been touched. Either the image does not exist for that SHA (the
CI build/push for that commit may not have completed or may have failed —
check `.github/workflows/images.yml`'s run for that commit) or `docker login
ghcr.io` has expired on this host. Fix the actual cause, then re-run the
same command — safe, because nothing was replaced.

### Migrate fails

**This is the important one.** Nothing has been replaced — the previous
version is still serving traffic, and the previous schema is still what the
database has. **Do not re-run the deploy.** A migrate failure means one of:

- A genuine SQL error in the new migration (investigate the migration file
  itself, in a non-production environment first).
- The migration advisory lock (`MIGRATION_ADVISORY_LOCK_KEY = 1_405_001`,
  `scripts/migrate-runner.mjs`, plan 14-01) could not be acquired within its
  bounded retry budget — this means another migration run is, or recently
  was, holding it. Before assuming it is stuck: confirm whether the session
  holding the lock is still alive.

  ```sql
  SELECT pid, granted, query, state, query_start
  FROM pg_locks l
  JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.locktype = 'advisorylock' AND l.objid = 1405001;
  ```

  If that query returns no rows, the lock is not actually held by anyone —
  the previous holder's session already ended (`scripts/migrate-runner.mjs`
  takes the lock on a dedicated connection specifically so it dies with the
  connection, never surviving past it; see plan 14-07's own unclean-death
  scenario, which proves this directly). Re-running the deploy is then safe.
  If it DOES return a row, that is a real, live migration run — do not touch
  it; either wait for it to finish or investigate why two deploys are
  running concurrently, which should not happen under D-04's own
  one-operator-decides-when model.

### API readiness times out

`web` and `api` came up, but `api` never answered `/readyz` with 200 within
the bounded timeout. **The worker has not been replaced** — this stage
happens before the worker replace, by design. Check the new `api`
container's logs and its own `/readyz` body (which check —
postgres/redis/migrations — is failing) before doing anything else. The
previous worker is still running the previous version; there is no dispatch
inconsistency to worry about yet.

### Worker replace fails

Two distinct failure points here, both already logged with which one hit:

- **The old worker did not stop within its grace period plus margin.** The
  script aborts BEFORE starting a new one — R-05's whole point is that the
  old and new worker must never run concurrently, and this abort is that
  guarantee holding under an unexpected failure. Investigate why the old
  container would not stop cleanly (a stuck job, a hung shutdown handler)
  before trying again.
- **The new worker did not report healthy within its own timeout.** By this
  point `api` is already serving the new version and the old worker is
  already gone — there is no dispatch inconsistency, but there IS a gap in
  queue processing until this is resolved. Check the new worker's logs and
  its own readiness checks (postgres/redis/migrations) directly.

## How to roll back

```bash
./scripts/deploy.sh --rollback-to <previous-sha>
```

This is the **same command, same script, same ordering guarantees** — no
rebuild, no manual container surgery (OPS-03). Running it prints a warning
naming the migration-tier question before doing anything else, because the
script itself cannot answer that question: it has no view of the migration
list for the SHA it is rolling back to.

**The decision that comes first, before running the command above:**
consult `MIGRATION_TIERS` (`packages/db/src/migration-tiers.ts`) for every
migration that shipped between the SHA you are on and the SHA you are
rolling back to —
[`docs/runbooks/migration-rollback-and-roll-forward.md`](migration-rollback-and-roll-forward.md)
is the full decision procedure and is not restated here, so the two
documents can never drift into disagreement:

- **Every migration in that range is `auto-reversible`** → rolling back with
  this script is safe: `--rollback-to` is a redeploy, and the schema does
  not need touching first (the previous image's code and the current schema
  are only in conflict if a migration ADDED something the old code never
  used, which the auto-reversible tier's own definition already excludes as
  destructive — but read the linked runbook's own procedure before assuming
  this, since it also covers the case where the schema needs its inverse
  DDL applied first).
- **Even one migration in that range is `forward-only`** → this is **not** a
  safe redeploy. The old code may not agree with the current schema, and
  there is no DDL sequence that undoes what a forward-only migration did.
  The recovery path is a **restore**, not this script — see
  [`docs/runbooks/migration-rollback-and-roll-forward.md`](migration-rollback-and-roll-forward.md)'s
  "Forward-only recovery" section and
  [`docs/runbooks/restore-drill.md`](restore-drill.md) (plan 14-11) for the
  actual mechanics.

**This is a judgement call the operator makes with both of those documents
open** — `--rollback-to` deliberately does not attempt to determine the tier
itself and will run the same sequence regardless of which case you are in.
The warning it prints exists to stop you at that judgement call, not to make
it for you.

## Pre-deploy checklist

- The domain resolves to this VPS, with 80 and 443 open (plan 14-08's
  topology).
- `MEGA_CRM_ENV_FILE` (see `scripts/env-path.mjs`'s convention) is set **in
  the shell you are running this script from** and points at a populated,
  real secrets file. This matters distinctly from the file simply existing
  on disk: `docker compose` resolves `env_file: path: ${MEGA_CRM_ENV_FILE}`
  (`docker/docker-compose.prod.yml`) via shell-level variable substitution
  at the moment it parses the compose file, not via
  `scripts/env-path.mjs`'s own Node-only default resolution — an unexported
  variable here silently skips loading the file (the compose file's own
  `required: false` is deliberate for a different reason: letting
  `docker compose config` resolve cleanly against `docker/prod.env.example`
  in isolation — not a license to skip exporting the real file at deploy
  time).
- `GHCR_IMAGE_BASE` and `SITE_ADDRESS` are exported in that same shell.
- The images for the target SHA exist in GHCR — confirm the CI run for that
  commit succeeded (`docs/runbooks/container-images.md`).
- `docker login ghcr.io` is current on this host.
- `docker compose -f docker/docker-compose.prod.yml config` resolves cleanly
  against the real environment (catches a missing/misspelled variable
  before it becomes a failed pull or a silently-empty secret).

## Post-deploy verification

- `https://<hostname>/` loads the SPA, and the certificate is real (issued
  by Let's Encrypt, not self-signed).
- `https://<hostname>/healthz` returns 200.
- `https://<hostname>/readyz` returns 200 with all three checks
  (`postgres`/`redis`/`migrations`) passing.
- `docker compose -f docker/docker-compose.prod.yml ps` shows every
  container healthy, including the worker (whose own `/readyz` is never
  reachable from outside the container — plan 14-04, D-14 — so its Docker
  health status is the only external signal).
- The `migrate` service does **not** appear as a running/long-lived
  container in that same `ps` output — it is a one-shot step, never a
  service.
- One functional check beyond the health endpoints (e.g. a known-good login,
  or triggering a single test send) — the readiness checks prove the
  backing services are reachable, not that the specific feature you care
  about actually works end to end.

## Where the previous-SHA record lives

`scripts/deploy.sh` writes the currently-deployed SHA to a plain text file,
outside the repository working tree — the same reasoning as
`scripts/env-path.mjs`'s own `MEGA_CRM_ENV_FILE` default (a file inside the
checkout is readable by every tool, editor extension, and agent operating on
it):

```
${XDG_STATE_HOME:-$HOME/.local/state}/mega-crm/current-sha
```

Override the path entirely with `MEGA_CRM_DEPLOY_STATE_FILE` if this host
keeps state somewhere else. Read it directly (`cat` the file) to find out
what is currently deployed without needing to inspect any running
container. It is written **before** any container is replaced on every run
(even one that goes on to fail at a later stage), so it always reflects the
SHA that was actually serving traffic at the moment the current or most
recent deploy attempt began.

## Related runbooks

- `docs/runbooks/container-images.md` — the three images, the tag scheme,
  and how to find the SHA currently deployed from a running container
  directly.
- `docs/runbooks/production-topology.md` — the six-service compose
  topology this script drives.
- `docs/runbooks/migration-rollback-and-roll-forward.md` — the migration
  tier decision procedure this runbook's "How to roll back" section sends
  you to rather than restating.
- `docs/runbooks/restore-drill.md` (plan 14-11) — the forward-only tier's
  actual recovery mechanics. As of this plan, confirm in that runbook's own
  SUMMARY whether the drill has actually been performed before treating a
  restore as a rehearsed procedure rather than a documented one.
- `docs/runbooks/relocate-default-partition-rows.md` and
  `docs/runbooks/reprovision-webhook-event-types.md` — this repository's
  other operator runbooks, for format precedent.
