import { describe, expect, it } from "vitest";

import { getCorrelationContext, getWorkspaceId, withCorrelation, withTenant } from "../index.js";

/**
 * Phase 15 plan 02 (OPS-11, RESEARCH.md Pitfall 7 -- the highest-severity
 * finding in this phase's research): a unit test that binds only ONE ALS
 * field at a time can never catch a nested-`run()`-replaces-the-store bug,
 * because a single `run()` call has nothing to clobber. Every case below
 * therefore mirrors the REAL call shape -- one `with*` call nested inside
 * another -- in both possible nesting orders, plus the three-level
 * accumulation case the plan's `<behavior>` names explicitly.
 */
describe("correlation context (merge-safe ALS store)", () => {
  it("getCorrelationContext outside any scope returns an empty object and does not throw", () => {
    expect(getCorrelationContext()).toEqual({});
  });

  it("getWorkspaceId throws outside any scope", () => {
    expect(() => getWorkspaceId()).toThrow(/No tenant context/);
  });

  it("correlation-then-tenant: withTenant nested inside withCorrelation sees workspaceId AND the outer correlation fields", async () => {
    const seen = await withCorrelation({ requestId: "req-1", jobId: "job-1" }, () =>
      withTenant("workspace-a", () => Promise.resolve(getCorrelationContext())),
    );
    expect(seen).toEqual({ requestId: "req-1", jobId: "job-1", workspaceId: "workspace-a" });
  });

  it("tenant-then-correlation: withCorrelation nested inside withTenant sees workspaceId AND the newly added correlation fields", async () => {
    const seen = await withTenant("workspace-a", () =>
      withCorrelation({ requestId: "req-2" }, () => Promise.resolve(getCorrelationContext())),
    );
    expect(seen).toEqual({ workspaceId: "workspace-a", requestId: "req-2" });
  });

  it("three levels of nesting (correlation -> tenant -> correlation) accumulate rather than replace", async () => {
    const seen = await withCorrelation({ requestId: "req-3" }, () =>
      withTenant("workspace-b", () =>
        withCorrelation({ jobId: "job-3" }, () => Promise.resolve(getCorrelationContext())),
      ),
    );
    expect(seen).toEqual({ requestId: "req-3", workspaceId: "workspace-b", jobId: "job-3" });
  });

  it("getWorkspaceId throws inside a correlation-only scope (no workspace bound)", async () => {
    await withCorrelation({ requestId: "req-4" }, () => {
      expect(() => getWorkspaceId()).toThrow(/No tenant context/);
      return Promise.resolve();
    });
  });

  it("withTenant called with a different workspaceId inside an existing tenant scope overrides workspaceId and preserves correlation fields", async () => {
    const seen = await withCorrelation({ requestId: "req-5" }, () =>
      withTenant("workspace-outer", () =>
        withTenant("workspace-inner", () => Promise.resolve(getCorrelationContext())),
      ),
    );
    expect(seen).toEqual({ requestId: "req-5", workspaceId: "workspace-inner" });
  });

  it("a field explicitly passed as undefined does not erase an already-bound value of that field", async () => {
    const seen = await withCorrelation({ requestId: "req-6", jobId: "job-6" }, () =>
      withCorrelation({ jobId: undefined }, () => Promise.resolve(getCorrelationContext())),
    );
    expect(seen).toEqual({ requestId: "req-6", jobId: "job-6" });
  });

  it("does not leak one scope's correlation fields into a sibling scope", async () => {
    const first = await withCorrelation({ requestId: "req-A" }, () => Promise.resolve(getCorrelationContext()));
    const second = await withCorrelation({ requestId: "req-B" }, () => Promise.resolve(getCorrelationContext()));
    expect(first).toEqual({ requestId: "req-A" });
    expect(second).toEqual({ requestId: "req-B" });
  });
});
