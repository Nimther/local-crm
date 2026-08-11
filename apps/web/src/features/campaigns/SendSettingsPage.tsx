import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { toast } from "sonner";

import type { WorkspaceResponse } from "@mega-crm/shared-schemas";
import { apiGet, apiPut } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const GENERIC_ERROR = "Что-то пошло не так. Попробуйте ещё раз — если ошибка повторится, обновите страницу.";
const MEMBER_TOOLTIP = "Только Owner или Admin может запускать кампании.";

interface SendSettingsResponse {
  frequencyCap: number;
  frequencyWindowHours: number;
  rpsLimit: number | null;
}

/**
 * D-13: workspace-level send settings — «Частотный лимит» (default 3) +
 * optional «Лимит отправки в секунду». GET is ordinary-member level, PUT is
 * Owner/Admin-gated server-side too (requirePermission("campaign","launch"));
 * the save control mirrors that gate client-side (disabled + tooltip).
 * Manual useState form (not react-hook-form/zod) -- frequencyWindowHours
 * (z.number().default(24)) makes the schema's input/output types diverge in
 * a way zodResolver can't reconcile for a field this page never edits.
 */
export function SendSettingsPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const [frequencyCap, setFrequencyCap] = useState(3);
  const [rpsLimit, setRpsLimit] = useState<number | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const workspaceQuery = useQuery({
    queryKey: ["workspace", slug],
    queryFn: () => apiGet<WorkspaceResponse>(`/api/workspaces/${slug}`),
    enabled: Boolean(slug),
  });
  const viewerRole = workspaceQuery.data?.role ?? "member";
  const canManage = viewerRole === "owner" || viewerRole === "admin";

  const settingsQuery = useQuery({
    queryKey: ["workspace", slug, "send-settings"],
    queryFn: () => apiGet<SendSettingsResponse>(`/api/workspaces/${slug}/send-settings`),
    enabled: Boolean(slug),
  });

  useEffect(() => {
    if (settingsQuery.data) {
      setFrequencyCap(settingsQuery.data.frequencyCap);
      setRpsLimit(settingsQuery.data.rpsLimit);
    }
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiPut<SendSettingsResponse>(`/api/workspaces/${slug}/send-settings`, {
        frequencyCap,
        frequencyWindowHours: settingsQuery.data?.frequencyWindowHours ?? 24,
        rpsLimit,
      }),
    onSuccess: () => {
      setServerError(null);
      toast.success("Настройки сохранены");
    },
    onError: () => setServerError(GENERIC_ERROR),
  });

  function handleSave() {
    if (!canManage) return;
    setServerError(null);
    saveMutation.mutate();
  }

  if (workspaceQuery.isLoading || settingsQuery.isLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const saveButton = (
    <Button type="button" onClick={handleSave} disabled={!canManage || saveMutation.isPending}>
      {saveMutation.isPending ? "Сохраняем…" : "Сохранить настройки"}
    </Button>
  );

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-display font-semibold">Настройки отправки</h1>
        <p className="text-sm text-muted-foreground">
          Частотный лимит и ограничение скорости отправки для этого воркспейса.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Ограничения отправки</CardTitle>
        </CardHeader>
        <CardContent className="max-w-sm space-y-6">
          <div className="space-y-2">
            <Label htmlFor="frequency-cap">Частотный лимит</Label>
            <Input
              id="frequency-cap"
              type="number"
              min={1}
              disabled={!canManage}
              value={frequencyCap}
              onChange={(e) => setFrequencyCap(Number(e.target.value))}
            />
            <p className="text-sm text-muted-foreground">
              Не более стольких маркетинговых писем одному контакту за 24 часа
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="rps-limit">Лимит отправки в секунду</Label>
            <Input
              id="rps-limit"
              type="number"
              min={1}
              placeholder="По умолчанию платформы"
              disabled={!canManage}
              value={rpsLimit ?? ""}
              onChange={(e) => setRpsLimit(e.target.value ? Number(e.target.value) : null)}
            />
            <p className="text-sm text-muted-foreground">
              Оставьте пустым, чтобы использовать стандартный лимит платформы
            </p>
          </div>

          {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}

          {canManage ? (
            saveButton
          ) : (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="inline-flex">
                    {saveButton}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{MEMBER_TOOLTIP}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default SendSettingsPage;
