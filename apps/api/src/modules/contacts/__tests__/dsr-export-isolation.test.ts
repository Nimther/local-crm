import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenantTransactionRepeatableRead } from "@mega-crm/tenant-context";
import { buildScrubbedSendEventPayload } from "@mega-crm/delivery-core";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../../test/db-fixture.js";
import { withTenant, withTenantTransaction } from "../../../middleware/tenant-context.js";
import { selectSendEventsPage, type SendEventPageRow } from "../dsr-export.repository.js";

/**
 * Phase 21 plan 05 (D-15, SC5): proves the DSR export's mid-scrub snapshot
 * guarantee against a REAL interleaved erasure scrub, with a READ COMMITTED
 * negative control that fails the same assertion. The positive case
 * (`withTenantTransactionRepeatableRead`) and its control
 * (`withTenantTransaction`) sit in the same file, side by side, so they
 * cannot drift apart -- the control is the fail-first evidence that the
 * positive case's guarantee comes from the isolation-level change and not
 * from test timing.
 *
 * The scrub is simulated by reproducing the exact per-row rewrite the real
 * `apps/worker` erasure-scrub worker commits (`buildScrubbedSendEventPayload`
 * applied per row, then an `UPDATE ... WHERE workspace_id = $2 AND id = $3
 * AND occurred_at = $4::timestamptz` keyed exactly like
 * `scrubSendEventsPage` in `erasure-scrub.worker.ts`) on a SEPARATE pool
 * client that this file owns -- no import from `apps/worker` (this
 * workspace does not depend on it; the shared function from
 * `@mega-crm/delivery-core` is the same code the real worker runs).
 */
describe("DSR export mid-scrub snapshot isolation (D-15, SC5, plan 21-05)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
    pool = createTestPool();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // Mirrors dsr-export.test.ts's own per-IP sign-up convention (the
  // /api/auth/* scope is rate-limited to 20 req/min per source IP).
  let nextSignUpIp = 1;
  async function signUp(email: string, password: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password, name },
      remoteAddress: `127.0.4.${nextSignUpIp++}`,
    });
    expect(res.statusCode, `sign-up failed: ${res.body}`).toBe(200);
    const sessionCookie = res.cookies.find((c) => c.name.toLowerCase().includes("session"));
    if (!sessionCookie) throw new Error("sign-up response did not set a session cookie");
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

  async function createContact(ownerCookie: string, slug: string, email: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/contacts`,
      headers: { cookie: ownerCookie },
      payload: { email },
    });
    expect(res.statusCode, `create contact failed: ${res.body}`).toBe(201);
    return res.json<{ id: string }>();
  }

  /** Mirrors dsr-export.test.ts's `seedSend` -- one raw `sends` row, minimal columns. */
  async function seedSend(workspaceId: string, contactId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, contact_id, kind, status, queued_at)
           VALUES ($1, $2, 'campaign', 'sent', now()) RETURNING id`,
          [workspaceId, contactId]
        );
        return rows[0].id;
      })
    );
  }

  /** Mirrors dsr-export.test.ts's `seedSendEvent` -- one raw `send_events` row. */
  async function seedSendEvent(
    workspaceId: string,
    sendId: string,
    occurredAt: Date,
    payload: Record<string, unknown>,
    eventType: string
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, payload, is_test, occurred_at, received_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, false, $6, now())
           RETURNING id`,
          [workspaceId, `sg-evt-${randomUUID()}`, sendId, eventType, JSON.stringify(payload), occurredAt]
        );
        return rows[0].id;
      })
    );
  }

  /**
   * Seeds one workspace/contact/send with three send events, each carrying
   * a distinctive export-only `useragent` value alongside an evidence key
   * (`event`) -- the recognisable value the tests below track across pages
   * and across the scrub.
   */
  async function seedIsolationFixture(nameSeed: string) {
    const owner = await signUp(`owner-${nameSeed}-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, `${nameSeed} Co`);
    const contact = await createContact(owner.cookie, workspace.slug, `${nameSeed}-${Date.now()}@example.test`);
    const sendId = await seedSend(workspace.id, contact.id);

    const recognizableUseragent = `isolation-proof-useragent-${randomUUID()}`;
    const now = Date.now();
    await seedSendEvent(workspace.id, sendId, new Date(now - 3000), { event: "processed", useragent: recognizableUseragent }, "processed");
    await seedSendEvent(workspace.id, sendId, new Date(now - 2000), { event: "delivered", useragent: recognizableUseragent }, "delivered");
    await seedSendEvent(workspace.id, sendId, new Date(now - 1000), { event: "open", useragent: recognizableUseragent }, "open");

    return { workspaceId: workspace.id, contactId: contact.id, sendId, recognizableUseragent };
  }

  /**
   * Reproduces the real `apps/worker` erasure-scrub worker's exact
   * `send_events` rewrite (`scrubSendEventsPage` in
   * `erasure-scrub.worker.ts`) on a SEPARATE pool client this file owns --
   * per-row `buildScrubbedSendEventPayload` then a per-row `UPDATE` keyed on
   * `(workspace_id, id, occurred_at)`, not a bulk rewrite, so the
   * simulation matches what the real worker commits.
   */
  async function runScrubOnSeparateConnection(workspaceId: string, sendId: string): Promise<void> {
    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      const { rows } = await client.query<{ id: string; occurredAt: string; payload: unknown }>(
        `SELECT id, occurred_at::text as "occurredAt", payload FROM send_events WHERE workspace_id = $1 AND send_id = $2`,
        [workspaceId, sendId]
      );
      for (const row of rows) {
        const scrubbed = buildScrubbedSendEventPayload(row.payload);
        await client.query(
          `UPDATE send_events SET payload = $1::jsonb WHERE workspace_id = $2 AND id = $3 AND occurred_at = $4::timestamptz`,
          [JSON.stringify(scrubbed), workspaceId, row.id, row.occurredAt]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  it("REPEATABLE READ: a scrub committing mid-walk cannot change what later pages read (D-15, SC5)", async () => {
    const { workspaceId, contactId, sendId, recognizableUseragent } = await seedIsolationFixture("iso-rr");

    const pages: SendEventPageRow[][] = [];
    await withTenant(workspaceId, () =>
      withTenantTransactionRepeatableRead(async (client) => {
        const page1 = await selectSendEventsPage(client, workspaceId, contactId, null, 1);
        expect(page1).toHaveLength(1);
        pages.push(page1);

        // The scrub commits BETWEEN page 1 and page 2, on a SEPARATE
        // client/transaction -- awaited to completion before the next read,
        // so the sequencing is deterministic -- no timers, no artificial DB delay.
        await runScrubOnSeparateConnection(workspaceId, sendId);

        const page2 = await selectSendEventsPage(
          client,
          workspaceId,
          contactId,
          { timestamp: page1[0].occurredAt, id: page1[0].id },
          1
        );
        expect(page2).toHaveLength(1);
        pages.push(page2);

        const page3 = await selectSendEventsPage(
          client,
          workspaceId,
          contactId,
          { timestamp: page2[0].occurredAt, id: page2[0].id },
          1
        );
        expect(page3).toHaveLength(1);
        pages.push(page3);
      })
    );

    // Every page read inside the REPEATABLE READ transaction -- including
    // the two read AFTER the scrub committed -- still carries the
    // pre-scrub payload.
    for (const page of pages) {
      expect(page[0].payload.useragent).toBe(recognizableUseragent);
    }

    // The scrub was not a no-op: checked on a THIRD client, after the
    // export transaction has already closed, the rows really were
    // rewritten.
    const rowsAfterScrub = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM send_events WHERE workspace_id = $1 AND send_id = $2 ORDER BY occurred_at ASC`,
          [workspaceId, sendId]
        );
        return rows;
      })
    );
    expect(rowsAfterScrub).toHaveLength(3);
    for (const row of rowsAfterScrub) {
      expect(row.payload).not.toHaveProperty("useragent");
    }
  });

  it("READ COMMITTED control: the same interleaving observes the scrubbed rows (fail-first evidence for the case above)", async () => {
    const { workspaceId, contactId, sendId, recognizableUseragent } = await seedIsolationFixture("iso-rc");

    const pages: SendEventPageRow[][] = [];
    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const page1 = await selectSendEventsPage(client, workspaceId, contactId, null, 1);
        expect(page1).toHaveLength(1);
        pages.push(page1);

        await runScrubOnSeparateConnection(workspaceId, sendId);

        const page2 = await selectSendEventsPage(
          client,
          workspaceId,
          contactId,
          { timestamp: page1[0].occurredAt, id: page1[0].id },
          1
        );
        expect(page2).toHaveLength(1);
        pages.push(page2);

        const page3 = await selectSendEventsPage(
          client,
          workspaceId,
          contactId,
          { timestamp: page2[0].occurredAt, id: page2[0].id },
          1
        );
        expect(page3).toHaveLength(1);
        pages.push(page3);
      })
    );

    // Page 1 was read BEFORE the scrub committed -- still the original value.
    expect(pages[0][0].payload.useragent).toBe(recognizableUseragent);

    // Pages 2 and 3 were read AFTER the scrub committed -- under READ
    // COMMITTED, each statement takes a fresh snapshot, so they observe the
    // scrubbed rows. This is the negative control: it MUST fail this
    // assertion if `withTenantTransaction`'s isolation level is ever raised
    // to REPEATABLE READ, or if the export ever stops using the dedicated
    // repeatable-read wrapper -- proving the two wrappers behave
    // differently on the exact same interleaving.
    expect(pages[1][0].payload).not.toHaveProperty("useragent");
    expect(pages[2][0].payload).not.toHaveProperty("useragent");
  });

  it("the export wrapper really is repeatable read (sanity control)", async () => {
    const owner = await signUp(`owner-iso-level-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Isolation Level Co");

    const repeatableReadLevel = await withTenant(workspace.id, () =>
      withTenantTransactionRepeatableRead(async (client) => {
        const { rows } = await client.query<{ level: string }>(`SELECT current_setting('transaction_isolation') as level`);
        return rows[0].level;
      })
    );
    expect(repeatableReadLevel).toBe("repeatable read");

    const readCommittedLevel = await withTenant(workspace.id, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ level: string }>(`SELECT current_setting('transaction_isolation') as level`);
        return rows[0].level;
      })
    );
    expect(readCommittedLevel).toBe("read committed");
  });
});
