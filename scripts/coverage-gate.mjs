#!/usr/bin/env node
// GSD 08-14 (QG-03): the coverage threshold gate.
//
// Vitest ships `coverage.thresholds`, and D-18 rejected it for two reasons this
// file exists to supply: it offers no unrounded comparison, and it offers no
// protection against the threshold being lowered in the same commit that broke
// it. The second half is scripts/coverage-ratchet.mjs.
//
// Two semantics decide whether this is a gate or a decoration:
//
//   boundary  — a run exactly AT the threshold PASSES. Failing on equality
//               would make the recorded number unreachable by construction.
//   precision — the comparison is the unrounded covered/total fraction, so a
//               run at 84.996% fails an 85% threshold instead of being
//               presented as equal to it. Rounding is how a real regression
//               gets through looking like a tie.
//
// No dependencies -- Node built-ins only.

import { readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_SUMMARY = "coverage/coverage-summary.json";
const DEFAULT_BASELINE = "coverage-baseline.json";

/**
 * @param summary  parsed `coverage/coverage-summary.json`
 * @param baseline parsed `coverage-baseline.json`
 * @returns {{ pass: boolean, actual: number, threshold: number, covered: number, total: number, reason?: string }}
 */
export function checkCoverageGate(summary, baseline) {
  const lines = summary?.total?.lines ?? {};
  const covered = Number(lines.covered ?? 0);
  const total = Number(lines.total ?? 0);
  const threshold = Number(baseline?.lines);

  if (!(total > 0)) {
    // A report with nothing in the denominator means the run measured nothing.
    // Passing on it is the coverage equivalent of a lint run that checked zero
    // files — the exact hole lint-file-floor.json exists to close for ESLint.
    return {
      pass: false,
      actual: 0,
      threshold,
      covered,
      total,
      reason: "the coverage report has an empty denominator — the run measured nothing",
    };
  }

  // No rounding anywhere before the comparison, and `>=` so equality passes.
  const actual = covered / total;
  return { pass: actual >= threshold, actual, threshold, covered, total };
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${path.resolve(entry)}`;
}

if (isDirectInvocation()) {
  const summaryPath = path.resolve(process.cwd(), process.argv[2] ?? DEFAULT_SUMMARY);
  const baselinePath = path.resolve(process.cwd(), process.argv[3] ?? DEFAULT_BASELINE);

  let summary;
  let baseline;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (err) {
    console.error(
      `coverage:gate FAILED: could not read ${summaryPath}.\n  ${err.message}\n\n` +
        "Run `npm run coverage` first — this gate reads the aggregated report, it does not produce it.",
    );
    process.exit(1);
  }
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (err) {
    console.error(`coverage:gate FAILED: could not read ${baselinePath}.\n  ${err.message}`);
    process.exit(1);
  }

  const result = checkCoverageGate(summary, baseline);

  // Printed on BOTH paths on purpose: a gate that is silent when green gives a
  // reader no way to watch the margin narrow commit by commit.
  console.log(
    [
      `coverage:gate — lines ${result.covered}/${result.total}`,
      `  actual    ${result.actual}`,
      `  threshold ${result.threshold}`,
    ].join("\n"),
  );

  if (!result.pass) {
    console.error(
      [
        "",
        `coverage:gate FAILED${result.reason ? `: ${result.reason}` : ""}.`,
        result.reason
          ? ""
          : `  short by ${result.threshold - result.actual} (unrounded).`,
        "",
        "Add tests. Do NOT lower `lines` in coverage-baseline.json to close the gap —",
        "scripts/coverage-ratchet.mjs fails on any decrease, and the number carries its",
        "own measurement provenance so a reduction is visibly a capitulation.",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    );
    process.exit(1);
  }

  console.log("coverage:gate — OK");
}
