import { Redis, type RedisOptions } from "ioredis";

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
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db,
    maxRetriesPerRequest: null,
  };
}

/** Constructs a shared ioredis connection for BullMQ Queue/Worker instances. */
export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(buildRedisConnectionOptions(redisUrl));
}
