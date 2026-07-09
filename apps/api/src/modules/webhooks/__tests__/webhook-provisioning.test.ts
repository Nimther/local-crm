import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionEventWebhook } from "../sendgrid-webhook-provision.js";

const API_KEY = "SG.mock_provisioning_key_1234567890abcdef";
const CALLBACK_URL = "https://api.test.local/webhooks/sendgrid/tok-abc123";
const TEST_WORKSPACE_ID = "11111111-2222-3333-4444-555555555555";
const EXPECTED_FRIENDLY_NAME = `Mega CRM Delivery Tracking (${TEST_WORKSPACE_ID.slice(0, 8)})`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * `provisionEventWebhook` (WBHK-01, D-01/D-02/D-05, Pitfall 4): stubbed
 * `fetch` only -- no live network, no nock. Routes on (method, url) so test
 * scenarios are independent of call ordering.
 */
describe("provisionEventWebhook (D-01/D-02/D-05)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function route(handler: (method: string, url: string, body: unknown) => Response | undefined) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const res = handler(method, url, body);
      if (!res) {
        throw new Error(`Unexpected fetch call: ${method} ${url}`);
      }
      return res;
    });
  }

  it("CREATE -> enable-signed returns { id, publicKey }", async () => {
    route((method, url) => {
      if (method === "GET" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/all") {
        return jsonResponse(200, { webhooks: [], max_allowed: 10 });
      }
      if (method === "POST" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings") {
        return jsonResponse(200, { id: "wh_new_123" });
      }
      if (
        method === "PATCH" &&
        url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/signed/wh_new_123"
      ) {
        return jsonResponse(200, { id: "wh_new_123", public_key: "PUBLICKEYVALUE" });
      }
      return undefined;
    });

    const result = await provisionEventWebhook(API_KEY, CALLBACK_URL, TEST_WORKSPACE_ID);

    expect(result).toEqual({ id: "wh_new_123", publicKey: "PUBLICKEYVALUE" });
  });

  it("friendly_name and group_unsubscribe:true appear in the CREATE body", async () => {
    let createBody: Record<string, unknown> | undefined;
    route((method, url, body) => {
      if (method === "GET" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/all") {
        return jsonResponse(200, { webhooks: [], max_allowed: 10 });
      }
      if (method === "POST" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings") {
        createBody = body as Record<string, unknown>;
        return jsonResponse(200, { id: "wh_new_456" });
      }
      if (
        method === "PATCH" &&
        url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/signed/wh_new_456"
      ) {
        return jsonResponse(200, { id: "wh_new_456", public_key: "PUBLICKEYVALUE" });
      }
      return undefined;
    });

    await provisionEventWebhook(API_KEY, CALLBACK_URL, TEST_WORKSPACE_ID);

    expect(createBody?.friendly_name).toBe(EXPECTED_FRIENDLY_NAME);
    expect(createBody?.group_unsubscribe).toBe(true);
  });

  it("existingWebhookId path PATCHes in place and never POSTs a create", async () => {
    let createCalled = false;
    let patchBody: Record<string, unknown> | undefined;
    route((method, url, body) => {
      if (method === "POST") {
        createCalled = true;
        return jsonResponse(200, { id: "should-not-happen" });
      }
      if (method === "PATCH" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/wh_existing_789") {
        patchBody = body as Record<string, unknown>;
        return jsonResponse(200, { id: "wh_existing_789" });
      }
      if (
        method === "PATCH" &&
        url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/signed/wh_existing_789"
      ) {
        return jsonResponse(200, { id: "wh_existing_789", public_key: "PUBLICKEYVALUE" });
      }
      return undefined;
    });

    const result = await provisionEventWebhook(API_KEY, CALLBACK_URL, TEST_WORKSPACE_ID, "wh_existing_789");

    expect(result).toEqual({ id: "wh_existing_789", publicKey: "PUBLICKEYVALUE" });
    expect(createCalled).toBe(false);
    expect(patchBody?.friendly_name).toBe(EXPECTED_FRIENDLY_NAME);
    expect(patchBody?.group_unsubscribe).toBe(true);
    expect(patchBody?.url).toBe(CALLBACK_URL);
  });

  it("a 403 scope response on PATCH returns { error: 'missing_scope' } without throwing", async () => {
    route((method, url) => {
      if (method === "PATCH" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/wh_scope_1") {
        return jsonResponse(403, { errors: [{ message: "Forbidden" }] });
      }
      return undefined;
    });

    const result = await provisionEventWebhook(API_KEY, CALLBACK_URL, TEST_WORKSPACE_ID, "wh_scope_1");

    expect(result).toEqual({ error: "missing_scope" });
  });

  it("a cap-reached listing (webhooks.length >= max_allowed) returns { error: 'cap_reached' } without POSTing", async () => {
    let createCalled = false;
    route((method, url) => {
      if (method === "GET" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/all") {
        return jsonResponse(200, {
          webhooks: [{ id: "wh_other_1", url: "https://tenant.example/hook", friendly_name: "Tenant's own" }],
          max_allowed: 1,
        });
      }
      if (method === "POST") {
        createCalled = true;
        return jsonResponse(200, { id: "should-not-happen" });
      }
      return undefined;
    });

    const result = await provisionEventWebhook(API_KEY, CALLBACK_URL, TEST_WORKSPACE_ID);

    expect(result).toEqual({ error: "cap_reached" });
    expect(createCalled).toBe(false);
  });

  it("a 404 on the primary CREATE path falls back to .../settings/all", async () => {
    let primaryAttempted = false;
    let fallbackAttempted = false;
    route((method, url) => {
      if (method === "GET" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/all") {
        return jsonResponse(200, { webhooks: [], max_allowed: 10 });
      }
      if (method === "POST" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings") {
        primaryAttempted = true;
        return jsonResponse(404, { errors: [{ message: "Not Found" }] });
      }
      if (method === "POST" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/all") {
        fallbackAttempted = true;
        return jsonResponse(200, { id: "wh_fallback_1" });
      }
      if (
        method === "PATCH" &&
        url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/signed/wh_fallback_1"
      ) {
        return jsonResponse(200, { id: "wh_fallback_1", public_key: "PUBLICKEYVALUE" });
      }
      return undefined;
    });

    const result = await provisionEventWebhook(API_KEY, CALLBACK_URL, TEST_WORKSPACE_ID);

    expect(primaryAttempted).toBe(true);
    expect(fallbackAttempted).toBe(true);
    expect(result).toEqual({ id: "wh_fallback_1", publicKey: "PUBLICKEYVALUE" });
  });

  it("an unexpected fetch exception is caught and returns { error: 'failed' } (never throws)", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error(`network unreachable, key=${API_KEY}`);
    });

    const result = await provisionEventWebhook(API_KEY, CALLBACK_URL, TEST_WORKSPACE_ID, "wh_boom");

    expect(result).toEqual({ error: "failed" });
  });

  it("reuse-by-name with a stale url PATCHes the webhook to the new callbackUrl before returning it active", async () => {
    let createCalled = false;
    let patchBody: Record<string, unknown> | undefined;
    route((method, url, body) => {
      if (method === "GET" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/all") {
        return jsonResponse(200, {
          webhooks: [
            {
              id: "wh_reuse_1",
              url: "https://api.test.local/webhooks/sendgrid/OLD-token",
              friendly_name: EXPECTED_FRIENDLY_NAME,
            },
          ],
          max_allowed: 10,
        });
      }
      if (method === "POST") {
        createCalled = true;
        return jsonResponse(200, { id: "should-not-happen" });
      }
      if (method === "PATCH" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/wh_reuse_1") {
        patchBody = body as Record<string, unknown>;
        return jsonResponse(200, { id: "wh_reuse_1" });
      }
      if (
        method === "PATCH" &&
        url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/signed/wh_reuse_1"
      ) {
        return jsonResponse(200, { id: "wh_reuse_1", public_key: "PUBLICKEYVALUE" });
      }
      return undefined;
    });

    const result = await provisionEventWebhook(API_KEY, CALLBACK_URL, TEST_WORKSPACE_ID);

    expect(createCalled).toBe(false);
    expect(patchBody?.url).toBe(CALLBACK_URL);
    expect(result).toEqual({ id: "wh_reuse_1", publicKey: "PUBLICKEYVALUE" });
  });

  it("a different workspace does not adopt a sibling's webhook (scoped friendly_name)", async () => {
    const SIBLING_WORKSPACE_ID = "bbbb2222-0000-0000-0000-000000000000";
    let createCalled = false;
    let patchedSibling = false;
    route((method, url, body) => {
      if (method === "GET" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/all") {
        return jsonResponse(200, {
          webhooks: [
            {
              id: "wh_sibling_A",
              url: "https://sibling.example/webhooks/sendgrid/A-token",
              friendly_name: "Mega CRM Delivery Tracking (aaaa1111)",
            },
          ],
          max_allowed: 10,
        });
      }
      if (method === "PATCH" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/wh_sibling_A") {
        patchedSibling = true;
        return jsonResponse(200, { id: "wh_sibling_A" });
      }
      if (method === "POST" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings") {
        createCalled = true;
        expect((body as Record<string, unknown>).friendly_name).toBe(
          "Mega CRM Delivery Tracking (bbbb2222)"
        );
        return jsonResponse(200, { id: "wh_new_B" });
      }
      if (
        method === "PATCH" &&
        url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/signed/wh_new_B"
      ) {
        return jsonResponse(200, { id: "wh_new_B", public_key: "PUBLICKEYVALUE" });
      }
      return undefined;
    });

    const result = await provisionEventWebhook(API_KEY, CALLBACK_URL, SIBLING_WORKSPACE_ID);

    expect(createCalled).toBe(true);
    expect(patchedSibling).toBe(false);
    expect(result).toEqual({ id: "wh_new_B", publicKey: "PUBLICKEYVALUE" });
  });
});
