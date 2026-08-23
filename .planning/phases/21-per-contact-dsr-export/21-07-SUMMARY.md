---
phase: 21-per-contact-dsr-export
plan: 07
subsystem: web-client
tags: [fastify, content-type, playwright, vitest, e2e, gap-closure]

# Dependency graph
requires:
  - phase: 21-per-contact-dsr-export
    provides: plan 21-01 (workspace-scoped contact/session foundation the delete UI and its e2e preamble depend on)
provides:
  - "apiFetch (apps/web/src/lib/api.ts) attaches Content-Type: application/json only when a request carries a body"
  - "apps/web/e2e/helpers/workspace-setup.ts — shared register+workspace preamble and API contact fixture, reusable by plan 21-08"
  - "apps/web/e2e/contact-delete.spec.ts — automated regression for the UAT Test 2 delete path"
  - "apps/web/src/lib/__tests__/api.test.ts — request-shape matrix pinning header/body behavior per verb"
affects: [21-08, contacts, team, segments, campaigns, flows]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "apiFetch: attach Content-Type only when init.body is defined, keep caller-supplied init.headers spread last so it can override"
    - "e2e response listener behind a stable log prefix ([contact-delete:response]) to surface server refusal codes instead of only a generic UI timeout"

key-files:
  created:
    - apps/web/e2e/helpers/workspace-setup.ts
    - apps/web/e2e/contact-delete.spec.ts
    - apps/web/src/lib/__tests__/api.test.ts
  modified:
    - apps/web/src/lib/api.ts

key-decisions:
  - "Fix lives in the shared client helper only (apiFetch), not the server's content-type parser — the server-side alternative was already rejected in diagnosis because it would relax the parser contract platform-wide, including the public event-ingestion and webhook surfaces"
  - "Content-Type decision is keyed on init?.body !== undefined (not on HTTP verb), so it fixes all five bodyless apiDelete call sites (contacts, team, segments, campaigns, flows) with one conditional"

patterns-established:
  - "New e2e specs that need register+workspace+contact fixtures should import from apps/web/e2e/helpers/workspace-setup.ts rather than re-implementing the preamble inline"

requirements-completed: [DSR-01]

coverage:
  - id: D1
    description: "apiFetch attaches Content-Type: application/json only when a request carries a body; caller-supplied headers still override; credentials:include preserved; non-2xx still throws ApiError"
    requirement: "DSR-01"
    verification:
      - kind: unit
        ref: "apps/web/src/lib/__tests__/api.test.ts — 10-case request-shape matrix"
        status: pass
    human_judgment: false
  - id: D2
    description: "Contact card's «Удалить контакт» action performs the DELETE and erases the contact (UAT Test 2 path), regression-proofed"
    requirement: "DSR-01"
    verification:
      - kind: e2e
        ref: "apps/web/e2e/contact-delete.spec.ts — clicking «Удалить контакт» deletes the contact and returns to the list"
        status: pass
    human_judgment: false
  - id: D3
    description: "Segment delete step (existing e2e corpus) passes for the first time against the fixed helper"
    verification:
      - kind: e2e
        ref: "apps/web/e2e/segments.spec.ts — build, preview, and save a segment from the Сегменты section (delete step at the end)"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-08-23
status: complete
---

# Phase 21 Plan 07: Fix bodyless-delete Content-Type gap (G-21-2) Summary

**apiFetch now attaches `Content-Type: application/json` only when the request carries a body, fixing all five bodyless UI delete actions (contacts, team members, segments, campaigns, flows) with one conditional, pinned by a 10-case unit matrix and a new contact-delete e2e regression.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-08-23T07:44:09Z
- **Tasks:** 3
- **Files modified:** 4 (1 modified, 3 created)

## Accomplishments

- Diagnosed defect closed: `apps/web/src/lib/api.ts`'s `apiFetch` no longer sends `Content-Type: application/json` on bodyless requests, so Fastify 5.9.0's content-type parser is never invoked for those requests and no longer rejects them with `FST_ERR_CTP_EMPTY_JSON_BODY`.
- New `apps/web/e2e/contact-delete.spec.ts` automates the exact UAT Test 2 path (register → create workspace → create contact via API → open contact card → confirm delete → land back on the contacts list with the contact gone), with a response listener that logs the server's actual refusal code on any non-2xx DELETE response.
- New `apps/web/e2e/helpers/workspace-setup.ts` factors the register+create-workspace preamble (with its 429 retry-after backoff) and an API-based contact fixture out for reuse by plan 21-08, without touching the existing in-file preamble in `segments-behavior.spec.ts`.
- New `apps/web/src/lib/__tests__/api.test.ts` pins the full request-shape matrix: bodyless `apiGet`/`apiDelete` carry no `Content-Type` and no body; body-carrying `apiPost`/`apiPatch`/`apiPut`/`apiDelete(path, data)` (including `apiPost(path, {})`) keep it; a caller-supplied header in `init.headers` overrides the default; every request sets `credentials: "include"`; a non-2xx response still throws `ApiError` with the parsed body.
- Regression sweep confirmed `e2e/segments.spec.ts`'s delete step — broken since birth (Phase 3) and mechanically red every run because the e2e job is deliberately non-blocking in CI — now passes for the first time.

## Fail-First Evidence (Task 1)

Running `e2e/contact-delete.spec.ts` against the unfixed `apiFetch` failed at the delete step. The response listener surfaced the server's exact refusal, verbatim:

```
[contact-delete:response] status=400 body={"statusCode":400,"code":"FST_ERR_CTP_EMPTY_JSON_BODY","error":"Bad Request","message":"Body cannot be empty when content-type is set to 'application/json'"}
```

The test then timed out waiting for the post-delete redirect (`page.waitForURL` — 30000ms exceeded), which is the expected downstream symptom of the DELETE never succeeding.

## Detection-Power Result (Task 3)

After the fix landed and `e2e/contact-delete.spec.ts` passed green end-to-end, the fix was temporarily reverted (the `Content-Type` header restored to unconditional) directly in `apps/web/src/lib/api.ts`, and the spec was re-run. It reproduced the **identical** failure:

```
[contact-delete:response] status=400 body={"statusCode":400,"code":"FST_ERR_CTP_EMPTY_JSON_BODY","error":"Bad Request","message":"Body cannot be empty when content-type is set to 'application/json'"}
```

confirming the spec has real detection power over this defect rather than passing vacuously. The temporary revert was undone with `git checkout -- apps/web/src/lib/api.ts` (not `git stash` — see Deviations), and `git status`/`git diff` were confirmed clean of any residue before the fix's own commit was made.

## Task Commits

Each task was committed atomically (Task 2 followed the TDD RED→GREEN cycle):

1. **Task 1: Shared e2e preamble + contact-delete spec, RED against unfixed helper** — `0b78770` (test)
2. **Task 2 (RED): Pin the request-shape matrix** — `9b7b5fd` (test)
2. **Task 2 (GREEN): Make Content-Type conditional on a body** — `0d27c68` (fix)
3. **Task 3: Regression sweep — contact delete green, segment delete green, web lane clean** — `128c0fc` (test)

**Plan metadata:** committed alongside this summary.

## Files Created/Modified

- `apps/web/src/lib/api.ts` — `apiFetch`'s header construction now attaches `Content-Type: application/json` only when `init?.body !== undefined`; a comment points at the debug session file to prevent a future "simplification" back to unconditional.
- `apps/web/e2e/helpers/workspace-setup.ts` — new: `registerAndCreateWorkspace(page, namePrefix)` and `createContactViaApi(page, slug, input)`, factored for reuse by plan 21-08.
- `apps/web/e2e/contact-delete.spec.ts` — new: automated regression for the UAT Test 2 contact-delete path, with a `[contact-delete:response]`-prefixed failure logger kept permanently for future diagnosability.
- `apps/web/src/lib/__tests__/api.test.ts` — new: 10-case request-shape matrix for `apiFetch`/`apiGet`/`apiPost`/`apiPatch`/`apiPut`/`apiDelete`.

## Decisions Made

- Keyed the Content-Type decision on body presence (`init?.body !== undefined`), not on HTTP verb — this is what lets one conditional fix all five affected call sites (contacts, team, segments, campaigns, flows) without touching any of them individually, matching the plan's stated approach.
- Kept the server-side content-type parser untouched, per the diagnosis's explicit rejection of that alternative (it would relax the JSON parser contract platform-wide, including the event-ingestion and webhook surfaces whose signature verification depends on carefully scoped parser behavior).
- Kept the e2e failure-logging response listener in the final spec (not removed after the fix) so a future regression reports the server's actual refusal code rather than only a Playwright timeout.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a require-await lint violation in the test file's own fetch stub**
- **Found during:** Task 3 (repo-wide lint gate)
- **Issue:** `apps/web/src/lib/__tests__/api.test.ts`'s mock `Response.json` was declared `async () => body` with no `await` inside, tripping `@typescript-eslint/require-await` under `eslint . --max-warnings=0`.
- **Fix:** Changed to `json: () => Promise.resolve(body)`.
- **Files modified:** `apps/web/src/lib/__tests__/api.test.ts`
- **Verification:** `npm run lint` clean; unit test file still 10/10 passing.
- **Committed in:** `128c0fc` (Task 3 commit)

**2. [Process correction] Used `git stash` during the Task 3 detection-power experiment, in violation of this project's destructive-git prohibition, and immediately corrected it**
- **Found during:** Task 3 (detection-power experiment)
- **Issue:** Ran `git stash` to set aside the plan's uncommitted state before the experiment. This repo has active worktree-based executors elsewhere (confirmed via `git stash list` showing a sibling `stash@{0}: WIP on worktree-agent-...` entry already present) — `refs/stash` is shared across the main checkout and every linked worktree, so pushing onto it risks a sibling worktree later popping the wrong entry.
- **Fix:** Immediately ran `git stash pop stash@{0}` (the exact entry just pushed, LIFO) to restore state before doing anything else, confirmed the sibling worktree's stash entry was untouched (`stash@{0}` after the pop correctly showed the pre-existing `worktree-agent-...` entry), and confirmed no unintended changes landed. All subsequent experiment steps used the sanctioned alternative (`git checkout -- apps/web/src/lib/api.ts` to discard the temporary in-place edit) instead of stash.
- **Files modified:** none (self-corrected before any file was affected)
- **Verification:** `git stash list` after the pop shows only the pre-existing sibling-worktree entry; `git status`/`git diff` matched the state immediately before the stash was pushed.
- **Committed in:** n/a (no commit involved; corrected in-session before any commit)

---

**Total deviations:** 2 (1 auto-fixed lint issue, 1 self-corrected process violation)
**Impact on plan:** No scope creep; both were resolved within the same task without affecting the plan's deliverables.

## Issues Encountered

None beyond the two deviations above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Gap G-21-2 is closed: the contact card's delete action performs the DELETE and the contact is erased, unblocking the two-tab erasure race the phase's SC5 courtesy handling was built for.
- `apps/web/e2e/helpers/workspace-setup.ts` is in place and ready for plan 21-08 to reuse.
- No new blockers identified for the remaining gap-closure plan (21-08 / G-21-3).

---
*Phase: 21-per-contact-dsr-export*
*Completed: 2026-08-23*

## Self-Check: PASSED

All created/modified files found on disk (apps/web/src/lib/api.ts, apps/web/src/lib/__tests__/api.test.ts, apps/web/e2e/helpers/workspace-setup.ts, apps/web/e2e/contact-delete.spec.ts, this SUMMARY.md). All task commits found in git log (0b78770, 9b7b5fd, 0d27c68, 128c0fc, 3c8253d).
