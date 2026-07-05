---
phase: 02-contacts-event-ingestion
verified: 2026-07-05T15:10:00Z
status: human_needed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/5
  gaps_closed:
    - "UAT Test 2 (major, failed): contact list search input lost focus and the page flashed a full-page skeleton on every debounced keystroke — closed by 02-13 (placeholderData: keepPreviousData + results-scoped skeleton + dim refetch cue), proven RED→GREEN by a real Playwright regression, independently re-run and passing."
    - "UAT Test 11 (follow-up-requested): WR-09 dead-pooled-connection-destroy path was proven only by source assertion — closed by 02-14, a fault-injection integration test (pg_terminate_backend mid-transaction) that exercises withTenantTransaction's own catch → ROLLBACK → release(err) branch and proves pool recovery, independently re-run and passing."
  gaps_remaining: []
  regressions: []
behavior_unverified_items: []
human_verification:
  - test: "Re-run UAT Test 2 by hand: open the contact list, click the search field, and type an email one character at a time (with natural pauses). Confirm the field keeps focus the whole time and the caret never jumps out (now backed by a passing automated regression — this is a final human sanity confirmation of the plan's own <human-check> step, not a re-test of unverified behavior)."
    expected: "Input stays focused throughout typing; no page flash; list refreshes in place."
    why_human: "The e2e spec proves focus/value preservation programmatically, but the plan (02-13) explicitly deferred one item to human judgment."
  - test: "Confirm the visual quality of the new dim/opacity refetch cue (isPlaceholderData || isFetching, opacity-50 with a 200ms transition) reads as a clear 'updating' signal and not a jarring or confusing flicker, compared to the old full-page skeleton swap."
    expected: "The dim cue is subtle, does not obscure readability, and clearly communicates an in-flight refetch without a layout jump."
    why_human: "Subjective rendering/visual-design judgment — explicitly flagged as human_judgment: true in 02-13's own SUMMARY (D2), not verifiable via source inspection."
---

# Phase 02: Contacts & Event Ingestion Verification Report (Re-Verification #2)

**Phase Goal:** A marketer can build and maintain their contact base (UI, CSV, API) while their backend streams freeform behavioral events that create and enrich contacts in real time.
**Verified:** 2026-07-05T15:10:00Z
**Status:** human_needed
**Re-verification:** Yes — after UAT-driven gap closure (plans 02-13, 02-14)

## Context

The prior re-verification (2026-07-05T10:20:00Z) found `status: human_needed`, score 5/5 (all ROADMAP success criteria and all 9 requirement IDs verified), with 11 deferred human-verification items. Those items were run through an actual human UAT session (`02-UAT.md`): 9 passed outright, 1 failed (Test 2 — search input focus loss during debounced refetch), 1 came back `follow-up-requested` (Test 11 — WR-09 dead-connection-destroy sign-off declined as source-assertion-only, human requested a real fault-injection test instead).

Two gap-closure plans were executed in response:
- **02-13** — root-caused and fixed the search-focus bug (`ContactsListPage.tsx`: added `placeholderData: keepPreviousData`, moved the loading skeleton out of a page-wide early return into the results region only, added a dim refetch cue) with a RED→GREEN Playwright regression (`contact-search-focus.spec.ts`).
- **02-14** — added a deterministic fault-injection integration test (`withTenantTransaction-dead-connection.test.ts`) that terminates a pooled connection's backend mid-transaction via `pg_terminate_backend`, proving `withTenantTransaction`'s destroy-on-error branch and pool self-healing, converting WR-09 from a source assertion into test-backed proof.

This re-verification independently re-confirms both fixes in the current source and by re-running the actual tests myself (not trusting SUMMARY.md's PASS claims), re-confirms no regressions via a full test-suite run, and re-checks that the 5 ROADMAP success criteria and 9 requirement IDs remain intact.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria) — unaffected by this round, re-confirmed

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A user can create, view, edit, and delete a contact in the UI, including arbitrary custom profile properties. | ✓ VERIFIED | Unaffected by 02-13/02-14. UAT Test 1 (create+tag+property) and Test 3 (edit — remove property, clear field, reload; CR-04 end-to-end) both passed under real human testing (`02-UAT.md`). |
| 2 | A user can upload a CSV, map columns to attributes, preview the result before applying, and receive a report of errors and duplicates. | ✓ VERIFIED | Unaffected. UAT Tests 6, 7, 8 (full wizard flow, error CSV + history, oversized upload rejection) all passed under real human testing. |
| 3 | A tenant's backend can create/update contacts via the Contacts API and post freeform events (name + JSON) with an API key, getting an immediate 2xx while processing happens asynchronously through a queue. | ✓ VERIFIED | Unaffected by this round's UI/test-only changes. Re-confirmed green in the full `apps/api`/`apps/worker` suite run below (events-api, events-ingest-idempotency tests still pass). |
| 4 | An event for an unknown contact automatically creates it via external_id/email upsert, and a later email change still resolves to the same contact. | ✓ VERIFIED | Unaffected. `upsert-priority.test.ts` still passes in the full suite run below. UAT Test 9 (live event feed on contact card) passed under real human testing. |
| 5 | Every contact carries a 3-state subscription status (subscribed / unsubscribed / suppressed). | ✓ VERIFIED | Unaffected. No code touched by 02-13/02-14 relates to subscription status. |

**Score:** 5/5 truths verified (unchanged from prior re-verification — 02-13/02-14 explicitly HARDEN already-satisfied requirements/criteria per their own plan frontmatter, not re-claim them; `requirements: []` in both plans confirmed by direct read).

### Gap-Closure Verification (this round's actual focus)

| # | Item | Plan | Status | Evidence |
|---|------|------|--------|----------|
| 1 | Search input keeps focus while typing; no full-page skeleton unmount on debounced refetch | 02-13 | ✓ VERIFIED | Source read of `apps/web/src/features/contacts/ContactsListPage.tsx` confirms: `import { keepPreviousData, useQuery } from "@tanstack/react-query"` (line 9); `placeholderData: keepPreviousData` on `contactsQuery` (line 99); `isInitialLoad = contactsQuery.isLoading` (line 184) used to scope the skeleton to the results region only (line 257), with the header + search/filter toolbar (lines 192-255) unconditionally rendered above that conditional — never unmountable by a refetch; `isRefetching = contactsQuery.isPlaceholderData \|\| contactsQuery.isFetching` (line 188) drives an `opacity-50` dim cue (line 262) on the results container only, not the input. Independently re-ran `apps/web/e2e/contact-search-focus.spec.ts` myself (not trusting the SUMMARY's claimed result): **1 passed** — types `"maria@example.com"` char-by-char with 350ms pauses (exceeding the 300ms debounce), asserts focus after every character and the full accumulated value at the end. |
| 2 | WR-09 dead-pooled-connection-destroy path proven by fault-injection test, not source assertion | 02-14 | ✓ VERIFIED | Source read of `packages/tenant-context/src/index.ts` (lines 62-95) confirms the exact `catch → ROLLBACK (try/catch) → releaseWithError set on rollback failure → finally client.release(releaseWithError)` structure the test targets. Independently re-ran `apps/api/src/db/__tests__/withTenantTransaction-dead-connection.test.ts` myself: **1 passed** — terminates the backend of a connection `withTenantTransaction` itself checked out via `pg_terminate_backend`, asserts the transaction rejects, confirms the backend is absent from `pg_stat_activity` afterward, and runs 6 sequential recovery transactions confirming none ever receive the destroyed pid. |

### Required Artifacts (delta from prior re-verification)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/web/src/features/contacts/ContactsListPage.tsx` | `placeholderData: keepPreviousData`; toolbar always mounted; skeleton scoped to results region; dim refetch cue | ✓ VERIFIED | All four elements confirmed present at the cited line numbers above. |
| `apps/web/e2e/contact-search-focus.spec.ts` | Playwright regression, char-by-char typing, asserts focus + value preserved across debounced refetches | ✓ VERIFIED | File exists, matches plan's spec exactly (uses `page.keyboard.type`, not `pressSequentially`/`fill`, per its own documented rationale), independently re-run and passing. |
| `apps/api/src/db/__tests__/withTenantTransaction-dead-connection.test.ts` | Fault-injection test: `pg_terminate_backend` mid-transaction, asserts destroy-not-recycle + pool recovery | ✓ VERIFIED | File exists, matches plan's spec exactly, independently re-run and passing. No production file modified — confirmed by `git status` (clean tree) and by reading `packages/tenant-context/src/index.ts` unchanged from the prior re-verification's citation. |

### Key Link Verification (delta)

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `contactsQuery` (`placeholderData: keepPreviousData`) | rendered search `<Input>` | query stays `'success'` on queryKey change → `isLoading` true only on first load → input never behind an unmounting conditional | ✓ WIRED (fixed) | Confirmed by direct source read and by the passing e2e regression, which is the only test in this codebase that actually drives real keystrokes through a real browser against this exact code path. |
| `withTenantTransaction`'s internal `catch → ROLLBACK throws → releaseWithError` | `client.release(releaseWithError)` → node-postgres destroy | pooled connection killed mid-transaction | ✓ WIRED (fixed, now test-proven) | Confirmed by direct source read (unchanged since 02-11) and by the new fault-injection test, which is the first test in this suite to let `withTenantTransaction` own the killed client (the sibling `rls-pooling-chaos.test.ts` only exercises a manually-released client, not this helper's own branch). |

### Behavioral Spot-Checks / Test Runs (independently executed, not trusted from SUMMARY.md)

| Suite | Command | Result | Status |
|-------|---------|--------|--------|
| Targeted fault-injection test | `npm run test -w apps/api -- withTenantTransaction-dead-connection` | 1 file, 1 test passed | ✓ PASS |
| `apps/api` full suite | `npm run test -w apps/api` (18 files) | 110/110 passed | ✓ PASS |
| `apps/worker` full suite | `npm run test -w apps/worker` (3 files) | 14/14 passed | ✓ PASS |
| Targeted Playwright regression | `npm run test:e2e -- contact-search-focus` (from `apps/web`) | 1 test passed (7.7s) | ✓ PASS |
| Full workspace build | `npm run build --workspaces --if-present` | 7/7 packages built clean (tsc --noEmit + vite build for web) | ✓ PASS |

No regressions: 110 (api) + 14 (worker) = 124 tests, up from the prior re-verification's 107+14=121, consistent with the one new fault-injection test added by 02-14 (02-13 added a Playwright e2e spec, which lives outside the vitest count). All previously-passing suites remain green.

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| CONT-01 | Create/view/edit/delete contacts in UI | ✓ SATISFIED | Unaffected by this round; UAT Tests 1/3 passed by a human. |
| CONT-02 | CSV import with mapping/preview/error report | ✓ SATISFIED | Unaffected; UAT Tests 6/7/8 passed by a human. |
| CONT-03 | Contacts CRUD API | ✓ SATISFIED | Unaffected; full API suite green. |
| CONT-04 | external_id/email prioritized upsert | ✓ SATISFIED | Unaffected; `upsert-priority.test.ts` green. Hardened indirectly — WR-09's connection-pool code path (shared by `upsertContactByIdentity` via `withTenantTransaction`) is now test-proven, not just source-asserted. |
| CONT-05 | Arbitrary custom properties | ✓ SATISFIED | Unaffected; UAT Test 3 passed by a human. |
| EVNT-01 | Freeform event API with API key | ✓ SATISFIED | Unaffected; events-api tests green. |
| EVNT-02 | Auto-create contact from event | ✓ SATISFIED | Unaffected; UAT Test 9 passed by a human. |
| EVNT-03 | Fast 2xx, async queue processing | ✓ SATISFIED | Unaffected. Hardened indirectly — WR-09's fault-injection test now proves the shared connection-pool code path this criterion's async worker depends on self-heals under a mid-transaction connection death. |
| SUBS-01 | 3-state subscription status | ✓ SATISFIED | Unaffected. |

**Orphaned requirements check:** Both 02-13 and 02-14 declare `requirements: []` in their PLAN frontmatter, explicitly and correctly — per their own stated rationale (gap-contract rule 5: hardening an already-satisfied requirement is not re-claiming it). REQUIREMENTS.md's traceability table (all 9 IDs, all marked Complete, all mapped to Phase 2) is unchanged and still exactly matches the phase's declared requirement-ID list. No orphaned requirements found.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` debt markers found in any of the three files touched by this round's gap closure (`ContactsListPage.tsx`, `contact-search-focus.spec.ts`, `withTenantTransaction-dead-connection.test.ts`) — confirmed by direct grep. `git status` shows a clean working tree; all gap-closure commits (`0206f7c`, `685d130`, `d94fc07`, `d8eb0b3`, `46fb9b3`) are present in `git log`.

No new Warnings or Info findings surfaced by this round beyond what `02-REVIEW.md` already carried forward from the prior re-verification (7 Warnings / 11 Info, none blocking, none contradicting the 5 verified truths) — this round's changes are narrowly scoped (one client-render fix, one new test file) and introduce no new production code paths beyond the already-reviewed `withTenantTransaction` release branch.

### Human Verification Required

2 items remain, both narrowly scoped to residual human-judgment aspects of the 02-13 fix (see frontmatter `human_verification` for full detail). Both are explicitly called out as `human_judgment: true` in 02-13's own SUMMARY (D2) and its plan's own `<human-check>` verification step — not unverified behavior, but subjective/visual confirmation that automated tests cannot substitute for:
1. A final human sanity re-run of the (now automated-test-backed) focus-preservation behavior.
2. Visual-quality judgment of the new dim/opacity refetch cue versus the old skeleton swap.

All 9 previously-passed UAT items (contact CRUD, filters/sort/pagination minus the now-fixed focus bug, duplicate-email inline error, external_id read-only display, CSV wizard end-to-end, error CSV + history, oversized-upload rejection, live event feed, UI-SPEC visual fidelity) are **not** re-listed here — they were already confirmed passed by a real human tester in `02-UAT.md`, not merely deferred. The WR-09 item is also **not** re-listed — 02-14 converted it from a human-judgment source-assertion sign-off into a fully automated, independently-passing fault-injection test (`human_judgment: false` on both coverage items in 02-14's SUMMARY), closing it outright.

### Gaps Summary

**No gaps remain.** Both UAT-identified issues (Test 2's search-focus failure, Test 11's WR-09 follow-up request) are independently confirmed closed in this re-verification:
- Test 2: fixed by 02-13, proven by a real Playwright regression that I independently re-ran and confirmed passing (not merely trusting the SUMMARY's claimed RED→GREEN result).
- Test 11: fixed by 02-14, proven by a real fault-injection integration test that I independently re-ran and confirmed passing, exercising the exact `withTenantTransaction` release-with-error branch confirmed present in current source.

The full `apps/api` (110/110) and `apps/worker` (14/14) test suites remain green with no regressions, and the full workspace build is clean. All 5 ROADMAP success criteria remain ✓ VERIFIED and all 9 requirement IDs remain SATISFIED with no orphans.

The phase is not `passed` outright because 2 narrowly-scoped human-judgment items remain open (final sanity re-confirmation of the focus fix, and visual-quality judgment of the new dim refetch cue) — both explicitly flagged as `human_judgment: true` by the executing plan itself, not gaps in coverage. These route to `status: human_needed` per the verification decision tree (any open human-verification item takes precedence over `passed`, even with a clean 5/5 score and zero remaining gaps).

---

_Verified: 2026-07-05T15:10:00Z_
_Verifier: Claude (gsd-verifier)_
