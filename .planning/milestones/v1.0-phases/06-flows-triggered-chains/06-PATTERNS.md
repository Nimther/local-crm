# Phase 6: Flows (Triggered Chains) - Pattern Map

**Mapped:** 2026-07-10
**Files analyzed:** ~30 (new tables, backend modules, workers, shared schemas, frontend feature)
**Analogs found:** 27 / 30

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/db/src/schema/flows.ts` | model | CRUD | `packages/db/src/schema/campaigns.ts` | exact |
| `packages/db/src/schema/flow-versions.ts` | model | CRUD (immutable snapshot) | `packages/db/src/schema/campaigns.ts` (status/lifecycle) + `segments.ts` (`definition jsonb`) | role-match |
| `packages/db/src/schema/flow-runs.ts` | model | event-driven / state-machine | `packages/db/src/schema/campaigns.ts` (counters/timestamps) + `campaign-recipients.ts` (per-contact row shape) | role-match |
| `packages/db/src/schema/flow-run-steps.ts` | model | event-driven (append-only log) | `packages/db/src/schema/send-events.ts` (append-only fact log) | role-match |
| `packages/db/src/schema/flow-segment-membership-snapshot.ts` | model | batch/diff | `packages/db/src/schema/campaign-recipients.ts` (per-contact snapshot rows) | role-match |
| `packages/db/migrations/00XX_flows.sql` | migration | DDL + RLS | `packages/db/migrations/0013_campaigns.sql`, `0011_segments.sql` | exact |
| `packages/db/migrations/00XX_flows_scheduler_scan_policy.sql` | migration | DDL (admin-scan RLS) | `packages/db/migrations/0018_campaigns_scheduler_scan_policy.sql` + `0019_..._nullif_guard.sql` | exact |
| `packages/db/migrations/00XX_sends_flow_columns.sql` | migration | DDL (extend existing table) | `packages/db/migrations/0022_sends_delivery_columns.sql` | exact |
| `packages/db/migrations/00XX_contacts_timezone.sql` | migration | DDL (add column) | `packages/db/migrations/0023_contacts_soft_bounce_streak.sql` | exact |
| `packages/db/migrations/00XX_workspace_send_settings_timezone_quiet_hours.sql` | migration | DDL (add columns) | `packages/db/migrations/0016_workspace_send_settings.sql` | exact |
| `packages/flows-core/src/flow-definition-schema.ts` | utility | transform (schema) | `packages/segments-core/src/types.ts` | exact |
| `packages/flows-core/src/flow-validate.ts` | utility | transform (pure validation) | `packages/segments-core/src/compile.ts` | role-match |
| `packages/flows-core/src/flow-condition.ts` | utility | transform (wraps segment engine) | `packages/segments-core/src/compile.ts` + `apps/api/src/modules/segments/segment.repository.ts`'s `isContactInSegment` | role-match |
| `packages/shared-schemas/src/flow.ts` | utility (Zod schemas) | request-response | `packages/shared-schemas/src/segment.ts` + `packages/shared-schemas/src/campaign.ts` | exact |
| `packages/shared-schemas/src/queues.ts` (MODIFY: discriminated union + flow queues) | config | request-response | itself (existing `emailTriggeredJobSchema`/`emailBroadcastJobSchema`) | exact |
| `packages/delivery-core/src/send-ledger.ts` (MODIFY: `claimFlowSend`, `recordFlowStepResult`) | service | CRUD (idempotent claim) | itself (`claimCampaignSend`/`dispatchSendGate`/`incrementCampaignSendCounter` shape, read via `send-dispatch.ts`) | exact |
| `apps/api/src/modules/flows/flow.repository.ts` | service | CRUD | `apps/api/src/modules/campaigns/campaign.repository.ts` | exact |
| `apps/api/src/modules/flows/flow-version.repository.ts` | service | CRUD (immutable versioning) | `apps/api/src/modules/segments/segment.repository.ts` (definition read/write) + campaign state-machine idea | role-match |
| `apps/api/src/modules/flows/flow-run.repository.ts` | service | CRUD / read-model | `apps/api/src/modules/campaigns/campaign.repository.ts` (progress/counters queries) | role-match |
| `apps/api/src/modules/flows/flow-validation.ts` | utility | transform (server-side re-validation) | delegates to `packages/flows-core/src/flow-validate.ts`; route-wiring analog is `campaigns.routes.ts`'s launch-incomplete-fields flow | role-match |
| `apps/api/src/modules/flows/flows.routes.ts` | route/controller | request-response | `apps/api/src/modules/campaigns/campaigns.routes.ts` | exact |
| `apps/api/src/modules/segments/segment.repository.ts` (MODIFY: `SegmentConflictError` gains `referenced_by_flow` check in `deleteSegment`) | service | CRUD | itself | exact |
| `apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts` | service (worker) | event-driven | `apps/worker/src/queues/events-ingest.worker.ts` (event-driven consumer) + `campaign-kickoff.worker.ts` (job → DB write) | role-match |
| `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` | service (worker) | batch (repeatable scan) | `apps/worker/src/queues/campaign-scheduler.worker.ts` | exact |
| `apps/worker/src/queues/flows/flow-reconciliation.worker.ts` | service (worker) | batch (repeatable scan, admin cross-tenant discovery) | `apps/worker/src/queues/campaign-scheduler.worker.ts` | exact |
| `apps/worker/src/queues/flows/flow-run-advance.worker.ts` | service (worker) | state-machine / event-driven | `apps/worker/src/queues/send-dispatch.ts` (`processSendJob` transaction-unit shape) + `campaign-kickoff.worker.ts` (per-row worker pattern) | role-match |
| `apps/worker/src/queues/flows/flow-send.ts` | service | CRUD (idempotent claim, sibling of `send-dispatch.ts`) | `apps/worker/src/queues/send-dispatch.ts` | exact |
| `apps/worker/src/queues/send-dispatch.ts` (MODIFY: `kind:"flow"` branch in `processSendJob`) | service (worker) | request-response (dispatch) | itself | exact |
| `apps/worker/src/queues/events-ingest.worker.ts` (MODIFY: enqueue flow-trigger-check after upsert) | service (worker) | event-driven | itself | exact |
| `apps/web/src/features/flows/api.ts` | utility (API client) | request-response | `apps/web/src/features/campaigns/api.ts` | exact |
| `apps/web/src/features/flows/list/FlowsListPage.tsx` | component | request-response (read) | `apps/web/src/features/campaigns/CampaignsListPage.tsx` | exact |
| `apps/web/src/features/flows/detail/FlowDetailPage.tsx` | component | request-response | `apps/web/src/features/campaigns/CampaignDetailPage.tsx` | exact |
| `apps/web/src/features/flows/detail/PublishEnrollDialog.tsx` | component | request-response (confirm dialog) | `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx` | exact |
| `apps/web/src/features/flows/canvas/FlowCanvas.tsx` (+ node types) | component | client-state (canvas) | none (new library `@xyflow/react`, no existing canvas in codebase) | no analog |
| Contact `timezone` field (contact form, CSV mapping, property registry, API) | model/component | CRUD | `packages/db/src/schema/contacts.ts` (existing fields) + `apps/web/src/features/contacts` form/CSV-mapping components | role-match |
| Workspace send-settings UI (default timezone + quiet hours) | component | request-response | `apps/web/src/features/campaigns/SendSettingsPage.tsx` | exact |

## Pattern Assignments

### `packages/db/src/schema/flows.ts` / `flow-versions.ts` / `flow-runs.ts` (model, CRUD)

**Analog:** `packages/db/src/schema/campaigns.ts` (full file, 69 lines — small file, read in full)

**Imports pattern** (lines 1-3):
```typescript
import { pgTable, text, timestamp, uuid, integer, boolean, pgEnum } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { segments } from "./segments.js";
```

**Status enum pattern** (lines 5-17):
```typescript
export const campaignStatusEnum = pgEnum("campaign_status", [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "canceled",
]);
```
For `flows`, use an analogous `flow_status` enum: `["draft", "live", "paused"]` (per D-18/D-22 — no terminal state in v1). `flow_versions` needs its own immutability marker instead of a status enum — mirror how `segments.ts`'s `definition jsonb` column stores the compiled shape (see segment analog below) but make the row itself immutable once referenced by `flows.live_version_id`.

**Nullable FK for cross-phase reuse** (lines 46-48, and mirrored in `sends.ts` line 39): `segmentId` is `.references(() => segments.id, { onDelete: "restrict" })` — copy this exact RESTRICT (not CASCADE/SET NULL) shape for `flows.trigger_segment_id`/branch/exit segment references (D-24 restrict-when-referenced).

**Counters/audit-timestamp pattern** (lines 53-65): `sentCount`/`failedCount`/`sendingStartedAt`/`terminalAt` — mirror for `flow_runs`: `currentNodeId`, `status` (`waiting|advancing|completed|exited|ejected`), `nextWakeAt`, `enteredAt`, `lastEntryAt` (D-06's per-contact re-entry clock).

---

### `packages/db/src/schema/sends.ts` (MODIFY — add `flow_run_id`/`node_id`)

**Analog:** itself, full file (63 lines)

**Nullable cross-phase FK + comment convention** (lines 18-23, 39):
```typescript
campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
```
The file's own doc-comment (lines 18-23) already anticipates the Phase 6 extension — read it verbatim before writing the migration. Copy the exact `unique(...)` table-constraint syntax (line 60) for the NEW partial unique index (Postgres partial indexes aren't expressible via drizzle's `unique()` helper directly — write this one as raw SQL in the migration, matching `0022_sends_delivery_columns.sql`'s ALTER-COLUMN convention).

---

### Migrations — RLS ENABLE+FORCE+NULLIF-guard (migration)

**Analog:** `packages/db/migrations/0013_campaigns.sql` lines 33-40, combined with the later fix in `0019_campaigns_workspace_isolation_nullif_guard.sql` lines 15-20:
```sql
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON campaigns
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
```
**Critical:** apply the NULLIF guard from the FIRST migration for every new flow table (`flows`, `flow_versions`, `flow_runs`, `flow_run_steps`, `flow_segment_membership_snapshot`) — do NOT reproduce the bare-cast bug that required `0019` as a follow-up fix for `campaigns`. Write it correctly once.

**Admin cross-tenant scan policy** — analog: `packages/db/migrations/0018_campaigns_scheduler_scan_policy.sql` (full file, ~30 lines) — copy verbatim for `flow_runs`' due-scan policy (`current_setting('app.admin_scan', true) = 'true'`), needed by both `flow-reconciliation.worker.ts` and `flow-segment-sweep.worker.ts`.

---

### `packages/flows-core/` (utility package, transform)

**Analog:** `packages/segments-core/src/compile.ts` + `types.ts` + `index.ts` (package structure) — read `packages/segments-core/src/types.ts`/`compile.ts` for the exact shape of a pure, side-effect-free, DB-free compiler package: `package.json`, `vitest.config.ts`, `tsconfig.json` siblings, `src/index.ts` barrel export. Mirror this package skeleton exactly for `packages/flows-core` (Wave-0 gap explicitly flagged in RESEARCH.md).

**Condition-wrapping pattern**: `flow-condition.ts` should NOT reimplement segment SQL — it must import and call `isContactInSegment`/`compileSegmentDefinition` from `@mega-crm/segments-core` / `apps/api/src/modules/segments/segment.repository.ts` (see below), per RESEARCH.md's explicit "Don't Hand-Roll" directive.

---

### `apps/api/src/modules/segments/segment.repository.ts` — `isContactInSegment` (service, CRUD/point-check)

**Analog:** itself, full file (339 lines, read in full — under 2000-line threshold)

**Point-check contract to reuse as-is** (lines 130-146):
```typescript
export async function isContactInSegment(def: SegmentDefinition, contactId: string): Promise<boolean> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { whereSql, params } = compileSegmentDefinition(def, workspaceId);
    const pointCheckParams = [...params, contactId];
    const { rows } = await client.query(
      `SELECT 1 FROM contacts c WHERE ${whereSql} AND c.id = $${pointCheckParams.length} LIMIT 1`,
      pointCheckParams
    );
    return rows.length > 0;
  });
}
```
This is exactly the branch/exit/trigger condition primitive (D-12/D-15) — call it, never reimplement.

**Restrict-when-referenced error pattern** (lines 37-45, 291-338 `deleteSegment`):
```typescript
export class SegmentConflictError extends Error {
  constructor(message: string, public readonly code: "referenced_by_campaign" | "referenced_by_flow") {
    super(message);
    this.name = "SegmentConflictError";
  }
}
```
The `code` union ALREADY reserves `"referenced_by_flow"` (line 40 comment: "remains reserved for Phase 6"). `deleteSegment`'s two-layer defense (app-level pre-check at lines 304-313 + DB-level `23503` catch at lines 315-336) is the exact pattern to extend: add a `flows`/`flow_versions` reference check alongside the existing `campaigns` check, and catch-map `23503` to `referenced_by_flow` too.

---

### `apps/api/src/modules/campaigns/campaign.repository.ts` (service, CRUD/state-machine)

**Analog:** itself (440 lines total — read first 120 lines here; remaining sections for launch/schedule/cancel/duplicate cover flow lifecycle equivalents; fetch on demand if planner needs schedule/cancel specifics)

**Column-list-as-const pattern** (lines 32-58):
```typescript
const CAMPAIGN_COLUMNS = `
  id,
  workspace_id as "workspaceId",
  ...
`;
```
Copy this convention for `FLOW_COLUMNS`/`FLOW_VERSION_COLUMNS`/`FLOW_RUN_COLUMNS`.

**State error class pattern** (lines 60-76):
```typescript
export class CampaignStateError extends Error {
  constructor(message: string, public readonly code: "illegal_transition" | "incomplete" | "not_found") {
    super(message);
    this.name = "CampaignStateError";
  }
}
```
Mirror for `FlowStateError` with codes covering draft/live/paused illegal transitions, publish-validation failure (`incomplete` → D-17 hard errors), `not_found`.

**Insert/create pattern** (lines 87-107): `withTenantTransaction` + `getWorkspaceId()` + parameterized INSERT ... RETURNING ${COLUMNS} — copy verbatim shape for `createFlow`.

---

### `apps/worker/src/queues/campaign-scheduler.worker.ts` (service/worker, batch)

**Analog:** itself, full file (126 lines, read in full)

**Two-phase discovery + tenant-scoped transition pattern** (lines 36-87): `findDueCampaignCandidates()` (admin-scoped, `SELECT`-only, no `FOR UPDATE`) followed by `transitionToSending()` (`withTenant` + `FOR UPDATE SKIP LOCKED` re-verify + write) — copy this exact two-function split for BOTH `flow-reconciliation.worker.ts` (`findDueFlowRunCandidates` / `transitionToAdvancing`) and `flow-segment-sweep.worker.ts` (adapted WHERE clause, per RESEARCH.md Pattern 2).

**Repeatable-tick registration pattern** (lines 101-112):
```typescript
const tickQueue = new Queue(CAMPAIGN_SCHEDULER_QUEUE, { connection });
void tickQueue.add("scan-due-campaigns", {}, { repeat: { every: SCAN_INTERVAL_MS }, jobId: "scan-due-campaigns" });
```
Idempotent registration via a fixed `jobId` — copy for each new repeatable worker (reconciliation tick, segment-sweep tick), using distinct fixed jobIds and distinct interval constants (RESEARCH.md flags the sweep interval, 15-60 min, as a discretion item vs. the reconciliation backstop interval, which should stay tighter, e.g. matching or near the 60s campaign-scheduler cadence).

**Deterministic jobId dedup pattern** (lines 118-121): `kickoffQueue.add("kickoff", {...}, { jobId: row.id })` — copy for `flow-run-advance` job enqueue, using `flowRunId` (or `flowRunId-nodeId`) as jobId so a redelivered wake nudge can never double-advance.

---

### `apps/worker/src/queues/send-dispatch.ts` (service/worker, request-response dispatch — EXTEND, don't fork)

**Analog:** itself, full file (431 lines, read in full — under 2000-line threshold, single pass)

**Prereqs-resolution pattern** (lines 124-156, `readSendPrereqs`): decrypt tenant SendGrid key, read `workspace_send_settings` for rps, read template/sender from the source-of-truth row (`campaigns` today). For `kind: "flow"`, write a `readFlowSendPrereqs` sibling that resolves template/sender from the pinned `flow_versions.definition` send-node config instead (RESEARCH.md Pattern 1, item 5).

**Claim-transaction pattern** (lines 181-241, `claimCampaignSend`): read contact → `evaluatePreSendGate` → `dispatchSendGate` (idempotent claim via unique index) → build `dynamicTemplateData`/unsubscribe URL. Copy this exact shape for `claimFlowSend` in `flow-send.ts`, swapping `dispatchSendGate`'s `ON CONFLICT (workspace_id, campaign_id, contact_id)` for a new `ON CONFLICT (workspace_id, flow_run_id, node_id)` against the new partial unique index (RESEARCH.md Pattern 1, item 3).

**Three-unit transaction-boundary discipline** (lines 269-352, main `processSendJob` body, `kind === "campaign"` branch): (1) claim transaction commits BEFORE any network call, (2) SendGrid call OUTSIDE any transaction, (3) terminal-record transaction ONLY after SendGrid responds. This is the single most important structural rule to replicate unmodified for the new `kind === "flow"` branch — do not collapse units or move the SendGrid call inside a transaction.

**Rate-limit consumption call site** (lines 301-309): `consumeTenantToken(redisClient, workspaceId, claim.rps)` — same call, same limiter instance, regardless of `kind`. Never instantiate a second limiter for flow sends (RESEARCH.md Don't Hand-Roll).

---

### `apps/api/src/modules/campaigns/campaigns.routes.ts` (route/controller, request-response)

**Analog:** itself (590 lines total; read lines 1-130 above — imports/error-mapping/response-shaping section; fetch remaining route-handler bodies on demand for the exact launch/schedule/duplicate/test-send Fastify wiring)

**Imports pattern** (lines 1-34): Zod schemas from `@mega-crm/shared-schemas`, `requirePermission`/`toFetchHeaders` from role-guard, `withTenant`/`withTenantTransaction`, repository functions as named imports, `campaignKickoffQueue`/`emailBroadcastQueue` from a co-located `*-queues.ts` file. Mirror all of this for `flows.routes.ts` + a new `flow-queues.ts`.

**Error-to-HTTP mapping pattern** (lines 76-105, `mapCampaignStateError`/`mapCampaignSenderError`): a small pure function per custom error class, mapping `.code` to `{code, body}`; `not_found`→404, `illegal_transition`→409, everything else→422 with a `fields` breakdown. Copy this exact shape for `mapFlowStateError` (draft/live/paused illegal transitions → 409, publish-validation hard errors → 422 with a `fields`-shaped breakdown per D-17).

**Response-shaping pattern** (lines 107-131, `toCampaignResponse`): field-for-field row→JSON mapping with `.toISOString()` on every timestamp. Copy for `toFlowResponse`/`toFlowRunSummaryResponse`.

**Role gating** — the file's Owner/Admin-only routes (launch/schedule/cancel — grep for `requirePermission` calls if exact line numbers needed) use `requirePermission(...)` from `../../middleware/role-guard.js`; apply identically to flow publish/pause/resume/enroll-existing routes (D-23).

---

### `packages/shared-schemas/src/queues.ts` (config — MODIFY)

**Analog:** itself, full file (144 lines, read in full)

**Existing gap to fix** (lines 103-111, current `emailTriggeredJobSchema`): currently an exact copy of `emailBroadcastJobSchema`'s flat shape (campaignId required for every kind). RESEARCH.md's Code Examples section (lines 392-412 of 06-RESEARCH.md) already spells out the exact discriminated-union replacement — implement it verbatim:
```typescript
export const emailTriggeredJobSchema = z.discriminatedUnion("kind", [
  z.object({ workspaceId: z.string().uuid(), kind: z.literal("campaign"), campaignId: z.string().uuid(), contactId: z.string().uuid() }),
  z.object({ workspaceId: z.string().uuid(), kind: z.literal("test"), campaignId: z.string().uuid(), testTo: z.string().email(), testData: z.record(z.string(), z.unknown()).optional() }),
  z.object({ workspaceId: z.string().uuid(), kind: z.literal("flow"), flowRunId: z.string().uuid(), nodeId: z.string(), contactId: z.string().uuid() }),
]);
```

**Queue-name-constant pattern** (lines 10-36): plain string constants, "-" not ":" separator (BullMQ rejects colons — comment at lines 10-13 explains why). Add new flow queue constants (e.g. `FLOW_RECONCILIATION_QUEUE = "flow-reconciliation"`, `FLOW_SEGMENT_SWEEP_QUEUE = "flow-segment-sweep"`) following this exact naming convention.

---

### Frontend: `apps/web/src/features/campaigns/` → `apps/web/src/features/flows/` (component, request-response)

**Analogs:**
- List page: `apps/web/src/features/campaigns/CampaignsListPage.tsx` (257 lines; read lines 1-70 above) — TanStack Query list fetch with `keepPreviousData`, per-row dropdown menu (Открыть/Дублировать/Удалить), delete-confirm `AlertDialog`, `isDeletable(status)` guard function. Mirror `isDeletable` → `isDeletableFlowStatus` (never-published or paused-with-zero-runs, per D-22).
- API client: `apps/web/src/features/campaigns/api.ts` (184 lines, read in full) — thin `apiGet`/`apiPost`/`apiPatch`/`apiDelete` wrappers per route, one function per endpoint, response interfaces hand-mirrored from the route's `toXResponse` shape (no shared-schemas response types exist for campaigns either — same will be true for flows).
- Publish/enroll confirmation dialog: `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx` — direct analog for the D-04 "enroll N existing contacts?" publish dialog (same UX shape: fetch a count, present a confirm/cancel choice, call a state-transition mutation).
- Send-settings page: `apps/web/src/features/campaigns/SendSettingsPage.tsx` — analog for the workspace default-timezone + default-quiet-hours settings UI addition (D-08/D-09).

**No analog:** the canvas editor itself (`FlowCanvas.tsx`, node/edge type components) — `@xyflow/react` is a brand-new library with no existing canvas precedent in this codebase; build fresh per the library's own documented node/edge API, following RESEARCH.md's Recommended Project Structure (`apps/web/src/features/flows/canvas/`).

## Shared Patterns

### Tenant context discipline in workers (project-wide Pitfall #5)
**Source:** `apps/worker/src/queues/send-dispatch.ts` line 278 (`return withTenant(workspaceId, async () => {...})`) and `campaign-scheduler.worker.ts` lines 69-87 (`withTenant(row.workspaceId, () => withTenantTransaction(...))`)
**Apply to:** every new worker file in `apps/worker/src/queues/flows/*.ts` — `workspaceId` always re-derived from job payload/row, never ambient; every DB call wrapped in `withTenant`/`withTenantTransaction`; the ONLY exception is the admin-scoped discovery scan (`pool.connect()` + `app.admin_scan` GUC), which must immediately re-scope per-row via `withTenant` before any write.

### RLS ENABLE+FORCE+NULLIF-guard on every new table
**Source:** `packages/db/migrations/0013_campaigns.sql` lines 33-40 + `0019_campaigns_workspace_isolation_nullif_guard.sql` lines 15-20
**Apply to:** `flows`, `flow_versions`, `flow_runs`, `flow_run_steps`, `flow_segment_membership_snapshot` — apply the NULLIF-guarded policy from the FIRST migration, not as a follow-up fix.

### Idempotent claim via DB-level UNIQUE + ON CONFLICT
**Source:** `packages/delivery-core/src/send-ledger.ts` (`dispatchSendGate`, referenced from `send-dispatch.ts` lines 210-226) and `sends.ts` line 60's `unique(...)` constraint
**Apply to:** `claimFlowSend`'s new partial unique index `sends_flow_run_node_unique` (RESEARCH.md Pattern 1) — the load-bearing idempotency guarantee for flow-step sends; also applicable to `flow_run_steps` insert-once-per-advance semantics.

### Restrict-when-referenced + two-layer conflict error
**Source:** `apps/api/src/modules/segments/segment.repository.ts` lines 37-45, 291-338 (`SegmentConflictError`, `deleteSegment`)
**Apply to:** segment delete extended to check flow references (D-24); same pattern reusable for "delete a flow that's referenced by nothing" checks (paused + zero active runs, D-22) and campaign-style state-error mapping in `flows.routes.ts`.

### Error-class-per-module + HTTP status mapper
**Source:** `apps/api/src/modules/campaigns/campaign.repository.ts` lines 60-76 (`CampaignStateError`) + `campaigns.routes.ts` lines 76-93 (`mapCampaignStateError`)
**Apply to:** `FlowStateError`/`mapFlowStateError` in `flow.repository.ts`/`flows.routes.ts`.

### Repeatable-scan + admin-discovery + tenant-rescoped-transition
**Source:** `apps/worker/src/queues/campaign-scheduler.worker.ts`, full file
**Apply to:** `flow-reconciliation.worker.ts` (delay/wait-until wake backstop) and `flow-segment-sweep.worker.ts` (D-02 periodic segment re-check) — both are structural clones of this file with different WHERE clauses/downstream actions.

### Three-unit transaction-boundary dispatch (claim / external call / record)
**Source:** `apps/worker/src/queues/send-dispatch.ts` lines 269-352
**Apply to:** the `kind === "flow"` branch added to `processSendJob`, and any new flow-send helper functions in `flow-send.ts` — never call SendGrid from inside a DB transaction, never skip the claim-first ordering.

### Role-gated state-transition routes (Owner/Admin only)
**Source:** `apps/api/src/modules/campaigns/campaigns.routes.ts` (`requirePermission` calls on launch/schedule/cancel routes) — grep `requirePermission` in that file for exact call sites if line-level detail is needed during implementation.
**Apply to:** publish/pause/resume/enroll-existing routes on `flows.routes.ts` (D-23); Member-level access remains for draft CRUD/duplicate.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `apps/web/src/features/flows/canvas/FlowCanvas.tsx` + node/edge type components | component | client-state (canvas editor) | No existing canvas/drag-drop UI in this codebase; `@xyflow/react` is this phase's first use of the library — build against its own docs/examples, not an internal analog. RESEARCH.md's Recommended Project Structure is the closest available guide. |
| `packages/delivery-core/src/quiet-hours.ts` (new, implied by D-08/D-09/D-10/D-11) | utility | transform (timezone/date math) | No existing timezone/date-math utility exists anywhere in the codebase today (project has zero date-library dependencies) — this is genuinely new logic built on native `Intl`, not an extension of prior art. |

## Metadata

**Analog search scope:** `apps/api/src/modules/{campaigns,segments}`, `apps/worker/src/queues`, `packages/db/src/schema`, `packages/db/migrations`, `packages/delivery-core/src`, `packages/segments-core/src`, `packages/shared-schemas/src`, `apps/web/src/features/campaigns`
**Files scanned:** ~45 (directory listings) + 12 read in full or targeted excerpt
**Pattern extraction date:** 2026-07-10
