import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SENDGRID_TIMEOUT_MS } from "@mega-crm/delivery-core";
import { WORKER_STOP_GRACE_PERIOD_SECONDS } from "../shutdown-budget.js";

/**
 * Phase 14 plan 04 (Pitfall 7, D-14, RESEARCH.md Pattern 4) -- the anti-drift
 * mechanism for `scripts/print-stop-grace-period.mjs`: proves the script's
 * printed stdout equals the SAME `WORKER_STOP_GRACE_PERIOD_SECONDS` this
 * file imports from the live TypeScript source, so a future change to
 * `SENDGRID_TIMEOUT_MS`/`CLAIM_TX_MARGIN_MS`/`RECORD_TX_MARGIN_MS` that
 * changes the constant but leaves a stale build in place fails THIS test,
 * not a silent deploy-time mismatch.
 *
 * The script is exercised as a REAL child process (matching
 * `scripts/migrate-runner.mjs`'s own precedent in
 * `apps/api/src/modules/ops/__tests__/readyz.test.ts`) rather than imported
 * -- the exit code and stdout/stderr separation are part of the contract
 * plans 14-08/14-09 depend on, and a plain `.ts` test file has no type
 * declarations for a `.mjs` script to import cleanly anyway.
 *
 * Requires `apps/worker` to already be built (`npm run build -w apps/worker`)
 * -- this test file does not build it itself, matching this plan's own
 * `<verify>` sequencing (build, then run the script, then run this suite).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts/print-stop-grace-period.mjs");
const BUILT_MODULE_PATH = path.join(REPO_ROOT, "apps/worker/dist/shutdown-budget.js");
const BACKUP_MODULE_PATH = `${BUILT_MODULE_PATH}.bak-test`;

function runScript(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("scripts/print-stop-grace-period.mjs (Pitfall 7 anti-drift)", () => {
  it("prints exactly WORKER_STOP_GRACE_PERIOD_SECONDS as a bare integer, and it exceeds the SendGrid timeout expressed in seconds", async () => {
    const { code, stdout, stderr } = await runScript();
    expect(code, `expected exit 0; stderr:\n${stderr}`).toBe(0);

    const trimmed = stdout.trim();
    expect(trimmed).toMatch(/^\d+$/);
    const printed = Number(trimmed);

    // Equality with the SOURCE constant -- this is what fails when
    // SENDGRID_TIMEOUT_MS/CLAIM_TX_MARGIN_MS/RECORD_TX_MARGIN_MS change but
    // the built output is stale.
    expect(printed).toBe(WORKER_STOP_GRACE_PERIOD_SECONDS);

    // Independent check: catches a refactor that accidentally divides by
    // the wrong unit even if it still happened to match the (also wrong)
    // source constant above.
    expect(printed).toBeGreaterThan(SENDGRID_TIMEOUT_MS / 1000);
  });

  it("exits non-zero and names the build command when the built worker output is absent", async () => {
    const builtExists = fs.existsSync(BUILT_MODULE_PATH);
    if (builtExists) {
      fs.renameSync(BUILT_MODULE_PATH, BACKUP_MODULE_PATH);
    }

    try {
      const { code, stderr } = await runScript();
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/npm run build -w apps\/worker/);
    } finally {
      if (builtExists) {
        fs.renameSync(BACKUP_MODULE_PATH, BUILT_MODULE_PATH);
      }
    }
  });

  it("does not register a root package.json script entry (plan 14-04 leaves that file untouched)", () => {
    const rootPackageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = rootPackageJson.scripts ?? {};
    const referencesScript = Object.values(scripts).some((command) => command.includes("print-stop-grace-period"));
    expect(referencesScript).toBe(false);
  });
});
