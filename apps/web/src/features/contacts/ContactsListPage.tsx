import { useEffect, useMemo, useState } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { ArrowDown, ArrowUp, ArrowUpDown, Filter } from "lucide-react";

import type { ContactListResponse, ContactResponse, SubscriptionStatus } from "@mega-crm/shared-schemas";
import { apiGet } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState } from "@/components/QueryErrorState";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CreateContactDialog } from "@/features/contacts/ContactForm";
import { SubscriptionStatusBadge } from "@/features/contacts/SubscriptionStatusBadge";
import { cn } from "@/lib/utils";

const STATUS_OPTIONS: { value: SubscriptionStatus; label: string }[] = [
  { value: "subscribed", label: "Подписан" },
  { value: "unsubscribed", label: "Отписан" },
  { value: "suppressed", label: "В списке подавления" },
];

const PAGE_SIZE = 20;

/** Simple trailing debounce -- no debounce utility exists in the codebase yet, keep local to this component. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

const columnHelper = createColumnHelper<ContactResponse>();

/**
 * Contact list (CONT-01/D-13): search (email/name/external_id) + status/tag
 * filters + sortable email/createdAt columns (server-driven, D-13 schema
 * only supports those two) + pagination, via a headless @tanstack/react-
 * table column model. Tag options are derived from the currently loaded
 * page (no dedicated tag-vocabulary endpoint exists in this phase's scope).
 */
export function ContactsListPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const [searchInput, setSearchInput] = useState("");
  const search = useDebouncedValue(searchInput, 300);
  const [status, setStatus] = useState<SubscriptionStatus | undefined>(undefined);
  const [tag, setTag] = useState<string | undefined>(undefined);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [page, setPage] = useState(1);

  // Reset to page 1 whenever a filter/search/sort changes.
  useEffect(() => {
    setPage(1);
  }, [search, status, tag, sorting]);

  const sort = useMemo<"createdAt" | "-createdAt" | "email" | "-email" | undefined>(() => {
    const active = sorting[0];
    if (!active) return undefined;
    if (active.id === "email") return active.desc ? "-email" : "email";
    if (active.id === "createdAt") return active.desc ? "-createdAt" : "createdAt";
    return undefined;
  }, [sorting]);

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (status) params.set("status", status);
    if (tag) params.set("tag", tag);
    if (sort) params.set("sort", sort);
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    return params;
  }, [search, status, tag, sort, page]);

  const contactsQuery = useQuery({
    queryKey: ["workspace", slug, "contacts", queryParams.toString()],
    queryFn: () => apiGet<ContactListResponse>(`/api/workspaces/${slug}/contacts?${queryParams.toString()}`),
    enabled: Boolean(slug),
    placeholderData: keepPreviousData,
  });

  // `?? []` built a fresh array every render, so the availableTags useMemo
  // below re-ran on every render and memoized nothing.
  const items = useMemo(() => contactsQuery.data?.items ?? [], [contactsQuery.data?.items]);
  const total = contactsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const contact of items) {
      for (const t of contact.tags) set.add(t);
    }
    return Array.from(set).sort();
  }, [items]);

  const columns = useMemo(
    () => [
      columnHelper.accessor((row) => `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim(), {
        id: "name",
        header: "Имя",
        enableSorting: false,
        cell: (info) => info.getValue() || "—",
      }),
      columnHelper.accessor("email", {
        id: "email",
        header: "Email",
        enableSorting: true,
        cell: (info) => info.getValue() ?? "—",
      }),
      columnHelper.accessor("externalId", {
        id: "externalId",
        header: "External ID",
        enableSorting: false,
        cell: (info) => info.getValue() ?? "—",
      }),
      columnHelper.accessor("subscriptionStatus", {
        id: "subscriptionStatus",
        header: "Статус",
        enableSorting: false,
        cell: (info) => <SubscriptionStatusBadge status={info.getValue()} />,
      }),
      columnHelper.accessor("tags", {
        id: "tags",
        header: "Теги",
        enableSorting: false,
        cell: (info) => {
          const tags = info.getValue();
          if (!tags.length) return "—";
          return (
            <div className="flex flex-wrap gap-1">
              {tags.map((t) => (
                <Badge key={t} variant="secondary">
                  {t}
                </Badge>
              ))}
            </div>
          );
        },
      }),
      columnHelper.accessor("createdAt", {
        id: "createdAt",
        header: "Создан",
        enableSorting: true,
        cell: (info) => new Date(info.getValue()).toLocaleDateString("ru-RU"),
      }),
    ],
    []
  );

  const table = useReactTable({
    data: items,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    manualSorting: true,
    manualPagination: true,
    getCoreRowModel: getCoreRowModel(),
  });

  const hasActiveFilters = Boolean(search.trim() || status || tag);
  // isLoading (isPending && isFetching) is true ONLY on the genuine first
  // load now that placeholderData: keepPreviousData is set -- every later
  // search/filter/sort/page change keeps the previous page's data (and
  // 'success' status) while it refetches, so this never re-triggers on a
  // keystroke and the toolbar/input below stay mounted.
  const isInitialLoad = contactsQuery.isLoading;
  // An in-flight refetch of an already-loaded page (new queryKey reusing
  // placeholder data) -- shown as a dim cue on the results region only,
  // never a remount.
  const isRefetching = contactsQuery.isPlaceholderData || contactsQuery.isFetching;
  // OPS-17/D-11: a failed fetch with NO prior data (genuine first-load
  // failure, or a placeholderData carry-over that never resolved) gets the
  // full-region QueryErrorState. A failed BACKGROUND refetch that still has
  // stale data (TanStack Query preserves `data` across a failed refetch --
  // `status` flips to 'error' but the last successful `data` is untouched)
  // must NOT clobber the previously-rendered table -- it surfaces as a
  // contained banner above the stale rows instead (T-15-14).
  const isFullyErrored = contactsQuery.isError && !contactsQuery.data;
  const isStaleErrored = contactsQuery.isError && Boolean(contactsQuery.data);
  // A page beyond the real total (e.g. the last item on the last page was
  // deleted server-side while this page number was still selected) must
  // render as an explicit out-of-range state, not an empty-looking table.
  const isOutOfRange = total > 0 && page > totalPages;

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-display font-semibold">Контакты</h1>
          <p className="text-sm text-muted-foreground">База контактов воркспейса.</p>
        </div>
        <CreateContactDialog slug={slug} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Поиск по email, имени или external_id"
          className="max-w-sm"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Filter className="mr-2 h-4 w-4" />
              Статус
              {status ? <Badge className="ml-2">{STATUS_OPTIONS.find((o) => o.value === status)?.label}</Badge> : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Статус подписки</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {STATUS_OPTIONS.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.value}
                checked={status === option.value}
                onCheckedChange={(checked) => setStatus(checked ? option.value : undefined)}
              >
                {option.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Filter className="mr-2 h-4 w-4" />
              Теги
              {tag ? <Badge className="ml-2">{tag}</Badge> : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Теги</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {availableTags.length === 0 ? (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">Нет тегов на этой странице</p>
            ) : (
              availableTags.map((t) => (
                <DropdownMenuCheckboxItem
                  key={t}
                  checked={tag === t}
                  onCheckedChange={(checked) => setTag(checked ? t : undefined)}
                >
                  {t}
                </DropdownMenuCheckboxItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isInitialLoad ? (
        <div className="space-y-4">
          <Skeleton className="h-96 w-full" />
        </div>
      ) : isFullyErrored ? (
        <QueryErrorState
          title="Не удалось загрузить контакты"
          isFetching={contactsQuery.isFetching}
          onRetry={() => void contactsQuery.refetch()}
        />
      ) : (
        <div className={cn("space-y-6 transition-opacity duration-200", isRefetching && "opacity-50")}>
          {isStaleErrored ? (
            <QueryErrorState
              title="Не удалось обновить список контактов"
              detail="Показаны последние загруженные данные."
              isFetching={contactsQuery.isFetching}
              onRetry={() => void contactsQuery.refetch()}
            />
          ) : null}
          {total === 0 && !hasActiveFilters ? (
            <EmptyState
              title="Пока нет ни одного контакта"
              description="Добавьте контакты вручную, импортируйте CSV или начните отправлять события через API — контакты появятся автоматически."
              action={<CreateContactDialog slug={slug} />}
            />
          ) : total === 0 && hasActiveFilters ? (
            <EmptyState title="Нет контактов по заданным фильтрам" />
          ) : isOutOfRange ? (
            <EmptyState
              title="Страница не найдена"
              description={`Всего страниц: ${totalPages}.`}
              action={
                <Button variant="outline" size="sm" onClick={() => setPage(1)}>
                  Вернуться на первую страницу
                </Button>
              }
            />
          ) : (
            <>
              <Card>
                <CardContent className="p-0">
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
                                  <button
                                    type="button"
                                    className="flex items-center gap-1 hover:text-foreground"
                                    onClick={header.column.getToggleSortingHandler()}
                                  >
                                    {flexRender(header.column.columnDef.header, header.getContext())}
                                    {sortDirection === "asc" ? (
                                      <ArrowUp className="h-3.5 w-3.5" />
                                    ) : sortDirection === "desc" ? (
                                      <ArrowDown className="h-3.5 w-3.5" />
                                    ) : (
                                      <ArrowUpDown className="h-3.5 w-3.5 opacity-40" />
                                    )}
                                  </button>
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
                        <TableRow
                          key={row.id}
                          className="h-12 cursor-pointer"
                          onClick={() => void navigate(`/w/${slug}/contacts/${row.original.id}`)}
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
                <p className="text-sm text-muted-foreground">Всего контактов: {total}</p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
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
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default ContactsListPage;
