import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { countSegmentMembers, isContactInSegment, listSegmentMembers } from "../segment.repository.js";
import type { SegmentDefinition } from "@mega-crm/segments-core";

/**
 * SEGM-03: count(), listMembers(), isMember() must resolve an IDENTICAL
 * membership set for the same definition -- this is the structural
 * guarantee every future consumer (Phase 4 campaigns, Phase 6 flows) relies
 * on, since all three call modes compile through the exact same
 * compileSegmentDefinition WHERE fragment (RESEARCH.md Pattern 2).
 */
describe("Unified segment evaluation contract (SEGM-03)", () => {
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

  async function createContact(cookie: string, slug: string, payload: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/contacts`,
      headers: { cookie },
      payload,
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

  it("count === listMembers set size === number of contacts for which isMember is true", async () => {
    const { cookie, workspace } = await owner("contract-unified");
    const now = Date.now();

    const ruWithOrder = await createContact(cookie, workspace.slug, {
      email: `contract-ru-order-${now}@example.com`,
      country: "RU",
    });
    const ruNoOrder = await createContact(cookie, workspace.slug, {
      email: `contract-ru-noorder-${now}@example.com`,
      country: "RU",
    });
    const kzWithOrder = await createContact(cookie, workspace.slug, {
      email: `contract-kz-order-${now}@example.com`,
      country: "KZ",
    });
    await createContact(cookie, workspace.slug, {
      email: `contract-fr-${now}@example.com`,
      country: "FR",
    });

    await seedEvent(workspace.id, ruWithOrder.id, "order_placed", new Date(now - 1000));
    await seedEvent(workspace.id, kzWithOrder.id, "order_placed", new Date(now - 1000));

    // (country=RU OR country=KZ) AND (order_placed at least once, all_time)
    const definition = def([
      {
        conditions: [
          { type: "attribute", source: "standard", field: "country", operator: "eq", value: "RU" },
          { type: "attribute", source: "standard", field: "country", operator: "eq", value: "KZ" },
        ],
      },
      {
        conditions: [
          {
            type: "behavioral",
            eventName: "order_placed",
            countOperator: "at_least",
            count: 1,
            timeframe: { kind: "all_time" },
          },
        ],
      },
    ]);

    const count = await withTenant(workspace.id, () => countSegmentMembers(definition));
    const { items, total } = await withTenant(workspace.id, () => listSegmentMembers(definition, 1, 50));

    expect(count).toBe(2);
    expect(total).toBe(2);
    expect(items).toHaveLength(2);

    const listedIds = new Set(items.map((c) => c.id));
    expect(listedIds).toEqual(new Set([ruWithOrder.id, kzWithOrder.id]));

    // Point-check every candidate contact -- must agree exactly with the
    // listed set (SEGM-03's structural guarantee).
    const allCandidates = [ruWithOrder.id, ruNoOrder.id, kzWithOrder.id];
    const pointChecks = await Promise.all(
      allCandidates.map((id) => withTenant(workspace.id, () => isContactInSegment(definition, id)))
    );
    const isMemberIds = allCandidates.filter((_, i) => pointChecks[i]);
    expect(new Set(isMemberIds)).toEqual(listedIds);
    expect(isMemberIds).toHaveLength(count);
  });
});
