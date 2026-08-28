---
schema_version: 1
open_count: 4
waived_count: 3
fixed_count: 7
total_count: 14
last_updated: 2026-08-28T12:14:21.112Z
---

# Broken Windows Ledger

> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 12 | deviation | .planning/WINDOWS.md |  | Ledger loss record: the pre-phase-12 WINDOWS.md (5 entries) was clobbered when 12-10's worktree force-committed a fresh ledger (commit 272ecc1) that overwrote the untracked main-repo file on merge. Original entry id 1 (pre-2026-08-07) is unrecoverable; entries 2-5 reconstructed below from orchestrator session output. | waived | Un-fixable tombstone: pre-phase-12 ledger loss is documented in the entry itself and unrecoverable; recurrence structurally closed — WINDOWS.md is git-tracked and executor prompts forbid force-adding a fresh ledger. Approved by developer 2026-08-25 (quick 260825-qhm audit). | 2026-08-10T19:00:00.000Z | 2026-08-25T14:40:23.354Z |
| 2 | 10 | unrun-verify |  |  | npm run test:e2e fails to load Playwright config in this sandbox (ERR_MODULE_NOT_FOUND on a .ts deep-specifier under Node v26). Reproduced identically with plan 10-09's changes fully stashed -- pre-existing environment gap, not caused by this plan. See deferred-items.md. [reconstructed after ledger clobber; original kind/file fields lost] | fixed |  | 2026-08-07T19:38:44.565Z | 2026-08-25T14:25:56.505Z |
| 3 | 11 | deviation | packages/db/scripts/audit-sends-history.ts |  | Plan 11-02 deviated from literal single-DATABASE_URL design; uses SCAN_DATABASE_URL + rollback-only per-workspace loop instead (documented in 11-02-SUMMARY.md Deviations) | waived | Consciously accepted deviation: SCAN_DATABASE_URL + rollback-only per-workspace loop documented in 11-02-SUMMARY.md Deviations and still shipped as designed (audit-sends-history.ts:220). Approved by developer 2026-08-25 (quick 260825-qhm audit). | 2026-08-09T10:21:28.109Z | 2026-08-25T14:40:23.626Z |
| 4 | 12 | deviation | apps/worker/src/queues/__tests__/tenant-deferral.test.ts |  | Repo-root lint regressed: 16 @typescript-eslint/unbound-method errors from 12-01's fake Job/Worker spy assertions (commits ffcbec1/c185ddb), surfaced during 12-02. Fixed post-wave-2 by orchestrator (commit 105d30e) with rule-scoped file-level eslint-disable directives matching the pre-send-gate.test.ts precedent; repo lint exit 0 re-verified. [reconstructed after ledger clobber] | fixed |  | 2026-08-10T13:00:00.000Z | 2026-08-10T13:00:00.000Z |
| 5 | 12 | unrun-verify | apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts |  | Timing flake under full-suite parallel load: waitFor 10s timeout when other suites contend on shared Redis (failed once in wave-4 post-merge gate; passed in isolation and on full re-run). Same family as webhooks-signature.test.ts contamination noted in 12-11-SUMMARY.md. Candidate for a shared-Redis isolation fix. [reconstructed after ledger clobber] | fixed |  | 2026-08-10T18:00:00.000Z | 2026-08-28T12:14:21.112Z |
| 6 | 12 | lint-warning | apps/worker/src/__tests__/graceful-shutdown.test.ts |  | Pre-existing require-await lint errors from plan 12-08 (4 in graceful-shutdown.test.ts, 7 in shared-error-listener.test.ts); out of scope for 12-10, discovered while running repo-wide lint | fixed |  | 2026-08-10T16:45:27.906Z | 2026-08-10T16:52:08.272Z |
| 7 | 12 | lint-warning | apps/worker/src/__tests__/graceful-shutdown.test.ts |  | 11 @typescript-eslint/require-await errors from 12-08's test stubs (async () => undefined and awaitless async mockImplementations), flagged by 12-10's executor. Fixed by orchestrator post-wave-6 with explicit Promise.resolve stubs; repo lint exit 0 re-verified. | fixed |  | 2026-08-10T16:52:08.272Z | 2026-08-10T16:52:08.272Z |
| 8 | 13 | skipped-test | packages/redaction/src/__tests__/scrub-identifier-false-positive.test.ts |  | NOT skipped, but probabilistically flaky (closest allowed kind): Test 3 samples 5000 random v4 UUIDs against the phone valueRule; an all-digit-group UUID (e.g. 17240210-0546-4077-9954-207876832048) still gets redacted despite the 3cd3f0c anchoring fix. Failed once in Phase 13 wave-3 post-merge gate, passed 3/3 on re-run; package untouched by Phase 13 (pre-existing). Fix direction: exclude UUID-shaped values before the phone rule, or seed the sampler. | open |  | 2026-08-11T20:30:09.687Z |  |
| 9 | 17 | deviation | .planning/phases/17-address-tech-debt-wr-06-medium-security-follow-ups/17-05-PLAN.md |  | Task 1 acceptance text 'failed_count is 0 in both reads' / must_haves truth #2 unsatisfiable against real cumulative pg_stat_archiver history; superseded by ratified corrected WAL criterion (archived_count strictly increases, failed_count unchanged from baseline, last_failed unmoved) -- see 17-05-SUMMARY.md | open |  | 2026-08-19T19:35:29.693Z |  |
| 10 | 17 | deviation | .planning/phases/17-address-tech-debt-wr-06-medium-security-follow-ups/17-CONTEXT.md |  | D-11 amended from verify-still-running to establish-then-verify: alloy was never durably deployed to production (deploy.sh never issues the compose up -d that would create it; 15-UAT test 5 was a bare unevidenced pass); operator provisioned Loki credentials and started alloy live during this plan's checkpoint -- see 17-05-SUMMARY.md | open |  | 2026-08-19T19:35:43.284Z |  |
| 11 | 17 | deviation | docker/postgres/Dockerfile |  | pgBackRest patch-level drift (2.59.1 vs docs/runbooks/backups.md's documented 2.59.0) ratified as expected, not a defect -- unpinned apt-get install pgbackrest against pgdg; T-14-58/T-14-88 are provenance/tag-immutability threats, not apt-reproducibility ones; cross-version restore proof landed live -- see 17-05-SUMMARY.md | waived | Ratified expected drift: pgBackRest 2.59.1 vs documented 2.59.0 ratified in 17-05-SUMMARY.md with live cross-version restore proof; docs/runbooks/backups.md already corrected. Approved by developer 2026-08-25 (quick 260825-qhm audit). | 2026-08-19T19:35:43.551Z | 2026-08-25T14:40:23.893Z |
| 12 | 17 | deviation | scripts/deploy.sh |  | Leg-isolation defect discovered by operator dry-run during this plan's live checkpoint: mutating compose calls (up -d web api / run --rm migrate / up -d worker) implicitly recreated db/redis via dependency convergence without --no-deps -- an ungated db cutover hidden inside the routine app-deploy path. Fixed and merged (PR #17, TDD RED 393a004 -> GREEN 3de6771) as a phase-17 orchestrator-side fix, not authored by this plan -- see 17-05-SUMMARY.md | fixed |  | 2026-08-19T19:35:43.817Z | 2026-08-25T14:25:49.623Z |
| 13 | 17 | deviation | apps/web/vite.config.ts |  | charts-vendor/canvas-vendor static import-cycle crash (advancedChunks.includeDependenciesRecursively: false, phase 15 plan 03) broke the dashboard growth chart and the flow editor in every production build since 2026-08-15; discovered by this plan's Task 1 step 7. Fixed with strictExecutionOrder: true and a wired check-web-chunks CI gate (PR #16, commits bd8a66c/2f77147), a phase-17 orchestrator-side fix, not authored by this plan -- see 17-05-SUMMARY.md | fixed |  | 2026-08-19T19:35:44.077Z | 2026-08-25T14:25:53.076Z |
| 14 | 12 | deviation | packages/test-support/src/global-setup.ts |  | Deliberately deferred recurrence guard (kind 'deviation' = consciously accepted deferral, closest allowed kind) from debug session flow-run-advance-shared-redis, whose H1 fix (commit 3e9941e) closed entry id 5 for ONE queue only. The harness isolates Postgres per run but never Redis: every worker/api test process points at one shared logical DB (redis://localhost:6379/1) with no per-run BullMQ prefix and no cleanup anywhere, so BullMQ jobs survive run to run without bound -- measured 2026-08-28: 21973 waiting webhook-events jobs, 3180 flow-trigger-evaluator, 2911 email-triggered, 2881 erasure-scrub. That residue is inert only because no test consumes those queues; the moment any test registers a real Worker on one it inherits the whole backlog as serial workload, which is exactly how id 5 flaked. Class-level guard: a fail-closed test-Redis cleanup in global-setup.ts mirroring the fail-closed test-DATABASE guard already there -- refuse to run unless the resolved Redis URL names an explicit logical DB index >= 1 (never db 0, the dev worker's), then clear it once per run. Scoped out of 3e9941e deliberately to keep that fix minimal and reviewable. | open |  | 2026-08-28T10:42:35.798Z |  |

````json
[
  {
    "id": 1,
    "kind": "deviation",
    "phase": "12",
    "file": ".planning/WINDOWS.md",
    "line": null,
    "description": "Ledger loss record: the pre-phase-12 WINDOWS.md (5 entries) was clobbered when 12-10's worktree force-committed a fresh ledger (commit 272ecc1) that overwrote the untracked main-repo file on merge. Original entry id 1 (pre-2026-08-07) is unrecoverable; entries 2-5 reconstructed below from orchestrator session output.",
    "status": "waived",
    "reason": "Un-fixable tombstone: pre-phase-12 ledger loss is documented in the entry itself and unrecoverable; recurrence structurally closed — WINDOWS.md is git-tracked and executor prompts forbid force-adding a fresh ledger. Approved by developer 2026-08-25 (quick 260825-qhm audit).",
    "recorded_at": "2026-08-10T19:00:00.000Z",
    "resolved_at": "2026-08-25T14:40:23.354Z"
  },
  {
    "id": 2,
    "kind": "unrun-verify",
    "phase": "10",
    "file": "",
    "line": null,
    "description": "npm run test:e2e fails to load Playwright config in this sandbox (ERR_MODULE_NOT_FOUND on a .ts deep-specifier under Node v26). Reproduced identically with plan 10-09's changes fully stashed -- pre-existing environment gap, not caused by this plan. See deferred-items.md. [reconstructed after ledger clobber; original kind/file fields lost]",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-07T19:38:44.565Z",
    "resolved_at": "2026-08-25T14:25:56.505Z"
  },
  {
    "id": 3,
    "kind": "deviation",
    "phase": "11",
    "file": "packages/db/scripts/audit-sends-history.ts",
    "line": null,
    "description": "Plan 11-02 deviated from literal single-DATABASE_URL design; uses SCAN_DATABASE_URL + rollback-only per-workspace loop instead (documented in 11-02-SUMMARY.md Deviations)",
    "status": "waived",
    "reason": "Consciously accepted deviation: SCAN_DATABASE_URL + rollback-only per-workspace loop documented in 11-02-SUMMARY.md Deviations and still shipped as designed (audit-sends-history.ts:220). Approved by developer 2026-08-25 (quick 260825-qhm audit).",
    "recorded_at": "2026-08-09T10:21:28.109Z",
    "resolved_at": "2026-08-25T14:40:23.626Z"
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
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-10T18:00:00.000Z",
    "resolved_at": "2026-08-28T12:14:21.112Z"
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
  },
  {
    "id": 9,
    "kind": "deviation",
    "phase": "17",
    "file": ".planning/phases/17-address-tech-debt-wr-06-medium-security-follow-ups/17-05-PLAN.md",
    "line": null,
    "description": "Task 1 acceptance text 'failed_count is 0 in both reads' / must_haves truth #2 unsatisfiable against real cumulative pg_stat_archiver history; superseded by ratified corrected WAL criterion (archived_count strictly increases, failed_count unchanged from baseline, last_failed unmoved) -- see 17-05-SUMMARY.md",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-19T19:35:29.693Z",
    "resolved_at": null
  },
  {
    "id": 10,
    "kind": "deviation",
    "phase": "17",
    "file": ".planning/phases/17-address-tech-debt-wr-06-medium-security-follow-ups/17-CONTEXT.md",
    "line": null,
    "description": "D-11 amended from verify-still-running to establish-then-verify: alloy was never durably deployed to production (deploy.sh never issues the compose up -d that would create it; 15-UAT test 5 was a bare unevidenced pass); operator provisioned Loki credentials and started alloy live during this plan's checkpoint -- see 17-05-SUMMARY.md",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-19T19:35:43.284Z",
    "resolved_at": null
  },
  {
    "id": 11,
    "kind": "deviation",
    "phase": "17",
    "file": "docker/postgres/Dockerfile",
    "line": null,
    "description": "pgBackRest patch-level drift (2.59.1 vs docs/runbooks/backups.md's documented 2.59.0) ratified as expected, not a defect -- unpinned apt-get install pgbackrest against pgdg; T-14-58/T-14-88 are provenance/tag-immutability threats, not apt-reproducibility ones; cross-version restore proof landed live -- see 17-05-SUMMARY.md",
    "status": "waived",
    "reason": "Ratified expected drift: pgBackRest 2.59.1 vs documented 2.59.0 ratified in 17-05-SUMMARY.md with live cross-version restore proof; docs/runbooks/backups.md already corrected. Approved by developer 2026-08-25 (quick 260825-qhm audit).",
    "recorded_at": "2026-08-19T19:35:43.551Z",
    "resolved_at": "2026-08-25T14:40:23.893Z"
  },
  {
    "id": 12,
    "kind": "deviation",
    "phase": "17",
    "file": "scripts/deploy.sh",
    "line": null,
    "description": "Leg-isolation defect discovered by operator dry-run during this plan's live checkpoint: mutating compose calls (up -d web api / run --rm migrate / up -d worker) implicitly recreated db/redis via dependency convergence without --no-deps -- an ungated db cutover hidden inside the routine app-deploy path. Fixed and merged (PR #17, TDD RED 393a004 -> GREEN 3de6771) as a phase-17 orchestrator-side fix, not authored by this plan -- see 17-05-SUMMARY.md",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-19T19:35:43.817Z",
    "resolved_at": "2026-08-25T14:25:49.623Z"
  },
  {
    "id": 13,
    "kind": "deviation",
    "phase": "17",
    "file": "apps/web/vite.config.ts",
    "line": null,
    "description": "charts-vendor/canvas-vendor static import-cycle crash (advancedChunks.includeDependenciesRecursively: false, phase 15 plan 03) broke the dashboard growth chart and the flow editor in every production build since 2026-08-15; discovered by this plan's Task 1 step 7. Fixed with strictExecutionOrder: true and a wired check-web-chunks CI gate (PR #16, commits bd8a66c/2f77147), a phase-17 orchestrator-side fix, not authored by this plan -- see 17-05-SUMMARY.md",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-19T19:35:44.077Z",
    "resolved_at": "2026-08-25T14:25:53.076Z"
  },
  {
    "id": 14,
    "kind": "deviation",
    "phase": "12",
    "file": "packages/test-support/src/global-setup.ts",
    "line": null,
    "description": "Deliberately deferred recurrence guard (kind 'deviation' = consciously accepted deferral, closest allowed kind) from debug session flow-run-advance-shared-redis, whose H1 fix (commit 3e9941e) closed entry id 5 for ONE queue only. The harness isolates Postgres per run but never Redis: every worker/api test process points at one shared logical DB (redis://localhost:6379/1) with no per-run BullMQ prefix and no cleanup anywhere, so BullMQ jobs survive run to run without bound -- measured 2026-08-28: 21973 waiting webhook-events jobs, 3180 flow-trigger-evaluator, 2911 email-triggered, 2881 erasure-scrub. That residue is inert only because no test consumes those queues; the moment any test registers a real Worker on one it inherits the whole backlog as serial workload, which is exactly how id 5 flaked. Class-level guard: a fail-closed test-Redis cleanup in global-setup.ts mirroring the fail-closed test-DATABASE guard already there -- refuse to run unless the resolved Redis URL names an explicit logical DB index >= 1 (never db 0, the dev worker's), then clear it once per run. Scoped out of 3e9941e deliberately to keep that fix minimal and reviewable.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-28T10:42:35.798Z",
    "resolved_at": null
  }
]
````
