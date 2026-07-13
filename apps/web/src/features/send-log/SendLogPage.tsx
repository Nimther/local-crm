import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Filter, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { fetchSendLog, type SendLogItem, type SendLogStatus } from "./api";
import { SendLogRowDrawer } from "./SendLogRowDrawer";

const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });

/** «3 минуты назад» -- reuse of ContactEventFeed.tsx's relativeTime helper (07-UI-SPEC: reuse verbatim). */
function relativeTime(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  if (Math.abs(diffSec) < 60) return RELATIVE_TIME_FORMAT.format(diffSec, "second");
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) return RELATIVE_TIME_FORMAT.format(diffMin, "minute");
  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) return RELATIVE_TIME_FORMAT.format(diffHour, "hour");
  const diffDay = Math.round(diffHour / 24);
  return RELATIVE_TIME_FORMAT.format(diffDay, "day");
}

/** 07-UI-SPEC.md § Color: the send-log status column's 3-hue badge vocabulary (D-06 chain + failed/excluded, D-15). */
const SEND_STATUS_LABELS: Record<string, string> = {
  sent: "Отправлено",
  delivered: "Доставлено",
  opened: "Открыто",
  clicked: "Клик",
  bounced: "Не доставлено",
  dropped: "Не доставлено",
  spam: "Не доставлено",
  failed: "Ошибка отправки",
  excluded: "Пропущено",
};

const SEND_STATUS_CLASSES: Record<string, string> = {
  sent: "border-transparent bg-neutral-100 text-neutral-500",
  delivered: "border-transparent bg-green-50 text-green-600",
  opened: "border-transparent bg-green-50 text-green-600",
  clicked: "border-transparent bg-green-50 text-green-600",
  bounced: "border-transparent bg-red-50 text-destructive",
  dropped: "border-transparent bg-red-50 text-destructive",
  spam: "border-transparent bg-red-50 text-destructive",
  failed: "border-transparent bg-red-50 text-destructive",
  excluded: "border-transparent bg-neutral-100 text-neutral-500",
};

const STATUS_OPTIONS: { value: SendLogStatus; label: string }[] = [
  { value: "sent", label: "Отправлено" },
  { value: "delivered", label: "Доставлено" },
  { value: "opened", label: "Открыто" },
  { value: "clicked", label: "Клик" },
  { value: "bounced", label: "Не доставлено (bounce)" },
  { value: "dropped", label: "Не доставлено (drop)" },
  { value: "spam", label: "Жалоба (спам)" },
  { value: "failed", label: "Ошибка отправки" },
  { value: "excluded", label: "Пропущено" },
];

const PERIOD_OPTIONS: { value: 7 | 30 | 90; label: string }[] = [
  { value: 7, label: "7 дней" },
  { value: 30, label: "30 дней" },
  { value: 90, label: "90 дней" },
];

const DEFAULT_PERIOD = 30;

function SendStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={SEND_STATUS_CLASSES[status] ?? "border-transparent bg-neutral-100 text-neutral-500"}
    >
      {SEND_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

function contactLabel(row: SendLogItem): string {
  const name = `${row.contactFirstName ?? ""} ${row.contactLastName ?? ""}`.trim();
  return name || row.contactEmail || "—";
}

function campaignOrFlowLabel(row: SendLogItem): string {
  return row.campaignName ?? row.flowName ?? "—";
}

const columnHelper = createColumnHelper<SendLogItem>();

/**
 * D-13/D-15/ANLT-05: the workspace-wide send log. Filters (contact/
 * campaign-or-flow/status multi-select/period) are driven entirely by URL
 * search params -- `contact`/`campaign`/`flow` are set by OTHER pages'
 * deep-links (never edited here, only cleared via their chip's × or the
 * blanket «Сбросить фильтры»), while `status`/`period`/`page` are edited
 * directly on this page. Follows the 02-13 keepPreviousData + results-scoped
 * skeleton + isPlaceholderData dim pattern (ContactsListPage precedent).
 */
export function SendLogPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedSendId, setSelectedSendId] = useState<string | null>(null);
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false);

  const contactId = searchParams.get("contact") ?? undefined;
  const campaignId = searchParams.get("campaign") ?? undefined;
  const flowId = searchParams.get("flow") ?? undefined;
  const campaignOrFlowId = campaignId ?? flowId ?? undefined;
  const statuses = searchParams.getAll("status") as SendLogStatus[];
  const periodParam = Number(searchParams.get("period"));
  const period = ([7, 30, 90] as const).includes(periodParam as 7 | 30 | 90)
    ? (periodParam as 7 | 30 | 90)
    : DEFAULT_PERIOD;
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const apiParams = useMemo(() => {
    const params = new URLSearchParams();
    if (contactId) params.set("contactId", contactId);
    if (campaignOrFlowId) params.set("campaignOrFlowId", campaignOrFlowId);
    for (const status of statuses) params.append("status", status);
    params.set("period", String(period));
    params.set("page", String(page));
    return params;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, campaignOrFlowId, statuses.join(","), period, page]);

  const sendLogQuery = useQuery({
    queryKey: ["workspace", slug, "send-log", apiParams.toString()],
    queryFn: () => fetchSendLog(slug, apiParams),
    enabled: Boolean(slug),
    placeholderData: keepPreviousData,
  });

  function updateParams(mutate: (next: URLSearchParams) => void) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      mutate(next);
      return next;
    });
  }

  function clearParam(key: "contact" | "campaign" | "flow") {
    updateParams((next) => {
      next.delete(key);
      next.delete("page");
    });
  }

  function toggleStatus(status: SendLogStatus) {
    updateParams((next) => {
      const current = next.getAll("status");
      next.delete("status");
      const nextSet = current.includes(status)
        ? current.filter((s) => s !== status)
        : [...current, status];
      for (const s of nextSet) next.append("status", s);
      next.delete("page");
    });
  }

  function setPeriod(value: 7 | 30 | 90) {
    updateParams((next) => {
      next.set("period", String(value));
      next.delete("page");
    });
  }

  function setPage(value: number) {
    updateParams((next) => {
      next.set("page", String(value));
    });
  }

  function resetFilters() {
    setSearchParams(new URLSearchParams());
  }

  const hasActiveFilters = Boolean(contactId || campaignId || flowId || statuses.length > 0 || period !== DEFAULT_PERIOD);

  const items = sendLogQuery.data?.items ?? [];
  const total = sendLogQuery.data?.total ?? 0;
  const pageSize = sendLogQuery.data?.pageSize ?? 50;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const columns = useMemo(
    () => [
      columnHelper.accessor((row) => contactLabel(row), {
        id: "contact",
        header: "Контакт",
        cell: (info) => info.getValue(),
      }),
      columnHelper.accessor((row) => campaignOrFlowLabel(row), {
        id: "campaignOrFlow",
        header: "Кампания / цепочка",
        cell: (info) => info.getValue(),
      }),
      columnHelper.accessor("status", {
        id: "status",
        header: "Статус",
        cell: (info) => {
          const row = info.row.original;
          return (
            <div className="flex flex-wrap items-center gap-2">
              <SendStatusBadge status={info.getValue()} />
              {row.openCount > 1 && (
                <span className="text-sm tabular-nums text-muted-foreground">открыто ×{row.openCount}</span>
              )}
              {row.clickCount > 1 && (
                <span className="text-sm tabular-nums text-muted-foreground">клики ×{row.clickCount}</span>
              )}
            </div>
          );
        },
      }),
      columnHelper.accessor((row) => row.sentAt ?? row.queuedAt, {
        id: "when",
        header: "Когда",
        cell: (info) => <span className="text-sm text-muted-foreground">{relativeTime(info.getValue())}</span>,
      }),
    ],
    []
  );

  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const isInitialLoad = sendLogQuery.isLoading;
  const isRefetching = sendLogQuery.isPlaceholderData || sendLogQuery.isFetching;

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-display font-semibold">Журнал отправок</h1>
        <p className="text-sm text-muted-foreground">Полный лог отправленных писем по всему воркспейсу.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {contactId && (
          <Badge variant="secondary" className="gap-1">
            Контакт
            <button type="button" onClick={() => clearParam("contact")} aria-label="Сбросить фильтр по контакту">
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}
        {campaignId && (
          <Badge variant="secondary" className="gap-1">
            Кампания
            <button type="button" onClick={() => clearParam("campaign")} aria-label="Сбросить фильтр по кампании">
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}
        {flowId && (
          <Badge variant="secondary" className="gap-1">
            Цепочка
            <button type="button" onClick={() => clearParam("flow")} aria-label="Сбросить фильтр по цепочке">
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}

        <Popover open={statusPopoverOpen} onOpenChange={setStatusPopoverOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <Filter className="mr-2 h-4 w-4" />
              {statuses.length > 0 ? `Статус: ${statuses.length}` : "Статус"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-0" align="start">
            <Command>
              <CommandList>
                <CommandGroup>
                  {STATUS_OPTIONS.map((option) => (
                    <CommandItem key={option.value} onSelect={() => toggleStatus(option.value)}>
                      <Checkbox checked={statuses.includes(option.value)} className="mr-2" />
                      {option.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <div className="flex items-center gap-1">
          {PERIOD_OPTIONS.map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={period === option.value ? "default" : "outline"}
              onClick={() => setPeriod(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>

        <Button variant="outline" size="sm" disabled={!hasActiveFilters} onClick={resetFilters}>
          Сбросить фильтры
        </Button>
      </div>

      {isInitialLoad ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className={cn("space-y-6 transition-opacity duration-200", isRefetching && "opacity-50")}>
          {total === 0 && !hasActiveFilters ? (
            <Card>
              <CardHeader>
                <CardTitle>Отправок пока нет</CardTitle>
                <CardDescription>Письма появятся здесь после первой кампании или цепочки.</CardDescription>
              </CardHeader>
            </Card>
          ) : total === 0 && hasActiveFilters ? (
            <Card>
              <CardHeader>
                <CardTitle>Ничего не найдено</CardTitle>
                <CardDescription>Попробуйте изменить период или сбросить фильтры.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" size="sm" onClick={resetFilters}>
                  Сбросить фильтры
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      {table.getHeaderGroups().map((headerGroup) => (
                        <TableRow key={headerGroup.id}>
                          {headerGroup.headers.map((header) => (
                            <TableHead key={header.id}>
                              {flexRender(header.column.columnDef.header, header.getContext())}
                            </TableHead>
                          ))}
                        </TableRow>
                      ))}
                    </TableHeader>
                    <TableBody>
                      {table.getRowModel().rows.map((row) => (
                        <TableRow
                          key={row.id}
                          className="h-12 cursor-pointer"
                          onClick={() => setSelectedSendId(row.original.id)}
                        >
                          {row.getVisibleCells().map((cell) => (
                            <TableCell key={cell.id}>
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <div className="flex items-center justify-between">
                <p className="text-sm tabular-nums text-muted-foreground">Всего отправок: {total}</p>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(Math.max(1, page - 1))}>
                    Назад
                  </Button>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    Стр. {page} из {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage(Math.min(totalPages, page + 1))}
                  >
                    Вперёд
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <SendLogRowDrawer
        slug={slug}
        sendId={selectedSendId}
        row={items.find((item) => item.id === selectedSendId) ?? null}
        onOpenChange={(open) => {
          if (!open) setSelectedSendId(null);
        }}
      />
    </div>
  );
}

export default SendLogPage;
