import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { Progress } from "@/components/ui/progress";
import { QueryErrorState } from "@/components/QueryErrorState";
import { CampaignMetricsSummary } from "@/features/campaigns/CampaignMetricsSummary";
import { getCampaignProgress, type CampaignStatus } from "@/features/campaigns/api";

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

  // OPS-17/D-11: a transient poll failure must never wipe the last known
  // progress. A failure with no prior successful poll (isFullyErrored) gets
  // the full-region QueryErrorState in place of the progress bar; a failed
  // poll that still has stale progress data (isStaleErrored) keeps
  // rendering the last known values, with the failure surfaced as a
  // contained banner above them instead of replacing anything.
  const isFullyErrored = progressQuery.isError && !progressQuery.data;
  const isStaleErrored = progressQuery.isError && Boolean(progressQuery.data);

  if (isFullyErrored) {
    return (
      <QueryErrorState
        title="Не удалось загрузить прогресс отправки"
        isFetching={progressQuery.isFetching}
        onRetry={() => void progressQuery.refetch()}
      />
    );
  }

  const sent = progress?.sentCount ?? 0;
  const total = progress?.sendableTotal ?? 0;
  const failed = progress?.failedCount ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;

  const delivered = progress?.deliveredCount ?? 0;
  const opened = progress?.openedCount ?? 0;
  const clicked = progress?.clickedCount ?? 0;
  const bounced = progress?.bouncedCount ?? 0;
  const unsubscribed = progress?.unsubscribedCount ?? 0;
  const excludedBreakdown = progress?.excludedBreakdown ?? [];
  const excludedTotal = progress?.excludedTotal ?? null;

  // D-16 (Phase 13): `reconciling`/`unknown` are ledger states, not
  // delivery facts -- a send in either state has an outcome the platform
  // has not observed yet. Reported as one combined "outcome not yet known"
  // stat, distinct from both `sent` and `failed`, so a marketer cannot
  // mistake an unresolved send for a delivery failure. Hidden entirely
  // when both counts are zero, mirroring the excluded-breakdown row's
  // conditional-render pattern below.
  const reconciling = progress?.ledger.reconciling ?? 0;
  const unknownOutcome = progress?.ledger.unknown ?? 0;
  const ambiguousTotal = reconciling + unknownOutcome;

  return (
    <div className="space-y-4">
      {isStaleErrored ? (
        <QueryErrorState
          title="Не удалось обновить прогресс отправки"
          detail="Показаны последние известные значения."
          isFetching={progressQuery.isFetching}
          onRetry={() => void progressQuery.refetch()}
        />
      ) : null}
      <div className="space-y-2">
        <Progress value={percent} />
        <p className="text-sm text-muted-foreground tabular-nums">
          {sent} из {total} отправлено
        </p>
        {failed > 0 ? <p className="text-sm font-medium text-destructive tabular-nums">{failed} ошибок</p> : null}
        {ambiguousTotal > 0 ? (
          <p className="text-sm text-muted-foreground tabular-nums">Исход неизвестен: {ambiguousTotal}</p>
        ) : null}
      </div>

      <CampaignMetricsSummary
        slug={slug}
        campaignId={campaignId}
        sent={sent}
        delivered={delivered}
        opened={opened}
        clicked={clicked}
        bounced={bounced}
        unsubscribed={unsubscribed}
        excludedBreakdown={excludedBreakdown}
        excludedTotal={excludedTotal}
      />
    </div>
  );
}

export default CampaignProgress;
