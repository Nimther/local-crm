import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrationFile,
  createEphemeralDatabase,
  dropEphemeralDatabase,
  listMigrationFiles,
} from "@mega-crm/test-support";

import { LOOKAHEAD_MONTHS, PARTITIONED_TABLES, ensurePartitions } from "../ensure-partitions.js";
import { relocateAllDefaultRows } from "../relocate-default.js";

/**
 * 09-04 task 3 (DB-03/DB-04, ROADMAP success criterion 3): the evidence that
 * a month boundary crossed with the automation running LATE -- DEFAULT
 * already holding rows by the time recovery happens -- is handled correctly
 * by the SAME code the operator runs.
 *
 * Two independent ephemeral databases:
 *   - "Scenario A" (tests 1/2/4): the target month's partition is dropped,
 *     rows land in DEFAULT, `relocateAllDefaultRows` recovers it, then
 *     `ensurePartitions` proves the cheap-attach state is restored.
 *   - "Scenario B" (test 3): the SAME late state, but `ensurePartitions` is
 *     called FIRST, before any relocation, to prove a genuinely non-empty
 *     DEFAULT (holding a DIFFERENT month's backlog) does not block attaching
 *     OTHER months via the CHECK-constraint-first sequence -- Pitfall 13's
 *     point is that the exclusion check is scoped to the specific range
 *     being attached, not "DEFAULT must be globally empty". (Attaching the
 *     SAME month whose rows are still sitting in DEFAULT would genuinely
 *     fail the exclusion CHECK -- that is not what this test exercises.)
 *
 * Test 5 needs no database at all: it is a source-inspection check that the
 * CLI entrypoint and this suite import the same function (D-08).
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const CLI_SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/relocate-default-partition-rows.ts",
);

// The dropped/late month for both scenarios -- the LAST month migration
// 0038's catch-up creates, matching apps/api's own tracer-test precedent
// for "drop an existing month to simulate a gap" (DROP TABLE events_2027_06).
const LATE_MONTH_YEAR = 2027;
const LATE_MONTH_INDEX = 5; // June (0-based)
const LATE_MONTH_MID = new Date(Date.UTC(LATE_MONTH_YEAR, LATE_MONTH_INDEX, 15, 12, 0, 0));

/**
 * `createEphemeralDatabase`'s own `adminDsn` field points at the CLUSTER's
 * maintenance database (`postgres`, used for CREATE/DROP DATABASE), not at
 * the ephemeral database itself -- swap only the pathname, keeping whatever
 * superuser credentials `adminDsn` already carries, to get a connection that
 * (a) targets the ephemeral database's own tables and (b) is backed by the
 * same RLS-bypassing role class production's
 * `PARTITION_RELOCATION_ADMIN_DATABASE_URL` documents (superuser or
 * BYPASSRLS).
 */
function adminDsnForDatabase(adminDsn: string, databaseName: string): string {
  const url = new URL(adminDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function seedWorkspaceAndContact(pool: Pool): Promise<{ workspaceId: string; contactId: string }> {
  const workspaceId = randomUUID();
  await pool.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3)`, [
    workspaceId,
    "Late Automation Test Co",
    `late-automation-${workspaceId.slice(0, 8)}`,
  ]);

  const contactId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    await client.query(`INSERT INTO contacts (id, workspace_id, external_id) VALUES ($1, $2, $3)`, [
      contactId,
      workspaceId,
      `late-automation-contact-${contactId.slice(0, 8)}`,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { workspaceId, contactId };
}

async function seedEvent(
  pool: Pool,
  workspaceId: string,
  contactId: string,
  id: string,
  name: string,
  occurredAt: Date,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    await client.query(
      `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, $5::timestamptz)`,
      [id, workspaceId, contactId, name, occurredAt],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function seedSendEvent(
  pool: Pool,
  workspaceId: string,
  id: string,
  sgEventId: string,
  occurredAt: Date,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    await client.query(
      `INSERT INTO send_events (id, workspace_id, sg_event_id, event_type, payload, occurred_at)
       VALUES ($1, $2, $3, 'delivered', '{}'::jsonb, $4::timestamptz)`,
      [id, workspaceId, sgEventId, occurredAt],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function countDefaultRows(pool: Pool, relation: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM ${relation}`);
  return Number(rows[0]?.count ?? 0);
}

async function countParentRows(pool: Pool, workspaceId: string, parentTable: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    const { rows } = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${parentTable}`);
    await client.query("COMMIT");
    return Number(rows[0]?.count ?? 0);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function readEventByIdThroughParent(
  pool: Pool,
  workspaceId: string,
  id: string,
): Promise<{ name: string; occurred_at: Date } | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    const { rows } = await client.query<{ name: string; occurred_at: Date }>(
      `SELECT name, occurred_at FROM events WHERE id = $1`,
      [id],
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

describe("boundary-crossing-late-automation (09-04 task 3, ROADMAP success criterion 3)", () => {
  describe("Scenario A: relocate first, then ensurePartitions restores the cheap-attach state", () => {
    let pool: Pool;
    let relocationPool: Pool;
    let relocationAdminPool: Pool;
    let databaseName: string;
    let adminDsn: string;
    let workspaceId: string;
    let contactId: string;
    const eventId = randomUUID();
    const sendEventId = randomUUID();

    let totalEventsBeforeRecovery: number;
    let totalSendEventsBeforeRecovery: number;

    beforeAll(async () => {
      const created = await createEphemeralDatabase({ workspace: "late-automation-a" });
      databaseName = created.databaseName;
      adminDsn = created.adminDsn;
      pool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });
      // Dedicated pool for relocate-default.ts/ensure-partitions.ts calls --
      // never shared with the tenant-scoped seeding pool above (see 09-04
      // task 1's commit for why).
      relocationPool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });
      // 10-06 (SEC-01/SEC-02, checkpoint option-b): relocateAllDefaultRows
      // now REQUIRES a separate elevated adminClient for its ATTACH steps'
      // FK re-validation visibility (migration 0043 drops the legacy
      // app.admin_scan-gated policy this suite used to rely on implicitly)
      // -- same shape as relocate-default.test.ts's relocationAdminPool.
      relocationAdminPool = new Pool({
        connectionString: adminDsnForDatabase(adminDsn, databaseName),
        max: 5,
        options: "-c timezone=UTC",
      });

      const files = listMigrationFiles(MIGRATIONS_DIR);
      for (const file of files) {
        await applyMigrationFile(pool, MIGRATIONS_DIR, file);
      }

      // Simulate "the automation ran late": the June 2027 partition that
      // migration 0038's catch-up already created is dropped, mirroring
      // apps/api's own tracer-test precedent for manufacturing a gap.
      await pool.query(`DROP TABLE events_2027_06`);
      await pool.query(`DROP TABLE send_events_2027_06`);

      const seeded = await seedWorkspaceAndContact(pool);
      workspaceId = seeded.workspaceId;
      contactId = seeded.contactId;

      // With no partition covering June 2027, these land in DEFAULT.
      await seedEvent(pool, workspaceId, contactId, eventId, "late_automation_event", LATE_MONTH_MID);
      await seedSendEvent(pool, workspaceId, sendEventId, `sg-late-${sendEventId}`, LATE_MONTH_MID);

      totalEventsBeforeRecovery = await countParentRows(pool, workspaceId, "events");
      totalSendEventsBeforeRecovery = await countParentRows(pool, workspaceId, "send_events");
    }, 60_000);

    afterAll(async () => {
      await relocationAdminPool?.end();
      await relocationPool?.end();
      await pool?.end();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    it("test 1: DEFAULT holds the late rows, and relocateAllDefaultRows -- the same function the CLI calls -- recovers them", async () => {
      expect(await countDefaultRows(pool, "events_default")).toBeGreaterThan(0);
      expect(await countDefaultRows(pool, "send_events_default")).toBeGreaterThan(0);

      await relocateAllDefaultRows(relocationPool, relocationAdminPool, PARTITIONED_TABLES);

      expect(await countDefaultRows(pool, "events_default")).toBe(0);
      expect(await countDefaultRows(pool, "send_events_default")).toBe(0);

      const { rows: eventsPartitionRows } = await pool.query<{ relispartition: boolean }>(
        `SELECT relispartition FROM pg_class WHERE relname = 'events_2027_06'`,
      );
      expect(eventsPartitionRows[0]?.relispartition, "events_2027_06 must exist and be attached").toBe(true);

      const { rows: sendEventsPartitionRows } = await pool.query<{ relispartition: boolean }>(
        `SELECT relispartition FROM pg_class WHERE relname = 'send_events_2027_06'`,
      );
      expect(
        sendEventsPartitionRows[0]?.relispartition,
        "send_events_2027_06 must exist and be attached",
      ).toBe(true);

      const relocatedEvent = await readEventByIdThroughParent(pool, workspaceId, eventId);
      expect(relocatedEvent?.name, "the relocated row must be readable through the parent with identical values").toBe(
        "late_automation_event",
      );
      expect(relocatedEvent?.occurred_at).toEqual(LATE_MONTH_MID);
    });

    it("test 2: with DEFAULT now empty, ensurePartitions creates the next month -- the cheap-attach state is restored", async () => {
      const now = new Date(Date.UTC(LATE_MONTH_YEAR, LATE_MONTH_INDEX, 20));
      const results = await ensurePartitions(relocationPool, PARTITIONED_TABLES, now, LOOKAHEAD_MONTHS);

      const eventsResult = results.find((r) => r.table === "events");
      expect(eventsResult?.created, "the month after June (July 2027) must be freshly created").toContain(
        "events_2027_07",
      );

      const { rows } = await pool.query<{ relispartition: boolean }>(
        `SELECT relispartition FROM pg_class WHERE relname = 'events_2027_07'`,
      );
      expect(rows[0]?.relispartition).toBe(true);
    });

    it("test 4: row counts are conserved across the whole late-automation recovery", async () => {
      const totalEventsAfter = await countParentRows(pool, workspaceId, "events");
      const totalSendEventsAfter = await countParentRows(pool, workspaceId, "send_events");

      expect(totalEventsAfter).toBe(totalEventsBeforeRecovery);
      expect(totalSendEventsAfter).toBe(totalSendEventsBeforeRecovery);
    });
  });

  describe("Scenario B: ensurePartitions runs first, against a genuinely non-empty DEFAULT", () => {
    let pool: Pool;
    let relocationPool: Pool;
    let databaseName: string;
    let adminDsn: string;

    beforeAll(async () => {
      const created = await createEphemeralDatabase({ workspace: "late-automation-b" });
      databaseName = created.databaseName;
      adminDsn = created.adminDsn;
      pool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });
      relocationPool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });

      const files = listMigrationFiles(MIGRATIONS_DIR);
      for (const file of files) {
        await applyMigrationFile(pool, MIGRATIONS_DIR, file);
      }

      await pool.query(`DROP TABLE events_2027_06`);
      await pool.query(`DROP TABLE send_events_2027_06`);

      const { workspaceId, contactId } = await seedWorkspaceAndContact(pool);
      // Rows for June 2027 land in DEFAULT and are DELIBERATELY left there
      // for this scenario -- no relocation call happens before
      // ensurePartitions runs.
      await seedEvent(pool, workspaceId, contactId, randomUUID(), "scenario_b_event", LATE_MONTH_MID);
      await seedSendEvent(pool, workspaceId, randomUUID(), `sg-scenario-b-${randomUUID()}`, LATE_MONTH_MID);
    }, 60_000);

    afterAll(async () => {
      await relocationPool?.end();
      await pool?.end();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    it("test 3: ensurePartitions succeeds and exercises the exclusion-constraint path while DEFAULT genuinely holds rows (Pitfall 13)", async () => {
      expect(await countDefaultRows(pool, "events_default")).toBeGreaterThan(0);

      // `now` is July 2027 -- one month AFTER the still-defaulted June
      // backlog. ensurePartitions walks forward (July..October, per
      // LOOKAHEAD_MONTHS=3) and attaches each via CHECK-constraint-first.
      // Every one of those attaches runs its exclusion-CHECK-then-VALIDATE
      // step against a DEFAULT that is NOT empty (June's rows are still
      // there) -- proving the mechanism is scoped to each month's own
      // range, not gated on DEFAULT being globally empty (Pitfall 13).
      const now = new Date(Date.UTC(LATE_MONTH_YEAR, LATE_MONTH_INDEX + 1, 15));
      const results = await ensurePartitions(relocationPool, PARTITIONED_TABLES, now, LOOKAHEAD_MONTHS);

      const eventsResult = results.find((r) => r.table === "events");
      expect(eventsResult?.created).toEqual(
        expect.arrayContaining(["events_2027_07", "events_2027_08", "events_2027_09", "events_2027_10"]),
      );

      for (const name of ["events_2027_07", "events_2027_08", "events_2027_09", "events_2027_10"]) {
        const { rows } = await pool.query<{ relispartition: boolean }>(
          `SELECT relispartition FROM pg_class WHERE relname = $1`,
          [name],
        );
        expect(rows[0]?.relispartition, `${name} must be attached`).toBe(true);
      }

      // June's backlog is untouched -- ensurePartitions creates NEW
      // partitions going forward; it never relocates existing DEFAULT rows.
      expect(await countDefaultRows(pool, "events_default")).toBeGreaterThan(0);
    });
  });

  it("test 5: procedure and test are one code path -- the CLI entrypoint imports the same relocation function this suite imports", () => {
    const cliSource = readFileSync(CLI_SCRIPT_PATH, "utf8");
    expect(cliSource).toMatch(/relocateAllDefaultRows/);
    expect(cliSource).toMatch(/from\s+["'][^"']*relocate-default\.js["']/);
  });
});
