---
phase: 02-contacts-event-ingestion
plan: 08
subsystem: ui
tags: [react, tanstack-query, shadcn, fastify, postgres-rls, csv-import, events]

# Dependency graph
requires:
  - phase: 02-contacts-event-ingestion
    provides: "CSV import backend (upload/dry-run/apply/status/error-report routes + imports:csv worker, 02-07); events:ingest worker writing the partitioned events table (02-06); contact detail tabbed layout with a События placeholder (02-02)"
provides:
  - "CsvImportWizard: upload -> column-mapping (incl. create-new-property) -> dry-run summary -> apply/progress -> report, wired to the 02-07 backend"
  - "CsvImportHistory: past-imports list (file/date/author/status/summary/error-download) that re-enters a run's progress/report view"
  - "GET /api/workspaces/:slug/contacts/:id/events (listContactEvents) + ContactEventFeed: the contact card's live, expandable event feed"
affects: [Phase 3 segmentation (contact detail UI patterns), Phase 7 full activity timeline (event feed is its seed)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Multipart file upload via a dedicated fetch (credentials: include), never the JSON apiPost wrapper -- CsvImportWizard's uploadCsvFile helper"
    - "Progress/report re-entry: a single component (ApplyProgressAndReport) renders both the polling progress bar and the terminal report from the same status query, reused identically by the fresh-apply flow and the history re-entry route"
    - "Read-route author resolution: the CSV status response exposes only createdByUserId; the web client joins it against the already-existing GET /members list rather than duplicating a user-lookup in the read-only status route"

key-files:
  created:
    - apps/web/src/features/contacts/CsvImportWizard.tsx
    - apps/web/src/features/contacts/CsvImportHistory.tsx
    - apps/web/src/features/contacts/ContactEventFeed.tsx
    - apps/api/src/modules/contacts/__tests__/contact-events-read.test.ts
  modified:
    - apps/web/src/features/contacts/ContactDetailPage.tsx
    - apps/web/src/App.tsx
    - apps/web/src/features/app-shell/AppShell.tsx
    - apps/web/src/features/onboarding/OnboardingChecklist.tsx
    - apps/api/src/modules/contacts/contacts.routes.ts
    - apps/api/src/modules/contacts/contact.repository.ts
    - apps/api/src/modules/contacts/csv-import.routes.ts
    - packages/shared-schemas/src/event.ts
    - packages/shared-schemas/src/csv-import.ts

key-decisions:
  - "csv_imports status response/schema now also exposes createdByUserId (previously internal-only) so CsvImportHistory can resolve the uploading member's display name against GET /members -- D-20 requires an author column the read route didn't surface yet"
  - "listContactEvents lives in contact.repository.ts (not a new events-read module) and is workspace-scoped by BOTH an explicit contact-existence 404 check and RLS on the events parent table -- defense-in-depth per T-02-08-01"
  - "CsvImportWizard's :id re-entry route skips mapping replay entirely (headers/previewRows aren't recoverable from the status route) -- re-entry only ever jumps to the progress/report view (applying/done/failed statuses), matching D-16's literal scope"

patterns-established:
  - "Wizard step state is local component state (not URL-driven) for a fresh import; only re-entry (import/:id) is URL-addressable, keeping the common path simple while still satisfying D-16's navigable-away-and-back requirement"

requirements-completed: [CONT-02, EVNT-01]

coverage:
  - id: D1
    description: "CSV import wizard walks upload -> column-mapping (incl. Создать новое свойство...) -> dry-run summary (three Display-sized stat cards) -> deliberate apply -> pollable progress -> report with error-CSV download"
    requirement: CONT-02
    verification:
      - kind: other
        ref: "npm run build -w apps/web (clean) + grep -q 'Progress\\|progress' and 'refetchInterval' in CsvImportWizard.tsx"
        status: pass
      - kind: manual_procedural
        ref: "02-UAT.md checklist items 1-5 (upload, mapping incl. create-new-property, dry-run stats, apply+progress+navigate-away-and-back, report+error-download)"
        status: unknown
    human_judgment: true
    rationale: "Visual/interaction correctness (drag-free multi-step wizard, exact stat-card sizing/colors, progress-bar behavior across a real navigate-away-and-back) requires a human to drive the browser; automated build/grep checks only prove the code compiles and contains the required primitives."
  - id: D2
    description: "Import history lists past imports (file, date, author, status/summary, error-report link) and re-enters a run's progress/report view via the same polled status endpoint"
    requirement: CONT-02
    verification:
      - kind: other
        ref: "npm run build -w apps/web (clean)"
        status: pass
      - kind: manual_procedural
        ref: "02-UAT.md checklist item 6 (import history lists the run)"
        status: unknown
    human_judgment: true
    rationale: "History-list correctness (author resolution, re-entry navigation) is best confirmed visually; no dedicated automated test was added for this list component in this plan."
  - id: D3
    description: "GET /api/workspaces/:slug/contacts/:id/events returns events newest-first, workspace-scoped (RLS + explicit contact check), and the contact card's События tab renders them as an expandable Collapsible feed (icon + name + relative time + JSON)"
    requirement: EVNT-01
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contact-events-read.test.ts#returns the contact's events newest-first, workspace-scoped"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contact-events-read.test.ts#returns an empty feed for a contact with no events yet"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contact-events-read.test.ts#T-02-08-01: workspace B cannot read workspace A's contact events"
        status: pass
      - kind: manual_procedural
        ref: "02-UAT.md checklist item 7 (send/seed a real event, confirm it appears in the card with expandable JSON)"
        status: unknown
    human_judgment: true
    rationale: "The read route's correctness (newest-first, workspace isolation) is fully proven by automated tests; the end-to-end \"a real event sent via /v1/events shows up live in the browser\" experience still needs a human to drive it, per D-14's UX intent."

# Metrics
duration: 25min
completed: 2026-07-04
status: complete
---

# Phase 2 Plan 8: CSV Import Wizard + Live Event Feed Summary

**CSV import wizard (upload -> column-mapping -> dry-run stat cards -> pollable apply progress -> report) plus a workspace-scoped contact-events read route feeding a live, expandable Collapsible event feed on the contact card.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-07-04T15:20:00+05:00
- **Completed:** 2026-07-04T15:45:00+05:00
- **Tasks:** 2 auto tasks + 1 deferred human-verify checkpoint
- **Files modified:** 13 (4 created, 9 modified)

## Accomplishments
- `CsvImportWizard`: five-step flow (upload with client-side wrong-type/too-large guard -> column mapping with per-column target select incl. «Создать новое свойство…» -> dry-run summary with three Display-sized stat cards -> deliberate «Применить импорт» -> determinate progress bar polled via `refetchInterval`, safe to navigate away from -> completion report with a conditional error-CSV download)
- `CsvImportHistory`: past-imports table (file, date, author resolved against `GET /members`, status badge, summary, error-download) with each in-flight/complete row re-entering the wizard's progress/report view at `/w/:slug/contacts/import/:id`
- New session-authed `GET /api/workspaces/:slug/contacts/:id/events` route (+ `listContactEvents` repository function) reading the partitioned `events` table newest-first, paginated, workspace-scoped by both an explicit contact-existence check and RLS
- `ContactEventFeed` replaces the 02-02 События-tab placeholder with a live feed: Activity icon + event name + relative time (`Intl.RelativeTimeFormat("ru")`) + expandable `Collapsible` JSON payload
- Wired `/w/:slug/contacts/import`, `/w/:slug/contacts/import/:id`, and `/w/:slug/contacts/imports` routes, an «Импорт CSV» AppShell nav entry, and an «Импортируйте контакты» onboarding checklist item

## Task Commits

Each task was committed atomically:

1. **Task 1: CSV import wizard (upload -> mapping -> dry-run -> apply/progress -> report)** - `9bca321` (feat)
2. **Task 2: Import history + wizard route/nav/onboarding + contact-card live event feed** - `aea6d1c` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `apps/web/src/features/contacts/CsvImportWizard.tsx` - five-step multipart-upload/mapping/dry-run/apply/report wizard + `:id` re-entry branch
- `apps/web/src/features/contacts/CsvImportHistory.tsx` - past-imports list, resolves author via `GET /members`, re-enters via `CsvImportWizard`'s `:id` route
- `apps/web/src/features/contacts/ContactEventFeed.tsx` - live, expandable event feed for the contact card's События tab
- `apps/web/src/features/contacts/ContactDetailPage.tsx` - swapped the 02-02 events placeholder for `ContactEventFeed`
- `apps/web/src/App.tsx` - registers `/contacts/imports`, `/contacts/import`, `/contacts/import/:id`
- `apps/web/src/features/app-shell/AppShell.tsx` - «Импорт CSV» nav link
- `apps/web/src/features/onboarding/OnboardingChecklist.tsx` - «Импортируйте контакты» checklist item
- `apps/api/src/modules/contacts/contacts.routes.ts` - new `GET .../contacts/:id/events` route
- `apps/api/src/modules/contacts/contact.repository.ts` - `listContactEvents` (newest-first, paginated, workspace-scoped)
- `apps/api/src/modules/contacts/csv-import.routes.ts` - `toStatusResponse` now exposes `createdByUserId`
- `packages/shared-schemas/src/event.ts` - `contactEventSchema`
- `packages/shared-schemas/src/csv-import.ts` - `csvImportStatusSchema` gains `createdByUserId`
- `apps/api/src/modules/contacts/__tests__/contact-events-read.test.ts` - read-route coverage (newest-first, empty feed, cross-tenant isolation)

## Decisions Made
- Exposed `createdByUserId` on the CSV import status response/schema so `CsvImportHistory` can resolve the uploading member's name against the already-existing `GET /members` list, rather than adding a dedicated author-lookup endpoint -- D-20 explicitly requires an author column the prior read route didn't surface.
- `listContactEvents` enforces workspace isolation twice: an explicit `getContact(id)` 404 check in the route AND RLS on the `events` parent table underneath (T-02-08-01) -- the extra application-level check also gives a clean 404 instead of an empty-array ambiguity for a foreign/nonexistent contact id.
- The wizard's `:id` re-entry route deliberately does NOT attempt to replay the mapping/preview steps (the status route never returns `headers`/`previewRows`) -- it only ever resolves to the progress/report view for `applying`/`done`/`failed` imports, with a fallback card for any earlier status, matching D-16's literal "progress/report re-entry" scope rather than a full wizard resume.
- Relative timestamps use the browser's native `Intl.RelativeTimeFormat("ru")` instead of a hand-rolled Russian pluralization helper -- correct plural forms ("минуту"/"минуты"/"минут") for free, no new dependency.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Exposed `createdByUserId` on the CSV import status response/schema**
- **Found during:** Task 2 (CsvImportHistory implementation)
- **Issue:** The plan's must-haves truth explicitly requires the import history to show "author" (D-20), but neither `csvImportStatusSchema` nor `csv-import.routes.ts`'s `toStatusResponse` exposed the already-persisted `createdByUserId` column -- the history list had no way to resolve who uploaded a given import.
- **Fix:** Added `createdByUserId` to `csvImportStatusSchema` (shared-schemas) and to `toStatusResponse`'s output; `CsvImportHistory` joins it against the existing `GET /members` list (same shape `TeamPage` already consumes) to render a display name.
- **Files modified:** `packages/shared-schemas/src/csv-import.ts`, `apps/api/src/modules/contacts/csv-import.routes.ts`
- **Verification:** `npm run build -w apps/api` and `npm run test -w apps/api` (94/94) remain green; `npm run build -w apps/web` clean.
- **Committed in:** `aea6d1c` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical field for an explicitly required truth)
**Impact on plan:** Necessary to satisfy D-20's author-column requirement; no new endpoints, tables, or business rules introduced beyond exposing an already-stored column.

## Issues Encountered
None beyond the deviation above.

## Checkpoint Deferred to Phase-Level UAT

**Task 3 (checkpoint:human-verify, gate="blocking")** -- CSV import wizard + live event feed visual/interaction verification -- was **not** run mid-flight. Per `.planning/config.json`'s `workflow.human_verify_mode: "end-of-phase"` (and the same precedent already established for every other Phase 2 plan's human-verify checkpoint: 02-01 through 02-05), this checkpoint's manual verification steps are deferred to the phase-level UAT pass rather than blocking this plan's completion. Automated coverage (94/94 apps/api tests, 11/11 apps/worker tests, clean `apps/web`/`apps/api` builds, the plan's own `grep`-based acceptance checks) is accepted as sufficient to unblock downstream work.

Manual checks carried forward to phase UAT:
1. Run `npm run dev` (Docker Postgres + Redis up; worker running); open `/w/{slug}/contacts` and start a CSV import.
2. Upload a small CSV; confirm header columns and the ~20-row preview appear; map a column to «Создать новое свойство…» and name it.
3. Choose the duplicate policy; run «Проверить файл»; confirm the three stat cards (Будет создано / Будет обновлено / Ошибок) and that nothing is written yet.
4. Click «Применить импорт»; watch the progress bar advance; navigate away to the contacts list and back into the import from history — confirm progress resumes via polling (D-16).
5. On completion, confirm the report counts and, if there were errors, download the error CSV and confirm the reason column.
6. Confirm import history lists the run (file, date, author, summary).
7. Send a test event for a contact via `/v1/events` (using an API key from 02-03) or seed one; open that contact's card -> События tab and confirm the event appears with name, relative time, and an expandable JSON payload (D-14).
8. Confirm spacing/typography/color and Russian copy match the Phase 2 UI-SPEC.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All three contact-ingestion surfaces (manual CRUD, CSV import, event API) now have both backend and UI in place; Phase 2's CONT-02/EVNT-01 requirements are UI-complete pending the deferred UAT pass above.
- The event feed's read route (`listContactEvents`) is the explicit seed for Phase 7's full activity timeline -- no rework anticipated, just additional event-source types feeding the same table/route.
- No blockers for Phase 3 (segmentation): the property registry, subscription status, and now the CSV/event ingestion UI are all wired end-to-end.

---
*Phase: 02-contacts-event-ingestion*
*Completed: 2026-07-04*

## Self-Check: PASSED

All 14 files (13 code/test + this SUMMARY) found on disk; both task commit hashes (`9bca321`, `aea6d1c`) found in git history.
