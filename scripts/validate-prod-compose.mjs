#!/usr/bin/env node
// Phase 14 plan 08 (OPS-01, OPS-02, DB-13, D-09, Pitfall 19, Pitfall 7).
// Asserts every production compose invariant that has NO local feedback
// loop -- memory limits, OOM protection, connection headroom, published
// ports, immutable tags, and the derived worker stop-grace-period -- rather
// than leaving them to a human reviewing YAML.
//
// Resolves docker/docker-compose.prod.yml two ways, planner's choice
// documented here: shells out to `docker compose ... config --format json`
// when the `docker compose` subcommand is actually available (giving the
// REAL resolved config, including registry-normalized image references and
// byte-normalized memory limits), and otherwise falls back to a hand-rolled
// substitution + line-based structural parse of the YAML text itself --
// Node built-ins only, no `yaml` package dependency (this repo's `yaml` is
// only ever a transitive devDependency of tooling like eslint/vitest, never
// a declared first-party dependency; depending on it here would be relying
// on a package that could vanish from the tree without this script's own
// package.json ever recording the dependency). The fallback is not a
// generic YAML parser -- it understands exactly the shapes THIS repo's own
// docker-compose.prod.yml uses (2-space indentation, block-style lists,
// mapping-style `environment:`, `#`-comments preceded by whitespace or at
// line start, never `#` inside a quoted value) because this script and that
// compose file are maintained together, in the same class as
// scripts/lint-session-state.mjs and scripts/lint-pg-pool-factory.mjs
// hand-rolling their own scoped parsers rather than adding a dependency.
//
// This IS the Docker-less path this repo's own sandbox needs: confirmed
// directly (`docker compose` -- "unknown command", no daemon socket) that
// this environment has no `docker compose` subcommand at all, so the
// fallback path is what every local/CI run of this gate actually exercises
// here, not a theoretical branch.
//
// The stop-grace-period drift check is the strictest invariant this script
// asserts (Pitfall 7's entire reason for existing) -- it spawns
// `node scripts/print-stop-grace-period.mjs` fresh on every run and fails on
// ANY mismatch with the compose file's resolved value, rather than pinning a
// remembered number.
//
// No dependencies -- Node built-ins only.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Plan 14-03's PG_POOL_SIZES summed total (one instance each of apps/api +
 * apps/worker) -- see 14-03-SUMMARY.md. `max_connections` must exceed this,
 * never merely equal it -- D-09's PgBouncer deferral was justified on
 * headroom above this number being a configured fact. */
export const POOL_SUM_FLOOR = 84;

/** Every service this compose file must declare, in the order the plan
 * introduces them. Phase 15 plan 17 (OPS-10) added `alloy` -- the Grafana
 * Alloy log-shipping sidecar; see docker/alloy/config.alloy. */
export const EXPECTED_SERVICES = ["db", "redis", "api", "worker", "web", "migrate", "pgbackrest", "alloy"];

/** WR-04: every service other than `db` must never carry a negative
 * oom_score_adj -- `db` alone is favored to survive an OOM event. Explicit
 * set (not an `if/else if` chain) so a future service added to
 * `EXPECTED_SERVICES` is covered by construction. */
const NEVER_NEGATIVE_OOM_SERVICES = new Set(EXPECTED_SERVICES.filter((name) => name !== "db"));

/** The one service permitted to publish a port to the host (T-14-43). */
const PORT_PUBLISHING_SERVICE = "web";

/** Plan 14-10 (DB-09): the named volume `db` and `pgbackrest` must BOTH
 * reference -- the sidecar's whole reason to exist is read access to this
 * exact volume (T-14-62's "read access to the cluster directory"). */
const DB_DATA_VOLUME_NAME = "mega_crm_db_data_prod";

/** The on-disk pgBackRest configuration file -- grep-asserted (like
 * `checkTlsEntrypointServesSsl` below) to contain no literal credential
 * value, mirroring this plan's own acceptance-criteria command exactly. */
const PGBACKREST_CONFIG_REL = path.join("docker", "pgbackrest", "pgbackrest.conf");

/** Services whose `image:` must resolve to an immutable (non-mutable) tag --
 * built by THIS repo's own CI (.github/workflows/images.yml), unlike
 * `db`/`redis`'s official base images, whose floating minor-version tags
 * (`postgres:17`, `redis:7`) are a pre-existing, deliberate project decision
 * unrelated to OPS-01/OPS-02's "no unreviewed local tree" concern.
 *
 * Phase 15 plan 17 (OPS-10) adds `alloy`: unlike `db`/`redis`, this
 * service's own must_haves truth requires "an explicitly pinned image tag
 * rather than a mutable one" as a first-class, gate-enforced invariant
 * (not merely authored correctly once) -- so it joins this set even though
 * it is a third-party vendor image, not a repo-built one. */
const FIRST_PARTY_IMAGE_SERVICES = new Set(["api", "worker", "web", "migrate", "alloy"]);

const MUTABLE_TAG_NAMES = new Set(["latest", "main", "master", "develop", "dev", "staging", ""]);

/** The on-disk TLS entrypoint script the `db` service execs -- read
 * directly rather than resolved through the compose volume mapping, since
 * this repo has exactly one such script and hard-coding its path is simpler
 * and no less correct than a generic bind-mount resolver would be. */
const DB_TLS_ENTRYPOINT_REL = path.join("docker", "postgres", "prod-tls-entrypoint.sh");

// ---------------------------------------------------------------------------
// Env-file parsing -- mirrors scripts/check-env.mjs's own line parser.
// ---------------------------------------------------------------------------

/** Parses a flat `KEY=value` env file (comments/blank lines skipped) into a plain object. */
export function parseEnvFile(raw) {
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    values[key] = value;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Docker Compose `${VAR}` / `${VAR:-default}` interpolation -- applied to
// the RAW compose text before any structural parsing, exactly mirroring
// what `docker compose config` itself does at the text-interpolation layer.
// ---------------------------------------------------------------------------

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-(.*?))?\}/g;

/** Substitutes every `${VAR}`/`${VAR:-default}` reference in `text` against `env`.
 * An unset variable with no default resolves to an empty string -- the same
 * "unset -> blank, with a warning" behavior `docker compose config` itself has. */
export function substituteVars(text, env) {
  return text.replace(VAR_PATTERN, (match, name, hasDefault, def) => {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
    if (hasDefault !== undefined) return def;
    return "";
  });
}

// ---------------------------------------------------------------------------
// YAML-subset structural parse (fallback path) -- scoped to this repo's own
// docker-compose.prod.yml shape, not a general-purpose parser.
// ---------------------------------------------------------------------------

/** Strips a full-line or trailing `#` comment. Only recognizes `#` preceded
 * by whitespace or at line start -- this repo's compose file never embeds a
 * literal `#` inside a quoted value, so this simple heuristic is sufficient. */
export function stripYamlComment(line) {
  if (/^\s*#/.test(line)) return "";
  const idx = line.search(/\s#/);
  return idx === -1 ? line : line.slice(0, idx);
}

function indentOf(line) {
  return line.match(/^ */)[0].length;
}

/** The `services:` block's body lines (everything indented under the
 * top-level `services:` key, stopping at the next top-level key or EOF). */
export function extractServicesBlockLines(lines) {
  const start = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (start === -1) throw new Error("no top-level 'services:' key found");
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      body.push(line);
      continue;
    }
    if (indentOf(line) === 0) break;
    body.push(line);
  }
  return body;
}

/** Splits the services block into `{ [serviceName]: bodyLines[] }`, one entry per 2-space-indented service key. */
export function splitServiceBlocks(bodyLines) {
  const services = {};
  let current = null;
  for (const line of bodyLines) {
    if (line.trim() === "") continue;
    if (indentOf(line) === 2) {
      const m = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
      if (m) {
        current = m[1];
        services[current] = [];
        continue;
      }
    }
    if (current) services[current].push(line);
  }
  return services;
}

/** A single scalar field at the given indent under a service body (default indent 4 -- one level below the service key). */
export function findScalarField(lines, key, indent = 4) {
  const re = new RegExp(`^ {${indent}}${key}:\\s*(.+?)\\s*$`);
  for (const line of lines) {
    const m = line.match(re);
    if (m) return m[1];
  }
  return undefined;
}

/** Parses an inline `["a", "b"]`-style array, or a single bare/quoted scalar, into a string array. */
export function parseInlineStringArray(raw) {
  if (!raw) return [];
  const m = raw.match(/^\[(.*)\]$/);
  if (!m) return [raw.replace(/^["']|["']$/g, "")];
  if (m[1].trim() === "") return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
}

/** The `environment:` mapping (indent+2 `KEY: value` lines) under a service body. Mapping style only -- this repo never uses list-style `environment:`. */
export function findEnvironmentMap(lines, indent = 4) {
  const idx = lines.findIndex((l) => new RegExp(`^ {${indent}}environment:\\s*$`).test(l));
  if (idx === -1) return {};
  const map = {};
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (indentOf(line) <= indent) break;
    const m = line.match(new RegExp(`^ {${indent + 2}}([A-Za-z0-9_]+):\\s*(.*)$`));
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

/** The `ports:` block-list values under a service body, or `null` if the key is absent entirely. */
export function findPortsList(lines, indent = 4) {
  const idx = lines.findIndex((l) => new RegExp(`^ {${indent}}ports:\\s*$`).test(l));
  if (idx === -1) return null;
  const items = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (indentOf(line) <= indent) break;
    const m = line.match(new RegExp(`^ {${indent + 2}}-\\s*(.+?)\\s*$`));
    if (m) items.push(m[1].replace(/^["']|["']$/g, ""));
  }
  return items;
}

/** Plan 14-10 (DB-09): the `volumes:` block-list under a service body,
 * reduced to just each entry's SOURCE (the named volume, or bind-mount
 * path, before the first unescaped `:`) -- this repo's compose file only
 * ever uses the short `source:target[:mode]` string form, never the
 * long-form mapping, so that is all this extracts. Used to assert
 * `pgbackrest` actually shares `db`'s own data volume rather than a
 * differently-named one. */
export function findVolumeSources(lines, indent = 4) {
  const idx = lines.findIndex((l) => new RegExp(`^ {${indent}}volumes:\\s*$`).test(l));
  if (idx === -1) return [];
  const sources = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (indentOf(line) <= indent) break;
    const m = line.match(new RegExp(`^ {${indent + 2}}-\\s*(.+?)\\s*$`));
    if (!m) continue;
    const raw = m[1].replace(/^["']|["']$/g, "");
    sources.push(raw.split(":")[0]);
  }
  return sources;
}

export function findVolumeEntries(lines, indent = 4) {
  const idx = lines.findIndex((l) => new RegExp(`^ {${indent}}volumes:\\s*$`).test(l));
  if (idx === -1) return [];
  const entries = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (indentOf(line) <= indent) break;
    const m = line.match(new RegExp(`^ {${indent + 2}}-\\s*(.+?)\\s*$`));
    if (!m) continue;
    const parts = m[1].replace(/^["']|["']$/g, "").split(":");
    entries.push({ source: parts[0], target: parts[1], readOnly: parts[2] === "ro" });
  }
  return entries;
}

export function findBlockList(lines, key, indent = 4) {
  const inline = findScalarField(lines, key, indent);
  if (inline) return parseInlineStringArray(inline);
  const idx = lines.findIndex((l) => new RegExp(`^ {${indent}}${key}:\\s*$`).test(l));
  if (idx === -1) return [];
  const values = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (indentOf(line) <= indent) break;
    const m = line.match(new RegExp(`^ {${indent + 2}}-\\s*(.+?)\\s*$`));
    if (m) values.push(m[1].replace(/^["']|["']$/g, ""));
  }
  return values;
}

/**
 * Builds the normalized model `{ services: { [name]: {...} } }` from the raw
 * compose text + a resolved env map, entirely via text substitution and the
 * structural helpers above -- no `docker compose` invocation.
 */
export function resolveViaYamlFallback(composeText, envMap) {
  const substituted = substituteVars(composeText, envMap);
  const lines = substituted.split("\n").map(stripYamlComment);
  const blocks = splitServiceBlocks(extractServicesBlockLines(lines));

  const services = {};
  for (const [name, svcLines] of Object.entries(blocks)) {
    services[name] = {
      image: findScalarField(svcLines, "image"),
      memLimit: findScalarField(svcLines, "mem_limit"),
      oomScoreAdj: findScalarField(svcLines, "oom_score_adj"),
      stopGracePeriod: findScalarField(svcLines, "stop_grace_period"),
      profiles: parseInlineStringArray(findScalarField(svcLines, "profiles")),
      ports: findPortsList(svcLines),
      environment: findEnvironmentMap(svcLines),
      volumeSources: findVolumeSources(svcLines),
      volumeEntries: findVolumeEntries(svcLines),
      groupAdd: findBlockList(svcLines, "group_add"),
    };
  }
  return { services, source: "yaml-fallback" };
}

// ---------------------------------------------------------------------------
// `docker compose config` path -- exercised only when the subcommand is
// actually available; kept behind a capability probe so it degrades to the
// YAML fallback rather than crashing when absent. Plan 14-08 authored this
// gate with NO real `docker compose` binary available in its own sandbox
// (confirmed then: no daemon, no `compose` subcommand at all) -- plan 14-10
// installed one locally (Homebrew's standalone `docker-compose` v5.4.0,
// auto-discovered by the `docker` CLI as its own `compose` subcommand) and
// found this path had never actually been exercised end-to-end anywhere in
// this project before now, surfacing the `resolveViaDockerCompose` bug
// documented on that function.
// ---------------------------------------------------------------------------

export function isDockerComposeAvailable() {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Resolves via a real `docker compose ... config --format json` call. Throws on any compose error (a genuine config problem, never silently swallowed into the fallback path).
 *
 * Plan 14-10 (Rule 1 bug, found via direct empirical testing once a real
 * `docker compose` binary was available for the first time across this
 * project's compose-file plans): `docker compose config` EXCLUDES any
 * service carrying a `profiles:` entry (this file's own `migrate`, added by
 * plan 14-08) from its resolved output UNLESS that profile is explicitly
 * activated -- confirmed directly (`docker compose ... config --services`
 * lists 6 services without `COMPOSE_PROFILES` set, 7 with
 * `COMPOSE_PROFILES=manual` or `COMPOSE_PROFILES=*`). Without this,
 * `evaluateInvariants`'s `missing-service` check would report `migrate` as
 * absent on ANY machine/CI runner that actually has `docker compose`
 * installed (this sandbox previously always used the YAML-fallback path
 * below, which never had this gap, masking the bug entirely -- see
 * `isDockerComposeAvailable`'s own comment). `COMPOSE_PROFILES=*` is
 * Compose's own documented wildcard for "activate every profile a service
 * declares" -- future-proof against a later plan adding a differently-named
 * profile, unlike hardcoding `manual`. */
export function resolveViaDockerCompose(composeFile, envFile) {
  const output = execFileSync(
    "docker",
    ["compose", "-f", composeFile, "--env-file", envFile, "config", "--format", "json"],
    { encoding: "utf8", env: { ...process.env, COMPOSE_PROFILES: "*" } },
  );
  const parsed = JSON.parse(output);
  const services = {};
  for (const [name, svc] of Object.entries(parsed.services ?? {})) {
    services[name] = {
      image: svc.image,
      memLimit: svc.mem_limit,
      oomScoreAdj: svc.oom_score_adj,
      stopGracePeriod: svc.stop_grace_period,
      profiles: svc.profiles ?? [],
      ports: svc.ports ? svc.ports.map((p) => `${p.published ?? ""}:${p.target ?? ""}`) : null,
      environment: svc.environment ?? {},
      volumeSources: (svc.volumes ?? []).map((v) => v.source),
      volumeEntries: (svc.volumes ?? []).map((v) => ({ source: v.source, target: v.target, readOnly: Boolean(v.read_only) })),
      groupAdd: (svc.group_add ?? []).map(String),
    };
  }
  return { services, source: "docker-compose" };
}

// ---------------------------------------------------------------------------
// Value normalization -- shared by both resolution paths.
// ---------------------------------------------------------------------------

/** Parses a docker-compose memory value ("2048m", "768m", "1g", or an
 * already-numeric byte count from `docker compose config`'s JSON) to bytes. */
export function parseMemLimitToBytes(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return value;
  const m = String(value)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([kKmMgG]?)b?$/);
  if (!m) return undefined;
  const num = Number.parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === "g" ? 1024 ** 3 : unit === "m" ? 1024 ** 2 : unit === "k" ? 1024 : 1;
  return Math.round(num * mult);
}

/** Parses a duration value to a plain number of seconds. Accepts a bare
 * number ("60"), the raw compose-YAML shape this repo writes ("60s"), and a
 * Go-style `time.Duration.String()` value.
 *
 * Plan 14-10 (Rule 1 bug, found via direct empirical testing once a real
 * `docker compose` binary was available): `docker compose config --format
 * json` does NOT echo `stop_grace_period` back as "<n>s" -- it normalizes
 * to Go's own duration format ("1m0s" for 60 seconds, "1m30s" for 90,
 * "2m5s" for 125s -- confirmed directly against this repo's own compose
 * file at several WORKER_STOP_GRACE_PERIOD_SECONDS values). The original
 * `/^(\d+(?:\.\d+)?)s$/`-only regex silently returned `undefined` for every
 * one of those, which made the stop-grace-period-drift check fail on ANY
 * machine with a real `docker compose` (this project's own YAML-fallback
 * path never normalizes the text this way, which is why this had never
 * been exercised before this plan installed one locally for the first
 * time). */
export function parseDurationToSeconds(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return value;
  const s = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number.parseFloat(s);
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (m && (m[1] !== undefined || m[2] !== undefined || m[3] !== undefined)) {
    const hours = m[1] !== undefined ? Number.parseInt(m[1], 10) : 0;
    const minutes = m[2] !== undefined ? Number.parseInt(m[2], 10) : 0;
    const seconds = m[3] !== undefined ? Number.parseFloat(m[3]) : 0;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return undefined;
}

/** Extracts the tag portion of an image reference (text after the last `:` following the last `/`). Returns `""` for an implicit (tagless) reference. */
export function extractImageTag(imageRef) {
  if (!imageRef) return undefined;
  const lastSlash = imageRef.lastIndexOf("/");
  const afterSlash = lastSlash === -1 ? imageRef : imageRef.slice(lastSlash + 1);
  const colonIdx = afterSlash.lastIndexOf(":");
  return colonIdx === -1 ? "" : afterSlash.slice(colonIdx + 1);
}

export function isMutableTag(tag) {
  return MUTABLE_TAG_NAMES.has((tag ?? "").toLowerCase());
}

/** Runs `node scripts/print-stop-grace-period.mjs` fresh and returns its printed integer, or throws with the script's own stderr (e.g. "run npm run build -w apps/worker first"). */
export function readExpectedStopGracePeriodSeconds(baseDir) {
  const scriptPath = path.join(baseDir, "scripts", "print-stop-grace-period.mjs");
  const stdout = execFileSync(process.execPath, [scriptPath], { cwd: baseDir, encoding: "utf8" });
  const n = Number(stdout.trim());
  if (Number.isNaN(n)) {
    throw new Error(`print-stop-grace-period.mjs printed a non-numeric value: ${JSON.stringify(stdout)}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// The pure evaluator -- one shared function for both resolution paths and
// for every fixture-driven test.
// ---------------------------------------------------------------------------

/**
 * @param {{services: Record<string, object>}} model
 * @param {{poolSumFloor: number, expectedStopGraceSeconds: number | undefined}} opts
 * @returns {{violations: Array<{rule: string, service?: string, detail: string}>, checkedCount: number}}
 */
export function evaluateInvariants(model, opts) {
  const violations = [];
  let checkedCount = 0;
  const check = (ok, rule, service, detail) => {
    checkedCount++;
    if (!ok) violations.push({ rule, service, detail });
  };

  const services = model.services ?? {};
  const serviceNames = Object.keys(services);

  for (const expected of EXPECTED_SERVICES) {
    check(
      serviceNames.includes(expected),
      "missing-service",
      expected,
      `docker-compose.prod.yml declares no "${expected}" service`,
    );
  }

  for (const [name, svc] of Object.entries(services)) {
    // 1. Every service has an explicit memory limit (Pitfall 19).
    const memBytes = parseMemLimitToBytes(svc.memLimit);
    check(
      memBytes !== undefined && memBytes > 0,
      "missing-mem-limit",
      name,
      `service "${name}" has no mem_limit (or it did not resolve to a positive byte value) -- Pitfall 19 requires an explicit memory limit on every service`,
    );

    // 2. db's oom_score_adj is negative; every OTHER service's is not
    // (Pitfall 19). WR-04: this used to be an `if (db) / else if (api ||
    // worker)` pair with no `else` branch at all, so `web`, `redis`,
    // `migrate`, and `pgbackrest` were entirely uncovered -- notably
    // `pgbackrest`, whose own compose comment explicitly states it "must
    // never win an OOM contest against the database it protects" and must
    // get the SAME non-negative treatment as api/worker, never db's
    // protective -500 (T-14-65). Enumerate the never-negative set
    // explicitly so a future service is covered by construction, not by
    // remembering to extend an `else if` chain.
    const oom = svc.oomScoreAdj === undefined ? undefined : Number(svc.oomScoreAdj);
    if (name === "db") {
      check(
        oom !== undefined && !Number.isNaN(oom) && oom < 0,
        "db-oom-score-adj-not-negative",
        name,
        `db's oom_score_adj must be a negative number (favoring Postgres's survival) -- resolved to ${JSON.stringify(svc.oomScoreAdj)}`,
      );
    } else if (NEVER_NEGATIVE_OOM_SERVICES.has(name)) {
      check(
        oom === undefined || Number.isNaN(oom) || oom >= 0,
        "non-db-oom-score-adj-negative",
        name,
        `"${name}" must not carry a negative oom_score_adj -- only db is favored to survive an OOM event (resolved to ${JSON.stringify(svc.oomScoreAdj)})`,
      );
    }

    // 3. Only `web` publishes a port (T-14-43).
    const hasPorts = Array.isArray(svc.ports) && svc.ports.length > 0;
    if (name === PORT_PUBLISHING_SERVICE) {
      check(hasPorts, "web-missing-ports", name, `"${PORT_PUBLISHING_SERVICE}" must publish at least one port`);
    } else {
      check(
        !hasPorts,
        "non-web-service-publishes-port",
        name,
        `service "${name}" publishes a port -- only "${PORT_PUBLISHING_SERVICE}" may (T-14-43)`,
      );
    }

    // 4. First-party images never carry a mutable tag (T-14-49).
    if (FIRST_PARTY_IMAGE_SERVICES.has(name)) {
      const tag = extractImageTag(svc.image);
      check(
        tag !== undefined && !isMutableTag(tag),
        "mutable-image-tag",
        name,
        `service "${name}"'s image resolves to a mutable or missing tag (${JSON.stringify(svc.image)}) -- production must reference an immutable SHA tag`,
      );
    }
  }

  // 5. Worker's stop_grace_period matches the published constant exactly (Pitfall 7).
  const worker = services.worker;
  if (worker) {
    const resolvedSeconds = parseDurationToSeconds(worker.stopGracePeriod);
    check(
      opts.expectedStopGraceSeconds !== undefined &&
        resolvedSeconds !== undefined &&
        resolvedSeconds === opts.expectedStopGraceSeconds,
      "stop-grace-period-drift",
      "worker",
      `worker's stop_grace_period resolves to ${JSON.stringify(worker.stopGracePeriod)} (${resolvedSeconds}s) but ` +
        `node scripts/print-stop-grace-period.mjs currently prints ${opts.expectedStopGraceSeconds}s -- these must match exactly`,
    );
  }

  // 6. Postgres max_connections exceeds the documented pool-sum floor (D-09).
  const db = services.db;
  if (db) {
    const maxConn = Number(db.environment?.PG_MAX_CONNECTIONS);
    check(
      !Number.isNaN(maxConn) && maxConn > opts.poolSumFloor,
      "max-connections-at-or-below-floor",
      "db",
      `db's PG_MAX_CONNECTIONS resolves to ${JSON.stringify(db.environment?.PG_MAX_CONNECTIONS)}, which must exceed ` +
        `${opts.poolSumFloor} (plan 14-03's PG_POOL_SIZES summed total)`,
    );
  }

  // 7. The migrate service is excluded from a plain `up` (RESEARCH.md Pitfall C / T-14-48).
  const migrate = services.migrate;
  if (migrate) {
    check(
      Array.isArray(migrate.profiles) && migrate.profiles.length > 0,
      "migrate-not-profile-excluded",
      "migrate",
      `migrate has no "profiles" entry -- a plain "docker compose up" would start it as a long-lived container`,
    );
  }

  // 8. Plan 14-10 (DB-09, T-14-62): the pgbackrest sidecar actually shares
  // db's own data volume -- the whole reason for its being a sidecar rather
  // than a standalone backup client is read access to the same cluster
  // directory `db` writes.
  const pgbackrest = services.pgbackrest;
  if (pgbackrest) {
    check(
      Array.isArray(pgbackrest.volumeSources) && pgbackrest.volumeSources.includes(DB_DATA_VOLUME_NAME),
      "pgbackrest-missing-shared-data-volume",
      "pgbackrest",
      `pgbackrest does not mount the "${DB_DATA_VOLUME_NAME}" volume db itself uses -- it would have no access to the cluster directory it exists to back up`,
    );
  }

  // File-backed KEK isolation: only api/worker get the exact read-only bind
  // and supplemental numeric group. Every other service must get neither.
  const kekSource = "/etc/mega-crm/kek";
  const kekTarget = "/run/secrets/mega-crm-kek";
  for (const [name, svc] of Object.entries(services)) {
    const entries = Array.isArray(svc.volumeEntries) ? svc.volumeEntries : [];
    const exact = entries.filter((v) => v.source === kekSource && v.target === kekTarget && v.readOnly);
    const anyKek = entries.filter((v) => v.source === kekSource || v.target === kekTarget);
    const groups = Array.isArray(svc.groupAdd) ? svc.groupAdd.map(String) : [];
    if (name === "api" || name === "worker") {
      check(exact.length === 1 && anyKek.length === 1, "kek-mount-invalid", name,
        `${name} must mount ${kekSource}:${kekTarget}:ro exactly once`);
      check(groups.length === 1 && groups[0] === "1999", "kek-group-invalid", name,
        `${name} must receive only supplemental group 1999 for the KEK mount`);
    } else {
      check(anyKek.length === 0, "kek-mount-leaked", name, `${name} must not receive the KEK mount`);
      check(!groups.includes("1999"), "kek-group-leaked", name, `${name} must not receive KEK group 1999`);
    }
  }

  return { violations, checkedCount };
}

/** Bonus invariant (Rule 2 -- not in the plan's own <behavior> list, but the
 * same class of "no local feedback loop" gap the plan's own <done>
 * criterion asks this script to close): the db service's on-disk TLS
 * entrypoint script actually sets `ssl=on` (DB-13's server half). Checked
 * directly against the file on disk, independent of either resolution path. */
export function checkTlsEntrypointServesSsl(baseDir) {
  const scriptPath = path.join(baseDir, DB_TLS_ENTRYPOINT_REL);
  if (!existsSync(scriptPath)) {
    return { ok: false, detail: `${DB_TLS_ENTRYPOINT_REL} does not exist` };
  }
  const content = readFileSync(scriptPath, "utf8");
  const ok = /ssl\s*=\s*on/.test(content);
  return { ok, detail: ok ? undefined : `${DB_TLS_ENTRYPOINT_REL} does not set ssl=on` };
}

/** Plan 14-10 (DB-09, T-14-61): the on-disk pgBackRest configuration file
 * carries no literal credential value -- every secret/endpoint is read from
 * the environment via pgBackRest's own `PGBACKREST_<OPTION>` override
 * convention (docker/pgbackrest/pgbackrest.conf's own header). Same regex
 * as this plan's own acceptance criteria (`grep -v '^\s*#' ... | grep -riE
 * "(secret|key|pass)[[:space:]]*=[[:space:]]*[^$[:space:]]"`), applied to
 * every non-comment line directly, so this is the SAME assertion machine-
 * checked on every CI run, not just at authoring time. */
export function checkPgbackrestConfigHasNoCredential(baseDir) {
  const configPath = path.join(baseDir, PGBACKREST_CONFIG_REL);
  if (!existsSync(configPath)) {
    return { ok: false, detail: `${PGBACKREST_CONFIG_REL} does not exist` };
  }
  const credentialLinePattern = /(secret|key|pass)\s*=\s*[^\s$]/i;
  const offendingLine = readFileSync(configPath, "utf8")
    .split(/\r?\n/)
    .find((line) => !/^\s*#/.test(line) && credentialLinePattern.test(line));
  return {
    ok: offendingLine === undefined,
    detail: offendingLine === undefined ? undefined : `${PGBACKREST_CONFIG_REL} appears to contain a literal credential value: ${JSON.stringify(offendingLine.trim())}`,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Runs the full gate: resolves the compose file (docker-compose path when
 * available, else the YAML fallback), evaluates every invariant, and adds
 * the TLS-entrypoint bonus check. Returns `{ violations, checkedCount, usedDocker }`.
 */
export function runValidation({
  baseDir = process.cwd(),
  composeFileRel = path.join("docker", "docker-compose.prod.yml"),
  envFileRel = path.join("docker", "prod.env.example"),
} = {}) {
  const composeFile = path.join(baseDir, composeFileRel);
  const envFile = path.join(baseDir, envFileRel);

  const usedDocker = isDockerComposeAvailable();
  let model;
  if (usedDocker) {
    model = resolveViaDockerCompose(composeFile, envFile);
  } else {
    const composeText = readFileSync(composeFile, "utf8");
    const envMap = parseEnvFile(readFileSync(envFile, "utf8"));
    model = resolveViaYamlFallback(composeText, envMap);
  }

  let expectedStopGraceSeconds;
  const preflightViolations = [];
  try {
    expectedStopGraceSeconds = readExpectedStopGracePeriodSeconds(baseDir);
  } catch (err) {
    preflightViolations.push({
      rule: "stop-grace-period-undeterminable",
      service: "worker",
      detail: `could not determine the expected stop-grace-period: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const { violations, checkedCount } = evaluateInvariants(model, {
    poolSumFloor: POOL_SUM_FLOOR,
    expectedStopGraceSeconds,
  });

  const tls = checkTlsEntrypointServesSsl(baseDir);
  const pgbackrestConfig = checkPgbackrestConfigHasNoCredential(baseDir);
  const bonusCheckedCount = checkedCount + 2;
  const allViolations = [...preflightViolations, ...violations];
  if (!tls.ok) {
    allViolations.push({ rule: "db-tls-entrypoint-missing-ssl-on", service: "db", detail: tls.detail });
  }
  if (!pgbackrestConfig.ok) {
    allViolations.push({
      rule: "pgbackrest-config-contains-credential",
      service: "pgbackrest",
      detail: pgbackrestConfig.detail,
    });
  }

  return {
    violations: allViolations,
    checkedCount: bonusCheckedCount,
    servicesChecked: Object.keys(model.services ?? {}).length,
    usedDocker,
  };
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

  console.log(
    `verify:prod-compose -- resolved via ${result.usedDocker ? "docker compose config" : "YAML-parsing fallback (no Docker daemon available)"}`,
  );
  console.log(`${result.servicesChecked} service(s), ${result.checkedCount} invariant(s) checked.`);

  if (result.violations.length > 0) {
    for (const v of result.violations) {
      console.error(`  [${v.rule}]${v.service ? ` (${v.service})` : ""} ${v.detail}`);
    }
    console.error(`\n${result.violations.length} violation(s) found.`);
    process.exit(1);
  }

  console.log("verify:prod-compose -- all invariants OK.");
}
