import { z } from "zod";

/** POST /api/workspaces/:slug/sendgrid-key -- the tenant's raw BYO SendGrid API key, validated live before storage (D-21). */
export const connectSendgridKeySchema = z.object({
  apiKey: z.string().trim().min(1, "Введите API-ключ SendGrid"),
});
export type ConnectSendgridKeyInput = z.infer<typeof connectSendgridKeySchema>;

export const verifiedSenderSchema = z.object({
  id: z.number(),
  fromEmail: z.string(),
  fromName: z.string().optional(),
  nickname: z.string().optional(),
});
export type VerifiedSender = z.infer<typeof verifiedSenderSchema>;

/**
 * Shared response shape for GET (status), POST (connect), and POST recheck
 * (D-22): `connected: false` is the not-connected empty state; otherwise
 * `keyMask`/`status`/`lastCheckedAt` always present, `verifiedSenders` only
 * present right after a live validation call (connect/recheck), not the
 * plain status read.
 */
export const sendgridKeyStatusSchema = z.object({
  connected: z.boolean(),
  keyMask: z.string().optional(),
  status: z.enum(["active", "error"]).optional(),
  lastCheckedAt: z.string().nullable().optional(),
  verifiedSenders: z.array(verifiedSenderSchema).optional(),
});
export type SendgridKeyStatus = z.infer<typeof sendgridKeyStatusSchema>;
