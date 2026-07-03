import { z } from "zod";

/**
 * D-17/D-18: invites can assign "member" or "admin" directly. Assigning
 * "owner" via invite is intentionally not offered in this schema -- ownership
 * only moves via an explicit role-change on an existing member (D-18), and
 * the server independently enforces that only an Owner may assign "admin"
 * (see apps/api/src/modules/tenancy/invites.ts).
 */
export const inviteSchema = z.object({
  email: z.string().trim().email("Введите корректный email"),
  role: z.enum(["member", "admin"]),
});
export type InviteInput = z.infer<typeof inviteSchema>;

export const inviteResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
  status: z.string(),
  expiresAt: z.string(),
  inviteUrl: z.string(),
});
export type InviteResponse = z.infer<typeof inviteResponseSchema>;

/** GET /api/invites/:id public preview -- no session required. */
export const invitePreviewSchema = z.object({
  email: z.string(),
  role: z.string(),
  organizationName: z.string(),
  organizationSlug: z.string(),
  status: z.enum(["pending", "expired", "revoked", "accepted"]),
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

/** D-12: register-from-invite -- email is fixed by the invitation, never client input. */
export const registerFromInviteSchema = z.object({
  name: z.string().trim().min(1, "Имя обязательно").max(120),
  password: z.string().min(8, "Пароль должен быть не короче 8 символов").max(128),
});
export type RegisterFromInviteInput = z.infer<typeof registerFromInviteSchema>;

/** POST /api/invites/:id/accept has no body -- the invitation id is the only input, taken from the URL. */
export const acceptInviteSchema = z.object({
  invitationId: z.string().min(1),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
