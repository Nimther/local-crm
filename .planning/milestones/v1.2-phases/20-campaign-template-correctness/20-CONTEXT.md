# Phase 20: Campaign Template Correctness - Context

**Gathered:** 2026-08-21
**Status:** Ready for planning

<domain>
## Phase Boundary

The template (and sender/segment) the marketer sees selected in a campaign is exactly what SendGrid receives — on launch, on schedule, and on test-send. An unsaved change is explicitly visible and blocks all three send actions until saved; a concurrent or stale change produces a typed conflict error and dispatches no mail. Requirements: TMPL-01, TMPL-02, TMPL-03.

**The located bug:** `CampaignDetailPage` embeds `CampaignBuilderPage` (template/sender/segment choices live in local React state) with `TestSendPanel` and `LaunchScheduleActions` as sibling components acting on the server-side saved row. An unsaved dropdown change is silently ignored by all three send paths — the old saved template goes out. Additionally, `campaigns` has no concurrency token: launch/schedule guard `status='draft'` only, not row staleness.

**Scope limits:** the three campaign send paths only. Flow sends (`flow-send.ts`) also send templated mail but are out of this phase. Non-negotiable (locked by ROADMAP success criteria, not discussion): dirty state visible + all three actions blocked until save (SC1); test-proof of the original bug scenario on all three paths (SC2); typed conflict + zero mail on stale/concurrent change (SC3); no send path may fall back to local client form state (SC4).

</domain>

<decisions>
## Implementation Decisions

### Dirty-state UX & blocking (TMPL-01)
- **D-01:** Unsaved changes surface as a persistent amber banner near the actions («Есть несохранённые изменения…») plus disabled launch/schedule/test-send buttons with inline reason copy — reusing the existing `computeIncompleteReason` inline-copy pattern and the builder's amber Card style. No intercept dialogs.
- **D-02:** "Dirty" = ANY field differing from the saved row: template, sender, segment, or name. One mental model — «what you see is saved, or you can't send» — no two-tier dirty concept.
- **D-03:** The banner carries a one-click «Сохранить» button invoking the same save mutation as the builder's own «Сохранить черновик» (validation errors still surface in the form). No discard affordance.
- **D-04:** No navigation guard (no beforeunload / router blocker). TMPL-01 blocks send actions, not navigation; abandoning unsaved edits is harmless because the saved row stays authoritative.
- Builder form state must be lifted/shared so sibling components (TestSendPanel, LaunchScheduleActions) and the banner can see dirtiness — mechanism (lift state, context, or store) is planner's choice.

### Staleness token mechanism (TMPL-02)
- **D-05:** New integer `campaigns.version` column (default 1), incremented on **every** campaign mutation — draft edits AND status transitions (launch/schedule/cancel). One uniform invariant: any write bumps. Chosen over `updated_at`-as-token (timestamp-without-timezone + JSON roundtrip precision makes byte-equality fragile) and over echoing expected field values (misses same-field races). — **Reversibility:** costly — the column ships in a migration and the version becomes part of the published API contract consumed by the web client.
- **D-06:** `expectedVersion` is a **required** field in the launch/schedule/test-send request bodies — a request without it is a 400. No optional-when-present soft mode: a permanent bypass is exactly the SC4 hole. No If-Match header (novel pattern; every other contract rides the zod-validated JSON body).
- **D-07:** Version comparison happens server-side under the existing `FOR UPDATE` locked read-check-write transaction in the repository, alongside the status check. Mismatch → new `CampaignStateError` code `"version_conflict"` mapped to HTTP **409** with body `{ error, code: "version_conflict", currentVersion }`. Joins the existing `incomplete`/`illegal_transition` error family. Contract documented in SPECIFICATION.md §6 in the same change; the column in §4.

### Conflict presentation & recovery (TMPL-02 UX)
- **D-08:** On `version_conflict` at launch/schedule the dialog STAYS OPEN, shows «Кампания была изменена — данные обновлены, проверьте и повторите», and the page refetches the campaign so the marketer re-confirms against fresh state. Never auto-retry with the fresh version — sending mail against a state the marketer never confirmed is exactly what this phase prevents.
- **D-09:** `illegal_transition` on launch/schedule (concurrent «already launched/canceled») also gets specific copy naming the real state + the same refetch pattern — one coherent stale-view recovery story replacing today's generic «Что-то пошло не так» for these codes.
- **D-10:** On conflict-triggered refetch, server wins: the embedded builder re-syncs to the fresh row (current `useEffect` behavior) and local unsaved edits are dropped with a notice. The saved row is the only truth this phase trusts.

### Test-send parity (TMPL-03)
- **D-11:** Test-send takes the SAME `expectedVersion` precondition as launch/schedule → 409 `version_conflict` on mismatch. One uniform contract across all three paths is easier to prove (SC4) than two strict paths plus one soft one.
- **D-12:** The test-send route snapshots the verified `templateId` (and the already-resolved `fromEmail`) into the `kind='test'` job payload at enqueue time; the dispatch worker sends exactly that for test sends instead of re-reading the row. Closes the async enqueue→dispatch gap where a save could swap the template under a queued test. («Ровно тот шаблон, что подтверждён» read literally — what you clicked is what arrives, deterministic to test.)

### Claude's Discretion
- State-sharing mechanism for dirtiness between builder and sibling components (lift to CampaignDetailPage, React context, or Zustand — follow existing app patterns).
- Conflict copy in TestSendPanel follows the same pattern as the dialogs — exact wording/placement at discretion.
- Test harness choices for SC2's three-path proof (integration vs Playwright), exact migration mechanics, zod schema details, error message texts, banner copy wording.
- Whether launch/schedule need payload changes beyond `expectedVersion` — launch/schedule are safe from the async gap by construction (version check + status flip in one locked transaction; non-draft rows are un-editable), so no snapshot needed there unless the planner finds otherwise.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — TMPL-01, TMPL-02, TMPL-03 («Campaign template correctness» section)
- `.planning/ROADMAP.md` — Phase 20 section: goal, 4 success criteria

### As-built documentation to update in the same change
- `SPECIFICATION.md` §4 «Схема данных» — the new `campaigns.version` column + migration MUST be documented here in the same change (hard project rule from `.claude/CLAUDE.md`); §6 «Публичные точки входа» — the `expectedVersion` request contract and 409 `version_conflict` error shape
- `.claude/CLAUDE.md` — "Project Specification" section defines where schema/route changes get documented

### Frontend (the components under change)
- `apps/web/src/features/campaigns/CampaignDetailPage.tsx` — composes embedded builder + TestSendPanel + LaunchScheduleActions; the dirty-state banner and state-sharing land here
- `apps/web/src/features/campaigns/CampaignBuilderPage.tsx` — local form state (name/segmentId/templateId/fromSenderId), save mutation, `useEffect` server-row sync (D-10 relies on it)
- `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx` — LaunchConfirmDialog / ScheduleDialog / LaunchScheduleActions; `computeIncompleteReason` inline-copy pattern (D-01 analog); generic-error handling to replace (D-08/D-09)
- `apps/web/src/features/campaigns/TestSendPanel.tsx` — test-send mutation, D-11 precondition + blocking joins here
- `apps/web/src/features/campaigns/TemplateSenderPickers.tsx` — template/sender pickers feeding the form state
- `apps/web/src/features/campaigns/api.ts` — client API layer gaining `expectedVersion` params + version field

### Backend (routes, repository, schema)
- `apps/api/src/modules/campaigns/campaigns.routes.ts` — launch (:295), schedule (:340), test-send (:431) routes; `CampaignStateError`→HTTP mapping; test-send enqueue payload (D-12 snapshot point)
- `apps/api/src/modules/campaigns/campaign.repository.ts` — `updateCampaign`/`launchCampaign`/`scheduleCampaign`/`cancelCampaign` FOR UPDATE transactions; version check + bump lands here (D-05/D-07)
- `packages/db/src/schema/campaigns.ts` — campaigns table definition; `version` column + migration
- `packages/shared-schemas` — `scheduleCampaignSchema`/`testSendCampaignSchema` (and a new launch body schema) gain required `expectedVersion`

### Worker (dispatch paths for SC2/SC4 proof)
- `apps/worker/src/queues/send-dispatch.ts` — reads `template_id` from the campaigns row at dispatch (:235-244); test-send payload consumption for D-12
- `apps/worker/src/queues/campaign-kickoff.worker.ts` — launch/schedule fan-out path
- `apps/worker/src/queues/campaign-broadcast-producer.ts` — broadcast production path
- `apps/worker/src/queues/campaign-scheduler.worker.ts` — scheduled-campaign pickup

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `computeIncompleteReason` + disabled-button-with-inline-copy pattern in `LaunchScheduleDialogs.tsx` — the dirty-block (D-01) extends this exact shape
- Amber notice Card (`border-amber-200 bg-amber-50`) already used in `CampaignBuilderPage` for the non-draft notice — the dirty banner reuses the style
- `CampaignStateError` typed-code family (`not_found`/`illegal_transition`/`incomplete`) with route-level mapping — `version_conflict` joins it (D-07)
- Repository FOR UPDATE locked read-check-write transactions — the version check slots into the existing lock, no new locking machinery
- Builder's `useEffect` sync from `campaignQuery.data` — D-10's "server wins" reset is its natural behavior once refetch is triggered

### Established Patterns
- Zod schemas in `packages/shared-schemas` shared between route validation and client — `expectedVersion` follows this path
- Test-send is never a direct SendGrid call — always enqueued on the broadcast queue with `kind='test'`; D-12 extends the job payload, not the transport
- Correlation-id propagation across HTTP→queue boundary (Phase 15) — any payload change must preserve it
- SPECIFICATION.md same-change documentation rule for schema (§4) and route contracts (§6)

### Integration Points
- `CampaignDetailPage` is the composition seam: dirty state must be shared from the embedded builder to sibling TestSendPanel/LaunchScheduleActions (state lift — mechanism at discretion)
- Launch/schedule/test-send request schemas + client `api.ts` change in lockstep (both sides ship together; D-06's required field is safe)
- Job payload schema for `email:broadcast` queue gains test-template snapshot fields — check payload schemaVersion conventions in `queue-registry.ts`/queues before changing

</code_context>

<specifics>
## Specific Ideas

- The uniform-contract principle came up repeatedly: the user consistently chose the strictest symmetric option (any-field dirty, required-not-optional precondition, bump-on-every-mutation, test-send parity, snapshot-at-enqueue). Planner should resolve future micro-ambiguities in the same direction — uniform and strict over clever and soft.
- Auto-retry-on-conflict was explicitly rejected as "exactly what this phase exists to prevent" — no code path may re-submit a send action without a fresh human confirmation.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 20-Campaign Template Correctness*
*Context gathered: 2026-08-21*
