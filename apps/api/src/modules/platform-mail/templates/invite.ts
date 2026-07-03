/** In-repo HTML template (D-08). Consumed by 01-04's team-invite flow. */
export function renderInviteHtml(params: { inviteUrl: string; orgName: string }): string {
  return `<!-- MEGA_CRM_INVITE_TEMPLATE -->
<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; color: #171717;">
  <h1 style="font-size: 20px; font-weight: 600;">Приглашение в «${params.orgName}»</h1>
  <p style="font-size: 16px; line-height: 1.5;">
    Вас пригласили присоединиться к воркспейсу «${params.orgName}» в Mega CRM.
  </p>
  <p>
    <a href="${params.inviteUrl}" style="display: inline-block; padding: 12px 20px; background: #4F46E5; color: #ffffff; border-radius: 6px; text-decoration: none; font-weight: 600;">
      Принять приглашение
    </a>
  </p>
</div>`;
}
