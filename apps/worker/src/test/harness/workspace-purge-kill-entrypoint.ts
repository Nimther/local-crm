import { scrubbedConsole } from "@mega-crm/redaction";
import type { PoolClient } from "pg";
import type { PurgeTable } from "@mega-crm/db";
import { deletePurgeBatch as deletePurgeBatchDefault } from "@mega-crm/db";
import { processWorkspacePurge, type ProcessWorkspacePurgeDeps } from "../../queues/workspace-purge.worker.js";

/**
 * Plan 22-09 (PRG-03, SC3) -- the real-process-kill harness for
 * `workspace-purge-resume.test.ts`. TEST HARNESS ONLY; nothing in production
 * imports this file.
 *
 * Mirrors `sigkill-entrypoint.ts`'s shape (freeze-then-signal, the parent
 * kills in response to the marker, never a timer) but freezes at one of
 * THREE seams inside the real `processWorkspacePurge()` walk rather than
 * inside a single injected mail call:
 *
 * - `mid_batch`: freezes a real `deletePurgeBatch` call for the target
 *   workspace AFTER it has issued its real DELETE (so the rows are gone
 *   from the table but the transaction that deleted them is still open --
 *   the SAME transaction the checkpoint heartbeat would advance in, per
 *   `advanceWorkspacePurgeCheckpoint`'s own doc comment) but BEFORE that
 *   transaction can ever commit. A kill here is the direct test of "the
 *   batch's DELETE and its checkpoint advance share one commit": the
 *   frozen batch's rows are still physically present after the kill
 *   (Postgres never saw a COMMIT, so the DELETE is invisible to every other
 *   session even before the dead connection is cleaned up -- MVCC, not a
 *   timing race), while every EARLIER batch for that workspace, having
 *   already committed, is gone for good.
 * - `between_tables`: freezes BEFORE the real delete is ever attempted, on
 *   the first call for `WPK_STOP_BEFORE_TABLE`. No DELETE is issued at all
 *   for that table, so there is no open-transaction lock to worry about --
 *   the table immediately before it in `PURGE_TABLE_ORDER` has already
 *   fully committed and been marked done by the time this freezes.
 * - `before_tail`: freezes inside `ProcessWorkspacePurgeDeps.afterTableWalk`
 *   (plan 22-09's own addition to `workspace-purge.worker.ts`), which fires
 *   once every table is confirmed empty and marked done but strictly
 *   before the auth step and the tombstone -- the one boundary the table
 *   loop's own checkpoint cannot reach.
 *
 * Every freeze is scoped to `WPK_TARGET_WORKSPACE_ID` so a neighbour
 * workspace processed in the SAME tick (`processWorkspacePurge` scans every
 * eligible workspace, not just one) is never affected by this harness's
 * instrumentation, regardless of which workspace the destructive selector
 * happens to reach first.
 */

export const WORKSPACE_PURGE_KILL_HARNESS_READY = "workspace-purge-kill-harness:ready";
export const WORKSPACE_PURGE_KILL_HARNESS_RUN = "run";

type KillMode = "mid_batch" | "between_tables" | "before_tail";

function fail(message: string): never {
  scrubbedConsole.error(`workspace-purge-kill-entrypoint: ${message}`);
  process.exit(1);
}

function readMode(): KillMode {
  const raw = process.env.WPK_MODE;
  if (raw !== "mid_batch" && raw !== "between_tables" && raw !== "before_tail") {
    fail(`WPK_MODE is not a recognized kill mode: "${String(raw)}"`);
  }
  return raw;
}

function readTargetWorkspaceId(): string {
  const raw = process.env.WPK_TARGET_WORKSPACE_ID;
  if (!raw) fail("WPK_TARGET_WORKSPACE_ID is not set -- refusing to start with no target workspace");
  return raw;
}

/** Never resolves. The open IPC channel keeps the process alive -- no timer is needed, and none is used. */
function freeze<T>(): Promise<T> {
  return new Promise<T>(() => {
    /* intentionally never resolved or rejected */
  });
}

process.on("message", (message: unknown) => {
  if (message !== WORKSPACE_PURGE_KILL_HARNESS_RUN) return;

  const mode = readMode();
  const targetWorkspaceId = readTargetWorkspaceId();
  let frozen = false;

  const deps: ProcessWorkspacePurgeDeps = {};

  if (mode === "mid_batch" || mode === "between_tables") {
    let meaningfulCalls = 0;
    const freezeAfterMeaningfulCall = Number(process.env.WPK_FREEZE_AFTER_MEANINGFUL_CALL ?? "0");
    const stopBeforeTable = process.env.WPK_STOP_BEFORE_TABLE as PurgeTable | undefined;

    if (mode === "mid_batch" && freezeAfterMeaningfulCall < 1) {
      fail("WPK_FREEZE_AFTER_MEANINGFUL_CALL must be a positive integer for mid_batch mode");
    }
    if (mode === "between_tables" && !stopBeforeTable) {
      fail("WPK_STOP_BEFORE_TABLE is required for between_tables mode");
    }

    deps.deletePurgeBatch = async (client: PoolClient, table: PurgeTable, workspaceId: string, limit?: number) => {
      if (workspaceId !== targetWorkspaceId) {
        return deletePurgeBatchDefault(client, table, workspaceId, limit);
      }

      if (mode === "between_tables" && !frozen && table === stopBeforeTable) {
        frozen = true;
        process.send?.(WORKSPACE_PURGE_KILL_HARNESS_READY);
        // Never call the real delete -- this table's walk has not even started.
        return freeze<number>();
      }

      const deletedCount = await deletePurgeBatchDefault(client, table, workspaceId, limit);

      if (mode === "mid_batch" && !frozen && deletedCount > 0) {
        meaningfulCalls += 1;
        if (meaningfulCalls === freezeAfterMeaningfulCall) {
          frozen = true;
          process.send?.(WORKSPACE_PURGE_KILL_HARNESS_READY);
          // The real DELETE above already ran on this open transaction --
          // freezing here means `advanceWorkspacePurgeCheckpoint` and the
          // transaction's own COMMIT never happen.
          return freeze<number>();
        }
      }

      return deletedCount;
    };
  }

  if (mode === "before_tail") {
    deps.afterTableWalk = async (workspaceId: string) => {
      if (workspaceId !== targetWorkspaceId || frozen) return;
      frozen = true;
      process.send?.(WORKSPACE_PURGE_KILL_HARNESS_READY);
      await freeze<void>();
    };
  }

  processWorkspacePurge(deps).catch((err: unknown) => {
    // Reaching here means the freeze did not hold and the tick failed for
    // some other reason -- surface it rather than exiting silently, or the
    // parent sees an unexplained early exit with no diagnosis.
    scrubbedConsole.error(
      `workspace-purge-kill-entrypoint: processWorkspacePurge rejected before the freeze: ${
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      }`,
    );
    process.exit(2);
  });
});
