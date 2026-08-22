---
phase: 21-per-contact-dsr-export
verified: 2026-08-22T13:41:17Z
status: human_needed
score: 16/16 must-haves verified
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Real blob download of the DSR export in a browser (21-01-PLAN.md Task 3 human-check): click the Export button on a live contact card and confirm a file named dsr-export-{contactId}-{YYYY-MM-DD}.json actually downloads and opens as valid JSON."
    expected: "A JSON file downloads via the browser's normal download flow (Blob + synthetic anchor click), openable and readable, filename carries no PII."
    why_human: "URL.createObjectURL + synthetic anchor click is a real-browser side effect; the repo's test lane (renderToStaticMarkup, no jsdom/@testing-library) cannot exercise an actual file download."
  - test: "Two-tab race (21-04-PLAN.md Task 2 human-check): open a contact's card in tab A, anonymize/erase that same contact in tab B, then click Export in tab A."
    expected: "Tab A's Export click gets the API's typed 410, the on-screen message flips to the erased-contact copy, and the contact query invalidation drives the card into its existing not-found/disabled state rather than staying clickable."
    why_human: "Requires two real browser tabs against a running dev stack with an actual race between an erasure and an in-flight export request; not reachable from the mocked-hook unit test lane used in this repo."
  - test: "Narrow-viewport visual check (UI-SPEC E1/E2 backstop items): resize the contact-card header (Export + Delete buttons row) and the inline reason/error paragraph beside the Export button to a narrow viewport width."
    expected: "The header actions row wraps onto a new line rather than clipping or overflowing; the inline reason/error paragraph wraps to multiple lines rather than being cut off."
    why_human: "This is a rendered-layout/CSS behavior. The header row's container (`flex items-center justify-between gap-4` / `flex items-center gap-2`, ContactDetailPage.tsx ~lines 299-308) carries no explicit `flex-wrap` utility class visible in the source, so whether it wraps or clips at narrow widths cannot be confirmed by static grep/read — it needs an actual rendered viewport check, and UI-SPEC.md itself designates both items `verification: backstop` with 'no explicit narrow-viewport test exists.'"
---

# Phase 21: Per-Contact DSR Export Verification Report

**Phase Goal:** An Owner or Admin can hand a data subject their own personal data in one action — a machine-readable file scoped strictly to that contact in that workspace, containing no other subject's data.
**Verified:** 2026-08-22T13:41:17Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Owner/Admin can download, from the contact card, a JSON file with the contact's profile, custom properties and consent history (SC1, DSR-01) | ✓ VERIFIED | `GET .../contacts/:id/dsr-export` route (`dsr-export.routes.ts`) returns `metadata`/`profile`/`customProperties`/`consentHistory`; `dsr-export.test.ts` happy-path cases pass (32/32 tests in the file re-run live). |
| 2 | The file also contains events and send-related personal data (send facts, delivery statuses) for that subject (SC2, DSR-02) | ✓ VERIFIED | `events` and `sends` (+ nested `sendEvents`) sections in `dsr-export.repository.ts`/`dsr-export.ts`; corresponding test cases pass. |
| 3 | A Member does not see the Export action in the UI and is refused by the API (SC3, DSR-04) | ✓ VERIFIED | `ExportContactButton` is `canExport ? (...) : null` (conditional render, not disabled) in `ContactDetailPage.tsx`; API 403 test (`role guard: member is refused...`) passes; web markup test (`contact-dsr-export.test.tsx`, 11/11 live) covers Owner/Admin/Member cases. |
| 4a | Cross-tenant / nonexistent contact id returns a byte-identical 404 (SC4, DSR-04) | ✓ VERIFIED | Route imports `NOT_FOUND_BODY` from `resolveWorkspaceMember` rather than a re-typed literal; `dsr-export.test.ts` asserts cross-tenant and never-existed cases are byte-identical; `negative-cross-tenant.test.ts` covers `registerDsrExportRoutes` as a read-only `ATTEMPT_CASE` (25/25 live). |
| 4b | Freeform JSONB (`events.properties`, `send_events.payload`) reaches the file only through an explicit allowlist; a synthetic other-subject field is provably absent (SC4, DSR-03) | ✓ VERIFIED | `events.properties` never named in `selectEventsPage`'s SELECT (D-01); `selectSendEventsPage` applies `buildExportSendEventPayload` (shared, superset-tested allowlist from `@mega-crm/delivery-core`) inside the reader before any row leaves it; SC4 synthetic-field test passes live. |
| 5 | Exporting an already-erased contact returns a typed response, never a silently empty file (SC5, DSR-01) | ✓ VERIFIED | `getDsrExportDocument` reads `anonymized_at` as the FIRST statement inside the transaction and throws `ContactErasedError` before assembling anything; route maps it to 410 `{code:"contact_erased", erasedAt, erasureRecordId}`; erased-410 test passes live. |
| 6 | Every export read runs inside one `BEGIN ISOLATION LEVEL REPEATABLE READ` transaction, gate-first (D-15) | ✓ VERIFIED | `withTenantTransactionRepeatableRead` (`packages/tenant-context/src/index.ts`) issues the combined `BEGIN ISOLATION LEVEL REPEATABLE READ` statement; `getDsrExportDocument` reads `anonymized_at` before any section walk, all walks share the same `client`. Behavior-dependent (mid-scrub race) proven by a real interleaved-scrub test with a failing READ COMMITTED control — `dsr-export-isolation.test.ts`, 3/3 cases, re-run live and passing. |
| 7 | Filename carries no contact PII; the download is `dsr-export-{contactId}-{YYYY-MM-DD}.json` | ✓ VERIFIED | Both the API (`dsr-export.routes.ts`'s `isoDateStamp`) and the UI (`ExportContactButton`'s blob-download filename) build the name from `contactId` + UTC date only. |
| 8 | A successful export emits one structured Pino log line with requester id, workspace id, contact id and section row counts — no exported personal data (D-11) | ✓ VERIFIED | `buildDsrExportAuditLog` returns exactly `{requesterUserId, workspaceId, contactId, sectionRowCounts}`; logged via `request.log.info(..., "dsr_export_completed")`. |
| 9 | An erased contact's Export button renders visible-but-disabled with an inline reason; a mid-session 410 flips a stale-enabled button to that state (D-14, SC5) | ✓ VERIFIED | `computeExportDisabledReason` + `anonymizedAt` on `contactResponseSchema`; `onError` invalidates the contact query on 410; `contact-crud.test.ts` (20/20 live) and `contact-dsr-export.test.tsx` (11/11 live) cover both. |
| 10 | The document has all eight D-05 sections (`profile`, `customProperties`, `consentHistory`, `events`, `sends`+`sendEvents`, `flowParticipation`+`steps`, `campaignMemberships`) with per-section row counts equal to real array lengths (D-06) | ✓ VERIFIED | `getDsrExportDocument`'s `metadata.sectionRowCounts` object lists all nine keys (eight sections + the nested `flowRunSteps`/`sendEvents` counts); dedicated completeness test passes. |
| 11 | Migration 0067 adds the three contact-scoped indexes the journey-section reads need | ✓ VERIFIED | `0067_dsr_export_contact_indexes.sql` creates `idx_flow_runs_workspace_contact`, `idx_campaign_recipients_workspace_contact`, `idx_flow_run_steps_flow_run_id`; `npm run test:migrations` — 245 passed/1 skipped (1 unrelated flake, see Anti-Patterns/Known Issues below, confirmed non-reproducing on isolated re-run). |
| 12 | `SPECIFICATION.md` documents the route, its permission gate, its typed responses, the new indexes, and the relocated allowlist package as-built | ✓ VERIFIED | §2.9, §4.5, §4.6, §6.5/§6.5.3 all reference `dsr-export`, `contact:["export"]`, the three new indexes and `@mega-crm/delivery-core`'s relocated allowlist exports (grepped directly). |
| 13 | `COVERAGE.md` records that this phase integrates no external API, with a reason | ✓ VERIFIED | `.planning/phases/21-per-contact-dsr-export/COVERAGE.md` states this explicitly. |
| 14 | The allowlist constants/build functions have exactly one definition, shared by API export and worker erasure paths (DSR-03) | ✓ VERIFIED | `packages/delivery-core/src/send-event-payload-allowlist.ts` is the sole definition; `erasure-scrub.worker.ts` imports + re-exports; `erasure-scrub.test.ts` (23/23 live) and `send-event-payload-allowlist.test.ts` (9/9 live) both pass unchanged/passing. |
| 15 | `SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST` is a structural, test-asserted superset of the evidence allowlist (D-02) | ✓ VERIFIED | Declared via TS spread + `ip`/`useragent`/`url`/`reason`; superset assertion test passes live. |
| 16 | `docs/PII-INVENTORY.md` enumerates per-table personal data and gives every excluded table a reason (D-03/D-04) | ✓ VERIFIED | File lists 9 included tables/groups and 4 excluded groups, each excluded row with a reason; `flow_runs`/`flow_run_steps`/`campaign_recipients` are recorded as included per GDPR Art. 15. Minor documentation drift noted below (not blocking). |

**Score:** 16/16 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/modules/contacts/dsr-export.routes.ts` | GET route, Owner/Admin gate, typed refusals, attachment response | ✓ VERIFIED | Present, substantive, wired into `server.ts`; `registerDsrExportRoutes`/`buildDsrExportAuditLog` both exported and used. |
| `apps/api/src/modules/contacts/dsr-export.repository.ts` | REPEATABLE READ transaction, anonymizedAt gate, eight-section assembly, all page readers | ✓ VERIFIED | `getDsrExportDocument`, `ContactErasedError`, `DSR_EXPORT_PAGE_LIMIT`, `DSR_EXPORT_FORMAT_VERSION`, and all `select*Page` readers present and called from `getDsrExportDocument`. |
| `packages/shared-schemas/src/dsr-export.ts` | zod schema + inferred types for the eight-section document | ✓ VERIFIED | `dsrExportDocumentSchema` and per-section schemas present, re-exported from `packages/shared-schemas/src/index.ts`. |
| `packages/tenant-context/src/index.ts` | `withTenantTransactionRepeatableRead` sibling helper | ✓ VERIFIED | Present; issues `BEGIN ISOLATION LEVEL REPEATABLE READ` combined statement; existing `withTenantTransaction` untouched (still READ COMMITTED). |
| `apps/api/src/modules/auth/access-control.ts` | `contact: ["export"]` resource, owner/admin only | ✓ VERIFIED | Present in the statement plus member/admin/owner role declarations (member excluded). |
| `packages/delivery-core/src/send-event-payload-allowlist.ts` | Single shared allowlist + build-up functions | ✓ VERIFIED | All exports present and re-exported from `packages/delivery-core/src/index.ts`, consumed by `dsr-export.repository.ts` and `erasure-scrub.worker.ts`. |
| `docs/PII-INVENTORY.md` | Per-table PII inventory for export + purge | ✓ VERIFIED | Present, substantive; one WR-03-class documentation drift (flow_run_steps.flow_run_id listed as an exported column though nested rows drop it) — flagged, non-blocking. |
| `packages/db/migrations/0067_dsr_export_contact_indexes.sql` | Three contact-scoped indexes | ✓ VERIFIED | Present; matches journal entry; migration test suite green (see flake note). |
| `apps/web/src/features/contacts/ContactDetailPage.tsx` | Export button, role gate, disabled-erased state, error handling | ✓ VERIFIED | `ExportContactButton`, `computeExportDisabledReason`, `computeExportErrorMessage` all present and wired into the page. |
| `apps/api/src/modules/contacts/__tests__/dsr-export.test.ts` + `dsr-export-isolation.test.ts` | End-to-end + isolation coverage | ✓ VERIFIED | Both files exist; 32/32 tests pass on live re-run. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `dsr-export.routes.ts` | `access-control.ts` | `requirePermission("contact","export")` preHandler | ✓ WIRED | Confirmed by direct read of the route registration. |
| `dsr-export.repository.ts` | `tenant-context/src/index.ts` | `withTenantTransactionRepeatableRead` wraps every read | ✓ WIRED | `getDsrExportDocument`'s single call site wraps the whole assembly; all section walks share the callback's `client`. |
| `server.ts` | `dsr-export.routes.ts` | route registration | ✓ WIRED | `registerDsrExportRoutes` registered alongside `registerContactsRoutes`. |
| `dsr-export.repository.ts` | `packages/delivery-core` allowlist | `buildExportSendEventPayload` applied inside `selectSendEventsPage` | ✓ WIRED | Applied per-row before any payload leaves the reader function — the strongest form of the isolation guarantee. |
| `ContactDetailPage.tsx` | `packages/shared-schemas/src/contact.ts` | reads `contact.anonymizedAt` to compute disabled reason | ✓ WIRED | `computeExportDisabledReason(contact)` reads the field directly. |
| `contacts.routes.ts` | `contact.repository.ts` | `toContactResponse` emits `anonymizedAt` from `getContact`'s widened select | ✓ WIRED | Confirmed via SUMMARY + passing `contact-crud.test.ts` cases. |
| `dsr-export.repository.ts` | migration 0067 indexes | journey-table filters ride the new indexes | ✓ WIRED | Query shapes (`WHERE workspace_id = $1 AND contact_id = $2`) match the new indexes' leading columns exactly. |
| `SPECIFICATION.md` | `dsr-export.routes.ts` | §6.5/§6.5.3 route table entry | ✓ WIRED | Confirmed by direct grep of both files. |

### Behavioral Spot-Checks / Test Runs (Step 7b/7c)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| DSR export happy path + refusal triad + all sections | `npm run test -w apps/api -- dsr-export.test.ts dsr-export-isolation.test.ts` | 2 files / 32 tests passed | ✓ PASS |
| Contact response carries `anonymizedAt`, disabled-erased UI state | `npm run test -w apps/api -- contact-crud.test.ts` | 1 file / 20 tests passed | ✓ PASS |
| Allowlist relocation + export superset | `npm run test -w packages/delivery-core -- send-event-payload-allowlist.test.ts` | 1 file / 9 tests passed | ✓ PASS |
| Export button UI states (Owner/Admin/Member/Pending/Error/Erased) | `npm run test -w apps/web -- contact-dsr-export.test.tsx` | 1 file / 11 tests passed | ✓ PASS |
| Erasure-scrub worker regression (relocation, zero behavior change) | `npm run test -w apps/worker -- erasure-scrub.test.ts` | 1 file / 23 tests passed | ✓ PASS |
| Cross-tenant negative coverage (new route registered as ATTEMPT_CASE) | `npm run test -w apps/api -- negative-cross-tenant.test.ts` | 1 file / 25 tests passed | ✓ PASS |
| Migration suite (0067 classification, rollback rehearsal, empty-diff) | `npm run test:migrations` | 30 files / 245 passed / 1 skipped / 1 failed (advisory-lock concurrency test) | ⚠️ 1 known flake — re-run in isolation passed 2/2; matches this repo's documented "dev-stack test gate flakes" memory (advisory-lock timing under load), unrelated to any file this phase touches |

No probes (`scripts/*/tests/probe-*.sh`) are declared or implied by this phase's plans/success criteria — Step 7c skipped as not applicable.

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|--------------|--------|----------|
| DSR-01 | 21-01, 21-03, 21-04 | Owner/Admin downloads profile + custom properties + consent history from the contact card | ✓ SATISFIED | Export route + UI button + tests, all live and passing. **REQUIREMENTS.md tracking table/checkbox still shows "Pending" / unchecked — see Anti-Patterns note below; this is a documentation-sync gap, not a functional one.** |
| DSR-02 | 21-01, 21-03, 21-05, 21-06 | Export includes events + send-related personal data, scoped to the subject | ✓ SATISFIED | `events`/`sends`/`sendEvents`/`flowParticipation`/`campaignMemberships` sections; REQUIREMENTS.md already marks this Complete. |
| DSR-03 | 21-02, 21-05, 21-06 | Export scoped to workspace_id+contact_id; freeform JSONB governed by an explicit allowlist decision | ✓ SATISFIED | Shared allowlist package, superset test, PII inventory, SC4 synthetic-field proof; REQUIREMENTS.md already marks this Complete. |
| DSR-04 | 21-01 | Member cannot run the export (API + UI role gate) | ✓ SATISFIED | 403 test + conditional-render UI test both pass. **REQUIREMENTS.md tracking table/checkbox still shows "Pending" / unchecked — see Anti-Patterns note below.** |

No orphaned requirements found: REQUIREMENTS.md's Phase 21 section names exactly DSR-01 through DSR-04, and all four are claimed across the six plans' frontmatter.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `.planning/REQUIREMENTS.md` | 18, 21, 81, 84 | DSR-01 and DSR-04 checkboxes/tracking rows still read `- [ ]` / "Pending" despite both being implemented and tested in plans 21-01/21-03/21-04 (whose SUMMARY frontmatter explicitly lists `requirements-completed: [DSR-01, DSR-04]`) | ℹ️ Info | Documentation-sync gap only — the code, tests and SPECIFICATION.md all confirm the requirements are met. Recommend updating REQUIREMENTS.md's checkboxes and Phase-21 tracking rows for DSR-01/DSR-04 to Complete before shipping, so the traceability table stays trustworthy for future phases/audits. |
| `docs/PII-INVENTORY.md` | 28 | Lists `flow_run_id` as an exported column of `flow_run_steps`, but the actual wire shape (`dsrExportFlowRunStepSchema`) omits it — the repository code deliberately strips `flowRunId` before nesting (the parent run's id already carries it) | ℹ️ Info | Already flagged by phase's own code-review report (WR-03), not fixed in this phase. Does not affect any exported data's correctness or completeness, only this doc's precision as Phase 22's future citation source. |
| N/A | — | No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in any file this phase modified (grepped across all `key-files` from all six SUMMARY.md files) | — | — |

No blocker-tier anti-patterns found. The phase's own code-review report (`21-REVIEW.md`, `status: issues_found`, 0 critical / 4 warning / 3 info) covers the same ground in more depth (timestamp-format inconsistency, one join missing a redundant explicit `workspace_id` filter beyond RLS, the PII-INVENTORY drift above, and an unenforced `allowlistVersion` literal) — all four warnings are quality/consistency issues, none is a cross-tenant leak, PII-allowlist bypass, or fail-open ordering defect.

### Human Verification Required

Three items, all previously deferred by the executing plans to this phase's end-of-phase human verification pass (`human_verify_mode: end-of-phase`), plus the UI-SPEC's own two backstop items:

1. **Real blob download** (21-01-PLAN.md Task 3)
   **Test:** Click Export on a live contact's card as an Owner/Admin.
   **Expected:** A `dsr-export-{contactId}-{YYYY-MM-DD}.json` file downloads via the browser and opens as valid, readable JSON with no PII in the filename.
   **Why human:** Blob + synthetic anchor click is a real browser side effect that this repo's `renderToStaticMarkup`-only test lane cannot exercise.

2. **Mid-session erasure race** (21-04-PLAN.md Task 2)
   **Test:** With a contact's card open in tab A, erase the same contact in tab B, then click Export in tab A.
   **Expected:** Tab A's Export click surfaces the 410 erased-contact message inline, and the card transitions to its not-found/disabled state on the next render rather than staying clickable.
   **Why human:** Requires two real browser tabs against a running dev stack with an actual timing race; not reachable from the mocked-hook unit test lane.

3. **Narrow-viewport wrap check** (UI-SPEC.md E1/E2 backstop items)
   **Test:** Resize the contact-card header (Export + Delete row) and the inline reason/error paragraph to a narrow viewport width.
   **Expected:** The header actions row wraps rather than clips; the inline reason/error text wraps to multiple lines rather than being cut off.
   **Why human:** Rendered-layout/CSS behavior; the header row's container classes (`flex items-center justify-between gap-4` / `flex items-center gap-2`) carry no visible `flex-wrap` utility in source, so wrap-vs-clip cannot be confirmed by static reading alone — UI-SPEC.md itself designates both as `verification: backstop` with "no explicit narrow-viewport test exists."

### Gaps Summary

No blocking gaps. All 16 consolidated must-have truths (roadmap SC1-5 plus plan-level must_haves across all six plans) are verified against the actual codebase — routes, repository, schemas, access control, migration, allowlist relocation, PII inventory, UI wiring, and SPECIFICATION.md/COVERAGE.md as-built records all exist, are substantive, and are correctly wired. All claimed test suites were re-run live in this verification session (not trusted from SUMMARY.md alone) and passed: 32 (dsr-export + isolation) + 20 (contact-crud) + 9 (allowlist) + 11 (web UI) + 23 (erasure-scrub regression) + 25 (negative-cross-tenant) = 120 tests, all green, plus the migration suite (245/246 passed, 1 unrelated documented flake confirmed non-reproducing on isolated re-run).

The phase's own code-review report found zero critical/blocker findings. The three items above are genuinely unreachable by this repo's automated test lane (real browser download, real two-tab race, real rendered viewport) and were explicitly deferred by the executing plans to end-of-phase human verification — hence `human_needed` rather than `passed`. One documentation-sync nit (REQUIREMENTS.md's stale Pending checkboxes for DSR-01/DSR-04) is noted as an Info-level anti-pattern, not a gap, since the underlying requirement is demonstrably met in code and tests.

---

*Verified: 2026-08-22T13:41:17Z*
*Verifier: Claude (gsd-verifier)*
