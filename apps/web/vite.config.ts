import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Dev server proxies /api to the Fastify API so the better-auth session
 * cookie is same-origin in dev (see 01-CONTEXT.md / 01-01-SUMMARY.md
 * interfaces: cookies must be sent with credentials: 'include').
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
  build: {
    // OPS-16/D-14: the build manifest is what makes the chunk-boundary
    // assertion (scripts/check-web-chunks.mjs) machine-checkable in CI
    // rather than eyeballed in the build's console output.
    manifest: true,
    rollupOptions: {
      output: {
        // Vite 8's default production bundler is Rolldown, which does NOT
        // support the classic object form of Rollup's `manualChunks`
        // (`{ "canvas-vendor": ["@xyflow/react"] }`) -- it either silently
        // no-ops or errors (15-RESEARCH.md Pitfall 2). Rolldown's own
        // `advancedChunks.groups` (regex `test` matched against each
        // module id) is the native, forward-compatible way to pin a vendor
        // chunk boundary instead. `@xyflow/react` (canvas editor) and
        // `recharts` (dashboard charts) are the two heaviest vendor
        // dependencies in this app -- pinning them into their own chunks
        // means they only download when a route that actually uses them
        // (the flow canvas, the dashboard) is opened.
        // `includeDependenciesRecursively` defaults to `true` in Rolldown --
        // that pulls each matched module's OWN transitive dependencies
        // (react, react-dom, etc.) into the SAME named chunk too. Since
        // those transitive deps are shared by virtually every other route,
        // the vendor chunk ends up as a static dependency of every chunk in
        // the app (confirmed empirically against the build manifest: every
        // route showed up as an `imports` consumer of canvas-vendor before
        // this was set to `false`) -- exactly the opposite of the intended
        // "loads only when this route opens" boundary. `false` restricts
        // each group to just the modules whose id matches `test` directly.
        advancedChunks: {
          includeDependenciesRecursively: false,
          groups: [
            { name: "canvas-vendor", test: /node_modules[\\/]@xyflow[\\/]react/ },
            { name: "charts-vendor", test: /node_modules[\\/]recharts/ },
          ],
        },
        // REQUIRED with `includeDependenciesRecursively: false` above: without
        // it Rolldown emits vendor/route chunk pairs that statically import
        // EACH OTHER (charts-vendor <-> WorkspaceDashboard, canvas-vendor <->
        // FlowDetailPage), and whichever body executes first reads an
        // uninitialized binding from the other -- both routes then crash at
        // module evaluation ("TypeError: P is not a function"). Rolldown's own
        // docs recommend this flag when includeDependenciesRecursively is
        // disabled. Removing it re-breaks both routes; the cycle gate in
        // scripts/check-web-chunks.mjs fails the build if that happens.
        strictExecutionOrder: true,
      },
    },
  },
});
