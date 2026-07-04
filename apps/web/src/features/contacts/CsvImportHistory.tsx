import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Download } from "lucide-react";

import type { CsvImportStatus } from "@mega-crm/shared-schemas";
import { apiGet } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface MemberListItem {
  userId: string;
  name: string;
}

function StatusBadge({ status }: { status: CsvImportStatus["status"] }) {
  if (status === "done") {
    return (
      <Badge variant="outline" className="border-transparent bg-green-50 text-green-600">
        Готово
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="outline" className="border-transparent bg-destructive/10 text-destructive">
        Ошибка
      </Badge>
    );
  }
  if (status === "applying") {
    return <Badge variant="outline">Выполняется</Badge>;
  }
  return (
    <Badge variant="outline" className="border-transparent bg-neutral-100 text-neutral-500">
      Черновик
    </Badge>
  );
}

function summaryText(item: CsvImportStatus): string {
  const summary = item.summary;
  if (!summary) return "—";
  if (item.status === "done" || item.status === "failed" || item.status === "applying") {
    const parts = [`Создано: ${summary.created ?? 0}`, `Обновлено: ${summary.updated ?? 0}`];
    if (item.duplicatePolicy === "skip") parts.push(`Пропущено: ${summary.skipped ?? 0}`);
    if ((summary.errorCount ?? 0) > 0) parts.push(`Ошибок: ${summary.errorCount}`);
    return parts.join(" · ");
  }
  return `Будет создано: ${summary.willCreate ?? 0} · Будет обновлено: ${summary.willUpdate ?? 0}`;
}

/**
 * CSV import history (D-20): file / date / author / status / summary / an
 * error-report download link, each row re-entering the wizard's
 * progress/report view via the same status endpoint the wizard itself polls
 * (D-16) -- see CsvImportWizard's `:id` re-entry branch.
 */
export function CsvImportHistory() {
  const { slug = "" } = useParams<{ slug: string }>();

  const historyQuery = useQuery({
    queryKey: ["workspace", slug, "imports"],
    queryFn: () => apiGet<CsvImportStatus[]>(`/api/workspaces/${slug}/imports`),
    enabled: Boolean(slug),
  });

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

  if (historyQuery.isLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const items = historyQuery.data ?? [];

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-display font-semibold">Импорт CSV</h1>
          <p className="text-sm text-muted-foreground">История импортов контактов из CSV-файлов.</p>
        </div>
        <Button asChild>
          <Link to={`/w/${slug}/contacts/import`}>Загрузить файл</Link>
        </Button>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Импортов ещё не было</CardTitle>
            <CardDescription>Загрузите CSV-файл, чтобы добавить контакты пакетом.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Файл</TableHead>
                  <TableHead>Дата</TableHead>
                  <TableHead>Автор</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead>Итог</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.fileName}</TableCell>
                    <TableCell>{new Date(item.createdAt).toLocaleString("ru-RU")}</TableCell>
                    <TableCell>{memberNameById.get(item.createdByUserId) ?? "—"}</TableCell>
                    <TableCell>
                      <StatusBadge status={item.status} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{summaryText(item)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {item.status === "applying" || item.status === "done" || item.status === "failed" ? (
                          <Button asChild variant="ghost" size="sm">
                            <Link to={`/w/${slug}/contacts/import/${item.id}`}>Открыть</Link>
                          </Button>
                        ) : null}
                        {(item.summary?.errorCount ?? 0) > 0 ? (
                          <Button asChild variant="ghost" size="sm">
                            <a href={`/api/workspaces/${slug}/imports/${item.id}/errors`} download>
                              <Download className="mr-1 h-4 w-4" />
                              Ошибки
                            </a>
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
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

export default CsvImportHistory;
