import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { encryptTenantSecret } from "@mega-crm/kms";
import {
  PURGE_EVIDENCE_TABLES,
  PURGE_SECRET_TABLES,
  PURGE_TABLE_ORDER,
  countPurgeTableRows,
  type PurgeTable,
} from "@mega-crm/db";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { insertFixtureOrganization, connectFixtureSendgridKey } from "../../test/failure-fixtures.js";
import { processWorkspacePurge } from "../workspace-purge.worker.js";

/**
 * Phase 22, plan 22-05 (PRG-02/PRG-04, D-10): the full FK-ordered table
 * allowlist, reconciled table-by-table against `docs/PII-INVENTORY.md`
 * (Task 1), and the proof that secrets are destroyed while every evidence
 * set survives a full-tenant purge (Task 2). Real Postgres, real RLS --
 * mirrors `workspace-purge.test.ts`'s own harness shape (the tracer's
 * two-table proof), extended to the full ~25-table order.
 *
 * Every `it()` seeds its OWN fresh workspace(s) and scopes every assertion to
 * that workspace's own id -- a later tick opportunistically finishing an
 * earlier test's already-asserted workspace is harmless, matching
 * `workspace-purge.test.ts`'s own file-level discipline.
 */
describe("workspace purge tables: full FK order, secrets, evidence (plan 22-05)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  async function softDeleteWorkspace(workspaceId: string, daysAgo: number): Promise<void> {
    await pool.query(`UPDATE organization SET "deletedAt" = now() - ($2 || ' days')::interval WHERE id = $1`, [
      workspaceId,
      daysAgo,
    ]);
  }

  interface OrganizationRow {
    name: string;
    slug: string;
    deletedAt: Date | null;
    purgedAt: Date | null;
  }

  async function readOrganization(workspaceId: string): Promise<OrganizationRow> {
    const { rows } = await pool.query<OrganizationRow>(
      `SELECT name, slug, "deletedAt" AS "deletedAt", "purgedAt" AS "purgedAt" FROM organization WHERE id = $1`,
      [workspaceId],
    );
    return rows[0];
  }

  interface PurgeRecordRow {
    status: string;
    tableCounts: Record<string, number>;
    completedTables: string[];
  }

  async function readPurgeRecord(workspaceId: string): Promise<PurgeRecordRow | null> {
    const { rows } = await pool.query<PurgeRecordRow>(
      `SELECT status,
              table_counts AS "tableCounts",
              completed_tables AS "completedTables"
         FROM purge_records WHERE workspace_id = $1`,
      [workspaceId],
    );
    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------
  // Small, local fixture helpers -- deliberately not shared with
  // workspace-purge.test.ts's own local helpers (same convention that file
  // itself follows relative to failure-fixtures.ts): this file's fixtures
  // seed every table in the full order, which no other test file needs.
  // -------------------------------------------------------------------

  async function seedContacts(workspaceId: string, count: number): Promise<string[]> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const ids: string[] = [];
        for (let i = 0; i < count; i += 1) {
          const email = `contact-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
             VALUES ($1, $2, 'Fixture', 'subscribed') RETURNING id`,
            [workspaceId, email],
          );
          ids.push(rows[0].id);
        }
        return ids;
      }),
    );
  }

  async function seedSubscriptionStatusHistory(workspaceId: string, contactId: string, count: number): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        for (let i = 0; i < count; i += 1) {
          await client.query(
            `INSERT INTO subscription_status_history (workspace_id, contact_id, old_status, new_status, source)
             VALUES ($1, $2, 'subscribed', 'unsubscribed', 'manual_ui')`,
            [workspaceId, contactId],
          );
        }
      }),
    );
  }

  async function countTable(workspaceId: string, table: PurgeTable): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction((client) => countPurgeTableRows(client, table, workspaceId)),
    );
  }

  async function countEvidenceTable(
    workspaceId: string,
    table: (typeof PURGE_EVIDENCE_TABLES)[number],
  ): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*) AS count FROM ${table} WHERE workspace_id = $1`,
          [workspaceId],
        );
        return Number(rows[0]?.count ?? 0);
      }),
    );
  }

  interface FullTenantFixtureIds {
    contactId: string;
  }

  /**
   * Seeds exactly one row into every one of the 25 tables in
   * `PURGE_TABLE_ORDER` except the three secret tables (which need KMS
   * envelope encryption and are seeded separately below), returning the
   * contact id so callers can also seed the evidence tables that reference
   * it.
   */
  async function seedFullTenantFixture(workspaceId: string): Promise<FullTenantFixtureIds> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const email = `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
        const { rows: contactRows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', 'subscribed') RETURNING id`,
          [workspaceId, email],
        );
        const contactId = contactRows[0].id;

        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }],
        );
        const segmentId = segmentRows[0].id;

        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, created_by_user_id)
           VALUES ($1, 'Fixture campaign', 'sending', $2, 'd-fixture-template', 'sender@fixture.test', 'test-user')
           RETURNING id`,
          [workspaceId, segmentId],
        );
        const campaignId = campaignRows[0].id;

        const { rows: flowRows } = await client.query<{ id: string }>(
          `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_event_name, trigger_segment_id, created_by_user_id)
           VALUES ($1, 'Fixture flow', 'live', 'event', 'fixture_event', $2, 'test-user') RETURNING id`,
          [workspaceId, segmentId],
        );
        const flowId = flowRows[0].id;

        const definition = {
          nodes: [
            { id: "trigger-1", type: "trigger", triggerType: "event", eventName: "fixture_event", position: { x: 0, y: 0 } },
            {
              id: "send-1",
              type: "send",
              templateId: "d-fixture-template",
              fromEmail: "sender@fixture.test",
              position: { x: 0, y: 100 },
            },
          ],
          edges: [{ id: "e1", source: "trigger-1", target: "send-1" }],
        };

        const { rows: versionRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
           VALUES ($1, $2, 1, $3, now()) RETURNING id`,
          [workspaceId, flowId, definition],
        );
        const flowVersionId = versionRows[0].id;

        await client.query(`UPDATE flows SET live_version_id = $2 WHERE id = $1`, [flowId, flowVersionId]);

        const { rows: runRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_runs (workspace_id, flow_id, flow_version_id, contact_id, status, current_node_id)
           VALUES ($1, $2, $3, $4, 'advancing', 'send-1') RETURNING id`,
          [workspaceId, flowId, flowVersionId, contactId],
        );
        const flowRunId = runRows[0].id;

        const { rows: sendRows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, campaign_id, contact_id, kind, status, flow_run_id, node_id)
           VALUES ($1, $2, $3, 'flow', 'sent', $4, 'send-1') RETURNING id`,
          [workspaceId, campaignId, contactId, flowRunId],
        );
        const sendId = sendRows[0].id;

        await client.query(
          `INSERT INTO flow_run_steps (workspace_id, flow_run_id, node_id, node_type, outcome, send_id)
           VALUES ($1, $2, 'send-1', 'send', 'sent', $3)`,
          [workspaceId, flowRunId, sendId],
        );

        await client.query(`INSERT INTO campaign_recipients (campaign_id, workspace_id, contact_id) VALUES ($1, $2, $3)`, [
          campaignId,
          workspaceId,
          contactId,
        ]);

        await client.query(
          `INSERT INTO subscription_status_history (workspace_id, contact_id, old_status, new_status, source)
           VALUES ($1, $2, 'subscribed', 'unsubscribed', 'manual_ui')`,
          [workspaceId, contactId],
        );

        await client.query(
          `INSERT INTO flow_segment_membership_snapshot (workspace_id, flow_id, contact_id) VALUES ($1, $2, $3)`,
          [workspaceId, flowId, contactId],
        );

        await client.query(`INSERT INTO flow_segment_sweep_checkpoint (workspace_id, flow_id, cursor) VALUES ($1, $2, $3)`, [
          workspaceId,
          flowId,
          contactId,
        ]);

        await client.query(
          `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, 'fixture_event', '{}'::jsonb, now())`,
          [workspaceId, contactId],
        );

        await client.query(
          `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, payload, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'delivered', '{}'::jsonb, now())`,
          [workspaceId, `sg-evt-${randomUUID()}`, sendId],
        );

        const { rows: csvImportRows } = await client.query<{ id: string }>(
          `INSERT INTO csv_imports (workspace_id, file_name, created_by_user_id, status)
           VALUES ($1, 'fixture.csv', 'test-user', 'done') RETURNING id`,
          [workspaceId],
        );
        const csvImportId = csvImportRows[0].id;

        await client.query(
          `INSERT INTO csv_import_rows (csv_import_id, workspace_id, row_number, raw, status)
           VALUES ($1, $2, 1, $3, 'created')`,
          [csvImportId, workspaceId, { email }],
        );

        await client.query(
          `INSERT INTO workspace_property_registry (workspace_id, key, observed_type) VALUES ($1, 'fixture_key', 'string')`,
          [workspaceId],
        );

        await client.query(
          `INSERT INTO send_event_quarantine (workspace_id, sg_event_id, event_type, raw_event, reason)
           VALUES ($1, $2, 'delivered', '{}'::jsonb, 'fixture-reason')`,
          [workspaceId, `sg-evt-quarantine-${randomUUID()}`],
        );

        await client.query(`INSERT INTO ingress_journal (workspace_id, raw_batch) VALUES ($1, '[]'::jsonb)`, [workspaceId]);

        await client.query(
          `INSERT INTO workspace_api_keys (id, workspace_id, name, secret_hash, key_mask)
           VALUES ($1, $2, 'Fixture key', 'fixture-hash', 'fixture-mask')`,
          [`fixture-key-${randomUUID()}`, workspaceId],
        );

        await client.query(`INSERT INTO workspace_send_settings (workspace_id) VALUES ($1)`, [workspaceId]);

        await client.query(`INSERT INTO reputation_alert_state (workspace_id, metric) VALUES ($1, 'bounce_rate')`, [
          workspaceId,
        ]);

        return { contactId };
      }),
    );
  }

  async function seedFixtureSuppressionKey(workspaceId: string): Promise<void> {
    const encrypted = await encryptTenantSecret(workspaceId, "fixture-suppression-hmac-key-0000000000000000");
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO workspace_suppression_keys (workspace_id, encrypted_dek, ciphertext, iv, auth_tag)
           VALUES ($1, $2, $3, $4, $5)`,
          [workspaceId, encrypted.encryptedDek, encrypted.ciphertext, encrypted.iv, encrypted.authTag],
        ),
      ),
    );
  }

  async function seedFixtureWebhookEndpoint(workspaceId: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO workspace_webhook_endpoints (workspace_id, path_token, provision_status)
           VALUES ($1, $2, 'provisioned')`,
          [workspaceId, `fixture-token-${randomUUID()}`],
        ),
      ),
    );
  }

  interface FixtureSuppressionRow {
    emailHash: string;
    suppressedAt: Date;
  }

  async function seedFixtureSuppression(workspaceId: string): Promise<FixtureSuppressionRow> {
    const emailHash = `fixture-hash-${randomUUID()}`;
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<FixtureSuppressionRow>(
          `INSERT INTO workspace_suppressions (workspace_id, email_hash, reason)
           VALUES ($1, $2, 'manual') RETURNING email_hash AS "emailHash", suppressed_at AS "suppressedAt"`,
          [workspaceId, emailHash],
        );
        return rows[0];
      }),
    );
  }

  async function readFixtureSuppression(workspaceId: string, emailHash: string): Promise<FixtureSuppressionRow | null> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<FixtureSuppressionRow>(
          `SELECT email_hash AS "emailHash", suppressed_at AS "suppressedAt"
             FROM workspace_suppressions WHERE workspace_id = $1 AND email_hash = $2`,
          [workspaceId, emailHash],
        );
        return rows[0] ?? null;
      }),
    );
  }

  async function seedFixtureDailyRollup(workspaceId: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(`INSERT INTO workspace_daily_rollup (workspace_id, day, sent_count) VALUES ($1, current_date, 1)`, [
          workspaceId,
        ]),
      ),
    );
  }

  async function seedFixtureErasureRecord(workspaceId: string, contactId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO erasure_records (workspace_id, contact_id, anonymized_at, status)
           VALUES ($1, $2, now(), 'pending') RETURNING id`,
          [workspaceId, contactId],
        );
        return rows[0].id;
      }),
    );
  }

  // -------------------------------------------------------------------
  // Task 1
  // -------------------------------------------------------------------

  it("order satisfies the restrict edges", () => {
    const idx = (t: PurgeTable) => PURGE_TABLE_ORDER.indexOf(t);
    expect(idx("sends")).toBeLessThan(idx("flow_runs"));
    expect(idx("flow_runs")).toBeLessThan(idx("flow_versions"));
    expect(idx("flow_versions")).toBeLessThan(idx("flows"));
    expect(idx("flows")).toBeLessThan(idx("segments"));
    expect(idx("campaigns")).toBeLessThan(idx("segments"));

    const referencesContacts: PurgeTable[] = [
      "subscription_status_history",
      "flow_runs",
      "campaign_recipients",
      "flow_segment_membership_snapshot",
      "sends",
      "events",
    ];
    for (const table of referencesContacts) {
      expect(idx("contacts")).toBeGreaterThan(idx(table));
    }
  });

  it("evidence tables are excluded", () => {
    expect(PURGE_EVIDENCE_TABLES.length).toBe(3);
    expect(PURGE_EVIDENCE_TABLES).toEqual(
      expect.arrayContaining(["erasure_records", "workspace_suppressions", "workspace_daily_rollup"]),
    );
    for (const table of PURGE_TABLE_ORDER) {
      expect(PURGE_EVIDENCE_TABLES as readonly string[]).not.toContain(table);
    }
  });

  it("every spec resolves: countPurgeTableRows executes against a real database for every table in the order", async () => {
    for (const table of PURGE_TABLE_ORDER) {
      const randomWorkspaceId = randomUUID();
      const count = await withTenant(randomWorkspaceId, () =>
        withTenantTransaction((client) => countPurgeTableRows(client, table, randomWorkspaceId)),
      );
      expect(count).toBe(0);
    }
  });

  /**
   * Gap-closure plan 22-12 (PRG-02): an explicit, documented exemption --
   * never a silent loosening of the invariant below -- mirroring this
   * repository's own `RLS_ACCEPT_EXEMPT` precedent
   * (`migrate-from-empty.test.ts`'s allowlist for `reputation_alert_state`).
   * `dead_letter_jobs` is named in `docs/PII-INVENTORY.md`'s Excluded tables
   * (plan 22-12, Task 3) precisely BECAUSE it is platform-scoped and
   * deliberately outside every purge list (migration 0054's own design,
   * reaffirmed by 22-12's recorded decision, option (b)) -- its PII lifetime
   * is bounded by its own `DEAD_LETTER_RETENTION_DAYS` sweep instead
   * (`apps/worker/src/queues/dead-letter-retention.ts`), not by the purge
   * walk this test otherwise reconciles against the inventory.
   */
  const INVENTORY_RECONCILIATION_EXEMPT_TABLES = new Set<string>(["dead_letter_jobs"]);

  it("inventory reconciliation: every table docs/PII-INVENTORY.md names is in the order, the evidence set, or the documented exemption list", () => {
    const inventoryPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../../docs/PII-INVENTORY.md",
    );
    const markdown = readFileSync(inventoryPath, "utf8");

    const names = new Set<string>();
    for (const line of markdown.split("\n")) {
      if (!line.trim().startsWith("|")) continue;
      const cells = line.split("|");
      const firstCell = cells[1] ?? "";
      const matches = firstCell.match(/`([a-z][a-z0-9_]*)`/g) ?? [];
      for (const m of matches) {
        names.add(m.slice(1, -1));
      }
    }

    // An empty extraction must fail rather than pass vacuously -- this is
    // the machine half of the same-change rule the doc itself describes.
    expect(names.size).toBeGreaterThan(0);

    const orderSet = new Set<string>(PURGE_TABLE_ORDER);
    const evidenceSet = new Set<string>(PURGE_EVIDENCE_TABLES);
    for (const name of names) {
      expect(orderSet.has(name) || evidenceSet.has(name) || INVENTORY_RECONCILIATION_EXEMPT_TABLES.has(name)).toBe(
        true,
      );
    }
  });

  it(
    "full-tenant purge empties everything: every table in the order reaches zero, every evidence table survives",
    async () => {
      const workspaceId = await freshWorkspaceId("purge-full-tenant");
      await softDeleteWorkspace(workspaceId, 40);

      const { contactId } = await seedFullTenantFixture(workspaceId);
      await connectFixtureSendgridKey(workspaceId);
      await seedFixtureSuppressionKey(workspaceId);
      await seedFixtureWebhookEndpoint(workspaceId);
      await seedFixtureErasureRecord(workspaceId, contactId);
      await seedFixtureSuppression(workspaceId);
      await seedFixtureDailyRollup(workspaceId);

      await processWorkspacePurge(); // report
      await processWorkspacePurge(); // destroy

      for (const table of PURGE_TABLE_ORDER) {
        expect(await countTable(workspaceId, table)).toBe(0);
      }
      for (const table of PURGE_EVIDENCE_TABLES) {
        expect(await countEvidenceTable(workspaceId, table)).toBeGreaterThan(0);
      }

      const record = await readPurgeRecord(workspaceId);
      expect(record!.status).toBe("complete");
    },
    60_000,
  );

  it("empty tables are normal: a workspace with rows in only three tables purges cleanly", async () => {
    const workspaceId = await freshWorkspaceId("purge-mostly-empty");
    await softDeleteWorkspace(workspaceId, 40);
    const [contactId] = await seedContacts(workspaceId, 1);
    await seedSubscriptionStatusHistory(workspaceId, contactId, 1);
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Fixture segment', $2, 'test-user')`,
          [workspaceId, { operator: "and", conditions: [] }],
        ),
      ),
    );

    await processWorkspacePurge(); // report
    await processWorkspacePurge(); // destroy

    const record = await readPurgeRecord(workspaceId);
    expect(record!.status).toBe("complete");
    expect(record!.tableCounts.campaigns).toBe(0);
    expect(record!.tableCounts.flow_runs).toBe(0);
    // Phase 22 (PRG-02, D-12, plan 22-07): completed_tables now also carries
    // the synthetic "auth" marker once the auth step (member/invitation
    // deletion through the dedicated mega_crm_auth pool) completes -- see
    // workspace-purge.worker.ts's own AUTH_STEP_MARKER doc comment.
    expect([...record!.completedTables].sort()).toEqual([...PURGE_TABLE_ORDER, "auth"].sort());
    expect(await countTable(workspaceId, "contacts")).toBe(0);
    expect(await countTable(workspaceId, "segments")).toBe(0);
  });

  // -------------------------------------------------------------------
  // Task 2
  // -------------------------------------------------------------------

  it("PURGE_SECRET_TABLES names exactly three secret tables", () => {
    expect(PURGE_SECRET_TABLES.length).toBe(3);
    expect(PURGE_SECRET_TABLES).toEqual(
      expect.arrayContaining(["workspace_sendgrid_keys", "workspace_suppression_keys", "workspace_webhook_endpoints"]),
    );
  });

  it("secrets are gone: each secret table holds zero rows for the workspace after a full purge", async () => {
    const workspaceId = await freshWorkspaceId("purge-secrets-gone");
    await softDeleteWorkspace(workspaceId, 40);
    const [contactId] = await seedContacts(workspaceId, 1);
    void contactId;
    await connectFixtureSendgridKey(workspaceId);
    await seedFixtureSuppressionKey(workspaceId);
    await seedFixtureWebhookEndpoint(workspaceId);

    await processWorkspacePurge(); // report
    await processWorkspacePurge(); // destroy

    for (const table of PURGE_SECRET_TABLES) {
      expect(await countTable(workspaceId, table)).toBe(0);
    }
  });

  it("cryptographic erasure of suppression matching: hashed rows survive, the HMAC key is gone", async () => {
    const workspaceId = await freshWorkspaceId("purge-suppression-erasure");
    await softDeleteWorkspace(workspaceId, 40);
    const [contactId] = await seedContacts(workspaceId, 1);
    void contactId;
    await seedFixtureSuppressionKey(workspaceId);
    const before = await seedFixtureSuppression(workspaceId);

    await processWorkspacePurge(); // report
    await processWorkspacePurge(); // destroy

    const after = await readFixtureSuppression(workspaceId, before.emailHash);
    expect(after).not.toBeNull();
    expect(after!.emailHash).toBe(before.emailHash);
    expect(after!.suppressedAt).toEqual(before.suppressedAt);

    expect(await countTable(workspaceId, "workspace_suppression_keys")).toBe(0);
  });

  it("all four evidence sets survive: erasure_records, workspace_suppressions, workspace_daily_rollup and purge_records itself", async () => {
    const workspaceId = await freshWorkspaceId("purge-evidence-survives");
    await softDeleteWorkspace(workspaceId, 40);
    const [contactId] = await seedContacts(workspaceId, 1);
    await seedFixtureErasureRecord(workspaceId, contactId);
    await seedFixtureSuppression(workspaceId);
    await seedFixtureDailyRollup(workspaceId);

    await processWorkspacePurge(); // report
    await processWorkspacePurge(); // destroy

    expect(await countEvidenceTable(workspaceId, "erasure_records")).toBeGreaterThan(0);
    expect(await countEvidenceTable(workspaceId, "workspace_suppressions")).toBeGreaterThan(0);
    expect(await countEvidenceTable(workspaceId, "workspace_daily_rollup")).toBeGreaterThan(0);

    const record = await readPurgeRecord(workspaceId);
    expect(record!.status).toBe("complete");
    expect(Object.keys(record!.tableCounts).length).toBeGreaterThan(0);
  });

  it("idempotent re-run: table_counts and completed_tables are byte-identical after two further ticks", async () => {
    const workspaceId = await freshWorkspaceId("purge-idempotent-full");
    await softDeleteWorkspace(workspaceId, 40);
    const [contactId] = await seedContacts(workspaceId, 2);
    await seedSubscriptionStatusHistory(workspaceId, contactId, 2);

    await processWorkspacePurge(); // report
    await processWorkspacePurge(); // destroy

    const firstRecord = await readPurgeRecord(workspaceId);
    expect(firstRecord!.status).toBe("complete");

    await processWorkspacePurge();
    await processWorkspacePurge();

    const secondRecord = await readPurgeRecord(workspaceId);
    expect(secondRecord).toEqual(firstRecord);
  });

  it("uuid equality, not name equality: a workspace sharing the tombstone's literal name is never matched by it", async () => {
    const workspaceA = await freshWorkspaceId("purge-uuid-eq-a");
    await softDeleteWorkspace(workspaceA, 40);
    const [contactIdA] = await seedContacts(workspaceA, 1);
    await seedSubscriptionStatusHistory(workspaceA, contactIdA, 1);

    await processWorkspacePurge(); // report
    await processWorkspacePurge(); // destroy + tombstone

    const orgA = await readOrganization(workspaceA);
    expect(orgA.name).toBe("purged-workspace");

    // Workspace B is never soft-deleted, and is deliberately given the exact
    // literal name a second tombstoned org would carry -- proving no purge
    // code path anywhere matches on organization.name/slug instead of id.
    const workspaceB = await freshWorkspaceId("purge-uuid-eq-b");
    await pool.query(`UPDATE organization SET name = 'purged-workspace' WHERE id = $1`, [workspaceB]);
    const [contactIdB] = await seedContacts(workspaceB, 1);
    await seedSubscriptionStatusHistory(workspaceB, contactIdB, 1);

    await processWorkspacePurge(); // A replays as a no-op; B is never eligible (never soft-deleted)

    expect(await countTable(workspaceA, "contacts")).toBe(0);
    expect(await countTable(workspaceB, "contacts")).toBe(1);
    expect(await readPurgeRecord(workspaceB)).toBeNull();
  });
});
