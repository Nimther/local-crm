import { describe, expect, it } from "vitest";

import { deriveAutosaveState } from "../useAutosaveDraft";

// DOM/component testing (e.g. asserting FlowCanvas's rendered toolbar copy)
// is intentionally out of scope for this lane -- no jsdom/@testing-library
// install exists in apps/web. The pure save-state derivation below is
// covered here; the retry-after-failure behavior is verified against the
// running app per the web lane's pure-function-only convention.

describe("06-21/WR-05 deriveAutosaveState", () => {
  it("returns 'saving' while a save is in flight", () => {
    expect(deriveAutosaveState({ isPending: true, isError: false, dirty: true })).toBe("saving");
  });

  it("returns 'error' after a failed save with unsaved changes pending (the bug case)", () => {
    expect(deriveAutosaveState({ isPending: false, isError: true, dirty: true })).toBe("error");
  });

  it("returns 'idle' when settled with no unsaved changes", () => {
    expect(deriveAutosaveState({ isPending: false, isError: false, dirty: false })).toBe("idle");
  });

  it("returns 'idle' when a prior error exists but nothing is left unsaved", () => {
    expect(deriveAutosaveState({ isPending: false, isError: true, dirty: false })).toBe("idle");
  });
});
