import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * Pure derivation of the toolbar's autosave indicator (06-21/WR-05, extended
 * 06-24 for UAT Test 11). Kept standalone (no hook state) so the "must not
 * read saved after a failed save" behavior is pinned by a plain unit test
 * with no jsdom/@testing-library install: a mutation PAUSED by TanStack
 * Query's offline networkMode ('online' default) never invokes the PATCH
 * mutationFn and never errors — it just sits at isPending:true indefinitely
 * — so a paused save must surface the honest not-saved/retrying state rather
 * than an indefinite «Сохранение…» (checked first, before the isPending
 * branch below would otherwise claim it as "saving"). TanStack Query resumes
 * a paused mutation automatically on reconnect, which re-fires the save and
 * lets this settle back to "idle" without any further user edit. An in-flight
 * ONLINE save still wins as "saving"; a failed save with unsaved changes
 * still pending is "error" (never "idle"/«Сохранено»); anything else —
 * including a stale error with nothing left unsaved — settles to "idle".
 */
export function deriveAutosaveState({
  isPending,
  isPaused,
  isError,
  dirty,
}: {
  isPending: boolean;
  isPaused: boolean;
  isError: boolean;
  dirty: boolean;
}): AutosaveState {
  if (isPending && isPaused) return "error";
  if (isPending) return "saving";
  if (isError && dirty) return "error";
  return "idle";
}

/**
 * OPS-19/D-13: is there work the server has not accepted yet, from the SAME
 * inputs `deriveAutosaveState` already reads plus a debounce-pending flag.
 * Kept standalone from `deriveAutosaveState` on purpose -- that function's
 * three-state output drives the toolbar label and its behavior is pinned by
 * existing tests (WR-05/T-06-21-02); this is a narrower boolean answering a
 * different question ("unsaved?" vs "what should the label read?"), cheaper
 * to add than to widen a tested contract.
 *
 * - The debounce still pending (the live serialization differs from the
 *   debounced one) is itself unsaved work -- the PATCH has not even fired yet.
 * - A save in flight (`isPending`) is unsaved by definition, including the
 *   paused-offline case (`isPending && isPaused`): TanStack Query's mutation
 *   is still "pending" while paused, so `isPending` alone already covers it.
 * - A failed save with changes still outstanding (`isError && dirty`) is
 *   unsaved even with nothing in flight right now -- this is exactly the
 *   state `SaveErrorBanner` renders for.
 * - Anything else -- debounce settled, nothing in flight, last save
 *   succeeded (or a stale error with nothing left to save) -- is saved.
 */
export function deriveUnsavedChanges({
  debouncePending,
  isPending,
  isPaused,
  isError,
  dirty,
}: {
  debouncePending: boolean;
  isPending: boolean;
  isPaused: boolean;
  isError: boolean;
  dirty: boolean;
}): boolean {
  return debouncePending || isPending || isPaused || (isError && dirty);
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
}): { saveState: AutosaveState; serialized: SerializedCanvas; unsaved: boolean; retry: () => void } {
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

  const saveState = deriveAutosaveState({
    isPending: mutation.isPending,
    isPaused: mutation.isPaused,
    isError: mutation.isError,
    dirty,
  });

  const unsaved = deriveUnsavedChanges({
    debouncePending: json !== debouncedJson,
    isPending: mutation.isPending,
    isPaused: mutation.isPaused,
    isError: mutation.isError,
    dirty,
  });

  // OPS-19: manual retry from `SaveErrorBanner` -- re-fires the SAME target
  // immediately, without waiting for another edit or for the bounded
  // `RETRY_DELAY_MS` delayed retry above. Mirrors that retry's own
  // onError/baseline-reset shape exactly.
  const retry = useCallback(() => {
    const target = debouncedJson;
    lastSavedRef.current = target;
    mutateRef.current(
      { definition: JSON.parse(target) as FlowDefinition },
      {
        onError: () => {
          lastSavedRef.current = "";
        },
      }
    );
  }, [debouncedJson]);

  return { saveState, serialized, unsaved, retry };
}
