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
