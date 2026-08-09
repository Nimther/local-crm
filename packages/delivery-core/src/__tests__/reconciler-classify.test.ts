import { describe, expect, it } from "vitest";
import {
  classifyReconcilableSend,
  RECONCILE_RESOLUTION_WINDOW_MS,
  RECONCILE_RESCAN_HORIZON_MS,
  STALE_DISPATCHING_AGE_MS,
  type ReconcileInput,
} from "../reconciler.js";
import type { SendStatus } from "../send-state-machine.js";

/**
 * Phase 11 (DLV-03/DLV-04, plan 11-08, Task 1) -- every `<behavior>` item
 * from 11-08-PLAN.md's Task 1, including the boundary case exactly at each
 * threshold. `NOW` is a fixed `Date`, never `Date.now()` -- ages are
 * expressed as offsets from it so every test is deterministic without fake
 * timers, mirroring the module's own "now is always a parameter" design.
 *
 * The `STALE_DISPATCHING_AGE_MS > SEND_MAX_JOB_LIFETIME_MS` inequality does
 * NOT live in this file: `packages/delivery-core` does not (and must not)
 * depend on `apps/worker`, so that assertion lives in
 * `apps/worker/src/queues/__tests__/send-timing-invariant.test.ts` instead,
 * importing both real constants from their respective packages. See that
 * file's own comment for the mirror-image note. The
 * `RECONCILE_RESCAN_HORIZON_MS > RECONCILE_RESOLUTION_WINDOW_MS` inequality
 * DOES live here, below, since both constants are local to this module.
 */

const NOW = new Date("2026-08-09T12:00:00.000Z");

function msAgo(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function classify(overrides: Partial<ReconcileInput> & { status: SendStatus }): ReturnType<typeof classifyReconcilableSend> {
  return classifyReconcilableSend({
    queuedAt: msAgo(0),
    reconcilingSince: null,
    hasEvidence: false,
    now: NOW,
    ...overrides,
  });
}

describe("classifyReconcilableSend (DLV-03, pure verdict function)", () => {
  describe("dispatching -> sweep_to_reconciling (D-08, stale-dispatching sweep)", () => {
    it("older than STALE_DISPATCHING_AGE_MS yields sweep_to_reconciling", () => {
      const verdict = classify({ status: "dispatching", queuedAt: msAgo(STALE_DISPATCHING_AGE_MS + 1) });
      expect(verdict).toEqual({ kind: "sweep_to_reconciling" });
    });

    it("newer than STALE_DISPATCHING_AGE_MS yields hold", () => {
      const verdict = classify({ status: "dispatching", queuedAt: msAgo(STALE_DISPATCHING_AGE_MS - 1) });
      expect(verdict).toEqual({ kind: "hold" });
    });

    it("boundary: age EXACTLY equal to STALE_DISPATCHING_AGE_MS still holds (strict > required to sweep)", () => {
      const verdict = classify({ status: "dispatching", queuedAt: msAgo(STALE_DISPATCHING_AGE_MS) });
      expect(verdict).toEqual({ kind: "hold" });
    });

    it("hasEvidence is irrelevant to a dispatching row's verdict", () => {
      const verdict = classify({
        status: "dispatching",
        queuedAt: msAgo(STALE_DISPATCHING_AGE_MS + 1),
        hasEvidence: true,
      });
      expect(verdict).toEqual({ kind: "sweep_to_reconciling" });
    });
  });

  describe("reconciling -> resolve_sent (evidence found, regardless of age)", () => {
    it("fresh reconciling row with evidence resolves to sent", () => {
      const verdict = classify({ status: "reconciling", reconcilingSince: msAgo(0), hasEvidence: true });
      expect(verdict).toEqual({ kind: "resolve_sent" });
    });

    it("reconciling row PAST the resolution window with evidence still resolves to sent, not unknown", () => {
      const verdict = classify({
        status: "reconciling",
        reconcilingSince: msAgo(RECONCILE_RESOLUTION_WINDOW_MS * 10),
        hasEvidence: true,
      });
      expect(verdict).toEqual({ kind: "resolve_sent" });
    });
  });

  describe("reconciling -> resolve_unknown (resolution window elapsed, no evidence)", () => {
    it("older than RECONCILE_RESOLUTION_WINDOW_MS with no evidence yields resolve_unknown", () => {
      const verdict = classify({
        status: "reconciling",
        reconcilingSince: msAgo(RECONCILE_RESOLUTION_WINDOW_MS + 1),
        hasEvidence: false,
      });
      expect(verdict).toEqual({ kind: "resolve_unknown" });
    });

    it("inside the resolution window with no evidence yields hold", () => {
      const verdict = classify({
        status: "reconciling",
        reconcilingSince: msAgo(RECONCILE_RESOLUTION_WINDOW_MS - 1),
        hasEvidence: false,
      });
      expect(verdict).toEqual({ kind: "hold" });
    });

    it("boundary: age EXACTLY equal to RECONCILE_RESOLUTION_WINDOW_MS still holds (strict > required to resolve_unknown)", () => {
      const verdict = classify({
        status: "reconciling",
        reconcilingSince: msAgo(RECONCILE_RESOLUTION_WINDOW_MS),
        hasEvidence: false,
      });
      expect(verdict).toEqual({ kind: "hold" });
    });

    it("a null reconcilingSince falls back to queuedAt for the age computation rather than holding forever", () => {
      const verdict = classify({
        status: "reconciling",
        queuedAt: msAgo(RECONCILE_RESOLUTION_WINDOW_MS + 1),
        reconcilingSince: null,
        hasEvidence: false,
      });
      expect(verdict).toEqual({ kind: "resolve_unknown" });
    });

    it("a null reconcilingSince with a queuedAt still inside the window holds", () => {
      const verdict = classify({
        status: "reconciling",
        queuedAt: msAgo(RECONCILE_RESOLUTION_WINDOW_MS - 1),
        reconcilingSince: null,
        hasEvidence: false,
      });
      expect(verdict).toEqual({ kind: "hold" });
    });
  });

  describe("unknown -> resolve_sent (late evidence within the re-scan horizon, D-04)", () => {
    it("evidence within RECONCILE_RESCAN_HORIZON_MS (measured from queuedAt) yields resolve_sent", () => {
      const verdict = classify({
        status: "unknown",
        queuedAt: msAgo(RECONCILE_RESCAN_HORIZON_MS - 1),
        hasEvidence: true,
      });
      expect(verdict).toEqual({ kind: "resolve_sent" });
    });

    it("boundary: age EXACTLY equal to RECONCILE_RESCAN_HORIZON_MS is still INSIDE the horizon (inclusive) and resolves to sent", () => {
      const verdict = classify({
        status: "unknown",
        queuedAt: msAgo(RECONCILE_RESCAN_HORIZON_MS),
        hasEvidence: true,
      });
      expect(verdict).toEqual({ kind: "resolve_sent" });
    });

    it("evidence PAST the horizon yields hold -- the row is immutable after the horizon", () => {
      const verdict = classify({
        status: "unknown",
        queuedAt: msAgo(RECONCILE_RESCAN_HORIZON_MS + 1),
        hasEvidence: true,
      });
      expect(verdict).toEqual({ kind: "hold" });
    });

    it("no evidence yields hold at any age, including well past the horizon", () => {
      const verdict = classify({
        status: "unknown",
        queuedAt: msAgo(RECONCILE_RESCAN_HORIZON_MS * 10),
        hasEvidence: false,
      });
      expect(verdict).toEqual({ kind: "hold" });
    });

    it("no evidence yields hold even freshly-unknown", () => {
      const verdict = classify({ status: "unknown", queuedAt: msAgo(0), hasEvidence: false });
      expect(verdict).toEqual({ kind: "hold" });
    });
  });

  describe("terminal statuses (sent/failed/excluded) always hold", () => {
    for (const status of ["sent", "failed", "excluded"] as const) {
      it(`${status} holds regardless of age or evidence`, () => {
        expect(classify({ status, queuedAt: msAgo(RECONCILE_RESCAN_HORIZON_MS * 10), hasEvidence: true })).toEqual({
          kind: "hold",
        });
        expect(classify({ status, queuedAt: msAgo(0), hasEvidence: false })).toEqual({ kind: "hold" });
      });
    }
  });

  describe("no input combination ever yields a verdict that would write 'failed'", () => {
    const statuses: SendStatus[] = ["dispatching", "sent", "failed", "excluded", "reconciling", "unknown"];
    const ages = [0, RECONCILE_RESOLUTION_WINDOW_MS, RECONCILE_RESCAN_HORIZON_MS, STALE_DISPATCHING_AGE_MS];

    it("exhaustively, across every status/evidence/age combination, kind is never 'resolve_failed'", () => {
      for (const status of statuses) {
        for (const hasEvidence of [true, false]) {
          for (const ageMs of ages) {
            const verdict = classifyReconcilableSend({
              status,
              queuedAt: msAgo(ageMs),
              reconcilingSince: msAgo(ageMs),
              hasEvidence,
              now: NOW,
            });
            expect(["resolve_sent", "resolve_unknown", "sweep_to_reconciling", "hold"]).toContain(verdict.kind);
          }
        }
      }
    });
  });

  describe("window/horizon constant invariants", () => {
    it("RECONCILE_RESCAN_HORIZON_MS > RECONCILE_RESOLUTION_WINDOW_MS", () => {
      expect(RECONCILE_RESCAN_HORIZON_MS).toBeGreaterThan(RECONCILE_RESOLUTION_WINDOW_MS);
    });
  });
});
