// GSD Phase 14 plan 09 (OPS-02, OPS-03, D-04, R-05, T-14-52..T-14-59).
//
// Mirrors the mix used by scripts/__tests__/lint-session-state.test.mjs and
// scripts/__tests__/validate-prod-compose.test.mjs: the CLI entry point
// (scripts/deploy.sh) is exercised as a real subprocess for the behaviors
// that are actually about exit codes and printed sequencing -- what an
// operator/CI would run is the subprocess, not an imported function (this is
// a bash script; there is nothing to import).
//
// No Docker daemon exists in this sandbox (repo-specific rule #5). Every
// "real" (non `--dry-run`) invocation below runs against a PATH-injected
// `docker` stub -- a small bash script that logs every invocation it
// receives and returns a scripted exit code/output driven by env vars this
// file sets per test. `--dry-run` invocations need no stub at all: dry run
// never executes anything, which this suite treats as load-bearing, not
// incidental (see "no side effects" below).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/deploy.sh");

const VALID_SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

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
 * Writes a `docker` stub into `binDir` and returns the env fragment that
 * points a `runCli` invocation at it (PATH-injected, so `docker compose ...`
 * and `docker inspect ...` resolve to this stub rather than any real Docker
 * daemon). Every invocation is appended (one line, raw argv joined by a
 * space) to `DEPLOY_TEST_LOG` so a test can assert exactly what the script
 * attempted and in what order -- the log IS the assertion surface for every
 * "no api/worker/web start command is attempted" style behavior.
 */
function setUpDockerStub(binDir, logFile) {
  const stubPath = path.join(binDir, "docker");
  writeFileSync(
    stubPath,
    `#!/usr/bin/env bash
echo "$*" >> "$DEPLOY_TEST_LOG"
args="$*"

if [[ "$1" == "inspect" ]]; then
  echo "\${DEPLOY_TEST_WORKER_HEALTH_STATUS:-healthy}"
  exit 0
fi

if [[ "$args" == *"pull api worker web"* ]]; then
  exit "\${DEPLOY_TEST_PULL_EXIT_CODE:-0}"
fi

if [[ "$args" == *"run --rm --no-deps migrate"* ]]; then
  exit "\${DEPLOY_TEST_MIGRATE_EXIT_CODE:-0}"
fi

if [[ "$args" == *"exec -T api"* ]]; then
  exit "\${DEPLOY_TEST_API_READYZ_EXIT_CODE:-0}"
fi

if [[ "$args" == *"exec -T web"* ]]; then
  exit "\${DEPLOY_TEST_WEB_READY_EXIT_CODE:-0}"
fi

if [[ "$args" == *"ps -q --status=running worker"* ]]; then
  if [[ "\${DEPLOY_TEST_WORKER_STILL_RUNNING:-0}" == "1" ]]; then
    echo "fakecid-worker-old"
  fi
  exit 0
fi

if [[ "$args" == *"ps -q worker"* ]]; then
  echo "fakecid-worker-new"
  exit 0
fi

exit 0
`,
    { mode: 0o755 },
  );
  return {
    PATH: `${binDir}:${process.env.PATH}`,
    DEPLOY_TEST_LOG: logFile,
  };
}

/** A fresh scratch dir per test -- bin stub, log file, record file, fake env file. */
function makeScratch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-script-test-"));
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  const logFile = path.join(dir, "docker-calls.log");
  writeFileSync(logFile, "");
  const recordFile = path.join(dir, "current-sha");
  const envFile = path.join(dir, "fake.env");
  writeFileSync(envFile, "# empty -- existence is all check_required_env verifies\n");
  return { dir, binDir, logFile, recordFile, envFile };
}

function baseRealEnv(scratch, overrides = {}) {
  return {
    ...setUpDockerStub(scratch.binDir, scratch.logFile),
    GHCR_IMAGE_BASE: "ghcr.io/example/mega-crm",
    SITE_ADDRESS: "example.test",
    MEGA_CRM_ENV_FILE: scratch.envFile,
    MEGA_CRM_DEPLOY_STATE_FILE: scratch.recordFile,
    DEPLOY_SCRIPT_TEST_STOP_GRACE_PERIOD_SECONDS: "5",
    DEPLOY_SCRIPT_TEST_SKIP_KEK_VALIDATION: "1",
    API_READYZ_TIMEOUT_SECONDS: "2",
    API_READYZ_POLL_INTERVAL_SECONDS: "1",
    WEB_READY_TIMEOUT_SECONDS: "2",
    WEB_READY_POLL_INTERVAL_SECONDS: "1",
    WORKER_STOP_CONFIRM_MARGIN_SECONDS: "1",
    WORKER_READY_MARGIN_SECONDS: "1",
    WORKER_POLL_INTERVAL_SECONDS: "1",
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
    const firstLines = source.split("\n").slice(0, 40).join("\n");
    expect(firstLines).toMatch(/set -Eeuo pipefail/);
  });
});

describe("argument validation", () => {
  it("rejects a branch name ('main') naming what was rejected", () => {
    const run = runCli(["main"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/main/);
  });

  it("rejects 'latest' naming what was rejected", () => {
    const run = runCli(["latest"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/latest/);
  });

  it("rejects an abbreviated SHA", () => {
    const run = runCli(["abc1234"]);
    expect(run.exitCode).not.toBe(0);
  });

  it("exits non-zero with usage when no argument is given", () => {
    const run = runCli([]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/Usage/);
  });

  it("accepts a full 40-character lowercase-hex SHA under --dry-run", () => {
    const run = runCli(["--dry-run", VALID_SHA]);
    expect(run.exitCode).toBe(0);
  });
});

describe("--dry-run: ordering, machine-readability, no side effects", () => {
  it("prints an ordered command sequence and performs no action", () => {
    const scratch = makeScratch();
    const run = runCli(["--dry-run", VALID_SHA], {
      env: { MEGA_CRM_DEPLOY_STATE_FILE: scratch.recordFile },
    });
    expect(run.exitCode).toBe(0);
    expect(existsSync(scratch.recordFile)).toBe(false);

    const lines = run.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    expect(lines.length).toBeGreaterThan(0);

    const idxPull = lines.findIndex((l) => l.includes("pull api worker web"));
    const idxGracePeriod = lines.findIndex((l) => l.includes("print-stop-grace-period.mjs"));
    const idxMigrate = lines.findIndex((l) => l.includes("run --rm --no-deps migrate"));
    const idxUpWebApi = lines.findIndex((l) => l.includes("up -d --no-deps web api"));
    const idxReadyzPoll = lines.findIndex((l) => l.includes("readyz"));
    const idxWebReadyPoll = lines.findIndex((l) => l.includes("exec -T web"));
    const idxStopWorker = lines.findIndex((l) => l.includes("stop --timeout"));
    const idxConfirmGone = lines.findIndex((l) => l.includes("ps -q --status=running worker"));
    const idxUpWorker = lines.findIndex((l) => l.trim().endsWith("up -d --no-deps worker"));

    for (const idx of [
      idxPull,
      idxGracePeriod,
      idxMigrate,
      idxUpWebApi,
      idxReadyzPoll,
      idxWebReadyPoll,
      idxStopWorker,
      idxConfirmGone,
      idxUpWorker,
    ]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }

    // pull precedes migrate, migrate precedes every api/worker/web start/up
    expect(idxPull).toBeLessThan(idxMigrate);
    expect(idxMigrate).toBeLessThan(idxUpWebApi);
    expect(idxMigrate).toBeLessThan(idxUpWorker);
    expect(idxUpWebApi).toBeLessThan(idxWebReadyPoll);

    // readiness wait present, no fixed sleep used as a wait anywhere
    expect(lines.some((l) => /\bsleep\b/.test(l))).toBe(false);

    // stop precedes the confirmation step, which precedes starting the new one
    expect(idxStopWorker).toBeLessThan(idxConfirmGone);
    expect(idxConfirmGone).toBeLessThan(idxUpWorker);
  });

  it("does not require GHCR_IMAGE_BASE/SITE_ADDRESS/MEGA_CRM_ENV_FILE to be set at all", () => {
    const run = runCli(["--dry-run", VALID_SHA], {
      env: {
        GHCR_IMAGE_BASE: "",
        SITE_ADDRESS: "",
        MEGA_CRM_ENV_FILE: "",
      },
    });
    expect(run.exitCode).toBe(0);
  });

  it("--rollback-to prints a migration-tier warning before the rest of the sequence", () => {
    const run = runCli(["--dry-run", "--rollback-to", VALID_SHA]);
    expect(run.exitCode).toBe(0);
    const lines = run.stdout.split("\n");
    const warningIdx = lines.findIndex((l) => /migration/i.test(l) && /tier/i.test(l));
    const pullIdx = lines.findIndex((l) => l.includes("pull api worker web"));
    expect(warningIdx).toBeGreaterThanOrEqual(0);
    expect(pullIdx).toBeGreaterThanOrEqual(0);
    expect(warningIdx).toBeLessThan(pullIdx);
  });
});

describe("real invocation: migrate failure aborts before any replacement", () => {
  it("exits non-zero and attempts no api/worker/web start command", () => {
    const scratch = makeScratch();
    const run = runCli([VALID_SHA], {
      env: baseRealEnv(scratch, { DEPLOY_TEST_MIGRATE_EXIT_CODE: "7" }),
    });

    expect(run.exitCode).not.toBe(0);
    expect(run.stdout + run.stderr).toMatch(/MIGRATE FAILED/);

    const calls = callLines(scratch.logFile);
    expect(calls.some((l) => l.includes("run --rm --no-deps migrate"))).toBe(true);
    expect(calls.some((l) => l.includes("up -d --no-deps web api"))).toBe(false);
    expect(calls.some((l) => l.includes("stop --timeout"))).toBe(false);
    expect(calls.some((l) => l.trim().endsWith("up -d --no-deps worker"))).toBe(false);

    // the previous-SHA record exists and the rollback command was printed,
    // even on this failure path (T-14-56)
    expect(existsSync(scratch.recordFile)).toBe(true);
    expect(run.stdout).toMatch(/roll ?back/i);
  });
});

describe("real invocation: KEK preflight fails before any mutation", () => {
  it("attempts no docker operation when the host file is unsafe", () => {
    const scratch = makeScratch();
    const run = runCli([VALID_SHA], {
      env: baseRealEnv(scratch, { DEPLOY_SCRIPT_TEST_SKIP_KEK_VALIDATION: "0" }),
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout + run.stderr).toMatch(/KEK preflight/);
    expect(callLines(scratch.logFile)).toEqual([]);
    expect(existsSync(scratch.recordFile)).toBe(false);
  });
});

describe("real invocation: unbounded /readyz never returns 200", () => {
  it("exits non-zero naming the service and the timeout, and never replaces the worker", () => {
    const scratch = makeScratch();
    const run = runCli([VALID_SHA], {
      env: baseRealEnv(scratch, { DEPLOY_TEST_API_READYZ_EXIT_CODE: "1" }),
    });

    expect(run.exitCode).not.toBe(0);
    const output = run.stdout + run.stderr;
    expect(output).toMatch(/api/);
    expect(output).toMatch(/2s/); // API_READYZ_TIMEOUT_SECONDS=2 in baseRealEnv

    const calls = callLines(scratch.logFile);
    expect(calls.some((l) => l.includes("exec -T api"))).toBe(true);
    expect(calls.some((l) => l.includes("stop --timeout"))).toBe(false);
    expect(calls.some((l) => l.trim().endsWith("up -d --no-deps worker"))).toBe(false);
  });
});

describe("real invocation: unbounded web admin-API probe never succeeds", () => {
  it("exits non-zero naming the service and the timeout, and never replaces the worker", () => {
    const scratch = makeScratch();
    const run = runCli([VALID_SHA], {
      env: baseRealEnv(scratch, { DEPLOY_TEST_WEB_READY_EXIT_CODE: "1" }),
    });

    expect(run.exitCode).not.toBe(0);
    const output = run.stdout + run.stderr;
    expect(output).toMatch(/web/);
    expect(output).toMatch(/2s/); // WEB_READY_TIMEOUT_SECONDS=2 in baseRealEnv

    const calls = callLines(scratch.logFile);
    expect(calls.some((l) => l.includes("exec -T api"))).toBe(true);
    expect(calls.some((l) => l.includes("exec -T web"))).toBe(true);
    expect(calls.some((l) => l.includes("stop --timeout"))).toBe(false);
    expect(calls.some((l) => l.trim().endsWith("up -d --no-deps worker"))).toBe(false);
  });
});

describe("real invocation: full successful deploy", () => {
  it("pulls, migrates, brings up web/api, waits readyz, replaces the worker stop-old-then-start-new, and records the SHA", () => {
    const scratch = makeScratch();
    const run = runCli([VALID_SHA], { env: baseRealEnv(scratch) });

    expect(run.exitCode).toBe(0);

    const calls = callLines(scratch.logFile);
    const idxPull = calls.findIndex((l) => l.includes("pull api worker web"));
    const idxMigrate = calls.findIndex((l) => l.includes("run --rm --no-deps migrate"));
    const idxUpWebApi = calls.findIndex((l) => l.includes("up -d --no-deps web api"));
    const idxApiReady = calls.findIndex((l) => l.includes("exec -T api"));
    const idxWebReady = calls.findIndex((l) => l.includes("exec -T web"));
    const idxStop = calls.findIndex((l) => l.includes("stop --timeout"));
    const idxConfirmGone = calls.findIndex((l) => l.includes("ps -q --status=running worker"));
    const idxUpWorker = calls.findIndex((l) => l.trim().endsWith("up -d --no-deps worker"));

    for (const idx of [idxPull, idxMigrate, idxUpWebApi, idxApiReady, idxWebReady, idxStop, idxConfirmGone, idxUpWorker]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }
    expect(idxPull).toBeLessThan(idxMigrate);
    expect(idxMigrate).toBeLessThan(idxUpWebApi);
    expect(idxUpWebApi).toBeLessThan(idxWebReady);
    expect(idxWebReady).toBeLessThan(idxStop);
    expect(idxStop).toBeLessThan(idxConfirmGone);
    expect(idxConfirmGone).toBeLessThan(idxUpWorker);

    expect(readFileSync(scratch.recordFile, "utf8")).toBe(VALID_SHA);
    expect(run.stdout).toMatch(/roll ?back/i);
    expect(run.stdout).toMatch(/no previous SHA is on record/i);
  });
});

describe("real invocation: re-running an already-deployed SHA is idempotent", () => {
  it("the second run skips the disruptive worker replace entirely", () => {
    const scratch = makeScratch();
    const env = baseRealEnv(scratch);

    const first = runCli([VALID_SHA], { env });
    expect(first.exitCode).toBe(0);
    expect(readFileSync(scratch.recordFile, "utf8")).toBe(VALID_SHA);

    // fresh log for the second invocation so its assertions are unambiguous
    writeFileSync(scratch.logFile, "");
    const second = runCli([VALID_SHA], { env });
    expect(second.exitCode).toBe(0);

    const calls = callLines(scratch.logFile);
    expect(calls.some((l) => l.includes("pull api worker web"))).toBe(true);
    expect(calls.some((l) => l.includes("run --rm --no-deps migrate"))).toBe(true);
    // the disruptive worker replace never runs the second time
    expect(calls.some((l) => l.includes("stop --timeout"))).toBe(false);
    expect(calls.some((l) => l.trim().endsWith("up -d --no-deps worker"))).toBe(false);
    expect(second.stdout).toMatch(/already the recorded deployed SHA/);
  });
});

describe("real invocation: an unhandled command failure is never silently continued", () => {
  it("a pull failure aborts before migrate ever runs", () => {
    const scratch = makeScratch();
    const run = runCli([VALID_SHA], {
      env: baseRealEnv(scratch, { DEPLOY_TEST_PULL_EXIT_CODE: "3" }),
    });

    expect(run.exitCode).not.toBe(0);
    const calls = callLines(scratch.logFile);
    expect(calls.some((l) => l.includes("pull api worker web"))).toBe(true);
    expect(calls.some((l) => l.includes("run --rm --no-deps migrate"))).toBe(false);
  });
});

describe("real invocation: required environment is enforced before touching anything", () => {
  it("fails loudly when MEGA_CRM_ENV_FILE does not point at a real file", () => {
    const scratch = makeScratch();
    const env = baseRealEnv(scratch, { MEGA_CRM_ENV_FILE: path.join(scratch.dir, "does-not-exist.env") });
    const run = runCli([VALID_SHA], { env });

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/MEGA_CRM_ENV_FILE/);
    const calls = callLines(scratch.logFile);
    expect(calls.length).toBe(0);
  });
});

describe("distinct SHAs are treated as genuinely different deploys", () => {
  it("deploying OTHER_SHA after VALID_SHA does not skip the worker replace", () => {
    const scratch = makeScratch();
    const env = baseRealEnv(scratch);

    const first = runCli([VALID_SHA], { env });
    expect(first.exitCode).toBe(0);

    writeFileSync(scratch.logFile, "");
    const second = runCli([OTHER_SHA], { env });
    expect(second.exitCode).toBe(0);

    const calls = callLines(scratch.logFile);
    expect(calls.some((l) => l.includes("stop --timeout"))).toBe(true);
    expect(calls.some((l) => l.trim().endsWith("up -d --no-deps worker"))).toBe(true);
    expect(readFileSync(scratch.recordFile, "utf8")).toBe(OTHER_SHA);
  });
});

describe("leg isolation: deploying apps never recreates db/redis", () => {
  // Found live during phase 17-05 attempt 3 (2026-08-19): with the checked-out
  // compose file describing `db` with a NEW image, `compose up -d web api`
  // WITHOUT --no-deps recreates db and redis as dependency convergence -- an
  // implicit, ungated database cutover buried inside an app deploy. deploy.sh's
  // documented compose surface is api/worker/web only (by design); --no-deps on
  // every mutating invocation is what actually enforces that contract.
  it("every mutating compose invocation carries --no-deps in the real deploy", () => {
    const scratch = makeScratch();
    const run = runCli([VALID_SHA], { env: baseRealEnv(scratch) });
    expect(run.exitCode).toBe(0);

    const calls = callLines(scratch.logFile);
    expect(calls.some((l) => l.includes("run --rm --no-deps migrate"))).toBe(true);
    expect(calls.some((l) => l.includes("up -d --no-deps web api"))).toBe(true);
    expect(calls.some((l) => l.trim().endsWith("up -d --no-deps worker"))).toBe(true);
    // no bare form may remain anywhere -- a single one reintroduces the hazard
    expect(calls.some((l) => l.includes("run --rm migrate"))).toBe(false);
    expect(calls.some((l) => l.includes("up -d web api"))).toBe(false);
    expect(calls.some((l) => l.trim().endsWith("up -d worker"))).toBe(false);
  });

  it("the printed --dry-run plan tells the operator the same --no-deps truth", () => {
    const scratch = makeScratch();
    const run = runCli(["--dry-run", VALID_SHA], {
      env: { MEGA_CRM_DEPLOY_STATE_FILE: scratch.recordFile },
    });
    expect(run.exitCode).toBe(0);

    const lines = run.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    expect(lines.some((l) => l.includes("run --rm --no-deps migrate"))).toBe(true);
    expect(lines.some((l) => l.includes("up -d --no-deps web api"))).toBe(true);
    expect(lines.some((l) => l.trim().endsWith("up -d --no-deps worker"))).toBe(true);
    expect(lines.some((l) => l.includes("run --rm migrate"))).toBe(false);
    expect(lines.some((l) => l.includes("up -d web api"))).toBe(false);
    expect(lines.some((l) => l.trim().endsWith("up -d worker"))).toBe(false);
  });
});
