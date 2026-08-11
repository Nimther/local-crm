import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrationFile, applyMigrationsUpTo, createEphemeralDatabase, dropEphemeralDatabase } from "@mega-crm/test-support";

/**
 * Phase 13 (CMP-04, D-01/D-04, plan 13-10, Task 1 [BLOCKING]): the
 * schema-level guarantees migration 0059 makes -- `contacts.anonymized_at`,
 * the `erasure_records` table, and the "no unique-constraint change needed"
 * claim for BOTH `contacts_workspace_email_unique` and
 * `contacts_workspace_external_id_unique` (REVIEWS.md HIGH finding 3: the
 * `external_id` half is the one nobody had checked when only `email` was
 * verified).
 *
 * `npm run build`/`tsc` passing is NOT evidence any of this exists --
 * Drizzle's types come from the schema files, not from a live database
 * (STATE.md operational note, carried from Phase 12: `npm run db:migrate`
 * hangs in this dev sandbox under Node v26, so `test:migrations` is this
 * project's real schema-apply proof). Mirrors
 * `migration-0056-workspace-daily-rollup-dirtied-at.test.ts`'s dedicated-
 * migration-suite precedent -- NOT in this plan's `files_modified` list, a
 * documented deviation (same class as that file's own).
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const CHECKPOINT = "0058_reputation_and_ingestion_alert_state.sql";
const TARGET_MIGRATION = "0059_contact_erasure.sql";

/**
 * `createEphemeralDatabase`'s own `adminDsn` points at the cluster's
 * maintenance database, not the ephemeral one -- swap only the pathname to
 * get a superuser connection into THIS database (mirrors
 * `migration-0056-workspace-daily-rollup-dirtied-at.test.ts`'s identical
 * helper). `organization` is INSERT-restricted to `mega_crm_auth` as of
 * migration 0045 -- the checkpoint here (0058) is well past that, so the
 * ordinary `mega_crm_app`-role `pool` this suite otherwise uses cannot seed
 * or delete it.
 */
function adminDsnForDatabase(adminDsn: string, databaseName: string): string {
  const url = new URL(adminDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/**
 * What `withTenant`/`withTenantTransaction` do, applied to THIS suite's own
 * pool. `mega_crm_app`'s `workspace_isolation` policy (unified fail-closed,
 * bare-cast form since migration 0044) throws on an unscoped connection
 * rather than returning zero rows, so every seed/read against a
 * tenant-scoped table here must run inside a `SET LOCAL
 * app.current_workspace_id` transaction.
 */
async function withWorkspace<T>(pool: Pool, workspaceId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

interface SeededContactRow {
  externalId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  timezone: string | null;
  tags: string[];
  properties: Record<string, unknown>;
  subscriptionStatus: string;
}

describe("migration 0059: contact erasure -- anonymized_at + erasure_records (CMP-04, plan 13-10)", () => {
  let pool: Pool;
  let seedPool: Pool;
  let adminPool: Pool;
  let databaseName: string;
  let adminDsn: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "migration-0059-contact-erasure" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    pool = new Pool({ connectionString: created.dsn, max: 5 });
    seedPool = new Pool({ connectionString: created.dsn, max: 5 });
    adminPool = new Pool({ connectionString: adminDsnForDatabase(created.adminDsn, databaseName), max: 2 });

    await applyMigrationsUpTo(pool, MIGRATIONS_DIR, CHECKPOINT);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await seedPool?.end();
    await adminPool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const { rows } = await adminPool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`]
    );
    return rows[0].id;
  }

  // --- Pre-migration seed: a real, fully-populated contacts row, proven
  // byte-identical afterwards -- the migration's non-destructiveness claim.
  let preMigrationWorkspaceId: string;
  let preMigrationContactId: string;
  const SEEDED_CONTACT: SeededContactRow = {
    externalId: "pre-0059-ext-1",
    email: "pre-0059@example.test",
    firstName: "Pre",
    lastName: "Migration",
    phone: "+15550001111",
    city: "Springfield",
    country: "US",
    timezone: "America/Chicago",
    tags: ["vip", "beta"],
    properties: { loyaltyTier: 3, favoriteColor: "teal" },
    subscriptionStatus: "subscribed",
  };

  /** Pre-0059 shape: no `anonymized_at` column exists yet at the checkpoint. */
  async function readContactSnapshotBeforeMigration(client: PoolClient, contactId: string) {
    const { rows } = await client.query<SeededContactRow>(
      `SELECT external_id as "externalId", email, first_name as "firstName", last_name as "lastName",
              phone, city, country, timezone, tags, properties,
              subscription_status as "subscriptionStatus"
       FROM contacts WHERE id = $1`,
      [contactId]
    );
    return rows[0] ?? null;
  }

  async function readContactSnapshot(client: PoolClient, contactId: string) {
    const { rows } = await client.query<SeededContactRow & { anonymizedAt: Date | null }>(
      `SELECT external_id as "externalId", email, first_name as "firstName", last_name as "lastName",
              phone, city, country, timezone, tags, properties,
              subscription_status as "subscriptionStatus", anonymized_at as "anonymizedAt"
       FROM contacts WHERE id = $1`,
      [contactId]
    );
    return rows[0] ?? null;
  }

  let snapshotBeforeMigration: SeededContactRow | null;
  let snapshotAfterMigration: (SeededContactRow & { anonymizedAt: Date | null }) | null;

  beforeAll(async () => {
    preMigrationWorkspaceId = await freshWorkspaceId("erasure-premig");
    preMigrationContactId = await withWorkspace(seedPool, preMigrationWorkspaceId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO contacts
           (workspace_id, external_id, email, first_name, last_name, phone, city, country, timezone, tags, properties, subscription_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          preMigrationWorkspaceId,
          SEEDED_CONTACT.externalId,
          SEEDED_CONTACT.email,
          SEEDED_CONTACT.firstName,
          SEEDED_CONTACT.lastName,
          SEEDED_CONTACT.phone,
          SEEDED_CONTACT.city,
          SEEDED_CONTACT.country,
          SEEDED_CONTACT.timezone,
          SEEDED_CONTACT.tags,
          SEEDED_CONTACT.properties,
          SEEDED_CONTACT.subscriptionStatus,
        ]
      );
      return rows[0].id;
    });

    snapshotBeforeMigration = await withWorkspace(seedPool, preMigrationWorkspaceId, (client) =>
      readContactSnapshotBeforeMigration(client, preMigrationContactId)
    );

    // --- the release under test ---
    await applyMigrationFile(pool, MIGRATIONS_DIR, TARGET_MIGRATION);

    snapshotAfterMigration = await withWorkspace(seedPool, preMigrationWorkspaceId, (client) =>
      readContactSnapshot(client, preMigrationContactId)
    );
  }, 60_000);

  it("actually seeded the pre-existing row before 0059 -- RLS did not silently swallow the insert", () => {
    expect(snapshotBeforeMigration).not.toBeNull();
    expect(snapshotBeforeMigration?.email).toBe(SEEDED_CONTACT.email);
  });

  it("leaves every pre-existing column byte-identical after 0059 applies", () => {
    expect(snapshotAfterMigration).not.toBeNull();
    expect({
      externalId: snapshotAfterMigration?.externalId,
      email: snapshotAfterMigration?.email,
      firstName: snapshotAfterMigration?.firstName,
      lastName: snapshotAfterMigration?.lastName,
      phone: snapshotAfterMigration?.phone,
      city: snapshotAfterMigration?.city,
      country: snapshotAfterMigration?.country,
      timezone: snapshotAfterMigration?.timezone,
      tags: snapshotAfterMigration?.tags,
      properties: snapshotAfterMigration?.properties,
      subscriptionStatus: snapshotAfterMigration?.subscriptionStatus,
    }).toEqual(SEEDED_CONTACT);
  });

  it("leaves anonymized_at null on the pre-existing row -- no backfill", () => {
    expect(snapshotAfterMigration?.anonymizedAt).toBeNull();
  });

  describe("after 0059 applies", () => {
    it("allows two contacts rows in one workspace with null email and anonymized_at set to coexist", async () => {
      const workspaceId = await freshWorkspaceId("erasure-email-coexist");
      await withWorkspace(seedPool, workspaceId, async (client) => {
        await client.query(
          `INSERT INTO contacts (workspace_id, external_id, email, anonymized_at) VALUES ($1, 'ext-a', NULL, now())`,
          [workspaceId]
        );
        await client.query(
          `INSERT INTO contacts (workspace_id, external_id, email, anonymized_at) VALUES ($1, 'ext-b', NULL, now())`,
          [workspaceId]
        );
        const { rows } = await client.query(`SELECT count(*) FROM contacts WHERE workspace_id = $1`, [workspaceId]);
        expect(Number(rows[0].count)).toBe(2);
      });
    });

    it("allows two contacts rows in one workspace with null external_id and anonymized_at set to coexist", async () => {
      const workspaceId = await freshWorkspaceId("erasure-extid-coexist");
      await withWorkspace(seedPool, workspaceId, async (client) => {
        await client.query(
          `INSERT INTO contacts (workspace_id, external_id, email, anonymized_at) VALUES ($1, NULL, 'a@example.test', now())`,
          [workspaceId]
        );
        await client.query(
          `INSERT INTO contacts (workspace_id, external_id, email, anonymized_at) VALUES ($1, NULL, 'b@example.test', now())`,
          [workspaceId]
        );
        const { rows } = await client.query(`SELECT count(*) FROM contacts WHERE workspace_id = $1`, [workspaceId]);
        expect(Number(rows[0].count)).toBe(2);
      });
    });

    it("still rejects two contacts rows in one workspace sharing a non-null email", async () => {
      const workspaceId = await freshWorkspaceId("erasure-email-collide");
      await withWorkspace(seedPool, workspaceId, async (client) => {
        await client.query(`INSERT INTO contacts (workspace_id, email) VALUES ($1, 'dupe@example.test')`, [
          workspaceId,
        ]);
        await expect(
          client.query(`INSERT INTO contacts (workspace_id, email) VALUES ($1, 'dupe@example.test')`, [workspaceId])
        ).rejects.toThrow(/contacts_workspace_email_unique/);
      });
    });

    it("still rejects two contacts rows in one workspace sharing a non-null external_id", async () => {
      const workspaceId = await freshWorkspaceId("erasure-extid-collide");
      await withWorkspace(seedPool, workspaceId, async (client) => {
        await client.query(`INSERT INTO contacts (workspace_id, external_id) VALUES ($1, 'dupe-ext')`, [workspaceId]);
        await expect(
          client.query(`INSERT INTO contacts (workspace_id, external_id) VALUES ($1, 'dupe-ext')`, [workspaceId])
        ).rejects.toThrow(/contacts_workspace_external_id_unique/);
      });
    });

    it("accepts an erasure_records row with null cursors, and a later composite-keyset write into each", async () => {
      const workspaceId = await freshWorkspaceId("erasure-records-cursors");
      await withWorkspace(seedPool, workspaceId, async (client) => {
        const { rows: contactRows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, anonymized_at) VALUES ($1, now()) RETURNING id`,
          [workspaceId]
        );
        const contactId = contactRows[0].id;

        const { rows: recordRows } = await client.query<{ id: string }>(
          `INSERT INTO erasure_records (workspace_id, contact_id, anonymized_at)
           VALUES ($1, $2, now()) RETURNING id`,
          [workspaceId, contactId]
        );
        const recordId = recordRows[0].id;

        const { rows: initial } = await client.query(
          `SELECT sends_scrub_cursor as "sendsScrubCursor", events_scrub_cursor as "eventsScrubCursor" FROM erasure_records WHERE id = $1`,
          [recordId]
        );
        expect(initial[0].sendsScrubCursor).toBeNull();
        expect(initial[0].eventsScrubCursor).toBeNull();

        const sendsCursor = { occurredAt: "2026-01-01T00:00:00.000Z", id: "00000000-0000-0000-0000-000000000001" };
        const eventsCursor = { occurredAt: "2026-01-02T00:00:00.000Z", id: "00000000-0000-0000-0000-000000000002" };
        await client.query(
          `UPDATE erasure_records SET sends_scrub_cursor = $2, events_scrub_cursor = $3 WHERE id = $1`,
          [recordId, JSON.stringify(sendsCursor), JSON.stringify(eventsCursor)]
        );

        const { rows: after } = await client.query(
          `SELECT sends_scrub_cursor as "sendsScrubCursor", events_scrub_cursor as "eventsScrubCursor" FROM erasure_records WHERE id = $1`,
          [recordId]
        );
        expect(after[0].sendsScrubCursor).toEqual(sendsCursor);
        expect(after[0].eventsScrubCursor).toEqual(eventsCursor);
      });
    });

    it("rejects an erasure_records row whose status is outside the allowed set", async () => {
      const workspaceId = await freshWorkspaceId("erasure-records-bad-status");
      await withWorkspace(seedPool, workspaceId, async (client) => {
        const { rows: contactRows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, anonymized_at) VALUES ($1, now()) RETURNING id`,
          [workspaceId]
        );
        await expect(
          client.query(
            `INSERT INTO erasure_records (workspace_id, contact_id, anonymized_at, status) VALUES ($1, $2, now(), 'bogus')`,
            [workspaceId, contactRows[0].id]
          )
        ).rejects.toThrow(/erasure_records.*status|violates check constraint/i);
      });
    });

    it("makes an erasure_records row unreadable from a tenant transaction scoped to a different workspace", async () => {
      const ownerWorkspaceId = await freshWorkspaceId("erasure-records-owner");
      const otherWorkspaceId = await freshWorkspaceId("erasure-records-other");

      const recordId = await withWorkspace(seedPool, ownerWorkspaceId, async (client) => {
        const { rows: contactRows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, anonymized_at) VALUES ($1, now()) RETURNING id`,
          [ownerWorkspaceId]
        );
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO erasure_records (workspace_id, contact_id, anonymized_at) VALUES ($1, $2, now()) RETURNING id`,
          [ownerWorkspaceId, contactRows[0].id]
        );
        return rows[0].id;
      });

      await withWorkspace(seedPool, otherWorkspaceId, async (client) => {
        const { rows } = await client.query(`SELECT id FROM erasure_records WHERE id = $1`, [recordId]);
        expect(rows).toHaveLength(0);
      });
    });

    it("cascades away an erasure_records row when its contact is deleted", async () => {
      // A live `DELETE FROM organization` cascading through erasure_records
      // cannot be exercised here -- migration 0045 (Phase 10) revoked ALL
      // privileges from `mega_crm_app` on `invitation`/`member` (re-granting
      // only SELECT), and Postgres's FK cascade-enforcement trigger for
      // those tables runs under the REFERENCING table's OWNER privileges
      // regardless of which role issues the top-level DELETE -- confirmed
      // empirically by `reputation-and-ingestion-alert-state.test.ts`'s
      // identical finding: even a real cluster superuser gets `permission
      // denied for table invitation` cascading a `DELETE FROM organization`.
      // The `workspace_id -> organization(id)` cascade is therefore verified
      // at the catalog level below (mirrors that file's own workaround);
      // THIS test instead proves the cascade live via `contact_id ->
      // contacts(id)`, which carries no such restriction -- `contacts` is an
      // ordinary `mega_crm_app`-owned table with full DML.
      const workspaceId = await freshWorkspaceId("erasure-records-cascade");
      const { contactId, recordId } = await withWorkspace(seedPool, workspaceId, async (client) => {
        const { rows: contactRows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, anonymized_at) VALUES ($1, now()) RETURNING id`,
          [workspaceId]
        );
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO erasure_records (workspace_id, contact_id, anonymized_at) VALUES ($1, $2, now()) RETURNING id`,
          [workspaceId, contactRows[0].id]
        );
        return { contactId: contactRows[0].id, recordId: rows[0].id };
      });

      await withWorkspace(seedPool, workspaceId, (client) =>
        client.query(`DELETE FROM contacts WHERE id = $1`, [contactId])
      );

      await withWorkspace(seedPool, workspaceId, async (client) => {
        const { rows } = await client.query(`SELECT id FROM erasure_records WHERE id = $1`, [recordId]);
        expect(rows).toHaveLength(0);
      });
    });

    it("erasure_records.workspace_id foreign key specifies ON DELETE CASCADE against organization(id)", async () => {
      const { rows } = await seedPool.query<{ confdeltype: string; referenced_table: string; column_name: string }>(
        `SELECT confdeltype, confrelid::regclass::text AS referenced_table, a.attname as column_name
           FROM pg_constraint c
           JOIN pg_attribute a ON a.attnum = c.conkey[1] AND a.attrelid = c.conrelid
          WHERE conrelid = 'erasure_records'::regclass
            AND contype = 'f'
            AND confrelid = 'organization'::regclass`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].column_name).toBe("workspace_id");
      // 'c' = CASCADE (see pg_constraint.confdeltype in the Postgres catalog docs).
      expect(rows[0].confdeltype).toBe("c");
    });
  });
});
