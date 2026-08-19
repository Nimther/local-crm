#!/usr/bin/env node
// Phase 15 plan 03 (OPS-16, D-14). The CI-checkable half of the code-
// splitting boundary apps/web/vite.config.ts pins: @xyflow/react (the
// canvas editor) and recharts (dashboard charts) are the two heaviest
// vendor bundles in this app, and Rolldown's `output.advancedChunks.groups`
// (vite.config.ts) pins each into its own named chunk ("canvas-vendor",
// "charts-vendor") so neither downloads until the route that needs it
// opens. This script asserts that boundary against the REAL build
// manifest rather than leaving it to be eyeballed in a build's console
// output -- a config regression (the group silently removed, or Rolldown
// merging the vendor code back into a shared/eager chunk) fails this gate
// instead of only showing up later as a slower first paint in production.
//
// REQUIRES a completed `npm run build -w apps/web` first -- this script
// only reads the build manifest already on disk (apps/web/dist/.vite/
// manifest.json, produced by vite.config.ts's `build.manifest: true`); it
// does not build anything itself, and fails loudly (never vacuously) if
// that manifest is absent.
//
// Same class as scripts/check-lockfile-npm10.mjs and
// scripts/validate-prod-compose.mjs: Node built-ins only, pure helpers
// exported for direct unit assertion, a CLI entry point that exits
// non-zero with a readable, actionable report naming exactly which
// boundary is missing.
//
// No dependencies -- Node built-ins only.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Each vendor boundary this gate protects: the chunk group `name` pinned
 * in apps/web/vite.config.ts's `build.rollupOptions.output.advancedChunks
 * .groups`, plus a content marker string unique to that package's bundled
 * output. The marker is a defense-in-depth check that the named chunk
 * really does contain the library (not merely a same-named, empty, or
 * unrelated chunk) -- `react-flow__` is a CSS class prefix @xyflow/react
 * itself emits on every rendered node/edge/pane; `recharts` is the string
 * literal recharts bundles into its own internal warnings/displayName use.
 */
export const VENDOR_BOUNDARIES = [
  { chunkName: "canvas-vendor", package: "@xyflow/react", marker: "react-flow__" },
  { chunkName: "charts-vendor", package: "recharts", marker: "recharts" },
];

export function manifestPath(webDir) {
  return path.join(webDir, "dist", ".vite", "manifest.json");
}

/** Reads and parses the build manifest, or throws a message naming the exact missing-build remediation. */
export function readManifest(webDir) {
  const file = manifestPath(webDir);
  if (!existsSync(file)) {
    throw new Error(
      `no build manifest found at ${path.relative(REPO_ROOT, file)} -- run "npm run build -w apps/web" first.`,
    );
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/** The manifest's entry record (the one chunk with `isEntry: true`) plus its own key. Throws if none exists. */
export function findEntry(manifest) {
  const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
  if (!entryKey) {
    throw new Error("build manifest has no entry chunk (no record with isEntry: true) -- cannot check chunk boundaries.");
  }
  return { entryKey, entry: manifest[entryKey] };
}

/**
 * Evaluates every VENDOR_BOUNDARIES entry against the manifest + the
 * on-disk dist directory, returning `{ violations, checkedCount }` --
 * `violations` is empty when every boundary holds.
 */
export function evaluateChunkBoundaries(manifest, webDir, { entryKey, entry }) {
  const violations = [];
  let checkedCount = 0;
  const distDir = path.join(webDir, "dist");
  const entryInitialImports = new Set(entry.imports ?? []);

  for (const boundary of VENDOR_BOUNDARIES) {
    checkedCount++;

    const vendorEntry = Object.entries(manifest).find(
      ([key, record]) => record.name === boundary.chunkName && key !== entryKey,
    );
    if (!vendorEntry) {
      violations.push(
        `no distinct "${boundary.chunkName}" chunk found in the build manifest -- ${boundary.package} is not pinned into its own vendor chunk (check apps/web/vite.config.ts's advancedChunks.groups).`,
      );
      continue;
    }
    const [vendorKey, vendorRecord] = vendorEntry;

    if (vendorRecord.isEntry) {
      violations.push(
        `"${boundary.chunkName}" chunk resolved to an entry chunk itself -- ${boundary.package} is not separated from the initial bundle.`,
      );
      continue;
    }

    const vendorFile = path.join(distDir, vendorRecord.file);
    if (!existsSync(vendorFile)) {
      violations.push(`"${boundary.chunkName}" chunk file ${vendorRecord.file} is listed in the manifest but does not exist on disk.`);
      continue;
    }
    const vendorContent = readFileSync(vendorFile, "utf8");
    if (!vendorContent.includes(boundary.marker)) {
      violations.push(
        `"${boundary.chunkName}" chunk (${vendorRecord.file}) does not contain the expected ${boundary.package} marker ("${boundary.marker}") -- the chunk may be empty or mis-scoped.`,
      );
      continue;
    }

    if (entryInitialImports.has(vendorKey)) {
      violations.push(
        `"${boundary.chunkName}" chunk (${vendorRecord.file}) is statically imported by the entry chunk -- ${boundary.package} would download on every initial page load, not only when its route opens.`,
      );
      continue;
    }

    const entryFile = path.join(distDir, entry.file);
    if (existsSync(entryFile)) {
      const entryContent = readFileSync(entryFile, "utf8");
      if (entryContent.includes(boundary.marker)) {
        violations.push(
          `the entry chunk (${entry.file}) itself contains the ${boundary.package} marker ("${boundary.marker}") -- it leaked into the initial bundle despite the vendor chunk split.`,
        );
        continue;
      }
    }
  }

  return { violations, checkedCount };
}

/**
 * Finds a static chunk-import cycle in the build manifest, or returns null.
 *
 * Why this gate exists: with `advancedChunks.includeDependenciesRecursively:
 * false` (vite.config.ts), Rolldown can emit a vendor chunk and a route chunk
 * that statically import EACH OTHER (charts-vendor <-> WorkspaceDashboard,
 * canvas-vendor <-> FlowDetailPage). The chunk whose body runs first then
 * reads a binding the other chunk has not initialized yet, and the route
 * crashes at module evaluation ("TypeError: P is not a function") -- a
 * failure mode the boundary checks above cannot see, because the boundaries
 * themselves all hold. Production shipped exactly this for four days
 * (2026-08-15..19); a cycle in the manifest graph is the machine-checkable
 * signature.
 *
 * Nodes are manifest keys; edges are each record's `imports` array (which
 * also holds manifest keys). Returns the first cycle found as an array of
 * keys, closed (first element repeated last), for a readable report.
 */
export function findChunkImportCycle(manifest) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(Object.keys(manifest).map((k) => [k, WHITE]));
  const stack = [];

  function visit(key) {
    color.set(key, GRAY);
    stack.push(key);
    for (const dep of manifest[key]?.imports ?? []) {
      if (!(dep in manifest)) continue;
      const c = color.get(dep);
      if (c === GRAY) {
        return [...stack.slice(stack.indexOf(dep)), dep];
      }
      if (c === WHITE) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    color.set(key, BLACK);
    return null;
  }

  for (const key of Object.keys(manifest)) {
    if (color.get(key) === WHITE) {
      const cycle = visit(key);
      if (cycle) return cycle;
    }
  }
  return null;
}

function isDirectInvocation() {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  return import.meta.url === pathToFileURL(path.resolve(entryArg)).href;
}

function main() {
  const webDir = path.join(REPO_ROOT, "apps", "web");

  let manifest;
  try {
    manifest = readManifest(webDir);
  } catch (err) {
    console.error(`check:web-chunks FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  let entryInfo;
  try {
    entryInfo = findEntry(manifest);
  } catch (err) {
    console.error(`check:web-chunks FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  const { violations, checkedCount } = evaluateChunkBoundaries(manifest, webDir, entryInfo);

  const cycle = findChunkImportCycle(manifest);
  if (cycle) {
    violations.push(
      `static chunk-import cycle in the build manifest: ${cycle.join(" -> ")} -- chunks in a cycle execute against uninitialized bindings and crash their route at module evaluation (set rollupOptions.output.strictExecutionOrder: true in apps/web/vite.config.ts).`,
    );
  }

  if (violations.length > 0) {
    console.error(`check:web-chunks -- ${checkedCount} boundary(ies) checked, ${violations.length} violation(s):`);
    for (const v of violations) {
      console.error(`  - ${v}`);
    }
    process.exit(1);
    return;
  }

  console.log(`check:web-chunks -- ${checkedCount} vendor chunk boundary(ies) OK (canvas/@xyflow-react, charts/recharts both isolated from the entry bundle).`);
}

if (isDirectInvocation()) {
  main();
}
