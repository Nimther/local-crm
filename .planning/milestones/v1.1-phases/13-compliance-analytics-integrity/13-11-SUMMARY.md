---
phase: 13-compliance-analytics-integrity
plan: 11
subsystem: api
tags: [ops, watchdog, postgres, rls, cross-workspace-scan, sendgrid, alerting]

requires:
  - phase: 13-compliance-analytics-integrity
    provides: "plan 13-01's ingress_journal (migration 0055, scan-role grant + policy), plan 13-06's webhook-replay-sweep worker, plan 13-09's reputation-tick worker + reputation_alert_state/ingestion_alert_state (migration 0058)"
provides:
  - "ingestion-health-watchdog.ts: reads ingress_journal via withCrossWorkspaceScan, partitions into stuck/attempt-capped/unrecoverable counts, alerts operator with a 72h recency trigger on newly-purged tombstones"
  - "reputation-watchdog.ts: keyed (workspace_id, metric) claim over reputation_alert_state, tier-escalation cooldown bypass, dual operator+tenant-member alert audience"
  - "apps/api/src/server.ts boots both as the fourth and fifth independent dead-man's switches"
  - "apps/api/src/__tests__/env-schema.test.ts's P3 invariant narrowed to a one-file allowlist for the scan-role import"
affects: [phase-14, phase-15-observability]

tech-stack:
  added: []
  patterns:
    - "First apps/api-resident consumer of withCrossWorkspaceScan (mega_crm_scan role) -- every prior apps/api watchdog table carried no RLS at all"
    - "Keyed (not singleton) alert-claim shape, with an escalation disjunct in the WHERE clause bypassing the dedup cooldown"
    - "First apps/api query joining member/user directly (bypassing better-auth's session-scoped listMembers API) for a background process with no request context"

key-files:
  created:
    - apps/api/src/modules/ops/ingestion-health-watchdog.ts
    - apps/api/src/modules/ops/reputation-watchdog.ts
    - apps/api/src/modules/ops/__tests__/ingestion-health-watchdog.test.ts
    - apps/api/src/modules/ops/__tests__/reputation-watchdog.test.ts
  modified:
    - apps/api/src/server.ts
    - apps/api/src/__tests__/env-schema.test.ts
    - SPECIFICATION.md

key-decisions:
  - "readIngestionHealth always reads through withCrossWorkspaceScan (mega_crm_scan role) since ingress_journal is RLS-forced tenant data; the claim/dedup half (ingestion_alert_state, no RLS) still uses the ordinary app-role pool -- one check spans two roles/pools deliberately."
  - "readReputationSnapshot/claimReputationAlertSlot/resolveWorkspaceAlertRecipients all use the ordinary app-role pool, NEVER withCrossWorkspaceScan -- reputation_alert_state has no scan-role grant (migration 0058's own comment: 'No new grant to mega_crm_scan is required'); a scan-role read would permission-deny."
  - "apps/api/src/__tests__/env-schema.test.ts's P3 blanket ban on withCrossWorkspaceScan imports is narrowed to an explicit one-file allowlist (ingestion-health-watchdog.ts only) -- an architectural consequence of the plan's own key_links/threat model (T-13-11-08), not a new decision made during execution."
  - "WEBHOOK_REPLAY_MAX_ATTEMPTS (apps/worker) is mirrored by VALUE as a local constant in ingestion-health-watchdog.ts, not imported -- apps/api has no dependency on apps/worker (a private app). Documented as a known cross-app duplication to keep in sync by hand."
  - "resolveWorkspaceAlertRecipients is the first member/user join query in apps/api -- the existing member-listing route goes through auth.api.listMembers, which requires a live request session and cannot run from a background watchdog."

requirements-completed: [CMP-08, CMP-09]

coverage:
  - id: D1
    description: "Ingestion-health watchdog: operator learns about stuck/attempt-capped/permanently-unrecoverable webhook ingestion batches, deduped per 6h window, with a 72h recency trigger on newly-purged tombstones so the standing loss is never invisible."
    requirement: "CMP-08"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/ingestion-health-watchdog.test.ts (16 tests, including a real withCrossWorkspaceScan grant-proving test against a migrated ephemeral DB)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Reputation watchdog: operator and affected workspace's own members both learn about a warn/critical complaint-rate or hard-bounce-rate crossing, deduped per (workspace, metric) per 24h with immediate warn->critical escalation, no auto-pause of sending."
    requirement: "CMP-09"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/reputation-watchdog.test.ts (14 tests, including escalation/de-escalation/two-workspace-independence/observed-columns-untouched)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Both watchdogs armed at every apps/api boot, alongside the three pre-existing dead-man's switches, with no new required environment variable."
    verification:
      - kind: unit
        ref: "apps/api/src/__tests__/env-schema.test.ts (12 tests, P3 allowlist + no-new-required-var coverage)"
        status: pass
      - kind: other
        ref: "npm run build (tsc across all 13 workspaces) and npm run lint (eslint . --max-warnings=0)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Live delivery confirmation: booting apps/api with OPERATOR_ALERT_EMAIL pointed at a real inbox and seeded unhealthy rows produces one ingestion alert and one reputation alert (including a tenant-member copy), with neither message leaking a recipient address or event payload."
    verification: []
    human_judgment: true
    rationale: "Plan 13-11's own Task 3 <verify> names this as a <human-check>, not an <automated> assertion -- it requires a real PLATFORM_SENDGRID_API_KEY/verified sender and a human reading a live inbox. No failure-injection harness in this repo drives a real SendGrid send (Phase 8's own convention: SendGrid is always faked via the ProcessSendJobDeps.sendMail seam in automated tests). Deferred to the phase's live-SendGrid UAT gate, consistent with every prior watchdog in this directory (09-05's own SUMMARY records the identical deferral for the partition watchdog)."

duration: ~45min
completed: 2026-08-12
status: complete
---

# Phase 13 Plan 11: Ingestion-Health and Reputation Watchdogs Summary

**Two new apps/api dead-man's switches turn plan 13-06's ingress-journal replay sweep and plan 13-09's reputation-tick measurements into operator/tenant email -- a three-way stuck/attempt-capped/unrecoverable partition over a real cross-workspace scan-role read, and a keyed per-(workspace, metric) claim with an escalation-bypasses-cooldown disjunct.**

## Performance

- **Duration:** ~45 min
- **Completed:** 2026-08-12
- **Tasks:** 3 (all `type="auto" tdd="true"`)
- **Files modified:** 7 (4 created, 3 modified)

## Accomplishments

- `ingestion-health-watchdog.ts` (CMP-08): the FIRST `apps/api`-resident consumer of `withCrossWorkspaceScan` -- every prior watchdog table in this directory carried no RLS at all, but `ingress_journal` is RLS-forced tenant data (migration 0055). Partitions incomplete rows into three mutually exclusive counts (stuck / attempt-capped / unrecoverable), triggers on `stuckCount > 0 || attemptCappedCount > 0 || recentlyPurgedCount > 0` (a 72h recency window on newly-purged tombstones, never "any tombstone exists" -- tombstones are retained indefinitely by plan 13-01, so a mere-existence trigger would re-alert forever on an unfixable condition).
- `reputation-watchdog.ts` (CMP-09): the first KEYED (not singleton) alert-claim in this codebase, `WHERE workspace_id = $1 AND metric = $2` -- 13-RESEARCH.md Pitfall 5's predicted mistake avoided. A warn->critical escalation bypasses the 24h dedup cooldown via a third `WHERE` disjunct; a flat tier or de-escalation does not. Sends BOTH an English operator alert and a Russian tenant-member alert, through the platform's own SendGrid key only.
- `resolveWorkspaceAlertRecipients` is the first direct `member`/`user` join query in `apps/api` -- the existing member-listing route goes through `auth.api.listMembers`, which needs a live request session and cannot run from a background interval with no request context.
- Both watchdogs wired into `apps/api/src/server.ts`'s `main()` as the fourth and fifth independent dead-man's switches, sharing the existing `OPERATOR_ALERT_EMAIL`/`PLATFORM_SENDGRID_API_KEY`/`PLATFORM_MAIL_FROM` channel. Confirmed via `git diff` that `apps/api/src/env.ts` and every `package.json` in the repo are unchanged by this plan -- no new required environment variable, no new dependency.

## Task Commits

1. **Task 1: Ingestion-health watchdog on the ingress journal** - `453aa45` (feat)
2. **Task 2: Reputation watchdog with a keyed claim and tier escalation** - `6386323` (feat)
3. **Task 3: Wire both watchdogs into API boot** - `f1edf40` (feat)

**Docs:** `4a16661` (docs: SPECIFICATION.md SS6.14/6.15 + SS7 entries)

_Note: all three tasks were `tdd="true"`; tests were written and run alongside each implementation in the same commit rather than as separate RED/GREEN commits -- consistent with how the plan's own sibling analogs (dead-letter-watchdog, send-reconciler-watchdog) were built in prior phases._

## Files Created/Modified

- `apps/api/src/modules/ops/ingestion-health-watchdog.ts` - Reads `ingress_journal` via `withCrossWorkspaceScan`, partitions into stuck/attempt-capped/unrecoverable, atomic claim + platform-key dispatch
- `apps/api/src/modules/ops/reputation-watchdog.ts` - Keyed `(workspace_id, metric)` claim over `reputation_alert_state`, tier-escalation cooldown bypass, dual operator+tenant alert audience
- `apps/api/src/modules/ops/__tests__/ingestion-health-watchdog.test.ts` - 16 tests, including a real-scan-connection grant-proving test
- `apps/api/src/modules/ops/__tests__/reputation-watchdog.test.ts` - 14 tests, including escalation/de-escalation/independence cases
- `apps/api/src/server.ts` - Boots both watchdogs as the 4th/5th dead-man's switches; two new `sendXAlert` dispatch functions
- `apps/api/src/__tests__/env-schema.test.ts` - P3 invariant narrowed from a blanket ban to an explicit one-file allowlist
- `SPECIFICATION.md` - New SS6.14/6.15 (public entry points) and SS7 (observability) entries for both watchdogs

## Decisions Made

- **`readIngestionHealth` always reads through `withCrossWorkspaceScan`; the claim writes through the ordinary app pool.** `ingress_journal` is RLS-forced tenant data (migration 0055) -- a tenant-scoped connection cannot answer "how many workspaces have stuck rows" at all under the fail-closed predicate. `ingestion_alert_state` (migration 0058) carries no RLS and is owned by `mega_crm_app`, so the claim/release half uses the ordinary pool. One check therefore spans two roles/pools -- documented at length in the module's own header comment.
- **`reputation-watchdog.ts` never touches the scan pool.** Migration 0058's own comment states plainly that `reputation_alert_state` needs no `mega_crm_scan` grant (the reputation-tick's only cross-tenant read, `SELECT id FROM organization`, is already covered by migration 0042). A scan-role read here would permission-deny -- exactly the T-13-11-08 silent-failure mode reproduced on a table where it does not need to exist. Every read/write in this module goes through `deps.client` (the ordinary app pool).
- **`WEBHOOK_REPLAY_MAX_ATTEMPTS` is duplicated by value, not imported.** `apps/api` has no dependency on `apps/worker` (a private app, not a shared package), so the attempt-cap threshold (5) is a local constant in `ingestion-health-watchdog.ts` with an explicit comment naming the sibling constant it must be kept in sync with by hand. This is a known, accepted duplication -- extracting it to `packages/db` would touch files outside this plan's declared scope.
- **`resolveWorkspaceAlertRecipients` is a new, first-of-its-kind query.** `apps/api/src/modules/tenancy/members.ts`'s existing member listing goes through `auth.api.listMembers`, which requires a live request's session headers -- unusable from a background `setInterval`. This plan writes the first direct `"member" m JOIN "user" u` SQL join in `apps/api`, noted here so a future reader knows it is the query to consolidate onto if a second background consumer of workspace membership appears.
- **The P3 structural test (`env-schema.test.ts`) is narrowed, not removed.** Its original blanket assertion ("zero files under `apps/api/src` import `withCrossWorkspaceScan`") predates this plan and would otherwise permanently block Task 1's own explicit, plan-approved design (13-11-PLAN.md's `key_links` names "readIngestionHealth under withCrossWorkspaceScan" verbatim; threat T-13-11-08 depends on it; 13-REVIEWS.md HIGH finding 2 directed it). The test now allowlists exactly one file (`ingestion-health-watchdog.ts`); any other file importing the scan helper still fails it.
- **Test fixture cleanup is row/workspace-scoped, never a blanket `DELETE`.** Both `ingress_journal` and `reputation_alert_state` are read platform-WIDE by their respective watchdogs (no workspace-scoping test override exists, unlike `runWebhookReplaySweep`'s `workspaceIds` param) and both tables are also touched by other apps/api test files running in the same shared ephemeral database. Every row this plan's own tests create is tracked by id/workspace and cleaned up in `afterEach` scoped to exactly those ids -- never a table-wide delete that could corrupt a concurrently-running file's own fixtures.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Narrowed the P3 structural test to an explicit one-file allowlist**
- **Found during:** Task 1 (before writing any code, while reading `apps/api/src/__tests__/env-schema.test.ts` per the general read-first discipline)
- **Issue:** A pre-existing Phase 10 structural test asserts that zero files under `apps/api/src` (outside `__tests__`) import `withCrossWorkspaceScan`. Task 1's own design -- explicitly directed by 13-11-PLAN.md's `key_links`, `must_haves`, and threat T-13-11-08 -- requires exactly this import in `ingestion-health-watchdog.ts`. Left as-is, the test would fail on every subsequent `npm test` run and block the plan's own explicitly-approved architecture.
- **Fix:** Changed the test's blanket `expect(offenders).toEqual([])` to an explicit one-file allowlist (`ingestion-health-watchdog.ts` only), with a comment recording the plan/threat/review citations that justify the narrowing. Any other file importing the scan helper still fails the test -- P3's original intent (no BROAD scan-role membership in `apps/api`) is preserved.
- **Files modified:** `apps/api/src/__tests__/env-schema.test.ts`
- **Verification:** `npx vitest run --root apps/api src/__tests__/env-schema.test.ts` -- 12/12 passing, including the narrowed test.
- **Committed in:** `453aa45` (Task 1 commit)

**2. [Rule 3 - Blocking] Two prose comments rephrased to avoid the P3 test's naive substring match**
- **Found during:** Task 3, running the combined `env-schema.test.ts` + `ops/__tests__` verification command
- **Issue:** The P3 test's allowlist check (deviation 1 above) matches the literal substring `withCrossWorkspaceScan` anywhere in a file's text, including comments. `reputation-watchdog.ts`'s own header comment and `server.ts`'s inline comment both explained, in prose, that the reputation watchdog does NOT use the scan helper -- which itself contains the banned substring and tripped the allowlist as a false positive.
- **Fix:** Reworded both comments to say "the cross-workspace scan helper" instead of naming the function literally, preserving the explanatory content without tripping the substring check.
- **Files modified:** `apps/api/src/modules/ops/reputation-watchdog.ts`, `apps/api/src/server.ts`
- **Verification:** `npx vitest run --root apps/api src/modules/ops/__tests__ src/__tests__/env-schema.test.ts` -- 79/79 passing.
- **Committed in:** `f1edf40` (Task 3 commit)

**3. [Rule 3 - Blocking] Test fixture writes to `user`/`member` routed through `authDb`, not the app pool**
- **Found during:** Task 2, first test run of `reputation-watchdog.test.ts`
- **Issue:** `mega_crm_app` (the ordinary tenant pool) has SELECT-only privilege on `user`/`member`/`organization`/`invitation` as of migration 0045 -- INSERT/UPDATE/DELETE on better-auth's own tables belongs exclusively to `mega_crm_auth`. The test's `seedMember` helper initially inserted via the raw app pool and failed with `permission denied for table user`.
- **Fix:** Routed the fixture's `user`/`member` inserts through `authDb` (Drizzle, `mega_crm_auth`-backed), mirroring `flow-enroll-atomic.test.ts`'s and `partition-watchdog.test.ts`'s own existing precedent for seeding `organization` the same way.
- **Files modified:** `apps/api/src/modules/ops/__tests__/reputation-watchdog.test.ts`
- **Verification:** `npx vitest run --root apps/api src/modules/ops/__tests__/reputation-watchdog.test.ts` -- 14/14 passing.
- **Committed in:** `6386323` (Task 2 commit)

**4. [Rule 1 - Bug] Test cleanup for RLS-forced `ingress_journal` moved from a bare pool query to a tenant-scoped one**
- **Found during:** Task 1, first test run of `ingestion-health-watchdog.test.ts`
- **Issue:** The initial `afterEach` cleanup attempted `pool.query("UPDATE ingress_journal SET ingestion_completed_at = now() WHERE id = ANY($1::uuid[])", [ids])` against the bare app pool with no tenant GUC set. `ingress_journal`'s fail-closed `workspace_isolation` policy (migration 0055) rejected this with `unrecognized configuration parameter "app.current_workspace_id"`, and because the cleanup never completed, later tests in the same file saw contaminated global state from earlier tests' un-cleaned rows.
- **Fix:** Tracked each created row alongside its owning `workspaceId` and cleaned up per-row through `withTenant(row.workspaceId, () => withTenantTransaction(...))`, exactly mirroring how the row was inserted in the first place.
- **Files modified:** `apps/api/src/modules/ops/__tests__/ingestion-health-watchdog.test.ts`
- **Verification:** `npx vitest run --root apps/api src/modules/ops/__tests__/ingestion-health-watchdog.test.ts` -- 16/16 passing, re-run twice to confirm no cross-test contamination.
- **Committed in:** `453aa45` (Task 1 commit)

**5. [Rule 1 - Bug] `startIngestionHealthWatchdog`'s interval-catch test redesigned around the real scan-pool failure mode**
- **Found during:** Task 1, while writing the interval-catch test
- **Issue:** Every sibling watchdog's own `startXWatchdog` test proves the interval-catch by making the injected `client.query` reject. That pattern does not exercise `ingestion-health-watchdog.ts`'s actual failure surface: the health READ never touches the injected client at all (it always goes through the real scan pool internally), so a rejecting fake client would never even be called when the platform state happens to be healthy, and the test would pass or fail depending on unrelated global state.
- **Fix:** Rewrote the test to simulate the module's actual, realistic failure mode instead: `closeScanPool()` to discard the cached scan-pool singleton, then temporarily unset `process.env.SCAN_DATABASE_URL` so the next scan attempt throws `SCAN_DATABASE_URL is required...` -- exactly the T-13-11-08 operational-prerequisite gap documented in the module's own header comment.
- **Files modified:** `apps/api/src/modules/ops/__tests__/ingestion-health-watchdog.test.ts`
- **Verification:** Test passes deterministically regardless of other tests' seeded data; `scrubbedConsole.error` assertion confirmed.
- **Committed in:** `453aa45` (Task 1 commit)

---

**Total deviations:** 5 auto-fixed (4 Rule 3 - blocking, 1 Rule 1 - bug)
**Impact on plan:** All five were necessary to make the plan's own explicitly-directed architecture (scan-role read from `apps/api`, keyed reputation claim) actually pass the existing structural test suite and produce deterministic, non-contaminated tests. No scope creep beyond the plan's declared file list, except the two narrowly-targeted edits to `env-schema.test.ts` (an existing file not in the plan's `files_modified` list, but a direct, unavoidable consequence of the plan's own design).

## Issues Encountered

None beyond the deviations documented above -- all discovered during the TDD RED/GREEN cycle for each task and resolved before moving to the next task.

## User Setup Required

None for boot correctness -- no new environment variable is introduced. However, two **operational prerequisites** worth flagging explicitly (not code changes, but easy to miss in a fresh deployment):

- **`SCAN_DATABASE_URL` must be present in `apps/api`'s deployed `process.env`** for the ingestion-health watchdog to actually see anything. If absent, `apps/api` still boots successfully and every 5-minute tick fails silently (caught and logged via `scrubbedConsole.error`) -- the ingestion-loss alert simply never fires. This is the exact T-13-11-08 failure mode the plan's threat model names.
- **Live SendGrid delivery is not exercised by this plan's automated tests** (D4 above, `human_judgment: true`) -- confirming both alerts actually arrive, and that the reputation alert reaches a real workspace member address, requires a live `PLATFORM_SENDGRID_API_KEY`/verified sender and a human reading an inbox, per Task 3's own `<human-check>` clause. Deferred to the phase's live-SendGrid UAT gate.

## Next Phase Readiness

- Both new watchdogs are structurally complete, fully unit/integration-tested (30 new tests across the two modules, 79/79 passing including the P3 allowlist test), and wired into `apps/api`'s boot sequence with zero new required configuration.
- `npm run build` (13 workspaces) and `npm run lint` (`eslint . --max-warnings=0`) both pass clean at HEAD.
- No blockers for the remaining Phase 13 plans (13-12 through 13-15) -- this plan's only shared-file touch (`env-schema.test.ts`'s P3 test) is additive/narrowing, not a behavior change to any code path another plan depends on.

---
*Phase: 13-compliance-analytics-integrity*
*Completed: 2026-08-12*
