// Thin re-export shim: the tenant-scoping mechanism (AsyncLocalStorage +
// `SET LOCAL app.current_workspace_id` + pooled pg client) now lives in
// @mega-crm/tenant-context so apps/worker can import the exact same
// implementation instead of re-deriving it (02-05, PITFALLS Pitfall 8).
// Every existing importer of this path (contact.repository.ts,
// sendgrid-key.repository.ts, api-keys.repository.ts, route modules, the
// rls-pooling-chaos chaos test) keeps resolving unchanged.
export {
  withTenant,
  withTenantTransaction,
  getWorkspaceId,
  withPreTenantLookup,
} from "@mega-crm/tenant-context";
