import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../../test/db-fixture.js";
import { eventsIngestQueue } from "../events-queue.js";
import type { Pool } from "pg";

/**
 * Phase 22 (PRG-06, D-04): a soft-deleted workspace's API keys stop being
 * honoured on EVERY key-authed surface, not only `/v1/events` -- the check
 * lives in `apiKeyAuth` itself (see that hook's own comment), so this suite
 * proves both the events route AND the contacts route are refused by the
 * SAME hook-level check, plus the two negative controls (live workspace,
 * invalid key) that prove the new branch changed nothing about the existing
 * failure paths.
 */
describe("API-key surfaces refuse a soft-deleted workspace (PRG-06, D-04)", () => {
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
    await eventsIngestQueue.obliterate({ force: true }).catch(() => undefined);
    await eventsIngestQueue.close();
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

  async function mintApiKey(cookie: string, slug: string, name: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/api-keys`,
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, `create api key failed: ${res.body}`).toBe(200);
    return (res.json<{ fullKey: string }>()).fullKey;
  }

  /** D-20's real Owner-only soft-delete route -- the exact codepath production uses to set `deletedAt`. */
  async function softDeleteWorkspace(cookie: string, slug: string, name: string): Promise<void> {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${slug}`,
      headers: { cookie },
      payload: { confirmName: name },
    });
    expect(res.statusCode, `soft-delete workspace failed: ${res.body}`).toBe(200);
  }

  async function ownerWithKey(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const name = `${nameSeed} Co`;
    const workspace = await createWorkspace(account.cookie, name);
    const fullKey = await mintApiKey(account.cookie, workspace.slug, "prod backend");
    return { ...account, workspace, name, fullKey };
  }

  it("events ingest refused after soft delete: 403 with a machine-readable code, and nothing enqueued", async () => {
    const { cookie, workspace, name, fullKey } = await ownerWithKey("quiesce-events");
    await softDeleteWorkspace(cookie, workspace.slug, name);

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${fullKey}` },
      payload: { name: "order_placed", externalId: "quiesce-events-cust" },
    });

    expect(res.statusCode, `expected 403, got: ${res.body}`).toBe(403);
    const body = res.json<{ code?: string }>();
    expect(body.code).toBe("workspace_deleted");

    const jobs = await eventsIngestQueue.getJobs(["waiting", "delayed", "active"]);
    const forThisWorkspace = jobs.filter((job) => (job.data as { workspaceId?: string }).workspaceId === workspace.id);
    expect(forThisWorkspace).toHaveLength(0);
  });

  it("contacts API refused too -- the hook-level (not route-level) placement", async () => {
    const email = `quiesce-contacts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", "quiesce-contacts");
    const name = "quiesce-contacts Co";
    const workspace = await createWorkspace(account.cookie, name);
    const fullKey = await mintApiKey(account.cookie, workspace.slug, "contacts backend");
    await softDeleteWorkspace(account.cookie, workspace.slug, name);

    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: { authorization: `Bearer ${fullKey}` },
      payload: { email: "quiesce-contact@example.com" },
    });

    expect(res.statusCode, `expected 403, got: ${res.body}`).toBe(403);
    const body = res.json<{ code?: string }>();
    expect(body.code).toBe("workspace_deleted");

    const rowCount = await withTenant(workspace.id, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(`SELECT 1 FROM contacts WHERE workspace_id = $1`, [workspace.id]);
        return rows.length;
      })
    );
    expect(rowCount).toBe(0);
  });

  it("live workspace unaffected: identical event POST still succeeds and enqueues", async () => {
    const { workspace, fullKey } = await ownerWithKey("quiesce-live");

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${fullKey}` },
      payload: { name: "order_placed", externalId: "quiesce-live-cust" },
    });

    expect(res.statusCode, `POST /v1/events failed: ${res.body}`).toBe(202);
    const body = res.json<{ results: Array<{ status: string }> }>();
    expect(body.results[0].status).toBe("accepted");

    const jobs = await eventsIngestQueue.getJobs(["waiting", "delayed", "active", "completed"]);
    const forThisWorkspace = jobs.filter((job) => (job.data as { workspaceId?: string }).workspaceId === workspace.id);
    expect(forThisWorkspace.length).toBeGreaterThan(0);
  });

  it("invalid key against a deleted workspace's endpoint still returns the unchanged 401 body", async () => {
    const { cookie, workspace, name } = await ownerWithKey("quiesce-invalid-key");
    await softDeleteWorkspace(cookie, workspace.slug, name);

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: {
        authorization: "Bearer mcrm_0000000000000000.invalidsecretvaluexxxxxxxxxxxxxxxxxxxxxxxxx",
      },
      payload: { name: "order_placed", externalId: "quiesce-invalid-cust" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Invalid or missing API key" });
  });
});
