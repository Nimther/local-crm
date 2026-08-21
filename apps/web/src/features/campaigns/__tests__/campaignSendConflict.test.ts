import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";
import { CAMPAIGN_STATUS_LABELS } from "../CampaignStatusBadge";
import { classifySendError, illegalTransitionCopy, VERSION_CONFLICT_COPY } from "../campaignSendConflict";

// DOM/component testing (e.g. asserting the dialog stays open, or the toast
// fires) is intentionally out of scope for this lane -- no jsdom in
// apps/web's vitest environment. That interaction proof is
// e2e/campaign-template-correctness.spec.ts (plan Task 2) plus the human
// checkpoint (plan Task 3). This file only proves the pure classification +
// copy composition, mirroring segmentSaveGate.test.ts's role.

describe("classifySendError", () => {
  it("returns 'version_conflict' for a 409 ApiError whose body carries that code", () => {
    const err = new ApiError(409, "stale", { error: "stale", code: "version_conflict", currentVersion: 3 });
    expect(classifySendError(err)).toBe("version_conflict");
  });

  it("returns 'illegal_transition' for a 409 ApiError whose body carries that code", () => {
    const err = new ApiError(409, "wrong state", { error: "wrong state", code: "illegal_transition" });
    expect(classifySendError(err)).toBe("illegal_transition");
  });

  it("returns null for a 409 whose body has no code", () => {
    const err = new ApiError(409, "stale", { error: "stale" });
    expect(classifySendError(err)).toBeNull();
  });

  it("returns null for a 409 whose body carries an unrecognised code", () => {
    const err = new ApiError(409, "stale", { error: "stale", code: "some_other_code" });
    expect(classifySendError(err)).toBeNull();
  });

  it("returns null for a 422 carrying the 'incomplete' code -- generic copy must keep covering it", () => {
    const err = new ApiError(422, "incomplete", { error: "incomplete", code: "incomplete" });
    expect(classifySendError(err)).toBeNull();
  });

  it("returns null for a 500", () => {
    const err = new ApiError(500, "boom", { error: "boom" });
    expect(classifySendError(err)).toBeNull();
  });

  it("returns null for a plain Error that is not an ApiError", () => {
    expect(classifySendError(new Error("network down"))).toBeNull();
  });

  it("returns null for a 409 whose body is a string, not thrown", () => {
    const err = new ApiError(409, "stale", "not json");
    expect(() => classifySendError(err)).not.toThrow();
    expect(classifySendError(err)).toBeNull();
  });

  it("returns null for a 409 whose body is undefined, not thrown", () => {
    const err = new ApiError(409, "stale", undefined);
    expect(() => classifySendError(err)).not.toThrow();
    expect(classifySendError(err)).toBeNull();
  });
});

describe("illegalTransitionCopy", () => {
  it("names the campaign's real current state using the badge's own label", () => {
    expect(illegalTransitionCopy("sending")).toContain(CAMPAIGN_STATUS_LABELS.sending);
    expect(illegalTransitionCopy("sending")).toContain("Отправляется");
    expect(illegalTransitionCopy("canceled")).toContain(CAMPAIGN_STATUS_LABELS.canceled);
    expect(illegalTransitionCopy("canceled")).toContain("Отменена");
  });

  it.each(["draft", "scheduled", "sending", "sent", "canceled"] as const)(
    "renders the '%s' label from the shared status-label map, never an independently-worded name",
    (status) => {
      expect(illegalTransitionCopy(status)).toContain(CAMPAIGN_STATUS_LABELS[status]);
    }
  );
});

describe("VERSION_CONFLICT_COPY", () => {
  it("matches D-08's exact wording", () => {
    expect(VERSION_CONFLICT_COPY).toBe("Кампания была изменена — данные обновлены, проверьте и повторите");
  });
});
