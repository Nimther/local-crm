---
status: complete
phase: 21-per-contact-dsr-export
source: [21-VERIFICATION.md]
started: 2026-08-22T13:45:00Z
updated: 2026-08-23T11:53:17Z
---

## Current Test

[testing complete]

## Tests

### 1. Real blob download of the DSR export in a browser
expected: Click the Export button on a live contact card — a JSON file named dsr-export-{contactId}-{YYYY-MM-DD}.json downloads, opens as valid JSON, filename carries no PII.
result: pass

### 2. Two-tab erasure race (410 mid-session handling)
expected: Open a contact's card in tab A, anonymize/erase that same contact in tab B, then click Export in tab A. Tab A gets the typed 410, the on-screen message flips to the erased-contact copy, and the contact query invalidation drives the card into its not-found/disabled state rather than staying clickable.
result: pass
resolution: "Initially failed (G-21-2, severity major): bodyless UI DELETE sent Content-Type: application/json, Fastify 400 FST_ERR_CTP_EMPTY_JSON_BODY. The 410 race handling itself passed when the user performed the DELETE via API. Gap resolved by plan 21-07 (apiFetch attaches Content-Type only when a body is present); e2e contact-delete.spec.ts reproduced the exact 400 RED then went GREEN; re-verified 2026-08-23 (21-VERIFICATION.md, 18/18). Original report preserved in Gaps G-21-2."

### 3. Narrow-viewport wrap check (UI-SPEC E1/E2 backstop)
expected: At a narrow viewport width, the contact-card header actions row (Export + Delete) wraps onto a new line rather than clipping/overflowing, and the inline reason/error paragraph beside the Export button wraps to multiple lines rather than being cut off.
result: pass
resolution: "Initially failed (G-21-3, severity major): nowrap header/action rows, horizontal overflow 1029px vs 375px viewport, Delete button and inline message off-screen. Gap resolved by plan 21-08 (responsive shell with drawer below md, wrapping header/actions/message rows, min-w-0); e2e contact-card-narrow-viewport.spec.ts measured RED scrollWidth 1220 vs 375, GREEN 375 == 375 after the fix; re-verified 2026-08-23 (21-VERIFICATION.md, 18/18). Follow-up drawer human check passed as Test 4. Original report preserved in Gaps G-21-3."

### 4. Mobile drawer interaction (21-08 deferred human check D5 + review edge cases WR-01/WR-02)
expected: Below md: «Меню» opens the drawer with all eleven sidebar destinations; tapping one navigates and closes the drawer; Escape and outside click dismiss it. Edge cases: resizing past md with the drawer open must not surface two identically-named nav renderings (WR-01); workspace switching from inside the drawer leaves it open (WR-02) — judge acceptability.
result: pass

## Summary

total: 4
passed: 4
issues: 0 (2 found during testing, both resolved by gap-closure plans 21-07/21-08 and re-verified 2026-08-23)
pending: 0
skipped: 0
blocked: 0

## Gaps

- gap_id: G-21-2
  truth: "Erasing/anonymizing a contact via the UI delete action ('Удалить контакт') succeeds, enabling the two-tab erasure race flow end-to-end"
  status: resolved
  resolution: "Closed by plan 21-07 (commits 0b78770/9b7b5fd/0d27c68/128c0fc, 2026-08-23): apiFetch attaches Content-Type: application/json only when the request carries a body; per-verb request-shape matrix in apps/web/src/lib/__tests__/api.test.ts; apps/web/e2e/contact-delete.spec.ts ran RED with the exact 400 FST_ERR_CTP_EMPTY_JSON_BODY, then GREEN after the fix; segments.spec.ts delete step green for the first time. Re-verified 2026-08-23 (21-VERIFICATION.md, 18/18)."
  reason: "User reported: Clicking 'Удалить контакт' sends DELETE with Content-Type: application/json but no body, so Fastify returns 400 FST_ERR_CTP_EMPTY_JSON_BODY and shows the generic error. The 410 race handling itself passes when the DELETE is performed correctly via the API. Root cause: apiFetch always sets Content-Type: application/json, including bodyless apiDelete calls."
  severity: major
  test: 2
  root_cause: "apps/web/src/lib/api.ts:33-36 — apiFetch unconditionally sets Content-Type: application/json on every request, including bodyless ones. apiDelete (api.ts:70-75) omits the body when called without data but inherits the header, so bodyless UI deletes go out as DELETE + JSON content-type + empty payload. Fastify 5.9.0 treats DELETE as body-carrying and, whenever a content-type header is present, runs the JSON parser regardless of content-length; the default parser rejects the empty payload with 400 FST_ERR_CTP_EMPTY_JSON_BODY before the route handler runs. Latent since Phase 01-04 (git show ec888af), NOT a Phase 21 regression — fix scope is the shared helper."
  artifacts:
    - path: "apps/web/src/lib/api.ts"
      issue: "lines 33-36: unconditional Content-Type: application/json in apiFetch; lines 70-75: apiDelete conditional body exposes it"
    - path: "apps/web/src/features/contacts/ContactDetailPage.tsx"
      issue: "line 134: bodyless contact delete — the reported UAT Test 2 failure, blocks DSR erasure flow"
    - path: "apps/web/src/features/team/TeamPage.tsx"
      issue: "line 78: bodyless member removal — same 400"
    - path: "apps/web/src/features/segments/api.ts"
      issue: "line 57: deleteSegment (via DeleteSegmentDialog.tsx:41) — same 400"
    - path: "apps/web/src/features/campaigns/api.ts"
      issue: "line 85: deleteCampaign (via CampaignsListPage.tsx:104) — same 400"
    - path: "apps/web/src/features/flows/api.ts"
      issue: "line 160: deleteFlow (via useDeleteFlow api.ts:301-309, FlowsListPage.tsx) — same 400"
  missing:
    - "In apiFetch, attach Content-Type: application/json only when init.body is present (or move header into body-carrying wrappers) — one change fixes all five bodyless apiDelete call sites"
    - "Do NOT fix server-side (empty-JSON-tolerant parser rejected: would mask malformed requests platform-wide incl. public event-ingestion, diverge from Fastify default contract, touch parser behavior webhook signature verification carefully scopes)"
    - "Verification: existing apps/web/e2e/segments.spec.ts:73-78 delete step exercises this exact broken path (mechanically cannot pass today; e2e CI job is non-blocking per .github/workflows/ci.yml:36) — fix should turn it green; add a contact-card delete test for the UAT Test 2 path"
  debug_session: ".planning/debug/ui-delete-empty-json-body-400.md"

- gap_id: G-21-3
  truth: "At narrow viewport widths the contact-card header actions row (Export + Delete) wraps onto a new line without horizontal page overflow, and the inline reason/error paragraph stays within the visible content width"
  status: resolved
  resolution: "Closed by plan 21-08 (commits f6cb341/cf18ffe/badb8f8, 2026-08-23): responsive shell (sidebar out of layout below md behind a Sheet drawer via new WorkspaceNav), wrapping header/actions/message rows, min-w-0 on main and title cluster, single-column ContactForm grid below sm. apps/web/e2e/contact-card-narrow-viewport.spec.ts measured RED scrollWidth 1220 vs clientWidth 375, GREEN 375 == 375 after the fix; desktop corpus unchanged. Re-verified 2026-08-23 (21-VERIFICATION.md, 18/18). Follow-up human check on the new drawer recorded as Test 4."
  reason: "User reported: The Export + Delete action row does not wrap — both containers use flex-wrap: nowrap. Body clientWidth 375px vs scrollWidth 1029px (horizontal overflow); Delete button rendered outside the visible viewport. The inline error text wraps internally but its block begins beyond the viewport, so the message is effectively off-screen."
  severity: major
  test: 3
  root_cause: "Multi-condition layout defect: (1) three nested nowrap flex rows — ContactDetailPage.tsx:300 header row, :305 actions cluster, ExportContactButton wrapper :111 — force title/Export/message/Delete onto one line; (2) children unshrinkable below min-content — shadcn Button base whitespace-nowrap (button.tsx:8), message <p> (:121) unconstrained, no min-w-0 anywhere so min-width:auto propagates min-content outward; (3) AppShell.tsx:27 fixed w-64 (256px) non-responsive sidebar + flex-1 main (:64) without min-w-0 — at 375px: 256 + 64 (p-8) + ~709 header min-content ≈ 1029px, matching measured scrollWidth. Fixing flex-wrap alone provably cannot clear page overflow (256 sidebar + 64 padding + 145px Delete ≈ 465px > 375px). Outer nowrap header pre-dates Phase 21 (f88699a); Phase 21 added ~330px of unshrinkable width, exposing the latent defect. UI-SPEC marks E1/E2 as backstop — wrap was never implemented, not regressed."
  artifacts:
    - path: "apps/web/src/features/contacts/ContactDetailPage.tsx"
      issue: "lines 300, 305, 301: nowrap flex rows without flex-wrap/min-w-0; line 111: ExportContactButton nowrap wrapper pins message beside button; line 121: message <p> has no width/placement constraint"
    - path: "apps/web/src/components/ui/button.tsx"
      issue: "line 8: base whitespace-nowrap makes header buttons irreducible min-content (shared primitive — constrain at call sites, not here)"
    - path: "apps/web/src/features/app-shell/AppShell.tsx"
      issue: "lines 27, 64: fixed 256px sidebar with no responsive breakpoints + flex-1 main without min-w-0 propagates content min-content into body scrollWidth"
  missing:
    - "Header layer: add flex-wrap to ContactDetailPage.tsx:300/:305; restructure ExportContactButton (:111) so message can drop below the button (column layout or flex-wrap + basis-full/max-w on the paragraph); min-w-0/truncation on title cluster (:301)"
    - "Shell layer (planner decision): either make AppShell responsive at narrow widths (collapse/overlay the w-64 sidebar) or explicitly re-scope the gap's 'no horizontal page overflow' criterion to the content column — header wrapping alone mathematically cannot satisfy it at 375px with the fixed 256px sidebar"
  debug_session: ".planning/debug/contact-card-narrow-viewport-overflow.md"
