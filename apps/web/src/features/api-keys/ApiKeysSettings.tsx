import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router";
import { toast } from "sonner";
import { Check, Copy } from "lucide-react";

import {
  createApiKeySchema,
  type ApiKeyCreated,
  type ApiKeyListItem,
  type CreateApiKeyInput,
  type WorkspaceResponse,
} from "@mega-crm/shared-schemas";
import { ApiError, apiGet, apiPost } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { QueryErrorState } from "@/components/QueryErrorState";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";

function extractErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown } | undefined;
    if (typeof body?.error === "string") return body.error;
  }
  return GENERIC_ERROR;
}

/** D-22: status badge -- semantic colors only, mirrors KeyStatusBadge's active/pending/error precedent. */
function ApiKeyStatusBadge({ revoked }: { revoked: boolean }) {
  return revoked ? (
    <Badge variant="outline" className="border-transparent bg-neutral-100 text-neutral-500">
      Отозван
    </Badge>
  ) : (
    <Badge variant="outline" className="border-transparent bg-green-50 text-green-600">
      Активен
    </Badge>
  );
}

/** Owner/Admin-only create dialog, showing the full secret exactly once on success (D-21/D-22). */
function CreateApiKeyDialog({ slug, canManage }: { slug: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<CreateApiKeyInput>({
    resolver: zodResolver(createApiKeySchema),
    defaultValues: { name: "" },
  });

  const createMutation = useMutation({
    mutationFn: (values: CreateApiKeyInput) => apiPost<ApiKeyCreated>(`/api/workspaces/${slug}/api-keys`, values),
    onSuccess: (data) => {
      setCreated(data);
      setServerError(null);
      void queryClient.invalidateQueries({ queryKey: ["workspace", slug, "api-keys"] });
      toast.success("Ключ создан");
    },
    onError: (error: unknown) => {
      setServerError(extractErrorMessage(error));
    },
  });

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setCreated(null);
      setCopied(false);
      setServerError(null);
      form.reset({ name: "" });
    }
  }

  async function onSubmit(values: CreateApiKeyInput) {
    await createMutation.mutateAsync(values);
  }

  async function handleCopy() {
    if (!created) return;
    await navigator.clipboard.writeText(created.fullKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!canManage) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>Создать API-ключ</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{created ? "Ключ создан" : "Создать API-ключ"}</DialogTitle>
          <DialogDescription>
            {created
              ? "Скопируйте ключ сейчас. Мы не покажем его снова."
              : "Ключ даёт вашему бэкенду полный доступ к Event API и Contacts API."}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Input readOnly value={created.fullKey} className="font-mono text-sm" />
              <Button type="button" variant="outline" onClick={() => void handleCopy()}>
                {copied ? (
                  <>
                    <Check className="mr-1 h-4 w-4" />
                    Скопировано
                  </>
                ) : (
                  <>
                    <Copy className="mr-1 h-4 w-4" />
                    Скопировать
                  </>
                )}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Ключ уже активен — если вы не скопируете его сейчас, просто создайте новый.
            </p>
            <DialogFooter>
              <Button type="button" onClick={() => handleOpenChange(false)}>
                Готово
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Название ключа</FormLabel>
                    <FormControl>
                      <Input autoComplete="off" placeholder="prod backend" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
              <DialogFooter>
                <Button type="submit" disabled={form.formState.isSubmitting || createMutation.isPending}>
                  {createMutation.isPending ? "Создаём…" : "Создать ключ"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Owner/Admin-only revoke confirmation, exact D-21 copy. */
function RevokeApiKeyDialog({
  slug,
  keyId,
  keyName,
  open,
  onOpenChange,
}: {
  slug: string;
  keyId: string;
  keyName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const revokeMutation = useMutation({
    mutationFn: () => apiPost(`/api/workspaces/${slug}/api-keys/${keyId}/revoke`, {}),
    onSuccess: () => {
      toast.success("Ключ отозван");
      void queryClient.invalidateQueries({ queryKey: ["workspace", slug, "api-keys"] });
      onOpenChange(false);
    },
    onError: () => {
      toast.error(GENERIC_ERROR);
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Отозвать ключ «{keyName}»?</AlertDialogTitle>
          <AlertDialogDescription>
            Любые запросы к Event API и Contacts API с этим ключом перестанут приниматься немедленно. Это действие
            нельзя отменить.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            disabled={revokeMutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(e) => {
              e.preventDefault();
              revokeMutation.mutate();
            }}
          >
            {revokeMutation.isPending ? "Отзываем…" : "Отозвать ключ"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * API keys settings (CONT-03/EVNT-01, D-21/D-22/D-23): masked key list +
 * status, create dialog with a one-time secret reveal, and a revoke
 * confirmation. Management actions are hidden (not disabled) for non-Owner/
 * Admin roles, mirroring Phase 1's role-gating convention -- the server
 * remains the enforcement layer (requirePermission).
 */
export function ApiKeysSettings() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyListItem | null>(null);

  const workspaceQuery = useQuery({
    queryKey: ["workspace", slug],
    queryFn: () => apiGet<WorkspaceResponse>(`/api/workspaces/${slug}`),
    enabled: Boolean(slug),
  });

  const keysQuery = useQuery({
    queryKey: ["workspace", slug, "api-keys"],
    queryFn: () => apiGet<ApiKeyListItem[]>(`/api/workspaces/${slug}/api-keys`),
    enabled: Boolean(slug),
  });

  if (workspaceQuery.isLoading || keysQuery.isLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const viewerRole = workspaceQuery.data?.role ?? "member";
  const canManage = viewerRole === "owner" || viewerRole === "admin";
  const keys = keysQuery.data ?? [];
  // OPS-17/D-11: same full-vs-stale error split as the other list surfaces.
  const isFullyErrored = keysQuery.isError && !keysQuery.data;
  const isStaleErrored = keysQuery.isError && Boolean(keysQuery.data);

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-display font-semibold">API-ключи</h1>
          <p className="text-sm text-muted-foreground">
            Ключи для вашего бэкенда: Event API и Contacts API аутентифицируются по ним, а не по сессии.
          </p>
        </div>
        <CreateApiKeyDialog slug={slug} canManage={canManage} />
      </div>

      {isFullyErrored ? (
        <QueryErrorState
          title="Не удалось загрузить API-ключи"
          isFetching={keysQuery.isFetching}
          onRetry={() => void keysQuery.refetch()}
        />
      ) : (
        <div className="space-y-6">
          {isStaleErrored ? (
            <QueryErrorState
              title="Не удалось обновить список API-ключей"
              detail="Показаны последние загруженные данные."
              isFetching={keysQuery.isFetching}
              onRetry={() => void keysQuery.refetch()}
            />
          ) : null}
          {keys.length === 0 ? (
            <EmptyState
              title="API-ключей пока нет"
              description="Создайте ключ, чтобы ваш бэкенд мог отправлять контакты и события через API."
            />
          ) : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Название</TableHead>
                      <TableHead>Ключ</TableHead>
                      <TableHead>Статус</TableHead>
                      <TableHead className="text-right" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {keys.map((key) => (
                      <TableRow key={key.id}>
                        <TableCell>{key.name}</TableCell>
                        <TableCell className="font-mono text-sm">{key.keyMask}</TableCell>
                        <TableCell>
                          <ApiKeyStatusBadge revoked={Boolean(key.revokedAt)} />
                        </TableCell>
                        <TableCell className="text-right">
                          {canManage && !key.revokedAt ? (
                            <Button type="button" variant="ghost" size="sm" onClick={() => setRevokeTarget(key)}>
                              Отозвать
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {revokeTarget ? (
        <RevokeApiKeyDialog
          slug={slug}
          keyId={revokeTarget.id}
          keyName={revokeTarget.name}
          open={Boolean(revokeTarget)}
          onOpenChange={(open) => {
            if (!open) setRevokeTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}

export default ApiKeysSettings;
