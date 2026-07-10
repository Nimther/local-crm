import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { MoreHorizontal } from "lucide-react";

import { EXHAUSTIVE_LOOKUP_PAGE_SIZE } from "@mega-crm/shared-schemas";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCreateFlow, useDeleteFlow, useDuplicateFlow, useFlows, type FlowResponse } from "@/features/flows/api";
import { FlowStatusBadge } from "@/features/flows/FlowStatusBadge";
import { listSegments } from "@/features/segments/api";

const PAGE_SIZE = 20;
const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";

/**
 * D-22: a flow is deletable in the UI only when it's never been published
 * (still a draft, no live version) or is currently paused -- the server
 * (deleteFlow) re-verifies zero-active-runs before actually allowing the
 * delete and returns a 409 with an explanatory message otherwise, which the
 * delete confirm surfaces verbatim rather than a generic error.
 */
export function isDeletableFlowStatus(flow: Pick<FlowResponse, "status" | "liveVersionId">): boolean {
  return (flow.status === "draft" && flow.liveVersionId === null) || flow.status === "paused";
}

function triggerSummary(flow: FlowResponse, segmentNameById: Map<string, string>): string {
  if (flow.triggerType === "event") {
    return flow.triggerEventName ? `Событие: ${flow.triggerEventName}` : "—";
  }
  if (flow.triggerType === "segment") {
    return flow.triggerSegmentId ? `Сегмент: ${segmentNameById.get(flow.triggerSegmentId) ?? "выбран"}` : "—";
  }
  return "—";
}

/**
 * Name-only creation dialog (createFlowSchema requires a name up front,
 * unlike campaigns' navigate-straight-to-builder flow) -- creates the draft
 * then navigates directly to its canvas.
 */
function CreateFlowDialog({
  slug,
  open,
  onOpenChange,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const createMutation = useCreateFlow(slug);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setName("");
      setServerError(null);
    }
  }

  function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setServerError(null);
    createMutation.mutate(
      { name: trimmed },
      {
        onSuccess: (created) => {
          toast.success("Цепочка создана");
          handleOpenChange(false);
          navigate(`/w/${slug}/flows/${created.id}`);
        },
        onError: () => setServerError(GENERIC_ERROR),
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Создать цепочку</DialogTitle>
          <DialogDescription>Дайте цепочке название — узлы и условия вы настроите на холсте.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="flow-name">Название</Label>
          <Input
            id="flow-name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
          />
        </div>
        {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Отмена
          </Button>
          <Button type="button" disabled={!name.trim() || createMutation.isPending} onClick={handleCreate}>
            {createMutation.isPending ? "Создаём…" : "Создать цепочку"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Flows list (FLOW-01): status badge (Черновик/Live/Приостановлена per
 * 06-UI-SPEC), trigger summary, «Создать цепочку» CTA, and a per-row
 * dropdown (Открыть/Дублировать/Удалить — delete only offered when
 * isDeletableFlowStatus, D-22). Structural analog: CampaignsListPage.
 */
export function FlowsListPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [flowPendingDelete, setFlowPendingDelete] = useState<FlowResponse | null>(null);

  const flowsQuery = useFlows(slug, { page, pageSize: PAGE_SIZE });

  // Flows only carry a triggerSegmentId -- resolve the display name the same
  // way CampaignsListPage resolves segmentId -> segment name.
  const segmentsQuery = useQuery({
    queryKey: ["workspace", slug, "segments", "all-for-lookup"],
    queryFn: () => listSegments(slug, { page: 1, pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE }),
    enabled: Boolean(slug),
  });
  const segmentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const segment of segmentsQuery.data?.items ?? []) map.set(segment.id, segment.name);
    return map;
  }, [segmentsQuery.data]);

  const duplicateMutation = useDuplicateFlow(slug);
  const deleteMutation = useDeleteFlow(slug);

  function handleDuplicate(flow: FlowResponse) {
    duplicateMutation.mutate(flow.id, {
      onSuccess: (duplicated) => {
        toast.success("Цепочка продублирована");
        navigate(`/w/${slug}/flows/${duplicated.id}`);
      },
      onError: () => toast.error(GENERIC_ERROR),
    });
  }

  function handleDelete(flow: FlowResponse) {
    deleteMutation.mutate(flow.id, {
      onSuccess: () => {
        toast.success("Цепочка удалена");
        setFlowPendingDelete(null);
      },
      onError: (error: unknown) => {
        setFlowPendingDelete(null);
        const body = error instanceof ApiError ? (error.body as { error?: unknown } | undefined) : undefined;
        toast.error(typeof body?.error === "string" ? body.error : GENERIC_ERROR);
      },
    });
  }

  const data = flowsQuery.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isInitialLoad = flowsQuery.isLoading;
  const isRefetching = flowsQuery.isPlaceholderData || flowsQuery.isFetching;

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-display font-semibold">Цепочки</h1>
          <p className="text-sm text-muted-foreground">
            Триггерные цепочки писем — от события или входа в сегмент до серии писем с задержками и условиями.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Создать цепочку</Button>
      </div>

      {isInitialLoad ? (
        <Skeleton className="h-96 w-full" />
      ) : items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Цепочек пока нет</CardTitle>
            <CardDescription>
              Постройте автоматическую цепочку — от события или входа в сегмент до серии писем с задержками и
              условиями.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => setCreateOpen(true)}>Создать цепочку</Button>
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
                  <TableHead>Триггер</TableHead>
                  <TableHead>Обновлена</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((flow) => (
                  <TableRow
                    key={flow.id}
                    className="h-12 cursor-pointer"
                    onClick={() => navigate(`/w/${slug}/flows/${flow.id}`)}
                  >
                    <TableCell>{flow.name}</TableCell>
                    <TableCell>
                      <FlowStatusBadge status={flow.status} />
                    </TableCell>
                    <TableCell>{triggerSummary(flow, segmentNameById)}</TableCell>
                    <TableCell>{new Date(flow.updatedAt).toLocaleString("ru-RU")}</TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label="Действия">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => navigate(`/w/${slug}/flows/${flow.id}`)}>
                            Открыть
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={duplicateMutation.isPending}
                            onSelect={() => handleDuplicate(flow)}
                          >
                            Дублировать
                          </DropdownMenuItem>
                          {isDeletableFlowStatus(flow) ? (
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onSelect={() => setFlowPendingDelete(flow)}
                            >
                              Удалить
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

      <CreateFlowDialog slug={slug} open={createOpen} onOpenChange={setCreateOpen} />

      {flowPendingDelete ? (
        <AlertDialog
          open={Boolean(flowPendingDelete)}
          onOpenChange={(open) => {
            if (!open) setFlowPendingDelete(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Удалить цепочку «{flowPendingDelete.name}»?</AlertDialogTitle>
              <AlertDialogDescription>
                Цепочка и её настройки будут удалены без возможности восстановления.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Отмена</AlertDialogCancel>
              <AlertDialogAction
                disabled={deleteMutation.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={(e) => {
                  e.preventDefault();
                  handleDelete(flowPendingDelete);
                }}
              >
                {deleteMutation.isPending ? "Удаляем…" : "Удалить цепочку"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}

export default FlowsListPage;
