import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";
import {
  SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST,
  ERASURE_SCRUB_PAGE_LIMIT,
  buildScrubbedSendEventPayload,
  buildScrubbedEventProperties,
  scrubSendEventsPage,
  scrubEventsPage,
  runErasureScrub,
} from "../erasure-scrub.worker.js";
import { loadErasureScrubCheckpoint } from "../erasure-scrub-checkpoint.js";

/**
 * Phase 13 (CMP-04, D-01/D-04, plan 13-13), Task 1: the pure allowlist
 * reconstruction functions. Task 2 extends this file with the checkpointed,
 * bounded scrub over real `sends`/`send_events`/`events` rows.
 */
describe("buildScrubbedSendEventPayload (Task 1, T-13-13-01/03/06)", () => {
  function realisticSendGridPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      email: "erased@example.test",
      event: "bounce",
      type: "blocked",
      sg_event_id: "sg-event-fixture-1",
      sg_message_id: "sg-message-fixture-1.filterdrecv-x",
      "smtp-id": "<fixture@sendgrid.net>",
      timestamp: 1_700_000_000,
      status: "5.1.1",
      attempt: "1",
      asm_group_id: 42,
      bounce_classification: "hard bounce",
      // The two clearest denylist-failure cases (REVIEWS.md BLOCKER finding
      // 4): neither key name looks PII-shaped, yet the address is a
      // substring of a longer diagnostic string.
      reason: "550 5.1.1 <erased@example.test> User unknown",
      response: "550 5.1.1 The email account that you tried to reach does not exist: erased@example.test",
      // A tenant-invented key with an ordinary string value.
      custom_tenant_field: "some ordinary string",
      // A tenant-invented key holding a person's name -- no key-pattern or
      // value-pattern rule detects this shape.
      customer_full_name: "Ivan Petrov",
      // A nested object under a non-allowlisted key.
      unique_args: { order_id: "ord-123", nested: { deeper: "still PII-adjacent" } },
      ip: "203.0.113.5",
      useragent: "Mozilla/5.0",
      url: "https://tenant.example/click?rcpt=erased@example.test",
      url_offset: { index: 0, type: "html" },
      category: ["welcome-series"],
      ...overrides,
    };
  }

  it("returns an object whose key set is a subset of the allowlist", () => {
    const result = buildScrubbedSendEventPayload(realisticSendGridPayload());
    for (const key of Object.keys(result)) {
      expect(SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST as readonly string[]).toContain(key);
    }
  });

  it("drops the top-level email key and keeps event/timestamp/sg_event_id with original values", () => {
    const input = realisticSendGridPayload();
    const result = buildScrubbedSendEventPayload(input);
    expect(result).not.toHaveProperty("email");
    expect(result.event).toBe(input.event);
    expect(result.timestamp).toBe(input.timestamp);
    expect(result.sg_event_id).toBe(input.sg_event_id);
  });

  it("drops reason and response (SMTP text embedding the recipient address verbatim inside a longer string)", () => {
    const result = buildScrubbedSendEventPayload(realisticSendGridPayload());
    expect(result).not.toHaveProperty("reason");
    expect(result).not.toHaveProperty("response");
    expect(JSON.stringify(result)).not.toContain("erased@example.test");
  });

  it("drops a tenant-defined key matching no rule in any redaction vocabulary, with an ordinary string value", () => {
    const result = buildScrubbedSendEventPayload(realisticSendGridPayload());
    expect(result).not.toHaveProperty("custom_tenant_field");
  });

  it("drops a never-seen-before key whose value is a person's full name", () => {
    const result = buildScrubbedSendEventPayload(realisticSendGridPayload());
    expect(result).not.toHaveProperty("customer_full_name");
    expect(JSON.stringify(result)).not.toContain("Ivan Petrov");
  });

  it("drops a nested object entirely when its key is not allowlisted, without needing to inspect nested contents", () => {
    const result = buildScrubbedSendEventPayload(realisticSendGridPayload());
    expect(result).not.toHaveProperty("unique_args");
    expect(JSON.stringify(result)).not.toContain("nested");
  });

  it("omits an allowlisted key absent from the input rather than inserting it as null", () => {
    const result = buildScrubbedSendEventPayload({ event: "delivered" });
    expect(result).toEqual({ event: "delivered" });
    expect(result).not.toHaveProperty("sg_event_id");
  });

  it("leaves event, timestamp, sg_event_id present with original values on a realistic fixture", () => {
    const input = realisticSendGridPayload();
    const result = buildScrubbedSendEventPayload(input);
    expect(result.event).toBe(input.event);
    expect(result.timestamp).toBe(input.timestamp);
    expect(result.sg_event_id).toBe(input.sg_event_id);
  });

  it("is idempotent: applying twice equals applying once", () => {
    const input = realisticSendGridPayload();
    const once = buildScrubbedSendEventPayload(input);
    const twice = buildScrubbedSendEventPayload(once);
    expect(twice).toEqual(once);
  });

  it("returns an empty object for null, an array, or a non-object input, without throwing", () => {
    expect(buildScrubbedSendEventPayload(null)).toEqual({});
    expect(buildScrubbedSendEventPayload([1, 2])).toEqual({});
    expect(buildScrubbedSendEventPayload("not an object")).toEqual({});
    expect(buildScrubbedSendEventPayload(undefined)).toEqual({});
  });

  it("for every key in the output over an input that is a strict superset of the allowlist, that key is a member of the allowlist", () => {
    const superset: Record<string, unknown> = {};
    for (const key of SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST) {
      superset[key] = `value-for-${key}`;
    }
    superset.extra_field_not_on_allowlist = "should not survive";
    const result = buildScrubbedSendEventPayload(superset);
    for (const key of Object.keys(result)) {
      expect(SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST as readonly string[]).toContain(key);
    }
    expect(result).not.toHaveProperty("extra_field_not_on_allowlist");
  });
});

describe("buildScrubbedEventProperties (Task 1, T-13-13-01)", () => {
  it("returns an empty object for every input, including one containing only innocuous keys", () => {
    expect(buildScrubbedEventProperties({ order_total: 42, shipping_address: "123 Main St" })).toEqual({});
    expect(buildScrubbedEventProperties({ favorite_color: "blue" })).toEqual({});
    expect(buildScrubbedEventProperties({})).toEqual({});
    expect(buildScrubbedEventProperties(null)).toEqual({});
  });

  it("is idempotent: applying twice equals applying once", () => {
    const once = buildScrubbedEventProperties({ anything: "at all" });
    const twice = buildScrubbedEventProperties(once);
    expect(twice).toEqual(once);
    expect(twice).toEqual({});
  });

  it("imports nothing from @mega-crm/redaction and defines no PII-shaped regular expression (module source check)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.resolve(import.meta.dirname, "../erasure-scrub.worker.ts"),
      "utf8"
    );
    // The check is against the source file's IMPORT list, not its prose --
    // the package name appears in this module's own doc comments to explain
    // why it is NOT the mechanism used here.
    expect(source).not.toMatch(/from\s+["']@mega-crm\/redaction["']/);
    // no email/phone-shaped regex literal defined in this module
    expect(source).not.toMatch(/\/[a-zA-Z0-9@.]*@[a-zA-Z0-9.]*\//); // no inline @-containing regex literal
  });
});

/**
 * Task 2: real-Postgres, checkpointed, bounded scrub over `sends`,
 * `send_events`, and `events`.
 */
describe("erasure scrub: checkpointed bounded walk over sends/send_events/events (Task 2)", () => {
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
    return insertFixtureOrganization(nameSeed);
  }

  async function createFixtureContact(workspaceId: string, email: string): Promise<string> {
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

  let sendEventSeq = 0;

  async function createFixtureSendEvent(
    workspaceId: string,
    sendId: string,
    email: string,
    occurredAtOffsetSeconds: number
  ): Promise<{ id: string; occurredAt: Date }> {
    sendEventSeq += 1;
    const occurredAt = new Date(Date.now() - 3600_000 + occurredAtOffsetSeconds * 1000);
    const payload = {
      email,
      event: "delivered",
      sg_event_id: `sg-event-${sendEventSeq}`,
      sg_message_id: `sg-message-${sendEventSeq}`,
      timestamp: Math.floor(occurredAt.getTime() / 1000),
      reason: `informational only, mentions ${email}`,
    };
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string; occurredAt: Date }>(
          `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, payload, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'delivered', $4::jsonb, $5)
           RETURNING id, occurred_at as "occurredAt"`,
          [workspaceId, payload.sg_event_id, sendId, JSON.stringify(payload), occurredAt]
        );
        return rows[0];
      })
    );
  }

  async function createFixtureEvent(
    workspaceId: string,
    contactId: string,
    email: string,
    occurredAtOffsetSeconds: number
  ): Promise<{ id: string; occurredAt: Date }> {
    const occurredAt = new Date(Date.now() - 3600_000 + occurredAtOffsetSeconds * 1000);
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string; occurredAt: Date }>(
          `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, 'placed_order', $3::jsonb, $4)
           RETURNING id, occurred_at as "occurredAt"`,
          [workspaceId, contactId, JSON.stringify({ order_total: 42, contact_email: email }), occurredAt]
        );
        return rows[0];
      })
    );
  }

  async function createFixtureErasureRecord(workspaceId: string, contactId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO erasure_records (workspace_id, contact_id, anonymized_at, status)
           VALUES ($1, $2, now(), 'pending') RETURNING id`,
          [workspaceId, contactId]
        );
        return rows[0].id;
      })
    );
  }

  interface ErasureRecordRow {
    status: string;
    sendsScrubbed: number;
    eventsScrubbed: number;
    scrubCompletedAt: Date | null;
    scrubError: string | null;
    sendsScrubCursor: unknown;
    eventsScrubCursor: unknown;
  }

  async function readErasureRecord(workspaceId: string, erasureRecordId: string): Promise<ErasureRecordRow> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<ErasureRecordRow>(
          `SELECT status, sends_scrubbed as "sendsScrubbed", events_scrubbed as "eventsScrubbed",
                  scrub_completed_at as "scrubCompletedAt", scrub_error as "scrubError",
                  sends_scrub_cursor as "sendsScrubCursor", events_scrub_cursor as "eventsScrubCursor"
           FROM erasure_records WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, erasureRecordId]
        );
        return rows[0];
      })
    );
  }

  async function readSendEventPayloads(workspaceId: string, contactId: string): Promise<Record<string, unknown>[]> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ payload: Record<string, unknown> }>(
          `SELECT se.payload FROM send_events se JOIN sends s ON s.id = se.send_id
           WHERE se.workspace_id = $1 AND s.contact_id = $2`,
          [workspaceId, contactId]
        );
        return rows.map((r) => r.payload);
      })
    );
  }

  async function readSendEventsFacts(
    workspaceId: string,
    contactId: string
  ): Promise<{ eventType: string; occurredAt: Date }[]> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ eventType: string; occurredAt: Date }>(
          `SELECT se.event_type as "eventType", se.occurred_at as "occurredAt"
           FROM send_events se JOIN sends s ON s.id = se.send_id
           WHERE se.workspace_id = $1 AND s.contact_id = $2`,
          [workspaceId, contactId]
        );
        return rows;
      })
    );
  }

  async function readEventProperties(workspaceId: string, contactId: string): Promise<Record<string, unknown>[]> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ properties: Record<string, unknown> }>(
          `SELECT properties FROM events WHERE workspace_id = $1 AND contact_id = $2`,
          [workspaceId, contactId]
        );
        return rows.map((r) => r.properties);
      })
    );
  }

  async function sendEventsRowCount(workspaceId: string, contactId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT se.id FROM send_events se JOIN sends s ON s.id = se.send_id
           WHERE se.workspace_id = $1 AND s.contact_id = $2`,
          [workspaceId, contactId]
        );
        return rows.length;
      })
    );
  }

  it("scrubs 5 linked send_events and 3 linked events, records counts, marks complete, and preserves evidence fields", async () => {
    const workspaceId = await freshWorkspaceId("erasure-scrub-basic");
    const email = "erased-basic@example.test";
    const contactId = await createFixtureContact(workspaceId, email);
    const campaignId = await createFixtureCampaign(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);
    for (let i = 0; i < 5; i += 1) {
      await createFixtureSendEvent(workspaceId, sendId, email, i);
    }
    for (let i = 0; i < 3; i += 1) {
      await createFixtureEvent(workspaceId, contactId, email, i);
    }
    const erasureRecordId = await createFixtureErasureRecord(workspaceId, contactId);

    await runErasureScrub({ workspaceId, contactId, erasureRecordId });

    const record = await readErasureRecord(workspaceId, erasureRecordId);
    expect(record.status).toBe("complete");
    expect(record.sendsScrubbed).toBe(5);
    expect(record.eventsScrubbed).toBe(3);
    expect(record.scrubCompletedAt).not.toBeNull();

    const payloads = await readSendEventPayloads(workspaceId, contactId);
    expect(payloads).toHaveLength(5);
    for (const payload of payloads) {
      expect(JSON.stringify(payload)).not.toContain(email);
      for (const key of Object.keys(payload)) {
        expect(SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST as readonly string[]).toContain(key);
      }
    }

    const properties = await readEventProperties(workspaceId, contactId);
    expect(properties).toHaveLength(3);
    for (const props of properties) {
      expect(props).toEqual({});
    }

    const facts = await readSendEventsFacts(workspaceId, contactId);
    expect(facts).toHaveLength(5);
    for (const fact of facts) {
      expect(fact.eventType).toBe("delivered");
      expect(fact.occurredAt).toBeInstanceOf(Date);
    }

    expect(await sendEventsRowCount(workspaceId, contactId)).toBe(5); // rows rewritten, never deleted
  });

  it("completes with both counts zero for a contact with no linked rows", async () => {
    const workspaceId = await freshWorkspaceId("erasure-scrub-empty");
    const email = "erased-empty@example.test";
    const contactId = await createFixtureContact(workspaceId, email);
    const erasureRecordId = await createFixtureErasureRecord(workspaceId, contactId);

    await runErasureScrub({ workspaceId, contactId, erasureRecordId });

    const record = await readErasureRecord(workspaceId, erasureRecordId);
    expect(record.status).toBe("complete");
    expect(record.sendsScrubbed).toBe(0);
    expect(record.eventsScrubbed).toBe(0);
  });

  it("re-running a completed scrub job is a no-op and does not reset the record", async () => {
    const workspaceId = await freshWorkspaceId("erasure-scrub-replay");
    const email = "erased-replay@example.test";
    const contactId = await createFixtureContact(workspaceId, email);
    const campaignId = await createFixtureCampaign(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);
    await createFixtureSendEvent(workspaceId, sendId, email, 0);
    const erasureRecordId = await createFixtureErasureRecord(workspaceId, contactId);

    await runErasureScrub({ workspaceId, contactId, erasureRecordId });
    const firstRun = await readErasureRecord(workspaceId, erasureRecordId);
    expect(firstRun.status).toBe("complete");
    expect(firstRun.sendsScrubbed).toBe(1);

    await runErasureScrub({ workspaceId, contactId, erasureRecordId });
    const secondRun = await readErasureRecord(workspaceId, erasureRecordId);
    expect(secondRun.status).toBe("complete");
    expect(secondRun.sendsScrubbed).toBe(1);
    expect(secondRun.scrubCompletedAt).toEqual(firstRun.scrubCompletedAt);
  });

  it("a scrub over more rows than the page limit advances the cursor per page and completes with correct totals", async () => {
    const workspaceId = await freshWorkspaceId("erasure-scrub-multipage");
    const email = "erased-multipage@example.test";
    const contactId = await createFixtureContact(workspaceId, email);
    const campaignId = await createFixtureCampaign(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

    const total = ERASURE_SCRUB_PAGE_LIMIT + 50;
    for (let i = 0; i < total; i += 1) {
      await createFixtureSendEvent(workspaceId, sendId, email, i);
    }
    const erasureRecordId = await createFixtureErasureRecord(workspaceId, contactId);

    await runErasureScrub({ workspaceId, contactId, erasureRecordId });

    const record = await readErasureRecord(workspaceId, erasureRecordId);
    expect(record.status).toBe("complete");
    expect(record.sendsScrubbed).toBe(total);

    const payloads = await readSendEventPayloads(workspaceId, contactId);
    expect(payloads).toHaveLength(total);
    for (const payload of payloads) {
      expect(JSON.stringify(payload)).not.toContain(email);
    }
  }, 60_000);

  it("a fresh erasure record has null cursors, and a page advance leaves a value distinguishable from null", async () => {
    const workspaceId = await freshWorkspaceId("erasure-scrub-cursor-shape");
    const email = "erased-cursor@example.test";
    const contactId = await createFixtureContact(workspaceId, email);
    const campaignId = await createFixtureCampaign(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);
    await createFixtureSendEvent(workspaceId, sendId, email, 0);
    const erasureRecordId = await createFixtureErasureRecord(workspaceId, contactId);

    const fresh = await readErasureRecord(workspaceId, erasureRecordId);
    expect(fresh.sendsScrubCursor).toBeNull();
    expect(fresh.eventsScrubCursor).toBeNull();

    await runErasureScrub({ workspaceId, contactId, erasureRecordId });

    const finished = await readErasureRecord(workspaceId, erasureRecordId);
    expect(finished.sendsScrubCursor).not.toBeNull();
    expect(finished.eventsScrubCursor).not.toBeNull();
    expect(finished.sendsScrubCursor).toEqual({ done: true });
    expect(finished.eventsScrubCursor).toEqual({ done: true });

    const sendsCursor = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => loadErasureScrubCheckpoint(client, workspaceId, erasureRecordId, "sends"))
    );
    expect(sendsCursor).toEqual({ done: true });
  });

  it("a job whose erasure_records row does not exist is a defensive no-op", async () => {
    const workspaceId = await freshWorkspaceId("erasure-scrub-missing-record");
    const email = "erased-missing@example.test";
    const contactId = await createFixtureContact(workspaceId, email);
    const bogusErasureRecordId = "00000000-0000-4000-8000-000000000099";

    await expect(
      runErasureScrub({ workspaceId, contactId, erasureRecordId: bogusErasureRecordId })
    ).resolves.toBeUndefined();
  });

  it("when a page's UPDATE throws, the erasure record is left failed with the error recorded, not pending", async () => {
    const workspaceId = await freshWorkspaceId("erasure-scrub-failure");
    const email = "erased-failure@example.test";
    const contactId = await createFixtureContact(workspaceId, email);
    const campaignId = await createFixtureCampaign(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);
    await createFixtureSendEvent(workspaceId, sendId, email, 0);
    const erasureRecordId = await createFixtureErasureRecord(workspaceId, contactId);

    // Pre-seed a malformed in-progress cursor directly on the erasure
    // record -- `runErasureScrub` will read this cursor and pass it into
    // `scrubSendEventsPage`'s keyset WHERE clause, where Postgres fails to
    // cast "not-a-valid-timestamp" to `timestamptz`. This exercises the same
    // failure path a real malformed/corrupted checkpoint would hit, without
    // needing to inject a fault into the driver itself.
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `UPDATE erasure_records SET sends_scrub_cursor = $1::jsonb WHERE workspace_id = $2 AND id = $3`,
          [
            JSON.stringify({ done: false, occurredAt: "not-a-valid-timestamp", id: "00000000-0000-4000-8000-000000000001" }),
            workspaceId,
            erasureRecordId,
          ]
        )
      )
    );

    await expect(runErasureScrub({ workspaceId, contactId, erasureRecordId })).rejects.toThrow();

    const record = await readErasureRecord(workspaceId, erasureRecordId);
    expect(record.status).toBe("failed");
    expect(record.scrubError).not.toBeNull();
  });

  it("scrubSendEventsPage commits the checkpoint advance in the SAME transaction as the page's UPDATE (T-13-13-02)", async () => {
    const workspaceId = await freshWorkspaceId("erasure-scrub-same-tx");
    const email = "erased-same-tx@example.test";
    const contactId = await createFixtureContact(workspaceId, email);
    const campaignId = await createFixtureCampaign(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);
    await createFixtureSendEvent(workspaceId, sendId, email, 0);
    const erasureRecordId = await createFixtureErasureRecord(workspaceId, contactId);

    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const result = await scrubSendEventsPage(client, workspaceId, contactId, erasureRecordId, null);
        expect(result.processed).toBe(1);

        // Read the checkpoint back on the SAME client, BEFORE this
        // transaction commits -- if the advance were in a separate,
        // already-committed transaction this would trivially pass; reading
        // it uncommitted on the same connection is what proves same-tx.
        const cursor = await loadErasureScrubCheckpoint(client, workspaceId, erasureRecordId, "sends");
        expect(cursor).toEqual(result.cursor);
      })
    );
  });

  it("scrubEventsPage rewrites properties to an empty object via one bulk UPDATE bounded to the page's ids", async () => {
    const workspaceId = await freshWorkspaceId("erasure-scrub-events-page");
    const email = "erased-events-page@example.test";
    const contactId = await createFixtureContact(workspaceId, email);
    await createFixtureEvent(workspaceId, contactId, email, 0);
    await createFixtureEvent(workspaceId, contactId, email, 1);
    const erasureRecordId = await createFixtureErasureRecord(workspaceId, contactId);

    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => scrubEventsPage(client, workspaceId, contactId, erasureRecordId, null))
    );
    expect(result.processed).toBe(2);

    const properties = await readEventProperties(workspaceId, contactId);
    expect(properties).toEqual([{}, {}]);
  });
});
