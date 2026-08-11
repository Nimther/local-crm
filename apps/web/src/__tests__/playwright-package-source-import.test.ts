import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("Playwright package-source resolution", () => {
  it("loads the shared E2E database fixture from a clean TypeScript source tree", () => {
    const webRoot = path.resolve(import.meta.dirname, "../..");
    const playwrightCli = path.resolve(webRoot, "../../node_modules/@playwright/test/cli.js");
    const config = path.resolve(webRoot, "e2e/package-source-import.config.ts");

    const result = spawnSync(process.execPath, [playwrightCli, "test", "--list", "--config", config], {
      cwd: webRoot,
      encoding: "utf8",
      env: process.env,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("ERR_MODULE_NOT_FOUND");
  });
});
