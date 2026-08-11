import { decryptTenantSecret } from "@mega-crm/kms";
import { withTenant, withTenantTransaction } from "../../middleware/tenant-context.js";
import { getKey } from "../tenancy/sendgrid-key.repository.js";
import { validateTenantSendGridKey } from "../tenancy/sendgrid-client.js";
import type { CampaignRow } from "./campaign.repository.js";

/**
 * CR-02: thrown by `resolveCampaignFromEmail` when a campaign's
 * `fromSenderId` cannot be turned into a concrete verified sender email --
 * `no_key` when the workspace has no connected/valid SendGrid key, or
 * `sender_not_found` when the id isn't present in `/v3/verified_senders`
 * (or both fromSenderId and fromEmail are unset). Mirrors
 * `CampaignStateError`'s shape from campaign.repository.ts.
 */
export class CampaignSenderError extends Error {
  constructor(
    message: string,
    public readonly code: "sender_not_found" | "no_key"
  ) {
    super(message);
    this.name = "CampaignSenderError";
  }
}

export type CampaignSenderInput = Pick<CampaignRow, "id" | "fromSenderId" | "fromEmail">;

/**
 * Resolves a campaign's sender to a concrete verified email BEFORE any
 * dispatch/kickoff job is enqueued (CAMP-02/CAMP-04) -- the dispatch worker
 * (send-dispatch.ts:155) hard-requires `campaigns.from_email` for both
 * `kind='campaign'` and `kind='test'`, but the campaign builder UI only ever
 * writes `fromSenderId` (a stringified numeric SendGrid verified-sender id).
 *
 * - `fromSenderId` set: decrypts the tenant's connected SendGrid key, lists
 *   verified senders (T-04-09-01: only an id SendGrid itself vouches for is
 *   ever trusted), matches `String(sender.id) === fromSenderId`, persists
 *   the matched `fromEmail` to `campaigns.from_email` (overwriting any stale
 *   value so a changed sender selection can never leave a mismatched
 *   address), and returns it.
 * - `fromSenderId` set but no connected/valid key: throws `no_key`.
 * - `fromSenderId` set but absent from `/v3/verified_senders`: throws
 *   `sender_not_found`.
 * - `fromSenderId` unset but `fromEmail` set (manual-entry fallback path):
 *   returns `fromEmail` unchanged, no SendGrid call.
 * - Neither set: throws `sender_not_found`.
 */
export async function resolveCampaignFromEmail(
  workspaceId: string,
  campaign: CampaignSenderInput
): Promise<string> {
  if (!campaign.fromSenderId) {
    if (campaign.fromEmail) {
      return campaign.fromEmail;
    }
    throw new CampaignSenderError("Campaign has no sender configured", "sender_not_found");
  }

  // Self-contained tenant context: callers pass workspaceId explicitly
  // rather than relying on an ambient withTenant() already being active,
  // matching the plan's literal `resolveCampaignFromEmail(workspaceId, campaign)`
  // signature.
  return withTenant(workspaceId, async () => {
    const row = await getKey();
    if (!row) {
      throw new CampaignSenderError("No SendGrid key connected for this workspace", "no_key");
    }

    // Never logged: the decrypted key is used only for this one
    // verified-senders read (T-04-09-02).
    const apiKey = await decryptTenantSecret(workspaceId, {
      ciphertext: row.ciphertext,
      encryptedDek: row.encryptedDek,
      iv: row.iv,
      authTag: row.authTag,
    });

    const validation = await validateTenantSendGridKey(apiKey);
    if (!validation.valid) {
      throw new CampaignSenderError("SendGrid key is not valid", "no_key");
    }

    const matched = validation.verifiedSenders.find(
      (sender) => String(sender.id) === campaign.fromSenderId
    );
    if (!matched) {
      throw new CampaignSenderError(
        `Sender ${campaign.fromSenderId} is not a verified SendGrid sender for this workspace`,
        "sender_not_found"
      );
    }

    await withTenantTransaction(async (client) => {
      await client.query(
        `UPDATE campaigns SET from_email = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2`,
        [campaign.id, workspaceId, matched.fromEmail]
      );
    });

    return matched.fromEmail;
  });
}
