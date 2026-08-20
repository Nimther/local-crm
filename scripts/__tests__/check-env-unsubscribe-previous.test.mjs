// 19-02 (ROT-01, D-01/D-02/D-03/D-07): check-env.mjs's conditional
// validation of UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS (Block A) and the
// three-site parity guard against apps/api/src/env.ts and
// apps/worker/src/server.ts (Block B, RESEARCH.md Pitfall 4's anti-drift
// guard).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/check-env.mjs");

const tmpDir = mkdtempSync(path.join(tmpdir(), "check-env-unsubscribe-previous-"));
const createdFiles = [];

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const PRIMARY = "p".repeat(40);

/** A minimal env file containing every baseRequired name plus KMS local provider vars. */
function baseFixtureLines(overrides = {}) {
  const values = {
    DATABASE_URL: "postgres://user:pass@localhost:5432/megacrm_test",
    BETTER_AUTH_SECRET: "0123456789abcdef0123",
    BETTER_AUTH_URL: "http://localhost:4000",
    WEB_URL: "http://localhost:5173",
    PLATFORM_SENDGRID_API_KEY: "SG.test_platform_key_0000000000000000",
    PLATFORM_MAIL_FROM: "noreply@megacrm.test",
    OPERATOR_ALERT_EMAIL: "ops@megacrm.test",
    REDIS_URL: "redis://localhost:6379/1",
    SCAN_DATABASE_URL: "postgres://mega_crm_scan:pass@localhost:5432/megacrm_test",
    AUTH_DATABASE_URL: "postgres://mega_crm_auth:pass@localhost:5432/megacrm_test",
    UNSUBSCRIBE_TOKEN_SECRET: PRIMARY,
    PUBLIC_APP_URL: "https://api.test.local",
    KMS_PROVIDER: "local",
    KMS_LOCAL_KEK: "grdVCb1fxmhPzylKEPqafcPW4xOMaynE0UwaFUo2OUE=",
    ...overrides,
  };
  return Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function writeFixture(name, overrides) {
  const filePath = path.join(tmpDir, name);
  writeFileSync(filePath, baseFixtureLines(overrides), "utf8");
  createdFiles.push(filePath);
  return filePath;
}

function runCheckEnv(fixturePath) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, fixturePath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return { exitCode: 0, output: stdout };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

describe("Block A -- check-env.mjs UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS behaviour", () => {
  it("absent UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS -- exit code 0", () => {
    const fixture = writeFixture("absent.env", {});
    const run = runCheckEnv(fixture);
    expect(run.exitCode).toBe(0);
  });

  it("one valid entry -- exit code 0", () => {
    const fixture = writeFixture("one-valid.env", {
      UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS: "a".repeat(32),
    });
    const run = runCheckEnv(fixture);
    expect(run.exitCode).toBe(0);
  });

  it("five valid entries -- exit code 0", () => {
    const entries = Array.from({ length: 5 }, (_, i) => String.fromCharCode(97 + i).repeat(32));
    const fixture = writeFixture("five-valid.env", {
      UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS: entries.join(","),
    });
    const run = runCheckEnv(fixture);
    expect(run.exitCode).toBe(0);
  });

  it("six entries -- exit code 1, stderr names the variable", () => {
    const entries = Array.from({ length: 6 }, (_, i) => String.fromCharCode(97 + i).repeat(32));
    const fixture = writeFixture("six.env", {
      UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS: entries.join(","),
    });
    const run = runCheckEnv(fixture);
    expect(run.exitCode).toBe(1);
    expect(run.output).toMatch(/UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS/);
  });

  it("a 31-character entry -- exit code 1", () => {
    const fixture = writeFixture("short-entry.env", {
      UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS: "a".repeat(31),
    });
    const run = runCheckEnv(fixture);
    expect(run.exitCode).toBe(1);
  });

  it("a trailing comma -- exit code 1", () => {
    const fixture = writeFixture("trailing-comma.env", {
      UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS: `${"a".repeat(32)},`,
    });
    const run = runCheckEnv(fixture);
    expect(run.exitCode).toBe(1);
  });

  it("an entry equal to the primary -- exit code 1", () => {
    const fixture = writeFixture("dup-primary.env", {
      UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS: PRIMARY,
    });
    const run = runCheckEnv(fixture);
    expect(run.exitCode).toBe(1);
  });

  it("duplicate entries -- exit code 1", () => {
    const fixture = writeFixture("dup-entries.env", {
      UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS: `${"a".repeat(32)},${"a".repeat(32)}`,
    });
    const run = runCheckEnv(fixture);
    expect(run.exitCode).toBe(1);
  });

  it("primary containing a comma -- exit code 1", () => {
    const fixture = writeFixture("primary-comma.env", {
      UNSUBSCRIBE_TOKEN_SECRET: `${"a".repeat(20)},${"a".repeat(19)}`,
    });
    const run = runCheckEnv(fixture);
    expect(run.exitCode).toBe(1);
  });

  it("primary containing whitespace -- exit code 1", () => {
    // Note: check-env.mjs's line parser trims and splits on the FIRST `=`,
    // so a literal space survives inside the value portion.
    const fixture = writeFixture("primary-space.env", {
      UNSUBSCRIBE_TOKEN_SECRET: `${"a".repeat(20)}_SPACE_${"a".repeat(19)}`.replace("_SPACE_", " "),
    });
    const run = runCheckEnv(fixture);
    expect(run.exitCode).toBe(1);
  });

  it("no stderr output in any failing case contains a secret value from the fixture", () => {
    const secretValue = "s".repeat(32);
    const fixture = writeFixture("no-leak.env", {
      UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS: `${secretValue},${secretValue}`,
    });
    const run = runCheckEnv(fixture);
    expect(run.exitCode).toBe(1);
    expect(run.output).not.toContain(secretValue);
  });
});

describe("Block B -- three-site parity (RESEARCH.md Pitfall 4)", () => {
  const API_ENV_TS = path.join(REPO_ROOT, "apps/api/src/env.ts");
  const WORKER_SERVER_TS = path.join(REPO_ROOT, "apps/worker/src/server.ts");
  const CHECK_ENV_MJS = SCRIPT;

  // Declaration-shaped: a word-boundary-anchored identifier starting with
  // MAX and containing PREVIOUS, optional type annotation, `=`, then the
  // literal digit 5 -- deliberately shaped so a bare mention of the name or
  // the digit inside a comment cannot satisfy it (only an actual assignment
  // does).
  const MAX_DECLARATION_RE = /\bMAX\w*PREVIOUS\w*\s*(?::\s*[A-Za-z<>[\]]+\s*)?=\s*5\b/;

  function extractMax(filePath) {
    const source = readFileSync(filePath, "utf8");
    const match = source.match(MAX_DECLARATION_RE);
    return match ? match[0] : null;
  }

  it("apps/api/src/env.ts declares a matching maximum assignment", () => {
    expect(extractMax(API_ENV_TS)).not.toBeNull();
  });

  it("apps/worker/src/server.ts declares a matching maximum assignment", () => {
    expect(extractMax(WORKER_SERVER_TS)).not.toBeNull();
  });

  it("scripts/check-env.mjs declares a matching maximum assignment", () => {
    expect(extractMax(CHECK_ENV_MJS)).not.toBeNull();
  });

  it("all three matched values equal 5", () => {
    for (const filePath of [API_ENV_TS, WORKER_SERVER_TS, CHECK_ENV_MJS]) {
      const match = extractMax(filePath);
      expect(match, `expected a MAX_..._PREVIOUS_... = 5 declaration in ${filePath}`).not.toBeNull();
      expect(match.trim().endsWith("= 5") || match.trim().endsWith("=5")).toBe(true);
    }
  });

  it("each of the three files also references UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS", () => {
    for (const filePath of [API_ENV_TS, WORKER_SERVER_TS, CHECK_ENV_MJS]) {
      const source = readFileSync(filePath, "utf8");
      expect(source, `expected UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS to appear in ${filePath}`).toMatch(
        /UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS/
      );
    }
  });
});
