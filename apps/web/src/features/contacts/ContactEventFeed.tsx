import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ChevronDown, ChevronRight } from "lucide-react";

import type { ContactEvent } from "@mega-crm/shared-schemas";
import { apiGet } from "@/lib/api";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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

/** D-14 row: Activity icon + event name (14px/600) + relative timestamp (muted) + chevron expanding to pretty-printed JSON. */
function EventRow({ event }: { event: ContactEvent }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-md border">
        <CollapsibleTrigger asChild>
          <button type="button" className="flex w-full items-center gap-3 p-3 text-left hover:bg-accent">
            <Activity className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate text-sm font-semibold">{event.name}</span>
            <span className="shrink-0 text-sm text-muted-foreground">{relativeTime(event.occurredAt)}</span>
            {open ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="overflow-x-auto border-t bg-muted/30 p-3 font-mono text-sm">
            {JSON.stringify(event.properties, null, 2)}
          </pre>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/**
 * Contact-card live event feed (D-14/EVNT-01, 02-08): reads the
 * workspace-scoped contact-events route and renders each event as an
 * expandable Collapsible row -- the first visible confirmation that "events
 * are arriving" for integration debugging, and the seed of the Phase 7 full
 * timeline.
 */
export function ContactEventFeed({ slug, contactId }: { slug: string; contactId: string }) {
  const eventsQuery = useQuery({
    queryKey: ["workspace", slug, "contacts", contactId, "events"],
    queryFn: () => apiGet<ContactEvent[]>(`/api/workspaces/${slug}/contacts/${contactId}/events`),
    enabled: Boolean(slug) && Boolean(contactId),
  });

  if (eventsQuery.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  const events = eventsQuery.data ?? [];

  if (events.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Событий пока нет</CardTitle>
          <CardDescription>
            Как только ваш бэкенд отправит первое событие через Event API, оно появится здесь. См.{" "}
            <a href={`/w/${slug}/settings/api-keys`} className="text-primary underline underline-offset-4">
              документацию по API-ключам
            </a>
            .
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {events.map((event) => (
        <EventRow key={event.id} event={event} />
      ))}
    </div>
  );
}

export default ContactEventFeed;
