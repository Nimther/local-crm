import { Pool } from "pg";
import { env } from "./env.js";

/**
 * The tenant-scoped pg Pool — used exclusively by
 * middleware/tenant-context.ts's `withTenantTransaction`, which runs
 * `SET LOCAL app.current_workspace_id` inside every transaction acquired
 * from this pool. This is a SEPARATE client from `@mega-crm/db`'s Drizzle
 * client (used for better-auth's own tables, which are not RLS-protected —
 * see packages/db/src/schema/auth.ts). Both point at the same physical
 * database via the same DATABASE_URL.
 */
export const pool = new Pool({ connectionString: env.DATABASE_URL });
