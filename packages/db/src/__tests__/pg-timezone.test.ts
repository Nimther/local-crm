import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createEphemeralDatabase, dropEphemeralDatabase, quoteIdentifier } from "@mega-crm/test-support";

import { createPgPool } from "../pool.js";

/**
 * Phase 17 plan 01 (WR-06, D-01, D-02) -- proves the write-path half of WR-06
 * behaviorally, against a real Postgres database whose own default timezone
 * is deliberately NOT UTC. Mirrors `pg-tls.test.ts`'s own philosophy: prove
 * real server behavior, never inspect the Pool's own JS config object.
 *
 * The one timezone mutation this file makes is `ALTER DATABASE
 * <provisioned.databaseName> SET timezone TO 'America/New_York'` -- scoped
 * to the ONE throwaway database this test provisions and drops. It never
 * touches the shared Postgres cluster's own TZ/PGTZ or postgresql.conf, so
 * no other concurrently-running test on the same cluster is affected
 * (`packages/test-support/src/provision-db.ts` provisions every ephemeral
 * test database against one shared cluster).
 *
 * Test 2 is the negative control: a bare `new Pool()` (deliberately NOT
 * `createPgPool`; `lint:pg-pool-factory` exempts `__tests__` directories) is
 * expected to inherit the database's altered default. If this test ever
 * starts reporting `UTC`, the harness has stopped being non-UTC and Tests 1
 * and 3 would have become vacuous -- this is why it exists and must never be
 * deleted alongside the others.
 */

const provisioned = await createEphemeralDatabase({ workspace: "pg-timezone" });

// Scoped to THIS ONE ephemeral database only, via `ALTER DATABASE`, never a
// cluster-level TZ/PGTZ or postgresql.conf change (RESEARCH.md Pattern 3).
const tzAdmin = new Pool({ connectionString: provisioned.adminDsn });
await tzAdmin.query(
  `ALTER DATABASE ${quoteIdentifier(provisioned.databaseName)} SET timezone TO 'America/New_York'`,
);
await tzAdmin.end();

/** Truncate an ISO-8601 or Postgres-naive-timestamp string to its date+hour bucket. */
function dateHourBucket(timestampText: string): string {
  // Both "2026-08-19T16:24:05.123Z" (JS toISOString) and
  // "2026-08-19 16:24:05.123456" (Postgres naive `timestamp::text`) put the
  // date at [0,10) and the hour at [11,13) -- only the separator character at
  // index 10 differs (T vs space), so slicing to 13 chars yields a
  // comparable "YYYY-MM-DD HH"-shaped bucket for both formats.
  return timestampText.slice(0, 13);
}

/** Interpret a Postgres naive-timestamp text value AS IF its digits were UTC. */
function parseNaiveTimestampAsUtc(timestampText: string): Date {
  return new Date(`${timestampText.replace(" ", "T")}Z`);
}

describe("naive timestamp UTC pin survives a non-UTC database default (WR-06, D-01/D-02)", () => {
  afterAll(async () => {
    await dropEphemeralDatabase(provisioned.databaseName, provisioned.adminDsn);
  });

  it("a pool built by createPgPool reports SHOW TimeZone = UTC even against a database defaulted to America/New_York", async () => {
    const pool = createPgPool({ connectionString: provisioned.dsn, name: "pg-timezone-test-pinned" });
    try {
      const { rows } = await pool.query<{ TimeZone: string }>("SHOW TimeZone");
      expect(rows[0].TimeZone).toBe("UTC");
    } finally {
      await pool.end();
    }
  });

  it("negative control: a bare pool NOT built via createPgPool inherits the database's America/New_York default", async () => {
    const bypassPool = new Pool({ connectionString: provisioned.dsn });
    try {
      const { rows } = await bypassPool.query<{ TimeZone: string }>("SHOW TimeZone");
      expect(rows[0].TimeZone).toBe("America/New_York");
    } finally {
      await bypassPool.end();
    }
  });

  it("a naive timestamp DEFAULT now() column stores true UTC wall clock through the pinned pool, and a different (shifted) value through the unpinned pool", async () => {
    const pinnedPool = createPgPool({ connectionString: provisioned.dsn, name: "pg-timezone-test-write" });
    const bypassPool = new Pool({ connectionString: provisioned.dsn });
    try {
      // No migrations are applied to this ephemeral database -- create the
      // probe table locally rather than depending on `contacts`. Naive
      // `timestamp` column defaulted from `now()`, reproducing WR-06's exact
      // column-type hazard.
      await pinnedPool.query(
        `CREATE TABLE tz_probe (
           label text NOT NULL,
           written_at timestamp NOT NULL DEFAULT now()
         )`,
      );

      const beforeInsertUtc = new Date();
      await pinnedPool.query(`INSERT INTO tz_probe (label) VALUES ('pinned')`);
      await bypassPool.query(`INSERT INTO tz_probe (label) VALUES ('unpinned')`);
      const afterInsertUtc = new Date();

      // Read the naive column back as text so no driver-side timezone
      // interpretation can enter the comparison.
      const { rows } = await pinnedPool.query<{ label: string; written_at: string }>(
        `SELECT label, written_at::text AS written_at FROM tz_probe ORDER BY label`,
      );
      const pinnedRow = rows.find((row) => row.label === "pinned");
      const unpinnedRow = rows.find((row) => row.label === "unpinned");
      expect(pinnedRow).toBeDefined();
      expect(unpinnedRow).toBeDefined();

      // Compare at date+hour granularity, not to the second, so this test is
      // not clock-race-flaky; accept either the before- or after-insert UTC
      // hour to absorb an hour boundary crossed mid-test.
      const beforeBucket = dateHourBucket(beforeInsertUtc.toISOString());
      const afterBucket = dateHourBucket(afterInsertUtc.toISOString());
      const pinnedBucket = dateHourBucket(pinnedRow!.written_at);
      expect([beforeBucket, afterBucket]).toContain(pinnedBucket);

      // The unpinned write stores America/New_York's local wall clock
      // instead of true UTC -- this is the WR-06 hazard, made executable.
      // America/New_York is always a WHOLE number of hours behind UTC (4 in
      // EDT, 5 in EST), so interpreting both naive values' digits as if they
      // were UTC and diffing them recovers exactly that whole-hour offset.
      const pinnedInstant = parseNaiveTimestampAsUtc(pinnedRow!.written_at);
      const unpinnedInstant = parseNaiveTimestampAsUtc(unpinnedRow!.written_at);
      const diffHours = Math.round((pinnedInstant.getTime() - unpinnedInstant.getTime()) / 3_600_000);
      expect(diffHours).not.toBe(0);
      expect([4, 5]).toContain(diffHours);
    } finally {
      await pinnedPool.end();
      await bypassPool.end();
    }
  });
});
