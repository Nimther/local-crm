import { useMemo, useState } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
} from "@tanstack/react-table";
import { useReactTable } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Link } from "react-router";

import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { QueryErrorState } from "@/components/QueryErrorState";
import { NODE_TYPE_META, type FlowCanvasNodeType } from "@/features/flows/canvas/nodeTypes";
import { useFlowAnalytics, type FlowNodeAnalyticsResponse } from "@/features/flows/api";
import { computeRate } from "@/lib/rates";

const rateLabel = (rate: number | null) => (rate === null ? "—" : `${rate}%`);

function nodeTypeLabel(nodeType: string): string {
  return NODE_TYPE_META[nodeType as FlowCanvasNodeType]?.label ?? nodeType;
}

const columnHelper = createColumnHelper<FlowNodeAnalyticsResponse>();

/**
 * ANLT-02/D-03/D-05: the flow detail page's «Аналитика» comparison tab --
 * one row per node_id (aggregated across ALL flow versions, per the same
 * GET /flows/:id/analytics response the canvas badges use), sortable by
 * node, listing send-node delivery/open/click/bounce counts + rates.
 * Nodes removed from the live definition are still listed (D-05) -- this
 * table has no concept of "the current graph", only the analytics response.
 *
 * OPS-18/D-12 (plan 15-15): deliberately NO `DataAsOfLabel`/`StaleDataBanner`
 * here. `useFlowAnalytics`'s `GET /flows/:id/analytics` response is built
 * live from `flow_run_steps`/`sends` (flow-analytics.repository.ts) --
 * `workspace_daily_rollup` plays no part in it. Mounting the rollup
 * watermark over these figures would mislabel live data as rollup-derived
 * (T-15-52); the plan 15-12 freshness signal only exists on the workspace
 * dashboard response and does not apply to this table.
 */
export function FlowAnalyticsTable({ slug, flowId }: { slug: string; flowId: string }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const analyticsQuery = useFlowAnalytics(slug, flowId);
  const items = analyticsQuery.data ?? [];

  const columns = useMemo(
    () => [
      columnHelper.accessor("nodeId", {
        id: "nodeId",
        header: "Узел",
        cell: (info) => (
          <div>
            <p className="font-medium">{nodeTypeLabel(info.row.original.nodeType)}</p>
            <p className="text-xs text-muted-foreground">{info.getValue()}</p>
          </div>
        ),
      }),
      columnHelper.accessor("contactCount", {
        id: "contactCount",
        header: "Прошли",
        cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.sent ?? null, {
        id: "sent",
        header: "Отправлено",
        cell: (info) => <span className="tabular-nums">{info.getValue() ?? "—"}</span>,
      }),
      columnHelper.accessor((row) => row.delivered ?? null, {
        id: "delivered",
        header: "Доставлено",
        cell: (info) => {
          const row = info.row.original;
          if (row.delivered === undefined) return <span className="tabular-nums">—</span>;
          return (
            <span className="tabular-nums">
              {row.delivered} <span className="text-muted-foreground">({rateLabel(computeRate(row.delivered, row.sent ?? 0))})</span>
            </span>
          );
        },
      }),
      columnHelper.accessor((row) => row.opened ?? null, {
        id: "opened",
        header: "Открыто",
        cell: (info) => {
          const row = info.row.original;
          if (row.opened === undefined) return <span className="tabular-nums">—</span>;
          return (
            <span className="tabular-nums">
              {row.opened}{" "}
              <span className="text-muted-foreground">({rateLabel(computeRate(row.opened, row.delivered ?? 0))})</span>
            </span>
          );
        },
      }),
      columnHelper.accessor((row) => row.clicked ?? null, {
        id: "clicked",
        header: "Клики",
        cell: (info) => {
          const row = info.row.original;
          if (row.clicked === undefined) return <span className="tabular-nums">—</span>;
          return (
            <span className="tabular-nums">
              {row.clicked}{" "}
              <span className="text-muted-foreground">({rateLabel(computeRate(row.clicked, row.delivered ?? 0))})</span>
            </span>
          );
        },
      }),
      columnHelper.accessor((row) => row.bounced ?? null, {
        id: "bounced",
        header: "Не доставлено",
        cell: (info) => <span className="tabular-nums">{info.getValue() ?? "—"}</span>,
      }),
    ],
    []
  );

  const table = useReactTable({
    data: items,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // WR-02/OPS-17/D-11: same isFullyErrored/isStaleErrored split every
  // sibling list/detail page in this phase applies -- this query shares its
  // exact key with FlowDetailPage's own analyticsQuery, so a background
  // refetch (e.g. after a pause/resume/publish mutation elsewhere on the
  // same detail page) can fail while this tab already shows previously
  // loaded rows. A plain `isError` check with no stale-data carve-out would
  // discard the whole table in favor of a generic error paragraph with no
  // Retry control.
  const isFullyErrored = analyticsQuery.isError && !analyticsQuery.data;
  const isStaleErrored = analyticsQuery.isError && Boolean(analyticsQuery.data);

  if (analyticsQuery.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (isFullyErrored) {
    return (
      <QueryErrorState
        title="Не удалось загрузить аналитику цепочки"
        isFetching={analyticsQuery.isFetching}
        onRetry={() => void analyticsQuery.refetch()}
      />
    );
  }

  if (items.length === 0) {
    return (
      <div className="space-y-4">
        {isStaleErrored ? (
          <QueryErrorState
            title="Не удалось обновить аналитику цепочки"
            detail="Показаны последние загруженные данные."
            isFetching={analyticsQuery.isFetching}
            onRetry={() => void analyticsQuery.refetch()}
          />
        ) : null}
        <div className="space-y-1">
          <p className="text-sm font-medium">Данных пока нет</p>
          <p className="text-sm text-muted-foreground">
            Опубликуйте цепочку и дождитесь первых контактов — здесь появится статистика по каждому узлу.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {isStaleErrored ? (
        <QueryErrorState
          title="Не удалось обновить аналитику цепочки"
          detail="Показаны последние загруженные данные."
          isFetching={analyticsQuery.isFetching}
          onRetry={() => void analyticsQuery.refetch()}
        />
      ) : null}
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const sortDirection = header.column.getIsSorted();
                return (
                  <TableHead key={header.id}>
                    {canSort ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="-ml-3 h-8"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sortDirection === "asc" ? (
                          <ArrowUp className="ml-2 h-3.5 w-3.5" />
                        ) : sortDirection === "desc" ? (
                          <ArrowDown className="ml-2 h-3.5 w-3.5" />
                        ) : (
                          <ArrowUpDown className="ml-2 h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </Button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} className="h-12">
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* D-03/D-04: deep link into the send log, pre-filtered by this flow. */}
      <Link to={`/w/${slug}/send-log?flow=${flowId}`} className="text-sm text-primary underline">
        Смотреть в журнале отправок
      </Link>
    </div>
  );
}

export default FlowAnalyticsTable;
