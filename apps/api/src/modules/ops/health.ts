import type { FastifyInstance } from "fastify";
import {
  assertMigrationsCurrent,
  MigrationsPendingError,
  MigrationsTableMissingError,
} from "@mega-crm/db";
import { pool } from "../../db.js";
import { campaignKickoffQueue } from "../campaigns/campaign-queues.js";

/**
 * Phase 14 plan 01 (D-13/D-14, OPS-04/OPS-05, DB-06) -- `/healthz` (pure
 * process liveness) and `/readyz` (Postgres + Redis + migration-currency,
 * D-13's "holds by construction" readiness). Registered in the same
 * `export async function register...Routes(fastify: FastifyInstance)` shape
 * every other route module uses. Neither route takes a `requirePermission`
 * or tenant-lookup preHandler -- both are deliberately unauthenticated
 * infrastructure probes carrying no tenant data (T-14-04, accepted by
 * design).
 */

export type ReadinessCheckName = "postgres" | "redis" | "migrations";

export interface ReadinessCheckResult {
  name: ReadinessCheckName;
  ok: boolean;
  /** Present only when `ok` is false -- names pending migration tags or the underlying error, never a DSN/credential (T-14-03). */
  detail?: string;
}

export interface ReadinessResult {
  ready: boolean;
  checks: ReadinessCheckResult[];
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Bounds every readiness check to a fixed wall-clock budget. Without this, a
 * check whose underlying client retries forever (ioredis's default
 * `retryStrategy` never gives up; BullMQ requires `maxRetriesPerRequest:
 * null`) never resolves NOR rejects on its own -- `/readyz` would hang
 * indefinitely instead of reporting "not ready" promptly (Rule 1 fix,
 * discovered by this plan's own Task 3 Redis-down test: the naive
 * `await campaignKickoffQueue.client` call hung the whole request). A
 * readiness probe that hangs is strictly worse than one that answers 503
 * fast -- an orchestrator waiting on this endpoint needs a bounded answer.
 */
const READINESS_CHECK_TIMEOUT_MS = 2_000;

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} check timed out after ${String(READINESS_CHECK_TIMEOUT_MS)}ms`));
    }, READINESS_CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkPostgres(): Promise<ReadinessCheckResult> {
  try {
    await withTimeout(pool.query("SELECT 1"), "postgres");
    return { name: "postgres", ok: true };
  } catch (err) {
    return { name: "postgres", ok: false, detail: errorDetail(err) };
  }
}

/**
 * Reuses `campaignKickoffQueue`'s own Redis connection (BullMQ's `Queue.client`
 * getter resolves to the underlying client) rather than opening a second
 * connection -- the API already reaches Redis exactly this way
 * (`apps/api/src/modules/campaigns/campaign-queues.ts`). Uses `info()` rather
 * than `ping()` as the round-trip probe: BullMQ's own `IRedisClient`
 * abstraction (bullmq's adapter-agnostic client interface, covering ioredis
 * today and other clients later) declares `info()` but not `ping()`, and
 * `info()` still requires a real round-trip to Redis, rejecting exactly the
 * same way `ping()` would on an unreachable connection.
 *
 * Wrapped in `withTimeout`: `campaignKickoffQueue.client` itself does not
 * resolve OR reject while the underlying connection is still retrying (which
 * it does forever by default) -- without the bound, this check would hang
 * `/readyz` rather than reporting Redis unreachable.
 */
async function checkRedis(): Promise<ReadinessCheckResult> {
  try {
    await withTimeout(
      (async () => {
        const client = await campaignKickoffQueue.client;
        await client.info();
      })(),
      "redis",
    );
    return { name: "redis", ok: true };
  } catch (err) {
    return { name: "redis", ok: false, detail: errorDetail(err) };
  }
}

/**
 * D-13: reuses `assertMigrationsCurrent` -- the SAME applied-vs-shipped
 * definition the migrate runner's underlying `drizzle-orm migrate()` uses
 * (see `packages/db/src/migration-journal.ts`'s header) -- on the API's own
 * existing pool, not a second connection.
 */
async function checkMigrations(): Promise<ReadinessCheckResult> {
  try {
    await assertMigrationsCurrent(pool);
    return { name: "migrations", ok: true };
  } catch (err) {
    if (err instanceof MigrationsPendingError) {
      return { name: "migrations", ok: false, detail: `pending: ${err.pendingTags.join(", ")}` };
    }
    if (err instanceof MigrationsTableMissingError) {
      return { name: "migrations", ok: false, detail: err.message };
    }
    return { name: "migrations", ok: false, detail: errorDetail(err) };
  }
}

/**
 * Runs all three named checks for `/readyz` (OPS-05). NOT used by the
 * onRequest guard below -- see that function's own comment for why the
 * guard checks migrations only, never Postgres-in-general or Redis.
 */
export async function checkReadiness(): Promise<ReadinessResult> {
  const checks = await Promise.all([checkPostgres(), checkRedis(), checkMigrations()]);
  return { ready: checks.every((check) => check.ok), checks };
}

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: app.register() resolves the returned promise, and the declared Promise<void> is part of that signature -- dropping async would change it, not simplify it
export async function registerOpsHealthRoutes(fastify: FastifyInstance): Promise<void> {
  // OPS-04: pure process liveness. No I/O whatsoever -- never Postgres, never
  // Redis -- because a liveness probe that fails during a database outage
  // gets the container killed for an outage it did not cause (T-14-06).
  fastify.get("/healthz", (_request, reply) => {
    reply.code(200).send({ status: "ok" });
  });

  fastify.get("/readyz", async (_request, reply) => {
    const result = await checkReadiness();
    reply.code(result.ready ? 200 : 503).send(result);
  });
}

/**
 * DB-06's fail-closed request guard, consumed by `buildServer()`'s
 * `onRequest` hook (`server.ts`). Confirms migration currency ONCE, then
 * latches permanently: the shipped migration set is baked into the image
 * and the journal only grows, so "current" cannot become false again for
 * this running process -- a per-request query would put a round trip on
 * every request in the platform for a condition that changes at most once
 * in a container's lifetime.
 *
 * On failure the memo is cleared (not the confirmed flag, which stays
 * false) so the NEXT request retries the check rather than caching a
 * failure forever -- a transient connection blip on the very first request
 * must not permanently wedge the guard into refusing all traffic.
 *
 * Deliberately migrations-only, never Postgres-liveness-in-general and
 * never Redis: DB-06's requirement is literally "does not accept traffic
 * until migrations complete", and widening this guard to Redis would make
 * every apps/api integration suite depend on a live Redis for routes that
 * never touch it. `/readyz` (OPS-05) is where all three checks live; this
 * guard is where the migration half is enforced against every request.
 */
let migrationsConfirmed = false;
let migrationsCheckPromise: Promise<void> | null = null;

export async function ensureMigrationsCurrentOnce(): Promise<void> {
  if (migrationsConfirmed) return;
  if (!migrationsCheckPromise) {
    migrationsCheckPromise = assertMigrationsCurrent(pool)
      .then(() => {
        migrationsConfirmed = true;
      })
      .catch((err: unknown) => {
        migrationsCheckPromise = null;
        throw err;
      });
  }
  return migrationsCheckPromise;
}

/** Test-only: resets the module-level latch between test cases (each test needs its own confirm-once lifecycle). */
export function resetMigrationGuardForTests(): void {
  migrationsConfirmed = false;
  migrationsCheckPromise = null;
}
