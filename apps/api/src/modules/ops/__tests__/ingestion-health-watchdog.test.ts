import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// 10-09 (SEC-05): seeding an organization row directly for test setup is not
// a live application query site -- as of migration 0045 it needs the
// mega_crm_auth-backed client, not the app-role `db`.
import { authDb as sharedDb, organization } from "@mega-crm/db";
import { closeScanPool, pool, withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { getScanTestDatabaseUrl } from "@mega-crm/test-support";
import { scrubbedConsole } from "@mega-crm/redaction";

import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import {
  INGESTION_ALERT_DEDUP_HOURS,
  INGESTION_UNRECOVERABLE_ALERT_WINDOW_HOURS,
  INGESTION_WATCHDOG_INTERVAL_MS,
  checkIngestionHealthAndAlert,
  claimIngestionAlertSlot,
  readIngestionHealth,
  renderIngestionAlertText,
  startIngestionHealthWatchdog,
} from "../ingestion-health-watchdog.js";

/**
 * Phase 13 (CMP-08, plan 13-11), Task 1: `ingestion-health-watchdog.ts`'s own
 * test module, mirroring `dead-letter-watchdog.test.ts`'s structure and
 * conventions. `ingress_journal` is, like `dead_letter_jobs`, a genuine
 * multi-row table -- but UNLIKE `dead_letter_jobs` (which no other apps/api
 * test file touches), `ingress_journal` is also written by
 * `apps/api/src/modules/webhooks/__tests__/ingress-journal.test.ts` and read
 * platform-WIDE by `readIngestionHealth` (no workspace-scoping override
 * exists, unlike `runWebhookReplaySweep`'s test-only `workspaceIds` param --
 * this watchdog's whole point is a platform-wide question). A blanket
 * `DELETE FROM ingress_journal` in `beforeEach` (the dead-letter precedent)
 * would therefore be unsafe here: vitest may run that file's test cases
 * concurrently with this one against the SAME ephemeral database.
 *
 * Instead, every row THIS file creates is tracked by id and marked
 * `ingestion_completed_at = now()` in `afterEach` -- a row-scoped, additive
 * cleanup (never a blanket delete) that removes it from every subsequent
 * `findStuckIngressJournalRows` read without ever touching a row this file
 * did not itself create. `ingress-journal.test.ts`'s own rows are never
 * "stuck" in the first place (it never backdates `received_at` past
 * `INGRESS_JOURNAL_STUCK_THRESHOLD_MINUTES`), so this file's own exact-count
 * assertions hold regardless of interleaving.
 */

interface CreatedJournalRow {
  id: string;
  workspaceId: string;
}

let createdJournalRows: CreatedJournalRow[] = [];

async function freshWorkspaceId(nameSeed: string): Promise<string> {
  const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await sharedDb
    .insert(organization)
    .values({ id: randomUUID(), name: nameSeed, slug, createdAt: new Date() })
    .returning();
  return org.id;
}

interface SeedOverrides {
  receivedAtMinutesAgo?: number;
  replayCount?: number;
  payloadPurgedAt?: Date | null;
  payloadMarker?: string;
}

async function seedJournalRow(workspaceId: string, overrides: SeedOverrides = {}): Promise<string> {
  const { receivedAtMinutesAgo = 30, replayCount = 0, payloadPurgedAt = null, payloadMarker } = overrides;
  const rawBatch = payloadPurgedAt
    ? null
    : [
        {
          sg_event_id: `sg-${randomUUID()}`,
          event: "delivered",
          timestamp: Math.floor(Date.now() / 1000) - 3600,
          ...(payloadMarker ? { marker: payloadMarker } : {}),
        },
      ];

  const id = await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO ingress_journal (workspace_id, raw_batch, received_at, replay_count, payload_purged_at)
         VALUES ($1, $2, now() - make_interval(mins => $3), $4, $5)
         RETURNING id`,
        [workspaceId, rawBatch === null ? null : JSON.stringify(rawBatch), receivedAtMinutesAgo, replayCount, payloadPurgedAt],
      );
      return rows[0].id;
    }),
  );
  createdJournalRows.push({ id, workspaceId });
  return id;
}

async function resetIngestionAlertState(): Promise<void> {
  await pool.query(
    `UPDATE ingestion_alert_state
        SET last_alert_sent_at = NULL, last_seen_stuck_at = NULL, updated_at = now()
      WHERE id = 1`,
  );
}

describe("renderIngestionAlertText (pure, no DB)", () => {
  it("carries all three counts, the oldest age, workspace ids, and never a payload/email", () => {
    const now = new Date("2027-06-01T00:00:00Z");
    const oldest = new Date("2027-05-31T20:00:00Z");
    const body = renderIngestionAlertText(
      {
        stuckCount: 3,
        attemptCappedCount: 1,
        unrecoverableCount: 2,
        recentlyPurgedCount: 1,
        oldestReceivedAt: oldest,
        affectedWorkspaceIds: ["ws-a", "ws-b"],
      },
      now,
    );

    expect(body).toContain(now.toISOString());
    expect(body).toContain("3");
    expect(body).toContain("1");
    expect(body).toContain("2");
    expect(body).toContain(oldest.toISOString());
    expect(body).toContain("ws-a");
    expect(body).toContain("ws-b");
    expect(body).not.toMatch(/@/);
    expect(body).not.toContain("raw_batch");
    expect(body).not.toContain("marker-value");
  });

  it("with a null oldestReceivedAt the body still renders without dereferencing it", () => {
    const now = new Date("2027-06-01T00:00:00Z");
    const body = renderIngestionAlertText(
      { stuckCount: 0, attemptCappedCount: 0, unrecoverableCount: 0, recentlyPurgedCount: 0, oldestReceivedAt: null, affectedWorkspaceIds: [] },
      now,
    );
    expect(body).toContain("0");
    expect(body).not.toContain("Invalid Date");
  });
});

describe("readIngestionHealth / claimIngestionAlertSlot / checkIngestionHealthAndAlert (T-13-11-01/02/03)", () => {
  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    process.env.SCAN_DATABASE_URL = getScanTestDatabaseUrl();
    pool.on("error", () => {
      // expected: the concurrent-replica test below deliberately drives two
      // independent pools against the same alert-state row, mirroring
      // dead-letter-watchdog.test.ts's own multi-pool convention.
    });
  });

  beforeEach(async () => {
    await resetIngestionAlertState();
  });

  afterEach(async () => {
    // Row-scoped cleanup, never a blanket delete -- see this file's own
    // header comment for why. Marking `ingestion_completed_at` removes each
    // row from every subsequent findStuckIngressJournalRows read without
    // ever touching a row this file did not itself create. `ingress_journal`
    // is RLS-forced (fail-closed workspace_isolation, migration 0055) --
    // a bare `pool.query(...)` with no tenant GUC set throws
    // "unrecognized configuration parameter", so this must go through
    // `withTenant`/`withTenantTransaction`, one call per row's own
    // workspace, exactly like `seedJournalRow`'s own insert.
    const rows = createdJournalRows;
    createdJournalRows = [];
    for (const row of rows) {
      await withTenant(row.workspaceId, () =>
        withTenantTransaction((client) =>
          client.query(`UPDATE ingress_journal SET ingestion_completed_at = now() WHERE id = $1`, [row.id]),
        ),
      );
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("T-13-11-08: readIngestionHealth invoked inside a REAL withCrossWorkspaceScan block against a migrated database resolves without throwing and sees rows across two workspaces", async () => {
    const workspaceA = await freshWorkspaceId("ingestion-scan-a");
    const workspaceB = await freshWorkspaceId("ingestion-scan-b");
    await seedJournalRow(workspaceA, { receivedAtMinutesAgo: 30 });
    await seedJournalRow(workspaceB, { receivedAtMinutesAgo: 30 });

    const now = new Date();
    const snapshot = await withCrossWorkspaceScan((client) => readIngestionHealth(client, now));

    expect(snapshot.affectedWorkspaceIds).toHaveLength(2);
    expect(snapshot.affectedWorkspaceIds).toEqual(expect.arrayContaining([workspaceA, workspaceB]));
    expect(snapshot.stuckCount).toBe(2);
  });

  it("a journal row inside the stuck threshold (2 minutes old) is not reported", async () => {
    const workspaceId = await freshWorkspaceId("ingestion-fresh");
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 2 });

    const now = new Date();
    const snapshot = await withCrossWorkspaceScan((client) => readIngestionHealth(client, now));

    expect(snapshot.stuckCount).toBe(0);
  });

  it("an attempt-capped row (replay_count at cap, payload present) is reported in attemptCappedCount, not stuckCount", async () => {
    const workspaceId = await freshWorkspaceId("ingestion-capped");
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 30, replayCount: 5 });

    const now = new Date();
    const snapshot = await withCrossWorkspaceScan((client) => readIngestionHealth(client, now));

    expect(snapshot.attemptCappedCount).toBe(1);
    expect(snapshot.stuckCount).toBe(0);
    expect(snapshot.unrecoverableCount).toBe(0);
  });

  it("a tombstoned row (payload_purged_at set, ingestion never completed) is reported in unrecoverableCount, in neither of the other two", async () => {
    const workspaceId = await freshWorkspaceId("ingestion-tombstone");
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 30, payloadPurgedAt: new Date() });

    const now = new Date();
    const snapshot = await withCrossWorkspaceScan((client) => readIngestionHealth(client, now));

    expect(snapshot.unrecoverableCount).toBe(1);
    expect(snapshot.stuckCount).toBe(0);
    expect(snapshot.attemptCappedCount).toBe(0);
  });

  it("a row that is BOTH tombstoned and at the attempt cap is counted once, as unrecoverable -- the three counts sum to the number of rows", async () => {
    const workspaceId = await freshWorkspaceId("ingestion-both");
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 30, replayCount: 5, payloadPurgedAt: new Date() });
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 40 }); // a plain stuck row, same workspace

    const now = new Date();
    const snapshot = await withCrossWorkspaceScan((client) => readIngestionHealth(client, now));

    expect(snapshot.unrecoverableCount).toBe(1);
    expect(snapshot.attemptCappedCount).toBe(0);
    expect(snapshot.stuckCount).toBe(1);
    expect(snapshot.unrecoverableCount + snapshot.attemptCappedCount + snapshot.stuckCount).toBe(2);
  });

  it("with only tombstones purged OLDER than INGESTION_UNRECOVERABLE_ALERT_WINDOW_HOURS, and zero stuck/capped rows, one check calls sendMail zero times", async () => {
    const workspaceId = await freshWorkspaceId("ingestion-old-tombstone");
    const oldPurge = new Date(Date.now() - (INGESTION_UNRECOVERABLE_ALERT_WINDOW_HOURS + 10) * 60 * 60 * 1000);
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 24 * 60, payloadPurgedAt: oldPurge });

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkIngestionHealthAndAlert({ client: pool, now: new Date(), operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(0);
  });

  it("with one tombstone purged WITHIN the window and zero stuck rows, one check calls sendMail exactly once, and old tombstones still count toward the reported total", async () => {
    const workspaceId = await freshWorkspaceId("ingestion-mixed-tombstones");
    const oldPurge = new Date(Date.now() - (INGESTION_UNRECOVERABLE_ALERT_WINDOW_HOURS + 10) * 60 * 60 * 1000);
    const recentPurge = new Date();
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 24 * 60, payloadPurgedAt: oldPurge });
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 20, payloadPurgedAt: recentPurge });

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkIngestionHealthAndAlert({ client: pool, now: new Date(), operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(1);
    // Full standing tombstone total (both rows), not only the recently purged one.
    expect(sent[0]?.text).toContain("Permanently unrecoverable rows (payload purged): 2");
    expect(sent[0]?.text).toContain("of which purged in the last");
  });

  it("with three stuck journal rows seeded, one check calls sendMail exactly once and the rendered text contains the count 3", async () => {
    const workspaceId = await freshWorkspaceId("ingestion-three-stuck");
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 20 });
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 30 });
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 40, payloadMarker: "do-not-leak-marker" });

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkIngestionHealthAndAlert({ client: pool, now: new Date(), operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("Stuck rows (still retrying): 3");
    expect(sent[0]?.text).toContain(workspaceId);
    expect(sent[0]?.text).not.toContain("do-not-leak-marker");
    expect(sent[0]?.text).not.toMatch(/@example\.com/);
  });

  it("with zero stuck rows, one check calls sendMail zero times and never touches ingestion_alert_state", async () => {
    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkIngestionHealthAndAlert({ client: pool, now: new Date(), operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(0);

    const { rows } = await pool.query<{ last_alert_sent_at: Date | null }>(
      "SELECT last_alert_sent_at FROM ingestion_alert_state WHERE id = 1",
    );
    expect(rows[0]?.last_alert_sent_at).toBeNull();
  });

  it("at most one send per INGESTION_ALERT_DEDUP_HOURS window, even across repeated unhealthy checks", async () => {
    const workspaceId = await freshWorkspaceId("ingestion-dedup");
    const t1 = new Date("2027-07-01T00:00:00Z");
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 30 });

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkIngestionHealthAndAlert({ client: pool, now: t1, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(1);

    const t2 = new Date(t1.getTime() + 60_000);
    await checkIngestionHealthAndAlert({ client: pool, now: t2, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(1);

    const t3 = new Date(t1.getTime() + (INGESTION_ALERT_DEDUP_HOURS + 1) * 60 * 60 * 1000);
    await checkIngestionHealthAndAlert({ client: pool, now: t3, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(2);
  });

  it("claimIngestionAlertSlot's own atomicity -- a second claim inside the window is refused", async () => {
    const t1 = new Date("2027-07-10T00:00:00Z");
    const firstClaim = await claimIngestionAlertSlot(pool, t1, INGESTION_ALERT_DEDUP_HOURS);
    expect(firstClaim).toBe(true);

    const secondClaim = await claimIngestionAlertSlot(pool, new Date(t1.getTime() + 60_000), INGESTION_ALERT_DEDUP_HOURS);
    expect(secondClaim).toBe(false);
  });

  it("two concurrent replicas checking the same unhealthy platform state produce exactly one send", async () => {
    const workspaceId = await freshWorkspaceId("ingestion-race");
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 30 });

    const dsn = getTestDatabaseUrl();
    const poolA = new Pool({ connectionString: dsn, max: 2 });
    const poolB = new Pool({ connectionString: dsn, max: 2 });
    poolA.on("error", () => undefined);
    poolB.on("error", () => undefined);

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };
    const now = new Date();

    try {
      await Promise.all([
        checkIngestionHealthAndAlert({ client: poolA, now, operatorEmail: "ops@example.com", sendMail }),
        checkIngestionHealthAndAlert({ client: poolB, now, operatorEmail: "ops@example.com", sendMail }),
      ]);
    } finally {
      await poolA.end();
      await poolB.end();
    }

    expect(sent).toHaveLength(1);
  });

  it("a rejecting sendMail causes checkIngestionHealthAndAlert to reject, never swallowed, and does not permanently burn the dedup window", async () => {
    const workspaceId = await freshWorkspaceId("ingestion-release");
    const now = new Date();
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 30 });

    await expect(
      checkIngestionHealthAndAlert({
        client: pool,
        now,
        operatorEmail: "ops@example.com",
        sendMail: () => Promise.reject(new Error("sendgrid down")),
      }),
    ).rejects.toThrow("sendgrid down");

    const { rows } = await pool.query<{ last_alert_sent_at: Date | null }>(
      "SELECT last_alert_sent_at FROM ingestion_alert_state WHERE id = 1",
    );
    expect(rows[0]?.last_alert_sent_at).toBeNull();

    const sent: Array<{ to: string; text: string }> = [];
    await checkIngestionHealthAndAlert({
      client: pool,
      now: new Date(now.getTime() + 1_000),
      operatorEmail: "ops@example.com",
      // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
      sendMail: async (message) => {
        sent.push(message);
      },
    });
    expect(sent).toHaveLength(1);
  });
});

describe("startIngestionHealthWatchdog", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Unlike every sibling watchdog's identical test (a rejecting injected
   * `client` proves the interval-catch), this module's health READ never
   * touches the injected `client` at all -- it always goes through the real
   * scan pool (`withCrossWorkspaceScan`, this module's own header comment).
   * The realistic failure this module can actually suffer in production is
   * exactly the T-13-11-08 operational-prerequisite gap: `SCAN_DATABASE_URL`
   * absent from `process.env`. `closeScanPool()` discards the cached scan
   * pool a PRIOR test in this file already constructed (module-level
   * singleton, lazy on first call) so removing the env var here actually
   * takes effect on the next `getScanPool()` call.
   */
  it("returns an interval handle and a check that fails at the scan layer (SCAN_DATABASE_URL unset) is caught and logged rather than escaping", async () => {
    await closeScanPool();
    const previousScanUrl = process.env.SCAN_DATABASE_URL;
    delete process.env.SCAN_DATABASE_URL;

    vi.useFakeTimers();
    const scrubbedErrorSpy = vi.spyOn(scrubbedConsole, "error").mockImplementation(() => undefined);

    const client = {
      query: () => Promise.reject(new Error("should never be reached -- the scan layer fails first")),
    };
    const handle = startIngestionHealthWatchdog({
      client,
      operatorEmail: "ops@example.com",
      sendMail: () => Promise.resolve(),
    });

    expect(handle).toBeDefined();

    await vi.advanceTimersByTimeAsync(INGESTION_WATCHDOG_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(scrubbedErrorSpy).toHaveBeenCalledWith(
      "ingestion-health-watchdog: health check failed",
      expect.anything(),
    );

    clearInterval(handle);
    if (previousScanUrl !== undefined) {
      process.env.SCAN_DATABASE_URL = previousScanUrl;
    }
  });
});
