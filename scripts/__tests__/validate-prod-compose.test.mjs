// Phase 14 plan 08 (OPS-01, OPS-02, DB-13, D-09, Pitfall 19, Pitfall 7):
// tests for the production compose invariant gate.
//
// Mirrors scripts/__tests__/lint-pg-pool-factory.test.mjs's own mix: the
// pure exported helpers/evaluator are asserted on directly with in-memory
// fixtures (fast, precise per-invariant edge cases), and the CLI entry
// point is exercised as a real subprocess for the behaviors that are
// actually about exit codes and printed counts -- what CI runs is the
// subprocess, not the imported function.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EXPECTED_SERVICES,
  POOL_SUM_FLOOR,
  checkPgbackrestConfigHasNoCredential,
  evaluateInvariants,
  extractImageTag,
  isMutableTag,
  parseDurationToSeconds,
  parseEnvFile,
  parseMemLimitToBytes,
  resolveViaYamlFallback,
  runValidation,
  substituteVars,
} from "../validate-prod-compose.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/validate-prod-compose.mjs");
const FIXTURES_DIR = path.join(REPO_ROOT, "scripts/__fixtures__/prod-compose");

function readFixture(name) {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

function runCli() {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
    return { exitCode: 0, output: stdout };
  } catch (err) {
    return { exitCode: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("value normalization helpers", () => {
  it("parseMemLimitToBytes handles shorthand strings and raw byte numbers", () => {
    expect(parseMemLimitToBytes("2048m")).toBe(2048 * 1024 * 1024);
    expect(parseMemLimitToBytes("768m")).toBe(768 * 1024 * 1024);
    expect(parseMemLimitToBytes("1g")).toBe(1024 ** 3);
    expect(parseMemLimitToBytes(536_870_912)).toBe(536_870_912);
    expect(parseMemLimitToBytes(undefined)).toBeUndefined();
    expect(parseMemLimitToBytes("")).toBeUndefined();
  });

  it("parseDurationToSeconds handles '<n>s' strings and bare numbers", () => {
    expect(parseDurationToSeconds("60s")).toBe(60);
    expect(parseDurationToSeconds("51s")).toBe(51);
    expect(parseDurationToSeconds(60)).toBe(60);
    expect(parseDurationToSeconds(undefined)).toBeUndefined();
  });

  it("parseDurationToSeconds handles the Go-style duration strings a real `docker compose config` returns", () => {
    // Plan 14-10: found empirically that `docker compose config --format
    // json` normalizes stop_grace_period to Go's time.Duration.String()
    // format, not "<n>s" -- confirmed directly against several
    // WORKER_STOP_GRACE_PERIOD_SECONDS values.
    expect(parseDurationToSeconds("1m0s")).toBe(60);
    expect(parseDurationToSeconds("1m30s")).toBe(90);
    expect(parseDurationToSeconds("2m5s")).toBe(125);
    expect(parseDurationToSeconds("45s")).toBe(45);
  });

  it("extractImageTag / isMutableTag flag latest, branch names, and missing tags", () => {
    expect(extractImageTag("ghcr.io/example/repo/api:abc123")).toBe("abc123");
    expect(extractImageTag("ghcr.io/example/repo/api:latest")).toBe("latest");
    expect(extractImageTag("ghcr.io/example/repo/api")).toBe("");
    expect(isMutableTag("latest")).toBe(true);
    expect(isMutableTag("main")).toBe(true);
    expect(isMutableTag("")).toBe(true);
    expect(isMutableTag("0123456789abcdef0123456789abcdef01234567")).toBe(false);
  });

  it("substituteVars resolves ${VAR}, falls back to ${VAR:-default}, and blanks an unset/no-default var", () => {
    const env = { FOO: "bar" };
    expect(substituteVars("x: ${FOO}", env)).toBe("x: bar");
    expect(substituteVars("x: ${MISSING:-fallback}", env)).toBe("x: fallback");
    expect(substituteVars("x: ${MISSING}", env)).toBe("x: ");
    // A default value that itself begins with "-" (e.g. a negative
    // oom_score_adj) must resolve correctly, not be mistaken for a second
    // ":-" separator.
    expect(substituteVars("x: ${MISSING:--500}", env)).toBe("x: -500");
  });

  it("parseEnvFile skips comments and blank lines, matching scripts/check-env.mjs's own parser", () => {
    const parsed = parseEnvFile("# comment\n\nFOO=bar\nBAZ=1\n  # indented comment\nQUX=\n");
    expect(parsed).toEqual({ FOO: "bar", BAZ: "1", QUX: "" });
  });
});

describe("the committed production compose file passes with a non-zero invariant count", () => {
  it("runValidation resolves the real file + example env with zero violations", () => {
    const result = runValidation({ baseDir: REPO_ROOT });
    expect(result.violations).toEqual([]);
    expect(result.servicesChecked).toBe(EXPECTED_SERVICES.length);
    expect(result.checkedCount).toBeGreaterThan(0);
  });

  it("the CLI exits 0 and reports non-zero service/invariant counts", () => {
    const { exitCode, output } = runCli();
    expect(exitCode).toBe(0);
    expect(output).toMatch(/\d+ service\(s\), \d+ invariant\(s\) checked/);
  });
});

describe("each fixture trips exactly the invariant it targets", () => {
  const cases = [
    { fixture: "missing-mem-limit.yml", rule: "missing-mem-limit", service: "api" },
    { fixture: "db-oom-non-negative.yml", rule: "db-oom-score-adj-not-negative", service: "db" },
    { fixture: "non-db-oom-score-adj-negative.yml", rule: "non-db-oom-score-adj-negative", service: "api" },
    {
      fixture: "pgbackrest-oom-score-adj-negative.yml",
      rule: "non-db-oom-score-adj-negative",
      service: "pgbackrest",
    },
    { fixture: "non-web-service-publishes-port.yml", rule: "non-web-service-publishes-port", service: "redis" },
    { fixture: "mutable-image-tag.yml", rule: "mutable-image-tag", service: "web" },
    { fixture: "max-connections-at-floor.yml", rule: "max-connections-at-or-below-floor", service: "db" },
    { fixture: "migrate-not-excluded.yml", rule: "migrate-not-profile-excluded", service: "migrate" },
    { fixture: "missing-pgbackrest-service.yml", rule: "missing-service", service: "pgbackrest" },
    { fixture: "pgbackrest-missing-mem-limit.yml", rule: "missing-mem-limit", service: "pgbackrest" },
    { fixture: "pgbackrest-publishes-port.yml", rule: "non-web-service-publishes-port", service: "pgbackrest" },
    {
      fixture: "pgbackrest-missing-data-volume.yml",
      rule: "pgbackrest-missing-shared-data-volume",
      service: "pgbackrest",
    },
    // Phase 15 plan 17 (OPS-10): `alloy`, the Grafana Alloy log-shipping
    // sidecar.
    { fixture: "missing-alloy-service.yml", rule: "missing-service", service: "alloy" },
    { fixture: "alloy-mutable-image-tag.yml", rule: "mutable-image-tag", service: "alloy" },
  ];

  for (const { fixture, rule, service } of cases) {
    it(`${fixture} trips "${rule}"`, () => {
      const model = resolveViaYamlFallback(readFixture(fixture), {});
      const { violations, checkedCount } = evaluateInvariants(model, {
        poolSumFloor: POOL_SUM_FLOOR,
        expectedStopGraceSeconds: 60,
      });
      expect(checkedCount).toBeGreaterThan(0);
      expect(violations.some((v) => v.rule === rule && v.service === service)).toBe(true);
    });
  }

  it("stop-grace-period-drift.yml trips the drift check against the expected published value", () => {
    const model = resolveViaYamlFallback(readFixture("stop-grace-period-drift.yml"), {});
    const { violations } = evaluateInvariants(model, { poolSumFloor: POOL_SUM_FLOOR, expectedStopGraceSeconds: 60 });
    expect(violations.some((v) => v.rule === "stop-grace-period-drift" && v.service === "worker")).toBe(true);
  });

  it("a compliant service trips none of the per-service invariants it declares", () => {
    const model = resolveViaYamlFallback(
      [
        "services:",
        "  db:",
        "    image: postgres:17",
        "    mem_limit: 2048m",
        "    oom_score_adj: -500",
        "    environment:",
        "      PG_MAX_CONNECTIONS: 200",
      ].join("\n"),
      {},
    );
    const { violations } = evaluateInvariants(model, { poolSumFloor: POOL_SUM_FLOOR, expectedStopGraceSeconds: 60 });
    expect(violations.some((v) => v.service === "db")).toBe(false);
  });
});

describe("checkPgbackrestConfigHasNoCredential", () => {
  it("flags a literal credential value in the pgBackRest configuration file", () => {
    const fixtureRoot = path.join(FIXTURES_DIR, "pgbackrest-conf-with-credential");
    const result = checkPgbackrestConfigHasNoCredential(fixtureRoot);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/repo1-cipher-pass/);
  });

  it("passes against the real committed pgbackrest.conf (no literal credential)", () => {
    const result = checkPgbackrestConfigHasNoCredential(REPO_ROOT);
    expect(result.ok).toBe(true);
  });
});

describe("a vacuous scan is impossible to mistake for a pass", () => {
  it("evaluateInvariants against zero services still reports the EXPECTED_SERVICES checks, never a zero count", () => {
    const { violations, checkedCount } = evaluateInvariants(
      { services: {} },
      { poolSumFloor: POOL_SUM_FLOOR, expectedStopGraceSeconds: 60 },
    );
    expect(checkedCount).toBe(EXPECTED_SERVICES.length);
    expect(violations).toHaveLength(EXPECTED_SERVICES.length);
  });
});
