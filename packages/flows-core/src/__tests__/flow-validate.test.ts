import { describe, expect, it } from "vitest";

import { validateFlowDefinition } from "../flow-validate.js";
import type { FlowDefinition } from "../flow-definition-schema.js";

const SEGMENT_ID = "11111111-1111-4111-8111-111111111111";

/** trigger --> send(templateId+sender) --> exit: the well-formed baseline. */
function wellFormedFlow(): FlowDefinition {
  return {
    nodes: [
      { id: "trigger-1", type: "trigger", triggerType: "event", eventName: "placed_order", position: { x: 0, y: 0 } },
      {
        id: "send-1",
        type: "send",
        templateId: "d-abc123",
        fromSenderId: "sender-1",
        position: { x: 0, y: 100 },
      },
      { id: "exit-1", type: "exit", position: { x: 0, y: 200 } },
    ],
    edges: [
      { id: "e1", source: "trigger-1", target: "send-1" },
      { id: "e2", source: "send-1", target: "exit-1" },
    ],
  };
}

describe("validateFlowDefinition -- D-17 hard errors", () => {
  it("returns [] for a well-formed trigger -> send -> exit flow", () => {
    expect(validateFlowDefinition(wellFormedFlow())).toEqual([]);
  });

  it("returns no_trigger when there is no trigger node", () => {
    const flow = wellFormedFlow();
    flow.nodes = flow.nodes.filter((n) => n.type !== "trigger");
    flow.edges = flow.edges.filter((e) => e.source !== "trigger-1");

    const errors = validateFlowDefinition(flow);
    expect(errors).toEqual([{ code: "no_trigger" }]);
  });

  it("returns empty_send naming the node id when a send node has no templateId", () => {
    const flow = wellFormedFlow();
    const sendNode = flow.nodes.find((n) => n.type === "send");
    if (sendNode && sendNode.type === "send") {
      delete sendNode.templateId;
    }

    const errors = validateFlowDefinition(flow);
    expect(errors).toEqual([{ code: "empty_send", nodeId: "send-1" }]);
  });

  it("returns empty_send naming the node id when a send node has no sender", () => {
    const flow = wellFormedFlow();
    const sendNode = flow.nodes.find((n) => n.type === "send");
    if (sendNode && sendNode.type === "send") {
      delete sendNode.fromSenderId;
    }

    const errors = validateFlowDefinition(flow);
    expect(errors).toEqual([{ code: "empty_send", nodeId: "send-1" }]);
  });

  it("returns branch_missing_exit when a branch's no-path does not terminate in an exit node", () => {
    const flow: FlowDefinition = {
      nodes: [
        { id: "trigger-1", type: "trigger", triggerType: "event", eventName: "placed_order", position: { x: 0, y: 0 } },
        { id: "branch-1", type: "branch", segmentId: SEGMENT_ID, position: { x: 0, y: 100 } },
        {
          id: "send-yes",
          type: "send",
          templateId: "d-yes",
          fromSenderId: "sender-1",
          position: { x: -100, y: 200 },
        },
        { id: "exit-yes", type: "exit", position: { x: -100, y: 300 } },
        {
          id: "send-no",
          type: "send",
          templateId: "d-no",
          fromSenderId: "sender-1",
          position: { x: 100, y: 200 },
        },
        // "no" path ends here with no exit node following send-no.
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "branch-1" },
        { id: "e2", source: "branch-1", target: "send-yes", sourceHandle: "yes" },
        { id: "e3", source: "send-yes", target: "exit-yes" },
        { id: "e4", source: "branch-1", target: "send-no", sourceHandle: "no" },
      ],
    };

    const errors = validateFlowDefinition(flow);
    expect(errors).toEqual([{ code: "branch_missing_exit", nodeId: "branch-1" }]);
  });

  it("returns [] for an orphan/dead branch that still satisfies the three hard requirements (no v2 linting in v1, D-17)", () => {
    const flow = wellFormedFlow();
    // Add a dead, unreachable branch node with no edges at all -- not
    // connected to the trigger's reachable path, and satisfies nothing
    // about the hard-error checks (no send node under it, no dangling path
    // reachable from the trigger since it's orphaned entirely).
    flow.nodes.push({ id: "branch-orphan", type: "branch", segmentId: SEGMENT_ID, position: { x: 500, y: 500 } });

    const errors = validateFlowDefinition(flow);
    expect(errors).toEqual([]);
  });
});

describe("flowDefinitionSchema -- parsing", () => {
  it("parses a valid trigger/delay/branch/send/exit definition", async () => {
    const { flowDefinitionSchema } = await import("../flow-definition-schema.js");
    const flow: FlowDefinition = {
      nodes: [
        { id: "trigger-1", type: "trigger", triggerType: "event", eventName: "placed_order", position: { x: 0, y: 0 } },
        {
          id: "delay-1",
          type: "delay",
          delay: { kind: "fixed", amount: 2, unit: "days" },
          position: { x: 0, y: 100 },
        },
        { id: "branch-1", type: "branch", segmentId: SEGMENT_ID, position: { x: 0, y: 200 } },
        {
          id: "send-1",
          type: "send",
          templateId: "d-abc123",
          fromSenderId: "sender-1",
          position: { x: 0, y: 300 },
        },
        { id: "exit-1", type: "exit", position: { x: 0, y: 400 } },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "delay-1" },
        { id: "e2", source: "delay-1", target: "branch-1" },
        { id: "e3", source: "branch-1", target: "send-1", sourceHandle: "yes" },
        { id: "e4", source: "send-1", target: "exit-1" },
      ],
    };
    expect(() => flowDefinitionSchema.parse(flow)).not.toThrow();
  });

  it("rejects an unknown node type", async () => {
    const { flowDefinitionSchema } = await import("../flow-definition-schema.js");
    const flow = {
      nodes: [{ id: "n1", type: "unknown_type", position: { x: 0, y: 0 } }],
      edges: [],
    };
    expect(() => flowDefinitionSchema.parse(flow)).toThrow();
  });
});
