---
phase: 03-segmentation-engine
verified: 2026-07-05T19:42:38Z
status: gaps_found
score: 2/4 must-haves verified
behavior_unverified: 2 # SEGM-02 behavioral-row conditional UI, SEGM-04 degraded/timeout amber state -- present + wired, no automated test exercises them
overrides_applied: 0
gaps:
  - truth: "A user can build and save a segment from profile attributes (country, tags, custom properties)."
    status: failed
    reason: >
      Two independently-verified defects break this truth as literally stated by the ROADMAP success
      criterion and by SEGM-01's own requirement text ("страна, теги, кастомные атрибуты"):
      (1) Tag-based conditions (has_tag/not_has_tag) are fully supported end-to-end by the compiler
      (packages/segments-core), the Zod contract, the DB migration (idx_contacts_tags_gin), and the API
      integration tests -- but the SegmentBuilder UI's STANDARD_FIELDS list never includes "tags", so
      there is no user-reachable way to build a tag-based segment. A marketer literally cannot do the
      one thing the success criterion names as an example.
      (2) CR-01 (from 03-REVIEW.md, independently re-verified by reading the live code): the create
      page's builder opens with a default, unconfigured attribute condition (field: ""). Client-side
      validateDefinition() only checks behavioral conditions and empty groups -- never attribute-field
      emptiness. packages/shared-schemas/src/segment.ts's attributeConditionSchema uses field: z.string()
      with no allow-list, so the empty field passes Zod. POST /segments has no try/catch around
      createSegment(), so compileAttributeCondition's "Unknown standard field: " throw propagates as an
      uncaught 500. The create mutation in SegmentCreatePage.tsx has no onError handler and never renders
      mutation.isError, so the failure is completely silent to the user -- clicking "Сохранить сегмент"
      on the pre-filled default row does nothing visible.
    artifacts:
      - path: "apps/web/src/features/segments/SegmentBuilder.tsx"
        issue: "STANDARD_FIELDS (lines 42-49) omits `tags` -- has_tag/not_has_tag unreachable from the UI despite full engine support"
      - path: "apps/web/src/features/segments/SegmentCreatePage.tsx"
        issue: "validateDefinition() (lines 18-35) does not reject an attribute condition with an empty field; mutation (lines 52-59) has no onError/error rendering"
      - path: "packages/shared-schemas/src/segment.ts"
        issue: "attributeConditionSchema's standard field: z.string() (line 44) has no allow-list -- an empty or unknown field passes validation and only fails inside the compiler"
      - path: "apps/api/src/modules/segments/segments.routes.ts"
        issue: "POST /segments (lines 125-144) has no try/catch around createSegment -- a compiler throw becomes an unhandled 500"
    missing:
      - "Add a tags condition row to SegmentBuilder (STANDARD_FIELDS entry + tags operator group), or explicitly document the omission as an intentional deferral"
      - "Constrain attributeConditionSchema's standard-source field to an enum of STANDARD_FIELD_COLUMNS keys (closing the CR-01/WR-01 validation gap at the boundary)"
      - "Add an attribute-field-emptiness check to validateDefinition and an onError handler + error UI to the create mutation (matches the pattern already used in SegmentDetailPage)"
deferred: []
behavior_unverified_items:
  - truth: "A user can add behavioral conditions over events with count and timeframe (SEGM-02)"
    test: "In the builder, add a behavioral condition; verify the count input hides when 'ни разу' (none) is selected and the days input hides when 'за всё время' (all_time) is selected; verify the condition round-trips through save/load."
    expected: "Count-operator/timeframe conditional inputs show/hide correctly and the saved definition matches what was configured."
    why_human: "No E2E or unit test exercises the behavioral condition row in the UI (the E2E only builds an attribute condition). 03-03-SUMMARY.md's own coverage table (D3) already flags this as human_judgment: true, status: unknown. Code inspection shows the conditional-rendering logic is present and appears correct, but it is not proven by an automated check."
  - truth: "A live count of matching contacts updates as the user edits conditions, with a graceful degraded state (SEGM-04/D-08)"
    test: "Force a preview-count request to exceed the 2000ms statement_timeout (e.g. a pathological definition or a throttled DB) and verify the UI keeps the last exact count dimmed with the amber '(устарело)' warning, rather than blanking to zero or erroring."
    expected: "The degraded state renders per the UI-SPEC copy contract and never loses the last known count."
    why_human: "The happy-path live count is proven by a passing E2E and a passing preview-count integration test, but the `{ degraded: true }` UI path has no automated trigger in current test data volume (03-03-SUMMARY.md D4, human_judgment: true)."
---

# Phase 3: Segmentation Engine Verification Report

**Phase Goal:** A marketer can define dynamic audiences by profile attributes and behavior, seeing how many contacts match as they build — using one segment engine that flows and campaigns will both share.
**Verified:** 2026-07-05T19:42:38Z
**Status:** gaps_found
**Re-verification:** No — initial verification

**Note on ROADMAP `Mode: mvp`:** The phase is tagged `Mode: mvp` in ROADMAP.md, but its goal text ("A marketer can define dynamic audiences...") does not conform to the "As a [role], I want to [capability], so that [outcome]." User Story format required for MVP Mode Verification (`gsd_run query user-story.validate` returns `valid: false`). Per the MVP-mode instructions this would normally require refusing verification and requesting a `/gsd mvp-phase` reformat; since the invoking task explicitly supplied standard ROADMAP success criteria (not user-flow steps) for this verification pass, this report proceeds as a standard goal-backward verification and simply flags the mode/goal-format mismatch here for the developer's attention. It does not change the findings below.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A user can build and save a segment from profile attributes (country, tags, custom properties). | ✗ FAILED (partial) | Country + custom-property paths work (E2E passes, API tests green). Tags condition engine-complete but unreachable in the builder UI (no `tags` entry in `STANDARD_FIELDS`). CR-01: saving the default unconfigured attribute condition throws inside the compiler, is uncaught by `POST /segments`, surfaces as a silent 500 (no `onError` in the create mutation) — independently re-verified by reading `SegmentCreatePage.tsx`, `segment.ts`, and `segments.routes.ts`. |
| 2 | A user can add behavioral conditions over events ("ordered in last 30 days", "didn't open in 90 days") with count and timeframe. | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (UI) / ✓ VERIFIED (engine+API) | `behavioral-conditions.test.ts` passes (16/16 segments suite green) proving EXISTS/NOT EXISTS with count>1, `last_days`/`all_time` timeframe, and negation at the DB/API tier. `BehavioralConditionRow` in `SegmentBuilder.tsx` implements the conditional count/timeframe inputs correctly per code read, but no E2E/unit test exercises the UI row — carried forward from 03-03-SUMMARY.md (D3, human_judgment: true). |
| 3 | As the user edits segment conditions, a live count of matching contacts updates. | ✓ VERIFIED (happy path) / ⚠️ degraded-state unverified | `apps/web/e2e/segments.spec.ts` passes live (re-run during this verification): builder → live count visible → save. `queryKey` grep confirms the full `SegmentDefinition` JSON is part of the TanStack Query key (Pitfall-6 stale-response guard). `preview-count.test.ts` passes. The `{ degraded: true }` amber-warning path (statement_timeout exceeded) has no automated trigger — human-verify item (03-03-SUMMARY.md D4). |
| 4 | The same saved segment definition resolves an identical membership set whether queried for a campaign audience or a flow trigger. | ✓ VERIFIED | `unified-engine-contract.test.ts` passes (re-run during this verification, part of the 16/16 segments suite): `count`/`listMembers`/`isMember` agree for the same definition. Structurally guaranteed — `countSegmentMembers`/`listSegmentMembers`/`isContactInSegment` all call the single `compileSegmentDefinition` from `@mega-crm/segments-core` (confirmed by reading `segment.repository.ts` and `compile.ts`), so this is not test-only. |

**Score:** 2/4 truths verified (2 present, behavior-unverified as noted; 1 failed)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/segments-core/{types,operators,compile,index}.ts` | Pure two-tier AND/OR SQL compiler | ✓ VERIFIED | Exists, builds clean (`tsc`), 16/16 vitest unit tests pass (re-run). `@> ARRAY[` (GIN-friendly tag containment) confirmed present. |
| `packages/shared-schemas/src/segment.ts` | Single Zod contract for SegmentDefinition + CRUD/preview-count shapes | ✓ VERIFIED but under-constrained | Exists, builds clean, exported from index.ts. Standard `field` is `z.string()` with no allow-list — this is the root cause of the CR-01/WR-01 gap above; the contract exists and is wired everywhere but does not fully perform its stated "fails closed" role. |
| `packages/db/src/schema/segments.ts` + migrations 0011/0012 | segments table, RLS, GIN index, applied to live DB | ✓ VERIFIED | Migrations present; live DB check (`psql`) confirms `relrowsecurity AND relforcerowsecurity = t`, `workspace_isolation` policy present, `idx_contacts_tags_gin` exists. |
| `apps/api/src/modules/segments/segment.repository.ts` | count/list/isMember + CRUD, one compiled WHERE | ✓ VERIFIED | 9 `withTenantTransaction` wrappers confirmed (one per exported query fn). |
| `apps/api/src/modules/segments/event-names.repository.ts` | Loose-index-scan distinct event names | ✓ VERIFIED | `WITH RECURSIVE` confirmed present. |
| `apps/api/src/modules/segments/segments.routes.ts` (registered) | Full HTTP surface, 404-not-409 auth | ✓ VERIFIED (with the CR-01 caveat above) | Registered in `server.ts`; routes exist. `POST /segments` lacks the try/catch other consumers of `countSegmentMembers`/`compileSegmentDefinition` have (only `preview-count` catches). |
| `apps/web/src/features/segments/SegmentBuilder.tsx` | Attribute + behavioral condition tree, groups, comboboxes, recap | ⚠️ WIRED but feature-incomplete | Builds clean, exercised live by E2E for the attribute path. Tags condition kind is absent (see gap above). |
| `apps/web/src/features/segments/{SegmentCreatePage,SegmentsListPage,SegmentDetailPage,DeleteSegmentDialog}.tsx` | Create/list/detail/delete UI | ✓ VERIFIED | All present, build clean, exercised live by the passing E2E (create → live count → save → detail → members → delete). |
| `apps/web/e2e/segments.spec.ts` | Playwright happy-path | ✓ VERIFIED | Re-run live during this verification: 1/1 passed. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `segment.repository.ts` (count/list/isMember) | `@mega-crm/segments-core`'s `compileSegmentDefinition` | Direct import, one compiled WHERE, three tails | ✓ WIRED | Confirmed by code read; proven by `unified-engine-contract.test.ts` (re-run, pass). |
| `SegmentBuilder.tsx` live-count panel | `POST /segments/preview-count` | TanStack `useQuery` with full definition JSON as `queryKey` | ✓ WIRED | `grep` confirms definition is part of the queryKey; E2E confirms the live count renders. |
| `segments.routes.ts` | `withTenantTransaction`/RLS | `withTenant(workspace.id, () => repoFn())` on every route | ✓ WIRED | Confirmed by code read across CRUD, members, preview-count, event-names routes. |
| `SegmentCreatePage.tsx` save | `POST /segments` → `createSegment` → compiler | Zod `safeParse` → server compile | ✗ PARTIALLY WIRED | The link exists but the validation gate it depends on (Zod `field` allow-list) is missing, and the error path back to the user is absent (no `onError`) — see gap above. |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| SEGM-01 | 03-01, 03-02, 03-03, 03-04 | Build a dynamic segment by profile attributes (country, tags, custom properties) | ✗ BLOCKED (partial) | Country/custom-property paths proven; tags path unreachable in UI; default-state save silently 500s (CR-01, re-verified). |
| SEGM-02 | 03-01, 03-02, 03-03 | Behavioral conditions with count/timeframe | ✓ SATISFIED (engine/API) / human-verify (UI) | `behavioral-conditions.test.ts` passes; UI conditional rendering not automatically tested. |
| SEGM-03 | 03-01, 03-02, 03-04 | Single engine shared by campaigns/flows | ✓ SATISFIED | `unified-engine-contract.test.ts` passes; structural single-compiler design confirmed. |
| SEGM-04 | 03-02, 03-03 | Live preview count while building | ✓ SATISFIED (happy path) / human-verify (degraded state) | `preview-count.test.ts` + E2E pass; timeout-degraded UI path untested. |

No orphaned requirements: `.planning/REQUIREMENTS.md`'s Phase 3 mapping (SEGM-01..04) matches exactly the requirement IDs declared across all four plans' frontmatter.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `packages/segments-core/src/compile.ts` / `operators.ts` | 47, 17-25 | `STANDARD_FIELD_COLUMNS[cond.field]` plain-object lookup resolves inherited `Object.prototype` members (`constructor`, `toString`, etc.) | ⚠️ Warning | Not an injection vector (native-code stringification only), but violates the compiler's own stated "fails closed on unknown field" guarantee — surfaces as a confusing 500 instead of a clean throw for pathological input. (03-REVIEW.md WR-01, re-confirmed by code read.) |
| `packages/segments-core/src/operators.ts` | ~55 | `contains`/`not_contains` don't escape `%`/`_`/`\` in the ILIKE pattern | ⚠️ Warning | Wrong (not just insecure) membership results for values containing SQL LIKE wildcard characters — a correctness bug in the product's core promise. (WR-04) |
| `apps/api/src/modules/segments/segments.routes.ts` / `segment.repository.ts` | multiple | `statement_timeout` DoS bound applies only to `preview-count`; `POST/PATCH /segments` and `GET /:id/members` run the same compiled query unbounded | ⚠️ Warning | Real DoS exposure for the create/update/members paths that the phase's own threat model (T-03-04) says should be bounded. (WR-03) |
| `apps/web/src/features/segments/SegmentsListPage.tsx` | ~22 | List query hardcodes `page: 1` with no pagination controls | ⚠️ Warning | 21st+ segment in a workspace is invisible in the UI despite the API supporting pagination. (WR-05) |
| `apps/web/src/features/segments/SegmentDetailPage.tsx` | ~230-249 | Error state renders an infinite skeleton instead of a not-found card | ⚠️ Warning | Dead code path; a deleted/bad segment id hangs the detail page instead of showing an error. (WR-06) |

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/placeholder-comment markers found in any phase-modified source file (grep across all 14 key implementation files was clean).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Compiler unit suite | `npx vitest run packages/segments-core` | 16/16 passed | ✓ PASS |
| API segments integration suite | `npm run test -w apps/api -- src/modules/segments` | 16/16 passed (4 files) | ✓ PASS |
| Web build | `npm run build -w apps/web` | tsc + vite clean | ✓ PASS |
| Workspace builds | `npm run build -w packages/segments-core -w packages/shared-schemas -w apps/api` | all clean | ✓ PASS |
| Live DB: RLS + policy + index | `psql ... pg_class/pg_policies/pg_indexes` | RLS forced, `workspace_isolation` present, `idx_contacts_tags_gin` present | ✓ PASS |
| E2E happy path | `npm run test:e2e -w apps/web -- segments.spec.ts` | 1/1 passed (live re-run) | ✓ PASS |
| CR-01 reproduction (code trace) | Read `SegmentCreatePage.tsx` → `segment.ts` → `compile.ts` → `segments.routes.ts` | Confirmed: empty-field default condition passes Zod, throws in compiler, uncaught in route, no client `onError` | ✗ FAIL (confirms the gap) |
| Tags reachability in builder | `grep STANDARD_FIELDS SegmentBuilder.tsx` | 6 fields listed, no `tags` | ✗ FAIL (confirms the gap) |

### Human Verification Required

### 1. Behavioral condition row functional check

**Test:** In the segment builder, add a behavioral condition. Toggle "выполнено ≥ N раз" vs "ни разу" and "за последние N дней" vs "за всё время". Save and reopen the segment.
**Expected:** Count input appears only for "≥N"; days input appears only for "last N days"; the saved/reloaded definition matches what was configured.
**Why human:** No automated test (E2E or unit) exercises the behavioral row's conditional UI; only the compiler/API layer is proven. Carried forward from 03-03-SUMMARY.md (D3).

### 2. Live-count degraded (timeout) state

**Test:** Trigger a preview-count request that exceeds the 2000ms `statement_timeout` (e.g., a definition with many custom-property conditions against a large contact set, or a temporarily throttled DB) and observe the builder.
**Expected:** The last known count stays visible, dimmed, with the amber "(устарело)" warning — never blanks to zero or shows a raw error.
**Why human:** No automated trigger for this path exists at current test data volume. Carried forward from 03-03-SUMMARY.md (D4).

### 3. Dynamic membership on definition edit (D-13)

**Test:** Open a saved segment's detail page, change a condition (e.g., widen the country filter), save, and confirm the "Участники" member table and count refresh to reflect the new definition without a page reload.
**Expected:** Member list and any displayed count update to match the edited definition.
**Why human:** The E2E only opens a freshly created segment and reads members once; it does not edit-then-resave-then-reverify. Carried forward from 03-04-SUMMARY.md (D2).

### 4. List enrichment visual/data check (D-11)

**Test:** View the segments list with at least one segment that has a non-null `member_count`/`member_count_at` and one whose author differs from the viewer.
**Expected:** Member-count renders in Display weight with a correctly formatted "на {дата, время}" freshness line; the author name resolves correctly via `GET /members` (not a raw id or blank).
**Why human:** No automated assertion checks the visual styling or that the resolved author name is correct — the E2E interacts with the row but doesn't read these cell values. Carried forward from 03-04-SUMMARY.md (D4).

### Gaps Summary

The engine layer (compiler, schema, DB, API) is solid and independently re-verified: all 32 unit/integration tests across `packages/segments-core` and `apps/api/src/modules/segments` pass, RLS/GIN are live in the database, and SEGM-03's "identical membership" guarantee is both structurally true (one compiler function) and test-proven (`unified-engine-contract.test.ts`).

The gap is at the product surface, and it is real, not cosmetic: (1) the ROADMAP success criterion and SEGM-01's own requirement text explicitly name "tags" as an example of a profile-attribute segment, and the shipped builder UI has no way to create one, despite the engine, schema, migration, and API tests all supporting it; (2) the create flow's default state — the very first thing a marketer sees when they click "Создать сегмент" — silently fails with an unhandled 500 if saved without first touching the pre-filled condition row, because validation was added at the client (behavioral only) and nowhere closes the loop at the server (Zod's unconstrained `field: z.string()`) or in the UI's error handling (no `onError`). Both were flagged as CRITICAL/BLOCKER findings in `03-REVIEW.md` and remain unfixed in the current commit (`bb7fece`) — no commit after the review touches any of the four implicated files.

These two items directly block "A user can build and save a segment from profile attributes (country, tags, custom properties)" as literally stated, so the phase cannot be marked passed. The remaining three success criteria (behavioral conditions, live count, shared-engine membership) are structurally and mostly test-proven, with UI-specific edge cases correctly deferred to end-of-phase human verification per this project's established `human_verify_mode: end-of-phase` convention.

---

_Verified: 2026-07-05T19:42:38Z_
_Verifier: Claude (gsd-verifier)_
