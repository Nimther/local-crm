/** In-repo HTML template (D-08). See templates/verify-email.ts for the pattern. */
export function renderResetPasswordHtml(params: { resetUrl: string }): string {
  return `<!-- MEGA_CRM_RESET_PASSWORD_TEMPLATE -->
<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; color: #171717;">
  <h1 style="font-size: 20px; font-weight: 600;">Сброс пароля</h1>
  <p style="font-size: 16px; line-height: 1.5;">
    Вы запросили сброс пароля в Mega CRM. Перейдите по ссылке ниже, чтобы задать новый пароль.
  </p>
  <p>
    <a href="${params.resetUrl}" style="display: inline-block; padding: 12px 20px; background: #4F46E5; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 600;">
      Сбросить пароль
    </a>
  </p>
  <p style="font-size: 14px; color: #737373;">
    Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо — ваш пароль останется прежним.
  </p>
</div>`;
}
