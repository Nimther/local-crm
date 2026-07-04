import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processEventIngestJob } from "../events-ingest.worker.js";

/**
 * events:ingest job-processing handler (EVNT-02/EVNT-03, Pitfall 1): invokes
 * `processEventIngestJob` directly with a crafted job payload -- no live
 * BullMQ Queue/Redis round-trip needed, since the handler is exported
 * standalone precisely so this test can call it in isolation (Pattern 2).
 * Uses a raw pool insert into `organization` (rather than spinning up
 * apps/api's full auth/session stack) to get a real workspace_id satisfying
 * the FK on `contacts`/`events`.
 */
describe("events:ingest worker (EVNT-02/EVNT-03, Pitfall 1/4)", () => {
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

  it("EVNT-02: creates the contact for an unknown identity and writes exactly one events row", async () => {
    const workspaceId = await freshWorkspaceId("worker-create");
    const externalId = `worker-ext-${Date.now()}`;
    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();

    await processEventIngestJob({
      workspaceId,
      eventId,
      occurredAt,
      name: "order_placed",
      properties: { total: 42 },
      externalId,
    });

    const { rows: contactRows } = await pool.query(
      `SELECT id FROM contacts WHERE workspace_id = $1 AND external_id = $2`,
      [workspaceId, externalId]
    );
    expect(contactRows).toHaveLength(1);

    const { rows: eventRows } = await pool.query(`SELECT id FROM events WHERE id = $1`, [eventId]);
    expect(eventRows).toHaveLength(1);
  });

  it("Pitfall 1: redelivering the same job (same eventId + occurredAt) writes NO duplicate events row", async () => {
    const workspaceId = await freshWorkspaceId("worker-idempotent");
    const externalId = `worker-idem-${Date.now()}`;
    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();

    const payload = {
      workspaceId,
      eventId,
      occurredAt,
      name: "email_opened",
      properties: {},
      externalId,
    };

    await processEventIngestJob(payload);
    await processEventIngestJob(payload); // simulated BullMQ redelivery

    const { rows } = await pool.query(`SELECT id FROM events WHERE id = $1 AND occurred_at = $2`, [
      eventId,
      occurredAt,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("EVNT-02: a later event changing the contact's email resolves to the same contact", async () => {
    const workspaceId = await freshWorkspaceId("worker-email-change");
    const externalId = `worker-email-${Date.now()}`;
    const firstEmail = `first-${Date.now()}@example.com`;
    const secondEmail = `second-${Date.now()}@example.com`;

    await processEventIngestJob({
      workspaceId,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      name: "signed_up",
      properties: {},
      externalId,
      email: firstEmail,
    });

    await processEventIngestJob({
      workspaceId,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      name: "email_changed",
      properties: {},
      externalId,
      email: secondEmail,
    });

    const { rows } = await pool.query<{ id: string; email: string }>(
      `SELECT id, email FROM contacts WHERE workspace_id = $1 AND external_id = $2`,
      [workspaceId, externalId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(secondEmail);
  });

  it("Pitfall 4: a subscription_status property on the event cannot flip the contact's real subscription state", async () => {
    const workspaceId = await freshWorkspaceId("worker-reserved-key");
    const externalId = `worker-reserved-${Date.now()}`;

    await processEventIngestJob({
      workspaceId,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      name: "spoofed_event",
      properties: { subscription_status: "suppressed", plan: "pro" },
      externalId,
    });

    const { rows } = await pool.query<{ subscriptionStatus: string; properties: Record<string, unknown> }>(
      `SELECT subscription_status as "subscriptionStatus", properties FROM contacts WHERE workspace_id = $1 AND external_id = $2`,
      [workspaceId, externalId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].subscriptionStatus).toBe("subscribed");
    expect(rows[0].properties).not.toHaveProperty("subscription_status");
    expect(rows[0].properties.plan).toBe("pro");
  });
});
