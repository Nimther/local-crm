#!/usr/bin/env node
// GSD 08-03 (QG-02): the lint file-count floor.
//
// Closes the "ESLint checked 0 files and exited 0" hole. An ignores-glob typo
// or a bad `files` pattern makes the lint gate pass vacuously — it reports
// success having examined nothing, and nothing about the exit code
// distinguishes that from a genuinely clean tree.
//
// D-08: the floor is a number in a version-controlled file compared against the
// LENGTH of `eslint --format json`'s array. Dynamic glob counting was
// explicitly rejected — it would re-derive the count from the same globs that
// just broke.
//
// No dependencies -- Node built-ins only.

import { readFileSync } from "node:fs";
import path from "node:path";

const FLOOR_FILE = "lint-file-floor.json";

/**
 * @param report parsed `eslint --format json` output (an array, one entry per checked file)
 * @param floor  minimum acceptable file count
 * @returns {{ pass: boolean, checked: number, floor: number }}
 */
export function checkLintFileFloor(report, floor) {
  const checked = Array.isArray(report) ? report.length : 0;
  return { pass: checked >= floor, checked, floor };
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${path.resolve(entry)}`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (isDirectInvocation()) {
  const floorPath = path.resolve(process.cwd(), FLOOR_FILE);
  const { minFiles } = JSON.parse(readFileSync(floorPath, "utf8"));

  const reportPath = process.argv[2];
  const source = reportPath ? `report file ${reportPath}` : "stdin";
  const raw = reportPath
    ? readFileSync(path.resolve(process.cwd(), reportPath), "utf8")
    : await readStdin();

  // An empty or unparseable report is not a crash to shrug at — it IS the
  // vacuous-success case this gate exists to catch, and it must be reported as
  // such rather than as a JSON stack trace. It happens when ESLint failed to
  // start at all (a config error), which leaves stdout empty.
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    console.error(
      [
        `Lint file-count floor FAILED: no parseable ESLint report on ${source}.`,
        "",
        "ESLint produced no JSON, which usually means it did not run at all —",
        "a syntax or resolution error in eslint.config.js. Run `npm run lint`",
        "on its own to see the real error.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const result = checkLintFileFloor(report, minFiles);

  if (!result.pass) {
    console.error(
      [
        `Lint file-count floor FAILED: ESLint reported ${result.checked} file(s), floor is ${result.floor}.`,
        "",
        "This almost always means an ignores glob or a `files` pattern in",
        "eslint.config.js stopped matching — the gate would otherwise have passed",
        "while checking little or nothing. Fix the config; do not lower the floor",
        `to make this pass. If files were legitimately deleted, edit ${FLOOR_FILE}`,
        "and update its measuredAt provenance in the same change.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(`lint:floor — ${result.checked} file(s) checked, floor ${result.floor}. OK`);
}
