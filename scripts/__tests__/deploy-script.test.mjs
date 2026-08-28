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
  # The alloy leg inspects State.Running + RestartCount (that service declares
  # no healthcheck in docker-compose.prod.yml, so Docker health status is not
  # available for it the way it is for worker). Disambiguated on the format
  # string so one stub can serve both legs.
  if [[ "$args" == *"State.Running"* ]]; then
    if [[ "\${DEPLOY_TEST_ALLOY_RESTART_LOOP:-0}" == "1" ]]; then
      # A restart-looping container: running at each glance, but RestartCount
      # climbs between samples (the G-15-4 production signature).
      n="\$(cat "\$DEPLOY_TEST_LOG.alloy-restarts" 2>/dev/null || echo 0)"
      n=\$(( n + 1 ))
      echo "\$n" > "\$DEPLOY_TEST_LOG.alloy-restarts"
      echo "true \$n"
    else
      echo "\${DEPLOY_TEST_ALLOY_INSPECT:-true 0}"
    fi
    exit 0
  fi
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

if [[ "$args" == *"ps -q alloy"* ]]; then
  echo "fakecid-alloy"
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

/**
 * The three Grafana Cloud values docker/alloy/config.alloy reads with `env()`
 * -- the complete set the alloy leg's preflight requires. Dummy values: the
 * docker stub never dials anything, but the push URL is deliberately `https`
 * so it satisfies T-15-64 (docker/alloy/config.alloy's own header) and the
 * happy-path tests exercise the accepting branch, not the rejecting one.
 */
const LOKI_ENV_LINES = {
  GRAFANA_LOKI_PUSH_URL: "https://logs-prod-000.grafana.test/loki/api/v1/push",
  GRAFANA_LOKI_USER: "123456",
  GRAFANA_CLOUD_API_TOKEN: "glc_fake_token_for_tests",
};

/**
 * Renders a MEGA_CRM_ENV_FILE body. `overrides` may blank a key (empty
 * string) or replace its value; `null` omits the line entirely -- the two
 * distinct "operator forgot to provision Loki" shapes that must both fail.
 */
function renderEnvFile(overrides = {}) {
  const merged = { ...LOKI_ENV_LINES, ...overrides };
  const lines = ["# fake operator secrets file -- deploy-script.test.mjs"];
  for (const [key, value] of Object.entries(merged)) {
    if (value === null) continue;
    lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

/** A fresh scratch dir per test -- bin stub, log file, record file, fake env file. */
function makeScratch(envOverrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-script-test-"));
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);
  const logFile = path.join(dir, "docker-calls.log");
  writeFileSync(logFile, "");
  const recordFile = path.join(dir, "current-sha");
  const envFile = path.join(dir, "fake.env");
  writeFileSync(envFile, renderEnvFile(envOverrides));
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
    ALLOY_STABLE_TIMEOUT_SECONDS: "3",
    ALLOY_STABLE_POLL_INTERVAL_SECONDS: "1",
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
    expect(calls.some((l) => l.trim().endsWith("up -d --no-deps alloy"))).toBe(true);
    expect(calls.some((l) => l.includes("run --rm migrate"))).toBe(false);
    expect(calls.some((l) => l.includes("up -d web api"))).toBe(false);
    expect(calls.some((l) => l.trim().endsWith("up -d worker"))).toBe(false);
    expect(calls.some((l) => l.trim().endsWith("up -d alloy"))).toBe(false);
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
    expect(lines.some((l) => l.trim().endsWith("up -d --no-deps alloy"))).toBe(true);
    expect(lines.some((l) => l.includes("run --rm migrate"))).toBe(false);
    expect(lines.some((l) => l.includes("up -d web api"))).toBe(false);
    expect(lines.some((l) => l.trim().endsWith("up -d worker"))).toBe(false);
    expect(lines.some((l) => l.trim().endsWith("up -d alloy"))).toBe(false);
  });
});

// Found during the Phase 17 live checkpoint (2026-08-28), diagnosed in
// .planning/debug/alloy-not-durable-in-deploy.md: docker-compose.prod.yml
// declares the `alloy` log-shipping sidecar (and scripts/validate-prod-compose.mjs
// already gates it as one of EXPECTED_SERVICES), but scripts/deploy.sh
// contained ZERO references to it -- `grep -c -i alloy scripts/deploy.sh`
// returned 0. A routine deploy therefore converged web/api/migrate/worker and
// left Alloy exactly as it found it: absent on a fresh host, absent after any
// manual removal, and never restarted when docker/alloy/config.alloy changed.
// Every application service reported healthy while not one log line reached
// Grafana Cloud Loki, and Alloy's existence in production depended entirely on
// an out-of-band manual `docker compose up -d alloy`.
//
// The silence has a SECOND, independent cause that this suite pins alongside
// the first: the service's `env_file: { required: false }` plus Alloy's own
// empty-tolerant `env()` mean a missing/blank Loki credential fails nothing
// anywhere in the stack. Convergence without a credential preflight would
// still ship a container that pushes nowhere.
describe("alloy convergence: the log-shipping sidecar is part of the deploy contract", () => {
  it("converges alloy in the real deploy, after the worker leg", () => {
    const scratch = makeScratch();
    const run = runCli([VALID_SHA], { env: baseRealEnv(scratch) });
    expect(run.exitCode).toBe(0);

    const calls = callLines(scratch.logFile);
    const idxUpWorker = calls.findIndex((l) => l.trim().endsWith("up -d --no-deps worker"));
    const idxUpAlloy = calls.findIndex((l) => l.trim().endsWith("up -d --no-deps alloy"));

    expect(idxUpAlloy).toBeGreaterThanOrEqual(0);
    expect(idxUpWorker).toBeGreaterThanOrEqual(0);
    expect(idxUpWorker).toBeLessThan(idxUpAlloy);
  });

  it("pulls the pinned alloy image alongside the application images", () => {
    const scratch = makeScratch();
    const run = runCli([VALID_SHA], { env: baseRealEnv(scratch) });
    expect(run.exitCode).toBe(0);

    const calls = callLines(scratch.logFile);
    expect(calls.some((l) => l.includes("pull api worker web alloy"))).toBe(true);
  });

  it("the printed --dry-run plan tells the operator alloy is converged too", () => {
    const scratch = makeScratch();
    const run = runCli(["--dry-run", VALID_SHA], {
      env: { MEGA_CRM_DEPLOY_STATE_FILE: scratch.recordFile },
    });
    expect(run.exitCode).toBe(0);

    const lines = run.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    expect(lines.some((l) => l.trim().endsWith("up -d --no-deps alloy"))).toBe(true);
    expect(lines.some((l) => l.includes("pull api worker web alloy"))).toBe(true);
    // Still no fixed sleep anywhere in the plan -- the alloy leg polls, same
    // discipline as every other readiness gate in this script (T-14-54).
    expect(lines.some((l) => /\bsleep\b/.test(l))).toBe(false);
  });

  it("still converges alloy when re-running an already-deployed SHA -- the repair path", () => {
    // The whole point: an operator who notices logs stopped re-runs the deploy
    // for the SAME SHA. If alloy convergence sat inside the skip_worker_replace
    // guard, that repair would do nothing at all.
    const scratch = makeScratch();
    const env = baseRealEnv(scratch);

    const first = runCli([VALID_SHA], { env });
    expect(first.exitCode).toBe(0);

    writeFileSync(scratch.logFile, "");
    const second = runCli([VALID_SHA], { env });
    expect(second.exitCode).toBe(0);

    const calls = callLines(scratch.logFile);
    expect(second.stdout).toMatch(/already the recorded deployed SHA/);
    expect(calls.some((l) => l.trim().endsWith("up -d --no-deps worker"))).toBe(false);
    expect(calls.some((l) => l.trim().endsWith("up -d --no-deps alloy"))).toBe(true);
  });

  describe("Loki credential preflight: missing configuration fails loudly, before any mutation", () => {
    for (const key of ["GRAFANA_LOKI_PUSH_URL", "GRAFANA_LOKI_USER", "GRAFANA_CLOUD_API_TOKEN"]) {
      it(`aborts naming ${key} when that line is absent from MEGA_CRM_ENV_FILE`, () => {
        const scratch = makeScratch({ [key]: null });
        const run = runCli([VALID_SHA], { env: baseRealEnv(scratch) });

        expect(run.exitCode).not.toBe(0);
        expect(run.stderr).toMatch(new RegExp(key));
        expect(callLines(scratch.logFile)).toEqual([]);
        expect(existsSync(scratch.recordFile)).toBe(false);
      });

      it(`aborts naming ${key} when that line is present but blank`, () => {
        // docker/prod.env.example ships all three blank on purpose -- an
        // operator who copied it without filling them in is the exact
        // production shape this must catch, and `required: false` means
        // compose itself never will.
        const scratch = makeScratch({ [key]: "" });
        const run = runCli([VALID_SHA], { env: baseRealEnv(scratch) });

        expect(run.exitCode).not.toBe(0);
        expect(run.stderr).toMatch(new RegExp(key));
        expect(callLines(scratch.logFile)).toEqual([]);
      });
    }

    it("rejects a plaintext push endpoint (T-15-64)", () => {
      const scratch = makeScratch({
        GRAFANA_LOKI_PUSH_URL: "http://logs-prod-000.grafana.test/loki/api/v1/push",
      });
      const run = runCli([VALID_SHA], { env: baseRealEnv(scratch) });

      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toMatch(/GRAFANA_LOKI_PUSH_URL/);
      expect(callLines(scratch.logFile)).toEqual([]);
    });

    it("does not run the preflight under --dry-run (that mode needs no environment at all)", () => {
      const scratch = makeScratch({
        GRAFANA_LOKI_PUSH_URL: null,
        GRAFANA_LOKI_USER: null,
        GRAFANA_CLOUD_API_TOKEN: null,
      });
      const run = runCli(["--dry-run", VALID_SHA], {
        env: {
          MEGA_CRM_ENV_FILE: scratch.envFile,
          MEGA_CRM_DEPLOY_STATE_FILE: scratch.recordFile,
        },
      });
      expect(run.exitCode).toBe(0);
    });
  });

  describe("convergence verification: a container that exists is not evidence it is shipping", () => {
    it("fails naming alloy when the container is not running after convergence", () => {
      const scratch = makeScratch();
      const run = runCli([VALID_SHA], {
        env: baseRealEnv(scratch, { DEPLOY_TEST_ALLOY_INSPECT: "false 0" }),
      });

      expect(run.exitCode).not.toBe(0);
      expect(run.stdout + run.stderr).toMatch(/alloy/i);
      // late-leg failure semantics, same as the worker-healthy timeout: the
      // SHA is NOT recorded as deployed
      expect(readFileSync(scratch.recordFile, "utf8")).not.toBe(VALID_SHA);
    });

    it("fails naming alloy when the container is restart-looping", () => {
      // G-15-4's exact production signature: `restart: unless-stopped` keeps
      // re-creating a container whose config Alloy's lexer rejects, so it is
      // "running" at any single glance while RestartCount climbs and not one
      // log line is ever shipped.
      const scratch = makeScratch();
      const run = runCli([VALID_SHA], {
        env: baseRealEnv(scratch, { DEPLOY_TEST_ALLOY_RESTART_LOOP: "1" }),
      });

      expect(run.exitCode).not.toBe(0);
      expect(run.stdout + run.stderr).toMatch(/alloy/i);
      expect(readFileSync(scratch.recordFile, "utf8")).not.toBe(VALID_SHA);
    });

    it("accepts a stable container whose RestartCount is non-zero but no longer climbing", () => {
      // Boundary neighbour of the case above, and the reason the check must be
      // a DELTA rather than `RestartCount == 0`: a sidecar that restarted once
      // months ago (host reboot, docker daemon restart) and has been stable
      // ever since is healthy. Failing deploys on its historical count would
      // be a worse bug than the one being fixed.
      const scratch = makeScratch();
      const run = runCli([VALID_SHA], {
        env: baseRealEnv(scratch, { DEPLOY_TEST_ALLOY_INSPECT: "true 4" }),
      });

      expect(run.exitCode).toBe(0);
      expect(readFileSync(scratch.recordFile, "utf8")).toBe(VALID_SHA);
    });
  });
});
