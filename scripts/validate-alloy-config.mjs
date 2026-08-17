#!/usr/bin/env node
// Phase 15 gap closure 15-22 (OPS-10, G-15-4). The machine half of "the
// production Grafana Alloy sidecar's config is syntactically valid Alloy" --
// 15-17-SUMMARY.md explicitly pre-flagged that no automated check in this
// repository ever parses docker/alloy/config.alloy with a real Alloy binary,
// and .planning/debug/alloy-config-hash-comments.md diagnosed exactly why
// that hole mattered: the committed file used `#` comments, which Alloy's
// lexer rejects as an illegal character at the very first byte, restart-
// looping the production sidecar under `restart: unless-stopped` and
// silently stopping all log delivery -- both backstop alert rules (dead-
// man's-switch, error-rate-spike) then read an empty stream.
//
// Two layers, both required for this gate to be real rather than vacuous:
//   1. A hand-rolled, comment-aware, string-aware static scanner
//      (`scanIllegalCommentTokens`) that owns exactly ONE defect class --
//      the illegal `#` comment token -- the same "scoped hand-rolled parser,
//      not a general grammar" discipline this repo already applies in
//      scripts/lint-session-state.mjs, scripts/lint-pg-pool-factory.mjs, and
//      scripts/validate-prod-compose.mjs's own YAML subset.
//   2. A real parse by the SAME pinned `grafana/alloy` image reference
//      docker/docker-compose.prod.yml pins for the `alloy` service --
//      resolved at run time via validate-prod-compose.mjs's own exported
//      `parseEnvFile`/`resolveViaYamlFallback`, never hardcoded here, so this
//      gate can never validate against a stale or different image than the
//      one production actually runs.
//
// The binary layer runs inside `--network none`, a single read-only bind
// mount of config.alloy, no env passthrough and no docker-socket mount --
// strictly less capability than the production sidecar (T-15-69). `alloy
// fmt` parses without evaluating, so the config's three `env()` calls
// resolve nothing and no Grafana Cloud credential is ever present in this
// gate's own environment.
//
// No dependencies -- Node built-ins only (T-15-SC): this plan installs
// nothing and adds no new npm dependency of any kind.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnvFile, resolveViaYamlFallback } from "./validate-prod-compose.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The one committed Alloy config this gate validates. */
export const ALLOY_CONFIG_REL = path.join("docker", "alloy", "config.alloy");

/** The production compose file the `alloy` service's pinned image is read from -- never restated here as a literal. */
export const COMPOSE_FILE_REL = path.join("docker", "docker-compose.prod.yml");

/** The example env file used to resolve `${VAR}` interpolation in the compose file's `image:` line, mirroring validate-prod-compose.mjs's own resolution. */
export const ENV_FILE_REL = path.join("docker", "prod.env.example");

/** The in-container path this gate mounts config.alloy at -- MUST match the
 * read-only bind mount target AND the `command:` argument the `alloy`
 * service already declares in docker-compose.prod.yml (asserted by a
 * dedicated test so the two paths cannot silently drift apart). */
export const CONTAINER_CONFIG_PATH = "/etc/alloy/config.alloy";

/** The single character Alloy's lexer rejects as a comment marker -- this
 * scanner owns exactly this one defect class, nothing broader. */
const ILLEGAL_CHAR = "#";

// ---------------------------------------------------------------------------
// Static scanner -- a four-state character walk (code / double-quoted
// string / line comment / block comment). Comment-awareness and
// string-awareness are load-bearing, not polish: this file's own header
// paragraph (added in Task 2) names the rejected character in `//` prose,
// and a quoted Loki endpoint URL may legitimately contain it too -- a blind
// character search would false-positive on both and make this gate
// unusable, which is how gates get deleted.
// ---------------------------------------------------------------------------

/**
 * Walks `text` tracking exactly four lexical states and reports one record
 * per illegal comment-token occurrence found in CODE position (i.e. neither
 * inside a `//` line comment, a `/* *\/` block comment, nor a double-quoted
 * string). 1-based line and column, matching how a text editor or the real
 * Alloy binary itself reports position.
 *
 * @param {string} text
 * @returns {Array<{rule: "illegal-comment-token", line: number, column: number, lineText: string}>}
 */
export function scanIllegalCommentTokens(text) {
  const lines = text.split("\n");
  const violations = [];

  /** @type {"code" | "string" | "lineComment" | "blockComment"} */
  let state = "code";
  let lineNum = 1;
  let col = 0;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === "\n") {
      lineNum += 1;
      col = 0;
      // A line comment (but never a block comment) ends at end-of-line.
      if (state === "lineComment") state = "code";
      escapeNext = false;
      continue;
    }
    col += 1;
    const next = i + 1 < text.length ? text[i + 1] : "";

    if (state === "code") {
      if (ch === '"') {
        state = "string";
        escapeNext = false;
      } else if (ch === "/" && next === "/") {
        state = "lineComment";
        i += 1;
        col += 1;
      } else if (ch === "/" && next === "*") {
        state = "blockComment";
        i += 1;
        col += 1;
      } else if (ch === ILLEGAL_CHAR) {
        violations.push({
          rule: "illegal-comment-token",
          line: lineNum,
          column: col,
          lineText: lines[lineNum - 1] ?? "",
        });
      }
    } else if (state === "string") {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (ch === '"') {
        state = "code";
      }
    } else if (state === "blockComment") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 1;
        col += 1;
      }
    }
    // state === "lineComment": nothing to do until the newline branch above.
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Image resolution -- reused from validate-prod-compose.mjs, never restated.
// ---------------------------------------------------------------------------

export class AlloyImageResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AlloyImageResolutionError";
  }
}

/**
 * Resolves the `alloy` service's `image:` value from
 * docker/docker-compose.prod.yml, via validate-prod-compose.mjs's own
 * exported `parseEnvFile` + `resolveViaYamlFallback` against
 * docker/prod.env.example -- the same path that resolver uses for every
 * other service, so this gate can never validate against an image different
 * from the one that file actually pins.
 *
 * @param {string} baseDir
 * @returns {string}
 */
export function resolveAlloyImageRef(baseDir) {
  const composeText = readFileSync(path.join(baseDir, COMPOSE_FILE_REL), "utf8");
  const envMap = parseEnvFile(readFileSync(path.join(baseDir, ENV_FILE_REL), "utf8"));
  const model = resolveViaYamlFallback(composeText, envMap);

  const alloy = model.services?.alloy;
  if (!alloy) {
    throw new AlloyImageResolutionError(`${COMPOSE_FILE_REL} declares no "alloy" service`);
  }
  if (!alloy.image) {
    throw new AlloyImageResolutionError(`${COMPOSE_FILE_REL}'s "alloy" service declares no image`);
  }
  return alloy.image;
}

// ---------------------------------------------------------------------------
// Real-binary layer -- capability probe + `alloy fmt` invocation. Both
// injectable seams on `runValidation` below, defaulting to these real
// implementations (the same dependency-seam convention
// `ProcessSendJobDeps.sendMail` established in this repo).
// ---------------------------------------------------------------------------

/** A container cannot run without a reachable daemon -- an installed CLI
 * with no reachable daemon must read as unavailable, mirroring
 * validate-prod-compose.mjs's own `isDockerComposeAvailable()`. */
export function isDockerAvailable() {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `alloy fmt` (parses without evaluating -- no Grafana credential is
 * ever read) against the committed config, inside `--network none` with a
 * single read-only bind mount and no docker-socket mount (T-15-69) --
 * strictly less capability than the production sidecar. Never passes `-w`:
 * this gate asserts parse validity, never formatting, and an in-place
 * rewrite would destroy the reviewable diff this gap-closure plan produces.
 *
 * @param {{baseDir: string, imageRef: string}} args
 * @returns {{exitCode: number, stderr: string}}
 */
export function runAlloyFmt({ baseDir, imageRef }) {
  const configPath = path.join(baseDir, ALLOY_CONFIG_REL);
  const mountArg = `${configPath}:${CONTAINER_CONFIG_PATH}:ro`;
  try {
    execFileSync(
      "docker",
      ["run", "--rm", "--network", "none", "-v", mountArg, imageRef, "fmt", CONTAINER_CONFIG_PATH],
      // Generous timeout: a cold CI runner pulling the pinned vendor image
      // for the first time must not be mistaken for a parse failure.
      { encoding: "utf8", timeout: 5 * 60 * 1000 },
    );
    return { exitCode: 0, stderr: "" };
  } catch (err) {
    const stderr =
      typeof err?.stderr === "string" ? err.stderr : err?.stderr ? err.stderr.toString("utf8") : String(err?.message ?? err);
    return { exitCode: typeof err?.status === "number" ? err.status : 1, stderr };
  }
}

/** Whether the binary layer is required (fail-closed) rather than merely
 * attempted. Defaults to whether `ALLOY_VALIDATE_REQUIRE_BINARY` is set to a
 * non-empty value other than `"0"` -- the CI step sets this; a plain local
 * run without Docker does not require it. */
function defaultRequireBinary() {
  const raw = process.env.ALLOY_VALIDATE_REQUIRE_BINARY;
  return raw !== undefined && raw !== "" && raw !== "0";
}

// ---------------------------------------------------------------------------
// Fail-closed orchestration.
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   baseDir?: string,
 *   requireBinary?: boolean,
 *   dockerAvailable?: () => boolean,
 *   runFmt?: (args: {baseDir: string, imageRef: string}) => {exitCode: number, stderr: string},
 * }} [opts]
 * @returns {{imageRef: string | undefined, binaryRan: boolean, skipReason: string | undefined, violations: Array<{rule: string, line?: number, column?: number, detail: string}>}}
 */
export function runValidation({
  baseDir = process.cwd(),
  requireBinary = defaultRequireBinary(),
  dockerAvailable = isDockerAvailable,
  runFmt = runAlloyFmt,
} = {}) {
  const configText = readFileSync(path.join(baseDir, ALLOY_CONFIG_REL), "utf8");

  // The static scan always runs, in every docker-availability state.
  const violations = scanIllegalCommentTokens(configText).map((v) => ({
    rule: v.rule,
    line: v.line,
    column: v.column,
    detail: v.lineText,
  }));

  let imageRef;
  try {
    imageRef = resolveAlloyImageRef(baseDir);
  } catch (err) {
    violations.push({
      rule: "alloy-image-unresolvable",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  let binaryRan = false;
  let skipReason;
  const dockerIsAvailable = dockerAvailable();

  if (dockerIsAvailable && imageRef !== undefined) {
    binaryRan = true;
    const { exitCode, stderr } = runFmt({ baseDir, imageRef });
    if (exitCode !== 0) {
      violations.push({
        rule: "alloy-binary-parse-failed",
        detail: stderr || `alloy fmt exited with code ${exitCode}`,
      });
    }
  } else if (!dockerIsAvailable && requireBinary) {
    // Exactly one violation, regardless of the static scan's own outcome --
    // an unreachable Docker daemon becomes a violation, not a silent pass.
    violations.push({
      rule: "alloy-binary-check-unavailable",
      detail:
        "Docker is unreachable and ALLOY_VALIDATE_REQUIRE_BINARY is set -- the real-binary layer is required but could not run",
    });
  } else if (!dockerIsAvailable) {
    skipReason = "Docker is unreachable -- the real-binary layer was skipped (set ALLOY_VALIDATE_REQUIRE_BINARY to fail closed instead)";
  } else if (dockerIsAvailable && imageRef === undefined) {
    skipReason = "the alloy image reference could not be resolved -- the real-binary layer was skipped";
  }

  return { imageRef, binaryRan, skipReason, violations };
}

// ---------------------------------------------------------------------------
// CLI -- guarded so importing this module for tests never executes it.
// ---------------------------------------------------------------------------

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${path.resolve(entry)}`;
}

if (isDirectInvocation()) {
  const baseDir = path.resolve(__dirname, "..");
  const result = runValidation({ baseDir });

  console.log(`verify:alloy-config -- resolved image: ${result.imageRef ?? "(unresolved)"}`);
  if (result.binaryRan) {
    console.log("verify:alloy-config -- ran the real Alloy binary (alloy fmt) against the committed config");
  } else if (result.skipReason) {
    console.log(`verify:alloy-config -- binary layer skipped: ${result.skipReason}`);
  }

  if (result.violations.length > 0) {
    for (const v of result.violations) {
      const loc = v.line !== undefined ? `${v.line}:${v.column ?? "?"} ` : "";
      console.error(`  [${v.rule}] ${loc}${v.detail}`);
    }
    console.error(`\n${result.violations.length} violation(s) found.`);
    process.exit(1);
  }

  console.log("verify:alloy-config -- all checks OK.");
}
