import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * Phase 15 plan 20 (G-15-1 webhook half, OPS-11). Mirrors
 * `apps/worker/src/__tests__/correlation-tracer.test.ts`'s capture technique
 * exactly: `process.stdout.write` must be spied on in `beforeAll` BEFORE the
 * first import that transitively reaches `../logger.js`, every such import
 * must be dynamic, and `logger.level` must be raised to `"info"` because the
 * logger is constructed `silent` under `NODE_ENV=test`. A static top-level
 * import of `webhook-events.worker.js` would construct the logger before the
 * spy exists and this suite would capture nothing while every other
 * assertion still (misleadingly) passed.
 *
 * `@mega-crm/tenant-context` and the local test fixtures are safe to import
 * statically -- correlation-tracer.test.ts already proves neither
 * transitively constructs `apps/worker`'s logger singleton.
 */
describe("webhook-events worker: per-event sendId correlation binding (G-15-1 webhook half)", () => {
  let pool: Pool;
  let stdoutChunks: string[];
  let processWebhookEventBatch: typeof import("../webhook-events.worker.js")["processWebhookEventBatch"];
  let workerLogger: typeof import("../../logger.js")["logger"];

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();

    stdoutChunks = [];
    // MUST happen before the first import of ../../logger.js (below) --
    // tampering process.stdout.write before pino's module-level
    // construction runs is what makes pino pick process.stdout as its
    // destination instead of a raw-fd SonicBoom writer that bypasses it.
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });

    ({ logger: workerLogger } = await import("../../logger.js"));
    // Constructed with level "silent" under NODE_ENV=test (see logger.ts) --
    // bumped to "info" here so this suite's log calls actually reach the
    // (now-captured) stream.
    workerLogger.level = "info";

    ({ processWebhookEventBatch } = await import("../webhook-events.worker.js"));
  });

  afterAll(async () => {
    await pool.end();
    vi.restoreAllMocks();
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  async function createFixtureCampaign(workspaceId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }]
        );
        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, created_by_user_id)
           VALUES ($1, 'Fixture campaign', 'sent', $2, 'd-fixture-template', 'sender@fixture.test', 'test-user')
           RETURNING id`,
          [workspaceId, segmentRows[0].id]
        );
        return campaignRows[0].id;
      })
    );
  }

  async function createFixtureContact(workspaceId: string, emailSeed: string): Promise<{ id: string; email: string }> {
    const email = `${emailSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', 'subscribed') RETURNING id`,
          [workspaceId, email]
        );
        return { id: rows[0].id, email };
      })
    );
  }

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

  // A fixed, recent-but-not-too-recent timestamp -- must fall inside
  // classifyOccurredAt's accepted window (roughly now-7d..now+5min) or the
  // event is quarantined instead of inserted.
  function occurredAtNow(): number {
    return Math.floor(Date.now() / 1000) - 60;
  }

  function sendgridEvent(
    workspaceId: string,
    campaignId: string,
    sendId: string,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      email: "hello@world.com",
      event: "delivered",
      sg_event_id: `sg-${randomUUID()}`,
      sg_message_id: "abc.filterdrecv-x",
      timestamp: occurredAtNow(),
      send_id: sendId,
      workspace_id: workspaceId,
      campaign_id: campaignId,
      ...overrides,
    };
  }

  function parseCapturedLines(): Record<string, unknown>[] {
    return stdoutChunks
      .join("")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((parsed): parsed is Record<string, unknown> => parsed !== undefined);
  }

  it("emits a captured log line with sendId equal to the resolved send's id and workspaceId equal to the fixture workspace", async () => {
    const workspaceId = await freshWorkspaceId("sendid-corr-field-lands");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contact = await createFixtureContact(workspaceId, "field-lands");
    const sendId = await createFixtureSend(workspaceId, campaignId, contact.id);

    const events = [sendgridEvent(workspaceId, campaignId, sendId, { event: "delivered" })];
    const result = await processWebhookEventBatch({ workspaceId, events });
    expect(result.inserted).toBe(1);

    const logLines = parseCapturedLines();
    const matchingLine = logLines.find((line) => line.sendId === sendId);

    expect(
      matchingLine,
      `expected a captured worker log line with sendId=${sendId}; captured lines: ${JSON.stringify(logLines)}`
    ).toBeDefined();
    expect(matchingLine?.workspaceId).toBe(workspaceId);
  });

  it("binds sendId per event, not per batch: two sends in one batch produce two lines with two distinct sendId values", async () => {
    // Scope this test's assertions to lines emitted DURING this test --
    // the captured-chunk array is module-scoped and fills across every test
    // in this file, so a bare "exactly two lines carry a sendId" count would
    // fail against a CORRECT implementation once the previous test has
    // already contributed a line. Clearing here is the fix, not a workaround
    // for a source bug.
    stdoutChunks.length = 0;

    const workspaceId = await freshWorkspaceId("sendid-corr-per-event");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactA = await createFixtureContact(workspaceId, "per-event-a");
    const contactB = await createFixtureContact(workspaceId, "per-event-b");
    const sendIdA = await createFixtureSend(workspaceId, campaignId, contactA.id);
    const sendIdB = await createFixtureSend(workspaceId, campaignId, contactB.id);

    const events = [
      sendgridEvent(workspaceId, campaignId, sendIdA, { event: "delivered" }),
      sendgridEvent(workspaceId, campaignId, sendIdB, { event: "delivered" }),
    ];
    const result = await processWebhookEventBatch({ workspaceId, events });
    expect(result.inserted).toBe(2);

    const logLines = parseCapturedLines();
    const linesWithSendId = logLines.filter(
      (line) => line.sendId === sendIdA || line.sendId === sendIdB
    );

    expect(
      linesWithSendId,
      `expected exactly one line per fixture send id; captured lines: ${JSON.stringify(logLines)}`
    ).toHaveLength(2);
    const observedSendIds = new Set(linesWithSendId.map((line) => line.sendId));
    expect(observedSendIds.size, "the two sendId values must be distinct").toBe(2);
    expect(observedSendIds.has(sendIdA)).toBe(true);
    expect(observedSendIds.has(sendIdB)).toBe(true);
  });

  it("never puts the provider reason text or a contact email onto a line carrying a sendId", async () => {
    const workspaceId = await freshWorkspaceId("sendid-corr-no-pii");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contact = await createFixtureContact(workspaceId, "no-pii");
    const sendId = await createFixtureSend(workspaceId, campaignId, contact.id);

    // A real SendGrid bounce/dropped `reason` string routinely embeds the
    // recipient address verbatim -- the reason field is populated at
    // extraction time regardless of event type, so a `delivered` event
    // carrying it still exercises the no-PII guarantee without needing a
    // bounce-specific normalizedType mapping.
    const events = [
      sendgridEvent(workspaceId, campaignId, sendId, {
        event: "delivered",
        reason: `550 5.1.1 The email account that you tried to reach does not exist: ${contact.email}`,
      }),
    ];
    const result = await processWebhookEventBatch({ workspaceId, events });
    expect(result.inserted).toBe(1);

    const logLines = parseCapturedLines();
    const linesWithThisSendId = logLines.filter((line) => line.sendId === sendId);

    expect(
      linesWithThisSendId.length,
      `expected at least one line with sendId=${sendId}; captured lines: ${JSON.stringify(logLines)}`
    ).toBeGreaterThan(0);

    for (const line of linesWithThisSendId) {
      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain(contact.email);
      expect(serialized).not.toContain("does not exist");
    }
  });
});
