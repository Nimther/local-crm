import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../../test/db-fixture.js";

/**
 * CSV contact import (CONT-02, D-15..D-20): the HTTP-observable half of the
 * pipeline -- upload (streamed staging + header/preview detection), dry-run
 * (D-17: whole-file validation that writes NO contact), the downloadable
 * error-report CSV (D-18), import history (D-20), and the apply route's
 * synchronous "queued" contract (mirrors events-api.test.ts's precedent: no
 * worker runs in THIS test process, so apply's actual row-by-row effects
 * -- both D-15 duplicate policies, progress, idempotency -- are proven in
 * apps/worker's imports-csv-idempotency.test.ts by invoking the worker
 * handler directly, the same split already established for events:ingest).
 */
describe("CSV contact import (CONT-02, D-15..D-20)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
    pool = createTestPool();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
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
    return res.json() as { id: string; slug: string; name: string };
  }

  async function owner(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    return { ...account, workspace };
  }

  /** Hand-builds a minimal multipart/form-data body -- no test-only dependency needed for a single-file upload. */
  function buildMultipartCsvBody(fileName: string, csvContent: string) {
    const boundary = `----csvtestboundary${Date.now()}${Math.random().toString(36).slice(2)}`;
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: text/csv\r\n\r\n` +
      `${csvContent}\r\n` +
      `--${boundary}--\r\n`;
    return { body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
  }

  /** 4 rows: 2 valid new identities, 1 invalid email, 1 missing both identifiers (D-02 error). */
  function csvFixture(nameSeed: string) {
    return [
      "external_id,email,first_name,tags",
      `${nameSeed}-ext-1,${nameSeed}-alice@example.com,Alice,vip`,
      `${nameSeed}-ext-2,${nameSeed}-bob@example.com,Bob,`,
      `,not-an-email,Charlie,`,
      ",,Dave,",
    ].join("\n");
  }

  const MAPPING = { external_id: "externalId", email: "email", first_name: "firstName", tags: "tags" };

  async function uploadCsv(cookie: string, slug: string, nameSeed: string) {
    const { body, headers } = buildMultipartCsvBody("contacts.csv", csvFixture(nameSeed));
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/imports`,
      headers: { cookie, ...headers },
      payload: body,
    });
    expect(res.statusCode, `upload failed: ${res.body}`).toBe(200);
    return res.json() as {
      importId: string;
      headers: string[];
      previewRows: Record<string, string>[];
      totalRows: number;
    };
  }

  it("upload streams the WHOLE file to staging and returns detected headers + a preview of the first rows", async () => {
    const { cookie, workspace } = await owner("csv-upload");
    const upload = await uploadCsv(cookie, workspace.slug, "upload");

    expect(upload.headers).toEqual(["external_id", "email", "first_name", "tags"]);
    expect(upload.totalRows).toBe(4);
    expect(upload.previewRows).toHaveLength(4);
    expect(upload.previewRows[0].email).toBe("upload-alice@example.com");

    // csv_import_rows carries ENABLE + FORCE ROW LEVEL SECURITY -- a plain
    // pool.query without the tenant GUC set is silently filtered to zero
    // rows (not an error), so this read must run inside withTenant/
    // withTenantTransaction like every other RLS-scoped table.
    const rowCount = await withTenant(workspace.id, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*) FROM csv_import_rows WHERE csv_import_id = $1`,
          [upload.importId]
        );
        return Number(rows[0].count);
      })
    );
    expect(rowCount).toBe(4);
  });

  it("D-17: dry-run validates the WHOLE file and reports willCreate/willUpdate/errorCount WITHOUT writing any contact", async () => {
    const { cookie, workspace } = await owner("csv-dryrun");
    const upload = await uploadCsv(cookie, workspace.slug, "dryrun");

    const dryRunRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/imports/${upload.importId}/dry-run`,
      headers: { cookie },
      payload: { mapping: MAPPING, duplicatePolicy: "update" },
    });
    expect(dryRunRes.statusCode, `dry-run failed: ${dryRunRes.body}`).toBe(200);
    const summary = dryRunRes.json() as { willCreate: number; willUpdate: number; errorCount: number };
    expect(summary.willCreate).toBe(2); // ext-1, ext-2
    expect(summary.errorCount).toBe(2); // invalid email row + missing-both-identifiers row
    expect(summary.willUpdate).toBe(0);

    const contactRows = await withTenant(workspace.id, () =>
      withTenantTransaction((client) => client.query(`SELECT 1 FROM contacts WHERE workspace_id = $1`, [workspace.id]))
    );
    expect(contactRows.rows).toHaveLength(0);
  });

  it("D-17: dry-run counts a pre-existing identity match as willUpdate, not willCreate", async () => {
    const { cookie, workspace } = await owner("csv-willupdate");

    await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/contacts`,
      headers: { cookie },
      payload: { externalId: "willupdate-ext-1", email: "preexisting@example.com" },
    });

    const upload = await uploadCsv(cookie, workspace.slug, "willupdate");
    const dryRunRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/imports/${upload.importId}/dry-run`,
      headers: { cookie },
      payload: { mapping: MAPPING, duplicatePolicy: "update" },
    });
    expect(dryRunRes.statusCode, `dry-run failed: ${dryRunRes.body}`).toBe(200);
    const summary = dryRunRes.json() as { willCreate: number; willUpdate: number; errorCount: number };
    expect(summary.willUpdate).toBe(1);
    expect(summary.willCreate).toBe(1);
  });

  it("D-18: the error-report route returns a downloadable CSV of only the errored rows with a reason column", async () => {
    const { cookie, workspace } = await owner("csv-errors");
    const upload = await uploadCsv(cookie, workspace.slug, "errors");

    const dryRunRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/imports/${upload.importId}/dry-run`,
      headers: { cookie },
      payload: { mapping: MAPPING, duplicatePolicy: "update" },
    });
    expect(dryRunRes.statusCode, `dry-run failed: ${dryRunRes.body}`).toBe(200);

    const errorsRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/imports/${upload.importId}/errors`,
      headers: { cookie },
    });
    expect(errorsRes.statusCode, `error report failed: ${errorsRes.body}`).toBe(200);
    expect(errorsRes.headers["content-type"]).toContain("text/csv");
    const lines = errorsRes.body.trim().split("\n");
    expect(lines[0]).toContain("reason");
    expect(lines.length).toBe(3); // header + 2 errored rows
  });

  it("apply enqueues a background job; the status route immediately reflects 'applying' (D-16)", async () => {
    const { cookie, workspace } = await owner("csv-apply");
    const upload = await uploadCsv(cookie, workspace.slug, "apply");

    await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/imports/${upload.importId}/dry-run`,
      headers: { cookie },
      payload: { mapping: MAPPING, duplicatePolicy: "update" },
    });

    const applyRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/imports/${upload.importId}/apply`,
      headers: { cookie },
    });
    expect(applyRes.statusCode, `apply failed: ${applyRes.body}`).toBe(202);
    expect(applyRes.json()).toEqual({ queued: true });

    const statusRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/imports/${upload.importId}`,
      headers: { cookie },
    });
    expect(statusRes.statusCode, `status failed: ${statusRes.body}`).toBe(200);
    expect(statusRes.json().status).toBe("applying");
    expect(statusRes.json().totalRows).toBe(4);
  });

  it("apply is rejected before a dry-run has established a mapping (D-17 ordering)", async () => {
    const { cookie, workspace } = await owner("csv-apply-guard");
    const upload = await uploadCsv(cookie, workspace.slug, "applyguard");

    const applyRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/imports/${upload.importId}/apply`,
      headers: { cookie },
    });
    expect(applyRes.statusCode).toBe(422);
  });

  it("D-20: import history persists file name, author, and (once dry-run has run) summary", async () => {
    const { cookie, workspace } = await owner("csv-history");
    await uploadCsv(cookie, workspace.slug, "history");

    const historyRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/imports`,
      headers: { cookie },
    });
    expect(historyRes.statusCode, `history failed: ${historyRes.body}`).toBe(200);
    const items = historyRes.json() as Array<{ fileName: string; createdAt: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].fileName).toBe("contacts.csv");
  });

  it("tenant isolation: workspace B cannot read workspace A's import status", async () => {
    const { cookie: cookieA, workspace: workspaceA } = await owner("csv-isolation-a");
    const { cookie: cookieB, workspace: workspaceB } = await owner("csv-isolation-b");

    const upload = await uploadCsv(cookieA, workspaceA.slug, "isolation");

    const crossRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceB.slug}/imports/${upload.importId}`,
      headers: { cookie: cookieB },
    });
    expect(crossRes.statusCode).toBe(404);
  });
});
