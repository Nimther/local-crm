import { Panel } from "@xyflow/react";

import { cn } from "@/lib/utils";
import { NODE_TYPE_META, type FlowCanvasNodeType } from "./nodeTypes";

/**
 * dataTransfer MIME key for palette → canvas drag-and-drop (FLOW-01's literal
 * drag-and-drop requirement, not click-to-add). FlowCanvas's onDrop reads it.
 */
export const PALETTE_DND_MIME = "application/x-mega-crm-flow-node";

const PALETTE_ORDER: FlowCanvasNodeType[] = ["trigger", "delay", "branch", "send", "exit"];

/**
 * Card-styled node palette docked top-left (06-UI-SPEC Canvas chrome):
 * the five node types as draggable rows (icon chip + Russian label).
 */
export function NodePalette() {
  return (
    <Panel position="top-left">
      <div className="w-56 rounded-lg border border-neutral-200 bg-white p-2 shadow-sm">
        <p className="px-2 py-1 text-sm font-semibold">Узлы</p>
        <div className="space-y-1">
          {PALETTE_ORDER.map((type) => {
            const meta = NODE_TYPE_META[type];
            const Icon = meta.icon;
            return (
              <div
                key={type}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(PALETTE_DND_MIME, type);
                  event.dataTransfer.effectAllowed = "move";
                }}
                className="flex cursor-grab items-center gap-2 rounded-md px-2 py-2 hover:bg-neutral-100 active:cursor-grabbing"
                aria-label={`Перетащите узел «${meta.label}» на холст`}
              >
                <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded", meta.chipClass)}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className="text-sm">{meta.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}
