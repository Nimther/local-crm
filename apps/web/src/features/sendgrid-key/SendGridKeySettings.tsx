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
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { KeyStatusBadge } from "@/features/sendgrid-key/KeyStatusBadge";

interface KeyMutationResponse {
  connected: true;
  keyMask: string;
  status: "active" | "error";
  verifiedSenders: VerifiedSender[];
}

const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";

function extractErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown } | undefined;
    if (typeof body?.error === "string") return body.error;
  }
  return GENERIC_ERROR;
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

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-display font-semibold">SendGrid</h1>
        <p className="text-sm text-muted-foreground">Подключение и статус вашего SendGrid-аккаунта.</p>
      </div>

      {!status?.connected ? (
        <Card>
          <CardHeader>
            <CardTitle>SendGrid не подключён</CardTitle>
            <CardDescription>Подключите API-ключ вашего SendGrid-аккаунта, чтобы отправлять письма.</CardDescription>
          </CardHeader>
          {canManage ? (
            <CardContent>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
    </div>
  );
}

export default SendGridKeySettings;
