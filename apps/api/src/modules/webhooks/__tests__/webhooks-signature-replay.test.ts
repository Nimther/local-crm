import { describe, expect, it } from "vitest";
import fixture from "./fixtures/uat-signed-payload.json" with { type: "json" };

/**
 * Phase 16 (UAT-03/UAT-04): this import is deliberately unconditional.
 * The captured SendGrid signature is a permanent CI input; deleting or
 * corrupting it must turn this suite red rather than silently skipping the
 * only real-account signature evidence in the repository.
 */
describe("real SendGrid signed replay fixture integrity", () => {
  it("contains exactly the four non-empty capture fields", () => {
    expect(Object.keys(fixture).sort()).toEqual(
      ["publicKey", "rawBodyBase64", "signature", "timestamp"].sort()
    );

    for (const key of ["rawBodyBase64", "signature", "timestamp", "publicKey"] as const) {
      expect(fixture[key], `${key} must be a non-empty string`).toEqual(expect.any(String));
      expect(fixture[key].length, `${key} must not be empty`).toBeGreaterThan(0);
    }
  });

  it("decodes the raw body as canonical base64", () => {
    const decoded = Buffer.from(fixture.rawBodyBase64, "base64");

    expect(decoded.length).toBeGreaterThan(0);
    expect(decoded.toString("base64")).toBe(fixture.rawBodyBase64);
  });

  it("contains a JSON array of webhook events", () => {
    const decoded = Buffer.from(fixture.rawBodyBase64, "base64");
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));

    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBeGreaterThan(0);
  });

  it("carries the signed timestamp as a numeric string", () => {
    expect(fixture.timestamp).toMatch(/^\d+$/);
  });
});
