---
phase: 04-broadcast-campaigns-send-pipeline
reviewed: 2026-07-06T18:22:15Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - apps/web/src/features/campaigns/CampaignBuilderPage.tsx
  - apps/web/src/features/campaigns/CampaignsListPage.tsx
  - apps/web/src/features/segments/SegmentDetailPage.tsx
  - packages/shared-schemas/src/__tests__/pagination.test.ts
  - packages/shared-schemas/src/campaign.ts
  - packages/shared-schemas/src/index.ts
  - packages/shared-schemas/src/pagination.ts
  - packages/shared-schemas/src/segment.ts
findings:
  critical: 0
  warning: 2
  info: 3
  total: 5
status: issues_found
---

# Phase 04: Code Review Report — Post-04-15 Delta Review

**Reviewed:** 2026-07-06T18:22:15Z
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found (warnings only — no blockers)

> Delta review of the 04-15 gap-closure change only (commits e67113f..b54219d over
> a4598d9), superseding the prior 04-14 delta report (unsubscribe content-type;
> warnings only, no blockers — remains in git history).

## Narrative Findings (AI reviewer)

## Summary

Reviewed the 04-15 delta: the new `EXHAUSTIVE_LOOKUP_PAGE_SIZE = 200` constant in
`packages/shared-schemas/src/pagination.ts`, the widened `segmentListQuerySchema` /
`campaignListQuerySchema` `pageSize` bounds referencing it, the contract regression test,
and the three web call sites repointed at the constant.

The core fix is correct and verified end-to-end:

- All three call sites (`CampaignBuilderPage.tsx:37`, `CampaignsListPage.tsx:72`,
  `SegmentDetailPage.tsx:169`) now send the exact constant the schemas enforce as `max` —
  the client/server contract can no longer drift silently. No leftover hardcoded
  `pageSize: 200`/`100` literals remain at exhaustive-lookup call sites (grep-verified).
- The server honors the widened bound: both route handlers
  (`apps/api/src/modules/segments/segments.routes.ts:127`,
  `apps/api/src/modules/campaigns/campaigns.routes.ts:168`) pass `parsed.data` straight into
  repository queries using parameterized `LIMIT $n OFFSET $n` — no hidden clamp, no SQL
  injection surface.
- The contract test suite runs and passes (18/18 in `packages/shared-schemas`), pinning the
  accepted value, the rejected boundary (+1), min/integer constraints, and the default of 20.
- `index.ts`'s new `export * from "./pagination.js"` introduces no name collisions.
- `segmentMembersQuerySchema` correctly keeps its literal `max(100)` — members are
  high-cardinality and not an exhaustive-lookup surface.

However, the fix moved the failure mode rather than eliminating it: the original bug was a
loud 400 when the client's lookup pageSize exceeded the schema ceiling; the surviving gap is
*silent truncation* when a workspace exceeds 200 segments/campaigns — nothing enforces that
bound server-side and no call site checks `total`. Findings below.

## Warnings

### WR-01: "Exhaustive" lookups silently truncate past 200 rows with no total check — the D-03 safety warning can silently disappear

**File:** `apps/web/src/features/segments/SegmentDetailPage.tsx:167-174` (also `apps/web/src/features/campaigns/CampaignBuilderPage.tsx:35-41`, `apps/web/src/features/campaigns/CampaignsListPage.tsx:70-80`)
**Issue:** All three call sites fetch only `page: 1` with `pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE`
and never inspect the `total` field the API already returns. There is no server-side cap on
segments or campaigns per workspace (grep-verified: no MAX_SEGMENTS/MAX_CAMPAIGNS-style limit
exists anywhere in `apps/api` or `packages`), so past 200 rows each site degrades silently:

1. `SegmentDetailPage` (sharpest edge): the D-03 warning — "a scheduled campaign references
   this segment; editing changes its audience" — is an explicit safety mechanism. With >200
   campaigns, the scheduled one can fall outside page 1 (list ordering is recency-based, so
   its position is arbitrary), the warning is silently absent, and a marketer edits a live
   scheduled campaign's audience with no notice. The comment at line 166 ("workspace campaign
   counts are small") is an assumption, not an enforced invariant.
2. `SegmentPicker` (CampaignBuilderPage): segments beyond row 200 cannot be selected at all.
3. `CampaignsListPage`: campaigns referencing segments beyond row 200 show "—" as audience.

This is the same failure class the 04-15 debug session fixed (client asks for more than the
contract delivers), moved from a loud 400 to silent data loss. The degradation is detectable
for free from the response's `total`.
**Fix:** At minimum, detect truncation and surface it, e.g. in each lookup consumer:

```tsx
const lookupTruncated =
  (referencingCampaignsQuery.data?.total ?? 0) > EXHAUSTIVE_LOOKUP_PAGE_SIZE;
// SegmentDetailPage: when lookupTruncated, render the amber notice in a
// "could not verify all campaigns" form instead of omitting it entirely.
```

Longer term, the D-03 check should be a dedicated server query — the repository already has
exactly this shape for the delete guard
(`apps/api/src/modules/segments/segment.repository.ts:305`:
`SELECT name FROM campaigns WHERE workspace_id = $1 AND segment_id = $2 ... LIMIT 1`);
exposing a scheduled-status variant removes the exhaustive fetch from this path entirely.

### WR-02: SegmentPicker keys cmdk items by segment name — duplicate names can select the wrong segment

**File:** `apps/web/src/features/campaigns/CampaignBuilderPage.tsx:66`
**Issue:** `<CommandItem key={segment.id} value={segment.name} ...>` — cmdk identifies and
matches items by `value`, and segment names have no uniqueness constraint (the repository's
`SegmentConflictError` covers only delete-time referential conflicts, not name collisions;
`createSegmentSchema` imposes none). Two segments named "VIP" produce two cmdk items with
identical values: filtering/highlighting becomes ambiguous and selecting one can fire the
other item's `onSelect`, silently pointing the campaign at the wrong audience — a
consequential mis-selection for a broadcast send. Pre-existing pattern, but line 66's
component is squarely in this delta's blast radius (its query is what 04-15 fixed).
**Fix:** Key the item by id and keep the name for text filtering:

```tsx
<CommandItem
  key={segment.id}
  value={segment.id}
  keywords={[segment.name]}
  onSelect={() => choose(segment.id)}
>
  {segment.name}
</CommandItem>
```

## Info

### IN-01: Identical segment lookup duplicated under two query keys

**File:** `apps/web/src/features/campaigns/CampaignBuilderPage.tsx:36` and `apps/web/src/features/campaigns/CampaignsListPage.tsx:71`
**Issue:** Both run the exact same request
(`listSegments(slug, { page: 1, pageSize: EXHAUSTIVE_LOOKUP_PAGE_SIZE })`) but under
different query keys (`"picker"` vs `"all-for-lookup"`), so TanStack Query caches and fetches
the same data twice per workspace session. The 04-15 change touched both lines and was the
natural moment to converge them.
**Fix:** Extract a shared `queryOptions` helper (e.g. `segmentsLookupQuery(slug)`) in
`apps/web/src/features/segments/api.ts` holding the single key + queryFn; both pages consume it.

### IN-02: Contract test never exercises the string form that actually crosses the wire

**File:** `packages/shared-schemas/src/__tests__/pagination.test.ts:19,27`
**Issue:** The routes parse `request.query`, where `pageSize` arrives as the *string* `"200"`
and relies on `z.coerce.number()`. The test feeds only numbers, so the coercion path — the
one production traffic takes — is unpinned. A future refactor from `z.coerce.number()` to
`z.number()` would keep this suite green while reintroducing a 400 on every real request —
the exact regression class this contract test exists to prevent.
**Fix:** Add one assertion per schema:
`expect(segmentListQuerySchema.safeParse({ pageSize: String(EXHAUSTIVE_LOOKUP_PAGE_SIZE) }).success).toBe(true);`

### IN-03: Public API max page size is now coupled to a UI lookup constant

**File:** `packages/shared-schemas/src/pagination.ts:15` (consumed at `segment.ts:154`, `campaign.ts:39`)
**Issue:** The single-source-of-truth design is intentional and well documented, but note the
coupling direction: `EXHAUSTIVE_LOOKUP_PAGE_SIZE` is semantically a *client* lookup size, yet
it now defines the *public API* ceiling for `GET /segments` and `GET /campaigns` for all
consumers (including API-key integrations). If WR-01 is later "fixed" by bumping the constant
to a large value, the public list endpoints' max page size silently balloons with it.
**Fix:** If the constant ever needs to grow, split into `MAX_LIST_PAGE_SIZE` (API bound) and
`EXHAUSTIVE_LOOKUP_PAGE_SIZE` (client value) with a test asserting
`EXHAUSTIVE_LOOKUP_PAGE_SIZE <= MAX_LIST_PAGE_SIZE`. No action needed at 200.

---

_Reviewed: 2026-07-06T18:22:15Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
