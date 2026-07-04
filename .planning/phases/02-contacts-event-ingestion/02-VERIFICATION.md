---
phase: 02-contacts-event-ingestion
verified: 2026-07-04T11:24:38Z
status: gaps_found
score: 3/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "A user can create, view, edit, and delete a contact in the UI, including arbitrary custom profile properties."
    status: failed
    reason: "CR-04 (code review): PATCH merge semantics on the server contradict replace semantics assumed by the UI. `updateContact` computes `nextProperties = patch.properties ? { ...existing.properties, ...patch.properties } : existing.properties` — a merge, never a replace. `CustomPropertyEditor`'s remove button sends the full REMAINING properties object (replace intent), so the server re-merges the deleted key back in: deletion is a silent no-op. The same class of bug blocks clearing standard fields: `ContactForm`'s `cleanPayload` drops emptied fields from the payload entirely, and the repository keeps the existing value for any absent field — phone/city/first/last name can never be cleared. The UI shows a success toast (\"Контакт обновлён\") in both cases."
    artifacts:
      - path: "apps/api/src/modules/contacts/contact.repository.ts"
        issue: "Line 286: `nextProperties = patch.properties ? { ...existing.properties, ...patch.properties } : existing.properties` — merge, not replace; deleted keys are re-added."
      - path: "apps/web/src/features/contacts/CustomPropertyEditor.tsx"
        issue: "`removeRow` calls `emit()` which sends the full remaining properties object via `onChange`, expecting server-side replace semantics that don't exist."
      - path: "apps/web/src/features/contacts/ContactForm.tsx"
        issue: "`cleanPayload` (lines 192-202) omits any emptied field from the PATCH body entirely, so the repository's `patch.X !== undefined ? patch.X : existing.X` fallback always keeps the old value — a field can never be cleared through this form."
    missing:
      - "Treat `properties` in PATCH as full replacement (the UI already sends the complete object): `const nextProperties = patch.properties ?? existing.properties;`"
      - "Distinguish `undefined` (field not present, keep existing) from `null` (explicit clear) for standard fields in both the Zod schema (`.nullable()`) and the repository, and have the UI send `null` for emptied fields."
  - truth: "A tenant's backend can create/update contacts via the Contacts API and post freeform events (name + JSON) with an API key, getting an immediate 2xx while processing happens asynchronously through a queue."
    status: failed
    reason: "The immediate-2xx/async-queue mechanics work and are tested, but two confirmed code-review findings (CR-01, CR-03) mean the asynchronous processing this success criterion promises is not reliable and, worse, silently violates workspace isolation — the project's hard, day-one constraint. CR-01: the optional client-supplied `eventId` is used directly as the BullMQ `jobId` (`{ jobId: eventId }`, global per queue, not scoped by workspace_id) AND as the `events` table's dedupe key (`PRIMARY KEY (id, occurred_at)` + `ON CONFLICT (id, occurred_at) DO NOTHING`, also unscoped by workspace_id). Any tenant with a valid API key can supply a UUID that collides with another tenant's in-flight/retained job or event row; the API still returns `{status:\"accepted\"}` while the actual event is silently dropped — a direct violation of \"все данные изолированы по воркспейсу\" for the platform's highest-volume write path. CR-03: `occurredAt` is accepted as any ISO datetime (`z.string().datetime().optional()`), but only the `events_2026_07`/`events_2026_08` partitions exist, there is no DEFAULT partition, and neither queue configures `attempts`/`backoff` (confirmed: no `defaultJobOptions` anywhere in `events-queue.ts` or the worker) — any accepted event outside that 2-month window (a historical backfill today, or ANY event after 2026-09-01) fails the INSERT, the job goes straight to BullMQ's `failed` state with zero retries, and the client already received a 202. This is accepted-then-permanently-lost data inside a normal input range, not an edge case."
    artifacts:
      - path: "apps/api/src/modules/events/events-api.routes.ts"
        issue: "Line 91: `eventsIngestQueue.add(\"ingest-event\", {...}, { jobId: eventId })` — jobId is the raw client-supplied UUID, not workspace-scoped."
      - path: "packages/db/migrations/0007_events_partitioned.sql"
        issue: "`PRIMARY KEY (id, occurred_at)` has no `workspace_id` component; only `events_2026_07`/`events_2026_08` partitions exist and there is no DEFAULT partition."
      - path: "apps/worker/src/queues/events-ingest.worker.ts"
        issue: "Line 40: `ON CONFLICT (id, occurred_at) DO NOTHING` — same unscoped dedupe key as the DB PK."
      - path: "apps/api/src/modules/events/events-queue.ts"
        issue: "`new Queue(EVENTS_INGEST_QUEUE, { connection })` has no `defaultJobOptions` — confirmed via source read, no `attempts`/`backoff` anywhere; a partition-routing failure (or any transient DB error) is a permanent, unretried job failure."
    missing:
      - "Scope the BullMQ jobId per tenant: `{ jobId: \\`${workspaceId}:${eventId}\\` }`."
      - "Scope the DB dedupe key per tenant: `PRIMARY KEY (workspace_id, id, occurred_at)` + matching `ON CONFLICT`."
      - "Add a DEFAULT partition (`CREATE TABLE events_default PARTITION OF events DEFAULT;`) and/or reject/clamp out-of-window `occurredAt` at validation time."
      - "Configure `defaultJobOptions: { attempts: 5, backoff: {...} }` on both `events:ingest` and `imports:csv` queues (also closes WR-01)."
    reason_for_partial_pass: "Contacts API (POST /v1/contacts) itself is unaffected — its identity key is the server-generated `contacts.id`, not a client-supplied global key — so CONT-03 in isolation is sound; the failure is specific to the event-ingestion half of this success criterion (EVNT-01/EVNT-03)."
deferred: []
human_verification:
  - test: "Create a contact with an email, a tag, and one custom property — confirm toast «Контакт создан» and list appearance."
    expected: "Contact appears in list with tag and property visible."
    why_human: "Visual/toast confirmation in a live browser session."
  - test: "Search by email and by name; apply the status filter and a tag filter; sort a column; page forward/back."
    expected: "Each interaction filters/sorts/paginates correctly; filtered-empty copy shows when nothing matches."
    why_human: "Interactive UI behavior, not visible via source grep."
  - test: "Open a contact; add another custom property (confirm key autocomplete from prior properties via native datalist); change tag set; save."
    expected: "Confirm «Контакт обновлён» and the new property/tags persist."
    why_human: "Autocomplete/datalist interaction requires a rendered browser."
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
  - test: "Send a test event for a contact via POST /v1/events (API key from 02-03) or seed one; open that contact's card → События tab."
    expected: "Event appears with name, relative time, and an expandable JSON payload (D-14)."
    why_human: "Visual confirmation of the live event feed rendering."
  - test: "Confirm spacing/typography/color and Russian copy match the Phase 2 UI-SPEC across the contact list/form/detail and CSV wizard."
    expected: "Visual fidelity to UI-SPEC."
    why_human: "Design/visual review, not verifiable via grep."
---

# Phase 02: Contacts & Event Ingestion Verification Report

**Phase Goal:** Contact base via UI/CSV/API plus an async server-side event stream that upserts contacts.
**Verified:** 2026-07-04T11:24:38Z
**Status:** gaps_found
**Re-verification:** No — initial verification

**Note on MVP-mode goal formatting:** ROADMAP.md's rendered "Goal" line for Phase 2 ("A marketer can build and maintain their contact base...") does not literally match the "As a [role], I want to [capability], so that [outcome]" regex the mvp-mode guard checks (it validates `false`). However, every PLAN.md in this phase embeds the properly-formatted phase goal ("As a marketer, I want to build and maintain my contact base through the UI, CSV import, and a server-side API — while my product backend streams freeform behavioral events — so that my contacts are created and enriched in real time and every contact carries an accurate subscription status"), which does validate against the same regex once the em-dash clause is folded into the outcome. Verification proceeded using the ROADMAP's 5 Success Criteria (the authoritative contract per Step 2a) rather than blocking on this authoring inconsistency in the rendered ROADMAP.md goal line.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A user can create, view, edit, and delete a contact in the UI, including arbitrary custom profile properties. | ✗ FAILED (partial) | Create/view/list/delete confirmed wired and working (`ContactsListPage.tsx`, `ContactForm.tsx`, `contacts.routes.ts` DELETE handler). **Edit is broken for the exact case the criterion calls out**: CR-04 confirms property deletion and standard-field clearing never persist despite a success toast (`contact.repository.ts:286`, `CustomPropertyEditor.tsx`, `ContactForm.tsx` `cleanPayload`). |
| 2 | A user can upload a CSV, map columns to attributes, preview the result before applying, and receive a report of errors and duplicates. | ✓ VERIFIED | `CsvImportWizard.tsx` (5-step flow), `csv-import.routes.ts` (upload/mapping/dry-run/status/error-report), `imports-csv.worker.ts` (background apply, reuses `upsertContactByIdentity`) all present, wired, and covered by passing tests (`csv-import.test.ts`, `imports-csv-idempotency.test.ts`). Warnings WR-03/04/05/07/09 (stuck-`applying` state, silent truncated uploads, unvalidated CSV `subscriptionStatus`, status-guard races, dead-connection pool leak) are real operational gaps but do not block the core described behavior. |
| 3 | A tenant's backend can create/update contacts via the Contacts API and post freeform events (name + JSON) with an API key, getting an immediate 2xx while processing happens asynchronously through a queue. | ✗ FAILED (partial) | `POST /v1/contacts` (CONT-03) works correctly and is unaffected by the issues below (its identity key is server-generated). `POST /v1/events` (EVNT-01/EVNT-03) mechanically returns 202 and enqueues correctly, BUT CR-01 (client-supplied `eventId` used as a globally-scoped BullMQ jobId + events PK, unscoped by `workspace_id` — cross-tenant event collision silently drops events) and CR-03 (events accepted with `occurredAt` outside the two pre-created partitions permanently fail with zero retries configured on either queue) mean the "processing happens asynchronously" promise is not reliable and, in CR-01's case, breaks workspace isolation on the platform's highest-volume write path. |
| 4 | An event for an unknown contact automatically creates it via external_id/email upsert, and a later email change still resolves to the same contact. | ✓ VERIFIED | `upsertContactByIdentity` (`contact-repository.ts`) confirmed correct for all 5 branches via passing tests (`upsert-priority.test.ts`); `events-ingest.worker.ts` reuses the exact same function. CR-02 (dead-code unique-violation retry — the retry runs inside an already-aborted transaction and will itself throw `25P02`) is a real correctness gap but only manifests under a genuine concurrent double-insert race on a brand-new identity, not the tested/primary behavior this criterion describes — noted as a warning, not a truth failure. |
| 5 | Every contact carries a 3-state subscription status (subscribed / unsubscribed / suppressed). | ✓ VERIFIED | `subscriptionStatusEnum` in schema, D-12 transition guards enforced in `updateContact` (suppressed→subscribed rejected; direct set-to-suppressed rejected), suppression-list override on create (D-08/D-11). Confirmed by passing `subscription-status.test.ts`. |

**Score:** 3/5 truths verified (2 failed — see gaps below). No truths were classified ⚠️ PRESENT_BEHAVIOR_UNVERIFIED: every behavior-dependent invariant in scope (idempotent redelivery, no-duplicate-on-retry) has a passing, directly-relevant behavioral test (`events-ingest-idempotency.test.ts`, `imports-csv-idempotency.test.ts`).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/db/src/schema/contacts.ts` + `0004_contacts_rls_policies.sql` | contacts table + RLS | ✓ VERIFIED | ENABLE + FORCE + `workspace_isolation` policy present. |
| `apps/api/src/modules/contacts/contact.repository.ts` | tenant-scoped CRUD + upsert | ⚠️ PARTIAL | CRUD present and wired; `updateContact`'s merge semantics break property/field deletion (CR-04). `upsertContactByIdentity`'s retry-on-race is dead code (CR-02). |
| `apps/api/src/modules/contacts/contacts.routes.ts` | session-authed CRUD routes | ✓ VERIFIED | GET/POST/PATCH/DELETE all present, registered in `server.ts`. |
| `apps/api/src/modules/contacts/contacts-api.routes.ts` | API-key-authed `/v1/contacts` | ✓ VERIFIED | `apiKeyAuth` onRequest hook, workspace resolved solely from key, reuses `upsertContactByIdentity`. |
| `apps/api/src/modules/api-keys/api-key-auth.ts` | key generation + auth hook | ✓ VERIFIED | `timingSafeEqual`, uniform 401, onRequest (pre-body-parse) placement confirmed. |
| `packages/db/migrations/0007_events_partitioned.sql` | partitioned events + RLS | ⚠️ HOLLOW (partial) | Table/RLS/indexes correctly structured, but only 2 of an unbounded-input-range's partitions exist and PK/dedupe key is not workspace-scoped (CR-01/CR-03). |
| `apps/api/src/modules/events/events-api.routes.ts` | fast-2xx `/v1/events` | ⚠️ PARTIAL | Fast-2xx + enqueue-only behavior confirmed (no inline upsert/insert); jobId scoping bug (CR-01). |
| `apps/worker/src/queues/events-ingest.worker.ts` | idempotent event worker | ⚠️ PARTIAL | Idempotent for same-tenant redelivery (tested); dedupe key not tenant-scoped (CR-01). |
| `apps/web/src/features/contacts/{ContactsListPage,ContactForm,ContactDetailPage,CustomPropertyEditor,SubscriptionStatusBadge}.tsx` | contact UI | ⚠️ PARTIAL | All exist, wired, substantive, routed. `CustomPropertyEditor`'s deletion UX is silently broken server-side (CR-04). |
| `apps/web/src/features/contacts/{CsvImportWizard,CsvImportHistory,ContactEventFeed}.tsx` | CSV UI + event feed | ✓ VERIFIED | All exist, wired, routed (`App.tsx`), substantive (2014 total LOC across contacts feature dir, no stub patterns found). |
| `apps/worker/src/queues/imports-csv.worker.ts` | idempotent CSV apply worker | ✓ VERIFIED (with warnings) | Row-level idempotency via `(csv_import_id, row_number)` + `FOR UPDATE` re-check confirmed; WR-03's stuck-`applying`-with-no-retry gap confirmed in source (swallowed catch at line 123). |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `contact.repository.ts` | `tenant-context.ts` | `withTenantTransaction` | ✓ WIRED | Every contact query runs inside the RLS tenant transaction. |
| `contacts.routes.ts` | `server.ts` | route registration | ✓ WIRED | Confirmed registered. |
| `contacts-api.routes.ts` | `api-key-auth.ts` | `onRequest: apiKeyAuth` | ✓ WIRED | Workspace resolved solely from `request.apiKeyWorkspaceId`. |
| `events-api.routes.ts` | `events-ingest.worker.ts` | BullMQ `EVENTS_INGEST_QUEUE` | ✓ WIRED (mechanically) | Producer/consumer connected; dedupe-key scoping is the CR-01 defect, not a wiring gap. |
| `events-ingest.worker.ts` | `contact.repository.ts` | `upsertContactByIdentity` reuse | ✓ WIRED | Single shared function, no drift between call sites (contacts API, events worker, CSV worker all call the same export). |
| `imports-csv.worker.ts` | `contact.repository.ts` | `upsertContactByIdentity` reuse | ✓ WIRED | Same as above. |
| `ContactsListPage.tsx` | `contacts.routes.ts` | TanStack Query `apiGet` | ✓ WIRED | Confirmed via route registration + list query usage. |
| `CsvImportWizard.tsx` | `csv-import.routes.ts` | TanStack Query upload/dry-run/apply/status polling | ✓ WIRED | `refetchInterval`-based polling confirmed present in SUMMARY and route existence confirmed. |
| `ContactEventFeed.tsx` | `contacts.routes.ts` (`GET .../events`) | `apiGet` | ✓ WIRED | Route + repository function (`listContactEvents`) confirmed present, workspace-scoped via explicit check + RLS. |

### Behavioral Spot-Checks / Full Test Run

Ran each workspace's full test suite once (Postgres `mega_crm_test` + Redis DB 1 available in this environment):

| Suite | Command | Result | Status |
|-------|---------|--------|--------|
| `apps/api` | `npm run test -w apps/api` (94 tests, 17 files) | 94/94 passed | ✓ PASS |
| `apps/worker` | `npm run test -w apps/worker` (11 tests, 3 files) | 11/11 passed | ✓ PASS |

All existing automated tests pass — this confirms the *tested* behaviors (upsert branches, idempotent redelivery, CRUD, API-key auth, RLS isolation for standard queries) are genuinely implemented, not stubbed. Critically, **none of the passing tests exercise CR-01 (cross-tenant jobId/PK collision), CR-02 (concurrent-insert race retry), CR-03 (out-of-partition-window `occurredAt`), or CR-04 (property/field deletion)** — these are real gaps in both the implementation and the test suite, independently confirmed by direct source inspection during this verification (not merely re-asserted from the code review).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| CONT-01 | 02-01, 02-02 | Create/view/edit/delete contacts in UI | ✗ BLOCKED (partial) | Create/view/delete work; edit of custom properties/field-clearing broken (CR-04). |
| CONT-02 | 02-07, 02-08 | CSV import with mapping/preview/error report | ✓ SATISFIED | Full pipeline present, wired, tested; operational warnings only (WR-03/04/05/07/09). |
| CONT-03 | 02-01, 02-03, 02-04 | Contacts CRUD API | ✓ SATISFIED | `/v1/contacts` works correctly; not affected by CR-01/CR-03 (server-generated identity key). |
| CONT-04 | 02-04 | external_id/email prioritized upsert | ✓ SATISFIED (with warning) | All 5 branches tested and correct; CR-02 dead-code retry only affects a rare concurrent-race edge case. |
| CONT-05 | 02-01, 02-02 | Arbitrary custom properties | ✗ BLOCKED (partial) | Round-trip create→read works; deletion via update broken (CR-04, shared root cause with CONT-01). |
| EVNT-01 | 02-03, 02-06 | Freeform event API with API key | ✗ BLOCKED (partial) | Route/auth/envelope-validation correct; CR-01's global jobId scoping breaks the per-tenant guarantee. |
| EVNT-02 | 02-04, 02-06 | Auto-create contact from event | ✓ SATISFIED | `upsertContactByIdentity` reuse confirmed and tested from the event worker. |
| EVNT-03 | 02-05, 02-06 | Fast 2xx, async queue processing | ✗ BLOCKED (partial) | 2xx-then-enqueue mechanics correct; CR-03 + WR-01 (no retry config) mean accepted events can be silently, permanently lost. |
| SUBS-01 | 02-01, 02-02 | 3-state subscription status | ✓ SATISFIED | Enum + D-12 transition guards confirmed and tested. |

**Orphaned requirements check:** REQUIREMENTS.md's traceability table maps exactly CONT-01..05, EVNT-01..03, SUBS-01 to Phase 2 — identical to the phase's declared requirement-ID list. No orphaned requirements found.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/api/src/modules/events/events-api.routes.ts` | 91 | Client-supplied UUID used as global BullMQ jobId | 🛑 Blocker | Cross-tenant event squatting/silent drop (CR-01) |
| `packages/db/migrations/0007_events_partitioned.sql` | 27, 36-39 | PK not workspace-scoped; only 2 partitions, no DEFAULT | 🛑 Blocker | Silent, permanent data loss for out-of-window events (CR-03) |
| `packages/contacts-core/src/contact-repository.ts` | 256-262 | Retry-on-unique-violation runs inside already-aborted transaction | 🛑 Blocker (rare-path) | Dead-code defense; actual race surfaces as 500/25P02 (CR-02) |
| `apps/api/src/modules/contacts/contact.repository.ts` (line 286) / `apps/web/.../CustomPropertyEditor.tsx` / `ContactForm.tsx` | 286 / 61-63 / 192-202 | PATCH merge vs UI replace-intent mismatch | 🛑 Blocker | Property deletion + field clearing silently no-op with false success toast (CR-04) |
| `apps/api/src/modules/events/events-queue.ts`, `imports-csv-queue.ts`, worker files | — | No `attempts`/`backoff`/`defaultJobOptions` on either queue | ⚠️ Warning | Any transient failure (including CR-03's partition miss) is permanent, unretried job loss (WR-01) |
| `apps/worker/src/queues/imports-csv.worker.ts` | 114-124, 144-149 | Swallowed error can strand import in `applying` forever | ⚠️ Warning | No automatic recovery (WR-03) |
| `apps/api/src/modules/contacts/csv-import.routes.ts` | 144-197 | No failure path on malformed/truncated CSV upload | ⚠️ Warning | Silent partial import reported as success (WR-04) |
| `packages/contacts-core/src/csv-mapping.ts` | 59-63 | Unvalidated `subscriptionStatus` from CSV mapping | ⚠️ Warning | dry-run/apply drift + bypass of "cannot set suppressed" rule (WR-05) |
| `packages/contacts-core/src/contact-repository.ts` | 297-323 | `upsertContactByIdentity` ignores `subscriptionStatus` on update branch | ⚠️ Warning | Silent no-op for API callers expecting a status change (WR-06) |
| `packages/tenant-context/src/index.ts`, `api-keys.repository.ts` | 79-89, 105-114 | Dead pooled connections released without destroy flag | ⚠️ Warning | Broken connections re-enter the pool (WR-09) |

No unresolved `TBD`/`FIXME`/`XXX` debt markers found in any file modified in this phase (grep across all phase-touched directories returned zero hits beyond legitimate HTML `placeholder=` attributes).

### Human Verification Required

9 items carried forward from 02-02 and 02-08's deferred `checkpoint:human-verify` tasks (per `workflow.human_verify_mode: "end-of-phase"`) — see frontmatter `human_verification` for full detail. These are standard UI/visual/interaction checks (contact CRUD flow, filter/sort/paginate, CSV wizard end-to-end with navigate-away/back, live event feed rendering, UI-SPEC visual fidelity) that cannot be verified via source inspection and were explicitly and correctly deferred rather than silently skipped.

### Gaps Summary

Two blocking, code-review-confirmed defects prevent a clean pass despite strong overall implementation quality (94+11 automated tests passing, solid RLS/multi-tenancy fundamentals everywhere except the specific defect below, correct upsert-identity logic, complete CSV pipeline):

1. **CR-04 (contact/property edit is a silent no-op for deletion/clearing)** — breaks Success Criterion #1 exactly as written ("edit... including arbitrary custom profile properties"). A marketer who removes a custom property or clears a field sees a success toast, but the data never changes. This is a shipping-blocking UX correctness bug on the phase's most basic manual-CRUD surface.

2. **CR-01 + CR-03 (event ingestion can silently violate workspace isolation and permanently lose accepted events)** — CR-01 breaks the hard project constraint "Multi-tenancy: изоляция данных тенантов с первого дня" on the highest-volume write path; CR-03 (compounded by the absence of any queue retry configuration, WR-01) means any event with an `occurredAt` outside a hand-maintained 2-month partition window is accepted with a 202 and then permanently dropped. Both are real, verified defects — not hypothetical — with concrete, minimal fixes documented in `02-REVIEW.md` (workspace-scope the jobId/PK; add a DEFAULT partition and/or validate `occurredAt` range; configure `defaultJobOptions`).

Neither gap is covered by an existing test, and neither was self-disclosed as an accepted risk in any plan's SUMMARY.md — both were found only by the standing-depth code review and independently re-confirmed against the current source during this verification. Recommend routing both through `/gsd-plan-phase --gaps` before considering Phase 2 complete; CR-02 and the Warning-level findings (WR-01 through WR-10) should be triaged alongside but are lower severity (concurrent-race edge case and operational robustness gaps respectively, not core-flow correctness failures).

---

_Verified: 2026-07-04T11:24:38Z_
_Verifier: Claude (gsd-verifier)_
