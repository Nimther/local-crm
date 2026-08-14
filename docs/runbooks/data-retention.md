# Data Retention Runbook (Partition Drop)

Implements requirement **DB-11** and decision **D-08**
(`.planning/phases/14-deployment-database-durability/14-CONTEXT.md`): retention
of the `events`/`send_events` monthly partitions defined by a versioned
horizon constant and **applied** by the existing daily maintenance tick, not
merely documented. This is the reference for
`packages/db/src/partitions/retention.ts` (the horizon, the eligibility walk,
the drop mechanism) and the retention-related columns
`docs/runbooks/backups.md`/`docs/runbooks/restore-drill.md` already
cross-reference from their own "what a dropped partition's real recovery
horizon is" sections.

## What this is, in one paragraph

Once a month, without any change to this file, the daily partition
maintenance tick (`apps/worker/src/queues/partition-maintenance.worker.ts`,
Phase 9) becomes eligible to permanently remove the oldest
`events`/`send_events` monthly partitions once they are more than
**`PARTITION_RETENTION_MONTHS` (currently 12) months old**. It does this by
`DETACH PARTITION` + `DROP TABLE` — never a row-level `DELETE` — which is
instant regardless of how many rows the partition holds. This is the only
automatic, irreversible operation this codebase performs. It does not run at
all until an operator explicitly enables it (see **The enable flag**), and it
never touches five specific evidence tables regardless (see **What retention
never touches**).

## What retention deletes

Whole monthly partitions of exactly two tables, `events` and `send_events`
(`RETENTION_ELIGIBLE_TABLES` in `retention.ts` — the same frozen table list
`ensure-partitions.ts` uses at the creation end of the timeline). A partition
is eligible only when its **entire** range ends at or before the horizon
boundary; a partition holding even one row inside the horizon is never
touched, and the comparison is read from Postgres's own catalog bound
expression for that partition, never derived from the partition's name.

## What retention never touches

Five evidence-table groups (`RETENTION_EXCLUDED_TABLES` in `retention.ts`),
named exactly, with what each one proves:

| Table | What it proves |
|---|---|
| `sends` | The sends ledger — Phase 11's terminal delivery-status truth for every email this platform has ever sent. |
| `workspace_daily_rollup` | The daily aggregate metrics rollup (Phase 13, ANLT). |
| `subscription_status_history` | The append-only consent-change history (D-09, ANLT-03) — every subscribe/unsubscribe/suppress transition a contact has ever undergone. |
| `erasure_records` | Phase 13's proof that a contact's data was anonymized (CMP-04). |
| `workspace_suppressions` | The hashed suppression list (CMP-04, migration 0061) — proof an address was suppressed, without ever storing what the address was. |

None of these five is partitioned today, so the eligibility walk would never
enumerate them regardless — the exclusion list is a **second, explicit** line
of defense (T-14-77): `findExpiredPartitions` refuses (throws) rather than
silently skipping if it is ever asked to enumerate one of these by name.
Phase 13's erasure model depends on every one of these five outliving the
event data retention deletes — they are the evidence that a person's data was
removed and must stay unmailable. Retention removing any of them would
destroy the very proof compliance depends on.

## The horizon

`PARTITION_RETENTION_MONTHS = 12` (`packages/db/src/partitions/retention.ts`).
D-08 states "~12 months"; this is the exact versioned constant that number
resolves to. A partition is eligible once its entire range ends at or before
`now`'s month minus 12 months — the trailing 12 complete months (not
counting the current, still-accumulating month) are always retained in full.

**Why this constant is different from every other constant in this
codebase**: dropping a partition is irreversible. The only recovery is a
pgBackRest restore, and only until that backup expires. See **The real
recovery horizon** below before changing this number.

## The enable flag

`PARTITION_RETENTION_ENABLED` — must be set to the exact string `true` for
retention to drop anything at all. Any other value (`1`, `TRUE`, `yes`, an
empty string) or the flag being unset resolves to **off**. Default is off;
no committed configuration file in this repository sets this flag to `true`
(`docker/prod.env.example` does not mention it at all — deliberately, so
there is nothing to accidentally uncomment). The operator sets it in the
externally-resolved `MEGA_CRM_ENV_FILE` (the same file `scripts/deploy.sh`
already reads for every other production secret/flag), never in a file
tracked by git.

**Precondition, enforced by the checkpoint that closed this plan, not just by
this sentence**: D-08 orders DB-10 (the restore drill, plan 14-11) strictly
before DB-11 (this plan) — retention deletes, and a dropped partition is
recoverable only from a backup, so nobody should be allowed to start deleting
data before a restore has ever been proven to work.

**Status as of this plan (14-12)**: the flag is OFF everywhere, and this
plan's own commits set it nowhere. Plan 14-11's real-host restore drill
(against the actual production VPS, S3 repository and Docker daemon —
`docs/runbooks/restore-drill.md`'s "What was NOT verified locally" section)
is a **pending operator action**, not yet performed as of this plan's
authoring. Do not set `PARTITION_RETENTION_ENABLED=true` in production until:

1. Plan 14-11's restore drill has actually been run against the real VPS/S3
   repository, following `docs/runbooks/restore-drill.md` end to end, with a
   passing `db:verify-restored` result recorded.
2. `docker/pgbackrest/pgbackrest.conf`'s `repo1-retention-full` has been
   widened per **The real recovery horizon** below, and the resulting
   storage cost has been reviewed and accepted.

Only once both of those are true should an operator set the flag on a real
production host.

## The real recovery horizon (read this before enabling)

A dropped partition is recoverable **only** from a pgBackRest backup, and
**only** until that backup itself expires. Two numbers combine to determine
how much real headroom exists between "a partition is dropped" and "that
partition becomes unrecoverable even from backup":

- **This runbook's horizon**: 12 months. A partition is dropped once it turns
  13 months old (see **The horizon** above) — roughly one partition drops per
  month, once retention is running steadily.
- **`docs/runbooks/backups.md`'s repository retention window**:
  `repo1-retention-full=2` (count-based) — **roughly two weeks** of
  restorable history before the oldest full backup (and everything chained
  off it) expires.

**The arithmetic**: once a given month's partition is dropped, the LAST
moment it is still recoverable from backup is roughly two weeks after that
drop — because that is how long the backup covering that moment stays
inside the retention window before pgBackRest ages it out. A two-week window
against a monthly drop cadence is short: if an operator does not notice a
mistaken horizon change (or a data need discovered after the fact) within
roughly two weeks of a drop, the backup-based recovery path is gone too, and
the data is gone permanently.

**Required before the first production enable**: widen
`docker/pgbackrest/pgbackrest.conf`'s `repo1-retention-full` from `2` to
somewhere in the **4-6 weekly fulls** range (roughly **1-1.5 months** of
restorable history) — this is a config change to that file, applied and
verified via a real `pgbackrest info` showing the wider chain, BEFORE
`PARTITION_RETENTION_ENABLED` is ever set to `true` on a real host. This
plan does not make that config change itself (it is a `docker/pgbackrest/`
edit, not a `packages/db`/`apps/worker` one, and belongs to the operator's
own pre-enable checklist, not to a code change gated behind a test). After
widening, **review the resulting storage cost** (more full backups retained
online means more S3 storage billed) before treating the wider window as
permanent — this is a real, ongoing cost being taken on specifically to make
the retention tick's own irreversibility safer, and it should be a conscious
tradeoff, not a default.

With the window widened to (say) 5 weekly fulls (~5 weeks online), the
combined recovery horizon becomes: a partition dropped by the monthly tick
remains recoverable for roughly 5 weeks after the drop, not 2 — comfortably
longer than the time it would plausibly take an operator to notice a mistake
and act on it.

## Changing the horizon safely

`PARTITION_RETENTION_MONTHS` is a versioned code constant
(`packages/db/src/partitions/retention.ts`), not an environment variable —
changing it requires a code change, a review, and a deploy, the same
discipline `LOOKAHEAD_MONTHS`/`BUFFER_ALERT_THRESHOLD_MONTHS` already carry
at the creation end of the timeline (D-11/D-12).

**Narrowing the horizon (fewer months retained) makes additional partitions
eligible on the very next tick** — this is the change most likely to be made
casually ("we don't need a year, 6 months is fine") without anyone
connecting it to the recovery-horizon arithmetic above. Before narrowing:

1. Re-run the arithmetic in **The real recovery horizon** with the NEW
   number — a shorter retention horizon does not change the backup window,
   but it does change how much data a single misconfigured/mistimed tick can
   remove in one run (potentially many months' worth, if the horizon moves
   down a lot at once and several previously-safe partitions become eligible
   simultaneously).
2. Confirm the backup window is still wide enough relative to the new,
   shorter horizon's drop cadence.
3. Deploy the change with retention still able to be disabled quickly
   (`PARTITION_RETENTION_ENABLED` unset) if the first post-change tick's
   results look wrong — check `partition_retention_drops` (see **Verifying
   what was dropped** below) before the SECOND tick runs.

Widening the horizon (more months retained) is comparatively safe — it can
only ever retain a partition that would otherwise have been dropped, never
the reverse.

## Verifying what was dropped, and when

Two places answer "what did retention remove and when" — from the
database, not from logs that may have rotated (T-14-79):

**The append-only ledger** — one row per partition ever dropped, with its
name, its range and the horizon that made it eligible:

```sql
SELECT parent_table, partition_name, range_start, range_end, horizon_months, dropped_at
  FROM partition_retention_drops
 ORDER BY dropped_at DESC;
```

**The most recent run's own status** — `partition_maintenance_runs` (the
same singleton health row the partition-creation watchdog already reads)
carries three additional columns for the retention half of the SAME run:

```sql
SELECT last_run_at, retention_status, retention_error, partitions_dropped
  FROM partition_maintenance_runs
 WHERE id = 1;
```

`retention_status` is one of:

- `disabled` — the flag was unset for this run. This is the value every run
  writes on any committed deployment of this codebase today.
- `ok` — the retention step ran, whether or not anything was actually
  eligible to drop (`partitions_dropped` is `[]` when nothing was eligible;
  this is a normal, expected result, not a failure).
- `failed` — the retention step itself threw. `retention_error` carries the
  error's own message. A `failed` retention step never prevents the
  partition-CREATION half of the same tick from being recorded — check
  `partitions_created`/the buffer columns on this same row to confirm
  creation is still healthy, and see `docker compose logs worker` (or
  whatever your process supervisor exposes) for the loud
  `partition-maintenance: retention step failed` log line the worker also
  emits alongside this row.

## Cross-references

- `docs/runbooks/backups.md` (plan 14-10) — the pgBackRest cadence and
  retention window this runbook's recovery-horizon arithmetic depends on.
- `docs/runbooks/restore-drill.md` (plan 14-11) — the restore drill that must
  be performed and pass before this plan's enable flag is ever set on a real
  host; also the authoritative record of whether that drill has actually
  been run yet.
- `docs/runbooks/migration-rollback-and-roll-forward.md` (plan 14-05) — a
  different kind of irreversibility (schema, not data); not the recovery
  path for a dropped partition.
