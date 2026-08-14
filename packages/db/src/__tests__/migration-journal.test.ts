import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEphemeralDatabase, dropEphemeralDatabase } from "@mega-crm/test-support";

import {
  assertMigrationsCurrent,
  findPendingMigrations,
  MigrationsTableMissingError,
  type AppliedMigrationRow,
  type ShippedMigration,
} from "../migration-journal.js";

/**
 * Phase 14 plan 01, Task 1 -- Tests 2-5 (Test 1, the end-to-end 503->200
 * flip, lives in apps/api/src/modules/ops/__tests__/readyz.test.ts).
 *
 * Tests 2-4 exercise `findPendingMigrations` -- pure, no I/O, no database.
 * Test 5 needs a real (deliberately never-migrated) database to prove
 * `assertMigrationsCurrent` throws rather than silently reporting "0
 * pending" against a database that has never been touched by a migration.
 */

const SHIPPED: ShippedMigration[] = [
  { tag: "0001_a", when: 1_000, idx: 0 },
  { tag: "0002_b", when: 2_000, idx: 1 },
  { tag: "0003_c", when: 3_000, idx: 2 },
];

describe("findPendingMigrations (pure)", () => {
  it("Test 2: returns every shipped tag for an empty journal", () => {
    expect(findPendingMigrations(SHIPPED, [])).toEqual(SHIPPED);
  });

  it("Test 3: returns an empty list for a fully migrated database", () => {
    const applied: AppliedMigrationRow[] = [{ hash: "hash-0003", createdAt: 3_000 }];
    expect(findPendingMigrations(SHIPPED, applied)).toEqual([]);
  });

  it("Test 4: returns exactly the trailing tags when the journal is missing only the newest entries", () => {
    const applied: AppliedMigrationRow[] = [{ hash: "hash-0001", createdAt: 1_000 }];
    expect(findPendingMigrations(SHIPPED, applied)).toEqual([
      { tag: "0002_b", when: 2_000, idx: 1 },
      { tag: "0003_c", when: 3_000, idx: 2 },
    ]);
  });
});

describe("assertMigrationsCurrent against a genuinely never-migrated database", () => {
  let pool: Pool;
  let databaseName: string;
  let adminDsn: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "migration-journal" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    pool = new Pool({ connectionString: created.dsn, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("Test 5: throws MigrationsTableMissingError -- never a silently-empty comparison", async () => {
    await expect(assertMigrationsCurrent(pool)).rejects.toBeInstanceOf(MigrationsTableMissingError);
  });
});
