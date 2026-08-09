import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { encryptTenantSecret } from "@mega-crm/kms";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processSendJob } from "../send-dispatch.js";
import {
  dispatchSendGate,
  resolveReconcilingSend,
  sweepStaleDispatchingSend,
  backfillCampaignSendCounter,
  incrementCampaignSendCounter,
  tryCompleteCampaign,
} from "@mega-crm/delivery-core";
import type { SendGridMailSendRequest, SendTenantMailResult } from "@mega-crm/delivery-core";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * CR-05/CR-06 regression tests (04-13, CAMP-02/03/05): pins that a
 * non-empty-audience campaign actually reaches `status='sent'` with live
 * `sent_count`/`failed_count` progress as terminal sends land, and that
 * canceling a `sending` campaign authoritatively stops in-flight dispatch.
 * Fixture helpers copied verbatim from send-dispatch-idempotency.test.ts /
 * send-dispatch-durability.test.ts (not exported there, per established
 * convention) -- campaign rows are arranged directly via RLS-scoped UPDATE
 * inside withTenant/withTenantTransaction so each case can pin an exact
 * sendable_total/fan_out_complete/status combination without depending on
 * campaign-kickoff.worker.ts's own fan-out.
 */
describe("campaign completion + cancel (CR-05/CR-06, CAMP-02/03/05)", () => {
  let pool: Pool;
  let redisClient: Redis;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
    redisClient = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/1");
  });

  afterAll(async () => {
    await pool.end();
    await redisClient.quit();
  });

  function fakeSendMail(status: number): (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult> {
    // eslint-disable-next-line @typescript-eslint/require-await -- test double: the signature must match the async function it replaces at the DI seam; a stub having nothing to await is the point
    return async () => ({
      status,
      headers: new Headers(),
      messageId: status < 300 ? "sg-message-id-fixture" : null,
    });
  }

  function countingSendMail(status = 202): {
    fn: (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult>;
    callCount: () => number;
  } {
    let calls = 0;
    return {
      // eslint-disable-next-line @typescript-eslint/require-await -- test double: the signature must match the async function it replaces at the DI seam; a stub having nothing to await is the point
      fn: async () => {
        calls += 1;
        return { status, headers: new Headers(), messageId: status < 300 ? "sg-message-id-fixture" : null };
      },
      callCount: () => calls,
    };
  }

  // 10-09 (SEC-05): delegates to the mega_crm_auth-backed INSERT in
  // failure-fixtures.ts instead of duplicating it -- mega_crm_app holds
  // only SELECT on organization post-migration-0045.
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

  /** Creates a 'sending' campaign and immediately pins its sendable_total/fan_out_complete for this test's arrangement. */
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
        const segmentId = segmentRows[0].id;

        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, sendable_total, fan_out_complete, created_by_user_id)
           VALUES ($1, 'Fixture campaign', 'sending', $2, 'd-fixture-template', 'sender@fixture.test', $3, $4, 'test-user')
           RETURNING id`,
          [workspaceId, segmentId, overrides.sendableTotal, overrides.fanOutComplete]
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

  interface CampaignSnapshot {
    status: string;
    sentCount: number;
    failedCount: number;
    terminalAt: Date | null;
  }

  async function getCampaignSnapshot(workspaceId: string, campaignId: string): Promise<CampaignSnapshot> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<CampaignSnapshot>(
          `SELECT status, sent_count as "sentCount", failed_count as "failedCount", terminal_at as "terminalAt"
           FROM campaigns WHERE id = $1`,
          [campaignId]
        );
        return rows[0];
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

  async function sendsRowExists(workspaceId: string, campaignId: string, contactId: string): Promise<boolean> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT id FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3`,
          [workspaceId, campaignId, contactId]
        );
        return rows.length > 0;
      })
    );
  }

  it("CR-05/CAMP-03/CAMP-05: a 2-recipient campaign advances sent_count live and reaches 'sent' after the last terminal send", async () => {
    const workspaceId = await freshWorkspaceId("completion-two");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 2, fanOutComplete: true });
    const contactA = await createFixtureContact(workspaceId);
    const contactB = await createFixtureContact(workspaceId);

    const counting = countingSendMail(202);

    const firstResult = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId: contactA },
      { sendMail: counting.fn, redisClient }
    );
    expect(firstResult.outcome).toBe("sent");

    const afterFirst = await getCampaignSnapshot(workspaceId, campaignId);
    expect(afterFirst.sentCount).toBe(1);
    expect(afterFirst.status).toBe("sending");
    expect(afterFirst.terminalAt).toBeNull();

    const secondResult = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId: contactB },
      { sendMail: counting.fn, redisClient }
    );
    expect(secondResult.outcome).toBe("sent");

    const afterSecond = await getCampaignSnapshot(workspaceId, campaignId);
    expect(afterSecond.sentCount).toBe(2);
    expect(afterSecond.status).toBe("sent");
    expect(afterSecond.terminalAt).not.toBeNull();
  });

  it("D-10/CR-05: a fully-failed 1-recipient campaign still terminates to 'sent' with a visible failed_count", async () => {
    const workspaceId = await freshWorkspaceId("completion-failed");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
    const contactId = await createFixtureContact(workspaceId);

    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: fakeSendMail(400), redisClient }
    );
    expect(result.outcome).toBe("failed");

    const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
    expect(snapshot.failedCount).toBe(1);
    expect(snapshot.sentCount).toBe(0);
    expect(snapshot.status).toBe("sent");
    expect(snapshot.terminalAt).not.toBeNull();
  });

  it("CR-06/CAMP-02: canceling a sending campaign stops in-flight dispatch -- 0 SendGrid calls, no send row, counters frozen", async () => {
    const workspaceId = await freshWorkspaceId("completion-canceled");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
    const contactId = await createFixtureContact(workspaceId);

    await setCampaignStatus(workspaceId, campaignId, "canceled");

    const counting = countingSendMail(202);
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(result.outcome).toBe("skipped");
    expect(counting.callCount()).toBe(0);
    expect(await sendsRowExists(workspaceId, campaignId, contactId)).toBe(false);

    const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
    expect(snapshot.status).toBe("canceled");
    expect(snapshot.sentCount).toBe(0);
    expect(snapshot.failedCount).toBe(0);
  });

  it("guard: a campaign already 'sent' never has its counters incremented again by a stray terminal record", async () => {
    const workspaceId = await freshWorkspaceId("completion-guard");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
    const contactId = await createFixtureContact(workspaceId);

    await setCampaignStatus(workspaceId, campaignId, "sent");

    const counting = countingSendMail(202);
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(result.outcome).toBe("skipped");
    expect(counting.callCount()).toBe(0);

    const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
    expect(snapshot.status).toBe("sent");
    expect(snapshot.sentCount).toBe(0);
    expect(snapshot.failedCount).toBe(0);
  });

  /**
   * Phase 11 (D-12, plan 11-08, Task 2): `tryCompleteCampaign`'s completion
   * predicate now counts `reconciling`/`unknown` rows toward
   * `sendable_total`, so a campaign whose LAST outstanding recipient is
   * ambiguous still completes instead of hanging on that one recipient.
   * `dispatching` is deliberately excluded (still genuinely in flight).
   *
   * `arrangeSendAtStatus` claims a fresh send via `dispatchSendGate` (so the
   * row satisfies every FK/unique constraint the same way a real dispatch
   * would) then force-writes its `status` directly -- mirrors
   * `claim-gate-exclusivity.test.ts`'s own `arrangeCampaignSendAtStatus`
   * helper.
   */
  describe("tryCompleteCampaign counts ambiguity toward sendable_total (D-12)", () => {
    async function arrangeSendAtStatus(
      workspaceId: string,
      campaignId: string,
      contactId: string,
      status: "reconciling" | "unknown" | "dispatching"
    ): Promise<string> {
      return withTenant(workspaceId, () =>
        withTenantTransaction(async (client) => {
          const claim = await dispatchSendGate(client, { workspaceId, campaignId, contactId });
          if (claim === "skipped" || !claim.sendId) {
            throw new Error("test setup failure: expected a fresh dispatchSendGate claim");
          }
          if (status !== "dispatching") {
            await client.query(`UPDATE sends SET status = $2::send_status WHERE id = $1`, [claim.sendId, status]);
          }
          return claim.sendId;
        })
      );
    }

    it("completes a campaign one short of sendable_total when exactly one 'reconciling' row exists for it", async () => {
      const workspaceId = await freshWorkspaceId("completion-ambiguous-reconciling");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 2, fanOutComplete: true });
      const contactA = await createFixtureContact(workspaceId);
      const contactB = await createFixtureContact(workspaceId);

      const counting = countingSendMail(202);
      const result = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId: contactA },
        { sendMail: counting.fn, redisClient }
      );
      expect(result.outcome).toBe("sent");

      await arrangeSendAtStatus(workspaceId, campaignId, contactB, "reconciling");

      // In production this re-check is `resolveOneSend`'s own post-resolution
      // call to tryCompleteCampaign (Task 3) -- here it is invoked directly
      // to isolate the completion PREDICATE itself, independent of the
      // reconciler tick's own wiring.
      await withTenant(workspaceId, () => withTenantTransaction((client) => tryCompleteCampaign(client, campaignId)));

      const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
      expect(snapshot.sentCount).toBe(1);
      expect(snapshot.status, "the one-short shortfall is ambiguous, not missing -- the campaign must complete").toBe(
        "sent"
      );
      expect(snapshot.terminalAt).not.toBeNull();
    });

    it("completes the same campaign when the outstanding row is 'unknown' instead of 'reconciling'", async () => {
      const workspaceId = await freshWorkspaceId("completion-ambiguous-unknown");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 2, fanOutComplete: true });
      const contactA = await createFixtureContact(workspaceId);
      const contactB = await createFixtureContact(workspaceId);

      const counting = countingSendMail(202);
      const result = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId: contactA },
        { sendMail: counting.fn, redisClient }
      );
      expect(result.outcome).toBe("sent");

      await arrangeSendAtStatus(workspaceId, campaignId, contactB, "unknown");
      await withTenant(workspaceId, () => withTenantTransaction((client) => tryCompleteCampaign(client, campaignId)));

      const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
      expect(snapshot.sentCount).toBe(1);
      expect(snapshot.status).toBe("sent");
      expect(snapshot.terminalAt).not.toBeNull();
    });

    it("does NOT complete when the shortfall is a 'dispatching' row -- still genuinely in flight, not ambiguous", async () => {
      const workspaceId = await freshWorkspaceId("completion-ambiguous-dispatching");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 2, fanOutComplete: true });
      const contactA = await createFixtureContact(workspaceId);
      const contactB = await createFixtureContact(workspaceId);

      const counting = countingSendMail(202);
      const result = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId: contactA },
        { sendMail: counting.fn, redisClient }
      );
      expect(result.outcome).toBe("sent");

      await arrangeSendAtStatus(workspaceId, campaignId, contactB, "dispatching");
      await withTenant(workspaceId, () => withTenantTransaction((client) => tryCompleteCampaign(client, campaignId)));

      const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
      expect(snapshot.sentCount).toBe(1);
      expect(snapshot.status, "a genuinely in-flight row must not be treated as ambiguous").toBe("sending");
      expect(snapshot.terminalAt).toBeNull();
    });

    it("remains a single-fire no-op on a campaign already 'sent', even with an ambiguous row present", async () => {
      const workspaceId = await freshWorkspaceId("completion-ambiguous-already-sent");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
      const contactId = await createFixtureContact(workspaceId);

      await arrangeSendAtStatus(workspaceId, campaignId, contactId, "reconciling");
      await setCampaignStatus(workspaceId, campaignId, "sent");

      const transitioned = await withTenant(workspaceId, () =>
        withTenantTransaction((client) => tryCompleteCampaign(client, campaignId))
      );

      expect(transitioned, "already-sent is a no-op, not a re-fire").toBe(false);
      const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
      expect(snapshot.status).toBe("sent");
    });
  });

  /**
   * Phase 11 (D-12, plan 11-08, Task 2): direct ledger-function coverage for
   * `resolveReconcilingSend`'s widened verdict, `sweepStaleDispatchingSend`,
   * `backfillCampaignSendCounter`, and `incrementCampaignSendCounter`'s
   * unweakened guard -- arranged directly against `sends`/`campaigns` rows
   * rather than through `processSendJob`, mirroring
   * `claim-gate-exclusivity.test.ts`'s own arrange-then-assert convention.
   */
  describe("send-ledger.ts direct coverage: resolveReconcilingSend / sweepStaleDispatchingSend / backfillCampaignSendCounter (D-12)", () => {
    async function claimFreshSend(workspaceId: string, campaignId: string, contactId: string): Promise<string> {
      return withTenant(workspaceId, () =>
        withTenantTransaction(async (client) => {
          const claim = await dispatchSendGate(client, { workspaceId, campaignId, contactId });
          if (claim === "skipped" || !claim.sendId) {
            throw new Error("test setup failure: expected a fresh dispatchSendGate claim");
          }
          return claim.sendId;
        })
      );
    }

    async function forceStatus(workspaceId: string, sendId: string, status: string): Promise<void> {
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          client.query(`UPDATE sends SET status = $2::send_status WHERE id = $1`, [sendId, status])
        )
      );
    }

    async function sendRow(
      workspaceId: string,
      sendId: string
    ): Promise<{ status: string; sentAt: Date | null; reconcilingSince: Date | null }> {
      const row = await withTenant(workspaceId, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ status: string; sentAt: Date | null; reconcilingSince: Date | null }>(
            `SELECT status, sent_at as "sentAt", reconciling_since as "reconcilingSince" FROM sends WHERE id = $1`,
            [sendId]
          );
          return rows[0];
        })
      );
      if (!row) throw new Error(`test assertion failure: no sends row for id ${sendId}`);
      return row;
    }

    it("resolveReconcilingSend({ kind: 'resolve_unknown' }) moves 'reconciling' to 'unknown', leaves sent_at null, clears nothing else", async () => {
      const workspaceId = await freshWorkspaceId("ledger-resolve-unknown");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
      const contactId = await createFixtureContact(workspaceId);
      const sendId = await claimFreshSend(workspaceId, campaignId, contactId);
      await forceStatus(workspaceId, sendId, "reconciling");

      const beforeRow = await sendRow(workspaceId, sendId);
      expect(beforeRow.reconcilingSince).toBeNull(); // forced directly, not via recordSendResult

      const { resolved } = await withTenant(workspaceId, () =>
        withTenantTransaction((client) => resolveReconcilingSend(client, sendId, { kind: "resolve_unknown" }))
      );
      expect(resolved).toBe(true);

      const afterRow = await sendRow(workspaceId, sendId);
      expect(afterRow.status).toBe("unknown");
      expect(afterRow.sentAt).toBeNull();
      expect(afterRow.reconcilingSince).toBeNull(); // untouched -- resolve_unknown clears nothing
    });

    it("resolveReconcilingSend({ kind: 'resolve_sent' }) moves either 'reconciling' or 'unknown' to 'sent' and back-dates sent_at", async () => {
      for (const startingStatus of ["reconciling", "unknown"] as const) {
        const workspaceId = await freshWorkspaceId(`ledger-resolve-sent-${startingStatus}`);
        await connectFixtureSendgridKey(workspaceId);
        const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
        const contactId = await createFixtureContact(workspaceId);
        const sendId = await claimFreshSend(workspaceId, campaignId, contactId);
        await forceStatus(workspaceId, sendId, startingStatus);

        const { resolved } = await withTenant(workspaceId, () =>
          withTenantTransaction((client) => resolveReconcilingSend(client, sendId, { kind: "resolve_sent" }))
        );
        expect(resolved).toBe(true);

        const afterRow = await sendRow(workspaceId, sendId);
        expect(afterRow.status).toBe("sent");
        expect(afterRow.sentAt).not.toBeNull();
        expect(afterRow.reconcilingSince).toBeNull();
      }
    });

    it("resolveReconcilingSend on an already-'sent' row updates nothing and reports resolved: false", async () => {
      const workspaceId = await freshWorkspaceId("ledger-resolve-noop");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
      const contactId = await createFixtureContact(workspaceId);
      const sendId = await claimFreshSend(workspaceId, campaignId, contactId);
      await forceStatus(workspaceId, sendId, "sent");

      const { resolved } = await withTenant(workspaceId, () =>
        withTenantTransaction((client) => resolveReconcilingSend(client, sendId, { kind: "resolve_sent" }))
      );
      expect(resolved).toBe(false);

      const afterRow = await sendRow(workspaceId, sendId);
      expect(afterRow.status).toBe("sent");
    });

    it("sweepStaleDispatchingSend moves a 'dispatching' row to 'reconciling' and sets reconciling_since; a non-'dispatching' row transitions nothing", async () => {
      const workspaceId = await freshWorkspaceId("ledger-sweep");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 2, fanOutComplete: true });
      const dispatchingContact = await createFixtureContact(workspaceId);
      const sentContact = await createFixtureContact(workspaceId);

      const dispatchingSendId = await claimFreshSend(workspaceId, campaignId, dispatchingContact);
      const sentSendId = await claimFreshSend(workspaceId, campaignId, sentContact);
      await forceStatus(workspaceId, sentSendId, "sent");

      const sweepResult = await withTenant(workspaceId, () =>
        withTenantTransaction((client) => sweepStaleDispatchingSend(client, dispatchingSendId))
      );
      expect(sweepResult.resolved).toBe(true);

      const sweptRow = await sendRow(workspaceId, dispatchingSendId);
      expect(sweptRow.status).toBe("reconciling");
      expect(sweptRow.reconcilingSince).not.toBeNull();

      const noopResult = await withTenant(workspaceId, () =>
        withTenantTransaction((client) => sweepStaleDispatchingSend(client, sentSendId))
      );
      expect(noopResult.resolved).toBe(false);

      const untouchedRow = await sendRow(workspaceId, sentSendId);
      expect(untouchedRow.status).toBe("sent");
    });

    it("backfillCampaignSendCounter increments sent_count on a campaign whose status is already 'sent' -- the path incrementCampaignSendCounter refuses", async () => {
      const workspaceId = await freshWorkspaceId("ledger-backfill");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
      await setCampaignStatus(workspaceId, campaignId, "sent");

      await withTenant(workspaceId, () =>
        withTenantTransaction((client) => backfillCampaignSendCounter(client, campaignId, "sent"))
      );

      const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
      expect(snapshot.sentCount, "backfillCampaignSendCounter must increment even though the campaign is already 'sent'").toBe(
        1
      );
    });

    it("incrementCampaignSendCounter still refuses to increment a campaign that is not 'sending' (the pre-existing guard is not weakened)", async () => {
      const workspaceId = await freshWorkspaceId("ledger-increment-guard");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
      await setCampaignStatus(workspaceId, campaignId, "sent");

      await withTenant(workspaceId, () =>
        withTenantTransaction((client) => incrementCampaignSendCounter(client, campaignId, "sent"))
      );

      const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
      expect(snapshot.sentCount, "incrementCampaignSendCounter's WHERE status='sending' guard must still refuse").toBe(0);
    });
  });
});
