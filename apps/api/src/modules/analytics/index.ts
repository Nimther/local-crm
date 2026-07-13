import type { FastifyInstance } from "fastify";
import { registerTimelineRoutes } from "./timeline.routes.js";
import { registerFlowAnalyticsRoutes } from "./flow-analytics.routes.js";
import { registerDashboardRoutes } from "./dashboard.routes.js";

/**
 * Analytics module aggregator (ANLT-02/ANLT-03+). Single registration point
 * in server.ts -- later Phase 7 plans (workspace dashboard) add their own
 * `register*Routes` calls here rather than each registering separately in
 * server.ts.
 */
export async function registerAnalyticsRoutes(fastify: FastifyInstance): Promise<void> {
  await registerTimelineRoutes(fastify);
  await registerFlowAnalyticsRoutes(fastify);
  await registerDashboardRoutes(fastify);
}
