---
status: resolved
trigger: "Editing a segment referenced by a scheduled campaign does not show the D-03 warning before saving (UAT Test 12)"
created: 2026-07-07T00:00:00Z
updated: 2026-07-07T00:45:00Z
mode: find_root_cause_only
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: CONFIRMED (by elimination + code lifecycle analysis) — the 04-15 pageSize fix IS effective end-to-end (live differential proof); the remaining defect is the D-03 warning's client-side lifecycle: a one-shot mount-time query with refetchOnWindowFocus:false, silently swallowed errors, and NO save-time re-check. Any editor session whose cached campaigns snapshot predates the scheduling event never shows the warning — including at the save click, which performs zero D-03 validation.
test: complete — full static + server-side verification of every layer; browser-level repro unavailable (no MCP browser tools in this agent, no credentials to mint a session; DB writes prohibited)
expecting: n/a
next_action: return ROOT CAUSE FOUND diagnosis (goal: find_root_cause_only — no fix applied)

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: Opening/editing a segment that a scheduled campaign references shows a warning in the segment editor ("a scheduled campaign references this segment", D-03) before the user saves changes.
actual: "предупреждение перед сохранением не появляется" — no warning appears at all.
errors: None reported. Console state unknown.
reproduction: UAT Test 12 (.planning/phases/04-broadcast-campaigns-send-pipeline/04-UAT.md). Campaign successfully scheduled («Запланирована», test 8 passed) referencing a segment; user edited that segment, no warning. Dev stack npm run dev, workspace slug "localrent".
started: Discovered during UAT 2026-07-06, after 04-15 fix (commit b54219d) that was supposed to close the latent Test 12 gap (pageSize=200 vs schema max 100 → silent 400).

## Eliminated
<!-- APPEND only - prevents re-investigating -->

- hypothesis: 04-15 fix missed the SegmentDetailPage call site (still sends pageSize over schema max -> silent 400)
  evidence: SegmentDetailPage.tsx:169 now calls listCampaigns(slug, { page: 1, pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE }); pagination.ts EXHAUSTIVE_LOOKUP_PAGE_SIZE=200; campaignListQuerySchema.pageSize max = EXHAUSTIVE_LOOKUP_PAGE_SIZE (200). Client value == schema max, so the 400 mechanism is closed. Also API demonstrably runs the new schema: UAT test 3 re-test passed with segments pageSize=200 (same shared constant). Live differential curl: pageSize=200 -> 404 (validation passed), pageSize=201 -> 400.
  timestamp: 2026-07-07T00:10:00Z

- hypothesis: No campaign was in status='scheduled' when the user ran test 12 (test-8 campaign transitioned to sending within ~60s)
  evidence: DB shows campaign 'Datetime picker' scheduled at 23:48:43+05 for 2026-07-08 (2 days future, deliberately kept scheduled), referencing segment 2c15ff95 ('Город пусто'); that exact segment was saved by the user at 23:55:40+05; UAT session 2 committed 23:57:49+05. The scheduled campaign existed throughout the test window.
  timestamp: 2026-07-07T00:26:00Z

- hypothesis: Response field-name mismatch (snake_case segment_id vs camelCase filter) breaks the find()
  evidence: CAMPAIGN_COLUMNS aliases segment_id AS "segmentId"; toCampaignResponse passes camelCase through. RLS-scoped replication of the exact API query returns segmentId='2c15ff95-...' status='scheduled' — the filter predicate matches this row.
  timestamp: 2026-07-07T00:30:00Z

- hypothesis: The warning lives on a route the user never visits when editing (list-page inline edit vs detail page)
  evidence: App.tsx routes segments/:id -> SegmentDetailPage (the page carrying the banner); SegmentsListPage's row click AND dropdown 'edit' both navigate to /w/:slug/segments/:id. There is no other segment editor. Segment updated_at=23:55:40 proves the save went through this editor.
  timestamp: 2026-07-07T00:18:00Z

- hypothesis: Stale build of @mega-crm/shared-schemas (missing EXHAUSTIVE_LOOKUP_PAGE_SIZE export) breaks the page
  evidence: Package main points at ./src/index.ts (source-resolved by Vite and tsx directly, no dist artifact exists); index.ts re-exports pagination.js. Also the user successfully edited and saved the segment (updated_at 23:55:40), so the page module loaded and functioned.
  timestamp: 2026-07-07T00:34:00Z

- hypothesis: RLS filters the scheduled campaign out of the app role's view
  evidence: SET LOCAL ROLE mega_crm_app + app.current_workspace_id returns all 5 campaigns including the scheduled one; the campaigns list UI also displayed it (test 8/9 passed with «Запланирована» badge visible).
  timestamp: 2026-07-07T00:30:00Z

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-07-07T00:05:00Z
  checked: .planning/debug/knowledge-base.md + prior session campaign-builder-segments-400.md
  found: No knowledge-base.md. Prior session confirmed the old mechanism (pageSize=200 vs max 100 -> 400 before handler) and flagged SegmentDetailPage.tsx:164 as the latent Test 12 gap.
  implication: Must verify the 04-15 fix actually covers this call site and whether a DIFFERENT mechanism now suppresses the warning.

- timestamp: 2026-07-07T00:08:00Z
  checked: apps/web/src/features/segments/SegmentDetailPage.tsx (post-04-15)
  found: "Line 167-171: referencingCampaignsQuery = useQuery({ queryKey: [workspace, slug, campaigns, for-segment-warning], queryFn: listCampaigns(slug, { page: 1, pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE }), enabled: slug && id }). Line 172-174: warning shown when find(c => c.segmentId === id && c.status === 'scheduled') matches. Query error state IS silently swallowed (no isError handling), warning banner at line 257 renders only if a match is found."
  implication: Fix is present at this call site. Warning requires a campaign with status EXACTLY 'scheduled' AND segmentId === current segment id at fetch time.

- timestamp: 2026-07-07T00:10:00Z
  checked: packages/shared-schemas/src/pagination.ts + campaign.ts
  found: EXHAUSTIVE_LOOKUP_PAGE_SIZE=200; campaignListQuerySchema.pageSize = z.coerce.number().int().min(1).max(EXHAUSTIVE_LOOKUP_PAGE_SIZE).optional().default(20)
  implication: pageSize=200 now passes validation; old 400 mechanism closed on the campaigns endpoint too.

- timestamp: 2026-07-07T00:12:00Z
  checked: UAT test 8 wording vs test 12 filter
  found: "Test 8 (passed): 'Within ~60s after the scheduled time, the scheduler worker picks it up and it transitions to sending WITHOUT manual action.' The D-03 filter only matches status === 'scheduled'. A campaign scheduled for a near-future time stops being 'scheduled' within ~60s."
  implication: STRONG candidate hypothesis - by the time the user opened the segment (test 12), the test-8 campaign may have already transitioned scheduled -> sending, so zero campaigns matched the filter. Need DB state to confirm.

- timestamp: 2026-07-07T00:18:00Z
  checked: Web router (App.tsx) + SegmentsListPage navigation + campaigns.routes.ts toCampaignResponse + campaign.repository.ts CAMPAIGN_COLUMNS
  found: "Route /w/:slug/segments/:id -> SegmentDetailPage is the ONLY segment editor; SegmentsListPage row click and dropdown both navigate there. toCampaignResponse returns camelCase fields; CAMPAIGN_COLUMNS aliases segment_id AS \"segmentId\" etc. listCampaigns repository has NO status filter, plain ORDER BY created_at DESC LIMIT pageSize."
  implication: Route-mismatch and field-name-mismatch hypotheses eliminated; repository returns all campaigns including scheduled ones.

- timestamp: 2026-07-07T00:22:00Z
  checked: Live running API differential curl (unauthenticated; query validation runs before auth)
  found: "GET localhost:4000/api/workspaces/localrent/campaigns?page=1&pageSize=200 -> 404 'Workspace not found' (validation PASSED, fell through to auth); pageSize=201 -> 400. Same via Vite proxy on :5173."
  implication: The running API accepts pageSize=200 for campaigns. The old 400 mechanism is definitively closed on the live server.

- timestamp: 2026-07-07T00:26:00Z
  checked: Live DB (read-only psql): campaigns joined to organization + segments tables, workspace localrent
  found: "5 campaigns. Campaign 'Datetime picker' (f8a21d65) status='scheduled', scheduled_at=2026-07-08 23:48+05 (2 days future), segment_id=2c15ff95-74b9-4140-b044-1a6e28538800 (segment 'Город пусто'). Created 23:48:33+05, scheduled 23:48:43+05 on 2026-07-06, unchanged since. Segment 'Город пусто' updated_at=2026-07-06 23:55:40+05 — the user edited and SAVED exactly this segment during test 12, while the campaign was scheduled. UAT session 2 committed 23:57:49+05; 04-15 fix committed 23:12:13+05."
  implication: ELIMINATES the 'no scheduled campaign existed at test time' hypothesis. The precondition data was perfect: scheduled campaign referencing the exact segment the user saved at 23:55:40.

- timestamp: 2026-07-07T00:30:00Z
  checked: RLS-scoped replication of the API's exact query (SET LOCAL ROLE mega_crm_app + app.current_workspace_id='8f518f6a-...', same SELECT as listCampaigns)
  found: "Returns all 5 campaigns including f8a21d65 status='scheduled' segmentId='2c15ff95-74b9-4140-b044-1a6e28538800'."
  implication: The authenticated API response during test 12 contained the scheduled campaign with a segmentId exactly equal to the page's :id param. The find(c => c.segmentId === id && c.status === 'scheduled') predicate matches this data.

- timestamp: 2026-07-07T00:34:00Z
  checked: shared-schemas resolution + export chain + apiGet + QueryClient config
  found: "packages/shared-schemas/package.json main='./src/index.ts' (source-resolved, no dist to go stale); index.ts has export * from './pagination.js'. apiGet throws ApiError on !res.ok (TanStack Query error -> banner silently absent; no isError branch in SegmentDetailPage). queryClient defaults: retry:1, refetchOnWindowFocus:FALSE, staleTime default 0."
  implication: No stale-build vector. But two lifecycle facts matter: (1) query errors are invisible; (2) with refetchOnWindowFocus:false, a mounted page NEVER refetches campaigns — the banner is computed once from the mount-time snapshot.

- timestamp: 2026-07-07T00:38:00Z
  checked: git show b54219d (SegmentDetailPage diff) + git log -S banner copy + 04-08-PLAN.md D-03 spec
  found: "Pre-fix code also sent pageSize:200 with the IDENTICAL filter — only the constant changed. Banner introduced 04-08 (c7f73bb) as a passive mount-time amber inline note per plan ('non-blocking'). handleSave() validates only name/definition and mutates — it performs NO referencing-campaign check, no refetch, no confirm. UAT truth however says 'warns ... BEFORE YOU SAVE changes' and the user report says 'предупреждение ПЕРЕД СОХРАНЕНИЕМ не появляется'."
  implication: The save action — the moment the UAT truth anchors the warning to — has zero D-03 logic. The warning exists only as a mount-time snapshot render.

- timestamp: 2026-07-07T00:42:00Z
  checked: Test coverage for the banner; browser-level reproduction options
  found: "No unit/E2E test references the banner or 'for-segment-warning' anywhere. Browser MCP tools unavailable in this agent session; cannot mint an authenticated session (credentials unknown, .env tool-denied, DB writes prohibited) — direct browser observation not possible from here."
  implication: The banner has never been verified rendering with real data. Final discrimination between 'stale-mount lifecycle gap' and 'rendered but unnoticed' requires a 30-second browser check (documented in Resolution)."

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: "NOT a recurrence of the 04-15 pageSize bug — that fix is verified effective end-to-end (constant=200 == schema max, live API accepts pageSize=200/rejects 201, RLS-scoped data path returns the scheduled campaign with camelCase segmentId matching the page's :id). The remaining defect is the D-03 warning's client-side lifecycle in apps/web/src/features/segments/SegmentDetailPage.tsx: the warning is a one-shot, mount-time-only computation — useQuery(['workspace', slug, 'campaigns', 'for-segment-warning']) fetched once at mount, with the app-wide QueryClient setting refetchOnWindowFocus:false, no refetchInterval, no isError surfacing (fetch failures render as 'no warning'), and handleSave() performing ZERO referencing-campaign check (it only validates name/definition and mutates). Consequently, whenever the campaigns snapshot in the TanStack cache predates the scheduling event — i.e., the segment editor tab/page was mounted before or while the user scheduled the campaign (the exact UAT test-12 flow: campaign scheduled 23:48:43, segment edited over the following minutes and saved 23:55:40) — the warning deterministically never appears, not even at the save click, which is precisely where the UAT truth ('warns ... before you save changes') and the user's report ('предупреждение перед сохранением не появляется') anchor the expectation. Secondary contributing gap: the banner has zero unit/E2E coverage, so it has never been observed rendering with real data."
fix: "(not applied — find_root_cause_only) Direction: move/duplicate the D-03 check to save time — in handleSave, before mutate(), refetch the referencing-campaigns lookup (await queryClient.fetchQuery or referencingCampaignsQuery.refetch()) and if a scheduled campaign references the segment, require an explicit confirm (dialog or inline warning + second click). Additionally: surface referencingCampaignsQuery.isError as a muted note instead of silently rendering nothing, and add a component test with a mocked scheduled campaign asserting the banner + save-time warning render. Optional hardening: per-mount fresh key or refetchOnMount:'always' for the warning query."
verification: "(n/a — diagnosis only) Discriminator for the fixer: open /w/localrent/segments/2c15ff95-74b9-4140-b044-1a6e28538800 in a FRESH tab today (campaign 'Datetime picker' is still scheduled until 2026-07-08) — the amber banner should render, proving the mount-time path works and isolating the gap to the stale-mount/save-time lifecycle; if it does NOT render even on fresh mount, capture the network response of GET /api/workspaces/localrent/campaigns?page=1&pageSize=200 in devtools (all server-side layers are verified, so any residual failure must be visible there)."
files_changed: []

## Closure Note (milestone v1.0 close)

Resolved at v1.0 milestone close on 2026-07-14: diagnosis was handed to plan-phase --gaps; fix shipped via gap-closure plans (see phase 01/04/05/06 gap plans) or recorded as external-env tech debt in v1.0-MILESTONE-AUDIT.md.
