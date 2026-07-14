import { describe, expect, it } from "vitest";

import { applySendTargetToParams, resolveSendTargetLabel } from "../send-log-filters";

/**
 * 07-10 (gap closure, UAT Test 1): pure helpers for the send-log's
 * campaign/flow target filter. Mirrors campaign⊕flow mutual exclusion
 * (campaignOrFlowId = campaignId ?? flowId, SendLogPage.tsx) and the
 * campaign-metrics.ts / campaign-metrics.test.ts style precedent (07-08).
 */
describe("applySendTargetToParams", () => {
  it("sets campaign, deletes flow and page, and preserves unrelated params", () => {
    const current = new URLSearchParams();
    current.append("status", "opened");
    current.append("status", "clicked");
    current.set("period", "7");
    current.set("flow", "F1");
    current.set("page", "3");

    const result = applySendTargetToParams(current, { kind: "campaign", id: "C1" });

    expect(result.get("campaign")).toBe("C1");
    expect(result.has("flow")).toBe(false);
    expect(result.has("page")).toBe(false);
    expect(result.getAll("status")).toEqual(["opened", "clicked"]);
    expect(result.get("period")).toBe("7");
  });

  it("sets flow, deletes campaign and page", () => {
    const current = new URLSearchParams();
    current.set("campaign", "C1");
    current.set("page", "2");

    const result = applySendTargetToParams(current, { kind: "flow", id: "F1" });

    expect(result.get("flow")).toBe("F1");
    expect(result.has("campaign")).toBe(false);
    expect(result.has("page")).toBe(false);
  });

  it("deletes both campaign and flow on null target, preserving unrelated params", () => {
    const current = new URLSearchParams();
    current.set("campaign", "C1");
    current.set("flow", "F1");
    current.set("period", "90");

    const result = applySendTargetToParams(current, null);

    expect(result.has("campaign")).toBe(false);
    expect(result.has("flow")).toBe(false);
    expect(result.get("period")).toBe("90");
  });

  it("never mutates the input URLSearchParams", () => {
    const current = new URLSearchParams();
    current.set("campaign", "C1");
    current.set("flow", "F1");
    current.set("period", "90");
    const before = current.toString();

    applySendTargetToParams(current, { kind: "campaign", id: "C2" });

    expect(current.toString()).toBe(before);
  });
});

describe("resolveSendTargetLabel", () => {
  const campaigns = [
    { id: "C1", name: "Летняя распродажа" },
    { id: "C2", name: "Осенний анонс" },
  ];
  const flows = [
    { id: "F1", name: "Приветственная цепочка" },
    { id: "F2", name: "Брошенная корзина" },
  ];

  it("resolves a campaignId present in the list", () => {
    expect(resolveSendTargetLabel("C1", undefined, campaigns, flows)).toEqual({
      kind: "campaign",
      id: "C1",
      label: "Летняя распродажа",
    });
  });

  it("resolves a flowId present in the list when only flowId is set", () => {
    expect(resolveSendTargetLabel(undefined, "F1", campaigns, flows)).toEqual({
      kind: "flow",
      id: "F1",
      label: "Приветственная цепочка",
    });
  });

  it("prefers campaign over flow when both are set", () => {
    expect(resolveSendTargetLabel("C1", "F1", campaigns, flows)).toEqual({
      kind: "campaign",
      id: "C1",
      label: "Летняя распродажа",
    });
  });

  it("falls back to the raw id label when campaignId is not found in the list", () => {
    expect(resolveSendTargetLabel("C-stale", undefined, campaigns, flows)).toEqual({
      kind: "campaign",
      id: "C-stale",
      label: "C-stale",
    });
  });

  it("returns null when both campaignId and flowId are undefined", () => {
    expect(resolveSendTargetLabel(undefined, undefined, campaigns, flows)).toBeNull();
  });
});
