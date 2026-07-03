import Fastify from "fastify";
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

/** Assembles the Fastify app: zod type provider, better-auth handler, workspace + profile routes. */
export async function buildServer() {
  const app = Fastify({ loggerInstance: logger }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(authPlugin);
  await app.register(registerWorkspaceRoutes);
  await app.register(registerProfileRoutes);

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
