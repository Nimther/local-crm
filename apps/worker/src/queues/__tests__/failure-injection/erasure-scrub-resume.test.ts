import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { createTestPool, ensureTestDbMigrated, getTestDatabaseUrl } from "@mega-crm/test-support";
import { insertFixtureOrganization } from "../../../test/failure-fixtures.js";
import {
  ERASURE_SCRUB_PAGE_LIMIT,
  SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST,
  runErasureScrub,
  scrubSendEventsPage,
} from "../../erasure-scrub.worker.js";
import { loadErasureScrubCheckpoint } from "../../erasure-scrub-checkpoint.js";

/**
 * Phase 13 (CMP-04, D-01/D-04, plan 13-13) -- the erasure scrub's checkpointed
 * walk must resume exactly where a kill left it at BOTH interruption
 * boundaries, mirroring `segment-sweep-kill-resume.test.ts`'s shape (the
 * directly analogous Phase 12 scenario) but proving the STRONGER pair this
 * plan's evidence guarantee requires:
 *
 *  - AFTER a page's transaction commits, a kill leaves that page's rows
 *    scrubbed and the checkpoint advanced past them -- proves the checkpoint
 *    is honored on resume (the after-commit case `segment-sweep`'s own test
 *    covers).
 *  - MID-page, BEFORE that page's transaction commits, a kill leaves that
 *    page's rows UNSCRUBBED and the checkpoint NOT advanced -- proves the
 *    checkpoint and the row rewrites share one transaction (D-09), which the
 *    after-commit case alone cannot distinguish from a checkpoint written in
 *    its own separate transaction. Only the PAIR together proves no row is
 *    ever silently skipped: a checkpoint committed separately from its page
 *    would pass the first assertion and fail the second, and the first is
 *    the one a naive test would write.
 *
 * State-based rather than kill-based, same reasoning as
 * `segment-sweep-kill-resume.test.ts`'s own doc comment (mirrors 11-11's
 * `arrangeCrashedBeforeResultWrite` precedent): a real process kill at either
 * boundary leaves IDENTICAL durable Postgres state to what these two
 * scenarios arrange directly, so a real-kill harness here would add process
 * machinery (fork, IPC marker, SIGKILL) without adding a single new
 * assertion.
 *
 * Reproduce with `npm run failure:erasure-scrub-resume` from the repo root.
 */
describe("failure injection: erasure-scrub kill-resume (CMP-04, D-01/D-04, plan 13-13)", () => {
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

  async function createFixtureContact(workspaceId: string, email: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', 'subscribed') RETURNING id`,
          [workspaceId, email]
        );
        return rows[0].id;
      })
    );
  }

  async function createFixtureCampaign(workspaceId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Fixture kill-resume segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }]
        );
        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, created_by_user_id)
           VALUES ($1, 'Fixture kill-resume campaign', 'sent', $2, 'd-fixture-template', 'sender@fixture.test', 'test-user')
           RETURNING id`,
          [workspaceId, segmentRows[0].id]
        );
        return campaignRows[0].id;
      })
    );
  }

  async function createFixtureSend(workspaceId: string, campaignId: string, contactId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, campaign_id, contact_id, kind, status, sent_at)
           VALUES ($1, $2, $3, 'campaign', 'sent', now()) RETURNING id`,
          [workspaceId, campaignId, contactId]
        );
        return rows[0].id;
      })
    );
  }

  let sendEventSeq = 0;

  async function seedManySendEvents(
    workspaceId: string,
    sendId: string,
    email: string,
    count: number
  ): Promise<void> {
    const baseSeq = sendEventSeq;
    sendEventSeq += count;
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, payload, occurred_at)
           SELECT gen_random_uuid(), $1,
                  'sg-event-' || ($4 + gs)::text,
                  $2, 'delivered',
                  jsonb_build_object(
                    'email', $3::text,
                    'event', 'delivered',
                    'sg_event_id', 'sg-event-' || ($4 + gs)::text,
                    'reason', 'informational only, mentions ' || $3::text
                  ),
                  now() - interval '2 hours' + (gs || ' seconds')::interval
           FROM generate_series(1, $5) AS gs`,
          [workspaceId, sendId, email, baseSeq, count]
        )
      )
    );
  }

  async function createFixtureEvent(workspaceId: string, contactId: string, email: string, offsetSeconds: number): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, 'placed_order', $3::jsonb, now() - interval '2 hours' + ($4 || ' seconds')::interval)`,
          [workspaceId, contactId, JSON.stringify({ order_total: 10, contact_email: email }), offsetSeconds]
        )
      )
    );
  }

  async function createFixtureErasureRecord(workspaceId: string, contactId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO erasure_records (workspace_id, contact_id, anonymized_at, status)
           VALUES ($1, $2, now(), 'pending') RETURNING id`,
          [workspaceId, contactId]
        );
        return rows[0].id;
      })
    );
  }

  interface ErasureRecordRow {
    status: string;
    sendsScrubbed: number;
    eventsScrubbed: number;
  }

  async function readErasureRecord(workspaceId: string, erasureRecordId: string): Promise<ErasureRecordRow> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<ErasureRecordRow>(
          `SELECT status, sends_scrubbed as "sendsScrubbed", events_scrubbed as "eventsScrubbed"
           FROM erasure_records WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, erasureRecordId]
        );
        return rows[0];
      })
    );
  }

  async function readSendEventRows(
    workspaceId: string,
    contactId: string
  ): Promise<{ id: string; payload: Record<string, unknown> }[]> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string; payload: Record<string, unknown> }>(
          `SELECT se.id, se.payload FROM send_events se JOIN sends s ON s.id = se.send_id
           WHERE se.workspace_id = $1 AND s.contact_id = $2`,
          [workspaceId, contactId]
        );
        return rows;
      })
    );
  }

  it(
    "after-commit boundary: a page committed before the kill stays scrubbed, checkpoint advanced past it, and resume enrolls only the remainder exactly once",
    async () => {
      const workspaceId = await freshWorkspaceId("erasure-scrub-kill-resume-after-commit");
      const email = "erased-after-commit@example.test";
      const contactId = await createFixtureContact(workspaceId, email);
      const campaignId = await createFixtureCampaign(workspaceId);
      const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

      // At least two pages' worth -- "interrupted after page 1" only means
      // something if a second page remains.
      const total = ERASURE_SCRUB_PAGE_LIMIT + 200;
      await seedManySendEvents(workspaceId, sendId, email, total);
      const erasureRecordId = await createFixtureErasureRecord(workspaceId, contactId);

      // --- simulate a kill strictly AFTER page 1's commit -----------------
      // A real process kill here would leave IDENTICAL durable state: one
      // committed page, one committed checkpoint row, nothing further done.
      const firstPage = await withTenant(workspaceId, () =>
        withTenantTransaction((client) => scrubSendEventsPage(client, workspaceId, contactId, erasureRecordId, null))
      );
      expect(firstPage.processed).toBe(ERASURE_SCRUB_PAGE_LIMIT);
      expect(firstPage.cursor.done).toBe(false);

      const checkpointAfterInterruption = await withTenant(workspaceId, () =>
        withTenantTransaction((client) => loadErasureScrubCheckpoint(client, workspaceId, erasureRecordId, "sends"))
      );
      expect(
        checkpointAfterInterruption,
        "the committed page's cursor must survive the simulated crash -- it was committed in the SAME transaction as the page's UPDATE (D-09)"
      ).toEqual(firstPage.cursor);

      const rowsAfterFirstPage = await readSendEventRows(workspaceId, contactId);
      const scrubbedAfterFirstPage = rowsAfterFirstPage.filter((row) => !("email" in row.payload));
      expect(
        scrubbedAfterFirstPage.length,
        "exactly one page's worth of rows were scrubbed before the interruption"
      ).toBe(ERASURE_SCRUB_PAGE_LIMIT);

      // --- resume: the erasure record is still 'pending' (never reached
      // runErasureScrub before the kill) -- the real recovery path re-reads
      // the checkpoint via runErasureScrub -----------------------------
      await runErasureScrub({ workspaceId, contactId, erasureRecordId });

      const record = await readErasureRecord(workspaceId, erasureRecordId);
      expect(record.status).toBe("complete");
      expect(
        record.sendsScrubbed,
        "resuming from the checkpoint enrolls the remainder exactly once -- total equals the seeded total, not the count from a single pass"
      ).toBe(total);

      const rowsAfterResume = await readSendEventRows(workspaceId, contactId);
      expect(rowsAfterResume).toHaveLength(total);
      for (const row of rowsAfterResume) {
        expect(JSON.stringify(row.payload)).not.toContain(email);
        for (const key of Object.keys(row.payload)) {
          expect(SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST as readonly string[]).toContain(key);
        }
      }
    },
    60_000
  );

  it(
    "mid-page boundary: a kill BEFORE a page's transaction commits leaves that page's rows unscrubbed and the checkpoint unadvanced, so resume re-processes it without skipping or double-reporting",
    async () => {
      const workspaceId = await freshWorkspaceId("erasure-scrub-kill-resume-mid-page");
      const email = "erased-mid-page@example.test";
      const contactId = await createFixtureContact(workspaceId, email);
      const campaignId = await createFixtureCampaign(workspaceId);
      const sendId = await createFixtureSend(workspaceId, campaignId, contactId);

      const sendEventCount = 10;
      await seedManySendEvents(workspaceId, sendId, email, sendEventCount);
      await createFixtureEvent(workspaceId, contactId, email, 0);
      await createFixtureEvent(workspaceId, contactId, email, 1);
      const erasureRecordId = await createFixtureErasureRecord(workspaceId, contactId);

      // --- simulate a kill strictly BEFORE the page's transaction commits -
      // scrubSendEventsPage's row UPDATEs and its checkpoint advance all run
      // on the SAME client this test opens via withTenantTransaction. An
      // error thrown AFTER those queries but before this transaction's own
      // implicit COMMIT forces a ROLLBACK of the WHOLE transaction --
      // exactly what a process kill strictly between the page's last query
      // and the transaction's commit would leave behind. This is the
      // boundary the after-commit scenario cannot distinguish from a
      // checkpoint written in a separate transaction (D-09's own point).
      const simulatedCrash = new Error("simulated crash strictly before this page's transaction commits");
      await expect(
        withTenant(workspaceId, () =>
          withTenantTransaction(async (client) => {
            await scrubSendEventsPage(client, workspaceId, contactId, erasureRecordId, null);
            throw simulatedCrash;
          })
        )
      ).rejects.toThrow(simulatedCrash);

      const rowsAfterCrash = await readSendEventRows(workspaceId, contactId);
      expect(
        rowsAfterCrash.every((row) => "email" in row.payload),
        "a page rolled back before commit must leave every row exactly as it was -- none scrubbed"
      ).toBe(true);

      const checkpointAfterCrash = await withTenant(workspaceId, () =>
        withTenantTransaction((client) => loadErasureScrubCheckpoint(client, workspaceId, erasureRecordId, "sends"))
      );
      expect(
        checkpointAfterCrash,
        "the checkpoint advance rolled back together with the page's UPDATE -- it must NOT be advanced"
      ).toBeNull();

      const recordAfterCrash = await readErasureRecord(workspaceId, erasureRecordId);
      expect(recordAfterCrash.sendsScrubbed, "the rolled-back page's count must not have been committed").toBe(0);
      expect(recordAfterCrash.status).toBe("pending");

      // --- resume: the checkpoint is null, so the walk starts over from
      // the beginning and re-processes the whole (unscrubbed) table -------
      await runErasureScrub({ workspaceId, contactId, erasureRecordId });

      const record = await readErasureRecord(workspaceId, erasureRecordId);
      expect(record.status).toBe("complete");
      expect(
        record.sendsScrubbed,
        "the resumed walk re-processes every row exactly once -- not zero (skipped) and not double the seeded count"
      ).toBe(sendEventCount);
      expect(record.eventsScrubbed).toBe(2);

      const rowsAfterResume = await readSendEventRows(workspaceId, contactId);
      expect(rowsAfterResume).toHaveLength(sendEventCount);
      for (const row of rowsAfterResume) {
        expect(JSON.stringify(row.payload)).not.toContain(email);
      }
    },
    60_000
  );
});
