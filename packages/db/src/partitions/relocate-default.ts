/**
 * 09-04 (DB-03/DB-04, D-08/D-09): the operator-invoked procedure that empties
 * `events_default`/`send_events_default` without a long lock on the live
 * parent. Postgres has no primitive for moving a row between partitions, so
 * this module implements a batched DELETE-then-INSERT and then reuses
 * `attachPartitionCheckFirst` (09-01) to finish with the same
 * CHECK-constraint-first sequence every other attach in this codebase uses --
 * Pitfall 13's mitigation lives in exactly one place.
 *
 * `relocateAllDefaultRows` is the single callable entrypoint: both
 * `packages/db/scripts/relocate-default-partition-rows.ts` (the operator CLI)
 * and `packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts`
 * (the criterion-3 automated test) call this exact function, never a parallel
 * reimplementation (D-08).
 *
 * 10-06 (SEC-01/SEC-02, checkpoint option-b): every month this module
 * relocates attaches a NON-EMPTY child (the whole point of the procedure),
 * which needs the elevated `adminClient` connection
 * `attachPartitionCheckFirst` (ensure-partitions.ts) documents -- the ordinary
 * `client` this module also threads through is never sufficient on its own
 * once migration 0043 drops the legacy `app.admin_scan`-gated policy. Both
 * `relocateMonth` and `relocateAllDefaultRows` REQUIRE `adminClient` as an
 * explicit, separate parameter (never optional here, unlike
 * `attachPartitionCheckFirst`'s own default) -- every caller of this module
 * always populates a non-empty child, so there is no legitimate call that
 * could omit it.
 *
 * Threat T-09-17 (Tampering): every partition/table identifier in this file
 * is built ONLY from `monthPartitionName` (calendar arithmetic against the
 * frozen `PARTITIONED_TABLES` allowlist) -- never from a discovery-query
 * result interpolated directly. Every date bound used in a DML `WHERE`
 * clause is a real bind parameter.
 *
 * This module is inert on import: it starts no timer, registers no job, and
 * constructs no scheduler or worker. Relocation is a deliberate operator
 * action (D-08), never background magic.
 */

import {
  attachPartitionCheckFirst,
  monthPartitionName,
  type PartitionClient,
  type PartitionedTableConfig,
} from "./ensure-partitions.js";

/**
 * Bounded so each transaction claiming a batch is short -- the whole point
 * of this exercise. A single unbounded `DELETE ... INSERT` moving an entire
 * month at once would hold row locks on DEFAULT for however long that move
 * takes, which is exactly the long-lock failure mode this procedure exists
 * to avoid. 500 keeps each batch's transaction on the order of a handful of
 * milliseconds against DEFAULT's normal accumulation rate, while still
 * converging quickly on a month that has accumulated many rows.
 */
export const RELOCATE_BATCH_SIZE = 500;

/** Zero-pad to `len` digits. */
function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

/** `YYYY-MM` display label for a UTC month-start `Date` -- report/log text only, never a DDL identifier. */
function monthLabel(monthStart: Date): string {
  return `${monthStart.getUTCFullYear()}-${pad(monthStart.getUTCMonth() + 1)}`;
}

/** The UTC month immediately after the month containing `monthStart`. */
function nextMonthStart(monthStart: Date): Date {
  return new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

/**
 * `SELECT count(*)` against `table`'s DEFAULT partition directly -- the
 * per-table primitive `packages/db/src/partitions/maintenance-run.ts`'s
 * `countDefaultRows` composes over `PARTITIONED_TABLES`. Exported separately
 * here because this module's callers (the CLI, the relocation report) want
 * the residual count for ONE table at a time, both before and after that
 * table's own relocation pass -- reusing `maintenance-run.ts`'s
 * multi-table loop for a single lookup would mean discarding the other
 * table's count on every call.
 */
export async function countDefaultRowsForTable(
  client: PartitionClient,
  table: PartitionedTableConfig,
): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*) AS count FROM ${table.defaultPartition}`,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Discovers every UTC month bucket actually present in `table`'s DEFAULT
 * partition, ordered ascending, by querying the data rather than assuming a
 * bounded "how many months back" window. `send_events.occurred_at` is a
 * provider-supplied SendGrid event timestamp and is not bounded until Phase
 * 13 / CMP-05 (D-09) -- a windowed procedure would leave a stray far-future
 * row in DEFAULT forever, permanently defeating the CHECK-constraint-first
 * optimisation for every normal month's attach afterwards.
 *
 * `date_trunc('month', <col> AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'` is the
 * standard two-step idiom for "truncate a timestamptz to a UTC month
 * boundary and hand back a timestamptz" -- it makes the returned bucket
 * independent of the session's own TimeZone GUC, matching
 * `ensure-partitions.ts`'s own UTC-anchored month arithmetic.
 */
export async function discoverDefaultMonths(
  client: PartitionClient,
  table: PartitionedTableConfig,
): Promise<Date[]> {
  const { rows } = await client.query<{ month_start: Date }>(
    `SELECT DISTINCT date_trunc('month', ${table.partitionKeyColumn} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS month_start
       FROM ${table.defaultPartition}
      ORDER BY month_start ASC`,
  );
  return rows.map((r) => new Date(r.month_start));
}

export interface MonthRelocationResult {
  childName: string;
  rowsMoved: number;
  batches: number;
}

/**
 * Moves every row in `table`'s DEFAULT partition whose partition-key value
 * falls in `[monthStart, monthEnd)` into a freestanding child table, then
 * attaches that child via `attachPartitionCheckFirst` (09-01) -- Pitfall
 * 13's mitigation lives ONLY there; this function never restates the
 * CHECK-constraint-first sequence itself.
 *
 * The child is created up front with `CREATE TABLE IF NOT EXISTS <child>
 * (LIKE <parent> INCLUDING ALL)`, matching `attachPartitionCheckFirst`'s own
 * (idempotent) creation step, so it carries the parent's composite primary
 * key, unique constraints and indexes before any row lands in it.
 *
 * The batch loop claims one dedicated connection for the whole month (not a
 * fresh `connect()` per batch) and runs one BEGIN/COMMIT transaction per
 * batch on it, mirroring `campaign-scheduler.worker.ts`'s
 * `findDueCampaignCandidates` try/catch/rollback/finally shape -- the
 * connection is released in `finally` unconditionally once the month is
 * done, whether it succeeded or threw. Each batch is a single statement: a
 * CTE `DELETE ... RETURNING *` claims up to `RELOCATE_BATCH_SIZE` rows with
 * `FOR UPDATE SKIP LOCKED` (skipping rather than blocking on a row a
 * concurrent writer or a concurrent relocation run already has locked) and
 * feeds an `INSERT INTO <child> SELECT * FROM moved` in the SAME statement,
 * so a crash between delete and insert is impossible -- that single-statement
 * atomicity is what conserves rows. The loop stops the first time a batch
 * moves fewer rows than `RELOCATE_BATCH_SIZE`.
 *
 * `adminClient` (10-06, SEC-01/SEC-02): passed straight through to
 * `attachPartitionCheckFirst` below as `options.adminClient` -- the DELETE/
 * INSERT batch loop above never uses it, only the final ATTACH does.
 */
export async function relocateMonth(
  client: PartitionClient,
  adminClient: PartitionClient,
  table: PartitionedTableConfig,
  monthStart: Date,
  monthEnd: Date,
): Promise<MonthRelocationResult> {
  const childName = monthPartitionName(table.parentTable, monthStart);

  // Freestanding, not yet attached -- carries the parent's composite PK,
  // unique constraints and indexes via INCLUDING ALL. Idempotent: a second
  // call for the same month (e.g. a re-run after a partial failure) is a
  // no-op here.
  await client.query(`CREATE TABLE IF NOT EXISTS ${childName} (LIKE ${table.parentTable} INCLUDING ALL)`);

  let rowsMoved = 0;
  let batches = 0;

  const conn = await client.connect();
  try {
    for (;;) {
      let movedThisBatch = 0;
      await conn.query("BEGIN");
      try {
        const { rows } = await conn.query<{ moved_marker: number }>(
          `WITH moved AS (
             DELETE FROM ${table.defaultPartition}
              WHERE ctid IN (
                SELECT ctid FROM ${table.defaultPartition}
                 WHERE ${table.partitionKeyColumn} >= $1 AND ${table.partitionKeyColumn} < $2
                 LIMIT $3
                 FOR UPDATE SKIP LOCKED
              )
             RETURNING *
           )
           INSERT INTO ${childName} SELECT * FROM moved RETURNING 1 AS moved_marker`,
          [monthStart, monthEnd, RELOCATE_BATCH_SIZE],
        );
        movedThisBatch = rows.length;
        await conn.query("COMMIT");
      } catch (err) {
        await conn.query("ROLLBACK").catch(() => undefined);
        throw err;
      }

      rowsMoved += movedThisBatch;
      batches += 1;
      if (movedThisBatch < RELOCATE_BATCH_SIZE) break;
    }
  } finally {
    conn.release();
  }

  // The child's rows are now confirmed to fit [monthStart, monthEnd) --
  // attach it through the one place the CHECK-constraint-first sequence
  // lives. `attachPartitionCheckFirst`'s own CREATE TABLE IF NOT EXISTS is a
  // no-op against the table this function just created and populated. The
  // child is non-empty, so `adminClient` is required here (see this
  // function's own doc comment and `attachPartitionCheckFirst`'s).
  await attachPartitionCheckFirst(client, table, monthStart, monthEnd, { adminClient });

  return { childName, rowsMoved, batches };
}

export interface MonthRelocationReport {
  month: string;
  partitionName: string;
  rowsMoved: number;
  batches: number;
}

export interface TableRelocationReport {
  table: string;
  months: MonthRelocationReport[];
  totalRowsMoved: number;
  /** The DEFAULT partition's row count for this table AFTER the run -- zero on full success. */
  residualDefaultCount: number;
}

export interface RelocationReport {
  tables: TableRelocationReport[];
}

/**
 * 09-REVIEW WR-02: a distinct int8 key from
 * `packages/test-support/src/db-fixture.ts`'s `MIGRATION_ADVISORY_LOCK_KEY`
 * (`8_472_991`) -- two unrelated arbitrary numbers, chosen only so the two
 * locks can never collide under a coincidental shared value.
 */
export const RELOCATE_ADVISORY_LOCK_KEY = 8_472_995;

/**
 * The single callable entrypoint both the operator CLI
 * (`packages/db/scripts/relocate-default-partition-rows.ts`) and the
 * criterion-3 automated test
 * (`__tests__/boundary-crossing-late-automation.test.ts`) call -- D-08's
 * requirement that the documented procedure and the test cannot diverge
 * only holds because there is exactly one implementation.
 *
 * For each table in `tables`: discovers the months actually present in
 * DEFAULT, relocates each one (in ascending month order), then re-counts
 * DEFAULT and reports the residual. A table whose DEFAULT is already empty
 * discovers zero months and contributes an all-zero report entry -- this is
 * what makes a re-run against an already-relocated database idempotent and
 * silent rather than a special case.
 *
 * 09-REVIEW WR-02: `CREATE TABLE IF NOT EXISTS` (used by `relocateMonth`
 * below) is not atomic against genuine concurrency -- two sessions can both
 * pass the existence check and both attempt the `CREATE`, one raising a
 * duplicate-relation error instead of a clean, actionable message. This
 * takes a session-scoped Postgres advisory lock (`pg_try_advisory_lock`,
 * non-blocking) on a DEDICATED connection for the whole function's
 * duration, released explicitly before that connection is returned to the
 * pool -- a plain `conn.release()` would NOT release the lock itself (an
 * advisory lock lives for the physical session, not the pooled-client
 * checkout), which would otherwise leave a "permanently held" lock the
 * moment that connection is recycled for something else. A second
 * concurrent invocation fails fast with a clear error instead of racing
 * `relocateMonth`'s own DDL.
 *
 * Returns the report rather than printing anything -- the CLI formats it
 * for a human, the tests assert on its shape.
 *
 * `adminClient` (10-06, SEC-01/SEC-02, checkpoint option-b): a connection
 * source backed by a role capable of bypassing row-level security --
 * threaded straight through to every `relocateMonth` call below, which needs
 * it for its own `attachPartitionCheckFirst` call. Required, not optional:
 * every month this function relocates attaches a non-empty child.
 */
export async function relocateAllDefaultRows(
  client: PartitionClient,
  adminClient: PartitionClient,
  tables: readonly PartitionedTableConfig[],
): Promise<RelocationReport> {
  const lockConn = await client.connect();
  let locked = false;
  try {
    const { rows } = await lockConn.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [RELOCATE_ADVISORY_LOCK_KEY],
    );
    locked = rows[0]?.locked ?? false;
    if (!locked) {
      throw new Error(
        "relocateAllDefaultRows: another DEFAULT-relocation run already holds the relocation advisory " +
          "lock against this database -- concurrent invocations are unsupported (CREATE TABLE IF NOT EXISTS " +
          "is not atomic against genuine concurrency). Wait for the other invocation to finish before retrying.",
      );
    }

    const tableReports: TableRelocationReport[] = [];

    for (const table of tables) {
      const months = await discoverDefaultMonths(client, table);
      const monthReports: MonthRelocationReport[] = [];

      for (const monthStart of months) {
        const monthEnd = nextMonthStart(monthStart);
        const { childName, rowsMoved, batches } = await relocateMonth(
          client,
          adminClient,
          table,
          monthStart,
          monthEnd,
        );
        monthReports.push({
          month: monthLabel(monthStart),
          partitionName: childName,
          rowsMoved,
          batches,
        });
      }

      const residualDefaultCount = await countDefaultRowsForTable(client, table);
      tableReports.push({
        table: table.parentTable,
        months: monthReports,
        totalRowsMoved: monthReports.reduce((sum, m) => sum + m.rowsMoved, 0),
        residualDefaultCount,
      });
    }

    return { tables: tableReports };
  } finally {
    try {
      if (locked) {
        await lockConn.query("SELECT pg_advisory_unlock($1)", [RELOCATE_ADVISORY_LOCK_KEY]);
      }
    } finally {
      lockConn.release();
    }
  }
}
