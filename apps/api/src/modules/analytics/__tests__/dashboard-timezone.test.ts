import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { BASELINE_CONTACT_COUNT_SQL, GROWTH_BY_DAY_SQL } from "../dashboard.repository.js";

/**
 * WR-06 / D-01 / D-02 (Phase 17 plan 02): proves the growth-chart's
 * day-bucketing SQL returns a UTC calendar day for a given contact
 * regardless of the READING session's `TimeZone` GUC, and makes
 * RESEARCH.md's Pitfall 1 executable: the single-hop
 * `(created_at AT TIME ZONE 'UTC')::date` form -- the exact expression
 * 13-REVIEW.md's WR-06 write-up and CONTEXT.md's D-01 both literally name --
 * is WRONG for `contacts.created_at` (a naive `timestamp` column, NOT
 * `timestamptz`), because it re-introduces session-TimeZone-dependence one
 * cast away.
 *
 * The non-UTC session is forced with a transaction-scoped `SET LOCAL TIME
 * ZONE` issued on the SAME client that then runs the query under test --
 * deliberately a session override, not an `ALTER DATABASE`. This simulates
 * exactly the scenario D-01 cites as the reason a read-site fix is needed at
 * all: a client whose session was never pinned by `createPgPool` (plan
 * 17-01). Because the override is transaction-local, this test does not
 * depend on plan 17-01's pool-level pin having landed, and does not become
 * vacuous once it has.
 *
 * `GROWTH_BY_DAY_SQL`/`BASELINE_CONTACT_COUNT_SQL` are imported directly
 * from `dashboard.repository.ts` -- this test executes production's exact
 * SQL string, not a copy that could drift.
 */

// The deliberately-WRONG single-hop expression 13-REVIEW.md's WR-06 write-up
// and CONTEXT.md's D-01 both name -- exists ONLY in this test file, to fail
// loudly if production ever adopts it (RESEARCH.md Pitfall 1). Never
// exported from dashboard.repository.ts.
const SINGLE_HOP_GROWTH_SQL = `SELECT (created_at AT TIME ZONE 'UTC')::date::text as day, count(*)::text as "newContacts"
   FROM contacts
   WHERE workspace_id = $1 AND created_at >= $2::date AND anonymized_at IS NULL
   GROUP BY (created_at AT TIME ZONE 'UTC')::date
   ORDER BY day`;

describe("dashboard growth query is UTC-day-correct under a non-UTC reading session (WR-06, D-01/D-02)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function signUp(email: string, password: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password, name },
    });
    expect(res.statusCode, `sign-up failed: ${res.body}`).toBe(200);
    const sessionCookie = res.cookies.find((c) => c.name.toLowerCase().includes("session"));
    if (!sessionCookie) {
      throw new Error("sign-up response did not set a session cookie");
    }
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

  async function owner(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    return { ...account, workspace };
  }

  /** A UTC calendar-day string (YYYY-MM-DD), `n` days before today (UTC). */
  function utcDayString(n: number): string {
    const now = new Date();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - n));
    return day.toISOString().slice(0, 10);
  }

  /**
   * Inserts a contact with an explicit `created_at` LITERAL wall-clock
   * string (no offset, e.g. `"2026-08-18 01:30:00"`) -- never a JS `Date`
   * object. A `Date` parameter would be serialized by `pg` with an offset
   * derived from the TEST PROCESS's own local `TZ` (node-postgres's
   * `dateToString`, `parseInputDatesAsUTC: false` is the driver default),
   * which Postgres would then reinterpret through the INSERT session's
   * `TimeZone` GUC to produce the stored naive wall-clock value -- exactly
   * the write-side hazard this whole phase is about, and not something this
   * READ-side test wants any dependency on. A literal string with no offset
   * is stored by Postgres verbatim, with no timezone conversion at insert
   * time at all, so the fixture's naive value is deterministic regardless of
   * which session or process TZ runs this test.
   */
  async function insertContactAtLiteral(workspaceId: string, email: string, naiveLiteral: string) {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO contacts (workspace_id, email, created_at, updated_at)
           VALUES ($1, $2, $3::timestamp, $3::timestamp)`,
          [workspaceId, email, naiveLiteral]
        )
      )
    );
  }

  /**
   * Runs `fn` inside one transaction whose session `TimeZone` has been
   * overridden via `SET LOCAL TIME ZONE` -- scoped to that one transaction,
   * auto-resets on COMMIT, and cannot leak into another test sharing the
   * pool (mirrors `withTenantTransaction`'s own `SET LOCAL` discipline for
   * the tenant GUC).
   */
  async function withSessionTimeZone<T>(
    workspaceId: string,
    timeZone: string,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        await client.query(`SET LOCAL TIME ZONE '${timeZone}'`);
        return fn(client);
      })
    );
  }

  it("Test 1: GROWTH_BY_DAY_SQL returns the correct UTC day under an America/New_York reading session", async () => {
    const { workspace } = await owner("tz-test1");
    // Window boundary well before the fixture, so the row is always inside it.
    const startDay = utcDayString(30);
    // The fixture's UTC calendar day: "the day before today".
    const correctDay = utcDayString(1);
    const naiveLiteral = `${correctDay} 01:30:00`;

    await insertContactAtLiteral(workspace.id, `tz1-${Date.now()}@example.com`, naiveLiteral);

    const rows = await withSessionTimeZone(workspace.id, "America/New_York", async (client) => {
      const { rows } = await client.query<{ day: string; newContacts: string }>(GROWTH_BY_DAY_SQL, [
        workspace.id,
        startDay,
      ]);
      return rows;
    });

    const row = rows.find((r) => Number(r.newContacts) > 0);
    expect(row, `no non-zero day bucket found among: ${JSON.stringify(rows)}`).toBeDefined();
    expect(row!.day).toBe(correctDay);
  });

  it("Test 2 (RESEARCH.md Pitfall 1, made executable): the single-hop form returns the WRONG (New York) day under the same non-UTC session", async () => {
    const { workspace } = await owner("tz-test2");
    const startDay = utcDayString(30);
    const correctDay = utcDayString(1);
    // One calendar day before the correct UTC day -- the day the single-hop
    // form is expected to (incorrectly) report under America/New_York.
    const wrongDay = utcDayString(2);
    const naiveLiteral = `${correctDay} 01:30:00`;

    await insertContactAtLiteral(workspace.id, `tz2-${Date.now()}@example.com`, naiveLiteral);

    const rows = await withSessionTimeZone(workspace.id, "America/New_York", async (client) => {
      const { rows } = await client.query<{ day: string; newContacts: string }>(SINGLE_HOP_GROWTH_SQL, [
        workspace.id,
        startDay,
      ]);
      return rows;
    });

    const row = rows.find((r) => Number(r.newContacts) > 0);
    expect(row, `no non-zero day bucket found among: ${JSON.stringify(rows)}`).toBeDefined();
    expect(row!.day).toBe(wrongDay);
    expect(row!.day).not.toBe(correctDay);
  });

  it("Test 3: under the pool's own UTC session, the double-hop and single-hop forms agree", async () => {
    const { workspace } = await owner("tz-test3");
    const startDay = utcDayString(30);
    const correctDay = utcDayString(1);
    const naiveLiteral = `${correctDay} 01:30:00`;

    await insertContactAtLiteral(workspace.id, `tz3-${Date.now()}@example.com`, naiveLiteral);

    const [doubleHopRows, singleHopRows] = await withSessionTimeZone(workspace.id, "UTC", async (client) => {
      const doubleHop = await client.query<{ day: string; newContacts: string }>(GROWTH_BY_DAY_SQL, [
        workspace.id,
        startDay,
      ]);
      const singleHop = await client.query<{ day: string; newContacts: string }>(SINGLE_HOP_GROWTH_SQL, [
        workspace.id,
        startDay,
      ]);
      return [doubleHop.rows, singleHop.rows];
    });

    const doubleHopRow = doubleHopRows.find((r) => Number(r.newContacts) > 0);
    const singleHopRow = singleHopRows.find((r) => Number(r.newContacts) > 0);
    expect(doubleHopRow?.day).toBe(correctDay);
    expect(singleHopRow?.day).toBe(correctDay);
    expect(doubleHopRow?.day).toBe(singleHopRow?.day);
  });

  it("Test 4 (D-03 verified-safe, made executable): BASELINE_CONTACT_COUNT_SQL returns the identical count under a UTC and an America/New_York session", async () => {
    const { workspace } = await owner("tz-test4");
    const startDay = utcDayString(30);
    const dayBeforeStartDay = utcDayString(31);

    // Genuinely before the window boundary -- counts toward baseline under
    // ANY session, since the comparison is naive-to-naive with no timezone
    // conversion at all.
    await insertContactAtLiteral(workspace.id, `tz4-before-${Date.now()}@example.com`, `${dayBeforeStartDay} 23:00:00`);
    // Straddles the window boundary in New York local time: 02:00 on the
    // start day itself is NOT "< startDay" (naive comparison), but if this
    // value were EVER reinterpreted through a session's TimeZone (the bug
    // this test guards against), a -4/-5h shift would push it to the
    // previous UTC day and incorrectly count it toward baseline under a
    // non-UTC session.
    await insertContactAtLiteral(workspace.id, `tz4-straddle-${Date.now()}@example.com`, `${startDay} 02:00:00`);

    const utcCount = await withSessionTimeZone(workspace.id, "UTC", async (client) => {
      const { rows } = await client.query<{ count: string }>(BASELINE_CONTACT_COUNT_SQL, [workspace.id, startDay]);
      return Number(rows[0]?.count ?? 0);
    });

    const nyCount = await withSessionTimeZone(workspace.id, "America/New_York", async (client) => {
      const { rows } = await client.query<{ count: string }>(BASELINE_CONTACT_COUNT_SQL, [workspace.id, startDay]);
      return Number(rows[0]?.count ?? 0);
    });

    expect(utcCount).toBe(1);
    expect(nyCount).toBe(1);
    expect(nyCount).toBe(utcCount);
  });
});
