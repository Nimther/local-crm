import { describe, expect, it } from "vitest";
import { compileSegmentDefinition } from "../compile.js";
import type { SegmentDefinition } from "../types.js";

const WSID = "11111111-1111-1111-1111-111111111111";

function def(groups: SegmentDefinition["groups"]): SegmentDefinition {
  return { version: 1, groups };
}

describe("compileSegmentDefinition -- attribute conditions", () => {
  it("compiles a standard eq condition with the leading workspace_id clause", () => {
    const result = compileSegmentDefinition(
      def([{ conditions: [{ type: "attribute", source: "standard", field: "country", operator: "eq", value: "RU" }] }]),
      WSID
    );
    expect(result.whereSql.startsWith("c.workspace_id = $1 AND (")).toBe(true);
    expect(result.whereSql).toContain("c.country = $2");
    expect(result.params).toEqual([WSID, "RU"]);
  });

  it("compiles a standard neq condition", () => {
    const result = compileSegmentDefinition(
      def([{ conditions: [{ type: "attribute", source: "standard", field: "country", operator: "neq", value: "RU" }] }]),
      WSID
    );
    expect(result.whereSql).toContain("c.country <> $2");
    expect(result.params).toEqual([WSID, "RU"]);
  });

  it("compiles contains/not_contains via ILIKE with a %value% param", () => {
    const contains = compileSegmentDefinition(
      def([{ conditions: [{ type: "attribute", source: "standard", field: "city", operator: "contains", value: "Mos" }] }]),
      WSID
    );
    expect(contains.whereSql).toContain("c.city ILIKE $2");
    expect(contains.params).toEqual([WSID, "%Mos%"]);

    const notContains = compileSegmentDefinition(
      def([{ conditions: [{ type: "attribute", source: "standard", field: "city", operator: "not_contains", value: "Mos" }] }]),
      WSID
    );
    expect(notContains.whereSql).toContain("NOT (");
    expect(notContains.whereSql).toContain("c.city ILIKE $2");
    expect(notContains.params).toEqual([WSID, "%Mos%"]);
  });

  it("compiles is_empty/is_not_empty via ->> text extraction (no jsonb existence operator)", () => {
    const isEmpty = compileSegmentDefinition(
      def([{ conditions: [{ type: "attribute", source: "custom", field: "coupon", operator: "is_empty" }] }]),
      WSID
    );
    expect(isEmpty.whereSql).toContain("->> $2");
    expect(isEmpty.whereSql).not.toMatch(/\?\s*\$/);
    expect(isEmpty.params).toEqual([WSID, "coupon"]);

    const isNotEmpty = compileSegmentDefinition(
      def([{ conditions: [{ type: "attribute", source: "custom", field: "coupon", operator: "is_not_empty" }] }]),
      WSID
    );
    expect(isNotEmpty.whereSql).toContain("->> $2");
    expect(isNotEmpty.params).toEqual([WSID, "coupon"]);
  });

  it("compiles number gt/gte/lt/lte for a custom property via ->> ::numeric cast", () => {
    const gt = compileSegmentDefinition(
      def([{ conditions: [{ type: "attribute", source: "custom", field: "orderTotal", operator: "gt", value: 100 }] }]),
      WSID
    );
    expect(gt.whereSql).toContain("::numeric > $3");
    expect(gt.params).toEqual([WSID, "orderTotal", 100]);
  });

  it("compiles bool is_true/is_false", () => {
    const isTrue = compileSegmentDefinition(
      def([{ conditions: [{ type: "attribute", source: "custom", field: "vip", operator: "is_true" }] }]),
      WSID
    );
    expect(isTrue.whereSql).toMatch(/::boolean\s*=\s*\$\d/);
    expect(isTrue.params).toEqual([WSID, "vip", true]);
  });

  it("compiles date before/after/in_last_days", () => {
    const before = compileSegmentDefinition(
      def([{ conditions: [{ type: "attribute", source: "custom", field: "signedUpAt", operator: "before", value: "2026-01-01" }] }]),
      WSID
    );
    expect(before.whereSql).toContain("::timestamptz <");

    const inLastDays = compileSegmentDefinition(
      def([{ conditions: [{ type: "attribute", source: "custom", field: "signedUpAt", operator: "in_last_days", value: 30 }] }]),
      WSID
    );
    expect(inLastDays.whereSql).toContain("now() -");
    expect(inLastDays.params).toEqual([WSID, "signedUpAt", 30]);
  });

  it("compiles has_tag/not_has_tag via GIN-friendly array containment, not = ANY()", () => {
    const has = compileSegmentDefinition(
      def([{ conditions: [{ type: "attribute", source: "standard", field: "tags" as never, operator: "has_tag", value: "vip" }] }]),
      WSID
    );
    expect(has.whereSql).toContain("@> ARRAY[");
    expect(has.whereSql).not.toContain("= ANY(");

    const notHas = compileSegmentDefinition(
      def([{ conditions: [{ type: "attribute", source: "standard", field: "tags" as never, operator: "not_has_tag", value: "vip" }] }]),
      WSID
    );
    expect(notHas.whereSql).toContain("NOT (");
    expect(notHas.whereSql).toContain("@> ARRAY[");
  });

  it("fails closed on an unknown standard field", () => {
    expect(() =>
      compileSegmentDefinition(
        def([{ conditions: [{ type: "attribute", source: "standard", field: "totallyUnknownField", operator: "eq", value: "x" }] }]),
        WSID
      )
    ).toThrow();
  });

  it("fails closed on an unknown operator", () => {
    expect(() =>
      compileSegmentDefinition(
        def([
          {
            conditions: [
              { type: "attribute", source: "standard", field: "country", operator: "bogus_operator" as never, value: "x" },
            ],
          },
        ]),
        WSID
      )
    ).toThrow();
  });
});

describe("compileSegmentDefinition -- behavioral conditions", () => {
  it("compiles a positive at_least (count=1) condition to EXISTS", () => {
    const result = compileSegmentDefinition(
      def([
        {
          conditions: [
            {
              type: "behavioral",
              eventName: "order_placed",
              countOperator: "at_least",
              count: 1,
              timeframe: { kind: "last_days", days: 30 },
            },
          ],
        },
      ]),
      WSID
    );
    expect(result.whereSql).toContain("EXISTS (");
    expect(result.whereSql).not.toContain("NOT EXISTS");
    expect(result.whereSql).toContain("e.name = $2");
    expect(result.whereSql).toContain("e.occurred_at >=");
    expect(result.params).toEqual([WSID, "order_placed", 30]);
  });

  it("compiles an at_least N>1 condition honoring the count (not silently treated as >=1)", () => {
    const result = compileSegmentDefinition(
      def([
        {
          conditions: [
            {
              type: "behavioral",
              eventName: "order_placed",
              countOperator: "at_least",
              count: 3,
              timeframe: { kind: "all_time" },
            },
          ],
        },
      ]),
      WSID
    );
    expect(result.whereSql).toContain("EXISTS (");
    expect(result.whereSql).toContain("HAVING count(*) >= $");
    expect(result.params).toContain(3);
  });

  it("compiles a negative 'none' condition to NOT EXISTS", () => {
    const result = compileSegmentDefinition(
      def([
        {
          conditions: [
            {
              type: "behavioral",
              eventName: "opened_email",
              countOperator: "none",
              timeframe: { kind: "all_time" },
            },
          ],
        },
      ]),
      WSID
    );
    expect(result.whereSql.trim()).toMatch(/\(NOT EXISTS \(/);
  });

  it("compiles all_time timeframe without an occurred_at clause", () => {
    const result = compileSegmentDefinition(
      def([
        {
          conditions: [
            { type: "behavioral", eventName: "order_placed", countOperator: "at_least", count: 1, timeframe: { kind: "all_time" } },
          ],
        },
      ]),
      WSID
    );
    expect(result.whereSql).not.toContain("occurred_at");
  });
});

describe("compileSegmentDefinition -- two-tier AND/OR parenthesization (Pitfall 7)", () => {
  it("wraps every group's OR'd conditions in parentheses and joins groups with AND", () => {
    const result = compileSegmentDefinition(
      def([
        {
          conditions: [
            { type: "attribute", source: "standard", field: "country", operator: "eq", value: "RU" },
            { type: "attribute", source: "standard", field: "country", operator: "eq", value: "KZ" },
          ],
        },
        {
          conditions: [
            {
              type: "behavioral",
              eventName: "order_placed",
              countOperator: "at_least",
              count: 1,
              timeframe: { kind: "last_days", days: 30 },
            },
          ],
        },
      ]),
      WSID
    );

    // Each group is its own parenthesized OR clause; groups joined by AND.
    const groupPattern = /^c\.workspace_id = \$1 AND \(c\.country = \$2 OR c\.country = \$3\) AND \(EXISTS \(/;
    expect(result.whereSql).toMatch(groupPattern);
    expect(result.params).toEqual([WSID, "RU", "KZ", "order_placed", 30]);
  });

  it("parenthesizes even a single-condition group (no conditional logic based on group size)", () => {
    const result = compileSegmentDefinition(
      def([{ conditions: [{ type: "attribute", source: "standard", field: "country", operator: "eq", value: "RU" }] }]),
      WSID
    );
    expect(result.whereSql).toContain("AND (c.country = $2)");
  });
});
