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

export type AutosaveState = "idle" | "saving" | "error";

/**
 * Pure derivation of the toolbar's autosave indicator (06-21/WR-05). Kept
 * standalone (no hook state) so the "must not read saved after a failed
 * save" behavior is pinned by a plain unit test with no jsdom/@testing-library
 * install: an in-flight save always wins ("saving"); otherwise a failed save
 * with unsaved changes still pending is "error" (never "idle"/«Сохранено»);
 * anything else — including a stale error with nothing left unsaved — settles
 * to "idle".
 */
export function deriveAutosaveState({
  isPending,
  isError,
  dirty,
}: {
  isPending: boolean;
  isError: boolean;
  dirty: boolean;
}): AutosaveState {
  if (isPending) return "saving";
  if (isError && dirty) return "error";
  return "idle";
}

/** Bounded single delayed retry after a failed autosave (T-06-21-02: never a hot loop). */
const RETRY_DELAY_MS = 4000;

/**
 * Debounced (1s) draft autosave (06-UI-SPEC Canvas chrome): serializes the
 * current canvas into the shared flowDefinitionSchema shape and PATCHes
 * /flows/:id whenever the debounced serialization differs from the last
 * saved one. No manual save button — the toolbar renders `saveState` as
 * «Сохранено» (idle) / «Сохранение…» (saving) / an honest not-saved/retrying
 * state (error), never a toast.
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

  const dirty = lastSavedRef.current !== json;

  // T-06-21-01/WR-05: a failed save is not left un-retried until the user
  // happens to make another edit — schedule a single bounded retry
  // (T-06-21-02: never a hot loop) of the SAME target that just failed.
  // Cleared on unmount or as soon as anything about the failure/target
  // changes, so at most one retry is ever pending at a time.
  useEffect(() => {
    if (!mutation.isError || !dirty) return;
    const target = debouncedJson;
    const id = setTimeout(() => {
      lastSavedRef.current = target;
      mutateRef.current(
        { definition: JSON.parse(target) as FlowDefinition },
        {
          onError: () => {
            lastSavedRef.current = "";
          },
        }
      );
    }, RETRY_DELAY_MS);
    return () => clearTimeout(id);
  }, [mutation.isError, dirty, debouncedJson]);

  const saveState = deriveAutosaveState({ isPending: mutation.isPending, isError: mutation.isError, dirty });

  return { saveState, serialized };
}
