import {
  PARTITIONED_TABLES,
  type PartitionClient,
  type PartitionedTableConfig,
} from "./ensure-partitions.js";

/**
 * Phase 14 plan 12 (DB-11, D-08): the horizon constant, the catalog-driven
 * eligibility walk, and the drop mechanism -- the same operation as
 * `ensure-partitions.ts`'s `ensurePartitions`, at the OPPOSITE end of the
 * timeline. That module is the single source of partition CREATE DDL; this
 * module is the single source of partition DROP DDL. Neither ever issues a
 * row-level DELETE -- Postgres's partition machinery is the deletion
 * mechanism (D-08: instant, no DELETE churn).
 *
 * This is the only IRREVERSIBLE operation this phase adds (see this file's
 * own `<reversibility>` in 14-12-PLAN.md). Every constant, comparison and
 * exclusion below is written conservative-by-construction, not conservative
 * by review: a partition is eligible only when its ENTIRE range is strictly
 * older than the horizon, the eligibility walk reads bounds from the
 * catalog's own bound expression (never from a partition's name), and the
 * five evidence-table groups Phase 13's erasure model depends on are
 * excluded by an explicit, hand-verified list.
 */

/**
 * D-08: ~12 months of `events`/`send_events` partition history is retained;
 * anything strictly older is eligible for the daily tick to drop once the
 * enable flag (`isRetentionEnabled` below) is switched on.
 *
 * THIS CONSTANT IS DIFFERENT FROM EVERY OTHER CONSTANT IN THIS CODEBASE:
 * dropping a partition is irreversible. The only recovery is a pgBackRest
 * restore, and only until that backup expires. As recorded in
 * `docs/runbooks/backups.md` (plan 14-10) and repeated in
 * `docs/runbooks/data-retention.md` (this plan): `repo1-retention-full=2`
 * (count-based) keeps roughly TWO WEEKS of restorable history today. A
 * 12-month drop cadence against a 2-week backup window means a partition
 * dropped by one month's tick is unrecoverable roughly two weeks after that
 * tick runs -- the runbook instructs widening `repo1-retention-full` to
 * 4-6 weekly fulls (roughly 1-1.5 months of restorable history) BEFORE the
 * enable flag is first switched on in production, precisely so the
 * combined recovery horizon (this constant's months, minus the backup
 * window's own months) never rounds down to "days". Changing this constant
 * changes that arithmetic -- see the runbook before changing it.
 */
export const PARTITION_RETENTION_MONTHS = 12;

/**
 * D-08: the two high-volume monthly-partitioned event tables retention ever
 * touches -- deliberately the SAME frozen array `ensure-partitions.ts`
 * enumerates at the creation end of the timeline, not a re-declared copy.
 * Reusing the identical reference means there is exactly one place in this
 * codebase that names which tables are partitioned at all; a table added to
 * (or removed from) `PARTITIONED_TABLES` is automatically eligible (or
 * ineligible) for retention with no second list to keep in sync.
 */
export const RETENTION_ELIGIBLE_TABLES: readonly PartitionedTableConfig[] = PARTITIONED_TABLES;

/**
 * D-08's five evidence groups, named by their EXACT physical table name
 * (verified by reading each schema file directly -- an exclusion list with
 * a typo excludes nothing while looking careful):
 *
 * - `sends` (packages/db/src/schema/sends.ts) -- the sends ledger. Phase 11's
 *   terminal delivery-status truth for every email this platform has ever
 *   sent.
 * - `workspace_daily_rollup` (schema/workspace-daily-rollup.ts) -- the daily
 *   aggregate metrics rollup (Phase 13, ANLT).
 * - `subscription_status_history` (schema/subscription-status-history.ts) --
 *   the append-only consent-change history (D-09, ANLT-03): every
 *   subscribe/unsubscribe/suppress transition a contact has ever undergone.
 * - `erasure_records` (schema/erasure-records.ts) -- Phase 13's proof that a
 *   contact's data was anonymized under CMP-04.
 * - `workspace_suppressions` (schema/suppressions.ts) -- the hashed
 *   suppression list (CMP-04, migration 0061): proof an address was
 *   suppressed, without ever storing what the address was.
 *
 * None of these tables is partitioned today, so `findExpiredPartitions`
 * would never enumerate them regardless -- this list exists as a SECOND,
 * explicit line of defense (T-14-77): even a future refactor that widened
 * `RETENTION_ELIGIBLE_TABLES`'s source, or a caller that constructs its own
 * table list by hand, is refused loudly by the guard in
 * `findExpiredPartitions` below rather than silently enumerating one of
 * these. Phase 13's erasure model depends on every one of these five
 * outliving the event data retention deletes -- they are the evidence that
 * a person's data was removed and must stay unmailable; retention removing
 * them would destroy the very proof compliance depends on.
 */
export const RETENTION_EXCLUDED_TABLES: readonly string[] = Object.freeze([
  "sends",
  "workspace_daily_rollup",
  "subscription_status_history",
  "erasure_records",
  "workspace_suppressions",
]);

/**
 * The env var that must be set to `RETENTION_ENABLING_VALUE` exactly for
 * retention drops to run at all. Named and exported so
 * `docs/runbooks/data-retention.md` and any test can reference the same
 * literal rather than restating it.
 */
export const PARTITION_RETENTION_ENABLE_FLAG = "PARTITION_RETENTION_ENABLED";

/** The one value that turns retention on -- every other value (including case variants, "1", "yes") is treated as off. */
export const RETENTION_ENABLING_VALUE = "true";

/**
 * D-08's DB-10-before-DB-11 ordering, made mechanical rather than
 * remembered: this must default to false, and any unrecognised value must
 * also resolve to false, because a flag that defaulted on would let a
 * fresh deployment start deleting partitions before anyone had ever proven
 * a restore actually works (plan 14-11's restore drill). No committed
 * configuration in this repository sets this flag to `RETENTION_ENABLING_VALUE`
 * -- enabling it is an operator action, performed only after the drill, per
 * `docs/runbooks/data-retention.md`.
 */
export function isRetentionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PARTITION_RETENTION_ENABLE_FLAG] === RETENTION_ENABLING_VALUE;
}

export interface ExpiredPartitionInfo {
  parentTable: string;
  partitionName: string;
  rangeStart: Date;
  rangeEnd: Date;
}

export interface PartitionDropRecord {
  parentTable: string;
  partitionName: string;
  rangeStart: Date;
  rangeEnd: Date;
  horizonMonths: number;
  droppedAt: Date;
}

/** The UTC first-of-month `Date` that is `monthsOffset` months after (or, negative, before) the month containing `from`. */
function monthStartUtc(from: Date, monthsOffset: number): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + monthsOffset, 1, 0, 0, 0, 0));
}

/**
 * Parses ONE UTC-offset timestamp literal body as produced by this
 * codebase's own `utcTimestampLiteral` (ensure-partitions.ts) -- the exact
 * shape Postgres's `pg_get_expr` renders for a timestamptz partition bound
 * in this database (`'YYYY-MM-DD HH:MM:SS+00'`). This is parsing the
 * CATALOG'S OWN bound expression text, never a partition's NAME -- T-14-80's
 * mitigation.
 */
function parseTimestampBoundLiteral(literal: string): Date {
  const match = /^'?(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\+00'?$/.exec(literal.trim());
  if (!match) {
    throw new Error(`findExpiredPartitions: could not parse partition bound literal "${literal}"`);
  }
  const [, year, month, day, hour, minute, second] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
  );
}

/** Parses `FOR VALUES FROM (<lit>) TO (<lit>)` -- the exact expression `pg_get_expr` renders for a RANGE partition's bound. */
function parsePartitionBoundExpression(expr: string): { start: Date; end: Date } {
  const match = /FOR VALUES FROM \(([^)]+)\) TO \(([^)]+)\)/.exec(expr);
  if (!match) {
    throw new Error(`findExpiredPartitions: could not parse partition bound expression "${expr}"`);
  }
  return {
    start: parseTimestampBoundLiteral(match[1]),
    end: parseTimestampBoundLiteral(match[2]),
  };
}

/**
 * D-08 / T-14-75 / T-14-76 / T-14-80: enumerates every RANGE partition of
 * each table in `tables` DIRECTLY FROM THE CATALOG (`pg_class`/`pg_inherits`/
 * `pg_partitioned_table`), never from a partition's name, and returns only
 * the ones whose ENTIRE range ends AT OR BEFORE the horizon boundary
 * (`monthStartUtc(now, -retentionMonths)`) -- a partition straddling that
 * boundary by even one day is never returned, because its range's exclusive
 * upper bound (`end`) is strictly greater than the boundary.
 *
 * The DEFAULT partition is excluded by joining `pg_partitioned_table` and
 * filtering `c.oid <> pt.partdefid` -- an OID comparison, not a name
 * comparison, so this holds even if a DEFAULT partition were ever renamed.
 * DEFAULT has no bounded range and can hold rows of any age; a "drop the
 * oldest" rule applied to it would be catastrophic (T-14-76).
 *
 * Refuses (throws) rather than silently skipping if `tables` ever contains
 * a table named in `RETENTION_EXCLUDED_TABLES` -- a second, explicit line of
 * defense on top of `RETENTION_ELIGIBLE_TABLES` already being disjoint from
 * that list (T-14-77).
 */
export async function findExpiredPartitions(
  client: PartitionClient,
  tables: readonly PartitionedTableConfig[] = RETENTION_ELIGIBLE_TABLES,
  now: Date = new Date(),
  retentionMonths: number = PARTITION_RETENTION_MONTHS,
): Promise<ExpiredPartitionInfo[]> {
  const horizonBoundary = monthStartUtc(now, -retentionMonths);
  const expired: ExpiredPartitionInfo[] = [];

  for (const table of tables) {
    if (RETENTION_EXCLUDED_TABLES.includes(table.parentTable)) {
      throw new Error(
        `findExpiredPartitions: refusing to enumerate "${table.parentTable}" -- it is named in RETENTION_EXCLUDED_TABLES`,
      );
    }

    const { rows } = await client.query<{ relname: string; bound: string | null }>(
      `SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_partitioned_table pt ON pt.partrelid = p.oid
        WHERE n.nspname = 'public'
          AND p.relname = $1
          AND c.relispartition
          AND c.oid <> pt.partdefid`,
      [table.parentTable],
    );

    for (const row of rows) {
      // Defensive only: the oid<>partdefid filter above already excludes
      // the DEFAULT partition, which is the one relation that would render
      // a null/DEFAULT-shaped bound here.
      if (row.bound === null) continue;
      const { start, end } = parsePartitionBoundExpression(row.bound);
      if (end.getTime() <= horizonBoundary.getTime()) {
        expired.push({ parentTable: table.parentTable, partitionName: row.relname, rangeStart: start, rangeEnd: end });
      }
    }
  }

  return expired;
}

/**
 * WR-03: catalog-sourced identifiers only ever look like this; refusing
 * anything else is cheap insurance against ever interpolating something
 * else into the one operation this file's own header calls "the only
 * IRREVERSIBLE operation this phase adds" -- mirrors the exact discipline
 * `verify-restored-database.ts`'s `SAFE_TABLE_NAME` already applies one
 * file over for a much lower-stakes `SELECT count(*)`.
 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Throws if `identifier` does not match the identifier shape every real catalog-sourced relation name has -- called immediately before interpolating a name into DETACH/DROP DDL. */
function assertSafeIdentifier(identifier: string, context: string): void {
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw new Error(
      `dropExpiredPartitions: refusing to interpolate "${identifier}" (${context}) -- its name does not match the identifier shape every real catalog-sourced relation name has`,
    );
  }
}

/**
 * D-08: detach-and-drop exactly what `findExpiredPartitions` returns, one
 * partition per transaction (mirrors `attachPartitionCheckFirst`'s own
 * one-dedicated-connection-per-operation shape). NEVER issues a row-level
 * DELETE anywhere -- the DETACH + DROP TABLE sequence IS the deletion
 * mechanism (D-08: instant, no DELETE churn), and a DELETE code path
 * existing at all would invite someone to reach for it on a straddling
 * partition. Returns one `PartitionDropRecord` per partition actually
 * dropped, carrying its name, range and the horizon that made it eligible
 * -- T-14-79's per-drop record. A no-op call (nothing eligible) returns `[]`
 * without touching the database at all.
 */
export async function dropExpiredPartitions(
  client: PartitionClient,
  tables: readonly PartitionedTableConfig[] = RETENTION_ELIGIBLE_TABLES,
  now: Date = new Date(),
  retentionMonths: number = PARTITION_RETENTION_MONTHS,
): Promise<PartitionDropRecord[]> {
  const expired = await findExpiredPartitions(client, tables, now, retentionMonths);
  const drops: PartitionDropRecord[] = [];

  for (const partition of expired) {
    assertSafeIdentifier(partition.parentTable, "parentTable");
    assertSafeIdentifier(partition.partitionName, "partitionName");

    const conn = await client.connect();
    try {
      await conn.query("BEGIN");
      await conn.query(`ALTER TABLE ${partition.parentTable} DETACH PARTITION ${partition.partitionName}`);
      await conn.query(`DROP TABLE ${partition.partitionName}`);
      await conn.query("COMMIT");
    } catch (err) {
      await conn.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }

    drops.push({
      parentTable: partition.parentTable,
      partitionName: partition.partitionName,
      rangeStart: partition.rangeStart,
      rangeEnd: partition.rangeEnd,
      horizonMonths: retentionMonths,
      droppedAt: now,
    });
  }

  return drops;
}
