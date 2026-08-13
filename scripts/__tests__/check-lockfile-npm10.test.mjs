// Phase 14 plan 14 (G-14-4 gap closure): tests for the npm-10 lockfile
// recurrence guard.
//
// Mirrors lint-pg-pool-factory.test.mjs's own mix exactly: the pure exported
// helpers are asserted on directly with in-memory strings (fast, precise
// edge cases), and the CLI entry point is exercised as a real subprocess for
// the behaviors that are actually about exit codes -- what CI runs is the
// subprocess, not the imported function.
//
// Hermetic by construction: every CLI case below either runs entirely
// offline (the `--plan` mode and the tag-mismatch fixture, both of which
// never invoke npm) or points `--npm-command` at this environment's own
// `npm` binary against a fixture lockfile that is already fully specified
// (a real `node_modules/left-pad` entry with resolved+integrity) -- npm's
// lockfile-sync check reads that entirely from the lockfile itself and
// never reaches the network. See scripts/check-lockfile-npm10.mjs's own
// header for why npm-10 specificity itself is proven elsewhere (Task 1's
// verify, and the real CI step), not by these tests.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseNodeTagFromDockerfile,
  readDockerfileSources,
  resolveNodeMajorFromDockerfiles,
  resolveNpmMajorForNode,
} from "../check-lockfile-npm10.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/check-lockfile-npm10.mjs");
const FIXTURES_DIR = path.join(REPO_ROOT, "scripts/__fixtures__/lockfile-npm10");

/** The shape execFileSync throws on a non-zero exit. */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
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

describe("Test 1 -- resolveNodeMajorFromDockerfiles agrees on a single major", () => {
  it("returns the single major shared by all three sources", () => {
    const sources = readDockerfileSources(REPO_ROOT);
    const resolved = resolveNodeMajorFromDockerfiles(sources);
    expect(resolved.major).toBe(22);
    expect(resolved.tag).toBe("22-slim");
  });
});

describe("Test 2 -- resolveNodeMajorFromDockerfiles rejects disagreeing pins", () => {
  it("throws an error naming BOTH conflicting tags", () => {
    const sources = {
      api: "FROM node:22-slim AS deps\n",
      worker: "FROM node:20-slim AS deps\n",
      web: "FROM node:22-slim AS deps\n",
    };
    expect(() => resolveNodeMajorFromDockerfiles(sources)).toThrowError(/22-slim/);
    expect(() => resolveNodeMajorFromDockerfiles(sources)).toThrowError(/20-slim/);
  });
});

describe("Test 3 -- node-major -> npm-major lookup", () => {
  it("returns 10 for node 22", () => {
    expect(resolveNpmMajorForNode(22)).toBe(10);
  });

  it("throws an instructive error for an unmapped major, naming the major and the discovery command", () => {
    expect(() => resolveNpmMajorForNode(18)).toThrowError(/18/);
    expect(() => resolveNpmMajorForNode(18)).toThrowError(/npm --version/);
  });
});

describe("Test 4 -- parseNodeTagFromDockerfile", () => {
  it("extracts the tag from the first FROM node: line", () => {
    const tag = parseNodeTagFromDockerfile("FROM node:22-slim AS deps\nFROM deps AS build\n", "api");
    expect(tag).toBe("22-slim");
  });

  it("throws when no FROM node: line exists", () => {
    expect(() => parseNodeTagFromDockerfile("FROM caddy:2 AS runtime\n", "web")).toThrowError(/web/);
  });
});

describe("Test 5 -- CLI against the clean fixture (npm-command override -> system npm)", () => {
  it("exits 0", () => {
    const run = runCli(["--repo-root", path.join(FIXTURES_DIR, "clean"), "--npm-command", "npm"]);
    expect(run.exitCode).toBe(0);
  });
});

describe("Test 6 -- CLI against the desynced fixture (npm-command override -> system npm)", () => {
  it("exits non-zero and names the missing package", () => {
    const run = runCli(["--repo-root", path.join(FIXTURES_DIR, "desynced"), "--npm-command", "npm"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/left-pad/);
    expect(run.output).toMatch(/Missing/);
  });
});

describe("Test 7 -- CLI against the tag-mismatch fixture", () => {
  it("exits non-zero before any npm invocation, naming the conflicting tags", () => {
    // A deliberately-invalid npm-command override: if the guard ever reached
    // the npm-invocation step, this would fail with an unrelated ENOENT-style
    // error instead of the tag-conflict message asserted below -- proving
    // the guard truly stops before invoking npm, not merely that it happens
    // to short-circuit in this test's particular ordering.
    const run = runCli([
      "--repo-root",
      path.join(FIXTURES_DIR, "tag-mismatch"),
      "--npm-command",
      "/nonexistent/definitely-not-a-real-npm-binary",
    ]);
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/22-slim/);
    expect(run.output).toMatch(/20-slim/);
    expect(run.output).not.toMatch(/ENOENT/);
  });
});

describe("Test 8 -- CLI against the real repo root in plan-printing mode", () => {
  it("prints the resolved node tag and npm major, exit 0, no npm invoked", () => {
    const run = runCli(["--plan", "--npm-command", "/nonexistent/definitely-not-a-real-npm-binary"]);
    expect(run.exitCode).toBe(0);
    expect(run.output).toMatch(/22-slim/);
    expect(run.output).toMatch(/10/);
    expect(run.output).not.toMatch(/ENOENT/);
  });
});

describe("Test 9 -- the real repo root's own npm-10 dry-run (no override)", () => {
  it("exits 0 against this repo's actual, regenerated package-lock.json", () => {
    const run = runCli([]);
    expect(run.exitCode).toBe(0);
  }, 60_000);
});
