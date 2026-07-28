import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 08-04 (WRK-12) — a throwaway redis-server for local verification.
 *
 * The developer machine runs a long-lived Redis on 6379 holding real state.
 * This harness never touches it: every instance it starts listens on a freshly
 * reserved port, keeps its AOF/RDB files in a temporary directory, and is torn
 * down with that directory removed. Nothing here reads REDIS_URL, and nothing
 * here connects to 6379.
 *
 * It exists so that `docker/redis.conf` — the file CI bind-mounts into the
 * `redis:7` container — is the same file a local run boots from. The verifier
 * (scripts/verify-redis-config.mjs) is then identical in both environments and
 * needs no CI branch; only the REDIS_URL handed to it differs.
 *
 * A missing `redis-server` binary is a hard error, never a skip: a run that
 * silently verifies nothing is exactly what SPEC R7's negative criterion
 * forbids.
 */

const READY_TIMEOUT_MS = 10_000;
const READY_POLL_INTERVAL_MS = 50;
const STOP_TIMEOUT_MS = 5_000;
const MAX_CAPTURED_OUTPUT = 8_000;

export interface TempRedis {
  /** `redis://127.0.0.1:<port>` — hand this to the verifier as REDIS_URL. */
  readonly url: string;
  readonly port: number;
  /** Temporary data directory; removed by `stop()`. */
  readonly dir: string;
  /** Whatever the server wrote to stdout/stderr, for diagnostics. */
  output(): string;
  /** Terminate the process and remove the data directory. Safe to call twice. */
  stop(): Promise<void>;
}

/** Instances that have not been stopped yet, so process exit cannot leak one. */
const live = new Set<{ child: ChildProcess }>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const handle of live) {
      try {
        handle.child.kill("SIGKILL");
      } catch {
        // Best effort — the process is already going away.
      }
    }
  });
}

function resolveRedisServerBinary(): string {
  const override = process.env.REDIS_SERVER_BIN;
  if (override) {
    if (existsSync(override)) return override;
    throw new Error(
      `REDIS_SERVER_BIN is set to "${override}" but no such file exists. ` +
        "Unset it to fall back to PATH lookup.",
    );
  }

  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "redis-server");
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    [
      "redis-server was not found on PATH, so the Redis configuration could not be verified.",
      "",
      "This is a FAILURE, not a skip: WRK-12 must never look satisfied on a run",
      "where nothing was checked.",
      "",
      "Install it (macOS: `brew install redis`, Debian/Ubuntu: `apt install redis-server`),",
      "or point REDIS_SERVER_BIN at the binary. Note that installing redis-server does",
      "not require running it — this harness starts its own throwaway instance on a",
      "free port and never touches a server you already have.",
    ].join("\n"),
  );
}

async function reserveFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("could not reserve a free port for the temporary Redis"));
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Inline-command PING; resolves false on any connection or protocol problem. */
function ping(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
    socket.on("close", () => done(false));
    socket.on("connect", () => socket.write("PING\r\n"));
    socket.on("data", (chunk: Buffer) => done(chunk.toString("utf8").startsWith("+PONG")));
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export interface StartTempRedisOptions {
  /**
   * Path to a redis.conf. Omit to boot a stock server on defaults — which is
   * how the fail-first assertion gets a genuinely unconfigured target.
   */
  configFile?: string;
}

/**
 * Start a redis-server on a free port with a temporary data directory.
 * The caller MUST call `stop()`, normally from a `finally` or `afterAll`.
 */
export async function startTempRedis(options: StartTempRedisOptions = {}): Promise<TempRedis> {
  const binary = resolveRedisServerBinary();

  if (options.configFile !== undefined && !existsSync(options.configFile)) {
    throw new Error(`redis config file not found: ${options.configFile}`);
  }

  const port = await reserveFreePort();
  const dir = await mkdtemp(path.join(tmpdir(), "mega-crm-redis-"));

  // CLI options override the config file, so the versioned file supplies the
  // durability directives under test while the harness supplies only the
  // isolation ones (own port, own data directory, loopback-only, no RDB).
  const args: string[] = [];
  if (options.configFile !== undefined) args.push(options.configFile);
  args.push(
    "--port", String(port),
    "--dir", dir,
    "--bind", "127.0.0.1",
    "--save", "",
    "--daemonize", "no",
  );

  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  const handle = { child };
  live.add(handle);
  installExitHook();

  let captured = "";
  const capture = (chunk: Buffer): void => {
    if (captured.length < MAX_CAPTURED_OUTPUT) captured += chunk.toString("utf8");
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  let spawnError: Error | undefined;
  child.on("error", (err: Error) => {
    spawnError = err;
  });

  const instance: TempRedis = {
    url: `redis://127.0.0.1:${String(port)}`,
    port,
    dir,
    output: () => captured,
    stop: async () => {
      live.delete(handle);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
          child.kill("SIGKILL");
          await waitForExit(child, STOP_TIMEOUT_MS);
        }
      }
      await rm(dir, { recursive: true, force: true });
    },
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (spawnError) {
      await instance.stop();
      throw new Error(`could not start redis-server (${binary}): ${spawnError.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const detail = captured.trim() || "(no output)";
      await instance.stop();
      throw new Error(
        `redis-server exited before becoming ready (code ${String(child.exitCode)}). ` +
          `A malformed directive causes an immediate exit rather than a fallback to defaults.\n${detail}`,
      );
    }
    if (await ping(port, 1_000)) return instance;
    if (Date.now() > deadline) {
      const detail = captured.trim() || "(no output)";
      await instance.stop();
      throw new Error(
        `redis-server did not become ready on port ${String(port)} within ${String(READY_TIMEOUT_MS)}ms.\n${detail}`,
      );
    }
    await sleep(READY_POLL_INTERVAL_MS);
  }
}
