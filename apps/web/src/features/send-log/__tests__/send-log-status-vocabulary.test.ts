import { describe, expect, it } from "vitest";

import { SEND_LOG_STATUS_VALUES } from "../api";
import {
  AMBIGUOUS_STATUSES,
  SEND_STATUS_CLASSES,
  SEND_STATUS_LABELS,
  STATUS_OPTIONS,
  STATUS_OPTION_GROUPS,
} from "../SendLogPage";

/**
 * Phase 11 (11-10, DLV-02/DLV-07): the send log's hand-maintained web
 * vocabulary (`SEND_LOG_STATUS_VALUES` in `api.ts`) and the API's own
 * `SEND_LOG_STATUSES` (`apps/api/src/modules/send-log/send-log.repository.ts`)
 * are two independently-edited copies of one closed vocabulary. apps/web has
 * no package dependency on apps/api (a cross-app source import would drag
 * backend-only runtime deps -- `pg`, `@mega-crm/tenant-context` -- into a
 * Vite/node test project), so this drift check instead pins a COPY of the
 * API list here, with this comment naming its source of truth: any change to
 * `SEND_LOG_STATUSES` in `send-log.repository.ts` must be mirrored in BOTH
 * `SEND_LOG_STATUS_VALUES` (api.ts) and the `API_SEND_LOG_STATUSES` copy
 * below, or this test fails.
 */
const API_SEND_LOG_STATUSES = [
  "sent",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "dropped",
  "spam",
  "failed",
  "excluded",
  "reconciling",
  "unknown",
] as const;

describe("send-log status vocabulary (11-10)", () => {
  it("the web vocabulary has exactly the same members as the API's SEND_LOG_STATUSES", () => {
    expect(new Set(SEND_LOG_STATUS_VALUES)).toEqual(new Set(API_SEND_LOG_STATUSES));
    expect(SEND_LOG_STATUS_VALUES.length).toBe(API_SEND_LOG_STATUSES.length);
  });

  /**
   * D-16 (Phase 13): membership alone (the `Set` comparison above) cannot
   * catch a reordered union -- reordering changes nothing at runtime, but it
   * does change what a reviewer believes the two committed copies agree on.
   * Array equality pins order as well as membership between the web's
   * `SEND_LOG_STATUS_VALUES` and this file's committed copy of the API's
   * `SEND_LOG_STATUSES`.
   */
  it("the web vocabulary has exactly the same order as the API's SEND_LOG_STATUSES", () => {
    expect(SEND_LOG_STATUS_VALUES).toEqual(API_SEND_LOG_STATUSES);
  });

  it("has exactly 11 members including reconciling and unknown", () => {
    expect(SEND_LOG_STATUS_VALUES.length).toBe(11);
    expect(SEND_LOG_STATUS_VALUES).toContain("reconciling");
    expect(SEND_LOG_STATUS_VALUES).toContain("unknown");
  });

  it("every SendLogStatus member has a label, a class, and a filter option -- a missing entry can no longer fall through to the raw English status string", () => {
    const optionValues = new Set(STATUS_OPTIONS.map((o) => o.value));
    for (const status of SEND_LOG_STATUS_VALUES) {
      expect(SEND_STATUS_LABELS[status], `missing label for ${status}`).toBeTruthy();
      expect(SEND_STATUS_CLASSES[status], `missing class for ${status}`).toBeTruthy();
      expect(optionValues.has(status), `missing STATUS_OPTIONS entry for ${status}`).toBe(true);
    }
  });

  it("DLV-07 honesty: reconciling/unknown labels and classes never claim success (green) or failure (red)", () => {
    for (const status of ["reconciling", "unknown"] as const) {
      const label = SEND_STATUS_LABELS[status];
      expect(label.toLowerCase()).not.toMatch(/отправлено|доставлено|ошибка|не доставлено/);
      const classes = SEND_STATUS_CLASSES[status];
      expect(classes).not.toMatch(/bg-green|text-green|bg-red|text-destructive/);
    }
  });

  /**
   * UAT gap G-11-2: plan 11-10 appended `reconciling`/`unknown` to the end of a
   * 9-item list, and `CommandList`'s shared `max-h-[300px]` clipped exactly
   * those two below the fold with no scroll affordance -- the filter rendered
   * them, but a marketer could not find them. The fix groups the ambiguous
   * statuses under their own heading (and raises the popover's LOCAL max-h).
   * These assertions pin the property that actually matters: the grouped view
   * the popover renders can never lose or duplicate a status.
   */
  describe("grouped filter view (UAT gap G-11-2)", () => {
    it("covers every STATUS_OPTIONS entry exactly once across all groups", () => {
      const grouped = STATUS_OPTION_GROUPS.flatMap((g) => g.options.map((o) => o.value));
      expect(grouped.length, "a status was dropped from or duplicated across the groups").toBe(
        STATUS_OPTIONS.length
      );
      expect(new Set(grouped).size, "the same status appears in more than one group").toBe(
        grouped.length
      );
      expect(new Set(grouped)).toEqual(new Set(STATUS_OPTIONS.map((o) => o.value)));
    });

    it("puts reconciling and unknown together in their own group, apart from the delivery statuses", () => {
      const ambiguousGroups = STATUS_OPTION_GROUPS.filter((g) =>
        g.options.some((o) => AMBIGUOUS_STATUSES.includes(o.value))
      );
      expect(ambiguousGroups, "the ambiguous statuses must live in exactly one group").toHaveLength(
        1
      );
      expect(new Set(ambiguousGroups[0].options.map((o) => o.value))).toEqual(
        new Set(AMBIGUOUS_STATUSES)
      );
    });

    it("gives every group a non-empty heading -- the heading IS the discoverability affordance", () => {
      for (const group of STATUS_OPTION_GROUPS) {
        expect(group.heading.trim(), "a group without a heading reads as an unlabelled run").toBeTruthy();
        expect(group.options.length, `group "${group.heading}" renders no options`).toBeGreaterThan(0);
      }
    });
  });
});
