import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { SegmentDefinition } from "@mega-crm/segments-core";
import { materializeBatch, SNAPSHOT_BATCH_SIZE, SNAPSHOT_STATEMENT_TIMEOUT_MS } from "../recipient-snapshot.js";

/**
 * recipient-snapshot.ts's `materializeBatch` (D-02, RESEARCH.md Pattern 1):
 * proves keyset (not OFFSET) pagination and cursor persistence/resume
 * across batches against a stubbed `PoolClient` -- no live Postgres needed
 * for this unit-level contract (the plan's own `<verify>` step greps the
 * compiled SQL text for `compileSegmentDefinition` usage and an absent
 * `OFFSET`, this test proves the RUNTIME behavior those static checks can't:
 * that repeated calls actually advance the cursor and never re-fetch
 * already-materialized contacts).
 */
describe("recipient-snapshot.ts materializeBatch (D-02, Pitfall 3)", () => {
  const workspaceId = "11111111-1111-1111-1111-111111111111";
  const campaignId = "22222222-2222-2222-2222-222222222222";
  const definition: SegmentDefinition = {
    version: 1,
    groups: [
      {
        conditions: [{ type: "attribute", source: "standard", field: "country", operator: "is_not_empty" }],
      },
    ],
  };

  /**
   * A stubbed `PoolClient` whose `.query` is scripted to return, in order:
   * (1) a full page of `SNAPSHOT_BATCH_SIZE`-shaped INSERT...RETURNING rows,
   * (2) a smaller final page, (3) zero rows -- mirroring
   * `imports-csv.worker.ts`'s existing "two pages then empty" cursor-loop
   * test shape, adapted to this batch's INSERT...SELECT...RETURNING call.
   */
  function stubClient(pages: string[][]): { client: PoolClient; calls: { sql: string; params: unknown[] }[] } {
    const calls: { sql: string; params: unknown[] }[] = [];
    let pageIndex = 0;
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        // set_config(statement_timeout, ...) and the UPDATE campaigns SET
        // snapshot_cursor... calls don't return rows relevant to pagination.
        if (sql.includes("set_config")) return { rows: [] };
        if (sql.includes("UPDATE campaigns")) return { rows: [] };
        // The INSERT...SELECT...RETURNING call -- serve the next scripted page.
        const page = pages[pageIndex] ?? [];
        pageIndex += 1;
        return { rows: page.map((id) => ({ id })) };
      }),
    } as unknown as PoolClient;
    return { client, calls };
  }

  it("uses keyset (c.id > $cursor ORDER BY c.id ASC LIMIT), never OFFSET", async () => {
    const { client, calls } = stubClient([["contact-1", "contact-2"], []]);

    await materializeBatch(client, campaignId, workspaceId, definition, null);

    const insertCall = calls.find((c) => c.sql.includes("INSERT INTO campaign_recipients"));
    expect(insertCall).toBeDefined();
    expect(insertCall!.sql).not.toMatch(/OFFSET/i);
    expect(insertCall!.sql).toMatch(/ORDER BY c\.id ASC/);
    expect(insertCall!.sql).toMatch(/LIMIT \$\d+/);
    // First call (no prior cursor) must NOT filter on c.id at all.
    expect(insertCall!.sql).not.toMatch(/c\.id\s*>/);
  });

  it("persists campaigns.snapshot_cursor after each batch and resumes from it without re-fetching prior rows", async () => {
    const page1 = ["contact-1", "contact-2"];
    const page2 = ["contact-3"];
    const { client, calls } = stubClient([page1, page2, []]);

    // Batch 1: no prior cursor.
    const batch1 = await materializeBatch(client, campaignId, workspaceId, definition, null);
    expect(batch1.inserted).toBe(2);
    expect(batch1.lastContactId).toBe("contact-2");

    const firstCursorUpdate = calls.find((c) => c.sql.includes("UPDATE campaigns"));
    expect(firstCursorUpdate).toBeDefined();
    expect(firstCursorUpdate!.params).toEqual([campaignId, "contact-2"]);

    // Batch 2: resumes from the persisted cursor -- the SELECT must filter
    // on c.id > $cursor this time (keyset resume, not a re-scan from the top).
    const batch2 = await materializeBatch(client, campaignId, workspaceId, definition, batch1.lastContactId);
    expect(batch2.inserted).toBe(1);
    expect(batch2.lastContactId).toBe("contact-3");

    const resumedInsertCall = calls
      .filter((c) => c.sql.includes("INSERT INTO campaign_recipients"))
      .at(-1);
    expect(resumedInsertCall!.sql).toMatch(/AND c\.id > \$\d+/);
    expect(resumedInsertCall!.params).toContain("contact-2");

    // Batch 3: an empty page signals materialization is complete.
    const batch3 = await materializeBatch(client, campaignId, workspaceId, definition, batch2.lastContactId);
    expect(batch3.inserted).toBe(0);
    expect(batch3.lastContactId).toBe("contact-3"); // cursor holds steady, no regression
  });

  it("scopes the batch's statement_timeout to SNAPSHOT_STATEMENT_TIMEOUT_MS (60s, RESEARCH.md Pattern 1)", async () => {
    const { client, calls } = stubClient([[]]);

    await materializeBatch(client, campaignId, workspaceId, definition, null);

    const timeoutCall = calls.find((c) => c.sql.includes("set_config"));
    expect(timeoutCall).toBeDefined();
    expect(timeoutCall!.params).toEqual([String(SNAPSHOT_STATEMENT_TIMEOUT_MS)]);
  });

  it("limits each batch to SNAPSHOT_BATCH_SIZE rows", async () => {
    const { client, calls } = stubClient([[]]);

    await materializeBatch(client, campaignId, workspaceId, definition, null);

    const insertCall = calls.find((c) => c.sql.includes("INSERT INTO campaign_recipients"));
    expect(insertCall!.params).toContain(SNAPSHOT_BATCH_SIZE);
  });
});
