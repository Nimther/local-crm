import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { X } from "lucide-react";
import { z } from "zod";

import {
  type ContactResponse,
  type CreateContactInput,
  type PropertyRegistryItem,
  type UpdateContactInput,
} from "@mega-crm/shared-schemas";
import { ApiError, apiGet, apiPatch, apiPost } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { CustomPropertyEditor } from "@/features/contacts/CustomPropertyEditor";

const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";
const EMAIL_TAKEN_ERROR = "Этот email уже используется другим контактом. Укажите другой адрес или найдите существующий контакт.";
const SUPPRESSED_TOOLTIP =
  "Статус «в списке подавления» нельзя снять вручную — так мы защищаем репутацию отправки. Это происходит только автоматически.";

/**
 * D-07: known server error codes map to the exact UI-SPEC copy; anything
 * else falls back to the raw server message (still meaningful, e.g. Zod
 * flatten output stringified) or the generic fallback.
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown; code?: unknown } | undefined;
    if (body?.code === "email_taken") return EMAIL_TAKEN_ERROR;
    if (typeof body?.error === "string") return body.error;
  }
  return GENERIC_ERROR;
}

/** Tag input: removable Badge chips + a commit-on-comma/Enter input (D: no new component, reuse badge+input). */
function TagInput({ tags, onChange }: { tags: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");

  function commit() {
    const value = draft.trim();
    if (!value) return;
    if (!tags.includes(value)) onChange([...tags, value]);
    setDraft("");
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-input p-2">
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1">
          {tag}
          <button type="button" onClick={() => onChange(tags.filter((t) => t !== tag))} aria-label={`Удалить тег ${tag}`}>
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
        placeholder="Добавить тег…"
        className="min-w-[100px] flex-1 border-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

/**
 * D-12: subscribed<->unsubscribed toggle only. A suppressed contact renders
 * as a disabled, non-actionable control with the exact D-12 tooltip copy --
 * never a control that could appear to allow un-suppressing from the UI.
 */
function SubscriptionControl({
  value,
  onChange,
  suppressed,
}: {
  value: "subscribed" | "unsubscribed";
  onChange: (next: "subscribed" | "unsubscribed") => void;
  suppressed: boolean;
}) {
  if (suppressed) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="inline-flex w-fit items-center gap-2 rounded-md border border-dashed border-destructive/40 px-3 py-2">
              <RadioGroup value="suppressed" disabled>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="suppressed" id="subscription-suppressed" disabled />
                </div>
              </RadioGroup>
              <Label htmlFor="subscription-suppressed" className="text-destructive">
                В списке подавления
              </Label>
            </div>
          </TooltipTrigger>
          <TooltipContent>{SUPPRESSED_TOOLTIP}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <RadioGroup value={value} onValueChange={(next) => onChange(next as "subscribed" | "unsubscribed")} className="flex gap-6">
      <div className="flex items-center gap-2">
        <RadioGroupItem value="subscribed" id="subscription-subscribed" />
        <Label htmlFor="subscription-subscribed">Подписан</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="unsubscribed" id="subscription-unsubscribed" />
        <Label htmlFor="subscription-unsubscribed">Отписан</Label>
      </div>
    </RadioGroup>
  );
}

interface ContactFormProps {
  slug: string;
  /** Present -> edit mode (PATCH); absent -> create mode (POST). */
  contact?: ContactResponse;
  /** Overview tab (edit mode) hides properties -- the Свойства tab owns that surface. Create dialog always shows it. */
  showProperties?: boolean;
  onSuccess?: (contact: ContactResponse) => void;
}

/**
 * RHF-local validation schema for the plain-text fields only -- tags,
 * properties and subscriptionStatus are managed as separate component state
 * (see below) and merged into the wire payload on submit, which is what
 * actually gets validated against createContactSchema/updateContactSchema
 * server-side (packages/shared-schemas/src/contact.ts). A resolver bound
 * directly to those wire schemas doesn't work for controlled text inputs:
 * RHF needs a defined "" default for every controlled field, but "" fails
 * the wire schemas' .email()/.min() checks meant for "field omitted" --
 * this local schema mirrors the same D-02 "at least one identifier" rule
 * without that conflict.
 */
const contactFormFieldsSchema = z
  .object({
    email: z.union([z.string().trim().toLowerCase().email("Введите корректный email"), z.literal("")]),
    externalId: z.string().trim().max(255),
    firstName: z.string().trim().max(255),
    lastName: z.string().trim().max(255),
    phone: z.string().trim().max(50),
    city: z.string().trim().max(255),
    country: z.string().trim().max(255),
  })
  .refine((v) => Boolean(v.email.trim() || v.externalId.trim()), {
    message: "Укажите email или external_id",
    path: ["email"],
  });

type FormValues = z.infer<typeof contactFormFieldsSchema>;

function toDefaultValues(contact?: ContactResponse): FormValues {
  return {
    email: contact?.email ?? "",
    externalId: contact?.externalId ?? "",
    firstName: contact?.firstName ?? "",
    lastName: contact?.lastName ?? "",
    phone: contact?.phone ?? "",
    city: contact?.city ?? "",
    country: contact?.country ?? "",
  };
}

/** Strips empty-string optional fields so they don't fail email()/min() refinements meant for "unset". */
function cleanPayload(values: FormValues): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (values.email.trim()) payload.email = values.email.trim();
  if (values.externalId.trim()) payload.externalId = values.externalId.trim();
  if (values.firstName.trim()) payload.firstName = values.firstName.trim();
  if (values.lastName.trim()) payload.lastName = values.lastName.trim();
  if (values.phone.trim()) payload.phone = values.phone.trim();
  if (values.city.trim()) payload.city = values.city.trim();
  if (values.country.trim()) payload.country = values.country.trim();
  return payload;
}

/**
 * Contact create/edit form (CONT-01/CONT-05): RHF + Zod fields, tag chips,
 * subscription control (D-12) and, when showProperties, the custom-property
 * editor (D-10/D-19). Reused by CreateContactDialog (create) and
 * ContactDetailPage's Overview tab (edit, showProperties=false).
 */
export function ContactForm({ slug, contact, showProperties = true, onSuccess }: ContactFormProps) {
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>(contact?.tags ?? []);
  const [properties, setProperties] = useState<Record<string, unknown>>(contact?.properties ?? {});
  const [subscriptionStatus, setSubscriptionStatus] = useState<"subscribed" | "unsubscribed">(
    contact?.subscriptionStatus === "unsubscribed" ? "unsubscribed" : "subscribed"
  );

  const registryQuery = useQuery({
    queryKey: ["workspace", slug, "property-registry"],
    queryFn: () => apiGet<PropertyRegistryItem[]>(`/api/workspaces/${slug}/property-registry`),
    enabled: Boolean(slug) && showProperties,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(contactFormFieldsSchema),
    defaultValues: toDefaultValues(contact),
  });

  function invalidateContacts() {
    return queryClient.invalidateQueries({ queryKey: ["workspace", slug, "contacts"] });
  }

  const mutation = useMutation({
    mutationFn: (payload: CreateContactInput | UpdateContactInput) =>
      contact
        ? apiPatch<ContactResponse>(`/api/workspaces/${slug}/contacts/${contact.id}`, payload)
        : apiPost<ContactResponse>(`/api/workspaces/${slug}/contacts`, payload),
    onSuccess: (data) => {
      setServerError(null);
      void invalidateContacts();
      toast.success(contact ? "Контакт обновлён" : "Контакт создан");
      onSuccess?.(data);
    },
    onError: (error: unknown) => {
      setServerError(extractErrorMessage(error));
    },
  });

  async function onSubmit(values: FormValues) {
    const basePayload = cleanPayload(values);
    const payload = {
      ...basePayload,
      tags,
      subscriptionStatus: contact?.subscriptionStatus === "suppressed" ? undefined : subscriptionStatus,
      ...(showProperties ? { properties } : {}),
    };
    await mutation.mutateAsync(payload as CreateContactInput | UpdateContactInput);
  }

  const externalIdLocked = Boolean(contact?.externalId);

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input type="email" autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="externalId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>external_id</FormLabel>
                <FormControl>
                  <Input autoComplete="off" readOnly={externalIdLocked} disabled={externalIdLocked} {...field} />
                </FormControl>
                {externalIdLocked ? (
                  <p className="text-sm text-muted-foreground">
                    external_id нельзя изменить после установки — это постоянный идентификатор контакта.
                  </p>
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="firstName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Имя</FormLabel>
                <FormControl>
                  <Input autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="lastName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Фамилия</FormLabel>
                <FormControl>
                  <Input autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Телефон</FormLabel>
                <FormControl>
                  <Input autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="city"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Город</FormLabel>
                <FormControl>
                  <Input autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="country"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Страна</FormLabel>
                <FormControl>
                  <Input autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="space-y-2">
          <Label>Теги</Label>
          <TagInput tags={tags} onChange={setTags} />
        </div>

        <div className="space-y-2">
          <Label>Статус подписки</Label>
          <SubscriptionControl
            value={subscriptionStatus}
            onChange={setSubscriptionStatus}
            suppressed={contact?.subscriptionStatus === "suppressed"}
          />
        </div>

        {showProperties ? (
          <div className="space-y-2">
            <Label>Свойства</Label>
            <CustomPropertyEditor
              properties={properties}
              registry={registryQuery.data ?? []}
              onChange={setProperties}
            />
          </div>
        ) : null}

        {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}

        <Button type="submit" disabled={form.formState.isSubmitting || mutation.isPending}>
          {mutation.isPending ? "Сохраняем…" : contact ? "Сохранить изменения" : "Создать контакт"}
        </Button>
      </form>
    </Form>
  );
}

/** Create-contact dialog (CONT-01): primary CTA on the contact list, closes and resets on success. */
export function CreateContactDialog({ slug }: { slug: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Добавить контакт</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Создать контакт</DialogTitle>
          <DialogDescription>Укажите email и/или external_id — хотя бы одно поле обязательно.</DialogDescription>
        </DialogHeader>
        <ContactForm
          slug={slug}
          onSuccess={(created) => {
            setOpen(false);
            navigate(`/w/${slug}/contacts/${created.id}`);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

export default ContactForm;
