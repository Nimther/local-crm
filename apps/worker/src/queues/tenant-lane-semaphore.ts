import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { scrubbedConsole } from "@mega-crm/redaction";
import { SENDGRID_TIMEOUT_MS } from "@mega-crm/delivery-core";
import { CLAIM_TX_MARGIN_MS, RECORD_TX_MARGIN_MS } from "./queue-options.js";

/**
 * WRK-02 (D-01/D-02/D-03): the per-tenant-per-lane concurrency semaphore.
 * A correct RPS token bucket (`rate-limiter.ts`) still lets one tenant's
 * large backlog occupy worker slots ahead of another tenant's small batch
 * -- this module closes that gap. Acquired before the SendGrid dispatch and
 * TTL-leased (D-01) so a crashed worker cannot leak a slot forever; keyed
 * on tenant AND lane (D-02) so a tenant's own broadcast backlog cannot
 * starve that SAME tenant's triggered sends. Architectural sibling of
 * `rate-limiter.ts`'s `consumeTenantToken` -- same Redis-client-injection
 * convention, same discriminated-result-instead-of-throw shape.
 */

/** The two BullMQ send lanes (Phase 4's two-queue split). */
export type TenantLane = "broadcast" | "triggered";

export interface AcquireSlotResult {
  acquired: boolean;
  /** Present only when acquired -- pass back to release the SAME slot. */
  token?: string;
  /** Present only when NOT acquired -- ms until the oldest live holder's lease could free a slot. */
  retryAfterMs?: number;
}

export interface AcquireSlotOptions {
  /** Overrides `resolveTenantLaneCap(lane)` -- primarily for tests, which need caps far smaller than the production defaults to stay fast. */
  cap?: number;
  /** Overrides `SEND_SLOT_LEASE_TTL_MS` -- primarily for tests (the lease-expiry case must not sleep out the tens-of-seconds production TTL). */
  leaseTtlMs?: number;
}

/**
 * Margin added on top of the dispatch worst case that makes up
 * `SEND_SLOT_LEASE_TTL_MS` below -- deliberately generous so ordinary
 * Redis/network jitter is never mistaken for a crashed holder. Versioned
 * constant with rationale (Phase 9 D-12 convention).
 */
export const SEND_SLOT_LEASE_MARGIN_MS = 10_000;

/**
 * TTL-leased slot lifetime (D-01: "TTL-leased so a crashed worker cannot
 * leak a slot forever"). Derived -- never hand-typed -- from the same
 * dispatch-worst-case chain `queue-options.ts`'s `SEND_MAX_JOB_LIFETIME_MS`
 * joins: the SendGrid call's own timeout (`SENDGRID_TIMEOUT_MS`) plus the
 * claim and record transaction margins that run immediately before/after
 * it, plus this module's own margin.
 *
 * Deliberately NOT derived from `SEND_LOCK_DURATION_MS` -- the two bound
 * different things (BullMQ's stalled-job redelivery risk vs. a Redis-side
 * slot leak) -- but the resulting value stays strictly BELOW
 * `SEND_LOCK_DURATION_MS`, so a leaked slot expires and frees itself before
 * BullMQ would even consider the job stalled. That ordering is asserted in
 * `tenant-lane-semaphore.test.ts` against the real exported constants.
 */
export const SEND_SLOT_LEASE_TTL_MS =
  SENDGRID_TIMEOUT_MS + CLAIM_TX_MARGIN_MS + RECORD_TX_MARGIN_MS + SEND_SLOT_LEASE_MARGIN_MS;

/**
 * Per-lane concurrency cap defaults (D-03) -- versioned platform-wide
 * constants with env override, same convention as `DEFAULT_TENANT_RPS`.
 * `broadcast` defaults to 3 against that lane's worker concurrency of 5;
 * `triggered` defaults to 12 against its concurrency of 20 -- roughly 60%
 * per lane, so a single-tenant platform still reaches most of its lane
 * throughput while a real share of every lane stays reachable by other
 * tenants.
 */
export const TENANT_LANE_CONCURRENCY_DEFAULTS: Record<TenantLane, number> = {
  broadcast: 3,
  triggered: 12,
};

const ENV_VAR_BY_LANE: Record<TenantLane, string> = {
  broadcast: "TENANT_LANE_CONCURRENCY_BROADCAST",
  triggered: "TENANT_LANE_CONCURRENCY_TRIGGERED",
};

/**
 * Resolves the effective per-tenant-per-lane cap: the lane's env override
 * when it parses as a positive integer, otherwise the versioned default. A
 * malformed override (absent, empty, non-numeric, fractional, zero or
 * negative) must never widen or void the cap -- it falls back to the
 * default with a warning instead (D-03/T-12-03-03).
 */
export function resolveTenantLaneCap(lane: TenantLane): number {
  const envVar = ENV_VAR_BY_LANE[lane];
  const raw = process.env[envVar];
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
    scrubbedConsole.warn(
      `tenant-lane-semaphore: ${envVar}="${raw}" is not a positive integer -- falling back to the default of ${TENANT_LANE_CONCURRENCY_DEFAULTS[lane]}`
    );
  }
  return TENANT_LANE_CONCURRENCY_DEFAULTS[lane];
}

const SEMAPHORE_KEY_PREFIX = "tenant-lane-sem";

function buildKey(workspaceId: string, lane: TenantLane): string {
  // D-02: keyed on tenant AND lane together -- a tenant-only key would
  // recreate, inside one tenant, the exact starvation the two-queue split
  // exists to prevent.
  return `${SEMAPHORE_KEY_PREFIX}:${workspaceId}:${lane}`;
}

/**
 * Atomic acquire: a sorted-set semaphore with per-holder lease expiry, NOT
 * a plain INCR/DECR counter with a key-wide expiry. A key-wide expiry is
 * refreshed by every new acquire, so under sustained traffic a crashed
 * holder's increment would persist indefinitely and the slot would leak --
 * exactly what D-01 forbids. Per-holder scores are what make expiry
 * per-holder. This is the algorithm the `redis-semaphore` package
 * implements; it is reproduced here rather than taken as a dependency, per
 * 12-01-PLAN.md.
 *
 * One EVAL performs, atomically:
 *   1. Purge holders whose score is older than `now - leaseTtlMs`
 *      (ZREMRANGEBYSCORE) -- per-holder lease expiry.
 *   2. Read the survivor count (ZCARD).
 *   3. If under cap: ZADD the caller's token at score `now`, PEXPIRE the
 *      key to `leaseTtlMs` (bounds the key's own lifetime after its last
 *      write), return acquired.
 *   4. Else: read the oldest survivor's score and return the remaining
 *      lease as the caller's retry-after.
 */
const ACQUIRE_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local leaseTtlMs = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
local token = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - leaseTtlMs)

local count = redis.call('ZCARD', key)

if count < cap then
  redis.call('ZADD', key, now, token)
  redis.call('PEXPIRE', key, leaseTtlMs)
  return {1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldestScore = tonumber(oldest[2])
local remaining = leaseTtlMs - (now - oldestScore)
if remaining < 1 then
  remaining = 1
end
return {0, remaining}
`;

/**
 * Acquires one concurrency slot for `workspaceId` in `lane`, gated by
 * `resolveTenantLaneCap(lane)` (or `options.cap` when overridden). Call
 * before the SendGrid dispatch; release unconditionally in a `finally`.
 *
 * A genuine Redis/connection error propagates -- it is NEVER mapped to an
 * `{ acquired: false }` rejection result. Swallowing it here would defeat
 * the cap this module exists to enforce, dispatching uncapped during a
 * Redis outage (mirrors `consumeTenantToken`'s identical comment in
 * `rate-limiter.ts`).
 */
export async function acquireTenantLaneSlot(
  redisClient: Redis,
  workspaceId: string,
  lane: TenantLane,
  options: AcquireSlotOptions = {}
): Promise<AcquireSlotResult> {
  const cap = options.cap ?? resolveTenantLaneCap(lane);
  const leaseTtlMs = options.leaseTtlMs ?? SEND_SLOT_LEASE_TTL_MS;
  const key = buildKey(workspaceId, lane);
  // Generated per acquisition so two concurrent holders in the same
  // process can never collide.
  const token = randomUUID();
  const now = Date.now();

  const raw = (await redisClient.eval(ACQUIRE_SCRIPT, 1, key, now, leaseTtlMs, cap, token)) as [number, number];
  const [acquiredFlag, retryAfterMs] = raw;

  if (acquiredFlag === 1) {
    return { acquired: true, token };
  }
  return { acquired: false, retryAfterMs };
}

/**
 * Releases a previously acquired slot. Removing a token that is not held
 * is a no-op by construction (`ZREM` of a non-member), so this is safe to
 * call unconditionally from a `finally` block, including with the
 * `undefined` token a failed acquire returns.
 */
export async function releaseTenantLaneSlot(
  redisClient: Redis,
  workspaceId: string,
  lane: TenantLane,
  token: string | undefined
): Promise<void> {
  if (!token) return;
  const key = buildKey(workspaceId, lane);
  await redisClient.zrem(key, token);
}
