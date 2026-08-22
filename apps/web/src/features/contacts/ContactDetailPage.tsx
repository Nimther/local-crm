import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Download } from "lucide-react";

import type { ContactResponse, DsrExportDocument, PropertyRegistryItem, WorkspaceResponse } from "@mega-crm/shared-schemas";
import { apiDelete, apiGet, apiPatch, ApiError } from "@/lib/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState } from "@/components/QueryErrorState";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ContactEventFeed } from "@/features/contacts/ContactEventFeed";
import { ContactForm } from "@/features/contacts/ContactForm";
import { CustomPropertyEditor } from "@/features/contacts/CustomPropertyEditor";
import { SubscriptionStatusBadge } from "@/features/contacts/SubscriptionStatusBadge";

const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";

/** D-13 backstop copy -- the same fixed string a later plan's disabled-erased-button state (D-14) will use. */
const EXPORT_ERASED_MESSAGE = "Контакт обезличен — персональные данные удалены";

/** Derives the export action's inline error copy from a mutation's `error` field -- `null` when there is nothing to show. */
function computeExportErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof ApiError && error.status === 410) return EXPORT_ERASED_MESSAGE;
  return GENERIC_ERROR;
}

/**
 * D-01/D-04/D-08/D-09/D-12: the Export action on the contact card.
 * Owner/Admin only -- gated by a conditional render (`canExport ? ... :
 * null`), never a disabled state, because SC3 requires a Member to not see
 * the action at all (stricter than the campaign-actions disabled+tooltip
 * pattern used elsewhere). Reuses `apiGet` (already parses JSON and throws
 * a typed `ApiError` on non-2xx) rather than a raw `fetch`/blob bypass --
 * the 403/404/410 typed-error handling comes "for free" that way.
 */
export function ExportContactButton({
  slug,
  contact,
  viewerRole,
}: {
  slug: string;
  contact: ContactResponse;
  viewerRole: string;
}) {
  const canExport = viewerRole === "owner" || viewerRole === "admin";

  const exportMutation = useMutation({
    mutationFn: () => apiGet<DsrExportDocument>(`/api/workspaces/${slug}/contacts/${contact.id}/dsr-export`),
    onSuccess: (doc) => {
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // D-08: ids and today's date only, never contact PII -- the date is
      // the moment of download, not `doc.metadata.generatedAt`.
      a.download = `dsr-export-${contact.id}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Файл с данными контакта скачан");
    },
  });

  const serverError = computeExportErrorMessage(exportMutation.error);

  return canExport ? (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" disabled={exportMutation.isPending} onClick={() => exportMutation.mutate()}>
        <Download className="mr-2 h-4 w-4" />
        {exportMutation.isPending ? "Скачиваем…" : "Скачать данные контакта"}
      </Button>
      {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
    </div>
  ) : null;
}

/** D-08: exact compliance copy for the destructive delete confirmation. */
function DeleteContactDialog({ slug, contact }: { slug: string; contact: ContactResponse }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () => apiDelete(`/api/workspaces/${slug}/contacts/${contact.id}`),
    onSuccess: async () => {
      toast.success("Контакт удалён");
      await queryClient.invalidateQueries({ queryKey: ["workspace", slug, "contacts"] });
      void navigate(`/w/${slug}/contacts`, { replace: true });
    },
    onError: () => {
      setServerError(GENERIC_ERROR);
    },
  });

  const label = contact.email ?? contact.externalId ?? "без имени";

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" className="border-destructive text-destructive hover:bg-destructive/10">
          Удалить контакт
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить контакт «{label}»?</AlertDialogTitle>
          <AlertDialogDescription>
            Контакт и все его события будут удалены безвозвратно. Если контакт был отписан или в списке подавления,
            письма ему не будут отправляться повторно даже после нового импорта.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            disabled={deleteMutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(e) => {
              e.preventDefault();
              deleteMutation.mutate();
            }}
          >
            {deleteMutation.isPending ? "Удаляем…" : "Удалить контакт"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Свойства tab: same CustomPropertyEditor as the create dialog, with its own save action (PATCH properties only). */
function PropertiesTab({ slug, contact }: { slug: string; contact: ContactResponse }) {
  const queryClient = useQueryClient();
  const [properties, setProperties] = useState<Record<string, unknown>>(contact.properties);
  const [serverError, setServerError] = useState<string | null>(null);

  const registryQuery = useQuery({
    queryKey: ["workspace", slug, "property-registry"],
    queryFn: () => apiGet<PropertyRegistryItem[]>(`/api/workspaces/${slug}/property-registry`),
    enabled: Boolean(slug),
  });

  const saveMutation = useMutation({
    mutationFn: () => apiPatch<ContactResponse>(`/api/workspaces/${slug}/contacts/${contact.id}`, { properties }),
    onSuccess: async () => {
      setServerError(null);
      toast.success("Контакт обновлён");
      await queryClient.invalidateQueries({ queryKey: ["workspace", slug, "contacts", contact.id] });
    },
    onError: () => {
      setServerError(GENERIC_ERROR);
    },
  });

  if (registryQuery.isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (registryQuery.isError) {
    return (
      <QueryErrorState
        title="Не удалось загрузить список свойств"
        isFetching={registryQuery.isFetching}
        onRetry={() => void registryQuery.refetch()}
      />
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <CustomPropertyEditor properties={properties} registry={registryQuery.data ?? []} onChange={setProperties} />
        {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
        <Button type="button" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? "Сохраняем…" : "Сохранить изменения"}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Contact detail (CONT-01/CONT-05/SUBS-01): tabbed Overview (edit form,
 * no properties) / Свойства (CustomPropertyEditor) / События (D-14 live
 * feed, ContactEventFeed) + delete confirmation (D-08).
 */
export function ContactDetailPage() {
  const { slug = "", id = "" } = useParams<{ slug: string; id: string }>();

  // D-01/D-04: the page previously fetched no workspace query at all --
  // owned HERE, above every early return, so hook order stays stable
  // across renders (same CampaignDetailPage.tsx/TeamPage.tsx precedent).
  const workspaceQuery = useQuery({
    queryKey: ["workspace", slug],
    queryFn: () => apiGet<WorkspaceResponse>(`/api/workspaces/${slug}`),
    enabled: Boolean(slug),
  });
  const viewerRole = workspaceQuery.data?.role ?? "member";
  const canExport = viewerRole === "owner" || viewerRole === "admin";

  const contactQuery = useQuery({
    queryKey: ["workspace", slug, "contacts", id],
    queryFn: () => apiGet<ContactResponse>(`/api/workspaces/${slug}/contacts/${id}`),
    enabled: Boolean(slug) && Boolean(id),
  });

  if (contactQuery.isLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  // Split the two states a single `if (!contact)` used to conflate: a
  // failed fetch (isError, Retry-able) is not the same fact as a successful
  // fetch that legitimately found nothing (not-found, no Retry control).
  if (contactQuery.isError) {
    return (
      <div className="p-8">
        <QueryErrorState
          title="Не удалось загрузить контакт"
          isFetching={contactQuery.isFetching}
          onRetry={() => void contactQuery.refetch()}
        />
      </div>
    );
  }

  const contact = contactQuery.data;
  if (!contact) {
    return (
      <div className="p-8">
        <EmptyState title="Контакт не найден" />
      </div>
    );
  }

  const title = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email || contact.externalId || "Контакт";

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-display font-semibold">{title}</h1>
          <SubscriptionStatusBadge status={contact.subscriptionStatus} />
        </div>
        <div className="flex items-center gap-2">
          {/* D-01/DSR-04/SC3: non-destructive action left of the destructive Delete button. */}
          {canExport ? <ExportContactButton slug={slug} contact={contact} viewerRole={viewerRole} /> : null}
          <DeleteContactDialog slug={slug} contact={contact} />
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="properties">Свойства</TabsTrigger>
          <TabsTrigger value="events">События</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Card>
            <CardContent className="p-6">
              <ContactForm slug={slug} contact={contact} showProperties={false} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="properties">
          <PropertiesTab slug={slug} contact={contact} />
        </TabsContent>
        <TabsContent value="events">
          <ContactEventFeed slug={slug} contactId={contact.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default ContactDetailPage;
