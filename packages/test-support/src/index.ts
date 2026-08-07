export { assertTestDatabaseUrl } from "./guard.js";
export {
  AUTH_ROLE,
  SCAN_ROLE,
  buildEphemeralDatabaseName,
  buildRoleDsn,
  createEphemeralDatabase,
  dropEphemeralDatabase,
  ensureClusterRoles,
  quoteIdentifier,
} from "./provision-db.js";
export {
  MIGRATION_ADVISORY_LOCK_KEY,
  createTestPool,
  ensureTestDbMigrated,
  getAuthTestDatabaseUrl,
  getMigrationsDir,
  getScanTestDatabaseUrl,
  getTestDatabaseUrl,
} from "./db-fixture.js";
export {
  applyMigrationFile,
  applyMigrationsUpTo,
  applyRemainingMigrations,
  listMigrationFiles,
} from "./migration-runner.js";
export type { MigrationClient } from "./migration-runner.js";
export { spawnAndAwaitReady } from "./harness/spawn-and-kill.js";
export { killAndAwaitExit } from "./harness/spawn-and-kill.js";
export type {
  ChildExitResult,
  SpawnAndAwaitReadyOptions,
  SpawnedChild,
} from "./harness/spawn-and-kill.js";
export { startTempRedis } from "./harness/temp-redis.js";
export type { StartTempRedisOptions, TempRedis } from "./harness/temp-redis.js";
