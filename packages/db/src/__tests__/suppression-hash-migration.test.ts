import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrationFile,
  applyMigrationsUpTo,
  buildRoleDsn,
  createEphemeralDatabase,
  dropEphemeralDatabase,
  SCAN_ROLE,
} from "@mega-crm/test-support";
import { isEmailSuppressed, normalizeSuppressionEmail } from "@mega-crm/contacts-core";

import { rehashAllSuppressions, rehashSuppressionsForWorkspace } from "../../scripts/rehash-suppressions.js";

/**
 * Phase 13 (CMP-04, D-02, plan 13-12), Task 3: proves the full
 * expand-backfill-contract sequence against a real ephemeral Postgres.
 * Checked out at migration 0059 (the last migration before this plan's own
 * 0060/0061) via `applyMigrationsUpTo`, mirroring
 * `send-events-dedup-rebase.test.ts`'s checkpoint convention -- seeding
 * plaintext `workspace_suppressions` rows requires the PRE-0060 schema,
 * where `email` is still the enforced NOT NULL identity column.
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const CHECKPOINT_BEFORE_0060 = "0059_contact_erasure.sql";
const MIGRATION_0060 = "0060_suppression_hash_expand.sql";
const MIGRATION_0061 = "0061_suppression_hash_contract.sql";

function adminDsnForDatabase(adminDsn: string, databaseName: string): string {
  const url = new URL(adminDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function withTenantWrite<T>(
  pool: Pool,
  workspaceId: string,
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function createWorkspace(adminPool: Pool, seed: string): Promise<string> {
  const workspaceId = randomUUID();
  await adminPool.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3)`, [
    workspaceId,
    `Suppression Hash Test ${seed}`,
    `supp-hash-test-${seed}-${workspaceId.slice(0, 8)}`,
  ]);
  return workspaceId;
}

/** Seeds a PRE-0060-shape plaintext suppression row directly (bypasses application code, which by this plan writes only the hash). */
async function seedPlaintextSuppression(appPool: Pool, workspaceId: string, email: string, reason = "manual"): Promise<string> {
  return withTenantWrite(appPool, workspaceId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO workspace_suppressions (workspace_id, email, reason) VALUES ($1, $2, $3) RETURNING id`,
      [workspaceId, email, reason],
    );
    return rows[0].id;
  });
}

async function suppressionRowCount(appPool: Pool, workspaceId: string): Promise<number> {
  return withTenantWrite(appPool, workspaceId, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workspace_suppressions WHERE workspace_id = $1`,
      [workspaceId],
    );
    return Number(rows[0]?.count ?? "0");
  });
}

async function nullHashCount(appPool: Pool, workspaceId: string): Promise<number> {
  return withTenantWrite(appPool, workspaceId, async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workspace_suppressions WHERE workspace_id = $1 AND email_hash IS NULL`,
      [workspaceId],
    );
    return Number(rows[0]?.count ?? "0");
  });
}

async function columnExists(pool: Pool, table: string, column: string): Promise<boolean> {
  const { rows } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

async function constraintExists(pool: Pool, relation: string, constraintName: string): Promise<boolean> {
  const { rows } = await pool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`,
    [relation, constraintName],
  );
  return rows.length > 0;
}

async function indexExists(pool: Pool, indexName: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS exists`, [
    `public.${indexName}`,
  ]);
  return rows[0]?.exists ?? false;
}

describe("suppression hash expand/backfill/contract sequence (Phase 13, CMP-04, plan 13-12, Task 3)", () => {
  describe("0061's fail-closed guard", () => {
    let adminPool: Pool;
    let appPool: Pool;
    let migratePool: Pool;
    let databaseName: string;
    let adminDsn: string;

    beforeAll(async () => {
      const created = await createEphemeralDatabase({ workspace: "supp-hash-guard" });
      databaseName = created.databaseName;
      adminDsn = created.adminDsn;
      appPool = new Pool({ connectionString: created.dsn, max: 5 });
      migratePool = new Pool({ connectionString: created.dsn, max: 2 });
      adminPool = new Pool({ connectionString: adminDsnForDatabase(adminDsn, databaseName), max: 5 });

      await applyMigrationsUpTo(migratePool, MIGRATIONS_DIR, CHECKPOINT_BEFORE_0060);
    }, 60_000);

    afterAll(async () => {
      await adminPool?.end();
      await migratePool?.end();
      await appPool?.end();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    it("applying 0060 then 0061 over an EMPTY suppression table succeeds trivially", async () => {
      await expect(applyMigrationFile(migratePool, MIGRATIONS_DIR, MIGRATION_0060)).resolves.toBeUndefined();
      await expect(applyMigrationFile(migratePool, MIGRATIONS_DIR, MIGRATION_0061)).resolves.toBeUndefined();

      expect(await columnExists(migratePool, "workspace_suppressions", "email")).toBe(false);
      expect(await constraintExists(migratePool, "workspace_suppressions", "workspace_suppressions_workspace_email_unique")).toBe(
        false,
      );
      expect(await indexExists(migratePool, "workspace_suppressions_workspace_email_hash_unique")).toBe(true);
    });
  });

  describe("0061 refuses to apply while a row still has a null email_hash", () => {
    let adminPool: Pool;
    let appPool: Pool;
    let migratePool: Pool;
    let databaseName: string;
    let adminDsn: string;
    let workspaceId: string;
    let email: string;

    beforeAll(async () => {
      const created = await createEphemeralDatabase({ workspace: "supp-hash-unresolved" });
      databaseName = created.databaseName;
      adminDsn = created.adminDsn;
      appPool = new Pool({ connectionString: created.dsn, max: 5 });
      migratePool = new Pool({ connectionString: created.dsn, max: 2 });
      adminPool = new Pool({ connectionString: adminDsnForDatabase(adminDsn, databaseName), max: 5 });

      await applyMigrationsUpTo(migratePool, MIGRATIONS_DIR, CHECKPOINT_BEFORE_0060);
      workspaceId = await createWorkspace(adminPool, "unresolved");
      email = `unbackfilled-${randomUUID()}@example.test`;
      await seedPlaintextSuppression(appPool, workspaceId, email);

      await applyMigrationFile(migratePool, MIGRATIONS_DIR, MIGRATION_0060);
    }, 60_000);

    afterAll(async () => {
      await adminPool?.end();
      await migratePool?.end();
      await appPool?.end();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    it("raises naming the backfill script, and leaves the email column and old constraint in place", async () => {
      await expect(applyMigrationFile(migratePool, MIGRATIONS_DIR, MIGRATION_0061)).rejects.toThrow(
        /db:rehash-suppressions/,
      );

      expect(await columnExists(migratePool, "workspace_suppressions", "email")).toBe(true);
      expect(
        await constraintExists(migratePool, "workspace_suppressions", "workspace_suppressions_workspace_email_unique"),
      ).toBe(true);
      expect(await nullHashCount(appPool, workspaceId)).toBe(1);
    });

    it("succeeds once the backfill has hashed the row, and the seeded address is still suppressed afterward", async () => {
      const result = await rehashSuppressionsForWorkspace(appPool, workspaceId, 500);
      expect(result).toMatchObject({ workspaceId, hashed: 1, skippedCollisions: 0 });
      expect(await nullHashCount(appPool, workspaceId)).toBe(0);

      await expect(applyMigrationFile(migratePool, MIGRATIONS_DIR, MIGRATION_0061)).resolves.toBeUndefined();

      expect(await columnExists(migratePool, "workspace_suppressions", "email")).toBe(false);

      const suppressed = await withTenantWrite(appPool, workspaceId, (client) =>
        isEmailSuppressed(client, workspaceId, email.toUpperCase()),
      );
      expect(suppressed).toBe(true);
    });
  });

  describe("the backfill script: idempotency, batching, and leaving already-hashed rows untouched", () => {
    let adminPool: Pool;
    let appPool: Pool;
    let scanPool: Pool;
    let migratePool: Pool;
    let databaseName: string;
    let adminDsn: string;
    let workspaceId: string;

    beforeAll(async () => {
      const created = await createEphemeralDatabase({ workspace: "supp-hash-backfill" });
      databaseName = created.databaseName;
      adminDsn = created.adminDsn;
      appPool = new Pool({ connectionString: created.dsn, max: 5 });
      migratePool = new Pool({ connectionString: created.dsn, max: 2 });
      adminPool = new Pool({ connectionString: adminDsnForDatabase(adminDsn, databaseName), max: 5 });
      scanPool = new Pool({
        connectionString: buildRoleDsn(adminDsnForDatabase(adminDsn, databaseName), databaseName, SCAN_ROLE, "mega_crm_dev_pw"),
        max: 5,
      });

      await applyMigrationsUpTo(migratePool, MIGRATIONS_DIR, CHECKPOINT_BEFORE_0060);
      workspaceId = await createWorkspace(adminPool, "backfill");

      for (let i = 0; i < 3; i += 1) {
        await seedPlaintextSuppression(appPool, workspaceId, `batch-${i}-${randomUUID()}@example.test`);
      }

      await applyMigrationFile(migratePool, MIGRATIONS_DIR, MIGRATION_0060);
    }, 60_000);

    afterAll(async () => {
      await scanPool?.end();
      await adminPool?.end();
      await migratePool?.end();
      await appPool?.end();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    it("pages in bounded batches and reports progress", async () => {
      const batchSizes: number[] = [];
      const result = await rehashSuppressionsForWorkspace(appPool, workspaceId, 1, (batchHashed) => {
        batchSizes.push(batchHashed);
      });

      expect(result.hashed).toBe(3);
      expect(result.batches).toBe(3);
      expect(batchSizes).toEqual([1, 1, 1]);
      expect(await nullHashCount(appPool, workspaceId)).toBe(0);
    });

    it("is idempotent -- a second run changes nothing", async () => {
      const secondRun = await rehashSuppressionsForWorkspace(appPool, workspaceId, 500);
      expect(secondRun).toMatchObject({ workspaceId, hashed: 0, skippedCollisions: 0, batches: 0 });
    });

    it("leaves an already-hashed row untouched (adding a fresh plaintext row and re-running only hashes the new one)", async () => {
      const freshEmail = `fresh-${randomUUID()}@example.test`;
      await seedPlaintextSuppression(appPool, workspaceId, freshEmail);

      const result = await rehashSuppressionsForWorkspace(appPool, workspaceId, 500);
      expect(result.hashed).toBe(1);
      expect(await nullHashCount(appPool, workspaceId)).toBe(0);
    });

    it("rehashAllSuppressions (the CLI's own discover-then-work path) enumerates via the scan role and reaches the same per-workspace result", async () => {
      const freshWorkspaceId = await createWorkspace(adminPool, "backfill-all");
      const email = `all-wrapper-${randomUUID()}@example.test`;
      await seedPlaintextSuppression(appPool, freshWorkspaceId, email);

      const report = await rehashAllSuppressions(scanPool, appPool, 500);
      const thisWorkspace = report.perWorkspace.find((w) => w.workspaceId === freshWorkspaceId);
      expect(thisWorkspace).toMatchObject({ workspaceId: freshWorkspaceId, hashed: 1, skippedCollisions: 0 });
      expect(await nullHashCount(appPool, freshWorkspaceId)).toBe(0);
    });

    it("performs no write on the scan connection and issues no GRANT naming mega_crm_scan", async () => {
      const fs = await import("node:fs");
      const scriptSource = fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/rehash-suppressions.ts"),
        "utf8",
      );
      expect(scriptSource).not.toMatch(/\bGRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL|USAGE|EXECUTE)\b/i);

      const migration0060Source = fs.readFileSync(path.resolve(MIGRATIONS_DIR, MIGRATION_0060), "utf8");
      expect(migration0060Source).not.toMatch(/GRANT[^;]*mega_crm_scan/i);
    });
  });

  describe("case/whitespace collision between two pre-existing plaintext rows", () => {
    let adminPool: Pool;
    let appPool: Pool;
    let migratePool: Pool;
    let databaseName: string;
    let adminDsn: string;
    let workspaceId: string;

    beforeAll(async () => {
      const created = await createEphemeralDatabase({ workspace: "supp-hash-collision" });
      databaseName = created.databaseName;
      adminDsn = created.adminDsn;
      appPool = new Pool({ connectionString: created.dsn, max: 5 });
      migratePool = new Pool({ connectionString: created.dsn, max: 2 });
      adminPool = new Pool({ connectionString: adminDsnForDatabase(adminDsn, databaseName), max: 5 });

      await applyMigrationsUpTo(migratePool, MIGRATIONS_DIR, CHECKPOINT_BEFORE_0060);
      workspaceId = await createWorkspace(adminPool, "collision");

      const base = `Collide-${randomUUID()}@example.test`;
      await seedPlaintextSuppression(appPool, workspaceId, base);
      await seedPlaintextSuppression(appPool, workspaceId, base.toUpperCase());

      await applyMigrationFile(migratePool, MIGRATIONS_DIR, MIGRATION_0060);
    }, 60_000);

    afterAll(async () => {
      await adminPool?.end();
      await migratePool?.end();
      await appPool?.end();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    it("hashes one row, skips the colliding one, and does not crash the batch", async () => {
      const result = await rehashSuppressionsForWorkspace(appPool, workspaceId, 500);
      expect(result.hashed).toBe(1);
      expect(result.skippedCollisions).toBe(1);
      expect(await suppressionRowCount(appPool, workspaceId)).toBe(2);
      expect(await nullHashCount(appPool, workspaceId)).toBe(1);
    });

    it("0061 still refuses to apply -- the skipped row's null hash is not silently dropped", async () => {
      await expect(applyMigrationFile(migratePool, MIGRATIONS_DIR, MIGRATION_0061)).rejects.toThrow(
        /db:rehash-suppressions/,
      );
    });
  });

  describe("full sequence: seed plaintext, expand, backfill, contract", () => {
    let adminPool: Pool;
    let appPool: Pool;
    let migratePool: Pool;
    let databaseName: string;
    let adminDsn: string;
    let workspaceId: string;
    const seededEmails = [
      `full-seq-a-${randomUUID()}@example.test`,
      `full-seq-b-${randomUUID()}@example.test`,
      `full-seq-c-${randomUUID()}@example.test`,
    ];

    beforeAll(async () => {
      const created = await createEphemeralDatabase({ workspace: "supp-hash-full-sequence" });
      databaseName = created.databaseName;
      adminDsn = created.adminDsn;
      appPool = new Pool({ connectionString: created.dsn, max: 5 });
      migratePool = new Pool({ connectionString: created.dsn, max: 2 });
      adminPool = new Pool({ connectionString: adminDsnForDatabase(adminDsn, databaseName), max: 5 });

      await applyMigrationsUpTo(migratePool, MIGRATIONS_DIR, CHECKPOINT_BEFORE_0060);
      workspaceId = await createWorkspace(adminPool, "full-sequence");

      for (const email of seededEmails) {
        await seedPlaintextSuppression(appPool, workspaceId, email, "manual");
      }

      await applyMigrationFile(migratePool, MIGRATIONS_DIR, MIGRATION_0060);
      await rehashSuppressionsForWorkspace(appPool, workspaceId, 500);
      await applyMigrationFile(migratePool, MIGRATIONS_DIR, MIGRATION_0061);
    }, 60_000);

    afterAll(async () => {
      await adminPool?.end();
      await migratePool?.end();
      await appPool?.end();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    it("every seeded address is still suppressed after the full sequence, including under a different letter case", async () => {
      for (const email of seededEmails) {
        const suppressed = await withTenantWrite(appPool, workspaceId, (client) =>
          isEmailSuppressed(client, workspaceId, normalizeSuppressionEmail(email).toUpperCase()),
        );
        expect(suppressed, `expected ${email} to still be suppressed`).toBe(true);
      }
    });

    it("information_schema reports no email column on workspace_suppressions", async () => {
      expect(await columnExists(migratePool, "workspace_suppressions", "email")).toBe(false);
    });

    it("email_hash is NOT NULL and unique per workspace", async () => {
      const { rows } = await migratePool.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workspace_suppressions' AND column_name = 'email_hash'`,
      );
      expect(rows[0]?.is_nullable).toBe("NO");
      expect(await indexExists(migratePool, "workspace_suppressions_workspace_email_hash_unique")).toBe(true);
    });
  });
});
