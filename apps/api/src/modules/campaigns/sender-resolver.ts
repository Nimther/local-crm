import { decryptTenantSecret } from "@mega-crm/kms";
import { withTenant } from "../../middleware/tenant-context.js";
import { getKey } from "../tenancy/sendgrid-key.repository.js";
import { validateTenantSendGridKey } from "../tenancy/sendgrid-client.js";
import type { CampaignRow } from "./campaign.repository.js";

/**
 * CR-02: thrown by `resolveCampaignSenderEmail` when a campaign's
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
 * TMPL-02/TMPL-03/RESEARCH Pitfall #1: the sole implementation of sender
 * resolution (plan 20-03 retired the persisting `resolveCampaignFromEmail`
 * variant that used to exist alongside this one). Used by the launch,
 * schedule and test-send routes (plans 20-02/20-03) -- EVERY caller
 * persists the returned email itself, INSIDE its own locked transaction
 * (`launchCampaign`/`scheduleCampaign`/`prepareCampaignTestSend`,
 * `campaign.repository.ts`), in the SAME statement as its version compare
 * and bump. This function itself never writes to `campaigns.from_email`:
 * a write here, executed in its own transaction ahead of the locked
 * version check, would bump the version the caller is about to be
 * compared against, producing a spurious `version_conflict` on the very
 * first, blameless attempt to use a campaign's primary (non-fallback)
 * fromSenderId sender-selection path.
 *
 * - `fromSenderId` set: decrypts the tenant's connected SendGrid key, lists
 *   verified senders (T-04-09-01: only an id SendGrid itself vouches for is
 *   ever trusted), matches `String(sender.id) === fromSenderId`, and
 *   returns the matched `fromEmail` -- WITHOUT persisting it.
 * - `fromSenderId` set but no connected/valid key: throws `no_key`.
 * - `fromSenderId` set but absent from `/v3/verified_senders`: throws
 *   `sender_not_found`.
 * - `fromSenderId` unset but `fromEmail` set (manual-entry fallback path):
 *   returns `fromEmail` unchanged, no SendGrid call.
 * - Neither set: throws `sender_not_found`.
 *
 * The decrypted key is never logged (T-04-09-02).
 */
export async function resolveCampaignSenderEmail(
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
  // rather than relying on an ambient withTenant() already being active.
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

    return matched.fromEmail;
  });
}
