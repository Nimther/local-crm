import type { CampaignProgressExcludedBreakdownItem } from "@/features/campaigns/api";

/**
 * 07-08: extracted verbatim from CampaignProgress.tsx so the terminal
 * SummaryView (07-08) and the sending-view CampaignProgress (07-03) share one
 * D-07 bucketing rule. Only `frequency_cap` is its own bucket -- everything
 * else (suppressed/unsubscribed/no_email/null/unknown) folds into the
 * subscription/suppression bucket.
 */
export function bucketExcludedCounts(breakdown: CampaignProgressExcludedBreakdownItem[]): {
  subscription: number;
  frequencyCap: number;
} {
  let subscription = 0;
  let frequencyCap = 0;
  for (const item of breakdown) {
    if (item.reason === "frequency_cap") {
      frequencyCap += item.count;
    } else {
      subscription += item.count;
    }
  }
  return { subscription, frequencyCap };
}
