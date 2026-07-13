import { createContext, memo, useContext } from "react";
import { Handle, Position, type Node, type NodeProps, type NodeTypes } from "@xyflow/react";
import { Clock, GitBranch, LogOut, Mail, MoreVertical, Zap, type LucideIcon } from "lucide-react";
import type { FlowDelay } from "@mega-crm/flows-core";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { computeRate } from "@/lib/rates";
import { cn } from "@/lib/utils";

/** The five canvas node types (FLOW-01, 06-UI-SPEC Canvas & Node Visual Language). */
export type FlowCanvasNodeType = "trigger" | "delay" | "branch" | "send" | "exit";

/**
 * Per-node config edited by NodeConfigPanel. A superset of the flows-core
 * node fields (minus id/type/position) plus display-name caches
 * (segmentName/templateName) that are NEVER serialized into the draft
 * definition — useAutosaveDraft rebuilds the flowDefinitionSchema shape
 * explicitly, field by field.
 */
export type CanvasNodeConfig = {
  // trigger
  triggerType?: "event" | "segment";
  eventName?: string;
  // trigger (segment mode) + branch
  segmentId?: string;
  /** Display cache only — not part of the persisted definition. */
  segmentName?: string;
  // delay
  delay?: FlowDelay;
  // send
  templateId?: string;
  /** Display cache only — not part of the persisted definition. */
  templateName?: string;
  fromSenderId?: string;
  fromEmail?: string;
};

/**
 * ANLT-02/D-03: per-node metrics badge data, sourced from the single
 * GET /flows/:id/analytics response (keyed by nodeId) and threaded in by
 * FlowCanvas. `sent`/`delivered` are only present for send nodes.
 */
export type CanvasNodeMetrics = {
  contactCount: number;
  sent?: number;
  delivered?: number;
};

export type CanvasNodeData = {
  config: CanvasNodeConfig;
  /**
   * Russian publish-blocker / unconfigured message injected by FlowCanvas
   * from validateFlowDefinition codes (+ schema-incompleteness checks).
   * Non-null drives the ring-2 ring-destructive state + red dot + tooltip.
   */
  invalidMessage?: string | null;
  /** ANLT-02/D-03: read-only metric badge overlay data, or null/undefined before analytics loads. */
  metrics?: CanvasNodeMetrics | null;
};

export type CanvasNode = Node<CanvasNodeData>;

/** Icon chips per 06-UI-SPEC — these five hues appear ONLY inside the 24px header chip. */
export const NODE_TYPE_META: Record<
  FlowCanvasNodeType,
  { label: string; icon: LucideIcon; chipClass: string }
> = {
  trigger: { label: "Триггер", icon: Zap, chipClass: "bg-indigo-50 text-indigo-600" },
  delay: { label: "Задержка", icon: Clock, chipClass: "bg-amber-50 text-amber-600" },
  // The one net-new hue this phase introduces — chips only, never general UI.
  branch: { label: "Условие", icon: GitBranch, chipClass: "bg-blue-50 text-blue-600" },
  send: { label: "Отправить письмо", icon: Mail, chipClass: "bg-green-50 text-green-600" },
  exit: { label: "Выход", icon: LogOut, chipClass: "bg-neutral-100 text-neutral-500" },
};

/** Node-level actions (overflow menu) provided by FlowCanvas. */
export const NodeActionsContext = createContext<{
  deleteNode: (id: string) => void;
  duplicateNode: (id: string) => void;
} | null>(null);

const UNCONFIGURED = "Не настроено";

function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const DELAY_UNITS: Record<"minutes" | "hours" | "days", [string, string, string]> = {
  minutes: ["минута", "минуты", "минут"],
  hours: ["час", "часа", "часов"],
  days: ["день", "дня", "дней"],
};

const WEEKDAYS_RU = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

/** «14 дней» / «Ждать до 09:00 (пн)» — config-summary line for a delay node. */
export function formatDelaySummary(delay: FlowDelay): string {
  if (delay.kind === "fixed") {
    const [one, few, many] = DELAY_UNITS[delay.unit];
    return `${delay.amount} ${pluralRu(delay.amount, one, few, many)}`;
  }
  const hh = String(Math.floor(delay.timeOfDay / 60)).padStart(2, "0");
  const mm = String(delay.timeOfDay % 60).padStart(2, "0");
  const day = delay.dayOfWeek === undefined ? "" : ` (${WEEKDAYS_RU[delay.dayOfWeek]})`;
  return `Ждать до ${hh}:${mm}${day}`;
}

/**
 * ANLT-02/D-03: the read-only metric badge overlay -- «{count} прошли» for
 * every node type, plus a delivered% sub-badge for send nodes. Absolutely
 * positioned over the card's top-right corner (existing 4px/xs chip inset
 * convention, no new hue); `pointer-events-none` on the wrapper keeps the
 * overlay from intercepting canvas drag/select, with `pointer-events-auto`
 * re-enabled only on the small pills themselves so the tooltip still opens
 * on hover.
 */
function MetricsBadge({ metrics, nodeType }: { metrics: CanvasNodeMetrics; nodeType: FlowCanvasNodeType }) {
  const isSend = nodeType === "send";
  const deliveredRate = isSend ? computeRate(metrics.delivered ?? 0, metrics.sent ?? 0) : null;
  const deliveredLabel = deliveredRate === null ? "—" : `${deliveredRate}%`;
  const tooltipText = isSend
    ? `${metrics.contactCount} прошли · ${deliveredLabel} доставлено`
    : `${metrics.contactCount} прошли`;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="pointer-events-none absolute -right-2 -top-2 flex items-center gap-1">
            <span className="pointer-events-auto rounded-full border border-neutral-200 bg-white px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-neutral-600 shadow-sm">
              {metrics.contactCount} прошли
            </span>
            {isSend ? (
              <span className="pointer-events-auto rounded-full border border-neutral-200 bg-white px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-green-600 shadow-sm">
                {deliveredLabel}
              </span>
            ) : null}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltipText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Shared 240px card shell (06-UI-SPEC Node card anatomy): header icon chip +
 * title + overflow menu, body config summary, selected → ring-primary,
 * invalid-for-publish → ring-destructive + red dot + tooltip. `metrics`
 * (ANLT-02/D-03) renders the read-only badge overlay when present.
 */
function NodeShell({
  id,
  type,
  selected,
  summary,
  invalidMessage,
  metrics,
  canDuplicate = true,
  children,
}: {
  id: string;
  type: FlowCanvasNodeType;
  selected: boolean | undefined;
  summary: string | null;
  invalidMessage: string | null | undefined;
  metrics?: CanvasNodeMetrics | null;
  canDuplicate?: boolean;
  children?: React.ReactNode;
}) {
  const meta = NODE_TYPE_META[type];
  const Icon = meta.icon;
  const actions = useContext(NodeActionsContext);

  return (
    <div
      className={cn(
        "relative w-60 rounded-lg border border-neutral-200 bg-white shadow-sm",
        selected && "ring-2 ring-primary",
        invalidMessage && "ring-2 ring-destructive"
      )}
    >
      {metrics ? <MetricsBadge metrics={metrics} nodeType={type} /> : null}
      <div className="flex items-center gap-2 px-4 pt-3">
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded", meta.chipClass)}>
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{meta.label}</span>
        {invalidMessage ? (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span aria-label={invalidMessage} className="h-2 w-2 shrink-0 rounded-full bg-destructive" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-64">
                {invalidMessage}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        {actions ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="nodrag h-6 w-6 shrink-0 text-muted-foreground"
                aria-label="Действия с узлом"
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canDuplicate ? (
                <DropdownMenuItem onSelect={() => actions.duplicateNode(id)}>Дублировать узел</DropdownMenuItem>
              ) : null}
              <DropdownMenuItem className="text-destructive" onSelect={() => actions.deleteNode(id)}>
                Удалить узел
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div className="px-4 pb-3 pt-1">
        <p className={cn("truncate text-sm", summary ? "text-muted-foreground" : "text-neutral-400")}>
          {summary ?? UNCONFIGURED}
        </p>
      </div>
      {children}
    </div>
  );
}

const handleClass = "!h-2.5 !w-2.5 !border-2 !border-white !bg-neutral-400";

const TriggerNode = memo(function TriggerNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { config } = data;
  const summary =
    config.triggerType === "event" && config.eventName
      ? `Событие: ${config.eventName}`
      : config.triggerType === "segment" && config.segmentId
        ? `Сегмент: ${config.segmentName ?? "выбран"}`
        : null;
  return (
    <NodeShell id={id} type="trigger" selected={selected} summary={summary} invalidMessage={data.invalidMessage} metrics={data.metrics} canDuplicate={false}>
      <Handle type="source" position={Position.Bottom} className={handleClass} />
    </NodeShell>
  );
});

const DelayNode = memo(function DelayNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const summary = data.config.delay ? formatDelaySummary(data.config.delay) : null;
  return (
    <NodeShell id={id} type="delay" selected={selected} summary={summary} invalidMessage={data.invalidMessage} metrics={data.metrics}>
      <Handle type="target" position={Position.Top} className={handleClass} />
      <Handle type="source" position={Position.Bottom} className={handleClass} />
    </NodeShell>
  );
});

const BranchNode = memo(function BranchNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { config } = data;
  const summary = config.segmentId ? `Сегмент: ${config.segmentName ?? "выбран"}` : null;
  return (
    <NodeShell id={id} type="branch" selected={selected} summary={summary} invalidMessage={data.invalidMessage} metrics={data.metrics}>
      {/* D-13: exactly two labelled outgoing paths, bound to sourceHandle yes/no. */}
      <div className="flex items-center justify-between px-8 pb-2">
        <span className="text-xs font-semibold text-green-600">Да</span>
        <span className="text-xs font-semibold text-neutral-500">Нет</span>
      </div>
      <Handle type="target" position={Position.Top} className={handleClass} />
      <Handle type="source" position={Position.Bottom} id="yes" style={{ left: "25%" }} className={handleClass} />
      <Handle type="source" position={Position.Bottom} id="no" style={{ left: "75%" }} className={handleClass} />
    </NodeShell>
  );
});

const SendNode = memo(function SendNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { config } = data;
  const summary = config.templateId ? `Шаблон: ${config.templateName ?? config.templateId}` : null;
  return (
    <NodeShell id={id} type="send" selected={selected} summary={summary} invalidMessage={data.invalidMessage} metrics={data.metrics}>
      <Handle type="target" position={Position.Top} className={handleClass} />
      <Handle type="source" position={Position.Bottom} className={handleClass} />
    </NodeShell>
  );
});

const ExitNode = memo(function ExitNode({ id, data, selected }: NodeProps<CanvasNode>) {
  return (
    <NodeShell id={id} type="exit" selected={selected} summary="Выход из цепочки" invalidMessage={data.invalidMessage} metrics={data.metrics}>
      <Handle type="target" position={Position.Top} className={handleClass} />
    </NodeShell>
  );
});

/** Registered on <ReactFlow nodeTypes={nodeTypes}> — keys match flows-core's node `type` discriminator. */
export const nodeTypes: NodeTypes = {
  trigger: TriggerNode,
  delay: DelayNode,
  branch: BranchNode,
  send: SendNode,
  exit: ExitNode,
};
