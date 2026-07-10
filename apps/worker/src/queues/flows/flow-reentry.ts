import type { PoolClient } from "pg";

export interface CanEnterFlowParams {
  workspaceId: string;
  flowId: string;
  contactId: string;
  reentryMode: string; // "once_ever" | "once_per_n_days" | "every_time"
  reentryWindowDays: number | null;
}

export interface CanEnterFlowResult {
  allowed: boolean;
  reason?: string;
}

/**
 * FLOW-04/D-06/D-07 re-entry decision: a straightforward DB-backed function
 * (no external deps) called by the trigger evaluator (Task 2) BEFORE it ever
 * attempts to INSERT a new flow_runs row.
 *
 * Ordering is deliberate and NOT mode-conditional:
 *   1. The one-active-run guard (D-07) runs FIRST, for ALL three modes --
 *      a waiting/advancing run for this exact (workspace, flow, contact)
 *      blocks entry unconditionally. This mirrors (does not replace) the
 *      flow_runs_one_active_per_contact partial unique index (migration
 *      0026), which remains the DB-level concurrency backstop the caller's
 *      INSERT ... ON CONFLICT DO NOTHING relies on -- this check alone is
 *      not sufficient under a race, only a fast-path optimization + clear
 *      `reason` for the common (non-racing) case.
 *   2. `every_time` -- no further restriction, always allowed (subject to
 *      guard 1).
 *   3. `once_ever` -- allowed only if NO flow_runs row (of ANY status) has
 *      ever existed for this contact x flow.
 *   4. `once_per_n_days` -- allowed only if no prior run exists, OR the most
 *      recent run's `last_entry_at` (D-06's re-entry clock, distinct from
 *      `entered_at`) is older than `reentryWindowDays` days.
 *
 * D-05: this function adds NO subscription/suppression predicate --
 * suppressed/unsubscribed contacts enroll normally. Filtering happens later,
 * at the pre-send gate (06-03), never at entry.
 */
export async function canEnterFlow(client: PoolClient, params: CanEnterFlowParams): Promise<CanEnterFlowResult> {
  const { workspaceId, flowId, contactId, reentryMode, reentryWindowDays } = params;

  const { rows: activeRows } = await client.query<{ id: string }>(
    `SELECT id FROM flow_runs
     WHERE workspace_id = $1 AND flow_id = $2 AND contact_id = $3 AND status IN ('waiting', 'advancing')
     LIMIT 1`,
    [workspaceId, flowId, contactId]
  );
  if (activeRows.length > 0) {
    return { allowed: false, reason: "active_run" };
  }

  if (reentryMode === "every_time") {
    return { allowed: true };
  }

  if (reentryMode === "once_ever") {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM flow_runs WHERE workspace_id = $1 AND flow_id = $2 AND contact_id = $3 LIMIT 1`,
      [workspaceId, flowId, contactId]
    );
    if (rows.length > 0) {
      return { allowed: false, reason: "once_ever" };
    }
    return { allowed: true };
  }

  if (reentryMode === "once_per_n_days") {
    const { rows } = await client.query<{ lastEntryAt: Date }>(
      `SELECT last_entry_at as "lastEntryAt" FROM flow_runs
       WHERE workspace_id = $1 AND flow_id = $2 AND contact_id = $3
       ORDER BY last_entry_at DESC
       LIMIT 1`,
      [workspaceId, flowId, contactId]
    );
    const lastEntryAt = rows[0]?.lastEntryAt;
    if (!lastEntryAt) {
      return { allowed: true };
    }
    const windowDays = reentryWindowDays ?? 0;
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    const elapsedMs = Date.now() - new Date(lastEntryAt).getTime();
    if (elapsedMs >= windowMs) {
      return { allowed: true };
    }
    return { allowed: false, reason: "reentry_window" };
  }

  // Unknown mode: fail closed rather than silently allowing an unbounded re-entry.
  return { allowed: false, reason: "unknown_reentry_mode" };
}
