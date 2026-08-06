import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { countSegmentMembers } from "../segment.repository.js";
import type { SegmentDefinition } from "@mega-crm/segments-core";

/**
 * SEGM-02: behavioral EXISTS/NOT EXISTS condition compilation + evaluation
 * (count/timeframe, including D-02 negation and count>1). Seeds events
 * directly via a raw INSERT (mirrors contact-events-read.test.ts's
 * precedent -- the same table the events:ingest worker writes to).
 */
describe("Segment behavioral conditions (SEGM-02)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
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

  async function owner(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    return { ...account, workspace };
  }

  async function createContact(cookie: string, slug: string, externalId: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/contacts`,
      headers: { cookie },
      payload: { externalId },
    });
    expect(res.statusCode, `create contact failed: ${res.body}`).toBe(201);
    return res.json<{ id: string }>();
  }

  async function seedEvent(workspaceId: string, contactId: string, name: string, occurredAt: Date) {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [randomUUID(), workspaceId, contactId, name, {}, occurredAt]
        )
      )
    );
  }

  function def(groups: SegmentDefinition["groups"]): SegmentDefinition {
    return { version: 1, groups };
  }

  it("at_least (count=1) within last_days resolves the expected count", async () => {
    const { cookie, workspace } = await owner("behav-at-least");
    const now = Date.now();
    const recent = await createContact(cookie, workspace.slug, `behav-recent-${now}`);
    const stale = await createContact(cookie, workspace.slug, `behav-stale-${now}`);
    await createContact(cookie, workspace.slug, `behav-never-${now}`);

    await seedEvent(workspace.id, recent.id, "order_placed", new Date(now - 5 * 24 * 60 * 60 * 1000));
    await seedEvent(workspace.id, stale.id, "order_placed", new Date(now - 90 * 24 * 60 * 60 * 1000));

    const count = await withTenant(workspace.id, () =>
      countSegmentMembers(
        def([
          {
            conditions: [
              {
                type: "behavioral",
                eventName: "order_placed",
                countOperator: "at_least",
                count: 1,
                timeframe: { kind: "last_days", days: 30 },
              },
            ],
          },
        ])
      )
    );
    expect(count).toBe(1);
  });

  it("none (negation) over all_time resolves the expected count -- D-02", async () => {
    const { cookie, workspace } = await owner("behav-none");
    const now = Date.now();
    const opened = await createContact(cookie, workspace.slug, `behav-opened-${now}`);
    const neverOpened = await createContact(cookie, workspace.slug, `behav-never-opened-${now}`);

    await seedEvent(workspace.id, opened.id, "opened_email", new Date(now));

    const count = await withTenant(workspace.id, () =>
      countSegmentMembers(
        def([
          {
            conditions: [
              {
                type: "behavioral",
                eventName: "opened_email",
                countOperator: "none",
                timeframe: { kind: "all_time" },
              },
            ],
          },
        ])
      )
    );
    // Both never-opened AND every other contact seeded so far in THIS workspace
    // (only neverOpened) qualify -- opened does not.
    expect(count).toBe(1);
    void neverOpened;
  });

  it("at_least with count>1 honors N, not silently truncated to >=1", async () => {
    const { cookie, workspace } = await owner("behav-count-n");
    const now = Date.now();
    const twice = await createContact(cookie, workspace.slug, `behav-twice-${now}`);
    const once = await createContact(cookie, workspace.slug, `behav-once-${now}`);

    await seedEvent(workspace.id, twice.id, "order_placed", new Date(now - 1000));
    await seedEvent(workspace.id, twice.id, "order_placed", new Date(now - 2000));
    await seedEvent(workspace.id, once.id, "order_placed", new Date(now - 1000));

    const atLeastTwo = await withTenant(workspace.id, () =>
      countSegmentMembers(
        def([
          {
            conditions: [
              {
                type: "behavioral",
                eventName: "order_placed",
                countOperator: "at_least",
                count: 2,
                timeframe: { kind: "all_time" },
              },
            ],
          },
        ])
      )
    );
    expect(atLeastTwo).toBe(1);
  });
});
