import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ChevronDown, ChevronRight, Mail, ArrowRightLeft, LogIn } from "lucide-react";

import { apiGet } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });

/** «3 минуты назад» -- Intl.RelativeTimeFormat("ru") owns Russian pluralization, no hand-rolled plural rules needed. */
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

/** D-10: the unified timeline's 4 kinds, unioned server-side (07-02, timeline.repository.ts). */
type TimelineKind = "event" | "send" | "status_change" | "flow_entry_exit";

interface TimelineRow {
  kind: TimelineKind;
  occurredAt: string;
  label: string;
  detail: Record<string, unknown>;
}

/** D-10: the record-type filter's 4 values -- «Статусы» buckets BOTH status_change and flow_entry_exit rows (matches the API's KINDS_BY_TYPE_FILTER). */
type TimelineTypeFilter = "all" | "events" | "emails" | "statuses";

const TIMELINE_TYPE_OPTIONS: Array<{ value: TimelineTypeFilter; label: string }> = [
  { value: "all", label: "Всё" },
  { value: "events", label: "События" },
  { value: "emails", label: "Письма" },
  { value: "statuses", label: "Статусы" },
];

/** Send-log status column palette (07-UI-SPEC.md § Color): one collapsed current status per message, 3-hue vocabulary reused from SubscriptionStatusBadge's precedent. */
const SEND_STATUS_LABELS: Record<string, string> = {
  sent: "Отправлено",
  delivered: "Доставлено",
  opened: "Открыто",
  clicked: "Клик",
  bounced: "Не доставлено",
  dropped: "Не доставлено",
  spam: "Не доставлено",
  unsubscribed: "Отписался",
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
  unsubscribed: "border-transparent bg-neutral-100 text-neutral-500",
  failed: "border-transparent bg-red-50 text-destructive",
  excluded: "border-transparent bg-neutral-100 text-neutral-500",
};

/** Human-readable label for a subscription_status_history `source` value. */
const STATUS_SOURCE_LABELS: Record<string, string> = {
  manual_ui: "вручную",
  webhook_suppression: "автоматически (bounce/жалоба)",
  webhook_unsubscribe: "отписка из письма",
  unsubscribe_route: "отписка по ссылке",
  csv_or_api_upsert: "импорт/API",
};

function SendStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={SEND_STATUS_CLASSES[status] ?? "border-transparent bg-neutral-100 text-neutral-500"}>
      {SEND_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

/** Shared row shell: icon + content + relative timestamp, matching the original EventRow's layout. */
function TimelineRowShell({
  icon,
  children,
  occurredAt,
  expandable,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  occurredAt: string;
  expandable?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  if (!expandable) {
    return (
      <div className="flex w-full items-center gap-3 rounded-md border p-3">
        {icon}
        <span className="flex-1 truncate text-sm font-semibold">{children}</span>
        <span className="shrink-0 text-sm text-muted-foreground">{relativeTime(occurredAt)}</span>
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-md border">
        <CollapsibleTrigger asChild>
          <button type="button" className="flex w-full items-center gap-3 p-3 text-left hover:bg-accent">
            {icon}
            <span className="flex-1 truncate text-sm font-semibold">{children}</span>
            <span className="shrink-0 text-sm text-muted-foreground">{relativeTime(occurredAt)}</span>
            {open ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>{expandable}</CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/** kind='event' row -- unchanged from the original ContactEventFeed: name + expandable pretty-printed JSON. */
function EventRow({ row }: { row: TimelineRow }) {
  const properties = row.detail.properties ?? {};
  return (
    <TimelineRowShell
      icon={<Activity className="h-4 w-4 shrink-0 text-muted-foreground" />}
      occurredAt={row.occurredAt}
      expandable={
        <pre className="overflow-x-auto border-t bg-muted/30 p-3 font-mono text-sm">
          {JSON.stringify(properties, null, 2)}
        </pre>
      }
    >
      {row.label}
    </TimelineRowShell>
  );
}

/** kind='send' row -- current status badge (D-06 priority chain, computed server-side), «×N» repeat opens/clicks (D-11), and the bounce/drop/exclusion reason when present. */
function SendRow({ row }: { row: TimelineRow }) {
  const status = String(row.detail.status ?? "sent");
  const openCount = Number(row.detail.openCount ?? 0);
  const clickCount = Number(row.detail.clickCount ?? 0);
  const reason = row.detail.reason as string | null | undefined;

  return (
    <div className="flex w-full items-center gap-3 rounded-md border p-3">
      <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{row.label}</span>
          <SendStatusBadge status={status} />
          {openCount > 1 && <span className="text-sm text-muted-foreground">открыто ×{openCount}</span>}
          {clickCount > 1 && <span className="text-sm text-muted-foreground">клики ×{clickCount}</span>}
        </div>
        {reason && <span className="text-sm text-muted-foreground">Причина: {reason}</span>}
      </div>
      <span className="shrink-0 text-sm text-muted-foreground">{relativeTime(row.occurredAt)}</span>
    </div>
  );
}

/** kind='status_change' row -- «{old} → {new}» plus source/reason. */
function StatusChangeRow({ row }: { row: TimelineRow }) {
  const oldStatus = (row.detail.oldStatus as string | null) ?? "—";
  const newStatus = row.detail.newStatus as string;
  const source = row.detail.source as string;
  const reason = row.detail.reason as string | null | undefined;

  return (
    <div className="flex w-full items-center gap-3 rounded-md border p-3">
      <ArrowRightLeft className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-1 flex-col gap-1">
        <span className="text-sm font-semibold">
          {oldStatus} → {newStatus}
        </span>
        <span className="text-sm text-muted-foreground">
          {STATUS_SOURCE_LABELS[source] ?? source}
          {reason ? ` · ${reason}` : ""}
        </span>
      </div>
      <span className="shrink-0 text-sm text-muted-foreground">{relativeTime(row.occurredAt)}</span>
    </div>
  );
}

/** kind='flow_entry_exit' row -- entry (and exit + reason, when the run has already exited). */
function FlowEntryExitRow({ row }: { row: TimelineRow }) {
  const exitedAt = row.detail.exitedAt as string | null;
  const exitReason = row.detail.exitReason as string | null | undefined;

  return (
    <div className="flex w-full items-center gap-3 rounded-md border p-3">
      <LogIn className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-1 flex-col gap-1">
        <span className="text-sm font-semibold">{row.label}</span>
        {exitedAt && (
          <span className="text-sm text-muted-foreground">
            Вышел {relativeTime(exitedAt)}
            {exitReason ? ` · ${exitReason}` : ""}
          </span>
        )}
      </div>
      <span className="shrink-0 text-sm text-muted-foreground">{relativeTime(row.occurredAt)}</span>
    </div>
  );
}

function TimelineRowView({ row }: { row: TimelineRow }) {
  switch (row.kind) {
    case "event":
      return <EventRow row={row} />;
    case "send":
      return <SendRow row={row} />;
    case "status_change":
      return <StatusChangeRow row={row} />;
    case "flow_entry_exit":
      return <FlowEntryExitRow row={row} />;
    default:
      return null;
  }
}

/**
 * Contact-card unified activity timeline (D-10/D-11/D-12, ANLT-03, 07-02):
 * reads the analytics timeline endpoint (a UNION ALL over events, sends,
 * subscription-status changes, and flow entries/exits) and renders each row
 * by kind, with a single record-type filter narrowing the result in-place --
 * no separate tabs. Evolved from the events-only feed added in 02-08.
 */
export function ContactEventFeed({ slug, contactId }: { slug: string; contactId: string }) {
  const [typeFilter, setTypeFilter] = useState<TimelineTypeFilter>("all");

  const timelineQuery = useQuery({
    queryKey: ["workspace", slug, "contacts", contactId, "timeline", typeFilter],
    queryFn: () =>
      apiGet<TimelineRow[]>(`/api/workspaces/${slug}/contacts/${contactId}/timeline?type=${typeFilter}`),
    enabled: Boolean(slug) && Boolean(contactId),
  });

  const filterControl = (
    <Select value={typeFilter} onValueChange={(value) => setTypeFilter(value as TimelineTypeFilter)}>
      <SelectTrigger className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TIMELINE_TYPE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  if (timelineQuery.isLoading) {
    return (
      <div className="space-y-2">
        <div className="flex justify-end">{filterControl}</div>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  const rows = timelineQuery.data ?? [];

  if (rows.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex justify-end">{filterControl}</div>
        <Card>
          <CardHeader>
            <CardTitle>Активности пока нет</CardTitle>
            <CardDescription>
              Здесь появятся события, отправленные письма, открытия, клики и смены статуса подписки, как только они
              произойдут.
              {typeFilter === "events" && (
                <>
                  {" "}
                  См.{" "}
                  <a href={`/w/${slug}/settings/api-keys`} className="text-primary underline underline-offset-4">
                    документацию по API-ключам
                  </a>
                  .
                </>
              )}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-end">{filterControl}</div>
      {rows.map((row, index) => (
        <TimelineRowView key={`${row.kind}-${index}-${row.occurredAt}`} row={row} />
      ))}
    </div>
  );
}

export default ContactEventFeed;
