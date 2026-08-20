---
status: resolved
trigger: "UAT Test 10 (phase 06): выпадающий список со списком часовых поясов отсутствует"
created: 2026-07-13T16:00:00Z
updated: 2026-07-13T16:15:00Z
symptoms_prefilled: true
goal: find_root_cause_only
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

reasoning_checkpoint:
  hypothesis: "UAT Test 10 promised a constrained IANA timezone combobox on THREE surfaces (contact form, CSV column mapping, workspace send settings). The CSV column-mapping surface never received one — 06-11 only added 'Часовой пояс' as a target-field OPTION in the mapping Select + header guesses — so the user, walking the three promised surfaces, found the surface where no dropdown listing timezones exists and reported it missing. The other two surfaces render TimezoneCombobox unconditionally in the code that was demonstrably running."
  confirming_evidence:
    - "CsvImportWizard.tsx contains NO TimezoneCombobox import and no timezone-value dropdown; only STANDARD_FIELD_OPTIONS entry { value: 'timezone', label: 'Часовой пояс' } (line 44) + header guesses (lines 74-76)"
    - "06-11-SUMMARY key claim says 'TimezoneCombobox wired into ContactForm, CSV mapping, and SendSettingsPage' while its own detail section admits CSV mapping only got 'timezone standard-field option (+ header guesses)' — the claim the UAT truth was built from overstates what shipped"
    - "SendSettingsPage.tsx:177 and ContactForm.tsx:391 render TimezoneCombobox unconditionally; route + nav link exist; files untouched since 06-11 commit 0d9d29d; flows pages from the SAME plan passed UAT tests 2-9 in the same session (rules out stale build); identical Popover+Command pattern (NodeConfigPanel/SegmentBuilder) worked in-session"
  falsification_test: "Ask the user which page they inspected. If they demonstrate the send-settings page (/w/{slug}/settings/sending) with no 'Часовой пояс по умолчанию' control or an empty option list in a modern browser, this hypothesis is wrong (would instead indicate an environment-specific Intl.supportedValuesOf absence — the only unexcluded alternative)."
  fix_rationale: "The fix must close the claim-vs-implementation gap on the CSV surface: either wire the promised constrained timezone UI into the CSV mapping step, or (more sensible for a column-mapping UI where users map columns, not pick values) realign the truth to the implemented contract — server-side row-value IANA validation at dry-run (packages/contacts-core/src/csv-mapping.ts:101 rejects 'Invalid timezone' per row) — and re-verify the two real comboboxes with the user on the correct pages."
  blind_spots: "Cannot observe the user's browser; cannot 100% exclude that the report was made against the send-settings page in a browser lacking Intl.supportedValuesOf (would render the dropdown control but with an empty list). No jsdom/@testing-library installed, so no DOM-render experiment was possible without modifying the tree."

## Symptoms

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: "Workspace send settings expose a default timezone (IANA combobox) + quiet-hours window (start/end/enabled). The contact form and CSV column mapping expose a constrained IANA timezone combobox; an invalid zone is rejected."
actual: "выпадающий список со списком часовых поясов отсутствует" (the dropdown with the list of timezones is missing)
errors: none reported
reproduction: "Test 10 in .planning/phases/06-flows-triggered-chains/06-UAT.md — user opened the app UI (workspace send settings and/or contact form) and found no timezone dropdown rendered"
started: "Discovered during phase 6 UAT on 2026-07-13; feature claimed complete in plans 06-07 (API/DB) and 06-11 (web UI)"

## Eliminated
<!-- APPEND only - prevents re-investigating -->

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-07-13T16:00:00Z
  checked: knowledge base (.planning/debug/knowledge-base.md)
  found: file does not exist; 9 other active debug sessions, none timezone-related
  implication: no known-pattern shortcut; investigate from scratch

- timestamp: 2026-07-13T16:01:00Z
  checked: grep TimezoneCombobox across apps/web/src
  found: component exists at apps/web/src/features/contacts/TimezoneCombobox.tsx; imported+rendered in ContactForm.tsx (line 391) and SendSettingsPage.tsx (line 177)
  implication: component IS wired into contact form and send settings — "missing" is not a missing-import problem on those two surfaces

- timestamp: 2026-07-13T16:02:00Z
  checked: TimezoneCombobox.tsx implementation
  found: TIMEZONE_OPTIONS is a module-level const = Intl.supportedValuesOf("timeZone") with fallback to [] when the function is absent; options rendered inside shadcn Command/CommandList within a Popover
  implication: if Intl.supportedValuesOf is missing/empty at module-eval time, the combobox renders as a button whose popover lists ZERO timezones — visually "the dropdown with timezones is missing"

- timestamp: 2026-07-13T16:05:00Z
  checked: SendSettingsPage.tsx full read; App.tsx routes; AppShell nav
  found: route settings/sending registered (App.tsx:97) with a sidebar NavLink (AppShell.tsx:51); TimezoneCombobox rendered UNCONDITIONALLY at line 177 after the loading skeleton gate; no canManage/disabled gate on the combobox
  implication: on the send-settings page the combobox button cannot be absent if the current code is what's running

- timestamp: 2026-07-13T16:06:00Z
  checked: ContactForm.tsx lines 225-400
  found: TimezoneCombobox rendered unconditionally at line 391 in the main field grid, present in BOTH CreateContactDialog and ContactDetailPage edit tab
  implication: contact form surface also has the combobox in code

- timestamp: 2026-07-13T16:07:00Z
  checked: CsvImportWizard.tsx timezone handling
  found: only { value: "timezone", label: "Часовой пояс" } in STANDARD_FIELD_OPTIONS (target-field Select) + header guesses timezone/time_zone/tz; NO TimezoneCombobox import, NO timezone-value dropdown anywhere in the mapping step
  implication: the CSV column-mapping surface genuinely has NO dropdown listing timezones — a real gap vs the UAT truth statement

- timestamp: 2026-07-13T16:08:00Z
  checked: 06-11-SUMMARY.md vs 06-UI-SPEC.md
  found: summary key claim says "TimezoneCombobox wired into ContactForm, CSV mapping, and SendSettingsPage" but its own detail section says CSV mapping only got "timezone standard-field option (+ header guesses)"; UI-SPEC line 217/232 lists "Contact form / CSV mapping — extended: popover + command (timezone combobox)"
  implication: 06-11's claim overstates what shipped on the CSV surface; UAT truth was derived from the overstated claim

- timestamp: 2026-07-13T16:09:00Z
  checked: git log --follow on TimezoneCombobox.tsx, SendSettingsPage.tsx, ContactForm.tsx, CsvImportWizard.tsx
  found: all last touched by 0d9d29d (06-11 task 3); no later plan modified or reverted them
  implication: no post-06-11 regression removed the combobox

- timestamp: 2026-07-13T16:10:00Z
  checked: same-session UAT evidence for the Popover+Command pattern
  found: UAT tests 2-9 passed, including canvas node config (NodeConfigPanel uses the same Command/CommandInput/CommandList primitives for segment/template pickers) — flows pages shipped in the SAME plan/commit range as TimezoneCombobox
  implication: (1) the running web app included 06-11 code (flows pages exist), ruling out a stale build older than 06-11; (2) the popover+command combobox pattern demonstrably rendered and worked in the user's browser during this same UAT session

- timestamp: 2026-07-13T16:11:00Z
  checked: module-eval crash / empty-options paths
  found: TIMEZONE_OPTIONS computed at module load; a throw there would break the whole statically-imported bundle (App.tsx imports SendSettingsPage -> TimezoneCombobox), yet all other pages worked; Intl.supportedValuesOf is baseline in all browsers since 2022; even the [] fallback still renders the button + popover ("Ничего не найдено"), i.e. a visible dropdown control
  implication: "renders empty" requires a browser without Intl.supportedValuesOf (implausible for the same browser that ran the flows canvas); "control absent" is impossible on send-settings/contact-form with this code

## Eliminated (appended)

- hypothesis: Stale web build older than 06-11 (combobox code not served)
  evidence: FlowsListPage/FlowDetailPage shipped in the same 06-11 plan and UAT tests 2-9 passed against them in the same session
  timestamp: 2026-07-13T16:10:00Z

- hypothesis: Post-06-11 regression removed/broke the combobox
  evidence: git log --follow shows TimezoneCombobox.tsx/SendSettingsPage.tsx/ContactForm.tsx/CsvImportWizard.tsx untouched since 0d9d29d
  timestamp: 2026-07-13T16:09:00Z

- hypothesis: Combobox conditionally hidden (role gate / loading gate / dialog-only)
  evidence: rendered unconditionally at SendSettingsPage.tsx:177 and ContactForm.tsx:391; no disabled/canManage prop reaches it
  timestamp: 2026-07-13T16:06:00Z

- timestamp: 2026-07-13T16:12:00Z
  checked: apps/api/src/modules/campaigns/send-settings.routes.ts
  found: GET returns getWorkspaceSendSettings (incl. defaultTimezone/quietHours*); PUT validates defaultTimezone via isValidIanaTimezone with code invalid_timezone
  implication: API side of send settings is complete; a GET failure cannot hide the combobox anyway (page renders with defaults after query settles)

- timestamp: 2026-07-13T16:13:00Z
  checked: packages/contacts-core/src/csv-mapping.ts
  found: line 101 — applyCsvRowMapping rejects any mapped timezone value failing isValidIanaTimezone with per-row error "Invalid timezone"
  implication: the CSV surface's "invalid zone is rejected" half of Test 10 IS implemented (server-side, dry-run error report); only the promised UI dropdown is absent

- timestamp: 2026-07-13T16:14:00Z
  checked: web test environment (package-lock, vitest.config)
  found: no jsdom/happy-dom/@testing-library installed; vitest environment "node", only pure-function tests exist
  implication: no component test verified TimezoneCombobox renders options; 06-11's verification was grep-only ("grep 'supportedValuesOf' passes") — a claim-level check, not a render-level check

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: "Claim-vs-implementation gap on the CSV column-mapping surface: UAT Test 10's truth (built from 06-11-SUMMARY's overstated key claim 'TimezoneCombobox wired into ContactForm, CSV mapping, and SendSettingsPage' and 06-UI-SPEC.md:217/232) promises a constrained IANA timezone combobox in CSV column mapping, but CsvImportWizard.tsx never renders one — it only offers 'Часовой пояс' as a target-field option in the column-mapping Select (line 44) with header auto-guesses (lines 74-76). A user walking Test 10's three promised surfaces finds no dropdown listing timezones on that surface. The other two surfaces (SendSettingsPage.tsx:177, ContactForm.tsx:391) render TimezoneCombobox unconditionally in code proven to be running (same-plan flows pages passed UAT tests 2-9 same-session); stale build, regression, conditional rendering, and module-crash paths all eliminated."
fix: ""
verification: ""
files_changed: []

## Closure Note (milestone v1.0 close)

Resolved at v1.0 milestone close on 2026-07-14: diagnosis was handed to plan-phase --gaps; fix shipped via gap-closure plans (see phase 01/04/05/06 gap plans) or recorded as external-env tech debt in v1.0-MILESTONE-AUDIT.md.
