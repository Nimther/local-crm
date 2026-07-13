import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { Progress } from "@/components/ui/progress";
import { getCampaignProgress, type CampaignStatus } from "@/features/campaigns/api";
import { computeRate } from "@/lib/rates";

/** D-07: buckets every exclusion_reason value into the UI-SPEC's two-row breakdown. Only `frequency_cap` is its own bucket -- everything else (suppressed/unsubscribed/no_email/null/unknown) folds into the subscription/suppression bucket. */
function bucketExcludedCounts(breakdown: { reason: string | null; count: number }[]): {
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

/**
 * CAMP-05/D-10: determinate progress bar + «{sent} из {total} отправлено»
 * caption, polling getCampaignProgress every 3s while sending
 * (TanStack Query refetchInterval:3000). The `enabled` gate uses the
 * parent-supplied initial status; `refetchInterval`'s own callback re-reads
 * the freshest fetched status so polling auto-stops the instant the
 * campaign reaches any terminal status, without an orphaned poll loop.
 * `onTerminal` lets the parent (CampaignDetailPage) know to refetch the
 * campaign itself and switch views once sending finishes.
 */
export function CampaignProgress({
  slug,
  campaignId,
  status,
  onTerminal,
}: {
  slug: string;
  campaignId: string;
  status: CampaignStatus;
  onTerminal?: (status: CampaignStatus) => void;
}) {
  const progressQuery = useQuery({
    queryKey: ["workspace", slug, "campaigns", campaignId, "progress"],
    queryFn: () => getCampaignProgress(slug, campaignId),
    enabled: status === "sending",
    refetchInterval: (query) => (query.state.data?.status === "sending" ? 3000 : false),
  });

  const progress = progressQuery.data;

  useEffect(() => {
    if (progress && progress.status !== "sending") {
      onTerminal?.(progress.status);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.status]);

  const sent = progress?.sentCount ?? 0;
  const total = progress?.sendableTotal ?? 0;
  const failed = progress?.failedCount ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;

  const delivered = progress?.deliveredCount ?? 0;
  const opened = progress?.openedCount ?? 0;
  const clicked = progress?.clickedCount ?? 0;
  const bounced = progress?.bouncedCount ?? 0;
  const unsubscribed = progress?.unsubscribedCount ?? 0;

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
  const excludedBreakdown = progress?.excludedBreakdown ?? [];
  const excludedFromBreakdown = excludedBreakdown.reduce((acc, item) => acc + item.count, 0);
  const excludedTotal = progress?.excludedTotal ?? excludedFromBreakdown;
  const { subscription: excludedSubscription, frequencyCap: excludedFrequencyCap } =
    bucketExcludedCounts(excludedBreakdown);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Progress value={percent} />
        <p className="text-sm text-muted-foreground tabular-nums">
          {sent} из {total} отправлено
        </p>
        {failed > 0 ? <p className="text-sm font-medium text-destructive tabular-nums">{failed} ошибок</p> : null}
      </div>

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

      {excludedTotal > 0 ? (
        <div className="space-y-1 text-sm text-muted-foreground">
          <p className="tabular-nums">Пропущено: {excludedTotal}</p>
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

export default CampaignProgress;
