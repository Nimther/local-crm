import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrationFile, createEphemeralDatabase, dropEphemeralDatabase, listMigrationFiles } from "@mega-crm/test-support";

import { claimOpsAlertSlot, releaseOpsAlertSlot } from "../ops/alert-state.js";

/**
 * Phase 15 (OPS-13, migration 0064, plan 15-12 Task 2) -- the shared
 * `ops_alert_state` claim/release primitive all four new OPS-13 watchdogs
 * will use. Exercised against a real ephemeral, fully migrated database
 * (mirrors `reputation-and-ingestion-alert-state.test.ts`'s own fixture
 * convention) -- the concurrency case in particular needs two REAL
 * connections, not a mock.
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

const DEDUP_HOURS = 6;

describe("claimOpsAlertSlot / releaseOpsAlertSlot (OPS-13, migration 0064)", () => {
  let pool: Pool;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "ops-alert-state" });
    pool = new Pool({ connectionString: created.dsn, max: 5 });

    const files = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of files) {
      await applyMigrationFile(pool, MIGRATIONS_DIR, file);
    }

    // Register cleanup against the SAME created database, since dropping it
    // requires the admin DSN captured here.
    poolCleanup = async () => {
      await pool.end();
      await dropEphemeralDatabase(created.databaseName, created.adminDsn);
    };
  }, 60_000);

  let poolCleanup: () => Promise<void>;

  afterAll(async () => {
    await poolCleanup?.();
  });

  function uniqueAlertName(seed: string): string {
    return `${seed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  it("claiming an alert slot for a name with no prior row succeeds and records the claim time", async () => {
    const alertName = uniqueAlertName("first-claim");
    const now = new Date();

    const claimed = await claimOpsAlertSlot(pool, alertName, now, DEDUP_HOURS);
    expect(claimed).toBe(true);

    const { rows } = await pool.query<{ last_alert_sent_at: Date }>(
      `SELECT last_alert_sent_at FROM ops_alert_state WHERE alert_name = $1`,
      [alertName],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].last_alert_sent_at.getTime()).toBe(now.getTime());
  });

  it("claiming the same name again inside the dedup window fails", async () => {
    const alertName = uniqueAlertName("dedup-window");
    const first = new Date();
    const second = new Date(first.getTime() + 60_000); // one minute later, well inside a 6h window

    expect(await claimOpsAlertSlot(pool, alertName, first, DEDUP_HOURS)).toBe(true);
    expect(await claimOpsAlertSlot(pool, alertName, second, DEDUP_HOURS)).toBe(false);

    // The refused claim must not have overwritten the winning claim's value.
    const { rows } = await pool.query<{ last_alert_sent_at: Date }>(
      `SELECT last_alert_sent_at FROM ops_alert_state WHERE alert_name = $1`,
      [alertName],
    );
    expect(rows[0].last_alert_sent_at.getTime()).toBe(first.getTime());
  });

  it("claiming the same name after the dedup window elapses succeeds", async () => {
    const alertName = uniqueAlertName("window-elapsed");
    const first = new Date();
    const afterWindow = new Date(first.getTime() + (DEDUP_HOURS + 1) * 60 * 60 * 1000);

    expect(await claimOpsAlertSlot(pool, alertName, first, DEDUP_HOURS)).toBe(true);
    expect(await claimOpsAlertSlot(pool, alertName, afterWindow, DEDUP_HOURS)).toBe(true);

    const { rows } = await pool.query<{ last_alert_sent_at: Date }>(
      `SELECT last_alert_sent_at FROM ops_alert_state WHERE alert_name = $1`,
      [alertName],
    );
    expect(rows[0].last_alert_sent_at.getTime()).toBe(afterWindow.getTime());
  });

  it("two concurrent claims for the same name in the same window: exactly one succeeds", async () => {
    const alertName = uniqueAlertName("concurrent");
    const now = new Date();

    // Two SEPARATE connections -- the property under test is that Postgres's
    // own row-level locking on the atomic statement (not in-process
    // coordination) is what arbitrates, so a mock or a single shared client
    // would not exercise it.
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      const [resultA, resultB] = await Promise.all([
        claimOpsAlertSlot(clientA, alertName, now, DEDUP_HOURS),
        claimOpsAlertSlot(clientB, alertName, now, DEDUP_HOURS),
      ]);

      const winners = [resultA, resultB].filter((won) => won);
      expect(winners).toHaveLength(1);
    } finally {
      clientA.release();
      clientB.release();
    }

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ops_alert_state WHERE alert_name = $1`,
      [alertName],
    );
    expect(rows[0].count).toBe("1");
  });

  it("claims for two different alert names are independent -- one does not suppress the other", async () => {
    const alertA = uniqueAlertName("indep-a");
    const alertB = uniqueAlertName("indep-b");
    const now = new Date();

    expect(await claimOpsAlertSlot(pool, alertA, now, DEDUP_HOURS)).toBe(true);
    // Claiming a DIFFERENT name in the same instant must succeed regardless
    // of alertA's own dedup window -- this is the whole point of keying by
    // alert_name instead of a singleton row.
    expect(await claimOpsAlertSlot(pool, alertB, now, DEDUP_HOURS)).toBe(true);

    // And alertA's own window is still in force -- a second claim for A
    // moments later still fails, proving B's claim did not touch A's row.
    const shortlyAfter = new Date(now.getTime() + 1_000);
    expect(await claimOpsAlertSlot(pool, alertA, shortlyAfter, DEDUP_HOURS)).toBe(false);
  });

  it("releasing a claim restores retryability so the next tick can retry", async () => {
    const alertName = uniqueAlertName("release-retry");
    const now = new Date();

    expect(await claimOpsAlertSlot(pool, alertName, now, DEDUP_HOURS)).toBe(true);
    // Still well inside the dedup window -- without a release this would fail.
    expect(await claimOpsAlertSlot(pool, alertName, new Date(now.getTime() + 1_000), DEDUP_HOURS)).toBe(false);

    await releaseOpsAlertSlot(pool, alertName, now);

    const retry = new Date(now.getTime() + 2_000);
    expect(await claimOpsAlertSlot(pool, alertName, retry, DEDUP_HOURS)).toBe(true);
  });

  it("releasing a claim that has since been superseded by a newer claim does not clobber it", async () => {
    const alertName = uniqueAlertName("release-superseded");
    const first = new Date();

    expect(await claimOpsAlertSlot(pool, alertName, first, DEDUP_HOURS)).toBe(true);

    // A newer claim wins after the window elapses (simulating a second,
    // later tick that genuinely re-claimed the slot).
    const afterWindow = new Date(first.getTime() + (DEDUP_HOURS + 1) * 60 * 60 * 1000);
    expect(await claimOpsAlertSlot(pool, alertName, afterWindow, DEDUP_HOURS)).toBe(true);

    // A stale release referencing the FIRST (now-superseded) claim time must
    // not clear the newer claim.
    await releaseOpsAlertSlot(pool, alertName, first);

    const { rows } = await pool.query<{ last_alert_sent_at: Date }>(
      `SELECT last_alert_sent_at FROM ops_alert_state WHERE alert_name = $1`,
      [alertName],
    );
    expect(rows[0].last_alert_sent_at.getTime()).toBe(afterWindow.getTime());
  });

  it("ops_alert_state is never seeded -- an alert name with no prior claim has no row until first claimed", async () => {
    const alertName = uniqueAlertName("unseeded");
    const { rows: before } = await pool.query(`SELECT 1 FROM ops_alert_state WHERE alert_name = $1`, [alertName]);
    expect(before).toHaveLength(0);
  });
});
