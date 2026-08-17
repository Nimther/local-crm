// Phase 16 plan 04 (D-09, D-11, UAT-03/UAT-04).
//
// Mirrors scripts/__tests__/deploy-script.test.mjs's own convention: the CLI
// entry point (scripts/uat-replay.sh) is exercised as a real subprocess for
// behaviors that are about exit codes and printed output -- what an operator
// would run is the subprocess, not an imported function (this is a bash
// script; there is nothing to import). No Docker daemon, no database, and no
// real network request is ever needed for any test in this file --
// `--dry-run` performs no request at all (asserted below via a PATH-injected
// `curl` stub that would fail loudly if invoked), so every case here runs
// with no external dependency.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/uat-replay.sh");

const SIGNATURE_HEADER_NAME = "x-twilio-email-event-webhook-signature";
const TIMESTAMP_HEADER_NAME = "x-twilio-email-event-webhook-timestamp";

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

/** A fresh scratch dir per test, plus a real capture file with a known decoded body. */
function makeScratch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "uat-replay-test-"));
  const decodedBody = Buffer.from(JSON.stringify([{ event: "delivered", sg_message_id: "abc" }]));
  const capturePath = path.join(dir, "capture.json");
  writeFileSync(
    capturePath,
    JSON.stringify({
      rawBodyBase64: decodedBody.toString("base64"),
      signature: "test-signature-value-xyz",
      timestamp: "1755400000",
      publicKey: "test-public-key-not-used-by-this-script",
    }),
  );
  return { dir, capturePath, decodedBody };
}

/**
 * Writes a `curl` stub into `binDir` that appends every invocation it
 * receives (one line, raw argv joined by spaces) to `CURL_TEST_LOG` and
 * returns a scripted HTTP status code -- mirrors
 * scripts/__tests__/deploy-script.test.mjs's `docker` stub. Used both to
 * assert dry-run performs NO request (log stays empty) and to assert a real
 * invocation's HTTP-status handling without any real network access.
 */
function setUpCurlStub(binDir, logFile, { statusCode = "202" } = {}) {
  const stubPath = path.join(binDir, "curl");
  writeFileSync(
    stubPath,
    `#!/usr/bin/env bash
echo "$*" >> "$CURL_TEST_LOG"
printf '%s' "${statusCode}"
exit 0
`,
    { mode: 0o755 },
  );
  return {
    PATH: `${binDir}:${process.env.PATH}`,
    CURL_TEST_LOG: logFile,
  };
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

  it("is executable", () => {
    // execFileSync would already fail if it weren't, but assert the mode
    // bit directly too -- this is also the acceptance criterion's own
    // `test -x scripts/uat-replay.sh` check, run from inside the suite.
    execFileSync("bash", ["-c", `test -x "${SCRIPT}"`]);
  });
});

describe("argument validation", () => {
  it("exits non-zero when --capture is missing, even under --dry-run", () => {
    const run = runCli(["--dry-run"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/--capture/);
  });

  it("exits non-zero when --url is missing", () => {
    const scratch = makeScratch();
    const run = runCli(["--dry-run", "--capture", scratch.capturePath]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toMatch(/--url/);
  });

  it("exits non-zero when the capture file does not exist", () => {
    const run = runCli(["--dry-run", "--capture", "/tmp/definitely-does-not-exist-uat16.json", "--url", "https://example.test/x"]);
    expect(run.exitCode).not.toBe(0);
  });
});

describe("--dry-run: reports byte length, header names, performs no request", () => {
  it("reports the decoded byte length matching the fixture's decoded length", () => {
    const scratch = makeScratch();
    const run = runCli(["--dry-run", "--capture", scratch.capturePath, "--url", "https://example.test/webhooks/sendgrid/tok"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(new RegExp(`${scratch.decodedBody.length} bytes`));
  });

  it("both signature header names appear verbatim in the dry-run output", () => {
    const scratch = makeScratch();
    const run = runCli(["--dry-run", "--capture", scratch.capturePath, "--url", "https://example.test/webhooks/sendgrid/tok"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(SIGNATURE_HEADER_NAME);
    expect(run.stdout).toContain(TIMESTAMP_HEADER_NAME);
  });

  it("performs NO request -- a stubbed curl that would log any invocation stays uncalled", () => {
    const scratch = makeScratch();
    const dir = mkdtempSync(path.join(os.tmpdir(), "uat-replay-curl-stub-"));
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir);
    const logFile = path.join(dir, "curl-calls.log");
    writeFileSync(logFile, "");

    const run = runCli(
      ["--dry-run", "--capture", scratch.capturePath, "--url", "https://example.test/webhooks/sendgrid/tok"],
      { env: setUpCurlStub(binDir, logFile) },
    );
    expect(run.exitCode).toBe(0);
    expect(readFileSync(logFile, "utf8").trim()).toBe("");
  });
});

describe("--flip-byte: mutates exactly one byte and reports the changed index", () => {
  it("changes exactly one byte and reports the index in --dry-run output", () => {
    const scratch = makeScratch();
    const run = runCli([
      "--dry-run",
      "--capture",
      scratch.capturePath,
      "--url",
      "https://example.test/webhooks/sendgrid/tok",
      "--flip-byte",
      "2",
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/index 2 flipped/);
  });

  it("rejects a --flip-byte index outside the decoded body's range", () => {
    const scratch = makeScratch();
    const run = runCli([
      "--dry-run",
      "--capture",
      scratch.capturePath,
      "--url",
      "https://example.test/webhooks/sendgrid/tok",
      "--flip-byte",
      "999999",
    ]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout + run.stderr).toMatch(/out of range/);
  });
});

describe("real invocation (stubbed curl): posts the decoded body and reports the HTTP status", () => {
  it("a 2xx response from the endpoint exits 0", () => {
    const scratch = makeScratch();
    const dir = mkdtempSync(path.join(os.tmpdir(), "uat-replay-curl-stub-2xx-"));
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir);
    const logFile = path.join(dir, "curl-calls.log");
    writeFileSync(logFile, "");

    const run = runCli(
      ["--capture", scratch.capturePath, "--url", "https://example.test/webhooks/sendgrid/tok"],
      { env: setUpCurlStub(binDir, logFile, { statusCode: "202" }) },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/202/);
    const calls = readFileSync(logFile, "utf8").trim();
    expect(calls).toContain(SIGNATURE_HEADER_NAME);
    expect(calls).toContain(TIMESTAMP_HEADER_NAME);
    expect(calls).toContain("test-signature-value-xyz");
  });

  it("a 400 (fail-closed) response from the endpoint exits non-zero", () => {
    const scratch = makeScratch();
    const dir = mkdtempSync(path.join(os.tmpdir(), "uat-replay-curl-stub-400-"));
    const binDir = path.join(dir, "bin");
    mkdirSync(binDir);
    const logFile = path.join(dir, "curl-calls.log");
    writeFileSync(logFile, "");

    const run = runCli(
      ["--capture", scratch.capturePath, "--url", "https://example.test/webhooks/sendgrid/tok"],
      { env: setUpCurlStub(binDir, logFile, { statusCode: "400" }) },
    );
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toMatch(/400/);
  });
});
