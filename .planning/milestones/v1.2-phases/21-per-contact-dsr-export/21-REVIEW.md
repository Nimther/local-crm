---
phase: 21-per-contact-dsr-export
reviewed: 2026-08-23T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - apps/web/e2e/contact-card-narrow-viewport.spec.ts
  - apps/web/e2e/contact-delete.spec.ts
  - apps/web/e2e/helpers/workspace-setup.ts
  - apps/web/src/features/app-shell/AppShell.tsx
  - apps/web/src/features/app-shell/WorkspaceNav.tsx
  - apps/web/src/features/contacts/ContactDetailPage.tsx
  - apps/web/src/features/contacts/ContactForm.tsx
  - apps/web/src/lib/__tests__/api.test.ts
  - apps/web/src/lib/api.ts
findings:
  critical: 0
  warning: 4
  info: 3
  total: 7
status: issues_found
---

# Phase 21: Code Review Report

**Reviewed:** 2026-08-23T00:00:00Z
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

This review covers a **gap-closure round** (plans 21-07 and 21-08) on Phase 21, which had already been through a prior code-review cycle. It replaces that prior round's `21-REVIEW.md` (preserved in git history); it does not re-review the whole phase from scratch. The diff base (`99f6c10`) isolates exactly three substantive commits: `0d27c68` (21-07, `apiFetch` Content-Type fix for bodyless requests), `cf18ffe` (21-08, responsive `AppShell`/`WorkspaceNav`), and `badb8f8` (21-08, contact-card header wrap + `ContactForm` grid), plus their accompanying e2e/unit tests.

**21-07 (`apps/web/src/lib/api.ts`)** — verified correct and narrowly scoped: gating `Content-Type: application/json` on `init?.body !== undefined` closes G-21-2 without touching the server-side content-type parser (the diagnosis's explicitly-rejected alternative). Confirmed all three production `apiDelete` call sites (`ContactDetailPage.tsx`, `TeamPage.tsx`, `DeleteWorkspaceDialog.tsx`) behave correctly under the new logic — the two bodyless calls drop the header, the one call with `confirmName` keeps it. DELETE is not a CORS-simple method, so dropping the header on bodyless requests does not weaken CSRF preflight properties; this was evaluated, not overlooked. One robustness gap remains (WR-04 below): the presence check doesn't fully match the "there is no body" contract it's supposed to enforce.

**21-08 (`AppShell.tsx`/`WorkspaceNav.tsx`, contact-card wrap)** — the two AND-gated overflow causes from the diagnosis (fixed sidebar, contact-card header rows) are both addressed and the new `contact-card-narrow-viewport.spec.ts` pins the exact 375px measurement from the UAT report. However, tracing the mobile-drawer mechanism (Radix `Dialog`/`Sheet` portals to `document.body`) surfaced that the shell's "exactly one nav rendering at any viewport" invariant is not actually enforced by the implementation as written — see WR-01. A related gap (WR-02) was confirmed by reading `WorkspaceSwitcher.tsx`, not inferred.

Zero Critical findings — nothing here is a security vulnerability, data-loss risk, or crash. The findings below are real correctness/robustness gaps worth fixing, not style nits.

## Warnings

### WR-01: Mobile drawer can render `WorkspaceNav` twice in the DOM simultaneously; invariant holds only by accident of the current test corpus

**File:** `apps/web/src/features/app-shell/AppShell.tsx:14-22, 38-50`

**Issue:** The docstring claims "the desktop aside is removed from rendering (not merely hidden) below md" — this is inaccurate. The aside uses `hidden md:flex` (a CSS `display: none` toggle), so `WorkspaceNav` is always mounted in the DOM; it is only visually/accessibility-tree hidden below `md`. Separately, `SheetContent` (in `components/ui/sheet.tsx`) renders via `SheetPortal` → Radix's `Dialog.Portal`, which teleports its subtree to `document.body` by default — **outside** the `md:hidden` wrapping `<div>` that the mobile trigger lives in. That `md:hidden` class therefore has no effect on the drawer's own visibility once open; only the Sheet's own `open` state (`drawerOpen`) controls that.

The consequence: whenever the drawer is open, there are two `WorkspaceNav` instances live in the DOM — the CSS-hidden aside and the open, portaled drawer. This is masked today only because every existing spec uses `getByRole`, which Playwright excludes `display:none` elements from by default. A future assertion using `getByText(...)` (or any query that doesn't respect the accessibility tree) at a narrow viewport with the drawer open would hit a strict-mode violation immediately. Worse, the invariant breaks even for `getByRole` if the browser is resized from below `md` to `md`+ *while the drawer is open*: `drawerOpen` is local React state that persists across a resize, so the aside becomes visible (`md:flex`) while the still-open, portaled drawer also remains visible — two accessible nav renderings with identical role/name pairs.

No current test opens the drawer at all (`contact-card-narrow-viewport.spec.ts` only asserts overflow/layout facts, never clicks the "Меню" trigger), so this class of bug has no automated guard.

**Fix:** Make the two renderings mutually exclusive at the state level instead of relying on CSS alone, e.g. drive the aside/drawer choice off a shared media-query hook so only one is ever mounted:

```tsx
const isDesktop = useMediaQuery("(min-width: 768px)"); // matches Tailwind's md
// ...
{isDesktop ? <aside className="w-64 ..."><WorkspaceNav slug={slug} /></aside> : null}
<Sheet open={!isDesktop && drawerOpen} onOpenChange={setDrawerOpen}>...</Sheet>
```
or, more cheaply, close the drawer automatically when the viewport crosses `md`:
```tsx
useEffect(() => {
  const mq = window.matchMedia("(min-width: 768px)");
  const onChange = () => setDrawerOpen(false);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}, []);
```
Also correct the docstring's "removed from rendering (not merely hidden)" claim, and add an e2e test that actually opens the drawer (click "Меню", assert exactly one `getByRole("link", { name: "Сегменты" })`) so this invariant is enforced going forward instead of asserted only in a comment.

---

### WR-02: Switching workspaces from the mobile drawer's `WorkspaceSwitcher` leaves the drawer open

**File:** `apps/web/src/features/app-shell/WorkspaceNav.tsx:28`, `apps/web/src/features/workspace-switcher/WorkspaceSwitcher.tsx:66`

**Issue:** `WorkspaceNav`'s `onNavigate` callback (added in 21-08 specifically so "the mobile drawer can close itself after a navigation") is wired to every `NavLink`'s `onClick`, but **not** to `WorkspaceSwitcher`, which is rendered inside the same `WorkspaceNav` and also triggers navigation via `onSelect={() => void navigate(...)}` (confirmed by reading `WorkspaceSwitcher.tsx`, both for switching workspace and for "Создать воркспейс"). A user who opens the mobile drawer and picks a different workspace (or "Создать воркспейс") from the switcher dropdown navigates to the new route while the drawer stays open on top of it, requiring a manual dismiss. This is inconsistent with the stated intent of `onNavigate` and is a real, reachable UX gap on the very surface this round added.

**Fix:** Thread `onNavigate` down into `WorkspaceSwitcher` and invoke it from both `onSelect` handlers, mirroring the `NavLink` pattern:

```tsx
// WorkspaceNav.tsx
<WorkspaceSwitcher activeSlug={slug} onNavigate={onNavigate} />

// WorkspaceSwitcher.tsx
export function WorkspaceSwitcher({ activeSlug, onNavigate }: { activeSlug: string; onNavigate?: () => void }) {
  ...
  onSelect={() => { onNavigate?.(); void navigate(`/w/${workspace.slug}`); }}
```

---

### WR-03: Stale `serverError` in `DeleteContactDialog` reappears on reopen after a prior failed attempt (pre-existing, outside this round's diff)

**File:** `apps/web/src/features/contacts/ContactDetailPage.tsx:131-183`

**Issue:** `serverError` is component-local state on `DeleteContactDialog`, which itself is never unmounted between opens (only its `AlertDialogContent` is portal-conditional). If a delete attempt fails (`onError` sets `serverError`), and the user then clicks "Отмена" to close the dialog, `serverError` is not cleared. Reopening the dialog later (to retry, or even for an unrelated reason) redisplays the stale error message from the previous session before any new attempt has been made — confusing since nothing has failed yet in the new interaction. This predates the 21-07/21-08 diff (confirmed via `git diff 99f6c10..HEAD` — this function's body is untouched by the current round) but is present in the reviewed file and was not caught by the prior review round either.

**Fix:** Reset `serverError` when the dialog transitions to open:

```tsx
<AlertDialog
  open={open}
  onOpenChange={(next) => {
    setOpen(next);
    if (next) setServerError(null);
  }}
>
```

---

### WR-04: `apiFetch`'s body-presence check doesn't fully match "there is no body sent", reopening a path back to the exact bug this round fixed

**File:** `apps/web/src/lib/api.ts:42`

**Issue:** The fix keys the `Content-Type` decision on `init?.body !== undefined`. `fetch`'s own contract treats `body: null` identically to an omitted body (no body is sent), and an explicit `body: ""` sends a zero-length body — Fastify's content-type parser runs whenever the header is present regardless of length, so either of these would reproduce `FST_ERR_CTP_EMPTY_JSON_BODY`, the exact class of bug 21-07 was written to close. No current caller passes `body: null` or `body: ""` (verified: all `apiPost`/`apiPatch`/`apiPut`/`apiDelete` call sites either omit `data` or pass a real object), so this is latent, not currently triggered. But the check is the single guard protecting the invariant this whole gap-closure round exists to establish, and it is not airtight against a future caller.

**Fix:** Tighten the guard to match `fetch`'s actual "no body" semantics, or add a comment making the contract explicit so a future caller can't silently reintroduce G-21-2:

```ts
// Treat null/undefined/empty-string bodies as "no body sent" -- matches
// fetch's own semantics and keeps this guard airtight against G-21-2.
...(init?.body !== undefined && init?.body !== null && init.body !== "" ? { "Content-Type": "application/json" } : {}),
```

## Info

### IN-01: `toHaveCount(0)` assertion in `contact-delete.spec.ts` can pass vacuously

**File:** `apps/web/e2e/contact-delete.spec.ts:54`

**Issue:** `await expect(page.getByText(email)).toHaveCount(0)` is evaluated immediately after `waitForURL`; if the contacts list hasn't finished its own fetch/render yet, the assertion trivially passes because the element doesn't exist *yet*, not because the contact was actually deleted. The real proof that the delete worked is already `waitForURL` succeeding (a 2xx DELETE response) — this assertion adds little and could mask a case where the list still shows the "deleted" contact once it finishes loading.

**Fix:** Either wait for the list to finish loading first (e.g., wait for a list-item role/testid to appear, or for a network-idle signal) before asserting absence, or drop the assertion since `waitForURL` already proves the delete succeeded.

### IN-02: `navLinkClassName` exported but only consumed within its own module

**File:** `apps/web/src/features/app-shell/WorkspaceNav.tsx:14`

**Issue:** `export function navLinkClassName(...)` is only referenced within `WorkspaceNav.tsx` itself (grep confirms no other importer). The `export` keyword adds no value here and slightly widens the file's public surface unnecessarily.

**Fix:** Drop `export` unless another module is expected to import it soon; if kept for an anticipated near-term reuse, a one-line comment saying so would avoid the "why is this exported" question for the next reader.

### IN-03: Duplicate `canExport` computation

**File:** `apps/web/src/features/contacts/ContactDetailPage.tsx:74, 259, 311`

**Issue:** `viewerRole === "owner" || viewerRole === "admin"` is computed once in `ContactDetailPage` (line 259, used to gate rendering `ExportContactButton` at all, line 311) and again independently inside `ExportContactButton` itself (line 74, used for its own `canExport ? ... : null` return). The outer gate makes the inner one dead in practice (when the outer is `false`, `ExportContactButton` is never even rendered), but the duplicated logic is easy to let drift out of sync if the role rule ever changes in only one place.

**Fix:** Pick one location for the check — either drop the outer `canExport ? ... : null` at the call site and let `ExportContactButton` be the sole gate (simplest, since it already returns `null` correctly), or pass `canExport` down as a prop instead of recomputing it.

---

_Reviewed: 2026-08-23T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
