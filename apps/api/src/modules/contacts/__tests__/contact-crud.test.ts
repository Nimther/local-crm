import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * Contact CRUD (CONT-01, CONT-05, D-01, D-06, D-07): create/read/update/delete
 * a contact through the session-authed API, custom-property round-trip, email
 * uniqueness, external_id immutability, and tenant isolation across
 * workspaces. Drives the real HTTP stack via Fastify's `.inject()` -- mirrors
 * the sign-up + create-workspace harness from sendgrid-key-connect.test.ts.
 */
describe("Contact CRUD (CONT-01, CONT-05)", () => {
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
    return res.json() as { id: string; slug: string; name: string };
  }

  async function owner(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    return { ...account, workspace };
  }

  function contactsUrl(slug: string, id?: string) {
    return id ? `/api/workspaces/${slug}/contacts/${id}` : `/api/workspaces/${slug}/contacts`;
  }

  it("create -> read: custom properties round-trip verbatim (CONT-05)", async () => {
    const { cookie, workspace } = await owner("crud-create-read");

    const createRes = await app.inject({
      method: "POST",
      url: contactsUrl(workspace.slug),
      headers: { cookie },
      payload: {
        email: `crud-${Date.now()}@example.com`,
        firstName: "Ada",
        properties: { favoriteColor: "teal", loyaltyTier: 3, isVip: true },
      },
    });
    expect(createRes.statusCode, `create failed: ${createRes.body}`).toBe(201);
    const created = createRes.json();
    expect(created.id).toBeTruthy();
    expect(created.firstName).toBe("Ada");
    expect(created.properties).toEqual({ favoriteColor: "teal", loyaltyTier: 3, isVip: true });

    const getRes = await app.inject({
      method: "GET",
      url: contactsUrl(workspace.slug, created.id),
      headers: { cookie },
    });
    expect(getRes.statusCode, `get failed: ${getRes.body}`).toBe(200);
    const fetched = getRes.json();
    expect(fetched.id).toBe(created.id);
    expect(fetched.properties).toEqual({ favoriteColor: "teal", loyaltyTier: 3, isVip: true });
  });

  it("D-01: creating a second contact with an email already used in the workspace is rejected", async () => {
    const { cookie, workspace } = await owner("crud-email-unique");
    const email = `dupe-${Date.now()}@example.com`;

    const first = await app.inject({
      method: "POST",
      url: contactsUrl(workspace.slug),
      headers: { cookie },
      payload: { email },
    });
    expect(first.statusCode, `first create failed: ${first.body}`).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: contactsUrl(workspace.slug),
      headers: { cookie },
      payload: { email },
    });
    expect([409, 422]).toContain(second.statusCode);
  });

  it("D-07: updating a contact's email to one used by another contact in the same workspace is rejected", async () => {
    const { cookie, workspace } = await owner("crud-email-update-unique");
    const emailA = `contact-a-${Date.now()}@example.com`;
    const emailB = `contact-b-${Date.now()}@example.com`;

    const a = (
      await app.inject({
        method: "POST",
        url: contactsUrl(workspace.slug),
        headers: { cookie },
        payload: { email: emailA },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: contactsUrl(workspace.slug),
      headers: { cookie },
      payload: { email: emailB },
    });

    const patchRes = await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, a.id),
      headers: { cookie },
      payload: { email: emailB },
    });
    expect([409, 422]).toContain(patchRes.statusCode);
  });

  it("D-07: a contact's email CAN be changed to a fresh, unused email", async () => {
    const { cookie, workspace } = await owner("crud-email-change-ok");
    const created = (
      await app.inject({
        method: "POST",
        url: contactsUrl(workspace.slug),
        headers: { cookie },
        payload: { email: `before-${Date.now()}@example.com` },
      })
    ).json();

    const newEmail = `after-${Date.now()}@example.com`;
    const patchRes = await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, created.id),
      headers: { cookie },
      payload: { email: newEmail },
    });
    expect(patchRes.statusCode, `email change failed: ${patchRes.body}`).toBe(200);
    expect(patchRes.json().email).toBe(newEmail);
  });

  it("D-06: external_id can be set on a contact that had none", async () => {
    const { cookie, workspace } = await owner("crud-extid-set");
    const created = (
      await app.inject({
        method: "POST",
        url: contactsUrl(workspace.slug),
        headers: { cookie },
        payload: { email: `noextid-${Date.now()}@example.com` },
      })
    ).json();
    expect(created.externalId).toBeNull();

    const patchRes = await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, created.id),
      headers: { cookie },
      payload: { externalId: "crm-ext-001" },
    });
    expect(patchRes.statusCode, `set externalId failed: ${patchRes.body}`).toBe(200);
    expect(patchRes.json().externalId).toBe("crm-ext-001");
  });

  it("D-06: an already-set external_id is immutable -- a change attempt is rejected or silently ignored", async () => {
    const { cookie, workspace } = await owner("crud-extid-immutable");
    const created = (
      await app.inject({
        method: "POST",
        url: contactsUrl(workspace.slug),
        headers: { cookie },
        payload: { email: `hasextid-${Date.now()}@example.com`, externalId: "crm-ext-original" },
      })
    ).json();
    expect(created.externalId).toBe("crm-ext-original");

    const patchRes = await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, created.id),
      headers: { cookie },
      payload: { externalId: "crm-ext-changed" },
    });

    if (patchRes.statusCode === 200) {
      // "ignored" branch: external_id must NOT have changed.
      expect(patchRes.json().externalId).toBe("crm-ext-original");
    } else {
      // "rejected" branch.
      expect([409, 422]).toContain(patchRes.statusCode);
    }

    const getRes = await app.inject({
      method: "GET",
      url: contactsUrl(workspace.slug, created.id),
      headers: { cookie },
    });
    expect(getRes.json().externalId).toBe("crm-ext-original");
  });

  it("delete removes the contact -- subsequent GET is 404", async () => {
    const { cookie, workspace } = await owner("crud-delete");
    const created = (
      await app.inject({
        method: "POST",
        url: contactsUrl(workspace.slug),
        headers: { cookie },
        payload: { email: `delete-me-${Date.now()}@example.com` },
      })
    ).json();

    const deleteRes = await app.inject({
      method: "DELETE",
      url: contactsUrl(workspace.slug, created.id),
      headers: { cookie },
    });
    expect(deleteRes.statusCode, `delete failed: ${deleteRes.body}`).toBe(200);

    const getRes = await app.inject({
      method: "GET",
      url: contactsUrl(workspace.slug, created.id),
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(404);
  });

  it("CR-04/CONT-05: removing a custom property (PATCH with the remaining-only object) persists -- the deleted key is gone, not re-merged", async () => {
    const { cookie, workspace } = await owner("crud-prop-delete");
    const created = (
      await app.inject({
        method: "POST",
        url: contactsUrl(workspace.slug),
        headers: { cookie },
        payload: {
          email: `prop-delete-${Date.now()}@example.com`,
          properties: { favoriteColor: "teal", loyaltyTier: 3 },
        },
      })
    ).json();
    expect(created.properties).toEqual({ favoriteColor: "teal", loyaltyTier: 3 });

    // Mirrors CustomPropertyEditor's remove action: it sends the full
    // remaining object (loyaltyTier omitted), not a delete marker.
    const patchRes = await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, created.id),
      headers: { cookie },
      payload: { properties: { favoriteColor: "teal" } },
    });
    expect(patchRes.statusCode, `patch failed: ${patchRes.body}`).toBe(200);

    const getRes = await app.inject({
      method: "GET",
      url: contactsUrl(workspace.slug, created.id),
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().properties).toEqual({ favoriteColor: "teal" });
    expect(Object.keys(getRes.json().properties)).not.toContain("loyaltyTier");
  });

  it("CR-04/CONT-01: clearing a standard field (firstName/phone) to null persists -- untouched fields (city) are unaffected", async () => {
    const { cookie, workspace } = await owner("crud-field-clear");
    const created = (
      await app.inject({
        method: "POST",
        url: contactsUrl(workspace.slug),
        headers: { cookie },
        payload: {
          email: `field-clear-${Date.now()}@example.com`,
          firstName: "Ada",
          phone: "555",
          city: "Paris",
        },
      })
    ).json();
    expect(created.firstName).toBe("Ada");
    expect(created.phone).toBe("555");
    expect(created.city).toBe("Paris");

    const patchRes = await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, created.id),
      headers: { cookie },
      payload: { firstName: null, phone: null },
    });
    expect(patchRes.statusCode, `patch failed: ${patchRes.body}`).toBe(200);

    const getRes = await app.inject({
      method: "GET",
      url: contactsUrl(workspace.slug, created.id),
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(200);
    const fetched = getRes.json();
    expect(fetched.firstName).toBeNull();
    expect(fetched.phone).toBeNull();
    expect(fetched.city).toBe("Paris");
  });

  it("CR-04: an Overview-tab edit (PATCH with no properties key) never wipes existing custom properties", async () => {
    const { cookie, workspace } = await owner("crud-no-wipe");
    const created = (
      await app.inject({
        method: "POST",
        url: contactsUrl(workspace.slug),
        headers: { cookie },
        payload: {
          email: `no-wipe-${Date.now()}@example.com`,
          lastName: "Byron",
          properties: { plan: "pro" },
        },
      })
    ).json();
    expect(created.properties).toEqual({ plan: "pro" });

    // No `properties` key in the body at all -- the Overview tab's payload shape.
    const patchRes = await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, created.id),
      headers: { cookie },
      payload: { lastName: "Lovelace" },
    });
    expect(patchRes.statusCode, `patch failed: ${patchRes.body}`).toBe(200);

    const getRes = await app.inject({
      method: "GET",
      url: contactsUrl(workspace.slug, created.id),
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(200);
    const fetched = getRes.json();
    expect(fetched.lastName).toBe("Lovelace");
    expect(fetched.properties).toEqual({ plan: "pro" });
  });

  it("tenant isolation: a contact created in workspace A is not returned by workspace B's list route", async () => {
    const { cookie: cookieA, workspace: workspaceA } = await owner("crud-isolation-a");
    const { cookie: cookieB, workspace: workspaceB } = await owner("crud-isolation-b");

    const created = (
      await app.inject({
        method: "POST",
        url: contactsUrl(workspaceA.slug),
        headers: { cookie: cookieA },
        payload: { email: `isolated-${Date.now()}@example.com` },
      })
    ).json();

    const listB = await app.inject({
      method: "GET",
      url: contactsUrl(workspaceB.slug),
      headers: { cookie: cookieB },
    });
    expect(listB.statusCode, `list B failed: ${listB.body}`).toBe(200);
    const idsInB = (listB.json().items as Array<{ id: string }>).map((c) => c.id);
    expect(idsInB).not.toContain(created.id);

    const listA = await app.inject({
      method: "GET",
      url: contactsUrl(workspaceA.slug),
      headers: { cookie: cookieA },
    });
    const idsInA = (listA.json().items as Array<{ id: string }>).map((c) => c.id);
    expect(idsInA).toContain(created.id);
  });
});
