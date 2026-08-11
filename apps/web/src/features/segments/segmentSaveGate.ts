/**
 * D-03 save-gate decision (UAT Test 12 gap-closure, .planning/debug/segment-editor-d03-warning-missing.md).
 *
 * A campaign's audience is only frozen once it is 'scheduled' (send-start
 * materializes the snapshot) -- a 'draft' campaign hasn't committed to an
 * audience yet, and 'sending'/'sent'/'canceled' campaigns have already
 * consumed (or will never consume) their snapshot, so editing a segment's
 * definition afterwards cannot retroactively change what already happened.
 * Only a 'scheduled' campaign referencing this exact segment is at risk of
 * having its audience silently changed by a segment edit before send-start.
 *
 * Pure, framework-free: this is the single source of truth consulted by
 * BOTH the passive mount-time banner and the save-time confirm gate in
 * SegmentDetailPage.tsx, so the two can never disagree.
 */

/** Minimal structural shape -- lets callers pass CampaignResponse items directly. */
export interface SaveGateCampaign {
  segmentId: string;
  status: string;
  name: string;
}

/**
 * Returns the first campaign in `campaigns` that is `status === "scheduled"`
 * AND references `segmentId`, or `null` if none does. Order of non-matching
 * entries in the input list does not affect the result.
 */
export function findBlockingScheduledCampaign(
  campaigns: readonly SaveGateCampaign[],
  segmentId: string
): { name: string } | null {
  const match = campaigns.find(
    (campaign) => campaign.segmentId === segmentId && campaign.status === "scheduled"
  );
  return match ? { name: match.name } : null;
}
