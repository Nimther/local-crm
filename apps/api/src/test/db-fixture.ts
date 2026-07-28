// 08-06 (D-13): the migration runner, advisory lock, tracking-table DDL and
// DSN resolution that used to live here are now in @mega-crm/test-support.
// Only this workspace's own reset helper stays. Kept as a shim rather than
// rewriting every import site: a mass import rewrite in the same change as the
// dev-DB fallback removal would make a regression impossible to bisect.
import type { Pool } from "pg";

export { createTestPool, ensureTestDbMigrated, getTestDatabaseUrl } from "@mega-crm/test-support";

/** Truncates every tenant-scoped domain table between test files, preserving migration history. */
export async function resetTestData(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      workspace_sendgrid_keys,
      invitation,
      member,
      organization,
      session,
      account,
      "user"
    RESTART IDENTITY CASCADE
  `);
}
