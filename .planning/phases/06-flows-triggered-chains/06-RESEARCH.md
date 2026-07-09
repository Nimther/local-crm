# Phase 6: Flows (Triggered Chains) - Research

**Researched:** 2026-07-09
**Domain:** Visual workflow/automation engine (Klaviyo-style triggered flows) — canvas builder, durable state-machine execution, quiet hours/timezone, immutable versioning
**Confidence:** MEDIUM-HIGH (codebase-grounded findings HIGH; ecosystem/pattern claims MEDIUM, inherited from project-level STACK/ARCHITECTURE/PITFALLS research dated 2026-07-03)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Триггеры и вход (FLOW-02)**
- D-01: Event-trigger matches ONLY by event name (picker of observed workspace event names + free-text entry — Phase 3 D-05 pattern). Property filters on events are v2.
- D-02: "Contact entered segment" detection is a hybrid: (a) event-driven re-check of a changed contact (after event ingest / contact edit / status change) via `isContactInSegment`, PLUS (b) a periodic sweep-scan as insurance for time-based conditions ("hasn't opened in 90 days" becomes true with no contact mutation). Both mechanisms are built in this phase; a per-flow membership snapshot is maintained for segment triggers to diff against.
- D-03: One trigger node per flow: event OR segment-entry. Both paths are needed — build two separate flows. Simplifies re-entry accounting, versioning, and canvas validation.
- D-04: Publishing a segment-triggered flow asks: "enroll N contacts already in the segment?" — yes (batch-enroll, respecting re-entry/frequency-cap/quiet-hours) or no (only new entries; existing contacts marked "seen" in the snapshot without enrollment).
- D-05: Unsubscribed/suppressed contacts DO enter the flow and proceed through it; their emails are filtered by the existing pre-send gate (recorded as excluded in the ledger). Re-subscribing mid-flow means subsequent emails resume. No second subscription check at entry.

**Re-entry control (FLOW-04)**
- D-06: "Once per N days" is counted from the contact's LAST ENTRY into the flow (Klaviyo model; stored as a last-entry timestamp per contact×flow).
- D-07: Maximum ONE active run per contact×flow pair. A trigger firing while a run is active is ignored (not enqueued) — protects against interleaved sequences. This rule applies on top of all three re-entry modes.

**Delays and quiet hours (FLOW-05)**
- D-08: Timezone source for quiet hours: PER-CONTACT timezone — a new standard contact field `timezone` (IANA name, validated; settable via UI/CSV-mapping/API), with fallback to a new workspace-level "default timezone" setting (in send settings). Both layers are built in this phase. (User consciously chose per-contact over workspace-only, revisiting Phase 4 D-06's default for flows specifically.)
- D-09: Quiet hours are configured at the workspace level (default window in send settings) with a per-flow override: a flow can override the window or disable quiet hours entirely.
- D-10: Deferred quiet-hours emails are released all at once when the window ends; smoothing is handled by the existing per-tenant token bucket + triggered lane — no new jitter mechanism.
- D-11: Delay node has two kinds: fixed duration (N minutes/hours/days) AND wait-until ("until next 10:00", "until Monday") — wait-until is computed using the same timezone logic as quiet hours (contact TZ → workspace fallback). DST math is the planner's/researcher's responsibility.

**Branching and exit (FLOW-01, FLOW-03)**
- D-12: Conditional branch checks ONLY segment membership ("is contact ∈ segment X right now?") via `isContactInSegment` — one condition vocabulary for the whole platform (segments already express attributes, tags, and behavior). Inline canvas conditions and "opened previous email" checks are NOT in v1 (deferred).
- D-13: Branch is binary: exactly two outgoing edges (yes/no). Multi-way is composed via chained conditions.
- D-14: Exit conditions are evaluated at STEP BOUNDARIES: when a run wakes to act — after a delay elapses, before a send — exit conditions are checked first. A purchase mid-delay exits the contact at the moment the delay ends, BEFORE the email sends. There is no continuous event-driven exit watcher.
- D-15: Exit conditions come in two kinds, configured at the flow level: (a) segment-based — "contact is in segment X" / "contact is no longer in segment X"; (b) event-based — "event {name} occurred after run entry" (checked against the events table with occurred_at > run started_at). Explicit exit NODES on branches (FLOW-01) are a separate thing: simply end-of-path markers.
- D-16: Send node is configured like campaigns: Dynamic Template from the tenant account's list (Phase 4 D-16), verified sender (D-17), the standard documented `dynamic_template_data` shape (D-18). No per-node variable mapping.
- D-17: Strict publish-time validation, blocking ONLY hard errors: no trigger, empty send node (no template/sender), a branch not ending in an exit node. Extended linting (dead branches, orphan nodes) is v2 (FLOW-V2-02).

**Lifecycle and versioning (FLOW-06, FLOW-07)**
- D-18: Pause = full freeze: no new entries, no step execution — expired timers are held, sends are stopped. Resume continues everyone from the same place.
- D-19: On resume, steps that became due during the pause execute IMMEDIATELY (smoothing via the token bucket; quiet hours are still honored at dispatch). Late — but never skipped; no silent-skip heuristics.
- D-20: Live-flow editing model: a single working draft, auto-created from the live version on first edit. Publish atomically makes the draft the new live version; new entries follow it, in-flight runs continue on the version they entered. Explicit version-list UI (view/rollback versions) is NOT in v1; immutable versions live at the storage layer.
- D-21: Version visibility: the flow page shows "N contacts in flow (M on old versions)." The only intervention is "remove contact from flow" (eject, single or bulk). There is NO migration of runs between versions — FLOW-07 exists precisely to avoid that.
- D-22: No terminal state in v1: "stop forever" = pause. Deletion is only possible for never-published flows and paused flows with zero active runs. Archive/cleanup UX comes later.
- D-23: Publish/pause/resume/enroll-existing are Owner/Admin only; Member creates and edits drafts (mirrors the campaign role matrix, Phase 4). "Duplicate flow" exists: the copy becomes a new draft with all nodes (mirrors campaign D-11).
- D-24: Deleting a segment referenced by a flow (trigger, branch, or exit) is BLOCKED: restrict-when-referenced, same pattern/error-mapping as campaigns (Phase 4 04-05, 23503 → conflict).

### Claude's Discretion
- Storage schema for flow definition (nodes/edges JSON), versions/runs/steps tables; RLS ENABLE+FORCE per the Phase 1-5 pattern; tenant context in workers (PITFALLS #5) — mandatory.
- Execution-engine mechanics: BullMQ delayed jobs vs. periodic scheduler-scan for delay expiry (ROADMAP 06-04 calls out a reconciliation scan — restart durability is mandatory); step idempotency (a retried job must not send an email twice — send-ledger pattern); jobId format.
- Sweep-scan interval for segment triggers (D-02) and its load; membership snapshot structure; enroll-existing (D-04) batching for large segments (engine's 15s statement_timeout — coordinate with the benchmark flag in STATE.md).
- How a frequency-capped flow email is handled — skip like broadcast (Phase 4 D-14) or defer; Phase 4 marked deferral as "Phase 6's territory" — decide during research/planning considering flow semantics.
- Canvas UX details (node palette, layout, autosave, zoom/minimap) — the UI-SPEC will come from `/gsd-ui-phase` (ui_phase: yes); Russian UI copy in the Phase 2-5 style.
- IANA timezone validation (list/library), contact and workspace timezone-picker UI.
- Frontend flow-feature structure (features/flows mirroring campaigns/segments), flow list page, flow detail page (canvas + status + run counters).
- What to show about runs in this phase (minimum: active/old-version counters + eject) — detailed per-step analytics is Phase 7 (ANLT-02).

### Deferred Ideas (OUT OF SCOPE for this phase)
- Property filters on event triggers ("order where amount > 100") — v2, alongside segment property filters (Phase 3 D-07, EVNT-V2-01)
- Branch condition "opened/clicked previous flow email" (flow-local email-engagement checks) — v2; requires a second condition source on top of segments
- Inline canvas conditions (without a saved segment) — v2
- Multi-way switch branch (N branches from one node) — v2; v1 composes via binary branches
- Explicit version-list UI (history, rollback, branch from an old version) — v2; versioned storage already exists in v1 (D-20)
- Terminal "stopped"/archived flow state — v2 (D-22)
- Bulk action "end all runs on old versions" — v2; emergency case is covered by pause + eject (D-21)
- Continuous (event-driven) real-time exit evaluation — v2; v1 checks at step boundaries (D-14)
- Deferred sending of frequency-capped emails — remains an open discretion question for this phase if research doesn't resolve it otherwise (Phase 4 D-14 marked it "Phase 6's territory")
- A/B branches in flows — v2 (FLOW-V2-01, already in REQUIREMENTS.md)
- Canvas linting (dead branches, orphan nodes) — v2 (FLOW-V2-02); v1 blocks only hard errors (D-17)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-------------------|
| FLOW-01 | Visual canvas builder: trigger, delay/wait, conditional branch, send-email, explicit exit/end nodes per branch | `@xyflow/react` stack entry, Recommended Project Structure (`packages/flows-core`, canvas feature folder), Pattern 3 (version-pinned storage), Pitfall 3 (server-side publish validation) |
| FLOW-02 | Flow triggered by event or by contact entering a segment | D-01/D-02/D-03 constraints above; Pattern 1 (extends `isContactInSegment`); Common Pitfall 1 (sweep-scan cost) and Open Question 2 (enroll-existing batching) |
| FLOW-03 | User-defined exit conditions — contact leaves the flow when a condition occurs | D-14/D-15 constraints; Architecture diagram's `flow-run-advance.worker.ts` step-boundary exit check; Pitfall 4 (evaluate at dispatch/action time, not schedule time) |
| FLOW-04 | Re-entry control: once-ever / once-per-N-days / every-time | D-06/D-07 constraints; Validation Architecture test map row for FLOW-04 |
| FLOW-05 | Quiet hours — emails not sent in the quiet window, deferred until it ends | D-08/D-09/D-10/D-11 constraints; native `Intl` timezone approach (Standard Stack, Don't Hand-Roll); Pitfall 4 |
| FLOW-06 | State machine: draft → live → paused; edits go into a draft, applied on publish | D-18/D-19/D-20/D-23 constraints; Pattern 3 (version pinning); flow.repository.ts structure |
| FLOW-07 | Published version is immutable: in-flight contacts continue on their entry version, edits don't break them | D-20/D-21 constraints; Pattern 3 (version-pinned execution) — the central architectural guarantee this phase must implement; ARCHITECTURE.md Pitfall 9 (project-level research, independently converges on the same design) |
</phase_requirements>

## Summary

This phase builds the flow builder, trigger evaluator, and execution engine on top of an already-mature send pipeline (Phases 4-5): the `email-triggered` BullMQ queue, `processSendJob`, the shared `sends` ledger, `evaluatePreSendGate`, and the unified segment engine (`isContactInSegment`/`compileSegmentDefinition`) are all real, working code today — not aspirational research. The single most important finding from reading that code (not just the prior STACK/ARCHITECTURE/PITFALLS research) is that **`processSendJob`'s idempotency and dispatch machinery is hard-coded to the campaign concept** and cannot be reused unmodified for flow-step sends: `dispatchSendGate`'s `ON CONFLICT (workspace_id, campaign_id, contact_id)` requires a non-null `campaign_id`, and `emailTriggeredJobSchema` currently requires a `campaignId` UUID with no `flowRunId`/`nodeId` fields. Phase 6 must extend the send ledger and job schema with a parallel flow-shaped path (new nullable `flow_run_id`/`node_id` columns, a new partial unique index, a `claimFlowSend` sibling to `claimCampaignSend`) while still routing through the exact same queue, rate limiter, and pre-send gate.

The second load-bearing finding: segments in this codebase are evaluated **on-the-fly** (SQL compiled per-call via `compileSegmentDefinition`, bounded by a `statement_timeout`, not a materialized `segment_memberships` table as the general ARCHITECTURE.md research suggested before Phase 3 was built). The periodic sweep-scan for segment-trigger re-evaluation (D-02) must therefore call `isContactInSegment` per-contact-per-segment-per-tick, which is only safe at scale if scoped carefully (batch size, tick interval, workspace fan-out) — this is a genuine open risk to flag for the planner, not a solved problem.

Everything else — durable timers (Postgres row + BullMQ delayed job + reconciliation scan), immutable version pinning per run, RLS ENABLE+FORCE on every new table, `withTenant`/`withTenantTransaction` discipline in workers, and native `Intl.supportedValuesOf('timeZone')` for IANA validation (no new npm dependency needed) — has a direct, provable precedent already in this codebase.

**Primary recommendation:** Build flows as five new tables (`flows`, `flow_versions`, `flow_runs`, `flow_run_steps`, plus a segment-trigger `flow_segment_membership_snapshot`) driven by a `campaign-scheduler.worker.ts`-style repeatable reconciliation scan (not naive BullMQ delayed jobs alone), and extend — never fork — `sends`/`processSendJob`/`isContactInSegment` for the actual send/condition evaluation work.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Canvas editor (drag-drop nodes/edges, draft autosave) | Browser / Client | Frontend Server (SSR: none, this is a SPA) | `@xyflow/react` owns all pan/zoom/node-drag interaction client-side; draft state is client-authored, persisted via API only on save |
| Flow definition storage + versioning | API / Backend | Database / Storage | `flows`/`flow_versions` tables; publish is a backend transaction, not a client action |
| Trigger evaluation (event match, segment-entry detection) | API / Backend (worker) | Database / Storage | Runs in `apps/worker`, re-using `isContactInSegment`/`events` table; never in the browser or API request path |
| Execution engine (state machine, delays, branches, exits) | API / Backend (worker) | Database / Storage | `flow_runs`/`flow_run_steps` are the durable state; workers advance them, Postgres is the timer per Anti-Pattern 1 in ARCHITECTURE.md |
| Quiet hours / timezone resolution | API / Backend (worker, at dispatch) | Database / Storage (contact.timezone, workspace settings) | Must be evaluated at actual dispatch time, not schedule time (Pitfall 6) |
| Send dispatch (SendGrid call) | API / Backend (worker) | — | Delegates to the existing `email-triggered` queue + `processSendJob`, extended for `kind: "flow"` |
| Publish-time validation (hard errors) | API / Backend | Browser / Client (surfacing) | Server is the authority on "can this be published"; canvas only renders the resulting errors |
| Flow list / detail / run-counter UI | Browser / Client | API / Backend (read endpoints) | Standard TanStack Query read-model consumption, mirrors `features/campaigns` |

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `@xyflow/react` | npm | Actively maintained project since 2019 (xyflow/React Flow rebrand); **latest patch published 2026-07-06** (3 days before this research) | 7,564,052/week | github.com/xyflow/xyflow | `SUS` (automated gate reason: `too-new` — triggered by the *patch version's* publish date, not the package's overall history) | **Approved with note** — already a locked project decision (CLAUDE.md "What NOT to Use", ROADMAP, and this phase's own CONTEXT.md fix this exact package). The automated legitimacy gate flags recency of the *latest release*, not package age; 7.5M weekly downloads and an established GitHub org make a slopsquat/hallucination explanation implausible. Per protocol, the planner MUST still insert a `checkpoint:human-verify` task before the `npm install @xyflow/react` step in 06-02, confirming the installed version resolves to `xyflow/xyflow`'s real registry entry (`npm view @xyflow/react repository.url`) before merging. |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** `@xyflow/react` — see disposition above; checkpoint required despite the package being an existing locked stack decision.

No other new external packages are required for this phase — see "Don't Hand-Roll" and "State of the Art" below for why a timezone library is unnecessary.

## Standard Stack

### Core (already installed, reused unmodified)

| Library | Version (verified in this repo) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `bullmq` | 5.79.1 (apps/api, apps/worker) — 5.79.3 current on npm `[VERIFIED: npm registry]` | Job queue backend for the reconciliation-scan tick queue and the existing `email-triggered` queue | Already the project's queue; Phase 6 adds zero new queue infra concepts beyond a `campaign-scheduler.worker.ts`-shaped tick |
| `ioredis` | 5.11.0 | Redis client under BullMQ + the per-tenant rate limiter | Unchanged from Phase 4 |
| `pg` | 8.22.0 | Postgres driver, `withTenantTransaction` | Unchanged |
| `drizzle-orm` | 0.45.2 | Schema type-inference for new tables | Unchanged; hand-written SQL migrations remain the source of truth for RLS/partitioning per existing convention (see `events.ts`'s own comment) |
| `zod` | 4.4.3 | Job schemas (`shared-schemas`), flow-definition schema validation | Unchanged |

### New for this phase

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|-------------|
| `@xyflow/react` | 12.11.2 `[VERIFIED: npm registry, cross-checked against project CLAUDE.md/STACK.md]` | Canvas node/edge editor (06-02) | Purpose-built for exactly this UI; explicitly the reason TS/React was chosen for this project (PROJECT.md) |

### Supporting (no install needed — native platform capability)

| Capability | Mechanism | When to Use |
|------------|-----------|-------------|
| IANA timezone validation (D-08) | `Intl.supportedValuesOf('timeZone')` (Node 22+, confirmed working on this repo's runtime: 418 zones returned) for the picker list; `new Intl.DateTimeFormat('en-US', { timeZone })` throws `RangeError` on an invalid zone for validation | Validating `contacts.timezone` on write (API + CSV import + property registry), and computing wait-until/quiet-hours math without a third-party date library |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Native `Intl` for timezone validation/math | `luxon` or `date-fns-tz` | A dedicated date library adds nicer DST-aware arithmetic helpers (`plus({ days: 1 })` style), but this project has zero date-library dependency today and native `Intl.DateTimeFormat` + `Temporal`-adjacent math (or simple UTC-offset diffing via `Intl.DateTimeFormat().formatToParts()`) is sufficient for "is now inside quiet-hours window" and "next occurrence of 10:00 local time" — both bounded, well-known DST edge cases. Reconsider `luxon` only if wait-until node logic (D-11) grows genuinely complex (e.g. recurring "every Monday" style rules beyond MVP scope). |
| BullMQ delayed jobs as primary timer | A dedicated workflow engine (Temporal, Inngest) | Massive overkill for this project's scale and adds an entirely new operational dependency; the existing Postgres-as-truth + BullMQ-as-doorbell + reconciliation-scan pattern (already proven in `campaign-scheduler.worker.ts`) directly satisfies the durability requirement without new infrastructure. |
| Reusing `processSendJob`'s campaign claim path as-is | Building a fully separate flow-send dispatch worker/queue | Rejected: this would violate the project's own architecture guarantee (single throttled dispatch path is what makes "broadcast never starves triggered" and per-tenant RPS enforceable in one place — ARCHITECTURE.md Pattern 2/Anti-Pattern 3). Extend the shared path with a `kind: "flow"` branch instead. |

**Installation:**
```bash
npm install @xyflow/react -w apps/web
```

**Version verification:** confirmed via `npm view @xyflow/react version` → `12.11.2`, and `npm view bullmq version` → `5.79.3` (repo pins `5.79.1`, compatible minor). No other new packages required.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│ BROWSER (apps/web)                                                    │
│  Canvas editor (@xyflow/react) ── draft autosave ──┐                  │
│  Flow list / detail page ── publish/pause/resume ──┤                  │
└─────────────────────────────────────────────────────┼─────────────────┘
                                                        │ HTTP (Fastify routes)
┌───────────────────────────────────────────────────────▼─────────────────┐
│ API (apps/api) — apps/api/src/modules/flows/ (NEW)                       │
│  - CRUD draft nodes/edges                                                │
│  - publish (validate hard errors D-17, snapshot -> flow_versions)        │
│  - pause/resume/duplicate/enroll-existing-dialog count                   │
│  - restrict-delete-when-referenced-by-flow (extends segment/campaign     │
│    pattern D-24)                                                         │
└───────────────────────────────────────────────────────┬─────────────────┘
                                                          │ writes flows/flow_versions
┌───────────────────────────────────────────────────────▼─────────────────┐
│ POSTGRES (source of truth)                                                │
│  flows │ flow_versions │ flow_runs │ flow_run_steps │                     │
│  flow_segment_membership_snapshot │ contacts.timezone (NEW column) │       │
│  workspace_send_settings.{default_timezone,quiet_hours} (NEW columns) │    │
│  sends.{flow_run_id, node_id} (NEW nullable columns + partial unique idx) │
└───────┬─────────────────────────────────────────────────────┬───────────┘
        │ read by trigger evaluator + reconciliation scan     │ read/write by dispatch
┌───────▼─────────────────────────────────────────────────────▼───────────┐
│ WORKER (apps/worker) — apps/worker/src/queues/flows/ (NEW)                │
│                                                                            │
│  events-ingest.worker.ts (EXISTING, extended)                             │
│    └─> after upserting event: enqueue flow-event-trigger-check job        │
│                                                                            │
│  flow-trigger-evaluator.worker.ts (NEW)                                   │
│    ├─ event trigger: match event.name against active flow_versions        │
│    └─ segment trigger: diff flow_segment_membership_snapshot on           │
│       contact-changed events (event-driven re-check, D-02a)               │
│    -> entry rules (re-entry D-06/D-07, quiet hours, frequency cap N/A     │
│       here -- checked at send time) -> INSERT flow_runs                   │
│                                                                            │
│  flow-segment-sweep.worker.ts (NEW, repeatable tick,                      │
│    campaign-scheduler.worker.ts pattern)                                  │
│    -> periodic sweep for time-based segment truths (D-02b)                │
│                                                                            │
│  flow-reconciliation.worker.ts (NEW, repeatable tick)                     │
│    -> scans flow_runs WHERE status='waiting' AND next_wake_at<=now()      │
│    -> durability backstop if a BullMQ delayed "wake" job is lost           │
│                                                                            │
│  flow-run-advance.worker.ts (NEW)                                        │
│    -> loads flow_runs row + PINNED flow_versions.definition (FLOW-07)      │
│    -> executes current node: delay/wait, branch (isContactInSegment/      │
│       events-since-entry), send, exit                                     │
│    -> send node: claimFlowSend (NEW, sibling of claimCampaignSend)         │
│       -> enqueues onto EXISTING email-triggered queue                     │
│       -> processSendJob (EXTENDED: kind:"flow" branch)                    │
│    -> quiet hours checked HERE (dispatch time), contact TZ -> workspace   │
│       default fallback (D-08/D-09)                                       │
│    -> advances flow_runs.current_node_id + records flow_run_steps in the  │
│       SAME transaction as marking the step done (Pitfall 1)               │
└────────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
apps/api/src/modules/flows/
├── flow.repository.ts          # CRUD, publish/pause/resume/duplicate, restrict-delete
├── flow-version.repository.ts  # immutable version snapshot read/write
├── flow-run.repository.ts      # run counters, eject, "N in flow (M on old versions)"
├── flow-validation.ts          # D-17 publish-time hard-error checks
└── flows.routes.ts             # Fastify routes, Owner/Admin gating (TENANT-03/D-23)

packages/flows-core/            # NEW shared package (mirrors segments-core)
├── flow-definition-schema.ts   # Zod schema for nodes/edges JSON (shared FE/BE)
├── flow-validate.ts            # pure validation logic (no-trigger, empty-send, no-exit)
└── flow-condition.ts           # branch/exit condition evaluation contract wrapping isContactInSegment

apps/worker/src/queues/flows/
├── flow-trigger-evaluator.worker.ts
├── flow-segment-sweep.worker.ts     # D-02 periodic sweep
├── flow-reconciliation.worker.ts    # D-11/durability backstop, mirrors campaign-scheduler pattern
├── flow-run-advance.worker.ts       # the state-machine step executor
└── flow-send.ts                    # claimFlowSend + recordFlowStepResult, sibling of send-dispatch.ts internals

packages/delivery-core/src/
└── send-ledger.ts   # EXTENDED: claimFlowSend, recordFlowStepResult alongside existing campaign functions

apps/web/src/features/flows/      # mirrors features/campaigns
├── canvas/                        # @xyflow/react node types, edge types, palette
├── list/
├── detail/
└── api.ts                         # TanStack Query hooks
```

### Structure Rationale

- **`packages/flows-core` as a new shared package**, not inline in `apps/api`: mirrors the existing `segments-core` precedent exactly (a pure, side-effect-free compiler/validator package consumed by both the API repository layer and, if needed, tests) — keeps the publish-time validation logic (D-17) unit-testable without a database.
- **`apps/worker/src/queues/flows/` as a subdirectory**, not flat files alongside existing workers: five new worker files is enough to warrant a subfolder; existing `apps/worker/src/queues/*.ts` stays flat because it only has one file per queue today. This is a naming/organization choice, not a hard requirement — the planner may flatten if the team's existing convention (flat) is preferred for consistency; note either way in the plan.
- **`send-dispatch.ts` and `send-ledger.ts` are EXTENDED, not forked**: this is the single most important structural decision from this research — see Pattern 1 below.

### Pattern 1: Extend the send ledger for flow-step sends — do not fork the dispatch path

**What:** `sends.campaign_id` is nullable and the code comment in `packages/db/src/schema/sends.ts` already anticipates this phase ("Phase 6 flow-triggered sends can share this same ledger table"), but the actual idempotency mechanism (`dispatchSendGate`'s `ON CONFLICT (workspace_id, campaign_id, contact_id)`) silently stops providing any duplicate-send protection when `campaign_id` is `NULL` — Postgres does not consider two `NULL`s equal for uniqueness purposes, so `ON CONFLICT` on that constraint never fires for a flow send, and a redelivered BullMQ job WOULD double-send. This is a real gap, not a hypothetical one — verified by reading `send-ledger.ts` directly (not from prior training-derived research).

**When to use:** Any Phase 6 send-node execution.

**Required extension (this phase's own design work, not yet built):**
1. Add nullable `flow_run_id uuid REFERENCES flow_runs(id)` and `node_id text` columns to `sends`.
2. Add a second partial unique index: `CREATE UNIQUE INDEX sends_flow_run_node_unique ON sends (workspace_id, flow_run_id, node_id) WHERE kind = 'flow'` (partial, so it doesn't collide with the existing campaign unique constraint's shape, and so campaign/test rows with `flow_run_id IS NULL` never contend for uniqueness on this index).
3. Add a `claimFlowSend(client, { workspaceId, flowRunId, nodeId, contactId })` sibling to `claimCampaignSend` in `send-dispatch.ts`, using `ON CONFLICT (workspace_id, flow_run_id, node_id) DO NOTHING` against the new index, returning the same `ClaimResult` shape.
4. Add `kind: "flow"` to `emailTriggeredJobSchema` (packages/shared-schemas/src/queues.ts) with `flowRunId`/`nodeId` required and `campaignId` no longer required for this kind (the current schema makes `campaignId` a required uuid for every kind — this must become conditional per `kind`, e.g. a Zod discriminated union).
5. `processSendJob`'s `kind === "campaign"` branch reads template/sender from the `campaigns` table (`readSendPrereqs`); the new `kind === "flow"` branch must instead resolve template/sender from the send-node's config, persisted on the pinned `flow_versions.definition` (D-16 — reuses the campaign send-node config shape: Dynamic Template id + verified sender, no per-node variable mapping).
6. `incrementCampaignSendCounter`/`tryCompleteCampaign` are campaign-specific (they mutate a `campaigns` row) — flows need an equivalent `recordFlowStepResult` that, in the SAME transaction, marks the `sends` row terminal AND advances `flow_runs.current_node_id`/`next_wake_at` AND appends to `flow_run_steps` (this is the concrete implementation of Pitfall 1's idempotency requirement: state advance and send-terminal-record must be one transaction).

**Trade-offs:** More code paths inside `send-dispatch.ts`/`send-ledger.ts` than a from-scratch flow-only dispatcher, but this is the ONLY way to keep the pre-send gate, per-tenant token bucket, and priority-lane guarantee centralized (ARCHITECTURE.md Pattern 2/Anti-Pattern 3) — forking would silently reintroduce the exact "two rate limiters" bug the project already avoided once.

**Example (schema delta, illustrative):**
```sql
-- packages/db/migrations/00XX_sends_flow_columns.sql
ALTER TABLE sends ADD COLUMN flow_run_id uuid REFERENCES flow_runs(id) ON DELETE CASCADE;
ALTER TABLE sends ADD COLUMN node_id text;
CREATE UNIQUE INDEX sends_flow_run_node_unique
  ON sends (workspace_id, flow_run_id, node_id)
  WHERE kind = 'flow';
```

### Pattern 2: Durable timer = Postgres row + BullMQ delayed job (nudge) + reconciliation scan (backstop)

**What:** Every `flow_runs` row waiting on a delay/wait-until node carries `next_wake_at` (source of truth). A BullMQ delayed job is enqueued as a low-latency wake-up nudge (`{ delay: msUntilWake }`), but a repeatable reconciliation scan — structurally identical to `campaign-scheduler.worker.ts`'s `findDueCampaignCandidates`/`transitionToSending` pair — is the durability backstop that catches any lost/evicted delayed job. This exact pattern (admin cross-tenant discovery scan via `app.admin_scan` GUC + `FOR UPDATE SKIP LOCKED` re-verification inside a properly tenant-scoped transaction) is proven, tested code in this repo today (`0018_campaigns_scheduler_scan_policy.sql`).

**When to use:** Delay/wait-until node advancement (06-04); segment-trigger sweep (D-02b) also reuses the identical repeatable-tick shape, just with a different WHERE clause and a different downstream action (create `flow_runs` instead of transition + kickoff).

**Example (adapted from `campaign-scheduler.worker.ts`, illustrative):**
```typescript
// apps/worker/src/queues/flows/flow-reconciliation.worker.ts
async function findDueFlowRunCandidates(): Promise<{ id: string; workspaceId: string }[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.admin_scan', 'true', true)`);
    const { rows } = await client.query(
      `SELECT id, workspace_id as "workspaceId" FROM flow_runs
       WHERE status = 'waiting' AND next_wake_at <= now()`
    );
    await client.query("COMMIT");
    return rows;
  } finally {
    client.release();
  }
}
// transitionToAdvancing(row) mirrors transitionToSending: withTenant + FOR UPDATE SKIP LOCKED
// re-verification, then enqueue onto a flow-run-advance queue with jobId: row.id.
```
*Requires a new RLS policy analogous to `campaign_scheduler_due_scan` (0018) scoped to `flow_runs`, plus the same NULLIF guard fix already applied to `campaigns` in `0019` — apply it from the start on `flow_runs`' policy, don't wait for a follow-up migration.*

### Pattern 3: Version-pinned execution (FLOW-06/FLOW-07)

**What:** `flows` (parent, mutable pointer to current draft/live version ids + status), `flow_versions` (immutable once published, `definition jsonb` = nodes/edges), `flow_runs` (one row per contact-in-flow, FK to the exact `flow_version_id` it entered on — never re-pointed). Publishing atomically sets `flows.live_version_id = <new version>`; new entrants resolve against `flows.live_version_id` at entry time; in-flight runs keep resolving against their own stamped `flow_version_id` forever (D-20). This is directly what ARCHITECTURE.md's Pattern 3 and Pitfall 9 (from the 2026-07-03 project-level research) already prescribe, and D-20/D-21 in this phase's CONTEXT.md make it a locked decision, not just a recommendation.

**When to use:** Every read of "what should this run do next" inside `flow-run-advance.worker.ts` — always joins through the run's own `flow_version_id`, never through `flows.live_version_id`.

### Anti-Patterns to Avoid

- **Recomputing `processSendJob`'s campaign-shaped logic by copy-paste into a new flow-only file:** guarantees behavioral drift on the pre-send gate/rate limiter (the exact anti-pattern this project's Phase 4 code comments explicitly warn against — "no separate dispatch implementation"). Extend the existing functions per Pattern 1.
- **In-worker `setTimeout` for delay nodes:** loses all state on deploy/crash (ARCHITECTURE.md Anti-Pattern 1, already flagged for this exact scenario).
- **Trusting BullMQ delayed-job payload as sole truth for "what should happen now":** the reconciliation scan and `flow-run-advance.worker.ts` must always re-read `flow_runs`'s current DB state before acting (ARCHITECTURE.md Pattern 1: queue-as-doorbell).
- **A single mutable `flows` table with no version snapshot:** breaks FLOW-07 outright; this is the central failure mode the whole versioning model exists to prevent (Pitfall 9).
- **Live segment-membership full-table joins on every sweep tick:** given segments are on-the-fly (not materialized) in this codebase, a naive "for every active flow with a segment trigger, for every contact in the workspace, call `isContactInSegment`" sweep is O(flows × contacts) per tick — this WILL hit the same `statement_timeout` wall Phase 3 already engineered around. See Common Pitfalls below.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Node/edge canvas rendering, pan/zoom, minimap, connection validation | A custom SVG/canvas drag-drop system | `@xyflow/react` | Multi-month undertaking already solved (STACK.md Alternatives Considered) |
| "Is contact X in segment Y" evaluation | A second, flow-specific segment query compiler | `isContactInSegment(def, contactId)` from `@mega-crm/segments-core`/`segment.repository.ts` | SEGM-03 explicitly built this contract for Phase 6's exact use case; a second implementation would let campaign and flow segment semantics silently drift |
| Per-tenant SendGrid RPS throttling for flow sends | A second token-bucket limiter scoped to flows | The EXISTING `rate-limiter-flexible` instance in `apps/worker/src/queues/rate-limiter.ts`, consumed identically regardless of `kind` | Two limiters per tenant is exactly the Anti-Pattern 3 this codebase's Phase 4 work already avoided once |
| IANA timezone validation and offset math | A timezone parsing library | `Intl.supportedValuesOf('timeZone')` + `Intl.DateTimeFormat` (native, zero-dependency, confirmed working on Node 22+ in this repo) | No new dependency; this project has zero date-library dependencies today and native `Intl` fully covers "validate this string is a real IANA zone" + "what's the wall-clock time right now in this zone" |
| Idempotent step execution / duplicate-send prevention | A bespoke in-memory or Redis-only "already ran" flag | DB-level `UNIQUE` constraint + `ON CONFLICT` claim pattern (Pattern 1 above), identical in shape to the existing `dispatchSendGate` | Redis-only idempotency flags don't survive a Redis flush; the DB constraint is the only durable guarantee (PITFALLS.md Pitfall 1) |
| Cross-tenant due-timer discovery | A per-tenant polling loop (N workspaces × N queries) | The single admin-scoped scan pattern from `campaign-scheduler.worker.ts` (`app.admin_scan` GUC + one query across all workspaces, then per-row tenant-scoped re-verification) | Already proven at this project's scale; per-tenant polling doesn't scale past a handful of tenants |

**Key insight:** Nearly everything Phase 6 needs at the "send a triggered email reliably" layer already exists and works; the actual net-new engineering surface is narrower than it looks — canvas UI, the state-machine tables, trigger/branch/exit evaluation logic, and the extension seams into the existing dispatch path. Treat any urge to build a new dispatch/rate-limit/segment-evaluation path as a signal to stop and re-read `send-dispatch.ts`/`segment.repository.ts` first.

## Runtime State Inventory

Not applicable — this is a greenfield feature phase (new tables, new worker files, new UI feature), not a rename/refactor/migration phase. No existing runtime state (stored data, live service config, OS-registered state, secrets, build artifacts) is being renamed or moved.

## Common Pitfalls

### Pitfall 1: Segment-trigger sweep-scan cost, given on-the-fly (non-materialized) segment evaluation

**What goes wrong:** D-02's periodic sweep (the strictly-time-based half of segment-entry detection, e.g. "hasn't opened in 90 days" becoming true with no contact mutation) calls `isContactInSegment` — which compiles and runs a real SQL query per call — once per (active segment-triggered flow × contact) pair on every tick. At even moderate scale (thousands of contacts, tens of segment-triggered flows per workspace, across many workspaces) this is a very different cost profile than the existing `campaign-scheduler.worker.ts` tick, which only ever scans a handful of `campaigns` rows.

**Why it happens:** The segment engine's own on-the-fly design (Phase 3's deliberate choice, not an oversight — see STATE.md's "benchmark is still outstanding" note) was accepted because segment counts/previews are bounded by a `statement_timeout` (2s/15s) and invoked by a human action (viewing a segment, launching a campaign) — a background sweep has no such natural rate limit unless one is designed in.

**How to avoid:**
- Invert the query direction where possible: instead of "for each flow, for each contact, check segment," batch per-segment using the segment's own `countSegmentMembers`/`listSegmentMembers`-shaped bulk query (one compiled WHERE, all matching contact ids) and diff against the `flow_segment_membership_snapshot` table (already called out as required in CONTEXT.md D-02) — this turns an O(flows × contacts) point-check loop into O(flows) bulk queries.
- Scope the sweep interval conservatively (e.g. every 15-60 minutes, not every minute) since D-02's own text acknowledges this is "an insurance mechanism for time-based conditions," not a low-latency path — the event-driven re-check (D-02a) handles the low-latency case.
- Explicitly benchmark against a seeded dataset before committing to a sweep interval/batch size, mirroring the still-open Phase 3 benchmark flag (STATE.md) — do not assume the 2s/15s `statement_timeout` values tuned for interactive segment preview are appropriate for a background batch process; a background job can reasonably use a longer per-batch timeout but must chunk work to avoid a single multi-minute transaction holding locks.
- This is exactly the discretion item CONTEXT.md flags ("Интервал sweep-скана ... и его нагрузка") — the planner must make and document an explicit interval/batch-size decision here, not leave it implicit.

**Warning signs:** Sweep tick duration growing unbounded as workspaces/segment-triggered-flow count grows; `EXPLAIN ANALYZE` on the sweep's underlying queries showing per-contact round trips instead of set-based batch queries.

### Pitfall 2: `sends` ledger idempotency silently not applying to flow sends (see Pattern 1 above)

**What goes wrong:** A flow send-node execution is retried (worker crash, BullMQ redelivery) and, without the Pattern-1 extension, calls SendGrid twice because the existing `ON CONFLICT (workspace_id, campaign_id, contact_id)` constraint never fires when `campaign_id IS NULL`.

**Why it happens:** `sends.campaign_id` being nullable was designed in anticipation of Phase 6 (per the schema's own comment), but nullable-and-therefore-idempotent are two different properties in Postgres — this is an easy trap because the column being present makes the table LOOK ready for flow sends without actually providing the constraint that makes them safe.

**How to avoid:** Implement Pattern 1's new partial unique index and `claimFlowSend` BEFORE the first `flow-run-advance.worker.ts` send-node execution ships — this is a hard prerequisite for FLOW-01/02/06 no matter how the plans are split across 06-01..06-05.

**Warning signs:** Any send-node dispatch code that reuses `dispatchSendGate`/`claimCampaignSend` as-is with a null/placeholder `campaignId`.

### Pitfall 3: Publish validation happening client-side only

**What goes wrong:** D-17's hard-error publish validation (no trigger, empty send-node, branch not ending in exit) is implemented only in the canvas editor's JS, and a direct API call (or a race between two tabs) bypasses it, publishing an invalid flow that then breaks `flow-run-advance.worker.ts` at runtime with no clear diagnostic.

**How to avoid:** Validation must live in `packages/flows-core` (pure function, shared) and be re-run server-side inside the publish transaction — the canvas editor calls the SAME validator client-side only for instant UX feedback, never as the authority.

**Warning signs:** A publish endpoint that trusts a client-sent "isValid: true" flag instead of re-validating server-side.

### Pitfall 4: Quiet hours / re-entry / frequency-cap evaluated at schedule time instead of dispatch time

**What goes wrong:** Directly inherited from PITFALLS.md Pitfall 6 (project-level research) — if the delay-node scheduler computes "send at 2pm" once and the actual send fires unconditionally when that time arrives, a subsequent change to quiet-hours settings, or a contact's timezone, is never re-checked.

**How to avoid:** `flow-run-advance.worker.ts`'s send-node handler must call the SAME pre-send-gate-adjacent quiet-hours check at the moment it's about to enqueue the send job, not when the node was first scheduled. D-14 (this phase's own decision) already mandates this: "exit conditions вычисляются на границах шагов ... непрерывного event-driven exit-вотчера нет" — apply the identical "check at the moment of action" principle to quiet hours and re-entry, not just exits.

### Pitfall 5: Missing tenant context in a new background worker (project-wide Pitfall #5)

**What goes wrong:** Any of the five new worker files in `apps/worker/src/queues/flows/` forgets to wrap its Postgres work in `withTenant(workspaceId, ...)`/`withTenantTransaction`, silently running under no tenant context (RLS then returns zero rows rather than throwing, which can look like "the query returned nothing" rather than a crash — easy to miss in testing).

**How to avoid:** Every new worker file follows the exact convention visible in `email-triggered.worker.ts`/`send-dispatch.ts`/`campaign-scheduler.worker.ts`: `workspaceId` is always re-derived from the job payload (never ambient), and every DB call is inside `withTenant`/`withTenantTransaction`. The cross-tenant admin-scan exception (Pattern 2) is the ONLY sanctioned exception, and even that immediately re-scopes per-row via `withTenant` before any write.

## Code Examples

### Extending `emailTriggeredJobSchema` for the flow kind (illustrative — actual implementation is planner's task)

```typescript
// packages/shared-schemas/src/queues.ts — CURRENT (campaign-shaped only):
export const emailTriggeredJobSchema = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  kind: z.enum(["campaign", "test"]),
  contactId: z.string().uuid().optional(),
  testTo: z.string().email().optional(),
  testData: z.record(z.string(), z.unknown()).optional(),
});

// NEEDS TO BECOME (discriminated union so `kind: "flow"` doesn't require campaignId):
export const emailTriggeredJobSchema = z.discriminatedUnion("kind", [
  z.object({ workspaceId: z.string().uuid(), kind: z.literal("campaign"), campaignId: z.string().uuid(), contactId: z.string().uuid() }),
  z.object({ workspaceId: z.string().uuid(), kind: z.literal("test"), campaignId: z.string().uuid(), testTo: z.string().email(), testData: z.record(z.string(), z.unknown()).optional() }),
  z.object({ workspaceId: z.string().uuid(), kind: z.literal("flow"), flowRunId: z.string().uuid(), nodeId: z.string(), contactId: z.string().uuid() }),
]);
```
*Note: `emailBroadcastJobSchema` (the broadcast lane's own schema) does NOT need this change — flow sends only ever go through `email-triggered`, per this phase's own locked decision.*

### Native IANA timezone validation (no dependency)

```typescript
// Confirmed working on this repo's Node runtime (v22+):
const VALID_TIMEZONES = new Set(Intl.supportedValuesOf("timeZone")); // 418 zones

function isValidIanaTimezone(tz: string): boolean {
  return VALID_TIMEZONES.has(tz);
  // Alternative/defense-in-depth: try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `reactflow` (npm package) | `@xyflow/react` | Package renamed/rebranded; `reactflow` last published June 2024 | Already correctly avoided in this project's CLAUDE.md; re-confirmed still current in this research |
| BullMQ group-key/per-tenant rate limiting via built-in `limiter` | App-level Redis token bucket (`rate-limiter-flexible`) keyed by `tenant_id` | BullMQ removed OSS group rate-limiting in v3+ | Already correctly implemented in `apps/worker/src/queues/rate-limiter.ts`; Phase 6 must call the SAME limiter instance, not a new one |

**Deprecated/outdated:** none newly identified this phase beyond what STACK.md already documents.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | A sweep interval of 15-60 minutes for D-02's segment-trigger safety-net sweep is an appropriate default, pending benchmark | Common Pitfalls #1 | If too frequent, background load competes with interactive segment-preview queries under the same `statement_timeout` budget; if too infrequent, "hasn't opened in 90 days"-style triggers feel laggy to marketers. This is explicitly flagged in CONTEXT.md as a discretion item requiring the planner's own benchmark-informed decision, not a fact to lock silently. |
| A2 | `luxon`/`date-fns-tz` are unnecessary and native `Intl` suffices for all D-11 wait-until/DST math needed in v1 (fixed-duration delays + simple daily wait-until-time-of-day) | Standard Stack, Don't Hand-Roll | If wait-until logic later needs recurring-schedule rules (e.g., "next business day," "skip weekends") beyond MVP scope, native `Intl` arithmetic becomes noticeably more manual than a date library's helpers — revisit if V2 scope grows in that direction. |
| A3 | Organizing the five new flow workers under a `apps/worker/src/queues/flows/` subdirectory (rather than flat, matching the existing convention) is acceptable | Recommended Project Structure | Low risk either way — purely organizational; flag explicitly for the planner to align with team preference/existing lint rules if any exist. |

## Open Questions

1. **Frequency-cap disposition for flow-step sends: skip (like broadcast, D-14) or defer?**
   - What we know: Phase 4's D-14 explicitly labeled deferral "territory Phase 6" and shipped skip-only for campaigns. `evaluatePreSendGate` currently returns a hard `sendable: false` (skip) for `frequency_cap`, with no defer mechanism anywhere in the codebase today.
   - What's unclear: Whether a flow-step email that hits the frequency cap should be silently skipped (matching campaign behavior, simplest, reuses `evaluatePreSendGate` unmodified) or deferred to the next allowed window (matching the "reliability is visible to the user" theme in this phase's own Specific Ideas, and matching how quiet-hours-deferred sends already behave per D-10).
   - Recommendation: Treat as a locked decision to make explicitly during planning (CONTEXT.md already flags it as open discretion), not to leave implicit. Given `evaluatePreSendGate` is shared by both campaigns and flows, changing its behavior for flows only would require a caller-side parameter (e.g., `onFrequencyCap: "skip" | "defer"`) — a defer path would need a new "waiting-on-frequency-cap" run status distinct from "waiting-on-delay," since a deferred step must still re-check the cap (not just a timer) when it wakes.

2. **Enroll-existing batch size for D-04's publish dialog on large segments**
   - What we know: The segment engine's own save-eval path already uses a 15s `statement_timeout` for a single evaluation; batch-enrolling potentially tens of thousands of contacts at publish time (creating one `flow_runs` row per contact, each needing re-entry/frequency-cap/quiet-hours checks) is a materially larger unit of work than a single segment count.
   - What's unclear: Whether this should be a synchronous part of the publish transaction (bounded by count, e.g., inline only under some threshold) or always deferred to a background batch job (mirroring `recipient-snapshot.ts`'s existing resumable-batch pattern for campaign audience snapshotting).
   - Recommendation: Reuse the existing `recipient-snapshot.ts` resumable-cursor pattern (already built for exactly this "chunk a potentially-huge contact set without one giant transaction" problem in Phase 4) rather than inventing a new batching mechanism.

## Environment Availability

Skipped — this phase has no new external service dependencies beyond what Phases 1-5 already established (Postgres, Redis, SendGrid via existing tenant keys). No new infrastructure (no new database, no new third-party API) is introduced.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.9 (confirmed in `apps/api/package.json`/`apps/worker/package.json`) |
| Config file | Per-package `vitest.config.ts` (existing convention, e.g. `apps/worker/src/queues/__tests__/*.test.ts`) |
| Quick run command | `npm run test -w apps/worker -- --run <file>` |
| Full suite command | `npm run test --workspaces --if-present` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FLOW-01 | Publish-time validation rejects: no trigger / empty send-node / branch missing exit | unit | `npm run test -w packages/flows-core` | ❌ Wave 0 — new package |
| FLOW-02 | Event-name trigger creates a `flow_runs` row; segment-entry trigger creates one via event-driven diff | integration | `npm run test -w apps/worker -- flow-trigger-evaluator` | ❌ Wave 0 |
| FLOW-02 | Re-entry control (once-ever / once-per-N-days / every-time) blocks/allows correctly | unit | `npm run test -w apps/worker -- flow-trigger-evaluator` | ❌ Wave 0 |
| FLOW-03 | Exit condition (segment-based, event-based) ends a run at a step boundary, not mid-delay | integration | `npm run test -w apps/worker -- flow-run-advance` | ❌ Wave 0 |
| FLOW-04 | Max one active run per contact×flow; interleaved trigger ignored while active | unit/integration | `npm run test -w apps/worker -- flow-trigger-evaluator` | ❌ Wave 0 |
| FLOW-05 | Quiet-hours window defers a due send until window end; contact TZ overrides workspace default | unit | `npm run test -w packages/delivery-core -- quiet-hours` | ❌ Wave 0 |
| FLOW-05 | Wait-until node resolves correctly across a DST transition | unit | `npm run test -w packages/flows-core -- wait-until` | ❌ Wave 0 |
| FLOW-06 | Pause freezes new entries + step execution; resume executes overdue steps immediately | integration | `npm run test -w apps/worker -- flow-run-advance` | ❌ Wave 0 |
| FLOW-07 | Publishing a new version does not alter in-flight runs; new entrants use the new version | integration | `npm run test -w apps/api -- flow-version` | ❌ Wave 0 |
| SEND-06 (flow-scoped) | A redelivered flow send-node job never double-sends (Pattern 1's partial unique index) | integration, chaos-style (simulate redelivery) | `npm run test -w apps/worker -- flow-send-idempotency` | ❌ Wave 0 — mirrors existing `send-dispatch-idempotency.test.ts` shape exactly |

### Sampling Rate
- **Per task commit:** the specific new test file for that task (`npm run test -w <package> -- <pattern>`)
- **Per wave merge:** `npm run test --workspaces --if-present`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `packages/flows-core/` — new package scaffold (package.json, vitest config, `src/index.ts`) mirroring `packages/segments-core/`
- [ ] `apps/worker/src/queues/__tests__/flow-send-idempotency.test.ts` — mirrors `send-dispatch-idempotency.test.ts` for the new `kind: "flow"` claim path
- [ ] `apps/worker/src/test/db-fixture.ts` — likely needs extension for flow tables (flows/flow_versions/flow_runs/flow_run_steps) fixtures, same pattern as existing contacts/campaigns fixtures
- [ ] Migration test coverage for the new `sends_flow_run_node_unique` partial index (verify `ON CONFLICT` actually dedupes under concurrent insert, matching the existing campaign-side idempotency test's structure)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No (unchanged from prior phases — session auth already established) | — |
| V3 Session Management | No (unchanged) | — |
| V4 Access Control | Yes | Publish/pause/resume/enroll-existing restricted to Owner/Admin (D-23, mirrors TENANT-03/campaign D-19 pattern already implemented) — enforce at the route layer identically to `campaigns.routes.ts`'s existing role check, not just hidden in the UI |
| V5 Input Validation | Yes | Flow definition (nodes/edges JSON) validated via a Zod schema in `packages/flows-core` before persisting a draft or accepting a publish; timezone strings validated via `Intl.supportedValuesOf` allowlist (never trust a client-sent IANA string without validation, since it flows into `Intl.DateTimeFormat` construction at dispatch time) |
| V6 Cryptography | No new surface (unchanged — SendGrid key envelope-encryption already exists, reused unmodified) | — |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Duplicate flow-step send from redelivered job | Repudiation-adjacent (data integrity/reliability, not classic security) | Pattern 1's partial unique index + `ON CONFLICT` claim — same class of control as the existing campaign-send idempotency guarantee |
| A Member (non-Owner/Admin) publishing/pausing/resuming a flow via direct API call bypassing UI role gating | Elevation of Privilege | Route-level role check (D-23), mirrored from the existing, already-tested `campaigns.routes.ts` Owner/Admin gate — never rely on the canvas UI hiding the publish button as the only control |
| Cross-tenant `flow_runs`/`flows` row access via a missing RLS policy on a newly-added table | Information Disclosure / Tampering | RLS ENABLE+FORCE + `workspace_isolation` policy (with the NULLIF guard from day one, per the `0019` lesson already learned in this codebase) on every new table — checklist item, not optional |
| Invalid/malicious IANA timezone string reaching `Intl.DateTimeFormat` construction at dispatch time | Tampering / Denial of Service (unhandled exception crashing a worker) | Validate against the `Intl.supportedValuesOf('timeZone')` allowlist at write time (contact update, CSV import, workspace settings) AND defensively re-validate/catch at read time in the dispatch worker, never assume a stored value is still valid |
| Segment/flow reference deleted out from under an active flow (referenced segment removed) | Tampering (data integrity) | Extend the existing restrict-when-referenced pattern (23503 → conflict, `SegmentConflictError`) to also check `flows`/`flow_versions` references, per D-24 |

## Sources

### Primary (HIGH confidence — direct codebase reads, this session)
- `packages/db/src/schema/sends.ts`, `packages/db/src/schema/events.ts`, `packages/db/src/schema/contacts.ts`, `packages/db/src/schema/workspace-send-settings.ts`, `packages/db/src/schema/campaigns.ts` — verified current schema shape
- `apps/worker/src/queues/send-dispatch.ts`, `packages/delivery-core/src/send-ledger.ts`, `packages/delivery-core/src/pre-send-gate.ts` — verified the campaign-coupled idempotency mechanism and pre-send gate contract directly
- `apps/worker/src/queues/campaign-scheduler.worker.ts`, `packages/db/migrations/0018_campaigns_scheduler_scan_policy.sql`, `packages/db/migrations/0019_campaigns_workspace_isolation_nullif_guard.sql` — verified the repeatable-scan + admin-scoped RLS pattern to reuse
- `apps/api/src/modules/segments/segment.repository.ts` — verified `isContactInSegment`/`countSegmentMembers` signatures and the on-the-fly (non-materialized) segment evaluation model
- `packages/shared-schemas/src/queues.ts` — verified current `emailTriggeredJobSchema` shape and its campaign-coupling gap
- `packages/db/migrations/0011_segments.sql`, `0012_segments_rls_and_indexes.sql` — verified the RLS ENABLE+FORCE+policy migration convention for a new table
- `.planning/STATE.md` — verified the still-open segment-benchmark flag referenced in this phase's own CONTEXT.md discretion item
- `npm view @xyflow/react version` → `12.11.2`; `npm view bullmq version` → `5.79.3` — direct registry verification
- `node -e "Intl.supportedValuesOf('timeZone')"` on this repo's Node runtime — confirmed 418 zones returned and invalid-zone rejection behavior, run in this session

### Secondary (MEDIUM confidence — inherited project-level research, 2026-07-03)
- `.planning/research/STACK.md`, `.planning/research/ARCHITECTURE.md`, `.planning/research/PITFALLS.md` — project-wide research predating Phase 3; cross-checked against actual Phase 3-5 implementation in this session and found to diverge on ONE material point (segment materialization — implemented as on-the-fly instead, a deliberate Phase 3 decision, not a research error)
- `.planning/phases/06-flows-triggered-chains/06-CONTEXT.md` — user decisions (D-01 through D-24), treated as locked per the `<user_constraints>` contract below

### Tertiary (LOW confidence)
- `[SUS]` package-legitimacy gate result for `@xyflow/react` — automated heuristic flagged "too-new" based on latest patch publish date, assessed as a false positive given 7.5M weekly downloads and established repo, but formally logged per protocol

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every new/reused library verified directly against this repo's package.json files and/or npm registry
- Architecture: HIGH — extension points (Pattern 1/2/3) verified by reading the actual source files, not inferred from prior general research
- Pitfalls: MEDIUM-HIGH — Pitfalls 2-5 are codebase-verified; Pitfall 1 (sweep cost) is a reasoned projection from the verified on-the-fly segment design, not yet benchmarked

**Research date:** 2026-07-09
**Valid until:** 30 days (stable domain; codebase-grounded findings won't drift unless Phase 4/5 code is refactored before Phase 6 execution)

---
*Phase: 6-Flows (Triggered Chains)*
*Research conducted: 2026-07-09*
