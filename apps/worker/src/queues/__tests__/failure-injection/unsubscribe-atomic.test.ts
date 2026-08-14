import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { applyUnsubscribeWithSendFact, type ApplyUnsubscribeInput } from "@mega-crm/contacts-core";
import { createTestPool, ensureTestDbMigrated, getTestDatabaseUrl } from "@mega-crm/test-support";
import { insertFixtureOrganization, createFixtureCampaign, createFixtureContact } from "../../../test/failure-fixtures.js";

/**
 * CMP-01 (Phase 13, plan 13-08, Task 3, T-13-08-01) -- proves
 * `applyUnsubscribeWithSendFact`'s three writes (the `contacts` status
 * UPDATE, the `subscription_status_history` INSERT, and the `sends`
 * fact-column UPDATE) share ONE transaction: because the helper never opens
 * its own transaction and always runs on the caller's client, a crash
 * anywhere between those three writes is structurally impossible to leave a
 * partial commit -- Postgres either commits the whole transaction or none
 * of it. There is no weaker/stronger observable state a real process kill
 * could produce that this test's rollback-based injection does not already
 * cover (mirrors `crash-pre-result-write.test.ts`'s own reasoning for why a
 * state-based/injected arrangement, not a kill harness, is the honest test
 * here).
 *
 * The injection technique: a thin `Proxy` around the REAL `PoolClient`
 * counts `.query()` calls made BY THE HELPER (the transaction's own
 * `BEGIN`/`SET LOCAL`/`COMMIT`/`ROLLBACK` queries run on the raw client
 * inside `withTenantTransaction` and are never proxied) and throws after
 * the Nth one -- deterministic given a fixed call path (a live `sends` row,
 * a real `contactId`, and a contact whose status will actually change),
 * confirmed against `unsubscribe-apply.ts`'s own 5-query happy path:
 * 1) SELECT the send row, 2) SELECT the contact's prior status,
 * 3) UPDATE contacts (the status write), 4) INSERT subscription_status_history
 * (the consent-history write), 5) UPDATE sends (the fact-column write).
 * `withTenantTransaction` catches the throw, issues `ROLLBACK`, and
 * rethrows -- exactly what a mid-transaction process crash's connection
 * cleanup would also leave behind (an aborted, rolled-back transaction).
 *
 * Reproduce with `npm run failure:unsubscribe-atomic` from the repo root.
 */
describe("failure injection: unsubscribe write set is atomic (CMP-01, T-13-08-01)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createFixtureSend(workspaceId: string, campaignId: string, contactId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, campaign_id, contact_id, kind, status, sent_at)
           VALUES ($1, $2, $3, 'campaign', 'sent', now()) RETURNING id`,
          [workspaceId, campaignId, contactId]
        );
        return rows[0].id;
      })
    );
  }

  interface DurableState {
    subscriptionStatus: string;
    historyRowCount: number;
    unsubscribedAt: Date | null;
    campaignUnsubscribedCount: number;
  }

  async function readDurableState(workspaceId: string, contactId: string, sendId: string, campaignId: string): Promise<DurableState> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: contactRows } = await client.query<{ subscriptionStatus: string }>(
          `SELECT subscription_status as "subscriptionStatus" FROM contacts WHERE id = $1`,
          [contactId]
        );
        const { rows: historyRows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM subscription_status_history WHERE contact_id = $1`,
          [contactId]
        );
        const { rows: sendRows } = await client.query<{ unsubscribedAt: Date | null }>(
          `SELECT unsubscribed_at as "unsubscribedAt" FROM sends WHERE id = $1`,
          [sendId]
        );
        const { rows: campaignRows } = await client.query<{ unsubscribedCount: number }>(
          `SELECT unsubscribed_count as "unsubscribedCount" FROM campaigns WHERE id = $1`,
          [campaignId]
        );
        return {
          subscriptionStatus: contactRows[0].subscriptionStatus,
          historyRowCount: Number(historyRows[0]?.count ?? "0"),
          unsubscribedAt: sendRows[0]?.unsubscribedAt ?? null,
          campaignUnsubscribedCount: campaignRows[0]?.unsubscribedCount ?? 0,
        };
      })
    );
  }

  /**
   * Wraps `client` so that the Nth call to `.query()` (1-indexed) throws
   * AFTER the underlying query has actually executed and returned -- i.e.
   * the injected failure lands strictly BETWEEN two real writes, never
   * inside one.
   */
  function wrapClientThrowingAfterQuery(client: PoolClient, throwAfterQueryCount: number): PoolClient {
    let queryCount = 0;
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return async (...args: unknown[]) => {
            const boundQuery = (target.query as (...a: unknown[]) => Promise<unknown>).bind(target);
            const result = await boundQuery(...args);
            queryCount += 1;
            if (queryCount === throwAfterQueryCount) {
              throw new Error(`INJECTED FAILURE after query #${queryCount} (unsubscribe-atomic failure injection)`);
            }
            return result;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  async function runInjected(
    workspaceId: string,
    input: ApplyUnsubscribeInput,
    throwAfterQueryCount: number
  ): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const wrapped = wrapClientThrowingAfterQuery(client, throwAfterQueryCount);
        await applyUnsubscribeWithSendFact(wrapped, input);
      })
    );
  }

  async function setUp(nameSeed: string): Promise<{
    workspaceId: string;
    campaignId: string;
    contactId: string;
    sendId: string;
    input: ApplyUnsubscribeInput;
  }> {
    const workspaceId = await insertFixtureOrganization(nameSeed);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);
    const input: ApplyUnsubscribeInput = {
      workspaceId,
      contactId,
      sendId,
      occurredAt: new Date().toISOString(),
      source: "unsubscribe_route",
    };
    return { workspaceId, campaignId, contactId, sendId, input };
  }

  it("boundary 1: a failure after the status UPDATE but before the consent-history write leaves ALL THREE writes uncommitted", async () => {
    const { workspaceId, campaignId, contactId, sendId, input } = await setUp("unsub-atomic-boundary1");
    const before = await readDurableState(workspaceId, contactId, sendId, campaignId);
    expect(before.subscriptionStatus).toBe("subscribed");
    expect(before.historyRowCount).toBe(0);
    expect(before.unsubscribedAt).toBeNull();

    // Query order: 1=SELECT send, 2=SELECT prior status, 3=UPDATE contacts
    // (the status write) -- throw right after #3, before #4 (history INSERT).
    await expect(runInjected(workspaceId, input, 3)).rejects.toThrow(/INJECTED FAILURE/);

    const after = await readDurableState(workspaceId, contactId, sendId, campaignId);
    expect(after.subscriptionStatus, "the status UPDATE must be rolled back, not just the writes after it").toBe(
      "subscribed"
    );
    expect(after.historyRowCount).toBe(0);
    expect(after.unsubscribedAt).toBeNull();
    expect(after.campaignUnsubscribedCount).toBe(0);
  });

  it("boundary 2: a failure after the consent-history write but before the send-fact write leaves ALL THREE writes uncommitted", async () => {
    const { workspaceId, campaignId, contactId, sendId, input } = await setUp("unsub-atomic-boundary2");

    // Throw right after #4 (the history INSERT), before #5 (the sends fact UPDATE).
    await expect(runInjected(workspaceId, input, 4)).rejects.toThrow(/INJECTED FAILURE/);

    const after = await readDurableState(workspaceId, contactId, sendId, campaignId);
    expect(after.subscriptionStatus, "the earlier status UPDATE must ALSO be rolled back").toBe("subscribed");
    expect(after.historyRowCount, "the history INSERT itself must be rolled back").toBe(0);
    expect(after.unsubscribedAt).toBeNull();
    expect(after.campaignUnsubscribedCount).toBe(0);
  });

  it("boundary 3: a failure after the send-fact write but before commit leaves ALL THREE writes uncommitted", async () => {
    const { workspaceId, campaignId, contactId, sendId, input } = await setUp("unsub-atomic-boundary3");

    // Throw right after #5 (the sends fact UPDATE) -- the LAST write the
    // helper performs, before withTenantTransaction's own COMMIT ever runs.
    await expect(runInjected(workspaceId, input, 5)).rejects.toThrow(/INJECTED FAILURE/);

    const after = await readDurableState(workspaceId, contactId, sendId, campaignId);
    expect(after.subscriptionStatus, "even the LAST write's own transaction commits nothing on a pre-commit crash").toBe(
      "subscribed"
    );
    expect(after.historyRowCount).toBe(0);
    expect(after.unsubscribedAt, "sends.unsubscribed_at must be rolled back even though its own UPDATE succeeded").toBeNull();
    expect(after.campaignUnsubscribedCount).toBe(0);
  });

  it("control: the same helper run to completion (no injected failure) commits all three writes", async () => {
    const { workspaceId, campaignId, contactId, sendId, input } = await setUp("unsub-atomic-control");

    await withTenant(workspaceId, () => withTenantTransaction((client) => applyUnsubscribeWithSendFact(client, input)));

    const after = await readDurableState(workspaceId, contactId, sendId, campaignId);
    expect(after.subscriptionStatus).toBe("unsubscribed");
    expect(after.historyRowCount).toBe(1);
    expect(after.unsubscribedAt).not.toBeNull();
  });
});
