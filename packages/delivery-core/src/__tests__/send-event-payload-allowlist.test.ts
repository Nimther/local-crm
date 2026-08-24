import { describe, expect, it } from "vitest";
import {
  SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST,
  SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST,
  buildScrubbedSendEventPayload,
  buildExportSendEventPayload,
  buildScrubbedEventProperties,
} from "../send-event-payload-allowlist.js";

/**
 * Phase 21 (DSR-03, D-02/D-03, plan 21-02), Task 1: the single shared
 * definition of both `send_events.payload` allowlists -- the pre-existing
 * evidence allowlist (relocated verbatim from `erasure-scrub.worker.ts`) and
 * the new export allowlist, which is asserted here to be a STRUCTURAL
 * superset of the evidence list, not merely a documented one. A future edit
 * that widens the export list without a decision fails
 * "adds exactly the subject's own single-recipient fields" below.
 */
describe("SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST is a superset of SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST (D-02)", () => {
  it("export allowlist is a superset of the evidence allowlist", () => {
    for (const key of SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST) {
      expect(SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST as readonly string[]).toContain(key);
    }
  });

  it("export allowlist adds exactly the subject's own single-recipient fields", () => {
    const evidenceSet = new Set<string>(SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST);
    const difference = (SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST as readonly string[]).filter(
      (key) => !evidenceSet.has(key)
    );
    expect(difference).toEqual(["ip", "useragent", "url", "reason"]);
  });
});

describe("buildExportSendEventPayload (D-02, build-up not tear-down)", () => {
  function realisticPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      // Evidence keys.
      event: "delivered",
      type: "blocked",
      timestamp: 1_700_000_000,
      sg_event_id: "sg-event-fixture-1",
      sg_message_id: "sg-message-fixture-1.filterdrecv-x",
      "smtp-id": "<fixture@sendgrid.net>",
      status: "5.1.1",
      attempt: "1",
      asm_group_id: 42,
      bounce_classification: "hard bounce",
      // Export-only keys (this subject's own single-recipient fields).
      ip: "203.0.113.5",
      useragent: "Mozilla/5.0",
      url: "https://tenant.example/click?rcpt=subject@example.test",
      reason: "550 5.1.1 <subject@example.test> User unknown",
      // Tenant-invented keys, one nesting another person's email.
      custom_tenant_field: "some ordinary string",
      unique_args: { order_id: "ord-123", referred_by_email: "other-subject@example.test" },
      ...overrides,
    };
  }

  it("copies allowlisted keys forward with original values", () => {
    const input = realisticPayload();
    const result = buildExportSendEventPayload(input);
    for (const key of SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST) {
      expect(result[key]).toEqual(input[key]);
    }
  });

  it("contains every allowlisted key and neither tenant-invented key, and never leaks the other subject's email", () => {
    const input = realisticPayload();
    const result = buildExportSendEventPayload(input);
    expect(result).not.toHaveProperty("custom_tenant_field");
    expect(result).not.toHaveProperty("unique_args");
    expect(JSON.stringify(result)).not.toContain("other-subject@example.test");
  });

  it("returns {} for null, an array, a string and a number", () => {
    expect(buildExportSendEventPayload(null)).toEqual({});
    expect(buildExportSendEventPayload([1, 2])).toEqual({});
    expect(buildExportSendEventPayload("not an object")).toEqual({});
    expect(buildExportSendEventPayload(42)).toEqual({});
    expect(buildExportSendEventPayload(undefined)).toEqual({});
  });

  it("omits an allowlisted key absent from the input rather than inserting it as null", () => {
    const result = buildExportSendEventPayload({ event: "delivered" });
    expect(result).toEqual({ event: "delivered" });
    expect(result).not.toHaveProperty("ip");
    expect(result).not.toHaveProperty("sg_event_id");
  });

  it("is idempotent: applying it to its own output is a fixed point", () => {
    const input = realisticPayload();
    const once = buildExportSendEventPayload(input);
    const twice = buildExportSendEventPayload(once);
    expect(twice).toEqual(once);
  });
});

describe("buildScrubbedSendEventPayload still drops all four export-only keys (evidence list unchanged)", () => {
  it("drops ip/useragent/url/reason from the erasure evidence output", () => {
    const input = {
      event: "delivered",
      ip: "203.0.113.5",
      useragent: "Mozilla/5.0",
      url: "https://tenant.example/click",
      reason: "550 5.1.1 <subject@example.test> User unknown",
    };
    const result = buildScrubbedSendEventPayload(input);
    expect(result).not.toHaveProperty("ip");
    expect(result).not.toHaveProperty("useragent");
    expect(result).not.toHaveProperty("url");
    expect(result).not.toHaveProperty("reason");
    expect(result).toEqual({ event: "delivered" });
  });
});

describe("buildScrubbedEventProperties returns {} for every input (D-01, unchanged by this plan)", () => {
  it("returns an empty object even for plausible-looking keys", () => {
    expect(buildScrubbedEventProperties({ order_total: 42, customer_email: "someone@example.test" })).toEqual({});
    expect(buildScrubbedEventProperties(null)).toEqual({});
    expect(buildScrubbedEventProperties({})).toEqual({});
  });
});
