import { z } from "zod";

/**
 * Phase 22 (PRG-01, D-06, plan 22-01): apps/worker's FIRST boot-time
 * zod-validated env module. Every existing worker env variable
 * (`REDIS_URL`, `SCAN_DATABASE_URL`, `UNSUBSCRIBE_TOKEN_SECRET`, ...) is
 * still validated ad hoc inside `server.ts`'s `buildWorker()` -- this module
 * does not absorb them, it only adds the two new variables this phase
 * introduces. Mirrors `apps/api/src/env.ts`'s shape (a zod object,
 * `safeParse`, a human-readable thrown message naming every failing path)
 * so a future consolidation of the worker's env validation has a precedent
 * to extend rather than a second, differently-shaped scheme to reconcile.
 *
 * `parseWorkerEnv` is a PURE function, exported separately from the
 * module-scope `workerEnv` it also produces, so a test can drive it against
 * an arbitrary object without mutating `process.env` (workspace-purge.test.ts's
 * "retention floor" case).
 */

/**
 * D-06: the worker refuses to start when `WORKSPACE_PURGE_RETENTION_DAYS`
 * parses below this floor. Seven days is the minimum window between a
 * workspace's soft-delete and its physical purge becoming eligible --
 * enough time for an accidental or disputed deletion to be caught and
 * reversed (the restore path, plan 22-06) before any tenant row is
 * destroyed.
 */
export const WORKSPACE_PURGE_RETENTION_DAYS_FLOOR = 7;

export const workerEnvSchema = z.object({
  /**
   * PRG-01: days a workspace must remain soft-deleted (`organization.deletedAt`
   * non-null) before the purge tick's eligibility query selects it. Defaults
   * to 30 -- comfortably above the floor -- so an environment that never sets
   * this variable at all still boots with a safe, deliberate value rather
   * than the floor itself.
   */
  WORKSPACE_PURGE_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .default(30)
    .refine((n) => n >= WORKSPACE_PURGE_RETENTION_DAYS_FLOOR, {
      message: `WORKSPACE_PURGE_RETENTION_DAYS must be at least ${WORKSPACE_PURGE_RETENTION_DAYS_FLOOR} days`,
    }),
  /** The purge tick's own `upsertJobScheduler` cron pattern, UTC. */
  WORKSPACE_PURGE_TICK_CRON: z.string().default("17 3 * * *"),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * Pure parse -- never reads `process.env` itself. Throws a single
 * human-readable `Error` naming every failing variable and its message
 * (mirrors `apps/api/src/env.ts`'s own thrown-message shape), rather than
 * letting a raw `ZodError` propagate.
 */
export function parseWorkerEnv(source: NodeJS.ProcessEnv): WorkerEnv {
  const parsed = workerEnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    });
    throw new Error(
      ["Invalid apps/worker environment configuration.", ...lines].join("\n"),
    );
  }
  return parsed.data;
}

// apps/worker/src/server.ts imports this module ONLY after `./load-env.js`'s
// side-effect import -- the same load-ordering apps/api's own env.ts depends
// on (ES module evaluation follows import order; a load placed after this
// import would parse against an already-populated `process.env`, but placed
// before it, this schema would parse an empty environment).
export const workerEnv: WorkerEnv = parseWorkerEnv(process.env);
