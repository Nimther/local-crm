import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  validateFlowDefinition,
  type FlowDefinition,
  type FlowDelay,
  type FlowValidationError,
  type FlowValidationErrorCode,
} from "@mega-crm/flows-core";
import { EXHAUSTIVE_LOOKUP_PAGE_SIZE } from "@mega-crm/shared-schemas";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listCampaignSenders, listCampaignTemplates } from "@/features/campaigns/api";
import { SenderPicker, TemplatePicker } from "@/features/campaigns/TemplateSenderPickers";
import { fetchEventNames, listSegments } from "@/features/segments/api";
import type { CanvasNode, CanvasNodeConfig, FlowCanvasNodeType } from "./nodeTypes";

// ---------------------------------------------------------------------------
// Client-side publish-blocker feedback (D-17). The canvas re-uses the SAME
// validateFlowDefinition the server runs inside the publish transaction —
// instant feedback only; the publish action (06-11) always POSTs to the
// server, which re-validates, and client validity is never sent as a
// trusted flag (Pitfall 3, T-06-10-01).
// ---------------------------------------------------------------------------

/** D-17 hard-error codes → Russian copy (06-UI-SPEC error table). */
export const PUBLISH_BLOCKER_MESSAGES: Record<FlowValidationErrorCode, string> = {
  no_trigger: "Добавьте и настройте триггер — событие или сегмент, — чтобы опубликовать цепочку.",
  empty_send: "Заполните шаблон и отправителя в узле «Отправить письмо».",
  branch_missing_exit: "Каждая ветка должна заканчиваться узлом «Выход».",
};

export interface PublishBlocker extends FlowValidationError {
  message: string;
}

/** validateFlowDefinition + Russian copy mapping, in one place for the canvas. */
export function computePublishBlockers(definition: FlowDefinition): PublishBlocker[] {
  return validateFlowDefinition(definition).map((error) => ({
    ...error,
    message: PUBLISH_BLOCKER_MESSAGES[error.code],
  }));
}

/** Schema-incomplete (not-yet-persistable) node states, per node type. */
export const INCOMPLETE_NODE_MESSAGES: Partial<Record<FlowCanvasNodeType, string>> = {
  trigger: "Выберите событие или сегмент.",
  delay: "Настройте задержку.",
  branch: "Выберите сегмент условия.",
};

const SECTION_TITLES: Record<FlowCanvasNodeType, string> = {
  trigger: "Настроить триггер",
  delay: "Настроить задержку",
  branch: "Настроить условие",
  send: "Настроить письмо",
  exit: "Выход",
};

const EVENT_NOT_OBSERVED_HELPER =
  "Такое событие ещё не встречалось — можно ввести имя вручную, оно начнёт учитываться, как только придёт.";
const SEGMENTS_EMPTY_COPY = "Сегментов пока нет — создайте сегмент в разделе «Сегменты», затем вернитесь сюда.";

// ---------------------------------------------------------------------------
// Pickers (Phase 3 popover+command combobox pattern, reused verbatim)
// ---------------------------------------------------------------------------

/** D-01/D-05: event-name combobox from observed names + free-text fallback. */
function EventNamePicker({
  slug,
  value,
  onChange,
}: {
  slug: string;
  value: string | undefined;
  onChange: (eventName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const eventNamesQuery = useQuery({
    queryKey: ["workspace", slug, "segments", "event-names"],
    queryFn: () => fetchEventNames(slug),
    enabled: Boolean(slug),
  });
  const eventNames = eventNamesQuery.data?.names ?? [];

  function choose(name: string) {
    onChange(name);
    setOpen(false);
    setSearch("");
  }

  return (
    <div className="space-y-2">
      <Label>Событие</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" aria-expanded={open} className="w-full justify-start">
            {value || "Выберите событие"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Поиск события…" value={search} onValueChange={setSearch} />
            <CommandList>
              <CommandEmpty>
                {search.trim() ? (
                  <button
                    type="button"
                    className="w-full px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => choose(search.trim())}
                  >
                    Использовать «{search.trim()}»
                  </button>
                ) : (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">
                    Событий этого воркспейса пока не поступало — введите имя вручную.
                  </p>
                )}
              </CommandEmpty>
              <CommandGroup heading="Наблюдаемые события">
                {eventNames.map((name) => (
                  <CommandItem key={name} value={name} onSelect={() => choose(name)}>
                    {name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value && !eventNamesQuery.isLoading && !eventNames.includes(value) ? (
        <p className="text-sm text-muted-foreground">{EVENT_NOT_OBSERVED_HELPER}</p>
      ) : null}
    </div>
  );
}

/** Segment picker (trigger segment mode + branch condition), command+popover. */
function SegmentPicker({
  slug,
  label,
  value,
  onChange,
}: {
  slug: string;
  label: string;
  value: string | undefined;
  onChange: (segmentId: string, segmentName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const segmentsQuery = useQuery({
    queryKey: ["workspace", slug, "segments", "all-for-lookup"],
    queryFn: () => listSegments(slug, { page: 1, pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE }),
    enabled: Boolean(slug),
  });
  const segments = segmentsQuery.data?.items ?? [];
  const selected = segments.find((segment) => segment.id === value);

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" aria-expanded={open} className="w-full justify-start">
            {selected ? selected.name : value ? "Сегмент выбран" : "Выберите сегмент"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Поиск сегмента…" value={search} onValueChange={setSearch} />
            <CommandList>
              <CommandEmpty>
                <p className="px-2 py-1.5 text-sm text-muted-foreground">{SEGMENTS_EMPTY_COPY}</p>
              </CommandEmpty>
              <CommandGroup heading="Сегменты">
                {segments.map((segment) => (
                  <CommandItem
                    key={segment.id}
                    value={`${segment.name} ${segment.id}`}
                    onSelect={() => {
                      onChange(segment.id, segment.name);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    {segment.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {!segmentsQuery.isLoading && segments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{SEGMENTS_EMPTY_COPY}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-type config sections
// ---------------------------------------------------------------------------

function TriggerConfigSection({
  slug,
  config,
  onChange,
}: {
  slug: string;
  config: CanvasNodeConfig;
  onChange: (next: CanvasNodeConfig) => void;
}) {
  const triggerType = config.triggerType ?? "event";
  return (
    <div className="space-y-4">
      <RadioGroup
        value={triggerType}
        onValueChange={(next) => onChange({ ...config, triggerType: next as "event" | "segment" })}
        className="space-y-1"
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="event" id="trigger-type-event" />
          <Label htmlFor="trigger-type-event" className="font-normal">
            Событие
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="segment" id="trigger-type-segment" />
          <Label htmlFor="trigger-type-segment" className="font-normal">
            Вход в сегмент
          </Label>
        </div>
      </RadioGroup>
      {triggerType === "event" ? (
        <EventNamePicker slug={slug} value={config.eventName} onChange={(eventName) => onChange({ ...config, eventName })} />
      ) : (
        <SegmentPicker
          slug={slug}
          label="Сегмент"
          value={config.segmentId}
          onChange={(segmentId, segmentName) => onChange({ ...config, segmentId, segmentName })}
        />
      )}
    </div>
  );
}

const WEEKDAY_OPTIONS: { value: string; label: string }[] = [
  { value: "any", label: "Любой день" },
  { value: "1", label: "Понедельник" },
  { value: "2", label: "Вторник" },
  { value: "3", label: "Среда" },
  { value: "4", label: "Четверг" },
  { value: "5", label: "Пятница" },
  { value: "6", label: "Суббота" },
  { value: "0", label: "Воскресенье" },
];

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

/** D-11: fixed duration OR wait-until-time-of-day (native time input, no date-picker library). */
function DelayConfigSection({
  config,
  onChange,
}: {
  config: CanvasNodeConfig;
  onChange: (next: CanvasNodeConfig) => void;
}) {
  const delay = config.delay;

  function setDelay(next: FlowDelay) {
    onChange({ ...config, delay: next });
  }

  return (
    <div className="space-y-4">
      <RadioGroup
        value={delay?.kind ?? ""}
        onValueChange={(kind) => {
          if (kind === "fixed") setDelay({ kind: "fixed", amount: 1, unit: "days" });
          if (kind === "wait_until") setDelay({ kind: "wait_until", timeOfDay: 9 * 60 });
        }}
        className="space-y-1"
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="fixed" id="delay-kind-fixed" />
          <Label htmlFor="delay-kind-fixed" className="font-normal">
            Фиксированная длительность
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="wait_until" id="delay-kind-wait-until" />
          <Label htmlFor="delay-kind-wait-until" className="font-normal">
            Дождаться времени
          </Label>
        </div>
      </RadioGroup>

      {delay?.kind === "fixed" ? (
        <div className="flex items-end gap-2">
          <div className="space-y-2">
            <Label htmlFor="delay-amount">Длительность</Label>
            <Input
              id="delay-amount"
              type="number"
              min={1}
              className="w-24"
              value={delay.amount}
              onChange={(event) => {
                const amount = Math.max(1, Math.floor(Number(event.target.value) || 1));
                setDelay({ ...delay, amount });
              }}
            />
          </div>
          <Select
            value={delay.unit}
            onValueChange={(unit) => setDelay({ ...delay, unit: unit as "minutes" | "hours" | "days" })}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="minutes">минуты</SelectItem>
              <SelectItem value="hours">часы</SelectItem>
              <SelectItem value="days">дни</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {delay?.kind === "wait_until" ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="delay-time">Время</Label>
            <Input
              id="delay-time"
              type="time"
              className="w-32"
              value={minutesToHhMm(delay.timeOfDay)}
              onChange={(event) => {
                const minutes = hhMmToMinutes(event.target.value);
                if (minutes !== null) setDelay({ ...delay, timeOfDay: minutes });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label>День недели</Label>
            <Select
              value={delay.dayOfWeek === undefined ? "any" : String(delay.dayOfWeek)}
              onValueChange={(value) => {
                if (value === "any") {
                  const { dayOfWeek: _omitted, ...rest } = delay;
                  setDelay(rest);
                } else {
                  setDelay({ ...delay, dayOfWeek: Number(value) });
                }
              }}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEKDAY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-sm text-muted-foreground">
            По часовому поясу контакта, иначе — по часовому поясу воркспейса.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** D-16: send node reuses the campaign template + verified-sender pickers verbatim. */
function SendConfigSection({
  slug,
  config,
  onChange,
}: {
  slug: string;
  config: CanvasNodeConfig;
  onChange: (next: CanvasNodeConfig) => void;
}) {
  // Same query keys as the pickers themselves — cache-shared lookups used to
  // resolve display/template names and the sender's fromEmail (the flow send
  // dispatcher, 06-03, reads templateId + fromEmail off the node config).
  const templatesQuery = useQuery({
    queryKey: ["workspace", slug, "campaign-templates"],
    queryFn: () => listCampaignTemplates(slug),
    enabled: Boolean(slug),
  });
  const sendersQuery = useQuery({
    queryKey: ["workspace", slug, "campaign-senders"],
    queryFn: () => listCampaignSenders(slug),
    enabled: Boolean(slug),
  });

  return (
    <div className="space-y-6">
      <TemplatePicker
        slug={slug}
        value={config.templateId ?? null}
        onChange={(templateId) => {
          const template = templatesQuery.data?.templates.find((t) => t.id === templateId);
          onChange({
            ...config,
            templateId: templateId ?? undefined,
            templateName: template?.name,
          });
        }}
      />
      <div className="space-y-2">
        <SenderPicker
          slug={slug}
          value={config.fromSenderId ?? null}
          onChange={(fromSenderId) => {
            const sender = sendersQuery.data?.senders.find((s) => String(s.id) === fromSenderId);
            onChange({
              ...config,
              fromSenderId: fromSenderId ?? undefined,
              fromEmail: sender?.fromEmail ?? config.fromEmail,
            });
          }}
        />
        {config.fromEmail ? (
          <p className="text-sm text-muted-foreground">Адрес отправителя: {config.fromEmail}</p>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Right-docked node-config panel — contents switch by the selected node's
 * type (trigger / delay / branch / send / exit). Changes apply to the canvas
 * immediately (the debounced autosave persists them); «Сохранить узел»
 * confirms and deselects.
 */
export function NodeConfigPanel({
  slug,
  node,
  onConfigChange,
  onClose,
}: {
  slug: string;
  node: CanvasNode | null;
  onConfigChange: (nodeId: string, config: CanvasNodeConfig) => void;
  onClose: () => void;
}) {
  if (!node || !node.type) {
    return (
      <aside className="w-96 shrink-0 overflow-y-auto border-l border-neutral-200 bg-white p-6">
        <p className="text-base text-muted-foreground">Выберите узел на холсте, чтобы настроить его.</p>
      </aside>
    );
  }

  const type = node.type as FlowCanvasNodeType;
  const config = node.data.config;
  const update = (next: CanvasNodeConfig) => onConfigChange(node.id, next);

  return (
    <aside className="flex w-96 shrink-0 flex-col overflow-y-auto border-l border-neutral-200 bg-white">
      <div className="flex-1 space-y-6 p-6">
        <h2 className="text-xl font-semibold">{SECTION_TITLES[type]}</h2>
        {node.data.invalidMessage ? <p className="text-sm text-destructive">{node.data.invalidMessage}</p> : null}
        {type === "trigger" ? <TriggerConfigSection slug={slug} config={config} onChange={update} /> : null}
        {type === "delay" ? <DelayConfigSection config={config} onChange={update} /> : null}
        {type === "branch" ? (
          <SegmentPicker
            slug={slug}
            label="Сегмент условия"
            value={config.segmentId}
            onChange={(segmentId, segmentName) => update({ ...config, segmentId, segmentName })}
          />
        ) : null}
        {type === "send" ? <SendConfigSection slug={slug} config={config} onChange={update} /> : null}
        {type === "exit" ? (
          <p className="text-base text-muted-foreground">
            Узел не требует настройки — контакт, дошедший до него, завершает цепочку.
          </p>
        ) : null}
      </div>
      {type !== "exit" ? (
        <div className="border-t border-neutral-200 p-6">
          <Button type="button" className="w-full" onClick={onClose}>
            Сохранить узел
          </Button>
        </div>
      ) : null}
    </aside>
  );
}
