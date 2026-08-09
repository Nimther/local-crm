import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { provisionEventWebhook } from "../sendgrid-webhook-provision.js";

const API_KEY = "SG.mock_event_flags_key_1234567890abcdef";
const CALLBACK_URL = "https://api.test.local/webhooks/sendgrid/tok-flags-1";
const TEST_WORKSPACE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Every flag the phase-5 subscription already enabled -- must survive the D-06 change with no regression. */
const PRE_EXISTING_FLAGS = [
  "delivered",
  "bounce",
  "dropped",
  "open",
  "click",
  "unsubscribe",
  "group_unsubscribe",
  "spam_report",
] as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Phase 11 (D-06, 11-07): `EVENT_FLAGS` gains `processed: true` (primary
 * acceptance evidence for the reconciler) and `deferred` stays deliberately
 * absent. Same stubbed-`fetch`-only convention as `webhook-provisioning.test.ts`
 * (no live network, no nock) -- captures the CREATE and PATCH bodies
 * independently so the parity assertion below compares the two captured
 * bodies against EACH OTHER, not against two hand-written literal lists that
 * could drift from the real EVENT_FLAGS const.
 */
describe("provisionEventWebhook event flags (D-06, 11-07)", () => {
  let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<unknown>>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function route(handler: (method: string, url: string, body: unknown) => Response | undefined) {
    // eslint-disable-next-line @typescript-eslint/require-await -- test double: the signature must match the async function it replaces at the DI seam; a stub having nothing to await is the point
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

  /** Drives a fresh CREATE (no existingWebhookId) and captures the POST body. */
  async function captureCreateBody(): Promise<Record<string, unknown>> {
    let createBody: Record<string, unknown> | undefined;
    route((method, url, body) => {
      if (method === "GET" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/all") {
        return jsonResponse(200, { webhooks: [], max_allowed: 10 });
      }
      if (method === "POST" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings") {
        createBody = body as Record<string, unknown>;
        return jsonResponse(200, { id: "wh_create_flags" });
      }
      if (
        method === "PATCH" &&
        url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/signed/wh_create_flags"
      ) {
        return jsonResponse(200, { id: "wh_create_flags", public_key: "PUBLICKEYVALUE" });
      }
      return undefined;
    });

    await provisionEventWebhook(API_KEY, CALLBACK_URL, TEST_WORKSPACE_ID);
    if (!createBody) {
      throw new Error("test setup failure: CREATE body was never captured");
    }
    return createBody;
  }

  /** Drives a PATCH (existingWebhookId supplied) and captures the PATCH body. */
  async function capturePatchBody(): Promise<Record<string, unknown>> {
    let patchBody: Record<string, unknown> | undefined;
    route((method, url, body) => {
      if (method === "PATCH" && url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/wh_patch_flags") {
        patchBody = body as Record<string, unknown>;
        return jsonResponse(200, { id: "wh_patch_flags" });
      }
      if (
        method === "PATCH" &&
        url === "https://api.sendgrid.com/v3/user/webhooks/event/settings/signed/wh_patch_flags"
      ) {
        return jsonResponse(200, { id: "wh_patch_flags", public_key: "PUBLICKEYVALUE" });
      }
      return undefined;
    });

    await provisionEventWebhook(API_KEY, CALLBACK_URL, TEST_WORKSPACE_ID, "wh_patch_flags");
    if (!patchBody) {
      throw new Error("test setup failure: PATCH body was never captured");
    }
    return patchBody;
  }

  it("the CREATE body contains processed: true and no deferred key", async () => {
    const createBody = await captureCreateBody();
    expect(createBody.processed).toBe(true);
    expect("deferred" in createBody).toBe(false);
  });

  it("the PATCH body contains processed: true and no deferred key", async () => {
    const patchBody = await capturePatchBody();
    expect(patchBody.processed).toBe(true);
    expect("deferred" in patchBody).toBe(false);
  });

  it("every previously-enabled flag is still true on the CREATE body -- no regression to the Phase 5 subscription", async () => {
    const createBody = await captureCreateBody();
    for (const flag of PRE_EXISTING_FLAGS) {
      expect(createBody[flag], `expected ${flag} to stay true`).toBe(true);
    }
  });

  it("every previously-enabled flag is still true on the PATCH body -- no regression to the Phase 5 subscription", async () => {
    const patchBody = await capturePatchBody();
    for (const flag of PRE_EXISTING_FLAGS) {
      expect(patchBody[flag], `expected ${flag} to stay true`).toBe(true);
    }
  });

  it("CREATE and PATCH carry an identical event-flag set -- compared against EACH OTHER, not two hand-written lists", async () => {
    const createBody = await captureCreateBody();
    const patchBody = await capturePatchBody();

    // Compare only the event-flag keys (exclude the non-flag fields every
    // body also carries: enabled/url/friendly_name) -- everything else is
    // exactly EVENT_FLAGS spread verbatim at both call sites, so a diff here
    // would mean the two spread sites have drifted apart.
    const NON_FLAG_KEYS = new Set(["enabled", "url", "friendly_name"]);
    const flagsOf = (body: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(body).filter(([key]) => !NON_FLAG_KEYS.has(key)));

    expect(flagsOf(createBody)).toEqual(flagsOf(patchBody));
    // Sanity: the comparison above is meaningful only if it actually covers
    // processed (the new flag) and excludes deferred (the deliberately
    // absent one) on BOTH sides -- assert that explicitly so a future
    // refactor that empties NON_FLAG_KEYS's filtering can't make this pass
    // vacuously.
    expect(flagsOf(createBody).processed).toBe(true);
    expect("deferred" in flagsOf(createBody)).toBe(false);
  });
});
