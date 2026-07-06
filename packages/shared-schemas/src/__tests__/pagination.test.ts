import { describe, expect, it } from "vitest";
import { campaignListQuerySchema } from "../campaign.js";
import { EXHAUSTIVE_LOOKUP_PAGE_SIZE } from "../pagination.js";
import { segmentListQuerySchema } from "../segment.js";

/**
 * Client/server contract pin (04-15 gap closure): the exact `pageSize` value
 * the exhaustive-lookup call sites send (EXHAUSTIVE_LOOKUP_PAGE_SIZE) must
 * parse successfully against BOTH list-query schemas, and the boundary just
 * past it must still be rejected -- the bound stays finite, only the ceiling
 * moved from 100 to 200. See campaign-builder-segments-400.md debug session.
 */
describe("EXHAUSTIVE_LOOKUP_PAGE_SIZE contract", () => {
  it("is 200", () => {
    expect(EXHAUSTIVE_LOOKUP_PAGE_SIZE).toBe(200);
  });

  it("segmentListQuerySchema accepts EXHAUSTIVE_LOOKUP_PAGE_SIZE", () => {
    const result = segmentListQuerySchema.safeParse({ pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pageSize).toBe(EXHAUSTIVE_LOOKUP_PAGE_SIZE);
    }
  });

  it("campaignListQuerySchema accepts EXHAUSTIVE_LOOKUP_PAGE_SIZE", () => {
    const result = campaignListQuerySchema.safeParse({ pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pageSize).toBe(EXHAUSTIVE_LOOKUP_PAGE_SIZE);
    }
  });

  it("segmentListQuerySchema still rejects EXHAUSTIVE_LOOKUP_PAGE_SIZE + 1", () => {
    const result = segmentListQuerySchema.safeParse({ pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE + 1 });
    expect(result.success).toBe(false);
  });

  it("campaignListQuerySchema still rejects EXHAUSTIVE_LOOKUP_PAGE_SIZE + 1", () => {
    const result = campaignListQuerySchema.safeParse({ pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE + 1 });
    expect(result.success).toBe(false);
  });

  it("both schemas still reject pageSize < 1 and non-integers", () => {
    expect(segmentListQuerySchema.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(segmentListQuerySchema.safeParse({ pageSize: 1.5 }).success).toBe(false);
    expect(campaignListQuerySchema.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(campaignListQuerySchema.safeParse({ pageSize: 1.5 }).success).toBe(false);
  });

  it("both schemas still default pageSize to 20 when omitted", () => {
    const segmentResult = segmentListQuerySchema.safeParse({});
    const campaignResult = campaignListQuerySchema.safeParse({});
    expect(segmentResult.success).toBe(true);
    expect(campaignResult.success).toBe(true);
    if (segmentResult.success) expect(segmentResult.data.pageSize).toBe(20);
    if (campaignResult.success) expect(campaignResult.data.pageSize).toBe(20);
  });
});
