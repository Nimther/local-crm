# Phase 10: Tenant Isolation & Trust Boundaries - Pattern Map

**Mapped:** 2026-08-07
**Files analyzed:** 20
**Analogs found:** 18 / 20

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `packages/tenant-context/src/scan.ts` | service (DB helper) | request-response (pooled tx) | `packages/tenant-context/src/index.ts` (`withTenantTransaction`) | exact |
| `packages/tenant-context/src/__tests__/scan.test.ts` | test | CRUD/catalog assertion | `packages/tenant-context/src/__tests__/tenant-context.test.ts` | exact |
| `packages/db/migrations/00XX_workspace_isolation_bare_cast_unification.sql` | migration | batch (DDL) | `packages/db/migrations/0001_rls_policies.sql` (and 0019 fix precedent) | exact |
| `packages/db/migrations/00XX_scan_role_grants.sql` | migration | batch (DDL) | existing GRANT-only migrations (Phase 9 partition grants) | role-match |
| `packages/db/migrations/00XX_scan_role_policies.sql` | migration | batch (DDL) | `packages/db/migrations/0018/0027/0032/0039` (admin-scan policies) | exact |
| `packages/db/migrations/00XX_auth_role_grants.sql` | migration | batch (DDL) | same GRANT-only precedent | role-match |
| `packages/db/migrations/00XX_api_key_scopes_backfill.sql` | migration | batch (data UPDATE) | any existing backfill-shaped migration in `packages/db/migrations` | role-match |
| `docker/init-app-role.sql` (extend) | config | batch (bootstrap DDL) | itself (existing `mega_crm_app` block) | exact |
| `apps/worker/src/env.ts` (new/extend) | config | request-response (boot validation) | `apps/api/src/env.ts` | exact |
| `apps/worker/src/queues/campaign-scheduler.worker.ts` | worker/queue processor | event-driven (scan) | itself (current `pool.connect()` + `admin_scan` block) | exact |
| `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` | worker/queue processor | event-driven (scan) | itself (mirrors campaign-scheduler pattern) | exact |
| `apps/worker/src/queues/flows/flow-reconciliation.worker.ts` | worker/queue processor | event-driven (scan) | itself (mirrors campaign-scheduler pattern) | exact |
| `apps/worker/src/queues/analytics-reconciliation.worker.ts` | worker/queue processor | event-driven (scan) | itself (bare `SELECT id FROM organization`) | exact |
| `apps/worker/src/queues/webhook-events.worker.ts` (sibling-drop addition) | worker/queue processor | event-driven | itself (existing dedup-insert loop, `sends` lookup at line ~448) | exact |
| `packages/db/src/partitions/ensure-partitions.ts` (`attachPartitionCheckFirst`) | utility | batch | itself (current `admin_scan` set_config at line 238) | exact |
| `packages/db/scripts/relocate-default-partition-rows.ts` | utility/script | batch | itself + `ensure-partitions.ts` | exact |
| `apps/api/src/env.ts` (add `AUTH_DATABASE_URL`) | config | request-response (boot validation) | itself (existing `superRefine` NODE_ENV-gated checks, e.g. `KMS_PROVIDER`/`PUBLIC_APP_URL`) | exact |
| `apps/api/src/modules/auth/auth.ts` (repoint `drizzleAdapter`) | provider/config | request-response | itself (current `drizzleAdapter(db)` wiring) | exact |
| `packages/db/src/index.ts` (new auth-role Drizzle client) | provider | request-response | itself (existing `drizzle(pool, {schema})` construction) | exact |
| `apps/api/src/modules/tenancy/resolve-workspace-member.ts` | service/utility | request-response | `apps/api/src/modules/tenancy/member-roles.ts` (`getCallerRoles`) | exact |
| `apps/api/src/modules/api-keys/api-key-auth.ts` (`requireApiKeyScope`) | middleware | request-response | itself (existing `apiKeyAuth` hook, `UNAUTHORIZED_BODY` pattern) | exact |
| `apps/api/src/modules/webhooks/signature-verify.ts` (timestamp window) | utility | request-response | itself (existing `verifyWebhookSignature`) | exact |
| `apps/api/src/modules/webhooks/webhooks.routes.ts` (independent rate-limit bucket) | route | request-response | `apps/api/src/server.ts`'s existing `{ config: { rateLimit } }` route-level opt-in (invite accept) | role-match |
| `apps/api/src/server.ts` (Redis-backed rate-limit store) | config/bootstrap | request-response | itself (current `rateLimit` registration, `global: false`) | exact |
| `apps/api/src/env.ts` (`BETTER_AUTH_SECRET` floor) | config | request-response | itself (existing `superRefine` block, `KMS_PROVIDER`/`PUBLIC_APP_URL` NODE_ENV gates) | exact |
| `packages/redaction/src/rules.ts` | utility/shared package | transform | `apps/api/src/logger.ts` (existing `redact.paths` array) | role-match (new package, no direct analog) |
| `packages/redaction/src/pino-redact.ts` | utility | transform | `apps/api/src/logger.ts` | role-match |
| `packages/redaction/src/scrub.ts` | utility | transform | no direct analog — new recursive-walker shape | none |
| Worker `console.log`/`console.error` wrap sites (e.g. `apps/worker/src/server.ts`) | utility (logging wrapper) | transform | `apps/api/src/logger.ts` (pino redact, for the target shape only, not the mechanism) | partial |
| CI bare-`SET`/`SET ROLE` audit script/ESLint rule | utility (static check) | batch (CI) | no direct analog — new tooling | none |
| Negative cross-tenant test suite (API + worker) | test | CRUD/negative assertion | `packages/tenant-context/src/__tests__/tenant-context.test.ts` "PRE-PHASE-10 baseline" block | exact |
| Cross-route 404-sweep test (anti-enumeration) | test | request-response | `apps/api/src/modules/api-keys/api-key-auth.ts`'s `UNAUTHORIZED_BODY` precedent + `invite-flow.test.ts` | role-match |

## Pattern Assignments

### `packages/tenant-context/src/scan.ts` (service, request-response/pooled-tx)

**Analog:** `packages/tenant-context/src/index.ts`

**Imports pattern** (lines 1-3):
```typescript
import { Pool } from "pg";
import type { PoolClient } from "pg";
```

**Core pattern — separate lazily-constructed pool + BEGIN/COMMIT/ROLLBACK discipline** (mirrors lines 15-25, 61-94):
```typescript
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on("error", (err) => {
  console.error("idle pg pool client error (connection dropped)", err);
});

export async function withTenantTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const ctx = tenantContext.getStore();
  if (!ctx) {
    throw new Error("No tenant context set for this request");
  }
  const client = await pool.connect();
  let releaseWithError: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [ctx.workspaceId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      releaseWithError = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.release(releaseWithError);
  }
}
```

**Adaptation for `withCrossWorkspaceScan` (from RESEARCH.md Pattern 3, already concretely drafted there):** same BEGIN/COMMIT/ROLLBACK/`release(releaseWithError)` shape, but (a) the pool is built from `process.env.SCAN_DATABASE_URL` lazily inside a `getScanPool()` function instead of module-load-time `new Pool(...)`, (b) no `SELECT set_config('app.current_workspace_id', ...)` call at all — the role identity (not a GUC) is the access-control boundary, (c) no `AsyncLocalStorage` context check (no "current tenant" concept for a cross-workspace scan).

**Error-on-missing-DSN pattern** (new, no direct analog — matches `apps/api/src/env.ts`'s "fail fast, descriptive message" style):
```typescript
function getScanPool(): Pool {
  const dsn = process.env.SCAN_DATABASE_URL;
  if (!dsn) {
    throw new Error(
      "SCAN_DATABASE_URL is required to run a cross-workspace scan -- this " +
      "process's env schema does not declare it if it should never run scans"
    );
  }
  if (!scanPool) {
    scanPool = new Pool({ connectionString: dsn });
    scanPool.on("error", (err) => {
      console.error("idle scan pool client error (connection dropped)", err);
    });
  }
  return scanPool;
}
```

---

### `packages/tenant-context/src/__tests__/scan.test.ts` (test, catalog + negative assertion)

**Analog:** `packages/tenant-context/src/__tests__/tenant-context.test.ts`

Read the existing "PRE-PHASE-10 baseline" `describe` block (lines 164-197 per RESEARCH.md) — it currently documents/asserts the OLD fail-open (`rows.length === 0`) behavior for an untouched GUC. Two things follow directly from it as patterns to copy:
1. **Structure**: real ephemeral-Postgres integration test (no mocks), asserting thrown error CLASS (`expect(...).rejects.toThrow(/unrecognized configuration parameter/)` or similar), not row counts — this is the exact inversion SEC-03/04 requires.
2. **New scan.test.ts additions**: catalog assertions via `pg_roles`/`pg_class` queries (`rolbypassrls = false`, no rows in `information_schema.role_table_grants` where the scan role owns a table) alongside a negative test that the API process's env schema genuinely lacks `SCAN_DATABASE_URL` (import `apps/api/src/env.ts`'s parsed schema and assert the key is absent/undefined).

---

### `packages/db/migrations/00XX_scan_role_policies.sql` (migration, batch DDL)

**Analog:** `packages/db/migrations/0018` / `0027` / `0032` / `0039` (admin-scan policies being replaced)

Read each of the four migrations for the exact predicate each scan consumer currently relies on (Pitfall 3: `0027`/`0032` have NO narrowing predicate beyond the GUC check — must restore the ORIGINAL intended predicate, not just role-scope it). Concrete replacement shape (from RESEARCH.md Pattern 2, verified live against Postgres 17.10):
```sql
CREATE POLICY campaign_scheduler_due_scan ON campaigns
  FOR SELECT TO mega_crm_scan
  USING (status = 'scheduled' AND scheduled_at <= now());

CREATE POLICY flow_runs_due_scan ON flow_runs
  FOR SELECT TO mega_crm_scan
  USING (status = 'waiting' AND next_wake_at <= now());

CREATE POLICY flows_segment_sweep_scan ON flows
  FOR SELECT TO mega_crm_scan
  USING (status = 'live' AND trigger_type = 'segment');

CREATE POLICY scan_visibility ON contacts FOR SELECT TO mega_crm_scan USING (true);
CREATE POLICY scan_visibility ON sends FOR SELECT TO mega_crm_scan USING (true);
```
Every `workspace_isolation` policy touched by the companion unification migration MUST also gain `TO mega_crm_app` (Pitfall 2) in the same wave — the two migrations are not independently safe.

---

### `packages/db/migrations/00XX_workspace_isolation_bare_cast_unification.sql` (migration, batch DDL)

**Analog:** the existing 22-table `workspace_isolation` policy set (12 bare-cast, 10 NULLIF — grep `packages/db/migrations` for `workspace_isolation`)

**Target predicate shape** (RESEARCH.md Pattern 1, verified live):
```sql
ALTER POLICY workspace_isolation ON <table> TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);
```
No `missing_ok` second argument, no `NULLIF` — both must be entirely absent per Pitfall 1. Apply identically to all 22 tables, not just the 10 currently NULLIF-guarded ones.

---

### `apps/worker/src/queues/campaign-scheduler.worker.ts` / `flow-segment-sweep.worker.ts` / `flow-reconciliation.worker.ts` / `analytics-reconciliation.worker.ts` (worker, event-driven scan)

**Analog:** each file's own current implementation (near-identical shape across all four — read the specific file being edited, they mirror each other)

**Current pattern being replaced** (campaign-scheduler.worker.ts, paraphrased from lines ~37-40):
```typescript
const client = await pool.connect();
try {
  await client.query(`SELECT set_config('app.admin_scan', 'true', true)`);
  // ... due-row scan query ...
} finally {
  client.release();
}
```

**Replacement pattern** — swap for `withCrossWorkspaceScan` from `packages/tenant-context/src/scan.ts`:
```typescript
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";

const dueRows = await withCrossWorkspaceScan((client) =>
  client.query(/* same due-row SELECT, now relying on role-scoped policy instead of the GUC */)
);
// per-row re-entry into the existing withTenant(row.workspaceId, () => withTenantTransaction(...)) path is UNCHANGED
```
The per-row `withTenant`/`withTenantTransaction` re-entry after the scan (already present in all four files, e.g. campaign-scheduler.worker.ts lines 70-71) is untouched — only the scan step's connection/GUC mechanism changes.

**analytics-reconciliation.worker.ts** currently issues a bare `SELECT id FROM organization` with no GUC at all (RESEARCH.md line 262) — same replacement: route that read through `withCrossWorkspaceScan` too, since `organization` will need a `TO mega_crm_scan` grant/policy consideration (verify at plan time whether `organization` needs a scan policy or is already globally readable via existing grants).

---

### `apps/worker/src/queues/webhook-events.worker.ts` (SEC-09 sibling-drop addition)

**Analog:** itself — the existing dedup-insert loop (`custom_args.send_id` resolution around line 448) and the D-15 "unresolved send" precedent it already implements

**Current pattern** (paraphrased from lines ~438-448):
```typescript
// D-15: send_id may point at a deleted/orphaned send OR (new, SEC-09) a
// sibling workspace's send under a shared BYO SendGrid key.
const { rows } = await client.query(
  `SELECT id FROM sends WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
  [receivingWorkspaceId, candidateSendIds]
);
```

**SEC-09 addition** (new — insert a cross-workspace resolution step BEFORE the tenant-scoped insert, per RESEARCH.md Pitfall 4 and the diagram's `webhook-events.worker.ts` block):
```typescript
import { withCrossWorkspaceScan } from "@mega-crm/tenant-context";

const trueOwner = await withCrossWorkspaceScan((client) =>
  client.query(`SELECT id, workspace_id FROM sends WHERE id = ANY($1::uuid[])`, [candidateSendIds])
);
// id+workspace_id ONLY -- no payload columns (P1 prohibition, Assumption A3)
for (const row of trueOwner.rows) {
  if (row.workspace_id !== receivingWorkspaceId) {
    droppedSiblingCounter.inc(); // count + structured log, workspace IDs only, no payload
    candidateSendIds = candidateSendIds.filter((id) => id !== row.id);
  }
}
// existing D-15 "unresolved send" behavior (store event, skip side effects) is UNCHANGED for ids that resolve to null
```

---

### `packages/db/src/partitions/ensure-partitions.ts` (`attachPartitionCheckFirst`, sixth GUC touchpoint)

**Analog:** itself — current `admin_scan` set_config at line 238

**Current pattern:**
```typescript
await conn.query("SELECT set_config('app.admin_scan', 'true', true)");
```
**Replacement:** the function must either accept a scan-role connection from its caller (all of whom will already be inside a `withCrossWorkspaceScan` block after the worker-file changes above) or be restructured so the caller passes the client in rather than `attachPartitionCheckFirst` setting the GUC itself. This is Pitfall 8's explicit "sixth touchpoint" — do not treat the five named worker files as the complete migration surface. `packages/db/scripts/relocate-default-partition-rows.ts` shares the same pattern (its own docstring at line 22 references the same `SET LOCAL app.current_workspace_id` discipline framing) and needs the identical treatment.

---

### `apps/api/src/modules/auth/auth.ts` + `packages/db/src/index.ts` (auth-role pool wiring, SEC-05)

**Analog:** itself (`apps/api/src/modules/auth/auth.ts` lines 1-18) + `packages/db/src/index.ts` (lines 1-30, current `drizzle(pool, {schema})` construction)

**Current pattern:**
```typescript
import { db } from "@mega-crm/db";
export const auth = betterAuth({
  // ...
  database: drizzleAdapter(db, { provider: "pg" }),
  // ...
});
```
**Replacement pattern:** `packages/db/src/index.ts` needs a second exported Drizzle client (`authDb`, or similar) built from `AUTH_DATABASE_URL` / `mega_crm_auth`'s connection string, using the identical `drizzle(new Pool({ connectionString: ... }), { schema })` construction already used for the existing `db` export — then `auth.ts` imports `authDb` instead of `db` for `drizzleAdapter`. Grant matrix (D-04/D-05): `session`/`account`/`verification` reachable ONLY by `mega_crm_auth`; `organization`/`member`/`invitation`/`user` keep `mega_crm_app` read grants (confirmed live query sites: `member-roles.ts`'s `getCallerRoles`, `analytics-reconciliation.worker.ts`'s `SELECT id FROM organization`, `invites.ts`'s `db.query.organization.findFirst`).

---

### `apps/api/src/modules/tenancy/resolve-workspace-member.ts` (SEC-14, new file)

**Analog:** `apps/api/src/modules/tenancy/member-roles.ts` (`getCallerRoles`, `normalizeRoles`)

**Imports pattern** (lines 1):
```typescript
import { auth } from "../auth/auth.js";
```

**Core pattern to generalize** (lines 12-23 — the wrapper this file collapses ~9 duplicated call sites into):
```typescript
export function normalizeRoles(role: string | string[]): string[] {
  const joined = Array.isArray(role) ? role.join(",") : role;
  return joined.split(",").map((r) => r.trim()).filter(Boolean);
}

export async function getCallerRoles(headers: Headers, organizationSlug: string): Promise<string[]> {
  const { role } = await auth.api.getActiveMemberRole({ headers, query: { organizationSlug } });
  return normalizeRoles(role);
}
```
`resolveWorkspaceMember` wraps this same `auth.api.getActiveMemberRole` call plus the workspace-lookup + 404-mapping logic currently duplicated across ~9 route modules (grep `findActiveWorkspaceBySlug` call sites, e.g. `invites.ts` line 14/56) into one function returning a discriminated result (`{ workspace, roles } | null`), with callers uniformly mapping `null` to the SAME 404 body (SEC-10/15 anti-enumeration precedent below).

---

### `apps/api/src/modules/api-keys/api-key-auth.ts` (`requireApiKeyScope`, SEC-06)

**Analog:** itself — existing `apiKeyAuth` hook and `UNAUTHORIZED_BODY` constant (lines 41-45, 62-84)

**Enumeration-safe response precedent to reuse the SHAPE of** (lines 41-45):
```typescript
const UNAUTHORIZED_BODY = { error: "Invalid or missing API key" };
```

**Declaration-merging pattern to extend** (lines 4-9):
```typescript
declare module "fastify" {
  interface FastifyRequest {
    apiKeyWorkspaceId?: string;
  }
}
```
Add `apiKeyScopes?: string[]` to the same interface, populate it in `apiKeyAuth` alongside `request.apiKeyWorkspaceId = row.workspaceId;` (line 84) by reading the (now-enforced) `workspaceApiKeys.scopes` column, then add `requireApiKeyScope(scope: string)` exactly as drafted in RESEARCH.md's Code Examples section (403, distinct body/message from the 401 `UNAUTHORIZED_BODY` since scope-lacking is a different condition — confirm against SPEC.md whether 403 vs uniform-401 is required for R7/anti-enumeration parity).

---

### `apps/api/src/modules/webhooks/signature-verify.ts` (timestamp window, SEC-07)

**Analog:** itself — `verifyWebhookSignature` (full file, 39 lines)

**Fail-closed convention to preserve** (lines 15-34 — every failure path returns `false`, never throws to the caller):
```typescript
export function verifyWebhookSignature(
  publicKey: string,
  rawBody: Buffer,
  signature: string | undefined,
  timestamp: string | undefined
): boolean {
  if (!signature || !timestamp) {
    return false;
  }
  try {
    const eventWebhook = new EventWebhook();
    const ecPublicKey = eventWebhook.convertPublicKeyToECDSA(publicKey);
    return eventWebhook.verifySignature(ecPublicKey, rawBody, signature, timestamp);
  } catch {
    return false;
  }
}
```
Add a sibling check (same file or new exported function) comparing `Date.now()/1000 - Number(timestamp)` against the 600s window, returning `false` (not throwing) on staleness/malformed timestamp — same fail-closed posture, composed with (not replacing) the existing signature check per Pitfall 6 (do NOT touch `webhook-events.worker.ts`'s `extractEventRow`'s per-event `timestamp` field — that's Phase 13 territory).

---

### `apps/api/src/server.ts` (Redis-backed rate limit, SEC-08/11)

**Analog:** itself — current registration (lines 50-53)

**Current pattern:**
```typescript
await app.register(rateLimit, { global: false });
```
**Replacement** (concrete code already drafted in RESEARCH.md Code Examples, reusable near-verbatim):
```typescript
import Redis from "ioredis";

const rateLimitRedis = new Redis(env.REDIS_URL, { connectTimeout: 500, maxRetriesPerRequest: 1 });
rateLimitRedis.on("error", (err) => {
  logger.error({ err }, "rate-limit Redis connection error -- requests proceeding unthrottled");
});

await app.register(rateLimit, { global: false, redis: rateLimitRedis, skipOnError: true });
```
Route-level opt-in shape (webhook bucket, SEC-08) mirrors the EXISTING invite-accept route's `{ config: { rateLimit: {...} } }` pattern already used elsewhere in the route modules (grep `config: { rateLimit` for the exact existing call site to copy verbatim).

---

### `apps/api/src/env.ts` (two additions: `AUTH_DATABASE_URL`, `BETTER_AUTH_SECRET` floor)

**Analog:** itself — existing schema fields + `superRefine` block (lines 3-32, 34-70)

**Field-addition pattern** (mirrors `UNSUBSCRIBE_TOKEN_SECRET`, line 33):
```typescript
UNSUBSCRIBE_TOKEN_SECRET: z.string().min(32, "UNSUBSCRIBE_TOKEN_SECRET must be at least 32 characters"),
```
Add `AUTH_DATABASE_URL: z.string().min(1, "AUTH_DATABASE_URL is required")` alongside `DATABASE_URL`.

**NODE_ENV-gated `superRefine` pattern to copy verbatim in shape** (lines 42-48, the `KMS_PROVIDER` production guard):
```typescript
if (val.NODE_ENV === "production" && val.KMS_PROVIDER === "local") {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "KMS_PROVIDER=local must never be used when NODE_ENV=production (RESEARCH.md Pitfall 3)",
    path: ["KMS_PROVIDER"],
  });
}
```
`BETTER_AUTH_SECRET`'s new floor: keep `.min(16, ...)` on the base schema (dev/test), add the exact `superRefine` block already drafted in RESEARCH.md's Code Examples (NODE_ENV === "production" && length < 32).

**P3 structural proof:** confirm/assert in a test that `SCAN_DATABASE_URL` is NOT a key in `envSchema.shape` here — this file's absence-of-a-field IS the negative-test target for SEC-02.

---

### `packages/redaction/` (new shared package, SEC-13)

**Analog:** `apps/api/src/logger.ts` (existing pino `redact` config, absorbed not duplicated per D-10)

**Seed content to migrate into `rules.ts`** (full existing config, lines 11-28):
```typescript
export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : "info",
  redact: {
    paths: [
      "sendgridKey", "*.sendgridKey", "*.*.sendgridKey",
      "apiKey", "*.apiKey", "*.*.apiKey",
      "password", "*.password", "*.*.password",
      "token", "*.token", "*.*.token",
    ],
    censor: "[REDACTED]",
  },
});
```
`packages/redaction/src/rules.ts` should hold this same path list (plus PII value-regex additions per D-08) as data; `pino-redact.ts` compiles it to the `redact.paths` shape `apps/api/src/logger.ts` then imports and passes straight through (replacing the inline array with `redact: { paths: compiledPaths, censor: "[REDACTED]" }`); `scrub.ts` is a new recursive function with no direct in-repo analog — model its signature/behavior after the "dual-consumer test guards against drift" requirement (D-08): given the SAME rule table, `scrub(value)` and the compiled pino config must redact an identical representative payload identically.

**Structural precedent for the package itself** (per CONTEXT/RESEARCH): follow the Phase 8 `packages/test-support` package shape (own `package.json`, `src/`, `__tests__/`) — read `packages/test-support/package.json` at plan time for the exact workspace-package boilerplate to copy.

## Shared Patterns

### `withTenant`/`withTenantTransaction` session discipline
**Source:** `packages/tenant-context/src/index.ts` (full file)
**Apply to:** `withCrossWorkspaceScan` (scan.ts) — same BEGIN/COMMIT/ROLLBACK-with-`release(releaseWithError)` shape, `SET LOCAL`-only discipline (never bare `SET`), pool `.on("error", ...)` listener.

### Enumeration-safe uniform response body
**Source:** `apps/api/src/modules/api-keys/api-key-auth.ts` lines 41-45 (`UNAUTHORIZED_BODY`) and `apps/api/src/modules/tenancy/invites.ts`'s existing identical-404 precedent (lines 187-202 per RESEARCH.md)
**Apply to:** SEC-10/15's platform-wide 404 sweep and the invite endpoint — one constant object per failure class, reused across every branch that should be indistinguishable to the caller.

### NODE_ENV-gated boot-time validation via `superRefine`
**Source:** `apps/api/src/env.ts` lines 38-70 (`KMS_PROVIDER`, `PUBLIC_APP_URL` guards)
**Apply to:** `BETTER_AUTH_SECRET` production floor (SEC-12) — copy the `ctx.addIssue({ code: z.ZodIssueCode.custom, message, path })` shape exactly.

### Fail-closed helper: return `false`/throw-on-invalid rather than "zero rows"
**Source:** `apps/api/src/modules/webhooks/signature-verify.ts` (whole file) and RESEARCH.md's live-verified Pattern 1 (bare-cast-no-`missing_ok` RLS predicate)
**Apply to:** every SEC-03/04/07 change — this phase's unifying theme is "prove absence via a thrown error/explicit false, never via an empty result set."

### One audited entry point per capability
**Source:** `withTenantTransaction` (tenant access) as the existing template
**Apply to:** `withCrossWorkspaceScan` (cross-tenant access, D-02) and `resolveWorkspaceMember` (membership resolution, SEC-14) — both are new "the one function everything calls" additions modeled directly on this existing precedent; do not let any consumer roll its own variant.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `packages/redaction/src/scrub.ts` | utility | transform | No existing recursive deep-object walker in the codebase; new shape, only the *rule data* has a precedent (`logger.ts`) |
| CI bare-`SET`/`SET ROLE` audit script/ESLint rule | static analysis | batch (CI) | No existing custom lint rule or standalone audit script in the repo to model against; mechanism choice (ESLint rule vs script) is Claude's Discretion per CONTEXT |
| `apps/worker` console-wrapper for `scrub()` (SEC-13/D-09) | utility | transform | Worker currently uses bare `console.log`/`console.error` with no existing wrapper abstraction to extend |

## Metadata

**Analog search scope:** `packages/tenant-context/src`, `packages/db/src` (partitions, schema, index), `packages/db/migrations`, `packages/db/scripts`, `apps/api/src` (env, logger, server, modules/{auth,api-keys,webhooks,tenancy}), `apps/worker/src` (queues, env), `docker/init-app-role.sql`
**Files scanned:** ~25 (direct reads) + migration-history grep sweep
**Pattern extraction date:** 2026-08-07
