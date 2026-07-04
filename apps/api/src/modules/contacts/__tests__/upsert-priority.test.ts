import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { withTenant, withTenantTransaction } from "../../../middleware/tenant-context.js";
import { logger } from "../../../logger.js";
import { createContact, getContact, upsertContactByIdentity } from "../contact.repository.js";

/**
 * upsertContactByIdentity (CONT-04, D-03/D-04/D-06/A1, Pitfall 2/4): the
 * single prioritized two-key upsert shared by this API route, the
 * events:ingest worker (02-06), and the imports:csv worker (02-07).
 * Constructs the exact partial pre-existing contact states each branch
 * requires (Pitfall 2) rather than only exercising the "create new contact"
 * happy path.
 */
describe("upsertContactByIdentity (CONT-04, D-03/D-04/D-06/A1)", () => {
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

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    return workspace.id;
  }

  it("Branch A: external_id match updates the existing contact in place, email untouched", async () => {
    const workspaceId = await freshWorkspaceId("upsert-branch-a");
    const seeded = await withTenant(workspaceId, () =>
      createContact({ externalId: "ext-a-1", email: `a-${Date.now()}@example.com` })
    );

    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        upsertContactByIdentity(client, workspaceId, { externalId: "ext-a-1", firstName: "Updated" })
      )
    );

    expect(result.contactId).toBe(seeded.id);
    const updated = await withTenant(workspaceId, () => getContact(seeded.id));
    expect(updated?.firstName).toBe("Updated");
    expect(updated?.email).toBe(seeded.email);
  });

  it("Branch B (D-03): email match with no external_id yet attaches the incoming external_id", async () => {
    const workspaceId = await freshWorkspaceId("upsert-branch-b");
    const email = `b-${Date.now()}@example.com`;
    const seeded = await withTenant(workspaceId, () => createContact({ email }));
    expect(seeded.externalId).toBeNull();

    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        upsertContactByIdentity(client, workspaceId, { email, externalId: "new-ext-attach" })
      )
    );

    expect(result.contactId).toBe(seeded.id);
    expect(result.attached).toBe(true);
    const updated = await withTenant(workspaceId, () => getContact(seeded.id));
    expect(updated?.externalId).toBe("new-ext-attach");
  });

  it("Branch C (A1): email match whose contact already has a DIFFERENT external_id ignores the incoming one and logs a conflict", async () => {
    const workspaceId = await freshWorkspaceId("upsert-branch-c");
    const email = `c-${Date.now()}@example.com`;
    const seeded = await withTenant(workspaceId, () => createContact({ email, externalId: "existing-ext" }));

    const warnSpy = vi.spyOn(logger, "warn");
    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        upsertContactByIdentity(client, workspaceId, { email, externalId: "different-ext" })
      )
    );

    expect(result.contactId).toBe(seeded.id);
    const updated = await withTenant(workspaceId, () => getContact(seeded.id));
    expect(updated?.externalId).toBe("existing-ext");
    const conflictCall = warnSpy.mock.calls.find(
      ([meta]) => (meta as Record<string, unknown> | undefined)?.reason === "external_id_conflict"
    );
    expect(conflictCall, "expected a structured Pino conflict log for the external_id conflict").toBeTruthy();
    warnSpy.mockRestore();
  });

  it("Branch D (D-04/D-05): incoming email owned by a different contact skips the email change and logs a conflict", async () => {
    const workspaceId = await freshWorkspaceId("upsert-branch-d");
    const emailA = `d-a-${Date.now()}@example.com`;
    const emailB = `d-b-${Date.now()}@example.com`;
    const contactA = await withTenant(workspaceId, () => createContact({ externalId: "cont-a", email: emailA }));
    await withTenant(workspaceId, () => createContact({ email: emailB }));

    const warnSpy = vi.spyOn(logger, "warn");
    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        upsertContactByIdentity(client, workspaceId, { externalId: "cont-a", email: emailB })
      )
    );

    expect(result.contactId).toBe(contactA.id);
    expect(result.emailChangeSkipped).toBe(true);
    const updated = await withTenant(workspaceId, () => getContact(contactA.id));
    expect(updated?.email).toBe(emailA);
    const conflictCall = warnSpy.mock.calls.find(
      ([meta]) => (meta as Record<string, unknown> | undefined)?.reason === "email_conflict"
    );
    expect(conflictCall, "expected a structured Pino conflict log for the email conflict").toBeTruthy();
    warnSpy.mockRestore();
  });

  it("Branch E: no match at all creates a brand new contact", async () => {
    const workspaceId = await freshWorkspaceId("upsert-branch-e");
    const email = `e-${Date.now()}@example.com`;

    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => upsertContactByIdentity(client, workspaceId, { email }))
    );

    expect(result.contactId).toBeTruthy();
    const created = await withTenant(workspaceId, () => getContact(result.contactId));
    expect(created?.email).toBe(email);
    expect(created?.subscriptionStatus).toBe("subscribed");
  });

  it("Pitfall 4: a property literally named subscription_status is stripped and cannot flip the contact's real status", async () => {
    const workspaceId = await freshWorkspaceId("upsert-reserved-key");
    const email = `reserved-${Date.now()}@example.com`;

    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        upsertContactByIdentity(client, workspaceId, {
          email,
          properties: { subscription_status: "suppressed", favoriteColor: "teal" },
        })
      )
    );

    const created = await withTenant(workspaceId, () => getContact(result.contactId));
    expect(created?.subscriptionStatus).toBe("subscribed");
    expect(created?.properties).not.toHaveProperty("subscription_status");
    expect(created?.properties.favoriteColor).toBe("teal");
  });

  it("D-10: a newly observed custom-property key is recorded in the property registry", async () => {
    const workspaceId = await freshWorkspaceId("upsert-registry");
    const email = `registry-${Date.now()}@example.com`;
    const propertyKey = `loyaltyTier${Date.now()}`;

    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        upsertContactByIdentity(client, workspaceId, { email, properties: { [propertyKey]: 3 } })
      )
    );

    const registryRows = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT key, observed_type as "observedType" FROM workspace_property_registry WHERE workspace_id = $1 AND key = $2`,
          [workspaceId, propertyKey]
        );
        return rows;
      })
    );
    expect(registryRows).toHaveLength(1);
    expect(registryRows[0].observedType).toBe("number");
  });
});
