# Phase 20: Campaign Template Correctness - Research

**Researched:** 2026-08-21
**Domain:** Optimistic concurrency control + client dirty-state tracking on an existing Fastify/React/BullMQ campaign send pipeline
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Dirty-state UX & blocking (TMPL-01)**
- **D-01:** Unsaved changes surface as a persistent amber banner near the actions («Есть несохранённые изменения…») plus disabled launch/schedule/test-send buttons with inline reason copy — reusing the existing `computeIncompleteReason` inline-copy pattern and the builder's amber Card style. No intercept dialogs.
- **D-02:** "Dirty" = ANY field differing from the saved row: template, sender, segment, or name. One mental model — «what you see is saved, or you can't send» — no two-tier dirty concept.
- **D-03:** The banner carries a one-click «Сохранить» button invoking the same save mutation as the builder's own «Сохранить черновик» (validation errors still surface in the form). No discard affordance.
- **D-04:** No navigation guard (no beforeunload / router blocker). TMPL-01 blocks send actions, not navigation; abandoning unsaved edits is harmless because the saved row stays authoritative.
- Builder form state must be lifted/shared so sibling components (TestSendPanel, LaunchScheduleActions) and the banner can see dirtiness — mechanism (lift state, context, or store) is planner's choice.

**Staleness token mechanism (TMPL-02)**
- **D-05:** New integer `campaigns.version` column (default 1), incremented on **every** campaign mutation — draft edits AND status transitions (launch/schedule/cancel). One uniform invariant: any write bumps. Chosen over `updated_at`-as-token and over echoing expected field values. — **Reversibility:** costly — the column ships in a migration and the version becomes part of the published API contract consumed by the web client.
- **D-06:** `expectedVersion` is a **required** field in the launch/schedule/test-send request bodies — a request without it is a 400. No optional-when-present soft mode. No If-Match header (novel pattern; every other contract rides the zod-validated JSON body).
- **D-07:** Version comparison happens server-side under the existing `FOR UPDATE` locked read-check-write transaction in the repository, alongside the status check. Mismatch → new `CampaignStateError` code `"version_conflict"` mapped to HTTP **409** with body `{ error, code: "version_conflict", currentVersion }`. Joins the existing `incomplete`/`illegal_transition` error family. Contract documented in SPECIFICATION.md §6 in the same change; the column in §4.

**Conflict presentation & recovery (TMPL-02 UX)**
- **D-08:** On `version_conflict` at launch/schedule the dialog STAYS OPEN, shows «Кампания была изменена — данные обновлены, проверьте и повторите», and the page refetches the campaign so the marketer re-confirms against fresh state. Never auto-retry with the fresh version.
- **D-09:** `illegal_transition` on launch/schedule (concurrent «already launched/canceled») also gets specific copy naming the real state + the same refetch pattern — one coherent stale-view recovery story replacing today's generic «Что-то пошло не так» for these codes.
- **D-10:** On conflict-triggered refetch, server wins: the embedded builder re-syncs to the fresh row (current `useEffect` behavior) and local unsaved edits are dropped with a notice. The saved row is the only truth this phase trusts.

**Test-send parity (TMPL-03)**
- **D-11:** Test-send takes the SAME `expectedVersion` precondition as launch/schedule → 409 `version_conflict` on mismatch. One uniform contract across all three paths.
- **D-12:** The test-send route snapshots the verified `templateId` (and the already-resolved `fromEmail`) into the `kind='test'` job payload at enqueue time; the dispatch worker sends exactly that for test sends instead of re-reading the row. Closes the async enqueue→dispatch gap where a save could swap the template under a queued test.

### Claude's Discretion
- State-sharing mechanism for dirtiness between builder and sibling components (lift to CampaignDetailPage, React context, or Zustand — follow existing app patterns).
- Conflict copy in TestSendPanel follows the same pattern as the dialogs — exact wording/placement at discretion.
- Test harness choices for SC2's three-path proof (integration vs Playwright), exact migration mechanics, zod schema details, error message texts, banner copy wording.
- Whether launch/schedule need payload changes beyond `expectedVersion` — launch/schedule are safe from the async gap by construction (version check + status flip in one locked transaction; non-draft rows are un-editable), so no snapshot needed there unless the planner finds otherwise. **Research finding: confirmed VERIFIED (see Architecture Patterns → Pattern 3) — no snapshot needed.**

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TMPL-01 | Маркетолог не может запустить, запланировать или отправить test-send кампании с несохранённым выбором шаблона — dirty state явно виден и блокирует действие до сохранения | Architecture Patterns #1 (dirty-state lift), existing `computeIncompleteReason`/amber-Card reuse identified in `LaunchScheduleDialogs.tsx`/`CampaignBuilderPage.tsx` |
| TMPL-02 | Launch и schedule выполняются только относительно подтверждённо сохранённой версии кампании; конкурентное или несохранённое изменение приводит к типизированному conflict без запуска отправки | Architecture Patterns #2 (version column + FOR UPDATE check), Pitfall #1 (sender-resolver bump race — critical), Common Pitfalls #2 (error-shape gap) |
| TMPL-03 | Test-send отправляет ровно тот шаблон, что подтверждённо сохранён в кампании — доказано тестом на все три send-пути | Architecture Patterns #3 (job-payload snapshot, back-compat additive field), Validation Architecture (integration test pattern with injected `sendMail` seam) |
</phase_requirements>

## Summary

This is a localized correctness fix on an already-built, well-tested campaign send pipeline — not new infrastructure. The fix has three parts that must ship together: (1) a frontend dirty-state tracker that blocks all three send actions until the campaign form matches the saved row, (2) a Postgres `version` column plus a required `expectedVersion` precondition checked inside the existing `FOR UPDATE` transactions on launch/schedule/test-send, and (3) a job-payload snapshot of `templateId`/`fromEmail` for test-sends only, closing the enqueue-to-dispatch race the bug report describes.

The single highest-risk finding from this research is **not** in CONTEXT.md: `resolveCampaignFromEmail` (the CR-02 sender-resolution helper used by all three launch/schedule/test-send routes) performs its own `UPDATE campaigns SET from_email = ...` in a **separate transaction, before** the launch/schedule/test-send repository function runs. If that write is made to bump `campaigns.version` under D-05's "any write bumps" invariant, every launch of a `fromSenderId`-based campaign (the primary, non-fallback sender-selection path) would self-trigger a spurious `version_conflict` on its very first attempt — the client's `expectedVersion` (read before the request) would already be stale by the time the locked check runs, through no fault of the marketer. This must be resolved by an explicit architectural choice at plan time (see Common Pitfalls #1); this document recommends folding sender resolution into the same locked transaction as the version check, so the version bumps at most once per request.

The rest of the work reuses established codebase patterns exactly: `CampaignStateError`'s typed-code family, the repository's locked read-check-write shape, the `emailBroadcastJobSchema` optional-additive-field convention already used for `requestId` (Phase 15/R-05), and the `app.inject()` + real-test-DB integration pattern already covering `campaigns.routes.ts`. No new external packages, no new libraries, and no novel HTTP mechanism (If-Match was explicitly rejected by the user) are needed.

**Primary recommendation:** Add `campaigns.version integer not null default 1`; check it inside a single locked transaction per action that also performs (and is the ONLY writer of) any related field sync (sender resolution) plus the actual mutation, so exactly one version bump happens per user-initiated write; snapshot `templateId`/`fromEmail` into the `kind='test'` job payload as new **optional** fields (no `schemaVersion` bump) so a rolling deploy's in-flight jobs still process; lift campaign form state to `CampaignDetailPage` (or a shared context) so the dirty banner and all three sibling action components read one source of truth.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Dirty-state detection & blocking (TMPL-01) | Browser / Client | — | Pure UI state comparison (form fields vs. last-saved query data); no server round-trip needed to know "have I saved my edits" |
| Staleness/version precondition enforcement (TMPL-02) | API / Backend | Database / Storage | The version check MUST be authoritative server-side (a client-only check is trivially bypassable); Postgres `FOR UPDATE` is the enforcement primitive |
| Version token propagation | Browser / Client | API / Backend | Client reads `version` from the campaign GET response and echoes it back verbatim in `expectedVersion` — no client-side computation, just a pass-through |
| Test-send template/sender pinning (TMPL-03) | API / Backend | — | Snapshot must be taken at enqueue time (route handler), before the async gap; the worker (dispatch tier) consumes the snapshot, never re-resolves |
| Conflict recovery UX (refetch + re-sync) | Browser / Client | — | Existing `useEffect` server-row sync in `CampaignBuilderPage` already implements "server wins"; TMPL-02 only needs to trigger a refetch on 409, not new sync logic |

## Standard Stack

No new libraries. This phase extends the existing stack in place:

| Component | Already in use | Role in this phase |
|-----------|-----------------|---------------------|
| Zod (`@mega-crm/shared-schemas`) | Yes (`campaign.ts`) | `expectedVersion: z.number().int().min(1)` added to `scheduleCampaignSchema`, `testSendCampaignSchema`, and a new (currently-empty) `launchCampaignSchema` |
| Drizzle ORM + drizzle-kit | Yes (`packages/db`) | New migration adding `campaigns.version integer not null default 1` |
| Fastify route + `CampaignStateError` typed-code family | Yes (`campaigns.routes.ts`, `campaign.repository.ts`) | New `"version_conflict"` code joins `not_found`/`illegal_transition`/`incomplete` |
| BullMQ job payload (`emailBroadcastJobSchema`) | Yes (`packages/shared-schemas/src/queues.ts`) | Two new **optional** fields (`templateId`, `fromEmail`) on the existing schema, no `schemaVersion` bump — mirrors the `requestId` precedent (Phase 15/R-05) |
| TanStack Query (`useQuery`/`useMutation`) | Yes (`apps/web`) | Dirty-state comparison reads from the same `campaignQuery.data` already fetched; conflict handling calls `queryClient.invalidateQueries` (existing pattern) |

**Version verification:** No new packages are installed — `npm view` verification is not applicable. All modified files already exist at their current versions per the project's own `package.json` (Fastify 5.9.x, Zod 4.4.x, Drizzle 0.45.x, BullMQ 5.79.x — see CLAUDE.md's Technology Stack section, unchanged by this phase).

**Installation:** None required.

## Package Legitimacy Audit

**Not applicable — no new external packages are introduced by this phase.** Every change is either a new Postgres column, a new Zod field on existing schemas, a new error code on an existing typed-error class, or new React state in existing components. No `npm install` step exists in this phase's implementation.

## Architecture Patterns

### System Architecture Diagram

```
Marketer's browser (CampaignDetailPage, draft view)
   │
   ├─ CampaignBuilderPage (name/segment/template/sender form state)
   │     │ lifts { formState, savedRow, isDirty } up (mechanism: discretion)
   │     ▼
   ├─ Dirty banner (D-01/D-02/D-03) ──────────┐
   ├─ TestSendPanel        (disabled if dirty)│  all three read the SAME
   ├─ LaunchScheduleActions(disabled if dirty)│  isDirty + campaign.version
   │                                          │
   ▼                                          ▼
[Save draft] ──PATCH /campaigns/:id──▶ updateCampaign() bumps version, returns fresh row
                                              │
                                    (query invalidated, campaign.version now current)
   │
[Launch/Schedule/Test-send] ──POST .../launch|schedule|test-send { expectedVersion }──▶
                                              │
                                   Fastify route: zod-validates body (expectedVersion required)
                                              │
                                   Repository: SELECT ... FOR UPDATE (locks row)
                                              │
                                   version === expectedVersion?  status legal?
                                        │no (version)      │no (status)      │yes
                                        ▼                  ▼                 ▼
                              409 version_conflict   409 illegal_transition  proceed:
                                (currentVersion)      (current status)       - resolve sender (if needed, same txn)
                                        │                  │                 - UPDATE row (status + version+1 [+from_email])
                                        │                  │                 - launch/schedule: enqueue kickoff (id-only)
                                        │                  │                 - test-send: enqueue with templateId+fromEmail SNAPSHOT
                                        ▼                  ▼                 ▼
                              Dialog stays open,   Dialog stays open,   BullMQ email-broadcast / campaign-kickoff queue
                              refetch campaign,    refetch campaign,          │
                              "изменена" copy      "{state}" copy             ▼
                                                                    Worker dispatch (send-dispatch.ts):
                                                                    - kind=campaign/flow: re-reads templateId/fromEmail from row (safe: row is locked/terminal by now)
                                                                    - kind=test: uses job.templateId/job.fromEmail if present, else falls back to row read (back-compat for in-flight jobs)
```

### Recommended Project Structure

No new files/folders — all changes land in existing modules:

```
apps/api/src/modules/campaigns/
├── campaigns.routes.ts        # zod-parse launch body (currently unparsed); map version_conflict -> 409
├── campaign.repository.ts     # version column read/check/bump inside launchCampaign/scheduleCampaign/updateCampaign/cancelCampaign
└── sender-resolver.ts         # CR-02: resolution call site moves inside the locked txn for launch/schedule (see Pitfall #1)

packages/db/src/schema/campaigns.ts   # + version: integer("version").notNull().default(1)
packages/db/migrations/00XX_campaigns_version.sql

packages/shared-schemas/src/
├── campaign.ts   # + expectedVersion on scheduleCampaignSchema/testSendCampaignSchema, new non-empty launchCampaignSchema
└── queues.ts     # + optional templateId/fromEmail on emailBroadcastJobSchema (additive, no schemaVersion bump)

apps/worker/src/queues/send-dispatch.ts   # kind='test' branch: prefer job.templateId/job.fromEmail, fallback to readSendPrereqs

apps/web/src/features/campaigns/
├── CampaignDetailPage.tsx       # owns/hosts lifted form state + dirty banner (or a context provider)
├── CampaignBuilderPage.tsx      # form state lifted out (or exposes it via a shared hook/context)
├── LaunchScheduleDialogs.tsx    # expectedVersion in launch/schedule mutations; version_conflict/illegal_transition copy + refetch
├── TestSendPanel.tsx            # expectedVersion in test-send mutation; same conflict copy pattern
└── api.ts                       # launchCampaign/scheduleCampaign/testSendCampaign gain expectedVersion param; CampaignResponse gains version
```

### Pattern 1: Dirty-state lift (TMPL-01)

**What:** A single boolean/derived value, computed by comparing live form fields (name, segmentId, templateId, fromSenderId) against the last-saved `CampaignResponse` from the campaign query — NOT against `fromEmail` (system-resolved, not marketer-edited; excluding it also avoids a false-dirty flash right after CR-02's sender resolution silently updates `fromEmail` server-side).

**When to use:** Computed once, shared by the banner, `TestSendPanel`, and `LaunchScheduleActions` — all three need the identical boolean, so it must live above all three in the component tree (`CampaignDetailPage`) or in a context/store that `CampaignBuilderPage` also writes to.

**Example (illustrative, not prescriptive on mechanism per CONTEXT.md discretion):**
```typescript
// Source: derived from existing CampaignBuilderPage.tsx field list (lines 96-99, 113-116)
function computeIsDirty(
  form: { name: string; segmentId: string | null; templateId: string | null; fromSenderId: string | null },
  saved: CampaignResponse
): boolean {
  return (
    form.name.trim() !== saved.name ||
    form.segmentId !== saved.segmentId ||
    form.templateId !== saved.templateId ||
    form.fromSenderId !== saved.fromSenderId
  );
}
```

**Reuse note:** `computeIncompleteReason` in `LaunchScheduleDialogs.tsx:272-277` is the existing sibling pattern for "why is the button disabled" inline copy — D-01 explicitly says the dirty banner reuses this shape (a function returning `string | null`, rendered as `<p className="text-sm text-destructive">`). The amber Card style already exists in `CampaignBuilderPage.tsx:180-186` for the "not draft" notice — reuse the exact class names (`border-amber-200 bg-amber-50`).

### Pattern 2: Version check inside the existing locked transaction (TMPL-02)

**What:** `campaign.repository.ts`'s `launchCampaign`/`scheduleCampaign` already do `SELECT ... FOR UPDATE` then branch on `existing.status`. The version check is one more branch in the SAME function, using the SAME locked row, before the `UPDATE`.

**When to use:** Every one of launch/schedule/test-send. Cancel bumps version too (D-05, "status transitions") but does NOT require `expectedVersion` from the client (D-06 names only launch/schedule/test-send; CONTEXT.md's own decisions never list cancel as needing the precondition).

**Example (illustrative, follows the existing file's exact style — comment style, error class, transaction shape from `campaign.repository.ts:214-243`):**
```typescript
// Extends launchCampaign() in campaign.repository.ts
export async function launchCampaign(id: string, expectedVersion: number): Promise<CampaignRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<CampaignRow>(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = rows[0];
    if (!existing) throw new CampaignStateError("Campaign not found", "not_found");
    if (existing.status !== "draft") {
      throw new CampaignStateError("Only a draft campaign can be launched", "illegal_transition");
    }
    // D-07: version check joins the existing status check, same locked row.
    if (existing.version !== expectedVersion) {
      throw new CampaignStateError("Campaign was modified", "version_conflict", existing.version);
    }
    if (!existing.templateId || !(existing.fromEmail || existing.fromSenderId) || !existing.segmentId) {
      throw new CampaignStateError("...", "incomplete");
    }
    const { rows: updated } = await client.query<CampaignRow>(
      `UPDATE campaigns SET status = 'sending', sending_started_at = now(),
         version = version + 1, updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [workspaceId, id]
    );
    return updated[0];
  });
}
```

`CampaignStateError` needs a `currentVersion?: number` carrier (constructor's third param) so the route can build `{ error, code: "version_conflict", currentVersion }` (D-07) without a second DB read.

### Pattern 3: CR-02 sender resolution folded into the version-checked transaction — CRITICAL, see Pitfall #1

**Verified today (send-dispatch.ts:630, campaign-kickoff.worker.ts, campaign-scheduler.worker.ts):** the dispatch worker and both fan-out workers re-derive `templateId`/`fromEmail` fresh from the `campaigns` row at their own dispatch/kickoff time — they never trust a value cached at enqueue time, and they only ever act on a row that is already locked into a terminal-for-editing status (`sending`/`scheduled`, both un-editable per `updateCampaign`'s `status !== 'draft'` guard). This confirms CONTEXT.md's discretion note as **VERIFIED, not assumed**: launch/schedule need **no** job-payload snapshot — only test-send does (D-12), because test-send is enqueued from a `draft` campaign, which remains editable while the job sits in the queue.

**What must change:** `resolveCampaignFromEmail` (`sender-resolver.ts`) currently does its own `UPDATE campaigns SET from_email = ...` in a SEPARATE `withTenantTransaction` call, invoked by the route handler BEFORE `launchCampaign`/`scheduleCampaign` run (`campaigns.routes.ts:308-313`, `:363-368`). See Common Pitfalls #1 for why this ordering is dangerous once `version` exists, and the recommended fix (resolve without persisting; persist once, inside the same locked transaction that checks+bumps version).

### Pattern 4: Job-payload snapshot, additive-optional convention (TMPL-03)

**What:** `emailBroadcastJobSchema` (`packages/shared-schemas/src/queues.ts:169-178`) gains two **optional** fields: `templateId: z.string().optional()`, `fromEmail: z.string().email().optional()`. The test-send route (`campaigns.routes.ts:478-489`) populates both at enqueue time from the already-resolved `campaign.templateId`/the value `resolveCampaignFromEmail` just returned. `send-dispatch.ts`'s `kind === "test"` branch (currently `readSendPrereqs` at line 630) prefers `job.templateId ?? prereqs.templateId` and `job.fromEmail ?? prereqs.fromEmail` — i.e., falls back to the current row-read behavior when the fields are absent, which is exactly what an in-flight job enqueued by pre-Phase-20 code (mid-rolling-deploy) will look like.

**Why additive-optional, not a `schemaVersion` bump:** `queues.ts`'s own doc comment on `requestId` (lines 156-167) documents this exact precedent and reasoning: a `schemaVersion` bump makes an old-code worker DEFER every new-shaped job during a rolling deploy window (the failure mode `sendReconcilerTickJobSchema`'s versioning exists to avoid on a *tick* payload, but is wrong here because there is no safe "try again next tick" for an already-enqueued send — deferring it would silently drop a queued test-send). An optional field an old worker never reads is invisible to it and the job still processes with the old (row-read) behavior.

**Example:**
```typescript
// packages/shared-schemas/src/queues.ts — extends emailBroadcastJobSchema
export const emailBroadcastJobSchema = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  kind: z.enum(["campaign", "test"]),
  contactId: z.string().uuid().optional(),
  testTo: z.string().email().optional(),
  testData: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string().optional(),
  // TMPL-03/D-12: snapshot of the confirmed-saved template/sender at
  // test-send enqueue time, additive-optional (same convention as
  // requestId above) -- an in-flight job from before this change has
  // neither field and the worker falls back to its current row-read.
  templateId: z.string().optional(),
  fromEmail: z.string().email().optional(),
});
```

### Anti-Patterns to Avoid

- **Checking `expectedVersion` in the route handler, before acquiring the lock:** a TOCTOU gap — another request could bump the version between the route's pre-check and the repository's `FOR UPDATE`. The check MUST happen inside the same locked transaction as the mutation (Pattern 2).
- **Bumping `version` from more than one write per user action:** if sender resolution and the status transition are two separate `UPDATE`s, `version` increments twice for one marketer click, and the version the client echoes back next time silently drifts from what the client's own read showed. Fold multi-field writes into one `UPDATE` per action (Pitfall #1).
- **Introducing a `schemaVersion` bump on `emailBroadcastJobSchema` for the new snapshot fields:** breaks the rolling-deploy contract the codebase has explicitly established (`requestId` precedent) — use additive-optional fields instead.
- **An `If-Match` header for the version precondition:** explicitly rejected by the user (D-06) — every other contract in this codebase is a zod-validated JSON body; a header-based precondition would be a novel, unprecedented pattern for one endpoint family.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| Optimistic concurrency / staleness detection | A custom diff/hash of campaign fields, a distributed lock, or an external "edit session" table | A single monotonically-incrementing integer column checked under `FOR UPDATE` | This is the textbook optimistic-locking pattern (same shape as JPA's `@Version`/Rails' `lock_version`) — the codebase already has the exact locking primitive (`FOR UPDATE`) in every repository function; adding one column and one comparison is strictly simpler and requires no new infrastructure |
| Cross-tab/cross-component "is the form dirty" signal | A pub/sub event bus or a new global store just for this one flag | Lift state to the common ancestor (`CampaignDetailPage`) or a scoped React context, per existing patterns in this codebase (Zustand is used for canvas/editor state elsewhere per CLAUDE.md, not introduced here unless the planner finds it genuinely simplifies 3-sibling sharing) | The dirty flag has exactly one producer (the builder form) and three consumers, all mounted together on one page — no cross-navigation or persistence requirement exists (D-04 explicitly rejects a navigation guard) |

**Key insight:** Every mechanism this phase needs (locked read-check-write, typed error codes, additive-optional job fields, TanStack Query refetch-on-error) already exists once elsewhere in this codebase for a structurally identical problem. The work is applying an established pattern four times, not inventing a new one — and the one place this phase's design deviates from "just reuse the existing shape" (three separate writes: resolve-sender, then check-version, then mutate) is precisely the place a spurious bug would be introduced (Pitfall #1).

## Common Pitfalls

### Pitfall 1: The CR-02 sender-resolution write races the version check it must not race — CRITICAL

**What goes wrong:** `campaigns.routes.ts`'s launch handler (lines 304-313) calls `getCampaign` (a plain read), then `resolveCampaignFromEmail` (which, if the campaign uses `fromSenderId`, performs its OWN `withTenantTransaction` write: `UPDATE campaigns SET from_email = ...`), and only THEN calls `launchCampaign(id)`. The schedule handler does the identical sequence (lines 363-368). If that intermediate `UPDATE` is made to bump `campaigns.version` (which D-05's literal wording, "incremented on every campaign mutation," would suggest it should), then by the time `launchCampaign`'s locked transaction reads the row, its `version` is already one higher than the `expectedVersion` value the client read and sent — a marketer who changed nothing gets a `version_conflict` on their very first click, on every campaign that uses the (primary, non-fallback) `fromSenderId` sender-selection path.

**Why it happens:** The version-bump requirement (D-05) and the pre-existing two-transaction sender-resolution flow (CR-02, built before this phase) were designed independently and were never reconciled against each other in CONTEXT.md — this is a genuine gap between two decisions, not a decision either explicitly makes.

**How to avoid:** Split resolution from persistence for launch/schedule:
1. Resolve the sender against SendGrid's API WITHOUT writing to the campaign row (call the SendGrid-facing part of `resolveCampaignFromEmail`, get back the matched email, do not persist yet) — do this OUTSIDE the lock, since holding `FOR UPDATE` across an HTTP call to SendGrid would be a serious lock-duration hazard.
2. Inside the SAME locked transaction that checks `version`/`status` and performs the launch/schedule `UPDATE`, also set `from_email` if it changed — one `UPDATE` statement, one `version + 1`, no intermediate write.
3. For test-send (no status transition, no persisted mutation needed at all per D-12 — the resolved email is snapshotted into the job payload, never written to the row for this path) — resolution can stay as a read-only computation; only persist `from_email` if some other campaign for the workspace still relies on a prior test-send having synced it (verify at plan time whether any code path depends on `from_email` being persisted by a test-send; if not, skip persistence entirely for test-send and the whole race disappears for that path).

**Explicitly reject the alternative** of "exempt system-derived writes (sender resolution) from bumping the version": CONTEXT.md's Specifics section states the user consistently chose "uniform and strict over clever and soft" for every micro-decision in this phase (any-field dirty, required-not-optional precondition, bump-on-every-mutation, test-send parity, snapshot-at-enqueue) — carving out an exception for one specific write is exactly the kind of "clever" asymmetry the discussion repeatedly avoided. Folding the write into one transaction (above) satisfies BOTH the uniform-bump invariant and correctness.

**Warning signs:** An integration test that saves a campaign with `fromSenderId` set, reads back `version`, then immediately calls `/launch` with that `version` as `expectedVersion` and gets a 409 instead of a successful launch. This exact scenario should be one of the phase's required tests regardless of which fix the plan picks — it is the single most important regression to prove.

### Pitfall 2: Error response bodies today carry no `code` field at all

**What goes wrong:** `mapCampaignStateError` (`campaigns.routes.ts:84-93`) returns `{ error: message }` for `illegal_transition`/`incomplete`/`not_found` — no `code` field ships in the JSON body today. D-07/D-08/D-09 all require the client to branch on `code === "version_conflict"` (and read `currentVersion`) and to give `illegal_transition` its own distinguishing copy. Both require the route to start emitting a `code` field it currently omits entirely, not just add one new case.

**Why it happens:** The existing error family predates any client-side need to distinguish error types programmatically — today the client only ever shows a generic `GENERIC_ERROR` string regardless of which `CampaignStateError` code fired (see `LaunchConfirmDialog`'s `onError: () => setServerError(GENERIC_ERROR)` in `LaunchScheduleDialogs.tsx:80`).

**How to avoid:** Widen `mapCampaignStateError`'s return body to include `code: err.code` for every branch (not just the new one), and widen `CampaignStateError` to carry an optional `currentVersion` set only for the `version_conflict` case. On the client, `ApiError.body` is already the parsed JSON (verified in `apps/web/src/lib/api.ts:6-15,42-51` — `apiFetch` throws `ApiError(status, message, body)` with `body` being the full parsed error JSON), so branching is `err instanceof ApiError && err.status === 409 && (err.body as { code？: string })?.code === "version_conflict"` — no change to the `api.ts` fetch wrapper itself is needed, only to what the server now includes in the body and how the mutation's `onError` reads it.

**Warning signs:** A conflict-handling test that asserts on `error.message` string content instead of `error.code` — brittle and exactly the kind of coupling D-08/D-09's "specific copy naming the real state" requirement is trying to move away from.

### Pitfall 3: The launch route today accepts and validates no request body at all

**What goes wrong:** `launchCampaignSchema = z.object({})` exists in `shared-schemas/src/campaign.ts:47-48` but `campaigns.routes.ts`'s launch handler (lines 295-337) never calls `.safeParse()` on it — the route reads only `request.params`. Once `expectedVersion` becomes required (D-06), the launch route needs its FIRST-EVER body validation step, mirroring the schedule/test-send routes' existing `parsed.success` pattern, not just a schema change with no route wiring.

**Why it happens:** Launch was originally "no body needed" (an action, not a resource update) — the schema was defined for symmetry but never wired up because there was nothing to validate.

**How to avoid:** Add the `parsed.success` check block to the launch route (copy the schedule route's shape at `campaigns.routes.ts:344-347` verbatim) and update `launchCampaignSchema` to require `expectedVersion`. Update the web client's `launchCampaign(slug, id, {})` call (`api.ts:83-85`, currently posts an empty object) to `launchCampaign(slug, id, { expectedVersion })`.

**Warning signs:** A frontend build error or a 400 on every launch attempt post-change if the client-side call site is missed — this is a two-sided contract change (D-06 already flags "both sides ship together" in CONTEXT.md's Integration Points).

### Pitfall 4: `updateCampaign` (draft PATCH) must also bump `version` — it is the most common write

**What goes wrong:** D-05 says "draft edits AND status transitions" both bump version — `updateCampaign` (`campaign.repository.ts:171-206`, the PATCH the builder's «Сохранить черновик» button calls) is the single most frequently executed write in this phase's scope and is easy to overlook since CONTEXT.md's Pattern 2 examples focus on launch/schedule/test-send.

**How to avoid:** Add `version = version + 1` to `updateCampaign`'s `UPDATE` statement too, and make sure the SAVED value the frontend compares dirtiness against, AND the value it will next send as `expectedVersion`, both come from this mutation's response (`toCampaignResponse` must include `version` in every response, not just launch/schedule/test-send's).

**Warning signs:** A marketer saves a draft, the page's cached `campaign.version` never updates (because the save mutation's response wasn't used to update the query cache, or `version` was left off `toCampaignResponse`), and their VERY NEXT launch attempt 409s against their own just-completed save.

## Code Examples

### Existing locked read-check-write shape (verified, `campaign.repository.ts:214-243`)
```typescript
// Source: apps/api/src/modules/campaigns/campaign.repository.ts (launchCampaign, current code)
export async function launchCampaign(id: string): Promise<CampaignRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<CampaignRow>(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = rows[0];
    if (!existing) throw new CampaignStateError("Campaign not found", "not_found");
    if (existing.status !== "draft") {
      throw new CampaignStateError("Only a draft campaign can be launched", "illegal_transition");
    }
    // ... incomplete check, then UPDATE ... this is where version check + bump slot in.
  });
}
```

### Existing integration-test harness (verified, `apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts:1-40`)
```typescript
// Source: apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts (current code)
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

describe("campaign routes (CAMP-01..05)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
  });
  // app.inject({ method: "POST", url: "/api/workspaces/:slug/campaigns/:id/launch", payload: {...} })
  // is the established pattern for SC2/SC3's three-path proof -- real Postgres, real
  // FOR UPDATE locking, no mocked repository layer.
});
```

## State of the Art

Not applicable — no external ecosystem shift is relevant here; this phase is entirely internal-codebase correctness work on infrastructure built in Phases 4-15 of this same project. No "old approach / current approach" industry table applies.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|----------------|
| A1 | Test-send's CR-02 sender resolution does not need to persist `from_email` to the campaign row at all (Pitfall #1, step 3) — only launch/schedule do | Pattern 3 / Pitfall 1 | If some other code path depends on a test-send having synced `from_email` (not found in this research's grep of call sites, but not exhaustively traced through every consumer), removing that persistence could leave `from_email` null for a campaign that only ever received test-sends before its first launch attempt — however, launch/schedule's OWN resolution call would still populate it at that point, so the risk is low and self-healing |
| A2 | No code path outside `apps/web/src/features/campaigns/` reads `CampaignResponse` and would break from the new `version` field being added (additive field, should be safe) | Standard Stack / Pattern 2 | Low — TypeScript structural typing means an added optional/required field on a response type is additive by default unless some consumer does an exact-shape check; no such check was found in the files read for this research |

**If this table is empty:** N/A — two low-risk assumptions logged above; both are verifiable by the planner with one additional grep (`grep -rn "from_email" apps/worker apps/api` for A1; `grep -rn "CampaignResponse" apps/web` for A2) before finalizing the plan if extra confidence is wanted.

## Open Questions (RESOLVED)

1. **RESOLVED — Should `updateCampaign` (draft PATCH) itself require `expectedVersion`?** → No, per D-06's explicit enumeration (launch/schedule/test-send only). Resolved in plan 20-02, «Resolved research questions» section.
   - What we know: D-06 explicitly names only launch/schedule/test-send as requiring the precondition. The draft PATCH is not in that list.
   - What's unclear: Two marketers editing the same draft concurrently could still silently clobber each other's field edits on PATCH (a pre-existing gap, not introduced by this phase) — this phase's scope is send-path correctness, not general draft-edit conflict resolution.
   - Recommendation: Out of scope per D-06's explicit enumeration; do not add `expectedVersion` to `updateCampaignSchema`. Flag as a known pre-existing gap only if the planner wants to note it for a future phase — do not silently expand this phase's scope to fix it.

2. **RESOLVED — Does test-send's sender resolution still need ANY persistence to `from_email`?** → Yes, kept as-is (rolling-deploy fallback for an old worker plus the sender-configured UI checks). Resolved in plan 20-03, «Resolved research questions» section.
   - What we know: D-12 snapshots the resolved email into the job payload, so the dispatch worker never needs to re-read `campaigns.from_email` for a test send.
   - What's unclear: Whether removing the persistence changes the audience-breakdown/launch-incomplete-fields UI logic, which checks `campaign.fromEmail` (`launchIncompleteFields` in `campaigns.routes.ts:68-74`) to decide whether the sender field shows as "missing."
   - Recommendation: Keep test-send's resolution persisting `from_email` as it does today (this is NOT what causes the version race — only launch/schedule's pre-transaction UPDATE does, because launch/schedule ALSO do a status-transition UPDATE moments later that checks the now-stale version). Confirm this at plan time by tracing whether skipping persistence changes any UI-visible "sender configured" check.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| PostgreSQL (dev DB) | New `campaigns.version` migration | ✓ | per project config | — |
| `drizzle-kit migrate` (dev) | Applying the migration locally | ✗ (known issue) | — | STATE.md documents `npm run db:migrate` hangs under Node v26 in this dev sandbox; migrations are proven via `npm run test:migrations` (vitest against a real test DB, `packages/db`) and applied to the dev DB by an alternate means already established in this project — the planner must NOT assume `db:migrate` works interactively here |
| Redis (BullMQ) | Test-send job payload change verification | ✓ (per STATE.md operational prerequisites) | `REDIS_URL=redis://localhost:6379` | — |

**Missing dependencies with no fallback:** None — the one gap (`db:migrate` hanging) has a documented, already-used fallback (`test:migrations` + alternate apply mechanism).

**Missing dependencies with fallback:** `drizzle-kit migrate` interactive run — use `test:migrations` for verification; apply via the project's already-established alternate method (see STATE.md "Operational prerequisites").

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.9 (both `apps/api` and `apps/web`) |
| Config file | Per-workspace `vitest.config.ts` (existing, no changes needed) |
| Quick run command | `npm run test -w apps/api -- campaigns` (or the equivalent path filter) |
| Full suite command | `npm run test -w apps/api && npm run test -w apps/web` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|---------------------|--------------|
| TMPL-01 | Dirty banner appears + all 3 actions disabled when a form field differs from saved row | component (Testing Library) | `npm run test -w apps/web -- CampaignDetailPage` or a new focused spec | ❌ new file needed (e.g. `apps/web/src/features/campaigns/__tests__/campaign-dirty-state.test.tsx`) |
| TMPL-02 | Launch/schedule with correct `expectedVersion` succeeds; with stale version → 409 `version_conflict`, no mail dispatched, no status change | integration (`app.inject` + real test DB, existing pattern in `campaigns-routes.test.ts`) | `npm run test -w apps/api -- campaigns-routes` (extend existing file) | ✅ existing file, extend |
| TMPL-02 | Concurrent launch of an already-`sending`/`canceled` campaign → 409 `illegal_transition` with new specific copy path | integration | same file | ✅ existing file, extend |
| TMPL-02 | The Pitfall #1 regression: save a `fromSenderId` campaign, read its `version`, launch with that exact version, expect success (not a spurious 409) | integration | same file — **this is the single most important new test in this phase** | ❌ new test case, existing file |
| TMPL-03 | Test-send after changing (but not saving) the template dropdown still sends the LAST SAVED template — reproduces the original bug on all 3 paths | integration, using the injected `sendMail`/`ProcessSendJobDeps` seam already established in `apps/worker/src/queues/__tests__/test-send-outcome.test.ts` | `npm run test -w apps/worker -- send-dispatch` (extend) or a new campaigns-routes case asserting the enqueued job's `templateId` field | ✅ existing seam/file, extend |

### Sampling Rate
- **Per task commit:** targeted `vitest run` filtered to the touched module (`campaigns`, `send-dispatch`, or the touched web component)
- **Per wave merge:** `npm run test -w apps/api && npm run test -w apps/worker && npm run test -w apps/web`
- **Phase gate:** Full suite green before `/gsd-verify-work`, plus `npm run test:migrations` for the new column

### Wave 0 Gaps
- [ ] A new focused component test file for the dirty-state banner/blocking (TMPL-01) — no existing file covers this UI concern
- [ ] Extend `campaigns-routes.test.ts` with the version-conflict, illegal-transition-copy-path, and (critically) the fromSenderId-launch-does-not-spuriously-409 cases
- [ ] Extend `send-dispatch.ts`'s test-send test coverage (or add a route-level assertion) proving the enqueued job payload's `templateId`/`fromEmail` match the SAVED row, not any value read after the job was queued

*(No framework install needed — Vitest and the `app.inject`/test-DB harness are already fully set up.)*

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|--------------------|
| V2 Authentication | no | Unchanged — existing session-cookie auth (`auth.api.getSession`) governs these routes already |
| V4 Access Control | already covered | Launch/schedule/cancel remain `requirePermission("campaign", "launch")`-gated (D-19, unchanged); test-send remains ordinary-member level (unchanged) — this phase adds no new authorization surface |
| V5 Input Validation | yes | `expectedVersion` must be `z.number().int().min(1)` (or similar), REQUIRED (not optional) per D-06 — a missing/malformed value is a 400, enforced by the existing zod-`safeParse`-then-400 pattern already used by every other route in this file |
| V6 Cryptography | no | Not touched by this phase |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| TOCTOU (check-then-act) on the send precondition — a marketer's stale UI submits a send action against a row that changed between page-load and click | Tampering (of intent, not of data — the marketer isn't malicious, but the mechanism must also resist a genuinely malicious concurrent actor) | Version check performed inside the SAME `FOR UPDATE`-locked transaction as the mutation (Pattern 2) — never a separate pre-check followed by an unlocked write |
| Silent send-on-stale-state (the ORIGINAL bug this phase fixes) — client-held form state diverges from the server's authoritative row and a send path trusts the client value | Tampering / Repudiation (a sent email the marketer never confirmed, with no record of what was actually confirmed) | No send path may read from client-supplied form values for template/sender/segment (D-06's "no fallback to local client form state," SC4) — every send path re-reads from the locked row (or, for test-send only, from the enqueue-time snapshot per D-12), never from the request body's own optimistic client state |

## Sources

### Primary (HIGH confidence — direct codebase reads, this session)
- `apps/api/src/modules/campaigns/campaigns.routes.ts` — full file read; launch/schedule/test-send route bodies, `mapCampaignStateError`, `resolveCampaignFromEmail` call sites and their sequencing relative to the state-transition calls
- `apps/api/src/modules/campaigns/campaign.repository.ts` — full file read; `CampaignStateError`, all locked read-check-write functions (`updateCampaign`, `launchCampaign`, `scheduleCampaign`, `cancelCampaign`)
- `apps/api/src/modules/campaigns/sender-resolver.ts` — full file read; confirmed the separate-transaction `UPDATE campaigns SET from_email` write that motivates Pitfall #1
- `packages/db/src/schema/campaigns.ts` — full file read; current column set, no `version` column yet
- `packages/db/migrations/0056_workspace_daily_rollup_dirtied_at.sql` — read for `ALTER TABLE ADD COLUMN` migration-file convention
- `packages/shared-schemas/src/campaign.ts` — full file read; current zod schemas for create/update/schedule/test-send, confirming `launchCampaignSchema` exists but is empty and unparsed
- `packages/shared-schemas/src/queues.ts` — full file read; `emailBroadcastJobSchema`/`emailTriggeredJobSchema`, and the documented `requestId` additive-optional-field precedent (Phase 15/R-05) this phase's job-snapshot fields should follow
- `apps/worker/src/queues/send-dispatch.ts` (relevant sections read: lines 84-260, 570-700) — confirmed `kind='test'` currently reads `templateId`/`fromEmail` via `readSendPrereqs` at dispatch time (the exact async gap D-12 closes)
- `apps/worker/src/queues/campaign-kickoff.worker.ts` — full file read; confirmed launch/schedule fan-out re-derives everything from the row, never trusts a payload snapshot
- `apps/worker/src/queues/campaign-scheduler.worker.ts` — full file read; confirmed `transitionToSending`'s own `FOR UPDATE SKIP LOCKED` re-verification and re-derive-from-row convention
- `apps/worker/src/queues/campaign-broadcast-producer.ts` — full file read; one-Queue-instance-per-process convention, confirms where `emailBroadcastJobSchema` changes propagate
- `apps/web/src/features/campaigns/CampaignDetailPage.tsx`, `CampaignBuilderPage.tsx`, `LaunchScheduleDialogs.tsx`, `TestSendPanel.tsx`, `api.ts` — full files read; current form-state shape, save mutation, `computeIncompleteReason` pattern, amber Card style, generic-error handling to be replaced
- `apps/web/src/lib/api.ts` — full file read; confirmed `ApiError.body` is the parsed JSON error body, so client-side `code`/`currentVersion` branching needs no fetch-wrapper change
- `apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts` — read header/setup; confirmed the `app.inject()` + `ensureTestDbMigrated` real-DB integration-test pattern already covering this route file
- `.planning/phases/20-campaign-template-correctness/20-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md` — read in full per task instructions

### Secondary (MEDIUM confidence)
None used — this research required no external documentation lookups; the entire domain is internal, already-established codebase pattern reuse.

### Tertiary (LOW confidence)
None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; every technology involved is already pinned and in use in this codebase
- Architecture: HIGH — every pattern cited was read directly from the current source files this session, not inferred from documentation or memory
- Pitfalls: HIGH — Pitfall #1 (the sender-resolver/version race) was discovered by direct code tracing (reading `sender-resolver.ts` and the route call-order), not assumed; it is a genuine gap between two independently-made decisions that the planner must explicitly resolve

**Research date:** 2026-08-21
**Valid until:** No expiry driver — this is a point-in-time snapshot of this codebase's own files; valid as long as the referenced files are unchanged by another concurrent phase (none currently in flight touch `campaigns.*` per STATE.md's phase map)
