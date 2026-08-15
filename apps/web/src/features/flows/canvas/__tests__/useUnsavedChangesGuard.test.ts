import { describe, expect, it } from "vitest";

import { deriveUnsavedChanges } from "../useAutosaveDraft";

// Same no-jsdom/@testing-library-free convention as autosaveState.test.ts --
// this pins the pure `deriveUnsavedChanges` derivation useUnsavedChangesGuard
// and SaveErrorBanner both consume, not the hook/component wiring itself
// (covered end-to-end by e2e/flow-unsaved-changes.spec.ts instead).

const base = { debouncePending: false, isPending: false, isPaused: false, isError: false, dirty: false };

describe("OPS-19/D-13 deriveUnsavedChanges", () => {
  it("reports unsaved when the debounce is still pending", () => {
    expect(deriveUnsavedChanges({ ...base, debouncePending: true })).toBe(true);
  });

  it("reports unsaved when a save is in flight", () => {
    expect(deriveUnsavedChanges({ ...base, isPending: true, dirty: true })).toBe(true);
  });

  it("reports unsaved when the last save errored and changes remain", () => {
    expect(deriveUnsavedChanges({ ...base, isError: true, dirty: true })).toBe(true);
  });

  it("reports unsaved when a mutation is paused (offline) with changes pending", () => {
    expect(deriveUnsavedChanges({ ...base, isPending: true, isPaused: true, dirty: true })).toBe(true);
  });

  it("reports saved only when the debounce has settled, nothing is in flight, and the last save succeeded", () => {
    expect(deriveUnsavedChanges(base)).toBe(false);
  });

  it("reports saved when a prior error exists but nothing is left unsaved (dirty=false)", () => {
    expect(deriveUnsavedChanges({ ...base, isError: true, dirty: false })).toBe(false);
  });
});
