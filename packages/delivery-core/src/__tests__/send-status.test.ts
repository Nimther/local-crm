import { describe, expect, it } from "vitest";
import { deriveCurrentStatus, type DeliveryFacts } from "../send-status.js";

const NOW = new Date("2026-07-08T12:00:00Z");

describe("deriveCurrentStatus (D-06 priority order)", () => {
  it("bounced wins over any open/click/delivered fact (terminal)", () => {
    const facts: DeliveryFacts = {
      bouncedAt: NOW,
      deliveredAt: NOW,
      firstOpenedAt: NOW,
      firstClickedAt: NOW,
    };
    expect(deriveCurrentStatus(facts, "sent")).toBe("bounced");
  });

  it("dropped is terminal", () => {
    expect(deriveCurrentStatus({ droppedAt: NOW, firstClickedAt: NOW }, "sent")).toBe("dropped");
  });

  it("spam_reported is terminal", () => {
    expect(deriveCurrentStatus({ spamReportedAt: NOW, deliveredAt: NOW }, "sent")).toBe("spam");
  });

  it("among non-terminal facts, clicked beats opened and delivered", () => {
    expect(
      deriveCurrentStatus({ firstClickedAt: NOW, firstOpenedAt: NOW, deliveredAt: NOW }, "sent")
    ).toBe("clicked");
  });

  it("opened beats delivered when not clicked", () => {
    expect(deriveCurrentStatus({ firstOpenedAt: NOW, deliveredAt: NOW }, "sent")).toBe("opened");
  });

  it("delivered wins when no open/click/terminal fact is set", () => {
    expect(deriveCurrentStatus({ deliveredAt: NOW }, "sent")).toBe("delivered");
  });

  it("falls back to baseStatus when no delivery facts are set", () => {
    expect(deriveCurrentStatus({}, "sent")).toBe("sent");
  });

  it("is order-insensitive -- constructing the same fact set in different key orders yields the same result", () => {
    const factsA: DeliveryFacts = { deliveredAt: NOW, firstOpenedAt: NOW, firstClickedAt: NOW, bouncedAt: NOW };
    const factsB: DeliveryFacts = { bouncedAt: NOW, firstClickedAt: NOW, firstOpenedAt: NOW, deliveredAt: NOW };
    expect(deriveCurrentStatus(factsA, "sent")).toBe(deriveCurrentStatus(factsB, "sent"));
    expect(deriveCurrentStatus(factsA, "sent")).toBe("bounced");
  });
});
