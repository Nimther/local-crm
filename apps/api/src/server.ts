import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "@fastify/type-provider-zod";
import { logger } from "./logger.js";
import { env } from "./env.js";
import { authPlugin } from "./modules/auth/plugin.js";
import { registerWorkspaceRoutes } from "./modules/tenancy/workspaces.js";
import { registerProfileRoutes } from "./modules/tenancy/profile.js";
import { registerInviteRoutes } from "./modules/tenancy/invites.js";
import { registerMemberRoutes } from "./modules/tenancy/members.js";
import { registerSendgridKeyRoutes } from "./modules/tenancy/sendgrid-key.js";
import { registerContactsRoutes } from "./modules/contacts/contacts.routes.js";
import { registerContactsApiRoutes } from "./modules/contacts/contacts-api.routes.js";
import { registerApiKeyRoutes } from "./modules/api-keys/api-keys.routes.js";
import { registerEventsApiRoutes } from "./modules/events/events-api.routes.js";
import { registerCsvImportRoutes } from "./modules/contacts/csv-import.routes.js";
import { registerSegmentsRoutes } from "./modules/segments/segments.routes.js";
import { registerUnsubscribeRoutes } from "./modules/delivery/unsubscribe.routes.js";
import { registerCampaignsRoutes } from "./modules/campaigns/campaigns.routes.js";
import { registerFlowsRoutes } from "./modules/flows/flows.routes.js";
import { registerSendSettingsRoutes } from "./modules/campaigns/send-settings.routes.js";
import { registerWebhookRoutes } from "./modules/webhooks/webhooks.routes.js";
import { registerWebhookSettingsRoutes } from "./modules/webhooks/webhook-settings.routes.js";
import { registerAnalyticsRoutes } from "./modules/analytics/index.js";
import { registerSendLogRoutes } from "./modules/send-log/send-log.routes.js";

/** Assembles the Fastify app: zod type provider, better-auth handler, workspace/profile/invite/member routes. */
export async function buildServer() {
  const app = Fastify({
    loggerInstance: logger,
    // 04-03: find-my-way's default maxParamLength (100) is too small for the
    // signed `:token` route param on /unsubscribe/:token -- the HMAC token
    // (base64url JSON payload + '.' + base64url signature) runs ~230-260
    // chars. Without this, find-my-way returns a 414 for every genuine
    // token, defeating the endpoint entirely.
    routerOptions: { maxParamLength: 1024 },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // `global: false`: only routes that opt in via `{ config: { rateLimit } }`
  // are limited (invite accept/register-from-invite, T-01-13 brute-force
  // mitigation) -- every other route is unaffected.
  await app.register(rateLimit, { global: false });

  // CR-01/WR-05: script-blocking CSP on every response, defense-in-depth on
  // top of the token format guard + attribute escaping in
  // unsubscribe.routes.ts. default-src 'none' blocks any script execution
  // (script-src has no override, so it falls back to default-src);
  // style-src allows 'unsafe-inline' because the public unsubscribe page
  // (and better-auth's own pages, if any) render a plain in-file <style>
  // block, matching this repo's no-template-engine convention -- there is
  // no separate stylesheet to point script-src-style-nonce machinery at.
  // This is the single registration for the whole app (previously
  // registered a second time, with permissive defaults, nested inside
  // authPlugin -- consolidated here so there is one source of truth for the
  // CSP actually served).
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  await app.register(authPlugin);
  await app.register(registerWorkspaceRoutes);
  await app.register(registerProfileRoutes);
  await app.register(registerInviteRoutes);
  await app.register(registerMemberRoutes);
  await app.register(registerSendgridKeyRoutes);
  await app.register(registerContactsRoutes);
  await app.register(registerContactsApiRoutes);
  await app.register(registerApiKeyRoutes);
  await app.register(registerEventsApiRoutes);
  await app.register(registerCsvImportRoutes);
  await app.register(registerSegmentsRoutes);
  await app.register(registerUnsubscribeRoutes);
  await app.register(registerCampaignsRoutes);
  await app.register(registerFlowsRoutes);
  await app.register(registerSendSettingsRoutes);
  await app.register(registerWebhookRoutes);
  await app.register(registerWebhookSettingsRoutes);
  await app.register(registerAnalyticsRoutes);
  await app.register(registerSendLogRoutes);

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();
  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
