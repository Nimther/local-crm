import http, { type IncomingMessage, type ServerResponse } from "node:http";
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
 * Built on `node:http` directly, not Fastify: `apps/worker/package.json`
 * declares `fastify` as a devDependency ONLY (D-14) -- the worker has no
 * production HTTP framework, and this is the one listener it needs.
 *
 * D-14 / T-14-17: this listener is bound to `WORKER_HEALTH_HOST`
 * (`127.0.0.1`) and is NEVER published to the host network (plan 14-08 must
 * not add a port mapping for it). Container healthchecks probe it from
 * inside the container; the deploy script observes worker health through
 * the container's own health status, never an HTTP connection from the
 * host. `apps/api`'s `/readyz` -- already reachable through Caddy -- remains
 * the deploy script's HTTP-level gate.
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
 * run health listeners on the same host without a collision. Phase 15's
 * observability work is expected to reuse THIS SAME listener (e.g. a
 * metrics route) rather than add a second HTTP surface to the worker
 * process.
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
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Routes exactly two paths, GET/HEAD only.
 *
 * `/healthz`: OPS-04, T-14-19. Zero I/O -- the handler never even reads
 * `deps` -- because the container healthcheck drives restarts, and a
 * liveness probe that fails during a backing-service outage converts a
 * dependency incident into a restart loop of otherwise-healthy worker
 * processes.
 *
 * `/readyz`: OPS-05. The draining flag short-circuits FIRST (see its own
 * comment above); otherwise runs `checkWorkerReadiness` and reports 200
 * only when every check passes, 503 naming the failing check(s) otherwise.
 *
 * Anything other than GET/HEAD on these two exact paths is rejected (405
 * wrong-method, 404 unknown-path) -- T-14-17: this listener answers exactly
 * two infrastructure questions and discloses nothing else.
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WorkerReadinessDeps
): Promise<void> {
  const url = req.url ?? "";
  const method = req.method ?? "GET";
  const isHead = method === "HEAD";

  // Health/readiness probes are infrequent and short-lived (a container
  // healthcheck or the deploy script polling every few seconds) -- there is
  // no benefit to keep-alive here, and closing the connection after every
  // response avoids a class of client-side connection-pool-reuse bugs
  // (observed directly in this plan's own test suite: a client that keeps a
  // connection alive to this exact host:port across a `close()` + rebind of
  // the listener will otherwise try to reuse the now-dead socket for its
  // next request and see an ECONNRESET instead of a clean new connection).
  res.setHeader("Connection", "close");

  if (url !== "/healthz" && url !== "/readyz") {
    if (isHead) {
      res.writeHead(404);
      res.end();
      return;
    }
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  if (method !== "GET" && !isHead) {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  if (url === "/healthz") {
    if (isHead) {
      res.writeHead(200);
      res.end();
      return;
    }
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // /readyz
  if (draining) {
    const body: WorkerReadinessResult = { ready: false, checks: [] };
    if (isHead) {
      res.writeHead(503);
      res.end();
      return;
    }
    sendJson(res, 503, body);
    return;
  }

  const result = await checkWorkerReadiness(deps);
  if (isHead) {
    res.writeHead(result.ready ? 200 : 503);
    res.end();
    return;
  }
  sendJson(res, result.ready ? 200 : 503, result);
}

/**
 * Starts the worker's health listener on `WORKER_HEALTH_HOST` (never
 * overridable -- D-14) and the resolved port. Returns once the socket is
 * bound and accepting connections. `close()` is idempotent: closing an
 * already-closed `node:http` server rejects, so this module guards that
 * with its own internal flag rather than pushing the guard onto every
 * caller (`server.ts`'s `closeWorkerRuntime` relies on this).
 */
export function startWorkerHealthServer(deps: StartWorkerHealthServerDeps): Promise<WorkerHealthServer> {
  const port = deps.port ?? Number(process.env.WORKER_HEALTH_PORT ?? WORKER_HEALTH_PORT_DEFAULT);

  const server = http.createServer((req, res) => {
    handleRequest(req, res, deps).catch((err: unknown) => {
      scrubbedConsole.error("apps/worker health server: unhandled request error", err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" });
      } else {
        res.end();
      }
    });
  });

  let closed = false;
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  };

  return new Promise((resolve, reject) => {
    const onListenError = (err: Error): void => {
      reject(err);
    };
    server.once("error", onListenError);
    server.listen(port, WORKER_HEALTH_HOST, () => {
      server.removeListener("error", onListenError);
      server.on("error", (err) => {
        scrubbedConsole.error("apps/worker health server error", err);
      });
      resolve({ close });
    });
  });
}
