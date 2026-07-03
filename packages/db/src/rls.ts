/**
 * Documents the Postgres GUC key every RLS policy in this project keys off,
 * so the constant is shared (not re-typed as a string literal) between
 * migrations, the tenant-context middleware, and any future admin tooling.
 */
export const TENANT_GUC_KEY = "app.current_workspace_id" as const;
