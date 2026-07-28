import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import type { ContactResponse, PropertyRegistryItem } from "@mega-crm/shared-schemas";
import { apiDelete, apiGet, apiPatch } from "@/lib/api";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ContactEventFeed } from "@/features/contacts/ContactEventFeed";
import { ContactForm } from "@/features/contacts/ContactForm";
import { CustomPropertyEditor } from "@/features/contacts/CustomPropertyEditor";
import { SubscriptionStatusBadge } from "@/features/contacts/SubscriptionStatusBadge";

const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";

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

  const contact = contactQuery.data;
  if (!contact) {
    return (
      <div className="p-8">
        <Card>
          <CardHeader>
            <CardTitle>Контакт не найден</CardTitle>
          </CardHeader>
        </Card>
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
        <DeleteContactDialog slug={slug} contact={contact} />
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
