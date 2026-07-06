import type { PoolClient } from "pg";
import { getWorkspaceSendSettings } from "./send-settings.js";

/** Skip reasons the D-04 audience-exclusion breakdown groups by. */
export type PreSendSkipReason = "unsubscribed" | "suppressed" | "no_email" | "frequency_cap";

export type PreSendDecision = { sendable: true } | { sendable: false; reason: PreSendSkipReason };

/** The subset of a contact row the gate needs -- callers pass their own `ContactRow`-shaped object. */
export interface PreSendGateContact {
  id: string;
  email: string | null;
  subscriptionStatus: string;
}

/**
 * The single shared "is this contact sendable right now" rule (SUBS-03,
 * SEND-04, D-04, D-14) -- called from BOTH the broadcast/triggered dispatch
 * worker (04-04) and the campaign audience-breakdown endpoint (04-05), so
 * "who is sendable" can never drift between the two call sites
 * (RESEARCH.md's central warning). Checks, in order: suppressed ->
 * unsubscribed -> missing email -> frequency cap. The frequency-cap check
 * counts `sends` rows with status='sent' inside the workspace's configured
 * rolling window (D-13) -- over the cap is a SKIP, not a defer (D-14).
 */
export async function evaluatePreSendGate(
  client: PoolClient,
  params: { workspaceId: string; contact: PreSendGateContact }
): Promise<PreSendDecision> {
  const { workspaceId, contact } = params;

  if (contact.subscriptionStatus === "suppressed") {
    return { sendable: false, reason: "suppressed" };
  }
  if (contact.subscriptionStatus === "unsubscribed") {
    return { sendable: false, reason: "unsubscribed" };
  }
  if (!contact.email) {
    return { sendable: false, reason: "no_email" };
  }

  const settings = await getWorkspaceSendSettings(client, workspaceId);

  // RESEARCH.md Pitfall 4: this query is index-backed by
  // idx_sends_workspace_contact_sent_at (workspace_id, contact_id, sent_at),
  // decided at table-creation time in 04-01.
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text as count
     FROM sends
     WHERE workspace_id = $1
       AND contact_id = $2
       AND status = 'sent'
       AND sent_at > now() - ($3 || ' hours')::interval`,
    [workspaceId, contact.id, settings.frequencyWindowHours]
  );
  const sentCount = Number(rows[0]?.count ?? "0");

  if (sentCount >= settings.frequencyCap) {
    return { sendable: false, reason: "frequency_cap" };
  }

  return { sendable: true };
}
