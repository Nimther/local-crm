import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { createTestPool, ensureTestDbMigrated, getScanTestDatabaseUrl, getTestDatabaseUrl } from "@mega-crm/test-support";
import { RECONCILE_RESOLUTION_WINDOW_MS } from "@mega-crm/delivery-core";

import { processSendJob } from "../../send-dispatch.js";
import { runReconcilerTick } from "../../send-reconciler.worker.js";
import {
  arrangeCrashedBeforeResultWrite,
  connectFixtureSendgridKey,
  countingSendMail,
  createFixtureCampaign,
  createFixtureContact,
  freshWorkspaceId,
  sendsRowCountFor,
  sendsStatusFor,
} from "../../../test/failure-fixtures.js";

/**
 * 11-11 (DLV-08 boundary 3) — a process that received a definite SendGrid
 * response but died before its own unit-3 record transaction ran, in both
 * response shapes: a 202 the process never got to record, and a permanent
 * 4xx it never got to record.
 *
 * Covered state-based rather than kill-based — see
 * `arrangeCrashedBeforeResultWrite`'s own doc comment in
 * `failure-fixtures.ts` for why: boundaries 2 and 3 leave an IDENTICAL
 * ledger state (a committed `dispatching` claim with no terminal row), so a
 * second real-kill harness here would add process machinery without adding
 * a new assertion. What actually differs between the two variants below is
 * the response the process received but never recorded.
 *
 * Reproduce with `npm run failure:crash-pre-result-write` from the repo root.
 */
describe("failure injection: crashed before the result write, both response variants (DLV-08 boundary 3)", () => {
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

  async function campaignCountersFor(
    workspaceId: string,
    campaignId: string,
  ): Promise<{ sentCount: number; failedCount: number }> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ sentCount: number; failedCount: number }>(
          `SELECT sent_count as "sentCount", failed_count as "failedCount" FROM campaigns WHERE id = $1`,
          [campaignId],
        );
        if (!rows[0]) throw new Error("test setup failure: no campaign row found");
        return rows[0];
      }),
    );
  }

  async function insertSendEventEvidence(workspaceId: string, sendId: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, payload, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'processed', '{}'::jsonb, now())`,
          [workspaceId, `sg-evt-pre-result-${sendId}-${Date.now()}`, sendId],
        ),
      ),
    );
  }

  async function backdateReconcilingSince(workspaceId: string, sendId: string, agoMs: number): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(`UPDATE sends SET reconciling_since = now() - ($2::bigint * INTERVAL '1 millisecond') WHERE id = $1`, [
          sendId,
          agoMs,
        ]),
      ),
    );
  }

  it("202 variant: redelivery resolves to reconciling with zero calls, then to sent once evidence arrives", async () => {
    const workspaceId = await freshWorkspaceId(pool, "crash-pre-write-202");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const { sendId } = await arrangeCrashedBeforeResultWrite(workspaceId, campaignId, contactId, {
      status: 202,
      headers: new Headers(),
      messageId: "sg-message-id-fixture",
    });

    const counting = countingSendMail(202);
    const redelivered = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient },
    );

    expect(
      counting.callCount(),
      "a 202 response was already received once — a redelivery must never call SendGrid again",
    ).toBe(0);
    expect(redelivered.outcome).toBe("reconciling");
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("reconciling");
    expect(await sendsRowCountFor(workspaceId, campaignId, contactId)).toBe(1);

    const countersBeforeTick = await campaignCountersFor(workspaceId, campaignId);
    expect(countersBeforeTick.sentCount).toBe(0);
    expect(countersBeforeTick.failedCount).toBe(0);

    await insertSendEventEvidence(workspaceId, sendId);
    const tick = await runReconcilerTick();
    expect(tick.resolvedSent).toBeGreaterThanOrEqual(1);

    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("sent");
    const countersAfter = await campaignCountersFor(workspaceId, campaignId);
    expect(countersAfter.sentCount).toBe(1);
  });

  it("4xx variant: redelivery resolves to reconciling with zero calls, then to unknown — never failed — once the resolution window elapses", async () => {
    const workspaceId = await freshWorkspaceId(pool, "crash-pre-write-4xx");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const { sendId } = await arrangeCrashedBeforeResultWrite(workspaceId, campaignId, contactId, {
      status: 400,
      headers: new Headers(),
      messageId: null,
    });

    const counting = countingSendMail(202);
    const redelivered = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient },
    );

    expect(
      counting.callCount(),
      "a definite 4xx response was already received once — a redelivery must never call SendGrid again",
    ).toBe(0);
    expect(redelivered.outcome).toBe("reconciling");
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("reconciling");

    // The platform will not infer failure from an unrecorded response — this
    // is the accepted, documented cost of at-most-once (ARCHITECTURE.md ##9,
    // "Why the reconciler never writes failed"). A future reader who "fixes"
    // this by teaching the reconciler to treat a stale reconciling row as
    // failed would reintroduce the exact class of unfounded assertion this
    // phase removed — a `failed` row here would tell an operator "nothing
    // was sent" when this test's own arrangement proves SendGrid DID
    // respond, just not with success.
    await backdateReconcilingSince(workspaceId, sendId, RECONCILE_RESOLUTION_WINDOW_MS + 60_000);
    const tick = await runReconcilerTick();
    expect(tick.markedUnknown).toBeGreaterThanOrEqual(1);

    const finalStatus = await sendsStatusFor(workspaceId, campaignId, contactId);
    expect(finalStatus, "the platform assumes rejection no more readily than it assumes acceptance").not.toBe("failed");
    expect(finalStatus).toBe("unknown");

    const counters = await campaignCountersFor(workspaceId, campaignId);
    expect(counters.sentCount).toBe(0);
    expect(counters.failedCount).toBe(0);
  });
});
