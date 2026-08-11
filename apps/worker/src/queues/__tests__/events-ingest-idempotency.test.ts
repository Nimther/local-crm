import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";
import { processEventIngestJob } from "../events-ingest.worker.js";

/**
 * events:ingest job-processing handler (EVNT-02/EVNT-03, Pitfall 1): invokes
 * `processEventIngestJob` directly with a crafted job payload -- no live
 * BullMQ Queue/Redis round-trip needed, since the handler is exported
 * standalone precisely so this test can call it in isolation (Pattern 2).
 * Uses a raw pool insert into `organization` (rather than spinning up
 * apps/api's full auth/session stack) to get a real workspace_id satisfying
 * the FK on `contacts`/`events`. Verification reads against `contacts`/
 * `events` MUST run inside `withTenant`/`withTenantTransaction` -- both
 * tables carry ENABLE + FORCE ROW LEVEL SECURITY, so a bare `pool.query`
 * that never sets `app.current_workspace_id` silently returns zero rows
 * (RLS filtering, not an error) rather than the actually-written data.
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

  // 10-09 (SEC-05): delegates to the mega_crm_auth-backed INSERT in
  // failure-fixtures.ts -- mega_crm_app holds only SELECT on organization
  // post-migration-0045, so a plain pool insert is no longer fine here.
  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
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

    const { contactRows, eventRows } = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const contactRows = await client.query(
          `SELECT id FROM contacts WHERE workspace_id = $1 AND external_id = $2`,
          [workspaceId, externalId]
        );
        const eventRows = await client.query(`SELECT id FROM events WHERE id = $1`, [eventId]);
        return { contactRows: contactRows.rows, eventRows: eventRows.rows };
      })
    );

    expect(contactRows).toHaveLength(1);
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

    const rows = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(`SELECT id FROM events WHERE id = $1 AND occurred_at = $2`, [
          eventId,
          occurredAt,
        ]);
        return rows;
      })
    );
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

    const rows = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string; email: string }>(
          `SELECT id, email FROM contacts WHERE workspace_id = $1 AND external_id = $2`,
          [workspaceId, externalId]
        );
        return rows;
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(secondEmail);
  });

  it("CR-01: two workspaces processing the SAME eventId + occurredAt both get their own events row (no cross-tenant DB dedupe drop)", async () => {
    const workspaceA = await freshWorkspaceId("worker-cr01-a");
    const workspaceB = await freshWorkspaceId("worker-cr01-b");
    const sharedEventId = randomUUID();
    const sharedOccurredAt = new Date().toISOString();

    await processEventIngestJob({
      workspaceId: workspaceA,
      eventId: sharedEventId,
      occurredAt: sharedOccurredAt,
      name: "order_placed",
      properties: {},
      externalId: `worker-cr01-a-${Date.now()}`,
    });
    // Against pre-fix code, this second INSERT hits the global
    // `ON CONFLICT (id, occurred_at)` from workspace A's row above and is
    // silently dropped -- workspace B would see 0 rows.
    await processEventIngestJob({
      workspaceId: workspaceB,
      eventId: sharedEventId,
      occurredAt: sharedOccurredAt,
      name: "order_placed",
      properties: {},
      externalId: `worker-cr01-b-${Date.now()}`,
    });

    const rowsA = await withTenant(workspaceA, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(`SELECT id FROM events WHERE id = $1`, [sharedEventId]);
        return rows;
      })
    );
    const rowsB = await withTenant(workspaceB, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(`SELECT id FROM events WHERE id = $1`, [sharedEventId]);
        return rows;
      })
    );

    expect(rowsA, "workspace A must have its own events row for the shared eventId").toHaveLength(1);
    expect(rowsB, "workspace B must have its own events row for the shared eventId").toHaveLength(1);
  });

  it("CR-03: an out-of-window occurredAt (outside the pre-created monthly partitions) is accepted and stored, not dropped", async () => {
    const workspaceId = await freshWorkspaceId("worker-cr03-default-partition");
    const externalId = `worker-cr03-${Date.now()}`;
    const eventId = randomUUID();
    // Well outside the 0007 migration's events_2026_07/events_2026_08
    // partitions -- against pre-fix code (no DEFAULT partition), this INSERT
    // throws "no partition of relation events found for row" and
    // processEventIngestJob rejects.
    const outOfWindowOccurredAt = "2027-03-01T00:00:00.000Z";

    await processEventIngestJob({
      workspaceId,
      eventId,
      occurredAt: outOfWindowOccurredAt,
      name: "backfilled_event",
      properties: {},
      externalId,
    });

    const rows = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(`SELECT id FROM events WHERE id = $1`, [eventId]);
        return rows;
      })
    );
    expect(rows).toHaveLength(1);
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

    const rows = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ subscriptionStatus: string; properties: Record<string, unknown> }>(
          `SELECT subscription_status as "subscriptionStatus", properties FROM contacts WHERE workspace_id = $1 AND external_id = $2`,
          [workspaceId, externalId]
        );
        return rows;
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].subscriptionStatus).toBe("subscribed");
    expect(rows[0].properties).not.toHaveProperty("subscription_status");
    expect(rows[0].properties.plan).toBe("pro");
  });
});
