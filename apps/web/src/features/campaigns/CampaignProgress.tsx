import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { Progress } from "@/components/ui/progress";
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

  const sent = progress?.sentCount ?? 0;
  const total = progress?.sendableTotal ?? 0;
  const failed = progress?.failedCount ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;

  return (
    <div className="space-y-2">
      <Progress value={percent} />
      <p className="text-sm text-muted-foreground">
        {sent} из {total} отправлено
      </p>
      {failed > 0 ? <p className="text-sm font-medium text-destructive">{failed} ошибок</p> : null}
    </div>
  );
}

export default CampaignProgress;
