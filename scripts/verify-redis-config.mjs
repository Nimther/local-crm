#!/usr/bin/env node
// GSD 08-04 (WRK-12): the Redis durability / eviction verifier.
//
// ONE verifier, invoked identically in every environment. REDIS_URL always
// comes from OUTSIDE, and there is deliberately no environment sniffing, no
// CI branch, and no default URL:
//
//   local -> a throwaway redis-server booted from docker/redis.conf on a free
//            port with a temporary data directory
//            (packages/test-support/src/harness/temp-redis.ts)
//   CI    -> the docker-compose `redis:7` container running that same
//            docker/redis.conf, bind-mounted read-only
//
// The single config file is what makes those two paths equivalent. A CI-only
// branch in here would mean the thing CI checks is not the thing a developer
// can run, which is the divergence WRK-12 exists to close.
//
// Asserting `maxmemory-policy` ALONE is vacuous: `noeviction` is already the
// Redis default and can never trigger while `maxmemory` is 0, so a policy-only
// check passes against a completely unconfigured server (RESEARCH Pitfall 5).
// All four directives are therefore asserted together.
//
// An unreachable Redis is a FAILURE, never a skip. A check that reports
// "skipped" makes WRK-12 look satisfied on a run where nobody verified it
// (SPEC R7 negative criterion).
//
// No dependencies -- Node built-ins only.

import net from "node:net";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 5_000;

/** The four directives read in a single CONFIG GET round trip. */
export const REQUIRED_DIRECTIVES = Object.freeze([
  "maxmemory",
  "maxmemory-policy",
  "appendonly",
  "appendfsync",
]);

/** Exact-match expectations. `maxmemory` is handled separately — it is a bound, not a literal. */
const EXPECTED_LITERALS = Object.freeze({
  "maxmemory-policy": "noeviction",
  appendonly: "yes",
  appendfsync: "everysec",
});

// ---------------------------------------------------------------------------
// Minimal RESP client
// ---------------------------------------------------------------------------

function encodeCommand(args) {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const value = String(arg);
    parts.push(`$${Buffer.byteLength(value, "utf8")}\r\n${value}\r\n`);
  }
  return Buffer.from(parts.join(""), "utf8");
}

/**
 * Parse one RESP reply starting at `offset`.
 * Returns `{ value, next }`, or `null` when the buffer holds an incomplete reply.
 */
function parseReply(buf, offset) {
  if (offset >= buf.length) return null;
  const lineEnd = buf.indexOf("\r\n", offset);
  if (lineEnd === -1) return null;

  const type = buf[offset];
  const line = buf.toString("utf8", offset + 1, lineEnd);
  const after = lineEnd + 2;

  // +simple string
  if (type === 0x2b) return { value: line, next: after };
  // -error
  if (type === 0x2d) return { value: new Error(line), next: after };
  // :integer
  if (type === 0x3a) return { value: Number(line), next: after };

  // $bulk string
  if (type === 0x24) {
    const len = Number(line);
    if (len === -1) return { value: null, next: after };
    if (buf.length < after + len + 2) return null;
    return { value: buf.toString("utf8", after, after + len), next: after + len + 2 };
  }

  // *array
  if (type === 0x2a) {
    const count = Number(line);
    if (count === -1) return { value: null, next: after };
    const items = [];
    let cursor = after;
    for (let i = 0; i < count; i += 1) {
      const item = parseReply(buf, cursor);
      if (!item) return null;
      items.push(item.value);
      cursor = item.next;
    }
    return { value: items, next: cursor };
  }

  return { value: null, next: after };
}

function sendCommand(host, port, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () =>
      finish(new Error(`timed out after ${timeoutMs}ms talking to ${host}:${port}`)),
    );
    socket.on("error", (err) =>
      finish(new Error(`${err.code ?? err.name}: ${err.message} (${host}:${port})`)),
    );
    socket.on("close", () =>
      finish(new Error(`connection to ${host}:${port} closed before a complete reply arrived`)),
    );
    socket.on("connect", () => socket.write(encodeCommand(args)));
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const parsed = parseReply(buf, 0);
      if (parsed) finish(null, parsed.value);
    });
  });
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Split a `redis://host:port[/db]` URL into a connect target. */
export function parseRedisUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`REDIS_URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol === "rediss:") {
    throw new Error("rediss:// (TLS) is not supported by this verifier");
  }
  if (url.protocol !== "redis:") {
    throw new Error(`unsupported scheme "${url.protocol}" in REDIS_URL — expected redis://`);
  }
  if (url.username || url.password) {
    // No environment this verifier runs against uses requirepass, and silently
    // dropping the credential would surface as a confusing NOAUTH error.
    throw new Error("REDIS_URL carries credentials, which this verifier does not support");
  }
  return { host: url.hostname || "127.0.0.1", port: Number(url.port) || 6379 };
}

/** Read the four directives from a live server. Throws when the server cannot be reached. */
export async function readRedisConfig(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { host, port } = parseRedisUrl(url);
  const reply = await sendCommand(host, port, ["CONFIG", "GET", ...REQUIRED_DIRECTIVES], timeoutMs);

  if (reply instanceof Error) throw new Error(`Redis replied with an error: ${reply.message}`);
  if (!Array.isArray(reply)) {
    throw new Error(`unexpected CONFIG GET reply shape: ${JSON.stringify(reply)}`);
  }

  const config = {};
  for (let i = 0; i + 1 < reply.length; i += 2) {
    config[String(reply[i])] = reply[i + 1] === null ? null : String(reply[i + 1]);
  }
  return config;
}

/**
 * Pure evaluator over an already-read config map.
 *
 * Kept separate from the I/O above so the discrimination logic — in particular
 * that a `noeviction` policy with `maxmemory` 0 does NOT pass — is assertable
 * without a live server.
 */
export function checkRedisConfig(config) {
  const failures = [];
  const observed = {};

  for (const directive of REQUIRED_DIRECTIVES) {
    observed[directive] = config?.[directive] ?? null;
  }

  const rawMaxmemory = observed.maxmemory;
  const maxmemory = Number(rawMaxmemory);
  if (rawMaxmemory === null || !Number.isFinite(maxmemory) || maxmemory <= 0) {
    failures.push({
      directive: "maxmemory",
      expected: "> 0 (a real ceiling; without one `noeviction` can never trigger)",
      observed: rawMaxmemory ?? "<absent>",
    });
  }

  for (const [directive, expected] of Object.entries(EXPECTED_LITERALS)) {
    const actual = observed[directive];
    if (actual !== expected) {
      failures.push({ directive, expected, observed: actual ?? "<absent>" });
    }
  }

  return { pass: failures.length === 0, failures, observed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${path.resolve(entry)}`;
}

function formatObserved(observed) {
  return REQUIRED_DIRECTIVES.map(
    (d) => `  ${d.padEnd(18)} = ${observed[d] ?? "<absent>"}`,
  ).join("\n");
}

if (isDirectInvocation()) {
  const url = process.env.REDIS_URL;

  if (!url) {
    console.error(
      [
        "verify:redis-config FAILED: REDIS_URL is unset.",
        "",
        "This verifier takes its target from the environment and has no default,",
        "so it can never silently check the wrong server. Point it at the Redis",
        "you actually mean to verify:",
        "",
        "  CI     REDIS_URL=redis://localhost:6379 npm run verify:redis-config",
        "  local  the vitest suite boots a throwaway redis-server from",
        "         docker/redis.conf and sets REDIS_URL itself — run",
        "         `npm run test -w packages/test-support`",
      ].join("\n"),
    );
    process.exit(1);
  }

  let config;
  try {
    config = await readRedisConfig(url);
  } catch (err) {
    console.error(
      [
        `verify:redis-config FAILED: could not read the configuration from ${url}.`,
        `  ${err instanceof Error ? err.message : String(err)}`,
        "",
        "An unreachable Redis is a FAILURE, not a skip — reporting this as",
        "skipped would make WRK-12 look satisfied on a run that verified nothing.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const result = checkRedisConfig(config);
  console.log(`verify:redis-config — ${url}\n${formatObserved(result.observed)}`);

  if (!result.pass) {
    console.error(
      [
        "",
        `verify:redis-config FAILED: ${result.failures.length} directive(s) wrong.`,
        ...result.failures.map(
          (f) => `  ${f.directive}: expected ${f.expected}, observed ${f.observed}`,
        ),
        "",
        "Redis must refuse writes at its ceiling rather than evict BullMQ job",
        "state, and must persist enqueued jobs across a restart. Fix",
        "docker/redis.conf — do not relax these assertions.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log("verify:redis-config — all four directives OK");
}
