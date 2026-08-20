---
phase: 15-observability-alerting-frontend-resilience
plan: 14
subsystem: api
tags: [postgres, rls, watchdog, ops, alerting, migration, grants, bullmq]

requires:
  - phase: 15-observability-alerting-frontend-resilience
    provides: "ops_alert_state (migration 0064) and claimOpsAlertSlot/releaseOpsAlertSlot (plan 15-12); queue-monitor.ts, queue-depth-watchdog.ts, oldest-job-age-watchdog.ts (plan 15-13, not yet wired into server.ts)"
provides:
  - "webhook-lag-watchdog.ts: the third OPS-13 alert, answering 'is delivery evidence still arriving' via a NEW column-level scan grant on workspace_webhook_endpoints.last_event_at (migration 0065) plus reuse of oldest-job-age-watchdog.ts's readOldestReconcilingSince for the outstanding-sends half"
  - "failed-send-share-watchdog.ts: the fourth OPS-13 alert, measuring the share of terminal (sent/failed) sends that failed over a rolling window, with the terminal/non-terminal split DERIVED from delivery-core's SEND_STATUS_TRANSITIONS rather than hard-coded status strings"
  - "migration 0065: a grants-only migration (column-level GRANT SELECT (last_event_at) ON workspace_webhook_endpoints TO mega_crm_scan + an unrestricted scan policy) -- a HUMAN-APPROVED override of this plan's own 'no new migration' prohibition, resolving a genuine architectural gap discovered mid-execution"
  - "all four OPS-13 watchdogs (queue-depth, oldest-job-age from 15-13; webhook-lag, failed-send-share from this plan) wired into apps/api/src/server.ts's main() -- nine watchdogs total now armed at every API boot"
affects: []

tech-stack:
  added: []
  patterns:
    - "Deriving a terminal/non-terminal status split from an executable state machine's own transition table (SEND_STATUS_TRANSITIONS) instead of hard-coding status-name literals, so a future status addition cannot silently land on the wrong side of a ratio"
    - "Column-level Postgres GRANT (GRANT SELECT (col) ON table TO role) as the minimal-surface alternative to a table-level grant, when the table also carries columns the new consumer has no legitimate use for"
    - "Contamination-safe DB-fixture test design against a shared ephemeral test database: prove a 'stays healthy' real-DB path via a value that can only push a platform-wide aggregate up (never down), and prove a real-read function via a before/after delta or lower bound rather than an exact count -- both patterns avoid false failures/flakiness when other test files in the same suite run concurrently against the same table"

key-files:
  created:
    - apps/api/src/modules/ops/webhook-lag-watchdog.ts
    - apps/api/src/modules/ops/failed-send-share-watchdog.ts
    - apps/api/src/modules/ops/__tests__/webhook-lag-watchdog.test.ts
    - apps/api/src/modules/ops/__tests__/failed-send-share-watchdog.test.ts
    - packages/db/migrations/0065_webhook_endpoints_scan_grant.sql
  modified:
    - apps/api/src/server.ts
    - apps/api/src/__tests__/env-schema.test.ts
    - packages/db/migrations/meta/_journal.json
    - packages/db/src/migration-tiers.ts
    - packages/db/src/__tests__/migration-tiers.test.ts
    - packages/db/src/__tests__/migration-empty-diff.test.ts
    - SPECIFICATION.md

key-decisions:
  - "HUMAN-APPROVED override of this plan's own 'no new migration' prohibition (Rule 4, resolved by explicit human decision after a checkpoint): the webhook-lag alert's receipt-timestamp requirement (server-set, never provider-supplied, per T-15-46) has NO scan-accessible data source anywhere in the existing schema. send_events has no mega_crm_scan grant at all; ingress_journal's scan policy is narrowed to incomplete rows only (a completed batch vanishes from scan view within seconds in a healthy system, making 'no rows visible' indistinguishable from 'nothing has arrived in months'); sends' own delivery-fact columns are written from event.occurredAt, a provider timestamp this plan explicitly forbids using. workspace_webhook_endpoints.last_event_at is the one column that is server-set, updated on every webhook batch, and semantically exact -- it simply had no scan grant before this plan."
  - "Migration 0065's grant is COLUMN-LEVEL (GRANT SELECT (last_event_at)), not table-level -- workspace_webhook_endpoints also carries path_token (the unguessable pre-verification webhook-URL trust anchor) and public_key, neither of which this alert needs. The privilege system itself refuses to leak them regardless of any future query, rather than relying on review discipline."
  - "The failed-send-share denominator (ATTEMPTED_TERMINAL_STATUSES = {sent, failed}) is derived from SEND_STATUS_TRANSITIONS' own terminal set ({sent, failed, excluded} -- states with zero outgoing transitions), then explicitly narrows out 'excluded' with a documented rationale: an excluded send never reached SendGrid at all (pre-send-gate skip), so counting it as an 'attempt' would dilute a genuinely high failure rate among sends that WERE actually attempted. 'unknown' and 'reconciling' fall out of both sides automatically via the derived split (both have non-empty outgoing transitions), with no separate rule needed for either -- this also means 'unknown' is never double-counted against oldest-job-age-watchdog.ts's own reconciling_since signal."
  - "webhook-lag-watchdog.ts reuses oldest-job-age-watchdog.ts's own readOldestReconcilingSince for the 'outstanding sends awaiting evidence' half, rather than reimplementing an equivalent MIN(reconciling_since) query -- one definition of that signal shared by both watchdogs, matching sends.ts's own doc comment naming this alert as reconciling_since's intended second consumer."
  - "Fixed this worktree's own node_modules symlink strategy mid-execution (Rule 3 - blocking, discovered by the migrate-runner-advisory-lock.test.ts real-child-process spawn): the prior untracked symlinks pointed the top-level node_modules directory itself at the main checkout's node_modules, so npm workspace's own @mega-crm/* symlinks (root node_modules/@mega-crm/db -> ../../packages/db, RELATIVE to wherever node_modules physically lives) resolved to the MAIN CHECKOUT's packages/db/migrations, not this worktree's -- any plain `node <script>` child process (not routed through vitest's own module resolver) silently read stale migration state. Replaced with a real (gitignored) node_modules directory containing per-entry symlinks: third-party packages point at the main checkout (safe, version-pinned, non-source), but every @mega-crm/* scoped entry points at this worktree's own apps/packages."
  - "Test 11 (failed-send-share) and tests 11/12 (webhook-lag) are deliberately contamination-safe against the shared ephemeral test database used by the full apps/api suite: failed-send-share's test 11 measures a before/after DELTA rather than an absolute count; webhook-lag's test 11 seeds a RECENT last_event_at (a fresh write can only push the platform-wide MAX up, never down) and test 12 asserts a lower bound rather than exact equality. An earlier, naive design (an absolute-count real-DB assertion) was caught failing only when run as part of the FULL apps/api suite (522/522 vs the file run alone passing 14/14), not in isolation -- both were rewritten before being committed."

requirements-completed: [OPS-13]

coverage:
  - id: D1
    description: "webhook-lag-watchdog.ts: healthy-when-quiet (no outstanding sends = idle, not lagging, regardless of last webhook age); a never-recorded webhook event WITH outstanding sends is its own distinct unhealthy reason; the lag measurement uses workspace_webhook_endpoints.last_event_at (server-set via debounceWebhookHealth's now(), never event.occurredAt); module header states the distinction from ingestion-health-watchdog.ts; alert body carries no workspace id/contact email/send id"
    requirement: "OPS-13"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/webhook-lag-watchdog.test.ts (12 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "failed-send-share-watchdog.ts: terminal/non-terminal split derived from delivery-core's SEND_STATUS_TRANSITIONS (not hard-coded strings); rate-limited deferrals (dispatching) and reconciling/unknown sends excluded from both numerator and denominator; excluded (never-attempted) sends excluded from the denominator; minimum-sample-size gate (20) below which the verdict is unconditionally healthy; exact-threshold boundary is healthy, one-over is unhealthy; alert body carries no workspace id/contact email/send id"
    requirement: "OPS-13"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/failed-send-share-watchdog.test.ts (14 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "migration 0065: column-level GRANT SELECT (last_event_at) ON workspace_webhook_endpoints TO mega_crm_scan + an unrestricted scan-role SELECT policy, classified forward-only in migration-tiers.ts, applied and verified against a real scratch Postgres database (fresh DB -> 66/66 rows in drizzle.__drizzle_migrations, grant/policy confirmed via \\dp/pg_policies)"
    requirement: "OPS-13"
    verification:
      - kind: unit
        ref: "npm run test:migrations (224/224 passing, includes migration-tiers.test.ts and migration-empty-diff.test.ts pinned-chain assertions)"
        status: pass
      - kind: other
        ref: "npm run lint:migrations (66 files, no violations); manual apply against a scratch Postgres database via scripts/migrate-runner.mjs"
        status: pass
    human_judgment: false
  - id: D4
    description: "all nine watchdogs (five pre-existing + queue-depth, oldest-job-age, webhook-lag, failed-send-share) armed at apps/api boot in server.ts's main(), each with its own real dispatch function, its own dedup-independence comment, and its own armed log line; existing five watchdogs' registration/intervals/ordering untouched; no new environment variable"
    requirement: "OPS-13"
    verification:
      - kind: unit
        ref: "npx vitest run --root apps/api (534/534 passing); npm run lint (0 errors, full repo); npm run check:spec-env-coverage (49/49)"
        status: pass
      - kind: other
        ref: "grep -c 'Watchdog({' apps/api/src/server.ts -> 9; git diff apps/api/src/server.ts contains zero removed lines; git diff --stat docker/prod.env.example is empty"
        status: pass
    human_judgment: false

duration: ~2h (including a checkpoint pause for human decision on the migration override)
completed: 2026-08-16
status: complete
---

# Phase 15 Plan 14: Remaining watchdogs and boot wiring Summary

**Webhook-lag and failed-send-share OPS-13 alerts, resolved through a human-approved grants-only migration (0065) for a genuine schema-access gap, with all four OPS-13 watchdogs (this plan's two plus plan 15-13's two) wired into apps/api/src/server.ts's boot sequence -- nine watchdogs total.**

## Performance

- **Duration:** ~2h (includes a `checkpoint:decision` pause between Task 2 and Task 1, waiting on human approval of the migration override)
- **Tasks:** 3 (Task 2 executed first per advisor guidance, since Task 1 was blocked; Task 1 completed after human approval; Task 3 last)
- **Files modified/created:** 12 (5 new: two watchdog modules, two test files, one migration; 7 modified: server.ts, env-schema.test.ts, migration journal, migration-tiers.ts + its two test files, SPECIFICATION.md)

## Accomplishments

- **`failed-send-share-watchdog.ts`** measures the share of terminal (`sent`/`failed`) sends that failed over a 6h rolling window, with the terminal/non-terminal split *derived* from `@mega-crm/delivery-core`'s exported `SEND_STATUS_TRANSITIONS` (a status is terminal iff its own outgoing-transition list is empty) rather than hard-coded status strings -- `excluded` is derived-terminal but explicitly carved out of the denominator (never reached SendGrid), and `reconciling`/`unknown`/`dispatching` fall out of both sides automatically via the derived split, with no separate rule needed for either.
- **`webhook-lag-watchdog.ts`** answers "is delivery evidence still arriving", a genuinely different question from `ingestion-health-watchdog.ts`'s "is an already-arrived batch stuck" -- resolved through a real, human-approved architectural fix (migration 0065) after discovering that every candidate scan-accessible data source for the receipt-timestamp requirement was either non-existent, structurally blind to the healthy-system case, or a forbidden provider timestamp.
- **Migration `0065`** grants `mega_crm_scan` column-level (not table-level) read access to exactly the one column this alert needs, deliberately narrower than a table-level grant would allow, since the table also carries an unguessable webhook-URL trust anchor and a public key neither watchdog has any use for.
- **All nine watchdogs** (five pre-existing plus the four OPS-13 alerts across plans 15-13/15-14) now start at every `apps/api` boot, each independently claiming through the shared `ops_alert_state` primitive under its own alert name so none can mask or be masked by another.
- **SPECIFICATION.md** fully updated per the CLAUDE.md doc-obligation rule: schema (§4.2/§4.6), scheduler/pipeline (§5.18/§5.19 -- webhook-lag's full data-source survey and the reasoning that ruled out every rejected alternative), public entry points (§6.18-6.21, matching the established "background process inside apps/api" convention), and observability (§7 -- the nine-watchdog alerting topology, and the still-outstanding hosted dead-man's-switch, plan 15-17).

## Task Commits

1. **Task 2: Failed-send-share watchdog** (executed first, per advisor guidance, since it was independent of the blocked Task 1)
   - RED: `230384d` (test) -- confirmed failing (module not found)
   - GREEN: `4f9ed6c` (feat) -- 14/14 tests pass; includes Rule 3 extension of `env-schema.test.ts`'s P3 `withCrossWorkspaceScan` allowlist
2. **[CHECKPOINT: decision]** -- Task 1 blocked on a genuine architectural gap (no scan-accessible server-set receipt timestamp existed for the webhook-lag alert without a new migration, and the plan's own text prohibits one). Checkpoint returned with a full survey of rejected alternatives and three options; orchestrator returned **Option A approved**: add a grants-only migration, human-approved override of the "no new migration" prohibition.
3. **Task 1: Webhook-lag watchdog**
   - Migration: `7fbdebc` (feat) -- `0065_webhook_endpoints_scan_grant.sql` + journal entry + tier classification + pinned-test updates; verified via `lint:migrations`, `test:migrations` (224/224), and a manual apply against a real scratch Postgres database
   - RED: `95b7557` (test) -- confirmed failing (module not found)
   - GREEN: `8e80afe` (feat) -- 12/12 tests pass; includes Rule 3 extension of the P3 allowlist (fourth consumer)
4. **Task 3: Wire all four watchdogs at boot**
   - `8fb6167` (feat) -- `server.ts` wiring for all four + full `SPECIFICATION.md` update

_No separate plan-metadata commit -- SUMMARY.md is force-added under this worktree's `.planning/` gitignore rules (see below)._

## Files Created/Modified

- `apps/api/src/modules/ops/webhook-lag-watchdog.ts` - `readNewestWebhookEventAt`, `evaluateWebhookLagHealth`, `renderWebhookLagAlertText`, `checkWebhookLagHealthAndAlert`, `startWebhookLagWatchdog`
- `apps/api/src/modules/ops/failed-send-share-watchdog.ts` - `readSendStatusCountsSince`, `evaluateFailedSendShareHealth`, `renderFailedSendShareAlertText`, `checkFailedSendShareHealthAndAlert`, `startFailedSendShareWatchdog`
- `apps/api/src/modules/ops/__tests__/webhook-lag-watchdog.test.ts` - 12 tests (7 pure, 5 real-DB)
- `apps/api/src/modules/ops/__tests__/failed-send-share-watchdog.test.ts` - 14 tests (10 pure, 4 real-DB)
- `packages/db/migrations/0065_webhook_endpoints_scan_grant.sql` - column-level scan grant + policy on `workspace_webhook_endpoints`
- `apps/api/src/server.ts` - imports, four real dispatch functions, four `start*Watchdog` calls, four armed log lines
- `apps/api/src/__tests__/env-schema.test.ts` - P3 `withCrossWorkspaceScan` allowlist extended twice (three, then four, permitted consumers)
- `packages/db/migrations/meta/_journal.json` - journal entry for `0065`
- `packages/db/src/migration-tiers.ts` - `0065` classified `forward-only`
- `packages/db/src/__tests__/migration-tiers.test.ts` - pinned trailing-auto-reversible-run assertion updated to reflect `0065` resetting it to `[]`
- `packages/db/src/__tests__/migration-empty-diff.test.ts` - pinned shipped-migration-count and newest-journal-tag assertions updated
- `SPECIFICATION.md` - §4.2, §4.6, §5.18, new §5.19, new §6.18-6.21, §7

## Decisions Made

- See `key-decisions` in frontmatter for the full architectural-gap survey, the column-level grant rationale, the derived terminal/non-terminal split, the `readOldestReconcilingSince` reuse, the node_modules symlink fix, and the contamination-safe test design.

## Deviations from Plan

### Human-Approved Architectural Override (Rule 4)

**1. [Rule 4 - Architectural] Added migration 0065, overriding this plan's own "no new migration" prohibition**
- **Found during:** Task 1 investigation (before any implementation)
- **Issue:** The plan's `must_haves.prohibitions` explicitly states "No new migration may be added; ops_alert_state from plan 15-12 is the only storage these use." Investigation of every scan-role grant across all 64 prior migrations proved this webhook-lag alert's own stated requirement -- "the lag measurement uses a server-set receipt timestamp, never a provider-supplied event timestamp", read cross-workspace -- has NO satisfying data source without a new grant: `send_events` has zero scan-role access; `ingress_journal`'s scan policy is narrowed to incomplete rows only (a completed batch vanishes from scan view within seconds in a healthy system); `sends`' delivery-fact columns are written from a provider timestamp this plan's own threat register (T-15-46) forbids using.
- **Action taken:** Executed Task 2 (independent, fully implementable) first per advisor guidance, then returned a `checkpoint:decision` naming three options (A: grants-only migration; B: ship a knowingly weaker/dishonest signal; C: defer the alert to a follow-up plan). The orchestrator returned **Option A approved by the human**, with explicit instruction to record the override and rationale here.
- **Fix:** `packages/db/migrations/0065_webhook_endpoints_scan_grant.sql` -- column-level `GRANT SELECT (last_event_at) ON workspace_webhook_endpoints TO mega_crm_scan` + an unrestricted scan-role SELECT policy. Deliberately column-level (not table-level): the table also carries `path_token` (the unguessable pre-verification webhook-URL trust anchor) and `public_key`, neither of which this alert has any use for.
- **Files modified:** `packages/db/migrations/0065_webhook_endpoints_scan_grant.sql`, `packages/db/migrations/meta/_journal.json`, `packages/db/src/migration-tiers.ts`, `packages/db/src/__tests__/migration-tiers.test.ts`, `packages/db/src/__tests__/migration-empty-diff.test.ts`
- **Verification:** `npm run lint:migrations` (66 files, no violations); `npm run test:migrations` (224/224); a manual apply against a real scratch Postgres database (fresh DB -> 66/66 rows in `drizzle.__drizzle_migrations`; grant + policy confirmed via `\dp`/`pg_policies` showing exactly `last_event_at: mega_crm_scan=r/primeropanther` and the new unrestricted `workspace_webhook_endpoints_scan` policy).
- **Committed in:** `7fbdebc`

### Auto-fixed Issues

**2. [Rule 3 - Blocking] Fixed this worktree's own node_modules symlink strategy**
- **Found during:** Task 1's migration verification (via `migrate-runner-advisory-lock.test.ts`'s real-child-process spawn)
- **Issue:** This worktree's untracked `node_modules` symlinks (set up before this plan, per prior-agent convention) pointed the top-level `node_modules` DIRECTORY at the main checkout's `node_modules`. npm workspaces' own `@mega-crm/*` symlinks inside THAT directory are relative (`../../packages/db`, resolved relative to wherever the symlinked directory physically lives) -- so any bare `@mega-crm/db` import resolved to the MAIN CHECKOUT's `packages/db/migrations`, not this worktree's. A plain `node <script>` child process (not routed through vitest's own module resolver -- exactly how `migrate-runner-advisory-lock.test.ts`'s concurrency test spawns the real migrate runner) silently read stale migration state: a fresh scratch database ended up with only 65/66 rows applied, not because migration 0065 was broken, but because the runner never saw it.
- **Fix:** Replaced the symlink strategy: root `node_modules` is now a real (gitignored) directory containing per-entry symlinks -- every third-party package points at the main checkout (safe: version-pinned, non-source, identical either way), but every `@mega-crm/*` scoped entry points at THIS worktree's own `apps/*`/`packages/*` directories. Re-verified the fix by re-running the manual scratch-database apply (66/66 rows, correct).
- **Files modified:** none tracked (untracked, gitignored `node_modules/` symlink structure only)
- **Verification:** `npm run test:migrations` (224/224, was 218/224 before the fix), `npm run lint` (0 errors, full repo -- also revealed and fixed the same pre-existing gap for `apps/web`/`packages/queue-core`), a manual scratch-database apply confirming 66/66 rows post-fix.
- **Committed in:** not applicable (gitignored, no commit)

**3. [Rule 3 - Blocking] Extended `env-schema.test.ts`'s P3 `withCrossWorkspaceScan` allowlist twice**
- **Found during:** Task 2 (failed-send-share-watchdog.ts) and Task 1 (webhook-lag-watchdog.ts)
- **Issue:** Both new watchdogs structurally need `withCrossWorkspaceScan` (the same reason `ingestion-health-watchdog.ts`/`oldest-job-age-watchdog.ts` already do), but the P3 guard's allowlist is a hard-coded array that fails on any new, unlisted consumer.
- **Fix:** Extended the allowlist array (and its own doc comment) twice -- once to three permitted files (Task 2), once to four (Task 1) -- mirroring the exact precedent 15-13's own executor established for the second consumer.
- **Files modified:** `apps/api/src/__tests__/env-schema.test.ts`
- **Verification:** `npx vitest run --root apps/api src/__tests__/env-schema.test.ts` passes at each step; full suite still green.
- **Committed in:** `4f9ed6c` (Task 2), `8e80afe` (Task 1)

**4. [Rule 1 - Bug] Rewrote a contamination-prone real-DB test assertion before it was ever committed**
- **Found during:** Task 2, after running the full `apps/api` suite (not just the new test file in isolation)
- **Issue:** An initial design for `failed-send-share-watchdog.test.ts`'s real-DB test asserted an EXACT ratio (`"4/5"`) computed from a platform-wide `sends` scan. Run alone, the test file passed (14/14); run as part of the full 76-file suite sharing one ephemeral database, it failed (`21.4%` observed instead of the expected `80%`) because other concurrently-run test files' own `sends` fixtures fell inside the same rolling window and diluted the ratio.
- **Fix:** Rewrote the test to measure a before/after DELTA on the raw per-status counts (proving `readSendStatusCountsSince`'s correctness in isolation from platform-wide contamination), then fed that exact delta into the pure evaluator separately -- proving the read and the evaluation compose correctly without depending on an uncontrollable global aggregate. Applied the same principle proactively to `webhook-lag-watchdog.test.ts`'s own real-DB tests (a lower-bound assertion and a "fresh write can only push a MAX up" healthy-direction test) before ever running them, avoiding the same class of flake pre-emptively.
- **Files modified:** `apps/api/src/modules/ops/__tests__/failed-send-share-watchdog.test.ts` (rewritten before its RED commit), `apps/api/src/modules/ops/__tests__/webhook-lag-watchdog.test.ts` (designed this way from the start)
- **Verification:** Full `apps/api` suite green (522/522 after Task 2, 534/534 after Task 1) with both test files included.
- **Committed in:** `230384d`/`4f9ed6c` (Task 2), `95b7557`/`8e80afe` (Task 1) -- the corrected versions are what was committed; no separate fix-up commit exists because the correction happened before the RED commit in each case.

---

**Total deviations:** 1 human-approved architectural override (Rule 4), 3 auto-fixed (2 Rule 3 -- blocking gaps required by the plan's own acceptance criteria/environment, 1 Rule 1 -- a test-design bug caught before it was ever committed).
**Impact on plan:** The Rule 4 override was the only way to deliver the webhook-lag alert's stated truth honestly; every other option surveyed (a weaker signal, or deferring the alert) was explicitly rejected by the human in favor of the correct fix. The three auto-fixes are necessary consequences of completing this plan's own stated tasks; none change what the plan asked for.

## Issues Encountered

- **Genuine architectural gap, not a planning oversight:** the plan's own `read_first` list pointed at `send-events.ts`/`ingress-journal.ts` as candidate data sources for the webhook-lag alert, but neither is actually usable as a platform-wide, scan-accessible, server-set signal without a new grant -- this was discovered only by exhaustively grepping every `mega_crm_scan` mention across all 64 prior migrations, not by re-reading the plan text alone. Documented in full in the checkpoint return and in this SUMMARY's key-decisions.
- **Worktree module-resolution bug with a real consequence (not merely cosmetic):** see Deviation #2 above -- this was not simply "tests fail in the worktree", it actively hid a genuine migration-application defect (0/1 migration missing) behind a passing-looking symlink setup. Fixed and re-verified before proceeding.
- **Full-repo `npm run lint` initially failed on `apps/web/src/lib/sentry.ts`** (4 `@typescript-eslint/no-unsafe-*` errors, a Vite `import.meta.env` type-resolution artifact) -- resolved by the same node_modules symlink fix (adding `apps/web`/`packages/queue-core` entries), not a regression in any file this plan touches. Full `npm run lint` now passes 0 errors across the whole repository.

## User Setup Required

None - no external service configuration required. Migration 0065 must be applied via the normal deploy pipeline (`scripts/migrate-runner.mjs`, already exercised in Phase 14) before the webhook-lag watchdog's default (non-injected) read path will function in a real environment -- no manual operator action beyond the existing deploy process.

## Next Phase Readiness

- All four OPS-13 alerts (queue depth, oldest job age, webhook lag, failed-send share) are implemented, tested, and armed at every `apps/api` boot -- Phase 15 success criterion 3's alert half is complete.
- Threshold/window VALUES for all four alerts remain a FLAGGED ASSUMPTION (first estimates, not validated against real production load) -- the runbooks in plan 15-18 must tell the operator how to tune them, per this phase's own edge-probe resolution note.
- The hosted-provider dead-man's switch (observing `apps/api` itself, not a business condition inside it) remains plan 15-17's job, not yet built -- documented explicitly in `SPECIFICATION.md` §7 so it reads as a named forward-follow-on, not a silent gap.
- No blockers for subsequent plans in this phase. Migration slot for this wave (0065) is now consumed.

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-16*
