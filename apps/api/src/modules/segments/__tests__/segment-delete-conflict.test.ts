import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, organization } from "@mega-crm/db";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { withTenant, withTenantTransaction } from "../../../middleware/tenant-context.js";
import { pool } from "../../../db.js";
import { deleteSegment, SegmentConflictError } from "../segment.repository.js";

/**
 * 06-20/WR-01 gap closure: `deleteSegment`'s 23503 catch re-checks
 * `findReferencingFlowName` on the SAME transaction the failed DELETE just
 * aborted. Before the SAVEPOINT fix, that re-check throws a raw Postgres
 * "25P02 current transaction is aborted" error instead of the intended
 * `SegmentConflictError`, so a segment referenced only by a CANCELED
 * campaign (which the app-level pre-check does not screen, by design --
 * canceled campaigns keep their audience reference for history, T-04-01-03)
 * surfaces as an opaque 500 instead of an actionable 409.
 *
 * Repository-level test (no HTTP layer): direct tenant-scoped inserts +
 * the real `deleteSegment`.
 */
describe("deleteSegment canceled-campaign conflict (06-20/WR-01)", () => {
  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool.on("error", () => {
      // Expected: prior chaos-style tests in this suite pool may terminate
      // connections; guard against an unhandled 'error' event crashing the
      // process the way rls-pooling-chaos.test.ts documents.
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("06-20/WR-01: deleting a segment referenced by a canceled campaign throws SegmentConflictError (referenced_by_campaign), not a raw 25P02", async () => {
    const workspaceId = randomUUID();
    await db.insert(organization).values({
      id: workspaceId,
      name: "WR-01 workspace",
      slug: `wr-01-${workspaceId.slice(0, 8)}`,
      createdAt: new Date(),
    });

    const segmentId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'ref-by-canceled', $2, 'test-user') RETURNING id`,
          [workspaceId, { version: 1, groups: [{ conditions: [] }] }]
        );
        const id = rows[0].id;

        await client.query(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, created_by_user_id)
           VALUES ($1, 'Canceled ref', 'canceled', $2, 'test-user')`,
          [workspaceId, id]
        );

        return id;
      })
    );

    let captured: unknown;
    await withTenant(workspaceId, async () => {
      try {
        await deleteSegment(segmentId);
      } catch (err) {
        captured = err;
      }
    });

    expect(captured).toBeInstanceOf(SegmentConflictError);
    expect((captured as SegmentConflictError).code).toBe("referenced_by_campaign");
  });
});
