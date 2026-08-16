import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import type { FastifyInstance } from "fastify";
import { boardQueues } from "./queues/board-queues.js";

/**
 * Phase 15 plan 16 (OPS-14, D-09/D-10): Bull Board, mounted on the worker's
 * own loopback-only health listener (`health-server.ts`) rather than a new
 * HTTP surface -- Phase 14's own comment on `WORKER_HEALTH_PORT_DEFAULT`
 * reserved this listener for exactly this use.
 *
 * Access control here is network topology, not application authorization
 * (D-09, T-15-54): the listener binds to `127.0.0.1` only, no port is
 * published in `docker/docker-compose.prod.yml`, and the only path in is an
 * SSH tunnel the operator already has. There is no auth middleware in front
 * of this board, and none is needed -- adding one would be a second,
 * redundant control on top of the actual boundary (network reachability),
 * not a stronger one.
 *
 * The board is a diagnostic VIEW, not a control panel (T-15-55): every
 * `BullMQAdapter` is constructed with `readOnlyMode: true`, which
 * `@bull-board/api`'s own `queueProvider` (`providers/queue.js`) enforces
 * server-side -- any mutating route (retry/remove/promote/clean/pause/
 * resume/obliterate) on a read-only queue returns 405 `ERRORS.QUEUE_READ_ONLY`
 * regardless of what the UI renders. This is NOT merely hiding buttons in
 * the frontend; the API layer itself refuses the mutation.
 */
export const BULL_BOARD_BASE_PATH = "/admin/queues";

/**
 * Mounts the board onto an already-built, not-yet-listening Fastify
 * instance -- called from `health-server.ts`'s `beforeListen` hook (Task 1),
 * itself invoked by `server.ts`'s `buildWorker()` after `board-queues.ts`'s
 * handles exist and before the listener starts accepting connections.
 */
export async function mountBullBoard(app: FastifyInstance): Promise<void> {
  const serverAdapter = new FastifyAdapter();
  serverAdapter.setBasePath(BULL_BOARD_BASE_PATH);

  createBullBoard({
    queues: boardQueues.map((queue) => new BullMQAdapter(queue, { readOnlyMode: true })),
    serverAdapter,
  });

  await app.register(serverAdapter.registerPlugin(), { prefix: BULL_BOARD_BASE_PATH });
}
