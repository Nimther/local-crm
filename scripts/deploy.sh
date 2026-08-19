#!/usr/bin/env bash
# Phase 14 plan 09 (D-04, OPS-02, OPS-03, R-05, T-14-52..T-14-59).
#
# The ONE operator-invoked command that deploys this platform: pulls the
# three SHA-tagged images (plan 14-06), runs docker/docker-compose.prod.yml's
# (plan 14-08) one-shot `migrate` service to completion and checks its exit
# code explicitly (RESEARCH.md Pitfall C / T-14-48 -- NEVER a `depends_on:
# { condition: service_completed_successfully }`, which Compose has been
# documented to re-trigger on a later `up`), brings up `web`+`api`, waits on
# the API's own `/readyz` (plan 14-01) rather than a timer, then replaces the
# worker stop-old-then-start-new (R-05) and confirms the NEW worker's own
# Docker health status -- never an HTTP call to its loopback-only,
# unpublished health port (plan 14-04, D-14).
#
# D-04: the command is reproducible, the human decides WHEN. There is no CI
# auto-deploy trigger anywhere in this file or in .github/workflows/*.yml --
# that was considered and rejected for now (see
# docs/runbooks/deploy-and-rollback.md's own "How to deploy" section for the
# revisit trigger).
#
# Usage:
#   scripts/deploy.sh <full-git-sha>              deploy that SHA
#   scripts/deploy.sh --dry-run <full-git-sha>    print the ordered command
#                                                  sequence, no side effects
#   scripts/deploy.sh --rollback-to <full-git-sha> deploy an OLDER SHA --
#                                                  read docs/runbooks/
#                                                  deploy-and-rollback.md's
#                                                  migration-tier decision
#                                                  FIRST; this script cannot
#                                                  determine tier itself (it
#                                                  has no view of the
#                                                  migration list for the
#                                                  target SHA)
#
# No dependencies beyond `docker` (with the `compose` plugin), `npm`/`node`
# (to resolve the worker's stop-grace-period, plan 14-04's
# scripts/print-stop-grace-period.mjs) -- all already required on any host
# that runs this repository's own tooling.

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="docker/docker-compose.prod.yml"

# A full-length, lowercase-hexadecimal git SHA only -- a mutable reference
# (a branch name, `latest`, an abbreviated SHA) would make "deploy SHA X" and
# "what is actually running" different, unverifiable facts, and would
# silently defeat OPS-03's rollback story (T-14-52). GitHub's own
# `${{ github.sha }}` (.github/workflows/images.yml, plan 14-06's tag
# scheme) is always the full 40-character lowercase form this matches.
SHA_REGEX='^[0-9a-f]{40}$'

# Where the currently-deployed SHA is remembered, so a rollback command can
# be produced without guessing (T-14-56). Deliberately OUTSIDE the repo
# working tree -- same reasoning as scripts/env-path.mjs's own
# MEGA_CRM_ENV_FILE default (a file inside the checkout is readable by every
# tool/editor/agent operating on it). MEGA_CRM_DEPLOY_STATE_FILE overrides it
# entirely, mirroring that same convention's own override variable.
RECORD_FILE="${MEGA_CRM_DEPLOY_STATE_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/mega-crm/current-sha}"

# The api container's healthcheck (docker/docker-compose.prod.yml) probes
# this exact same URL from inside its own container -- reused verbatim here
# so the deploy script's own readiness gate and the container's own
# Docker-visible health status can never disagree about what "ready" means.
READYZ_PROBE_JS="fetch('http://127.0.0.1:4000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# WR-07: mirrors the `web` service's own Docker healthcheck
# (docker/docker-compose.prod.yml) verbatim -- Caddy's admin API on
# 127.0.0.1:2019, not the public {$SITE_ADDRESS} site, so this gate never
# depends on ACME cert issuance or DNS/hostname resolution.
WEB_READY_PROBE_CMD=(wget --spider -q "http://127.0.0.1:2019/config/")

# --- Readiness/timeout budgets -----------------------------------------
#
# OPS-02's core guarantee: gate on /readyz, NEVER a fixed sleep (T-14-54).
# 120s comfortably exceeds the api container's own Docker healthcheck
# worst-case time-to-first-healthy (start_period 20s + 5 retries x 10s
# interval = 70s, docker/docker-compose.prod.yml) while still failing loudly
# inside a normal deploy window rather than hanging it indefinitely.
API_READYZ_TIMEOUT_SECONDS="${API_READYZ_TIMEOUT_SECONDS:-120}"
API_READYZ_POLL_INTERVAL_SECONDS="${API_READYZ_POLL_INTERVAL_SECONDS:-3}"

# WR-07: same reasoning as API_READYZ_TIMEOUT_SECONDS above, sized against
# `web`'s own Docker healthcheck worst-case time-to-first-healthy
# (start_period 10s + 5 retries x 10s interval = 60s, docker/docker-compose.prod.yml).
WEB_READY_TIMEOUT_SECONDS="${WEB_READY_TIMEOUT_SECONDS:-90}"
WEB_READY_POLL_INTERVAL_SECONDS="${WEB_READY_POLL_INTERVAL_SECONDS:-3}"

# The worker's own timeouts are ALWAYS derived from the machine-read
# WORKER_STOP_GRACE_PERIOD_SECONDS (plan 14-04's
# scripts/print-stop-grace-period.mjs) plus a stated, justified margin --
# never a hand-typed round number picked on its own:
#   - stop-confirm margin (15s): the grace period is already the bound
#     Docker itself uses before SIGKILLing a slow-to-stop container
#     (`docker compose stop --timeout`); this margin covers the daemon's own
#     reap/report latency AFTER that SIGKILL, not a second guess at drain
#     time.
#   - ready margin (90s): covers the NEW worker's own Docker healthcheck
#     worst-case time-to-first-healthy (start_period 20s + 5 x 10s interval =
#     70s) plus a 20s buffer for container start + Postgres/Redis
#     reconnection.
# Plan 14-07 measured a REAL SIGTERM-to-exit drain of ~1.6s against the
# WORKER_STOP_GRACE_PERIOD_SECONDS=60 budget measured at that plan's commit
# (~97% headroom) -- these margins are additional slack layered on top of an
# already-generous budget, not evidence the budget itself is tight.
WORKER_STOP_CONFIRM_MARGIN_SECONDS="${WORKER_STOP_CONFIRM_MARGIN_SECONDS:-15}"
WORKER_READY_MARGIN_SECONDS="${WORKER_READY_MARGIN_SECONDS:-90}"
WORKER_POLL_INTERVAL_SECONDS="${WORKER_POLL_INTERVAL_SECONDS:-1}"

# --- Argument parsing ----------------------------------------------------

DRY_RUN=0
ROLLBACK_MODE=0
TARGET_SHA=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --rollback-to)
      ROLLBACK_MODE=1
      shift
      if [[ $# -eq 0 ]]; then
        echo "deploy.sh: --rollback-to requires a SHA argument" >&2
        exit 1
      fi
      TARGET_SHA="$1"
      shift
      ;;
    -*)
      echo "deploy.sh: unknown flag '$1'" >&2
      exit 1
      ;;
    *)
      if [[ -n "$TARGET_SHA" ]]; then
        echo "deploy.sh: unexpected extra argument '$1' (a SHA was already given)" >&2
        exit 1
      fi
      TARGET_SHA="$1"
      shift
      ;;
  esac
done

if [[ -z "$TARGET_SHA" ]]; then
  echo "deploy.sh: missing required SHA argument." >&2
  echo "Usage: scripts/deploy.sh <full-git-sha> | scripts/deploy.sh --dry-run <full-git-sha> | scripts/deploy.sh --rollback-to <full-git-sha>" >&2
  exit 1
fi

if ! [[ "$TARGET_SHA" =~ $SHA_REGEX ]]; then
  echo "deploy.sh: rejected argument '$TARGET_SHA' -- must be a full 40-character lowercase-hexadecimal git SHA. Branch names and 'latest' are not accepted: a mutable reference would defeat OPS-03's rollback guarantee (T-14-52)." >&2
  exit 1
fi

# --- Helpers ---------------------------------------------------------------

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

print_rollback_command() {
  local sha="$1"
  if [[ "$sha" == "none" ]]; then
    echo "deploy.sh: no previous SHA is on record at $RECORD_FILE (this looks like the first deploy on this host) -- nothing to roll back to."
  else
    echo "deploy.sh: rollback command for this deploy -- scripts/deploy.sh --rollback-to $sha"
  fi
}

# Resolves WORKER_STOP_GRACE_PERIOD_SECONDS the SAME way plans 14-04/14-08
# already established: build the worker, then read the value it just built
# with (never a hand-typed number -- Pitfall 7). DEPLOY_SCRIPT_TEST_STOP_GRACE_PERIOD_SECONDS
# is a TEST-ONLY escape hatch, inert unless explicitly set, mirroring this
# repository's existing convention for this class of hook
# (scripts/migrate-runner.mjs's MIGRATE_RUNNER_TEST_PAUSE_AFTER_LOCK) -- no
# production invocation of this script ever sets it.
resolve_worker_stop_grace_period() {
  if [[ -n "${DEPLOY_SCRIPT_TEST_STOP_GRACE_PERIOD_SECONDS:-}" ]]; then
    echo "${DEPLOY_SCRIPT_TEST_STOP_GRACE_PERIOD_SECONDS}"
    return 0
  fi

  # WR-05: this builds and reads WORKER_STOP_GRACE_PERIOD_SECONDS from
  # whatever is CURRENTLY CHECKED OUT on the deploy host, not from
  # $TARGET_SHA itself. If the local tree isn't actually at $TARGET_SHA --
  # the ordinary case for --rollback-to an older commit, or any multi-
  # operator/CI setup where the checkout lags or leads the SHA being
  # deployed -- the resolved number would reflect the WRONG commit's
  # shutdown-budget constants while `docker compose stop --timeout` applies
  # it to the image actually being deployed. Fail loud here (this repo's
  # own convention -- see the header's Pitfall 7 discussion) rather than
  # silently building against the wrong tree state.
  local head_sha
  head_sha="$(git rev-parse HEAD)"
  if [[ "$head_sha" != "$TARGET_SHA" ]]; then
    echo "deploy.sh: refusing to resolve the worker stop-grace-period -- the local working tree is checked out at $head_sha, not the SHA being deployed ($TARGET_SHA). The grace period MUST come from a build of the exact SHA being deployed (Pitfall 7); building from a mismatched tree would silently apply the wrong commit's shutdown-budget constants. Run 'git checkout $TARGET_SHA' (or an equivalent worktree checked out at that SHA) and re-run this script." >&2
    exit 1
  fi

  npm run build -w apps/worker 1>&2
  node scripts/print-stop-grace-period.mjs
}

wait_for_api_ready() {
  local waited=0
  while (( waited < API_READYZ_TIMEOUT_SECONDS )); do
    if compose exec -T api node -e "$READYZ_PROBE_JS"; then
      return 0
    fi
    sleep "$API_READYZ_POLL_INTERVAL_SECONDS"
    waited=$(( waited + API_READYZ_POLL_INTERVAL_SECONDS ))
  done
  return 1
}

# WR-07: `web` had no deploy-time gate at all -- `compose up -d web api`
# returned as soon as the containers were STARTED, with no verification
# that Caddy actually came up (e.g. CR-01's storage-permission failure
# would have gone entirely unnoticed here). Polls the same admin-API probe
# the `web` service's own Docker healthcheck uses.
wait_for_web_ready() {
  local waited=0
  while (( waited < WEB_READY_TIMEOUT_SECONDS )); do
    if compose exec -T web "${WEB_READY_PROBE_CMD[@]}"; then
      return 0
    fi
    sleep "$WEB_READY_POLL_INTERVAL_SECONDS"
    waited=$(( waited + WEB_READY_POLL_INTERVAL_SECONDS ))
  done
  return 1
}

wait_for_worker_gone() {
  local bound=$(( WORKER_STOP_GRACE_PERIOD_SECONDS + WORKER_STOP_CONFIRM_MARGIN_SECONDS ))
  local waited=0
  while (( waited < bound )); do
    local running
    running="$(compose ps -q --status=running worker)"
    if [[ -z "$running" ]]; then
      return 0
    fi
    sleep "$WORKER_POLL_INTERVAL_SECONDS"
    waited=$(( waited + WORKER_POLL_INTERVAL_SECONDS ))
  done
  return 1
}

wait_for_worker_healthy() {
  local bound=$(( WORKER_STOP_GRACE_PERIOD_SECONDS + WORKER_READY_MARGIN_SECONDS ))
  local waited=0
  while (( waited < bound )); do
    local cid status
    cid="$(compose ps -q worker)"
    if [[ -n "$cid" ]]; then
      status="$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)"
      if [[ "$status" == "healthy" ]]; then
        return 0
      fi
    fi
    sleep "$WORKER_POLL_INTERVAL_SECONDS"
    waited=$(( waited + WORKER_POLL_INTERVAL_SECONDS ))
  done
  return 1
}

# --- Dry run ---------------------------------------------------------------
#
# Machine-readable: one command per line, execution order, NO side effects.
# This is what makes the ordering testable (scripts/__tests__/deploy-script.test.mjs)
# and what an operator should read before their first real deploy.
print_dry_run() {
  local target="$1"
  local rollback="$2"

  if [[ "$rollback" -eq 1 ]]; then
    cat <<EOF
# WARNING: --rollback-to runs the SAME sequence for an OLDER SHA ($target).
# This script has no view of the migration list for that SHA and cannot
# determine whether the migrations between now and then are auto-reversible.
# Consult MIGRATION_TIERS (packages/db/src/migration-tiers.ts) via
# docs/runbooks/deploy-and-rollback.md BEFORE running this for real -- if any
# migration in that range is forward-only, this is a restore, not a redeploy.
EOF
  fi

  cat <<EOF
printf '%s' "\$PREV_SHA" > "$RECORD_FILE"
node scripts/validate-kek-file.mjs /etc/mega-crm/kek
docker compose -f $COMPOSE_FILE pull api worker web
npm run build -w apps/worker && node scripts/print-stop-grace-period.mjs
docker compose -f $COMPOSE_FILE run --rm --no-deps migrate
docker compose -f $COMPOSE_FILE up -d --no-deps web api
docker compose -f $COMPOSE_FILE exec -T api node -e "$READYZ_PROBE_JS"
docker compose -f $COMPOSE_FILE exec -T web ${WEB_READY_PROBE_CMD[@]}
docker compose -f $COMPOSE_FILE stop --timeout \$WORKER_STOP_GRACE_PERIOD_SECONDS worker
docker compose -f $COMPOSE_FILE ps -q --status=running worker
docker compose -f $COMPOSE_FILE up -d --no-deps worker
docker inspect --format '{{.State.Health.Status}}' \$(docker compose -f $COMPOSE_FILE ps -q worker)
printf '%s' "$target" > "$RECORD_FILE"
EOF
}

# --- Real deploy -------------------------------------------------------------

check_required_env() {
  : "${GHCR_IMAGE_BASE:?deploy.sh: GHCR_IMAGE_BASE must be exported (e.g. ghcr.io/<owner>/<repo>) -- docker compose resolves the three image references from it.}"
  : "${SITE_ADDRESS:?deploy.sh: SITE_ADDRESS must be exported -- the public hostname Caddy (web) serves and requests a certificate for.}"
  : "${MEGA_CRM_ENV_FILE:?deploy.sh: MEGA_CRM_ENV_FILE must be exported and point at the operator real secrets file (see docs/runbooks/deploy-and-rollback.md pre-deploy checklist) -- docker compose resolves env_file paths via shell-level variable substitution, NOT via scripts/env-path.mjs Node-only default.}"
  if [[ ! -f "$MEGA_CRM_ENV_FILE" ]]; then
    echo "deploy.sh: MEGA_CRM_ENV_FILE=$MEGA_CRM_ENV_FILE does not exist or is not a regular file -- aborting before touching anything." >&2
    exit 1
  fi
}

validate_host_kek() {
  if [[ "${DEPLOY_SCRIPT_TEST_SKIP_KEK_VALIDATION:-0}" == "1" ]]; then
    return 0
  fi
  node scripts/validate-kek-file.mjs /etc/mega-crm/kek
}

run_real_deploy() {
  local target="$1"

  check_required_env
  validate_host_kek

  mkdir -p "$(dirname "$RECORD_FILE")"
  local prev_sha
  if [[ -f "$RECORD_FILE" ]]; then
    prev_sha="$(cat "$RECORD_FILE")"
  else
    prev_sha="none"
  fi

  # Written BEFORE anything is replaced (T-14-56): even a crash between here
  # and the end of this function leaves this file holding the SHA that is
  # still actually serving traffic, not a guess.
  printf '%s' "$prev_sha" > "$RECORD_FILE"

  local skip_worker_replace=0
  if [[ "$prev_sha" == "$target" ]]; then
    echo "deploy.sh: $target is already the recorded deployed SHA -- pulling/migrating for safety (both are idempotent), but skipping the disruptive worker replace."
    skip_worker_replace=1
  fi

  export GHCR_IMAGE_BASE
  export SITE_ADDRESS
  export MEGA_CRM_ENV_FILE
  export IMAGE_TAG="$target"

  echo "deploy.sh: pulling api/worker/web images for $target"
  compose pull api worker web

  echo "deploy.sh: resolving worker stop-grace-period"
  local worker_stop_grace_period_seconds
  worker_stop_grace_period_seconds="$(resolve_worker_stop_grace_period)"
  export WORKER_STOP_GRACE_PERIOD_SECONDS="$worker_stop_grace_period_seconds"

  echo "deploy.sh: running the one-shot migrate step"
  if ! compose run --rm --no-deps migrate; then
    echo "deploy.sh: MIGRATE FAILED -- aborting before any application container is replaced. The previous version ($prev_sha) is still serving." >&2
    print_rollback_command "$prev_sha"
    exit 1
  fi

  echo "deploy.sh: bringing up web and api"
  compose up -d --no-deps web api

  echo "deploy.sh: waiting for api readiness (/readyz)"
  if ! wait_for_api_ready; then
    echo "deploy.sh: READINESS TIMEOUT waiting for service 'api' to answer /readyz after ${API_READYZ_TIMEOUT_SECONDS}s -- aborting before the worker is replaced." >&2
    print_rollback_command "$prev_sha"
    exit 1
  fi

  echo "deploy.sh: waiting for web readiness (Caddy admin API)"
  if ! wait_for_web_ready; then
    echo "deploy.sh: READINESS TIMEOUT waiting for service 'web' to answer its admin API after ${WEB_READY_TIMEOUT_SECONDS}s -- aborting before the worker is replaced. web is the only service this topology publishes to the internet (T-14-43); investigate before retrying." >&2
    print_rollback_command "$prev_sha"
    exit 1
  fi

  if [[ "$skip_worker_replace" -eq 0 ]]; then
    echo "deploy.sh: replacing the worker (stop old, confirm gone, start new)"
    compose stop --timeout "$WORKER_STOP_GRACE_PERIOD_SECONDS" worker

    if ! wait_for_worker_gone; then
      echo "deploy.sh: TIMEOUT waiting for service 'worker' (old container) to stop after $(( WORKER_STOP_GRACE_PERIOD_SECONDS + WORKER_STOP_CONFIRM_MARGIN_SECONDS ))s -- aborting before a new worker starts (never running two workers at once)." >&2
      print_rollback_command "$prev_sha"
      exit 1
    fi

    compose up -d --no-deps worker

    if ! wait_for_worker_healthy; then
      echo "deploy.sh: READINESS TIMEOUT waiting for service 'worker' (new container) to report healthy after $(( WORKER_STOP_GRACE_PERIOD_SECONDS + WORKER_READY_MARGIN_SECONDS ))s -- investigate; api is already serving $target." >&2
      print_rollback_command "$prev_sha"
      exit 1
    fi
  fi

  printf '%s' "$target" > "$RECORD_FILE"
  echo "deploy.sh: deploy of $target complete."
  print_rollback_command "$prev_sha"
}

# --- Main --------------------------------------------------------------------

if [[ "$DRY_RUN" -eq 1 ]]; then
  print_dry_run "$TARGET_SHA" "$ROLLBACK_MODE"
  exit 0
fi

if [[ "$ROLLBACK_MODE" -eq 1 ]]; then
  cat >&2 <<EOF
deploy.sh: WARNING -- rolling back to $TARGET_SHA.
This script has no view of the migration list for that SHA and cannot
determine tier. Consult MIGRATION_TIERS (packages/db/src/migration-tiers.ts)
via docs/runbooks/deploy-and-rollback.md's rollback decision BEFORE this runs
against a real host -- if any migration between the two SHAs is forward-only,
this is NOT a safe redeploy; you need a restore, not this script.
EOF
fi

run_real_deploy "$TARGET_SHA"
