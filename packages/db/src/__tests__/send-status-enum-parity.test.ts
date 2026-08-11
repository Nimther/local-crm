import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrationFile,
  createEphemeralDatabase,
  dropEphemeralDatabase,
  listMigrationFiles,
} from "@mega-crm/test-support";

import { SEND_STATUSES } from "@mega-crm/delivery-core";
import { sendStatusEnum } from "../schema/sends.js";

/**
 * Phase 11, plan 11-02 (DLV-01 support, key_links) — proves the three
 * independent places that name the send-status vocabulary can never
 * silently drift apart:
 *
 *   1. `sendStatusEnum.enumValues` (this package's Drizzle schema).
 *   2. `SEND_STATUSES` (`@mega-crm/delivery-core`'s executable mirror of
 *      ARCHITECTURE.md's state-machine section, the design artifact 11-01
 *      landed).
 *   3. `enum_range(NULL::send_status)` against a database that has actually
 *      run migrations 0047/0048 (the live physical enum).
 *
 * Provisions its OWN ephemeral database and applies the full migration
 * chain directly (mirrors `fixture-partition-parity.test.ts`/
 * `migrate-incremental.test.ts` in this same directory), rather than
 * reusing `@mega-crm/test-support`'s shared `getTestDatabaseUrl()` fixture
 * -- the existing convention in this package's own test suite.
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

describe("send_status enum parity (11-02, DLV-01 support)", () => {
  let pool: Pool;
  let databaseName: string;
  let adminDsn: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "send-status-enum-parity" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    pool = new Pool({ connectionString: created.dsn, max: 2 });

    const files = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of files) {
      await applyMigrationFile(pool, MIGRATIONS_DIR, file);
    }
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("Drizzle's sendStatusEnum.enumValues is set-equal to delivery-core's SEND_STATUSES", () => {
    const drizzleValues = [...sendStatusEnum.enumValues].sort();
    const deliveryCoreValues = [...SEND_STATUSES].sort();
    expect(drizzleValues).toEqual(deliveryCoreValues);
  });

  it("the live database's enum_range(NULL::send_status) is set-equal to SEND_STATUSES", async () => {
    const { rows } = await pool.query<{ v: string }>(
      "SELECT unnest(enum_range(NULL::send_status))::text AS v",
    );
    const liveValues = rows.map((r) => r.v).sort();
    const deliveryCoreValues = [...SEND_STATUSES].sort();
    expect(liveValues).toEqual(deliveryCoreValues);
  });

  it("the live database's enum_range is also set-equal to Drizzle's sendStatusEnum.enumValues", async () => {
    const { rows } = await pool.query<{ v: string }>(
      "SELECT unnest(enum_range(NULL::send_status))::text AS v",
    );
    const liveValues = rows.map((r) => r.v).sort();
    const drizzleValues = [...sendStatusEnum.enumValues].sort();
    expect(liveValues).toEqual(drizzleValues);
  });

  it("SEND_STATUSES has exactly six values -- a future addition without an updated migration would be caught here first", () => {
    expect(SEND_STATUSES).toHaveLength(6);
    expect([...SEND_STATUSES].sort()).toEqual(
      ["dispatching", "excluded", "failed", "reconciling", "sent", "unknown"].sort(),
    );
  });
});
