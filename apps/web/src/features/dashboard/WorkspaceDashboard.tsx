import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

const GENERIC_ERROR = "Не удалось загрузить дашборд. Обновите страницу — если ошибка повторится, попробуйте позже.";

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
      ) : dashboardQuery.isError ? (
        <p className="text-sm font-medium text-destructive">{GENERIC_ERROR}</p>
      ) : !data ? null : isEmpty ? (
        <Card>
          <CardHeader>
            <CardTitle>Пока нет отправок</CardTitle>
            <CardDescription>
              Как только вы запустите первую кампанию или цепочку, здесь появится динамика доставок и открытий.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="secondary" onClick={() => void navigate(`/w/${slug}/campaigns`)}>
              Создать кампанию
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <KpiCard label="Отправлено" value={String(data.kpis.sent)} />
            <KpiCard label="Доставлено" value={rateLabel(data.kpis.deliveredRate)} />
            <KpiCard label="Открыто" value={rateLabel(data.kpis.openedRate)} />
            <KpiCard label="Новые контакты" value={String(data.kpis.newContacts)} />
            <KpiCard label="Отписки" value={String(data.kpis.unsubscribes)} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Динамика отправок</CardTitle>
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
