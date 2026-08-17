import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataAsOfLabel } from "@/components/DataAsOfLabel";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState } from "@/components/QueryErrorState";
import { StaleDataBanner } from "@/components/StaleDataBanner";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { OnboardingChecklist } from "@/features/onboarding/OnboardingChecklist";
import { getWorkspaceDashboard, type DashboardPeriod } from "@/features/dashboard/api";
import { TrendChart } from "@/features/dashboard/TrendChart";
import { GrowthChart } from "@/features/dashboard/GrowthChart";

const PERIOD_PRESETS: { value: DashboardPeriod; label: string }[] = [
  { value: 7, label: "7 дней" },
  { value: 30, label: "30 дней" },
  { value: 90, label: "90 дней" },
];

/** D-06: «—» for a zero-denominator rate, never NaN%/Infinity% (mirrors CampaignProgress.tsx's rateLabel). */
function rateLabel(rate: number | null): string {
  return rate === null ? "—" : `${rate}%`;
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-display font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

/**
 * ANLT-04/D-08/D-08a: the workspace index route -- replaces `WorkspaceHome`.
 * Renders the preserved onboarding checklist on top, then rollup-backed
 * trend + growth charts (Recharts), period KPIs, and recent-campaigns /
 * active-flows mini-lists. Period presets 7/30/90 days, default 30 (D-08 --
 * no arbitrary date range in v1).
 */
export function WorkspaceDashboard() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<DashboardPeriod>(30);

  const dashboardQuery = useQuery({
    queryKey: ["workspace", slug, "dashboard", period],
    queryFn: () => getWorkspaceDashboard(slug, period),
    enabled: Boolean(slug),
  });

  const data = dashboardQuery.data;
  // No dedicated "has ever sent" flag exists on the endpoint -- a workspace
  // with zero recent campaigns, zero active flows, and zero sends in the
  // selected period is treated as "no sends yet" for the empty state (D-08
  // UI-SPEC), matching OnboardingChecklist's own all-time-count heuristic.
  const isEmpty = Boolean(
    data && data.kpis.sent === 0 && data.recentCampaigns.length === 0 && data.activeFlows.length === 0
  );

  // OPS-17/D-11/T-15-21: this endpoint returns one combined payload for
  // every widget on this page (KPIs, both charts, both mini-lists) -- there
  // is no per-widget query to split without changing the API contract,
  // which this plan does not do. Within that constraint, a failure still
  // renders as two distinct, region-scoped QueryErrorState cards (the
  // KPI/chart region and the lists region) rather than one page-wide
  // message, and the header/period selector/OnboardingChecklist above
  // never disappear regardless of this query's state -- no early return
  // ever replaces the whole page.
  const isFullyErrored = dashboardQuery.isError && !dashboardQuery.data;
  const isStaleErrored = dashboardQuery.isError && Boolean(dashboardQuery.data);

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-display font-semibold">Дашборд</h1>
          <p className="text-sm text-muted-foreground">Динамика доставок и открытий, рост базы контактов.</p>
        </div>
        <div className="flex items-center gap-2">
          {PERIOD_PRESETS.map((preset) => (
            <Button
              key={preset.value}
              size="sm"
              variant={period === preset.value ? "default" : "outline"}
              onClick={() => setPeriod(preset.value)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      </div>

      <OnboardingChecklist slug={slug} />

      {dashboardQuery.isLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : isFullyErrored ? (
        <div className="space-y-6">
          <QueryErrorState
            title="Не удалось загрузить KPI и графики"
            isFetching={dashboardQuery.isFetching}
            onRetry={() => void dashboardQuery.refetch()}
          />
          <QueryErrorState
            title="Не удалось загрузить последние кампании и цепочки"
            isFetching={dashboardQuery.isFetching}
            onRetry={() => void dashboardQuery.refetch()}
          />
        </div>
      ) : !data ? null : isEmpty ? (
        <EmptyState
          title="Пока нет отправок"
          description="Как только вы запустите первую кампанию или цепочку, здесь появится динамика доставок и открытий."
          action={
            <Button variant="secondary" onClick={() => void navigate(`/w/${slug}/campaigns`)}>
              Создать кампанию
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          {isStaleErrored ? (
            <QueryErrorState
              title="Не удалось обновить дашборд"
              detail="Показаны последние загруженные данные."
              isFetching={dashboardQuery.isFetching}
              onRetry={() => void dashboardQuery.refetch()}
            />
          ) : null}

          {/*
            OPS-18/D-12 (plan 15-15): one banner for the whole rollup-derived
            region below, not one per widget -- a delayed pipeline is one
            message. `newContacts` (below) and the growth chart/mini-lists
            further down are read LIVE from contacts/campaigns/flows, never
            from the rollup, so this signal deliberately does not cover them
            (T-15-52 -- labelling a live number with a rollup watermark would
            be a new lie in place of the old one).
          */}
          <StaleDataBanner lagMinutes={data.lagMinutes} />

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <KpiCard label="Отправлено" value={String(data.kpis.sent)} />
            <KpiCard label="Доставлено" value={rateLabel(data.kpis.deliveredRate)} />
            <KpiCard label="Открыто" value={rateLabel(data.kpis.openedRate)} />
            {/* `newContacts` is grouped from `contacts.created_at` (RESEARCH A2), not workspace_daily_rollup -- live, always current, deliberately outside the freshness label's scope below. */}
            <KpiCard label="Новые контакты" value={String(data.kpis.newContacts)} />
            <KpiCard label="Отписки" value={String(data.kpis.unsubscribes)} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Динамика отправок</CardTitle>
              {/*
                Scoped to this card: `sent`/`deliveredRate`/`openedRate`
                (grid above) and `trend` (below) all come from the SAME
                `workspace_daily_rollup` query for the SAME period window
                (dashboard.repository.ts), so one watermark honestly
                describes all of them. `unsubscribes` (grid above) is also
                rollup-derived (summed from the same rows).
              */}
              <DataAsOfLabel dataAsOf={data.dataAsOf} />
            </CardHeader>
            <CardContent>
              <TrendChart data={data.trend} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Рост базы контактов</CardTitle>
            </CardHeader>
            <CardContent>
              <GrowthChart data={data.growth} />
            </CardContent>
          </Card>

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Последние кампании</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.recentCampaigns.length === 0 ? (
                  <p className="p-6 text-sm text-muted-foreground">Кампаний пока нет.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Название</TableHead>
                        <TableHead className="text-right">Отправлено</TableHead>
                        <TableHead className="text-right">Доставлено</TableHead>
                        <TableHead className="text-right">Открыто</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.recentCampaigns.map((campaign) => (
                        <TableRow
                          key={campaign.id}
                          className={cn("h-12 cursor-pointer")}
                          onClick={() => void navigate(`/w/${slug}/campaigns/${campaign.id}`)}
                        >
                          <TableCell>{campaign.name}</TableCell>
                          <TableCell className="text-right tabular-nums">{campaign.sentCount}</TableCell>
                          <TableCell className="text-right tabular-nums">{rateLabel(campaign.deliveredRate)}</TableCell>
                          <TableCell className="text-right tabular-nums">{rateLabel(campaign.openedRate)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Активные цепочки</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.activeFlows.length === 0 ? (
                  <p className="p-6 text-sm text-muted-foreground">Активных цепочек пока нет.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Название</TableHead>
                        <TableHead className="text-right">В процессе</TableHead>
                        <TableHead className="text-right">Отправлено писем</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.activeFlows.map((flow) => (
                        <TableRow
                          key={flow.id}
                          className={cn("h-12 cursor-pointer")}
                          onClick={() => void navigate(`/w/${slug}/flows/${flow.id}`)}
                        >
                          <TableCell>{flow.name}</TableCell>
                          <TableCell className="text-right tabular-nums">{flow.activeRuns}</TableCell>
                          <TableCell className="text-right tabular-nums">{flow.emailsSent}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

export default WorkspaceDashboard;
