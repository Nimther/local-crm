import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import type { Redis } from "ioredis";

/**
 * Default per-tenant RPS ceiling (SEND-02) when a workspace has no
 * `workspace_send_settings.rps_limit` override -- RESEARCH.md Assumption A1
 * [ASSUMED], flagged for user confirmation but shipped as the starting
 * default since no universal-safe value exists across SendGrid plan tiers.
 */
export const DEFAULT_TENANT_RPS = 10;

/**
 * `RateLimiterRedis` instances are cached per distinct `rps` ceiling
 * (RESEARCH.md Code Examples: "points" is fixed at construction time, so a
 * dynamic per-workspace RPS is handled by keeping one instance per distinct
 * configured value) -- the bucket KEY itself (`consume(workspaceId)`) is
 * what actually scopes the throttle per tenant, not the instance.
 */
const limitersByRps = new Map<number, RateLimiterRedis>();

/**
 * Factory for the per-tenant token bucket at a given RPS ceiling. Requires
 * its OWN connected `ioredis` client (RESEARCH.md Code Examples) -- never
 * BullMQ's internal `ConnectionOptions`-only connection, which BullMQ
 * manages itself and does not expose as a directly usable client.
 */
export function createTenantRateLimiter(redisClient: Redis, rps: number): RateLimiterRedis {
  let limiter = limitersByRps.get(rps);
  if (!limiter) {
    limiter = new RateLimiterRedis({
      storeClient: redisClient,
      keyPrefix: "send-rl",
      points: rps,
      duration: 1, // per second -- token bucket refills every second
    });
    limitersByRps.set(rps, limiter);
  }
  return limiter;
}

export interface ConsumeTokenResult {
  allowed: boolean;
  /** Milliseconds to wait before the next token is available (0 when allowed). */
  msBeforeNext: number;
}

/**
 * Consumes one token from `workspaceId`'s per-second bucket at the given RPS
 * ceiling (SEND-02/SEND-03). Returns a discriminated result instead of
 * throwing when the tenant's budget is exhausted -- `send-dispatch.ts` turns
 * `allowed: false` into the same rate-limit signal a SendGrid 429 produces,
 * so the calling Worker can `await worker.rateLimit(msBeforeNext); throw
 * Worker.RateLimitError();` (Pattern 3) without `processSendJob` needing a
 * live Worker to be unit-testable.
 */
export async function consumeTenantToken(
  redisClient: Redis,
  workspaceId: string,
  rps: number
): Promise<ConsumeTokenResult> {
  const limiter = createTenantRateLimiter(redisClient, rps);
  try {
    await limiter.consume(workspaceId, 1);
    return { allowed: true, msBeforeNext: 0 };
  } catch (rejection) {
    if (rejection instanceof RateLimiterRes) {
      return { allowed: false, msBeforeNext: rejection.msBeforeNext };
    }
    // A genuine Redis/connection error (not a rate-limit rejection) --
    // propagate rather than silently treating it as "allowed", since that
    // would defeat the per-tenant RPS ceiling this module exists to enforce.
    throw rejection;
  }
}
