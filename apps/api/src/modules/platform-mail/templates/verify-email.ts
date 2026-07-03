/**
 * In-repo HTML template (D-08) -- system email bodies live in the
 * repository, never in SendGrid Dynamic Templates. Kept as a simple string
 * template function per RESEARCH.md/PLAN action text.
 */
export function renderVerifyEmailHtml(params: { verifyUrl: string }): string {
  return `<!-- MEGA_CRM_VERIFY_EMAIL_TEMPLATE -->
<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; color: #171717;">
  <h1 style="font-size: 20px; font-weight: 600;">Подтвердите email</h1>
  <p style="font-size: 16px; line-height: 1.5;">
    Чтобы подключить SendGrid и снять остальные ограничения аккаунта, подтвердите свой email в Mega CRM.
  </p>
  <p>
    <a href="${params.verifyUrl}" style="display: inline-block; padding: 12px 20px; background: #4F46E5; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 600;">
      Подтвердить email
    </a>
  </p>
  <p style="font-size: 14px; color: #737373;">
    Если вы не регистрировались в Mega CRM, просто проигнорируйте это письмо.
  </p>
</div>`;
}
