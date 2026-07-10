import { useCallback, useEffect, useMemo } from "react";
import { useParams } from "react-router";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  getSmoothStepPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { FlowDefinition } from "@mega-crm/flows-core";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useFlow, type FlowResponse } from "../api";
import { INCOMPLETE_NODE_MESSAGES, NodeConfigPanel, computePublishBlockers } from "./NodeConfigPanel";
import { NodePalette, PALETTE_DND_MIME } from "./NodePalette";
import { useAutosaveDraft } from "./useAutosaveDraft";
import {
  NODE_TYPE_META,
  NodeActionsContext,
  nodeTypes,
  type CanvasNode,
  type CanvasNodeConfig,
  type FlowCanvasNodeType,
} from "./nodeTypes";

// 06-UI-SPEC edge palette: neutral-300 default, indigo-600 (primary) selected.
const EDGE_STROKE = "#D4D4D4";
const EDGE_STROKE_SELECTED = "#4F46E5";

/**
 * Single custom edge type: default bezier-free smoothstep path, 2px stroke,
 * with an inline «Да»/«Нет» label whenever the edge originates from a branch
 * node's yes/no sourceHandle (D-13: a binary branch is meaningless without
 * knowing which edge is which — never render those edges unlabelled).
 */
function LabelledFlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  sourceHandleId,
  markerEnd,
}: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const label = sourceHandleId === "yes" ? "Да" : sourceHandleId === "no" ? "Нет" : null;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ stroke: selected ? EDGE_STROKE_SELECTED : EDGE_STROKE, strokeWidth: 2 }}
      />
      {label ? (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            className={cn(
              "nodrag nopan pointer-events-none absolute text-xs font-semibold",
              label === "Да" ? "text-green-600" : "text-neutral-500"
            )}
          >
            <span className="rounded bg-neutral-50 px-1">{label}</span>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const edgeTypes: EdgeTypes = { flow: LabelledFlowEdge };

/** flows-core definition → React Flow nodes/edges (config = node minus id/type/position). */
export function definitionToCanvas(definition: FlowDefinition): { nodes: CanvasNode[]; edges: Edge[] } {
  const nodes = definition.nodes.map((node): CanvasNode => {
    const { id, type, position, ...config } = node;
    return { id, type, position, data: { config: config as CanvasNodeConfig } };
  });
  const edges = definition.edges.map(
    (edge): Edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      type: "flow",
    })
  );
  return { nodes, edges };
}

/**
 * A freshly created draft has an empty definition — seed a single
 * unconfigured Trigger node (06-UI-SPEC: the node's own «Не настроено»
 * placeholder IS the empty state; no separate empty-state screen).
 */
function initialCanvas(definition: FlowDefinition): { nodes: CanvasNode[]; edges: Edge[] } {
  if (definition.nodes.length > 0) return definitionToCanvas(definition);
  return {
    nodes: [
      {
        id: crypto.randomUUID(),
        type: "trigger",
        position: { x: 240, y: 96 },
        data: { config: { triggerType: "event" } },
      },
    ],
    edges: [],
  };
}

function FlowCanvasInner({
  slug,
  flow,
  focusNodeId,
}: {
  slug: string;
  flow: FlowResponse;
  focusNodeId?: string | null;
}) {
  const initial = initialCanvas(flow.definition);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const { screenToFlowPosition, fitView } = useReactFlow();

  // 06-11/T-06-11-02: the publish-blocker dialog (rendering the SERVER's
  // 422 blocker list) lets the marketer jump straight to the offending node
  // — select it and pan/zoom it into view. A non-matching id (e.g. the
  // flow-scoped "trigger" key, which has no node id) safely no-ops.
  useEffect(() => {
    if (!focusNodeId) return;
    setNodes((nds) => {
      if (!nds.some((node) => node.id === focusNodeId)) return nds;
      return nds.map((node) => ({ ...node, selected: node.id === focusNodeId }));
    });
    if (nodes.some((node) => node.id === focusNodeId)) {
      fitView({ nodes: [{ id: focusNodeId }], duration: 300, maxZoom: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNodeId]);

  // Debounced (1s) draft autosave against PATCH /flows/:id (06-04).
  const { saveState, serialized } = useAutosaveDraft({ slug, flowId: flow.id, nodes, edges });

  // Instant D-17 feedback via the SAME validateFlowDefinition the server
  // re-runs at publish time — client validity is never a trusted flag.
  const blockers = useMemo(() => computePublishBlockers(serialized.definition), [serialized]);

  const invalidByNodeId = useMemo(() => {
    const map = new Map<string, string>();
    for (const blocker of blockers) {
      if (blocker.nodeId) map.set(blocker.nodeId, blocker.message);
    }
    for (const node of nodes) {
      if (map.has(node.id) || !node.type) continue;
      const incompleteMessage = INCOMPLETE_NODE_MESSAGES[node.type as FlowCanvasNodeType];
      if (serialized.incompleteNodeIds.includes(node.id) && incompleteMessage) {
        map.set(node.id, incompleteMessage);
      } else if (node.type === "trigger") {
        const { config } = node.data;
        const configured =
          (config.triggerType === "event" && Boolean(config.eventName)) ||
          (config.triggerType === "segment" && Boolean(config.segmentId));
        if (!configured && incompleteMessage) map.set(node.id, incompleteMessage);
      }
    }
    return map;
  }, [blockers, serialized, nodes]);

  /** Nodes with the computed invalid ring/tooltip injected (state itself stays clean). */
  const displayNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        data: { ...node.data, invalidMessage: invalidByNodeId.get(node.id) ?? null },
      })),
    [nodes, invalidByNodeId]
  );

  const uniqueBlockerMessages = useMemo(() => [...new Set(blockers.map((blocker) => blocker.message))], [blockers]);

  const selectedNode = useMemo(() => displayNodes.find((node) => node.selected) ?? null, [displayNodes]);

  const onConfigChange = useCallback(
    (nodeId: string, config: CanvasNodeConfig) => {
      setNodes((nds) => nds.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, config } } : node)));
    },
    [setNodes]
  );

  const deselectAll = useCallback(() => {
    setNodes((nds) => nds.map((node) => (node.selected ? { ...node, selected: false } : node)));
  }, [setNodes]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge({ ...connection, type: "flow" }, eds));
    },
    [setEdges]
  );

  /**
   * Structural guards at connect time: no self-loops, and at most one
   * outgoing edge per (source, sourceHandle) — a branch gets one «Да» and
   * one «Нет», every other node type a single outgoing path.
   */
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      if (!connection.source || !connection.target) return false;
      if (connection.source === connection.target) return false;
      return !edges.some(
        (edge) => edge.source === connection.source && (edge.sourceHandle ?? null) === (connection.sourceHandle ?? null)
      );
    },
    [edges]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData(PALETTE_DND_MIME) as FlowCanvasNodeType;
      if (!type || !(type in NODE_TYPE_META)) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const node: CanvasNode = {
        id: crypto.randomUUID(),
        type,
        position,
        data: { config: type === "trigger" ? { triggerType: "event" } : {} },
        selected: true,
      };
      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), node]);
    },
    [screenToFlowPosition, setNodes]
  );

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((nds) => nds.filter((node) => node.id !== id));
      setEdges((eds) => eds.filter((edge) => edge.source !== id && edge.target !== id));
    },
    [setNodes, setEdges]
  );

  const duplicateNode = useCallback(
    (id: string) => {
      setNodes((nds) => {
        const original = nds.find((node) => node.id === id);
        if (!original) return nds;
        const copy: CanvasNode = {
          ...original,
          id: crypto.randomUUID(),
          position: { x: original.position.x + 32, y: original.position.y + 32 },
          data: { ...original.data, config: { ...original.data.config } },
          selected: true,
        };
        return [...nds.map((n) => ({ ...n, selected: false })), copy];
      });
    },
    [setNodes]
  );

  return (
    <NodeActionsContext.Provider value={{ deleteNode, duplicateNode }}>
      <div className="h-full min-h-0 flex-1">
        <ReactFlow
          nodes={displayNodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={{ type: "flow" }}
          onDragOver={onDragOver}
          onDrop={onDrop}
          snapToGrid
          snapGrid={[16, 16]}
          fitView
          fitViewOptions={{ maxZoom: 1 }}
          className="bg-neutral-50"
        >
          {/* Dot-grid neutral-200 on the standard neutral-50 page background. */}
          <Background variant={BackgroundVariant.Dots} gap={16} size={1.5} color="#E5E5E5" />
          <Controls position="bottom-left" />
          <MiniMap position="bottom-right" />
          <NodePalette />
          <Panel position="top-right">
            <div className="flex flex-col items-end gap-2">
              {/* Autosave status — Label/meta text, never a toast (06-UI-SPEC). WR-05: an
                  errored-with-unsaved-changes state must read honestly, never «Сохранено». */}
              <span
                className={cn(
                  "rounded bg-white/90 px-2 py-1 text-sm",
                  saveState === "error" ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {saveState === "saving" ? "Сохранение…" : saveState === "error" ? "Не сохранено — повтор…" : "Сохранено"}
              </span>
              {uniqueBlockerMessages.length > 0 ? (
                <div className="w-72 rounded-lg border border-neutral-200 bg-white p-3 shadow-sm">
                  <p className="text-sm font-semibold">Блокирует публикацию</p>
                  <ul className="mt-1 space-y-1">
                    {uniqueBlockerMessages.map((message) => (
                      <li key={message} className="text-sm text-destructive">
                        {message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </Panel>
        </ReactFlow>
      </div>
      <NodeConfigPanel slug={slug} node={selectedNode} onConfigChange={onConfigChange} onClose={deselectAll} />
    </NodeActionsContext.Provider>
  );
}

/**
 * Canvas flow builder (FLOW-01) for /w/{slug}/flows/:id — loads the flow's
 * best-current-editable definition via the draft API (06-04) and hands it to
 * the React Flow canvas. Remounts the canvas per flow id so local canvas
 * state never leaks between flows.
 *
 * `focusNodeId` (06-11): when embedded inside FlowDetailPage, the publish
 * dialog's server-returned blocker list can pass a node id here to select +
 * pan/zoom it into view — optional, defaults to no-op for any other caller.
 */
export function FlowCanvas({ focusNodeId }: { focusNodeId?: string | null } = {}) {
  const { slug = "", id = "" } = useParams<{ slug: string; id: string }>();
  const flowQuery = useFlow(slug, id);

  if (flowQuery.isLoading) {
    return (
      <div className="space-y-4 p-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (flowQuery.isError || !flowQuery.data) {
    return (
      <div className="p-8">
        <p className="text-sm text-muted-foreground">
          Не удалось загрузить цепочку. Попробуйте ещё раз — если ошибка повторится, обновите страницу.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <ReactFlowProvider>
        <FlowCanvasInner key={flowQuery.data.id} slug={slug} flow={flowQuery.data} focusNodeId={focusNodeId} />
      </ReactFlowProvider>
    </div>
  );
}

export default FlowCanvas;
