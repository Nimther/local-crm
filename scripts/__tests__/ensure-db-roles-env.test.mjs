// GSD 10-15 (SEC-01/SEC-02, gap G-10-1): proves scripts/ensure-db-roles.mjs
// resolves its admin DSN through resolveEnvPath() like every sibling DSN
// consumer, instead of bare process.env.
//
// Mirrors lint-session-state.test.mjs's subprocess-CLI pattern
// (execFileSync wrapped so a non-zero exit is captured, not thrown), but
// passes an explicit `env` option instead of inheriting process.env -- the
// whole point is to control exactly which admin-DSN keys the child process
// sees. None of the three cases reaches a database: every sentinel DSN below
// points at a loopback port with no listener, so node-postgres refuses the
// connection before any role-creation statement runs (T-10-15-02).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/ensure-db-roles.mjs");

let tmpDir;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "ensure-db-roles-env-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** The shape execFileSync throws on a non-zero exit -- normalized like runCli in lint-session-state.test.mjs. */
function runCli(env) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
    });
    return { exitCode: 0, output: stdout };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

/**
 * Shallow-copies process.env with both admin-DSN keys deleted, so a
 * developer shell or CI job that already exports either one cannot change
 * the outcome of a case that isn't testing that precedence.
 */
function baseEnv() {
  const env = { ...process.env };
  delete env.TEST_ADMIN_DATABASE_URL;
  delete env.GSD_ADMIN_DATABASE_URL;
  return env;
}

describe("Test 1 (the gap) — admin DSN loaded from the external env file", () => {
  it("connects using the file's DSN, not the compose-default constant", () => {
    const envFile = path.join(tmpDir, "test1.env");
    writeFileSync(
      envFile,
      "TEST_ADMIN_DATABASE_URL=postgres://sentinel_user:sentinel_pw@127.0.0.1:59999/sentinel_db_1\n",
    );

    const env = baseEnv();
    env.MEGA_CRM_ENV_FILE = envFile;

    const run = runCli(env);

    expect(run.exitCode).not.toBe(0);
    // node-postgres puts host:port in its connection-refused message -- this
    // is the proof the value came from the file, not the DEFAULT_ADMIN_DSN
    // fallback (which would name port 5432 instead). Never assert on a full
    // printed DSN: the script must not log the credentials it resolved.
    expect(run.output).toContain("127.0.0.1:59999");
    expect(run.output).not.toContain(":5432");
  });
});

describe("Test 2 — a directly exported admin DSN still outranks the file", () => {
  it("resolves the exported DSN's port, not the file's", () => {
    const envFile = path.join(tmpDir, "test2.env");
    writeFileSync(
      envFile,
      "TEST_ADMIN_DATABASE_URL=postgres://sentinel_user:sentinel_pw@127.0.0.1:59999/sentinel_db_2\n",
    );

    const env = baseEnv();
    env.MEGA_CRM_ENV_FILE = envFile;
    env.GSD_ADMIN_DATABASE_URL =
      "postgres://sentinel_user:sentinel_pw@127.0.0.1:59998/sentinel_db_2b";

    const run = runCli(env);

    expect(run.exitCode).not.toBe(0);
    expect(run.output).toContain("127.0.0.1:59998");
    expect(run.output).not.toContain("59999");
  });
});

describe("Test 3 — a missing env file is tolerated", () => {
  it("does not crash on the failed load and still resolves the exported DSN", () => {
    const missingPath = path.join(tmpDir, "does-not-exist", "missing.env");

    const env = baseEnv();
    env.MEGA_CRM_ENV_FILE = missingPath;
    env.GSD_ADMIN_DATABASE_URL =
      "postgres://sentinel_user:sentinel_pw@127.0.0.1:59998/sentinel_db_3";

    const run = runCli(env);

    expect(run.exitCode).not.toBe(0);
    expect(run.output).toContain("127.0.0.1:59998");
  });
});
