import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { apiGet } from "@/lib/api";
import { useUpdateFlowDraft, type FlowResponse } from "@/features/flows/api";

interface WorkspaceSendSettingsResponse {
  frequencyCap: number;
  frequencyWindowHours: number;
  rpsLimit: number | null;
  defaultTimezone: string | null;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  quietHoursEnabled: boolean;
}

function minutesToHhMm(minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function hhMmToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 1439 ? minutes : null;
}

/**
 * FLOW-05/D-09: per-flow quiet-hours override card. Switch «Использовать
 * своё окно для этой цепочки» off (default) inherits the workspace's own
 * default window (shown as a muted read-only preview); on reveals the
 * from/to time inputs plus a second switch «Отключить тихие часы для этой
 * цепочки» for the explicit-disable case. Persists via useUpdateFlowDraft.
 */
export function QuietHoursCard({ slug, flow }: { slug: string; flow: FlowResponse }) {
  const mutation = useUpdateFlowDraft(slug, flow.id);
  const [start, setStart] = useState(flow.quietHoursStart ?? 22 * 60);
  const [end, setEnd] = useState(flow.quietHoursEnd ?? 8 * 60);

  const settingsQuery = useQuery({
    queryKey: ["workspace", slug, "send-settings"],
    queryFn: () => apiGet<WorkspaceSendSettingsResponse>(`/api/workspaces/${slug}/send-settings`),
    enabled: Boolean(slug),
  });

  const useCustom = flow.quietHoursMode !== "workspace_default";
  const disabled = flow.quietHoursMode === "disabled";
  const workspaceDefault = settingsQuery.data;

  function handleUseCustomChange(next: boolean) {
    mutation.mutate(
      next
        ? { quietHoursMode: "custom", quietHoursStart: start, quietHoursEnd: end }
        : { quietHoursMode: "workspace_default" }
    );
  }

  function handleDisabledChange(next: boolean) {
    mutation.mutate(
      next
        ? { quietHoursMode: "disabled" }
        : { quietHoursMode: "custom", quietHoursStart: start, quietHoursEnd: end }
    );
  }

  function commitTimes() {
    if (flow.quietHoursMode === "custom") {
      mutation.mutate({ quietHoursStart: start, quietHoursEnd: end });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Тихие часы</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Switch id="quiet-hours-custom" checked={useCustom} onCheckedChange={handleUseCustomChange} />
          <Label htmlFor="quiet-hours-custom" className="font-normal">
            Использовать своё окно для этой цепочки
          </Label>
        </div>

        {!useCustom ? (
          <p className="text-sm text-muted-foreground">
            {workspaceDefault?.quietHoursEnabled &&
            workspaceDefault.quietHoursStart !== null &&
            workspaceDefault.quietHoursEnd !== null
              ? `Сейчас используется окно воркспейса по умолчанию: ${minutesToHhMm(
                  workspaceDefault.quietHoursStart
                )}–${minutesToHhMm(workspaceDefault.quietHoursEnd)}`
              : "Тихие часы по умолчанию для воркспейса не заданы"}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Switch id="quiet-hours-disabled" checked={disabled} onCheckedChange={handleDisabledChange} />
              <Label htmlFor="quiet-hours-disabled" className="font-normal">
                Отключить тихие часы для этой цепочки
              </Label>
            </div>

            {!disabled ? (
              <div className="flex items-end gap-4">
                <div className="space-y-2">
                  <Label htmlFor="quiet-hours-start">С</Label>
                  <Input
                    id="quiet-hours-start"
                    type="time"
                    className="w-32"
                    value={minutesToHhMm(start)}
                    onChange={(e) => {
                      const minutes = hhMmToMinutes(e.target.value);
                      if (minutes !== null) setStart(minutes);
                    }}
                    onBlur={commitTimes}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="quiet-hours-end">До</Label>
                  <Input
                    id="quiet-hours-end"
                    type="time"
                    className="w-32"
                    value={minutesToHhMm(end)}
                    onChange={(e) => {
                      const minutes = hhMmToMinutes(e.target.value);
                      if (minutes !== null) setEnd(minutes);
                    }}
                    onBlur={commitTimes}
                  />
                </div>
              </div>
            ) : null}
          </div>
        )}

        <p className="text-sm text-muted-foreground">{mutation.isPending ? "Сохранение…" : "Сохранено"}</p>
      </CardContent>
    </Card>
  );
}

export default QuietHoursCard;
