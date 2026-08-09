import type { PoolClient } from "pg";
import { deriveCampaignSendId, deriveFlowSendId } from "./send-id.js";

/**
 * Either the send is a genuine no-op (already terminal -- idempotent
 * redelivery), or the caller should proceed with the returned `sendId`.
 * `interrupted: true` marks the CR-04 case: a PRIOR attempt already
 * committed the 'dispatching' claim but never reached a terminal status
 * (worker crash between the claim commit and the SendGrid call, or between
 * the SendGrid call and the record transaction) -- the caller must NOT
 * re-call SendGrid for this sendId; it must record it as failed instead.
 */
export type DispatchSendGateResult = "skipped" | { sendId: string; interrupted?: boolean };

/**
 * Idempotent send-dispatch gate (SEND-06, RESEARCH.md Pattern 2). Inserts a
 * `sends` row with `ON CONFLICT (workspace_id, campaign_id, contact_id) DO
 * NOTHING`; on conflict, locks the existing row `FOR UPDATE` and returns:
 *   - `"skipped"` when the existing row is already terminal (`sent`,
 *     `failed`, or `excluded`) -- never resend.
 *   - `{ sendId, interrupted: true }` when the existing row is still
 *     `dispatching` -- a prior attempt committed the claim and never
 *     finished (CR-04); the caller must record this as `failed` rather than
 *     re-calling SendGrid.
 * A fresh insert (no conflict) returns `{ sendId }` (interrupted
 * undefined/false) and the caller proceeds to send.
 *
 * Phase 11 (D-09, DLV-05): `id` is now `deriveCampaignSendId(workspaceId,
 * campaignId, contactId)` -- a pure function of the send intent, computed
 * here rather than plumbed through from the caller so every campaign insert
 * site can never drift onto a different id for the same intent. This is what
 * makes `releaseDispatchClaim`'s `DELETE` below safe: a fresh insert for the
 * SAME intent, whenever it happens, reproduces the SAME id. `kind='test'` is
 * the one exempt path (D-11) -- it never reaches this function at all, since
 * it inserts no ledger row; `send-dispatch.ts`'s `randomUUID()` there is
 * correct and must not be "fixed" to call this module.
 */
export async function dispatchSendGate(
  client: PoolClient,
  params: { workspaceId: string; campaignId: string; contactId: string }
): Promise<DispatchSendGateResult> {
  const { workspaceId, campaignId, contactId } = params;
  const derivedId = deriveCampaignSendId(workspaceId, campaignId, contactId);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO sends (id, workspace_id, campaign_id, contact_id, status, queued_at)
     VALUES ($4, $1, $2, $3, 'dispatching', now())
     ON CONFLICT (workspace_id, campaign_id, contact_id) DO NOTHING
     RETURNING id`,
    [workspaceId, campaignId, contactId, derivedId]
  );

  let sendId = rows[0]?.id;
  if (!sendId) {
    const { rows: existing } = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3 FOR UPDATE`,
      [workspaceId, campaignId, contactId]
    );
    const existingStatus = existing[0]?.status;
    if (existingStatus === "sent" || existingStatus === "failed" || existingStatus === "excluded") {
      return "skipped";
    }
    // Phase 11 (DLV-04, T-11-03-02): 'reconciling'/'unknown' are "not my
    // job" for the job processor, not "try again" -- only
    // resolveReconcilingSend, called from the reconciler
    // (send-reconciler.worker.ts), may leave these states (D-03). This
    // branch -- not row locking -- is what closes the
    // reconciler-vs-retry-worker half of DLV-04's exclusivity guarantee:
    // `FOR UPDATE SKIP LOCKED` in the reconciler's own claim only protects
    // reconciler-vs-reconciler.
    if (existingStatus === "reconciling" || existingStatus === "unknown") {
      return "skipped";
    }
    sendId = existing[0]?.id;
    if (sendId && existingStatus === "dispatching") {
      return { sendId, interrupted: true };
    }
  }

  if (!sendId) {
    throw new Error("dispatchSendGate: failed to obtain a sends row id (insert and lookup both empty)");
  }

  return { sendId };
}

/**
 * Releases a claim committed by `dispatchSendGate` while it is STILL
 * `dispatching` -- a no-op if the row has already advanced past that status
 * (e.g. a concurrent recordSendResult won the race). Safe to call after a
 * 429/5xx (SendGrid never accepted the message) or after the per-tenant
 * rate limiter denies a token, so a clean retry re-claims a fresh row
 * instead of finding a stranded claim (T-04-12-03).
 *
 * Phase 11 (D-09, RESEARCH.md Pitfall 4): this `DELETE` is now safe in a way
 * it was NOT before `dispatchSendGate`/`claimFlowSend` started deriving
 * `id` from the send intent. If SendGrid silently accepted the message
 * despite the 429/5xx that triggered this release, the deleted row's id is
 * gone -- but the NEXT claim attempt for the same intent (whenever it
 * happens) reproduces that EXACT SAME id via `deriveCampaignSendId`/
 * `deriveFlowSendId`, so a late-arriving webhook event for the phantom
 * attempt still correlates to whatever row currently occupies that id
 * (either the new attempt's live row, or the reconciler's later resolution
 * of it). This is why the `DELETE` was never replaced with a status
 * transition (unlike `dispatching -> reconciling`, D-08): a deleted-then-
 * reinserted row and a status-transitioned row are indistinguishable once
 * the id is stable across the gap.
 */
export async function releaseDispatchClaim(client: PoolClient, sendId: string): Promise<void> {
  await client.query(`DELETE FROM sends WHERE id = $1 AND status = 'dispatching'`, [sendId]);
}

/**
 * Advances a `sends` row to a terminal `sent`/`failed` status, or to the
 * ambiguous `reconciling` status (Phase 11, DLV-02) -- recording the
 * provider's message id on success. `reconciling` is NOT terminal: it is
 * the ONLY status this function may write that has an outgoing transition
 * of its own (`reconciling -> sent`/`unknown`, written exclusively by
 * `resolveReconcilingSend` below, D-03). `reconciling_since` is set once,
 * on first entry into `reconciling` -- `COALESCE(reconciling_since, now())`
 * so a row that is (re-)written with `status = 'reconciling'` more than
 * once (should that ever happen) never has its original ambiguity
 * timestamp overwritten; Phase 15's webhook-lag alert reads this column.
 */
export async function recordSendResult(
  client: PoolClient,
  sendId: string,
  result: { status: "sent" | "failed" | "reconciling"; providerMessageId?: string | null }
): Promise<void> {
  // $2::send_status is cast explicitly at BOTH usages -- without the cast,
  // Postgres deduces $2's type from its first use (assigned to the
  // `send_status` enum column) and then rejects the second use (`= 'sent'`
  // inside the CASE) as an inconsistent parameter type, throwing
  // "inconsistent types deduced for parameter $2" at query time.
  await client.query(
    `UPDATE sends
     SET status = $2::send_status,
         provider_message_id = $3,
         sent_at = CASE WHEN $2::send_status = 'sent' THEN now() ELSE sent_at END,
         reconciling_since = CASE WHEN $2::send_status = 'reconciling' THEN COALESCE(reconciling_since, now()) ELSE reconciling_since END
     WHERE id = $1`,
    [sendId, result.status, result.providerMessageId ?? null]
  );
}

/**
 * The result of `resolveReconcilingSend`'s terminal write attempt --
 * `resolved: false` means the caller's `WHERE status IN ('reconciling',
 * 'unknown')` guard matched zero rows (a concurrent writer already resolved
 * it, or the row somehow left those states between the caller's own lock
 * acquisition and this call -- should not happen given `resolveOneSend`'s
 * `FOR UPDATE SKIP LOCKED` discipline, but this function's own guard makes
 * that a no-op rather than a stomp regardless).
 */
export interface ResolveReconcilingResult {
  resolved: boolean;
}

/**
 * The ONLY function in this codebase permitted to write a status onto a
 * `sends` row currently in `reconciling` or `unknown` (Phase 11, D-03 --
 * "the reconciler is the sole writer of every `reconciling -> terminal`
 * transition"). Its `WHERE status IN ('reconciling', 'unknown')` guard is
 * what makes that rule enforceable in code, not just in convention: no
 * other call site in the codebase may target either of those two statuses
 * with an UPDATE, and this is the one place that does.
 *
 * This slice (11-03) only ever calls it with `verdict.status === "sent"`
 * (evidence-found resolution) -- `-> unknown` (resolution-window-elapsed,
 * no evidence) is 11-07's expansion of this same function, not a new one.
 *
 * `sent_at` is BACK-DATED to `COALESCE(sent_at, dispatched_at,
 * reconciling_since, queued_at)` rather than stamped with `now()`: this is
 * load-bearing, not cosmetic. `workspace_daily_rollup` is computed from
 * `sent_at::date` -- if this function stamped resolution time instead, a
 * send that was actually accepted on day N but not resolved until day N+2
 * (the reconciler's ~5min cadence makes same-tick resolution the common
 * case, but a backlogged tick or a re-scanned `unknown` row makes a
 * multi-day gap possible) would silently move into the wrong calendar
 * day's rollup.
 *
 * The caller MUST already hold the row lock (`resolveOneSend`'s `SELECT
 * ... FOR UPDATE SKIP LOCKED`, inside the same `withTenantTransaction`) --
 * this function does not lock anything itself; its `WHERE status IN (...)`
 * guard is a correctness backstop for the lost-the-race case, not a
 * substitute for holding the lock in the first place.
 */
export async function resolveReconcilingSend(
  client: PoolClient,
  sendId: string,
  verdict: { status: "sent"; providerMessageId?: string | null }
): Promise<ResolveReconcilingResult> {
  const { rowCount } = await client.query(
    `UPDATE sends
     SET status = $2::send_status,
         sent_at = COALESCE(sent_at, dispatched_at, reconciling_since, queued_at),
         reconciling_since = NULL
     WHERE id = $1 AND status IN ('reconciling', 'unknown')`,
    [sendId, verdict.status]
  );
  return { resolved: (rowCount ?? 0) > 0 };
}

/**
 * Records a contact as excluded from a campaign's send (D-04's frozen
 * exclusion breakdown) instead of ever calling SendGrid for them.
 *
 * CR-07 (SEND-04/SEND-06): the ON CONFLICT ... DO UPDATE is guarded by
 * `WHERE sends.status NOT IN ('sent', 'dispatching', 'failed', 'reconciling',
 * 'unknown')` so an at-least-once BullMQ kickoff redelivery's exclusion
 * re-walk can never demote an already-terminal 'sent'/'failed' row or an
 * in-flight 'dispatching' claim back to 'excluded' -- that would both erase
 * delivery history and let pre-send-gate's rolling frequency-cap count
 * (which counts this campaign's own status='sent' rows) undercount,
 * allowing a re-send past the cap. When the conflicting row's status IS
 * preserved, Postgres simply skips the update (no error) -- a no-op, not a
 * failure. An existing 'excluded' row still has its exclusion_reason
 * updated (re-classification).
 *
 * Phase 11 (T-11-03-03, RESEARCH.md Pitfall 3): 'reconciling'/'unknown' were
 * added to this guard's list in the SAME change that introduced code
 * consuming them (this file), not in the enum-add migration itself (0047/
 * 0048) -- Postgres does not warn about an enum value missing from a `NOT
 * IN` list, so leaving the original three-value list unchanged would let a
 * redelivered exclusion re-walk silently stomp an in-flight reconciliation
 * back to 'excluded', erasing the row the reconciler was about to resolve.
 *
 * Phase 11 (D-09, DLV-05): `id` is `deriveCampaignSendId(...)`, the SAME
 * derivation `dispatchSendGate` uses for the identical (workspaceId,
 * campaignId, contactId) triple -- an intent excluded here and later
 * dispatched (or vice versa) can never end up represented by two different
 * ids depending on which path inserted first (RESEARCH.md key_links).
 */
export async function recordExcluded(
  client: PoolClient,
  params: { workspaceId: string; campaignId: string; contactId: string },
  reason: string
): Promise<void> {
  const derivedId = deriveCampaignSendId(params.workspaceId, params.campaignId, params.contactId);
  await client.query(
    `INSERT INTO sends (id, workspace_id, campaign_id, contact_id, status, exclusion_reason, queued_at)
     VALUES ($5, $1, $2, $3, 'excluded', $4, now())
     ON CONFLICT (workspace_id, campaign_id, contact_id) DO UPDATE SET
       status = 'excluded',
       exclusion_reason = EXCLUDED.exclusion_reason
     WHERE sends.status NOT IN ('sent', 'dispatching', 'failed', 'reconciling', 'unknown')`,
    [params.workspaceId, params.campaignId, params.contactId, reason, derivedId]
  );
}

/**
 * Idempotent flow-step send-claim gate (FLOW-01/FLOW-07, sibling of
 * `dispatchSendGate` for the campaign ledger). Inserts a `sends` row
 * (`kind='flow'`) with `ON CONFLICT (workspace_id, flow_run_id, node_id)
 * WHERE kind = 'flow' DO NOTHING` -- the conflict target matches the
 * `sends_flow_run_node_unique` PARTIAL unique index (migration 0028), scoped
 * to flow rows only so campaign/test sends (null `flow_run_id`) never
 * contend with it. Mirrors `dispatchSendGate`'s three outcomes exactly:
 *   - `"skipped"` when the existing row for this (workspace, flow_run,
 *     node) is already terminal (`sent`, `failed`, or `excluded`) -- never
 *     resend a redelivered flow-step job.
 *   - `{ sendId, interrupted: true }` when the existing row is still
 *     `dispatching` -- a prior attempt committed the claim and crashed
 *     before reaching a terminal status; the caller must record this as
 *     `failed` rather than re-calling SendGrid.
 *   - `{ sendId }` (a fresh insert, no conflict) -- the caller proceeds to
 *     send.
 *
 * Phase 11 (D-09, DLV-05): `id` is `deriveFlowSendId(workspaceId, flowRunId,
 * nodeId)` -- the flow-shaped sibling of `dispatchSendGate`'s campaign
 * derivation, computed here rather than plumbed through from the caller for
 * the same drift-prevention reason. `sends.id` is now a pure function of the
 * send intent for both campaign and flow ledger inserts; `kind='test'`
 * remains the one exempt path (D-11), never reaching this function.
 */
export async function claimFlowSend(
  client: PoolClient,
  params: { workspaceId: string; flowRunId: string; nodeId: string; contactId: string }
): Promise<DispatchSendGateResult> {
  const { workspaceId, flowRunId, nodeId, contactId } = params;
  const derivedId = deriveFlowSendId(workspaceId, flowRunId, nodeId);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO sends (id, workspace_id, flow_run_id, node_id, contact_id, kind, status, queued_at)
     VALUES ($5, $1, $2, $3, $4, 'flow', 'dispatching', now())
     ON CONFLICT (workspace_id, flow_run_id, node_id) WHERE kind = 'flow' DO NOTHING
     RETURNING id`,
    [workspaceId, flowRunId, nodeId, contactId, derivedId]
  );

  let sendId = rows[0]?.id;
  if (!sendId) {
    const { rows: existing } = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM sends
       WHERE workspace_id = $1 AND flow_run_id = $2 AND node_id = $3 AND kind = 'flow'
       FOR UPDATE`,
      [workspaceId, flowRunId, nodeId]
    );
    const existingStatus = existing[0]?.status;
    if (existingStatus === "sent" || existingStatus === "failed" || existingStatus === "excluded") {
      return "skipped";
    }
    // Phase 11 (DLV-04, T-11-03-02): 'reconciling'/'unknown' are "not my
    // job" for the job processor, not "try again" -- only
    // resolveReconcilingSend, called from the reconciler
    // (send-reconciler.worker.ts), may leave these states (D-03). This
    // branch -- not row locking -- is what closes the
    // reconciler-vs-retry-worker half of DLV-04's exclusivity guarantee:
    // `FOR UPDATE SKIP LOCKED` in the reconciler's own claim only protects
    // reconciler-vs-reconciler.
    if (existingStatus === "reconciling" || existingStatus === "unknown") {
      return "skipped";
    }
    sendId = existing[0]?.id;
    if (sendId && existingStatus === "dispatching") {
      return { sendId, interrupted: true };
    }
  }

  if (!sendId) {
    throw new Error("claimFlowSend: failed to obtain a sends row id (insert and lookup both empty)");
  }

  return { sendId };
}

/**
 * Advances a flow-step `sends` row (`kind='flow'`) to its terminal
 * `sent`/`failed` status -- the flow-shaped sibling of `recordSendResult`.
 * Callers use this instead of `recordSendResult` for flow sends so the
 * function name at each call site documents which ledger shape it is
 * updating; the underlying `sends` row (looked up by `id`, not by kind) is
 * identical either way.
 */
export async function recordFlowStepResult(
  client: PoolClient,
  sendId: string,
  result: { status: "sent" | "failed"; providerMessageId?: string | null }
): Promise<void> {
  // $2::send_status is cast explicitly at BOTH usages -- without the cast,
  // Postgres deduces $2's type from its first use (assigned to the
  // `send_status` enum column) and then rejects the second use (`= 'sent'`
  // inside the CASE) as an inconsistent parameter type, throwing
  // "inconsistent types deduced for parameter $2" at query time (mirrors
  // recordSendResult's own comment/fix, 04-04).
  await client.query(
    `UPDATE sends
     SET status = $2::send_status,
         provider_message_id = $3,
         sent_at = CASE WHEN $2::send_status = 'sent' THEN now() ELSE sent_at END
     WHERE id = $1`,
    [sendId, result.status, result.providerMessageId ?? null]
  );
}

/**
 * Records a contact as excluded from a flow-step send (D-05's frozen
 * exclusion disposition -- suppressed/unsubscribed/frequency-capped is
 * always a skip, never a defer, matching campaign behavior) instead of ever
 * calling SendGrid for them. Flow-shaped sibling of `recordExcluded`,
 * keyed by (workspace_id, flow_run_id, node_id) instead of
 * (workspace_id, campaign_id, contact_id).
 *
 * Mirrors `recordExcluded`'s CR-07 guard: the ON CONFLICT ... DO UPDATE is
 * guarded by `WHERE sends.status NOT IN ('sent', 'dispatching', 'failed',
 * 'reconciling', 'unknown')` so a redelivered exclusion re-walk can never
 * demote an already-terminal 'sent'/'failed' row, an in-flight 'dispatching'
 * claim, or an in-flight reconciliation back to 'excluded'. An existing
 * 'excluded' row still has its exclusion_reason updated (re-classification).
 *
 * Phase 11 (T-11-03-03, RESEARCH.md Pitfall 3): same rationale as
 * `recordExcluded`'s own comment above -- 'reconciling'/'unknown' were added
 * to this guard in the same change that introduced consuming code, not the
 * enum-add migration itself.
 *
 * Phase 11 (D-09, DLV-05): `id` is `deriveFlowSendId(...)`, the SAME
 * derivation `claimFlowSend` uses for the identical (workspaceId,
 * flowRunId, nodeId) triple -- mirrors `recordExcluded`'s own same-id
 * guarantee for the campaign path.
 */
export async function recordFlowExcluded(
  client: PoolClient,
  params: { workspaceId: string; flowRunId: string; nodeId: string; contactId: string },
  reason: string
): Promise<void> {
  const derivedId = deriveFlowSendId(params.workspaceId, params.flowRunId, params.nodeId);
  await client.query(
    `INSERT INTO sends (id, workspace_id, flow_run_id, node_id, contact_id, kind, status, exclusion_reason, queued_at)
     VALUES ($6, $1, $2, $3, $4, 'flow', 'excluded', $5, now())
     ON CONFLICT (workspace_id, flow_run_id, node_id) WHERE kind = 'flow' DO UPDATE SET
       status = 'excluded',
       exclusion_reason = EXCLUDED.exclusion_reason
     WHERE sends.status NOT IN ('sent', 'dispatching', 'failed', 'reconciling', 'unknown')`,
    [params.workspaceId, params.flowRunId, params.nodeId, params.contactId, reason, derivedId]
  );
}

/**
 * Atomically advances a campaign's live progress counter (CAMP-05, CR-05)
 * by 1 -- `sent_count` for a 'sent' terminal record, `failed_count` for a
 * 'failed' one -- guarded `WHERE status = 'sending'` (T-04-13-02) so a
 * campaign that has already left 'sending' (canceled, or already
 * transitioned to 'sent' by a prior call in this same fan-out) has its
 * counters frozen rather than incremented past a terminal state. The
 * UPDATE's own row lock serializes concurrent sends against the same
 * campaign row.
 */
export async function incrementCampaignSendCounter(
  client: PoolClient,
  campaignId: string,
  status: "sent" | "failed"
): Promise<void> {
  const column = status === "sent" ? "sent_count" : "failed_count";
  await client.query(
    `UPDATE campaigns SET ${column} = ${column} + 1, updated_at = now()
     WHERE id = $1 AND status = 'sending'`,
    [campaignId]
  );
}

/**
 * Idempotent completion transition (CR-05, T-04-13-03): moves a campaign
 * from 'sending' to 'sent' once fan-out has finished AND every sendable
 * recipient has reached a terminal send (sent_count + failed_count >=
 * sendable_total). Guarded `WHERE status = 'sending'` so it fires at most
 * once -- a no-op both before completion and after a prior call has already
 * transitioned the row. Returns whether this call performed the
 * transition, so callers can distinguish "already terminal" from "just
 * completed" if ever needed.
 */
export async function tryCompleteCampaign(client: PoolClient, campaignId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE campaigns SET status = 'sent', terminal_at = now(), updated_at = now()
     WHERE id = $1
       AND status = 'sending'
       AND fan_out_complete = true
       AND (sent_count + failed_count) >= sendable_total`,
    [campaignId]
  );
  return (rowCount ?? 0) > 0;
}

export interface AudienceExclusionBreakdown {
  reason: string;
  count: number;
}

/** D-04 UI: counts of excluded recipients for a campaign, grouped by exclusion reason. */
export async function audienceExclusionBreakdown(
  client: PoolClient,
  params: { workspaceId: string; campaignId: string }
): Promise<AudienceExclusionBreakdown[]> {
  const { rows } = await client.query<{ exclusionReason: string; count: string }>(
    `SELECT exclusion_reason as "exclusionReason", count(*)::text as count
     FROM sends
     WHERE workspace_id = $1 AND campaign_id = $2 AND status = 'excluded'
     GROUP BY exclusion_reason`,
    [params.workspaceId, params.campaignId]
  );
  return rows.map((row) => ({ reason: row.exclusionReason, count: Number(row.count) }));
}
