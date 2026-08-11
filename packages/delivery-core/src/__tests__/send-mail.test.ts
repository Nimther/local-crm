import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { buildMailSendRequest, sendTenantMailV3, SENDGRID_TIMEOUT_MS } from "../send-mail.js";

function sampleParams(overrides: Partial<Parameters<typeof buildMailSendRequest>[0]> = {}) {
  return {
    to: "contact@example.com",
    templateId: "d-1234567890",
    fromEmail: "marketing@tenant.example.com",
    dynamicTemplateData: { first_name: "Ada" },
    listUnsubscribeUrl: "https://api.example.com/unsubscribe/abc.def",
    sendId: "11111111-1111-1111-1111-111111111111",
    workspaceId: "22222222-2222-2222-2222-222222222222",
    campaignId: "33333333-3333-3333-3333-333333333333",
    ...overrides,
  };
}

describe("buildMailSendRequest (D-04 forced tracking, D-15 test marker)", () => {
  it("forces open_tracking and click_tracking on alongside the existing subscription_tracking:false", () => {
    const result = buildMailSendRequest(sampleParams());
    expect(result.tracking_settings).toEqual({
      subscription_tracking: { enable: false },
      open_tracking: { enable: true },
      click_tracking: { enable: true },
    });
  });

  it("a campaign build (isTest omitted) has NO test custom_arg", () => {
    const result = buildMailSendRequest(sampleParams());
    const customArgs = result.personalizations[0].custom_args;
    expect(customArgs).not.toHaveProperty("test");
  });

  it("a campaign build (isTest: false) has NO test custom_arg", () => {
    const result = buildMailSendRequest(sampleParams({ isTest: false }));
    const customArgs = result.personalizations[0].custom_args;
    expect(customArgs).not.toHaveProperty("test");
  });

  it("a test build (isTest: true) has custom_args.test === 'true'", () => {
    const result = buildMailSendRequest(sampleParams({ isTest: true }));
    const customArgs = result.personalizations[0].custom_args;
    expect(customArgs.test).toBe("true");
  });

  it("send_id/workspace_id/campaign_id remain present in both campaign and test builds", () => {
    const campaignResult = buildMailSendRequest(sampleParams());
    const testResult = buildMailSendRequest(sampleParams({ isTest: true }));

    for (const result of [campaignResult, testResult]) {
      expect(result.personalizations[0].custom_args).toMatchObject({
        send_id: "11111111-1111-1111-1111-111111111111",
        workspace_id: "22222222-2222-2222-2222-222222222222",
        campaign_id: "33333333-3333-3333-3333-333333333333",
      });
    }
  });
});

/**
 * Phase 11 (D-15, DLV-06): `sendTenantMailV3`'s explicit `AbortSignal.timeout()`.
 * `sendTenantMailV3` hardcodes SendGrid's production URL, so these tests swap
 * `globalThis.fetch` for the duration of each test (restored in `finally`)
 * rather than injecting a base URL -- this exercises the REAL fetch call the
 * function makes, including the real `signal` it constructs, redirected to a
 * local fixture instead of the network.
 */
describe("sendTenantMailV3 timeout/abort (D-15, DLV-06)", () => {
  it("SENDGRID_TIMEOUT_MS is exported and equals the documented 20s value", () => {
    expect(SENDGRID_TIMEOUT_MS).toBe(20_000);
  });

  it("a normal 2xx response is returned unchanged -- the happy path is not altered by the added timeout", async () => {
    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/require-await -- test double: matches fetch's signature, nothing to await
    globalThis.fetch = async () =>
      new Response(null, { status: 202, headers: { "x-message-id": "sg-fixture-message-id" } });
    try {
      const result = await sendTenantMailV3("SG.fixture_key", buildMailSendRequest(sampleParams()));
      expect(result.status).toBe(202);
      expect(result.messageId).toBe("sg-fixture-message-id");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it(
    "rejects when the request does not respond within SENDGRID_TIMEOUT_MS (real AbortSignal.timeout(), real never-responding local server)",
    async () => {
      const server = createServer(() => {
        /* never respond -- forces the real abort to fire */
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        throw new Error("expected an AddressInfo from the ephemeral listener");
      }

      const realFetch = globalThis.fetch;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((_url: string, init?: RequestInit) =>
        realFetch(`http://127.0.0.1:${address.port}/`, init)) as typeof fetch;

      try {
        const start = Date.now();
        await expect(sendTenantMailV3("SG.does_not_matter", buildMailSendRequest(sampleParams()))).rejects.toBeInstanceOf(
          Error
        );
        const elapsedMs = Date.now() - start;
        // Comfortably under this test's own timeout -- proves SENDGRID_TIMEOUT_MS,
        // not the test harness's own limit, is what bounded the call.
        expect(elapsedMs).toBeLessThan(SENDGRID_TIMEOUT_MS + 5000);
      } finally {
        globalThis.fetch = originalFetch;
        server.close();
      }
    },
    SENDGRID_TIMEOUT_MS + 10_000
  );

  it("redacts the API key from the thrown error's message and stack, even on the abort path", async () => {
    const apiKey = "SG.super_secret_test_key_0000000000";
    const abortLikeError = new DOMException(`The operation was aborted for key ${apiKey}`, "AbortError");
    // DOMException's own `.stack` may not include the message on every
    // runtime -- force one so this test genuinely exercises stack redaction,
    // not just message redaction.
    Object.defineProperty(abortLikeError, "stack", {
      value: `AbortError: The operation was aborted for key ${apiKey}\n    at fixture`,
      configurable: true,
    });

    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/require-await -- test double: matches fetch's signature, the throw IS the behaviour under test
    globalThis.fetch = async () => {
      throw abortLikeError;
    };

    let caught: Error | undefined;
    try {
      await sendTenantMailV3(apiKey, buildMailSendRequest(sampleParams()));
    } catch (err) {
      caught = err as Error;
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toContain("[REDACTED]");
    expect(caught?.message).not.toContain(apiKey);
    expect(caught?.stack).toContain("[REDACTED]");
    expect(caught?.stack).not.toContain(apiKey);
  });
});
