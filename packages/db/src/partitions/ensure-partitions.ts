/**
 * 09-01 (DB-01/DB-02, D-05): the single source of partition DDL for `events`
 * and `send_events`. Called from three places across this phase's plans: the
 * daily maintenance worker (09-02), `packages/test-support`'s db-fixture
 * provisioning of ephemeral test databases, and this plan's own tracer test.
 *
 * The client parameter is typed as a minimal STRUCTURAL interface below, and
 * this file never imports a concrete class from the `pg` driver package
 * (RESEARCH.md Pitfall 5): a concrete `Pool`/`PoolClient` type import would
 * break the moment this function is called from `packages/test-support`'s own
 * pool, which resolves through a different `pg` driver import graph than
 * `packages/db`'s own dependency. `pg.Pool`/`pg.PoolClient` already satisfy
 * `PartitionClient`/`PartitionConnection` structurally -- nothing here needs
 * to know that, or import from "pg" to prove it.
 *
 * Threat T-09-01 (Tampering): partition and table identifiers are built ONLY
 * from `Date` calendar arithmetic against the frozen `PARTITIONED_TABLES`
 * allowlist below -- never from row data. Postgres cannot parameterise a
 * partition bound or an identifier inside DDL, so every DDL statement in this
 * file formats its bounds from computed `Date` values only (never from a
 * caller-supplied string); every DML query in this file that filters on a
 * date range uses a real bind parameter ($1, $2) instead.
 */

/** A raw query result shaped like node-postgres's `QueryResult`, structurally. */
export interface PartitionQueryResult<T = unknown> {
  rows: T[];
}

/** A dedicated connection checked out of a pool -- has its own transaction state. */
export interface PartitionConnection {
  query<T = unknown>(queryText: string, params?: unknown[]): Promise<PartitionQueryResult<T>>;
  release(err?: unknown): void;
}

/**
 * Minimal structural client interface, mirroring
 * `packages/test-support/src/migration-runner.ts`'s `MigrationClient`
 * (query-only) but widened with `connect()` -- `attachPartitionCheckFirst`
 * needs a single dedicated connection to run its five-statement sequence
 * inside one real transaction (BEGIN/COMMIT/ROLLBACK on the SAME connection),
 * which a bare pool-level `.query()` call cannot provide (each pool `.query()`
 * call may be served by a different physical connection).
 */
export interface PartitionClient {
  query<T = unknown>(queryText: string, params?: unknown[]): Promise<PartitionQueryResult<T>>;
  connect(): Promise<PartitionConnection>;
}

export interface PartitionedTableConfig {
  /** e.g. "events" | "send_events" -- the RANGE-partitioned parent table. */
  parentTable: string;
  /** e.g. "events_default" | "send_events_default" -- the pre-existing DEFAULT
   * partition (0010/0020) this module never creates, only defends via
   * `attachPartitionCheckFirst`. */
  defaultPartition: string;
  /** e.g. "occurred_at" -- the RANGE partition key column. */
  partitionKeyColumn: string;
}

// D-11/D-12/D-13: lookahead, alert threshold, and cron schedule are
// versioned CODE constants, never env vars -- a weakening of any of the
// three must be visible in a diff or a failing review, matching the
// SCAN_INTERVAL_MS / RECONCILE_INTERVAL_MS convention already established by
// campaign-scheduler.worker.ts / analytics-reconciliation.worker.ts.
// LOOKAHEAD_MONTHS and BUFFER_ALERT_THRESHOLD_MONTHS are kept adjacent in
// this ONE file deliberately -- D-12 requires drift between the two to be
// catchable by review, not hidden across files.

/** D-11: partitions are created 3 months ahead of the month containing `now`. */
export const LOOKAHEAD_MONTHS = 3;

/**
 * D-11: alert when fewer than 2 months of partition buffer remain -- a full
 * month of slack below the +3 steady state, so a stalled maintenance job has
 * roughly 30 days to be noticed before any row can reach a DEFAULT partition.
 */
export const BUFFER_ALERT_THRESHOLD_MONTHS = 2;

/**
 * D-13: a fixed UTC hour (03:00), not `every` from worker boot time --
 * predictable for the operator, and gives the API-side watchdog a clean
 * "last run older than N hours" staleness threshold to check against.
 */
export const PARTITION_MAINTENANCE_CRON = "0 3 * * *";

/**
 * The two tables this phase automates. Frozen (and each entry frozen) so a
 * caller cannot mutate the allowlist at runtime -- this array IS the identity
 * boundary threat T-09-01 depends on: only these two parent/default pairs are
 * ever named in generated DDL.
 */
export const PARTITIONED_TABLES: readonly PartitionedTableConfig[] = Object.freeze([
  Object.freeze({
    parentTable: "events",
    defaultPartition: "events_default",
    partitionKeyColumn: "occurred_at",
  }),
  Object.freeze({
    parentTable: "send_events",
    defaultPartition: "send_events_default",
    partitionKeyColumn: "occurred_at",
  }),
]);

/** Zero-pad to `len` digits. */
function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

/**
 * Formats a UTC `Date` as an explicit-offset Postgres timestamp literal body
 * (no surrounding quotes) -- e.g. `2026-09-01 00:00:00+00`. Independent of the
 * session TimeZone in effect when the DDL runs, per T-09-01's identifier/bound
 * discipline: this only ever receives `Date` objects produced by calendar
 * arithmetic in this file, never a value derived from a database row.
 */
function utcTimestampLiteral(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00`;
}

/**
 * Returns the `[start, end)` UTC month boundary for `year`/`monthIndex`
 * (0-based, JS `Date` convention) as explicit-offset timestamp literal
 * bodies. Both `ensurePartitions`'s own walk and `attachPartitionCheckFirst`
 * go through this single function, so the exact same bound is always used
 * for both the CHECK constraint and the ATTACH statement for a given month --
 * they can never silently diverge.
 */
export function monthRangeUtc(year: number, monthIndex: number): { start: string; end: string } {
  const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
  return { start: utcTimestampLiteral(start), end: utcTimestampLiteral(end) };
}

/**
 * `<parentTable>_YYYY_MM`, derived ONLY from calendar arithmetic on `date`
 * (read via its UTC fields) -- never from row data. This, plus the hard-coded
 * `PARTITIONED_TABLES` allowlist for `parentTable`, is the injection
 * mitigation for threat T-09-01: Postgres cannot parameterise a DDL
 * identifier, so the only safe way to build one is to construct it from
 * values the application fully controls.
 */
export function monthPartitionName(parentTable: string, date: Date): string {
  return `${parentTable}_${date.getUTCFullYear()}_${pad(date.getUTCMonth() + 1)}`;
}

/** The UTC first-of-month `Date` that is `monthsAhead` months after the month containing `from`. */
function monthStartUtc(from: Date, monthsAhead: number): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + monthsAhead, 1, 0, 0, 0, 0));
}

async function partitionExists(client: PartitionClient, name: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${name}`],
  );
  return rows[0]?.exists ?? false;
}

/**
 * Pitfall 13 / Pattern 3 (RESEARCH.md), quoted from PostgreSQL's own docs:
 * before attaching a partition to a table that has a DEFAULT partition,
 * Postgres will otherwise scan the DEFAULT partition under an
 * ACCESS EXCLUSIVE lock to prove it holds no rows in the new range. Adding a
 * validated CHECK constraint on DEFAULT that excludes the new range first
 * lets Postgres skip that scan entirely.
 *
 * Applied UNCONDITIONALLY on every attach (RESEARCH.md Open Question 1,
 * resolved) -- not gated on first checking whether DEFAULT actually holds
 * rows -- because this phase exists precisely because "safe by default"
 * already failed once (T-09-06). The five-statement sequence for one month
 * runs inside a SINGLE transaction on one dedicated connection (BEGIN /
 * COMMIT, ROLLBACK on error, connection released in `finally`), the same
 * shape `apps/worker/src/queues/campaign-scheduler.worker.ts`'s
 * `findDueCampaignCandidates` uses -- a crash between CREATE and ATTACH must
 * never leave a freestanding, RLS-less `events_YYYY_MM`/`send_events_YYYY_MM`
 * table holding `workspace_id` data (threat T-09-02).
 *
 * Returns the created/attached partition's name.
 */
export async function attachPartitionCheckFirst(
  client: PartitionClient,
  table: PartitionedTableConfig,
  monthStart: Date,
  monthEnd: Date,
): Promise<string> {
  const childName = monthPartitionName(table.parentTable, monthStart);
  const constraintName = `excl_${childName}`;
  const startLiteral = utcTimestampLiteral(monthStart);
  const endLiteral = utcTimestampLiteral(monthEnd);

  const conn = await client.connect();
  try {
    await conn.query("BEGIN");

    // 09-04: some callers (the DEFAULT-relocation procedure) attach a child
    // already populated with real rows, not just an empty new month.
    // PostgreSQL automatically re-validates a partitioned table's inherited
    // FOREIGN KEY constraints against the referenced table whenever a
    // NON-EMPTY child is attached -- for events.contact_id -> contacts(id)
    // and send_events.send_id -> sends(id), both referenced tables carry
    // FORCE ROW LEVEL SECURITY, so without a visibility grant that internal
    // scan would see zero contacts/sends rows (no single
    // app.current_workspace_id can cover a backlog spanning many tenants at
    // once) and the ATTACH would fail with a spurious FK violation. The
    // migration 0039 SELECT-only `partition_relocation_admin_scan` policy
    // (same admin-scan-gated precedent as campaign_scheduler_due_scan /
    // flow_runs_due_scan / flows_segment_sweep_scan) grants exactly that
    // visibility, scoped to this transaction only via SET LOCAL semantics
    // (set_config's third argument) -- it reverts automatically on
    // COMMIT/ROLLBACK and never leaks into a later pooled query. A no-op for
    // every EMPTY-child attach (09-01's own callers): zero rows means the FK
    // validation trivially passes regardless of visibility.
    //
    // This relies on `client` never being a connection that has previously
    // run a tenant-scoped `SET LOCAL app.current_workspace_id` (0039's own
    // comment has the full reasoning: contacts/sends are PRE-PHASE-10
    // bare-cast RLS baselines -- see
    // packages/tenant-context/src/__tests__/tenant-context.test.ts -- and a
    // recycled connection's reverted-to-'' GUC throws inside the OTHER
    // (bare-cast) permissive policy regardless of this one). In production
    // the maintenance worker/CLI script that owns `client` here constructs
    // its own dedicated pool, never shared with the app's tenant-scoped
    // `@mega-crm/tenant-context` pool, so this invariant holds by
    // construction, not by convention.
    await conn.query("SELECT set_config('app.admin_scan', 'true', true)");

    // 1. Freestanding table, not yet attached -- fast, no lock contention
    // with the parent (0007/0010's `LIKE ... INCLUDING ALL` precedent).
    await conn.query(`CREATE TABLE IF NOT EXISTS ${childName} (LIKE ${table.parentTable} INCLUDING ALL)`);

    // 2. Metadata-only, no scan (ACCESS EXCLUSIVE on DEFAULT, but brief).
    await conn.query(
      `ALTER TABLE ${table.defaultPartition} ADD CONSTRAINT ${constraintName}
         CHECK (${table.partitionKeyColumn} < '${startLiteral}' OR ${table.partitionKeyColumn} >= '${endLiteral}')
         NOT VALID`,
    );

    // 3. Scans DEFAULT, but under SHARE UPDATE EXCLUSIVE -- concurrent reads
    // and writes continue.
    await conn.query(`ALTER TABLE ${table.defaultPartition} VALIDATE CONSTRAINT ${constraintName}`);

    // 4. Now fast -- Postgres trusts the just-validated constraint and skips
    // its own scan of DEFAULT entirely.
    await conn.query(
      `ALTER TABLE ${table.parentTable} ATTACH PARTITION ${childName}
         FOR VALUES FROM ('${startLiteral}') TO ('${endLiteral}')`,
    );

    // 5. Redundant once the partition boundary itself enforces the same
    // thing -- cleanup, not a correctness requirement.
    await conn.query(`ALTER TABLE ${table.defaultPartition} DROP CONSTRAINT ${constraintName}`);

    await conn.query("COMMIT");
    return childName;
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Pitfall 2 (RESEARCH.md): the buffer is the count of CONSECUTIVE months,
 * starting at the month containing `now` (index 0 of `monthPresence`), that
 * already had a partition BEFORE this run attempted to create anything --
 * stopping at the first gap -- minus 1 (the current month itself is not
 * "buffer"; buffer is coverage beyond the current month). A raw count of
 * "how many future partitions exist" would overstate the buffer whenever
 * month N+1 is missing but N+2 exists, masking an imminent DEFAULT-routing
 * failure.
 *
 * Exported and pure so `ensurePartitions`'s own forward walk (below) and any
 * other caller inspecting a known presence sequence compute buffer from the
 * exact same rule -- the two can never diverge because there is only one
 * function that does this arithmetic.
 */
export function computeBufferMonths(monthPresence: readonly boolean[]): number {
  let consecutive = 0;
  for (const present of monthPresence) {
    if (!present) break;
    consecutive++;
  }
  return consecutive - 1;
}

export interface PartitionEnsureResult {
  table: string;
  /** Partitions actually created THIS call -- empty on a pure no-op run, which is what makes idempotency observable. */
  created: string[];
  /**
   * Pitfall 2: computed from the state as found BEFORE this call created
   * anything, so a caller that manufactures a gap and then calls
   * `ensurePartitions` (which self-heals the gap in the same call) still
   * observes the pre-run buffer here, not a post-heal "everything's fine
   * now" number that would mask the very condition being measured.
   */
  bufferMonths: number;
}

/**
 * D-05: the single entry point that creates every missing partition for
 * `tables`, walking months `0..lookaheadMonths` forward (inclusive) from the
 * UTC month containing `now`. For each table this always walks the FULL
 * range unconditionally (never stops early at the first gap) -- Pitfall 13's
 * lesson is "safe by default already failed once", so every month in range
 * gets checked and, if missing, created via `attachPartitionCheckFirst`
 * regardless of what came before it in the walk.
 *
 * No try/catch wraps this loop: `CREATE TABLE IF NOT EXISTS` already makes
 * creation idempotent (a second identical call reports zero `created`), and
 * an unhandled throw from `attachPartitionCheckFirst` is deliberately left to
 * propagate -- the caller (the maintenance worker, or a test) owns error
 * handling, and a DDL failure must surface as a loud failure, not be
 * swallowed here.
 */
export async function ensurePartitions(
  client: PartitionClient,
  tables: readonly PartitionedTableConfig[],
  now: Date,
  lookaheadMonths: number,
): Promise<PartitionEnsureResult[]> {
  const results: PartitionEnsureResult[] = [];

  for (const table of tables) {
    const created: string[] = [];
    const monthPresence: boolean[] = [];

    for (let offset = 0; offset <= lookaheadMonths; offset++) {
      const monthStart = monthStartUtc(now, offset);
      const monthEnd = monthStartUtc(now, offset + 1);
      const childName = monthPartitionName(table.parentTable, monthStart);

      const existedBefore = await partitionExists(client, childName);
      monthPresence.push(existedBefore);

      if (!existedBefore) {
        const attachedName = await attachPartitionCheckFirst(client, table, monthStart, monthEnd);
        created.push(attachedName);
      }
    }

    results.push({
      table: table.parentTable,
      created,
      bufferMonths: computeBufferMonths(monthPresence),
    });
  }

  return results;
}
