import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../../test/db-fixture.js";
import { withTenant, withTenantTransaction } from "../../../middleware/tenant-context.js";
import { logger } from "@mega-crm/contacts-core";
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

  /**
   * CR-02 (02-11 gap closure): the unique-violation retry at the bottom of
   * Branch E currently recurses on the SAME client without first issuing
   * `ROLLBACK TO SAVEPOINT` -- the connection's transaction is already
   * aborted after the failed INSERT, so the retry's first statement (the
   * SELECT) throws 25P02 instead of resolving to the winning row. This test
   * drives a REAL concurrent double-insert (two independent pooled
   * connections racing the exact same brand-new identity) rather than
   * mocking the interleave, so it exercises the genuine 23505 Postgres
   * raises when both connections' SELECTs miss and both INSERTs collide.
   */
  it("CR-02 (Test A): a concurrent double-insert on a brand-new identity resolves to a single contact without surfacing 25P02", async () => {
    const workspaceId = await freshWorkspaceId("upsert-race");
    const email = `race-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

    const racePool = createTestPool();
    try {
      const clientA = await racePool.connect();
      const clientB = await racePool.connect();

      await clientA.query("BEGIN");
      await clientA.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      await clientB.query("BEGIN");
      await clientB.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);

      async function raceUpsert(client: PoolClient) {
        try {
          const result = await upsertContactByIdentity(client, workspaceId, { email });
          await client.query("COMMIT");
          return result;
        } catch (err) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // connection may already be dead/aborted beyond recovery -- release() below handles cleanup
          }
          throw err;
        } finally {
          client.release();
        }
      }

      // Both connections race the SAME brand-new identity: neither's
      // internal SELECT can see the other's row yet, so both fall into
      // Branch E and both attempt the INSERT -- exactly the 23505 race the
      // SAVEPOINT retry is meant to defend against.
      const [outcomeA, outcomeB] = await Promise.allSettled([raceUpsert(clientA), raceUpsert(clientB)]);

      expect(
        outcomeA.status,
        `client A's upsertContactByIdentity should resolve, not throw: ${
          outcomeA.status === "rejected" ? outcomeA.reason : ""
        }`
      ).toBe("fulfilled");
      expect(
        outcomeB.status,
        `client B's upsertContactByIdentity should resolve, not throw: ${
          outcomeB.status === "rejected" ? outcomeB.reason : ""
        }`
      ).toBe("fulfilled");

      const contactIdA = outcomeA.status === "fulfilled" ? outcomeA.value.contactId : undefined;
      const contactIdB = outcomeB.status === "fulfilled" ? outcomeB.value.contactId : undefined;
      expect(contactIdA).toBeTruthy();
      expect(contactIdA).toBe(contactIdB);

      const rows = await withTenant(workspaceId, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query("SELECT id FROM contacts WHERE workspace_id = $1 AND email = $2", [
            workspaceId,
            email,
          ]);
          return rows;
        })
      );
      expect(rows).toHaveLength(1);
    } finally {
      await racePool.end();
    }
  });

  /**
   * WR-06 (02-11 gap closure): `upsertContactApiSchema` accepts
   * `subscriptionStatus` on every item, but the update branch of
   * `upsertContactByIdentity` currently never writes `subscription_status` --
   * an integrator gets a 200 with no state change. Test B proves a valid
   * subscribed<->unsubscribed transition is applied on the update branch.
   */
  it("WR-06 (Test B): subscriptionStatus on the update branch applies a valid subscribed->unsubscribed transition", async () => {
    const workspaceId = await freshWorkspaceId("upsert-status-update");
    const email = `status-b-${Date.now()}@example.com`;

    const created = await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        upsertContactByIdentity(client, workspaceId, { email, subscriptionStatus: "subscribed" })
      )
    );

    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        upsertContactByIdentity(client, workspaceId, { email, subscriptionStatus: "unsubscribed" })
      )
    );

    const updated = await withTenant(workspaceId, () => getContact(created.contactId));
    expect(updated?.subscriptionStatus).toBe("unsubscribed");
  });

  /**
   * WR-06/D-12 (02-11 gap closure): mirrors updateContact's D-12 guard --
   * a direct set to `suppressed` via the update branch must never be
   * applied, matching "cannot set suppressed directly". Documented as
   * possibly already passing pre-fix (the update branch currently ignores
   * subscriptionStatus entirely, which trivially satisfies this assertion) --
   * the plan only requires A and B to fail RED; this case guards the D-12
   * rule stays true once WR-06 makes the field live.
   */
  it("WR-06/D-12 (Test C): a direct set to suppressed on the update branch is refused, not applied", async () => {
    const workspaceId = await freshWorkspaceId("upsert-status-suppressed-guard");
    const email = `status-c-${Date.now()}@example.com`;

    const created = await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        upsertContactByIdentity(client, workspaceId, { email, subscriptionStatus: "subscribed" })
      )
    );

    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        upsertContactByIdentity(client, workspaceId, { email, subscriptionStatus: "suppressed" })
      )
    );

    const updated = await withTenant(workspaceId, () => getContact(created.contactId));
    expect(updated?.subscriptionStatus).toBe("subscribed");
  });
});
