// GSD Phase 14 plan 11 (DB-10, D-07, T-14-68..T-14-73).
//
// Mirrors scripts/__tests__/deploy-script.test.mjs's own mix exactly: the
// CLI entry point (scripts/restore-drill.sh) is exercised as a real
// subprocess for the behaviors that are actually about exit codes and
// printed sequencing. No Docker daemon exists in this sandbox (repo-specific
// rule #5) -- every "real" (non `--dry-run`) invocation below runs against
// PATH-injected `docker`/`npm` stubs, logging every invocation and returning
// a scripted exit code/output driven by env vars this file sets per test.
// `--dry-run` needs no stub at all -- dry run never executes anything.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/restore-drill.sh");
const COMPOSE_FILE = path.join(REPO_ROOT, "docker/docker-compose.prod.yml");

const VALID_TARGET = "2026-08-13 04:27:54+00";

/** The shape execFileSync throws on a non-zero exit -- normalized either way. */
function runCli(args, { env = {} } = {}) {
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

/**
 * A `docker` stub (volume create/compose exec/run/exec pg_isready/rm/volume
 * rm, each independently scriptable) plus an `npm` stub (the
 * `db:verify-restored` invocation) -- both PATH-injected. Every invocation
 * is appended to `DRILL_TEST_LOG`, the assertion surface for ordering and
 * "no teardown ran" style behaviors.
 */
function setUpStubs(binDir, logFile) {
  writeFileSync(
    path.join(binDir, "docker"),
    `#!/usr/bin/env bash
echo "$*" >> "$DRILL_TEST_LOG"
args="$*"

if [[ "$1" == "volume" && "$2" == "create" ]]; then
  exit "\${DRILL_TEST_VOLUME_CREATE_EXIT_CODE:-0}"
fi
if [[ "$1" == "compose" ]]; then
  echo '{"contacts":1}'
  exit "\${DRILL_TEST_BASELINE_EXIT_CODE:-0}"
fi
if [[ "$1" == "run" ]]; then
  exit "\${DRILL_TEST_RUN_EXIT_CODE:-0}"
fi
if [[ "$1" == "exec" ]]; then
  exit "\${DRILL_TEST_READY_EXIT_CODE:-0}"
fi
if [[ "$1" == "rm" ]]; then
  exit "\${DRILL_TEST_RM_EXIT_CODE:-0}"
fi
if [[ "$args" == "volume rm"* ]]; then
  exit "\${DRILL_TEST_VOLUME_RM_EXIT_CODE:-0}"
fi
exit 0
`,
    { mode: 0o755 },
  );

  writeFileSync(
    path.join(binDir, "npm"),
    `#!/usr/bin/env bash
echo "NODE_ENV=$NODE_ENV npm $*" >> "$DRILL_TEST_LOG"
exit "\${DRILL_TEST_VERIFY_EXIT_CODE:-0}"
`,
    { mode: 0o755 },
  );

  return {
    PATH: `${binDir}:${process.env.PATH}`,
    DRILL_TEST_LOG: logFile,
  };
}

function makeScratch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "restore-drill-script-test-"));
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  const logFile = path.join(dir, "docker-calls.log");
  writeFileSync(logFile, "");
  const envFile = path.join(dir, "fake.env");
  // The real operator file sets production mode. The scratch verifier must
  // explicitly override that inherited value because it connects only to
  // the loopback-only throwaway Postgres container, not production.
  writeFileSync(envFile, "NODE_ENV=production\nPOSTGRES_PASSWORD=drill-test-password\nPOSTGRES_DB=mega_crm\n");
  const baselineFile = path.join(dir, "baseline.json");
  return { dir, binDir, logFile, envFile, baselineFile };
}

function baseRealEnv(scratch, overrides = {}) {
  return {
    ...setUpStubs(scratch.binDir, scratch.logFile),
    MEGA_CRM_ENV_FILE: scratch.envFile,
    RESTORE_DRILL_BASELINE_FILE: scratch.baselineFile,
    RESTORE_DRILL_READY_TIMEOUT_SECONDS: "2",
    RESTORE_DRILL_READY_POLL_INTERVAL_SECONDS: "1",
    ...overrides,
  };
}

function callLines(logFile) {
  return readFileSync(logFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

describe("syntax and strict-mode header", () => {
  it("bash -n exits 0", () => {
    expect(() => execFileSync("bash", ["-n", SCRIPT])).not.toThrow();
  });

  it("enables strict error handling (set -Eeuo pipefail) near the top of the file", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const firstLines = source.split("\n").slice(0, 45).join("\n");
    expect(firstLines).toMatch(/set -Eeuo pipefail/);
  });
});

describe("argument validation", () => {
  it("exits non-zero naming the missing argument and the retention-window requirement when no target is given", () => {
    const run = runCli([]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/missing required PITR target/i);
    expect(run.stderr).toMatch(/retention window/i);
  });

  it("rejects a badly-shaped target", () => {
    const run = runCli(["not-a-timestamp"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/rejected target/i);
  });

  it("refuses a target naming a production volume, naming the refusal", () => {
    const run = runCli(["mega_crm_db_data_prod"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/REFUSED/);
    expect(run.stderr).toMatch(/mega_crm_db_data_prod/);
  });

  it("refuses a target naming the production service", () => {
    const run = runCli(["db"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/REFUSED/);
  });

  it("refuses a target naming the production PGDATA path", () => {
    const run = runCli(["/var/lib/postgresql/data"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/REFUSED/);
  });

  it("accepts a well-formed UTC target under --dry-run", () => {
    const run = runCli(["--dry-run", VALID_TARGET]);
    expect(run.exitCode).toBe(0);
  });
});

describe("production-name extraction (T-14-68)", () => {
  it("every production service and volume name named in docker-compose.prod.yml exists on disk (sanity: the guard's own source of truth is real)", () => {
    const compose = readFileSync(COMPOSE_FILE, "utf8");
    expect(compose).toMatch(/^\s*db:/m);
    expect(compose).toMatch(/mega_crm_db_data_prod:/);
  });
});

describe("--dry-run: ordering, machine-readability, no side effects", () => {
  it("prints an ordered command sequence and performs no action", () => {
    const run = runCli(["--dry-run", VALID_TARGET]);
    expect(run.exitCode).toBe(0);

    const lines = run.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    expect(lines.length).toBeGreaterThan(0);

    const idxRestore = lines.findIndex((l) => l.includes("pgbackrest") && l.includes("--type=time"));
    const idxVerify = lines.findIndex((l) => l.includes("db:verify-restored"));
    const idxTeardownContainer = lines.findIndex((l) => l.trim().startsWith("docker rm -f"));
    const idxTeardownVolume = lines.findIndex((l) => l.trim().startsWith("docker volume rm"));

    for (const idx of [idxRestore, idxVerify, idxTeardownContainer, idxTeardownVolume]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }

    // restore precedes verification, which precedes teardown
    expect(idxRestore).toBeLessThan(idxVerify);
    expect(idxVerify).toBeLessThan(idxTeardownContainer);
    expect(idxVerify).toBeLessThan(idxTeardownVolume);
  });

  it("every written container and volume name differs from every production name read from the compose file", () => {
    const run = runCli(["--dry-run", VALID_TARGET]);
    expect(run.exitCode).toBe(0);

    const compose = readFileSync(COMPOSE_FILE, "utf8");
    const serviceNames = ["db", "pgbackrest", "redis", "api", "worker", "web", "migrate"];
    const volumeNames = [
      "mega_crm_db_data_prod",
      "mega_crm_db_certs_prod",
      "mega_crm_pg_socket_prod",
      "mega_crm_redis_data_prod",
      "mega_crm_caddy_data_prod",
      "mega_crm_caddy_config_prod",
    ];
    // sanity: the hardcoded lists above actually match the real file, so a
    // silent drift in the compose file would fail this test too.
    for (const name of [...serviceNames, ...volumeNames]) {
      expect(compose).toContain(name);
    }

    const scratchContainerMatch = /Scratch container: (\S+)/.exec(run.stdout);
    const scratchVolumeMatch = /Scratch volume: (\S+)/.exec(run.stdout);
    expect(scratchContainerMatch).not.toBeNull();
    expect(scratchVolumeMatch).not.toBeNull();

    const scratchContainer = scratchContainerMatch[1];
    const scratchVolume = scratchVolumeMatch[1];

    expect(serviceNames).not.toContain(scratchContainer);
    expect(volumeNames).not.toContain(scratchVolume);

    // Every line that WRITES (volume create, docker run --name/-v, rm -f,
    // volume rm) must use these exact scratch names in its NAME-bearing
    // fields specifically -- not "the line's text never contains the
    // substring", which would false-positive on legitimate mentions like
    // the pgbackrest CLI invocation itself or the bind-mounted
    // docker/pgbackrest/pgbackrest.conf SOURCE path (read-only config, not
    // a written resource).
    const nameFieldsWritten = [];
    for (const line of run.stdout.split("\n")) {
      const named = /--name (\S+)/.exec(line);
      if (named) nameFieldsWritten.push(named[1]);
      const volumeCreate = /^docker volume (?:create|rm) (\S+)/.exec(line.trim());
      if (volumeCreate) nameFieldsWritten.push(volumeCreate[1]);
      const rmF = /^docker rm -f (\S+)/.exec(line.trim());
      if (rmF) nameFieldsWritten.push(rmF[1]);
      // the WRITE side of a `-v SRC:DST` bind: only the volume-name form
      // (no leading "/") is a named resource this script could collide on;
      // path-shaped SRCs (docker/pgbackrest/pgbackrest.conf) are read-only
      // mounts, never asserted here.
      for (const m of line.matchAll(/-v ([A-Za-z0-9_.-]+):\/[^\s"]+/g)) {
        if (!m[1].startsWith("/")) nameFieldsWritten.push(m[1]);
      }
    }
    expect(nameFieldsWritten.length).toBeGreaterThan(0);
    for (const name of nameFieldsWritten) {
      expect(serviceNames, `name field "${name}" unexpectedly matches a production service name`).not.toContain(name);
      expect(volumeNames, `name field "${name}" unexpectedly matches a production volume name`).not.toContain(name);
    }
  });

  it("does not require MEGA_CRM_ENV_FILE to be set at all", () => {
    const run = runCli(["--dry-run", VALID_TARGET], { env: { MEGA_CRM_ENV_FILE: "" } });
    expect(run.exitCode).toBe(0);
  });
});

describe("real invocation: a failed restore leaves scratch resources for inspection", () => {
  it("exits non-zero, never runs the teardown, and prints the cleanup command", () => {
    const scratch = makeScratch();
    const run = runCli([VALID_TARGET], {
      env: baseRealEnv(scratch, { DRILL_TEST_RUN_EXIT_CODE: "9" }),
    });

    expect(run.exitCode).not.toBe(0);
    expect(run.stdout + run.stderr).toMatch(/RESTORE FAILED/);
    expect(run.stdout + run.stderr).toMatch(/clean up the scratch resources by hand/i);
    expect(run.stdout + run.stderr).toMatch(/docker rm -f megacrm-restore-drill-scratch/);
    expect(run.stdout + run.stderr).toMatch(/docker volume rm megacrm_restore_drill_scratch_data/);

    const calls = callLines(scratch.logFile);
    expect(calls.some((l) => l.startsWith("run -d"))).toBe(true);
    // teardown never actually RAN (only mentioned in the printed message above)
    expect(calls.some((l) => l.startsWith("rm -f") || l === "rm -f megacrm-restore-drill-scratch")).toBe(false);
    expect(calls.some((l) => l.startsWith("volume rm"))).toBe(false);
    expect(calls.some((l) => l.includes("db:verify-restored"))).toBe(false);
  });
});

describe("real invocation: a failed verification also leaves scratch resources for inspection", () => {
  it("exits non-zero and never tears down", () => {
    const scratch = makeScratch();
    const run = runCli([VALID_TARGET], {
      env: baseRealEnv(scratch, { DRILL_TEST_VERIFY_EXIT_CODE: "1" }),
    });

    expect(run.exitCode).not.toBe(0);
    expect(run.stdout + run.stderr).toMatch(/VERIFICATION FAILED/);

    const calls = callLines(scratch.logFile);
    expect(calls.some((l) => l.includes("db:verify-restored"))).toBe(true);
    expect(calls.some((l) => l.startsWith("volume rm"))).toBe(false);
  });
});

describe("real invocation: full successful sequence", () => {
  it("creates the scratch volume, restores, waits for readiness, verifies, then destroys both scratch resources", () => {
    const scratch = makeScratch();
    const run = runCli([VALID_TARGET], { env: baseRealEnv(scratch) });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/drill for target .* complete/i);

    const calls = callLines(scratch.logFile);
    const idxVolumeCreate = calls.findIndex((l) => l.startsWith("volume create"));
    const idxBaseline = calls.findIndex((l) => l.startsWith("compose"));
    const idxRestore = calls.findIndex((l) => l.startsWith("run -d"));
    const idxReady = calls.findIndex((l) => l.startsWith("exec") && l.includes("pg_isready"));
    const idxVerify = calls.findIndex((l) => l.includes("db:verify-restored"));
    const idxRmContainer = calls.findIndex((l) => l.startsWith("rm -f"));
    const idxRmVolume = calls.findIndex((l) => l.startsWith("volume rm"));

    for (const idx of [idxVolumeCreate, idxBaseline, idxRestore, idxReady, idxVerify, idxRmContainer, idxRmVolume]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }

    expect(idxVolumeCreate).toBeLessThan(idxRestore);
    expect(idxBaseline).toBeLessThan(idxRestore);
    expect(idxRestore).toBeLessThan(idxReady);
    expect(idxReady).toBeLessThan(idxVerify);
    expect(idxVerify).toBeLessThan(idxRmContainer);
    expect(idxVerify).toBeLessThan(idxRmVolume);
  });

  it("passes the exact target through to db:verify-restored as --as-of", () => {
    const scratch = makeScratch();
    const run = runCli([VALID_TARGET], { env: baseRealEnv(scratch) });
    expect(run.exitCode).toBe(0);

    const calls = callLines(scratch.logFile);
    const verifyCall = calls.find((l) => l.includes("db:verify-restored"));
    expect(verifyCall).toContain(`--as-of=${VALID_TARGET}`);
    expect(verifyCall).toContain(`--baseline=${scratch.baselineFile}`);
  });

  it("runs only the loopback scratch verifier outside production mode", () => {
    const scratch = makeScratch();
    const run = runCli([VALID_TARGET], { env: baseRealEnv(scratch) });
    expect(run.exitCode).toBe(0);

    const calls = callLines(scratch.logFile);
    const verifyCall = calls.find((l) => l.includes("db:verify-restored"));
    expect(verifyCall).toMatch(/^NODE_ENV=test npm /);
  });
});

describe("real invocation: required environment is enforced before touching anything", () => {
  it("fails loudly when MEGA_CRM_ENV_FILE does not point at a real file", () => {
    const scratch = makeScratch();
    const env = baseRealEnv(scratch, { MEGA_CRM_ENV_FILE: path.join(scratch.dir, "does-not-exist.env") });
    const run = runCli([VALID_TARGET], { env });

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/MEGA_CRM_ENV_FILE/);
    const calls = callLines(scratch.logFile);
    expect(calls.length).toBe(0);
  });

  it("fails loudly when POSTGRES_PASSWORD is absent from MEGA_CRM_ENV_FILE", () => {
    const scratch = makeScratch();
    writeFileSync(scratch.envFile, "POSTGRES_DB=mega_crm\n");
    const run = runCli([VALID_TARGET], { env: baseRealEnv(scratch) });

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/POSTGRES_PASSWORD/);
  });
});
