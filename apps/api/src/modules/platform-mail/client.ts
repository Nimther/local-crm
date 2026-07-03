import sgMail from "@sendgrid/mail";
import { env } from "../../env.js";
import { renderVerifyEmailHtml } from "./templates/verify-email.js";
import { renderResetPasswordHtml } from "./templates/reset-password.js";
import { renderInviteHtml } from "./templates/invite.js";

/**
 * Platform SendGrid client (D-07): every system email (verification, reset,
 * team invite) is dispatched through the PLATFORM's own SendGrid
 * account/key -- never a tenant's BYO key. This module reads ONLY
 * PLATFORM_SENDGRID_API_KEY/PLATFORM_MAIL_FROM and must structurally never
 * reach into the tenant-owned SendGrid-key storage module or any future KMS
 * decryption helper -- the two-key-confusion failure shape RESEARCH.md
 * Pitfall 4 warns about (see the __tests__ source assertion that locks this
 * in). Bodies are in-repo HTML templates (D-08), never a SendGrid Dynamic
 * Template reference.
 */
sgMail.setApiKey(env.PLATFORM_SENDGRID_API_KEY);

async function dispatch(to: string, subject: string, html: string): Promise<void> {
  await sgMail.send({
    to,
    from: env.PLATFORM_MAIL_FROM,
    subject,
    html,
  });
}

export const platformMail = {
  async sendVerification(params: { to: string; verifyUrl: string }): Promise<void> {
    await dispatch(
      params.to,
      "Подтвердите email — Mega CRM",
      renderVerifyEmailHtml({ verifyUrl: params.verifyUrl })
    );
  },

  async sendReset(params: { to: string; resetUrl: string }): Promise<void> {
    await dispatch(
      params.to,
      "Сброс пароля — Mega CRM",
      renderResetPasswordHtml({ resetUrl: params.resetUrl })
    );
  },

  async sendInvite(params: { to: string; inviteUrl: string; orgName: string }): Promise<void> {
    await dispatch(
      params.to,
      `Приглашение в ${params.orgName} — Mega CRM`,
      renderInviteHtml({ inviteUrl: params.inviteUrl, orgName: params.orgName })
    );
  },
};
