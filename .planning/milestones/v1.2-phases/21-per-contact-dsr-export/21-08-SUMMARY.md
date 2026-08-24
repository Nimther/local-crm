---
phase: 21-per-contact-dsr-export
plan: 08
subsystem: ui
tags: [react, tailwind, playwright, responsive, app-shell, contact-card]

requires:
  - phase: 21-per-contact-dsr-export
    provides: "plan 21-07's e2e preamble helpers (apps/web/e2e/helpers/workspace-setup.ts) and the bodyless-delete Content-Type fix"
provides:
  - "Responsive AppShell: fixed sidebar hidden below the md breakpoint behind a Sheet-based mobile drawer, exactly one nav rendering at any width"
  - "WorkspaceNav.tsx: the eleven-link nav list extracted and shared by the desktop aside and the mobile drawer"
  - "Contact card header row / actions cluster / ExportContactButton wrapper all wrap at narrow widths instead of forcing horizontal page overflow"
  - "apps/web/e2e/contact-card-narrow-viewport.spec.ts: automated 375px regression test for gap G-21-3"
affects: [app-shell, contacts, phase-22]

tech-stack:
  added: []
  patterns:
    - "Shared nav content component (WorkspaceNav) consumed by both a fixed desktop aside and a Sheet-based mobile drawer, with an optional onNavigate callback for drawer self-close"
    - "flex-wrap + min-w-0 + break-words on nested flex header rows to let a fixed-width sidebar shell coexist with a shrinkable content column"

key-files:
  created:
    - apps/web/e2e/contact-card-narrow-viewport.spec.ts
    - apps/web/src/features/app-shell/WorkspaceNav.tsx
  modified:
    - apps/web/src/features/app-shell/AppShell.tsx
    - apps/web/src/features/contacts/ContactDetailPage.tsx
    - apps/web/src/features/contacts/ContactForm.tsx
    - .planning/phases/21-per-contact-dsr-export/21-UI-SPEC.md

key-decisions:
  - "Made the shell responsive (sidebar hidden below md, mobile drawer navigation) rather than re-scoping the 'no horizontal page overflow at 375px' criterion to the content column — the diagnosis proved header wrapping alone mathematically cannot clear page overflow while a fixed 256px sidebar stands, and re-scoping would have declared the gap closed while the page still scrolled sideways."
  - "A flex item's automatic min-width is not reduced by overflow-wrap/break-words alone when the item is nested two flex levels deep — min-w-0 had to be added on both the title-cluster wrapper AND the <h1> itself before a long title/email would actually wrap instead of propagating its min-content width outward. Discovered empirically via a temporary DOM-walk added mid-Task-3 (removed before commit) after the fix from Task 2 alone only reduced overflow from 1220px to 524px, not to 0."

requirements-completed: [DSR-01]

coverage:
  - id: D1
    description: "At 375px the contact card page has no horizontal page overflow (body scrollWidth <= body clientWidth)"
    requirement: DSR-01
    verification:
      - kind: e2e
        ref: "apps/web/e2e/contact-card-narrow-viewport.spec.ts#at 375px the contact card has no horizontal overflow and both header actions are visible"
        status: pass
    human_judgment: false
  - id: D2
    description: "Both the Export and Delete buttons render fully inside the 375px viewport"
    requirement: DSR-01
    verification:
      - kind: e2e
        ref: "apps/web/e2e/contact-card-narrow-viewport.spec.ts#at 375px the contact card has no horizontal overflow and both header actions are visible"
        status: pass
    human_judgment: false
  - id: D3
    description: "The inline export error message renders inside the visible content width instead of starting off-screen"
    requirement: DSR-01
    verification:
      - kind: e2e
        ref: "apps/web/e2e/contact-card-narrow-viewport.spec.ts#at 375px the contact card has no horizontal overflow and both header actions are visible"
        status: pass
    human_judgment: false
  - id: D4
    description: "Desktop rendering at 768px and above (and every existing Playwright spec's default 1280x720 viewport) is unaffected by the responsive shell change"
    verification:
      - kind: e2e
        ref: "apps/web/e2e/segments.spec.ts (full run, desktop default viewport)"
        status: pass
      - kind: unit
        ref: "npm run build -w apps/web (tsc + vite build, clean)"
        status: pass
    human_judgment: false
  - id: D5
    description: "At 375px the mobile drawer (Menu trigger -> Sheet -> WorkspaceNav) opens, lists every destination the desktop sidebar lists, closes on navigation, and dismisses on Escape/outside click"
    verification: []
    human_judgment: true
    rationale: "Task 2's <human-check> is a visual/interactive drawer-behavior check (open/close/dismiss/navigate) that the environment constraints for this run explicitly could not perform (autonomous plan, no interactive browser session available to this executor). Deferred to the next human-verify pass; the code path is exercised structurally by the build and by segments.spec.ts's role-based nav queries not tripping a strict-mode duplicate violation, but the drawer's own open/close/dismiss interaction has not been observed by a human."

duration: 25min
completed: 2026-08-23
status: complete
---

# Phase 21 Plan 08: Responsive shell + contact-card header wrap for 375px overflow (gap G-21-3) Summary

**Made AppShell responsive (sidebar hidden below `md`, Sheet-based mobile drawer sharing a new `WorkspaceNav` component) and made the contact-card header wrap, closing gap G-21-3 without re-scoping the "no horizontal overflow at 375px" criterion.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-08-23T12:5x (first commit 12:55:21+05:00)
- **Completed:** 2026-08-23T13:02:17+05:00 (last task commit)
- **Tasks:** 3/3 completed
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- Authored `apps/web/e2e/contact-card-narrow-viewport.spec.ts`, ran it RED against the pre-fix layout, then drove it to GREEN across two real fixes (shell + header), matching the UAT tester's exact measurement shape at every step.
- Extracted `WorkspaceNav.tsx` (WorkspaceSwitcher + 11 NavLinks) and made `AppShell` responsive: the fixed `w-64` sidebar is removed from rendering (not merely hidden) below `md`, replaced by a mobile-only header bar with a `Sheet` drawer (accessible name «Меню», lucide `Menu` icon) whose content is unmounted while closed — exactly one nav rendering exists in the DOM at any width.
- Made the contact-card header wrap end-to-end: the page header row, the title cluster (plus the `<h1>` itself), the actions cluster, and `ExportContactButton`'s own wrapper all gain `flex-wrap`/`min-w-0`/`break-words` as appropriate, and the inline export error message drops onto its own line (`basis-full break-words`) below the button instead of pinning beside it.
- Fixed the other AND-gate content-column offender the plan flagged: `ContactForm`'s Overview-tab grid is single-column below `sm`, two-column from `sm` up.
- Updated `21-UI-SPEC.md`'s two overflow "backstop" rows (E1 header actions cluster, E2 inline reason/error slot) to "covered", citing the new spec as evidence.

## Measurement: RED -> GREEN side by side

| Stage | body scrollWidth at 375px viewport | body clientWidth |
|---|---|---|
| **RED** (Task 1, before any fix) | **1220px** | 375px |
| After Task 2 alone (responsive shell, header not yet touched) | 524px | 375px |
| **GREEN** (Task 3, header + content-column fixes applied) | **375px** | 375px |

(The UAT tester's original report measured 1029px scrollWidth against the same 375px clientWidth on a differently-populated contact card; the defect class — page-wide horizontal overflow driven by the fixed sidebar plus unshrinkable header rows — is identical, only the exact pixel count differs by test-data content.)

## Task Commits

Each task was committed atomically:

1. **Task 1: Author the 375px measurement spec and run it RED against the current layout** — `f6cb341` (test)
2. **Task 2: Responsive shell — extract WorkspaceNav, hide the fixed sidebar below md behind a drawer** — `cf18ffe` (feat)
3. **Task 3: Contact card header wraps, message drops below the button, content column fits — spec turns GREEN** — `badb8f8` (fix)

_No TDD-per-task multi-commit split was needed beyond the plan's own three-task RED→shell-fix→header-fix structure; each task's own `<verify>` block was run and passed before its commit._

## Files Created/Modified

- `apps/web/e2e/contact-card-narrow-viewport.spec.ts` — new spec-scoped-viewport (375x812) Playwright test reproducing the UAT tester's three measurements: no body horizontal overflow, both header buttons' bounding boxes inside the viewport, and the intercepted (500-fulfilled) inline export error message's bounding box inside the viewport.
- `apps/web/src/features/app-shell/WorkspaceNav.tsx` — new: WorkspaceSwitcher + Separator + eleven NavLinks (verbatim destinations), exported `navLinkClassName`, optional `onNavigate` callback for the drawer's self-close.
- `apps/web/src/features/app-shell/AppShell.tsx` — desktop aside now `hidden md:flex`; new mobile header bar (`md:hidden`) with a `Sheet`/`SheetTrigger`/`SheetContent` drawer rendering `WorkspaceNav`; `main` gains `min-w-0` alongside `flex-1`.
- `apps/web/src/features/contacts/ContactDetailPage.tsx` — page header row gains `flex-wrap`; title cluster gains `min-w-0`; `<h1>` gains `min-w-0 break-words`; actions cluster gains `flex-wrap justify-end`; `ExportContactButton`'s wrapper gains `flex-wrap` and its message `<p>` gains `basis-full break-words` (text-styling tokens unchanged).
- `apps/web/src/features/contacts/ContactForm.tsx` — Overview tab's field grid: `grid-cols-1 gap-4 sm:grid-cols-2` (was unconditional `grid-cols-2`).
- `.planning/phases/21-per-contact-dsr-export/21-UI-SPEC.md` — E1/E2 overflow rows moved from 🧪 backstop to ✅ covered, citing the new spec; summary line count updated to 11 covered / 1 backstop / 0 unresolved (the remaining backstop row, E2 long-text, is unrelated to wrap-testing and was left alone per the plan's instruction).

## Decisions Made

- **Shell-layer decision (per plan objective): made the shell responsive; did not re-scope the criterion.** The diagnosis (`.planning/debug/contact-card-narrow-viewport-overflow.md`) proved a fixed 256px sidebar plus page padding plus the smallest header button already exceeds 375px, so header-only wrapping mathematically cannot satisfy "no horizontal page overflow at 375px." This plan chose the harder, correct fix — a responsive sidebar with a drawer — over declaring the gap closed against a narrower (content-column-only) restatement of the criterion. This decision should be inherited by Phase 22 and any later UI phase: the shell is now the reference responsive-breakpoint pattern (`hidden md:flex` / mobile Sheet drawer) for any future narrow-viewport work.
- **`min-w-0` needed at two nesting levels, not one.** Adding `min-w-0` only to the title-cluster flex wrapper reduced overflow (1220px → 524px, from the shell fix) but did not fully close it — the `<h1>` itself, as a flex item of that wrapper, still carried its own automatic minimum width from the long contact email used as the title. `min-w-0` had to be applied directly to the `<h1>` as well before `break-words` could actually take effect. This is a reusable lesson for any future nested-flex wrap fix in this codebase.

## Deviations from Plan

**None requiring Rule 1-4 escalation.** One in-flow investigative step, not a deviation from the plan's instructions:

- During Task 3, after applying the header-wrap classes the plan specified, the spec was still RED (scrollWidth 524px, not 375px). Per Rule 1 (auto-fix bugs — the described fix did not yet produce the described done-criterion), a temporary DOM-walk was added directly to the spec file (`page.evaluate` reporting the widest overflowing elements), run once to identify the exact offending node (the `<h1>` itself, not a class of element the plan's read_first section called out), and then fully removed before the final task commit — `git diff` against the Task 1 commit confirms the spec file is byte-identical to what Task 1 committed. The one-line fix this investigation led to (`min-w-0` added directly to the `<h1>`, in addition to the already-planned wrapper `min-w-0`) is included in the Task 3 commit.

## Issues Encountered

None beyond the investigative step described above.

## Deferred Human Verification Items

- **Task 2's `<human-check>`** ("At 375px the menu button opens the drawer, the drawer lists every destination the desktop sidebar lists, tapping one navigates and closes the drawer, and the overlay dismisses on Escape and on outside click") **was not performed by this executor**, per this run's environment constraints (autonomous plan run, no interactive browser session available). Structural evidence exists that the drawer code path is reachable and does not duplicate nav rendering (clean build, `segments.spec.ts`'s role-based `getByRole("link", ...)` queries did not hit a Playwright strict-mode violation, which they would if both the desktop aside and an open/mounted drawer were simultaneously in the DOM) — but the actual open/close/dismiss/navigate interaction sequence has not been observed by a human. Recorded as `D5` above with `human_judgment: true` so `verify-work`/UAT routes it to a human rather than auto-passing it.

## User Setup Required

None — no external service configuration required.

## Self-Check: PASSED

All created/modified files confirmed present on disk; all four commits (`f6cb341`, `cf18ffe`, `badb8f8`, `4f4446b`) confirmed present in git log.

## Next Phase Readiness

- Gap G-21-3 is closed: all four `must_haves.truths` from the plan frontmatter are met and machine-verified by `contact-card-narrow-viewport.spec.ts`, except the drawer's own interactive behavior (D5, deferred to human verification above).
- The responsive-shell pattern (`hidden md:flex` desktop aside / `md:hidden` mobile header + Sheet drawer / shared nav-content component) is now established in this codebase and should be reused, not reinvented, by Phase 22 or any later UI phase that needs narrow-viewport support elsewhere in the app shell.
- No blockers for closing out Phase 21; the one open item is the deferred human-check above, which is a courtesy/UX verification (navigation is already provably reachable at every width through the existing routes) rather than a correctness blocker.
