import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildEphemeralDatabaseName,
  createEphemeralDatabase,
  dropEphemeralDatabase,
} from "../provision-db.js";
import { getMigrationsDir } from "../db-fixture.js";

/**
 * 08-06 (QG-04) — per-workspace database isolation.
 *
 * This closes the SPEC R4 concurrency BACKSTOP edge. The shared advisory lock
 * (8_472_991) serializes *migration application* across processes, but it does
 * nothing to keep two workspaces' ROWS apart: if api and worker ran their
 * suites concurrently against one physical database, each would happily
 * truncate and re-seed tables the other was mid-assertion on.
 *
 * Isolation therefore comes from giving each workspace its own database, and
 * that is what is asserted here — not by inspecting names alone, but by writing
 * a distinct marker into each and proving neither can see the other's.
 */

const RUN_ID = randomUUID().slice(0, 8);

describe("migrations directory resolution", () => {
  // The consolidated fixture sits one level shallower than the three copies it
  // replaced, so the `../` count changed. Verified at runtime rather than
  // assumed — an off-by-one here would silently apply zero migrations.
  it("resolves to a real packages/db/migrations containing the SQL files", async () => {
    const dir = getMigrationsDir();
    expect(dir.endsWith("packages/db/migrations")).toBe(true);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).filter((f) => f.endsWith(".sql")).length).toBeGreaterThan(30);
  });
});

describe("per-workspace ephemeral database names", () => {
  it("gives api, worker and delivery-core distinct names for the same run", () => {
    const names = ["api", "worker", "delivery-core"].map((ws) =>
      buildEphemeralDatabaseName(ws, RUN_ID),
    );
    expect(new Set(names).size).toBe(3);
    names.forEach((n) => expect(n.startsWith("mega_crm_test_")).toBe(true));
  });
});

describe("two workspaces' databases are physically distinct", () => {
  const created: Array<{ databaseName: string; dsn: string; adminDsn: string }> = [];

  afterAll(async () => {
    for (const db of created) {
      await dropEphemeralDatabase(db.databaseName, db.adminDsn).catch(() => {});
    }
  });

  it("a row written in one is invisible in the other", async () => {
    const a = await createEphemeralDatabase({ workspace: "isolationa", runId: RUN_ID });
    created.push(a);
    const b = await createEphemeralDatabase({ workspace: "isolationb", runId: RUN_ID });
    created.push(b);

    expect(a.databaseName).not.toBe(b.databaseName);

    const poolA = new Pool({ connectionString: a.dsn });
    const poolB = new Pool({ connectionString: b.dsn });
    try {
      for (const [pool, marker] of [
        [poolA, "marker-a"],
        [poolB, "marker-b"],
      ] as Array<[Pool, string]>) {
        await pool.query("CREATE TABLE isolation_probe (marker text primary key)");
        await pool.query("INSERT INTO isolation_probe (marker) VALUES ($1)", [marker]);
      }

      const { rows: rowsA } = await poolA.query<{ marker: string }>(
        "SELECT marker FROM isolation_probe",
      );
      const { rows: rowsB } = await poolB.query<{ marker: string }>(
        "SELECT marker FROM isolation_probe",
      );

      expect(rowsA.map((r) => r.marker)).toEqual(["marker-a"]);
      expect(rowsB.map((r) => r.marker)).toEqual(["marker-b"]);
    } finally {
      await poolA.end();
      await poolB.end();
    }
  });
});
