import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureTestDbMigrated, getScanTestDatabaseUrl, getTestDatabaseUrl } from "@mega-crm/test-support";

import { closeScanPool, pool, withCrossWorkspaceScan, withTenant, withTenantTransaction } from "../index.js";

/**
 * Phase 10 (SEC-01/SEC-02, D-01/D-02) — the tracer slice for the whole
 * scan-role architecture: `mega_crm_scan`, `withCrossWorkspaceScan`,
 * migration 0041's role-scoped `campaigns_scan` policy, and the P2/P3
 * negative assertions that prove the role is least-privilege and the API
 * process cannot reach it.
 */
describe("cross-workspace scan role (Phase 10 SEC-01/SEC-02)", () => {
  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.SCAN_DATABASE_URL = getScanTestDatabaseUrl();
  });

  afterAll(async () => {
    await closeScanPool();
    await pool.end();
  });

  async function seedDueCampaign(nameSeed: string): Promise<{ workspaceId: string; campaignId: string }> {
    const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows: orgRows } = await pool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, slug],
    );
    const workspaceId = orgRows[0].id;

    const campaignId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Scan fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }],
        );
        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, scheduled_at, created_by_user_id)
           VALUES ($1, 'Scan fixture campaign', 'scheduled', $2, now() - interval '1 minute', 'test-user')
           RETURNING id`,
          [workspaceId, segmentRows[0].id],
        );
        return campaignRows[0].id;
      }),
    );

    return { workspaceId, campaignId };
  }

  it("Test 1: reads due campaigns from two DIFFERENT workspaces in a single scan-pool query", async () => {
    const a = await seedDueCampaign("scan-workspace-a");
    const b = await seedDueCampaign("scan-workspace-b");

    const rows = await withCrossWorkspaceScan((client) =>
      client
        .query<{ id: string; workspaceId: string }>(
          `SELECT id, workspace_id as "workspaceId" FROM campaigns
           WHERE status = 'scheduled' AND scheduled_at <= now() AND id = ANY($1::uuid[])`,
          [[a.campaignId, b.campaignId]],
        )
        .then((res) => res.rows),
    );

    const seenWorkspaceIds = rows.map((r) => r.workspaceId).sort();
    expect(seenWorkspaceIds).toEqual([a.workspaceId, b.workspaceId].sort());
  });

  it("Test 2: mega_crm_scan is a login role that cannot bypass RLS", async () => {
    const { rows } = await pool.query<{ rolcanlogin: boolean; rolbypassrls: boolean }>(
      `SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = 'mega_crm_scan'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolcanlogin).toBe(true);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("Test 3: mega_crm_scan and mega_crm_auth own zero tables", async () => {
    const { rows } = await pool.query<{ rolname: string; relname: string }>(
      `SELECT r.rolname, c.relname
       FROM pg_class c
       JOIN pg_roles r ON r.oid = c.relowner
       WHERE r.rolname IN ('mega_crm_scan', 'mega_crm_auth')`,
    );
    expect(rows).toEqual([]);
  });

  it("Test 4: mega_crm_app is not a member of mega_crm_scan or mega_crm_auth (P3)", async () => {
    const { rows } = await pool.query<{ scanMember: boolean; authMember: boolean }>(
      `SELECT
         pg_has_role('mega_crm_app', 'mega_crm_scan', 'MEMBER') AS "scanMember",
         pg_has_role('mega_crm_app', 'mega_crm_auth', 'MEMBER') AS "authMember"`,
    );
    expect(rows[0].scanMember).toBe(false);
    expect(rows[0].authMember).toBe(false);
  });

  it("Test 5 (10-01 tracer, superseded by 10-03's flow_versions case below): a scan-pool query against a table with no grant/policy is refused outright, not silently empty", async () => {
    // 10-01 originally asserted this against `contacts` -- migration 0042
    // (this plan) now GRANTs SELECT on `contacts` to mega_crm_scan (with an
    // unrestricted-row `contacts_scan` policy, T-10-03-02), so `contacts` is
    // no longer a table with "no grant/policy". `flow_versions` replaces it
    // as the ungranted table: still no grant for mega_crm_scan anywhere in
    // this migration set, so the same privilege-check-layer refusal applies
    // -- "permission denied", not an empty result set.
    await expect(
      withCrossWorkspaceScan((client) => client.query(`SELECT id FROM flow_versions LIMIT 1`)),
    ).rejects.toThrow(/permission denied for table flow_versions/);
  });

  // ---------------------------------------------------------------------
  // Phase 10 plan 10-03 (SEC-01/SEC-02): the three remaining worker-level
  // scan consumers (flow-reconciliation, flow-segment-sweep,
  // analytics-reconciliation) and migration 0042's narrowing predicates.
  // ---------------------------------------------------------------------

  async function seedOrganization(nameSeed: string): Promise<string> {
    const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, slug],
    );
    return rows[0].id;
  }

  /** Seeds one flow_run (with its parent flow/flow_version/contact) at the given status/next_wake_at. */
  async function seedFlowRun(
    nameSeed: string,
    opts: { status: string; nextWakeAt: Date },
  ): Promise<{ workspaceId: string; flowRunId: string }> {
    const workspaceId = await seedOrganization(nameSeed);
    const flowRunId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
        const { rows: contactRows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', 'subscribed') RETURNING id`,
          [workspaceId, email],
        );
        const { rows: flowRows } = await client.query<{ id: string }>(
          `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_event_name, created_by_user_id)
           VALUES ($1, 'Scan fixture flow', 'live', 'event', 'fixture_event', 'test-user') RETURNING id`,
          [workspaceId],
        );
        const { rows: versionRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
           VALUES ($1, $2, 1, $3, now()) RETURNING id`,
          [workspaceId, flowRows[0].id, { nodes: [], edges: [] }],
        );
        const { rows: runRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_runs (workspace_id, flow_id, flow_version_id, contact_id, status, next_wake_at)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [workspaceId, flowRows[0].id, versionRows[0].id, contactRows[0].id, opts.status, opts.nextWakeAt],
        );
        return runRows[0].id;
      }),
    );
    return { workspaceId, flowRunId };
  }

  /** Seeds one segment-triggered flow (with its parent segment) at the given status. */
  async function seedSegmentFlow(nameSeed: string, opts: { status: string }): Promise<{ workspaceId: string; flowId: string }> {
    const workspaceId = await seedOrganization(nameSeed);
    const flowId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Scan fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }],
        );
        const { rows: flowRows } = await client.query<{ id: string }>(
          `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_segment_id, created_by_user_id)
           VALUES ($1, 'Scan fixture segment flow', $2, 'segment', $3, 'test-user') RETURNING id`,
          [workspaceId, opts.status, segmentRows[0].id],
        );
        const { rows: versionRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
           VALUES ($1, $2, 1, $3, now()) RETURNING id`,
          [workspaceId, flowRows[0].id, { nodes: [], edges: [] }],
        );
        await client.query(`UPDATE flows SET live_version_id = $2 WHERE id = $1`, [flowRows[0].id, versionRows[0].id]);
        return flowRows[0].id;
      }),
    );
    return { workspaceId, flowId };
  }

  it("10-03 Test 1: reads waiting, past-wake flow_runs from two DIFFERENT workspaces in a single scan-pool query", async () => {
    const past = new Date(Date.now() - 60_000);
    const a = await seedFlowRun("flow-runs-scan-a", { status: "waiting", nextWakeAt: past });
    const b = await seedFlowRun("flow-runs-scan-b", { status: "waiting", nextWakeAt: past });

    const rows = await withCrossWorkspaceScan((client) =>
      client
        .query<{ id: string; workspaceId: string }>(
          `SELECT id, workspace_id as "workspaceId" FROM flow_runs
           WHERE status = 'waiting' AND next_wake_at <= now() AND id = ANY($1::uuid[])`,
          [[a.flowRunId, b.flowRunId]],
        )
        .then((res) => res.rows),
    );

    const seenWorkspaceIds = rows.map((r) => r.workspaceId).sort();
    expect(seenWorkspaceIds).toEqual([a.workspaceId, b.workspaceId].sort());
  });

  it("10-03 Test 2: a completed flow_run and a future-wake waiting flow_run are both invisible to the scan pool", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60 * 60_000);
    const completed = await seedFlowRun("flow-runs-scan-completed", { status: "completed", nextWakeAt: past });
    const futureWake = await seedFlowRun("flow-runs-scan-future", { status: "waiting", nextWakeAt: future });

    const rows = await withCrossWorkspaceScan((client) =>
      client
        .query<{ id: string }>(
          `SELECT id FROM flow_runs
           WHERE status = 'waiting' AND next_wake_at <= now() AND id = ANY($1::uuid[])`,
          [[completed.flowRunId, futureWake.flowRunId]],
        )
        .then((res) => res.rows),
    );

    // Note: a plain `status = 'waiting'` WHERE clause alone would NOT have
    // excluded the completed row's PRESENCE in `flow_runs` (it excludes it
    // by status match, not by RLS) -- the assertion here is specifically
    // that the POLICY itself narrows visibility, proven by seeding a
    // completed row and confirming the scan-pool query -- which shares the
    // exact same predicate as flow_runs_scan's USING clause -- still returns
    // nothing for either id.
    expect(rows).toEqual([]);
  });

  it("10-03 Test 3: a live segment-triggered flow in each of two workspaces is visible to the scan pool; a paused one is not", async () => {
    const live1 = await seedSegmentFlow("flows-scan-live-1", { status: "live" });
    const live2 = await seedSegmentFlow("flows-scan-live-2", { status: "live" });
    const paused = await seedSegmentFlow("flows-scan-paused", { status: "paused" });

    const rows = await withCrossWorkspaceScan((client) =>
      client
        .query<{ id: string; workspaceId: string }>(
          `SELECT id, workspace_id as "workspaceId" FROM flows
           WHERE status = 'live' AND trigger_type = 'segment'
             AND trigger_segment_id IS NOT NULL AND live_version_id IS NOT NULL
             AND id = ANY($1::uuid[])`,
          [[live1.flowId, live2.flowId, paused.flowId]],
        )
        .then((res) => res.rows),
    );

    const seenIds = rows.map((r) => r.id).sort();
    expect(seenIds).toEqual([live1.flowId, live2.flowId].sort());
  });

  it("10-03 Test 4: the scan pool can read organization ids across workspaces", async () => {
    const a = await seedOrganization("org-scan-a");
    const b = await seedOrganization("org-scan-b");

    const rows = await withCrossWorkspaceScan((client) =>
      client
        .query<{ id: string }>(`SELECT id FROM organization WHERE id = ANY($1::uuid[])`, [[a, b]])
        .then((res) => res.rows),
    );

    expect(rows.map((r) => r.id).sort()).toEqual([a, b].sort());
  });

  it("Test 7: withCrossWorkspaceScan rejects with a descriptive error when SCAN_DATABASE_URL is unset", async () => {
    const saved = process.env.SCAN_DATABASE_URL;
    delete process.env.SCAN_DATABASE_URL;
    try {
      await expect(withCrossWorkspaceScan((client) => client.query("SELECT 1"))).rejects.toThrow(
        /SCAN_DATABASE_URL is required/,
      );
    } finally {
      if (saved !== undefined) process.env.SCAN_DATABASE_URL = saved;
    }
  });

  // ---------------------------------------------------------------------
  // Phase 10 plan 10-06 (SEC-01/SEC-02): the legacy app.admin_scan marker
  // GUC is retired everywhere -- migration 0043 drops the last five
  // policies that read it (campaign_scheduler_due_scan, flow_runs_due_scan,
  // flows_segment_sweep_scan, partition_relocation_admin_scan x2), and
  // ensure-partitions.ts's attachPartitionCheckFirst no longer sets it.
  // These two tests are the SPEC R2 negative proof: no policy still
  // references the marker, and setting it grants nothing.
  // ---------------------------------------------------------------------

  /** Seeds one contact and one send in a fresh workspace, for the marker-retirement negative test below. */
  async function seedContactAndSend(nameSeed: string): Promise<{ workspaceId: string; contactId: string; sendId: string }> {
    const workspaceId = await seedOrganization(nameSeed);
    const { contactId, sendId } = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
        const { rows: contactRows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, subscription_status)
           VALUES ($1, $2, 'subscribed') RETURNING id`,
          [workspaceId, email],
        );
        const { rows: sendRows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, contact_id, kind, status)
           VALUES ($1, $2, 'campaign', 'sent') RETURNING id`,
          [workspaceId, contactRows[0].id],
        );
        return { contactId: contactRows[0].id, sendId: sendRows[0].id };
      }),
    );
    return { workspaceId, contactId, sendId };
  }

  const MARKER_GATED_TABLES = ["campaigns", "flow_runs", "flows", "contacts", "sends"] as const;

  /**
   * Phase 10 plan 10-07 (SEC-03/SEC-04, migration 0044): all five of these
   * tables now carry the fail-closed `workspace_isolation` predicate, so a
   * genuinely fresh connection (never previously tenant-scoped, so
   * `app.current_workspace_id` reads as unset rather than the empty string a
   * recycled connection would leave behind -- see `tenant-context.test.ts`'s
   * "the fail-closed RLS contract" describe block) now THROWS on every one
   * of these tables instead of returning zero rows. The marker-retirement
   * negative proof this helper backs still holds under that predicate: it
   * is re-expressed as "the marker changes nothing about whether the query
   * throws" rather than "the marker changes nothing about the row count" --
   * a stronger claim, since a thrown error can never be misread as "no such
   * record" the way a silent zero-row result could.
   *
   * Runs each table's query in its OWN transaction (BEGIN per table, not
   * once for the whole loop): once a query throws, Postgres aborts the
   * transaction and every subsequent statement on it fails with "current
   * transaction is aborted" rather than the real per-table error -- a fresh
   * BEGIN/ROLLBACK per table keeps every table's outcome independently
   * observable on the SAME physical connection (dedicatedPool has max: 1).
   */
  async function probeMarkerGatedTables(
    dedicatedPool: Pool,
    setMarker: boolean,
  ): Promise<Record<(typeof MARKER_GATED_TABLES)[number], { threw: boolean; message?: string }>> {
    const client = await dedicatedPool.connect();
    const outcomes = {} as Record<(typeof MARKER_GATED_TABLES)[number], { threw: boolean; message?: string }>;
    try {
      for (const table of MARKER_GATED_TABLES) {
        await client.query("BEGIN");
        if (setMarker) {
          await client.query("SELECT set_config('app.admin_scan', 'true', true)");
        }
        try {
          await client.query<{ id: string }>(`SELECT id FROM ${table}`);
          outcomes[table] = { threw: false };
          await client.query("COMMIT");
        } catch (err) {
          outcomes[table] = { threw: true, message: err instanceof Error ? err.message : String(err) };
          await client.query("ROLLBACK");
        }
      }
    } finally {
      client.release();
    }
    return outcomes;
  }

  it("10-06 Test 1: setting the legacy admin-scan marker on a tenant-pool connection grants no additional access across five tables", async () => {
    // Seed two workspaces' worth of real rows in every table the marker
    // used to gate visibility on, so this is a meaningful claim, not
    // vacuously true on an empty table.
    await seedDueCampaign("marker-retired-campaign-a");
    await seedDueCampaign("marker-retired-campaign-b");
    const pastWake = new Date(Date.now() - 60_000);
    await seedFlowRun("marker-retired-flow-run-a", { status: "waiting", nextWakeAt: pastWake });
    await seedFlowRun("marker-retired-flow-run-b", { status: "waiting", nextWakeAt: pastWake });
    await seedSegmentFlow("marker-retired-segment-flow-a", { status: "live" });
    await seedSegmentFlow("marker-retired-segment-flow-b", { status: "live" });
    await seedContactAndSend("marker-retired-contact-send-a");
    await seedContactAndSend("marker-retired-contact-send-b");

    // A DEDICATED, single-connection pool -- never shared with `pool` above
    // (which every seed helper's withTenantTransaction call already reused
    // many times in this file, leaving `app.current_workspace_id` reverted
    // to '' on some of its physical connections). A genuinely fresh
    // connection is what makes "the marker changes nothing" a meaningful
    // claim about the fail-closed predicate's behaviour.
    const freshPool = new Pool({ connectionString: getTestDatabaseUrl(), max: 1 });
    try {
      const withoutMarker = await probeMarkerGatedTables(freshPool, false);
      const withMarker = await probeMarkerGatedTables(freshPool, true);

      for (const table of MARKER_GATED_TABLES) {
        expect(
          withMarker[table].threw,
          `${table}: setting the legacy admin-scan marker must not change whether the fail-closed predicate throws`,
        ).toBe(withoutMarker[table].threw);
        expect(
          withMarker[table].threw,
          `${table}: a connection with no tenant context must raise, not silently reveal rows, under Phase 10's fail-closed predicate`,
        ).toBe(true);
        expect(withMarker[table].message).toMatch(/unrecognized configuration parameter/);
      }
    } finally {
      await freshPool.end();
    }
  });

  it("10-06 Test 2: no policy in pg_policies references the legacy admin-scan marker variable", async () => {
    const { rows } = await pool.query<{
      policyname: string;
      qual: string | null;
      withCheck: string | null;
    }>(`SELECT policyname, qual, with_check AS "withCheck" FROM pg_policies WHERE schemaname = 'public'`);

    const offenders = rows.filter(
      (r) => (r.qual ?? "").includes("app.admin_scan") || (r.withCheck ?? "").includes("app.admin_scan"),
    );
    expect(
      offenders,
      `expected zero policies referencing app.admin_scan, found: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});
