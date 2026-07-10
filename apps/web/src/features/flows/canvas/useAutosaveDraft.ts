import { useEffect, useMemo, useRef, useState } from "react";
import type { Edge } from "@xyflow/react";
import { flowNodeSchema, type FlowDefinition, type FlowEdge, type FlowNode } from "@mega-crm/flows-core";

import { useUpdateFlowDraft } from "../api";
import type { CanvasNode } from "./nodeTypes";

export interface SerializedCanvas {
  /** The schema-valid subset of the canvas, in flowDefinitionSchema shape. */
  definition: FlowDefinition;
  /**
   * Node ids whose config is still too incomplete to satisfy flowNodeSchema
   * (a branch without a segment, a delay without a delay config). The server
   * PATCH re-validates via updateFlowDraftSchema and would reject them, so
   * they stay canvas-local until configured — their «Не настроено» ring
   * communicates the pending state.
   */
  incompleteNodeIds: string[];
}

/**
 * React Flow nodes/edges → flowDefinitionSchema shape. Each node candidate is
 * safeParse'd through flowNodeSchema (T-06-10-02: malformed node/edge data is
 * never serialized into the draft) — Zod also strips the canvas-only display
 * caches (segmentName/templateName) since they are not part of the schema.
 * Edges referencing a skipped node are skipped with it.
 */
export function serializeCanvas(nodes: CanvasNode[], edges: Edge[]): SerializedCanvas {
  const parsedNodes: FlowNode[] = [];
  const incompleteNodeIds: string[] = [];

  for (const node of nodes) {
    const candidate = {
      id: node.id,
      type: node.type,
      position: { x: node.position.x, y: node.position.y },
      ...node.data.config,
    };
    const parsed = flowNodeSchema.safeParse(candidate);
    if (parsed.success) {
      parsedNodes.push(parsed.data);
    } else {
      incompleteNodeIds.push(node.id);
    }
  }

  const keptIds = new Set(parsedNodes.map((node) => node.id));
  const parsedEdges: FlowEdge[] = edges
    .filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      // D-13: only a branch's yes/no handles survive; RF's null becomes undefined.
      ...(edge.sourceHandle === "yes" || edge.sourceHandle === "no"
        ? { sourceHandle: edge.sourceHandle }
        : {}),
    }));

  return { definition: { nodes: parsedNodes, edges: parsedEdges }, incompleteNodeIds };
}

export type AutosaveState = "idle" | "saving";

/**
 * Debounced (1s) draft autosave (06-UI-SPEC Canvas chrome): serializes the
 * current canvas into the shared flowDefinitionSchema shape and PATCHes
 * /flows/:id whenever the debounced serialization differs from the last
 * saved one. No manual save button — the toolbar renders `saveState` as
 * «Сохранено» (idle) / «Сохранение…» (saving), never a toast.
 *
 * The mount-time serialization is the baseline: nothing is saved until the
 * user actually changes something.
 */
export function useAutosaveDraft({
  slug,
  flowId,
  nodes,
  edges,
}: {
  slug: string;
  flowId: string;
  nodes: CanvasNode[];
  edges: Edge[];
}): { saveState: AutosaveState; serialized: SerializedCanvas } {
  const serialized = useMemo(() => serializeCanvas(nodes, edges), [nodes, edges]);
  const json = useMemo(() => JSON.stringify(serialized.definition), [serialized]);

  // Trailing 1s debounce (same convention as segments' useDebouncedValue,
  // kept local so the hook is self-contained).
  const [debouncedJson, setDebouncedJson] = useState(json);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedJson(json), 1000);
    return () => clearTimeout(id);
  }, [json]);

  const mutation = useUpdateFlowDraft(slug, flowId);
  const mutateRef = useRef(mutation.mutate);
  mutateRef.current = mutation.mutate;

  const lastSavedRef = useRef(json);

  useEffect(() => {
    if (debouncedJson === lastSavedRef.current) return;
    lastSavedRef.current = debouncedJson;
    mutateRef.current(
      { definition: JSON.parse(debouncedJson) as FlowDefinition },
      {
        // On failure, drop the baseline so the next change (or the next
        // debounce tick after an edit) retries the save — routine autosave
        // never toasts (06-UI-SPEC).
        onError: () => {
          lastSavedRef.current = "";
        },
      }
    );
  }, [debouncedJson]);

  return { saveState: mutation.isPending ? "saving" : "idle", serialized };
}
