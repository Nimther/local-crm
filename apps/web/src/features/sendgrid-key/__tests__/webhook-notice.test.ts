import { describe, expect, it } from "vitest";

import {
  reconnectToastForHealth,
  webhookHealthDescription,
  webhookNoticeForKeyResponse,
} from "../webhook-notice";

// DOM/component testing (e.g. asserting SendGridKeySettings' rendered toast
// or inline warning) is intentionally out of scope for this lane -- no
// jsdom/@testing-library install exists in apps/web (mirrors the
// segmentSaveGate precedent). These pure decision helpers are covered here;
// the rendering itself is exercised by phase UAT.

describe("webhookNoticeForKeyResponse", () => {
  it("returns the webhookWarning string when present", () => {
    expect(webhookNoticeForKeyResponse({ webhookWarning: "X" })).toBe("X");
  });

  it("returns null when webhookWarning is absent", () => {
    expect(webhookNoticeForKeyResponse({})).toBeNull();
  });
});

describe("reconnectToastForHealth", () => {
  it("returns an error variant with the provisionError message when provisionStatus is 'error'", () => {
    expect(reconnectToastForHealth({ provisionStatus: "error", provisionError: "нет прав" })).toEqual({
      variant: "error",
      message: "нет прав",
    });
  });

  it("falls back to a generic message when provisionStatus is 'error' but provisionError is null", () => {
    const result = reconnectToastForHealth({ provisionStatus: "error", provisionError: null });
    expect(result.variant).toBe("error");
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("returns a success variant when provisionStatus is 'active'", () => {
    expect(reconnectToastForHealth({ provisionStatus: "active", provisionError: null })).toEqual({
      variant: "success",
      message: "Отслеживание доставки переподключено",
    });
  });

  it("returns a success variant when provisionStatus is 'pending'", () => {
    const result = reconnectToastForHealth({ provisionStatus: "pending", provisionError: null });
    expect(result.variant).toBe("success");
  });
});

describe("webhookHealthDescription", () => {
  it("returns the provisionError reason when provisionStatus is 'error' and a reason is present", () => {
    expect(
      webhookHealthDescription({ provisionStatus: "error", provisionError: "нет прав", lastEventAt: null })
    ).toBe("нет прав");
  });

  it("returns null when provisionStatus is 'error' but provisionError is null (caller falls back)", () => {
    expect(
      webhookHealthDescription({ provisionStatus: "error", provisionError: null, lastEventAt: null })
    ).toBeNull();
  });

  it("returns null when provisionStatus is 'active' (caller falls back to its own last-event rendering)", () => {
    expect(
      webhookHealthDescription({ provisionStatus: "active", provisionError: null, lastEventAt: "2026-07-09T00:00:00Z" })
    ).toBeNull();
  });

  it("returns null when provisionStatus is 'pending'", () => {
    expect(
      webhookHealthDescription({ provisionStatus: "pending", provisionError: null, lastEventAt: null })
    ).toBeNull();
  });
});
