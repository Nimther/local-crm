import { fork, type ChildProcess } from "node:child_process";

/**
 * 08-12 — generic child-process orchestration: start, await a ready marker,
 * SIGKILL, await exit.
 *
 * Deliberately domain-free. It knows about an entrypoint path, an environment,
 * and two IPC markers, and nothing else. That genericity is the whole point:
 * it lets the domain-specific child entrypoint live in the app that owns the
 * code under test, so no `packages/*` module has to depend on an `apps/*` one —
 * a dependency direction that exists nowhere else in this repository.
 *
 * `node:child_process.fork` rather than execa: fork gives an IPC channel as a
 * first-class primitive, which is the mechanism this module exists to provide.
 * execa is declared in this package's manifest but would add a layer over
 * exactly the feature being used, and the rest of the harness here (temp-redis)
 * is already built on Node built-ins.
 *
 * NOTE ON TIMING: nothing in this module decides WHEN to kill. The caller kills
 * in response to the ready marker. The bounded wait below exists only to turn a
 * hang into a diagnosable failure — a timer that triggered the kill would land
 * at an arbitrary instant and prove nothing, which is precisely what SPEC R6
 * rejects.
 */

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_EXIT_TIMEOUT_MS = 10_000;
const MAX_CAPTURED_OUTPUT = 16_000;

export interface SpawnAndAwaitReadyOptions {
  /** Absolute path to the child entrypoint. */
  entrypoint: string;
  /** The marker the child posts back once it has reached the point of interest. */
  readyMessage: string;
  /** The marker the parent posts to tell the child to begin. Defaults to `"run"`. */
  runMessage?: string;
  /** Environment for the child. Merged over the parent's. */
  env?: NodeJS.ProcessEnv;
  /** e.g. `["--import", "tsx"]` when the entrypoint is TypeScript. */
  execArgv?: string[];
  /** Hang-to-failure converter, NOT the kill trigger. */
  readyTimeoutMs?: number;
}

export interface SpawnedChild {
  readonly child: ChildProcess;
  /** Whatever the child wrote to stdout/stderr, for diagnostics. */
  output(): string;
}

export interface ChildExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Start the entrypoint, tell it to begin, and resolve once it posts
 * `readyMessage`.
 *
 * Rejects — with the child's captured output attached — if it exits first or
 * never reports. An entrypoint that throws during module load exits before
 * reporting anything, and without its stderr the caller sees only a timeout,
 * which reads as flakiness and attracts a retry loop instead of a fix.
 */
export async function spawnAndAwaitReady(
  options: SpawnAndAwaitReadyOptions,
): Promise<SpawnedChild> {
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  const child = fork(options.entrypoint, [], {
    env: { ...process.env, ...options.env },
    execArgv: options.execArgv ?? process.execArgv,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  let captured = "";
  const capture = (chunk: Buffer): void => {
    if (captured.length < MAX_CAPTURED_OUTPUT) captured += chunk.toString("utf8");
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const handle: SpawnedChild = { child, output: () => captured };

  return await new Promise<SpawnedChild>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        child.kill("SIGKILL");
        reject(err);
      } else {
        resolve(handle);
      }
    };

    const timer = setTimeout(() => {
      finish(
        new Error(
          `child at ${options.entrypoint} never posted "${options.readyMessage}" within ${String(readyTimeoutMs)}ms.\n` +
            `--- child output ---\n${captured.trim() || "(none)"}`,
        ),
      );
    }, readyTimeoutMs);

    child.on("message", (message: unknown) => {
      if (message === options.readyMessage) finish();
    });

    child.on("error", (err: Error) => {
      finish(new Error(`could not start ${options.entrypoint}: ${err.message}`));
    });

    child.on("exit", (code, signal) => {
      finish(
        new Error(
          `child at ${options.entrypoint} exited (code ${String(code)}, signal ${String(signal)}) ` +
            `before posting "${options.readyMessage}".\n` +
            `--- child output ---\n${captured.trim() || "(none)"}`,
        ),
      );
    });

    child.send(options.runMessage ?? "run");
  });
}

/**
 * SIGKILL the child and resolve once its exit event fires.
 *
 * SIGKILL cannot be caught, blocked or ignored, so the process cannot run a
 * shutdown path on the way out — which is what makes it a model of a hard
 * crash rather than a graceful stop. Returning the observed signal lets the
 * caller assert the process was killed rather than having ended on its own.
 */
export async function killAndAwaitExit(
  handle: SpawnedChild,
  timeoutMs: number = DEFAULT_EXIT_TIMEOUT_MS,
): Promise<ChildExitResult> {
  const { child } = handle;

  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  return await new Promise<ChildExitResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`child did not exit within ${String(timeoutMs)}ms of SIGKILL`));
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });

    child.kill("SIGKILL");
  });
}
