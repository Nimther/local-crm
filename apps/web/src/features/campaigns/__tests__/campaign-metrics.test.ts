import { describe, expect, it } from "vitest";

import { bucketExcludedCounts } from "../campaign-metrics";

/**
 * 07-08: unit tests for the D-07 excluded-reason bucketing rule extracted
 * from CampaignProgress.tsx. Only `frequency_cap` is its own bucket --
 * everything else (suppressed/unsubscribed/no_email/null/unknown) folds into
 * the subscription/suppression bucket.
 */
describe("bucketExcludedCounts", () => {
  it("returns zeroed buckets for an empty breakdown", () => {
    expect(bucketExcludedCounts([])).toEqual({ subscription: 0, frequencyCap: 0 });
  });

  it("adds a frequency_cap reason's count to frequencyCap only", () => {
    expect(bucketExcludedCounts([{ reason: "frequency_cap", count: 4 }])).toEqual({
      subscription: 0,
      frequencyCap: 4,
    });
  });

  it("folds suppressed, unsubscribed, no_email, null, and unknown reasons into subscription", () => {
    expect(
      bucketExcludedCounts([
        { reason: "suppressed", count: 1 },
        { reason: "unsubscribed", count: 2 },
        { reason: "no_email", count: 3 },
        { reason: null, count: 5 },
        { reason: "some_unknown_reason", count: 7 },
      ])
    ).toEqual({ subscription: 18, frequencyCap: 0 });
  });

  it("sums each bucket independently for a mixed breakdown", () => {
    expect(
      bucketExcludedCounts([
        { reason: "frequency_cap", count: 3 },
        { reason: "suppressed", count: 2 },
        { reason: null, count: 1 },
      ])
    ).toEqual({ subscription: 3, frequencyCap: 3 });
  });
});
