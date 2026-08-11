import { Redis, type RedisOptions } from "ioredis";
import { scrubbedConsole } from "@mega-crm/redaction";

/**
 * Decodes a percent-encoded Redis URL credential, re-throwing a
 * `REDIS_URL`-specific error on malformed input. `decodeURIComponent`
 * throws a bare `URIError: URI malformed` for a value containing a raw
 * `%` that is not part of a valid two-hex-digit escape sequence (e.g. a
 * generated secret embedded into the URL without being encoded first).
 * The WHATWG `URL` parser accepts such a string without complaint (userinfo
 * does not require valid escapes to parse), so this is the first point
 * where it can fail -- surface it with a message that names `REDIS_URL`
 * and the likely fix, rather than letting operators debug a generic
 * `URIError` at process boot (12-REVIEW.md iteration 2, IN-02).
 */
function decodeCredential(value: string, field: "username" | "password"): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(
      `REDIS_URL ${field} contains an invalid percent-encoding; ensure it was built with encodeURIComponent`,
    );
  }
}

/**
 * Builds the ioredis connection options BullMQ needs from REDIS_URL.
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ — without it, ioredis
 * gives up retrying individual commands after its own default retry count
 * and BullMQ's blocking commands (used internally for job polling) start
 * throwing instead of reconnecting indefinitely. See BullMQ's own
 * connection docs (STACK.md Queue & Send Pipeline).
 */
export function buildRedisConnectionOptions(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  const db = url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined;

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    // The WHATWG `URL` object's `.username`/`.password` getters return the
    // PERCENT-ENCODED form of the credential, not the decoded original. A
    // Redis password containing a character that must be percent-encoded in
    // a URL (`@`, `:`, `/`, `%`, space, etc.) would otherwise be passed to
    // ioredis's AUTH command still encoded -- ioredis uses `options.password`
    // verbatim, it does not decode it. Decode both here so this is the one
    // place that ever needs to know about URL percent-encoding at all.
    username: url.username ? decodeCredential(url.username, "username") : undefined,
    password: url.password ? decodeCredential(url.password, "password") : undefined,
    db,
    maxRetriesPerRequest: null,
  };
}

/**
 * Constructs a shared ioredis connection for BullMQ Queue/Worker instances.
 * Registers an `'error'` listener (12-REVIEW.md WR-01) so connection errors
 * route through `scrubbedConsole` -- like every other long-lived connection
 * in this codebase -- instead of ioredis's own unredacted internal fallback
 * logger.
 */
export function createRedisConnection(redisUrl: string): Redis {
  const client = new Redis(buildRedisConnectionOptions(redisUrl));
  client.on("error", (err) => {
    scrubbedConsole.error("queue-core: shared ioredis connection error", err);
  });
  return client;
}
