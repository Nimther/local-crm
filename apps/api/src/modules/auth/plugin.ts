import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth.js";
import { env } from "../../env.js";

/**
 * Mounts better-auth's handler at /api/auth/* and registers the baseline
 * security plugins (CORS/rate-limit — RESEARCH.md Supporting stack).
 * @fastify/helmet is registered once, app-wide, in server.ts (CR-01/WR-05)
 * with an explicit script-blocking CSP -- not duplicated here.
 *
 * better-auth's Node handler needs the RAW, unparsed request body — it is
 * registered in its own encapsulated Fastify context so Fastify's default
 * JSON body parser never consumes the stream first (a documented
 * better-auth+Fastify integration requirement; parsing JSON before this
 * handler runs is the single most common integration bug).
 */
export const authPlugin = fp(async function authPlugin(fastify: FastifyInstance) {
  await fastify.register(cors, {
    origin: [env.WEB_URL],
    credentials: true,
  });

  await fastify.register(async (scope) => {
    // Rate-limit only applies within this encapsulated scope — i.e. only to
    // /api/auth/* (sign-up, sign-in, and every other better-auth route),
    // guarding against credential stuffing / invite-token brute force.
    await scope.register(rateLimit, {
      max: 20,
      timeWindow: "1 minute",
    });

    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_request, payload, done) => {
      done(null, payload);
    });

    const handler = toNodeHandler(auth);

    scope.all("/api/auth/*", async (request, reply) => {
      reply.hijack();
      await handler(request.raw, reply.raw);
    });
  });
});
