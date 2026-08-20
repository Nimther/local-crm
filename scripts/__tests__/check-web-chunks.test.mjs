// Phase 17 code-review fix (WR-03, 17-REVIEW.md): unit coverage for
// scripts/check-web-chunks.mjs's cycle-detection logic
// (`findChunkImportCycle`, `viteConfigHasStrictExecutionOrder`,
// `evaluateCycleBoundary`).
//
// This gate exists to prevent recurrence of a real four-day production
// incident (2026-08-15..19, see check-web-chunks.mjs's own header comment):
// a static chunk-import cycle in the Rolldown build manifest crashed a route
// at module evaluation. Every other CI-gate script this same phase touched
// or added (validate-prod-compose.mjs, deploy.sh, restore-drill.sh) ships
// dedicated, fixture-driven __tests__ exercising the pure exported helpers
// directly -- this file gives check-web-chunks.mjs the same treatment.
//
// In-memory manifest fixtures, not a real Vite build: `findChunkImportCycle`
// and `evaluateCycleBoundary` operate purely on the manifest object's
// `imports` graph shape, so a hand-built object exercises every edge case
// (2-node cycle, acyclic, longer cycle) without a real `apps/web` build.
// `viteConfigHasStrictExecutionOrder` reads a real file from disk (`webDir`),
// so those cases use a temp directory with a fixture `vite.config.ts`.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateCycleBoundary,
  findChunkImportCycle,
  viteConfigHasStrictExecutionOrder,
} from "../check-web-chunks.mjs";

/** A minimal manifest entry -- only the fields findChunkImportCycle/evaluateChunkBoundaries read. */
function entry(imports = []) {
  return { file: "irrelevant.js", imports };
}

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Creates a temp "webDir" containing a vite.config.ts fixture with the given source text. */
function makeWebDirWithViteConfig(source) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "check-web-chunks-test-"));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, "vite.config.ts"), source, "utf8");
  return dir;
}

describe("findChunkImportCycle", () => {
  it("(1) returns the cycle for a 2-node mutual-import manifest", () => {
    const manifest = {
      "chunk-a.js": entry(["chunk-b.js"]),
      "chunk-b.js": entry(["chunk-a.js"]),
    };
    const cycle = findChunkImportCycle(manifest);
    expect(cycle).not.toBeNull();
    // Closed: first element repeated last, per this function's own doc comment.
    expect(cycle[0]).toBe(cycle[cycle.length - 1]);
    expect(new Set(cycle)).toEqual(new Set(["chunk-a.js", "chunk-b.js"]));
  });

  it("(2) returns null for an acyclic manifest", () => {
    const manifest = {
      "entry.js": entry(["vendor.js", "route.js"]),
      "vendor.js": entry([]),
      "route.js": entry(["vendor.js"]),
    };
    expect(findChunkImportCycle(manifest)).toBeNull();
  });

  it("returns null for an empty manifest", () => {
    expect(findChunkImportCycle({})).toBeNull();
  });

  it("finds a longer (3-node) cycle, not only the 2-node case", () => {
    const manifest = {
      "a.js": entry(["b.js"]),
      "b.js": entry(["c.js"]),
      "c.js": entry(["a.js"]),
      "unrelated.js": entry([]),
    };
    const cycle = findChunkImportCycle(manifest);
    expect(cycle).not.toBeNull();
    expect(new Set(cycle)).toEqual(new Set(["a.js", "b.js", "c.js"]));
  });

  it("ignores an import reference to a key absent from the manifest (dangling edge, not a cycle)", () => {
    const manifest = {
      "entry.js": entry(["not-in-manifest.js"]),
    };
    expect(findChunkImportCycle(manifest)).toBeNull();
  });
});

describe("viteConfigHasStrictExecutionOrder", () => {
  it("returns true when the config source sets strictExecutionOrder: true", () => {
    const webDir = makeWebDirWithViteConfig(`
      export default {
        build: {
          rollupOptions: {
            output: {
              strictExecutionOrder: true,
            },
          },
        },
      };
    `);
    expect(viteConfigHasStrictExecutionOrder(webDir)).toBe(true);
  });

  it("returns false when the flag is absent", () => {
    const webDir = makeWebDirWithViteConfig(`
      export default {
        build: {
          rollupOptions: {
            output: {},
          },
        },
      };
    `);
    expect(viteConfigHasStrictExecutionOrder(webDir)).toBe(false);
  });

  it("returns false when the flag only appears inside a full-line comment", () => {
    const webDir = makeWebDirWithViteConfig(`
      // strictExecutionOrder: true
      export default {};
    `);
    expect(viteConfigHasStrictExecutionOrder(webDir)).toBe(false);
  });

  it("returns false when vite.config.ts does not exist at all", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "check-web-chunks-test-"));
    tempDirs.push(dir);
    expect(viteConfigHasStrictExecutionOrder(dir)).toBe(false);
  });
});

describe("evaluateCycleBoundary (WR-03: the exact main() suppression decision, directly testable)", () => {
  const cyclicManifest = {
    "charts-vendor.js": entry(["WorkspaceDashboard.js"]),
    "WorkspaceDashboard.js": entry(["charts-vendor.js"]),
  };
  const acyclicManifest = {
    "entry.js": entry(["vendor.js"]),
    "vendor.js": entry([]),
  };

  it("(3) suppresses the violation when a cycle exists AND strictExecutionOrder: true is present", () => {
    const webDir = makeWebDirWithViteConfig(`
      export default { build: { rollupOptions: { output: { strictExecutionOrder: true } } } };
    `);
    expect(evaluateCycleBoundary(cyclicManifest, webDir)).toBeNull();
  });

  it("(4) raises a violation naming the cycle when the same cycle exists WITHOUT the flag", () => {
    const webDir = makeWebDirWithViteConfig(`
      export default { build: { rollupOptions: { output: {} } } };
    `);
    const violation = evaluateCycleBoundary(cyclicManifest, webDir);
    expect(violation).not.toBeNull();
    expect(violation).toContain("charts-vendor.js");
    expect(violation).toContain("WorkspaceDashboard.js");
    expect(violation).toContain("strictExecutionOrder");
  });

  it("returns null for an acyclic manifest regardless of strictExecutionOrder", () => {
    const webDirWithFlag = makeWebDirWithViteConfig(
      `export default { build: { rollupOptions: { output: { strictExecutionOrder: true } } } };`
    );
    const webDirWithoutFlag = makeWebDirWithViteConfig(
      `export default { build: { rollupOptions: { output: {} } } };`
    );
    expect(evaluateCycleBoundary(acyclicManifest, webDirWithFlag)).toBeNull();
    expect(evaluateCycleBoundary(acyclicManifest, webDirWithoutFlag)).toBeNull();
  });
});
