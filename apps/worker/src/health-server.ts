import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { MigrationsPendingError, MigrationsTableMissingError } from "@mega-crm/db";
import { scrubbedConsole } from "@mega-crm/redaction";

/**
 * Phase 14 plan 04 (D-14, OPS-04/OPS-05): the worker's own `/healthz` +
 * `/readyz`, matching `apps/api/src/modules/ops/health.ts`'s contract
 * EXACTLY -- same three check names (postgres/redis/migrations), same
 * response body shape (`{ ready, checks: [{ name, ok, detail? }] }`), same
 * status-code semantics (`/healthz` always 200; `/readyz` 200 iff every
 * check passes, else 503 naming the failing check(s)). Divergence here
 * would mean the deploy script and the container healthchecks need two
 * parsers for what is conceptually one question asked of two processes.
 *
 * Phase 15 plan 16 (OPS-14, D-10, T-15-56): re-hosted on Fastify -- required
 * because `@bull-board/fastify`'s adapter needs a Fastify instance to mount
 * onto, and Phase 14's own comment (see `WORKER_HEALTH_PORT_DEFAULT` below)
 * explicitly reserved THIS listener for that future use rather than allowing
 * a second HTTP surface on the worker process. The externally-observed
 * contract (status codes, body shape, headers) is unchanged -- proven by
 * `__tests__/health-server-contract.test.ts`, captured against the
 * pre-migration `node:http` implementation and required to pass unchanged
 * against this one.
 *
 * D-14 / T-14-17 / T-15-54: this listener is bound to `WORKER_HEALTH_HOST`
 * (`127.0.0.1`) and is NEVER published to the host network (plan 14-08, and
 * this plan's own SPECIFICATION.md update, confirm no port mapping for it).
 * Container healthchecks probe it from inside the container; the deploy
 * script observes worker health through the container's own health status,
 * never an HTTP connection from the host. `apps/api`'s `/readyz` -- already
 * reachable through Caddy -- remains the deploy script's HTTP-level gate.
 */

export type WorkerReadinessCheckName = "postgres" | "redis" | "migrations";

export interface WorkerReadinessCheckResult {
  name: WorkerReadinessCheckName;
  ok: boolean;
  /** Present only when `ok` is false -- a pending-migration tag list or the underlying error message, never a DSN/credential/tenant id (T-14-17). */
  detail?: string;
}

export interface WorkerReadinessResult {
  ready: boolean;
  checks: WorkerReadinessCheckResult[];
}

/**
 * Loopback ONLY -- literally `127.0.0.1`, never the string `"localhost"`
 * (which can resolve to `::1` depending on the host's resolver order, and a
 * security boundary should not depend on that ambiguity) and never
 * `0.0.0.0` (T-14-17: this listener must never be reachable from outside
 * the container).
 */
export const WORKER_HEALTH_HOST = "127.0.0.1";

/**
 * Fallback port, read from the `WORKER_HEALTH_PORT` environment variable
 * with this constant as the documented default. Distinct from `apps/api`'s
 * `API_PORT` default (4000, `apps/api/src/env.ts`) so both processes can
 * run health listeners on the same host without a collision. Phase 15 plan
 * 16 (OPS-14) reuses THIS SAME listener for the Bull Board mount, exactly as
 * this comment originally anticipated, rather than adding a second HTTP
 * surface to the worker process.
 */
export const WORKER_HEALTH_PORT_DEFAULT = 4100;

/**
 * Bounds every readiness check to a fixed wall-clock budget -- identical
 * value and rationale to `apps/api/src/modules/ops/health.ts`'s own
 * `READINESS_CHECK_TIMEOUT_MS`: a check whose underlying client retries
 * forever (ioredis's default `retryStrategy` never gives up; BullMQ
 * requires `maxRetriesPerRequest: null`) never resolves NOR rejects on its
 * own -- without this bound, `/readyz` would hang instead of reporting
 * "not ready" promptly.
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

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The three readiness dependencies, injected rather than constructed inside
 * this module -- so tests can drive each failure independently (a rejecting
 * `queryPostgres`, a `redisConnection.info()` that throws, a
 * `checkMigrationsCurrent` that throws `MigrationsPendingError`) without
 * touching any real backing service. `server.ts` wires the production
 * values: the shared `@mega-crm/tenant-context` pool for `queryPostgres`,
 * the worker's own already-open ioredis connection (`WorkerRuntime.connection`)
 * for `redisConnection` -- never a second connection, this listener's own
 * connection-count budget depends on that -- and `assertMigrationsCurrent`
 * (imported from `@mega-crm/db`'s migration-journal module, D-13) bound to
 * that same pool for `checkMigrationsCurrent`.
 */
export interface WorkerReadinessDeps {
  queryPostgres: () => Promise<unknown>;
  redisConnection: Pick<Redis, "info">;
  checkMigrationsCurrent: () => Promise<void>;
}

async function checkPostgres(deps: WorkerReadinessDeps): Promise<WorkerReadinessCheckResult> {
  try {
    await withTimeout(deps.queryPostgres(), "postgres");
    return { name: "postgres", ok: true };
  } catch (err) {
    return { name: "postgres", ok: false, detail: errorDetail(err) };
  }
}

/**
 * Pings the SAME connection `WorkerRuntime.connection` already holds
 * (`server.ts` passes it straight through) -- never a second Redis
 * connection. Uses `info()` for the same reason `apps/api`'s `checkRedis`
 * does: it is a real round trip, and it is declared on BullMQ's own
 * adapter-agnostic `IRedisClient` interface (covering ioredis today).
 */
async function checkRedis(deps: WorkerReadinessDeps): Promise<WorkerReadinessCheckResult> {
  try {
    await withTimeout(deps.redisConnection.info(), "redis");
    return { name: "redis", ok: true };
  } catch (err) {
    return { name: "redis", ok: false, detail: errorDetail(err) };
  }
}

/**
 * D-13: the caller's `checkMigrationsCurrent` is `assertMigrationsCurrent`
 * (`packages/db/src/migration-journal.ts`) bound to the worker's own pool --
 * the SAME applied-vs-shipped definition `apps/api`'s `/readyz` uses. This
 * function only FORMATS the two named error subclasses that call can throw;
 * it never re-derives the comparison itself.
 */
async function checkMigrations(deps: WorkerReadinessDeps): Promise<WorkerReadinessCheckResult> {
  try {
    await deps.checkMigrationsCurrent();
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

/** OPS-05: runs all three named checks. Never consulted by `/healthz` -- see that route's own comment below for why. */
export async function checkWorkerReadiness(deps: WorkerReadinessDeps): Promise<WorkerReadinessResult> {
  const checks = await Promise.all([checkPostgres(deps), checkRedis(deps), checkMigrations(deps)]);
  return { ready: checks.every((check) => check.ok), checks };
}

/**
 * R-05 (stop-old-then-start-new): a module-scoped flag, set once by the
 * SIGTERM/SIGINT shutdown path (`server.ts`'s `requestWorkerRuntimeShutdown`)
 * and NEVER cleared -- monotonic by design (T-14-21). `/readyz`
 * short-circuits on it before running any of the three checks above: an
 * aborting process should not spend a database round trip to say it is
 * going away, and a draining worker must never flicker back to ready.
 */
let draining = false;

export function markWorkerDraining(): void {
  draining = true;
}

/** Test-only: resets the module-level latch between test cases (mirrors `apps/api/src/modules/ops/health.ts`'s `resetMigrationGuardForTests`). */
export function resetWorkerDrainingForTests(): void {
  draining = false;
}

export interface WorkerHealthServer {
  close: () => Promise<void>;
}

export interface StartWorkerHealthServerDeps extends WorkerReadinessDeps {
  /** Test-only override. Production always resolves from `WORKER_HEALTH_PORT` / `WORKER_HEALTH_PORT_DEFAULT` above. */
  port?: number;
  /**
   * Phase 15 plan 16 (OPS-14): the Bull Board mount point. Invoked with the
   * built Fastify instance AFTER `/healthz`/`/readyz` are registered but
   * BEFORE `app.listen(...)` is called -- so a plugin registered here (the
   * Bull Board adapter, `bull-board.ts`) is live from the very first
   * accepted connection, and `server.ts` never needs to import this
   * module's internal Fastify instance directly. Optional so every existing
   * test call site (which never mounts anything extra) keeps working
   * unchanged.
   */
  beforeListen?: (app: FastifyInstance) => Promise<void> | void;
}

/**
 * Every response -- 200, 404, 405, 500, whatever -- carries `Connection:
 * close` (T-14-?? empirically discovered during the original plan 14-04:
 * undici's connection-pool otherwise tries to reuse a stale keep-alive
 * socket against a closed-and-restarted listener on the same port, giving
 * `ECONNRESET` instead of a clean new connection). Health/readiness probes
 * are infrequent and short-lived (a container healthcheck or the deploy
 * script polling every few seconds) -- there is no benefit to keep-alive
 * here. Applied via a global `onSend` hook rather than per-route so it
 * covers the 404/405 paths too, matching the pre-Fastify implementation's
 * behavior of setting this header before any routing decision is made.
 */
function registerConnectionCloseHook(app: FastifyInstance): void {
  app.addHook("onSend", (_request, reply, payload, done) => {
    reply.header("Connection", "close");
    done(null, payload);
  });
}

const ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/**
 * Routes exactly two paths, GET/HEAD only -- registered against every HTTP
 * method so this handler (not Fastify's own 404 fallback) decides the
 * response for a wrong-method request on one of these two exact paths (405,
 * matching the pre-Fastify implementation), while any OTHER path still
 * falls through to `setNotFoundHandler` below (404).
 */
function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/**
 * `/healthz`: OPS-04, T-14-19. Zero I/O -- the handler never even reads
 * `deps` -- because the container healthcheck drives restarts, and a
 * liveness probe that fails during a backing-service outage converts a
 * dependency incident into a restart loop of otherwise-healthy worker
 * processes.
 */
function handleHealthz(request: FastifyRequest, reply: FastifyReply): void {
  if (!isReadMethod(request.method)) {
    reply.code(405).send({ error: "method_not_allowed" });
    return;
  }
  reply.code(200).send({ status: "ok" });
}

/**
 * `/readyz`: OPS-05. The draining flag short-circuits FIRST (see its own
 * comment above); otherwise runs `checkWorkerReadiness` and reports 200
 * only when every check passes, 503 naming the failing check(s) otherwise.
 */
async function handleReadyz(request: FastifyRequest, reply: FastifyReply, deps: WorkerReadinessDeps): Promise<void> {
  if (!isReadMethod(request.method)) {
    reply.code(405).send({ error: "method_not_allowed" });
    return;
  }

  if (draining) {
    const body: WorkerReadinessResult = { ready: false, checks: [] };
    reply.code(503).send(body);
    return;
  }

  const result = await checkWorkerReadiness(deps);
  reply.code(result.ready ? 200 : 503).send(result);
}

/**
 * Builds (but does not start) the Fastify instance backing this listener --
 * split out from `startWorkerHealthServer` so `beforeListen` runs against a
 * fully-routed, not-yet-listening instance (Phase 15 plan 16's Bull Board
 * mount point). `logger: false` -- this is an internal infrastructure
 * listener probed every few seconds by container healthchecks; per-request
 * access logs here would be pure noise, and errors are still surfaced via
 * `scrubbedConsole` in the error handler below, matching the pre-Fastify
 * implementation's own unhandled-error logging.
 */
function buildWorkerHealthApp(deps: WorkerReadinessDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  registerConnectionCloseHook(app);

  app.route({
    method: [...ALL_METHODS],
    url: "/healthz",
    handler: (request, reply) => {
      handleHealthz(request, reply);
    },
  });

  app.route({
    method: [...ALL_METHODS],
    url: "/readyz",
    handler: async (request, reply) => {
      await handleReadyz(request, reply, deps);
    },
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "not_found" });
  });

  app.setErrorHandler((err, _request, reply) => {
    scrubbedConsole.error("apps/worker health server: unhandled request error", err);
    if (!reply.sent) {
      reply.code(500).send({ error: "internal_error" });
    }
  });

  return app;
}

/**
 * Starts the worker's health listener on `WORKER_HEALTH_HOST` (never
 * overridable -- D-14) and the resolved port. Returns once the socket is
 * bound and accepting connections. `close()` is idempotent -- calling
 * Fastify's own `close()` twice is harmless in practice, but this module
 * guards it explicitly anyway so the contract (`close()` is safe to call
 * more than once) does not depend on that Fastify internal (`server.ts`'s
 * `closeWorkerRuntime` relies on this).
 */
export async function startWorkerHealthServer(deps: StartWorkerHealthServerDeps): Promise<WorkerHealthServer> {
  const port = deps.port ?? Number(process.env.WORKER_HEALTH_PORT ?? WORKER_HEALTH_PORT_DEFAULT);

  const app = buildWorkerHealthApp(deps);

  if (deps.beforeListen) {
    await deps.beforeListen(app);
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await app.close();
  };

  try {
    await app.listen({ port, host: WORKER_HEALTH_HOST });
  } catch (err) {
    await app.close().catch(() => undefined);
    throw err;
  }

  return { close };
}
