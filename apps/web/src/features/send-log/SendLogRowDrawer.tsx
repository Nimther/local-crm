import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Mail, MousePointerClick, Send, ShieldAlert } from "lucide-react";

import { QueryErrorState } from "@/components/QueryErrorState";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchSendLogEvents, type SendLogItem } from "./api";

const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });

/** «3 минуты назад» -- reuse of ContactEventFeed.tsx's relativeTime helper verbatim (07-UI-SPEC). */
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

const EVENT_TYPE_LABELS: Record<string, string> = {
  processed: "В обработке",
  delivered: "Доставлено",
  open: "Открыто",
  click: "Клик",
  bounce: "Bounce",
  dropped: "Отклонено",
  deferred: "Отложено",
  spamreport: "Жалоба на спам",
  unsubscribe: "Отписка",
};

function eventIcon(eventType: string) {
  if (eventType === "click") return <MousePointerClick className="h-4 w-4 shrink-0 text-muted-foreground" />;
  if (eventType === "bounce" || eventType === "dropped" || eventType === "spamreport") {
    return <ShieldAlert className="h-4 w-4 shrink-0 text-destructive" />;
  }
  if (eventType === "delivered") return <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />;
  return <Send className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

interface SendLogRowDrawerProps {
  slug: string;
  sendId: string | null;
  row: SendLogItem | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * D-14: the send-log row drawer -- full per-message chronology from
 * send_events (sent -> delivered -> opened ×N -> clicks by URL), the
 * bounce/drop/exclusion reason when present, and links to the contact/
 * campaign/flow. Built on shadcn `sheet` (this phase's one new component).
 */
export function SendLogRowDrawer({ slug, sendId, row, onOpenChange }: SendLogRowDrawerProps) {
  const eventsQuery = useQuery({
    queryKey: ["workspace", slug, "send-log", sendId, "events"],
    queryFn: () => fetchSendLogEvents(slug, sendId as string),
    enabled: Boolean(slug) && Boolean(sendId),
  });

  const reason = row?.bounceReason ?? row?.dropReason ?? row?.exclusionReason ?? null;

  return (
    <Sheet open={Boolean(sendId)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Письмо</SheetTitle>
          <SheetDescription>
            {row ? `${row.contactEmail ?? row.contactId} · ${row.campaignName ?? row.flowName ?? "—"}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          {row && (
            <Link to={`/w/${slug}/contacts/${row.contactId}`} className="text-primary underline underline-offset-4">
              Контакт
            </Link>
          )}
          {row?.campaignId && (
            <Link to={`/w/${slug}/campaigns/${row.campaignId}`} className="text-primary underline underline-offset-4">
              Кампания
            </Link>
          )}
          {row?.flowId && (
            <Link to={`/w/${slug}/flows/${row.flowId}`} className="text-primary underline underline-offset-4">
              Цепочка
            </Link>
          )}
        </div>

        {reason && (
          <>
            <Separator className="my-4" />
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">Причина</h3>
              <p className="text-sm text-muted-foreground">{reason}</p>
            </div>
          </>
        )}

        <Separator className="my-4" />
        <h3 className="mb-2 text-sm font-semibold">Хронология письма</h3>

        {eventsQuery.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : eventsQuery.isError && !eventsQuery.data ? (
          // Contained to the drawer -- the table behind it keeps rendering
          // regardless of this drawer's own fetch state (T-15-14).
          <QueryErrorState
            title="Не удалось загрузить хронологию письма"
            isFetching={eventsQuery.isFetching}
            onRetry={() => void eventsQuery.refetch()}
          />
        ) : (
          <>
            {eventsQuery.isError && eventsQuery.data ? (
              <QueryErrorState
                title="Не удалось обновить хронологию письма"
                isFetching={eventsQuery.isFetching}
                onRetry={() => void eventsQuery.refetch()}
              />
            ) : null}
            {(eventsQuery.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Событий по этому письму пока нет.</p>
            ) : (
              <div className="space-y-2">
                {(eventsQuery.data ?? []).map((event) => (
                  <div key={event.id} className="flex items-start gap-3 rounded-md border p-3">
                    {eventIcon(event.eventType)}
                    <div className="flex-1 space-y-1">
                      <p className="text-sm font-medium">{EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}</p>
                      {event.clickUrl && (
                        <p className="break-all text-sm text-muted-foreground">{event.clickUrl}</p>
                      )}
                      {event.reason && <p className="text-sm text-muted-foreground">{event.reason}</p>}
                    </div>
                    <span className="shrink-0 text-sm text-muted-foreground">{relativeTime(event.occurredAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default SendLogRowDrawer;
