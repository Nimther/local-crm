---
phase: 10-tenant-isolation-trust-boundaries
fixed_at: 2026-08-08T20:02:07Z
review_path: .planning/phases/10-tenant-isolation-trust-boundaries/10-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 10: Code Review Fix Report

**Fixed at:** 2026-08-08T20:02:07Z
**Source review:** .planning/phases/10-tenant-isolation-trust-boundaries/10-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (fix_scope: critical_warning -- CR-01 + WR-01..WR-05; IN-01 excluded)
- Fixed: 6
- Skipped: 0

## Fixed Issues

### CR-01: `packages/db/src/index.ts`'s base Postgres pool has no `error` listener

**Files modified:** `packages/db/src/index.ts`
**Commit:** 777d8d4
**Applied fix:** Added `pool.on("error", ...)` to the base pool backing the exported `db` Drizzle client, matching the identical listener already present on every sibling pool this phase touched (`authPool`, tenant-context's `pool`, `scanPool`, `partitionMaintenancePool`). Verified with `tsc --noEmit` against `packages/db/tsconfig.json` (clean).

### WR-01: Invitation revoke route has no explicit cross-workspace ownership check

**Files modified:** `apps/api/src/modules/tenancy/invites.ts`
**Commit:** a4ac45f
**Applied fix:** Added the workspace resolution + `existing.organizationId === workspace.id` ownership check (mirroring the sibling `resend` handler) to the `POST /api/workspaces/:slug/invites/:invitationId/revoke` route before calling `auth.api.cancelInvitation`. Verified with `tsc --noEmit` against `apps/api/tsconfig.json` (clean).

### WR-02: `GET /contacts/:id/events` bypasses the zod pagination pattern

**Files modified:** `apps/api/src/modules/contacts/contacts.routes.ts`
**Commit:** 103e086
**Applied fix:** Replaced the hand-rolled `Number()`/`Math.max` page parser with a `z.object({ page: z.coerce.number().int().min(1).optional() })` schema and `safeParse`, matching every sibling paginated route (`timeline.routes.ts`, `send-log.routes.ts`, `segments.routes.ts`). Verified with `tsc --noEmit` against `apps/api/tsconfig.json` (clean).

### WR-03: `getWebhookEndpointByWorkspace` reads the tenant GUC with `missing_ok=true`

**Files modified:** `apps/api/src/modules/webhooks/webhook-endpoint.repository.ts`
**Commit:** 986dd57
**Applied fix:** Replaced the in-SQL `current_setting('app.current_workspace_id', true)::uuid` (null-tolerant) read with the bound `getWorkspaceId()` parameter, matching every sibling repository function and eliminating the one reintroduction of the fail-open pattern migration 0044 otherwise retired everywhere. Verified with `tsc --noEmit` against `apps/api/tsconfig.json` (clean).

### WR-04: CSV error-report download does not neutralize spreadsheet formula characters

**Files modified:** `apps/api/src/modules/contacts/csv-import.routes.ts`
**Commit:** 9298819
**Applied fix:** `csvEscape` now prefixes any value starting with `=`, `+`, `-`, `@`, tab, or CR with a neutralizing `'` before RFC 4180 quoting, closing the CSV/formula-injection risk (CWE-1236) in the import error-report download. Verified with `tsc --noEmit` against `apps/api/tsconfig.json` (clean).

### WR-05: Locally re-typed 404 body literals duplicate `NOT_FOUND_BODY`

**Files modified:** `apps/api/src/modules/tenancy/invites.ts`, `apps/api/src/modules/campaigns/campaigns.routes.ts`, `apps/api/src/modules/flows/flows.routes.ts`
**Commit:** d3320ff
**Applied fix:** Imported `NOT_FOUND_BODY` from `resolve-workspace-member.ts` in all three modules and replaced every hand-typed `{ error: "Workspace not found" }` literal at `findActiveWorkspaceBySlug`-based branches (~12 call sites total: 4 in `invites.ts`, 4 in `campaigns.routes.ts`, 5 in `flows.routes.ts`) with the imported reference. `invites.ts`'s separate `INVITATION_NOT_FOUND_BODY` constant (a different resource's 404 body) was left untouched, as it is out of this finding's scope. Verified with `tsc --noEmit` against `apps/api/tsconfig.json` (clean).

## Skipped Issues

None — all in-scope findings were fixed.

---

_Fixed: 2026-08-08T20:02:07Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
