import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { getAuthTestDatabaseUrl } from "@mega-crm/test-support";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../test/db-fixture.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";
import { processEventIngestJob } from "../events-ingest.worker.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";
import { logger } from "../../logger.js";

/**
 * Phase 22 (PRG-06, RESEARCH Open Question 1): closes the queue-drain
 * window on both ingest workers -- a job already sitting in the queue when
 * its workspace was soft-deleted must resolve quietly (never throw, never
 * dead-letter) and write NOTHING for that workspace. The API-side refusals
 * (22-03 Tasks 1/2) close the front door; this suite proves the two workers
 * close the back door for work already past it.
 *
 * `organization` carries no RLS (workspace-lookup.ts's own precedent) -- the
 * soft-delete UPDATE below runs on the mega_crm_auth-backed pool, mirroring
 * `insertFixtureOrganization`'s own reasoning (mega_crm_app holds only
 * SELECT+UPDATE on `organization` as of migration 0045; UPDATE alone is
 * sufficient here, but reusing the auth pool keeps this file's one soft-
 * delete helper consistent with the fixture creation helper it pairs with).
 */
describe("workspace quiesce -- ingest worker drain-window guard (PRG-06)", () => {
  let authPool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    authPool = new Pool({ connectionString: getAuthTestDatabaseUrl() });
  });

  afterAll(async () => {
    await authPool.end();
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  async function softDeleteWorkspace(workspaceId: string): Promise<void> {
    await authPool.query(`UPDATE organization SET "deletedAt" = now() WHERE id = $1`, [workspaceId]);
  }

  async function countContacts(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM contacts WHERE workspace_id = $1`,
          [workspaceId]
        );
        return Number(rows[0].count);
      })
    );
  }

  async function countEvents(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM events WHERE workspace_id = $1`,
          [workspaceId]
        );
        return Number(rows[0].count);
      })
    );
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

  it("events-ingest job dropped: resolves without throwing, writes zero contacts/events rows, logs the drop", async () => {
    const workspaceId = await freshWorkspaceId("quiesce-ingest-events");
    await softDeleteWorkspace(workspaceId);

    const infoSpy = vi.spyOn(logger, "info");
    await expect(
      processEventIngestJob({
        workspaceId,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        name: "order_placed",
        properties: {},
        externalId: `quiesce-ingest-${Date.now()}`,
      })
    ).resolves.toBeUndefined();

    expect(await countContacts(workspaceId)).toBe(0);
    expect(await countEvents(workspaceId)).toBe(0);
    expect(
      infoSpy.mock.calls.some(
        (call) =>
          typeof call[0] === "object" &&
          call[0] !== null &&
          (call[0] as { workspaceId?: string }).workspaceId === workspaceId &&
          typeof call[1] === "string" &&
          call[1].includes("soft-deleted")
      )
    ).toBe(true);
    infoSpy.mockRestore();
  });

  it("webhook-events job dropped: resolves without throwing and writes zero send_events rows", async () => {
    const workspaceId = await freshWorkspaceId("quiesce-ingest-webhook");
    await softDeleteWorkspace(workspaceId);

    const infoSpy = vi.spyOn(logger, "info");
    const result = await processWebhookEventBatch({
      workspaceId,
      events: [
        {
          email: "hello@world.com",
          event: "delivered",
          sg_event_id: `sg-${randomUUID()}`,
          sg_message_id: "abc.filterdrecv-x",
          timestamp: Math.floor(Date.now() / 1000),
        },
      ],
    });

    expect(result).toEqual({ inserted: 0 });
    expect(await countSendEvents(workspaceId)).toBe(0);
    expect(
      infoSpy.mock.calls.some(
        (call) =>
          typeof call[0] === "object" &&
          call[0] !== null &&
          (call[0] as { workspaceId?: string }).workspaceId === workspaceId &&
          typeof call[1] === "string" &&
          call[1].includes("soft-deleted")
      )
    ).toBe(true);
    infoSpy.mockRestore();
  });

  it("live workspace still ingests on both processors", async () => {
    const eventsWorkspaceId = await freshWorkspaceId("quiesce-ingest-events-live");
    const externalId = `quiesce-ingest-live-${Date.now()}`;
    await processEventIngestJob({
      workspaceId: eventsWorkspaceId,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      name: "order_placed",
      properties: {},
      externalId,
    });
    expect(await countContacts(eventsWorkspaceId)).toBe(1);
    expect(await countEvents(eventsWorkspaceId)).toBe(1);

    const webhookWorkspaceId = await freshWorkspaceId("quiesce-ingest-webhook-live");
    const result = await processWebhookEventBatch({
      workspaceId: webhookWorkspaceId,
      events: [
        {
          email: "hello@world.com",
          event: "delivered",
          sg_event_id: `sg-${randomUUID()}`,
          sg_message_id: "abc.filterdrecv-x",
          timestamp: Math.floor(Date.now() / 1000),
        },
      ],
    });
    expect(result.inserted).toBe(1);
    expect(await countSendEvents(webhookWorkspaceId)).toBe(1);
  });
});
