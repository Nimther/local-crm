#!/usr/bin/env bash
# Phase 14 plan 11 (DB-10, D-07, T-14-68..T-14-73).
#
# The scripted point-in-time restore drill: restores the latest backup plus
# WAL replay to an EXPLICIT target timestamp into a throwaway Postgres
# container with its own name and its own volume -- never the production
# ones -- verifies the result with `npm run db:verify-restored` (Task 1),
# and destroys the scratch resources on success. This is the ONE operation
# in this phase that could destroy production data if its guard ever
# failed, so every write-capable step asserts its own scratch names differ
# from the production names READ from docker/docker-compose.prod.yml, not
# from a remembered/hardcoded list a future rename could make stale.
#
# Mirrors scripts/deploy.sh's own conventions deliberately: strict shell
# error handling, named argument rejections, a `--dry-run` that prints one
# command per line with no side effects. Consistency between the two
# operator scripts matters more than either one's own style.
#
# Usage:
#   scripts/restore-drill.sh <utc-timestamp>              run the real drill
#   scripts/restore-drill.sh --dry-run <utc-timestamp>     print the ordered
#                                                          command sequence,
#                                                          no side effects
#
# <utc-timestamp> MUST be explicit -- there is no "latest" default. Defaulting
# to the latest backup would let this drill degrade into "we unpacked a
# backup", which is not what DB-10 claims and not what point-in-time recovery
# means. Format: 'YYYY-MM-DD HH:MM:SS+00' (UTC, explicit +00 offset -- the
# same shape packages/db/src/partitions/ensure-partitions.ts's own
# utcTimestampLiteral produces, and the exact format this plan's own local
# rehearsal against a real pgBackRest 2.59.0 + Postgres 17 confirmed
# round-trips correctly through `--type=time --target=... --target-action=
# promote`). The target must fall inside the retention window
# docs/runbooks/backups.md records (2 full backups, count-based -- roughly
# two weeks); this script cannot verify that itself (it has no view of the
# repository from the host) and says so in its own rejection message.
#
# No dependencies beyond `docker` (with the `compose` plugin) and `npm` --
# both already required to run scripts/deploy.sh.

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="docker/docker-compose.prod.yml"
PGBACKREST_CONF="docker/pgbackrest/pgbackrest.conf"
STANZA="mega_crm"

# A full UTC timestamp with an explicit +00 offset only -- see this file's
# header for why this format was chosen and how it was verified.
PITR_TARGET_REGEX='^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\+00$'

# --- Scratch resource names (T-14-68/T-14-69) -------------------------------
#
# Fixed, distinctly-named, and asserted at runtime against the production
# names read from $COMPOSE_FILE below -- never trusted merely because they
# look different by construction. Env-overridable ONLY for this script's own
# test suite (scripts/__tests__/restore-drill-script.test.mjs); no production
# invocation of this script ever sets these.
SCRATCH_CONTAINER_NAME="${RESTORE_DRILL_SCRATCH_CONTAINER:-megacrm-restore-drill-scratch}"
SCRATCH_VOLUME_NAME="${RESTORE_DRILL_SCRATCH_VOLUME:-megacrm_restore_drill_scratch_data}"
SCRATCH_PORT="${RESTORE_DRILL_SCRATCH_PORT:-55611}"

# Outside the repo working tree, mirroring scripts/deploy.sh's own
# RECORD_FILE convention -- a file inside the checkout is readable by every
# tool/editor/agent operating on it, and this is a read-only snapshot of
# production row counts (no credentials), but still not something to leave
# lying around in the repo.
BASELINE_FILE="${RESTORE_DRILL_BASELINE_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/mega-crm/restore-drill-baseline.json}"

READY_TIMEOUT_SECONDS="${RESTORE_DRILL_READY_TIMEOUT_SECONDS:-120}"
READY_POLL_INTERVAL_SECONDS="${RESTORE_DRILL_READY_POLL_INTERVAL_SECONDS:-3}"

# --- Argument parsing --------------------------------------------------------

DRY_RUN=0
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -*)
      echo "restore-drill.sh: unknown flag '$1'" >&2
      exit 1
      ;;
    *)
      if [[ -n "$TARGET" ]]; then
        echo "restore-drill.sh: unexpected extra argument '$1' (a target was already given)" >&2
        exit 1
      fi
      TARGET="$1"
      shift
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "restore-drill.sh: missing required PITR target argument." >&2
  echo "The target must fall inside the retention window docs/runbooks/backups.md records (2 full backups, count-based -- roughly two weeks) -- run 'pgbackrest --stanza=$STANZA info' first to confirm what is actually restorable." >&2
  echo "Usage: scripts/restore-drill.sh <utc-timestamp> | scripts/restore-drill.sh --dry-run <utc-timestamp>" >&2
  exit 1
fi

# --- Names read from the compose file, never hardcoded (T-14-68) -----------
#
# A future service/volume rename in docker-compose.prod.yml is reflected
# here automatically -- the alternative (a hand-typed list) is exactly the
# kind of guard that silently stops guarding anything the day it goes stale.
production_service_names() {
  awk '
    /^services:/ { in_block = 1; next }
    /^[a-zA-Z_][a-zA-Z0-9_-]*:/ { in_block = 0 }
    in_block && /^  [a-zA-Z][a-zA-Z0-9_-]*:/ {
      line = $0
      gsub(/^  /, "", line)
      gsub(/:.*/, "", line)
      print line
    }
  ' "$COMPOSE_FILE"
}

production_volume_names() {
  awk '
    /^volumes:/ { in_block = 1; next }
    /^[a-zA-Z_][a-zA-Z0-9_-]*:/ { in_block = 0 }
    in_block && /^  [a-zA-Z][a-zA-Z0-9_-]*:/ {
      line = $0
      gsub(/^  /, "", line)
      gsub(/:.*/, "", line)
      print line
    }
  ' "$COMPOSE_FILE"
}

production_pgdata_path() {
  grep -oE 'mega_crm_db_data_prod:[^[:space:]]+' "$COMPOSE_FILE" | head -1 | cut -d: -f2
}

# Newline-separated strings, not bash arrays -- `mapfile`/`readarray` are
# bash-4+ builtins, and macOS's own bundled `/bin/bash` (still 3.2, Apple's
# last GPLv2 release) is a real target this script must run under without
# requiring a Homebrew bash install first.
PRODUCTION_SERVICE_NAMES="$(production_service_names)"
PRODUCTION_VOLUME_NAMES="$(production_volume_names)"
PRODUCTION_PGDATA_PATH="$(production_pgdata_path)"

# A parsing bug that silently returns nothing would disable this guard
# entirely without ever failing loudly -- refuse to proceed rather than
# proceed unguarded (advisor-flagged, same discipline as
# scripts/validate-prod-compose.mjs's own "vacuous scan is impossible"
# tests).
if [[ -z "$PRODUCTION_SERVICE_NAMES" || -z "$PRODUCTION_VOLUME_NAMES" || -z "$PRODUCTION_PGDATA_PATH" ]]; then
  echo "restore-drill.sh: FATAL -- could not read any service/volume names (or the PGDATA path) from $COMPOSE_FILE. Refusing to proceed with an unverified production-name guard." >&2
  exit 1
fi

# Exact-line membership against a newline-separated list -- avoids bash-4+
# arrays entirely (see the comment above).
name_in_list() {
  local needle="$1"
  local list="$2"
  printf '%s\n' "$list" | grep -qxF "$needle"
}

# The target itself must never NAME a production resource (a pasted volume
# name, container/service name, or the PGDATA path, instead of a timestamp)
# -- checked BEFORE the format regex so the rejection message can name
# exactly what was detected, not just "bad format" (T-14-68's target-facing
# half; the write-side half is asserted separately below).
if name_in_list "$TARGET" "$PRODUCTION_SERVICE_NAMES" || name_in_list "$TARGET" "$PRODUCTION_VOLUME_NAMES" \
    || [[ "$TARGET" == "$PRODUCTION_PGDATA_PATH" ]]; then
  echo "restore-drill.sh: REFUSED -- '$TARGET' names a production service, volume or data path (read from $COMPOSE_FILE), not a PITR timestamp. This script will never target a production resource." >&2
  exit 1
fi

if ! [[ "$TARGET" =~ $PITR_TARGET_REGEX ]]; then
  echo "restore-drill.sh: rejected target '$TARGET' -- must be a UTC timestamp shaped 'YYYY-MM-DD HH:MM:SS+00'. There is no 'latest' default: an explicit target is what makes this a point-in-time recovery drill rather than a backup-unpacking drill." >&2
  exit 1
fi

# The scratch names this script itself writes to must differ from EVERY
# production name -- asserted here, not merely by the literals above looking
# different, so a future edit to either side cannot silently collide.
if name_in_list "$SCRATCH_CONTAINER_NAME" "$PRODUCTION_SERVICE_NAMES"; then
  echo "restore-drill.sh: FATAL -- SCRATCH_CONTAINER_NAME ('$SCRATCH_CONTAINER_NAME') collides with a production service name read from $COMPOSE_FILE. Refusing to proceed." >&2
  exit 1
fi
if name_in_list "$SCRATCH_VOLUME_NAME" "$PRODUCTION_VOLUME_NAMES"; then
  echo "restore-drill.sh: FATAL -- SCRATCH_VOLUME_NAME ('$SCRATCH_VOLUME_NAME') collides with a production volume name read from $COMPOSE_FILE. Refusing to proceed." >&2
  exit 1
fi

# --- Helpers -----------------------------------------------------------------

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

# The exact psql one-liner this drill's baseline capture runs against
# production, read-only, over the docker network (production's `db`
# publishes no port -- T-14-43 -- so this is the only way to reach it from
# outside the compose network). Generic over every real table via
# `query_to_xml`, the same catalog walk verify-restored-database.ts's own
# `checkRowCounts` uses, so the two can never disagree about which tables
# exist. Verified directly against a real local Postgres by this plan
# (see docs/runbooks/restore-drill.md).
baseline_query() {
  cat <<'SQL'
SELECT json_object_agg(t.relname, t.cnt)
FROM (
  SELECT c.relname,
         (xpath('/row/c/text()',
                query_to_xml(format('SELECT count(*) AS c FROM %I', c.relname), false, true, '')
               ))[1]::text::bigint AS cnt
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND NOT c.relispartition
) t;
SQL
}

# The scratch container's own entrypoint payload: chown the freshly-restored
# data to the image's postgres user, restore with WAL replay to the target
# and promote, then exec the image's own docker-entrypoint.sh -- which,
# finding an already-initialized PGDATA (PG_VERSION present), skips every
# init/setup path and simply execs postgres. `-c archive_mode=off` is a
# deliberate, explicit safety net (T-14-69's spirit extended to WAL): the
# restored on-disk postgresql.conf never had archive_mode/archive_command
# persisted into it in the first place (docker/postgres/prod-tls-entrypoint.sh
# only ever applies them as runtime `-c` flags), but stating it here means a
# future change to that fact cannot silently make this scratch cluster start
# shipping WAL back into the shared production repository.
restore_and_start_script() {
  local target="$1"
  printf 'chown -R postgres:postgres /var/lib/postgresql/data && gosu postgres pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=%s --type=time --target=%s --target-action=promote restore && exec docker-entrypoint.sh postgres -c archive_mode=off -c listen_addresses=*' \
    "$STANZA" "$(printf '%q' "$target")"
}

print_cleanup_command() {
  echo "restore-drill.sh: clean up the scratch resources by hand with: docker rm -f $SCRATCH_CONTAINER_NAME; docker volume rm $SCRATCH_VOLUME_NAME"
}

wait_for_scratch_ready() {
  local waited=0
  while (( waited < READY_TIMEOUT_SECONDS )); do
    if docker exec "$SCRATCH_CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep "$READY_POLL_INTERVAL_SECONDS"
    waited=$(( waited + READY_POLL_INTERVAL_SECONDS ))
  done
  return 1
}

# --- Dry run -----------------------------------------------------------------
#
# One command per line, execution order, NO side effects -- what makes the
# ordering testable (scripts/__tests__/restore-drill-script.test.mjs) and
# what an operator should read before ever running this for real.
print_dry_run() {
  local target="$1"
  # Built as its own variable, never nested directly inside the echo below's
  # double-quoted argument -- a $(...) command substitution whose OWN
  # argument is itself double-quoted, nested inside an outer double-quoted
  # string, tripped a real quote-depth-tracking bug in the bash 3.2 this
  # repository's own sandbox resolves `bash` to (macOS's bundled, GPLv2-last
  # bash) -- confirmed empirically: with the nested form, `run_real_drill`'s
  # OWN function definition further down the file silently failed to
  # register at all ("command not found" when called), while every function
  # defined after it in the file still worked. Assigning first sidesteps the
  # nesting entirely.
  local restore_cmd
  restore_cmd="$(restore_and_start_script "$target")"

  echo "# PITR target: $target"
  echo "# Scratch container: $SCRATCH_CONTAINER_NAME -- Scratch volume: $SCRATCH_VOLUME_NAME (both distinct from every production service/volume name read from $COMPOSE_FILE)"
  echo "docker volume create $SCRATCH_VOLUME_NAME"
  echo "docker compose -f $COMPOSE_FILE exec -T db psql -U postgres -d \${POSTGRES_DB:-mega_crm} -tAc \"<row-count baseline query -- see restore-drill.sh's own baseline_query()>\" > $BASELINE_FILE"
  echo "docker run -d --name $SCRATCH_CONTAINER_NAME -v $SCRATCH_VOLUME_NAME:/var/lib/postgresql/data -v $REPO_ROOT/$PGBACKREST_CONF:/etc/pgbackrest/pgbackrest.conf:ro --env-file \"\$MEGA_CRM_ENV_FILE\" -p 127.0.0.1:$SCRATCH_PORT:5432 --entrypoint /bin/bash megacrm-postgres:\${POSTGRES_IMAGE_TAG:-local} -c \"$restore_cmd\""
  echo "docker exec $SCRATCH_CONTAINER_NAME pg_isready -U postgres   # polled, bounded by RESTORE_DRILL_READY_TIMEOUT_SECONDS (default 120s)"
  echo "VERIFY_RESTORED_DATABASE_URL=postgresql://postgres:***@127.0.0.1:$SCRATCH_PORT/\${POSTGRES_DB:-mega_crm} npm run db:verify-restored --workspace=packages/db -- --baseline=$BASELINE_FILE --as-of=\"$target\""
  echo "docker rm -f $SCRATCH_CONTAINER_NAME"
  echo "docker volume rm $SCRATCH_VOLUME_NAME"
}

# --- Real drill ---------------------------------------------------------------

check_required_env() {
  # No apostrophe in this message -- see run_real_drill's own POSTGRES_PASSWORD
  # guard below for why: bash 3.2 (macOS's own bundled /bin/bash) mishandles
  # an unescaped single quote inside a ${var:?word} guard's message even
  # though the whole thing sits inside double quotes, treating it as an
  # unterminated single-quoted string that swallows unrelated, unrelated
  # lines of the script until some later apostrophe happens to close it --
  # confirmed empirically (a later function's own definition silently failed
  # to register at all). scripts/deploy.sh's own check_required_env already
  # avoids this by convention ("the operator real secrets file", no
  # possessive); this file now matches it exactly, not by accident.
  : "${MEGA_CRM_ENV_FILE:?restore-drill.sh: MEGA_CRM_ENV_FILE must be exported and point at the operator real secrets file (see docs/runbooks/restore-drill.md) -- the same env file scripts/deploy.sh and docker compose already use.}"
  if [[ ! -f "$MEGA_CRM_ENV_FILE" ]]; then
    echo "restore-drill.sh: MEGA_CRM_ENV_FILE=$MEGA_CRM_ENV_FILE does not exist or is not a regular file -- aborting before touching anything." >&2
    exit 1
  fi
}

run_real_drill() {
  local target="$1"

  check_required_env

  # Same file every other secret in this project is trusted from
  # (scripts/env-path.mjs's convention) -- sourcing it (not merely reading
  # it) is what lets this script build the verifier's own connection string
  # below without inventing a second parsing mechanism.
  # shellcheck disable=SC1090
  set -a
  source "$MEGA_CRM_ENV_FILE"
  set +a

  # No apostrophe here either -- see check_required_env's own comment above.
  : "${POSTGRES_PASSWORD:?restore-drill.sh: POSTGRES_PASSWORD must be set in MEGA_CRM_ENV_FILE -- the restored clusters real postgres superuser password came back with the physical backup, and this is how the verifier authenticates as it.}"

  mkdir -p "$(dirname "$BASELINE_FILE")"

  echo "restore-drill.sh: creating scratch volume $SCRATCH_VOLUME_NAME"
  docker volume create "$SCRATCH_VOLUME_NAME" >/dev/null

  echo "restore-drill.sh: capturing a read-only row-count baseline from production"
  if ! compose exec -T db psql -U postgres -d "${POSTGRES_DB:-mega_crm}" -tAc "$(baseline_query)" > "$BASELINE_FILE"; then
    echo "restore-drill.sh: BASELINE CAPTURE FAILED -- aborting before creating the scratch container. Production was not modified. The scratch volume ($SCRATCH_VOLUME_NAME) was created but holds no restored data; clean it up with: docker volume rm $SCRATCH_VOLUME_NAME" >&2
    exit 1
  fi

  echo "restore-drill.sh: restoring backup set with PITR target $target into scratch container $SCRATCH_CONTAINER_NAME"
  local restore_cmd
  restore_cmd="$(restore_and_start_script "$target")"
  if ! docker run -d --name "$SCRATCH_CONTAINER_NAME" \
        -v "$SCRATCH_VOLUME_NAME":/var/lib/postgresql/data \
        -v "$REPO_ROOT/$PGBACKREST_CONF":/etc/pgbackrest/pgbackrest.conf:ro \
        --env-file "$MEGA_CRM_ENV_FILE" \
        -p "127.0.0.1:${SCRATCH_PORT}:5432" \
        --entrypoint /bin/bash \
        "megacrm-postgres:${POSTGRES_IMAGE_TAG:-local}" \
        -c "$restore_cmd" >/dev/null; then
    echo "restore-drill.sh: RESTORE FAILED to start -- scratch resources left in place for inspection." >&2
    print_cleanup_command >&2
    exit 1
  fi

  echo "restore-drill.sh: waiting for the scratch container to become ready"
  if ! wait_for_scratch_ready; then
    echo "restore-drill.sh: READINESS TIMEOUT after ${READY_TIMEOUT_SECONDS}s -- scratch resources left in place for inspection." >&2
    print_cleanup_command >&2
    exit 1
  fi

  echo "restore-drill.sh: verifying the restored cluster (db:verify-restored)"
  # WR-06: POSTGRES_PASSWORD came back with the physical backup -- it is
  # whatever the password was at backup time, not a value this script
  # controls, so it may contain URL-significant characters (@, :, /, #, %,
  # whitespace). Interpolating it unencoded can misparse the
  # credential/host boundary (or throw outright) in the URL parser
  # createPgPool's assertDsnRequestsTls and pg-connection-string both use,
  # turning every real restore drill against such a password into a
  # confusing parse/auth error instead of the actual verification outcome.
  local encoded_postgres_password
  encoded_postgres_password="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$POSTGRES_PASSWORD")"
  if ! VERIFY_RESTORED_DATABASE_URL="postgresql://postgres:${encoded_postgres_password}@127.0.0.1:${SCRATCH_PORT}/${POSTGRES_DB:-mega_crm}" \
        npm run db:verify-restored --workspace=packages/db -- --baseline="$BASELINE_FILE" --as-of="$target"; then
    echo "restore-drill.sh: VERIFICATION FAILED -- scratch resources left in place for inspection." >&2
    print_cleanup_command >&2
    exit 1
  fi

  echo "restore-drill.sh: verification passed -- destroying scratch resources"
  docker rm -f "$SCRATCH_CONTAINER_NAME" >/dev/null
  docker volume rm "$SCRATCH_VOLUME_NAME" >/dev/null
  echo "restore-drill.sh: drill for target $target complete. Production was never touched except by the read-only baseline query above."
}

# --- Main --------------------------------------------------------------------

if [[ "$DRY_RUN" -eq 1 ]]; then
  print_dry_run "$TARGET"
  exit 0
fi

run_real_drill "$TARGET"
