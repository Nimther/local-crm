import { describe, expect, it } from "vitest";

import { DEAD_LETTER_RETENTION_DAYS_FLOOR, parseWorkerEnv } from "../../env.js";

/**
 * Gap-closure plan 22-12 (PRG-02), Task 1: `DEAD_LETTER_RETENTION_DAYS`'s
 * boot-time invariant, driven directly through `parseWorkerEnv` exactly the
 * way `workspace-purge.test.ts`'s own "retention floor" case drives
 * `WORKSPACE_PURGE_RETENTION_DAYS` -- `parseWorkerEnv` is pure and takes the
 * source object, so this never mutates `process.env`.
 */
describe("DEAD_LETTER_RETENTION_DAYS env invariant (Task 1)", () => {
  it("defaults to 30 when absent", () => {
    const parsed = parseWorkerEnv({});
    expect(parsed.DEAD_LETTER_RETENTION_DAYS).toBe(30);
  });

  it("throws naming the variable when below the floor", () => {
    expect(() => parseWorkerEnv({ DEAD_LETTER_RETENTION_DAYS: "6" })).toThrow(/DEAD_LETTER_RETENTION_DAYS/);
  });

  it("throws naming both variables when it exceeds WORKSPACE_PURGE_RETENTION_DAYS", () => {
    expect(() =>
      parseWorkerEnv({ DEAD_LETTER_RETENTION_DAYS: "60", WORKSPACE_PURGE_RETENTION_DAYS: "30" }),
    ).toThrow(/DEAD_LETTER_RETENTION_DAYS[\s\S]*WORKSPACE_PURGE_RETENTION_DAYS|WORKSPACE_PURGE_RETENTION_DAYS[\s\S]*DEAD_LETTER_RETENTION_DAYS/);
  });

  it("succeeds when strictly below the purge retention window", () => {
    const parsed = parseWorkerEnv({ DEAD_LETTER_RETENTION_DAYS: "30", WORKSPACE_PURGE_RETENTION_DAYS: "90" });
    expect(parsed.DEAD_LETTER_RETENTION_DAYS).toBe(30);
    expect(parsed.WORKSPACE_PURGE_RETENTION_DAYS).toBe(90);
  });

  it("succeeds when equal to the purge retention window -- at most, not strictly less", () => {
    const parsed = parseWorkerEnv({ DEAD_LETTER_RETENTION_DAYS: "30", WORKSPACE_PURGE_RETENTION_DAYS: "30" });
    expect(parsed.DEAD_LETTER_RETENTION_DAYS).toBe(30);
    expect(parsed.WORKSPACE_PURGE_RETENTION_DAYS).toBe(30);
  });

  it("exposes the floor constant", () => {
    expect(DEAD_LETTER_RETENTION_DAYS_FLOOR).toBe(7);
  });
});
