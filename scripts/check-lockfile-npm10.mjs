#!/usr/bin/env node
// Phase 14 plan 14 (G-14-4 gap closure). The recurrence guard for the root
// cause diagnosed in .planning/debug/docker-npm-ci-lockfile-desync.md:
// package-lock.json can satisfy npm 11 (dev/CI, Node 26 per .nvmrc) while
// silently NOT satisfying npm 10 -- the major bundled by node:22-slim,
// which every docker/Dockerfile.{api,worker,web} pins for the actual
// production build. npm 11's ideal tree does not require every entry npm
// 10's does (see the diagnosis: vite's OPTIONAL esbuild peer), so a
// routine `npm install <pkg>` performed under dev/CI npm 11 can silently
// drop an npm-10-required entry and reintroduce the defect this guard
// exists to catch.
//
// Why the Docker tag is READ, not hand-typed: this repo's own convention
// for exactly this problem is scripts/print-stop-grace-period.mjs -- a
// machine-read value a drift test asserts, never a hand-typed number. A
// hardcoded "npm 10" here would keep passing after a future base-image
// major bump while silently checking an npm nobody actually builds with.
//
// Why npx and not a real Docker run: .planning/debug/docker-npm-ci-lockfile-desync.md
// verified that npx-resolved npm major 10 produces a byte-alike EUSAGE
// error signature to node:22-slim's bundled npm, and npx works on a
// developer machine or CI runner with no Docker daemon (this sandbox has
// none). This is a same-major proxy, not the literal bundled binary --
// acceptable because npm's lockfile-sync check is a pure, major-scoped
// algorithm, not something that varies by patch. The resolved npm version
// is always printed (T-14-14-02) so an unexpected one is visible in the
// job log rather than silent.
//
// Same class as scripts/lint-pg-pool-factory.mjs and
// scripts/lint-session-state.mjs: Node built-ins only, repo root resolved
// from import.meta.url (runnable from any cwd), pure helpers exported for
// direct unit assertion, a CLI entry point that exits non-zero with a
// readable, actionable report.
//
// No dependencies -- Node built-ins only.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The three deployable images, in the fixed order the guard always reports them. */
const DOCKERFILE_LABELS = ["api", "worker", "web"];

/**
 * One documented table, fail-loud default (T-14-14-... same class as
 * lint-pg-pool-factory's FACTORY_FILE allow-list: a single source of
 * truth, never re-derived per call site). Extend this table -- never
 * guess -- when a Dockerfile's base-image major changes; determine a new
 * major's bundled npm by running `npm --version` inside that image.
 */
const NODE_TO_NPM_MAJOR = {
  22: 10,
};

const FROM_NODE_PATTERN = /^FROM\s+node:([\w.-]+)/im;

/**
 * Extracts the base-image tag (e.g. "22-slim") from the FIRST `FROM
 * node:<tag>` line in a Dockerfile's source text. `label` is used only for
 * the error message when no such line exists -- a Dockerfile whose deps
 * stage does not pin a `node:` image at all cannot tell this guard
 * anything about which npm major to check under.
 */
export function parseNodeTagFromDockerfile(source, label) {
  const match = FROM_NODE_PATTERN.exec(source);
  if (!match) {
    throw new Error(
      `check-lockfile-npm10: no "FROM node:<tag>" line found in Dockerfile.${label} -- cannot resolve the npm major to check under.`,
    );
  }
  return match[1];
}

/**
 * Reads all three Dockerfiles under `${repoRoot}/docker/`, keyed by label
 * (api/worker/web). Throws if any is missing -- a silent "skip the file
 * that isn't there" would let this guard pass while checking fewer images
 * than production actually builds.
 */
export function readDockerfileSources(repoRoot) {
  const sources = {};
  for (const label of DOCKERFILE_LABELS) {
    const file = path.join(repoRoot, "docker", `Dockerfile.${label}`);
    if (!existsSync(file)) {
      throw new Error(
        `check-lockfile-npm10: missing ${path.relative(repoRoot, file)} -- cannot resolve the Node base-image pin without it.`,
      );
    }
    sources[label] = readFileSync(file, "utf8");
  }
  return sources;
}

/**
 * Given the three Dockerfile sources (keyed by label), asserts they all
 * pin the SAME `node:<tag>` base image and returns `{ tag, major }`.
 * Disagreement is refused outright -- a silent "pick the first one" is
 * the exact failure mode this guard exists to prevent, since it would
 * make the guard check an npm major that at least one of the three real
 * images does not build with.
 */
export function resolveNodeMajorFromDockerfiles(sourcesByLabel) {
  const tags = {};
  for (const label of DOCKERFILE_LABELS) {
    if (!(label in sourcesByLabel)) {
      throw new Error(`check-lockfile-npm10: no Dockerfile source supplied for "${label}".`);
    }
    tags[label] = parseNodeTagFromDockerfile(sourcesByLabel[label], label);
  }

  const referenceLabel = DOCKERFILE_LABELS[0];
  const referenceTag = tags[referenceLabel];
  const mismatches = DOCKERFILE_LABELS.filter((label) => tags[label] !== referenceTag);

  if (mismatches.length > 0) {
    const summary = DOCKERFILE_LABELS.map((label) => `${label}=node:${tags[label]}`).join(", ");
    throw new Error(
      `check-lockfile-npm10: Dockerfile base-image tags disagree (${summary}) -- refusing to guess which npm major to check under. Re-align docker/Dockerfile.{api,worker,web} on a single node:<tag> pin before this guard can run.`,
    );
  }

  const majorMatch = /^(\d+)/.exec(referenceTag);
  if (!majorMatch) {
    throw new Error(
      `check-lockfile-npm10: could not parse a numeric Node major out of tag "${referenceTag}".`,
    );
  }

  return { tag: referenceTag, major: Number(majorMatch[1]) };
}

/**
 * Node major -> the npm major that version of the official `node:<major>-slim`
 * image bundles. Throws an instructive error for an unmapped major rather
 * than guessing -- the reader is told exactly how to determine the right
 * value (run `npm --version` inside that image) instead of being left to
 * assume the guard silently degrades to "no check".
 */
export function resolveNpmMajorForNode(nodeMajor) {
  if (nodeMajor in NODE_TO_NPM_MAJOR) {
    return NODE_TO_NPM_MAJOR[nodeMajor];
  }
  throw new Error(
    `check-lockfile-npm10: no known npm major for Node ${nodeMajor} -- this guard's NODE_TO_NPM_MAJOR table only maps ${Object.keys(NODE_TO_NPM_MAJOR).join(", ")}. Determine Node ${nodeMajor}'s bundled npm major by running \`npm --version\` inside a \`node:${nodeMajor}-slim\` container, then add it to NODE_TO_NPM_MAJOR before this guard can check that major.`,
  );
}

function parseArgs(argv) {
  const args = { repoRoot: REPO_ROOT, npmCommand: null, plan: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo-root") {
      const value = argv[++i];
      if (!value) throw new Error("check-lockfile-npm10: --repo-root requires a value");
      args.repoRoot = path.resolve(value);
    } else if (arg === "--npm-command") {
      const value = argv[++i];
      if (!value) throw new Error("check-lockfile-npm10: --npm-command requires a value");
      args.npmCommand = value;
    } else if (arg === "--plan") {
      args.plan = true;
    } else {
      throw new Error(`check-lockfile-npm10: unrecognized argument "${arg}"`);
    }
  }
  return args;
}

/** Runs `cmd args...` and always returns `{ exitCode, output }` instead of throwing. */
function runCapture(cmd, cmdArgs, options) {
  try {
    const stdout = execFileSync(cmd, cmdArgs, { encoding: "utf8", ...options });
    return { exitCode: 0, output: stdout };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}${err.status == null ? String(err.message ?? err) : ""}`,
    };
  }
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let resolved;
  try {
    const sources = readDockerfileSources(args.repoRoot);
    resolved = resolveNodeMajorFromDockerfiles(sources);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  let npmMajor;
  try {
    npmMajor = resolveNpmMajorForNode(resolved.major);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  if (args.plan) {
    console.log(
      `check-lockfile-npm10 (plan mode): docker/Dockerfile.{api,worker,web} agree on node:${resolved.tag} -> npm major ${npmMajor}. No npm invoked.`,
    );
    process.exit(0);
    return;
  }

  const npmCommandParts = args.npmCommand
    ? args.npmCommand.split(/\s+/).filter(Boolean)
    : ["npx", "--yes", `npm@${npmMajor}`];
  const [npmCmd, ...npmBaseArgs] = npmCommandParts;
  const commandLabel = npmCommandParts.join(" ");

  const versionResult = runCapture(npmCmd, [...npmBaseArgs, "--version"], { cwd: args.repoRoot });
  const resolvedNpmVersion = versionResult.exitCode === 0 ? versionResult.output.trim() : "unresolved";
  console.log(`check-lockfile-npm10: running \`${commandLabel} ci --dry-run\` under npm ${resolvedNpmVersion} (node:${resolved.tag} pin).`);

  const ciResult = runCapture(npmCmd, [...npmBaseArgs, "ci", "--dry-run"], { cwd: args.repoRoot });

  if (ciResult.exitCode !== 0) {
    console.error(
      [
        `check-lockfile-npm10 FAILED: \`${commandLabel} ci --dry-run\` exited ${ciResult.exitCode} under npm ${resolvedNpmVersion} (node:${resolved.tag} pin).`,
        "",
        ciResult.output.trim(),
        "",
        "Remediation -- regenerate the lockfile under this npm major and commit the additive-only result:",
        "",
        `  npx --yes npm@${npmMajor} install --package-lock-only --ignore-scripts`,
      ].join("\n"),
    );
    process.exit(ciResult.exitCode || 1);
    return;
  }

  console.log(
    `check-lockfile-npm10 -- npm ${resolvedNpmVersion} accepts package-lock.json under docker/Dockerfile.{api,worker,web}'s node:${resolved.tag} pin.`,
  );
}

if (isDirectInvocation()) {
  main();
}
