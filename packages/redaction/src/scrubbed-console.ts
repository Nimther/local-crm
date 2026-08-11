import { scrub } from "./scrub.js";

type ConsoleMethod = "log" | "error" | "warn" | "info" | "debug";

function wrap(method: ConsoleMethod): (...args: unknown[]) => void {
  return (...args: unknown[]): void => {
    // This IS the console wrapper -- every other call site in apps/worker/src
    // routes through here instead of calling console directly.
    console[method](...args.map((arg) => scrub(arg)));
  };
}

/**
 * 10-13 (SEC-13, D-09): a drop-in replacement for the worker's direct
 * `console.*` calls that scrubs every argument through `scrub()` first.
 *
 * Lives in `@mega-crm/redaction` rather than as a small wrapper module
 * inside `apps/worker` (the plan left this to the executor's discretion) --
 * this package has no runtime dependencies and `console` is a global, so
 * putting it here costs nothing and means apps/api could adopt the same
 * wrapper later without a second implementation.
 *
 * This is D-09's scope exactly: wrapping the worker's EXISTING console
 * surface so the "every argument gets scrubbed" guarantee is mechanical
 * rather than reviewed. It is not a rebuild into a structured logger --
 * that is Phase 15's work (OPS-06).
 */
export const scrubbedConsole: Record<ConsoleMethod, (...args: unknown[]) => void> = {
  log: wrap("log"),
  error: wrap("error"),
  warn: wrap("warn"),
  info: wrap("info"),
  debug: wrap("debug"),
};
