import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { encryptTenantSecret } from "@mega-crm/kms";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool, createFixtureFlowRun } from "../../test/db-fixture.js";
import { processSendJob, type SendJobResult } from "../send-dispatch.js";
import type { SendGridMailSendRequest, SendTenantMailResult } from "@mega-crm/delivery-core";

/**
 * `processSendJob`'s `kind === "flow"` branch (FLOW-01/FLOW-07, 06-03),
 * mirroring `send-dispatch-idempotency.test.ts`'s exact convention: invoked
 * directly with a crafted `kind:"flow"` job payload -- no live BullMQ
 * Queue/Redis round-trip needed. The SendGrid network call is replaced with
 * a fake `sendMail` so these tests never touch the real network, while
 * every other step (KMS decrypt, pre-send gate, idempotent partial-index
 * ledger claim, rate limiter) runs against the real test Postgres/Redis.
 */
describe("send-dispatch.ts processSendJob kind:'flow' (FLOW-01/FLOW-07, T-06-03-01/02/03)", () => {
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

  function countingSendMail(): {
    fn: (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult>;
    callCount: () => number;
    lastPayload: () => SendGridMailSendRequest | undefined;
  } {
    let calls = 0;
    let lastPayload: SendGridMailSendRequest | undefined;
    return {
      fn: async (_apiKey, payload) => {
        calls += 1;
        lastPayload = payload;
        return { status: 202, headers: new Headers(), messageId: "sg-message-id-fixture" };
      },
      callCount: () => calls,
      lastPayload: () => lastPayload,
    };
  }

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, slug]
    );
    return rows[0].id;
  }

  // workspace_sendgrid_keys/contacts/flows/flow_versions/flow_runs all
  // carry ENABLE + FORCE ROW LEVEL SECURITY -- fixture inserts MUST run
  // inside withTenant/withTenantTransaction.
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

  async function createFixtureContact(
    workspaceId: string,
    overrides: { email?: string | null; subscriptionStatus?: "subscribed" | "unsubscribed" | "suppressed" } = {}
  ): Promise<string> {
    const email =
      overrides.email === undefined
        ? `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`
        : overrides.email;
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', $3) RETURNING id`,
          [workspaceId, email, overrides.subscriptionStatus ?? "subscribed"]
        );
        return rows[0].id;
      })
    );
  }

  async function flowSendsFor(
    workspaceId: string,
    flowRunId: string,
    nodeId: string
  ): Promise<Array<{ id: string; status: string }>> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM sends
           WHERE workspace_id = $1 AND flow_run_id = $2 AND node_id = $3 AND kind = 'flow'`,
          [workspaceId, flowRunId, nodeId]
        );
        return rows;
      })
    );
  }

  it("T-06-03-01: a redelivered flow-step job sends exactly once and inserts exactly one kind='flow' sends row", async () => {
    const workspaceId = await freshWorkspaceId("flow-send-idempotent");
    await connectFixtureSendgridKey(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);

    const counting = countingSendMail();
    const first = await processSendJob(
      { workspaceId, kind: "flow", flowRunId, nodeId, contactId },
      { sendMail: counting.fn, redisClient }
    );
    expect(first.outcome).toBe("sent");
    expect(counting.callCount()).toBe(1);

    // Simulated BullMQ at-least-once redelivery of the SAME job.
    const redelivered: SendJobResult = await processSendJob(
      { workspaceId, kind: "flow", flowRunId, nodeId, contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(redelivered.outcome).toBe("skipped");
    expect(counting.callCount(), "SendGrid must not be called again for an already-sent flow step").toBe(1);

    const rows = await flowSendsFor(workspaceId, flowRunId, nodeId);
    expect(rows.length, "no duplicate sends row for the redelivered flow-step job").toBe(1);
    expect(rows[0].status).toBe("sent");

    // SUBS-04 sibling: flow sends still carry the same List-Unsubscribe
    // headers and disabled subscription-tracking as campaign sends.
    const payload = counting.lastPayload();
    expect(payload?.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(payload?.tracking_settings.subscription_tracking.enable).toBe(false);
    // 06-03: a flow send has no campaigns row -- custom_args never carries
    // an (empty or stale) campaign_id key.
    expect(payload?.personalizations[0].custom_args).not.toHaveProperty("campaign_id");
  });

  it("T-06-03-03/D-05: a suppressed contact's flow send is recorded excluded and SendGrid is never called", async () => {
    const workspaceId = await freshWorkspaceId("flow-send-excluded");
    await connectFixtureSendgridKey(workspaceId);
    const contactId = await createFixtureContact(workspaceId, { subscriptionStatus: "suppressed" });
    const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);

    const counting = countingSendMail();
    const result = await processSendJob(
      { workspaceId, kind: "flow", flowRunId, nodeId, contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(result).toEqual({ outcome: "excluded", reason: "suppressed" });
    expect(counting.callCount()).toBe(0);

    const rows = await flowSendsFor(workspaceId, flowRunId, nodeId);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("excluded");
  });

  it("T-06-03-02: the flow path consumes the SAME per-tenant token bucket key as campaign/test dispatch (no second limiter)", async () => {
    const workspaceId = await freshWorkspaceId("flow-send-rate-limiter");
    await connectFixtureSendgridKey(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);

    // Exhaust the workspace's default 10 rps bucket entirely via the SAME
    // `consumeTenantToken` keyed by workspaceId that the campaign path uses
    // (rate-limiter.test.ts's own convention) -- if the flow path minted a
    // second, independent limiter, this exhaustion would never affect it.
    const { consumeTenantToken, DEFAULT_TENANT_RPS } = await import("../rate-limiter.js");
    for (let i = 0; i < DEFAULT_TENANT_RPS; i += 1) {
      await consumeTenantToken(redisClient, workspaceId, DEFAULT_TENANT_RPS);
    }

    const counting = countingSendMail();
    const result = await processSendJob(
      { workspaceId, kind: "flow", flowRunId, nodeId, contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(result.outcome).toBe("rate_limited");
    expect(counting.callCount()).toBe(0);
  });
});
