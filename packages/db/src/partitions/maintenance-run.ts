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
       events_default_count, send_events_default_count, partitions_created, updated_at
     ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
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
       updated_at = now()`,
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
    ],
  );
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
            last_alert_sent_at, updated_at
       FROM partition_maintenance_runs
      WHERE id = 1`,
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Composes the three: `ensurePartitions` (creates any missing months and
 * yields each table's pre-run buffer via the same forward walk),
 * `countDefaultRows` (D-10), then `recordMaintenanceRun` with
 * `buffer_months_remaining` set to the MINIMUM of the per-table buffers
 * (never an average -- one healthy table must never mask an exhausted one,
 * see the phase's assumption-delta decision on the now-primary
 * `(partitioned table, month)` pair). No internal try/catch: a DDL failure
 * inside `ensurePartitions` throws, the row is simply never written this
 * run, and the watchdog's own staleness check catches that on its next poll.
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
  };

  await recordMaintenanceRun(client, snapshot);
  return snapshot;
}
