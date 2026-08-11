import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { createTestPool, ensureTestDbMigrated, getScanTestDatabaseUrl, getTestDatabaseUrl } from "@mega-crm/test-support";
import { dispatchSendGate } from "@mega-crm/delivery-core";

import { processSendJob } from "../../send-dispatch.js";
import { runReconcilerTick } from "../../send-reconciler.worker.js";
import { connectFixtureSendgridKey, countingSendMail, createFixtureCampaign, createFixtureContact, freshWorkspaceId } from "../../../test/failure-fixtures.js";

/**
 * 11-11 (DLV-08's three-way race, ROADMAP SC2) — the scenario the ROADMAP
 * calls out explicitly as more than the three named crash points: a
 * reconciler tick and a retry-worker redelivery racing over the SAME
 * `reconciling` row at the SAME instant, via genuine `Promise.all`
 * concurrency. This is the only test file in this suite where both writers
 * permitted anywhere near a `reconciling` row (DLV-04's writer matrix) are
 * actually live at once, rather than one after the other — every other
 * scenario proves a single writer's behavior; this one proves the
 * exclusivity guarantee between the two.
 *
 * DLV-04's exclusivity comes from the RETRY WORKER's side, not from row
 * locking alone: `dispatchSendGate`'s fourth status branch treats an
 * existing `reconciling`/`unknown` row as "not my job" and returns
 * `"skipped"` WITHOUT ever calling SendGrid — this is what guarantees no
 * double-send regardless of which writer's transaction happens to win the
 * underlying row lock first. The reconciler's own `FOR UPDATE SKIP LOCKED`
 * only protects reconciler-vs-reconciler. Because `dispatchSendGate`'s
 * existing-row lookup takes a plain (non-`SKIP LOCKED`) `FOR UPDATE`, it is
 * possible — though not the common case, since the reconciler's discovery
 * scan is the slower of the two paths — for it to win the row lock ahead of
 * the reconciler's own claim attempt within a SINGLE tick; when that
 * happens the reconciler's `SKIP LOCKED` observes zero claimable rows for
 * that row THIS tick and reports `hold`, exactly as it would for a row a
 * concurrent reconciler pass already claimed. That is not a bug — a
 * production reconciler simply resolves the row on its NEXT tick — so this
 * test tolerates it by re-ticking until the row resolves, while treating
 * "the retry worker never calls the provider and never itself transitions
 * the row" as the hard, per-iteration invariant that actually proves
 * DLV-04's safety guarantee.
 *
 * Reproduce with `npm run failure:reconciler-race` from the repo root.
 */
describe("failure injection: reconciler tick vs. retry-worker redelivery, racing the same row (DLV-08 three-way race)", () => {
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

  /** Seeds a `reconciling` row, already carrying correlated evidence, ready for the reconciler to resolve on its next actionable tick. */
  async function seedReconcilingWithEvidence(workspaceId: string, campaignId: string, contactId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const claim = await dispatchSendGate(client, { workspaceId, campaignId, contactId });
        if (claim === "skipped" || !claim.sendId) {
          throw new Error("test setup failure: expected a fresh dispatchSendGate claim");
        }
        const sendId = claim.sendId;
        await client.query(
          `UPDATE sends SET status = 'reconciling'::send_status, reconciling_since = now() - interval '10 minutes' WHERE id = $1`,
          [sendId],
        );
        await client.query(
          `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, payload, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'processed', '{}'::jsonb, now())`,
          [workspaceId, `sg-evt-race-${sendId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sendId],
        );
        return sendId;
      }),
    );
  }

  async function sentCountFor(workspaceId: string, campaignId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ sentCount: number }>(`SELECT sent_count as "sentCount" FROM campaigns WHERE id = $1`, [
          campaignId,
        ]);
        if (!rows[0]) throw new Error("test setup failure: no campaign row found");
        return rows[0].sentCount;
      }),
    );
  }

  async function statusFor(workspaceId: string, sendId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ status: string }>(`SELECT status FROM sends WHERE id = $1`, [sendId]);
        if (!rows[0]) throw new Error("test setup failure: no sends row found");
        return rows[0].status;
      }),
    );
  }

  const ITERATIONS = 10;
  /** A losing SKIP LOCKED race (see file header) means the row may not resolve on the FIRST tick — bounded so a genuine bug still fails fast. */
  const MAX_SETTLE_TICKS = 5;

  it(`races a reconciler tick against a retry-worker redelivery over ${ITERATIONS} fresh intents, with no double-send and no double-count`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const workspaceId = await freshWorkspaceId(pool, `reconciler-race-${i}`);
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);

      const sendId = await seedReconcilingWithEvidence(workspaceId, campaignId, contactId);
      const counting = countingSendMail(202);

      // Genuine concurrency: both writers race the SAME row at the SAME
      // instant, not one after the other.
      const [tickResult, redeliveryResult] = await Promise.all([
        runReconcilerTick(),
        processSendJob({ workspaceId, campaignId, kind: "campaign", contactId }, { sendMail: counting.fn, redisClient }),
      ]);

      // --- the hard, per-iteration safety invariants --------------------
      expect(counting.callCount(), `iteration ${i}: the retry worker's claim gate must refuse a reconciling row`).toBe(0);
      expect(redeliveryResult.outcome, `iteration ${i}: the retry worker never transitions a reconciling row`).toBe("skipped");
      expect(
        tickResult.resolvedSent <= 1,
        `iteration ${i}: a single tick must resolve at most this one seeded row for this workspace`,
      ).toBe(true);

      // --- liveness: the row eventually resolves, via this tick or a
      // follow-up one if the retry worker happened to win the row lock
      // first (see file header) --------------------------------------------
      let settled = await statusFor(workspaceId, sendId);
      let extraTicks = 0;
      while (settled === "reconciling" && extraTicks < MAX_SETTLE_TICKS) {
        await runReconcilerTick();
        settled = await statusFor(workspaceId, sendId);
        extraTicks += 1;
      }

      expect(settled, `iteration ${i}: exactly one terminal state, and it is sent`).toBe("sent");
      expect(
        await sentCountFor(workspaceId, campaignId),
        `iteration ${i}: sent_count increased by exactly one, not two`,
      ).toBe(1);
    }
  });
});
