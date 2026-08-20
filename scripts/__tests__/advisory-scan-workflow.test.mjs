// Phase 18 plan 04 (DEP-02, ROADMAP SC3). Drift test for the daily scheduled
// advisory scan workflow. Written BEFORE .github/workflows/advisory-scan.yml
// exists -- this suite is this plan's RED evidence.
//
// Plain string/regex processing over the two workflow files as text, no YAML
// parser and no new dependency -- matching every sibling script/test in
// `scripts/` (see check-web-chunks.test.mjs, this plan's own <read_first>).
//
// Every assertion here is a DRIFT check: it derives its expectation from
// ci.yml (the file that already exists and already governs the PR gate)
// rather than restating a hardcoded literal, so a rename or divergence in
// either file fails this test instead of silently passing.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const CI_YML_PATH = path.join(REPO_ROOT, ".github/workflows/ci.yml");
const SCAN_YML_PATH = path.join(REPO_ROOT, ".github/workflows/advisory-scan.yml");

const DEDUP_LABEL = "dependency-advisory";

/** Reads a workflow file as text; returns null if it does not exist (RED state for advisory-scan.yml). */
function tryReadFile(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Extracts the `run:` line (the actual shell command, not the `run:` token
 * itself) that invokes the dependency advisory gate npm script from a
 * workflow file's text. Returns null if no such line exists.
 */
function extractGateInvocation(workflowText) {
  if (workflowText === null) return null;
  const lines = workflowText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("run:") && trimmed.includes("check:dependency-advisories")) {
      return trimmed;
    }
  }
  return null;
}

/**
 * Collects the top-level `permissions:` block's key set from workflow text.
 * Returns null if no top-level `permissions:` block exists.
 */
function extractPermissionsKeys(workflowText) {
  const lines = workflowText.split("\n");
  const startIndex = lines.findIndex((line) => /^permissions:\s*$/.test(line));
  if (startIndex === -1) return null;
  const keys = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // dedented back to top level: block ended
    const match = line.match(/^\s{2}([a-z-]+):/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

describe("advisory-scan.yml (Phase 18 plan 04, DEP-02/SC3)", () => {
  const ciText = readFileSync(CI_YML_PATH, "utf8");
  const scanText = tryReadFile(SCAN_YML_PATH);

  it("exists at .github/workflows/advisory-scan.yml", () => {
    expect(scanText, "advisory-scan.yml is missing").not.toBeNull();
  });

  it("declares exactly one daily `cron:` expression under `schedule:`", () => {
    expect(scanText).not.toBeNull();
    const cronLines = scanText.match(/^\s*- cron:\s*"([^"]+)"/gm) ?? [];
    expect(cronLines.length).toBe(1);
    const cronExpr = scanText.match(/^\s*- cron:\s*"([^"]+)"/m)?.[1];
    expect(cronExpr).toBeTruthy();
    // A daily cron has exactly 5 fields, with day-of-month and month as "*"
    // (runs every day) and a fixed minute/hour -- not "*/N" style multi-run.
    const fields = cronExpr.trim().split(/\s+/);
    expect(fields.length).toBe(5);
    const [minute, hour, dayOfMonth, month] = fields;
    expect(minute).not.toBe("*");
    expect(hour).not.toBe("*");
    expect(dayOfMonth).toBe("*");
    expect(month).toBe("*");
  });

  it("declares a `workflow_dispatch:` trigger", () => {
    expect(scanText).not.toBeNull();
    expect(scanText).toMatch(/^\s*workflow_dispatch:\s*$/m);
  });

  it("declares a top-level `permissions:` block granting exactly `contents: read` and `issues: write`", () => {
    expect(scanText).not.toBeNull();
    const keys = extractPermissionsKeys(scanText);
    expect(keys).not.toBeNull();
    expect(keys.sort()).toEqual(["contents", "issues"]);
    expect(scanText).toMatch(/^\s{2}contents:\s*read\s*$/m);
    expect(scanText).toMatch(/^\s{2}issues:\s*write\s*$/m);
  });

  it("pins every `uses:` line to a 40-character commit SHA with a trailing version comment, never a floating tag", () => {
    expect(scanText).not.toBeNull();
    const usesLines = scanText.split("\n").filter((line) => /\buses:\s*/.test(line));
    expect(usesLines.length).toBeGreaterThan(0);
    for (const line of usesLines) {
      expect(line).toMatch(/uses:\s*[^\s@]+@[0-9a-f]{40}\s*#\s*\S+/);
    }
  });

  it("invokes the dependency advisory gate through the SAME npm script ci.yml's `static` job invokes (derived, not hardcoded)", () => {
    const ciInvocation = extractGateInvocation(ciText);
    expect(ciInvocation, "ci.yml no longer invokes check:dependency-advisories -- update this test's derivation").not.toBeNull();

    const scanInvocation = extractGateInvocation(scanText);
    expect(scanInvocation, "advisory-scan.yml does not invoke check:dependency-advisories").not.toBeNull();

    expect(scanInvocation).toBe(ciInvocation);
  });

  it("guards the issue-surfacing step so it only runs when the gate step failed (`if: failure()`)", () => {
    expect(scanText).not.toBeNull();
    expect(scanText).toMatch(/if:\s*failure\(\)/);
  });

  it("uses the same dedup label literal in both the issue search and the issue creation, at least twice", () => {
    expect(scanText).not.toBeNull();
    const occurrences = scanText.split(DEDUP_LABEL).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("reads the Node version from `.nvmrc` rather than hardcoding a version", () => {
    expect(scanText).not.toBeNull();
    expect(scanText).toMatch(/node-version-file:\s*\.nvmrc/);
  });
});
