import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import type { Redis } from "ioredis";

/**
 * Default per-tenant RPS ceiling (SEND-02) when a workspace has no
 * `workspace_send_settings.rps_limit` override.
 *
 * D-06 (Phase 12, WRK-04): backed by both halves the decision calls for.
 *
 * Platform half -- the platform's own send pipeline sustains this rate for
 * a full measurement window without its queue's waiting depth growing,
 * proven by the on-demand load test at
 * `apps/worker/src/queues/__tests__/loadtest/tenant-rps-sustained.test.ts`
 * (`npm run loadtest:tenant-rps`; deliberately not wired into CI, D-04).
 *
 * Provider half -- SendGrid's own published Web API v3 rate-limit guidance
 * (https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/rate-limits,
 * retrieved 2026-08-10) states that the API enforces limits PER ENDPOINT,
 * surfaced dynamically via the `X-RateLimit-Limit`/`-Remaining`/`-Reset`
 * response headers, and does NOT publish one universal fixed
 * requests-per-second ceiling for the `mail/send` endpoint specifically --
 * the docs' own example headers (`500`, `150`) are illustrative of the
 * MECHANISM, not a `mail/send`-specific number. This is exactly why this
 * constant can only ever be a self-imposed, platform-side default, never a
 * figure copied out of SendGrid's docs: every tenant supplies their OWN
 * SendGrid API key (BYO, per CLAUDE.md's delivery model), so their real
 * provider ceiling depends on their own plan tier and sending reputation --
 * neither of which this platform can observe in advance. 10 is a
 * conservative starting point, sized well inside what the sustained run
 * above proves the platform's own pipeline can sustain.
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
