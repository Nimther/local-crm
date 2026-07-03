import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nock from "nock";
import { afterEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Platform SendGrid client dispatch contract (D-07/D-08, RESEARCH.md
 * Pitfall 4). Uses vitest.config.ts's test-safe PLATFORM_SENDGRID_API_KEY /
 * PLATFORM_MAIL_FROM values (never real SendGrid credentials) and `nock` to
 * intercept the outbound HTTP call `platformMail` makes through
 * `@sendgrid/mail` -- proving the request is authenticated with the
 * *platform* key/from-address, never a tenant's, and that the body is an
 * in-repo HTML template rather than a SendGrid Dynamic Template reference.
 */
const PLATFORM_KEY = process.env.PLATFORM_SENDGRID_API_KEY;
const PLATFORM_FROM = process.env.PLATFORM_MAIL_FROM;

if (!PLATFORM_KEY || !PLATFORM_FROM) {
  throw new Error(
    "PLATFORM_SENDGRID_API_KEY / PLATFORM_MAIL_FROM must be set for tests (see apps/api/vitest.config.ts test.env)"
  );
}

interface CapturedMailBody {
  from: { email: string };
  content: Array<{ type: string; value: string }>;
}

describe("platformMail (platform-key-only dispatch)", () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it("sendReset authenticates with the platform key, sends from PLATFORM_MAIL_FROM, and uses the in-repo reset-password template", async () => {
    let capturedAuth: string | undefined;
    let capturedBody: CapturedMailBody | undefined;

    const scope = nock("https://api.sendgrid.com", {
      reqheaders: {
        authorization: (value) => {
          capturedAuth = value;
          return true;
        },
      },
    })
      .post("/v3/mail/send", (body: CapturedMailBody) => {
        capturedBody = body;
        return true;
      })
      .reply(202, "", { "x-message-id": "test-reset-msg-id" });

    const { platformMail } = await import("../client.js");
    await platformMail.sendReset({
      to: "user@example.com",
      resetUrl: "https://app.megacrm.test/reset-password?token=abc123",
    });

    expect(scope.isDone()).toBe(true);
    expect(capturedAuth).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(capturedBody?.from.email).toBe(PLATFORM_FROM);

    const html = capturedBody?.content.find((c) => c.type === "text/html")?.value;
    expect(html).toBeTruthy();
    expect(html).toContain("MEGA_CRM_RESET_PASSWORD_TEMPLATE");
    expect(html).not.toMatch(/template_id/i);
  });

  it("sendVerification authenticates with the platform key and uses the in-repo verify-email template", async () => {
    let capturedAuth: string | undefined;
    let capturedBody: CapturedMailBody | undefined;

    const scope = nock("https://api.sendgrid.com", {
      reqheaders: {
        authorization: (value) => {
          capturedAuth = value;
          return true;
        },
      },
    })
      .post("/v3/mail/send", (body: CapturedMailBody) => {
        capturedBody = body;
        return true;
      })
      .reply(202, "", { "x-message-id": "test-verify-msg-id" });

    const { platformMail } = await import("../client.js");
    await platformMail.sendVerification({
      to: "user@example.com",
      verifyUrl: "https://api.megacrm.test/api/auth/verify-email?token=xyz789",
    });

    expect(scope.isDone()).toBe(true);
    expect(capturedAuth).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(capturedBody?.from.email).toBe(PLATFORM_FROM);

    const html = capturedBody?.content.find((c) => c.type === "text/html")?.value;
    expect(html).toBeTruthy();
    expect(html).toContain("MEGA_CRM_VERIFY_EMAIL_TEMPLATE");
    expect(html).not.toMatch(/template_id/i);
  });

  it("sendInvite authenticates with the platform key and uses the in-repo invite template", async () => {
    let capturedAuth: string | undefined;
    let capturedBody: CapturedMailBody | undefined;

    const scope = nock("https://api.sendgrid.com", {
      reqheaders: {
        authorization: (value) => {
          capturedAuth = value;
          return true;
        },
      },
    })
      .post("/v3/mail/send", (body: CapturedMailBody) => {
        capturedBody = body;
        return true;
      })
      .reply(202, "", { "x-message-id": "test-invite-msg-id" });

    const { platformMail } = await import("../client.js");
    await platformMail.sendInvite({
      to: "invitee@example.com",
      inviteUrl: "https://app.megacrm.test/invite/tok",
      orgName: "Acme",
    });

    expect(scope.isDone()).toBe(true);
    expect(capturedAuth).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(capturedBody?.from.email).toBe(PLATFORM_FROM);

    const html = capturedBody?.content.find((c) => c.type === "text/html")?.value;
    expect(html).toBeTruthy();
    expect(html).toContain("MEGA_CRM_INVITE_TEMPLATE");
    expect(html).not.toMatch(/template_id/i);
  });

  it("renderInviteHtml HTML-escapes an attacker-controlled orgName (CR-02)", async () => {
    const { renderInviteHtml } = await import("../templates/invite.js");

    const tagName = "script";
    const payload = `Acme<${tagName}>alert(1)</${tagName}>`;
    const html = renderInviteHtml({ inviteUrl: "https://app.megacrm.test/invite/tok", orgName: payload });

    expect(html).toContain("&lt;");
    expect(html).toContain("&gt;");
    expect(html).not.toContain(`<${tagName}>`);
    expect(html).not.toContain(`</${tagName}>`);

    const plain = renderInviteHtml({ inviteUrl: "https://app.megacrm.test/invite/tok", orgName: "Acme" });
    expect(plain).toContain("Acme");
    expect(plain).toContain("MEGA_CRM_INVITE_TEMPLATE");
  });

  it("does not import the tenant sendgrid-key/KMS module (two-key separation, RESEARCH Pitfall 4)", () => {
    const source = readFileSync(path.resolve(__dirname, "../client.ts"), "utf8");
    expect(source).not.toMatch(/sendgrid-key\.repository/);
    expect(source).not.toMatch(/kms\/client/i);
    expect(source).not.toMatch(/kms-client/i);
  });
});
