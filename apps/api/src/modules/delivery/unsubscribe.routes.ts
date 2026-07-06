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
 * Strict base64url "<payload-segment>.<signature-segment>" shape check
 * (CR-01/T-04-11-01) -- this is a FORMAT guard only, not a signature
 * verification (GET still never verifies/mutates, T-04-03-02/03). Its only
 * job is refusing to reflect anything that isn't shaped like a genuine
 * token, closing the reflected-XSS vector at the source rather than relying
 * solely on escaping.
 */
function isWellFormedUnsubscribeToken(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

/**
 * HTML-attribute escape (defense in depth, CR-01/T-04-11-01) -- applied to a
 * token that already passed {@link isWellFormedUnsubscribeToken}. A
 * well-formed base64url token never contains any of these characters, so
 * this is a no-op on the happy path; it only matters if the format guard
 * were ever bypassed.
 */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * GET confirm page (UI-SPEC): «Отписаться от рассылки?» + a form that POSTs
 * to the same URL. The token itself is never inspected for VERIFICATION
 * purposes on GET (T-04-03-02/T-04-03-03: nothing to leak, nothing to
 * mutate) -- but as of CR-01 it IS checked for well-formedness before being
 * reflected into the page: a malformed token renders this same generic page
 * with a fixed, tokenless form action (still resolves to the current URL),
 * while a well-formed token is HTML-attribute-escaped into the action.
 */
function renderConfirmPage(token: string): string {
  const formAction = isWellFormedUnsubscribeToken(token)
    ? `/unsubscribe/${escapeHtmlAttribute(token)}`
    : "";
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
<form method="POST" action="${formAction}">
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
  // SUBS-04/CR-01: Fastify's default parser set (application/json +
  // text/plain) rejects application/x-www-form-urlencoded with 415
  // FST_ERR_CTP_INVALID_MEDIA_TYPE *before* the route handler runs -- which
  // blocked both real-world POST shapes that hit this endpoint: a mailbox
  // provider's RFC 8058 one-click POST and the confirm page's own
  // <form method="POST"> submit. The body content is deliberately
  // irrelevant here -- the signed token in the URL path (:token) is the
  // sole authorization input, and the handler below never reads
  // request.body -- so the parser just buffers (bounded by bodyLimit,
  // T-04-14-01) and discards it via done(null, undefined).
  //
  // Registered here (media-type-specific, not a catch-all "*") rather than
  // app-wide: registerUnsubscribeRoutes is a plain async function (not a
  // fastify-plugin), so this addContentTypeParser is encapsulated to
  // /unsubscribe/* only and cannot weaken body parsing for any sibling
  // route (/api/auth/*, campaigns, contacts, segments) -- T-04-14-02.
  fastify.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer", bodyLimit: 1024 },
    (_request, _payload, done) => {
      done(null, undefined);
    }
  );

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
