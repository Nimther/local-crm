import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { killAndAwaitExit, spawnAndAwaitReady } from "../harness/spawn-and-kill.js";

/**
 * 08-12 — the generic spawn / await-ready / SIGKILL helper.
 *
 * Fixture entrypoints are plain JavaScript written to a temp directory, so the
 * helper is exercised without a TypeScript loader in the way and without
 * committing throwaway files. Nothing here touches a database or a queue.
 */

const READY = "harness:ready";

describe("spawnAndAwaitReady / killAndAwaitExit", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mega-crm-spawn-kill-"));

    // Reports ready, then hangs forever. The unref'd interval keeps the event
    // loop alive without ever resolving anything — the shape a frozen child has.
    writeFileSync(
      path.join(dir, "ready-then-hang.mjs"),
      [
        `process.on("message", (m) => {`,
        `  if (m !== "run") return;`,
        `  process.send(${JSON.stringify(READY)});`,
        `  setInterval(() => {}, 1000);`,
        `});`,
      ].join("\n"),
    );

    // Dies during startup, before it can report anything.
    writeFileSync(
      path.join(dir, "crash-on-load.mjs"),
      [
        `console.error("deliberate startup failure: MISSING_CONFIG");`,
        `process.exit(3);`,
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves once the child reports the ready marker", async () => {
    const handle = await spawnAndAwaitReady({
      entrypoint: path.join(dir, "ready-then-hang.mjs"),
      readyMessage: READY,
    });

    try {
      expect(handle.child.pid).toBeGreaterThan(0);
      expect(handle.child.exitCode, "the child must still be alive when we resolve").toBeNull();
    } finally {
      await killAndAwaitExit(handle);
    }
  });

  it("reports SIGKILL as the observed signal, proving the process was killed", async () => {
    const handle = await spawnAndAwaitReady({
      entrypoint: path.join(dir, "ready-then-hang.mjs"),
      readyMessage: READY,
    });

    const result = await killAndAwaitExit(handle);

    // A child that had ended on its own would report a numeric code and a null
    // signal — which is exactly the case a bare "the process is gone" check
    // would wave through.
    expect(result.signal).toBe("SIGKILL");
    expect(result.code).toBeNull();
  });

  it("rejects when the child dies before reporting, surfacing its stderr", async () => {
    await expect(
      spawnAndAwaitReady({
        entrypoint: path.join(dir, "crash-on-load.mjs"),
        readyMessage: READY,
      }),
      "a child that crashes on load must produce a diagnosable error, not a timeout",
    ).rejects.toThrow(/MISSING_CONFIG/);
  });

  it("rejects with a bounded wait rather than hanging when no marker ever arrives", async () => {
    // The bounded wait is a hang-to-failure converter, not the kill trigger.
    await expect(
      spawnAndAwaitReady({
        entrypoint: path.join(dir, "ready-then-hang.mjs"),
        readyMessage: "a-marker-the-child-never-posts",
        readyTimeoutMs: 750,
      }),
    ).rejects.toThrow(/never posted/);
  });
});
