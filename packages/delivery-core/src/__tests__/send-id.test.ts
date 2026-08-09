import { describe, expect, it } from "vitest";
import { SEND_ID_NAMESPACE, deriveCampaignSendId, deriveFlowSendId, uuidv5 } from "../send-id.js";

const UUID_V5_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("send-id.ts (D-09, DLV-05) -- hand-rolled UUIDv5, no `uuid` dependency", () => {
  describe("uuidv5 correctness (the only tripwire standing between this file and a silently-wrong id)", () => {
    it("matches a published, citable RFC 4122 test vector -- NOT self-agreement", () => {
      // Provenance: Python's standard library `uuid` module documentation,
      // https://docs.python.org/3/library/uuid.html -- the worked example
      // given there is:
      //   >>> uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')
      //   UUID('886313e1-3b8a-5372-9b90-0c9aee199e5d')
      // `uuid.NAMESPACE_DNS` is RFC 4122's predefined DNS namespace,
      // 6ba7b810-9dad-11d1-80b4-00c04fd430c8. This vector is independent of
      // this codebase and of `SEND_ID_NAMESPACE` -- it exercises the same
      // `uuidv5(name, namespace)` primitive this module exports, so a
      // bit-twiddling error in the version/variant nibbles, an endianness
      // mistake, or a wrong SHA-1 input framing would fail this assertion
      // even if every other test in this file (which only ever compares the
      // implementation against itself) passed.
      const namespaceDns = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
      expect(uuidv5("python.org", namespaceDns)).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
    });

    it("asserts the version nibble is exactly 5 and the variant is RFC 4122 for several distinct inputs", () => {
      const namespaceDns = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
      const namespaceUrl = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
      const inputs: Array<[string, string]> = [
        ["python.org", namespaceDns],
        ["example.com", namespaceDns],
        ["https://example.com/path", namespaceUrl],
        [SEND_ID_NAMESPACE, namespaceDns],
      ];
      for (const [name, namespace] of inputs) {
        const id = uuidv5(name, namespace);
        expect(id, `${name} over ${namespace}`).toMatch(UUID_V5_SHAPE);
      }
    });

    it("rejects a malformed namespace (throws) rather than silently hashing truncated/garbage bytes", () => {
      expect(() => uuidv5("anything", "not-a-uuid")).toThrow();
      expect(() => uuidv5("anything", "6ba7b810-9dad-11d1-80b4-00c04fd430")).toThrow(); // truncated
      expect(() => uuidv5("anything", "")).toThrow();
      expect(() => uuidv5("anything", "zzzzzzzz-9dad-11d1-80b4-00c04fd430c8")).toThrow(); // non-hex
    });

    it("produces canonical lowercase 8-4-4-4-12 formatting, 36 characters", () => {
      const id = uuidv5("some-name", "6ba7b810-9dad-11d1-80b4-00c04fd430c8");
      expect(id).toHaveLength(36);
      expect(id).toBe(id.toLowerCase());
      expect(id.split("-").map((segment) => segment.length)).toEqual([8, 4, 4, 4, 12]);
    });

    it("is deterministic: the same (name, namespace) pair always yields the same id", () => {
      const namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
      expect(uuidv5("repeat-me", namespace)).toBe(uuidv5("repeat-me", namespace));
    });
  });

  describe("SEND_ID_NAMESPACE (the tripwire constant)", () => {
    it("pins the exact literal value committed in source -- changing it re-derives every existing intent's id", () => {
      expect(SEND_ID_NAMESPACE).toBe("6f1c9a3e-5d2b-4f8a-9c17-2e0b7d4a6591");
    });
  });

  const workspaceId = "11111111-1111-1111-1111-111111111111";
  const campaignId = "22222222-2222-2222-2222-222222222222";
  const contactId = "33333333-3333-3333-3333-333333333333";
  const flowRunId = "44444444-4444-4444-4444-444444444444";
  const nodeId = "send-1";

  describe("deriveCampaignSendId", () => {
    it("matches a fully-worked golden vector for a fixed (workspace, campaign, contact) triple", () => {
      // Golden vector: uuidv5(`campaign:${workspaceId}:${campaignId}:${contactId}`, SEND_ID_NAMESPACE)
      // computed once and pinned here. Any future edit to SEND_ID_NAMESPACE
      // or to the `campaign:` key-composition prefix/order changes this
      // value and must fail this test loudly.
      expect(deriveCampaignSendId(workspaceId, campaignId, contactId)).toBe(
        "31acebd5-daa4-5b32-8fe3-e3337af7dace"
      );
    });

    it("called twice with identical arguments returns the identical string", () => {
      expect(deriveCampaignSendId(workspaceId, campaignId, contactId)).toBe(
        deriveCampaignSendId(workspaceId, campaignId, contactId)
      );
    });

    it("returns a string matching the RFC 4122 UUID format with version nibble 5 and RFC 4122 variant", () => {
      expect(deriveCampaignSendId(workspaceId, campaignId, contactId)).toMatch(UUID_V5_SHAPE);
    });

    it("changing any one of the three arguments changes the result (injectivity)", () => {
      const base = deriveCampaignSendId(workspaceId, campaignId, contactId);
      const otherWorkspace = "99999999-9999-9999-9999-999999999999";
      const otherCampaign = "88888888-8888-8888-8888-888888888888";
      const otherContact = "77777777-7777-7777-7777-777777777777";

      expect(deriveCampaignSendId(otherWorkspace, campaignId, contactId)).not.toBe(base);
      expect(deriveCampaignSendId(workspaceId, otherCampaign, contactId)).not.toBe(base);
      expect(deriveCampaignSendId(workspaceId, campaignId, otherContact)).not.toBe(base);
    });
  });

  describe("deriveFlowSendId", () => {
    it("matches a fully-worked golden vector for a fixed (workspace, flowRun, node) triple", () => {
      expect(deriveFlowSendId(workspaceId, flowRunId, nodeId)).toBe("505228d9-544b-5a52-8627-2168f4b76cd7");
    });

    it("has the same determinism property across its own three arguments", () => {
      expect(deriveFlowSendId(workspaceId, flowRunId, nodeId)).toBe(
        deriveFlowSendId(workspaceId, flowRunId, nodeId)
      );
    });

    it("returns a string matching the RFC 4122 UUID format with version nibble 5 and RFC 4122 variant", () => {
      expect(deriveFlowSendId(workspaceId, flowRunId, nodeId)).toMatch(UUID_V5_SHAPE);
    });

    it("changing any one of the three arguments changes the result (injectivity)", () => {
      const base = deriveFlowSendId(workspaceId, flowRunId, nodeId);
      const otherWorkspace = "99999999-9999-9999-9999-999999999999";
      const otherFlowRun = "66666666-6666-6666-6666-666666666666";
      const otherNode = "send-2";

      expect(deriveFlowSendId(otherWorkspace, flowRunId, nodeId)).not.toBe(base);
      expect(deriveFlowSendId(workspaceId, otherFlowRun, nodeId)).not.toBe(base);
      expect(deriveFlowSendId(workspaceId, flowRunId, otherNode)).not.toBe(base);
    });
  });

  it("a campaign intent and a flow intent sharing the same three argument values produce different ids (namespace prefix keeps the two spaces from colliding)", () => {
    // Deliberately reuses campaignId as the flow's "flowRunId" positional
    // slot, and contactId as the flow's "nodeId" positional slot, so the
    // three raw argument VALUES are identical between the two calls -- only
    // the `campaign:`/`flow:` key-composition prefix differs.
    const campaignSide = deriveCampaignSendId(workspaceId, campaignId, contactId);
    const flowSide = deriveFlowSendId(workspaceId, campaignId, contactId);
    expect(flowSide).not.toBe(campaignSide);
  });
});
