import Fastify from "fastify";
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

/** Assembles the Fastify app: zod type provider, better-auth handler, workspace/profile/invite/member routes. */
export async function buildServer() {
  const app = Fastify({ loggerInstance: logger }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // `global: false`: only routes that opt in via `{ config: { rateLimit } }`
  // are limited (invite accept/register-from-invite, T-01-13 brute-force
  // mitigation) -- every other route is unaffected.
  await app.register(rateLimit, { global: false });

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

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();
  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}
