import type { PoolClient } from "pg";

/** Either the send is a genuine no-op (already sent -- idempotent redelivery), or the caller should proceed with the returned `sendId`. */
export type DispatchSendGateResult = "skipped" | { sendId: string };

/**
 * Idempotent send-dispatch gate (SEND-06, RESEARCH.md Pattern 2). Inserts a
 * `sends` row with `ON CONFLICT (workspace_id, campaign_id, contact_id) DO
 * NOTHING`; on conflict, locks the existing row `FOR UPDATE` and returns
 * `"skipped"` only if it's already `sent` (a worker crash between "SendGrid
 * accepted" and "we recorded that" must never cause the retried job to send
 * again). Never re-calls SendGrid for a row already `sent`.
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
    if (existing[0]?.status === "sent") {
      return "skipped";
    }
    sendId = existing[0]?.id;
  }

  if (!sendId) {
    throw new Error("dispatchSendGate: failed to obtain a sends row id (insert and lookup both empty)");
  }

  return { sendId };
}

/** Advances a `sends` row to its terminal `sent`/`failed` status, recording the provider's message id on success. */
export async function recordSendResult(
  client: PoolClient,
  sendId: string,
  result: { status: "sent" | "failed"; providerMessageId?: string | null }
): Promise<void> {
  await client.query(
    `UPDATE sends
     SET status = $2,
         provider_message_id = $3,
         sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
     WHERE id = $1`,
    [sendId, result.status, result.providerMessageId ?? null]
  );
}

/**
 * Records a contact as excluded from a campaign's send (D-04's frozen
 * exclusion breakdown) instead of ever calling SendGrid for them.
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
       exclusion_reason = EXCLUDED.exclusion_reason`,
    [params.workspaceId, params.campaignId, params.contactId, reason]
  );
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
