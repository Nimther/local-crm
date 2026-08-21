import { describe, expect, it } from "vitest";

import { computeDirtyBlockReason, computeIsDirty, DIRTY_BLOCK_REASON } from "../campaignDirtyState";
import type { CampaignFormSnapshot } from "../campaignDirtyState";

// Pure module, no React -- exercised directly per segmentSaveGate.test.ts's
// precedent. Component-level rendering of the consumers that read this
// module's result lives in campaign-dirty-blocking.test.tsx (plan Task 3).

function snapshot(overrides: Partial<CampaignFormSnapshot> = {}): CampaignFormSnapshot {
  return {
    name: "Spring Sale",
    segmentId: "segment-1",
    templateId: "template-1",
    fromSenderId: "sender-1",
    ...overrides,
  };
}

describe("computeIsDirty / computeDirtyBlockReason", () => {
  it("is clean when the form matches the saved row on all four compared fields", () => {
    const saved = snapshot();
    const form = snapshot();
    expect(computeIsDirty(form, saved)).toBe(false);
    expect(computeDirtyBlockReason(form, saved)).toBeNull();
  });

  it("is dirty when only name differs", () => {
    const saved = snapshot();
    const form = snapshot({ name: "Summer Sale" });
    expect(computeIsDirty(form, saved)).toBe(true);
    expect(computeDirtyBlockReason(form, saved)).toBe(DIRTY_BLOCK_REASON);
  });

  it("is dirty when only segmentId differs", () => {
    const saved = snapshot();
    const form = snapshot({ segmentId: "segment-2" });
    expect(computeIsDirty(form, saved)).toBe(true);
    expect(computeDirtyBlockReason(form, saved)).toBe(DIRTY_BLOCK_REASON);
  });

  it("is dirty when only templateId differs", () => {
    const saved = snapshot();
    const form = snapshot({ templateId: "template-2" });
    expect(computeIsDirty(form, saved)).toBe(true);
    expect(computeDirtyBlockReason(form, saved)).toBe(DIRTY_BLOCK_REASON);
  });

  it("is dirty when only fromSenderId differs", () => {
    const saved = snapshot();
    const form = snapshot({ fromSenderId: "sender-2" });
    expect(computeIsDirty(form, saved)).toBe(true);
    expect(computeDirtyBlockReason(form, saved)).toBe(DIRTY_BLOCK_REASON);
  });

  it("stays clean when fromEmail differs but all four compared fields match (fromEmail is excluded)", () => {
    // CampaignFormSnapshot has no fromEmail field at all -- passing a
    // CampaignResponse-shaped object (structurally compatible, extra
    // fromEmail property) proves the comparison never reads it.
    const saved = { ...snapshot(), fromEmail: "old@example.com" };
    const form = { ...snapshot(), fromEmail: "new@example.com" };
    expect(computeIsDirty(form, saved)).toBe(false);
    expect(computeDirtyBlockReason(form, saved)).toBeNull();
  });

  it("trims the form name before comparing, matching what save actually sends", () => {
    const saved = snapshot({ name: "Spring Sale" });
    const form = snapshot({ name: "  Spring Sale  " });
    expect(computeIsDirty(form, saved)).toBe(false);
    expect(computeDirtyBlockReason(form, saved)).toBeNull();
  });

  it("is dirty when saved templateId is null and form templateId is a string", () => {
    const saved = snapshot({ templateId: null });
    const form = snapshot({ templateId: "template-1" });
    expect(computeIsDirty(form, saved)).toBe(true);
  });

  it("is dirty when saved templateId is a string and form templateId is null", () => {
    const saved = snapshot({ templateId: "template-1" });
    const form = snapshot({ templateId: null });
    expect(computeIsDirty(form, saved)).toBe(true);
  });

  it("is clean when both saved and form templateId are null", () => {
    const saved = snapshot({ templateId: null });
    const form = snapshot({ templateId: null });
    expect(computeIsDirty(form, saved)).toBe(false);
  });

  it("is dirty when saved fromSenderId is null and form fromSenderId is a string", () => {
    const saved = snapshot({ fromSenderId: null });
    const form = snapshot({ fromSenderId: "sender-1" });
    expect(computeIsDirty(form, saved)).toBe(true);
  });

  it("is dirty when saved fromSenderId is a string and form fromSenderId is null", () => {
    const saved = snapshot({ fromSenderId: "sender-1" });
    const form = snapshot({ fromSenderId: null });
    expect(computeIsDirty(form, saved)).toBe(true);
  });

  it("is clean when both saved and form fromSenderId are null", () => {
    const saved = snapshot({ fromSenderId: null });
    const form = snapshot({ fromSenderId: null });
    expect(computeIsDirty(form, saved)).toBe(false);
  });
});
