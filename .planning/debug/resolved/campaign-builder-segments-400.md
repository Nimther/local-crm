---
status: resolved
trigger: "UAT Test 3 (Phase 04): Не могу выбрать сегмент аудитории — сегменты не отображаются. В консоли ошибка http://localhost:5173/api/workspaces/localrent/segments?page=1&pageSize=200 400 (Bad Request)"
created: 2026-07-06T18:00:00Z
updated: 2026-07-06T18:20:00Z
mode: find_root_cause_only
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: CONFIRMED — campaign UI requests pageSize=200 while segmentListQuerySchema caps pageSize at max(100); Zod safeParse fails and the route returns 400 before the handler runs
test: complete — code read on both sides + live differential curl reproduction
expecting: n/a
next_action: return ROOT CAUSE FOUND diagnosis (goal: find_root_cause_only — no fix applied)

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: In the campaign builder, the segment picker lists the workspace's segments for selection
actual: "Не могу выбрать сегмент аудитории — сегменты не отображаются. В консоли ошибка http://localhost:5173/api/workspaces/localrent/segments?page=1&pageSize=200 400 (Bad Request)"
errors: GET /api/workspaces/localrent/segments?page=1&pageSize=200 → 400 (Bad Request), observed in browser console via the Vite dev proxy
reproduction: Test 3 in .planning/phases/04-broadcast-campaigns-send-pipeline/04-UAT.md — open campaign builder, try to pick a segment
started: Discovered during UAT immediately after Phase 4 completion; segments UI itself (Phase 3) reportedly worked during Phase 3 UAT

## Eliminated
<!-- APPEND only - prevents re-investigating -->

- hypothesis: Regression in the Phase 3 segments API route or repository itself
  evidence: Route and schema are unchanged Phase 3 code; Phase 3's own UI (SegmentsListPage.tsx:22 PAGE_SIZE=20, SegmentDetailPage.tsx:21 MEMBERS_PAGE_SIZE=20) stays within the max(100) bound and still works. The 400 only occurs for the new Phase 4 callers that send pageSize=200.
  timestamp: 2026-07-06T18:15:00Z

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-07-06T18:00:00Z
  checked: .planning/debug/ for knowledge base
  found: No knowledge-base.md exists; one resolved session (contact-search-focus-loss) unrelated to this symptom
  implication: No known-pattern shortcut; proceed with primary hypothesis from UAT diagnosis context

- timestamp: 2026-07-06T18:05:00Z
  checked: apps/web/src/features/campaigns/CampaignBuilderPage.tsx
  found: "line 36: SegmentPicker's query calls listSegments(slug, { page: 1, pageSize: 200 }) (listSegments imported from @/features/segments/api at line 14). This is exactly the failing request URL from the user report."
  implication: The campaign builder is the direct producer of the pageSize=200 request

- timestamp: 2026-07-06T18:07:00Z
  checked: apps/api/src/modules/segments/segments.routes.ts
  found: "lines 127-130: GET /api/workspaces/:slug/segments runs segmentListQuerySchema.safeParse(request.query) and returns reply.code(400).send({ error: parsed.error.flatten() }) on failure — BEFORE resolveWorkspaceMember runs (line 132)"
  implication: 400 is produced by query validation, before auth/handler; matches the observed status exactly

- timestamp: 2026-07-06T18:08:00Z
  checked: packages/shared-schemas/src/segment.ts
  found: "line 152: segmentListQuerySchema.pageSize = z.coerce.number().int().min(1).max(100).optional().default(20) — max is 100, request sends 200"
  implication: 200 > 100 fails Zod validation deterministically — mechanism complete

- timestamp: 2026-07-06T18:10:00Z
  checked: apps/web/src/features/segments/ (Phase 3 UI) for its own pageSize values
  found: "SegmentsListPage.tsx:22 PAGE_SIZE=20; SegmentDetailPage.tsx:21 MEMBERS_PAGE_SIZE=20 — both within max(100)"
  implication: Explains why Phase 3 UAT passed — Phase 3's own callers never exceeded the bound; the bug was introduced by Phase 4 callers reusing the route with a larger pageSize

- timestamp: 2026-07-06T18:12:00Z
  checked: Other Phase 4 call sites sending pageSize=200 (same bug class)
  found: "(1) apps/web/src/features/campaigns/CampaignsListPage.tsx:71 — listSegments(slug, { page: 1, pageSize: 200 }) for segment-name lookup in the campaign list; (2) apps/web/src/features/segments/SegmentDetailPage.tsx:164 — listCampaigns(slug, { page: 1, pageSize: 200 }) for the D-03 scheduled-campaign warning; packages/shared-schemas/src/campaign.ts:37 caps campaigns pageSize at max(100) too (validated at apps/api/src/modules/campaigns/campaigns.routes.ts:168)"
  implication: Three call sites fail identically. (2) fails SILENTLY (useQuery error unhandled, warning just never shows) — would surface later as UAT Test 12 failure. (1) makes segment names blank on the campaigns list. All must be covered by the gap-closure plan, not just the reported picker.

- timestamp: 2026-07-06T18:18:00Z
  checked: Live differential reproduction against running API (localhost:4000, unauthenticated — query validation runs before auth so no session needed)
  found: "curl '.../segments?page=1&pageSize=200' → 400 with body {\"error\":{\"formErrors\":[],\"fieldErrors\":{\"pageSize\":[\"Too big: expected number to be <=100\"]}}}; curl same URL with pageSize=100 → 404 (validation passes, falls through to unauthenticated workspace-not-found)"
  implication: Root cause confirmed by direct observation, not just code reading — the 400 is precisely the Zod pageSize<=100 rejection

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: "Client/server contract mismatch on the pageSize bound. Phase 4 UI code requests pageSize=200 from list endpoints whose shared Zod query schemas cap pageSize at max(100): CampaignBuilderPage.tsx:36 and CampaignsListPage.tsx:71 call listSegments with pageSize 200 against segmentListQuerySchema (packages/shared-schemas/src/segment.ts:152, max(100)), rejected at segments.routes.ts:127-130 with 400 before the handler runs; SegmentDetailPage.tsx:164 calls listCampaigns with pageSize 200 against campaignListQuerySchema (packages/shared-schemas/src/campaign.ts:37, max(100)), rejected at campaigns.routes.ts:168 — same class, silent failure (D-03 warning never renders). Live repro: 400 body = fieldErrors.pageSize ['Too big: expected number to be <=100']. Phase 3 UAT passed because Phase 3's own callers use pageSize 20."
fix: "(not applied — find_root_cause_only)"
verification: "(n/a)"
files_changed: []

## Closure Note (milestone v1.0 close)

Resolved at v1.0 milestone close on 2026-07-14: diagnosis was handed to plan-phase --gaps; fix shipped via gap-closure plans (see phase 01/04/05/06 gap plans) or recorded as external-env tech debt in v1.0-MILESTONE-AUDIT.md.
