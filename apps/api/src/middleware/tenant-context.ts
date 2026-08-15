// Thin re-export shim: the tenant-scoping mechanism (AsyncLocalStorage +
// `SET LOCAL app.current_workspace_id` + pooled pg client) now lives in
// @mega-crm/tenant-context so apps/worker can import the exact same
// implementation instead of re-deriving it (02-05, PITFALLS Pitfall 8).
// Every existing importer of this path (contact.repository.ts,
// sendgrid-key.repository.ts, api-keys.repository.ts, route modules, the
// rls-pooling-chaos chaos test) keeps resolving unchanged.
// Phase 15 plan 02 (OPS-11): `getCorrelationContext`/`withCorrelation` added
// alongside the pre-existing tenant exports -- the request-path `onRequest`
// hook in server.ts binds `requestId` via `withCorrelation`, and route
// handlers (e.g. campaigns.routes.ts's test-send) read it back through this
// same shim rather than importing `@mega-crm/tenant-context` a second way.
export {
  withTenant,
  withTenantTransaction,
  getWorkspaceId,
  withPreTenantLookup,
  withCorrelation,
  getCorrelationContext,
} from "@mega-crm/tenant-context";
