import type { PoolClient } from "pg";

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
 */
export async function dispatchSendGate(
  client: PoolClient,
  params: { workspaceId: string; campaignId: string; contactId: string }
): Promise<DispatchSendGateResult> {
  const { workspaceId, campaignId, contactId } = params;

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO sends (id, workspace_id, campaign_id, contact_id, status, queued_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'dispatching', now())
     ON CONFLICT (workspace_id, campaign_id, contact_id) DO NOTHING
     RETURNING id`,
    [workspaceId, campaignId, contactId]
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
 */
export async function releaseDispatchClaim(client: PoolClient, sendId: string): Promise<void> {
  await client.query(`DELETE FROM sends WHERE id = $1 AND status = 'dispatching'`, [sendId]);
}

/** Advances a `sends` row to its terminal `sent`/`failed` status, recording the provider's message id on success. */
export async function recordSendResult(
  client: PoolClient,
  sendId: string,
  result: { status: "sent" | "failed"; providerMessageId?: string | null }
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
         sent_at = CASE WHEN $2::send_status = 'sent' THEN now() ELSE sent_at END
     WHERE id = $1`,
    [sendId, result.status, result.providerMessageId ?? null]
  );
}

/**
 * Records a contact as excluded from a campaign's send (D-04's frozen
 * exclusion breakdown) instead of ever calling SendGrid for them.
 *
 * CR-07 (SEND-04/SEND-06): the ON CONFLICT ... DO UPDATE is guarded by
 * `WHERE sends.status NOT IN ('sent', 'dispatching', 'failed')` so an
 * at-least-once BullMQ kickoff redelivery's exclusion re-walk can never
 * demote an already-terminal 'sent'/'failed' row or an in-flight
 * 'dispatching' claim back to 'excluded' -- that would both erase delivery
 * history and let pre-send-gate's rolling frequency-cap count (which counts
 * this campaign's own status='sent' rows) undercount, allowing a re-send
 * past the cap. When the conflicting row's status IS preserved, Postgres
 * simply skips the update (no error) -- a no-op, not a failure. An existing
 * 'excluded' row still has its exclusion_reason updated (re-classification).
 */
export async function recordExcluded(
  client: PoolClient,
  params: { workspaceId: string; campaignId: string; contactId: string },
  reason: string
): Promise<void> {
  await client.query(
    `INSERT INTO sends (id, workspace_id, campaign_id, contact_id, status, exclusion_reason, queued_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'excluded', $4, now())
     ON CONFLICT (workspace_id, campaign_id, contact_id) DO UPDATE SET
       status = 'excluded',
       exclusion_reason = EXCLUDED.exclusion_reason
     WHERE sends.status NOT IN ('sent', 'dispatching', 'failed')`,
    [params.workspaceId, params.campaignId, params.contactId, reason]
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
 */
export async function claimFlowSend(
  client: PoolClient,
  params: { workspaceId: string; flowRunId: string; nodeId: string; contactId: string }
): Promise<DispatchSendGateResult> {
  const { workspaceId, flowRunId, nodeId, contactId } = params;

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO sends (id, workspace_id, flow_run_id, node_id, contact_id, kind, status, queued_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'flow', 'dispatching', now())
     ON CONFLICT (workspace_id, flow_run_id, node_id) WHERE kind = 'flow' DO NOTHING
     RETURNING id`,
    [workspaceId, flowRunId, nodeId, contactId]
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
 * guarded by `WHERE sends.status NOT IN ('sent', 'dispatching', 'failed')`
 * so a redelivered exclusion re-walk can never demote an already-terminal
 * 'sent'/'failed' row or an in-flight 'dispatching' claim back to
 * 'excluded'. An existing 'excluded' row still has its exclusion_reason
 * updated (re-classification).
 */
export async function recordFlowExcluded(
  client: PoolClient,
  params: { workspaceId: string; flowRunId: string; nodeId: string; contactId: string },
  reason: string
): Promise<void> {
  await client.query(
    `INSERT INTO sends (id, workspace_id, flow_run_id, node_id, contact_id, kind, status, exclusion_reason, queued_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'flow', 'excluded', $5, now())
     ON CONFLICT (workspace_id, flow_run_id, node_id) WHERE kind = 'flow' DO UPDATE SET
       status = 'excluded',
       exclusion_reason = EXCLUDED.exclusion_reason
     WHERE sends.status NOT IN ('sent', 'dispatching', 'failed')`,
    [params.workspaceId, params.flowRunId, params.nodeId, params.contactId, reason]
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
