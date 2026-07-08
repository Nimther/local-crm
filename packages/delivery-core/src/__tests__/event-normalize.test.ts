import { describe, expect, it } from "vitest";
import { normalizeEventType } from "../event-normalize.js";

describe("normalizeEventType (WBHK-02)", () => {
  it("maps delivered/open/click/dropped/spamreport/unsubscribe/group_unsubscribe to their stable normalized types", () => {
    expect(normalizeEventType({ event: "delivered" })).toBe("delivered");
    expect(normalizeEventType({ event: "open" })).toBe("open");
    expect(normalizeEventType({ event: "click" })).toBe("click");
    expect(normalizeEventType({ event: "dropped" })).toBe("dropped");
    expect(normalizeEventType({ event: "spamreport" })).toBe("spam_report");
    expect(normalizeEventType({ event: "unsubscribe" })).toBe("unsubscribe");
    expect(normalizeEventType({ event: "group_unsubscribe" })).toBe("group_unsubscribe");
  });

  it("distinguishes hard vs soft bounce by the type field (D-10)", () => {
    expect(normalizeEventType({ event: "bounce", type: "bounce" })).toBe("bounce_hard");
    expect(normalizeEventType({ event: "bounce", type: "blocked" })).toBe("bounce_soft");
  });

  it("treats a bounce with no type field as hard bounce", () => {
    expect(normalizeEventType({ event: "bounce" })).toBe("bounce_hard");
  });

  it("returns null for out-of-scope events (processed and unknown events)", () => {
    expect(normalizeEventType({ event: "processed" })).toBeNull();
    expect(normalizeEventType({ event: "deferred" })).toBeNull();
    expect(normalizeEventType({ event: "group_resubscribe" })).toBeNull();
    expect(normalizeEventType({ event: "account_status_change" })).toBeNull();
    expect(normalizeEventType({ event: "some_unknown_future_event" })).toBeNull();
  });
});
