---
phase: 06-flows-triggered-chains
verified: 2026-07-13T17:04:57Z
status: passed
score: 13/15 must-haves verified
behavior_unverified: 2
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 4/4
  gaps_closed:

    - "UAT Test 10 (server half): a CSV import can carry a marketer-chosen default IANA timezone that is applied server-side, validated, and threaded from dry-run through to the apply worker (06-22)."
    - "UAT Test 10 (client half): the CSV column-mapping surface now renders the constrained TimezoneCombobox as a per-import default-timezone control, and its selection is threaded into the dry-run request (06-23) — code-level fix confirmed; live render still needs a human UAT re-walk (see Human Verification)."
    - "UAT Test 11 (state-derivation half): an offline-paused autosave (isPending:true, isPaused:true, isError:false) now derives the honest 'error' state instead of an indefinite «Сохранение…» (06-24) — pinned by a passing unit test I ran myself."
  gaps_remaining: []
  regressions: []
deferred: []
behavior_unverified_items:

  - truth: "The CSV import mapping step visibly renders a constrained IANA timezone combobox («Часовой пояс по умолчанию») that a marketer can see and use — the user-facing half of UAT Test 10."
    test: "Open /w/{slug}/contacts/import, upload a CSV, reach the column-mapping step."
    expected: "A labelled «Часовой пояс по умолчанию» combobox is visible near the duplicate-policy control, opens a searchable list of real IANA zones, and can be cleared."
    why_human: "The web unit-test lane is node-only (no jsdom/@testing-library) per project convention, so JSX render output cannot be asserted by an automated test in this repo — only source wiring (import, prop threading, conditional POST body) was confirmed by direct code read and a clean tsc+vite build."

  - truth: "When connectivity is restored after an offline-paused autosave, TanStack Query's automatic resume re-fires the draft PATCH with no further user edit, and the toolbar returns to «Сохранено» (the reconnect half of UAT Test 11)."
    test: "With the flow canvas open, go offline in devtools and make an edit (toolbar should show «Не сохранено — повтор…»); restore connectivity."
    expected: "The paused mutation automatically resumes, the PATCH re-fires, and the toolbar settles to «Сохранено» without the user making another edit."
    why_human: "This is a state-transition (paused → resumed → success) that depends on TanStack Query's runtime `onlineManager`/resume-paused-mutations behavior and real browser online/offline events; no test in this repo (unit or e2e/Playwright) exercises the resume path — only the paused→'error' half is unit-tested. No automated evidence exists either way for this half, so it is left present-but-unverified rather than claimed VERIFIED on code presence alone."
human_verification:

  - test: "UAT Test 10 re-walk: open /w/{slug}/contacts/import, upload a CSV, reach the column-mapping step."
    expected: "A «Часовой пояс по умолчанию» combobox is visible, searchable, lists real IANA zones (via Intl.supportedValuesOf), can be cleared, and choosing a zone is reflected in the dry-run result (rows without their own timezone get the chosen default)."
    why_human: "Visual rendering and live dropdown interaction — no jsdom/@testing-library lane exists in this repo to assert render output automatically."

  - test: "UAT Test 11 re-walk: with the flow canvas open, go offline in devtools, make an edit, observe the toolbar, then restore connectivity."
    expected: "Toolbar shows «Не сохранено — повтор…» while offline (never a stuck «Сохранение…» or a false «Сохранено»); on reconnect, the PATCH automatically re-fires and the toolbar returns to «Сохранено» with no further user edit."
    why_human: "The offline→'error' half is unit-tested and passes, but the reconnect/auto-resume half is a live runtime behavior (TanStack `onlineManager`, real browser network events) not exercised by any test in this repo."
---

# Phase 6: Flows — Triggered Chains Verification Report (Re-Verification, Round 4 — Gap Closure)

**Phase Goal:** As a marketer, I want to visually build, publish, and run automated triggered chains that reuse the proven send pipeline, suppression, and frequency cap, so that the right email reaches the right contact at the right time.
**Verified:** 2026-07-13
**Status:** human_needed
**Re-verification:** Yes — round 4, closing 2 gaps found by a live UAT session on 2026-07-13 (Test 10: CSV-mapping timezone combobox missing; Test 11: offline-paused autosave stuck at «Сохранение…»), after round 3's re-verification passed 4/4 roadmap truths on 2026-07-10.

## Goal Achievement

### Observable Truths (Roadmap Success Criteria — carried forward, reconfirmed unaffected)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A user can drag-and-drop a flow on the canvas with trigger, delay/wait, conditional branch, send-email, and explicit exit nodes per branch, then publish it (draft → live → paused). | ✓ VERIFIED | Unaffected by round 4 (06-22/23/24 touch only CSV-import and autosave-derivation code, not the canvas/publish mechanic). Full `apps/web` suite (24/24, up from 22/22 in round 3 due to the 2 new autosave cases) and `apps/api`/`apps/worker` suites (227/227, 95/95) all green, run by me this round. |
| 2 | A contact entering via an event or by joining a segment moves through the flow — respecting delays and branch conditions — and leaves when an exit condition is met. | ✓ VERIFIED | Unaffected by round 4. `apps/worker` full suite (95/95) green. |
| 3 | Re-entry control (once ever / once per N days / every time) and quiet hours are honored: no email is sent inside the quiet window, and it is deferred until the window ends. | ✓ VERIFIED | Unaffected by round 4. Quiet-hours/re-entry logic untouched by 06-22/23/24's file set. |
| 4 | Editing a live flow happens in a draft that only takes effect on publish; contacts already mid-flight continue on the version they entered, with no duplicate or skipped sends. | ✓ VERIFIED | Unaffected by round 4. `apps/api` full suite (227/227) green. |

**Score:** 4/4 roadmap truths verified (carried forward from round 3, reconfirmed via live regression runs this round, not merely inherited from SUMMARY.md).

### Round-4 Gap-Closure Must-Haves (06-22 / 06-23 / 06-24 PLAN frontmatter)

**06-22 — CSV import default timezone, server-side (FLOW-05):**

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A CSV import can carry a marketer-chosen default IANA timezone applied server-side to every imported row NOT already resolving a timezone from a mapped column. | ✓ VERIFIED | `packages/contacts-core/src/csv-mapping.ts:99-101`: `if (input.timezone === undefined && options?.defaultTimezone) { input.timezone = options.defaultTimezone; }` — read directly. `csv_imports.default_timezone` column confirmed present via migration 0035 + journal entry (idx 35) + drizzle schema `packages/db/src/schema/csv-imports.ts:27`. |
| 2 | The default is validated server-side against the real IANA allowlist inside the same shared `applyCsvRowMapping` both dry-run and apply call. | ✓ VERIFIED | `csv-mapping.ts:116`: `if (input.timezone !== undefined && !isValidIanaTimezone(input.timezone))` runs AFTER the default-fill (line 99-101), so a bad default hits the identical validation/error path a bad mapped cell does. `apps/api -- default timezone` unit tests: 8/8 passed (I ran live). |
| 3 | A row that maps a valid timezone column keeps its own value; the default only fills rows lacking one. | ✓ VERIFIED | Same code read (`input.timezone === undefined` guard); confirmed by the "mapped value wins" test case passing. |
| 4 | The default survives dry-run → async apply job (persisted, re-read). | ✓ VERIFIED | `csv-import.repository.ts:169-171` (`saveDryRunResult` UPDATE writes `default_timezone`); `imports-csv.worker.ts:51,93` (SELECT `default_timezone as "defaultTimezone"`, passed into `applyCsvRowMapping`). `apps/worker -- imports-csv` suite: 5/5 passed (I ran live). |

**06-23 — CSV import default-timezone combobox, client-side (FLOW-05):**

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | The CSV mapping step renders the constrained IANA `TimezoneCombobox` (same component as contact form / send settings) as the default-timezone control. | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Source confirmed: `CsvImportWizard.tsx:25` imports `TimezoneCombobox`; `CsvImportWizard.tsx:300-308` renders it inside `MappingStep`'s `CardContent`, labelled «Часовой пояс по умолчанию» with explanatory helper text. `npm run build -w apps/web` (tsc + vite build) passes clean. No jsdom/render-level test exists in this repo to assert the JSX actually paints — routed to human verification (Test 10 re-walk). |
| 2 | Choosing a default includes it in the dry-run request; leaving it unset sends no default. | ✓ VERIFIED | `CsvImportWizard.tsx:222`: `...(defaultTimezone ? { defaultTimezone } : {})` — confirmed by direct read; this is a pure code-path check (conditional spread), not a rendering concern, and the `tsc` build confirms the resulting body typechecks against 06-22's extended `csvDryRunRequestSchema`. |
| 3 | The control is constrained to real IANA zones (no free text); server independently re-validates. | ✓ VERIFIED | `TimezoneCombobox.tsx:15-16`: options sourced live from `Intl.supportedValuesOf("timeZone")`, no free-text `<input>` path exists in the component (`CommandInput` only filters the existing list). Server-side re-validation confirmed under 06-22 truth 2 above. |

**06-24 — Offline-paused autosave honest error state (FLOW-01):**

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A paused-offline save (isPending:true, isPaused:true, isError:false) shows the honest not-saved/retrying state, not a stuck «Сохранение…». | ✓ VERIFIED | `useAutosaveDraft.ts:92`: `if (isPending && isPaused) return "error";` — checked BEFORE the plain `isPending` → `"saving"` branch (line 93). Live-ran `npm test -w apps/web -- autosaveState`: 6/6 passed, including both new paused-offline cases (`isPaused:true, dirty:false` and `dirty:true` → `"error"`). `FlowCanvas.tsx:329` renders `saveState === "error"` as «Не сохранено — повтор…» (pre-existing from 06-21, unchanged). |
| 2 | On reconnect, TanStack's automatic resume re-fires the PATCH and the toolbar returns to «Сохранено» with no further user edit. | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | This is a state-transition (paused → resumed → success → idle) that depends on TanStack Query's runtime `onlineManager` resume behavior. No test (unit, in this repo's node-only web lane, or e2e/Playwright) exercises an actual reconnect. Code inspection confirms no `networkMode` override anywhere in `useUpdateFlowDraft` or `queryClient.ts` (default `'online'` mode, which does auto-resume paused mutations per TanStack v5's documented behavior) — but that is a library-behavior assumption, not a locally-run behavioral proof. Routed to human verification (Test 11 re-walk, reconnect half). |
| 3 | Existing settled states (in-flight online save, settled success, settled error+dirty) are unchanged. | ✓ VERIFIED | Same 6/6 passing run: the 4 pre-existing 06-21 cases (now carrying `isPaused: false`) all still pass with unchanged outcomes. |
| 4 | The paused-input behavior is pinned by a pure-function unit test. | ✓ VERIFIED | `autosaveState.test.ts` contains the two new paused-offline cases (confirmed by direct read); both pass live. |

**Score (this round's 11 gap-closure truths):** 9/11 verified, 2 present-but-behavior-unverified (both routed to human verification, neither FAILED).

**Combined score (roadmap + round-4 truths):** 13/15 verified, 2 behavior-unverified.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/db/migrations/0035_csv_imports_default_timezone.sql` + journal entry | nullable `default_timezone` text column | ✓ VERIFIED | File content confirmed (`ALTER TABLE "csv_imports" ADD COLUMN "default_timezone" text;`); journal `idx: 35, tag: "0035_csv_imports_default_timezone"` present and correctly ordered after idx 34. `npm run build -w packages/db` passes. |
| `packages/db/src/schema/csv-imports.ts` | drizzle `defaultTimezone` column | ✓ VERIFIED | Line 27: `defaultTimezone: text("default_timezone")`, nullable (no `.notNull()`). |
| `packages/shared-schemas/src/csv-import.ts` | optional `defaultTimezone` on `csvDryRunRequestSchema` | ✓ VERIFIED | Line 39: `defaultTimezone: z.string().min(1).nullish()`. `npm run build -w packages/shared-schemas` passes. |
| `packages/contacts-core/src/csv-mapping.ts` | default-aware validated `applyCsvRowMapping` | ✓ VERIFIED | `options?: { defaultTimezone?: string | null }` param (line 69); default-fill (99-101) precedes the existing IANA validation (116). `npm run build -w packages/contacts-core` passes. |
| `apps/api/src/modules/contacts/csv-import.routes.ts` + `.repository.ts` | thread `defaultTimezone` through dry-run summary + persistence | ✓ VERIFIED | Routes read `parsed.data.defaultTimezone`, forward to `computeDryRunSummary` (line 259) and `saveDryRunResult` (267); repository's UPDATE writes `default_timezone` (171) and `CSV_IMPORT_COLUMNS` surfaces it (27). |
| `apps/worker/src/queues/imports-csv.worker.ts` | re-read `default_timezone` at apply time | ✓ VERIFIED | SELECT includes `default_timezone as "defaultTimezone"` (51); passed into `applyCsvRowMapping` (93). |
| `apps/api/.../__tests__/csv-import.test.ts` | pure-function default-timezone regression tests | ✓ VERIFIED | 8 tests match `-t "default timezone"`, all pass live; full file 22/22 passes live. |
| `apps/web/src/features/contacts/CsvImportWizard.tsx` | `MappingStep` renders `TimezoneCombobox`, threads `defaultTimezone` into dry-run POST | ✓ VERIFIED (structurally) / ⚠️ visual render unconfirmed | Source read + clean `tsc`/`vite build`; JSX paint not asserted by any test in this repo (see Human Verification). |
| `apps/web/src/features/flows/canvas/useAutosaveDraft.ts` | `deriveAutosaveState` gains `isPaused` input, mapped to `"error"` before `isPending` | ✓ VERIFIED | Line 92 guard confirmed; hook wires `mutation.isPaused` at the call site (line 182). |
| `apps/web/src/features/flows/canvas/__tests__/autosaveState.test.ts` | paused-offline regression cases | ✓ VERIFIED | 6/6 tests pass live (`npm test -w apps/web -- autosaveState`), including both new paused cases. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| CSV dry-run request body `defaultTimezone` | `csvDryRunRequestSchema` | zod field | ✓ WIRED | `csv-import.ts:39`; typechecked against the wizard's POST body via `tsc`. |
| dry-run route `defaultTimezone` | `computeDryRunSummary` → `applyCsvRowMapping` (preview) | direct param forwarding | ✓ WIRED | `csv-import.routes.ts:106,259` |
| dry-run route `defaultTimezone` | `saveDryRunResult` → `csv_imports.default_timezone` | repository UPDATE | ✓ WIRED | `csv-import.routes.ts:267` → `csv-import.repository.ts:169-171` |
| `csv_imports.default_timezone` | apply worker `applyCsvRowMapping` | SELECT + param passthrough | ✓ WIRED | `imports-csv.worker.ts:51,93` |
| `TimezoneCombobox` (value/onChange) | `MappingStep` `defaultTimezone` state | React prop/state | ✓ WIRED | `CsvImportWizard.tsx:197,306` |
| `MappingStep` `defaultTimezone` state | dry-run POST body | conditional spread | ✓ WIRED | `CsvImportWizard.tsx:222` |
| `useUpdateFlowDraft` mutation `isPaused` | `deriveAutosaveState` | direct call-site arg | ✓ WIRED | `useAutosaveDraft.ts:182` |
| `deriveAutosaveState` `"error"` result | `FlowCanvas.tsx` toolbar text | ternary render | ✓ WIRED (pre-existing from 06-21, unchanged) | `FlowCanvas.tsx:329` |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|--------------|--------|----------|
| FLOW-01 | 01,02,03,04,05,07,08,09,10,11,17,21,24 | Visual canvas builder, 5 node types, publish | ✓ SATISFIED | Core mechanic unaffected; round-4 closes the offline-autosave-honesty half of the FLOW-01 UX contract (06-24), with the reconnect-resume half still awaiting live confirmation. |
| FLOW-02 | 02,06,08,12,18,20 | Trigger by event or segment entry | ✓ SATISFIED | Unaffected by round 4. |
| FLOW-03 | 02,05,08,12,17 | Exit conditions | ✓ SATISFIED | Unaffected by round 4. |
| FLOW-04 | 06,11,19 | Re-entry control | ✓ SATISFIED | Unaffected by round 4. |
| FLOW-05 | 07,11,13,15,22,23 | Quiet hours + (round 4) CSV-import default timezone | ✓ SATISFIED | 06-22/06-23 close the CSV-mapping timezone-dropdown gap: server-side default fully test-covered; client-side render structurally verified, visual confirmation pending (see Human Verification). |
| FLOW-06 | 01,04,05,09,11,14,16 | draft → live → paused state machine | ✓ SATISFIED | Unaffected by round 4. |
| FLOW-07 | 01,03,04,05,09 | Immutable published versions, in-flight pinning | ✓ SATISFIED | Unaffected by round 4. |

No orphaned requirements — all 7 FLOW-0X IDs from REQUIREMENTS.md are claimed across the 24 plans (including round-4's 06-22/23/24), and REQUIREMENTS.md's traceability table marks all 7 "Complete".

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` debt markers found in any of the round-4 files (`CsvImportWizard.tsx`, `useAutosaveDraft.ts`, `autosaveState.test.ts`, `0035_csv_imports_default_timezone.sql`, `csv-imports.ts`, `csv-import.ts`, `csv-mapping.ts`, `csv-import.routes.ts`, `csv-import.repository.ts`, `imports-csv.worker.ts`, `csv-import.test.ts`). One grep hit on `CsvImportWizard.tsx:272` was `placeholder="Название нового свойства"` — a form-input HTML attribute, not a debt marker; not counted.

A fresh code review (`06-REVIEW.md`, re-reviewed after round 4) independently confirms all three round-4 fixes are correct (matches my own direct-source verification) and surfaces non-blocking findings, none of which are round-4 regressions:

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `csv-import.routes.ts` (dry-run/apply) | Neither route checks `csv_imports.status` before acting — a concurrent dry-run on an `applying` import can flip rows the worker already resolved back to `pending`, and 06-22 widened this seam by adding a second piece of persisted dry-run config (`default_timezone`) an in-flight worker won't re-read | ⚠️ Warning | New this round (the CSV routes/worker enter review scope for the first time). Not reachable from the wizard UI; reachable via direct API calls by an authenticated workspace member. Not a round-4 regression — a pre-existing ordering gap the widened seam makes marginally worse. Recommended for future triage. |
| `csv-import.routes.ts` / `csv-mapping.ts` | `defaultTimezone` is unbounded (no `.max()`) and a bad default marks every timezone-less row `error` with reason "Invalid timezone", without indicating the *default* (not the row data) is at fault | ℹ️ Info | Cosmetic/DX issue in the dry-run error report; the fail-closed guarantee (invalid default never stored on a contact) still holds. |
| `useAutosaveDraft.ts` | `deriveAutosaveState` still returns `idle` for up to ~1s of debounce after every edit before an offline pause even engages; the 4s retry-effect comment says "never a hot loop" but a permanently-rejected payload retries indefinitely (safe, but mislabeled) | ⚠️ Warning | Carried forward from round 3, unaffected by 06-24's fix (06-24 correctly closed the paused-offline case specifically; these are pre-existing, narrower edge cases). |

### Behavioral Spot-Checks / Regression Tests (run live by this verifier, not trusted from SUMMARY.md)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| CSV default-timezone mapper unit tests (06-22) | `npm test -w apps/api -- -t "default timezone"` | 8 passed \| 219 skipped | ✓ PASS |
| Full csv-import.test.ts (06-22 regression, run once) | `npm test -w apps/api -- csv-import.test` | 22/22 passed | ✓ PASS |
| Full apply-worker imports-csv suite (06-22 regression, run once) | `npm test -w apps/worker -- imports-csv` | 5/5 passed | ✓ PASS |
| Offline-paused autosave derivation (06-24) | `npm test -w apps/web -- autosaveState` | 6/6 passed (4 preserved + 2 new paused cases) | ✓ PASS |
| apps/web build (06-23 + 06-24 typecheck) | `npm run build -w apps/web` | tsc --noEmit + vite build, exit 0 | ✓ PASS |
| packages/db, shared-schemas, contacts-core, api, worker builds (06-22 typecheck) | `npm run build -w packages/db -w packages/shared-schemas -w packages/contacts-core -w apps/api -w apps/worker` | all exit 0 | ✓ PASS |
| Full apps/api suite (regression check, run once) | `npm test -w apps/api` | 227/227 passed across 41 files | ✓ PASS |
| Full apps/worker suite (regression check, run once) | `npm test -w apps/worker` | 95/95 passed across 19 files | ✓ PASS |
| Full apps/web suite (regression check, run once) | `npm test -w apps/web` | 24/24 passed across 3 files | ✓ PASS |
| Migration 0035 present + registered | `cat` migration file + journal tail | `ALTER TABLE "csv_imports" ADD COLUMN "default_timezone" text;`; journal idx 35 present | ✓ PASS |
| No free-text timezone entry point in TimezoneCombobox | Direct source read of `TimezoneCombobox.tsx` | Options sourced only from `Intl.supportedValuesOf("timeZone")`; `CommandInput` filters, does not add | ✓ PASS |
| Commits cited in 06-22/23/24 SUMMARY.md actually exist | `git log --oneline -1 <hash>` for 07239db, 7cdfba4, ad04d64, 52e2cf1, c4fc048, 3445ae8 | All 6 found in git log with matching messages | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` files exist in this repository and no probes are declared in the phase's PLAN/SUMMARY files. Step 7c: SKIPPED (no probes declared or discovered).

### Human Verification Required

1 and 2 below are the two items that keep this round's status at `human_needed` (both are UAT re-walks explicitly deferred to end-of-phase human_verify per this project's stated convention — `06-23-SUMMARY.md`/`06-24-SUMMARY.md` both flag their client-facing halves as `human_judgment: true`):

### 1. UAT Test 10 re-walk — CSV mapping timezone combobox

**Test:** Open `/w/{slug}/contacts/import`, upload a CSV, reach the column-mapping step.
**Expected:** A labelled «Часовой пояс по умолчанию» combobox is visible near the duplicate-policy control, opens a searchable list of real IANA zones (via `Intl.supportedValuesOf`), can be cleared, and — when a zone is chosen — is reflected in the dry-run preview for rows without their own timezone.
**Why human:** No jsdom/@testing-library render lane exists in this repo (project convention); only source wiring and a clean tsc/vite build were confirmed automatically.

### 2. UAT Test 11 re-walk — offline autosave reconnect

**Test:** With the flow canvas open, go offline in devtools, make an edit, observe the toolbar, then restore connectivity.
**Expected:** Toolbar shows «Не сохранено — повтор…» while offline (confirmed by unit test — this part is code-verified); on reconnect, the PATCH automatically re-fires (TanStack `onlineManager` resume) and the toolbar returns to «Сохранено» with no further user edit.
**Why human:** The offline→'error' derivation is unit-tested and passes; the reconnect/auto-resume half is a live runtime behavior not exercised by any test (unit or e2e) in this repo.

### Gaps Summary

No FAILED must-haves this round — every artifact from 06-22/06-23/06-24 exists, is substantive, is wired end-to-end, and every automatable test (8 new unit tests for the CSV default-timezone mapper, 2 new unit tests for the paused-offline autosave case, plus the full `apps/api`/`apps/worker`/`apps/web` regression suites) passes when run live by this verifier — not merely inherited from SUMMARY.md narrative.

Two items remain **present-but-behavior-unverified** rather than fully VERIFIED, both explicitly flagged as needing human confirmation by their own SUMMARY.md coverage blocks (not something this verifier is inventing):

1. **Test 10's visual half** — the `TimezoneCombobox` is correctly wired into `CsvImportWizard.tsx` (import, state, conditional POST body all confirmed by direct source read + a clean build), but this repo has no render-level test lane, so whether it actually *paints* in a browser has not been machine-verified.
2. **Test 11's reconnect half** — `deriveAutosaveState`'s paused→'error' mapping is unit-tested and passes, but the "automatic retry re-fires the PATCH once connectivity restored" half depends on TanStack Query's live `onlineManager` resume behavior, which no test in this repo exercises.

Neither item is a code gap — both are precisely the kind of visual/live-runtime behavior this project's own convention (no jsdom, no e2e coverage of these two flows) defers to human UAT. **Recommendation:** run the two UAT re-walks above (Tests 10 and 11). If both pass, the phase goal is fully achieved and round 4's gap closure is complete — re-run this verifier (or manually update 06-UAT.md) to flip status to `passed`. If either fails, the underlying derivation/wiring code verified here is NOT the suspect; the failure would point to something outside what static/unit verification can see (e.g., a CSS/z-index issue hiding the popover, a browser-specific `Intl.supportedValuesOf` gap, or a TanStack version/config mismatch in the actual runtime bundle).

---

_Verified: 2026-07-13_
_Verifier: Claude (gsd-verifier)_
