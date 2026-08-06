import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { checkRedisConfig } from "../../../../scripts/verify-redis-config.mjs";
import { startTempRedis, type StartTempRedisOptions, type TempRedis } from "../harness/temp-redis.js";

/**
 * 08-04 (WRK-12) — Redis refuses writes at its ceiling instead of silently
 * evicting BullMQ job state, and the check that proves it can actually fail.
 *
 * The verifier under test is `scripts/verify-redis-config.mjs`. It is the SAME
 * script CI runs against the `redis:7` container; the only thing that differs
 * between the two environments is the REDIS_URL handed to it from outside. It
 * is invoked here as a subprocess rather than imported, so what these
 * assertions exercise is literally the CI entry point, exit code included.
 *
 * Every server used here is a throwaway started by the harness on a free port
 * with a temporary data directory. The developer's own Redis on 6379 is never
 * connected to, never reconfigured, and never restarted.
 *
 * The fail-first proof SPEC R7 demands is not a one-time transcript here — it
 * is the first test below, which boots a deliberately unconfigured server on
 * every run and asserts the verifier rejects it. A check that has only ever
 * been seen to pass is indistinguishable from a check that asserts nothing.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const VERIFIER = path.join(REPO_ROOT, "scripts/verify-redis-config.mjs");
const REDIS_CONF = path.join(REPO_ROOT, "docker/redis.conf");

interface VerifierRun {
  exitCode: number;
  output: string;
}

/** Run the verifier exactly as CI does, with REDIS_URL supplied from outside. */
function runVerifier(redisUrl: string | undefined): VerifierRun {
  const env = { ...process.env };
  delete env.REDIS_URL;
  if (redisUrl !== undefined) env.REDIS_URL = redisUrl;

  const result = spawnSync(process.execPath, [VERIFIER], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
  });

  return {
    exitCode: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** Guarantees the server is stopped and its data directory removed. */
async function withTempRedis<T>(
  options: StartTempRedisOptions,
  fn: (redis: TempRedis) => T | Promise<T>,
): Promise<T> {
  const redis = await startTempRedis(options);
  try {
    return await fn(redis);
  } finally {
    await redis.stop();
  }
}

describe("fail-first — the verifier rejects an unconfigured server", () => {
  it("fails against a stock redis-server, naming maxmemory and appendonly", async () => {
    const run = await withTempRedis({}, (redis) => runVerifier(redis.url));

    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/maxmemory/);
    expect(run.output).toMatch(/appendonly/);
    // The two directives a stock server gets wrong, with their observed values.
    expect(run.output).toMatch(/maxmemory\s+= 0/);
    expect(run.output).toMatch(/appendonly\s+= no/);
  });
});

describe("green — the versioned docker/redis.conf satisfies the verifier", () => {
  it("is version-controlled and present", () => {
    expect(existsSync(REDIS_CONF)).toBe(true);
  });

  it("passes when redis-server is booted from docker/redis.conf", async () => {
    const run = await withTempRedis({ configFile: REDIS_CONF }, (redis) => runVerifier(redis.url));

    expect(run.output).toMatch(/maxmemory-policy\s+= noeviction/);
    expect(run.output).toMatch(/appendonly\s+= yes/);
    expect(run.output).toMatch(/appendfsync\s+= everysec/);
    expect(run.exitCode).toBe(0);
  });
});

/**
 * A skipped check exits 0 — that is precisely what makes it dangerous, because
 * CI reads it as success. So the anti-skip contract is asserted on the exit
 * code itself, not on the wording of the message.
 */
describe("an unverifiable server is a failure, never a skip", () => {
  it("fails when nothing is listening on the target port", async () => {
    // Start and immediately stop a server, so the port is provably unused.
    const redis = await startTempRedis({});
    const deadUrl = redis.url;
    await redis.stop();

    const run = runVerifier(deadUrl);

    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/FAILED/);
    expect(run.output).toMatch(/ECONNREFUSED/);
  });

  it("fails when REDIS_URL is unset rather than defaulting to a server", () => {
    const run = runVerifier(undefined);

    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/REDIS_URL is unset/);
  });
});

/**
 * The discrimination logic, asserted without a server. `noeviction` is the
 * Redis default and cannot trigger while `maxmemory` is 0, so a policy-only
 * check would pass against a completely unconfigured server and prove nothing
 * (RESEARCH Pitfall 5).
 */
describe("checkRedisConfig — a policy-only assertion would be vacuous", () => {
  const GOOD = {
    maxmemory: "536870912",
    "maxmemory-policy": "noeviction",
    appendonly: "yes",
    appendfsync: "everysec",
  };

  it("accepts the full four-directive configuration", () => {
    expect(checkRedisConfig(GOOD).pass).toBe(true);
  });

  it("rejects noeviction when maxmemory is 0", () => {
    const result = checkRedisConfig({ ...GOOD, maxmemory: "0" });
    expect(result.pass).toBe(false);
    expect(result.failures.map((f) => f.directive)).toContain("maxmemory");
  });

  it("rejects a missing memory ceiling", () => {
    const result = checkRedisConfig({ ...GOOD, maxmemory: undefined });
    expect(result.pass).toBe(false);
    expect(result.failures.map((f) => f.directive)).toContain("maxmemory");
  });

  it.each([
    ["maxmemory-policy", "allkeys-lru"],
    ["appendonly", "no"],
    ["appendfsync", "always"],
  ])("rejects %s = %s", (directive, value) => {
    const result = checkRedisConfig({ ...GOOD, [directive]: value });
    expect(result.pass).toBe(false);
    expect(result.failures.map((f) => f.directive)).toContain(directive);
  });

  it("reports every wrong directive at once, not just the first", () => {
    const result = checkRedisConfig({});
    expect(result.failures.map((f) => f.directive).sort()).toEqual([
      "appendfsync",
      "appendonly",
      "maxmemory",
      "maxmemory-policy",
    ]);
  });
});
