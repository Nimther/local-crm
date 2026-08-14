import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, getAuthTestDatabaseUrl, createTestPool } from "@mega-crm/test-support";
import { findContactIdByIdentity, isEmailTaken, upsertContactByIdentity } from "../contact-repository.js";

/**
 * CMP-04/T-13-10-08 (plan 13-10, Task 3, REVIEWS.md HIGH finding 3): the
 * shared-upsert half of "an anonymized contact is never a re-import match
 * target." Lives in `contacts-core` (not `apps/api`'s own test suite)
 * because that is where `findContactIdByIdentity`/`upsertContactByIdentity`
 * live, and where the imports:csv WORKER's apply path also consumes them
 * directly (`apps/worker/src/queues/imports-csv.worker.ts`) -- a test only
 * in `apps/api` would leave the worker's use of the same functions
 * unasserted.
 *
 * Exercises real SQL against a real Postgres connection (mirrors
 * `unsubscribe-apply.test.ts`'s own convention) -- a stubbed PoolClient
 * cannot exercise the `FOR UPDATE`/`anonymized_at IS NULL` filter these
 * functions now carry.
 */
describe("findContactIdByIdentity / upsertContactByIdentity vs. an anonymized contact (CMP-04, plan 13-10)", () => {
  let pool: Pool;
  let authPool: Pool | undefined;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
    await authPool?.end();
  });

  function getAuthTestPool(): Pool {
    if (!authPool) authPool = new Pool({ connectionString: getAuthTestDatabaseUrl() });
    return authPool;
  }

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await getAuthTestPool().query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, slug]
    );
    return rows[0].id;
  }

  /** Seeds a contact and anonymizes it in place with a single raw UPDATE -- mirrors deleteContact's own anonymizing UPDATE column set, without going through apps/api. */
  async function seedAnonymizedContact(
    workspaceId: string,
    input: { email?: string | null; externalId?: string | null }
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, external_id) VALUES ($1, $2, $3) RETURNING id`,
          [workspaceId, input.email ?? null, input.externalId ?? null]
        );
        const contactId = rows[0].id;
        await client.query(
          `UPDATE contacts SET email = NULL, external_id = NULL, first_name = NULL, last_name = NULL,
             phone = NULL, city = NULL, country = NULL, timezone = NULL, tags = '{}', properties = '{}'::jsonb,
             anonymized_at = now(), updated_at = now()
           WHERE id = $1`,
          [contactId]
        );
        return contactId;
      })
    );
  }

  it("findContactIdByIdentity returns null for an anonymized contact's former external_id", async () => {
    const workspaceId = await freshWorkspaceId("anon-find-extid");
    await seedAnonymizedContact(workspaceId, { externalId: "former-ext-1" });

    const found = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => findContactIdByIdentity(client, workspaceId, { externalId: "former-ext-1" }))
    );
    expect(found).toBeNull();
  });

  it("findContactIdByIdentity returns null for an anonymized contact's former email", async () => {
    const workspaceId = await freshWorkspaceId("anon-find-email");
    const email = `former-${Date.now()}@example.test`;
    await seedAnonymizedContact(workspaceId, { email });

    const found = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => findContactIdByIdentity(client, workspaceId, { email }))
    );
    expect(found).toBeNull();
  });

  it("upsertContactByIdentity called with an anonymized contact's former external_id creates a NEW row rather than updating the anonymized one", async () => {
    const workspaceId = await freshWorkspaceId("anon-upsert-extid");
    const anonymizedId = await seedAnonymizedContact(workspaceId, { externalId: "reimport-ext-1" });

    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        upsertContactByIdentity(client, workspaceId, { externalId: "reimport-ext-1", firstName: "Reimported" })
      )
    );

    expect(result.created).toBe(true);
    expect(result.contactId).not.toBe(anonymizedId);

    const anonymizedAfter = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{
          email: string | null;
          firstName: string | null;
          lastName: string | null;
          phone: string | null;
        }>(
          `SELECT email, first_name as "firstName", last_name as "lastName", phone FROM contacts WHERE id = $1`,
          [anonymizedId]
        );
        return rows[0];
      })
    );
    expect(anonymizedAfter.email).toBeNull();
    expect(anonymizedAfter.firstName).toBeNull();
    expect(anonymizedAfter.lastName).toBeNull();
    expect(anonymizedAfter.phone).toBeNull();
  });

  it("upsertContactByIdentity called with an anonymized contact's former email creates a NEW row, and isUniqueViolation's retry branch is never reached", async () => {
    const workspaceId = await freshWorkspaceId("anon-upsert-email");
    const email = `reimport-${Date.now()}@example.test`;
    const anonymizedId = await seedAnonymizedContact(workspaceId, { email });

    // Both identity columns are NULL on the anonymized row (nulled by the
    // same anonymizing UPDATE that scrubs email/external_id), so the
    // filtered lookup finds nothing and the subsequent INSERT has nothing
    // to collide with -- isUniqueViolation's retry branch (23505) is
    // structurally unreachable for this case, confirmed here by asserting
    // the call resolves normally rather than throwing/retrying.
    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => upsertContactByIdentity(client, workspaceId, { email }))
    );

    expect(result.created).toBe(true);
    expect(result.contactId).not.toBe(anonymizedId);
  });

  it("isEmailTaken returns false for an anonymized contact's former email (already null, filter is defensive)", async () => {
    const workspaceId = await freshWorkspaceId("anon-email-taken");
    const email = `taken-check-${Date.now()}@example.test`;
    await seedAnonymizedContact(workspaceId, { email });

    const taken = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => isEmailTaken(client, workspaceId, email))
    );
    expect(taken).toBe(false);
  });
});
