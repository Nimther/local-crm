import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { ensureTestDbMigrated, getTestDatabaseUrl, getAuthTestDatabaseUrl } from "@mega-crm/test-support";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import * as kms from "@mega-crm/kms";
import {
  clearSuppressionKeyCache,
  ensureWorkspaceSuppressionKey,
  hashSuppressionEmail,
  loadWorkspaceSuppressionKey,
  normalizeSuppressionEmail,
  SUPPRESSION_KEY_CACHE_TTL_MS,
} from "../suppression-hash.js";

/**
 * CMP-04 (D-02, plan 13-12), Task 1: the pure normalize-and-hash functions
 * plus the per-workspace key lifecycle. `ensureWorkspaceSuppressionKey`/
 * `loadWorkspaceSuppressionKey` are exercised against a real Postgres
 * connection (mirrors `upsert-anonymized.test.ts`'s convention) since they
 * read/write the FORCE-RLS `workspace_suppression_keys` table (via
 * `@mega-crm/tenant-context`'s `withTenant`/`withTenantTransaction`, exactly
 * as production call sites do) and call through to `@mega-crm/kms`'s local
 * provider.
 */
describe("normalizeSuppressionEmail (pure)", () => {
  it("lowercases and trims", () => {
    expect(normalizeSuppressionEmail("  A@B.com ")).toBe(normalizeSuppressionEmail("a@b.com"));
    expect(normalizeSuppressionEmail("  A@B.com ")).toBe("a@b.com");
  });
});

describe("hashSuppressionEmail (pure)", () => {
  it("returns a fixed-length hex digest regardless of input length", () => {
    const key = Buffer.from("a".repeat(32));
    const short = hashSuppressionEmail("a@b.com", key);
    const long = hashSuppressionEmail("a-very-long-local-part-indeed@a-very-long-domain-name.example.com", key);
    expect(short).toMatch(/^[0-9a-f]{64}$/);
    expect(long).toMatch(/^[0-9a-f]{64}$/);
    expect(short.length).toBe(long.length);
  });

  it("returns equal digests for the same address and key", () => {
    const key = Buffer.from("b".repeat(32));
    expect(hashSuppressionEmail("same@example.com", key)).toBe(hashSuppressionEmail("same@example.com", key));
  });

  it("returns different digests for the same address under two different keys", () => {
    const keyA = Buffer.from("c".repeat(32));
    const keyB = Buffer.from("d".repeat(32));
    expect(hashSuppressionEmail("same@example.com", keyA)).not.toBe(hashSuppressionEmail("same@example.com", keyB));
  });
});

describe("workspace suppression key lifecycle (real DB + local KMS provider)", () => {
  let authPool: Pool | undefined;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
  });

  afterAll(async () => {
    await authPool?.end();
  });

  afterEach(() => {
    clearSuppressionKeyCache();
    vi.restoreAllMocks();
  });

  /** Runs `fn` inside a tenant-scoped transaction for `workspaceId` -- the same mechanism every production call site uses against these FORCE-RLS tables. */
  function scoped<T>(workspaceId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTenant(workspaceId, () => withTenantTransaction(fn));
  }

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    if (!authPool) {
      const { Pool: PoolCtor } = await import("pg");
      authPool = new PoolCtor({ connectionString: getAuthTestDatabaseUrl() });
    }
    const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await authPool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, slug]
    );
    return rows[0].id;
  }

  it("loadWorkspaceSuppressionKey returns null for a workspace with no key row, creates no row, and performs zero provider calls", async () => {
    const workspaceId = await freshWorkspaceId("supp-key-none");
    const decryptSpy = vi.spyOn(kms, "decryptTenantSecret");

    const key = await scoped(workspaceId, (client) => loadWorkspaceSuppressionKey(client, workspaceId));
    expect(key).toBeNull();
    expect(decryptSpy).not.toHaveBeenCalled();

    const rowCount = await scoped(workspaceId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM workspace_suppression_keys WHERE workspace_id = $1`, [
        workspaceId,
      ]);
      return rows.length;
    });
    expect(rowCount).toBe(0);
  });

  it("ensureWorkspaceSuppressionKey creates and stores a wrapped key on first call, and returns the same key material on a second call without a second row", async () => {
    const workspaceId = await freshWorkspaceId("supp-key-create");

    const first = await scoped(workspaceId, (client) => ensureWorkspaceSuppressionKey(client, workspaceId));
    const second = await scoped(workspaceId, (client) => ensureWorkspaceSuppressionKey(client, workspaceId));

    expect(first.equals(second)).toBe(true);

    const rowCount = await scoped(workspaceId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM workspace_suppression_keys WHERE workspace_id = $1`, [
        workspaceId,
      ]);
      return rows.length;
    });
    expect(rowCount).toBe(1);
  });

  it("zeroes the freshly-generated plaintext key buffer immediately after wrapping it, even on the happy path", async () => {
    const workspaceId = await freshWorkspaceId("supp-key-zeroed");
    const fillSpy = vi.spyOn(Buffer.prototype, "fill");

    await scoped(workspaceId, (client) => ensureWorkspaceSuppressionKey(client, workspaceId));
    expect(fillSpy).toHaveBeenCalledWith(0);
  });

  it("zeroes the freshly-generated plaintext key buffer even when wrapping fails (error path)", async () => {
    const workspaceId = await freshWorkspaceId("supp-key-zeroed-error");
    const encryptSpy = vi.spyOn(kms, "encryptTenantSecret").mockRejectedValueOnce(new Error("INJECTED kms failure"));
    const fillSpy = vi.spyOn(Buffer.prototype, "fill");

    await expect(
      scoped(workspaceId, (client) => ensureWorkspaceSuppressionKey(client, workspaceId))
    ).rejects.toThrow(/INJECTED kms failure/);
    expect(fillSpy).toHaveBeenCalledWith(0);
    encryptSpy.mockRestore();

    const rowCount = await scoped(workspaceId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM workspace_suppression_keys WHERE workspace_id = $1`, [
        workspaceId,
      ]);
      return rows.length;
    });
    expect(rowCount).toBe(0);
  });

  it("loadWorkspaceSuppressionKey performs exactly one provider unwrap for two calls inside the TTL", async () => {
    const workspaceId = await freshWorkspaceId("supp-key-ttl-cached");
    await scoped(workspaceId, (client) => ensureWorkspaceSuppressionKey(client, workspaceId));
    clearSuppressionKeyCache(); // force the next load to actually unwrap, not reuse ensureWorkspaceSuppressionKey's own cache fill

    const decryptSpy = vi.spyOn(kms, "decryptTenantSecret");
    const [first, second] = await scoped(workspaceId, async (client) => {
      const a = await loadWorkspaceSuppressionKey(client, workspaceId);
      const b = await loadWorkspaceSuppressionKey(client, workspaceId);
      return [a, b];
    });

    expect(first).not.toBeNull();
    expect(first?.equals(second as Buffer)).toBe(true);
    expect(decryptSpy).toHaveBeenCalledTimes(1);
  });

  it("loadWorkspaceSuppressionKey performs a second provider unwrap after the TTL expires", async () => {
    const workspaceId = await freshWorkspaceId("supp-key-ttl-expired");
    await scoped(workspaceId, (client) => ensureWorkspaceSuppressionKey(client, workspaceId));
    clearSuppressionKeyCache();

    const decryptSpy = vi.spyOn(kms, "decryptTenantSecret");

    vi.useFakeTimers();
    try {
      await scoped(workspaceId, (client) => loadWorkspaceSuppressionKey(client, workspaceId));
      vi.advanceTimersByTime(SUPPRESSION_KEY_CACHE_TTL_MS + 1);
      await scoped(workspaceId, (client) => loadWorkspaceSuppressionKey(client, workspaceId));
    } finally {
      vi.useRealTimers();
    }

    expect(decryptSpy).toHaveBeenCalledTimes(2);
  });

  it("produces different digests for the same address under two different workspaces' keys", async () => {
    const workspaceA = await freshWorkspaceId("supp-key-ws-a");
    const workspaceB = await freshWorkspaceId("supp-key-ws-b");

    const keyA = await scoped(workspaceA, (client) => ensureWorkspaceSuppressionKey(client, workspaceA));
    const keyB = await scoped(workspaceB, (client) => ensureWorkspaceSuppressionKey(client, workspaceB));
    const normalized = normalizeSuppressionEmail("shared@example.com");

    expect(hashSuppressionEmail(normalized, keyA)).not.toBe(hashSuppressionEmail(normalized, keyB));
  });
});
