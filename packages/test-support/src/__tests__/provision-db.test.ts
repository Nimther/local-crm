import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildEphemeralDatabaseName,
  createEphemeralDatabase,
  dropEphemeralDatabase,
  quoteIdentifier,
} from "../provision-db.js";

/**
 * 08-02 (QG-04) — ephemeral test-database provisioning.
 *
 * The security-critical property under test is the DROP guard: this module is
 * the only place in Phase 8 with enough privilege to destroy real data, so the
 * refusal must live INSIDE dropEphemeralDatabase — not at the call site — and
 * must fire before any connection is opened or any string is interpolated
 * into SQL (08-RESEARCH.md § Security Domain).
 *
 * The "before any connection" property is asserted by passing a deliberately
 * unreachable admin DSN: if the rejection is the name-validation error rather
 * than a connection error, validation demonstrably ran first.
 */

const UNREACHABLE_ADMIN_DSN = "postgres://nobody:nobody@127.0.0.1:1/postgres";

const ADMIN_DSN =
  process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

describe("buildEphemeralDatabaseName", () => {
  it("produces mega_crm_test_<workspace>_<runId>", () => {
    expect(buildEphemeralDatabaseName("worker", "abc123")).toBe("mega_crm_test_worker_abc123");
  });

  it("sanitizes characters outside [a-z0-9_] and lowercases", () => {
    const name = buildEphemeralDatabaseName("My-App.v2", "RUN/42");
    expect(name).toMatch(/^mega_crm_test_[a-z0-9_]+$/);
    expect(name).toBe("mega_crm_test_my_app_v2_run_42");
  });

  it("truncates to Postgres's 63-byte identifier limit", () => {
    const name = buildEphemeralDatabaseName("w".repeat(80), "r".repeat(80));
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith("mega_crm_test_")).toBe(true);
  });

  it("is deterministic for the same inputs and distinct for different runIds", () => {
    expect(buildEphemeralDatabaseName("worker", "abc123")).toBe(
      buildEphemeralDatabaseName("worker", "abc123"),
    );
    expect(buildEphemeralDatabaseName("worker", "abc123")).not.toBe(
      buildEphemeralDatabaseName("worker", "def456"),
    );
  });

  // 08-REVIEW WR-06: a plain 63-byte slice has no collision-avoidance step.
  // With a long enough workspace name, the runId-carrying suffix falls
  // entirely past the 63-byte cutoff, so two DIFFERENT runIds truncate to the
  // SAME name -- the opposite of the "unique per run" guarantee this function
  // documents. `dropEphemeralDatabase` combined with `createEphemeralDatabase`
  // calling it first means the second run would drop the first run's
  // still-in-use database out from under it.
  it("stays distinct after truncation even when the divergent runId falls past the 63-byte cutoff", () => {
    const workspace = "a".repeat(60);
    const nameA = buildEphemeralDatabaseName(workspace, "run-one");
    const nameB = buildEphemeralDatabaseName(workspace, "run-two");

    expect(nameA.length).toBeLessThanOrEqual(63);
    expect(nameB.length).toBeLessThanOrEqual(63);
    expect(nameA).not.toBe(nameB);
    expect(nameA.startsWith("mega_crm_test_")).toBe(true);
    expect(nameB.startsWith("mega_crm_test_")).toBe(true);
  });
});

describe("dropEphemeralDatabase — refuses non-test databases before connecting", () => {
  const forbidden: Array<{ name: string; value: string }> = [
    { name: "the dev database", value: "mega_crm" },
    { name: "the postgres system database", value: "postgres" },
    { name: "an empty name", value: "" },
    { name: "a quote-injection payload", value: 'mega_crm"; DROP DATABASE mega_crm; --' },
  ];

  it.each(forbidden)("rejects $name", async ({ value }) => {
    // An unreachable admin DSN: a connection-error rejection would prove the
    // guard ran too late. The assertion below requires the *validation* error.
    await expect(dropEphemeralDatabase(value, UNREACHABLE_ADMIN_DSN)).rejects.toThrow(
      /mega_crm_test|refus/i,
    );
  });

  it("accepts a name that satisfies the prefix and allow-list", async () => {
    // mega_crm_testing_ground passes both rules, so it must NOT be rejected by
    // validation — it fails later, on the unreachable connection instead.
    await expect(
      dropEphemeralDatabase("mega_crm_testing_ground", UNREACHABLE_ADMIN_DSN),
    ).rejects.not.toThrow(/mega_crm_test/);
  });
});

describe("quoteIdentifier", () => {
  it("wraps in double quotes and doubles any embedded double quote", () => {
    expect(quoteIdentifier("plain")).toBe('"plain"');
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });
});

describe("createEphemeralDatabase (integration)", () => {
  const runId = randomUUID().slice(0, 8);
  let created: { databaseName: string; dsn: string; adminDsn: string } | null = null;

  afterAll(async () => {
    if (created) {
      await dropEphemeralDatabase(created.databaseName, created.adminDsn).catch(() => {});
    }
  });

  it("creates a database reachable under the non-superuser app role, then drops it", async () => {
    created = await createEphemeralDatabase({ workspace: "provisiontest", runId });
    expect(created.databaseName).toBe(`mega_crm_test_provisiontest_${runId}`);

    // The returned DSN must be the APP role, not the admin role — with a
    // superuser DSN, RLS is not enforced and every RLS assertion in the
    // existing suites would become vacuous (D-11).
    expect(created.dsn).toContain("mega_crm_app");

    const pool = new Pool({ connectionString: created.dsn });
    try {
      const { rows } = await pool.query<{ db: string; usr: string }>(
        "select current_database() as db, current_user as usr",
      );
      expect(rows[0]?.db).toBe(created.databaseName);
      expect(rows[0]?.usr).toBe("mega_crm_app");
    } finally {
      await pool.end();
    }

    await dropEphemeralDatabase(created.databaseName, created.adminDsn);
    created = null;

    const admin = new Pool({ connectionString: ADMIN_DSN });
    try {
      const { rows } = await admin.query(
        "select 1 from pg_database where datname = $1",
        [`mega_crm_test_provisiontest_${runId}`],
      );
      expect(rows).toHaveLength(0);
    } finally {
      await admin.end();
    }
  });
});
