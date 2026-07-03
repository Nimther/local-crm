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
});
