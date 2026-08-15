import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";

import {
  connectSendgridKeySchema,
  type ConnectSendgridKeyInput,
  type SendgridKeyStatus,
  type VerifiedSender,
  type WorkspaceResponse,
} from "@mega-crm/shared-schemas";
import { ApiError, apiGet, apiPost } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { QueryErrorState } from "@/components/QueryErrorState";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { KeyStatusBadge } from "@/features/sendgrid-key/KeyStatusBadge";
import { getWebhookHealth, reconnectWebhook } from "@/features/webhooks/webhook-health.api";
import {
  reconnectToastForHealth,
  webhookHealthDescription,
  webhookNoticeForKeyResponse,
} from "@/features/sendgrid-key/webhook-notice";

interface KeyMutationResponse {
  connected: true;
  keyMask: string;
  status: "active" | "error";
  verifiedSenders: VerifiedSender[];
  webhookWarning?: string;
}

const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";

function extractErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown } | undefined;
    if (typeof body?.error === "string") return body.error;
  }
  return GENERIC_ERROR;
}

const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });

/** «3 минуты назад» -- mirrors ContactEventFeed.tsx's Intl.RelativeTimeFormat("ru") pattern. */
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

function webhookHealthQueryKey(slug: string) {
  return ["workspace", slug, "webhook-health"];
}

/**
 * D-02/D-03: connected/disconnected indicator + last-event-received relative
 * time + a "Переподключить"/"Включить отслеживание доставки" action for
 * Owner/Admin (T-05-13: server independently re-enforces requirePermission,
 * this gate is cosmetic only). Rendered only once a SendGrid key is
 * connected -- webhook provisioning itself depends on the key.
 */
function WebhookHealthCard({ slug, canManage }: { slug: string; canManage: boolean }) {
  const queryClient = useQueryClient();

  const healthQuery = useQuery({
    queryKey: webhookHealthQueryKey(slug),
    queryFn: () => getWebhookHealth(slug),
    enabled: Boolean(slug),
  });

  const reconnectMutation = useMutation({
    mutationFn: () => reconnectWebhook(slug),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: webhookHealthQueryKey(slug) });
      const result = reconnectToastForHealth(data);
      if (result.variant === "error") {
        toast.error(result.message);
      } else {
        toast.success(result.message);
      }
    },
    onError: (error: unknown) => {
      toast.error(extractErrorMessage(error));
    },
  });

  if (healthQuery.isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  const health = healthQuery.data;
  const connected = Boolean(health?.connected);
  const reconnectLabel = connected ? "Переподключить отслеживание" : "Включить отслеживание доставки";
  const badgeStatus = connected ? "active" : health?.provisionStatus === "error" ? "error" : "pending";
  const errorDescription = health
    ? webhookHealthDescription({
        provisionStatus: health.provisionStatus,
        provisionError: health.provisionError,
        lastEventAt: health.lastEventAt,
      })
    : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-3">
            Отслеживание доставки
            <KeyStatusBadge status={badgeStatus} />
          </CardTitle>
          <CardDescription>
            {errorDescription
              ? errorDescription
              : health?.lastEventAt
                ? `Последнее событие получено: ${relativeTime(health.lastEventAt)}`
                : "События ещё не поступали"}
          </CardDescription>
        </div>
        {canManage ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => reconnectMutation.mutate()}
            disabled={reconnectMutation.isPending}
          >
            <RefreshCw
              className={reconnectMutation.isPending ? "mr-2 h-4 w-4 animate-spin" : "mr-2 h-4 w-4"}
            />
            {reconnectLabel}
          </Button>
        ) : null}
      </CardHeader>
    </Card>
  );
}

/**
 * SendGrid key settings (TENANT-04, D-19/D-21/D-22): not-connected empty
 * state (with a connect form for Owner/Admin only, D-19), connected view
 * with the masked key + status badge + verified senders + «Проверить
 * сейчас», and the exact invalid/missing-scope/unverified error copy
 * surfaced inline from the server (never re-derived client-side).
 */
export function SendGridKeySettings() {
  const { slug = "" } = useParams<{ slug: string }>();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const [verifiedSenders, setVerifiedSenders] = useState<VerifiedSender[] | null>(null);
  const [webhookWarning, setWebhookWarning] = useState<string | null>(null);

  const workspaceQuery = useQuery({
    queryKey: ["workspace", slug],
    queryFn: () => apiGet<WorkspaceResponse>(`/api/workspaces/${slug}`),
    enabled: Boolean(slug),
  });

  const statusQuery = useQuery({
    queryKey: ["workspace", slug, "sendgrid-key"],
    queryFn: () => apiGet<SendgridKeyStatus>(`/api/workspaces/${slug}/sendgrid-key`),
    enabled: Boolean(slug),
  });

  const form = useForm<ConnectSendgridKeyInput>({
    resolver: zodResolver(connectSendgridKeySchema),
    defaultValues: { apiKey: "" },
  });

  function invalidateStatus() {
    return queryClient.invalidateQueries({ queryKey: ["workspace", slug, "sendgrid-key"] });
  }

  const connectMutation = useMutation({
    mutationFn: (values: ConnectSendgridKeyInput) =>
      apiPost<KeyMutationResponse>(`/api/workspaces/${slug}/sendgrid-key`, values),
    onSuccess: (data) => {
      setServerError(null);
      setVerifiedSenders(data.verifiedSenders);
      form.reset({ apiKey: "" });
      void invalidateStatus();
      toast.success("SendGrid подключён");
      const warning = webhookNoticeForKeyResponse(data);
      setWebhookWarning(warning);
      if (warning) {
        toast.warning(warning);
      }
    },
    onError: (error: unknown) => {
      setServerError(extractErrorMessage(error));
    },
  });

  const recheckMutation = useMutation({
    mutationFn: () => apiPost<KeyMutationResponse>(`/api/workspaces/${slug}/sendgrid-key/recheck`, {}),
    onSuccess: (data) => {
      setServerError(null);
      setVerifiedSenders(data.verifiedSenders);
      void invalidateStatus();
      toast.success("Статус SendGrid обновлён");
      const warning = webhookNoticeForKeyResponse(data);
      setWebhookWarning(warning);
      if (warning) {
        toast.warning(warning);
      }
    },
    onError: (error: unknown) => {
      setServerError(extractErrorMessage(error));
      void invalidateStatus();
    },
  });

  async function onSubmit(values: ConnectSendgridKeyInput) {
    await connectMutation.mutateAsync(values);
  }

  if (workspaceQuery.isLoading || statusQuery.isLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const viewerRole = workspaceQuery.data?.role ?? "member";
  const canManage = viewerRole === "owner" || viewerRole === "admin";
  const status = statusQuery.data;

  // T-15-19/OPS-17: a failed status fetch must NEVER fall into the
  // `!status?.connected` branch below -- that branch renders the connect
  // form, which reads as "no key configured" and invites pasting a key
  // that may already be stored (a real repudiation risk on a page whose
  // whole purpose is showing whether a key is connected). The empty/connect
  // state is reachable only from a successful response that says
  // `connected: false`, never from a fetch failure.
  const isFullyErrored = statusQuery.isError && !statusQuery.data;
  const isStaleErrored = statusQuery.isError && Boolean(statusQuery.data);

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-display font-semibold">SendGrid</h1>
        <p className="text-sm text-muted-foreground">Подключение и статус вашего SendGrid-аккаунта.</p>
      </div>

      {isFullyErrored ? (
        <QueryErrorState
          title="Не удалось загрузить статус SendGrid"
          detail="Ключ может быть уже подключён — не вводите его заново, пока проверка не пройдёт успешно."
          isFetching={statusQuery.isFetching}
          onRetry={() => void statusQuery.refetch()}
        />
      ) : (
        <>
          {isStaleErrored ? (
            <QueryErrorState
              title="Не удалось обновить статус SendGrid"
              detail="Показан последний известный статус."
              isFetching={statusQuery.isFetching}
              onRetry={() => void statusQuery.refetch()}
            />
          ) : null}
          {!status?.connected ? (
        <Card>
          <CardHeader>
            <CardTitle>SendGrid не подключён</CardTitle>
            <CardDescription>Подключите API-ключ вашего SendGrid-аккаунта, чтобы отправлять письма.</CardDescription>
          </CardHeader>
          {canManage ? (
            <CardContent>
              <Form {...form}>
                <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="apiKey"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>API-ключ SendGrid</FormLabel>
                        <FormControl>
                          <Input type="password" autoComplete="off" className="font-mono" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
                  <Button type="submit" disabled={form.formState.isSubmitting || connectMutation.isPending}>
                    {connectMutation.isPending ? "Подключаем…" : "Подключить SendGrid"}
                  </Button>
                </form>
              </Form>
            </CardContent>
          ) : null}
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-3">
                <span className="font-mono text-sm">{status.keyMask}</span>
                <KeyStatusBadge status={status.status === "error" ? "error" : "active"} />
              </CardTitle>
              <CardDescription>
                {status.lastCheckedAt
                  ? `Последняя проверка: ${new Date(status.lastCheckedAt).toLocaleString("ru-RU")}`
                  : "Ещё не проверялся"}
              </CardDescription>
            </div>
            {canManage ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => recheckMutation.mutate()}
                      disabled={recheckMutation.isPending}
                    >
                      <RefreshCw
                        className={recheckMutation.isPending ? "mr-2 h-4 w-4 animate-spin" : "mr-2 h-4 w-4"}
                      />
                      Проверить сейчас
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Повторно проверяет ключ в SendGrid и обновляет статус</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-4">
            {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
            {webhookWarning ? <p className="text-sm font-medium text-amber-600">{webhookWarning}</p> : null}
            {verifiedSenders && verifiedSenders.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Отправитель</TableHead>
                    <TableHead>Имя</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {verifiedSenders.map((sender) => (
                    <TableRow key={sender.id}>
                      <TableCell>{sender.fromEmail}</TableCell>
                      <TableCell>{sender.nickname ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">
                Список верифицированных отправителей появится после подключения или проверки ключа.
              </p>
            )}
          </CardContent>
        </Card>
          )}
        </>
      )}

      {status?.connected ? <WebhookHealthCard slug={slug} canManage={canManage} /> : null}
    </div>
  );
}

export default SendGridKeySettings;
