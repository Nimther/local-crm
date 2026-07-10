import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";

import { EXHAUSTIVE_LOOKUP_PAGE_SIZE, type FlowExitCondition } from "@mega-crm/shared-schemas";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listSegments } from "@/features/segments/api";
import { useUpdateFlowDraft, type FlowResponse } from "@/features/flows/api";

const SEGMENTS_EMPTY_COPY = "Сегментов пока нет — создайте сегмент в разделе «Сегменты», затем вернитесь сюда.";

/** Inline "add a new exit condition" row -- segment (in/not_in) or event, added on confirm (no separate save step). */
function NewConditionRow({
  slug,
  onAdd,
  onCancel,
}: {
  slug: string;
  onAdd: (condition: FlowExitCondition) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<"segment" | "event">("segment");
  const [segmentId, setSegmentId] = useState("");
  const [mode, setMode] = useState<"in" | "not_in">("in");
  const [eventName, setEventName] = useState("");

  const segmentsQuery = useQuery({
    queryKey: ["workspace", slug, "segments", "all-for-lookup"],
    queryFn: () => listSegments(slug, { page: 1, pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE }),
    enabled: Boolean(slug) && kind === "segment",
  });
  const segments = segmentsQuery.data?.items ?? [];

  function handleAdd() {
    if (kind === "segment") {
      if (!segmentId) return;
      onAdd({ type: "segment", segmentId, mode });
    } else {
      const trimmed = eventName.trim();
      if (!trimmed) return;
      onAdd({ type: "event", eventName: trimmed });
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-dashed p-3">
      <Select value={kind} onValueChange={(v) => setKind(v as "segment" | "event")}>
        <SelectTrigger className="w-52">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="segment">Условие по сегменту</SelectItem>
          <SelectItem value="event">Условие по событию</SelectItem>
        </SelectContent>
      </Select>

      {kind === "segment" ? (
        <div className="flex flex-wrap items-center gap-3">
          <Select value={segmentId} onValueChange={setSegmentId}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Выберите сегмент" />
            </SelectTrigger>
            <SelectContent>
              {segments.map((segment) => (
                <SelectItem key={segment.id} value={segment.id}>
                  {segment.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as "in" | "not_in")} className="flex gap-4">
            <div className="flex items-center gap-2">
              <RadioGroupItem value="in" id="exit-mode-in" />
              <Label htmlFor="exit-mode-in" className="font-normal">
                Входит в сегмент
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="not_in" id="exit-mode-not-in" />
              <Label htmlFor="exit-mode-not-in" className="font-normal">
                Не входит в сегмент
              </Label>
            </div>
          </RadioGroup>
          {!segmentsQuery.isLoading && segments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{SEGMENTS_EMPTY_COPY}</p>
          ) : null}
        </div>
      ) : (
        <Input
          placeholder="Имя события"
          value={eventName}
          onChange={(e) => setEventName(e.target.value)}
          className="w-56"
        />
      )}

      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={handleAdd}>
          Добавить
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </div>
  );
}

function exitConditionLabel(condition: FlowExitCondition, segmentNameById: Map<string, string>): string {
  if (condition.type === "segment") {
    const name = segmentNameById.get(condition.segmentId) ?? "сегмент";
    return condition.mode === "in" ? `Входит в сегмент «${name}»` : `Не входит в сегмент «${name}»`;
  }
  return `Событие «${condition.eventName}»`;
}

/**
 * FLOW-04/D-06/D-15: re-entry radio-group (three modes, inline N-day input)
 * + exit-conditions list («Добавить условие выхода») -- both persist
 * immediately via useUpdateFlowDraft. Draft settings stay Member-editable
 * (no Owner/Admin gate, unlike publish/pause/resume/eject/delete, D-23).
 */
export function FlowLifecycleSettings({ slug, flow }: { slug: string; flow: FlowResponse }) {
  const mutation = useUpdateFlowDraft(slug, flow.id);
  const [reentryWindowDays, setReentryWindowDays] = useState(flow.reentryWindowDays ?? 7);
  const [addingCondition, setAddingCondition] = useState(false);

  const segmentsQuery = useQuery({
    queryKey: ["workspace", slug, "segments", "all-for-lookup"],
    queryFn: () => listSegments(slug, { page: 1, pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE }),
    enabled: Boolean(slug),
  });
  const segmentNameById = new Map((segmentsQuery.data?.items ?? []).map((segment) => [segment.id, segment.name]));

  function handleReentryModeChange(mode: FlowResponse["reentryMode"]) {
    mutation.mutate({
      reentryMode: mode,
      ...(mode === "once_per_n_days" ? { reentryWindowDays } : {}),
    });
  }

  function commitReentryWindowDays() {
    if (flow.reentryMode === "once_per_n_days") {
      mutation.mutate({ reentryWindowDays });
    }
  }

  function addExitCondition(condition: FlowExitCondition) {
    mutation.mutate({ exitConditions: [...flow.exitConditions, condition] });
    setAddingCondition(false);
  }

  function removeExitCondition(index: number) {
    mutation.mutate({ exitConditions: flow.exitConditions.filter((_, i) => i !== index) });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Повторный вход</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <RadioGroup
            value={flow.reentryMode}
            onValueChange={(v) => handleReentryModeChange(v as FlowResponse["reentryMode"])}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="once_ever" id="reentry-once" />
              <Label htmlFor="reentry-once" className="font-normal">
                Только один раз
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="once_per_n_days" id="reentry-window" />
              <Label htmlFor="reentry-window" className="font-normal">
                Не чаще, чем раз в
              </Label>
              <Input
                type="number"
                min={1}
                className="w-20"
                value={reentryWindowDays}
                disabled={flow.reentryMode !== "once_per_n_days"}
                onChange={(e) => setReentryWindowDays(Math.max(1, Number(e.target.value) || 1))}
                onBlur={commitReentryWindowDays}
              />
              <span className="text-sm text-muted-foreground">дней</span>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="every_time" id="reentry-every" />
              <Label htmlFor="reentry-every" className="font-normal">
                Каждый раз
              </Label>
            </div>
          </RadioGroup>
          <p className="text-sm text-muted-foreground">{mutation.isPending ? "Сохранение…" : "Сохранено"}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Условия выхода</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {flow.exitConditions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Условий выхода нет — контакт дойдёт до конца цепочки без досрочного выхода.
            </p>
          ) : (
            <ul className="space-y-2">
              {flow.exitConditions.map((condition, index) => (
                <li key={index} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                  <span>{exitConditionLabel(condition, segmentNameById)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeExitCondition(index)}
                    aria-label="Удалить условие"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {addingCondition ? (
            <NewConditionRow slug={slug} onAdd={addExitCondition} onCancel={() => setAddingCondition(false)} />
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => setAddingCondition(true)}>
              <Plus className="mr-1 h-4 w-4" />
              Добавить условие выхода
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default FlowLifecycleSettings;
