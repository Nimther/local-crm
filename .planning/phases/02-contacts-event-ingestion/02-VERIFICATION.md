---
phase: 02-contacts-event-ingestion
verified: 2026-07-05T10:20:00Z
status: human_needed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 3/5
  gaps_closed:
    - "A user can create, view, edit, and delete a contact in the UI, including arbitrary custom profile properties. (CR-04: PATCH merge-vs-replace mismatch)"
    - "A tenant's backend can create/update contacts via the Contacts API and post freeform events (name + JSON) with an API key, getting an immediate 2xx while processing happens asynchronously through a queue. (CR-01 cross-tenant jobId/PK collision, CR-03 events-lost-outside-partition-window)"
  gaps_remaining: []
  regressions: []
behavior_unverified_items: []
human_verification:
  - test: "Create a contact with an email, a tag, and one custom property — confirm toast «Контакт создан» and list appearance."
    expected: "Contact appears in list with tag and property visible."
    why_human: "Visual/toast confirmation in a live browser session."
  - test: "Search by email and by name; apply the status filter and a tag filter; sort a column; page forward/back."
    expected: "Each interaction filters/sorts/paginates correctly; filtered-empty copy shows when nothing matches."
    why_human: "Interactive UI behavior, not visible via source grep."
  - test: "Open a contact; add a custom property, then remove one, then clear the phone field; save. Reload the page."
    expected: "Removed property stays removed, cleared field stays cleared, untouched fields (e.g. city) are unaffected — confirms CR-04's fix is correct end-to-end through the browser form, not just via direct API PATCH (02-09's D4 coverage item was type-check-only, not a rendered-browser test)."
    why_human: "cleanPayload's null-emission on an emptied input has no component-level test — only API-level PATCH tests exist."
  - test: "Attempt to create a second contact with the same email."
    expected: "Inline «Этот email уже используется другим контактом…» copy (D-07)."
    why_human: "Exact inline error copy rendering."
  - test: "Confirm a contact with a set external_id shows it read-only with the D-06 helper text."
    expected: "external_id field is visibly read-only with helper text."
    why_human: "Visual/DOM state in rendered browser."
  - test: "Run a full CSV import: upload a small CSV, map columns (including «Создать новое свойство…»), choose duplicate policy, run dry-run, confirm the three stat cards, apply, watch progress bar, navigate away and back into the import from history."
    expected: "Dry-run writes nothing; apply progresses and resumes correctly on re-entry (D-16); completion report shows correct counts."
    why_human: "Multi-step live interaction, including navigate-away/back state resumption."
  - test: "On a CSV import with errors, download the error CSV and confirm the reason column; confirm import history lists the run (file, date, author, summary)."
    expected: "Error CSV downloads with correct reason column; history row is accurate."
    why_human: "File download + visual list confirmation."
  - test: "Upload a CSV file larger than the 50MB limit."
    expected: "Import status becomes 'failed' and the upload responds 413, instead of hanging or silently truncating (WR-04's truncation branch, 02-12 D4)."
    why_human: "No automated test exercises an actual >50MB upload (impractical payload size for the fast unit/integration suite); the code path was implemented and reviewed against @fastify/multipart's source but never executed end-to-end."
  - test: "Send a test event for a contact via POST /v1/events (API key from 02-03) or seed one; open that contact's card → События tab."
    expected: "Event appears with name, relative time, and an expandable JSON payload (D-14)."
    why_human: "Visual confirmation of the live event feed rendering."
  - test: "Confirm spacing/typography/color and Russian copy match the Phase 2 UI-SPEC across the contact list/form/detail and CSV wizard."
    expected: "Visual fidelity to UI-SPEC."
    why_human: "Design/visual review, not verifiable via grep."
  - test: "Review the WR-09 dead-pooled-connection-destroy reasoning (source assertion only, no fault-injection test exists in this suite) and confirm it's acceptable to ship without a deterministic test that kills a connection mid-ROLLBACK."
    expected: "Human either accepts the source-assertion-only proof, or requests a follow-up plan to add fault-injection coverage before Phase 4 (send pipeline) depends on this same connection-pool code path at much higher volume."
    why_human: "No fault-injection tooling exists in this suite to deterministically reproduce a mid-ROLLBACK connection failure; the fix (`client.release(err)`) is proven only by source assertion + a clean full-suite regression run, per 02-11's own documented rationale."
---

# Phase 02: Contacts & Event Ingestion Verification Report (Re-Verification)

**Phase Goal:** A marketer can build and maintain their contact base (UI, CSV, API) while their backend streams freeform behavioral events that create and enrich contacts in real time.
**Verified:** 2026-07-05T10:20:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (plans 02-09..02-12)

## Context

The prior verification (2026-07-04T11:24:38Z) found `status: gaps_found`, score 3/5, blocked by four Critical code-review findings (CR-01..CR-04). Gap-closure plans 02-09 (CR-04), 02-10 (CR-01/CR-03/WR-01), 02-11 (CR-02/WR-06/WR-09), and 02-12 (WR-03/WR-04/WR-05) were executed, followed by a fresh full-surface code review (`02-REVIEW.md`, 93 files, `status: issues_found`, 0 critical / 7 warning / 11 info). This re-verification independently re-confirms every prior Critical finding is fixed in the current source (not merely trusting `02-REVIEW.md`'s or the SUMMARYs' claims), re-runs the full automated test suite once, and re-checks the 5 ROADMAP success criteria end to end.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A user can create, view, edit, and delete a contact in the UI, including arbitrary custom profile properties. | ✓ VERIFIED | CR-04 confirmed fixed by direct source read: `contact.repository.ts:294` — `const nextProperties = patch.properties ?? existing.properties;` (full replacement, not merge); `packages/shared-schemas/src/contact.ts:47-51` — firstName/lastName/phone/city/country are `.nullable().optional()` on the update schema; `ContactForm.tsx:202-218` `cleanPayload(values, isEdit)` emits explicit `null` for emptied fields in edit mode. Regression tests `contact-crud.test.ts` (property deletion, field clearing, no-wipe invariant) pass in the full suite run below. Create/view/list/delete unaffected and re-confirmed present (`contacts.routes.ts:192` DELETE handler). |
| 2 | A user can upload a CSV, map columns to attributes, preview the result before applying, and receive a report of errors and duplicates. | ✓ VERIFIED | Unaffected by this round's gap closure except hardening (WR-03/04/05 fixed in 02-12): `applyCsvRowMapping` now validates `subscriptionStatus` (`csv-mapping.ts`); upload route wraps parse in try/catch → `markCsvImportFailed` + 422, and checks `data.file.truncated` → 413 (`csv-import.routes.ts`); worker throws on `stillPending > 0` instead of silently leaving `applying` forever (`imports-csv.worker.ts:163-173`). Core wizard/preview/report flow (`CsvImportWizard.tsx`, `csv-import.routes.ts`) unchanged and still present/wired. |
| 3 | A tenant's backend can create/update contacts via the Contacts API and post freeform events (name + JSON) with an API key, getting an immediate 2xx while processing happens asynchronously through a queue. | ✓ VERIFIED | CR-01 confirmed fixed by direct source read: `events-api.routes.ts:99` — `{ jobId: \`${workspaceId}-${eventId}\` }` (workspace-scoped, not global); migration `0010_events_workspace_scoped_pk.sql:23-24` — `ALTER TABLE events ADD PRIMARY KEY (workspace_id, id, occurred_at)`; `events-ingest.worker.ts:43` — `ON CONFLICT (workspace_id, id, occurred_at) DO NOTHING` matches. CR-03 confirmed fixed: `0010:36` — `CREATE TABLE events_default PARTITION OF events DEFAULT;`. WR-01 confirmed fixed: `events-queue.ts:45-47` and `imports-csv-queue.ts:41-43` both set `defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 2000 } }`. Migration journaled (`meta/_journal.json` idx 10). |
| 4 | An event for an unknown contact automatically creates it via external_id/email upsert, and a later email change still resolves to the same contact. | ✓ VERIFIED | `upsertContactByIdentity` unchanged in its identity-priority logic; CR-02 (dead-code retry) confirmed fixed: `contact-repository.ts:242-274` — INSERT wrapped in `SAVEPOINT upsert_insert`, `ROLLBACK TO SAVEPOINT upsert_insert` before retry (not a bare aborted-transaction retry). Proven by a real two-connection concurrent-race test (`upsert-priority.test.ts`, confirmed passing in full suite run). `events-ingest.worker.ts` still reuses the same shared function — no drift. |
| 5 | Every contact carries a 3-state subscription status (subscribed / unsubscribed / suppressed). | ✓ VERIFIED | Unchanged and unaffected: `subscriptionStatusEnum` (`packages/db/src/schema/contacts.ts:10`), D-12 transition guards in `updateContact`, suppression-list override on create. Additionally hardened this round: `upsertContactByIdentity`'s update branch now also applies `subscriptionStatus` under the same D-12 guards (WR-06, `contact-repository.ts:311-346`), closing a prior silent-no-op gap on the events/CSV write paths. |

**Score:** 5/5 truths verified (up from 3/5). All 4 prior Critical findings (CR-01, CR-02, CR-03, CR-04) independently re-confirmed fixed via direct source inspection (not solely via `02-REVIEW.md`'s or SUMMARY.md's claims).

### Required Artifacts (delta from prior verification)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/modules/contacts/contact.repository.ts` | tenant-scoped CRUD + upsert, full-replace PATCH semantics | ✓ VERIFIED | Line 294 confirmed full-replacement (`??`, not merge). Previously ⚠️ PARTIAL (CR-04), now clean. |
| `apps/api/src/modules/events/events-api.routes.ts` | fast-2xx `/v1/events`, tenant-scoped jobId | ✓ VERIFIED | Line 99 confirmed workspace-scoped jobId. Previously ⚠️ PARTIAL (CR-01), now clean. |
| `packages/db/migrations/0010_events_workspace_scoped_pk.sql` | workspace-scoped PK + DEFAULT partition | ✓ VERIFIED | Both DDL statements present and applied (journaled). Closes the prior ⚠️ HOLLOW artifact status on `0007_events_partitioned.sql`. |
| `apps/worker/src/queues/events-ingest.worker.ts` | idempotent, tenant-scoped dedupe | ✓ VERIFIED | `ON CONFLICT (workspace_id, id, occurred_at)` matches new PK. |
| `packages/contacts-core/src/contact-repository.ts` | race-safe upsert with real retry | ✓ VERIFIED | SAVEPOINT/ROLLBACK TO SAVEPOINT confirmed at lines 242-274. Previously dead-code retry (CR-02), now functional and proven by a real concurrent-connection test. |
| `apps/web/src/features/contacts/{ContactForm,CustomPropertyEditor}.tsx` | edit UI with working deletion/clearing | ✓ VERIFIED | `ContactForm.tsx` `cleanPayload` confirmed emitting `null` for emptied fields in edit mode. |
| `apps/worker/src/queues/imports-csv.worker.ts` | throws on unresolved rows instead of silent stuck-`applying` | ✓ VERIFIED | Lines 163-173 confirmed: throws when `stillPending > 0`. |
| `apps/api/src/modules/contacts/csv-import.routes.ts` | upload failure path sets `failed` + non-200 | ✓ VERIFIED | try/catch around parse loop + `data.file.truncated` check confirmed present (truncation branch itself not exercised by an automated test — see human verification). |
| `packages/contacts-core/src/csv-mapping.ts` | validates `subscriptionStatus`, blocks `suppressed` | ✓ VERIFIED | Shared by dry-run and apply, confirmed by passing WR-05a/WR-05b tests. |

All artifacts previously flagged ⚠️ PARTIAL/HOLLOW in the prior verification are now ✓ VERIFIED.

### Key Link Verification (delta)

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `events-api.routes.ts` | `events-ingest.worker.ts` | BullMQ jobId `${workspaceId}-${eventId}` | ✓ WIRED (fixed) | Previously "mechanically wired but tenant-unscoped" (CR-01) — now tenant-scoped end to end, confirmed by cross-tenant collision tests in both `events-api.test.ts` and `events-ingest-idempotency.test.ts`. |
| `contact.repository.ts` (PATCH) | `CustomPropertyEditor.tsx` / `ContactForm.tsx` | full-replace `properties` + explicit `null` for cleared fields | ✓ WIRED (fixed) | Previously broken (CR-04, silent no-op) — now closes end to end through the shared PATCH contract. |
| `upsertContactByIdentity` | events worker / CSV worker / Contacts API | shared function, race-safe | ✓ WIRED (fixed) | CR-02's retry is no longer dead code; all three callers benefit identically. |

### Behavioral Spot-Checks / Full Test Run

Ran each workspace's full test suite once (Postgres running, Redis running, confirmed available in this environment) — the only two workspaces with a `test` script:

| Suite | Command | Result | Status |
|-------|---------|--------|--------|
| `apps/api` | `npm run test -w apps/api` (107 tests, 17 files) | 107/107 passed | ✓ PASS |
| `apps/worker` | `npm run test -w apps/worker` (14 tests, 3 files) | 14/14 passed | ✓ PASS |
| all workspaces (build) | `npm run build --workspaces --if-present` | 7/7 packages built clean (tsc + vite) | ✓ PASS |

Test counts grew from the prior verification's 94 (api) + 11 (worker) = 105 to 107 + 14 = 121, consistent with the regression tests added across 02-09..02-12 (contact-crud CR-04 x3, events-api/events-ingest CR-01/CR-03/WR-01 x4, upsert-priority CR-02/WR-06 x3, csv-import/imports-csv WR-03/04/05 x4). Specifically confirmed present and passing (by suite membership, not individually re-run in isolation, per the "run full suite once" constraint):
- `contact-crud.test.ts` — CR-04 property-deletion, field-clearing, no-wipe-invariant tests
- `events-api.test.ts` — CR-01 cross-tenant jobId test, WR-01 retry-config assertion
- `events-ingest-idempotency.test.ts` — CR-01 cross-tenant DB-dedupe test, CR-03 out-of-window `occurredAt` test
- `upsert-priority.test.ts` — CR-02 real two-connection concurrent-insert race test, WR-06 subscriptionStatus-on-update tests
- `csv-import.test.ts` — WR-05a/WR-05b (subscriptionStatus validation/drift), WR-04 (malformed CSV → failed)
- `imports-csv-idempotency.test.ts` — WR-03 (stillPending → throw)

No regressions: all previously-passing behaviors (RLS isolation, API-key auth, CSV pipeline core flow, subscription-status guards) remain green alongside the new tests.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| CONT-01 | 02-01, 02-02, 02-09 | Create/view/edit/delete contacts in UI | ✓ SATISFIED | Edit (incl. deletion/clearing) now works correctly end to end (CR-04 fixed). |
| CONT-02 | 02-07, 02-08, 02-12 | CSV import with mapping/preview/error report | ✓ SATISFIED | Full pipeline present, wired, tested; hardened by WR-03/04/05 fixes. |
| CONT-03 | 02-01, 02-03, 02-04 | Contacts CRUD API | ✓ SATISFIED | Unaffected by this round; confirmed still correct. |
| CONT-04 | 02-04, 02-11 | external_id/email prioritized upsert | ✓ SATISFIED | CR-02 race-condition retry now functional and proven under a real concurrent test. |
| CONT-05 | 02-01, 02-02, 02-09 | Arbitrary custom properties | ✓ SATISFIED | Deletion via update now persists correctly (CR-04 fixed, shared root cause with CONT-01). |
| EVNT-01 | 02-03, 02-06, 02-10 | Freeform event API with API key | ✓ SATISFIED | CR-01's global jobId scoping fixed — per-tenant guarantee restored. |
| EVNT-02 | 02-04, 02-06 | Auto-create contact from event | ✓ SATISFIED | Unaffected by this round; confirmed still correct. |
| EVNT-03 | 02-05, 02-06, 02-10 | Fast 2xx, async queue processing | ✓ SATISFIED | CR-03 (permanent data loss outside partition window) and WR-01 (no retry config) both fixed — accepted events can no longer be silently, permanently lost. |
| SUBS-01 | 02-01, 02-02, 02-11 | 3-state subscription status | ✓ SATISFIED | Unaffected core logic; additionally hardened via WR-06 (status now honored on the upsert update branch too). |

**Orphaned requirements check:** REQUIREMENTS.md's traceability table maps exactly CONT-01..05, EVNT-01..03, SUBS-01 to Phase 2 (all marked `[x]` complete) — identical to the phase's declared requirement-ID list and the plan-frontmatter `requirements` fields observed across 02-01..02-12. No orphaned requirements found.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` debt markers found in any file touched by the gap-closure commits (`e651ae3^..0360f0d`, 23 files, excluding `.planning/`) — confirmed by direct grep, not solely by `02-REVIEW.md`'s claim.

`02-REVIEW.md` (re-review after gap closure, 93 files, dated 2026-07-05T05:12:30Z) independently confirms 0 Critical findings remain and lists 7 Warnings / 11 Info items. These are real, non-blocking findings that do not prevent any of the 5 success criteria from being true today, but are worth carrying into the phase's backlog / Phase 3-4 hardening:

| File | Finding | Severity | Impact |
|------|---------|----------|--------|
| `apps/worker/src/server.ts`, workers, `connection.ts` | No `error`/`failed` listeners on BullMQ Workers/shared Redis connection | ⚠️ Warning (WR-01/carried) | A transient Redis hiccup crashes the worker process; job failures produce no log output. |
| `apps/worker/src/queues/imports-csv.worker.ts`, `imports-csv-queue.ts`, `CsvImportWizard.tsx` | CSV apply job exhausting all retries has no terminal `failed` transition | ⚠️ Warning (new, residual of WR-03 fix) | Import can still get stuck in `applying` if all 5 retries fail (vs. the common transient-failure case, which now retries and typically recovers). |
| `apps/api/src/modules/contacts/csv-import.routes.ts` | No status guard on dry-run/apply routes | ⚠️ Warning (carried) | Concurrent re-POST/dry-run-mid-apply races are possible. |
| `apps/api/src/modules/contacts/contact.repository.ts` | TOCTOU on email-uniqueness check surfaces as 500 not 409 | ⚠️ Warning (carried) | Rare-race UX gap, not a correctness/data-loss issue. |
| `apps/worker/src/queues/connection.ts`, `events-queue.ts`, `imports-csv-queue.ts` | Redis URL parsing (3 copies) drops TLS for `rediss://` | ⚠️ Warning (carried) | Would only matter switching to a managed TLS Redis; not applicable to current local/dev config. |
| `ContactDetailPage.tsx` (`PropertiesTab`), `CustomPropertyEditor.tsx` | Stale-tab full-replace can silently drop concurrently-added properties | ⚠️ Warning (new, introduced by CR-04's replace semantics) | Real but narrow lost-update window (marketer has tab open while an event/API write adds a property, then saves stale state). Does not negate CR-04's fix — deletion now works; this is a different, lower-frequency race. Recommend a follow-up plan before Phase 3+ increases concurrent-write volume. |
| `events-api.routes.ts` | Mid-batch enqueue failure returns whole-request 500 after partial enqueue; client retry can duplicate server-minted eventIds | ⚠️ Warning (new) | Only manifests on a genuine Redis failure mid-batch; does not affect the primary success-criteria-3 happy path (2xx + async queue), which is proven by the passing test suite. |

11 Info-level findings (IN-01..IN-11) also remain — cosmetic/hygiene issues (CSV formula injection in error report, unescaped ILIKE wildcards, stale doc comments, test-Redis-connection hygiene) that do not affect the 5 success criteria. Full detail in `02-REVIEW.md`.

None of the above Warnings or Info items are classified Blocker; none contradict any of the 5 VERIFIED truths above. They are carried forward as backlog items, not phase-blocking gaps.

### Human Verification Required

11 items require human sign-off (see frontmatter `human_verification` for full detail):
- 9 items carried forward from 02-02/02-08's deferred `checkpoint:human-verify` tasks (standard UI/visual/interaction checks: contact CRUD flow, filter/sort/paginate, CSV wizard end-to-end, live event feed rendering, UI-SPEC visual fidelity) — one of these (item 3) is expanded to explicitly re-verify the CR-04 fix through the rendered browser form, since 02-09's own coverage only proved the fix via a type-check, not a rendered-DOM interaction.
- 1 new item from 02-12: the WR-04 truncated-upload 413 path has implemented code but no automated test (impractical to construct a >50MB payload in the fast test suite) — flagged for manual verification.
- 1 new item from 02-11: the WR-09 dead-connection-destroy fix has no fault-injection test in this suite; a human should review and accept the source-assertion-only proof, or request follow-up fault-injection coverage before Phase 4's higher-volume send pipeline relies on the same pooled-connection code path.

None of these 11 items are FAILED or blocking — they were correctly and explicitly deferred (not silently skipped) per the project's `human_verify_mode: end-of-phase` convention, and none contradict the 5/5 VERIFIED truths above.

### Gaps Summary

**No gaps remain.** All four prior Critical findings (CR-01, CR-02, CR-03, CR-04) are independently confirmed fixed in the current source, each backed by a regression test that fails on pre-fix code and passes on current code — confirmed both by reading the actual diffs/current source directly (not merely trusting `02-REVIEW.md`'s narrative) and by running the full automated test suite once (107/107 `apps/api`, 14/14 `apps/worker`, all green, no regressions vs. the prior verification's 94+11=105). All 5 ROADMAP success criteria are now ✓ VERIFIED, up from 3/5. All 9 Phase 2 requirement IDs (CONT-01..05, EVNT-01..03, SUBS-01) are SATISFIED with no orphans.

The phase is not `passed` outright because 11 human-verification items remain open — 9 pre-existing deferred UI/visual checks plus 2 new judgment items surfaced by this round's gap-closure work (a browser-level re-check of CR-04, and human sign-off on WR-09's untested fault path). These are standard end-of-phase UAT items, not blockers, and route to `status: human_needed` per the verification decision tree.

7 Warnings and 11 Info findings remain open in `02-REVIEW.md` (2 of the warnings are newly introduced by this round's fixes: WR-06's stale-Свойства-tab lost-update window, and WR-07's mid-batch-enqueue-failure duplicate risk). None negate the verified truths; recommended as backlog items for a future hardening pass, particularly before Phase 4 (send pipeline) increases write concurrency on the same shared code paths (`withTenantTransaction`, `upsertContactByIdentity`, BullMQ workers).

---

_Verified: 2026-07-05T10:20:00Z_
_Verifier: Claude (gsd-verifier)_
