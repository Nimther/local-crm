import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { encryptTenantSecret } from "@mega-crm/kms";
import { getScanTestDatabaseUrl } from "@mega-crm/test-support";
import {
  dispatchSendGate,
  claimFlowSend,
  RECONCILE_RESOLUTION_WINDOW_MS,
  RECONCILE_RESCAN_HORIZON_MS,
  STALE_DISPATCHING_AGE_MS,
} from "@mega-crm/delivery-core";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool, createFixtureFlowRun } from "../../test/db-fixture.js";
import { findReconcilableCandidates, runReconcilerTick, RECONCILER_BATCH_LIMIT } from "../send-reconciler.worker.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * Phase 11 (DLV-03/DLV-04, plan 11-08, Task 3): every `<behavior>` item for
 * the full reconciler verdict wiring -- `resolve_sent`/`resolve_unknown`/
 * `sweep_to_reconciling`/`hold`, the campaign-counter backfill's
 * exactly-once guarantee, the flow-kind no-counter-call case, the
 * batch-limit cap, and the two-concurrent-ticks exclusivity proof. Age-
 * dependent cases are arranged by back-dating `queued_at`/`reconciling_since`
 * with explicit `UPDATE` statements, never fake timers, so the SQL age
 * comparison under test is the SAME one production runs.
 */
describe("send-reconciler.worker.ts full verdict wiring (DLV-03/DLV-04, plan 11-08)", () => {
  let pool: Pool;
  let redisClient: Redis;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    process.env.SCAN_DATABASE_URL = getScanTestDatabaseUrl();
    pool = createTestPool();
    redisClient = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/1");
  });

  afterAll(async () => {
    await pool.end();
    await redisClient.quit();
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  async function connectFixtureSendgridKey(workspaceId: string): Promise<void> {
    const encrypted = await encryptTenantSecret(workspaceId, "SG.fixture_test_key_0000000000000000");
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO workspace_sendgrid_keys (workspace_id, encrypted_dek, ciphertext, iv, auth_tag, key_mask, status)
           VALUES ($1, $2, $3, $4, $5, 'SG.fi…0000', 'active')`,
          [workspaceId, encrypted.encryptedDek, encrypted.ciphertext, encrypted.iv, encrypted.authTag]
        )
      )
    );
  }

  async function createFixtureCampaign(
    workspaceId: string,
    overrides: { sendableTotal: number; fanOutComplete: boolean }
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }]
        );
        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, sendable_total, fan_out_complete, created_by_user_id)
           VALUES ($1, 'Fixture campaign', 'sending', $2, 'd-fixture-template', 'sender@fixture.test', $3, $4, 'test-user')
           RETURNING id`,
          [workspaceId, segmentRows[0].id, overrides.sendableTotal, overrides.fanOutComplete]
        );
        return campaignRows[0].id;
      })
    );
  }

  async function createFixtureContact(workspaceId: string): Promise<string> {
    const email = `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', 'subscribed') RETURNING id`,
          [workspaceId, email]
        );
        return rows[0].id;
      })
    );
  }

  async function setCampaignStatus(workspaceId: string, campaignId: string, status: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(`UPDATE campaigns SET status = $2::campaign_status WHERE id = $1`, [campaignId, status])
      )
    );
  }

  interface CampaignSnapshot {
    status: string;
    sentCount: number;
    failedCount: number;
  }

  async function getCampaignSnapshot(workspaceId: string, campaignId: string): Promise<CampaignSnapshot> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<CampaignSnapshot>(
          `SELECT status, sent_count as "sentCount", failed_count as "failedCount" FROM campaigns WHERE id = $1`,
          [campaignId]
        );
        return rows[0];
      })
    );
  }

  interface SendRow {
    id: string;
    status: string;
    sentAt: Date | null;
    reconcilingSince: Date | null;
    queuedAt: Date;
  }

  async function sendRowById(workspaceId: string, sendId: string): Promise<SendRow> {
    const row = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<SendRow>(
          `SELECT id, status, sent_at as "sentAt", reconciling_since as "reconcilingSince", queued_at as "queuedAt"
           FROM sends WHERE id = $1`,
          [sendId]
        );
        return rows[0];
      })
    );
    if (!row) throw new Error(`test assertion failure: no sends row for id ${sendId}`);
    return row;
  }

  /** Inserts a raw send_events row correlated by send_id -- the ONLY evidence the reconciler may read (D-01/D-05). */
  async function insertSendEventEvidence(workspaceId: string, sendId: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, payload, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'processed', '{}'::jsonb, now())`,
          [workspaceId, `sg-evt-${sendId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sendId]
        )
      )
    );
  }

  /** Claims a fresh campaign send via the real gate, then force-writes status/age columns -- mirrors claim-gate-exclusivity.test.ts's own convention. */
  async function claimCampaignSendAt(
    workspaceId: string,
    campaignId: string,
    contactId: string,
    overrides: { status: string; queuedAgoMs?: number; reconcilingSinceAgoMs?: number | null }
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const claim = await dispatchSendGate(client, { workspaceId, campaignId, contactId });
        if (claim === "skipped" || !claim.sendId) {
          throw new Error("test setup failure: expected a fresh dispatchSendGate claim");
        }
        const sendId = claim.sendId;
        await client.query(`UPDATE sends SET status = $2::send_status WHERE id = $1`, [sendId, overrides.status]);
        if (overrides.queuedAgoMs !== undefined) {
          await client.query(`UPDATE sends SET queued_at = now() - ($2::bigint * INTERVAL '1 millisecond') WHERE id = $1`, [
            sendId,
            overrides.queuedAgoMs,
          ]);
        }
        if (overrides.reconcilingSinceAgoMs !== undefined) {
          if (overrides.reconcilingSinceAgoMs === null) {
            await client.query(`UPDATE sends SET reconciling_since = NULL WHERE id = $1`, [sendId]);
          } else {
            await client.query(
              `UPDATE sends SET reconciling_since = now() - ($2::bigint * INTERVAL '1 millisecond') WHERE id = $1`,
              [sendId, overrides.reconcilingSinceAgoMs]
            );
          }
        }
        return sendId;
      })
    );
  }

  describe("resolve_sent (evidence found)", () => {
    it("a reconciling row with correlated evidence resolves to sent and increments sent_count by exactly one, even when the campaign is already 'sent'", async () => {
      const workspaceId = await freshWorkspaceId("verdicts-resolve-sent-already-sent-campaign");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
      const contactId = await createFixtureContact(workspaceId);

      const sendId = await claimCampaignSendAt(workspaceId, campaignId, contactId, { status: "reconciling" });
      await insertSendEventEvidence(workspaceId, sendId);
      await setCampaignStatus(workspaceId, campaignId, "sent");

      const tick = await runReconcilerTick();
      expect(tick.resolvedSent).toBeGreaterThanOrEqual(1);

      const afterRow = await sendRowById(workspaceId, sendId);
      expect(afterRow.status).toBe("sent");
      expect(afterRow.reconcilingSince).toBeNull();
      expect(afterRow.sentAt).not.toBeNull();

      const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
      expect(snapshot.sentCount, "backfillCampaignSendCounter must fire even though the campaign is already 'sent'").toBe(
        1
      );

      // Running the tick again over the SAME row changes nothing and
      // increments no counter -- exactly-once, not merely once-so-far.
      const secondTick = await runReconcilerTick();
      const rowAfterSecondTick = await sendRowById(workspaceId, sendId);
      const snapshotAfterSecondTick = await getCampaignSnapshot(workspaceId, campaignId);
      expect(rowAfterSecondTick.status).toBe("sent");
      expect(rowAfterSecondTick.sentAt?.getTime()).toBe(afterRow.sentAt?.getTime());
      expect(snapshotAfterSecondTick.sentCount, "a second tick must not double-count").toBe(1);
      expect(secondTick.resolvedSent, "the row is already terminal -- no further resolution to count").toBe(0);
    });
  });

  describe("resolve_unknown (resolution window elapsed, no evidence)", () => {
    it("a reconciling row older than the resolution window with no evidence resolves to unknown, and neither counter moves", async () => {
      const workspaceId = await freshWorkspaceId("verdicts-resolve-unknown");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
      const contactId = await createFixtureContact(workspaceId);

      const sendId = await claimCampaignSendAt(workspaceId, campaignId, contactId, {
        status: "reconciling",
        reconcilingSinceAgoMs: RECONCILE_RESOLUTION_WINDOW_MS + 60_000,
      });

      const tick = await runReconcilerTick();
      expect(tick.markedUnknown).toBeGreaterThanOrEqual(1);

      const afterRow = await sendRowById(workspaceId, sendId);
      expect(afterRow.status).toBe("unknown");
      expect(afterRow.sentAt).toBeNull();

      const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
      expect(snapshot.sentCount).toBe(0);
      expect(snapshot.failedCount).toBe(0);
    });
  });

  describe("unknown -> resolve_sent (late evidence within the re-scan horizon, D-04)", () => {
    it("an unknown row that gains evidence inside the re-scan horizon upgrades to sent and increments sent_count exactly once", async () => {
      const workspaceId = await freshWorkspaceId("verdicts-unknown-late-evidence");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
      const contactId = await createFixtureContact(workspaceId);

      const sendId = await claimCampaignSendAt(workspaceId, campaignId, contactId, {
        status: "unknown",
        queuedAgoMs: RECONCILE_RESCAN_HORIZON_MS - 60_000,
      });

      // Confirm it was never counted while unknown (no evidence yet).
      const beforeTick = await runReconcilerTick();
      expect(beforeTick.resolvedSent).toBe(0);
      const snapshotBefore = await getCampaignSnapshot(workspaceId, campaignId);
      expect(snapshotBefore.sentCount).toBe(0);

      await insertSendEventEvidence(workspaceId, sendId);
      const tick = await runReconcilerTick();
      expect(tick.resolvedSent).toBeGreaterThanOrEqual(1);

      const afterRow = await sendRowById(workspaceId, sendId);
      expect(afterRow.status).toBe("sent");

      const snapshotAfter = await getCampaignSnapshot(workspaceId, campaignId);
      expect(snapshotAfter.sentCount, "it was never counted while unknown -- this is the ONLY increment").toBe(1);
    });

    it("an unknown row PAST the horizon is not re-examined even when evidence exists", async () => {
      const workspaceId = await freshWorkspaceId("verdicts-unknown-past-horizon");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
      const contactId = await createFixtureContact(workspaceId);

      const sendId = await claimCampaignSendAt(workspaceId, campaignId, contactId, {
        status: "unknown",
        queuedAgoMs: RECONCILE_RESCAN_HORIZON_MS + 60_000,
      });
      await insertSendEventEvidence(workspaceId, sendId);

      const tick = await runReconcilerTick();
      expect(tick.resolvedSent).toBe(0);

      const afterRow = await sendRowById(workspaceId, sendId);
      expect(afterRow.status, "immutable after the horizon, even with evidence present").toBe("unknown");

      const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
      expect(snapshot.sentCount).toBe(0);
    });
  });

  describe("sweep_to_reconciling (stale-dispatching sweep, D-08)", () => {
    it("a dispatching row older than the stale threshold is swept to reconciling with reconciling_since set, and resolves via a subsequent tick", async () => {
      const workspaceId = await freshWorkspaceId("verdicts-sweep-stale");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
      const contactId = await createFixtureContact(workspaceId);

      const sendId = await claimCampaignSendAt(workspaceId, campaignId, contactId, {
        status: "dispatching",
        queuedAgoMs: STALE_DISPATCHING_AGE_MS + 60_000,
      });

      const firstTick = await runReconcilerTick();
      expect(firstTick.swept).toBeGreaterThanOrEqual(1);

      const sweptRow = await sendRowById(workspaceId, sendId);
      expect(sweptRow.status).toBe("reconciling");
      expect(sweptRow.reconcilingSince).not.toBeNull();

      // Swept row is NOT re-classified in the same tick/transaction -- it
      // resolves on a LATER tick through the normal evidence path.
      await insertSendEventEvidence(workspaceId, sendId);
      const secondTick = await runReconcilerTick();
      expect(secondTick.resolvedSent).toBeGreaterThanOrEqual(1);

      const resolvedRow = await sendRowById(workspaceId, sendId);
      expect(resolvedRow.status).toBe("sent");
    });

    it("a dispatching row newer than the stale threshold is left alone", async () => {
      const workspaceId = await freshWorkspaceId("verdicts-no-sweep-fresh");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
      const contactId = await createFixtureContact(workspaceId);

      const sendId = await claimCampaignSendAt(workspaceId, campaignId, contactId, {
        status: "dispatching",
        queuedAgoMs: 1_000,
      });

      const tick = await runReconcilerTick();
      expect(tick.swept).toBe(0);

      const afterRow = await sendRowById(workspaceId, sendId);
      expect(afterRow.status).toBe("dispatching");
    });
  });

  describe("flow-kind sends never touch a campaign counter or completion check", () => {
    it("a flow-kind send (null campaign_id) resolves to sent without attempting any campaign-counter or campaign-completion call", async () => {
      const workspaceId = await freshWorkspaceId("verdicts-flow-kind");
      await connectFixtureSendgridKey(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);

      const sendId = await withTenant(workspaceId, () =>
        withTenantTransaction(async (client) => {
          const claim = await claimFlowSend(client, { workspaceId, flowRunId, nodeId, contactId });
          if (claim === "skipped" || !claim.sendId) {
            throw new Error("test setup failure: expected a fresh claimFlowSend claim");
          }
          await client.query(`UPDATE sends SET status = 'reconciling' WHERE id = $1`, [claim.sendId]);
          return claim.sendId;
        })
      );
      await insertSendEventEvidence(workspaceId, sendId);

      // No throw is itself the proof that resolveOneSend's campaignId-null
      // guard skipped the counter/completion calls -- backfillCampaignSendCounter/
      // tryCompleteCampaign would both fail on a null campaignId parameter.
      const tick = await runReconcilerTick();
      expect(tick.resolvedSent).toBeGreaterThanOrEqual(1);

      const afterRow = await sendRowById(workspaceId, sendId);
      expect(afterRow.status).toBe("sent");
    });
  });

  describe("no network call anywhere in a full tick pass (D-01/D-05)", () => {
    let originalFetch: typeof fetch;
    let fetchCalls: number;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      fetchCalls = 0;
      globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
        fetchCalls += 1;
        return originalFetch(...args);
      };
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("a full tick over reconciling/unknown/stale-dispatching candidates makes zero network calls", async () => {
      const workspaceId = await freshWorkspaceId("verdicts-no-network");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 3, fanOutComplete: true });
      const evidenceContact = await createFixtureContact(workspaceId);
      const noEvidenceContact = await createFixtureContact(workspaceId);
      const staleContact = await createFixtureContact(workspaceId);

      const evidenceSendId = await claimCampaignSendAt(workspaceId, campaignId, evidenceContact, {
        status: "reconciling",
      });
      await insertSendEventEvidence(workspaceId, evidenceSendId);
      await claimCampaignSendAt(workspaceId, campaignId, noEvidenceContact, {
        status: "reconciling",
        reconcilingSinceAgoMs: RECONCILE_RESOLUTION_WINDOW_MS + 60_000,
      });
      await claimCampaignSendAt(workspaceId, campaignId, staleContact, {
        status: "dispatching",
        queuedAgoMs: STALE_DISPATCHING_AGE_MS + 60_000,
      });

      await runReconcilerTick();

      expect(fetchCalls, "the reconciler must never call the provider (D-01/D-05)").toBe(0);
    });
  });

  describe("exclusivity: two concurrent ticks produce exactly one terminal write per row (DLV-04)", () => {
    it("Promise.all over two runReconcilerTick() calls resolves each seeded row exactly once, with no error", async () => {
      const workspaceId = await freshWorkspaceId("verdicts-concurrency");
      await connectFixtureSendgridKey(workspaceId);

      const rowCount = 5;
      const campaignIds: string[] = [];
      for (let i = 0; i < rowCount; i += 1) {
        const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
        const contactId = await createFixtureContact(workspaceId);
        const sendId = await claimCampaignSendAt(workspaceId, campaignId, contactId, { status: "reconciling" });
        await insertSendEventEvidence(workspaceId, sendId);
        campaignIds.push(campaignId);
      }

      const [tickA, tickB] = await Promise.all([runReconcilerTick(), runReconcilerTick()]);
      expect(tickA.resolvedSent + tickB.resolvedSent).toBe(rowCount);

      for (const campaignId of campaignIds) {
        const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
        expect(snapshot.sentCount, "exactly one terminal write per row -- never double-counted").toBe(1);
        expect(snapshot.status).toBe("sent");
      }
    });
  });

  /**
   * Deliberately LAST in this file: this describe block's second test seeds
   * MORE 'reconciling' rows than `RECONCILER_BATCH_LIMIT` itself. Since
   * discovery orders by `queued_at ASC`, those rows would sort ahead of any
   * EARLIER test's much smaller candidate set and starve it out of the
   * LIMIT entirely if this block ran first. Running last (plus this test's
   * own cleanup DELETE) keeps every test above exact-count-safe.
   */
  describe("runReconcilerTick's counts and batch cap", () => {
    it("returns all four per-verdict counts (scanned, resolvedSent, markedUnknown, swept)", async () => {
      const workspaceId = await freshWorkspaceId("verdicts-tick-counts");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
      const contactId = await createFixtureContact(workspaceId);
      const sendId = await claimCampaignSendAt(workspaceId, campaignId, contactId, { status: "reconciling" });
      await insertSendEventEvidence(workspaceId, sendId);

      const tick = await runReconcilerTick();
      expect(tick).toHaveProperty("scanned");
      expect(tick).toHaveProperty("resolvedSent");
      expect(tick).toHaveProperty("markedUnknown");
      expect(tick).toHaveProperty("swept");
      expect(tick.scanned).toBeGreaterThanOrEqual(1);
    });

    it("never exceeds RECONCILER_BATCH_LIMIT candidates in one discovery pass", async () => {
      const workspaceId = await freshWorkspaceId("verdicts-batch-cap");
      const seedCount = RECONCILER_BATCH_LIMIT + 5;

      const { rows: contactRows } = await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          client.query<{ id: string }>(
            `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
             SELECT $1, 'batch-' || gs || '-' || $2 || '@fixture.test', 'Fixture', 'subscribed'
             FROM generate_series(1, $3) AS gs
             RETURNING id`,
            [workspaceId, Date.now(), seedCount]
          )
        )
      );
      expect(contactRows.length).toBe(seedCount);

      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          client.query(
            `INSERT INTO sends (workspace_id, contact_id, kind, status, queued_at)
             SELECT $1, id, 'campaign', 'reconciling', now() FROM contacts WHERE id = ANY($2::uuid[])`,
            [workspaceId, contactRows.map((r) => r.id)]
          )
        )
      );

      const candidates = await findReconcilableCandidates();
      const thisWorkspaceCandidates = candidates.filter((c) => c.workspaceId === workspaceId);
      // The global cap applies across ALL workspaces' candidates combined --
      // this workspace alone seeded MORE than the cap, so the overall
      // result can never exceed it regardless of how many other candidates
      // exist concurrently in the shared test database.
      expect(candidates.length).toBeLessThanOrEqual(RECONCILER_BATCH_LIMIT);
      expect(thisWorkspaceCandidates.length).toBeLessThanOrEqual(RECONCILER_BATCH_LIMIT);

      // Cleanup: this test seeds MORE 'reconciling' rows than the shared
      // discovery LIMIT itself. Left in place, they would starve out any
      // LATER test's own (much smaller) candidate set from ever being
      // scanned at all, since the discovery query orders by queued_at ASC
      // -- these rows, seeded first, would always sort first. Deleting the
      // contacts cascades to their sends rows (contacts.id -> sends.contact_id
      // is ON DELETE CASCADE), removing this test's footprint entirely --
      // this is also the LAST test in this file, so there is nothing left
      // to starve regardless.
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) => client.query(`DELETE FROM contacts WHERE workspace_id = $1`, [workspaceId]))
      );
    });
  });
});
