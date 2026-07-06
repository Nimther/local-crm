import { useEffect, useState } from "react";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router";
import { toast } from "sonner";

import type { ContactResponse, SegmentDefinition, SegmentResponse } from "@mega-crm/shared-schemas";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SubscriptionStatusBadge } from "@/features/contacts/SubscriptionStatusBadge";
import { getSegment, listSegmentMembers, updateSegment } from "@/features/segments/api";
import { SegmentBuilder } from "@/features/segments/SegmentBuilder";
import { GENERIC_ERROR, validateDefinition } from "@/features/segments/validateDefinition";
import { cn } from "@/lib/utils";

const MEMBERS_PAGE_SIZE = 20;

const columnHelper = createColumnHelper<ContactResponse>();

/**
 * D-12: paginated read-only member list -- a filtered view of Contacts, no
 * per-row actions. Reuses ContactsListPage's table/keepPreviousData pattern
 * verbatim. Refetches whenever `refreshToken` changes (D-13: after a
 * definition save, membership must reflect the new definition).
 */
function SegmentMembersTable({ slug, segmentId, refreshToken }: { slug: string; segmentId: string; refreshToken: number }) {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [refreshToken]);

  const membersQuery = useQuery({
    queryKey: ["workspace", slug, "segments", segmentId, "members", refreshToken, page, MEMBERS_PAGE_SIZE],
    queryFn: () => listSegmentMembers(slug, segmentId, { page, pageSize: MEMBERS_PAGE_SIZE }),
    enabled: Boolean(slug) && Boolean(segmentId),
    placeholderData: keepPreviousData,
  });

  const items = membersQuery.data?.items ?? [];
  const total = membersQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / MEMBERS_PAGE_SIZE));
  const isInitialLoad = membersQuery.isLoading;
  const isRefetching = membersQuery.isPlaceholderData || membersQuery.isFetching;

  const columns = [
    columnHelper.accessor((row) => `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim(), {
      id: "name",
      header: "Имя",
      cell: (info) => info.getValue() || "—",
    }),
    columnHelper.accessor("email", {
      id: "email",
      header: "Email",
      cell: (info) => info.getValue() ?? "—",
    }),
    columnHelper.accessor("subscriptionStatus", {
      id: "subscriptionStatus",
      header: "Статус",
      cell: (info) => <SubscriptionStatusBadge status={info.getValue()} />,
    }),
  ];

  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
  });

  if (isInitialLoad) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (total === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Пока никто не подходит под условия</CardTitle>
          <CardDescription>Измените условия сегмента — список обновится автоматически.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className={cn("space-y-4 transition-opacity duration-200", isRefetching && "opacity-50")}>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</TableHead>
                  ))}
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
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Всего участников: {total}</p>
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
    </div>
  );
}

/**
 * Segment detail (SEGM-01/03, D-12): «Определение сегмента» -- the same
 * SegmentBuilder used by the create flow, prefilled and editable inline
 * (rename is just editing the name field, D-14) -- above «Участники», a
 * paginated read-only member list (D-13: dynamic, refetches on save).
 */
export function SegmentDetailPage() {
  const { slug = "", id = "" } = useParams<{ slug: string; id: string }>();
  const queryClient = useQueryClient();

  const segmentQuery = useQuery({
    queryKey: ["workspace", slug, "segments", id],
    queryFn: () => getSegment(slug, id),
    enabled: Boolean(slug) && Boolean(id),
  });

  const [name, setName] = useState("");
  const [definition, setDefinition] = useState<SegmentDefinition | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  // Bumped after a successful save so the member table remounts its query
  // (D-13: membership must reflect the newly saved definition).
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (segmentQuery.data) {
      setName(segmentQuery.data.name);
      setDefinition(segmentQuery.data.definition);
    }
  }, [segmentQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => updateSegment(slug, id, { name: name.trim(), definition: definition as SegmentDefinition }),
    onSuccess: async (updated: SegmentResponse) => {
      setServerError(null);
      toast.success("Сегмент обновлён");
      await queryClient.invalidateQueries({ queryKey: ["workspace", slug, "segments", id] });
      await queryClient.invalidateQueries({ queryKey: ["workspace", slug, "segments"] });
      setName(updated.name);
      setDefinition(updated.definition);
      setRefreshToken((t) => t + 1);
    },
    onError: () => {
      setServerError(GENERIC_ERROR);
    },
  });

  function handleSave() {
    if (!definition) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError("Укажите название сегмента");
      return;
    }
    setNameError(null);

    const validationError = validateDefinition(definition);
    if (validationError) {
      setDefinitionError(validationError);
      return;
    }
    setDefinitionError(null);

    saveMutation.mutate();
  }

  // WR-06: check isError BEFORE the loading/skeleton branch -- a deleted/bad
  // segment id must surface the not-found card instead of hanging on an
  // infinite skeleton (isLoading stays false but `definition` never gets set).
  if (segmentQuery.isError || (!segmentQuery.isLoading && !segmentQuery.data)) {
    return (
      <div className="p-8">
        <Card>
          <CardHeader>
            <CardTitle>Сегмент не найден</CardTitle>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (segmentQuery.isLoading || !definition) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-8 p-8">
      <div>
        <h1 className="text-display font-semibold">{name}</h1>
      </div>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Определение сегмента</h2>

        <div className="max-w-sm space-y-2">
          <Label htmlFor="segment-name">Название сегмента</Label>
          <Input id="segment-name" value={name} onChange={(e) => setName(e.target.value)} />
          {nameError ? <p className="text-sm text-destructive">{nameError}</p> : null}
        </div>

        <SegmentBuilder value={definition} onChange={setDefinition} slug={slug} />

        {definitionError ? <p className="text-sm font-medium text-destructive">{definitionError}</p> : null}
        {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}

        <Button onClick={handleSave} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? "Сохраняем…" : "Сохранить изменения"}
        </Button>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Участники</h2>
        <SegmentMembersTable slug={slug} segmentId={id} refreshToken={refreshToken} />
      </section>
    </div>
  );
}

export default SegmentDetailPage;
