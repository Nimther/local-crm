import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";

import type { SegmentListResponse } from "@mega-crm/shared-schemas";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listSegments } from "@/features/segments/api";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;

/**
 * D-10/D-11: segments list -- name, last-computed member count + freshness
 * timestamp, created date, each row linking to the segment detail page
 * (03-04). "Создать сегмент" is the one accent CTA per screen.
 */
export function SegmentsListPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const segmentsQuery = useQuery({
    queryKey: ["workspace", slug, "segments", 1, PAGE_SIZE],
    queryFn: () => listSegments(slug, { page: 1, pageSize: PAGE_SIZE }),
    enabled: Boolean(slug),
    placeholderData: keepPreviousData,
  });

  const data: SegmentListResponse | undefined = segmentsQuery.data;
  const items = data?.items ?? [];
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
        <Button onClick={() => navigate(`/w/${slug}/segments/new`)}>Создать сегмент</Button>
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
            <Button onClick={() => navigate(`/w/${slug}/segments/new`)}>Создать сегмент</Button>
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
                  <TableHead>Создан</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((segment) => (
                  <TableRow
                    key={segment.id}
                    className="h-12 cursor-pointer"
                    onClick={() => navigate(`/w/${slug}/segments/${segment.id}`)}
                  >
                    <TableCell>{segment.name}</TableCell>
                    <TableCell>
                      {segment.memberCount === null ? (
                        "—"
                      ) : (
                        <span>
                          {segment.memberCount}
                          {segment.memberCountAt ? (
                            <span className="ml-2 text-xs text-muted-foreground">
                              на {new Date(segment.memberCountAt).toLocaleString("ru-RU")}
                            </span>
                          ) : null}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{new Date(segment.createdAt).toLocaleDateString("ru-RU")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default SegmentsListPage;
