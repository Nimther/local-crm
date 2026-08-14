---
schema_version: 1
open_count: 5
waived_count: 0
fixed_count: 3
total_count: 8
last_updated: 2026-08-11T20:30:09.687Z
---

# Broken Windows Ledger

> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 12 | deviation | .planning/WINDOWS.md |  | Ledger loss record: the pre-phase-12 WINDOWS.md (5 entries) was clobbered when 12-10's worktree force-committed a fresh ledger (commit 272ecc1) that overwrote the untracked main-repo file on merge. Original entry id 1 (pre-2026-08-07) is unrecoverable; entries 2-5 reconstructed below from orchestrator session output. | open |  | 2026-08-10T19:00:00.000Z |  |
| 2 | 10 | unrun-verify |  |  | npm run test:e2e fails to load Playwright config in this sandbox (ERR_MODULE_NOT_FOUND on a .ts deep-specifier under Node v26). Reproduced identically with plan 10-09's changes fully stashed -- pre-existing environment gap, not caused by this plan. See deferred-items.md. [reconstructed after ledger clobber; original kind/file fields lost] | open |  | 2026-08-07T19:38:44.565Z |  |
| 3 | 11 | deviation | packages/db/scripts/audit-sends-history.ts |  | Plan 11-02 deviated from literal single-DATABASE_URL design; uses SCAN_DATABASE_URL + rollback-only per-workspace loop instead (documented in 11-02-SUMMARY.md Deviations) | open |  | 2026-08-09T10:21:28.109Z |  |
| 4 | 12 | deviation | apps/worker/src/queues/__tests__/tenant-deferral.test.ts |  | Repo-root lint regressed: 16 @typescript-eslint/unbound-method errors from 12-01's fake Job/Worker spy assertions (commits ffcbec1/c185ddb), surfaced during 12-02. Fixed post-wave-2 by orchestrator (commit 105d30e) with rule-scoped file-level eslint-disable directives matching the pre-send-gate.test.ts precedent; repo lint exit 0 re-verified. [reconstructed after ledger clobber] | fixed |  | 2026-08-10T13:00:00.000Z | 2026-08-10T13:00:00.000Z |
| 5 | 12 | unrun-verify | apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts |  | Timing flake under full-suite parallel load: waitFor 10s timeout when other suites contend on shared Redis (failed once in wave-4 post-merge gate; passed in isolation and on full re-run). Same family as webhooks-signature.test.ts contamination noted in 12-11-SUMMARY.md. Candidate for a shared-Redis isolation fix. [reconstructed after ledger clobber] | open |  | 2026-08-10T18:00:00.000Z |  |
| 6 | 12 | lint-warning | apps/worker/src/__tests__/graceful-shutdown.test.ts |  | Pre-existing require-await lint errors from plan 12-08 (4 in graceful-shutdown.test.ts, 7 in shared-error-listener.test.ts); out of scope for 12-10, discovered while running repo-wide lint | fixed |  | 2026-08-10T16:45:27.906Z | 2026-08-10T16:52:08.272Z |
| 7 | 12 | lint-warning | apps/worker/src/__tests__/graceful-shutdown.test.ts |  | 11 @typescript-eslint/require-await errors from 12-08's test stubs (async () => undefined and awaitless async mockImplementations), flagged by 12-10's executor. Fixed by orchestrator post-wave-6 with explicit Promise.resolve stubs; repo lint exit 0 re-verified. | fixed |  | 2026-08-10T16:52:08.272Z | 2026-08-10T16:52:08.272Z |
| 8 | 13 | skipped-test | packages/redaction/src/__tests__/scrub-identifier-false-positive.test.ts |  | NOT skipped, but probabilistically flaky (closest allowed kind): Test 3 samples 5000 random v4 UUIDs against the phone valueRule; an all-digit-group UUID (e.g. 17240210-0546-4077-9954-207876832048) still gets redacted despite the 3cd3f0c anchoring fix. Failed once in Phase 13 wave-3 post-merge gate, passed 3/3 on re-run; package untouched by Phase 13 (pre-existing). Fix direction: exclude UUID-shaped values before the phone rule, or seed the sampler. | open |  | 2026-08-11T20:30:09.687Z |  |

````json
[
  {
    "id": 1,
    "kind": "deviation",
    "phase": "12",
    "file": ".planning/WINDOWS.md",
    "line": null,
    "description": "Ledger loss record: the pre-phase-12 WINDOWS.md (5 entries) was clobbered when 12-10's worktree force-committed a fresh ledger (commit 272ecc1) that overwrote the untracked main-repo file on merge. Original entry id 1 (pre-2026-08-07) is unrecoverable; entries 2-5 reconstructed below from orchestrator session output.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-10T19:00:00.000Z",
    "resolved_at": null
  },
  {
    "id": 2,
    "kind": "unrun-verify",
    "phase": "10",
    "file": "",
    "line": null,
    "description": "npm run test:e2e fails to load Playwright config in this sandbox (ERR_MODULE_NOT_FOUND on a .ts deep-specifier under Node v26). Reproduced identically with plan 10-09's changes fully stashed -- pre-existing environment gap, not caused by this plan. See deferred-items.md. [reconstructed after ledger clobber; original kind/file fields lost]",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-07T19:38:44.565Z",
    "resolved_at": null
  },
  {
    "id": 3,
    "kind": "deviation",
    "phase": "11",
    "file": "packages/db/scripts/audit-sends-history.ts",
    "line": null,
    "description": "Plan 11-02 deviated from literal single-DATABASE_URL design; uses SCAN_DATABASE_URL + rollback-only per-workspace loop instead (documented in 11-02-SUMMARY.md Deviations)",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-09T10:21:28.109Z",
    "resolved_at": null
  },
  {
    "id": 4,
    "kind": "deviation",
    "phase": "12",
    "file": "apps/worker/src/queues/__tests__/tenant-deferral.test.ts",
    "line": null,
    "description": "Repo-root lint regressed: 16 @typescript-eslint/unbound-method errors from 12-01's fake Job/Worker spy assertions (commits ffcbec1/c185ddb), surfaced during 12-02. Fixed post-wave-2 by orchestrator (commit 105d30e) with rule-scoped file-level eslint-disable directives matching the pre-send-gate.test.ts precedent; repo lint exit 0 re-verified. [reconstructed after ledger clobber]",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-10T13:00:00.000Z",
    "resolved_at": "2026-08-10T13:00:00.000Z"
  },
  {
    "id": 5,
    "kind": "unrun-verify",
    "phase": "12",
    "file": "apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts",
    "line": null,
    "description": "Timing flake under full-suite parallel load: waitFor 10s timeout when other suites contend on shared Redis (failed once in wave-4 post-merge gate; passed in isolation and on full re-run). Same family as webhooks-signature.test.ts contamination noted in 12-11-SUMMARY.md. Candidate for a shared-Redis isolation fix. [reconstructed after ledger clobber]",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-10T18:00:00.000Z",
    "resolved_at": null
  },
  {
    "id": 6,
    "kind": "lint-warning",
    "phase": "12",
    "file": "apps/worker/src/__tests__/graceful-shutdown.test.ts",
    "line": null,
    "description": "Pre-existing require-await lint errors from plan 12-08 (4 in graceful-shutdown.test.ts, 7 in shared-error-listener.test.ts); out of scope for 12-10, discovered while running repo-wide lint",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-10T16:45:27.906Z",
    "resolved_at": "2026-08-10T16:52:08.272Z"
  },
  {
    "id": 7,
    "kind": "lint-warning",
    "phase": "12",
    "file": "apps/worker/src/__tests__/graceful-shutdown.test.ts",
    "line": null,
    "description": "11 @typescript-eslint/require-await errors from 12-08's test stubs (async () => undefined and awaitless async mockImplementations), flagged by 12-10's executor. Fixed by orchestrator post-wave-6 with explicit Promise.resolve stubs; repo lint exit 0 re-verified.",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-10T16:52:08.272Z",
    "resolved_at": "2026-08-10T16:52:08.272Z"
  },
  {
    "id": 8,
    "kind": "skipped-test",
    "phase": "13",
    "file": "packages/redaction/src/__tests__/scrub-identifier-false-positive.test.ts",
    "line": null,
    "description": "NOT skipped, but probabilistically flaky (closest allowed kind): Test 3 samples 5000 random v4 UUIDs against the phone valueRule; an all-digit-group UUID (e.g. 17240210-0546-4077-9954-207876832048) still gets redacted despite the 3cd3f0c anchoring fix. Failed once in Phase 13 wave-3 post-merge gate, passed 3/3 on re-run; package untouched by Phase 13 (pre-existing). Fix direction: exclude UUID-shaped values before the phone rule, or seed the sampler.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-11T20:30:09.687Z",
    "resolved_at": null
  }
]
````
