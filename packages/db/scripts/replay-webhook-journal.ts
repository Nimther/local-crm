import { Pool } from "pg";
import { Queue } from "bullmq";
import { buildJobOptions, buildRedisConnectionOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import { buildWebhookEventsJobPayload, WEBHOOK_EVENTS_QUEUE, type WebhookEventsJob } from "@mega-crm/shared-schemas";

import { resolveEnvPath } from "../../../scripts/env-path.mjs";

/**
 * Phase 13 (CMP-08, D-06, plan 13-06), Task 3 -- an operator-invoked CLI for
 * a SURGICAL re-run of a `received_at` range for exactly one workspace's
 * `ingress_journal`, following `relocate-default-partition-rows.ts`'s
 * operator-CLI shape (Phase 9, D-08): argument parsing first, then a
 * dedicated `Pool` (never `@mega-crm/tenant-context`'s module-load-time
 * pool, which is constructed from `process.env.DATABASE_URL` at IMPORT
 * time -- before this file's own `resolveEnvPath()` load has run), then a
 * bounded, paged operation with a `--dry-run` option and a printed running
 * count.
 *
 * DIFFERENT from `webhook-replay-sweep.worker.ts`'s automatic sweep on
 * purpose (D-06 vs. D-07): the sweep only re-enqueues rows with
 * `ingestion_completed_at IS NULL` (an incomplete batch); THIS script
 * re-enqueues EVERY row in the requested range, including rows already
 * marked ingested. Its purpose is a surgical re-run after a bug fix
 * misprocessed a window -- in that scenario the rows WERE "ingested",
 * incorrectly, and the whole point of running this is to reprocess them
 * under the fixed code. Re-running an already-correct row is harmless: the
 * `send_events` insert is `ON CONFLICT (workspace_id, sg_event_id,
 * occurred_at) DO NOTHING` and every side effect is gated on a genuinely-new
 * row (webhook-events.worker.ts), so replaying a correct row is a no-op
 * rather than a double-count.
 *
 * There is exactly ONE row this script still must skip: a tombstone
 * (`payload_purged_at IS NOT NULL`, plan 13-01/13-06's retention split).
 * The REASON differs from the sweep's own tombstone skip and is stated here
 * rather than left to look like the same filter: the sweep skips a
 * tombstone because it cannot make progress against a poison batch that has
 * already reached the attempt cap or aged past the retention horizon; this
 * script skips it because there is LITERALLY NOTHING TO SEND -- Task 2's
 * retention step nulled `raw_batch`, so enqueueing one would push an empty
 * payload through the worker and burn a `replay_count` increment against
 * nothing. Skipped rows are counted and reported in the final summary
 * (never silently dropped): an operator running a surgical range replay
 * after an incident needs to learn that part of their requested window is
 * permanently unrecoverable -- a summary that just reported a lower
 * enqueued count would let them believe the replay was complete.
 *
 * Reuses `webhook-replay-sweep.worker.ts`'s own building blocks rather than
 * inventing a third, independently-maintained enqueue path: the SAME shared
 * pure `buildWebhookEventsJobPayload` (`@mega-crm/shared-schemas`) that both
 * the api route's producer (`enqueue.ts`) and the sweep's producer use, and
 * the SAME `UPDATE ingress_journal SET replay_count = replay_count + 1 ...
 * RETURNING raw_batch` shape the sweep uses for its own bookkeeping.
 * `packages/db` never imports `apps/worker` -- that would invert this
 * repository's package hierarchy (packages are depended ON by apps, never
 * the reverse) -- so "reuse" here means calling the same low-level shared
 * primitives both producers already share, not a cross-package import of
 * the sweep's own module.
 *
 * Requires an explicit `--workspace <id>` with NO all-workspaces mode --
 * mirrors Phase 9 D-08's rule that row relocation (and, here, replay) is
 * operator-invoked and scoped, never scheduled or blast-radius-unbounded. A
 * mistyped range across every tenant at once is exactly the kind of blast
 * radius an operator tool should make impossible, not merely discouraged.
 *
 * Argument validation runs and fails BEFORE any database or Redis
 * connection is attempted (REVIEWS.md LOW finding: the earlier verify line
 * asserted nothing at all) -- `<verify>`'s automated line asserts a
 * non-zero exit for a missing `--workspace`, and that assertion would
 * silently depend on a reachable database if connection happened first.
 */

const DEFAULT_PAGE_SIZE = 500;

/** The smallest possible UUID -- every real `ingress_journal.id` sorts strictly after it, making it a safe initial keyset-pagination cursor. */
const MIN_UUID = "00000000-0000-0000-0000-000000000000";

interface CliArgs {
  workspaceId: string;
  from: string;
  to: string;
  dryRun: boolean;
  pageSize: number;
}

/**
 * Parses and validates argv, throwing a descriptive `Error` on the first
 * problem found. Runs with NO side effects (no env load, no connection) --
 * see this file's own header comment for why that ordering matters.
 */
export function parseArgs(argv: string[]): CliArgs {
  const flags = new Map<string, string>();
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`--${key} requires a value`);
      }
      flags.set(key, value);
      i += 1;
    }
  }

  const workspaceId = flags.get("workspace");
  if (!workspaceId) {
    throw new Error(
      "replay-webhook-journal requires --workspace <id> -- there is no all-workspaces mode. " +
        "A mistyped range across every tenant at once is exactly the blast radius this tool refuses to allow."
    );
  }

  const from = flags.get("from");
  const to = flags.get("to");
  if (!from || !to) {
    throw new Error("replay-webhook-journal requires --from <iso-timestamp> and --to <iso-timestamp>");
  }
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    throw new Error(`--from/--to must be valid ISO-8601 timestamps (got --from=${from} --to=${to})`);
  }
  if (fromMs > toMs) {
    throw new Error(`--from (${from}) must not be after --to (${to})`);
  }

  const pageSizeRaw = flags.get("page-size");
  const pageSize = pageSizeRaw !== undefined ? Number(pageSizeRaw) : DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`--page-size must be a positive integer (got ${pageSizeRaw ?? "unset"})`);
  }

  return { workspaceId, from, to, dryRun, pageSize };
}

interface JournalPageRow {
  id: string;
  rawBatch: unknown;
  payloadPurgedAt: Date | null;
  receivedAtIso: string;
}

/**
 * Fetches one keyset-paginated page (`(received_at, id) > (cursorReceivedAt,
 * cursorId)`, bounded above by `args.to`) and, for a real (non-dry-run)
 * invocation, increments `replay_count` for every row on the page EXCEPT a
 * tombstone in the SAME transaction as the SELECT -- mirroring
 * `webhook-replay-sweep.worker.ts`'s own `UPDATE ... RETURNING` shape so the
 * two replay routes cannot drift on bookkeeping. A dry run always rolls
 * back, even though its SELECT alone makes no writes -- there is no
 * conditional branch here that could accidentally commit a dry-run's
 * "preview".
 *
 * `SET LOCAL app.current_workspace_id` (not `@mega-crm/tenant-context`'s
 * `withTenant`/`withTenantTransaction`) for the SAME reason
 * `audit-sends-history.ts` gives: that package's `pool` is constructed from
 * `process.env.DATABASE_URL` at import time, before this file's own
 * `resolveEnvPath()` load has had a chance to populate it.
 */
async function fetchAndClaimPage(
  pool: Pool,
  args: CliArgs,
  cursorReceivedAt: string,
  cursorId: string
): Promise<JournalPageRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [args.workspaceId]);

    const { rows } = await client.query<{
      id: string;
      rawBatch: unknown;
      payloadPurgedAt: Date | null;
      receivedAt: Date;
    }>(
      `SELECT id, raw_batch as "rawBatch", payload_purged_at as "payloadPurgedAt", received_at as "receivedAt"
         FROM ingress_journal
        WHERE workspace_id = $1
          AND (received_at, id) > ($2::timestamptz, $3::uuid)
          AND received_at <= $4::timestamptz
        ORDER BY received_at ASC, id ASC
        LIMIT $5`,
      [args.workspaceId, cursorReceivedAt, cursorId, args.to, args.pageSize]
    );

    if (!args.dryRun) {
      const eligibleIds = rows.filter((row) => row.payloadPurgedAt === null).map((row) => row.id);
      if (eligibleIds.length > 0) {
        await client.query(`UPDATE ingress_journal SET replay_count = replay_count + 1 WHERE id = ANY($1::uuid[])`, [
          eligibleIds,
        ]);
      }
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }

    return rows.map((row) => ({
      id: row.id,
      rawBatch: row.rawBatch,
      payloadPurgedAt: row.payloadPurgedAt,
      receivedAtIso: row.receivedAt.toISOString(),
    }));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  // 08-15: the location comes from resolveEnvPath() -- one decision point,
  // overridable with MEGA_CRM_ENV_FILE. Runs ONLY after argument validation
  // has already passed (see this file's own header comment).
  try {
    process.loadEnvFile(resolveEnvPath());
  } catch {
    // .env not present -- rely on already-exported environment variables
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required to run replay-webhook-journal -- set it in .env");
    process.exitCode = 1;
    return;
  }

  // A dry run never enqueues, so it never needs a Redis connection at all.
  let redisUrl: string | undefined;
  if (!args.dryRun) {
    redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      console.error("REDIS_URL is required to run replay-webhook-journal (unless --dry-run) -- set it in .env");
      process.exitCode = 1;
      return;
    }
  }

  console.log(
    `Replaying ingress_journal for workspace ${args.workspaceId}, range [${args.from}, ${args.to}]` +
      (args.dryRun ? " (dry run -- nothing will be enqueued)" : "")
  );

  const pool = new Pool({ connectionString: databaseUrl });
  const queue =
    args.dryRun || !redisUrl
      ? undefined
      : new Queue<WebhookEventsJob>(WEBHOOK_EVENTS_QUEUE, {
          connection: buildRedisConnectionOptions(redisUrl),
          defaultJobOptions: buildJobOptions(STANDARD_JOB_RETENTION),
        });

  let enqueued = 0;
  let skippedPurged = 0;
  let cursorReceivedAt = args.from;
  let cursorId = MIN_UUID;

  try {
    for (;;) {
      const page = await fetchAndClaimPage(pool, args, cursorReceivedAt, cursorId);
      if (page.length === 0) break;

      for (const row of page) {
        if (row.payloadPurgedAt !== null) {
          skippedPurged += 1;
          continue;
        }
        if (queue) {
          const events = Array.isArray(row.rawBatch) ? row.rawBatch : [];
          await queue.add("webhook-events", buildWebhookEventsJobPayload(args.workspaceId, events, row.id));
        }
        enqueued += 1;
      }

      console.log(
        `  page complete -- running totals: ${args.dryRun ? "would enqueue" : "enqueued"} ${enqueued}, skipped (payload purged) ${skippedPurged}`
      );

      const last = page[page.length - 1];
      cursorReceivedAt = last.receivedAtIso;
      cursorId = last.id;

      if (page.length < args.pageSize) break;
    }
  } finally {
    await pool.end();
    await queue?.close();
  }

  console.log(
    `\nDone. ${args.dryRun ? "Would enqueue" : "Enqueued"} ${enqueued} row(s); skipped ${skippedPurged} row(s) with a purged payload (nothing left to replay).`
  );
}

main().catch((err: unknown) => {
  console.error("replay-webhook-journal failed:", err);
  process.exitCode = 1;
});
