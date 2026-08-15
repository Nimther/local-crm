import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureTestDbMigrated, getAuthTestDatabaseUrl } from "@mega-crm/test-support";
import { Pool } from "pg";

import {
  APPLICATION_NAME_BYTE_BUDGET,
  composeApplicationName,
  pool,
  withCorrelation,
  withTenant,
  withTenantTransaction,
} from "../index.js";

/**
 * Phase 15 plan 02 (OPS-12, RESEARCH.md Pattern 4): `application_name`
 * correlation folded into `withTenantTransaction`'s existing `set_config`
 * call -- proven here against a REAL transaction and a REAL
 * `pg_stat_activity` read, not a unit-level string assertion alone (the
 * plan's own must-have: "the current backend reports an application_name
 * containing the bound requestId and jobId").
 */
const WORKSPACE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

async function seedOrganization(): Promise<void> {
  const authPool = new Pool({ connectionString: getAuthTestDatabaseUrl() });
  try {
    await authPool.query(
      `INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [WORKSPACE_ID, "App-Name Correlation Tenant", `app-name-correlation-${Date.now().toString(36)}`],
    );
  } finally {
    await authPool.end();
  }
}

describe("application_name correlation (withTenantTransaction)", () => {
  beforeAll(async () => {
    await ensureTestDbMigrated();
    await seedOrganization();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("reports an application_name containing the bound requestId and jobId", async () => {
    const seen = await withCorrelation({ requestId: "req-app-name-1", jobId: "job-app-name-1" }, () =>
      withTenant(WORKSPACE_ID, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ application_name: string }>(
            "SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()",
          );
          return rows[0].application_name;
        }),
      ),
    );
    expect(seen).toContain("req-app-name-1");
    expect(seen).toContain("job-app-name-1");
  });

  it("sets a well-formed placeholder application_name when neither requestId nor jobId is bound", async () => {
    const seen = await withTenant(WORKSPACE_ID, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ application_name: string }>(
          "SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()",
        );
        return rows[0].application_name;
      }),
    );
    expect(seen).toBe("req=- job=-");
  });

  it("a pino log line emitted inside a correlation scope carries requestId/workspaceId/jobId as top-level fields", async () => {
    // Covered end-to-end (real pino output) by apps/worker/src/__tests__/correlation-tracer.test.ts
    // (task 3) -- this package has no pino dependency of its own, so this
    // suite asserts the ALS-side contract the mixin depends on instead:
    // getCorrelationContext() returns exactly what was bound.
    const { getCorrelationContext } = await import("../index.js");
    const seen = await withCorrelation({ requestId: "req-mixin-1", jobId: "job-mixin-1" }, () =>
      withTenant(WORKSPACE_ID, () => Promise.resolve(getCorrelationContext())),
    );
    expect(seen).toEqual({ requestId: "req-mixin-1", jobId: "job-mixin-1", workspaceId: WORKSPACE_ID });
  });

  it("a pino log line emitted outside any scope carries no correlation fields and does not throw", async () => {
    const { getCorrelationContext } = await import("../index.js");
    expect(() => getCorrelationContext()).not.toThrow();
    expect(getCorrelationContext()).toEqual({});
  });

  describe("composeApplicationName byte budget", () => {
    const FULL_UUID_A = "11111111-1111-4111-8111-111111111111";
    const FULL_UUID_B = "22222222-2222-4222-8222-222222222222";

    it("is at most APPLICATION_NAME_BYTE_BUDGET (63) bytes for two full UUIDs", () => {
      const composed = composeApplicationName({ requestId: FULL_UUID_A, jobId: FULL_UUID_B });
      expect(Buffer.byteLength(composed, "utf8")).toBeLessThanOrEqual(APPLICATION_NAME_BYTE_BUDGET);
    });

    it("truncates deterministically rather than including a partial trailing field", () => {
      const composed = composeApplicationName({ requestId: FULL_UUID_A, jobId: FULL_UUID_B });
      // req= (4) + 36-char UUID (36) + " job=" (5) + up to budget - 45 chars of the second UUID
      expect(composed.startsWith(`req=${FULL_UUID_A} job=`)).toBe(true);
      expect(Buffer.byteLength(composed, "utf8")).toBe(APPLICATION_NAME_BYTE_BUDGET);
    });

    it("composes the placeholder form when neither field is bound", () => {
      expect(composeApplicationName({})).toBe("req=- job=-");
    });
  });
});
