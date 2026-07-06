import { describe, expect, it } from "vitest";

import { findBlockingScheduledCampaign, type SaveGateCampaign } from "../segmentSaveGate";

// DOM/component testing (e.g. asserting SegmentDetailPage's rendered banner
// or confirm affordance) is intentionally out of scope for this lane -- no
// jsdom/@testing-library install exists in apps/web. The save-time
// refetch+confirm wiring is covered by this pure decision plus a phase UAT
// re-run of Test 12 against the running app.

const SEGMENT_ID = "segment-1";
const OTHER_SEGMENT_ID = "segment-2";

function campaign(overrides: Partial<SaveGateCampaign>): SaveGateCampaign {
  return {
    segmentId: SEGMENT_ID,
    status: "scheduled",
    name: "Test Campaign",
    ...overrides,
  };
}

describe("findBlockingScheduledCampaign", () => {
  it("returns null when there are no campaigns", () => {
    expect(findBlockingScheduledCampaign([], SEGMENT_ID)).toBeNull();
  });

  it("returns the campaign when a scheduled campaign references the target segment", () => {
    const scheduled = campaign({ name: "Datetime picker" });
    expect(findBlockingScheduledCampaign([scheduled], SEGMENT_ID)).toEqual({ name: "Datetime picker" });
  });

  it("returns null when a scheduled campaign references a different segment", () => {
    const scheduled = campaign({ segmentId: OTHER_SEGMENT_ID });
    expect(findBlockingScheduledCampaign([scheduled], SEGMENT_ID)).toBeNull();
  });

  it.each(["draft", "sending", "sent", "canceled"] as const)(
    "returns null when a matching campaign has status '%s' (only 'scheduled' blocks)",
    (status) => {
      const nonScheduled = campaign({ status });
      expect(findBlockingScheduledCampaign([nonScheduled], SEGMENT_ID)).toBeNull();
    }
  );

  it("finds the one scheduled+matching campaign even when other campaigns precede it", () => {
    const draftSameSegment = campaign({ status: "draft", name: "Draft same segment" });
    const scheduledOtherSegment = campaign({ segmentId: OTHER_SEGMENT_ID, name: "Scheduled other segment" });
    const scheduledMatch = campaign({ name: "Scheduled match" });
    const sentSameSegment = campaign({ status: "sent", name: "Sent same segment" });

    const result = findBlockingScheduledCampaign(
      [draftSameSegment, scheduledOtherSegment, scheduledMatch, sentSameSegment],
      SEGMENT_ID
    );

    expect(result).toEqual({ name: "Scheduled match" });
  });
});
