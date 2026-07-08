import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";

/**
 * webhook-events job-processing handler (WBHK-03, D-14): invokes
 * `processWebhookEventBatch` directly with a crafted job payload -- no live
 * BullMQ Queue/Redis round-trip needed, since the handler is exported
 * standalone precisely so this test can call it in isolation (mirrors
 * events-ingest-idempotency.test.ts's `processEventIngestJob` precedent).
 * Verification reads against `send_events` MUST run inside
 * `withTenant`/`withTenantTransaction` -- the table carries
 * ENABLE + FORCE ROW LEVEL SECURITY.
 */
describe("webhook-events worker (WBHK-03, D-14)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, slug]
    );
    return rows[0].id;
  }

  function sendgridEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      email: "hello@world.com",
      event: "delivered",
      sg_event_id: `sg-${randomUUID()}`,
      sg_message_id: "abc.filterdrecv-x",
      timestamp: 1_700_000_000,
      ...overrides,
    };
  }

  async function countSendEvents(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM send_events WHERE workspace_id = $1`,
          [workspaceId]
        );
        return Number(rows[0].count);
      })
    );
  }

  it("inserts N rows for a fresh batch of N distinct sg_event_ids, RETURNING yields N", async () => {
    const workspaceId = await freshWorkspaceId("wh-fresh");
    const events = [sendgridEvent(), sendgridEvent(), sendgridEvent()];

    const result = await processWebhookEventBatch({ workspaceId, events });

    expect(result.inserted).toBe(3);
    expect(await countSendEvents(workspaceId)).toBe(3);
  });

  it("WBHK-03: a replayed identical batch inserts zero additional rows", async () => {
    const workspaceId = await freshWorkspaceId("wh-replay");
    const events = [sendgridEvent(), sendgridEvent()];

    const first = await processWebhookEventBatch({ workspaceId, events });
    expect(first.inserted).toBe(2);

    const replay = await processWebhookEventBatch({ workspaceId, events });
    expect(replay.inserted).toBe(0);
    expect(await countSendEvents(workspaceId)).toBe(2);
  });

  it("a batch mixing 2 already-seen and 3 new sg_event_ids inserts exactly the 3 new rows", async () => {
    const workspaceId = await freshWorkspaceId("wh-mixed");
    const seen = [sendgridEvent(), sendgridEvent()];
    await processWebhookEventBatch({ workspaceId, events: seen });

    const fresh = [sendgridEvent(), sendgridEvent(), sendgridEvent()];
    const mixedResult = await processWebhookEventBatch({ workspaceId, events: [...seen, ...fresh] });

    expect(mixedResult.inserted).toBe(3);
    expect(await countSendEvents(workspaceId)).toBe(5);
  });

  it("every write is tenant-scoped: two workspaces never see each other's rows", async () => {
    const workspaceA = await freshWorkspaceId("wh-tenant-a");
    const workspaceB = await freshWorkspaceId("wh-tenant-b");

    await processWebhookEventBatch({ workspaceId: workspaceA, events: [sendgridEvent()] });
    await processWebhookEventBatch({ workspaceId: workspaceB, events: [sendgridEvent(), sendgridEvent()] });

    expect(await countSendEvents(workspaceA)).toBe(1);
    expect(await countSendEvents(workspaceB)).toBe(2);
  });

  it("an event with a missing/blank sg_event_id is skipped, not crashing the batch", async () => {
    const workspaceId = await freshWorkspaceId("wh-blank-id");
    const events = [
      sendgridEvent(),
      sendgridEvent({ sg_event_id: "" }),
      { ...sendgridEvent(), sg_event_id: undefined },
      sendgridEvent(),
    ];

    const result = await processWebhookEventBatch({ workspaceId, events });

    expect(result.inserted).toBe(2);
    expect(await countSendEvents(workspaceId)).toBe(2);
  });
});
