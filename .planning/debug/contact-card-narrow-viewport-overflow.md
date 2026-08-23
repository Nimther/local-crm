# Debug Session: contact-card-narrow-viewport-overflow

**Status:** root cause found
**Phase:** 21-per-contact-dsr-export (UAT Test 3, gap G-21-3)
**Date:** 2026-08-23
**Goal:** find_root_cause_only

## Symptoms

At 375px viewport width, the contact-card header actions row (Export + Delete) does not
wrap: both containers use `flex-wrap: nowrap`. The page develops horizontal overflow
(body clientWidth 375px, scrollWidth 1029px) and the Delete button renders outside the
visible viewport. The inline error text wraps internally (~10 lines at 20px line-height)
but its block begins beyond the viewport, so the message is effectively off-screen.

## Root Cause

Multi-condition (AND-gate) layout defect:

1. **Three nested nowrap flex rows** — the page-header row at
   `apps/web/src/features/contacts/ContactDetailPage.tsx:300`
   (`flex items-center justify-between gap-4`), the actions cluster at `:305`
   (`flex items-center gap-2` — the two containers the tester measured as nowrap), and
   `ExportContactButton`'s own wrapper at `:111` (`flex items-center gap-2`) force title,
   Export button, inline reason/error paragraph, and Delete button onto one line.
2. **Every child is unshrinkable below min-content** — shadcn Button base has
   `whitespace-nowrap` (`apps/web/src/components/ui/button.tsx:8`; Export ≈230px /
   Delete ≈145px irreducible); the message `<p>` at `ContactDetailPage.tsx:121` has no
   width constraint (shrinks only to longest-word min-content ≈80px); no `min-w-0`
   exists anywhere in the chain, so CSS `min-width: auto` propagates the min-content
   sum outward.
3. **Fixed non-responsive shell** — `apps/web/src/features/app-shell/AppShell.tsx:27`
   renders a fixed `w-64` (256px) sidebar beside a `flex-1` main (`:64`, default
   `min-width: auto`). At 375px: 256 (sidebar) + 64 (page `p-8`) + ~709 (header row
   min-content) ≈ 1029px — matching the measured body scrollWidth exactly.

## Evidence

- Width accounting reconciles the tester's measurements (clientWidth 375 /
  scrollWidth 1029 / 10-line message) with the static flex chain. Critically,
  condition (3) means **fixing flex-wrap alone provably cannot clear the page
  overflow** — even the smallest button (Delete ≈145px, `whitespace-nowrap`) + 256px
  sidebar + 64px padding ≈ 465px > 375px, independent of Export-button width.
- Provenance (git): the outer nowrap header row pre-dates Phase 21 (`f88699a` already
  had `flex items-center justify-between gap-4` with only the ~145px Delete button);
  Phase 21 (`2e716fb`, `6895f0a`) added the actions-cluster div, the Export button, and
  the message slot — ~330px of new unshrinkable/min-content width that pushed the
  latent defect past any narrow viewport.
- 21-UI-SPEC.md documents the header as `flex items-center justify-between gap-4` and
  marks both E1/E2 overflow rows as "backstop — no explicit narrow-viewport test
  exists": wrap behavior was never implemented, not regressed.
- Eliminated: data-dependence (empty title still overflows: 256 + 64 + ~480 actions
  cluster ≈ 800px) and global CSS (index.css has no overflow/min-width rules).

## Files Involved

- `apps/web/src/features/contacts/ContactDetailPage.tsx`: lines 300, 305 (and title
  cluster 301) — nowrap flex rows without `flex-wrap`/`min-w-0`; line 111 —
  ExportContactButton's nowrap wrapper pins the message beside the button; line 121 —
  message `<p>` has no width/placement constraint.
- `apps/web/src/components/ui/button.tsx`: line 8 — base `whitespace-nowrap` makes both
  header buttons irreducible min-content (shared primitive; constrain at call sites,
  not here).
- `apps/web/src/features/app-shell/AppShell.tsx`: lines 27, 64 — fixed 256px sidebar
  with zero responsive breakpoints + `flex-1` main without `min-w-0`, which propagates
  content min-content into body scrollWidth.

## Suggested Fix Direction

Two layers, enumerate for the planner:

- **(a) Header layer** — add wrap utilities (`flex-wrap`) to
  ContactDetailPage.tsx:300/:305 and restructure ExportContactButton (:111) so the
  message can drop below the button (e.g. column layout or `flex-wrap` +
  `basis-full`/`max-w` on the paragraph), plus `min-w-0`/truncation on the title
  cluster (:301).
- **(b) Shell layer** — a decision for plan-phase --gaps: either make AppShell
  responsive at narrow widths (collapse/overlay the `w-64` sidebar) or explicitly
  re-scope the gap's "no horizontal page overflow" criterion to the content column,
  because header wrapping alone mathematically cannot satisfy it at 375px while the
  fixed 256px sidebar stands.

**Specialist hint:** react

> Note: original session file was written inside the diagnosis worktree and lost on
> worktree cleanup; this file is reconstructed verbatim from the agent's returned
> diagnosis.
