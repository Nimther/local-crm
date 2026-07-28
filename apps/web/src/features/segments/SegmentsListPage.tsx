import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { MoreHorizontal } from "lucide-react";

import type { SegmentListResponse, SegmentResponse } from "@mega-crm/shared-schemas";
import { apiGet } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DeleteSegmentDialog } from "@/features/segments/DeleteSegmentDialog";
import { listSegments } from "@/features/segments/api";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;

interface MemberListItem {
  userId: string;
  name: string;
}

/**
 * D-10/D-11: segments list -- name, last-computed member count + freshness
 * timestamp, created date, each row linking to the segment detail page
 * (03-04). "Создать сегмент" is the one accent CTA per screen.
 */
export function SegmentsListPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const [segmentPendingDelete, setSegmentPendingDelete] = useState<SegmentResponse | null>(null);
  const [page, setPage] = useState(1);

  const segmentsQuery = useQuery({
    queryKey: ["workspace", slug, "segments", page, PAGE_SIZE],
    queryFn: () => listSegments(slug, { page, pageSize: PAGE_SIZE }),
    enabled: Boolean(slug),
    placeholderData: keepPreviousData,
  });

  // D-11: resolve createdByUserId -> display name, the 02-08 CsvImportHistory
  // pattern (GET /members, build a lookup map).
  const membersQuery = useQuery({
    queryKey: ["workspace", slug, "members"],
    queryFn: () => apiGet<MemberListItem[]>(`/api/workspaces/${slug}/members`),
    enabled: Boolean(slug),
  });

  const memberNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of membersQuery.data ?? []) map.set(member.userId, member.name);
    return map;
  }, [membersQuery.data]);

  const data: SegmentListResponse | undefined = segmentsQuery.data;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isInitialLoad = segmentsQuery.isLoading;
  const isRefetching = segmentsQuery.isPlaceholderData || segmentsQuery.isFetching;

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-display font-semibold">Сегменты</h1>
          <p className="text-sm text-muted-foreground">
            Динамические аудитории по свойствам профиля и поведению.
          </p>
        </div>
        <Button onClick={() => void navigate(`/w/${slug}/segments/new`)}>Создать сегмент</Button>
      </div>

      {isInitialLoad ? (
        <Skeleton className="h-96 w-full" />
      ) : items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Сегментов пока нет</CardTitle>
            <CardDescription>
              Создайте сегмент — объедините контакты по свойствам и поведению. Он сразу станет доступен как
              аудитория для кампаний и цепочек.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => void navigate(`/w/${slug}/segments/new`)}>Создать сегмент</Button>
          </CardContent>
        </Card>
      ) : (
        <Card className={cn("transition-opacity duration-200", isRefetching && "opacity-50")}>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Имя</TableHead>
                  <TableHead>Участников</TableHead>
                  <TableHead>Обновлён</TableHead>
                  <TableHead>Автор</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((segment) => (
                  <TableRow
                    key={segment.id}
                    className="h-12 cursor-pointer"
                    onClick={() => void navigate(`/w/${slug}/segments/${segment.id}`)}
                  >
                    <TableCell>{segment.name}</TableCell>
                    <TableCell>
                      {segment.memberCount === null ? (
                        "—"
                      ) : (
                        <div>
                          <p className="text-display font-semibold">{segment.memberCount.toLocaleString("ru-RU")}</p>
                          {segment.memberCountAt ? (
                            <p className="text-sm text-muted-foreground">
                              на {new Date(segment.memberCountAt).toLocaleString("ru-RU")}
                            </p>
                          ) : null}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{new Date(segment.updatedAt).toLocaleString("ru-RU")}</TableCell>
                    <TableCell>
                      {segment.createdByUserId ? memberNameById.get(segment.createdByUserId) ?? "—" : "—"}
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label="Действия">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => void navigate(`/w/${slug}/segments/${segment.id}`)}>
                            Изменить
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => setSegmentPendingDelete(segment)}
                          >
                            Удалить
                          </DropdownMenuItem>
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

      {segmentPendingDelete ? (
        <DeleteSegmentDialog
          slug={slug}
          segment={segmentPendingDelete}
          open={Boolean(segmentPendingDelete)}
          onOpenChange={(open) => {
            if (!open) setSegmentPendingDelete(null);
          }}
        />
      ) : null}
    </div>
  );
}

export default SegmentsListPage;
