---
phase: 21-per-contact-dsr-export
plan: 05
subsystem: api
tags: [postgres, drizzle, zod, dsr-export, gdpr, keyset-pagination, repeatable-read]

# Dependency graph
requires:
  - phase: 21-per-contact-dsr-export (plan 02)
    provides: SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST + buildExportSendEventPayload in @mega-crm/delivery-core
  - phase: 21-per-contact-dsr-export (plan 03)
    provides: the walkToExhaustion keyset-walk shape and withTenantTransactionRepeatableRead usage in dsr-export.repository.ts
provides:
  - "sends section: every sends row for a contact, oldest first, with delivery-status timestamps and reasons, excluding dispatch telemetry"
  - "sendEvents nested under each send: every send_events row reached only through the sends join, payload bounded by the export allowlist"
  - "machine-proven D-15/SC5: a REPEATABLE READ export transaction reads one pre-scrub snapshot across all its pages during a real interleaved erasure scrub, with a READ COMMITTED control that fails the same assertion"
affects: [21-06 (SPECIFICATION.md update), phase-22-workspace-quiesce-physical-purge]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Export section readers apply their allowlist function INSIDE the page reader (buildExportSendEventPayload called before rows leave selectSendEventsPage), not at the assembly layer -- no raw payload value ever escapes the reader function."
    - "Multi-row export sections keyed on (id) return an extra join key (sendId) from the page reader so the assembler can group without a second query, then strip that key when nesting."

key-files:
  created:
    - apps/api/src/modules/contacts/__tests__/dsr-export-isolation.test.ts
  modified:
    - apps/api/src/modules/contacts/dsr-export.repository.ts
    - packages/shared-schemas/src/dsr-export.ts
    - apps/api/src/modules/contacts/__tests__/dsr-export.test.ts

key-decisions:
  - "selectSendEventsPage applies buildExportSendEventPayload to every row's payload INSIDE the reader (before returning), not at the getDsrExportDocument assembly layer -- the strongest form of the plan's prohibition against a raw payload ever reaching the document."
  - "The isolation test's simulated erasure scrub reproduces the real apps/worker per-row UPDATE (workspace_id, id, occurred_at keyed, buildScrubbedSendEventPayload per row) on a separate pool connection rather than importing apps/worker -- this workspace has no dependency on it, and the shared allowlist function is the same code the real worker runs."

requirements-completed: [DSR-02, DSR-03]

coverage:
  - id: D1
    description: "sends section: every send for the contact exported oldest first by queued_at, with delivery-status timestamps/reasons, campaign/flow linkage, and open/click counters; dispatch telemetry (reconciling_since, dispatch_duration_ms) excluded"
    requirement: "DSR-02"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#sends: every send for this contact is exported oldest first (DSR-02)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#sends: excluded telemetry columns are absent (DSR-02)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#sends: another contact's sends are absent (DSR-02)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#sends: a contact with no sends exports an empty array with count 0 (DSR-02)"
        status: pass
    human_judgment: false
  - id: D2
    description: "sendEvents nest under their parent send, oldest first, reached only through the sends join, with pagination proven at DSR_EXPORT_PAGE_LIMIT+3 rows"
    requirement: "DSR-02"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#send events nest under their send, oldest first (DSR-02)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#send events: another contact's send events are absent (DSR-02)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#send events: more than one page of send events all reach the file (D-10)"
        status: pass
    human_judgment: false
  - id: D3
    description: "send_events.payload reaches the export only through buildExportSendEventPayload -- a synthetic other-subject field under two innocuous key names is proven absent from the whole serialized document (SC4), and the export list (not the erasure list) is proven applied by asserting the four export-only keys survive"
    requirement: "DSR-03"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#allowlist: a synthetic field holding another subject's data is absent from the export (DSR-03, SC4)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#allowlist: the export list is applied, not the evidence list (DSR-03, D-02)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#allowlist: a payload of only non-allowlisted keys exports an empty object (DSR-03)"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-15/SC5: an export transaction that begins before a concurrent erasure scrub commits and finishes after it ships one consistent pre-scrub snapshot across all its pages, proven against a real interleaved scrub with a READ COMMITTED control that fails the same assertion, plus a direct isolation-level sanity check"
    requirement: "DSR-02"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export-isolation.test.ts#REPEATABLE READ: a scrub committing mid-walk cannot change what later pages read (D-15, SC5)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export-isolation.test.ts#READ COMMITTED control: the same interleaving observes the scrubbed rows (fail-first evidence for the case above)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export-isolation.test.ts#the export wrapper really is repeatable read (sanity control)"
        status: pass
    human_judgment: false

duration: 30min
completed: 2026-08-22
status: complete
---

# Phase 21 Plan 05: Sends + Send-Events Export Sections Summary

**`sends`/nested `sendEvents` DSR export sections with the export allowlist applied inside the page reader, plus a machine-proven mid-scrub REPEATABLE READ snapshot guarantee with a failing READ COMMITTED control.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-08-22T17:20:00+05:00 (approx.)
- **Completed:** 2026-08-22T17:38:00+05:00 (approx.)
- **Tasks:** 3
- **Files modified:** 3 (1 created)

## Accomplishments
- Added `selectSendsPage` to `dsr-export.repository.ts`: every `sends` row for the contact, keyset-paginated on `(queued_at, id)`, excluding `reconciling_since`/`dispatch_duration_ms` per `docs/PII-INVENTORY.md`.
- Added `selectSendEventsPage`: every `send_events` row for the contact reached only through a JOIN to `sends` (the table carries no `contact_id` of its own), keyset-paginated on `(occurred_at, id)` because the table is range-partitioned, with `buildExportSendEventPayload` from `@mega-crm/delivery-core` applied to every row's `payload` **inside the reader** so no raw payload value can ever escape it.
- Extended `packages/shared-schemas/src/dsr-export.ts` with `dsrExportSendSchema`/`dsrExportSendEventSchema` and nested `sends[].sendEvents` in the document schema.
- Proved SC4 (the synthetic other-subject-field proof): a send event payload seeded with a distinctive address nested under two innocuous tenant-invented key names is absent from the whole serialized export document, while all ten evidence keys and the four export-only keys (`ip`, `useragent`, `url`, `reason`) survive.
- Proved D-15/SC5 in a new `dsr-export-isolation.test.ts`: a real interleaved erasure-scrub simulation (the exact per-row `buildScrubbedSendEventPayload` + `UPDATE ... WHERE workspace_id = $2 AND id = $3 AND occurred_at = $4::timestamptz` the real `apps/worker` scrub commits, on a separate pool connection) proves every page an export transaction reads after the scrub commits still carries the pre-scrub payload under `withTenantTransactionRepeatableRead`, with a `withTenantTransaction` (READ COMMITTED) control that observes the scrubbed rows on the identical interleaving -- run three times consecutively, all green.

## Task Commits

Each task was committed atomically (TDD RED/GREEN, per plan frontmatter `tdd="true"`):

1. **Task 1+2 RED: sends + sendEvents failing tests** - `ce35125` (test) -- 10 new cases added to `dsr-export.test.ts`, all failing for the expected reason (`body.sends` undefined); all 13 pre-existing cases stayed green.
2. **Task 1+2 GREEN: sends + sendEvents export sections** - `b909168` (feat) -- `selectSendsPage`/`selectSendEventsPage` in the repository, `dsrExportSendSchema`/`dsrExportSendEventSchema` in shared-schemas; all 23 cases pass.
3. **Task 3: D-15/SC5 isolation proof** - `df2a196` (test) -- new `dsr-export-isolation.test.ts`, 3 cases, run 3 consecutive times green.

**Plan metadata:** (this commit, pending)

## Files Created/Modified
- `apps/api/src/modules/contacts/dsr-export.repository.ts` - Adds `selectSendsPage`, `selectSendEventsPage` (with `buildExportSendEventPayload` applied inside the reader), grouping of send events by parent send, and `sends`/`sendEvents` section-row counts.
- `packages/shared-schemas/src/dsr-export.ts` - Adds `dsrExportSendSchema`, `dsrExportSendEventSchema`, nests `sends` in `dsrExportDocumentSchema`.
- `apps/api/src/modules/contacts/__tests__/dsr-export.test.ts` - Adds 10 new cases for the sends/sendEvents sections and the SC4 allowlist proof; gives the file's `signUp` helper a unique `remoteAddress` per call so the added sign-ups do not trip the `/api/auth/*` 20 req/min per-IP rate limit.
- `apps/api/src/modules/contacts/__tests__/dsr-export-isolation.test.ts` - New file; the D-15/SC5 mid-scrub race proof and its READ COMMITTED negative control.

## Decisions Made
- `buildExportSendEventPayload` is applied inside `selectSendEventsPage` (not at the `getDsrExportDocument` assembly layer) so a raw `payload` value structurally cannot reach the document from any call site -- the strongest form of the plan's prohibition, and it does not weaken Task 3's assertions since `useragent` sits on the export allowlist either way.
- `selectSendEventsPage` returns an extra `sendId` field (via the exported `SendEventPageRow` type) alongside the export-shaped fields so `getDsrExportDocument` can group the whole-contact walk by parent send without a second query; `sendId` is destructured off before the entry is nested under `sends[].sendEvents`.
- The isolation test's simulated scrub runs on a `createTestPool()` connection this test file owns, never importing from `apps/worker` -- it reproduces the worker's exact per-row `UPDATE` shape using the shared `buildScrubbedSendEventPayload` from `@mega-crm/delivery-core`, which is the actual production code path, not an approximation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking, minor] `stop-grace-period-publish.test.ts` in apps/worker needed a fresh build**
- **Found during:** the plan's overall `<verification>` run of `npm run test -w apps/worker`
- **Issue:** the test imports `apps/worker/dist/shutdown-budget.js`, which did not exist yet in this fresh worktree checkout
- **Fix:** ran `npm run build -w apps/worker` (build artifact only, no source change)
- **Files modified:** none (generated `dist/` is gitignored, not committed)
- **Verification:** re-ran the full `apps/worker` suite; that test passed afterward
- **Committed in:** N/A (no source change to commit)

---

**Total deviations:** 1 auto-fixed (1 blocking, build-artifact only)
**Impact on plan:** No scope creep -- this was environment setup, not a code change.

### Literal acceptance-gate discrepancies (documented, not "fixed")

**1. Task 1's acceptance criterion `grep -c 'withTenantTransactionRepeatableRead' dsr-export.repository.ts` is 1**

The file's actual literal count is **3** (the `import` line, a doc-comment mention at the top of `getDsrExportDocument`, and the one call site) -- all three pre-date this plan (added by 21-01/21-03). This plan added **zero** new occurrences of the literal. The intent behind the gate -- "the export still opens exactly one repeatable-read transaction" -- holds: `grep -c 'withTenantTransactionRepeatableRead('` (call-sites only, matching the open paren) is exactly `1`. Not changed to force the literal gate to `1`, per instruction not to delete an import or comment just to satisfy a stale count.

**2. Task 3's acceptance criterion `grep -c 'pg_sleep' dsr-export-isolation.test.ts` is 0**

An early draft of the file's header comment mentioned "no timers, no pg_sleep" in prose, which the literal grep would have counted as `1`. Reworded to "no timers, no artificial DB delay" before the final commit -- `grep -c 'pg_sleep'` is `0` in the committed file, and the file genuinely contains neither `setTimeout` nor `pg_sleep` anywhere, so the underlying claim (deterministic sequencing, no timing dependence) is unaffected.

## Issues Encountered
- Worktree isolation (#3097-class issue, per this repo's known pattern): a fresh worktree's `@mega-crm/*` bare imports resolve up into the main checkout's stale copies unless `node_modules/@mega-crm/*` symlinks point at this worktree's own `packages/*`. Created the 11 symlinks at session start, removed them before returning (see below).
- `apps/worker`'s `src/queues/__tests__/failure-injection/erasure-enqueue-crash.test.ts` fails deterministically in this environment (`No tenant context set for this request` instead of the expected `/INJECTED FAILURE/` match), reproduced in isolation, unrelated to any file this plan touches (last modified by a Phase 13 commit, `70e3c20`). Out of scope per the SCOPE BOUNDARY rule -- not fixed, logged here rather than in `.planning/WINDOWS.md` (this worktree does not force-add that ledger, per this repo's standing instruction) or a separate `deferred-items.md` (kept the durable record in this SUMMARY instead, to avoid an extra gitignored artifact competing with the ledger on merge).
- `apps/api`'s and `apps/worker`'s `sentry.test.ts` "no DSN configured" cases fail deterministically on this machine (real DSNs live in `~/.config/mega-crm/.env` since UAT) -- pre-existing, environmental, documented in this repo's own operating notes; passes in CI.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `sends`/`sendEvents` are the last multi-row export sections named in the phase's document-growth plan; `21-06` is scoped to `SPECIFICATION.md` updates and does not touch this repository/schema code.
- The export document now covers: `metadata`, `profile`, `customProperties`, `consentHistory`, `events`, `sends` (with nested `sendEvents`) -- DSR-01 and DSR-02 are fully covered by this plan and its predecessors; DSR-03's JSONB bound is proven for both `events.properties` (21-03, empty by construction) and `send_events.payload` (this plan, allowlist-bounded with a synthetic-field proof).
- Phase 22 (Workspace Quiesce & Physical Purge) can reuse `SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST`/`SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST` from `@mega-crm/delivery-core` as the same shared definition this plan's isolation test already exercises against the real worker's update shape -- no new allowlist should be invented there.

## Self-Check: PASSED

All claimed files verified present on disk (`dsr-export.repository.ts`, `packages/shared-schemas/src/dsr-export.ts`, `dsr-export.test.ts`, `dsr-export-isolation.test.ts`, this SUMMARY). All claimed commit hashes verified present in `git log` (`ce35125`, `b909168`, `df2a196`).

---
*Phase: 21-per-contact-dsr-export*
*Completed: 2026-08-22*
