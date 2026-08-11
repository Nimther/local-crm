import { describe, expect, it } from "vitest";
import {
  SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST,
  buildScrubbedSendEventPayload,
  buildScrubbedEventProperties,
} from "../erasure-scrub.worker.js";

/**
 * Phase 13 (CMP-04, D-01/D-04, plan 13-13), Task 1: the pure allowlist
 * reconstruction functions. Task 2 extends this file with the checkpointed,
 * bounded scrub over real `sends`/`send_events`/`events` rows.
 */
describe("buildScrubbedSendEventPayload (Task 1, T-13-13-01/03/06)", () => {
  function realisticSendGridPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      email: "erased@example.test",
      event: "bounce",
      type: "blocked",
      sg_event_id: "sg-event-fixture-1",
      sg_message_id: "sg-message-fixture-1.filterdrecv-x",
      "smtp-id": "<fixture@sendgrid.net>",
      timestamp: 1_700_000_000,
      status: "5.1.1",
      attempt: "1",
      asm_group_id: 42,
      bounce_classification: "hard bounce",
      // The two clearest denylist-failure cases (REVIEWS.md BLOCKER finding
      // 4): neither key name looks PII-shaped, yet the address is a
      // substring of a longer diagnostic string.
      reason: "550 5.1.1 <erased@example.test> User unknown",
      response: "550 5.1.1 The email account that you tried to reach does not exist: erased@example.test",
      // A tenant-invented key with an ordinary string value.
      custom_tenant_field: "some ordinary string",
      // A tenant-invented key holding a person's name -- no key-pattern or
      // value-pattern rule detects this shape.
      customer_full_name: "Ivan Petrov",
      // A nested object under a non-allowlisted key.
      unique_args: { order_id: "ord-123", nested: { deeper: "still PII-adjacent" } },
      ip: "203.0.113.5",
      useragent: "Mozilla/5.0",
      url: "https://tenant.example/click?rcpt=erased@example.test",
      url_offset: { index: 0, type: "html" },
      category: ["welcome-series"],
      ...overrides,
    };
  }

  it("returns an object whose key set is a subset of the allowlist", () => {
    const result = buildScrubbedSendEventPayload(realisticSendGridPayload());
    for (const key of Object.keys(result)) {
      expect(SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST as readonly string[]).toContain(key);
    }
  });

  it("drops the top-level email key and keeps event/timestamp/sg_event_id with original values", () => {
    const input = realisticSendGridPayload();
    const result = buildScrubbedSendEventPayload(input);
    expect(result).not.toHaveProperty("email");
    expect(result.event).toBe(input.event);
    expect(result.timestamp).toBe(input.timestamp);
    expect(result.sg_event_id).toBe(input.sg_event_id);
  });

  it("drops reason and response (SMTP text embedding the recipient address verbatim inside a longer string)", () => {
    const result = buildScrubbedSendEventPayload(realisticSendGridPayload());
    expect(result).not.toHaveProperty("reason");
    expect(result).not.toHaveProperty("response");
    expect(JSON.stringify(result)).not.toContain("erased@example.test");
  });

  it("drops a tenant-defined key matching no rule in any redaction vocabulary, with an ordinary string value", () => {
    const result = buildScrubbedSendEventPayload(realisticSendGridPayload());
    expect(result).not.toHaveProperty("custom_tenant_field");
  });

  it("drops a never-seen-before key whose value is a person's full name", () => {
    const result = buildScrubbedSendEventPayload(realisticSendGridPayload());
    expect(result).not.toHaveProperty("customer_full_name");
    expect(JSON.stringify(result)).not.toContain("Ivan Petrov");
  });

  it("drops a nested object entirely when its key is not allowlisted, without needing to inspect nested contents", () => {
    const result = buildScrubbedSendEventPayload(realisticSendGridPayload());
    expect(result).not.toHaveProperty("unique_args");
    expect(JSON.stringify(result)).not.toContain("nested");
  });

  it("omits an allowlisted key absent from the input rather than inserting it as null", () => {
    const result = buildScrubbedSendEventPayload({ event: "delivered" });
    expect(result).toEqual({ event: "delivered" });
    expect(result).not.toHaveProperty("sg_event_id");
  });

  it("leaves event, timestamp, sg_event_id present with original values on a realistic fixture", () => {
    const input = realisticSendGridPayload();
    const result = buildScrubbedSendEventPayload(input);
    expect(result.event).toBe(input.event);
    expect(result.timestamp).toBe(input.timestamp);
    expect(result.sg_event_id).toBe(input.sg_event_id);
  });

  it("is idempotent: applying twice equals applying once", () => {
    const input = realisticSendGridPayload();
    const once = buildScrubbedSendEventPayload(input);
    const twice = buildScrubbedSendEventPayload(once);
    expect(twice).toEqual(once);
  });

  it("returns an empty object for null, an array, or a non-object input, without throwing", () => {
    expect(buildScrubbedSendEventPayload(null)).toEqual({});
    expect(buildScrubbedSendEventPayload([1, 2])).toEqual({});
    expect(buildScrubbedSendEventPayload("not an object")).toEqual({});
    expect(buildScrubbedSendEventPayload(undefined)).toEqual({});
  });

  it("for every key in the output over an input that is a strict superset of the allowlist, that key is a member of the allowlist", () => {
    const superset: Record<string, unknown> = {};
    for (const key of SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST) {
      superset[key] = `value-for-${key}`;
    }
    superset.extra_field_not_on_allowlist = "should not survive";
    const result = buildScrubbedSendEventPayload(superset);
    for (const key of Object.keys(result)) {
      expect(SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST as readonly string[]).toContain(key);
    }
    expect(result).not.toHaveProperty("extra_field_not_on_allowlist");
  });
});

describe("buildScrubbedEventProperties (Task 1, T-13-13-01)", () => {
  it("returns an empty object for every input, including one containing only innocuous keys", () => {
    expect(buildScrubbedEventProperties({ order_total: 42, shipping_address: "123 Main St" })).toEqual({});
    expect(buildScrubbedEventProperties({ favorite_color: "blue" })).toEqual({});
    expect(buildScrubbedEventProperties({})).toEqual({});
    expect(buildScrubbedEventProperties(null)).toEqual({});
  });

  it("is idempotent: applying twice equals applying once", () => {
    const once = buildScrubbedEventProperties({ anything: "at all" });
    const twice = buildScrubbedEventProperties(once);
    expect(twice).toEqual(once);
    expect(twice).toEqual({});
  });

  it("imports nothing from @mega-crm/redaction and defines no PII-shaped regular expression (module source check)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.resolve(import.meta.dirname, "../erasure-scrub.worker.ts"),
      "utf8"
    );
    // The check is against the source file's IMPORT list, not its prose --
    // the package name appears in this module's own doc comments to explain
    // why it is NOT the mechanism used here.
    expect(source).not.toMatch(/from\s+["']@mega-crm\/redaction["']/);
    // no email/phone-shaped regex literal defined in this module
    expect(source).not.toMatch(/\/[a-zA-Z0-9@.]*@[a-zA-Z0-9.]*\//); // no inline @-containing regex literal
  });
});
