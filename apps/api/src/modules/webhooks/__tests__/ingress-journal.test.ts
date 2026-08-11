import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { writeIngressJournal } from "@mega-crm/db/src/webhooks/ingress-journal.js";
import { writeQuarantinedEvent } from "@mega-crm/db/src/webhooks/quarantine.js";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { webhookEventsQueue } from "../enqueue.js";
import * as ingressJournalModule from "@mega-crm/db/src/webhooks/ingress-journal.js";

/**
 * Phase 13 (CMP-08, D-05, plan 13-01, Task 2): query-behavior coverage for
 * both new modules (`ingress-journal.ts`/`quarantine.ts`) against a real
 * ephemeral database, including the cross-tenant RLS reads for both tables
 * -- the plan's own Task 2 scope.
 *
 * ALSO covers three of Task 1's `<behavior>` list items that require
 * driving the real Fastify HTTP stack (a verified batch POST creates
 * exactly one `ingress_journal` row; an invalid signature creates zero
 * rows; a simulated journal-write failure produces a 5xx response and
 * zero enqueued jobs) -- documented deviation from 13-01-PLAN.md's file
 * list, which named `apps/worker/src/queues/__tests__/webhook-events-journal.test.ts`
 * for this. apps/worker's vitest project has no path to booting
 * apps/api's `buildServer()` (apps/api's env schema requires
 * AUTH_DATABASE_URL/REDIS_URL/BETTER_AUTH_SECRET/etc. that apps/worker's
 * test harness never provisions), whereas this file's own test project
 * already boots `buildServer()` successfully
 * (webhooks-signature.test.ts's existing precedent). See
 * 13-01-SUMMARY.md for the full rationale.
 */
describe("packages/db webhook modules: ingress_journal + send_event_quarantine (CMP-08, D-05, 13-01)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    // 10-11 precedent (webhooks-signature.test.ts): NOT .obliterate() --
    // this queue is shared across concurrent apps/api test files.
    await webhookEventsQueue.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function signUp(email: string, password: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password, name },
    });
    expect(res.statusCode, `sign-up failed: ${res.body}`).toBe(200);
    const sessionCookie = res.cookies.find((c) => c.name.toLowerCase().includes("session"));
    if (!sessionCookie) {
      throw new Error("sign-up response did not set a session cookie");
    }
    return { cookie: `${sessionCookie.name}=${sessionCookie.value}` };
  }

  async function createWorkspace(cookie: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, `create workspace failed: ${res.body}`).toBe(200);
    return res.json<{ id: string; slug: string; name: string }>();
  }

  async function freshWorkspace(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    return createWorkspace(account.cookie, `${nameSeed} Co`);
  }

  async function provisionEndpoint(workspaceId: string, pathToken: string, publicKey: string | null) {
    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        await client.query(
          `INSERT INTO workspace_webhook_endpoints (workspace_id, path_token, public_key, provision_status)
           VALUES ($1, $2, $3, 'active')`,
          [workspaceId, pathToken, publicKey]
        );
      })
    );
  }

  async function countIngressJournalRows(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM ingress_journal WHERE workspace_id = $1`,
          [workspaceId]
        );
        return Number(rows[0].count);
      })
    );
  }

  async function countQuarantineRows(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM send_event_quarantine WHERE workspace_id = $1`,
          [workspaceId]
        );
        return Number(rows[0].count);
      })
    );
  }

  // -----------------------------------------------------------------------
  // packages/db/src/webhooks/ingress-journal.ts -- direct module behavior
  // -----------------------------------------------------------------------

  it("writeIngressJournal inserts one row with a null ingestion_completed_at", async () => {
    const workspace = await freshWorkspace("journal-write");
    const events = [{ event: "delivered", sg_event_id: `sg-${randomUUID()}` }];

    const journalId = await withTenant(workspace.id, () =>
      withTenantTransaction((client) => writeIngressJournal(client, workspace.id, events))
    );

    expect(await countIngressJournalRows(workspace.id)).toBe(1);
    const row = await withTenant(workspace.id, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ rawBatch: unknown; ingestionCompletedAt: Date | null }>(
          `SELECT raw_batch as "rawBatch", ingestion_completed_at as "ingestionCompletedAt" FROM ingress_journal WHERE id = $1`,
          [journalId]
        );
        return rows[0];
      })
    );
    expect(row?.rawBatch).toEqual(events);
    expect(row?.ingestionCompletedAt).toBeNull();
  });

  it("markIngestionComplete sets ingestion_completed_at to a non-null timestamp", async () => {
    const workspace = await freshWorkspace("journal-complete");
    const journalId = await withTenant(workspace.id, () =>
      withTenantTransaction((client) => writeIngressJournal(client, workspace.id, []))
    );

    await withTenant(workspace.id, () =>
      withTenantTransaction((client) => ingressJournalModule.markIngestionComplete(client, journalId))
    );

    const row = await withTenant(workspace.id, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ ingestionCompletedAt: Date | null }>(
          `SELECT ingestion_completed_at as "ingestionCompletedAt" FROM ingress_journal WHERE id = $1`,
          [journalId]
        );
        return rows[0];
      })
    );
    expect(row?.ingestionCompletedAt).not.toBeNull();
  });

  it("ingress_journal is unreadable from a tenant transaction scoped to a different workspace", async () => {
    const owner = await freshWorkspace("journal-rls-owner");
    const other = await freshWorkspace("journal-rls-other");
    const journalId = await withTenant(owner.id, () =>
      withTenantTransaction((client) => writeIngressJournal(client, owner.id, []))
    );

    const rowsFromOther = await withTenant(other.id, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(`SELECT id FROM ingress_journal WHERE id = $1`, [journalId]);
        return rows;
      })
    );
    expect(rowsFromOther).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // packages/db/src/webhooks/quarantine.ts -- direct module behavior
  // -----------------------------------------------------------------------

  it("writeQuarantinedEvent inserts one row carrying the rejected raw event, reason, occurred_at candidate text, and a server received_at", async () => {
    const workspace = await freshWorkspace("quarantine-write");
    const rawEvent = { event: "delivered", timestamp: "not-a-number" };

    await withTenant(workspace.id, () =>
      withTenantTransaction((client) =>
        writeQuarantinedEvent(client, workspace.id, {
          sgEventId: "sg-quarantine-1",
          eventType: "delivered",
          rawEvent,
          reason: "unusable timestamp",
          occurredAtCandidate: "not-a-number",
        })
      )
    );

    const row = await withTenant(workspace.id, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{
          rawEvent: unknown;
          reason: string;
          occurredAtCandidate: string | null;
          receivedAt: Date;
        }>(
          `SELECT raw_event as "rawEvent", reason, occurred_at_candidate as "occurredAtCandidate", received_at as "receivedAt"
           FROM send_event_quarantine WHERE workspace_id = $1`,
          [workspace.id]
        );
        return rows[0];
      })
    );
    expect(row?.rawEvent).toEqual(rawEvent);
    expect(row?.reason).toBe("unusable timestamp");
    expect(row?.occurredAtCandidate).toBe("not-a-number");
    expect(row?.receivedAt).toBeInstanceOf(Date);
  });

  it("writeQuarantinedEvent resolves rather than rejecting when the INSERT fails", async () => {
    const brokenClient = {
      query: () => Promise.reject(new Error("simulated connection failure")),
    } as unknown as PoolClient;

    await expect(
      writeQuarantinedEvent(brokenClient, randomUUID(), {
        sgEventId: null,
        eventType: null,
        rawEvent: {},
        reason: "test",
        occurredAtCandidate: null,
      })
    ).resolves.toBeUndefined();
  });

  it("two quarantined events in the same batch produce two rows", async () => {
    const workspace = await freshWorkspace("quarantine-two");

    await withTenant(workspace.id, () =>
      withTenantTransaction(async (client) => {
        await writeQuarantinedEvent(client, workspace.id, {
          sgEventId: "sg-a",
          eventType: "delivered",
          rawEvent: { a: 1 },
          reason: "reason a",
          occurredAtCandidate: null,
        });
        await writeQuarantinedEvent(client, workspace.id, {
          sgEventId: "sg-b",
          eventType: "open",
          rawEvent: { b: 2 },
          reason: "reason b",
          occurredAtCandidate: null,
        });
      })
    );

    expect(await countQuarantineRows(workspace.id)).toBe(2);
  });

  it("a quarantine row is unreadable from a tenant transaction scoped to a different workspace", async () => {
    const owner = await freshWorkspace("quarantine-rls-owner");
    const other = await freshWorkspace("quarantine-rls-other");

    await withTenant(owner.id, () =>
      withTenantTransaction((client) =>
        writeQuarantinedEvent(client, owner.id, {
          sgEventId: "sg-rls",
          eventType: "delivered",
          rawEvent: {},
          reason: "rls test",
          occurredAtCandidate: null,
        })
      )
    );

    expect(await countQuarantineRows(owner.id)).toBe(1);
    const rowsFromOther = await withTenant(other.id, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(`SELECT id FROM send_event_quarantine WHERE workspace_id = $1`, [
          owner.id,
        ]);
        return rows;
      })
    );
    expect(rowsFromOther).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // HTTP-level: webhooks.routes.ts journal-before-enqueue (Task 1 behaviors,
  // relocated here -- see file header comment)
  // -----------------------------------------------------------------------

  // SendGrid's own published example signed payload (verbatim from
  // @sendgrid/eventwebhook's test fixture, same fixture
  // webhooks-signature.test.ts uses) -- a real ECDSA signature over real
  // bytes.
  const PUBLIC_KEY =
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==";
  const SIGNATURE =
    "MEUCIGHQVtGj+Y3LkG9fLcxf3qfI10QysgDWmMOVmxG0u6ZUAiEAyBiXDWzM+uOe5W0JuG+luQAbPIqHh89M15TluLtEZtM=";
  const TIMESTAMP = "1600112502";
  const PAYLOAD =
    JSON.stringify([
      {
        email: "hello@world.com",
        event: "dropped",
        reason: "Bounced Address",
        sg_event_id: "ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA",
        sg_message_id: "LRzXl_NHStOGhQ4kofSm_A.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0",
        "smtp-id": "<LRzXl_NHStOGhQ4kofSm_A@ismtpd0039p1iad1.sendgrid.net>",
        timestamp: 1600112492,
      },
    ]) + "\r\n";

  async function postSigned(pathToken: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Number(TIMESTAMP) * 1000);
    try {
      return await app.inject({
        method: "POST",
        url: `/webhooks/sendgrid/${pathToken}`,
        headers: {
          "content-type": "application/json",
          "x-twilio-email-event-webhook-signature": SIGNATURE,
          "x-twilio-email-event-webhook-timestamp": TIMESTAMP,
        },
        payload: PAYLOAD,
      });
    } finally {
      vi.useRealTimers();
    }
  }

  it("a verified batch POST creates exactly one ingress_journal row before enqueue", async () => {
    const workspace = await freshWorkspace("journal-http-valid");
    const pathToken = `tok-journal-valid-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, PUBLIC_KEY);

    const res = await postSigned(pathToken);
    expect(res.statusCode, `valid signature request failed: ${res.body}`).toBe(200);

    expect(await countIngressJournalRows(workspace.id)).toBe(1);

    const waitingJobs = await webhookEventsQueue.getJobs(["waiting"]);
    const jobForThisWorkspace = waitingJobs.find(
      (job) => (job.data as { workspaceId?: string }).workspaceId === workspace.id
    );
    expect(jobForThisWorkspace).toBeDefined();
    const journalRow = await withTenant(workspace.id, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM ingress_journal WHERE workspace_id = $1`,
          [workspace.id]
        );
        return rows[0];
      })
    );
    expect((jobForThisWorkspace?.data as { journalId?: string }).journalId).toBe(journalRow?.id);
  });

  it("an invalid signature creates zero ingress_journal rows", async () => {
    const workspace = await freshWorkspace("journal-http-invalid");
    const pathToken = `tok-journal-invalid-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, PUBLIC_KEY);

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/sendgrid/${pathToken}`,
      headers: {
        "content-type": "application/json",
        "x-twilio-email-event-webhook-signature": SIGNATURE,
        "x-twilio-email-event-webhook-timestamp": TIMESTAMP,
      },
      payload: PAYLOAD.replace("hello@world.com", "attacker@evil.com"),
    });

    expect(res.statusCode).toBe(400);
    expect(await countIngressJournalRows(workspace.id)).toBe(0);
  });

  it("a simulated journal INSERT failure produces a 5xx response and zero enqueued jobs", async () => {
    const workspace = await freshWorkspace("journal-http-write-fail");
    const pathToken = `tok-journal-write-fail-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, PUBLIC_KEY);

    const writeSpy = vi
      .spyOn(ingressJournalModule, "writeIngressJournal")
      .mockRejectedValueOnce(new Error("simulated journal write failure"));

    const before = await webhookEventsQueue.getJobCounts("waiting");
    const res = await postSigned(pathToken);
    expect(res.statusCode).toBe(500);
    expect(writeSpy).toHaveBeenCalledTimes(1);

    const after = await webhookEventsQueue.getJobCounts("waiting");
    expect(after.waiting).toBe(before.waiting ?? 0);
    expect(await countIngressJournalRows(workspace.id)).toBe(0);
  });
});
