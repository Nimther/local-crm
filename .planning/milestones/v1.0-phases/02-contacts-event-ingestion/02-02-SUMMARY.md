---
phase: 02-contacts-event-ingestion
plan: 02
subsystem: ui
tags: [react, tanstack-table, tanstack-query, react-hook-form, zod, shadcn, tabs, radio-group]

# Dependency graph
requires:
  - phase: 02-01
    provides: Contacts API (CRUD, list/filter/sort/paginate, subscription-status rules D-06/D-07/D-08/D-12)
  - phase: 02-03
    provides: workspace-scoped API-key auth context reused by the web app's tenant routing
provides:
  - "/w/:slug/contacts list page: search (email/name/external_id), status + tag filters, sortable columns, pagination, semantic subscription badges"
  - Contact create/edit form (RHF + Zod) with inline server-error surfacing (D-07 email uniqueness), read-only external_id (D-06)
  - CustomPropertyEditor with registry-driven key autocomplete + type-aware value inputs (text/number/checkbox/date)
  - Tag chip editor (comma/Enter commit)
  - D-12-safe subscription control (subscribed<->unsubscribed only; suppressed renders disabled+tooltip, never actionable)
  - ContactDetailPage with Overview/Свойства/События tabs (событий placeholder pending 02-06)
  - Delete AlertDialog with D-08 compliance copy
  - "GET /api/workspaces/:slug/property-registry + listPropertyRegistry() (new, Rule 2 deviation) backing the property-key autocomplete"
affects: [02-06 (event feed populates the События tab), 02-07 (CSV import reuses this feature dir), phase-07 (full contact timeline)]

# Tech tracking
tech-stack:
  added: ["@tanstack/react-table", "shadcn: progress, radio-group, collapsible, textarea, tabs"]
  patterns:
    - "TanStack Query key [\"workspace\", slug, \"contacts\", queryState] with server-driven pagination/search/filter, client-driven column sort via headless @tanstack/react-table"
    - "RHF + zodResolver reusing SendGridKeySettings' extractErrorMessage pattern to surface exact server error copy inline"
    - "Registry-driven autocomplete via native <datalist>, not a custom combobox component"

key-files:
  created:
    - apps/web/src/features/contacts/ContactsListPage.tsx
    - apps/web/src/features/contacts/ContactForm.tsx
    - apps/web/src/features/contacts/ContactDetailPage.tsx
    - apps/web/src/features/contacts/CustomPropertyEditor.tsx
    - apps/web/src/features/contacts/SubscriptionStatusBadge.tsx
    - apps/web/src/components/ui/progress.tsx
    - apps/web/src/components/ui/radio-group.tsx
    - apps/web/src/components/ui/collapsible.tsx
    - apps/web/src/components/ui/textarea.tsx
    - apps/web/src/components/ui/tabs.tsx
    - apps/api/src/modules/contacts/property-registry.ts
  modified:
    - apps/web/src/App.tsx
    - apps/web/src/features/app-shell/AppShell.tsx
    - apps/web/src/features/onboarding/OnboardingChecklist.tsx
    - apps/web/src/lib/api.ts
    - apps/web/package.json
    - apps/api/src/modules/contacts/contacts.routes.ts
    - packages/shared-schemas/src/contact.ts

key-decisions:
  - "02-02: Task 3 (human verification of the contact UI) deferred to phase-level UAT per workflow.human_verify_mode: \"end-of-phase\" and the established Phase-1 precedent (01-03/01-04/01-05) -- automated coverage (clean npm run build -w apps/web, route/nav grep checks, Tabs/RadioGroup presence checks) accepted as sufficient to unblock downstream plans; 9 manual UAT items carried forward"
  - "02-02: added GET /api/workspaces/:slug/property-registry + listPropertyRegistry() (Rule 2) -- custom-property key autocomplete had no data source; 02-01 never exposed a read endpoint for the property registry"
  - "02-02: 409 contact-conflict responses now include a machine-readable code field (email_taken) (Rule 1) so the frontend renders the exact D-07 Russian copy instead of the repository's raw English message"
  - "02-02: added apiPatch() to apps/web/src/lib/api.ts (Rule 3) -- no PATCH helper existed and contact edit needed one"

patterns-established:
  - "Contact feature UI lives under apps/web/src/features/contacts/ -- reused as-is by 02-07 (CSV import) and extended by 02-06 (event feed) and Phase 7 (full timeline)"

requirements-completed: [CONT-01, CONT-05, SUBS-01]

coverage:
  - id: D1
    description: "Contact list at /w/:slug/contacts with search (email/name/external_id), status + tag filters, sortable columns, pagination, and semantic subscription badges"
    requirement: "CONT-01"
    verification:
      - kind: automated_ui
        ref: "npm run build -w apps/web (tsc --noEmit + vite build) -- clean"
        status: pass
      - kind: other
        ref: "grep -q react-table apps/web/package.json && grep -q contacts apps/web/src/App.tsx"
        status: pass
    human_judgment: true
    rationale: "Visual/interaction correctness (search/filter/sort/pagination behavior, filtered-empty copy, badge colors) requires a human walking the browser flow -- deferred to phase-level UAT per human_verify_mode: end-of-phase"
  - id: D2
    description: "Contact create/edit form with custom-property editor, tag input, and D-12-safe subscription control; ContactDetailPage with Overview/Свойства/События tabs"
    requirement: "CONT-05"
    verification:
      - kind: automated_ui
        ref: "npm run build -w apps/web -- clean"
        status: pass
      - kind: other
        ref: "grep -q Tabs apps/web/src/features/contacts/ContactDetailPage.tsx && grep -q RadioGroup apps/web/src/features/contacts/ContactForm.tsx"
        status: pass
    human_judgment: true
    rationale: "Form UX (autocomplete behavior, inline D-07 error copy, D-06 read-only external_id helper, D-12 tooltip non-actionability, delete AlertDialog compliance copy, Russian copy fidelity) is genuinely a human-judgment UI verification -- deferred to phase-level UAT"
  - id: D3
    description: "Subscription status renders as a semantic badge; suppressed state is read-only and non-actionable in the UI"
    requirement: "SUBS-01"
    verification:
      - kind: other
        ref: "grep -q RadioGroup apps/web/src/features/contacts/ContactForm.tsx (disabled+tooltip suppressed-state code path present)"
        status: pass
    human_judgment: true
    rationale: "Confirming the suppressed control is genuinely non-clickable in the rendered browser (not just present in source) requires human visual/interaction verification -- deferred to phase-level UAT"

duration: 10min
completed: 2026-07-04
status: complete
---

# Phase 2 Plan 2: Contact List, Create/Edit Form, and Detail Page Summary

**Contact base is now fully manageable in the browser: TanStack-Table list with search/filter/sort/pagination, an RHF+Zod create/edit form with a registry-driven custom-property editor and D-12-safe subscription control, and a tabbed detail page — all wired to the 02-01 API.**

## Performance

- **Duration:** 10 min (Task 1 + Task 2 execution ~6 min; checkpoint closeout ~4 min)
- **Started:** 2026-07-04T14:05:00+05:00 (approx, first commit 14:11:06+05:00)
- **Completed:** 2026-07-04 (checkpoint resolution)
- **Tasks:** 3/3 (Task 3 resolved via deferral, not re-executed)
- **Files modified:** 21 (12 in Task 1's commit, 9 in Task 2's commit)

## Accomplishments
- Searchable/filterable/sortable/paginated contact list at `/w/:slug/contacts` with semantic subscription-status badges, wired into AppShell nav and the onboarding checklist
- Contact create/edit form with custom-property editor (registry-driven key autocomplete + type-aware value inputs), tag chip editor, and a D-12-safe subscription control that can never re-enable a suppressed contact from the UI
- Tabbed `ContactDetailPage` (Overview / Свойства / События) with a delete `AlertDialog` carrying the exact D-08 compliance copy
- Task 3 (live browser human verification) deferred to phase-level UAT, consistent with `workflow.human_verify_mode: "end-of-phase"` and Phase-1 precedent, unblocking downstream plans 02-06/02-07

## Task Commits

Each task was committed atomically:

1. **Task 1: Install UI deps + contact list page (search/filter/sort/pagination) + route + nav** - `e55cb50` (feat)
2. **Task 2: Contact create/edit form + custom-property editor + tag input + detail page tabs** - `77deb0c` (feat)
3. **Task 3: Human verification of the contact UI against the UI-SPEC** - deferred, no commit (checkpoint resolution documented below)

**Plan metadata:** (this commit) `docs(02-02): complete plan`

## Files Created/Modified
- `apps/web/src/features/contacts/ContactsListPage.tsx` - TanStack-Table contact list: search, status/tag filters, sort, pagination, empty/filtered-empty states
- `apps/web/src/features/contacts/ContactForm.tsx` - RHF+Zod create/edit form, tag chips, D-12-safe subscription radio-group, inline D-07 server-error surfacing
- `apps/web/src/features/contacts/ContactDetailPage.tsx` - Overview/Свойства/События tabs, delete AlertDialog (D-08 copy)
- `apps/web/src/features/contacts/CustomPropertyEditor.tsx` - key/value rows, registry-driven key autocomplete via `<datalist>`, type-aware value inputs
- `apps/web/src/features/contacts/SubscriptionStatusBadge.tsx` - semantic subscribed/unsubscribed/suppressed badge
- `apps/web/src/components/ui/{progress,radio-group,collapsible,textarea,tabs}.tsx` - shadcn primitives (official registry)
- `apps/api/src/modules/contacts/property-registry.ts` - new `listPropertyRegistry()` + `GET /property-registry` route (Rule 2 deviation)
- `apps/api/src/modules/contacts/contacts.routes.ts` - 409 conflict responses now include `code: "email_taken"` (Rule 1 deviation)
- `apps/web/src/lib/api.ts` - added `apiPatch()` helper (Rule 3 deviation)
- `apps/web/src/App.tsx`, `apps/web/src/features/app-shell/AppShell.tsx`, `apps/web/src/features/onboarding/OnboardingChecklist.tsx` - route, nav link, onboarding item wiring
- `packages/shared-schemas/src/contact.ts` - schema additions supporting the new property-registry endpoint

## Decisions Made
- Task 3 (human verification) deferred to phase-level UAT — see key-decisions in frontmatter for full rationale. This mirrors the standing project pattern from Phase 1 (01-03/01-04/01-05 deferrals), now also codified in `.planning/config.json` as `workflow.human_verify_mode: "end-of-phase"`.
- Live verification is additionally blocked in this environment: `.env` lacks `REDIS_URL` and `.env*` paths are hard-denied to agent tooling (`Read`/`Write`) — the user must add `REDIS_URL=redis://localhost:6379` manually before `npm run dev` can boot the stack for browser verification (tracked already in STATE.md Blockers/Concerns from 02-05).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added property-registry read endpoint**
- **Found during:** Task 2 (custom-property editor)
- **Issue:** The custom-property key autocomplete had no data source — 02-01 never exposed a read endpoint for the property registry, so the D-10/D-19 autocomplete requirement was unimplementable as scoped.
- **Fix:** Added `listPropertyRegistry()` repository read + `GET /api/workspaces/:slug/property-registry` route.
- **Files modified:** `apps/api/src/modules/contacts/property-registry.ts` (new)
- **Verification:** `npm run build -w apps/web` clean; autocomplete wired to the new endpoint.
- **Committed in:** `77deb0c` (Task 2 commit)

**2. [Rule 1 - Bug] 409 contact-conflict responses now carry a machine-readable `code`**
- **Found during:** Task 2 (inline D-07 error copy)
- **Issue:** The API's 409 response only had an English message; the frontend needed to render the exact Russian D-07 copy («Этот email уже используется другим контактом…»), which required a stable machine-readable discriminator, not string-matching the English message.
- **Fix:** Added `code: "email_taken"` to the 409 response body.
- **Files modified:** `apps/api/src/modules/contacts/contacts.routes.ts`
- **Verification:** `npm run build -w apps/web` clean; ContactForm branches on `code` to render the D-07 copy.
- **Committed in:** `77deb0c` (Task 2 commit)

**3. [Rule 3 - Blocking] Added `apiPatch()` helper**
- **Found during:** Task 2 (contact edit mutation)
- **Issue:** `apps/web/src/lib/api.ts` had no PATCH helper; contact edit needed one to call the update endpoint.
- **Fix:** Added `apiPatch()` alongside the existing `apiGet`/`apiPost`/`apiDelete`.
- **Files modified:** `apps/web/src/lib/api.ts`
- **Verification:** `npm run build -w apps/web` clean; edit mutation uses `apiPatch()`.
- **Committed in:** `77deb0c` (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 missing critical, 1 bug, 1 blocking)
**Impact on plan:** All three deviations were necessary to deliver the plan's stated must-haves (property autocomplete, exact D-07 copy, working edit mutation). No scope creep.

## Issues Encountered
None beyond the deviations above.

## Outstanding UAT Items (deferred from Task 3, to be folded into phase-level UAT)

The following manual browser checks from the plan's Task 3 `how-to-verify` remain outstanding and must be run once `REDIS_URL` is configured and `npm run dev` can boot the full stack:

1. Create a contact with an email, a tag, and one custom property — confirm toast «Контакт создан» and list appearance.
2. Search by email and by name; apply the status filter and a tag filter; sort a column; page forward/back — confirm each behaves and the filtered-empty copy shows when nothing matches.
3. Open a contact; add another custom property (confirm the key autocompletes from prior properties via the native datalist); change the tag set; save — confirm «Контакт обновлён».
4. Attempt to create a second contact with the same email — confirm the inline «Этот email уже используется другим контактом…» copy (D-07).
5. Confirm a contact with a set `external_id` shows it read-only with the D-06 helper text.
6. For a suppressed contact, confirm the subscription control is not clickable and shows the D-12 tooltip; confirm subscribed↔unsubscribed toggling works for a normal contact.
7. Delete a contact — confirm the AlertDialog shows the D-08 compliance copy and that deletion works.
8. Confirm badge colors (subscribed=green, unsubscribed=neutral, suppressed=red), spacing, typography and Russian copy match the Phase 2 UI-SPEC.
9. Confirm role-gated hiding (not just disabling) of contact-management/delete actions for roles lacking permission, per the plan's prohibitions section.

## User Setup Required

None from this plan directly, but the pre-existing blocker from 02-05 still applies: `.env`/`.env.example` need `REDIS_URL=redis://localhost:6379` added manually before `npm run dev` boots the full stack for the outstanding UAT items above.

## Next Phase Readiness
- The contacts feature directory (`apps/web/src/features/contacts/`) is ready for 02-06 (event feed populates the События tab) and 02-07 (CSV import reuses this directory).
- 9 manual UAT checks carried forward to phase-level UAT (to be executed alongside the other deferred Phase 2 checkpoints, if any, once the environment blocker is resolved).

---
*Phase: 02-contacts-event-ingestion*
*Completed: 2026-07-04*
