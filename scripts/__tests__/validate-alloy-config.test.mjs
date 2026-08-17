// Phase 15 gap closure 15-22 (OPS-10, G-15-4): tests for the alloy-config
// gate. Mirrors validate-prod-compose.test.mjs's own mix -- pure helpers
// asserted directly against fixtures, plus the CLI exercised as a real
// subprocess for exit-code behavior (what CI runs, not the imported
// function).
//
// Task 2 (GREEN) added the regression lock below -- `scanIllegalCommentTokens`
// over the REAL committed docker/alloy/config.alloy returns an empty array.
// That assertion could not exist before Task 2's fix; it is the one that
// fails the moment anyone reintroduces the defect this gap closure exists
// to prevent (G-15-4).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ALLOY_CONFIG_REL,
  COMPOSE_FILE_REL,
  CONTAINER_CONFIG_PATH,
  isDockerAvailable,
  resolveAlloyImageRef,
  runValidation,
  scanIllegalCommentTokens,
} from "../validate-alloy-config.mjs";
import { extractImageTag, isMutableTag } from "../validate-prod-compose.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/validate-alloy-config.mjs");
const FIXTURES_DIR = path.join(REPO_ROOT, "scripts/__fixtures__/alloy-config");

function readFixture(name) {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

describe("scanIllegalCommentTokens", () => {
  it("reports the illegal `#` at 1:1 when it is the first non-whitespace character of a line (the committed file's header shape)", () => {
    const violations = scanIllegalCommentTokens(readFixture("hash-comment-header.alloy"));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toMatchObject({ rule: "illegal-comment-token", line: 1, column: 1 });
  });

  it("reports a mid-line trailing `#` at its own column, not line 1", () => {
    const violations = scanIllegalCommentTokens(readFixture("hash-trailing-comment.alloy"));
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
    expect(violations[0].column).toBeGreaterThan(1);
  });

  it("does not report a `#` inside a `//` line comment, a block comment, or a quoted string value", () => {
    const violations = scanIllegalCommentTokens(readFixture("valid-with-slash-comments.alloy"));
    expect(violations).toEqual([]);
  });

  it("does not report a `#` inside a double-quoted string that contains an earlier backslash-escaped quote", () => {
    // The escaped quote must not be mistaken for the string's closing quote --
    // if it were, the '#' below would be re-classified as CODE and flagged.
    const text = 'url = "a\\"b#c"\n';
    expect(scanIllegalCommentTokens(text)).toEqual([]);
  });

  it("returns an empty array for a file with only Alloy-legal comments and blocks", () => {
    const text = ["// fine", "/* also fine */", 'x = "y"', ""].join("\n");
    expect(scanIllegalCommentTokens(text)).toEqual([]);
  });
});

describe("resolveAlloyImageRef", () => {
  it("returns the real docker-compose.prod.yml's own pinned alloy image reference", () => {
    const ref = resolveAlloyImageRef(REPO_ROOT);
    expect(typeof ref).toBe("string");
    expect(ref.length).toBeGreaterThan(0);

    // Not a mutable tag -- asserted with validate-prod-compose.mjs's own helpers.
    const tag = extractImageTag(ref);
    expect(isMutableTag(tag)).toBe(false);
  });

  it("throws a named error when the compose file declares no alloy service or no image for it", () => {
    // A baseDir whose docker-compose.prod.yml/prod.env.example do not exist
    // at all exercises the same failure path deterministically without a
    // second fixture compose file.
    expect(() => resolveAlloyImageRef(path.join(REPO_ROOT, "scripts/__fixtures__/alloy-config"))).toThrow();
  });
});

describe("isDockerAvailable", () => {
  it("returns a boolean", () => {
    expect(typeof isDockerAvailable()).toBe("boolean");
  });
});

describe("runValidation -- fail-closed orchestration with injected seams", () => {
  const fakeDockerAvailable = (available) => () => available;
  const fakeRunFmt =
    (exitCode, stderr = "") =>
    () => ({ exitCode, stderr });

  it("docker reachable: the binary layer runs and its failure becomes a violation carrying the parser's own stderr", () => {
    const result = runValidation({
      baseDir: REPO_ROOT,
      requireBinary: false,
      dockerAvailable: fakeDockerAvailable(true),
      runFmt: fakeRunFmt(1, "illegal character U+0023 '#'"),
    });
    expect(result.binaryRan).toBe(true);
    expect(result.violations.some((v) => v.rule === "alloy-binary-parse-failed" && v.detail.includes("U+0023"))).toBe(
      true,
    );
  });

  it("docker reachable and fmt succeeds: no binary-related violation", () => {
    const result = runValidation({
      baseDir: REPO_ROOT,
      requireBinary: false,
      dockerAvailable: fakeDockerAvailable(true),
      runFmt: fakeRunFmt(0),
    });
    expect(result.binaryRan).toBe(true);
    expect(result.violations.some((v) => v.rule.startsWith("alloy-binary"))).toBe(false);
  });

  it("docker unreachable and requireBinary false: no violation, skip reason recorded naming the binary layer did not run", () => {
    const result = runValidation({
      baseDir: REPO_ROOT,
      requireBinary: false,
      dockerAvailable: fakeDockerAvailable(false),
      runFmt: fakeRunFmt(0),
    });
    expect(result.binaryRan).toBe(false);
    expect(result.skipReason).toBeTruthy();
    expect(result.violations.some((v) => v.rule.startsWith("alloy-binary"))).toBe(false);
  });

  it("docker unreachable and requireBinary true: exactly one violation with rule alloy-binary-check-unavailable, regardless of the static scan's outcome", () => {
    const result = runValidation({
      baseDir: REPO_ROOT,
      requireBinary: true,
      dockerAvailable: fakeDockerAvailable(false),
      runFmt: fakeRunFmt(0),
    });
    expect(result.binaryRan).toBe(false);
    const binaryViolations = result.violations.filter((v) => v.rule === "alloy-binary-check-unavailable");
    expect(binaryViolations).toHaveLength(1);
  });
});

describe("CLI wiring -- exercised as a real subprocess (this is what CI runs)", () => {
  it("with no docker on PATH and ALLOY_VALIDATE_REQUIRE_BINARY=1, exits non-zero and prints alloy-binary-check-unavailable", () => {
    let threw = false;
    let output = "";
    try {
      execFileSync(process.execPath, [SCRIPT], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, PATH: "/nonexistent", ALLOY_VALIDATE_REQUIRE_BINARY: "1" },
      });
    } catch (err) {
      threw = true;
      output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      expect(err.status).not.toBe(0);
    }
    expect(threw).toBe(true);
    expect(output).toMatch(/alloy-binary-check-unavailable/);
  });
});

describe("regression lock -- the real committed config stays clean (G-15-4)", () => {
  it("scanIllegalCommentTokens over the real docker/alloy/config.alloy returns an empty array", () => {
    const realConfigText = readFileSync(path.join(REPO_ROOT, ALLOY_CONFIG_REL), "utf8");
    expect(scanIllegalCommentTokens(realConfigText)).toEqual([]);
  });
});

describe("in-container path cannot drift from the compose service's own declaration", () => {
  it("docker-compose.prod.yml's raw text contains CONTAINER_CONFIG_PATH", () => {
    const composeText = readFileSync(path.join(REPO_ROOT, COMPOSE_FILE_REL), "utf8");
    expect(composeText).toContain(CONTAINER_CONFIG_PATH);
  });

  it("ALLOY_CONFIG_REL points at the real committed file", () => {
    expect(readFileSync(path.join(REPO_ROOT, ALLOY_CONFIG_REL), "utf8").length).toBeGreaterThan(0);
  });
});

describe("wiring lock -- the gate cannot silently become advisory (Task 3)", () => {
  it("package.json declares the verify:alloy-config script pointing at this gate", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    expect(pkg.scripts?.["verify:alloy-config"]).toBe("node scripts/validate-alloy-config.mjs");
  });

  it(".github/workflows/ci.yml's static job runs verify:alloy-config with ALLOY_VALIDATE_REQUIRE_BINARY set", () => {
    const ciText = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ciText).toMatch(/run:\s*npm run verify:alloy-config/);
    expect(ciText).toMatch(/ALLOY_VALIDATE_REQUIRE_BINARY:\s*["']1["']/);
  });
});
