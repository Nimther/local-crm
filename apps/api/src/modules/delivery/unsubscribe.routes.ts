import type { FastifyInstance } from "fastify";
import { verifyUnsubscribeToken } from "@mega-crm/delivery-core";
import { withTenant, withTenantTransaction } from "../../middleware/tenant-context.js";

/**
 * Shared inline CSS for the standalone public unsubscribe page -- no app
 * shell, no sidebar/nav (UI-SPEC: "standalone centered card"). Plain in-file
 * HTML string, no template engine, mirroring platform-mail's in-repo HTML
 * convention.
 */
const PAGE_STYLE = `<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f7f8; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border-radius: 12px; padding: 40px; max-width: 420px; width: 90%; box-shadow: 0 1px 3px rgba(0,0,0,0.08); text-align: center; }
  h1 { font-size: 20px; margin: 0 0 12px; color: #111; }
  p { color: #555; font-size: 14px; line-height: 1.5; margin: 0 0 24px; }
  button { background: #111; color: #fff; border: none; border-radius: 8px; padding: 10px 24px; font-size: 14px; cursor: pointer; }
</style>`;

/**
 * GET confirm page (UI-SPEC): «Отписаться от рассылки?» + a form that POSTs
 * to the same URL. Rendered UNCONDITIONALLY -- the token is never inspected
 * on GET (T-04-03-02/T-04-03-03: nothing to leak, nothing to mutate, so a
 * forged/garbage token segment and a genuine one render byte-identical
 * output).
 */
function renderConfirmPage(token: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>Отписаться от рассылки</title>
${PAGE_STYLE}
</head>
<body>
<div class="card">
<h1>Отписаться от рассылки?</h1>
<p>Нажмите кнопку, чтобы больше не получать маркетинговые письма от этой компании.</p>
<form method="POST" action="/unsubscribe/${token}">
<button type="submit">Отписаться</button>
</form>
</div>
</body>
</html>`;
}

/** POST success page (UI-SPEC): «Вы отписаны» -- shown for the human confirm-form path. */
function renderSuccessPage(): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>Вы отписаны</title>
${PAGE_STYLE}
</head>
<body>
<div class="card">
<h1>Вы отписаны</h1>
<p>Вы больше не будете получать маркетинговые письма от этой компании.</p>
</div>
</body>
</html>`;
}

/**
 * Public RFC 8058 one-click unsubscribe surface (SUBS-04, D-15). Registered
 * top-level (no session, no workspace `:slug` prefix, no auth preHandler) --
 * a mail client's `List-Unsubscribe` URL must be reachable with zero
 * platform context beyond the signed token itself.
 *
 * Threat model (T-04-03-01/02/03):
 * - GET never verifies the token and never mutates -- it always renders the
 *   SAME static confirm page, so it cannot be a mutation-via-prefetch vector
 *   nor an enumeration oracle (nothing token-dependent is ever computed).
 * - POST verifies the HMAC signature + expiry; ANY failure (bad signature,
 *   malformed token, expired) and a valid-signature-but-unknown-contact both
 *   fall through the exact same code path with no branching on which one
 *   happened, so the response is byte-identical for all three cases.
 */
export async function registerUnsubscribeRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/unsubscribe/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    reply.type("text/html");
    return renderConfirmPage(token);
  });

  fastify.post("/unsubscribe/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    // A browser's plain <form method="POST"> submit sends Accept: text/html
    // first -- used only to pick which body to render (rendered success page
    // for the human confirm-form path vs. an empty 2xx for a mail client's
    // native one-click POST, RFC 8058). This is a presentation choice made
    // AFTER the mutation decision below, never a security branch: both
    // branches run the identical verify-then-mutate logic first.
    const acceptsHtml = (request.headers.accept ?? "").includes("text/html");

    const payload = verifyUnsubscribeToken(token);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const isValid = payload !== null && payload.exp >= nowSeconds;

    if (isValid) {
      // T-04-03-01: the HMAC signature already binds this token to a
      // specific sendId/contactId/workspaceId -- safe to trust
      // payload.workspaceId for RLS tenant scoping without a separate
      // lookup. Idempotent: an already-unsubscribed contact is a no-op, and
      // an unknown contactId simply updates zero rows (never surfaced to the
      // caller -- T-04-03-02).
      await withTenant(payload.workspaceId, () =>
        withTenantTransaction(async (client) => {
          await client.query(
            `UPDATE contacts SET subscription_status = 'unsubscribed', updated_at = now() WHERE id = $1`,
            [payload.contactId]
          );
        })
      );
    }

    if (acceptsHtml) {
      reply.type("text/html");
      return renderSuccessPage();
    }

    // RFC 8058: one-click POST returns 2xx with no body.
    reply.code(200);
    return "";
  });
}
