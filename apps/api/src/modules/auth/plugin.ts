import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth.js";
import { env } from "../../env.js";

/**
 * Credential-path budget: sign-in, sign-up, password reset, invite
 * acceptance — every /api/auth/* request that is not on the read allow-list
 * below. Unchanged ceiling; this is the credential-stuffing / token
 * brute-force control and must not be loosened.
 */
const CREDENTIAL_BUCKET_MAX = 20;

/**
 * Session-read budget. Deliberately roomier than the credential bucket
 * (better-auth's client refetches /get-session on window focus — floored at
 * one per 5s, ~12/min — plus tab visibility, online events, cross-tab
 * broadcast and every fresh store mount, doubled by React StrictMode in dev),
 * but FINITE: a read burst must still be throttled, just never out of the
 * credential budget.
 */
const SESSION_READ_BUCKET_MAX = 120;

/**
 * The only /api/auth/* paths that read state without touching a credential:
 * better-auth's session read, and its liveness endpoint (which the E2E
 * webServer health probe polls). Everything else — including any other GET
 * that carries a token, e.g. email verification — falls in the credential
 * bucket, so widening the read budget cannot widen a brute-force surface.
 */
const AUTH_READ_PATHS = new Set(["/api/auth/get-session", "/api/auth/ok"]);

function isAuthReadRequest(request: FastifyRequest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const queryStart = request.url.indexOf("?");
  const path = queryStart === -1 ? request.url : request.url.slice(0, queryStart);
  return AUTH_READ_PATHS.has(path);
}

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
    //
    // TWO buckets per IP, not one shared budget (debug session
    // `auth-session-lifecycle`): this used to be a single `max: 20` over the
    // whole scope, so better-auth's session READS spent the very budget the
    // comment above says protects credentials. An authenticated user who just
    // browsed the app for a couple of minutes drained it, and their next
    // sign-in with CORRECT credentials was answered 429 — which the login page
    // rendered as "wrong email or password". The counters are separated by
    // `keyGenerator` (one key per bucket per IP) with `max` resolved per
    // request, so a read burst can no longer deny a credential submit while
    // both paths stay throttled. `keyGenerator`/`max` are the only supported
    // way to do this here: the scope serves better-auth through ONE catch-all
    // route, so per-route `config.rateLimit` cannot tell the paths apart.
    //
    // Store stays the plugin's in-memory default (per process) — deliberately
    // NOT the app-wide Redis store from server.ts, which is registered
    // `{ global: false }` and therefore never applied to this scope.
    await scope.register(rateLimit, {
      max: (request) => (isAuthReadRequest(request) ? SESSION_READ_BUCKET_MAX : CREDENTIAL_BUCKET_MAX),
      timeWindow: "1 minute",
      keyGenerator: (request) =>
        `${isAuthReadRequest(request) ? "auth-read" : "auth-credential"}:${request.ip}`,
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
