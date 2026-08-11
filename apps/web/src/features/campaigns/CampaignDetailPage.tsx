import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router";
import { Loader2 } from "lucide-react";

import type { WorkspaceResponse } from "@mega-crm/shared-schemas";
import { apiGet } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  getCampaign,
  getCampaignAudienceBreakdown,
  type CampaignResponse,
} from "@/features/campaigns/api";
import { AudienceBreakdown } from "@/features/campaigns/AudienceBreakdown";
import CampaignBuilderPage from "@/features/campaigns/CampaignBuilderPage";
import { CampaignProgress } from "@/features/campaigns/CampaignProgress";
import { CampaignStatusBadge } from "@/features/campaigns/CampaignStatusBadge";
import { CancelDialog, LaunchScheduleActions } from "@/features/campaigns/LaunchScheduleDialogs";
import { TestSendPanel } from "@/features/campaigns/TestSendPanel";

function campaignQueryKey(slug: string, id: string) {
  return ["workspace", slug, "campaigns", id];
}

/** Scheduled view (D-01): provisional «~{count} на момент проверки» estimate, isFetching-dim + spinner cue, never a full skeleton over a prior number. */
function ScheduledView({ slug, campaign }: { slug: string; campaign: CampaignResponse }) {
  const [cancelOpen, setCancelOpen] = useState(false);

  const breakdownQuery = useQuery({
    queryKey: [...campaignQueryKey(slug, campaign.id), "audience-breakdown"],
    queryFn: () => getCampaignAudienceBreakdown(slug, campaign.id),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          Кампания запланирована
          {breakdownQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
        </CardTitle>
        {campaign.scheduledAt ? (
          <CardDescription>Отправка: {new Date(campaign.scheduledAt).toLocaleString("ru-RU")}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className={cn("text-sm text-muted-foreground", breakdownQuery.isFetching && "opacity-50")}>
          ~{breakdownQuery.data ? breakdownQuery.data.sendableCount.toLocaleString("ru-RU") : "…"} на момент проверки
        </p>
        <Button type="button" variant="outline" onClick={() => setCancelOpen(true)}>
          Отменить кампанию
        </Button>
      </CardContent>
      <CancelDialog slug={slug} campaign={campaign} open={cancelOpen} onOpenChange={setCancelOpen} />
    </Card>
  );
}

/** Sending view (CAMP-05): live progress + the frozen audience-breakdown snapshot (fetched once, not re-polled) + «Остановить отправку». */
function SendingView({
  slug,
  campaign,
  onTerminal,
}: {
  slug: string;
  campaign: CampaignResponse;
  onTerminal: () => void;
}) {
  const [cancelOpen, setCancelOpen] = useState(false);

  const breakdownQuery = useQuery({
    queryKey: [...campaignQueryKey(slug, campaign.id), "audience-breakdown"],
    queryFn: () => getCampaignAudienceBreakdown(slug, campaign.id),
    staleTime: Infinity,
  });

  return (
    <div className="space-y-8">
      <Card>
        <CardHeader>
          <CardTitle>Прогресс отправки</CardTitle>
        </CardHeader>
        <CardContent>
          <CampaignProgress
            slug={slug}
            campaignId={campaign.id}
            status={campaign.status}
            onTerminal={onTerminal}
          />
        </CardContent>
      </Card>

      {breakdownQuery.data ? (
        <Card>
          <CardHeader>
            <CardTitle>Аудитория</CardTitle>
          </CardHeader>
          <CardContent>
            <AudienceBreakdown data={breakdownQuery.data} />
          </CardContent>
        </Card>
      ) : null}

      <Button type="button" variant="destructive" onClick={() => setCancelOpen(true)}>
        Остановить отправку
      </Button>
      <CancelDialog slug={slug} campaign={campaign} open={cancelOpen} onOpenChange={setCancelOpen} />
    </div>
  );
}

/** Sent/canceled summary (D-10): sent/failed/excluded counts, red «N ошибок» line when failed>0 — never hide partial failures. */
function SummaryView({ campaign }: { campaign: CampaignResponse }) {
  const total = campaign.sendableTotal ?? campaign.sentCount;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{campaign.status === "canceled" ? "Кампания отменена" : "Кампания отправлена"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">
          {campaign.sentCount} из {total} отправлено
        </p>
        {campaign.excludedTotal ? (
          <p className="text-sm text-muted-foreground">{campaign.excludedTotal} исключено</p>
        ) : null}
        {campaign.failedCount > 0 ? (
          <p className="text-sm font-medium text-destructive">{campaign.failedCount} ошибок</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Campaign detail (CAMP-02/03/04/05): branches by status — draft embeds the
 * 04-07 builder plus the new test-send panel + launch/schedule actions;
 * scheduled/sending/sent/canceled each get their own dedicated view. Replaces
 * the 04-07 placeholder that routed every /campaigns/:id request straight to
 * the builder.
 */
export function CampaignDetailPage() {
  const { slug = "", id = "" } = useParams<{ slug: string; id: string }>();
  const queryClient = useQueryClient();

  const workspaceQuery = useQuery({
    queryKey: ["workspace", slug],
    queryFn: () => apiGet<WorkspaceResponse>(`/api/workspaces/${slug}`),
    enabled: Boolean(slug),
  });
  const viewerRole = workspaceQuery.data?.role ?? "member";
  const canLaunch = viewerRole === "owner" || viewerRole === "admin";

  const campaignQuery = useQuery({
    queryKey: campaignQueryKey(slug, id),
    queryFn: () => getCampaign(slug, id),
    enabled: Boolean(slug) && Boolean(id),
    refetchInterval: (query) => (query.state.data?.status === "sending" ? 3000 : false),
  });

  function refreshCampaign() {
    void queryClient.invalidateQueries({ queryKey: campaignQueryKey(slug, id) });
  }

  if (campaignQuery.isError || (!campaignQuery.isLoading && !campaignQuery.data)) {
    return (
      <div className="p-8">
        <Card>
          <CardHeader>
            <CardTitle>Кампания не найдена</CardTitle>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (campaignQuery.isLoading || !campaignQuery.data) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const campaign = campaignQuery.data;

  if (campaign.status === "draft") {
    return (
      <div className="space-y-6">
        <CampaignBuilderPage />
        <div className="space-y-6 px-8 pb-8">
          <TestSendPanel slug={slug} campaign={campaign} />
          <LaunchScheduleActions slug={slug} campaign={campaign} canLaunch={canLaunch} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center gap-3">
        <h1 className="text-display font-semibold">{campaign.name}</h1>
        <CampaignStatusBadge status={campaign.status} />
      </div>

      {campaign.status === "scheduled" ? <ScheduledView slug={slug} campaign={campaign} /> : null}
      {campaign.status === "sending" ? (
        <SendingView slug={slug} campaign={campaign} onTerminal={refreshCampaign} />
      ) : null}
      {campaign.status === "sent" || campaign.status === "canceled" ? <SummaryView campaign={campaign} /> : null}
    </div>
  );
}

export default CampaignDetailPage;
