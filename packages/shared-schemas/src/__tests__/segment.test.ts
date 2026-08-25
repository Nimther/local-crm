import { describe, expect, it } from "vitest";
import {
  attributeConditionSchema,
  segmentDefinitionSchema,
  STANDARD_FIELD_KEYS,
} from "../segment.js";

describe("STANDARD_FIELD_KEYS", () => {
  it("has exactly 7 keys, including tags, in sync with segments-core's STANDARD_FIELD_COLUMNS", () => {
    expect(STANDARD_FIELD_KEYS).toHaveLength(7);
    expect(STANDARD_FIELD_KEYS).toEqual([
      "country",
      "city",
      "firstName",
      "lastName",
      "phone",
      "subscriptionStatus",
      "tags",
    ]);
    expect(STANDARD_FIELD_KEYS).toContain("tags");
  });
});

describe("attributeConditionSchema -- standard source", () => {
  it("fails safeParse when field is an empty string (CR-01 root cause)", () => {
    const result = attributeConditionSchema.safeParse({
      type: "attribute",
      source: "standard",
      field: "",
      operator: "eq",
      value: "RU",
    });
    expect(result.success).toBe(false);
  });

  it("fails safeParse when field is an unknown standard field", () => {
    const result = attributeConditionSchema.safeParse({
      type: "attribute",
      source: "standard",
      field: "totallyUnknownField",
      operator: "eq",
      value: "RU",
    });
    expect(result.success).toBe(false);
  });

  it("passes safeParse for field:country with a valid operator/value", () => {
    const result = attributeConditionSchema.safeParse({
      type: "attribute",
      source: "standard",
      field: "country",
      operator: "eq",
      value: "RU",
    });
    expect(result.success).toBe(true);
  });

  it("passes safeParse for field:tags with operator has_tag (D-03/D-04)", () => {
    const result = attributeConditionSchema.safeParse({
      type: "attribute",
      source: "standard",
      field: "tags",
      operator: "has_tag",
      value: "vip",
    });
    expect(result.success).toBe(true);
  });

  it("fails closed on inherited Object.prototype field names (constructor, toString, hasOwnProperty, __proto__)", () => {
    for (const field of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const result = attributeConditionSchema.safeParse({
        type: "attribute",
        source: "standard",
        field,
        operator: "eq",
        value: "x",
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("attributeConditionSchema -- custom source", () => {
  it("fails safeParse when a custom field is an empty string", () => {
    const result = attributeConditionSchema.safeParse({
      type: "attribute",
      source: "custom",
      field: "",
      operator: "is_empty",
    });
    expect(result.success).toBe(false);
  });

  it("fails safeParse when a custom field is whitespace-only", () => {
    const result = attributeConditionSchema.safeParse({
      type: "attribute",
      source: "custom",
      field: "   ",
      operator: "is_empty",
    });
    expect(result.success).toBe(false);
  });

  it("passes safeParse for a non-empty custom field", () => {
    const result = attributeConditionSchema.safeParse({
      type: "attribute",
      source: "custom",
      field: "coupon",
      operator: "is_empty",
    });
    expect(result.success).toBe(true);
  });
});

describe("segmentDefinitionSchema -- boundary integration", () => {
  it("rejects a full segment definition containing an unknown standard field", () => {
    const result = segmentDefinitionSchema.safeParse({
      version: 1,
      groups: [
        {
          conditions: [
            { type: "attribute", source: "standard", field: "", operator: "eq", value: "x" },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a full segment definition with a valid tags condition", () => {
    const result = segmentDefinitionSchema.safeParse({
      version: 1,
      groups: [
        {
          conditions: [
            { type: "attribute", source: "standard", field: "tags", operator: "has_tag", value: "vip" },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

/**
 * The user-selectable group combinator has to survive the API boundary, not
 * just the compiler. `segmentDefinitionSchema` declares neither `.strict()`
 * nor `.passthrough()`, so Zod's default behavior STRIPS unknown keys: a
 * combinator wired only into the UI would be silently dropped here and the
 * segment saved as AND with no error anywhere -- "the toggle exists but does
 * nothing", with no diagnosable signal. These tests are the boundary guard
 * for that failure mode. The same schema is embedded in
 * `segmentResponseSchema`, so it closes the strip in both directions.
 */
describe("segmentDefinitionSchema -- groupCombinator at the API boundary", () => {
  const GROUPS = [
    { conditions: [{ type: "attribute", source: "standard", field: "country", operator: "eq", value: "RU" }] },
    { conditions: [{ type: "attribute", source: "standard", field: "city", operator: "eq", value: "Moscow" }] },
  ];

  /**
   * Reads the key structurally rather than off the inferred type, so these
   * tests compile BEFORE the schema carries the field and stay valid after.
   */
  function combinatorOf(data: unknown): unknown {
    return (data as { groupCombinator?: unknown } | undefined)?.groupCombinator;
  }

  it("preserves groupCombinator 'or' through parse instead of silently stripping it", () => {
    const result = segmentDefinitionSchema.safeParse({ version: 1, groupCombinator: "or", groups: GROUPS });
    expect(result.success).toBe(true);
    expect(combinatorOf(result.data)).toBe("or");
  });

  it("preserves an explicit groupCombinator 'and' through parse", () => {
    const result = segmentDefinitionSchema.safeParse({ version: 1, groupCombinator: "and", groups: GROUPS });
    expect(result.success).toBe(true);
    expect(combinatorOf(result.data)).toBe("and");
  });

  it("defaults a definition with no groupCombinator to 'and' (backwards-compatible with stored version:1 rows)", () => {
    const result = segmentDefinitionSchema.safeParse({ version: 1, groups: GROUPS });
    expect(result.success).toBe(true);
    expect(combinatorOf(result.data)).toBe("and");
  });

  it("fails closed on an out-of-enum groupCombinator instead of stripping it and defaulting to and", () => {
    for (const bogus of ["xor", "AND", "", "nand", 1, null]) {
      const result = segmentDefinitionSchema.safeParse({ version: 1, groupCombinator: bogus, groups: GROUPS });
      expect(result.success, `groupCombinator ${JSON.stringify(bogus)} must be rejected`).toBe(false);
    }
  });
});
