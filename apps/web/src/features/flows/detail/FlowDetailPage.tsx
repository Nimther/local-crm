import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { EXHAUSTIVE_LOOKUP_PAGE_SIZE, type WorkspaceResponse } from "@mega-crm/shared-schemas";
import { ApiError, apiGet } from "@/lib/api";
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
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState } from "@/components/QueryErrorState";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  useDeleteFlow,
  useFlow,
  useFlowAnalytics,
  useFlowRuns,
  usePauseFlow,
  useResumeFlow,
} from "@/features/flows/api";
import { FlowCanvas } from "@/features/flows/canvas/FlowCanvas";
import { FlowStatusBadge } from "@/features/flows/FlowStatusBadge";
import { isDeletableFlowStatus } from "@/features/flows/list/FlowsListPage";
import { listSegments } from "@/features/segments/api";
import { FlowAnalyticsTable } from "./FlowAnalyticsTable";
import { FlowLifecycleSettings } from "./FlowLifecycleSettings";
import { FlowRunsTable } from "./FlowRunsTable";
import { PublishEnrollDialog } from "./PublishEnrollDialog";
import { QuietHoursCard } from "./QuietHoursCard";

const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";
const MEMBER_TOOLTIP = "Только Owner или Admin может публиковать цепочки.";

function extractServerError(error: unknown): string {
  const body = error instanceof ApiError ? (error.body as { error?: unknown } | undefined) : undefined;
  return typeof body?.error === "string" ? body.error : GENERIC_ERROR;
}

/**
 * Flow detail (FLOW-01/04/05/06/07): canvas + lifecycle actions + run
 * counter + settings, organized as three tabs (Холст / Настройки / Контакты
 * в цепочке) under one status/lifecycle header. Structural analog:
 * CampaignDetailPage, adapted for the always-editable-draft flow model
 * (there is no separate "draft view" -- the canvas IS the draft view,
 * always reachable regardless of live/paused status, D-20).
 */
export function FlowDetailPage() {
  const { slug = "", id = "" } = useParams<{ slug: string; id: string }>();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<"canvas" | "settings" | "runs" | "analytics">("canvas");
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [pauseConfirmOpen, setPauseConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const workspaceQuery = useQuery({
    queryKey: ["workspace", slug],
    queryFn: () => apiGet<WorkspaceResponse>(`/api/workspaces/${slug}`),
    enabled: Boolean(slug),
  });
  const viewerRole = workspaceQuery.data?.role ?? "member";
  const canManage = viewerRole === "owner" || viewerRole === "admin";

  const flowQuery = useFlow(slug, id);
  const flow = flowQuery.data;

  // D-21: cheap counts-only fetch (pageSize 1) for the header caption --
  // FlowRunsTable independently fetches the real paginated list for its tab.
  const runCountsQuery = useFlowRuns(slug, id, { page: 1, pageSize: 1 });
  const counts = runCountsQuery.data?.counts;

  // ANLT-02/D-03: one flow-analytics response drives BOTH the canvas node
  // badges (below) and FlowAnalyticsTable's own fetch (which independently
  // re-queries the same key, sharing this cache entry via TanStack Query).
  const analyticsQuery = useFlowAnalytics(slug, id);

  const segmentsQuery = useQuery({
    queryKey: ["workspace", slug, "segments", "all-for-lookup"],
    queryFn: () => listSegments(slug, { page: 1, pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE }),
    enabled: Boolean(slug) && Boolean(flow),
  });
  const segmentName = flow?.triggerSegmentId
    ? segmentsQuery.data?.items.find((segment) => segment.id === flow.triggerSegmentId)?.name
    : undefined;

  const pauseMutation = usePauseFlow(slug);
  const resumeMutation = useResumeFlow(slug);
  const deleteMutation = useDeleteFlow(slug);

  function handleSelectNode(nodeId: string) {
    setPublishOpen(false);
    setActiveTab("canvas");
    setFocusNodeId(nodeId);
  }

  function handlePause() {
    if (!flow) return;
    pauseMutation.mutate(flow.id, {
      onSuccess: () => {
        toast.success("Цепочка приостановлена");
        setPauseConfirmOpen(false);
      },
      onError: () => toast.error(GENERIC_ERROR),
    });
  }

  function handleResume() {
    if (!flow) return;
    resumeMutation.mutate(flow.id, {
      onSuccess: () => toast.success("Цепочка возобновлена"),
      onError: () => toast.error(GENERIC_ERROR),
    });
  }

  function handleDelete() {
    if (!flow) return;
    deleteMutation.mutate(flow.id, {
      onSuccess: () => {
        toast.success("Цепочка удалена");
        void navigate(`/w/${slug}/flows`);
      },
      onError: (error: unknown) => {
        setDeleteConfirmOpen(false);
        toast.error(extractServerError(error));
      },
    });
  }

  // OPS-17/D-11: the canvas below renders the flow definition this query
  // loads -- a failed fetch must show the error state in place of the
  // canvas with Retry, never let the canvas mount over missing/partial
  // data. Split the previously-conflated isError/not-found branch, same
  // pattern as ContactDetailPage/CampaignDetailPage.
  if (flowQuery.isLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (flowQuery.isError) {
    return (
      <div className="p-8">
        <QueryErrorState
          title="Не удалось загрузить цепочку"
          isFetching={flowQuery.isFetching}
          onRetry={() => void flowQuery.refetch()}
        />
      </div>
    );
  }

  if (!flow) {
    return (
      <div className="p-8">
        <EmptyState title="Цепочка не найдена" />
      </div>
    );
  }

  const lifecycleButton =
    flow.status === "draft" ? (
      <Button type="button" disabled={!canManage} onClick={() => setPublishOpen(true)}>
        Опубликовать
      </Button>
    ) : flow.status === "live" ? (
      <Button type="button" variant="outline" disabled={!canManage} onClick={() => setPauseConfirmOpen(true)}>
        Приостановить
      </Button>
    ) : (
      <Button type="button" disabled={!canManage || resumeMutation.isPending} onClick={handleResume}>
        {resumeMutation.isPending ? "Возобновляем…" : "Возобновить"}
      </Button>
    );

  // CR-03/WR-03: a live/paused flow may have accumulated an unpublished
  // draft (canvas autosave) whose trigger edits are pinned away from live
  // enrollment until published (flow.repository.ts publishFlow). Without
  // this action there was no UI path at all to promote that draft.
  const hasPublishableDraft =
    (flow.status === "live" || flow.status === "paused") && flow.draftVersionId !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-200 p-6">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{flow.name}</h1>
            <FlowStatusBadge status={flow.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {counts
              ? counts.onOldVersions > 0
                ? `${counts.active} контактов в цепочке (${counts.onOldVersions} на старых версиях)`
                : `${counts.active} контактов в цепочке`
              : "…"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasPublishableDraft ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="inline-flex">
                    <Button type="button" variant="outline" disabled={!canManage} onClick={() => setPublishOpen(true)}>
                      Опубликовать изменения
                    </Button>
                  </span>
                </TooltipTrigger>
                {!canManage ? <TooltipContent>{MEMBER_TOOLTIP}</TooltipContent> : null}
              </Tooltip>
            </TooltipProvider>
          ) : null}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="inline-flex">
                  {lifecycleButton}
                </span>
              </TooltipTrigger>
              {!canManage ? <TooltipContent>{MEMBER_TOOLTIP}</TooltipContent> : null}
            </Tooltip>
          </TooltipProvider>
          {isDeletableFlowStatus(flow) ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="inline-flex">
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-destructive"
                      disabled={!canManage}
                      onClick={() => setDeleteConfirmOpen(true)}
                    >
                      Удалить цепочку
                    </Button>
                  </span>
                </TooltipTrigger>
                {!canManage ? <TooltipContent>{MEMBER_TOOLTIP}</TooltipContent> : null}
              </Tooltip>
            </TooltipProvider>
          ) : null}
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as typeof activeTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mx-6 mt-4 w-fit">
          <TabsTrigger value="canvas">Холст</TabsTrigger>
          <TabsTrigger value="settings">Настройки</TabsTrigger>
          <TabsTrigger value="runs">Контакты в цепочке</TabsTrigger>
          <TabsTrigger value="analytics">Аналитика</TabsTrigger>
        </TabsList>
        <TabsContent value="canvas" className="mt-0 min-h-0 flex-1">
          <FlowCanvas focusNodeId={focusNodeId} metrics={analyticsQuery.data} />
        </TabsContent>
        <TabsContent value="settings" className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className="max-w-2xl space-y-6">
            <FlowLifecycleSettings slug={slug} flow={flow} />
            <QuietHoursCard slug={slug} flow={flow} />
          </div>
        </TabsContent>
        <TabsContent value="runs" className="min-h-0 flex-1 overflow-y-auto p-6">
          <FlowRunsTable slug={slug} flowId={flow.id} canManage={canManage} />
        </TabsContent>
        <TabsContent value="analytics" className="min-h-0 flex-1 overflow-y-auto p-6">
          <FlowAnalyticsTable slug={slug} flowId={flow.id} />
        </TabsContent>
      </Tabs>

      <PublishEnrollDialog
        slug={slug}
        flow={flow}
        segmentName={segmentName}
        open={publishOpen}
        onOpenChange={setPublishOpen}
        onSelectNode={handleSelectNode}
      />

      <AlertDialog open={pauseConfirmOpen} onOpenChange={setPauseConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Приостановить цепочку «{flow.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Новые контакты перестанут входить, а уже идущие по цепочке — остановятся на текущем шаге до
              возобновления.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Не приостанавливать</AlertDialogCancel>
            <AlertDialogAction
              disabled={pauseMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                handlePause();
              }}
            >
              {pauseMutation.isPending ? "Приостанавливаем…" : "Приостановить"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить цепочку «{flow.name}»?</AlertDialogTitle>
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
                handleDelete();
              }}
            >
              {deleteMutation.isPending ? "Удаляем…" : "Удалить цепочку"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default FlowDetailPage;
