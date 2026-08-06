import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";

import type {
  AttributeCondition,
  BehavioralCondition,
  ConditionOperator,
  PropertyRegistryItem,
  SegmentCondition,
  SegmentDefinition,
  SegmentGroup,
} from "@mega-crm/shared-schemas";
import { apiGet } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchEventNames, fetchPreviewCount } from "@/features/segments/api";
import { useDebouncedValue } from "@/features/segments/useDebouncedValue";
import { cn } from "@/lib/utils";

/** D-03 field kinds -- drives which operators/value-input a condition row shows. */
type FieldKind = "string" | "number" | "bool" | "date" | "subscriptionStatus" | "tags";

interface StandardFieldMeta {
  field: string;
  label: string;
  kind: FieldKind;
}

/** D-04: standard profile fields exposed in the builder's "Стандартные поля" combobox group. */
const STANDARD_FIELDS: StandardFieldMeta[] = [
  { field: "country", label: "Страна", kind: "string" },
  { field: "city", label: "Город", kind: "string" },
  { field: "firstName", label: "Имя", kind: "string" },
  { field: "lastName", label: "Фамилия", kind: "string" },
  { field: "phone", label: "Телефон", kind: "string" },
  { field: "subscriptionStatus", label: "Статус подписки", kind: "subscriptionStatus" },
  { field: "tags", label: "Теги", kind: "tags" },
];

const SUBSCRIPTION_STATUS_OPTIONS = [
  { value: "subscribed", label: "Подписан" },
  { value: "unsubscribed", label: "Отписан" },
  { value: "suppressed", label: "В списке подавления" },
];

/** D-03 operator registry, grouped by field type -- mirrors packages/shared-schemas/src/segment.ts. */
const OPERATORS_BY_KIND: Record<FieldKind, { value: ConditionOperator; label: string }[]> = {
  string: [
    { value: "eq", label: "равно" },
    { value: "neq", label: "не равно" },
    { value: "contains", label: "содержит" },
    { value: "not_contains", label: "не содержит" },
    { value: "is_empty", label: "пусто" },
    { value: "is_not_empty", label: "не пусто" },
  ],
  number: [
    { value: "gt", label: "больше" },
    { value: "gte", label: "больше или равно" },
    { value: "lt", label: "меньше" },
    { value: "lte", label: "меньше или равно" },
  ],
  bool: [
    { value: "is_true", label: "истина" },
    { value: "is_false", label: "ложь" },
  ],
  date: [
    { value: "before", label: "до" },
    { value: "after", label: "после" },
    { value: "in_last_days", label: "в последние N дней" },
  ],
  subscriptionStatus: [
    { value: "eq", label: "равно" },
    { value: "neq", label: "не равно" },
  ],
  tags: [
    { value: "has_tag", label: "есть тег" },
    { value: "not_has_tag", label: "нет тега" },
  ],
};

const HIDDEN_VALUE_OPERATORS = new Set<ConditionOperator>(["is_empty", "is_not_empty", "is_true", "is_false"]);

function kindForAttributeCondition(cond: AttributeCondition, registry: PropertyRegistryItem[]): FieldKind {
  if (cond.source === "standard") {
    return STANDARD_FIELDS.find((f) => f.field === cond.field)?.kind ?? "string";
  }
  return registry.find((r) => r.key === cond.field)?.observedType ?? "string";
}

function fieldLabel(cond: AttributeCondition): string {
  if (!cond.field) return "Выберите поле";
  if (cond.source === "standard") {
    return STANDARD_FIELDS.find((f) => f.field === cond.field)?.label ?? cond.field;
  }
  return cond.field;
}

function valueInputKind(
  kind: FieldKind,
  operator: ConditionOperator
): "hidden" | "text" | "number" | "date" | "subscriptionStatus" {
  if (HIDDEN_VALUE_OPERATORS.has(operator)) return "hidden";
  if (kind === "subscriptionStatus") return "subscriptionStatus";
  if (operator === "in_last_days") return "number";
  if (kind === "number") return "number";
  if (kind === "date") return "date";
  return "text";
}

export function newAttributeCondition(): AttributeCondition {
  return { type: "attribute", source: "standard", field: "", operator: "eq", value: "" };
}

export function newBehavioralCondition(): BehavioralCondition {
  return { type: "behavioral", eventName: "", countOperator: "at_least", count: 1, timeframe: { kind: "all_time" } };
}

/** SEGM-01/02: the empty starting definition a new segment's builder opens with. */
export function createEmptySegmentDefinition(): SegmentDefinition {
  return { version: 1, groups: [{ conditions: [newAttributeCondition()] }] };
}

function recapForCondition(cond: SegmentCondition, registry: PropertyRegistryItem[]): string {
  if (cond.type === "attribute") {
    if (!cond.field) return "Условие не задано";
    const label = fieldLabel(cond);
    const kind = kindForAttributeCondition(cond, registry);
    const opLabel = OPERATORS_BY_KIND[kind].find((o) => o.value === cond.operator)?.label ?? cond.operator;
    if (HIDDEN_VALUE_OPERATORS.has(cond.operator)) {
      return `${label}: ${opLabel}`;
    }
    // AttributeCondition.value is `unknown` (segments-core/types.ts), so a bare
    // String() renders "[object Object]" into the human-readable summary for
    // any non-primitive an operator legitimately carries.
    const raw: unknown = cond.value;
    const value =
      raw === undefined || raw === ""
        ? "…"
        : typeof raw === "string"
          ? raw
          : typeof raw === "number" || typeof raw === "boolean"
            ? String(raw)
            : Array.isArray(raw)
              ? raw.join(", ")
              : JSON.stringify(raw);
    return `${label}: ${opLabel} ${value}`;
  }
  if (!cond.eventName) return "Событие не задано";
  const verb = cond.countOperator === "none" ? "не выполнил" : `выполнил ≥ ${cond.count ?? 1} раз`;
  const period = cond.timeframe.kind === "last_days" ? `за последние ${cond.timeframe.days} дней` : "за всё время";
  return `${cond.eventName} ${verb} ${period}`;
}

function recapForGroup(group: SegmentGroup, registry: PropertyRegistryItem[]): string {
  return group.conditions.map((c) => recapForCondition(c, registry)).join(" или ");
}

/**
 * D-08: gates the live-count preview request -- only fires once every group
 * has at least one condition with its required fields filled in (partial
 * edits don't spam the preview-count endpoint with an incomplete/invalid
 * definition on every keystroke).
 */
function isConditionReadyForPreview(cond: SegmentCondition): boolean {
  if (cond.type === "attribute") {
    if (!cond.field) return false;
    if (HIDDEN_VALUE_OPERATORS.has(cond.operator)) return true;
    return cond.value !== undefined && cond.value !== "";
  }
  if (!cond.eventName) return false;
  if (cond.countOperator === "at_least" && !cond.count) return false;
  if (cond.timeframe.kind === "last_days" && !cond.timeframe.days) return false;
  return true;
}

function isDefinitionReadyForPreview(definition: SegmentDefinition): boolean {
  return (
    definition.groups.length > 0 &&
    definition.groups.every((g) => g.conditions.length > 0 && g.conditions.every(isConditionReadyForPreview))
  );
}

/** D-01/D-03: field/custom-property combobox (popover + command), free-text fallback. */
function FieldCombobox({
  cond,
  registry,
  onSelect,
}: {
  cond: AttributeCondition;
  registry: PropertyRegistryItem[];
  onSelect: (next: { source: "standard" | "custom"; field: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  function choose(next: { source: "standard" | "custom"; field: string }) {
    onSelect(next);
    setOpen(false);
    setSearch("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" aria-expanded={open} className="w-48 justify-start">
          {fieldLabel(cond)}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Поиск поля…" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>
              {search.trim() ? (
                <button
                  type="button"
                  className="w-full px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => choose({ source: "custom", field: search.trim() })}
                >
                  Использовать «{search.trim()}»
                </button>
              ) : (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">Ничего не найдено</p>
              )}
            </CommandEmpty>
            <CommandGroup heading="Стандартные поля">
              {STANDARD_FIELDS.map((f) => (
                <CommandItem key={f.field} value={f.label} onSelect={() => choose({ source: "standard", field: f.field })}>
                  {f.label}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="Кастомные свойства">
              {registry.length === 0 ? (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">
                  Кастомных свойств пока нет — они появятся здесь по мере поступления данных через API, события или
                  импорт.
                </p>
              ) : (
                registry.map((item) => (
                  <CommandItem
                    key={item.key}
                    value={item.key}
                    onSelect={() => choose({ source: "custom", field: item.key })}
                  >
                    {item.key}
                  </CommandItem>
                ))
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** D-05: event-name combobox (popover + command), free-text fallback. */
function EventCombobox({ eventName, eventNames, onSelect }: { eventName: string; eventNames: string[]; onSelect: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  function choose(name: string) {
    onSelect(name);
    setOpen(false);
    setSearch("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" aria-expanded={open} className="w-48 justify-start">
          {eventName || "Выберите событие"}
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
  );
}

/** D-03: attribute condition row -- field combobox, typed operator select, type-appropriate value input. */
function AttributeConditionRow({
  cond,
  registry,
  onChange,
  onRemove,
}: {
  cond: AttributeCondition;
  registry: PropertyRegistryItem[];
  onChange: (next: AttributeCondition) => void;
  onRemove: () => void;
}) {
  const kind = cond.field ? kindForAttributeCondition(cond, registry) : "string";
  const operators = OPERATORS_BY_KIND[kind];
  const valueKind = valueInputKind(kind, cond.operator);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FieldCombobox
        cond={cond}
        registry={registry}
        onSelect={({ source, field }) => {
          const nextKind =
            source === "standard"
              ? STANDARD_FIELDS.find((f) => f.field === field)?.kind ?? "string"
              : registry.find((r) => r.key === field)?.observedType ?? "string";
          const defaultOperator = OPERATORS_BY_KIND[nextKind][0].value;
          onChange({ ...cond, source, field, operator: defaultOperator, value: undefined });
        }}
      />

      {cond.field ? (
        <>
          <Select
            value={cond.operator}
            onValueChange={(op) => onChange({ ...cond, operator: op as ConditionOperator, value: undefined })}
          >
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {operators.map((op) => (
                <SelectItem key={op.value} value={op.value}>
                  {op.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {valueKind === "subscriptionStatus" ? (
            <Select
              value={typeof cond.value === "string" ? cond.value : ""}
              onValueChange={(v) => onChange({ ...cond, value: v })}
            >
              <SelectTrigger className="w-52">
                <SelectValue placeholder="Значение" />
              </SelectTrigger>
              <SelectContent>
                {SUBSCRIPTION_STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : valueKind === "number" ? (
            <Input
              type="number"
              placeholder="Значение"
              value={typeof cond.value === "number" ? cond.value : ""}
              onChange={(e) => onChange({ ...cond, value: e.target.value === "" ? undefined : Number(e.target.value) })}
              className="w-32"
            />
          ) : valueKind === "date" ? (
            <Input
              type="date"
              placeholder="Значение"
              value={typeof cond.value === "string" ? cond.value : ""}
              onChange={(e) => onChange({ ...cond, value: e.target.value })}
              className="w-40"
            />
          ) : valueKind === "text" ? (
            <Input
              placeholder="Значение"
              value={typeof cond.value === "string" || typeof cond.value === "number" ? String(cond.value) : ""}
              onChange={(e) => onChange({ ...cond, value: e.target.value })}
              className="w-40"
            />
          ) : null}
        </>
      ) : null}

      <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label="Удалить условие">
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

/** D-06: behavioral condition row -- event combobox, count/timeframe selects, conditional numeric inputs. */
function BehavioralConditionRow({
  cond,
  eventNames,
  onChange,
  onRemove,
}: {
  cond: BehavioralCondition;
  eventNames: string[];
  onChange: (next: BehavioralCondition) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <EventCombobox
        eventName={cond.eventName}
        eventNames={eventNames}
        onSelect={(eventName) => onChange({ ...cond, eventName })}
      />

      <Select
        value={cond.countOperator}
        onValueChange={(v) =>
          onChange({
            ...cond,
            countOperator: v as "at_least" | "none",
            count: v === "at_least" ? cond.count ?? 1 : undefined,
          })
        }
      >
        <SelectTrigger className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="at_least">выполнено ≥ N раз</SelectItem>
          <SelectItem value="none">ни разу</SelectItem>
        </SelectContent>
      </Select>

      {cond.countOperator === "at_least" ? (
        <Input
          type="number"
          min={1}
          placeholder="Количество"
          value={cond.count ?? ""}
          onChange={(e) => onChange({ ...cond, count: e.target.value === "" ? undefined : Number(e.target.value) })}
          className="w-24"
        />
      ) : null}

      <Select
        value={cond.timeframe.kind}
        onValueChange={(v) =>
          onChange({
            ...cond,
            timeframe: v === "last_days" ? { kind: "last_days", days: 30 } : { kind: "all_time" },
          })
        }
      >
        <SelectTrigger className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="last_days">за последние N дней</SelectItem>
          <SelectItem value="all_time">за всё время</SelectItem>
        </SelectContent>
      </Select>

      {cond.timeframe.kind === "last_days" ? (
        <Input
          type="number"
          min={1}
          placeholder="Дней"
          value={cond.timeframe.days}
          onChange={(e) => onChange({ ...cond, timeframe: { kind: "last_days", days: Number(e.target.value) || 1 } })}
          className="w-24"
        />
      ) : null}

      <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label="Удалить условие">
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

/**
 * D-01..D-09: two-tier AND/OR segment builder -- groups AND'd together, OR'd
 * conditions within a group. Controlled component: emits the exact
 * SegmentDefinition JSON (version 1) via onChange on every edit. No inline
 * member list here (D-09) -- only the group recap + (Task 3) live count.
 */
export function SegmentBuilder({
  value,
  onChange,
  slug,
}: {
  value: SegmentDefinition;
  onChange: (next: SegmentDefinition) => void;
  slug: string;
}) {
  const registryQuery = useQuery({
    queryKey: ["workspace", slug, "property-registry"],
    queryFn: () => apiGet<PropertyRegistryItem[]>(`/api/workspaces/${slug}/property-registry`),
    enabled: Boolean(slug),
  });
  const eventNamesQuery = useQuery({
    queryKey: ["workspace", slug, "segments", "event-names"],
    queryFn: () => fetchEventNames(slug),
    enabled: Boolean(slug),
  });

  const registry = registryQuery.data ?? [];
  const eventNames = eventNamesQuery.data?.names ?? [];

  // D-08/SEGM-04: debounce the definition, then use the FULL debounced JSON
  // as the queryKey (Pitfall 6) -- stale/out-of-order responses are handled
  // by TanStack Query's cache identity, no manual AbortController needed.
  const debouncedDefinition = useDebouncedValue(value, 300);
  const canPreview = isDefinitionReadyForPreview(debouncedDefinition);

  const previewQuery = useQuery({
    // definition is part of the queryKey (Pitfall 6 stale-response guard).
    queryKey: ["workspace", slug, "segments", "preview-count", debouncedDefinition],
    queryFn: () => fetchPreviewCount(slug, debouncedDefinition),
    enabled: Boolean(slug) && canPreview,
    placeholderData: keepPreviousData,
  });

  // Keep the last successfully computed exact count around even once a
  // later response comes back `{ degraded: true }` -- never blanked to zero.
  const [lastGoodCount, setLastGoodCount] = useState<number | null>(null);
  useEffect(() => {
    if (previewQuery.data && "count" in previewQuery.data) {
      setLastGoodCount(previewQuery.data.count);
    }
  }, [previewQuery.data]);

  const isDegraded = Boolean(previewQuery.data && "degraded" in previewQuery.data && previewQuery.data.degraded);

  function updateGroup(groupIndex: number, nextGroup: SegmentGroup) {
    onChange({ ...value, groups: value.groups.map((g, i) => (i === groupIndex ? nextGroup : g)) });
  }

  function addGroup() {
    onChange({ ...value, groups: [...value.groups, { conditions: [newAttributeCondition()] }] });
  }

  function removeGroup(groupIndex: number) {
    onChange({ ...value, groups: value.groups.filter((_, i) => i !== groupIndex) });
  }

  function addCondition(groupIndex: number, kind: "attribute" | "behavioral") {
    const group = value.groups[groupIndex];
    const nextCondition = kind === "attribute" ? newAttributeCondition() : newBehavioralCondition();
    updateGroup(groupIndex, { conditions: [...group.conditions, nextCondition] });
  }

  function updateCondition(groupIndex: number, conditionIndex: number, next: SegmentCondition) {
    const group = value.groups[groupIndex];
    updateGroup(groupIndex, { conditions: group.conditions.map((c, i) => (i === conditionIndex ? next : c)) });
  }

  function removeCondition(groupIndex: number, conditionIndex: number) {
    const group = value.groups[groupIndex];
    updateGroup(groupIndex, { conditions: group.conditions.filter((_, i) => i !== conditionIndex) });
  }

  return (
    <div className="space-y-6">
      {value.groups.map((group, groupIndex) => (
        <div key={groupIndex} className="space-y-2">
          {groupIndex > 0 ? (
            <div className="flex justify-center">
              <Badge variant="secondary" className="text-muted-foreground">
                И
              </Badge>
            </div>
          ) : null}
          <Card className={cn(group.conditions.length === 0 && "border-destructive")}>
            <CardHeader className="space-y-1">
              <div className="flex items-center justify-between">
                <CardTitle className="text-xl">Группа {groupIndex + 1}</CardTitle>
                {value.groups.length > 1 ? (
                  <Button type="button" variant="ghost" size="icon" onClick={() => removeGroup(groupIndex)} aria-label="Удалить группу">
                    <X className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
              {group.conditions.length > 0 ? (
                <p className="text-base text-muted-foreground">{recapForGroup(group, registry)}</p>
              ) : (
                <p className="text-sm text-destructive">Добавьте хотя бы одно условие в каждую группу</p>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              {group.conditions.map((cond, conditionIndex) => (
                <div key={conditionIndex} className="space-y-2">
                  {conditionIndex > 0 ? (
                    <div className="flex justify-start">
                      <Badge variant="secondary" className="text-muted-foreground">
                        ИЛИ
                      </Badge>
                    </div>
                  ) : null}
                  {cond.type === "attribute" ? (
                    <AttributeConditionRow
                      cond={cond}
                      registry={registry}
                      onChange={(next) => updateCondition(groupIndex, conditionIndex, next)}
                      onRemove={() => removeCondition(groupIndex, conditionIndex)}
                    />
                  ) : (
                    <BehavioralConditionRow
                      cond={cond}
                      eventNames={eventNames}
                      onChange={(next) => updateCondition(groupIndex, conditionIndex, next)}
                      onRemove={() => removeCondition(groupIndex, conditionIndex)}
                    />
                  )}
                </div>
              ))}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm">
                    <Plus className="mr-2 h-4 w-4" />
                    Добавить условие
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => addCondition(groupIndex, "attribute")}>По свойству</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => addCondition(groupIndex, "behavioral")}>По событию</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </CardContent>
          </Card>
        </div>
      ))}

      <Button type="button" variant="outline" onClick={addGroup}>
        Добавить группу (И)
      </Button>

      <Card>
        <CardContent className="space-y-1 p-6">
          {!canPreview ? (
            <p className="text-sm text-muted-foreground">
              Заполните условия, чтобы увидеть количество подходящих контактов.
            </p>
          ) : (
            <>
              <p
                className={cn(
                  "flex items-center gap-2 text-display font-semibold",
                  (previewQuery.isFetching || isDegraded) && "opacity-50"
                )}
              >
                {lastGoodCount !== null ? lastGoodCount.toLocaleString("ru-RU") : "—"}
                {previewQuery.isFetching ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : null}
                {isDegraded ? <span className="text-sm font-normal text-amber-800">(устарело)</span> : null}
              </p>
              <p className="text-sm text-muted-foreground">контактов подходит</p>
              {isDegraded ? (
                <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  Не удалось быстро посчитать при таких сложных условиях. Уберите часть условий, чтобы увидеть точное
                  число.
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default SegmentBuilder;
