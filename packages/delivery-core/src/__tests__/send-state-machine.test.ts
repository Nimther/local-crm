import { describe, expect, it } from "vitest";
import {
  SEND_STATUSES,
  SEND_STATUS_TRANSITIONS,
  isAllowedTransition,
  writersFor,
  type SendStatus,
} from "../send-state-machine.js";

describe("SEND_STATUSES (DLV-01)", () => {
  it("equals exactly the six documented statuses, in order", () => {
    expect(SEND_STATUSES).toEqual([
      "dispatching",
      "sent",
      "failed",
      "excluded",
      "reconciling",
      "unknown",
    ]);
  });
});

describe("isAllowedTransition (DLV-01)", () => {
  it("dispatching -> reconciling is allowed", () => {
    expect(isAllowedTransition("dispatching", "reconciling")).toBe(true);
  });

  it("reconciling -> failed is NOT allowed (webhook evidence is positive-only, D-01)", () => {
    expect(isAllowedTransition("reconciling", "failed")).toBe(false);
  });

  it("unknown -> failed is NOT allowed either", () => {
    expect(isAllowedTransition("unknown", "failed")).toBe(false);
  });

  it("sent -> reconciling is NOT allowed (sent is terminal)", () => {
    expect(isAllowedTransition("sent", "reconciling")).toBe(false);
  });

  it("unknown -> sent is allowed (late-evidence re-scan within the horizon)", () => {
    expect(isAllowedTransition("unknown", "sent")).toBe(true);
  });

  it("dispatching -> sent and dispatching -> failed are both allowed", () => {
    expect(isAllowedTransition("dispatching", "sent")).toBe(true);
    expect(isAllowedTransition("dispatching", "failed")).toBe(true);
  });

  it("reconciling -> sent and reconciling -> unknown are both allowed", () => {
    expect(isAllowedTransition("reconciling", "sent")).toBe(true);
    expect(isAllowedTransition("reconciling", "unknown")).toBe(true);
  });

  it("every terminal state (sent, failed, excluded) has no allowed outgoing transition", () => {
    const terminalStates: SendStatus[] = ["sent", "failed", "excluded"];
    for (const from of terminalStates) {
      for (const to of SEND_STATUSES) {
        expect(isAllowedTransition(from, to)).toBe(false);
      }
    }
  });
});

describe("writersFor (DLV-01)", () => {
  it("dispatching -> reconciling names exactly two writers: worker and reconciler", () => {
    const writers = writersFor("dispatching", "reconciling");
    expect(writers).toHaveLength(2);
    expect(writers).toContain("worker");
    expect(writers).toContain("reconciler");
  });

  it("every transition other than dispatching -> reconciling has exactly one writer (assumption-delta invariant)", () => {
    for (const from of SEND_STATUSES) {
      for (const transition of SEND_STATUS_TRANSITIONS[from]) {
        if (from === "dispatching" && transition.to === "reconciling") {
          continue; // the one deliberate two-writer transition, asserted above
        }
        expect(transition.writers.length).toBe(1);
      }
    }
  });

  it("every transition whose `from` is reconciling or unknown has reconciler as its sole writer", () => {
    for (const from of ["reconciling", "unknown"] as const) {
      for (const transition of SEND_STATUS_TRANSITIONS[from]) {
        expect(transition.writers).toEqual(["reconciler"]);
      }
    }
  });

  it("returns an empty array for a transition that is not in the matrix", () => {
    expect(writersFor("sent", "reconciling")).toEqual([]);
    expect(writersFor("reconciling", "excluded")).toEqual([]);
    expect(writersFor("excluded", "sent")).toEqual([]);
  });

  it("no entry anywhere has to: 'failed' with from: 'reconciling' or from: 'unknown'", () => {
    // The `.to === "failed"` comparison below is statically unreachable for
    // these two `from` values -- SEND_STATUS_TRANSITIONS' literal types
    // already prove no such entry can exist -- but the runtime assertion
    // still stands on its own as the behavioral spec, with `to` widened via
    // `SendStatus` so the comparison type-checks regardless.
    for (const from of ["reconciling", "unknown"] as const) {
      const toFailed = SEND_STATUS_TRANSITIONS[from].some(
        (t): boolean => (t.to as SendStatus) === "failed"
      );
      expect(toFailed).toBe(false);
    }
  });
});

describe("SEND_STATUS_TRANSITIONS completeness (DLV-01)", () => {
  it("has an entry for every SendStatus value", () => {
    for (const status of SEND_STATUSES) {
      expect(SEND_STATUS_TRANSITIONS[status]).toBeDefined();
    }
  });

  it("terminal statuses (sent, failed, excluded) have empty transition lists", () => {
    expect(SEND_STATUS_TRANSITIONS.sent).toEqual([]);
    expect(SEND_STATUS_TRANSITIONS.failed).toEqual([]);
    expect(SEND_STATUS_TRANSITIONS.excluded).toEqual([]);
  });
});
