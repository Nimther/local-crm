#!/usr/bin/env node
// GSD 08-14 (QG-03): the coverage ratchet.
//
// scripts/coverage-gate.mjs enforces the threshold. This stops the threshold
// itself from being quietly reduced in the same commit that broke it — the
// difference between a gate and a decoration.
//
// SPEC's negative criterion for R3 is that CI fails when the recorded value
// decreased in the diff. Any decrease fails, however small — permitting a
// margin would be a smaller version of the same loophole. Nor is one needed:
// coverage-baseline.json carries `measuredLines` and `measuredAt`, so a
// legitimate re-measurement is visible as exactly that.
//
// The base copy comes from `git show <ref>:coverage-baseline.json`. A base
// branch that has no such file maps to the null case, which passes — that is
// the state on the very commit introducing the file. Any OTHER git failure is
// an error, not a pass: a ratchet that silently passes whenever git is unhappy
// is a ratchet that stops ratcheting the first time CI is misconfigured.
//
// No dependencies -- Node built-ins only.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_BASE_REF = "origin/master";
const BASELINE_FILE = "coverage-baseline.json";

/**
 * @param current parsed working-tree coverage-baseline.json
 * @param base    parsed base-branch copy, or null when the base has no such file
 * @returns {{ pass: boolean, current: number, base: number|null, delta: number|null }}
 */
export function checkRatchet(current, base) {
  const currentLines = Number(current?.lines);

  if (base === null || base === undefined) {
    return { pass: true, current: currentLines, base: null, delta: null };
  }

  const baseLines = Number(base.lines);
  const delta = currentLines - baseLines;
  return { pass: currentLines >= baseLines, current: currentLines, base: baseLines, delta };
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${path.resolve(entry)}`;
}

/**
 * Read the file at `<ref>:<BASELINE_FILE>`.
 * Returns null when the ref exists but the file does not; throws otherwise.
 */
function readBaseCopy(ref) {
  const result = spawnSync("git", ["show", `${ref}:${BASELINE_FILE}`], { encoding: "utf8" });

  if (result.status === 0) return JSON.parse(result.stdout);

  const stderr = (result.stderr ?? "").trim();

  // "path 'x' does not exist in 'ref'" / "exists on disk, but not in 'ref'"
  if (/does not exist|exists on disk/i.test(stderr)) return null;

  throw new Error(
    `could not read ${BASELINE_FILE} from ${ref}: ${stderr || `git exited ${String(result.status)}`}`,
  );
}

if (isDirectInvocation()) {
  const ref = process.argv[2] ?? DEFAULT_BASE_REF;

  let current;
  try {
    current = JSON.parse(readFileSync(path.resolve(process.cwd(), BASELINE_FILE), "utf8"));
  } catch (err) {
    console.error(`coverage:ratchet FAILED: could not read ${BASELINE_FILE}.\n  ${err.message}`);
    process.exit(1);
  }

  let base;
  try {
    base = readBaseCopy(ref);
  } catch (err) {
    console.error(
      `coverage:ratchet FAILED: ${err.message}\n\n` +
        `If the base ref is wrong for this branch, pass it explicitly:\n` +
        `  node scripts/coverage-ratchet.mjs origin/main`,
    );
    process.exit(1);
  }

  const result = checkRatchet(current, base);

  console.log(
    [
      `coverage:ratchet — base ref ${ref}`,
      `  current ${result.current}`,
      `  base    ${result.base === null ? "(no baseline on the base ref yet)" : result.base}`,
      `  delta   ${result.delta === null ? "n/a" : result.delta}`,
    ].join("\n"),
  );

  if (!result.pass) {
    console.error(
      [
        "",
        "coverage:ratchet FAILED: the recorded coverage threshold was LOWERED.",
        "",
        "Raising coverage is the way to make a red gate green. Lowering the",
        "threshold makes the gate agree with the regression instead. If the",
        "number genuinely needs re-measuring, say so in the commit and update",
        "measuredLines/measuredAt alongside it so the change is auditable.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log("coverage:ratchet — OK");
}
