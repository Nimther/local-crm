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

async function checkPostgres(): Promise<ReadinessCheckResult> {
  try {
    await pool.query("SELECT 1");
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
 */
async function checkRedis(): Promise<ReadinessCheckResult> {
  try {
    const client = await campaignKickoffQueue.client;
    await client.info();
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
 * Runs all three named checks. Exported so both the `/readyz` route and the
 * onRequest readiness guard (plan 14-01 Task 3) can call it -- though the
 * guard only cares about the `migrations` check, per DB-06 vs OPS-05's split
 * (see the guard's own comment in `server.ts`).
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
