// Debug session `ci-tenant-fairness-double-run` (2026-08-20). RED-phase guard
// for the fix that stops the timing-sensitive load tests executing inside the
// aggregate coverage run.
//
// The defect this file exists to make impossible again:
// `apps/worker/vitest.config.ts` excluded only `dist/**`, so the root
// aggregate entrypoint (`npm run coverage`, CI job `test`) collected BOTH
// `failure-injection/tenant-fairness.test.ts` and
// `loadtest/tenant-rps-sustained.test.ts`. tenant-fairness therefore ran TWICE
// per CI run -- once in the quiet, uninstrumented `failure-injection` job
// (passed) and once inside the v8-instrumented aggregate on top of ~60 sibling
// files' accumulated Postgres/Redis state, where its throughput-RATIO
// assertion (~0.38s of discriminating signal, quantized into 1-second token
// bucket windows) missed by 0.045 and reported the whole required `test` check
// red. `loadtest/tenant-rps-sustained.test.ts` was worse: its own header and
// `fairness-constants.ts` both claim it is "deliberately NOT wired into CI
// (D-04)", yet nothing implemented that claim, so 15 seconds of full-rate
// sustained load ran on every pull request immediately alongside the
// measurement it was most able to disturb.
//
// Two halves, and BOTH are load-bearing -- a guard that only checked the
// first would pass just as happily if the fairness proof were deleted from
// every entrypoint at once, which is precisely the silent gate loss the fix
// must not be able to cause:
//
//   1. NOT collected by the aggregate  (the flake is gone)
//   2. STILL collected by its own dedicated entrypoint  (the gate survives)
//
// The oracle for both is `vitest list --filesOnly --json` -- the real
// collection Vitest performs, not a re-implementation of its include/exclude
// resolution, which is the only way this can stay true across a Vitest
// upgrade. `--filesOnly` is load-bearing twice over: it neither executes test
// bodies (so this test cannot recurse into itself through the `scripts`
// project it belongs to) nor fires `globalSetup`, so no database or Redis is
// needed and this stays a pure `static`-class check that happens to live in
// the `test` job.
//
// Assertions derive from package.json and ci.yml rather than restating their
// contents, following scripts/__tests__/advisory-scan-workflow.test.mjs's
// drift-test convention: a rename on either side fails here instead of
// silently orphaning the guard.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const VITEST_BIN = path.join(REPO_ROOT, "node_modules/vitest/vitest.mjs");
const CI_YML_PATH = path.join(REPO_ROOT, ".github/workflows/ci.yml");
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");

// A cold runner resolves twelve Vite configs before it can answer; the local
// warm figure (~1.2s) is not the number to budget against.
const LIST_TIMEOUT_MS = 120_000;

/**
 * The load tests that must run exactly once per CI run, in their own quiet
 * lane. Deliberately only these two: the other fifteen failure-injection
 * files are deterministic correctness tests whose aggregate-run execution
 * feeds the `coverage:gate` denominator and must NOT be excluded (see the
 * positive control below).
 */
const LOAD_TESTS = [
  {
    label: "two-tenant fairness (WRK-03/WRK-04)",
    relPath: "src/queues/__tests__/failure-injection/tenant-fairness.test.ts",
    npmScript: "failure:tenant-fairness",
    // Required status check on master (verified 2026-08-20 against
    // repos/.../branches/master/protection: contexts are `static`, `test`,
    // `failure-injection`, with enforce_admins true). Excluding this file
    // from the aggregate does not weaken the gate ONLY because the
    // failure-injection job still runs it -- which is what this flag makes a
    // machine-checked claim rather than a comment.
    mustBeInvokedByCi: true,
  },
  {
    label: "DEFAULT_TENANT_RPS sustained throughput (WRK-04)",
    relPath: "src/queues/__tests__/loadtest/tenant-rps-sustained.test.ts",
    npmScript: "loadtest:tenant-rps",
    // D-04: on-demand only, by decision. The inverse assertion below is what
    // finally makes that documented intent true -- it was false for the whole
    // life of the file.
    mustBeInvokedByCi: false,
  },
];

/**
 * The positive control. A future "just exclude the whole failure-injection
 * directory" edit would satisfy every other assertion in this file while
 * silently dropping fifteen deterministic test files -- and their source
 * coverage -- out of the aggregate. This file must stay in.
 */
const AGGREGATE_CONTROL_FILE = "src/queues/__tests__/failure-injection/rate-limit-429.test.ts";

const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
const ciYml = readFileSync(CI_YML_PATH, "utf8");

/**
 * Runs `vitest list` and returns the absolute file paths it collected.
 *
 * VITEST_* is stripped from the child environment: this test is itself
 * executing inside a Vitest worker, and inheriting that worker's pool/worker
 * identifiers into a nested run makes the child believe it is part of the
 * parent's pool.
 */
function collectFiles(args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST")) delete env[key];
  }

  let stdout;
  try {
    stdout = execFileSync(process.execPath, [VITEST_BIN, "list", "--filesOnly", "--json", ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env,
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(
      `\`vitest list ${args.join(" ")}\` exited non-zero -- collection could not be determined.\n` +
        `stdout:\n${err.stdout ?? ""}\nstderr:\n${err.stderr ?? ""}`,
    );
  }

  // Vitest may print diagnostics ahead of the payload; take the JSON array.
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`could not find a JSON array in \`vitest list\` output:\n${stdout}`);
  }
  const parsed = JSON.parse(stdout.slice(start, end + 1));
  return parsed.map((entry) => entry.file);
}

/** Absolute path of a repo-relative apps/worker test file. */
function workerFile(relPath) {
  return path.join(REPO_ROOT, "apps/worker", relPath);
}

/**
 * Turns a `vitest run ...` npm script into its `vitest list --filesOnly
 * --json ...` equivalent, so the dedicated lane is probed through the EXACT
 * flags CI uses rather than through flags restated here. Notably this carries
 * over `--root`/`--config` verbatim -- and `--config` is resolved relative to
 * `--root`, not to the working directory, a trap worth preserving by
 * derivation instead of rediscovering by hand.
 */
function listArgsForScript(scriptName) {
  const command = packageJson.scripts[scriptName];
  expect(command, `package.json must define a \`${scriptName}\` script`).toBeTruthy();

  const tokens = command.split(/\s+/);
  expect(tokens[0], `\`${scriptName}\` is expected to invoke vitest directly`).toBe("vitest");
  expect(tokens[1], `\`${scriptName}\` is expected to be a \`vitest run\` invocation`).toBe("run");

  return tokens.slice(2);
}

/** The `run:` lines of a named job in ci.yml, in order. */
function jobRunLines(jobName) {
  const lines = ciYml.split("\n");
  const startIndex = lines.findIndex((line) => new RegExp(`^  ${jobName}:\\s*$`).test(line));
  expect(startIndex, `ci.yml must define a \`${jobName}\` job`).toBeGreaterThan(-1);

  const collected = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    // A line indented by exactly two spaces starts the next job.
    if (/^ {2}\S/.test(lines[i])) break;
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("run:")) collected.push(trimmed);
  }
  return collected;
}

describe("the aggregate coverage run must not execute the timing-sensitive load tests", () => {
  // One collection, reused: `vitest list` at the repo root resolves every
  // project in the aggregate and is the slowest thing this file does.
  const aggregateFiles = collectFiles([]);

  it("collects a plausible aggregate at all (guards against a vacuous pass)", () => {
    // Every assertion below is an absence check, and an absence check over an
    // empty list passes for the wrong reason. This is the denominator.
    expect(
      aggregateFiles.length,
      "the aggregate collection came back suspiciously small -- the absence assertions below would pass vacuously",
    ).toBeGreaterThan(100);
  });

  it(`still collects ${AGGREGATE_CONTROL_FILE} (positive control)`, () => {
    expect(
      aggregateFiles,
      "a deterministic failure-injection test disappeared from the aggregate -- the exclusion has been widened " +
        "past the two load tests and is now dropping source coverage out of the `coverage:gate` denominator",
    ).toContain(workerFile(AGGREGATE_CONTROL_FILE));
  });

  for (const loadTest of LOAD_TESTS) {
    describe(loadTest.label, () => {
      it("is NOT collected by the root aggregate entrypoint", () => {
        expect(
          aggregateFiles,
          `${loadTest.relPath} is still collected by \`npm run coverage\`. It runs there under v8 coverage ` +
            "instrumentation on top of every sibling worker test's accumulated Postgres/Redis state, which is " +
            "not an environment its throughput measurement is valid in.",
        ).not.toContain(workerFile(loadTest.relPath));
      });

      it(`is STILL collected by its own \`npm run ${loadTest.npmScript}\` entrypoint`, () => {
        // The half that stops the fix from becoming a silent gate removal:
        // excluding the file from the aggregate is only acceptable while its
        // dedicated lane still finds it.
        const dedicatedFiles = collectFiles(listArgsForScript(loadTest.npmScript));
        expect(
          dedicatedFiles,
          `\`npm run ${loadTest.npmScript}\` no longer collects ${loadTest.relPath}. The test is now excluded ` +
            "from EVERY entrypoint -- the gate has been removed, not relocated.",
        ).toContain(workerFile(loadTest.relPath));
      });
    });
  }
});

describe("the dedicated lane keeps the fairness gate mandatory", () => {
  const failureInjectionRunLines = jobRunLines("failure-injection");

  it("ci.yml's failure-injection job invokes every CI-wired load test's script", () => {
    for (const loadTest of LOAD_TESTS.filter((entry) => entry.mustBeInvokedByCi)) {
      expect(
        failureInjectionRunLines.some((line) => line.includes(`npm run ${loadTest.npmScript}`)),
        `ci.yml's failure-injection job no longer runs \`npm run ${loadTest.npmScript}\`. That job is a REQUIRED ` +
          "status check on master and is now the only place this test executes -- dropping the step deletes the gate.",
      ).toBe(true);
    }
  });

  it("ci.yml does not run the on-demand full-scale load test (D-04)", () => {
    // The claim `tenant-rps-sustained.test.ts`'s own header has always made,
    // asserted for the first time. It was false until this fix.
    for (const loadTest of LOAD_TESTS.filter((entry) => !entry.mustBeInvokedByCi)) {
      expect(
        ciYml.includes(`npm run ${loadTest.npmScript}`),
        `ci.yml invokes \`npm run ${loadTest.npmScript}\`, which is documented as deliberately NOT wired into CI ` +
          "(D-04) because it runs at full rate for LOADTEST_TENANT_RPS_DURATION_MS on every pull request.",
      ).toBe(false);
    }
  });

  it("ci.yml's test job still runs the aggregate entrypoint this guard checks", () => {
    // Anchors the guard to the real job. If the coverage entrypoint is
    // renamed, this fails loudly rather than leaving every assertion above
    // checking a command CI no longer runs.
    expect(
      jobRunLines("test").some((line) => line.includes("npm run coverage")),
      "ci.yml's `test` job no longer runs `npm run coverage` -- this guard is asserting against the wrong entrypoint.",
    ).toBe(true);
  });
});
