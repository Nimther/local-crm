import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useEjectRuns, useFlowRuns, type FlowRunSummaryResponse } from "@/features/flows/api";

const PAGE_SIZE = 20;
const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";

const STATUS_LABELS: Record<FlowRunSummaryResponse["status"], string> = {
  waiting: "Ожидает",
  advancing: "В процессе",
  completed: "Завершён",
  exited: "Вышел",
  ejected: "Удалён",
};

function isActive(run: FlowRunSummaryResponse): boolean {
  return run.status === "waiting" || run.status === "advancing";
}

function contactLabel(run: FlowRunSummaryResponse): string {
  const name = [run.contactFirstName, run.contactLastName].filter(Boolean).join(" ");
  return name || run.contactEmail || run.contactId;
}

/**
 * D-21/FLOW-07: runs list for a flow — per-row + bulk «Удалить из цепочки»
 * (eject, Owner/Admin-only per D-23), an «на старой версии» flag (FLOW-07
 * immutability made visible), and the D-21 empty-state copy.
 */
export function FlowRunsTable({ slug, flowId, canManage }: { slug: string; flowId: string; canManage: boolean }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runPendingEject, setRunPendingEject] = useState<FlowRunSummaryResponse | null>(null);
  const [bulkEjectOpen, setBulkEjectOpen] = useState(false);

  const runsQuery = useFlowRuns(slug, flowId, { page, pageSize: PAGE_SIZE });
  const ejectMutation = useEjectRuns(slug, flowId);

  const items = runsQuery.data?.items ?? [];
  const total = runsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function toggleSelected(runId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(runId);
      else next.delete(runId);
      return next;
    });
  }

  function ejectOne(run: FlowRunSummaryResponse) {
    ejectMutation.mutate(
      { runIds: [run.id] },
      {
        onSuccess: () => {
          toast.success("Контакт удалён из цепочки");
          setRunPendingEject(null);
        },
        onError: () => toast.error(GENERIC_ERROR),
      }
    );
  }

  function ejectBulk() {
    ejectMutation.mutate(
      { runIds: Array.from(selected) },
      {
        onSuccess: () => {
          toast.success("Контакты удалены из цепочки");
          setSelected(new Set());
          setBulkEjectOpen(false);
        },
        onError: () => toast.error(GENERIC_ERROR),
      }
    );
  }

  if (runsQuery.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">В цепочке пока нет контактов. Опубликуйте её, чтобы начать приём.</p>
    );
  }

  return (
    <div className="space-y-4">
      {canManage && selected.size > 0 ? (
        <div className="flex items-center justify-between rounded-md border bg-secondary/40 p-3">
          <p className="text-sm">Выбрано: {selected.size}</p>
          <Button type="button" variant="destructive" size="sm" onClick={() => setBulkEjectOpen(true)}>
            Удалить из цепочки
          </Button>
        </div>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            {canManage ? <TableHead className="w-10" /> : null}
            <TableHead>Контакт</TableHead>
            <TableHead>Статус</TableHead>
            <TableHead>Вошёл</TableHead>
            <TableHead />
            <TableHead className="text-right" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((run) => (
            <TableRow key={run.id} className="h-12">
              {canManage ? (
                <TableCell>
                  {isActive(run) ? (
                    <Checkbox
                      checked={selected.has(run.id)}
                      onCheckedChange={(checked) => toggleSelected(run.id, Boolean(checked))}
                      aria-label="Выбрать контакт"
                    />
                  ) : null}
                </TableCell>
              ) : null}
              <TableCell>{contactLabel(run)}</TableCell>
              <TableCell>{STATUS_LABELS[run.status]}</TableCell>
              <TableCell>{new Date(run.enteredAt).toLocaleString("ru-RU")}</TableCell>
              <TableCell>
                {run.onOldVersion ? (
                  <Badge variant="outline" className="border-transparent bg-neutral-100 text-neutral-500">
                    на старой версии
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className="text-right">
                {canManage && isActive(run) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setRunPendingEject(run)}
                  >
                    Удалить из цепочки
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {totalPages > 1 ? (
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

      {runPendingEject ? (
        <AlertDialog open={Boolean(runPendingEject)} onOpenChange={(open) => !open && setRunPendingEject(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Удалить {contactLabel(runPendingEject)} из цепочки?</AlertDialogTitle>
              <AlertDialogDescription>
                Контакт перестанет получать письма и не сможет вернуться в этот запуск. Он может войти заново, если
                сработает триггер.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Отмена</AlertDialogCancel>
              <AlertDialogAction
                disabled={ejectMutation.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={(e) => {
                  e.preventDefault();
                  ejectOne(runPendingEject);
                }}
              >
                {ejectMutation.isPending ? "Удаляем…" : "Удалить из цепочки"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

      <AlertDialog open={bulkEjectOpen} onOpenChange={setBulkEjectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить {selected.size} контактов из цепочки?</AlertDialogTitle>
            <AlertDialogDescription>
              Контакты перестанут получать письма и не смогут вернуться в этот запуск. Они могут войти заново, если
              сработает триггер.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              disabled={ejectMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                ejectBulk();
              }}
            >
              {ejectMutation.isPending ? "Удаляем…" : "Удалить из цепочки"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default FlowRunsTable;
