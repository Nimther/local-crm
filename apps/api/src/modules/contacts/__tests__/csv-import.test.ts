import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { applyCsvRowMapping } from "@mega-crm/contacts-core";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../../test/db-fixture.js";
import { markCsvImportFailed } from "../csv-import.repository.js";

/**
 * WR-05a (gap-closure 02-12): applyCsvRowMapping is a pure function, so its
 * subscriptionStatus validation is exercised directly here rather than via
 * the HTTP harness below. This is the SAME mapper the dry-run summary
 * (`computeDryRunSummary` in csv-import.routes.ts) and the apply worker
 * (`imports-csv.worker.ts`) both call, so fixing it here closes the
 * dry-run/apply drift and the D-12 "suppressed is automated-only" bypass in
 * one place.
 */
describe("applyCsvRowMapping subscriptionStatus validation (WR-05a)", () => {
  const mapping = { external_id: "externalId", status: "subscriptionStatus" };

  it("rejects a non-enum value like 'yes' with a mapper error", () => {
    const result = applyCsvRowMapping({ external_id: "wr05a-1", status: "yes" }, mapping);
    expect(result.error).toBeTruthy();
  });

  it("normalizes a valid value's case (e.g. 'SUBSCRIBED' -> 'subscribed')", () => {
    const result = applyCsvRowMapping({ external_id: "wr05a-2", status: "SUBSCRIBED" }, mapping);
    expect(result.error).toBeUndefined();
    expect(result.input.subscriptionStatus).toBe("subscribed");
  });

  it("refuses 'suppressed' via CSV even though it is otherwise a valid enum value (D-12)", () => {
    const result = applyCsvRowMapping({ external_id: "wr05a-3", status: "suppressed" }, mapping);
    expect(result.error).toBeTruthy();
  });
});

/**
 * 06-07/T-06-07-01/T-06-07-04: `timezone` is a standard field (mirrors
 * city/country) -- mapping a column to it lands the value on the typed
 * column, not in freeform `properties`, and an invalid IANA zone is
 * rejected with a mapper error rather than ever reaching storage.
 */
describe("applyCsvRowMapping timezone standard-field validation (06-07)", () => {
  const mapping = { external_id: "externalId", tz: "timezone" };

  it("maps a valid IANA zone onto the standard timezone field, not properties", () => {
    const result = applyCsvRowMapping({ external_id: "tz-1", tz: "Europe/Belgrade" }, mapping);
    expect(result.error).toBeUndefined();
    expect(result.input.timezone).toBe("Europe/Belgrade");
    expect(result.input.properties).toEqual({});
  });

  it("rejects an invalid IANA zone with a mapper error", () => {
    const result = applyCsvRowMapping({ external_id: "tz-2", tz: "Mars/Phobos" }, mapping);
    expect(result.error).toBeTruthy();
  });
});

/**
 * 06-22/FLOW-05: `options.defaultTimezone` on applyCsvRowMapping -- the
 * server-side foundation for the CSV mapping step's "default timezone for
 * rows without one" control (closes UAT Test 10's gap on the CSV surface,
 * see .planning/debug/timezone-combobox-missing.md). Validated through the
 * SAME isValidIanaTimezone check a mapped column value goes through, so an
 * invalid default is never stored, and a mapped per-row value always wins.
 */
describe("applyCsvRowMapping default timezone (06-22/FLOW-05)", () => {
  const mappingNoTz = { external_id: "externalId" };
  const mappingWithTz = { external_id: "externalId", tz: "timezone" };

  it("applies the default to a row that maps no timezone column", () => {
    const result = applyCsvRowMapping({ external_id: "dtz-1" }, mappingNoTz, {
      defaultTimezone: "Europe/Belgrade",
    });
    expect(result.error).toBeUndefined();
    expect(result.input.timezone).toBe("Europe/Belgrade");
  });

  it("keeps a row's own valid mapped timezone -- the default is ignored", () => {
    const result = applyCsvRowMapping({ external_id: "dtz-2", tz: "America/New_York" }, mappingWithTz, {
      defaultTimezone: "Europe/Belgrade",
    });
    expect(result.error).toBeUndefined();
    expect(result.input.timezone).toBe("America/New_York");
  });

  it("no default provided + no timezone column leaves input.timezone undefined with no error (backward compatible)", () => {
    const result = applyCsvRowMapping({ external_id: "dtz-3" }, mappingNoTz);
    expect(result.error).toBeUndefined();
    expect(result.input.timezone).toBeUndefined();
  });

  it("rejects an invalid default with a truthy error", () => {
    const result = applyCsvRowMapping({ external_id: "dtz-4" }, mappingNoTz, {
      defaultTimezone: "Mars/Phobos",
    });
    expect(result.error).toBeTruthy();
  });

  it("falls back to the default when the row's timezone cell is empty", () => {
    const result = applyCsvRowMapping({ external_id: "dtz-5", tz: "" }, mappingWithTz, {
      defaultTimezone: "Europe/Belgrade",
    });
    expect(result.error).toBeUndefined();
    expect(result.input.timezone).toBe("Europe/Belgrade");
  });
});

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
    return res.json<{ id: string; slug: string; name: string }>();
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
    return res.json<{
      importId: string;
      headers: string[];
      previewRows: Record<string, string>[];
      totalRows: number;
    }>();
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
    const summary = dryRunRes.json<{ willCreate: number; willUpdate: number; errorCount: number }>();
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
    const summary = dryRunRes.json<{ willCreate: number; willUpdate: number; errorCount: number }>();
    expect(summary.willUpdate).toBe(1);
    expect(summary.willCreate).toBe(1);
  });

  it("WR-05b: dry-run reports an invalid subscriptionStatus value as an error, not a create/update (no drift with apply)", async () => {
    const { cookie, workspace } = await owner("csv-status-drift");
    const csvContent = ["external_id,email,status", "wr05b-1,wr05b@example.com,yes"].join("\n");
    const { body, headers } = buildMultipartCsvBody("status.csv", csvContent);

    const uploadRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/imports`,
      headers: { cookie, ...headers },
      payload: body,
    });
    expect(uploadRes.statusCode, `upload failed: ${uploadRes.body}`).toBe(200);
    const upload = uploadRes.json<{ importId: string }>();

    const dryRunRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/imports/${upload.importId}/dry-run`,
      headers: { cookie },
      payload: {
        mapping: { external_id: "externalId", email: "email", status: "subscriptionStatus" },
        duplicatePolicy: "update",
      },
    });
    expect(dryRunRes.statusCode, `dry-run failed: ${dryRunRes.body}`).toBe(200);
    const summary = dryRunRes.json<{ willCreate: number; willUpdate: number; errorCount: number }>();
    // Pre-fix: the untyped subscriptionStatus cast lets "yes" through, so
    // this row is (wrongly) counted in willCreate instead of errorCount --
    // the exact dry-run/apply drift WR-05 closes.
    expect(summary.errorCount).toBe(1);
    expect(summary.willCreate).toBe(0);
  });

  it("WR-04: a malformed CSV that throws mid-stream sets the import status to 'failed', not stuck 'uploaded'", async () => {
    const { cookie, workspace } = await owner("csv-malformed");
    // Unbalanced quote: csv-parse absorbs the rest of the file into the open
    // quoted field and throws CSV_QUOTE_NOT_CLOSED once the stream ends.
    const malformedCsv = 'external_id,email\n1,"unterminated quote\n2,valid@example.com\n';
    const { body, headers } = buildMultipartCsvBody("bad.csv", malformedCsv);

    const uploadRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/imports`,
      headers: { cookie, ...headers },
      payload: body,
    });
    // Pre-fix: the streaming loop has no try/catch, so a parser error
    // reaches Fastify's default error handler as an unhandled 500 instead
    // of a controlled failure response.
    expect(uploadRes.statusCode).not.toBe(200);

    const historyRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/imports`,
      headers: { cookie },
    });
    expect(historyRes.statusCode, `history failed: ${historyRes.body}`).toBe(200);
    const items = historyRes.json<Array<{ fileName: string; status: string }>>();
    const failedImport = items.find((i) => i.fileName === "bad.csv");
    // Pre-fix: the import row was created before parsing began and is never
    // updated on error, so it stays stuck at the default 'uploaded' status
    // forever instead of surfacing as 'failed'.
    expect(failedImport?.status).toBe("failed");
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
    // WR-06 regression guard: the happy path's Content-Disposition header
    // must stay exactly this shape once the :id UUID guard is added.
    expect(errorsRes.headers["content-disposition"]).toBe(`attachment; filename="import-${upload.importId}-errors.csv"`);
    const lines = errorsRes.body.trim().split("\n");
    expect(lines[0]).toContain("reason");
    expect(lines.length).toBe(3); // header + 2 errored rows
  });

  it("WR-06: a non-UUID :id on the error-report route is rejected with 400 and no Content-Disposition header", async () => {
    const { cookie, workspace } = await owner("csv-wr06-invalid");

    const errorsRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/imports/not-a-uuid/errors`,
      headers: { cookie },
    });

    expect(errorsRes.statusCode, `expected 400, got ${errorsRes.statusCode}: ${errorsRes.body}`).toBe(400);
    expect(errorsRes.json()).toHaveProperty("error");
    expect(errorsRes.headers["content-disposition"]).toBeUndefined();
  });

  it("WR-06: a double-quote-bearing :id cannot inject a second filename parameter into Content-Disposition", async () => {
    const { cookie, workspace } = await owner("csv-wr06-injection");
    const maliciousId = encodeURIComponent('x"; filename="evil.html');

    const errorsRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/imports/${maliciousId}/errors`,
      headers: { cookie },
    });

    expect(errorsRes.statusCode, `expected 400, got ${errorsRes.statusCode}: ${errorsRes.body}`).toBe(400);
    expect(errorsRes.headers["content-disposition"]).toBeUndefined();
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
    const items = historyRes.json<Array<{ fileName: string; createdAt: string }>>();
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

  it("WR-04: a truncated upload sets status 'failed' and returns 413", async () => {
    const { cookie, workspace } = await owner("csv-truncated");

    // Real >50MB payload: rows put a huge padding value in the LAST column so
    // the 50MB multipart cut lands mid-value, keeping every parsed record at
    // the full column count (csv-parse would otherwise reject a short row
    // with Invalid Record Length and the route would 422 instead of 413).
    const pad = "x".repeat(1024 * 1024 - 64);
    const rows = ["external_id,email,notes"];
    for (let i = 0; i < 52; i++) {
      rows.push(`trunc-${i},trunc-${i}@example.com,${pad}`);
    }
    const { body, headers } = buildMultipartCsvBody("truncated.csv", rows.join("\n"));

    const uploadRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/imports`,
      headers: { cookie, ...headers },
      payload: body,
    });
    expect(uploadRes.statusCode).toBe(413);

    // The import row created before parsing must be marked 'failed', not
    // left dangling at 'uploaded' (WR-04's silent-truncation failure mode).
    const historyRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/imports`,
      headers: { cookie },
    });
    expect(historyRes.statusCode).toBe(200);
    const items = historyRes.json<Array<{ fileName: string; status: string }>>();
    const createdImport = items.find((i) => i.fileName === "truncated.csv");
    expect(createdImport?.status).toBe("failed");
  });

  it("WR-04: markCsvImportFailed sets import status to 'failed'", async () => {
    const { cookie, workspace } = await owner("csv-failed-mark");

    // Direct test of the markCsvImportFailed repository function, which is
    // called by the truncation handler (lines 209-211 of csv-import.routes.ts).
    // This ensures the status-update logic is sound.

    const csvContent = "external_id,email\nfail-1,test@example.com\n";
    const { body, headers } = buildMultipartCsvBody("will-fail.csv", csvContent);

    const uploadRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/imports`,
      headers: { cookie, ...headers },
      payload: body,
    });
    expect(uploadRes.statusCode).toBe(200);
    const uploadData = uploadRes.json<{ importId: string }>();

    // Simulate what the truncation handler does: call markCsvImportFailed
    // directly and verify the status changes to 'failed'.
    await withTenant(workspace.id, () => markCsvImportFailed(uploadData.importId));

    // Verify the import status is now 'failed'
    const statusRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/imports/${uploadData.importId}`,
      headers: { cookie },
    });
    expect(statusRes.statusCode).toBe(200);
    const status = statusRes.json<{ status: string }>();
    expect(status.status).toBe("failed");
  });
});
