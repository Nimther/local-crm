import { useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  deleteCampaign,
  duplicateCampaign,
  listCampaigns,
  type CampaignResponse,
} from "@/features/campaigns/api";
import { listSegments } from "@/features/segments/api";
import { CampaignStatusBadge } from "@/features/campaigns/CampaignStatusBadge";

const PAGE_SIZE = 20;
const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";

/** Only draft/canceled campaigns preserve no send history worth keeping -- scheduled/sending/sent are not deletable (04-UI-SPEC). */
function isDeletable(status: CampaignResponse["status"]): boolean {
  return status === "draft" || status === "canceled";
}

/**
 * Campaigns list (CAMP-01): name + status badge + audience (segment name) +
 * updated column, empty state, «Создать кампанию» CTA, and a per-row
 * dropdown with «Открыть»/«Дублировать»/«Удалить черновик» (draft/canceled
 * only). Structural analog: SegmentsListPage (04-PATTERNS.md).
 */
export function CampaignsListPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [campaignPendingDelete, setCampaignPendingDelete] = useState<CampaignResponse | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const campaignsQuery = useQuery({
    queryKey: ["workspace", slug, "campaigns", page, PAGE_SIZE],
    queryFn: () => listCampaigns(slug, { page, pageSize: PAGE_SIZE }),
    enabled: Boolean(slug),
    placeholderData: keepPreviousData,
  });

  // Campaigns only carry a segmentId -- resolve the display name the same
  // way SegmentsListPage resolves createdByUserId -> member name.
  const segmentsQuery = useQuery({
    queryKey: ["workspace", slug, "segments", "all-for-lookup"],
    queryFn: () => listSegments(slug, { page: 1, pageSize: 200 }),
    enabled: Boolean(slug),
  });

  const segmentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const segment of segmentsQuery.data?.items ?? []) map.set(segment.id, segment.name);
    return map;
  }, [segmentsQuery.data]);

  const duplicateMutation = useMutation({
    mutationFn: (campaign: CampaignResponse) => duplicateCampaign(slug, campaign.id),
    onSuccess: async (duplicated) => {
      setServerError(null);
      await queryClient.invalidateQueries({ queryKey: ["workspace", slug, "campaigns"] });
      toast.success("Кампания продублирована");
      navigate(`/w/${slug}/campaigns/${duplicated.id}`);
    },
    onError: () => {
      setServerError(GENERIC_ERROR);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (campaign: CampaignResponse) => deleteCampaign(slug, campaign.id),
    onSuccess: async () => {
      setServerError(null);
      toast.success("Черновик удалён");
      await queryClient.invalidateQueries({ queryKey: ["workspace", slug, "campaigns"] });
      setCampaignPendingDelete(null);
    },
    onError: () => {
      setServerError(GENERIC_ERROR);
    },
  });

  const data = campaignsQuery.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isInitialLoad = campaignsQuery.isLoading;
  const isRefetching = campaignsQuery.isPlaceholderData || campaignsQuery.isFetching;

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-display font-semibold">Кампании</h1>
          <p className="text-sm text-muted-foreground">Разовые email-рассылки по сегментам через SendGrid.</p>
        </div>
        <Button onClick={() => navigate(`/w/${slug}/campaigns/new`)}>Создать кампанию</Button>
      </div>

      {isInitialLoad ? (
        <Skeleton className="h-96 w-full" />
      ) : items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Кампаний пока нет</CardTitle>
            <CardDescription>
              Создайте кампанию — выберите сегмент-аудиторию и шаблон, чтобы отправить рассылку через SendGrid.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate(`/w/${slug}/campaigns/new`)}>Создать кампанию</Button>
          </CardContent>
        </Card>
      ) : (
        <Card className={cn("transition-opacity duration-200", isRefetching && "opacity-50")}>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Название</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead>Аудитория</TableHead>
                  <TableHead>Обновлена</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((campaign) => (
                  <TableRow
                    key={campaign.id}
                    className="h-12 cursor-pointer"
                    onClick={() => navigate(`/w/${slug}/campaigns/${campaign.id}`)}
                  >
                    <TableCell>{campaign.name}</TableCell>
                    <TableCell>
                      <CampaignStatusBadge status={campaign.status} />
                    </TableCell>
                    <TableCell>{segmentNameById.get(campaign.segmentId) ?? "—"}</TableCell>
                    <TableCell>{new Date(campaign.updatedAt).toLocaleString("ru-RU")}</TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label="Действия">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => navigate(`/w/${slug}/campaigns/${campaign.id}`)}>
                            Открыть
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={duplicateMutation.isPending}
                            onSelect={() => duplicateMutation.mutate(campaign)}
                          >
                            Дублировать
                          </DropdownMenuItem>
                          {isDeletable(campaign.status) ? (
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onSelect={() => setCampaignPendingDelete(campaign)}
                            >
                              Удалить черновик
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}

      {!isInitialLoad && items.length > 0 ? (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Всего: {total}</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Назад
            </Button>
            <span className="text-sm text-muted-foreground">
              Стр. {page} из {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Вперёд
            </Button>
          </div>
        </div>
      ) : null}

      {campaignPendingDelete ? (
        <AlertDialog
          open={Boolean(campaignPendingDelete)}
          onOpenChange={(open) => {
            if (!open) setCampaignPendingDelete(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Удалить черновик «{campaignPendingDelete.name}»?</AlertDialogTitle>
              <AlertDialogDescription>Черновик будет удалён без возможности восстановления.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Отмена</AlertDialogCancel>
              <AlertDialogAction
                disabled={deleteMutation.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={(e) => {
                  e.preventDefault();
                  deleteMutation.mutate(campaignPendingDelete);
                }}
              >
                {deleteMutation.isPending ? "Удаляем…" : "Удалить черновик"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}

export default CampaignsListPage;
