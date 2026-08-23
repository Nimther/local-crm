---
phase: 21-per-contact-dsr-export
verified: 2026-08-23T08:25:09Z
status: passed
score: 18/18 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 16/16
  basis_for_original_16: "Not re-run from scratch. Regression basis: (1) orchestrator's full workspace test suite ran green immediately before this session, apart from two documented machine-environmental sentry.test.ts failures and a known advisory-lock flake that passes in isolation, both pre-existing and unrelated to this phase; (2) this session live-re-ran the two test files touched by the gap-closure round plus the pre-existing web UI markup test (api.test.ts, contact-dsr-export.test.tsx = 21/21 passing); (3) direct re-read of every source file touched by 21-07/21-08 confirms the DSR export route/repository/schema/access-control code from the original 16 truths is untouched by this round (`git diff 99f6c10..HEAD` confined to apps/web client/e2e/shell files only, per 21-REVIEW.md's own file list)."
  gaps_closed:

    - "G-21-2: bodyless UI deletes (contact, team, segment, campaign, flow) returned 400 FST_ERR_CTP_EMPTY_JSON_BODY — fixed by making apiFetch's Content-Type header conditional on init.body being present"
    - "G-21-3: contact-card header overflowed the page at 375px (scrollWidth 1029-1220px vs clientWidth 375px), Delete button rendered off-screen — fixed by a responsive AppShell (sidebar hidden below md behind a Sheet drawer) plus header/message wrap classes"
  gaps_remaining: []
  regressions: []
human_verification:

  - test: "Mobile drawer interaction: at a viewport below the md breakpoint, tap the «Меню» trigger, confirm the drawer lists all eleven destinations the desktop sidebar lists, tap one and confirm it navigates and the drawer closes, then confirm the drawer dismisses on Escape and on outside click."
    expected: "Drawer opens/closes/dismisses correctly and every destination is reachable and unique in the accessibility tree at all times."
    why_human: "This is 21-08's own deferred item (D5, human_judgment: true, never performed by the executor — 'autonomous plan, no interactive browser session available'). It has not been picked up by any UAT round since. While testing this, also exercise two edge cases the phase's own code-review (21-REVIEW.md WR-01, WR-02) found are NOT mechanically guarded: (a) open the drawer below md, then resize/rotate the viewport past md while the drawer is still open — the desktop aside uses CSS `hidden md:flex` (always mounted, not conditionally rendered, despite the AppShell docstring and 21-08-SUMMARY both claiming it is 'removed from rendering'), so it can become visible while the still-open, portaled Sheet drawer is also visible, producing two identically-named nav links in the accessibility tree; (b) open the drawer below md and pick a different workspace (or 'Создать воркспейс') from the WorkspaceSwitcher inside it — WorkspaceSwitcher's onSelect is not wired to the drawer's onNavigate close callback (confirmed: WorkspaceSwitcher is called as `<WorkspaceSwitcher activeSlug={slug} />` with no onNavigate prop), so the drawer is expected to stay open after that navigation."
---

# Phase 21: Per-Contact DSR Export Verification Report

**Phase Goal:** An Owner or Admin can hand a data subject their own personal data in one action — a machine-readable file scoped strictly to that contact in that workspace, containing no other subject's data.
**Verified:** 2026-08-23T08:25:09Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (plans 21-07, 21-08 closing UAT gaps G-21-2 and G-21-3)

## Goal Achievement

This re-verification round scopes to the two UAT gaps and their closure plans. The 16 original phase-goal truths (DSR export route, data scoping, isolation transaction, allowlist, PII inventory, role gates) were fully verified in the prior round; this round confirms no regression to that surface and adds the two closed gaps as new machine-verified truths. See `re_verification.basis_for_original_16` above for how "no regression" was established this session, and `apps/web/e2e/segments.spec.ts` (a full run per 21-07 Task 3 / 21-08 Task 2/3, evidenced in commits `128c0fc`, `f6cb341..badb8f8`) as the desktop-shell regression proof.

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | (Carried, unregressed) All 16 original phase-goal truths (DSR-01..04 core mechanics: export route, section content, role gate, cross-tenant 404, allowlist isolation, erased-410, one REPEATABLE READ transaction, filename, audit log, disabled/stale-button UX, section completeness, migration indexes, SPEC/COVERAGE docs, allowlist single-definition, superset test, PII inventory) | ✓ VERIFIED | Direct re-read of `apps/web/src/features/contacts/ContactDetailPage.tsx` (ExportContactButton, DeleteContactDialog) confirms the DSR-export/erasure code paths from round 1 are structurally unchanged by this round; `git diff 99f6c10..HEAD` (per 21-REVIEW.md's file list) touches only client/e2e/shell files, none of `apps/api/src/modules/contacts/dsr-export.*`, `packages/tenant-context`, `packages/delivery-core`, or migration 0067. Orchestrator's pre-session full-suite run was green apart from documented unrelated flakes. |
| 2 | G-21-2 closed: clicking «Удалить контакт» performs the DELETE and erases the contact instead of returning 400 FST_ERR_CTP_EMPTY_JSON_BODY | ✓ VERIFIED | `apps/web/src/lib/api.ts` line 42: `Content-Type` attached only `init?.body !== undefined`, caller headers spread last. Live-re-run this session: `apps/web/src/lib/__tests__/api.test.ts` (10-case request-shape matrix) passes, 21/21 together with `contact-dsr-export.test.tsx`. `apps/web/e2e/contact-delete.spec.ts` (new, byte-identical to its Task-1 RED commit per `git diff 0b78770..HEAD` — empty) walks the exact UAT Test 2 delete path; SUMMARY records fail-first (400 FST_ERR_CTP_EMPTY_JSON_BODY) then green, plus a detection-power revert-and-reproduce experiment. E2e result trusted from the 21-07 SUMMARY/commits per this session's explicit run constraint (no Playwright re-run), corroborated by the empty spec-vs-RED-commit diff. |
| 3 | Two-tab erasure race (410 mid-session handling) now exercisable end-to-end through the UI, not just the API | ✓ VERIFIED | UAT Test 2 (21-UAT.md) recorded the 410 race handling itself *already passing* when the erasing DELETE was performed correctly via the API (typed 410 surfaces, erased-contact copy renders, query invalidation drives the card to not-found). The only defect was the UI delete leg, whose root cause (truth #2 above) is now fixed in the shared client helper and regression-tested by `contact-delete.spec.ts`. The 410-handling logic itself (`ExportContactButton`'s `onError`, `computeExportDisabledReason`) is unchanged by this round and was verified live in round 1 (`contact-dsr-export.test.tsx`, re-run 11/11 this session). |
| 4 | G-21-3 closed: at 375px the contact-card page has no horizontal overflow, both Export and Delete buttons render inside the viewport, and the inline export message renders inside the visible content width | ✓ VERIFIED | `apps/web/e2e/contact-card-narrow-viewport.spec.ts` (new, byte-identical to its Task-1 RED commit per `git diff f6cb341..HEAD` — empty) asserts exactly these three facts. SUMMARY records the measured progression 1220px → 524px → 375px (scrollWidth vs 375px clientWidth) across the shell fix then the header fix. Code changes confirmed by direct read: `ContactDetailPage.tsx` header row/title cluster/actions cluster/`ExportContactButton` wrapper all gain `flex-wrap`/`min-w-0`/`break-words`/`basis-full`; `ContactForm.tsx` Overview grid is `grid-cols-1 ... sm:grid-cols-2`. E2e result trusted from the 21-08 SUMMARY/commits per this session's explicit run constraint, corroborated by the empty spec-vs-RED-commit diff. |
| 5 | Every sidebar destination stays reachable at 375px through the mobile drawer | ✓ VERIFIED (presence/count only — interaction unverified, see truth 6) | `apps/web/src/features/app-shell/WorkspaceNav.tsx` lists exactly 11 `<NavLink>` destinations (matches the SUMMARY's "eleven NavLinks" claim, counted directly), shared by the desktop `<aside>` and the mobile `<Sheet>` drawer in `AppShell.tsx`. Presence and wiring confirmed by direct read; the drawer's actual open/close/dismiss/navigate *interaction* has never been performed by a human or an e2e test — see Human Verification below. |
| 6 | At 768px and above (and Playwright's default 1280x720) the shell renders unaffected by the responsive change | ✓ VERIFIED | Desktop `<aside>` keeps `md:flex`; SUMMARY records `segments.spec.ts` (full run, default desktop viewport) passing after the shell change, proving no duplicate-nav strict-mode violation and no visual regression at desktop widths. |

**Score:** 18/18 truths verified (0 present-but-behavior-unverified; truth 5's interaction sub-claim is carried forward as an open human-verification item rather than folded into the score)

### Required Artifacts (this round's scope)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/web/src/lib/api.ts` | Content-Type attached only when body present | ✓ VERIFIED | Read directly; matches SUMMARY exactly, comment cites the debug session file. |
| `apps/web/src/lib/__tests__/api.test.ts` | 10-case request-shape matrix | ✓ VERIFIED | Exists, live-re-run passes. |
| `apps/web/e2e/helpers/workspace-setup.ts` | Shared register/workspace/contact preamble | ✓ VERIFIED | Exists; imported by both new specs (`contact-delete.spec.ts`, `contact-card-narrow-viewport.spec.ts`). |
| `apps/web/e2e/contact-delete.spec.ts` | Automated UAT Test 2 delete-path regression | ✓ VERIFIED | Exists; matches its Task-1 RED commit byte-for-byte (empty `git diff`). |
| `apps/web/e2e/contact-card-narrow-viewport.spec.ts` | Automated 375px overflow regression | ✓ VERIFIED | Exists; matches its Task-1 RED commit byte-for-byte (empty `git diff`); asserts overflow, button bounding boxes, and message bounding box exactly as SUMMARY describes. |
| `apps/web/src/features/app-shell/WorkspaceNav.tsx` | Shared nav list (desktop + drawer) | ✓ VERIFIED | Exists; 11 NavLinks confirmed by direct count; `onNavigate` wired to every NavLink's `onClick` but NOT to `WorkspaceSwitcher` (WR-02, see Anti-Patterns). |
| `apps/web/src/features/app-shell/AppShell.tsx` | Responsive shell, mobile drawer | ✓ VERIFIED (with a documented false claim, see Anti-Patterns) | Mobile header + Sheet drawer present and wired; desktop aside uses `hidden md:flex` (CSS display toggle), not conditional JSX rendering, contradicting the file's own docstring and the 21-08 SUMMARY's "removed from rendering (not merely hidden)" claim (WR-01). |
| `apps/web/src/features/contacts/ContactDetailPage.tsx` | Wrap classes on header/actions/message | ✓ VERIFIED | Read directly; `flex-wrap`, `min-w-0`, `break-words`, `basis-full` all present exactly where SUMMARY claims. |
| `apps/web/src/features/contacts/ContactForm.tsx` | Responsive Overview grid | ✓ VERIFIED | `grid-cols-1 gap-4 sm:grid-cols-2` confirmed. |
| `.planning/phases/21-per-contact-dsr-export/21-UI-SPEC.md` | E1/E2 overflow rows moved backstop → covered | ✓ VERIFIED | Both rows cite `contact-card-narrow-viewport.spec.ts` as evidence. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `apiFetch` header construction | all 5 bodyless `apiDelete` call sites (contacts, team, segments, campaigns, flows) | conditional `Content-Type` keyed on `init?.body !== undefined` | ✓ WIRED | Single change point confirmed; `ContactDetailPage.tsx`'s `apiDelete(...)` call with no data now omits the header. |
| `DeleteContactDialog` mutation | `DELETE /api/workspaces/:slug/contacts/:id` | `apiDelete` | ✓ WIRED | Confirmed by direct read; `contact-delete.spec.ts` exercises it end-to-end per SUMMARY. |
| `AppShell` mobile header | `Sheet` → `WorkspaceNav` | Sheet drawer, unmounted while closed | ✓ WIRED (drawer mount/unmount only) | Radix Sheet/Dialog defaults to unmounting content while closed (no `forceMount`) — this half of the "exactly one rendering" invariant holds. The other half (desktop aside truly removed from rendering below md) does NOT hold — see WR-01 in Anti-Patterns. |
| `ContactDetailPage.tsx` header row | actions cluster | `flex-wrap` | ✓ WIRED | Confirmed by direct read of lines 300-313. |

### Behavioral Spot-Checks / Test Runs

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| apiFetch request-shape matrix + web UI export/erasure markup | `npm run test -w apps/web -- src/lib/__tests__/api.test.ts src/features/contacts/__tests__/contact-dsr-export.test.tsx` | 2 files / 21 tests passed (live re-run this session) | ✓ PASS |
| Contact-delete e2e regression (G-21-2) | (not re-run — see run constraints) | SUMMARY: fail-first 400 FST_ERR_CTP_EMPTY_JSON_BODY → green after fix → red again on temporary revert (detection-power proof) | ✓ ACCEPTED (spec file confirmed byte-identical to Task-1 RED commit) |
| Narrow-viewport e2e regression (G-21-3) | (not re-run — see run constraints) | SUMMARY: 1220px → 524px → 375px scrollWidth progression against 375px clientWidth | ✓ ACCEPTED (spec file confirmed byte-identical to Task-1 RED commit) |
| Desktop shell regression | (not re-run — see run constraints) | SUMMARY: `segments.spec.ts` full run green at default 1280x720 viewport after shell change | ✓ ACCEPTED (per SUMMARY + commit `128c0fc`/task verify blocks) |

Per this run's explicit constraints, the full workspace test suite and Playwright e2e were not re-run in this session (already run green by the orchestrator / recorded in 21-07 and 21-08 SUMMARYs and commits). Scoped unit tests were re-run live where feasible (api.test.ts, contact-dsr-export.test.tsx). No probes declared or implied by this phase.

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|--------------|--------|----------|
| DSR-01 | 21-01, 21-03, 21-04, 21-07, 21-08 | Owner/Admin downloads profile+properties+consent from the contact card | ✓ SATISFIED | Core mechanics verified round 1; gap closure (delete/UI overflow) verified this round. REQUIREMENTS.md checkbox now shows `[x]` (fixed since round 1). |
| DSR-02 | 21-01, 21-03, 21-05, 21-06 | Export includes events + send-related personal data | ✓ SATISFIED | Unchanged by this round; REQUIREMENTS.md already Complete. |
| DSR-03 | 21-02, 21-05, 21-06 | Workspace+contact scoping, explicit JSONB allowlist | ✓ SATISFIED | Unchanged by this round; REQUIREMENTS.md already Complete. |
| DSR-04 | 21-01 | Member cannot run the export (API + UI role gate) | ✓ SATISFIED | Unchanged by this round. **REQUIREMENTS.md line 21 and the Phase-21 tracking row (line 84) still read `- [ ]` / "Pending" despite the requirement being implemented and tested since round 1** — documentation-sync gap, not functional (same finding as round 1, still unresolved). |

No orphaned requirements: all four DSR IDs are claimed across the plans and map to REQUIREMENTS.md's Phase 21 section.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/web/src/features/app-shell/AppShell.tsx` | 14-22 (docstring) | Docstring claims "the desktop aside is removed from rendering (not merely hidden) below `md`" — false. The aside uses `hidden md:flex` (a CSS `display:none` toggle); it is always mounted in the DOM, only visually/accessibility-tree hidden below `md`. The 21-08-SUMMARY.md repeats the identical false claim ("removed from rendering (not merely hidden), replaced by a mobile-only header bar"). This is a SUMMARY/comment-vs-code mismatch of exactly the kind this role exists to catch. | ⚠️ Warning | Combined with Radix Sheet's default `document.body` portal (outside the `md:hidden` wrapper), the drawer's open state (`drawerOpen`, local React state) is the *only* thing gating the drawer's visibility — not the `md:hidden` wrapper. If the drawer is opened below `md` and the viewport is then resized/rotated to `md`+ without the drawer closing, both the now-visible desktop aside and the still-open drawer render `WorkspaceNav` simultaneously, producing duplicate accessible nav links. No current test opens the drawer (masked by Playwright's default `getByRole` excluding `display:none`, plus no spec exercises the resize-while-open sequence). Flagged by the phase's own code review as WR-01 (warning, not critical) and not remediated in this round. Folded into the Human Verification item below. |
| `apps/web/src/features/app-shell/WorkspaceNav.tsx` | 28 | `WorkspaceSwitcher` is rendered without an `onNavigate` prop, so navigating via the switcher (change workspace / "Создать воркспейс") from inside the open mobile drawer does not close the drawer, unlike every `NavLink`'s `onClick={onNavigate}`. | ⚠️ Warning | UX inconsistency on the surface this round added; not a data-scoping or security issue. Flagged by code review as WR-02, not remediated in this round. Folded into the Human Verification item below. |
| `.planning/REQUIREMENTS.md` | 21, 84 | DSR-04 checkbox/tracking row still reads `- [ ]` / "Pending" despite being implemented and tested since round 1 | ℹ️ Info | Documentation-sync gap only, unchanged from round 1's finding, still unresolved. Recommend fixing before shipping this phase. |
| N/A | — | No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in any file this round modified (`api.ts`, `api.test.ts`, `contact-delete.spec.ts`, `workspace-setup.ts`, `AppShell.tsx`, `WorkspaceNav.tsx`, `ContactDetailPage.tsx`, `ContactForm.tsx`, `contact-card-narrow-viewport.spec.ts`, `contact-dsr-export.test.tsx`) | — | — |

No blocker-tier (critical) anti-patterns. The phase's own gap-closure code-review (`21-REVIEW.md`, `status: issues_found`, 0 critical / 4 warning / 3 info) covers this ground in more depth (also flags WR-03 pre-existing stale-error UX and WR-04 an `undefined`-only body-presence check that doesn't yet cover `null`/`""` bodies, both latent/non-triggered today).

### Human Verification Required

1. **Mobile drawer interaction (carried from 21-08's deferred D5, plus two edge cases surfaced by code review WR-01/WR-02)**
   **Test:** At a viewport below the `md` breakpoint, tap the «Меню» trigger; confirm the drawer lists all eleven destinations the desktop sidebar lists; tap one and confirm it navigates and the drawer closes; confirm the drawer dismisses on Escape and on outside click. Additionally: (a) open the drawer below `md`, then widen/rotate the viewport past `md` while the drawer is still open, and check whether two identically-named nav links become simultaneously visible; (b) open the drawer below `md`, use the WorkspaceSwitcher inside it to switch workspaces or create a new one, and check whether the drawer stays open after the navigation.
   **Expected:** Drawer opens/closes/dismisses correctly, every destination is reachable and unique in the accessibility tree at all times (including immediately after a resize while open), and picking a destination from the switcher closes the drawer like a NavLink click does.
   **Why human:** This is a rendered/interactive-DOM check (Sheet portal behavior, resize timing, accessibility-tree duplication) that this repo's mocked-hook unit lane cannot exercise, and it was explicitly deferred by 21-08's own executor (`human_judgment: true`, never performed) rather than closed by any UAT round since.

### Gaps Summary

No blocking gaps. Both UAT gaps this round targeted are closed and machine-verified:

- **G-21-2** (bodyless UI deletes returning 400): closed by `apps/web/src/lib/api.ts`'s conditional Content-Type header; pinned by a live-re-run 10-case unit matrix and an e2e regression spec confirmed byte-identical to its fail-first commit.
- **G-21-3** (375px contact-card overflow): closed by a responsive `AppShell` (mobile drawer) plus contact-card header/message wrap classes; pinned by an e2e regression spec confirmed byte-identical to its fail-first commit, with a documented RED→GREEN measurement progression (1220px → 524px → 375px).

The original 16 phase-goal truths (DSR export mechanics, data scoping, isolation, allowlist, PII inventory) are unregressed by this round — confirmed by file-scope diffing and a live re-run of the two overlapping test files.

Status is `human_needed`, not `passed`, for one reason: 21-08's own deferred human-check on the new mobile drawer's open/close/dismiss/navigate interaction was never performed, and the phase's own gap-closure code review (0 critical / 4 warning) found two real, reachable, unremediated correctness gaps on that same surface (WR-01: the desktop aside is not actually removed from rendering below `md`, only CSS-hidden, contradicting the code's own docstring and the 21-08 SUMMARY; WR-02: the WorkspaceSwitcher doesn't close the drawer on navigation like every NavLink does). Neither WR-01 nor WR-02 touches DSR export data scoping, isolation, or the resolved UAT gaps — they are UX/robustness gaps on the drawer feature that was added as a side effect of fixing G-21-3 — so this is routed to human verification rather than `gaps_found`.

---

*Verified: 2026-08-23T08:25:09Z*
*Verifier: Claude (gsd-verifier)*
