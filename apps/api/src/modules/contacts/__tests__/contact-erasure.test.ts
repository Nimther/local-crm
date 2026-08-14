import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../../test/db-fixture.js";
import { withTenant, withTenantTransaction } from "../../../middleware/tenant-context.js";
import { createContact, deleteContact, getContact, type DeleteContactDeps } from "../contact.repository.js";
import {
  hashSuppressionEmail,
  isEmailSuppressed,
  loadWorkspaceSuppressionKey,
  normalizeSuppressionEmail,
  upsertContactByIdentity,
} from "@mega-crm/contacts-core";
import { buildErasureScrubJobId, type ErasureScrubJob } from "@mega-crm/shared-schemas";

/**
 * CMP-04 (D-01/D-04, plan 13-10): `deleteContact`'s rewrite from a hard
 * `DELETE` to an in-place anonymization -- the erasure record, the
 * unconditional suppression write, and the deterministic post-commit scrub
 * enqueue. Uses the SAME HTTP-signup-plus-workspace harness as
 * `contact-crud.test.ts`, but calls `deleteContact`/`createContact`/
 * `getContact` and `@mega-crm/contacts-core`'s shared upsert directly
 * (mirrors `upsert-priority.test.ts`'s precedent) so failure-injection
 * `deps` and raw-table assertions (`erasure_records`, `workspace_suppressions`,
 * `sends`, `subscription_status_history`) are reachable without a live
 * BullMQ/Redis round trip.
 */
describe("deleteContact: anonymize-in-place with erasure record + scrub enqueue (CMP-04, plan 13-10)", () => {
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

  async function signUp(email: string, password: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password, name },
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

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    return workspace.id;
  }

  interface RawContactRow {
    email: string | null;
    externalId: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    city: string | null;
    country: string | null;
    timezone: string | null;
    tags: string[];
    properties: Record<string, unknown>;
    anonymizedAt: Date | null;
  }

  async function readRawContact(workspaceId: string, contactId: string): Promise<RawContactRow | null> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<RawContactRow>(
          `SELECT email, external_id as "externalId", first_name as "firstName", last_name as "lastName",
                  phone, city, country, timezone, tags, properties, anonymized_at as "anonymizedAt"
           FROM contacts WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, contactId]
        );
        return rows[0] ?? null;
      })
    );
  }

  // CMP-04 (D-02, plan 13-12): workspace_suppressions no longer stores
  // plaintext -- reads the row by its HMAC hash, which is what the write
  // sites under test (deleteContact) actually write. `emailHash` is
  // returned instead of `email` so callers assert against the hash of the
  // address they captured, not a plaintext column that no longer exists.
  async function readSuppressionRow(
    workspaceId: string,
    email: string
  ): Promise<{ emailHash: string; reason: string } | null> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const key = await loadWorkspaceSuppressionKey(client, workspaceId);
        if (!key) return null;
        const hash = hashSuppressionEmail(normalizeSuppressionEmail(email), key);
        const { rows } = await client.query<{ emailHash: string; reason: string }>(
          `SELECT email_hash as "emailHash", reason FROM workspace_suppressions WHERE workspace_id = $1 AND email_hash = $2`,
          [workspaceId, hash]
        );
        return rows[0] ?? null;
      })
    );
  }

  async function readErasureRecords(
    workspaceId: string,
    contactId: string
  ): Promise<Array<{ id: string; status: string; anonymizedAt: Date }>> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string; status: string; anonymizedAt: Date }>(
          `SELECT id, status, anonymized_at as "anonymizedAt" FROM erasure_records
           WHERE workspace_id = $1 AND contact_id = $2`,
          [workspaceId, contactId]
        );
        return rows;
      })
    );
  }

  async function seedContact(
    workspaceId: string,
    input: { email?: string | null; externalId?: string | null; subscriptionStatus?: string }
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, external_id, subscription_status)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [workspaceId, input.email ?? null, input.externalId ?? null, input.subscriptionStatus ?? "subscribed"]
        );
        return rows[0].id;
      })
    );
  }

  it("source order: the locking SELECT (FOR UPDATE) appears before the anonymizing UPDATE", () => {
    const filePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../contact.repository.ts"
    );
    const source = readFileSync(filePath, "utf8");
    const forUpdateIdx = source.indexOf("FOR UPDATE");
    const anonymizeIdx = source.indexOf("email = NULL");
    expect(forUpdateIdx, "expected a FOR UPDATE locking read in deleteContact").toBeGreaterThan(-1);
    expect(anonymizeIdx, "expected the anonymizing UPDATE's SET email = NULL").toBeGreaterThan(-1);
    expect(forUpdateIdx, "FOR UPDATE must appear BEFORE the anonymizing UPDATE").toBeLessThan(anonymizeIdx);
  });

  it("leaves the row present (count 1) after delete, with PII columns null and anonymized_at set", async () => {
    const workspaceId = await freshWorkspaceId("erasure-row-present");
    const contactId = await seedContact(workspaceId, {
      email: `present-${Date.now()}@example.test`,
      externalId: "present-ext-1",
    });

    const result = await withTenant(workspaceId, () => deleteContact(contactId));
    expect(result).toBe(true);

    const count = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(`SELECT count(*) FROM contacts WHERE id = $1`, [
          contactId,
        ]);
        return Number(rows[0].count);
      })
    );
    expect(count).toBe(1);

    const row = await readRawContact(workspaceId, contactId);
    expect(row?.email).toBeNull();
    expect(row?.externalId).toBeNull();
    expect(row?.anonymizedAt).not.toBeNull();
  });

  it("[Rule 2] scrubs every PII-bearing column the schema actually has, not just the four the plan text named", async () => {
    const workspaceId = await freshWorkspaceId("erasure-full-scrub");
    const contactId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts
             (workspace_id, email, external_id, first_name, last_name, phone, city, country, timezone, tags, properties)
           VALUES ($1, $2, 'full-scrub-ext', 'Ada', 'Lovelace', '+15550002222', 'Springfield', 'US', 'America/Chicago', $3, $4)
           RETURNING id`,
          [
            workspaceId,
            `full-scrub-${Date.now()}@example.test`,
            ["vip"],
            { favoriteColor: "teal" },
          ]
        );
        return rows[0].id;
      })
    );

    await withTenant(workspaceId, () => deleteContact(contactId));

    const row = await readRawContact(workspaceId, contactId);
    expect(row?.email).toBeNull();
    expect(row?.externalId).toBeNull();
    expect(row?.firstName).toBeNull();
    expect(row?.lastName).toBeNull();
    expect(row?.phone).toBeNull();
    expect(row?.city).toBeNull();
    expect(row?.country).toBeNull();
    expect(row?.timezone).toBeNull();
    expect(row?.tags).toEqual([]);
    expect(row?.properties).toEqual({});
  });

  it("a former external_id is reusable by a new contact after erasure, without a unique violation", async () => {
    const workspaceId = await freshWorkspaceId("erasure-extid-reuse");
    const contactId = await seedContact(workspaceId, { externalId: "reuse-ext-1" });

    await withTenant(workspaceId, () => deleteContact(contactId));

    const created = await withTenant(workspaceId, () => createContact({ externalId: "reuse-ext-1" }));
    expect(created.id).not.toBe(contactId);
    expect(created.externalId).toBe("reuse-ext-1");
  });

  it("suppresses an unsubscribed contact's address on delete, reason contact_deleted", async () => {
    const workspaceId = await freshWorkspaceId("erasure-unsub-suppress");
    const email = `unsub-suppress-${Date.now()}@example.test`;
    const contactId = await seedContact(workspaceId, { email, subscriptionStatus: "unsubscribed" });

    await withTenant(workspaceId, () => deleteContact(contactId));

    const suppression = await readSuppressionRow(workspaceId, email);
    expect(suppression, "expected a suppression row hashed from the captured pre-erasure address").not.toBeNull();
    expect(suppression?.reason).toBe("contact_deleted");
  });

  it("BLOCKER finding 1: suppresses a SUBSCRIBED contact's address too, asserted against the hash of the literal captured address", async () => {
    const workspaceId = await freshWorkspaceId("erasure-subscribed-suppress");
    const email = `erased-${Date.now()}@example.test`;
    const contactId = await seedContact(workspaceId, { email, subscriptionStatus: "subscribed" });

    await withTenant(workspaceId, () => deleteContact(contactId));

    // CMP-04 (D-02, plan 13-12): the captured pre-erasure address must be
    // hashed and stored, not null/empty -- readSuppressionRow looks the row
    // up BY that hash, so finding it at all is the assertion that matters
    // (there is no plaintext column left to compare against directly).
    const suppression = await readSuppressionRow(workspaceId, email);
    expect(suppression).not.toBeNull();
    expect(suppression?.reason).toBe("contact_deleted");
  });

  it("writes no suppression row and does not throw when the contact's email was already null", async () => {
    const workspaceId = await freshWorkspaceId("erasure-null-email");
    const contactId = await seedContact(workspaceId, { externalId: "null-email-ext" });

    await expect(withTenant(workspaceId, () => deleteContact(contactId))).resolves.toBe(true);

    const { rows } = await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(`SELECT 1 FROM workspace_suppressions WHERE workspace_id = $1`, [workspaceId])
      )
    );
    expect(rows).toHaveLength(0);
  });

  it("re-creating an erased subscribed contact's address fails the pre-send suppression gate", async () => {
    const workspaceId = await freshWorkspaceId("erasure-reimport-create");
    const email = `reimport-create-${Date.now()}@example.test`;
    const contactId = await seedContact(workspaceId, { email, subscriptionStatus: "subscribed" });

    await withTenant(workspaceId, () => deleteContact(contactId));
    const recreated = await withTenant(workspaceId, () => createContact({ email }));

    expect(recreated.subscriptionStatus).toBe("suppressed");
    const suppressed = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => isEmailSuppressed(client, workspaceId, email))
    );
    expect(suppressed).toBe(true);
  });

  it("re-importing an erased subscribed contact's address through the shared contacts-core upsert (the CSV worker's own identity path) fails the pre-send suppression gate", async () => {
    const workspaceId = await freshWorkspaceId("erasure-reimport-upsert");
    const email = `reimport-upsert-${Date.now()}@example.test`;
    const contactId = await seedContact(workspaceId, { email, subscriptionStatus: "subscribed" });

    await withTenant(workspaceId, () => deleteContact(contactId));

    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => upsertContactByIdentity(client, workspaceId, { email }))
    );
    expect(result.created).toBe(true);
    expect(result.contactId).not.toBe(contactId);

    const newContact = await withTenant(workspaceId, () => getContact(result.contactId));
    // status resolution happens inside upsertContactByIdentity itself via
    // isEmailSuppressed -- confirmed directly against the suppression gate.
    const suppressed = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => isEmailSuppressed(client, workspaceId, email))
    );
    expect(suppressed).toBe(true);
    expect(newContact).toBeTruthy();
  });

  it("writes exactly one pending erasure_records row per delete", async () => {
    const workspaceId = await freshWorkspaceId("erasure-record-written");
    const contactId = await seedContact(workspaceId, { email: `record-${Date.now()}@example.test` });

    await withTenant(workspaceId, () => deleteContact(contactId));

    const records = await readErasureRecords(workspaceId, contactId);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("pending");
    expect(records[0].anonymizedAt).not.toBeNull();
  });

  it("atomicity: injecting a failure before the erasure_records insert leaves the contact un-anonymized and writes no suppression row", async () => {
    const workspaceId = await freshWorkspaceId("erasure-atomic-injection");
    const email = `atomic-${Date.now()}@example.test`;
    const contactId = await seedContact(workspaceId, { email, subscriptionStatus: "unsubscribed" });

    const deps: DeleteContactDeps = {
      beforeErasureRecordWrite: () => {
        throw new Error("INJECTED FAILURE before erasure_records insert");
      },
    };

    await expect(withTenant(workspaceId, () => deleteContact(contactId, deps))).rejects.toThrow(/INJECTED FAILURE/);

    const row = await readRawContact(workspaceId, contactId);
    expect(row?.anonymizedAt, "the anonymizing UPDATE must roll back too").toBeNull();
    expect(row?.email).toBe(email);

    const suppression = await readSuppressionRow(workspaceId, email);
    expect(suppression, "the suppression insert must roll back too").toBeNull();

    const records = await readErasureRecords(workspaceId, contactId);
    expect(records).toHaveLength(0);
  });

  it("deps.enqueueErasureScrub is an injectable dependency, so a test can make it reject without a module-level queue stub", async () => {
    const workspaceId = await freshWorkspaceId("erasure-enqueue-injectable");
    const contactId = await seedContact(workspaceId, { email: `injectable-${Date.now()}@example.test` });

    let called = false;
    const deps: DeleteContactDeps = {
      enqueueErasureScrub: () => {
        called = true;
        return Promise.resolve();
      },
    };
    await withTenant(workspaceId, () => deleteContact(contactId, deps));
    expect(called).toBe(true);
  });

  it("a post-commit enqueue failure leaves the anonymization, the suppression row, and the pending erasure_records row all intact", async () => {
    const workspaceId = await freshWorkspaceId("erasure-enqueue-fails-post-commit");
    const email = `enqueue-fail-${Date.now()}@example.test`;
    const contactId = await seedContact(workspaceId, { email, subscriptionStatus: "unsubscribed" });

    const deps: DeleteContactDeps = {
      enqueueErasureScrub: () => {
        throw new Error("INJECTED enqueue failure -- transaction already committed");
      },
    };

    await expect(withTenant(workspaceId, () => deleteContact(contactId, deps))).rejects.toThrow(
      /INJECTED enqueue failure/
    );

    const row = await readRawContact(workspaceId, contactId);
    expect(row?.anonymizedAt, "the commit already happened -- anonymization survives the enqueue failure").not.toBeNull();

    const suppression = await readSuppressionRow(workspaceId, email);
    expect(suppression, "expected a suppression row hashed from the captured pre-erasure address").not.toBeNull();

    const records = await readErasureRecords(workspaceId, contactId);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("pending");
  });

  it("deleting an already-anonymized contact returns true, writes no second erasure record, and enqueues no second job", async () => {
    const workspaceId = await freshWorkspaceId("erasure-double-delete");
    const contactId = await seedContact(workspaceId, { email: `double-${Date.now()}@example.test` });

    let enqueueCount = 0;
    const deps: DeleteContactDeps = {
      enqueueErasureScrub: () => {
        enqueueCount += 1;
        return Promise.resolve();
      },
    };

    const first = await withTenant(workspaceId, () => deleteContact(contactId, deps));
    const second = await withTenant(workspaceId, () => deleteContact(contactId, deps));

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(enqueueCount, "exactly one job must be enqueued across both calls").toBe(1);

    const records = await readErasureRecords(workspaceId, contactId);
    expect(records).toHaveLength(1);
  });

  it("deleting a nonexistent contact returns false and writes nothing", async () => {
    const workspaceId = await freshWorkspaceId("erasure-nonexistent");
    const fakeId = "00000000-0000-0000-0000-000000000000";

    let enqueueCalled = false;
    const result = await withTenant(workspaceId, () =>
      deleteContact(fakeId, {
        enqueueErasureScrub: () => {
          enqueueCalled = true;
          return Promise.resolve();
        },
      })
    );

    expect(result).toBe(false);
    expect(enqueueCalled).toBe(false);
    const records = await readErasureRecords(workspaceId, fakeId);
    expect(records).toHaveLength(0);
  });

  it("buildErasureScrubJobId is deterministic across repeated calls with the same erasure-record id", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(buildErasureScrubJobId(id)).toBe(buildErasureScrubJobId(id));
  });

  it("a sends row referencing the deleted contact still resolves its contact_id after the delete", async () => {
    const workspaceId = await freshWorkspaceId("erasure-sends-fk");
    const contactId = await seedContact(workspaceId, { email: `sends-fk-${Date.now()}@example.test` });

    const sendId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, contact_id, kind) VALUES ($1, $2, 'test') RETURNING id`,
          [workspaceId, contactId]
        );
        return rows[0].id;
      })
    );

    await withTenant(workspaceId, () => deleteContact(contactId));

    const resolved = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ contactId: string }>(
          `SELECT contact_id as "contactId" FROM sends WHERE id = $1`,
          [sendId]
        );
        return rows[0] ?? null;
      })
    );
    expect(resolved?.contactId).toBe(contactId);
  });

  it("a subscription_status_history row for the deleted contact still resolves after the delete", async () => {
    const workspaceId = await freshWorkspaceId("erasure-history-fk");
    const contactId = await seedContact(workspaceId, { email: `history-fk-${Date.now()}@example.test` });

    const historyId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO subscription_status_history (workspace_id, contact_id, old_status, new_status, source)
           VALUES ($1, $2, 'subscribed', 'unsubscribed', 'manual_ui') RETURNING id`,
          [workspaceId, contactId]
        );
        return rows[0].id;
      })
    );

    await withTenant(workspaceId, () => deleteContact(contactId));

    const resolved = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ contactId: string }>(
          `SELECT contact_id as "contactId" FROM subscription_status_history WHERE id = $1`,
          [historyId]
        );
        return rows[0] ?? null;
      })
    );
    expect(resolved?.contactId).toBe(contactId);
  });

  it("the erasure-scrub job payload/id builders round-trip a real erasure record id", async () => {
    const workspaceId = await freshWorkspaceId("erasure-payload-shape");
    const contactId = await seedContact(workspaceId, { email: `payload-${Date.now()}@example.test` });

    let capturedPayload: ErasureScrubJob | null = null;
    let capturedJobId: string | null = null;
    await withTenant(workspaceId, () =>
      deleteContact(contactId, {
        enqueueErasureScrub: (payload, jobId) => {
          capturedPayload = payload;
          capturedJobId = jobId;
          return Promise.resolve();
        },
      })
    );

    const records = await readErasureRecords(workspaceId, contactId);
    expect(capturedPayload).toEqual({
      schemaVersion: 1,
      workspaceId,
      contactId,
      erasureRecordId: records[0].id,
    });
    expect(capturedJobId).toBe(buildErasureScrubJobId(records[0].id));
  });
});
