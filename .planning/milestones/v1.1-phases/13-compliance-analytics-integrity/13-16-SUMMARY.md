---
phase: 13-compliance-analytics-integrity
plan: 16
subsystem: db, worker, docs
tags: [compliance, retention, erasure, quarantine, gap-closure, cmp-04]
status: complete
dependency-graph:
  requires: [13-01, 13-04, 13-06, 13-14]
  provides:
    - packages/db/src/webhooks/quarantine.ts (pruneSendEventQuarantine, SEND_EVENT_QUARANTINE_RETENTION_DAYS)
    - apps/worker/src/queues/webhook-replay-sweep.worker.ts (quarantineRowsPruned tick-summary field, quarantineRetentionDays option)
  affects:
    - apps/worker/src/queues/erasure-scrub.worker.ts (scope-boundary comment only, no behavior change)
    - SPECIFICATION.md §4.2/§5.13
    - ARCHITECTURE.md §12
tech-stack:
  added: []
  patterns:
    - "Age-out DELETE keyed on a server-observed column only, mirroring pruneIngressJournal's interval/rowCount shape"
key-files:
  created:
    - packages/db/src/__tests__/quarantine-retention.test.ts
  modified:
    - packages/db/src/webhooks/quarantine.ts
    - apps/worker/src/queues/webhook-replay-sweep.worker.ts
    - apps/worker/src/queues/__tests__/webhook-replay-sweep.test.ts
    - apps/worker/src/queues/erasure-scrub.worker.ts
    - SPECIFICATION.md
    - ARCHITECTURE.md
    - .planning/REQUIREMENTS.md
decisions:
  - "SEND_EVENT_QUARANTINE_RETENTION_DAYS = 7, equal to and independently settable from INGRESS_JOURNAL_RETENTION_DAYS -- both tables from migration 0055, same erasure-scrub exemption argument"
  - "Plain age-out DELETE for send_event_quarantine, not the journal's prune/purge/tombstone split -- a quarantined event is terminal with no replay value and no cross-workspace reader"
  - "quarantineRowsPruned reported as its own never-summed tick-summary field, third retention call inside the same per-workspace transaction, no new queue/scheduler/worker/env var"
metrics:
  duration: ~15min
  tasks: 3
  files: 7
  completed: 2026-08-12
---

# Phase 13 Plan 16: Quarantine Retention (CMP-04 Gap Closure) Summary

Age-out retention for `send_event_quarantine` on the existing `webhook-replay-sweep` tick, keyed on `received_at` only — closes 13-VERIFICATION.md Gap #1, the last blocking gap in Phase 13.

## What was built

**Task 1 — `pruneSendEventQuarantine` (packages/db):** the disposal counterpart to plan 13-01's insert-only `writeQuarantinedEvent`. `SEND_EVENT_QUARANTINE_RETENTION_DAYS = 7` (exported constant, rationale comment carrying all four required points: equal to `INGRESS_JOURNAL_RETENTION_DAYS`, states the CMP-04 erasure-scrub exemption argument in full, not shorter than `OCCURRED_AT_MAX_PAST_DAYS`, falsifiable if raised). `pruneSendEventQuarantine(client, retentionDays)` — one `DELETE ... WHERE received_at < now() - make_interval(days => $1)`, returns `rowCount ?? 0`, mirroring `pruneIngressJournal`'s exact shape. New test file `quarantine-retention.test.ts`, 10 cases: expired-deleted, fresh-kept, ancient-`occurred_at_candidate`-survives, ancient-provider-`timestamp`-in-`raw_event`-survives, mixed 3-expired/2-fresh, idempotent second call, cross-workspace isolation, `ingress_journal` rows left untouched (both completed and incomplete), independently-settable horizons, and constant-equality assertion via import (not literal comparison).

**Task 2 — wired into the existing tick (apps/worker):** `pruneSendEventQuarantine` called inside `runWorkspaceTick`'s existing `withTenant`/`withTenantTransaction` scope, immediately after both journal retention calls (replay → journal-prune → journal-purge → quarantine-prune ordering preserved). `quarantineRetentionDays` threaded through `WorkspaceTickThresholds`/`RunWebhookReplaySweepOptions` as a separate option from `retentionDays` (default `SEND_EVENT_QUARANTINE_RETENTION_DAYS`), `quarantineRowsPruned` added to `WorkspaceTickResult`/`WebhookReplaySweepTickSummary` as its own never-summed field. No new queue, scheduler id, worker, or environment variable — `upsertJobScheduler(` still has exactly one call site. 7 new test cases in `webhook-replay-sweep.test.ts` covering the full Task 2 behavior list; all 59 tests in that file plus `scheduler-registration.test.ts` pass; `npm run build --workspace=apps/worker` exits 0.

**Task 3 — documentation sync (same change, per `.claude/CLAUDE.md`'s binding rule):** `erasure-scrub.worker.ts` gains a comment-only scope-boundary note naming both retention constants and the falsifiability condition (`git diff` on this file shows comment lines only). `SPECIFICATION.md` §4.2's `send_event_quarantine` paragraph no longer ends on the "no caller wired" note — names plan 13-04 as the writer's caller and records the retention mechanism/horizon, cross-referencing §5.13. §5.13's retention-step bullet now names three calls; tick-summary bullet enumerates `quarantineRowsPruned`; new `quarantineRetentionDays` test-only override documented. `ARCHITECTURE.md` §12's "Deliberately NOT scrubbed" paragraph now states HOW both tables self-prune (same tick, equal horizons, delete vs. tombstone) plus the falsifiability condition; closing pointer line adds §5.13.

## Verification

- `npx vitest run --root packages/db src/__tests__/quarantine-retention.test.ts` — 10/10 pass.
- `npx vitest run --root apps/worker src/queues/__tests__/webhook-replay-sweep.test.ts src/queues/__tests__/scheduler-registration.test.ts` — 59/59 pass.
- `npm run build --workspace=apps/worker` — exit 0.
- `npm run lint:migrations` — 62 files checked, no violations (unchanged count; no migration touched).
- `npm run test:migrations` — 138/138 pass (full `packages/db` suite, 17 files).
- `npm run lint` — exit 0.
- `git diff --quiet -- packages/db/migrations` — exit 0 (no migration file added or edited).
- `grep -c "upsertJobScheduler(" apps/worker/src/queues/webhook-replay-sweep.worker.ts` → `1`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Worktree had no `node_modules`; bare-specifier `@mega-crm/*` imports silently resolved to the main checkout, not this worktree's own code**

- **Found during:** Task 2 RED phase. A sanity-check test importing `SEND_EVENT_QUARANTINE_RETENTION_DAYS` from `@mega-crm/db/src/webhooks/quarantine.js` (a bare package specifier, used throughout `webhook-replay-sweep.worker.ts` for its existing `ingress-journal.js` import) returned `undefined` even though Task 1 had already committed the export.
- **Root cause:** this worktree (`git worktree add`-created) had no `node_modules` of its own anywhere in the tree — confirmed via `find <worktree>/node_modules`, `find <worktree>/packages/db/node_modules/@mega-crm`, etc., all empty except Vite cache dirs. Node's ESM resolver for bare specifiers walks up parent filesystem directories looking for `node_modules`; since the worktree is nested inside the main repo checkout (`.claude/worktrees/<id>/` under `/Users/.../mega-crm/`), resolution escaped past the worktree entirely and found `/Users/.../mega-crm/node_modules/@mega-crm/db`, a symlink to the **main checkout's own** `packages/db` — which does not have this plan's commits. Every bare-specifier cross-package import in this worktree (not relative imports — those correctly resolve to the worktree's own files) was silently testing the main branch's code instead of this worktree's.
- **Fix:** ran `npm install --workspaces --prefer-offline --no-audit --no-fund` inside the worktree root. This created the worktree's own `node_modules/@mega-crm/db -> ../../packages/db` symlink (relative, so it correctly points at the worktree's own `packages/db`), fixing resolution for all subsequent bare-specifier imports without touching `package-lock.json` (`node_modules` is gitignored; `git status --short` after install showed no tracked-file changes).
- **Verification:** re-ran the sanity check — `SEND_EVENT_QUARANTINE_RETENTION_DAYS` resolved to `7` correctly afterward. Re-ran Task 1's own test suite (which uses relative imports and was unaffected) to confirm no regression: still 10/10 pass.
- **Files modified:** none tracked (only `node_modules`, gitignored).
- **Impact for other parallel executors in this wave:** any worktree agent testing a **new** cross-package export via a bare `@mega-crm/*` specifier will hit the same silent-stale-import trap if its worktree has no `node_modules` yet. A relative import inside the same package is unaffected. Recommend the orchestrator note this for future worktree spawns, or run `npm install --workspaces` once per fresh worktree before executor tasks that add new cross-package exports.

No other deviations. Plan executed as written otherwise.

## Requirement Traceability (CMP-04)

- **Checkbox marked complete** in `.planning/REQUIREMENTS.md` (via `requirements mark-complete`) — this plan's scoped work (all three artifacts 13-VERIFICATION.md's Gap #1 named) is done: `pruneSendEventQuarantine` exists with its own independently-settable horizon, it runs on the existing tick, and `erasure-scrub.worker.ts`'s exclusion of the table is now a recorded, falsifiable decision.
- **Traceability table row left `Gaps Found`** (the tool reported `applied: false` for that surface) — that row is owned by phase-level re-verification of `13-VERIFICATION.md`, not by this plan. It should flip once re-verification confirms Gap #1's three `artifacts:` complaints are answered (see plan's own `<verification>` section).
- **Human-check deferred to end-of-phase** (`human_verify_mode=end-of-phase`, per the plan's `<verification>` section): delete a contact with a webhook event that produced a `send_event_quarantine` row, confirm the row survives erasure (by design) and is gone after the retention horizon passes, with no manual SQL. Appended to the 13-14 checklist's step 4 rather than replacing it — not performed by this executor.

## WINDOWS.md Ledger

Skipped per worktree prohibition (writing/force-adding `.planning/WINDOWS.md` in a worktree would clobber the main checkout's ledger on merge). No open defects to record regardless — no stubs, no skipped tests, no unrun `<verify>` blocks; every automated verification in this plan actually ran and passed.

## Known Stubs

None.

## Threat Flags

None. `erasure-scrub.worker.ts`'s change is comment-only (verified via `git diff` showing comment lines only) — no new surface. T-13-16-01 (unbounded PII retention), T-13-16-02 (provider-timestamp tampering), T-13-16-04 (cross-tenant reach), and T-13-16-05 (silent retention) from this plan's `<threat_model>` are all mitigated by the implementation and pinned by the Task 1/2 test suites. T-13-16-03 (unbounded single-statement DELETE) is an accepted risk per the plan, documented in `pruneSendEventQuarantine`'s own doc comment.

## Self-Check

- `packages/db/src/webhooks/quarantine.ts` — FOUND (contains `SEND_EVENT_QUARANTINE_RETENTION_DAYS`, `pruneSendEventQuarantine`).
- `packages/db/src/__tests__/quarantine-retention.test.ts` — FOUND.
- `apps/worker/src/queues/webhook-replay-sweep.worker.ts` — FOUND (contains `quarantineRowsPruned`, `pruneSendEventQuarantine(`).
- `apps/worker/src/queues/erasure-scrub.worker.ts` — FOUND (contains `SEND_EVENT_QUARANTINE_RETENTION_DAYS` in comment).
- `SPECIFICATION.md` — FOUND (contains `pruneSendEventQuarantine`, `quarantineRowsPruned`).
- `ARCHITECTURE.md` — FOUND (§12 pointer line lists §5.13).
- Commits `4369a14`, `1fb6265`, `ea01d66`, `b52926f`, `700eed7` — all present in `git log` on branch `worktree-agent-ac80cf554eab30ae6`.

## Self-Check: PASSED
