/**
 * 09-01 (DB-01/DB-02, D-02/D-10): DEFAULT-row counting, the
 * `partition_maintenance_runs` health-row upsert/read, and the composed
 * `runPartitionMaintenance` the daily worker (09-02) calls every tick. This
 * is the WORKER side of the two-process dead-man's-switch (RESEARCH.md
 * Pattern 2) -- `apps/api/src/modules/ops/partition-watchdog.ts` is the
 * separate-process READER of the row this module writes.
 */

import {
  ensurePartitions,
  PARTITIONED_TABLES,
  type PartitionClient,
  type PartitionedTableConfig,
} from "./ensure-partitions.js";
import {
  dropExpiredPartitions,
  isRetentionEnabled,
  PARTITION_RETENTION_MONTHS,
  RETENTION_ELIGIBLE_TABLES,
  type PartitionDropRecord,
} from "./retention.js";

/**
 * Phase 14 plan 12 (DB-11, D-08): "disabled" is what every run writes while
 * the retention enable flag is unset -- the only value any committed deploy
 * of this codebase can reach. "ok" means the retention step ran (with or
 * without anything actually eligible to drop); "failed" means the step
 * itself threw. See `runPartitionMaintenance`'s own comment for why a
 * retention failure never prevents the partition-CREATION half of this same
 * run from being recorded.
 */
export type RetentionRunStatus = "disabled" | "ok" | "failed";

export interface MaintenanceRunSnapshot {
  lastRunAt: Date;
  lookaheadMonths: number;
  bufferAlertThresholdMonths: number;
  eventsBufferMonths: number;
  sendEventsBufferMonths: number;
  /** The minimum of the two per-table buffers -- one healthy table can never mask an exhausted one. */
  bufferMonthsRemaining: number;
  eventsDefaultCount: number;
  sendEventsDefaultCount: number;
  partitionsCreated: string[];
  /** DB-11: disabled | ok | failed for THIS run's retention step -- never a default-true trap. */
  retentionStatus: RetentionRunStatus;
  /** Populated only alongside `retentionStatus === "failed"`. */
  retentionError: string | null;
  /** Names only (mirrors `partitionsCreated`) -- the full per-drop record lives in `partition_retention_drops`. */
  partitionsDropped: string[];
}

export interface PartitionMaintenanceRunRow extends MaintenanceRunSnapshot {
  id: number;
  /** Owned exclusively by the watchdog (apps/api) -- this module never writes it. */
  lastAlertSentAt: Date | null;
  updatedAt: Date;
}

export interface RunPartitionMaintenanceOptions {
  lookaheadMonths: number;
  bufferAlertThresholdMonths: number;
  /** Test-only override; defaults to the real `retention.ts` flag check against `process.env`. */
  isRetentionEnabledFn?: typeof isRetentionEnabled;
  /** Test-only override; defaults to the real `retention.ts` catalog-driven drop. */
  dropExpiredPartitionsFn?: typeof dropExpiredPartitions;
}

/**
 * D-10: one `SELECT count(*)` per `_default` partition -- cheap in the
 * normal case (both DEFAULTs are empty), and this is exactly the daily
 * check that closes the "automation ran late, DEFAULT already holds rows"
 * detection loop (detection -> operator -> the 09-04 relocation script).
 * Returns a map keyed by `parentTable` so it stays generic over
 * `PARTITIONED_TABLES` rather than hard-coding `events`/`send_events` here.
 */
export async function countDefaultRows(
  client: PartitionClient,
  tables: readonly PartitionedTableConfig[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${table.defaultPartition}`,
    );
    counts[table.parentTable] = Number(rows[0]?.count ?? 0);
  }
  return counts;
}

/**
 * `INSERT ... VALUES (1, ...) ON CONFLICT (id) DO UPDATE SET` against the
 * singleton row -- lists ONLY the worker-owned columns plus `updated_at`.
 * Deliberately never touches `last_alert_sent_at`: that column belongs to
 * the watchdog process (apps/api), and a maintenance run must never reset an
 * in-flight alert-dedup window just by running.
 */
export async function recordMaintenanceRun(
  client: PartitionClient,
  snapshot: MaintenanceRunSnapshot,
): Promise<void> {
  await client.query(
    `INSERT INTO partition_maintenance_runs (
       id, last_run_at, lookahead_months, buffer_alert_threshold_months,
       events_buffer_months, send_events_buffer_months, buffer_months_remaining,
       events_default_count, send_events_default_count, partitions_created, updated_at,
       retention_status, retention_error, partitions_dropped
     ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11, $12)
     ON CONFLICT (id) DO UPDATE SET
       last_run_at = EXCLUDED.last_run_at,
       lookahead_months = EXCLUDED.lookahead_months,
       buffer_alert_threshold_months = EXCLUDED.buffer_alert_threshold_months,
       events_buffer_months = EXCLUDED.events_buffer_months,
       send_events_buffer_months = EXCLUDED.send_events_buffer_months,
       buffer_months_remaining = EXCLUDED.buffer_months_remaining,
       events_default_count = EXCLUDED.events_default_count,
       send_events_default_count = EXCLUDED.send_events_default_count,
       partitions_created = EXCLUDED.partitions_created,
       updated_at = now(),
       retention_status = EXCLUDED.retention_status,
       retention_error = EXCLUDED.retention_error,
       partitions_dropped = EXCLUDED.partitions_dropped`,
    [
      snapshot.lastRunAt,
      snapshot.lookaheadMonths,
      snapshot.bufferAlertThresholdMonths,
      snapshot.eventsBufferMonths,
      snapshot.sendEventsBufferMonths,
      snapshot.bufferMonthsRemaining,
      snapshot.eventsDefaultCount,
      snapshot.sendEventsDefaultCount,
      snapshot.partitionsCreated,
      snapshot.retentionStatus,
      snapshot.retentionError,
      snapshot.partitionsDropped,
    ],
  );
}

/**
 * DB-11 / T-14-79: the append-only "what did retention remove and when"
 * history the singleton `partition_maintenance_runs` row cannot hold (it is
 * upserted every tick, so it only ever describes the MOST RECENT run). One
 * INSERT per drop, called only when `dropExpiredPartitions` actually
 * returned something -- an empty `drops` array is a genuine no-op, never an
 * empty INSERT statement.
 */
export async function recordPartitionDrops(
  client: PartitionClient,
  drops: readonly PartitionDropRecord[],
): Promise<void> {
  for (const drop of drops) {
    await client.query(
      `INSERT INTO partition_retention_drops (
         parent_table, partition_name, range_start, range_end, horizon_months, dropped_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [drop.parentTable, drop.partitionName, drop.rangeStart, drop.rangeEnd, drop.horizonMonths, drop.droppedAt],
    );
  }
}

interface RawMaintenanceRunRow {
  id: number;
  last_run_at: Date;
  lookahead_months: number;
  buffer_alert_threshold_months: number;
  events_buffer_months: number;
  send_events_buffer_months: number;
  buffer_months_remaining: number;
  events_default_count: string;
  send_events_default_count: string;
  partitions_created: string[];
  last_alert_sent_at: Date | null;
  updated_at: Date;
  retention_status: RetentionRunStatus;
  retention_error: string | null;
  partitions_dropped: string[];
}

function mapRow(row: RawMaintenanceRunRow): PartitionMaintenanceRunRow {
  return {
    id: row.id,
    lastRunAt: row.last_run_at,
    lookaheadMonths: row.lookahead_months,
    bufferAlertThresholdMonths: row.buffer_alert_threshold_months,
    eventsBufferMonths: row.events_buffer_months,
    sendEventsBufferMonths: row.send_events_buffer_months,
    bufferMonthsRemaining: row.buffer_months_remaining,
    // bigint columns come back from node-postgres as strings by default.
    eventsDefaultCount: Number(row.events_default_count),
    sendEventsDefaultCount: Number(row.send_events_default_count),
    partitionsCreated: row.partitions_created,
    lastAlertSentAt: row.last_alert_sent_at,
    updatedAt: row.updated_at,
    retentionStatus: row.retention_status,
    retentionError: row.retention_error,
    partitionsDropped: row.partitions_dropped,
  };
}

/** Reads the singleton health row, or `null` if the maintenance job has never recorded one. */
export async function readLatestMaintenanceRun(
  client: PartitionClient,
): Promise<PartitionMaintenanceRunRow | null> {
  const { rows } = await client.query<RawMaintenanceRunRow>(
    `SELECT id, last_run_at, lookahead_months, buffer_alert_threshold_months,
            events_buffer_months, send_events_buffer_months, buffer_months_remaining,
            events_default_count, send_events_default_count, partitions_created,
            last_alert_sent_at, updated_at, retention_status, retention_error, partitions_dropped
       FROM partition_maintenance_runs
      WHERE id = 1`,
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Composes the tick's full body, in order: `ensurePartitions` (creates any
 * missing months and yields each table's pre-run buffer via the same
 * forward walk), `countDefaultRows` (D-10), the DB-11 retention step, then
 * ONE `recordMaintenanceRun` call carrying everything. Creation runs FIRST
 * deliberately (Phase 9's whole reason for existing -- creation has a real
 * deadline; a day-late retention drop does not) and its own recorded fields
 * are computed and captured BEFORE the retention step ever runs, so a
 * retention failure can never affect them.
 *
 * Retention itself is wrapped in its OWN try/catch (unlike `ensurePartitions`
 * above, which is deliberately left to throw and abort the whole run): D-08
 * makes retention a lower-priority, catch-up-tolerant step, and Task 2's own
 * acceptance criteria require a retention failure to still leave the
 * creation work recorded, distinguishably from "retention was disabled" --
 * `retentionStatus` carries that distinction (`disabled` | `ok` | `failed`),
 * and `retentionError` carries the failure's own message for
 * `retentionStatus === "failed"`. The caller (the worker's own
 * `processPartitionMaintenance`) is responsible for LOGGING a `"failed"`
 * status loudly -- this module stays pure DB composition, matching every
 * other function in this file.
 *
 * `isRetentionEnabledFn`/`dropExpiredPartitionsFn` default to the real
 * `retention.ts` implementations; overridable for tests only (mirrors this
 * file's own existing test-injection precedent in
 * `apps/worker/src/queues/partition-maintenance.worker.ts`'s
 * `ProcessPartitionMaintenanceDeps`).
 *
 * Returns the snapshot so a caller (the worker's own logging) can inspect
 * what just happened.
 */
export async function runPartitionMaintenance(
  client: PartitionClient,
  now: Date,
  options: RunPartitionMaintenanceOptions,
): Promise<MaintenanceRunSnapshot> {
  const ensureResults = await ensurePartitions(client, PARTITIONED_TABLES, now, options.lookaheadMonths);

  const eventsResult = ensureResults.find((r) => r.table === "events");
  const sendEventsResult = ensureResults.find((r) => r.table === "send_events");
  if (!eventsResult || !sendEventsResult) {
    throw new Error(
      "runPartitionMaintenance expects PARTITIONED_TABLES to include both 'events' and 'send_events'",
    );
  }

  const defaultCounts = await countDefaultRows(client, PARTITIONED_TABLES);
  const partitionsCreated = [...eventsResult.created, ...sendEventsResult.created];

  const checkRetentionEnabled = options.isRetentionEnabledFn ?? isRetentionEnabled;
  const dropExpiredPartitionsFn = options.dropExpiredPartitionsFn ?? dropExpiredPartitions;

  let retentionStatus: RetentionRunStatus = "disabled";
  let retentionError: string | null = null;
  let partitionsDropped: string[] = [];

  if (checkRetentionEnabled()) {
    try {
      const drops = await dropExpiredPartitionsFn(client, RETENTION_ELIGIBLE_TABLES, now, PARTITION_RETENTION_MONTHS);
      if (drops.length > 0) {
        await recordPartitionDrops(client, drops);
      }
      retentionStatus = "ok";
      partitionsDropped = drops.map((d) => d.partitionName);
    } catch (err) {
      retentionStatus = "failed";
      retentionError = err instanceof Error ? err.message : String(err);
    }
  }

  const snapshot: MaintenanceRunSnapshot = {
    lastRunAt: now,
    lookaheadMonths: options.lookaheadMonths,
    bufferAlertThresholdMonths: options.bufferAlertThresholdMonths,
    eventsBufferMonths: eventsResult.bufferMonths,
    sendEventsBufferMonths: sendEventsResult.bufferMonths,
    bufferMonthsRemaining: Math.min(eventsResult.bufferMonths, sendEventsResult.bufferMonths),
    eventsDefaultCount: defaultCounts.events ?? 0,
    sendEventsDefaultCount: defaultCounts.send_events ?? 0,
    partitionsCreated,
    retentionStatus,
    retentionError,
    partitionsDropped,
  };

  await recordMaintenanceRun(client, snapshot);
  return snapshot;
}
