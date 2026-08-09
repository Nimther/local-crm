import { describe, expect, it } from "vitest";

import { SEND_LOG_STATUS_VALUES } from "../api";
import { SEND_STATUS_CLASSES, SEND_STATUS_LABELS, STATUS_OPTIONS } from "../SendLogPage";

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
});
