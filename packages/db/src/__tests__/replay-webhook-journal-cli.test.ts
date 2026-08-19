import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import fs from "node:fs";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrationFile, createEphemeralDatabase, dropEphemeralDatabase, listMigrationFiles } from "@mega-crm/test-support";
import { writeIngressJournal, markIngestionComplete } from "../webhooks/ingress-journal.js";

/**
 * Phase 13 (CMP-08, D-06, plan 13-06), Task 3 — behavioral tests for the
 * operator-invoked `replay:webhook-journal` CLI, verifying the gap behaviors
 * from the Nyquist validation plan:
 *
 * - Dry-run mode makes no DB writes and no queue enqueues
 * - Tombstoned rows are skipped
 * - Date-range bounds are respected
 * - Missing/invalid workspace-id fails closed
 * - Pagination works correctly (keyset pagination over large ranges)
 *
 * Tests spawn the compiled script as subprocess (`npx tsx ...`) with hermetic
 * environment (fresh .env file, explicit DATABASE_URL, no inherited
 * REDIS_URL in dry-run) to avoid module-load-time main() execution and to
 * match the plan's own human-check methodology (real tsx subprocess invocations).
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCRIPT_PATH = path.resolve(PROJECT_ROOT, "packages/db/scripts/replay-webhook-journal.ts");
const SCRATCHPAD = fs.mkdtempSync(path.join(os.tmpdir(), "replay-webhook-journal-cli-"));

function adminDsnForDatabase(adminDsn: string, databaseName: string): string {
  const url = new URL(adminDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describe("replay-webhook-journal.ts CLI (CMP-08, D-06, plan 13-06)", () => {
  let pool: Pool;
  let adminPool: Pool;
  let databaseName: string;
  let adminDsn: string;
  let dsnForTest: string;
  let emptyEnvFile: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "replay-webhook-journal-cli" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    dsnForTest = created.dsn;
    pool = new Pool({ connectionString: dsnForTest, max: 5 });
    adminPool = new Pool({ connectionString: adminDsnForDatabase(adminDsn, databaseName), max: 2 });

    const files = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of files) {
      await applyMigrationFile(pool, MIGRATIONS_DIR, file);
    }

    // Create an empty .env file in scratchpad to avoid loading the real env
    emptyEnvFile = path.join(SCRATCHPAD, `.env.replay-test.${Date.now()}`);
    fs.writeFileSync(emptyEnvFile, "");
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    fs.rmSync(SCRATCHPAD, { recursive: true, force: true });
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const { rows } = await adminPool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`]
    );
    return rows[0].id;
  }

  async function withWorkspace<T>(workspaceId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Seeds a journal row with explicit received_at and optional payload_purged_at
   * to simulate aged rows and tombstones.
   */
  async function seedJournalRow(
    workspaceId: string,
    overrides: {
      receivedAt?: Date;
      payloadPurgedAt?: Date | null;
      completed?: boolean;
    } = {}
  ): Promise<{ id: string; receivedAt: Date }> {
    return withWorkspace(workspaceId, async (client) => {
      const journalId = await writeIngressJournal(client, workspaceId, [{ event: "delivered" }]);
      if (overrides.completed) {
        await markIngestionComplete(client, journalId);
      }
      if (overrides.receivedAt || overrides.payloadPurgedAt !== undefined) {
        const setClauses: string[] = [];
        const params: unknown[] = [];
        if (overrides.receivedAt) {
          params.push(overrides.receivedAt);
          setClauses.push(`received_at = $${params.length}`);
        }
        if (overrides.payloadPurgedAt !== undefined) {
          params.push(overrides.payloadPurgedAt);
          setClauses.push(`payload_purged_at = $${params.length}`);
        }
        params.push(journalId);
        await client.query(`UPDATE ingress_journal SET ${setClauses.join(", ")} WHERE id = $${params.length}`, params);
      }
      const receivedAt = overrides.receivedAt || new Date();
      return { id: journalId, receivedAt };
    });
  }

  async function getJournalRowReplayCount(workspaceId: string, journalId: string): Promise<number> {
    return withWorkspace(workspaceId, async (client) => {
      const { rows } = await client.query<{ replayCount: number }>(
        `SELECT replay_count as "replayCount" FROM ingress_journal WHERE id = $1`,
        [journalId]
      );
      return rows[0]?.replayCount ?? 0;
    });
  }

  /**
   * Spawns the replay CLI with hermetic environment, capturing output and exit code.
   * Returns { exitCode, stdout, stderr }.
   */
  function spawnCli(args: string[], env?: Record<string, string | undefined>): { exitCode: number; stdout: string; stderr: string } {
    const defaultEnv = {
      MEGA_CRM_ENV_FILE: emptyEnvFile,
      DATABASE_URL: dsnForTest,
      REDIS_URL: undefined, // explicitly unset for most tests
      NODE_ENV: "test",
      PATH: process.env.PATH,
    };
    const finalEnv = { ...defaultEnv, ...env };

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      stdout = execSync(`npx tsx ${SCRIPT_PATH} ${args.join(" ")}`, {
        cwd: path.join(PROJECT_ROOT, "packages/db"),
        env: finalEnv,
        encoding: "utf-8",
        timeout: 30_000, // 30s timeout to catch infinite loops
      });
    } catch (caught) {
      const err = caught as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; killed?: boolean };
      if (err.status !== undefined) {
        exitCode = err.status;
        stdout = err.stdout?.toString() || "";
        stderr = err.stderr?.toString() || "";
      } else if (err.killed) {
        // Process was killed by timeout
        exitCode = 124; // conventional timeout exit code
        stderr = "Process killed (timeout)";
      } else {
        throw caught instanceof Error ? caught : new Error(String(caught));
      }
    }

    return { exitCode, stdout, stderr };
  }

  // ============================================================================
  // TEST 1: Fail-closed — argument validation before any connection
  // ============================================================================

  it("fails non-zero with no arguments (no workspace id)", () => {
    const { exitCode, stderr } = spawnCli([]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--workspace/i);
  });

  it("fails non-zero with --dry-run but no workspace", () => {
    const { exitCode, stderr } = spawnCli(["--dry-run"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--workspace/i);
  });

  it("fails non-zero when --from is missing", async () => {
    const workspaceId = await freshWorkspaceId("test-missing-from");
    const { exitCode, stderr } = spawnCli(["--workspace", workspaceId, "--to", "2026-08-20T00:00:00Z"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--from.*required|requires/i);
  });

  it("fails non-zero when --to is missing", async () => {
    const workspaceId = await freshWorkspaceId("test-missing-to");
    const { exitCode, stderr } = spawnCli(["--workspace", workspaceId, "--from", "2026-08-20T00:00:00Z"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--to.*required|requires/i);
  });

  it("fails non-zero with malformed --from timestamp", async () => {
    const workspaceId = await freshWorkspaceId("test-bad-from");
    const { exitCode, stderr } = spawnCli([
      "--workspace",
      workspaceId,
      "--from",
      "not-a-timestamp",
      "--to",
      "2026-08-20T00:00:00Z",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/ISO-8601|invalid|timestamp/i);
  });

  it("fails non-zero when --from > --to", async () => {
    const workspaceId = await freshWorkspaceId("test-from-after-to");
    const { exitCode, stderr } = spawnCli([
      "--workspace",
      workspaceId,
      "--from",
      "2026-08-21T00:00:00Z",
      "--to",
      "2026-08-20T00:00:00Z",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--from.*must not be after|--to/i);
  });

  // ============================================================================
  // TEST 2: Dry-run makes no writes — DB replay_count stays 0, no queue enqueues
  // ============================================================================

  it("dry-run does not increment replay_count and reports correct count", async () => {
    const workspaceId = await freshWorkspaceId("test-dry-run-no-writes");

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 1000 * 60 * 60);
    const twoHoursAgo = new Date(now.getTime() - 1000 * 60 * 60 * 2);

    // Seed 2 eligible rows + 1 tombstone in range
    const row1 = await seedJournalRow(workspaceId, { receivedAt: twoHoursAgo });
    const row2 = await seedJournalRow(workspaceId, { receivedAt: oneHourAgo });
    const tombstone = await seedJournalRow(workspaceId, {
      receivedAt: new Date(now.getTime() - 1000 * 60 * 30), // 30 min ago
      payloadPurgedAt: new Date(), // marks it as a tombstone
    });

    // Run dry-run (no REDIS_URL)
    const fromTime = new Date(now.getTime() - 1000 * 60 * 60 * 3).toISOString();
    const toTime = new Date(now.getTime() + 1000).toISOString();
    const { exitCode, stdout } = spawnCli([
      "--workspace",
      workspaceId,
      "--from",
      fromTime,
      "--to",
      toTime,
      "--dry-run",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Would enqueue 2/); // the 2 eligible rows
    expect(stdout).toMatch(/skipped 1/); // the tombstone
    expect(stdout).toMatch(/dry run/i);

    // Verify DB was not modified: all replay_count still 0
    const count1 = await getJournalRowReplayCount(workspaceId, row1.id);
    const count2 = await getJournalRowReplayCount(workspaceId, row2.id);
    const countTombstone = await getJournalRowReplayCount(workspaceId, tombstone.id);

    expect(count1).toBe(0);
    expect(count2).toBe(0);
    expect(countTombstone).toBe(0);
  });

  // ============================================================================
  // TEST 3: Date-range bounds are respected
  // ============================================================================

  it("respects date-range bounds and only enqueues rows within [from, to]", async () => {
    const workspaceId = await freshWorkspaceId("test-range-bounds");

    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 3);
    const twoDaysAgo = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 2);
    const oneDayAgo = new Date(now.getTime() - 1000 * 60 * 60 * 24);

    // Seed one row before range, one in range, one after range
    await seedJournalRow(workspaceId, { receivedAt: threeDaysAgo });
    await seedJournalRow(workspaceId, { receivedAt: twoDaysAgo });
    await seedJournalRow(workspaceId, { receivedAt: oneDayAgo });

    // Use a range that only includes the middle row
    const fromTime = new Date(twoDaysAgo.getTime() - 1000).toISOString();
    const toTime = new Date(twoDaysAgo.getTime() + 1000).toISOString();

    const { exitCode, stdout } = spawnCli([
      "--workspace",
      workspaceId,
      "--from",
      fromTime,
      "--to",
      toTime,
      "--dry-run",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Would enqueue 1/); // only the in-range row
  });

  // ============================================================================
  // TEST 4: Pagination works with bounded page size
  // ============================================================================

  it("paginates correctly with --page-size 1 over 3 rows (keyset pagination)", async () => {
    const workspaceId = await freshWorkspaceId("test-pagination");

    const now = new Date();
    const baseTime = new Date(now.getTime() - 1000 * 60 * 60);

    // Seed 3 rows with distinct timestamps (ensure clear ordering for keyset pagination)
    await seedJournalRow(workspaceId, { receivedAt: new Date(baseTime.getTime()) });
    await seedJournalRow(workspaceId, { receivedAt: new Date(baseTime.getTime() + 1000) });
    await seedJournalRow(workspaceId, { receivedAt: new Date(baseTime.getTime() + 2000) });

    const fromTime = new Date(baseTime.getTime() - 1000).toISOString();
    const toTime = new Date(baseTime.getTime() + 3000).toISOString();

    const { exitCode, stdout } = spawnCli([
      "--workspace",
      workspaceId,
      "--from",
      fromTime,
      "--to",
      toTime,
      "--page-size",
      "1",
      "--dry-run",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Would enqueue 3/); // all 3 rows across 3 pages
    expect(stdout).toMatch(/page complete/i); // should show multiple page messages
  });

  // ============================================================================
  // TEST 5: Tombstoned rows are skipped and counted separately
  // ============================================================================

  it("skips tombstoned rows (payload_purged_at set) and reports them separately", async () => {
    const workspaceId = await freshWorkspaceId("test-tombstone-skip");

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 1000 * 60 * 60);

    // Seed 1 eligible row + 1 tombstoned row
    await seedJournalRow(workspaceId, { receivedAt: oneHourAgo });
    const tombstone = await seedJournalRow(workspaceId, {
      receivedAt: oneHourAgo,
      payloadPurgedAt: new Date(), // This makes it a tombstone
    });

    const fromTime = new Date(now.getTime() - 1000 * 60 * 60 * 2).toISOString();
    const toTime = new Date(now.getTime() + 1000).toISOString();

    const { exitCode, stdout } = spawnCli([
      "--workspace",
      workspaceId,
      "--from",
      fromTime,
      "--to",
      toTime,
      "--dry-run",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Would enqueue 1/); // only eligible
    expect(stdout).toMatch(/skipped 1/); // the tombstone

    // Verify the tombstone's replay_count was not incremented
    const tombstoneCount = await getJournalRowReplayCount(workspaceId, tombstone.id);
    expect(tombstoneCount).toBe(0);
  });

  // ============================================================================
  // TEST 6: Re-enqueueing already-ingested rows (D-06 surgical re-run intent)
  // ============================================================================

  it("re-enqueues already-ingested rows (surgical re-run after bug fix)", async () => {
    const workspaceId = await freshWorkspaceId("test-re-enqueue-ingested");

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 1000 * 60 * 60);

    // Seed 1 incomplete row + 1 completed row
    await seedJournalRow(workspaceId, { receivedAt: oneHourAgo, completed: false });
    await seedJournalRow(workspaceId, { receivedAt: oneHourAgo, completed: true });

    const fromTime = new Date(now.getTime() - 1000 * 60 * 60 * 2).toISOString();
    const toTime = new Date(now.getTime() + 1000).toISOString();

    // Dry-run should include both
    const { exitCode, stdout } = spawnCli([
      "--workspace",
      workspaceId,
      "--from",
      fromTime,
      "--to",
      toTime,
      "--dry-run",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Would enqueue 2/); // both rows, unlike the sweep which filters on ingestion_completed_at
  });
});
