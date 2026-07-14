import { Link } from "react-router";

import { bucketExcludedCounts } from "@/features/campaigns/campaign-metrics";
import type { CampaignProgressExcludedBreakdownItem } from "@/features/campaigns/api";
import { computeRate } from "@/lib/rates";

/**
 * 07-08: shared presentational metrics block, extracted from
 * CampaignProgress.tsx (the sending view, 07-03) so the terminal
 * SummaryView (`sent`/`canceled`) gets the same D-01 rate percentages, D-07
 * «Пропущено» excluded-reason breakdown, and D-04 send-log deep link -- with
 * zero duplicated rate/excluded logic between the two views. Deliberately
 * does NOT own the Progress bar, «N отправлено» caption, or «N ошибок» line
 * -- those stay with each parent view.
 */
export function CampaignMetricsSummary({
  slug,
  campaignId,
  sent,
  delivered,
  opened,
  clicked,
  bounced,
  unsubscribed,
  excludedBreakdown,
  excludedTotal,
}: {
  slug: string;
  campaignId: string;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
  excludedBreakdown: CampaignProgressExcludedBreakdownItem[];
  excludedTotal: number | null;
}) {
  // D-01: one denominator per metric -- delivery/bounce rate is from-sent,
  // open/click rate is from-delivered. computeRate returns null on a zero
  // denominator, rendered as «—» (never NaN%/Infinity%, T-07-03-02).
  const deliveryRate = computeRate(delivered, sent);
  const bounceRate = computeRate(bounced, sent);
  const openRate = computeRate(opened, delivered);
  const clickRate = computeRate(clicked, delivered);
  const rateLabel = (rate: number | null) => (rate === null ? "—" : `${rate}%`);

  // D-07: excluded messages are shown separately and never folded into any
  // rate denominator above.
  const excludedFromBreakdown = excludedBreakdown.reduce((acc, item) => acc + item.count, 0);
  const total = excludedTotal ?? excludedFromBreakdown;
  const { subscription: excludedSubscription, frequencyCap: excludedFrequencyCap } =
    bucketExcludedCounts(excludedBreakdown);

  return (
    <div className="space-y-4">
      {/* D-07/D-08/D-09: delivery counters sourced from the campaigns row, kept fresh by the 05-03 webhook worker. D-01: each counter also shows its rate percentage. */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-5">
        <div>
          <dt className="text-muted-foreground">Доставлено</dt>
          <dd className="font-medium tabular-nums">
            {delivered} <span className="text-muted-foreground">({rateLabel(deliveryRate)})</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Открытий</dt>
          <dd className="font-medium tabular-nums">
            {opened} <span className="text-muted-foreground">({rateLabel(openRate)})</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Кликов</dt>
          <dd className="font-medium tabular-nums">
            {clicked} <span className="text-muted-foreground">({rateLabel(clickRate)})</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Не доставлено</dt>
          <dd className="font-medium tabular-nums">
            {bounced} <span className="text-muted-foreground">({rateLabel(bounceRate)})</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Отписалось</dt>
          <dd className="font-medium tabular-nums">{unsubscribed}</dd>
        </div>
      </dl>

      {total > 0 ? (
        <div className="space-y-1 text-sm text-muted-foreground">
          <p className="tabular-nums">Пропущено: {total}</p>
          {excludedSubscription > 0 ? (
            <p className="pl-3 tabular-nums">из-за подписки/suppression: {excludedSubscription}</p>
          ) : null}
          {excludedFrequencyCap > 0 ? (
            <p className="pl-3 tabular-nums">из-за лимита частоты: {excludedFrequencyCap}</p>
          ) : null}
        </div>
      ) : null}

      {/* D-04: deep link into the send log, pre-filtered by this campaign. */}
      <Link to={`/w/${slug}/send-log?campaign=${campaignId}`} className="text-sm text-primary underline">
        Смотреть в журнале отправок
      </Link>
    </div>
  );
}

export default CampaignMetricsSummary;
