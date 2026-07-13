import type { FastifyInstance } from "fastify";
import { registerTimelineRoutes } from "./timeline.routes.js";

/**
 * Analytics module aggregator (ANLT-03+). Single registration point in
 * server.ts -- later Phase 7 plans (flow-node analytics, workspace
 * dashboard) add their own `register*Routes` calls here rather than each
 * registering separately in server.ts.
 */
export async function registerAnalyticsRoutes(fastify: FastifyInstance): Promise<void> {
  await registerTimelineRoutes(fastify);
}
