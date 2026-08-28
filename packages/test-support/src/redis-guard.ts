import { Redis } from "ioredis";

export type RedisDatabaseCleaner = (redisUrl: string) => Promise<void>;

const TEST_REDIS_URL_ERROR =
  "FATAL: the test Redis URL must name an explicit logical DB index >= 1; refusing to clear Redis DB 0 or an implicit database.";

/**
 * Fail-closed boundary for the one destructive Redis operation in the test
 * harness. DB 0 is the local development worker's default; only an explicit,
 * non-zero logical DB is eligible for a test-run FLUSHDB.
 */
export function assertTestRedisUrl(redisUrl: string | undefined): string {
  if (!redisUrl) throw new Error(TEST_REDIS_URL_ERROR);

  let parsed: URL;
  try {
    parsed = new URL(redisUrl);
  } catch {
    throw new Error(TEST_REDIS_URL_ERROR);
  }

  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error(TEST_REDIS_URL_ERROR);
  }

  const match = /^\/([1-9]\d*)$/.exec(parsed.pathname);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new Error(TEST_REDIS_URL_ERROR);
  }

  return redisUrl;
}

export function createTestRedisPreparer(
  clearDatabase: RedisDatabaseCleaner,
): (redisUrl: string | undefined) => Promise<void> {
  let preparedUrl: string | undefined;
  let preparation: Promise<void> | undefined;

  return async (redisUrl) => {
    const guardedUrl = assertTestRedisUrl(redisUrl);

    if (preparedUrl !== undefined && preparedUrl !== guardedUrl) {
      throw new Error(
        "FATAL: projects in one test run resolved a different test Redis URL; refusing to clear a second database.",
      );
    }

    preparedUrl ??= guardedUrl;
    preparation ??= clearDatabase(guardedUrl);
    await preparation;
  };
}

/** Clear only the already-guarded logical database, never the whole server. */
export async function clearTestRedisDatabase(redisUrl: string): Promise<void> {
  const guardedUrl = assertTestRedisUrl(redisUrl);
  const client = new Redis(guardedUrl, {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });

  // ioredis emits connection failures as events as well as rejecting the
  // awaited command. The awaited failure is the fail-loud path; this listener
  // prevents EventEmitter's unhandled-error fallback from obscuring it.
  client.on("error", () => undefined);

  try {
    await client.connect();
    await client.flushdb();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`FATAL: unable to clear the guarded test Redis database: ${detail}`);
  } finally {
    client.disconnect();
  }
}

export const prepareTestRedisOnce = createTestRedisPreparer(clearTestRedisDatabase);
