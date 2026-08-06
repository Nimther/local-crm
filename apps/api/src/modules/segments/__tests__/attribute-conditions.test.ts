import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { countSegmentMembers } from "../segment.repository.js";
import type { SegmentDefinition } from "@mega-crm/segments-core";

/**
 * SEGM-01: profile-attribute condition compilation + evaluation against
 * seeded contacts -- country eq/neq, tag has_tag/not_has_tag, custom-property
 * eq, is_empty/is_not_empty. Drives the real HTTP contacts-create route to
 * seed fixtures (mirrors contact-crud.test.ts's harness), then calls
 * countSegmentMembers directly (segments.routes.ts doesn't exist until
 * 03-02 Task 3).
 */
describe("Segment attribute conditions (SEGM-01)", () => {
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

  async function createContact(
    cookie: string,
    slug: string,
    payload: Record<string, unknown>
  ) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/contacts`,
      headers: { cookie },
      payload,
    });
    expect(res.statusCode, `create contact failed: ${res.body}`).toBe(201);
    return res.json<{ id: string }>();
  }

  function def(groups: SegmentDefinition["groups"]): SegmentDefinition {
    return { version: 1, groups };
  }

  it("country eq/neq resolves the expected count", async () => {
    const { cookie, workspace } = await owner("attr-country");
    await createContact(cookie, workspace.slug, { email: `ru1-${Date.now()}@example.com`, country: "RU" });
    await createContact(cookie, workspace.slug, { email: `ru2-${Date.now()}@example.com`, country: "RU" });
    await createContact(cookie, workspace.slug, { email: `kz1-${Date.now()}@example.com`, country: "KZ" });

    const eqCount = await withTenant(workspace.id, () =>
      countSegmentMembers(
        def([{ conditions: [{ type: "attribute", source: "standard", field: "country", operator: "eq", value: "RU" }] }])
      )
    );
    expect(eqCount).toBe(2);

    const neqCount = await withTenant(workspace.id, () =>
      countSegmentMembers(
        def([{ conditions: [{ type: "attribute", source: "standard", field: "country", operator: "neq", value: "RU" }] }])
      )
    );
    expect(neqCount).toBe(1);
  });

  it("has_tag/not_has_tag resolves the expected count", async () => {
    const { cookie, workspace } = await owner("attr-tags");
    await createContact(cookie, workspace.slug, { email: `vip1-${Date.now()}@example.com`, tags: ["vip"] });
    await createContact(cookie, workspace.slug, { email: `vip2-${Date.now()}@example.com`, tags: ["vip", "eu"] });
    await createContact(cookie, workspace.slug, { email: `notvip-${Date.now()}@example.com`, tags: ["eu"] });

    const hasTag = await withTenant(workspace.id, () =>
      countSegmentMembers(
        def([{ conditions: [{ type: "attribute", source: "standard", field: "tags", operator: "has_tag", value: "vip" }] }])
      )
    );
    expect(hasTag).toBe(2);

    const notHasTag = await withTenant(workspace.id, () =>
      countSegmentMembers(
        def([{ conditions: [{ type: "attribute", source: "standard", field: "tags", operator: "not_has_tag", value: "vip" }] }])
      )
    );
    expect(notHasTag).toBe(1);
  });

  it("custom-property eq resolves the expected count", async () => {
    const { cookie, workspace } = await owner("attr-custom-eq");
    await createContact(cookie, workspace.slug, {
      email: `pro1-${Date.now()}@example.com`,
      properties: { plan: "pro" },
    });
    await createContact(cookie, workspace.slug, {
      email: `free1-${Date.now()}@example.com`,
      properties: { plan: "free" },
    });

    const count = await withTenant(workspace.id, () =>
      countSegmentMembers(
        def([{ conditions: [{ type: "attribute", source: "custom", field: "plan", operator: "eq", value: "pro" }] }])
      )
    );
    expect(count).toBe(1);
  });

  it("is_empty/is_not_empty resolves the expected count for a custom property", async () => {
    const { cookie, workspace } = await owner("attr-custom-empty");
    await createContact(cookie, workspace.slug, {
      email: `coupon-set-${Date.now()}@example.com`,
      properties: { coupon: "SAVE10" },
    });
    await createContact(cookie, workspace.slug, {
      email: `coupon-unset-${Date.now()}@example.com`,
      properties: {},
    });

    const isNotEmpty = await withTenant(workspace.id, () =>
      countSegmentMembers(
        def([{ conditions: [{ type: "attribute", source: "custom", field: "coupon", operator: "is_not_empty" }] }])
      )
    );
    expect(isNotEmpty).toBe(1);

    const isEmpty = await withTenant(workspace.id, () =>
      countSegmentMembers(
        def([{ conditions: [{ type: "attribute", source: "custom", field: "coupon", operator: "is_empty" }] }])
      )
    );
    expect(isEmpty).toBe(1);
  });

  it("two-tier AND/OR: (country=RU OR country=KZ) matches both, AND'd with a tag filter narrows further", async () => {
    const { cookie, workspace } = await owner("attr-and-or");
    await createContact(cookie, workspace.slug, { email: `ru-vip-${Date.now()}@example.com`, country: "RU", tags: ["vip"] });
    await createContact(cookie, workspace.slug, { email: `kz-vip-${Date.now()}@example.com`, country: "KZ", tags: ["vip"] });
    await createContact(cookie, workspace.slug, { email: `ru-novip-${Date.now()}@example.com`, country: "RU", tags: [] });

    const orOnly = await withTenant(workspace.id, () =>
      countSegmentMembers(
        def([
          {
            conditions: [
              { type: "attribute", source: "standard", field: "country", operator: "eq", value: "RU" },
              { type: "attribute", source: "standard", field: "country", operator: "eq", value: "KZ" },
            ],
          },
        ])
      )
    );
    expect(orOnly).toBe(3);

    const orAndTag = await withTenant(workspace.id, () =>
      countSegmentMembers(
        def([
          {
            conditions: [
              { type: "attribute", source: "standard", field: "country", operator: "eq", value: "RU" },
              { type: "attribute", source: "standard", field: "country", operator: "eq", value: "KZ" },
            ],
          },
          { conditions: [{ type: "attribute", source: "standard", field: "tags", operator: "has_tag", value: "vip" }] },
        ])
      )
    );
    expect(orAndTag).toBe(2);
  });
});
