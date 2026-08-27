# 260825-qhm: Evidence-Based Audit of `.planning/WINDOWS.md` Open Entries

Executed 2026-08-25 from the main checkout `/Users/primeropanther/Projects/mega-crm` (no worktree).
All evidence below is execution-time command output captured during this run, not a restatement
of the plan's pinned-facts table.

## Pre-mutation baseline (`windows status`, verbatim, captured before any evidence-gathering)

```json
{
  "ok": true,
  "ledger": {
    "schema_version": 1,
    "open_count": 10,
    "waived_count": 0,
    "fixed_count": 3,
    "total_count": 13,
    "last_updated": "2026-08-19T19:35:44.077Z",
    "entries": [
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
        "status": "open",
        "reason": "",
        "recorded_at": "2026-08-19T19:35:43.551Z",
        "resolved_at": null
      },
      {
        "id": 12,
        "kind": "deviation",
        "phase": "17",
        "file": "scripts/deploy.sh",
        "line": null,
        "description": "Leg-isolation defect discovered by operator dry-run during this plan's live checkpoint: mutating compose calls (up -d web api / run --rm migrate / up -d worker) implicitly recreated db/redis via dependency convergence without --no-deps -- an ungated db cutover hidden inside the routine app-deploy path. Fixed and merged (PR #17, TDD RED 393a004 -> GREEN 3de6771) as a phase-17 orchestrator-side fix, not authored by this plan -- see 17-05-SUMMARY.md",
        "status": "open",
        "reason": "",
        "recorded_at": "2026-08-19T19:35:43.817Z",
        "resolved_at": null
      },
      {
        "id": 13,
        "kind": "deviation",
        "phase": "17",
        "file": "apps/web/vite.config.ts",
        "line": null,
        "description": "charts-vendor/canvas-vendor static import-cycle crash (advancedChunks.includeDependenciesRecursively: false, phase 15 plan 03) broke the dashboard growth chart and the flow editor in every production build since 2026-08-15; discovered by this plan's Task 1 step 7. Fixed with strictExecutionOrder: true and a wired check-web-chunks CI gate (PR #16, commits bd8a66c/2f77147), a phase-17 orchestrator-side fix, not authored by this plan -- see 17-05-SUMMARY.md",
        "status": "open",
        "reason": "",
        "recorded_at": "2026-08-19T19:35:44.077Z",
        "resolved_at": null
      }
    ]
  }
}
```

---

## Entry 12 — `scripts/deploy.sh` mutating-compose leg isolation

**Verdict: FIXED**

Commits exist:
```
$ git log -1 --format='%h %s' 393a004
393a004 test(17): require --no-deps on every mutating deploy.sh compose call (RED)
$ git log -1 --format='%h %s' 3de6771
3de6771 fix(17): deploy.sh mutating compose calls get --no-deps — app deploys must never recreate db/redis (GREEN)
```

Per-line gate (comments filtered, mutating calls only — `compose` + `up -d`/`run --rm`):
```
$ grep -v '^\s*#' scripts/deploy.sh | grep -n -E 'compose.*(up -d|run --rm)'
176:docker compose -f $COMPOSE_FILE run --rm --no-deps migrate
177:docker compose -f $COMPOSE_FILE up -d --no-deps web api
182:docker compose -f $COMPOSE_FILE up -d --no-deps worker
242:  if ! compose run --rm --no-deps migrate; then
249:  compose up -d --no-deps web api
275:    compose up -d --no-deps worker
```
Mutating calls = 6, calls carrying `--no-deps` = 6 (counted independently: `grep ... | grep -c -- '--no-deps'` also returns 6). All six carry the flag.

Guard test located via `git show 393a004 --stat` (`scripts/__tests__/deploy-script.test.mjs`, 42
lines added) and run targeted (single file, via repo-local vitest, not tsx — the file is a vitest
suite):
```
$ node_modules/.bin/vitest run scripts/__tests__/deploy-script.test.mjs
 Test Files  1 passed (1)
      Tests  21 passed (21)
```

Fixed set candidate: yes.

---

## Entry 13 — `apps/web/vite.config.ts` chunk-cycle crash

**Verdict: FIXED**

Commits exist:
```
$ git log -1 --format='%h %s' bd8a66c
bd8a66c test(17): fail the web-chunk gate on static chunk-import cycles (RED)
$ git log -1 --format='%h %s' 2f77147
2f77147 fix(17): strictExecutionOrder breaks vendor-chunk eval crash; wire chunk gate into CI (GREEN)
```

`strictExecutionOrder` present outside comments:
```
$ grep -v '^\s*//' apps/web/vite.config.ts | grep -n 'strictExecutionOrder'
37:        strictExecutionOrder: true,
```

Gate script exists:
```
$ ls -la scripts/check-web-chunks.mjs
-rw-r--r--@ 1 primeropanther  staff  11155 Aug 20 20:54 scripts/check-web-chunks.mjs
```

Gate is WIRED into CI, not merely present — matching workflow line quoted with file:line:
```
$ grep -n 'check-web-chunks\|check:web-chunks' .github/workflows/ci.yml
78:        run: npm run check:web-chunks
```
`.github/workflows/ci.yml:78` — `run: npm run check:web-chunks`, and `package.json:75` maps that
script to `node scripts/check-web-chunks.mjs`.

`git show bd8a66c --stat` shows the RED commit added the gate's cycle-detection logic directly
inside `scripts/check-web-chunks.mjs` (58 lines) rather than a separate `*.test.*` file, so there
is no standalone guard test to run in isolation; running the gate itself requires a full
`apps/web` production build (`tsc --noEmit && vite build`) to produce the manifest it reads — not
attempted here as it is out of proportion to this audit and is optional per the plan. The
commit/grep evidence above is sufficient: two real commits, the config change present, the gate
file present, and the gate provably wired into the required CI job.

Fixed set candidate: yes.

---

## Entry 10 — Grafana Alloy deploy durability

**Verdict: RESIDUAL-GAP** (no waive — per constraints, ids 5/8/10 may never carry a waive proposal)

The open question is deploy-path durability, not whether alloy was ever started manually once.

Alloy IS defined as a service in the prod compose file:
```
$ grep -rn 'alloy' docker/docker-compose.prod.yml
148:    # outlive a network blip during which the `alloy` sidecar below cannot
456:  # docker/alloy/config.alloy's own header for the full label-strategy and
458:  alloy:
467:    image: grafana/alloy:v1.18.1
475:    # config.alloy's own `env()` calls read exactly these three names, no
484:    # Read-only: config.alloy's own header explains why this mount is
489:      - ./alloy/config.alloy:/etc/alloy/config.alloy:ro
494:        "/etc/alloy/config.alloy",
```

Alloy has ZERO non-comment occurrences in `scripts/deploy.sh`:
```
$ grep -v '^\s*#' scripts/deploy.sh | grep -n 'alloy'
(no output)
```

Corroborating: the deploy script's mutating `up -d` calls target explicit service lists
(`up -d --no-deps web api`, `up -d --no-deps worker` — see Entry 12 evidence), never a bare
`up -d` that would implicitly start every service including `alloy`. So `alloy` cannot be
(re)started by any code path in `scripts/deploy.sh` today, confirming the discriminator from the
plan: defined in compose, absent from every deploy.sh startup path = the gap is real.

**Recommendation:** next-milestone requirement — add `alloy` to the mutating-service list in
`scripts/deploy.sh` (or a dedicated observability-stack startup step) so a fresh production
bring-up (not just the one live checkpoint where the operator started it by hand during 17-05)
durably (re)establishes the sidecar. This is a genuine gap in the automated deploy path, not a
documentation or ratification issue — no waive proposed.

---

## Entry 8 — redaction phone-rule UUID false positive

**Verdict: DEFECT-CONFIRMED** (no waive — excluded per constraints)

Root-cause investigation: `packages/redaction/src/rules.ts`'s `phone` valueRule was anchored by
commit `3cd3f0c` (2026-08-09) against `[0-9A-Za-z-]` at both match boundaries specifically to stop
matching mid-token inside a UUID's hex groups. Confirmed the CURRENT file is byte-identical to
that fix (`git show 3cd3f0c -- packages/redaction/src/rules.ts` diff matches the live file), and
`git log --since=2026-08-11 -- packages/redaction/src` shows no further change to the phone rule
after the ledger entry was recorded (2026-08-11 20:30) — no fix has landed since.

Primary probe (NOT the 5000-sample sampler under suspicion): a throwaway script written to this
session's own scratchpad
(`/private/tmp/claude-501/.../scratchpad/probe-uuid-redaction.ts`, never committed to the repo),
importing the real `scrub` entry point by absolute path and run with the repo-local
`node_modules/.bin/tsx`:

```ts
import { scrub } from "/Users/primeropanther/Projects/mega-crm/packages/redaction/src/scrub.ts";
const input = { workspaceId: "17240210-0546-4077-9954-207876832048" };
console.log(JSON.stringify({ input, result: scrub(input) }));
```

```
$ node_modules/.bin/tsx probe-uuid-redaction.ts
{"input":{"workspaceId":"17240210-0546-4077-9954-207876832048"},"result":{"workspaceId":"[REDACTED]"}}
```

Still redacted. Root cause identified precisely: the anchoring fix relies on hex-letter
boundaries inside a UUID to block mid-token starts, but `17240210-0546-4077-9954-207876832048` has
NO hex letters in ANY group — every character across all five groups (8+4+4+4+12 = 32 hex
positions, all decimal digits, joined by 4 hyphens) is a decimal digit. With only hyphens as
internal separators (which the phone pattern's own separator class `[\s().-]` already treats as
internal punctuation), the entire 32-digit run matches end-to-end as a single valid phone-shaped
token, and the boundary anchors are trivially satisfied because nothing outside the match falls
inside `[0-9A-Za-z-]` (the value is the whole string). This is a distinct failure mode from the
one `3cd3f0c` fixed (mid-token start inside mixed hex/digit groups) — it is the all-digit-group
case, structurally unreachable by that fix.

**Recommendation:** `/gsd-debug` on `packages/redaction/src/rules.ts`'s phone valueRule. Two
candidate fix directions, carried from the ledger entry's own text verbatim: "exclude UUID-shaped
values before the phone rule, or seed the sampler." This session's live, deterministic
single-input repro (above) moots the second direction as a *fix* — seeding the 5000-sample sampler
would only make the existing all-digit-group failure reproducible on demand, not prevent it; the
sampler still can't observe a defect this rare-but-deterministic reliably without a seeded case
list. Direction (a), excluding UUID-shaped values (RFC 4122 canonical 8-4-4-4-12 hex pattern)
before applying the phone rule, is the one this evidence actually supports as a fix.

---

## Entry 2 — Playwright config load (`ERR_MODULE_NOT_FOUND` under Node v26)

**Verdict: FIXED**

Reproduced config-load only, cheaply, using the repo-local Playwright binary (never a bare
fetch-capable invocation):
```
$ node_modules/.bin/playwright test --list --config=apps/web/playwright.config.ts
[e2e:database] postgres://mega_crm_app:***@localhost:5432/mega_crm_test_e2e_93b913c1
Listing tests:
  auth-session-lifecycle.spec.ts:107:1 › ...
  ... (21 total)
Total: 21 tests in 11 files
```
The listing itself is the dispositive evidence — the config loaded, resolved its imports (including
the `[e2e:database]` module-scope provisioning step described in the config's own header), and
enumerated all 21 tests across 11 files with no `ERR_MODULE_NOT_FOUND` and no stack trace. (Not
separately claiming an exit-code check here: this session's first attempt at this command piped
through `head`, which per constraint 11 would have laundered the real exit status through `head`'s
own — re-running unpiped would provision a second throwaway ephemeral database for no evidentiary
gain over the clean listing already captured, so the listing stands as the evidence and no
exit-code claim is made.)

Inspected the real entry point named by the root `test:e2e` script,
`apps/web/e2e/run-e2e.ts` — it resolves the Playwright CLI module via `require.resolve` and pins
the child to `process.execPath`; no deep `.ts` specifier that could trigger the historical
`ERR_MODULE_NOT_FOUND` is present.

Before claiming FIXED, checked `git log` on the affected import path for a fix landing after the
ledger entry's `recorded_at` (2026-08-07T19:38:44Z):
```
$ git log --oneline --since=2026-08-07 -- apps/web/e2e/run-e2e.ts apps/web/playwright.config.ts
1402968 fix(ci): restore clean E2E and aggregate coverage   (2026-08-11 14:12:11 +0500)
```
`git show 1402968 --stat` touches `apps/web/e2e/provision-database.ts`, `apps/web/playwright.config.ts`,
`packages/db/package.json`, plus a new resolved-debug doc
`.planning/debug/resolved/e2e-package-source-import.md`. That doc's own recorded symptom is:
```
ERR_MODULE_NOT_FOUND: Cannot find module node_modules/@mega-crm/db/src/partitions/ensure-partitions.js
imported from packages/test-support/src/db-fixture.ts
```
— the exact defect class described in ledger entry 2, fixed 4 days after the entry was recorded
and never reflected back into the ledger. This is an unexplained-pass guard satisfied: the pass is
explained by a named, dated commit, not merely observed.

Fixed set candidate: yes.

---

## Entry 5 — `flow-run-advance-integration.test.ts` shared-Redis timing flake

**Verdict: DEFECT-CONFIRMED** (no waive — excluded per constraints; **zero tests run for this id**)

Inspected `apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts`: `beforeAll`
builds a `Worker` directly from `process.env.REDIS_URL` via `buildRedisConnectionOptions` — a
single shared Redis instance/connection, no per-suite key prefix, no dedicated Redis logical DB
number, no isolation wrapper. Grepped `apps/worker/src/queues/flows/flow-queues.ts` and
`packages/queue-core` for any `prefix`/`db:` isolation mechanism — none found:
```
$ grep -n "prefix\|QUEUE_PREFIX\|db:" apps/worker/src/queues/flows/flow-queues.ts
34:  const redisUrl = process.env.REDIS_URL;
$ grep -rn "prefix\|db:" packages/queue-core/src/*.ts
(no output)
```
`git log --oneline --since=2026-08-10` on this test file and its queue module shows one unrelated
commit (`ead5987`, queue-handle shutdown tracking) — no isolation fix has landed.

Checked `.planning/debug/knowledge-base.md` for the isolation-pass-equals-flake signature: no
entry specific to `flow-run-advance`/shared-Redis exists, but a directly analogous, well-evidenced
lesson is recorded under `segm-04-live-count-race` / the redaction-rule entry: *"an intermittent
failure is a gate reporting a real defect at a low duty cycle"* and *"if a suite passes
per-workspace but fails in the aggregate run, suspect shared global state before suspecting the
flag that distinguishes the two entrypoints."* Both apply directly to this entry's shared-Redis
contention description.

Per constraint 10, **no test was run for this id** — an isolated pass is the documented flake
signature itself and proves nothing either way.

**Recommendation:** `/gsd-debug` on shared-Redis test isolation for
`apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts` — candidate fix: a
per-suite unique BullMQ queue-name prefix or a dedicated Redis logical DB per worker test file, so
concurrent suites cannot contend on the same job-id keyspace under full-suite parallel load.

---

## Entry 1 — Ledger-loss tombstone

**Verdict: WAIVE-PROPOSED — awaiting developer approval**

Three-leg basis, each independently verified this run:

**(a) Self-describing loss.** The entry's own description states the pre-phase-12 `WINDOWS.md`
(5 entries) was clobbered when 12-10's worktree force-committed a fresh ledger (commit `272ecc1`)
that overwrote the untracked main-repo file on merge, and that the original entry id 1
(pre-2026-08-07) is unrecoverable — the tombstone documents its own irreversibility; there is no
code path to "fix."

**(b) Recurrence mechanism structurally closed.** The clobber depended on `.planning/WINDOWS.md`
being untracked in the main repo when a worktree force-committed a competing version. Verified the
file is now git-tracked:
```
$ git ls-files --error-unmatch .planning/WINDOWS.md
.planning/WINDOWS.md
```
A tracked file cannot be silently overwritten the same way by an untracked worktree commit landing
on merge — git would surface the conflict instead.

**(c) Recurrence path additionally closed by process guidance.** This very plan's own
`hard_constraints` (constraint 5: "Do not create a fresh `WINDOWS.md`, do not `git add -f` it, do
not restructure it... This task runs in the MAIN checkout — there is no worktree") and this
executor's standing prompt template both explicitly forbid the exact action (`git add -f` a fresh
force-added ledger from a worktree) that caused the original loss — the lesson has been absorbed
into the standard executor guardrails, not merely remembered informally.

**Proposed waive reason (single line, pass-through ready):**
> "Un-fixable tombstone: pre-phase-12 ledger loss (5 entries) from a worktree force-commit overwriting an untracked file on merge; WINDOWS.md is now git-tracked (git ls-files confirms) and the exact recurrence action is now forbidden by standing executor constraints — nothing further can restore the lost entry or prevent a structurally identical loss."

**Status: awaiting developer approval — not applied.**

---

## Entry 3 — `SCAN_DATABASE_URL` design deviation

**Verdict: WAIVE-PROPOSED — awaiting developer approval**

Confirmed the cited SUMMARY exists before quoting it:
```
$ ls -la .planning/milestones/v1.1-phases/11-delivery-correctness/11-02-SUMMARY.md
-rw-r--r--@ 1 primeropanther  staff  16897 Aug 20 20:54 ...
```

Quoted Deviations passage (11-02-SUMMARY.md, "Deviations from Plan"):
> "**1. [Rule 3 - Blocking] `audit-sends-history.ts` cannot use a single `DATABASE_URL`
> connection as the plan's `<action>` literally describes** ... Added a second connection built
> from `SCAN_DATABASE_URL` (the `mega_crm_scan` role, already granted unrestricted `SELECT` on
> `sends`/`organization` since migration 0042 ...) for the per-status/per-kind `sends` aggregates
> and workspace-id enumeration ... Committed in: `56df671`"

Confirmed the deviation is still the shipped reality:
```
$ grep -n "SCAN_DATABASE_URL" packages/db/scripts/audit-sends-history.ts
43: *      SECOND pool built from `SCAN_DATABASE_URL` for exactly this reason.
220:  const scanDatabaseUrl = requireEnv("SCAN_DATABASE_URL");
```

**Basis:** a design deviation documented and accepted at the time of shipping (Rule 3 blocking-fix,
auto-fixed and committed within the same plan, not a later patch), still accurately describing the
current code.

**Proposed waive reason (single line, pass-through ready):**
> "Documented design deviation (11-02-SUMMARY.md, Rule 3 blocking-fix): audit-sends-history.ts uses SCAN_DATABASE_URL + a rollback-only per-workspace loop instead of a single DATABASE_URL connection, because RLS on sends/send_events makes the literal plan design structurally impossible; still the shipped code (packages/db/scripts/audit-sends-history.ts:220)."

**Status: awaiting developer approval — not applied.**

---

## Entry 9 — WAL-archiving acceptance criterion superseded

**Verdict: WAIVE-PROPOSED — awaiting developer approval**

Confirmed the cited SUMMARY exists:
```
$ ls -la .planning/milestones/v1.1-phases/17-address-tech-debt-wr-06-medium-security-follow-ups/17-05-SUMMARY.md
-rw-r--r--@ 1 primeropanther  staff  33578 Aug 20 20:54 ...
```

Quoted ratified corrected criterion (17-05-SUMMARY.md):
> "Ratified: the WAL-archiving acceptance criterion (plan text and must_haves truth #2's literal
> 'failed_count is 0 in both reads') is corrected to 'archived_count strictly increases;
> failed_count unchanged from baseline; last_failed_time/wal unmoved' -- pg_stat_archiver's
> failed_count is cumulative since stats_reset (2026-08-14 stanza bring-up), so the literal
> criterion could never pass on this host regardless of whether the cutover succeeded. The
> corrected form is a strictly better detector of the threat (T-17-28: archiving silently not
> resuming) it exists to guard."

And the Deviations section entry itself:
> "**1. [Rule 1 - Bug] WAL-archiving acceptance criterion corrected** ... Verification: Attempt 2
> step 6 passed under the corrected criterion (archived_count 123->126, failed_count 67 unchanged,
> last_failed unmoved); attempt 3 confirmed it again (131->133, 67 unchanged)."

**Basis:** the original plan's literal acceptance text was unsatisfiable against real cumulative
`pg_stat_archiver` history on this host and was replaced by a ratified, strictly-better criterion
— a superseded plan assertion caught and corrected in the same plan, not a product defect.

**Proposed waive reason (single line, pass-through ready):**
> "Superseded plan assertion, not a defect: 17-05's literal WAL criterion ('failed_count is 0 in both reads') was unsatisfiable against this host's cumulative pg_stat_archiver history and was ratified-replaced by a strictly-better criterion (archived_count strictly increases, failed_count unchanged from baseline, last_failed unmoved), independently confirmed twice in the same plan (17-05-SUMMARY.md)."

**Status: awaiting developer approval — not applied.**

---

## Entry 11 — pgBackRest 2.59.1 patch-level drift

**Verdict: WAIVE-PROPOSED — awaiting developer approval**

Quoted ratification passage (17-05-SUMMARY.md):
> "Ratified: pgBackRest 2.59.1 (vs. the runbook's documented 2.59.0) is accepted, not rebuilt
> pinned -- T-14-58/T-14-88 are provenance/tag-immutability threats, never apt-level
> build-reproducibility ones, and the plan's own acceptance text already carried the escape hatch
> ('unless a base-image change was intended'). Proven, not merely asserted: the restore drill
> (Task 2) restored and verified a repository whose backups were written by 2.59.0 using the 2.59.1
> binary."

Checked `docs/runbooks/backups.md` for a stale `2.59.0` residual — NOT found; the runbook already
documents the correct ratified version:
```
$ grep -n "2.59" docs/runbooks/backups.md
49:**Installed pgBackRest version**: **2.59.1** as of the phase 17 CI-built ...
53:**2.59.0** confirmed by the original real arm64/amd64 builds on 2026-08-14 ...
70:The 2.59.1-vs-2.59.0 gap was explicitly ratified during phase 17's live ...
```
`docs/runbooks/backups.md` is already corrected and current (17-05-SUMMARY.md's own "Files
Modified" section confirms this file was in scope and updated). The residual found is elsewhere,
explicitly acknowledged as out-of-scope in 17-05-SUMMARY.md's own Deviations section (line 180):
> "Stale pgBackRest `2.59.0` mentions remain in `docker/postgres/Dockerfile`'s own comment and in
> SPECIFICATION.md -- both outside this plan's files_modified; docs/runbooks/backups.md (in scope)
> is already corrected."

Re-checked SPECIFICATION.md independently this run — it is NOT stale either; it documents 2.59.1
with the ratification citation (`SPECIFICATION.md:244`). Only `docker/postgres/Dockerfile`'s
in-file comment (lines 32/37) still reads `2.59.0` — a cosmetic comment, already flagged as an
accepted out-of-scope residual by 17-05 itself, not a new finding.

**Note (not a new ledger entry, not blocking the waive):** `docker/postgres/Dockerfile`'s header
comment (lines 32, 37) still says "Installed pgBackRest version: 2.59.0" — cosmetic drift in a
code comment, already acknowledged as out-of-scope by 17-05-SUMMARY.md. Recommendation:
`/gsd-quick` to update the comment to 2.59.1 for consistency, no urgency.

**Basis:** ratified during phase 17's live checkpoint with empirical cross-version restore proof;
the runbook this entry names (`docs/runbooks/backups.md`) is already corrected and current.

**Proposed waive reason (single line, pass-through ready):**
> "pgBackRest 2.59.1-vs-2.59.0 drift ratified as expected (17-05-SUMMARY.md): unpinned apt-get install against pgdg, provenance/tag-immutability threats unaffected, cross-version restore (2.59.0-written backups restored by 2.59.1) proven live; docs/runbooks/backups.md already corrected to 2.59.1."

**Status: awaiting developer approval — not applied.** (Separately: `docker/postgres/Dockerfile`
comment residual noted above, informational only, not part of this waive.)

---

## Task 3 — Ledger mutation and commit record

**Fixed set derived strictly from Task 1 verdicts above: ids 12, 13, 2.**
Ids 1, 3, 5, 8, 9, 10, 11 were NOT touched.

Branch at time of mutation:
```
$ git branch --show-current
fix/auth-session-lifecycle
```

Mutations (one id per invocation; each invocation's exit status was checked unpiped and was 0):

```
$ node /Users/primeropanther/.claude/gsd-core/bin/gsd-tools.cjs windows fixed 12
{
  "ok": true,
  "ledger": {
    "schema_version": 1,
    "open_count": 9,
    "waived_count": 0,
    "fixed_count": 4,
    "total_count": 13,
    "last_updated": "2026-08-25T14:25:49.623Z",
    "entries": [ /* ids 1-11, 13 unchanged from baseline (see baseline snapshot above), except: */
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
      }
    ]
  }
}
$ echo $?
0

$ node /Users/primeropanther/.claude/gsd-core/bin/gsd-tools.cjs windows fixed 13
{
  "ok": true,
  "ledger": {
    "schema_version": 1,
    "open_count": 8,
    "waived_count": 0,
    "fixed_count": 5,
    "total_count": 13,
    "last_updated": "2026-08-25T14:25:53.076Z",
    "entries": [ /* ids 1-11 unchanged, id 12 already fixed above, except: */
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
      }
    ]
  }
}
$ echo $?
0

$ node /Users/primeropanther/.claude/gsd-core/bin/gsd-tools.cjs windows fixed 2
{
  "ok": true,
  "ledger": {
    "schema_version": 1,
    "open_count": 7,
    "waived_count": 0,
    "fixed_count": 6,
    "total_count": 13,
    "last_updated": "2026-08-25T14:25:56.505Z",
    "entries": [ /* ids 12, 13 already fixed above, ids 1,3,5,8,9,10,11 unchanged, except: */
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
      }
    ]
  }
}
$ echo $?
0
```

No `WINDOWS_ALREADY_RESOLVED` error encountered — all three ids were `open` before mutation.

**Post-mutation `windows status` reconciliation against the pre-mutation baseline:**

| Metric | Baseline | Post-mutation | Delta | Expected |
|---|---|---|---|---|
| `total_count` | 13 | 13 | 0 | unchanged — holds |
| `waived_count` | 0 | 0 | 0 | unchanged — holds |
| `open_count` | 10 | 7 | −3 | −(size of fixed set = 3) — holds |
| `fixed_count` | 3 | 6 | +3 | +(size of fixed set = 3) — holds |

All four invariants hold; recomputed entirely by the tool, never typed by hand.

**Post-mutation `windows status` snapshot (verbatim, second of the two snapshots this report records):**

```json
{
  "ok": true,
  "ledger": {
    "schema_version": 1,
    "open_count": 7,
    "waived_count": 0,
    "fixed_count": 6,
    "total_count": 13,
    "last_updated": "2026-08-25T14:25:56.505Z",
    "entries": [
      { "id": 1, "kind": "deviation", "phase": "12", "file": ".planning/WINDOWS.md", "line": null, "description": "Ledger loss record: the pre-phase-12 WINDOWS.md (5 entries) was clobbered when 12-10's worktree force-committed a fresh ledger (commit 272ecc1) that overwrote the untracked main-repo file on merge. Original entry id 1 (pre-2026-08-07) is unrecoverable; entries 2-5 reconstructed below from orchestrator session output.", "status": "open", "reason": "", "recorded_at": "2026-08-10T19:00:00.000Z", "resolved_at": null },
      { "id": 2, "kind": "unrun-verify", "phase": "10", "file": "", "line": null, "description": "npm run test:e2e fails to load Playwright config in this sandbox (ERR_MODULE_NOT_FOUND on a .ts deep-specifier under Node v26). Reproduced identically with plan 10-09's changes fully stashed -- pre-existing environment gap, not caused by this plan. See deferred-items.md. [reconstructed after ledger clobber; original kind/file fields lost]", "status": "fixed", "reason": "", "recorded_at": "2026-08-07T19:38:44.565Z", "resolved_at": "2026-08-25T14:25:56.505Z" },
      { "id": 3, "kind": "deviation", "phase": "11", "file": "packages/db/scripts/audit-sends-history.ts", "line": null, "description": "Plan 11-02 deviated from literal single-DATABASE_URL design; uses SCAN_DATABASE_URL + rollback-only per-workspace loop instead (documented in 11-02-SUMMARY.md Deviations)", "status": "open", "reason": "", "recorded_at": "2026-08-09T10:21:28.109Z", "resolved_at": null },
      { "id": 4, "kind": "deviation", "phase": "12", "file": "apps/worker/src/queues/__tests__/tenant-deferral.test.ts", "line": null, "description": "Repo-root lint regressed: 16 @typescript-eslint/unbound-method errors from 12-01's fake Job/Worker spy assertions (commits ffcbec1/c185ddb), surfaced during 12-02. Fixed post-wave-2 by orchestrator (commit 105d30e) with rule-scoped file-level eslint-disable directives matching the pre-send-gate.test.ts precedent; repo lint exit 0 re-verified. [reconstructed after ledger clobber]", "status": "fixed", "reason": "", "recorded_at": "2026-08-10T13:00:00.000Z", "resolved_at": "2026-08-10T13:00:00.000Z" },
      { "id": 5, "kind": "unrun-verify", "phase": "12", "file": "apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts", "line": null, "description": "Timing flake under full-suite parallel load: waitFor 10s timeout when other suites contend on shared Redis (failed once in wave-4 post-merge gate; passed in isolation and on full re-run). Same family as webhooks-signature.test.ts contamination noted in 12-11-SUMMARY.md. Candidate for a shared-Redis isolation fix. [reconstructed after ledger clobber]", "status": "open", "reason": "", "recorded_at": "2026-08-10T18:00:00.000Z", "resolved_at": null },
      { "id": 6, "kind": "lint-warning", "phase": "12", "file": "apps/worker/src/__tests__/graceful-shutdown.test.ts", "line": null, "description": "Pre-existing require-await lint errors from plan 12-08 (4 in graceful-shutdown.test.ts, 7 in shared-error-listener.test.ts); out of scope for 12-10, discovered while running repo-wide lint", "status": "fixed", "reason": "", "recorded_at": "2026-08-10T16:45:27.906Z", "resolved_at": "2026-08-10T16:52:08.272Z" },
      { "id": 7, "kind": "lint-warning", "phase": "12", "file": "apps/worker/src/__tests__/graceful-shutdown.test.ts", "line": null, "description": "11 @typescript-eslint/require-await errors from 12-08's test stubs (async () => undefined and awaitless async mockImplementations), flagged by 12-10's executor. Fixed by orchestrator post-wave-6 with explicit Promise.resolve stubs; repo lint exit 0 re-verified.", "status": "fixed", "reason": "", "recorded_at": "2026-08-10T16:52:08.272Z", "resolved_at": "2026-08-10T16:52:08.272Z" },
      { "id": 8, "kind": "skipped-test", "phase": "13", "file": "packages/redaction/src/__tests__/scrub-identifier-false-positive.test.ts", "line": null, "description": "NOT skipped, but probabilistically flaky (closest allowed kind): Test 3 samples 5000 random v4 UUIDs against the phone valueRule; an all-digit-group UUID (e.g. 17240210-0546-4077-9954-207876832048) still gets redacted despite the 3cd3f0c anchoring fix. Failed once in Phase 13 wave-3 post-merge gate, passed 3/3 on re-run; package untouched by Phase 13 (pre-existing). Fix direction: exclude UUID-shaped values before the phone rule, or seed the sampler.", "status": "open", "reason": "", "recorded_at": "2026-08-11T20:30:09.687Z", "resolved_at": null },
      { "id": 9, "kind": "deviation", "phase": "17", "file": ".planning/phases/17-address-tech-debt-wr-06-medium-security-follow-ups/17-05-PLAN.md", "line": null, "description": "Task 1 acceptance text 'failed_count is 0 in both reads' / must_haves truth #2 unsatisfiable against real cumulative pg_stat_archiver history; superseded by ratified corrected WAL criterion (archived_count strictly increases, failed_count unchanged from baseline, last_failed unmoved) -- see 17-05-SUMMARY.md", "status": "open", "reason": "", "recorded_at": "2026-08-19T19:35:29.693Z", "resolved_at": null },
      { "id": 10, "kind": "deviation", "phase": "17", "file": ".planning/phases/17-address-tech-debt-wr-06-medium-security-follow-ups/17-CONTEXT.md", "line": null, "description": "D-11 amended from verify-still-running to establish-then-verify: alloy was never durably deployed to production (deploy.sh never issues the compose up -d that would create it; 15-UAT test 5 was a bare unevidenced pass); operator provisioned Loki credentials and started alloy live during this plan's checkpoint -- see 17-05-SUMMARY.md", "status": "open", "reason": "", "recorded_at": "2026-08-19T19:35:43.284Z", "resolved_at": null },
      { "id": 11, "kind": "deviation", "phase": "17", "file": "docker/postgres/Dockerfile", "line": null, "description": "pgBackRest patch-level drift (2.59.1 vs docs/runbooks/backups.md's documented 2.59.0) ratified as expected, not a defect -- unpinned apt-get install pgbackrest against pgdg; T-14-58/T-14-88 are provenance/tag-immutability threats, not apt-reproducibility ones; cross-version restore proof landed live -- see 17-05-SUMMARY.md", "status": "open", "reason": "", "recorded_at": "2026-08-19T19:35:43.551Z", "resolved_at": null },
      { "id": 12, "kind": "deviation", "phase": "17", "file": "scripts/deploy.sh", "line": null, "description": "Leg-isolation defect discovered by operator dry-run during this plan's live checkpoint: mutating compose calls (up -d web api / run --rm migrate / up -d worker) implicitly recreated db/redis via dependency convergence without --no-deps -- an ungated db cutover hidden inside the routine app-deploy path. Fixed and merged (PR #17, TDD RED 393a004 -> GREEN 3de6771) as a phase-17 orchestrator-side fix, not authored by this plan -- see 17-05-SUMMARY.md", "status": "fixed", "reason": "", "recorded_at": "2026-08-19T19:35:43.817Z", "resolved_at": "2026-08-25T14:25:49.623Z" },
      { "id": 13, "kind": "deviation", "phase": "17", "file": "apps/web/vite.config.ts", "line": null, "description": "charts-vendor/canvas-vendor static import-cycle crash (advancedChunks.includeDependenciesRecursively: false, phase 15 plan 03) broke the dashboard growth chart and the flow editor in every production build since 2026-08-15; discovered by this plan's Task 1 step 7. Fixed with strictExecutionOrder: true and a wired check-web-chunks CI gate (PR #16, commits bd8a66c/2f77147), a phase-17 orchestrator-side fix, not authored by this plan -- see 17-05-SUMMARY.md", "status": "fixed", "reason": "", "recorded_at": "2026-08-19T19:35:44.077Z", "resolved_at": "2026-08-25T14:25:53.076Z" }
    ]
  }
}
```

**Ship-gate wording check (post-mutation, pre-commit):**
```
$ grep -q 'blocks while' .planning/WINDOWS.md && grep -q 'open_count > 0' .planning/WINDOWS.md && echo intact
intact
```
Matched line: `> Cross-phase defect register. \`/gsd-ship\` blocks while \`open_count > 0\`.`

**Commit:**
```
$ git add .planning/WINDOWS.md
$ git commit -m "docs(windows): close provably-fixed broken-window entries after evidence audit ..."
[fix/auth-session-lifecycle 8489c0c] docs(windows): close provably-fixed broken-window entries after evidence audit
 1 file changed, 12 insertions(+), 12 deletions(-)
```

**Branch:** `fix/auth-session-lifecycle`
**Commit sha:** `8489c0c7a02ff99707d519fdea2cb433bf408da1`

**Post-commit re-grep (proving content survived the git operation, per constraint 16 — this repo
has a documented history of a tracked `.planning/` file being silently clobbered by an
intervening git operation):**
```
$ git show --numstat --format= HEAD
12	12	.planning/WINDOWS.md
```
Only path touched: `.planning/WINDOWS.md` (single line of numstat output, confirmed both the
insertion/deletion counts and that no other file appears).

```
$ grep -n 'blocks while' .planning/WINDOWS.md; grep -n 'open_count > 0' .planning/WINDOWS.md
12:> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.
```
Ship-gate line survived byte-identical.

```
$ head -8 .planning/WINDOWS.md
---
schema_version: 1
open_count: 7
waived_count: 0
fixed_count: 6
total_count: 13
last_updated: 2026-08-25T14:25:56.505Z
---
```
Frontmatter counts survived matching exactly what `windows status` reported before the commit
(`open_count: 7`, `waived_count: 0`, `fixed_count: 6`, `total_count: 13`).

```
$ git diff --quiet -- .planning/WINDOWS.md && echo clean
clean
```
Ledger committed clean — no uncommitted residue.

---

## Summary table

| id | verdict | evidence pointer |
|----|---------|-------------------|
| 1 | WAIVE-PROPOSED | tombstone; WINDOWS.md now tracked (`git ls-files` confirms); recurrence path forbidden by standing constraints |
| 2 | **FIXED** (closed) | `playwright test --list` loads clean; fix commit `1402968` (2026-08-11), post-dates ledger entry |
| 3 | WAIVE-PROPOSED | 11-02-SUMMARY.md Deviations; `SCAN_DATABASE_URL` still live at `audit-sends-history.ts:220` |
| 5 | DEFECT-CONFIRMED | no shared-Redis isolation mechanism found in `flow-queues.ts`/`queue-core`; zero tests run |
| 8 | DEFECT-CONFIRMED | live probe: fixed UUID `17240210-0546-4077-9954-207876832048` still redacted; all-digit-group case unreachable by the `3cd3f0c` anchoring fix |
| 9 | WAIVE-PROPOSED | 17-05-SUMMARY.md ratified corrected WAL criterion, confirmed twice (attempts 2 and 3) |
| 10 | RESIDUAL-GAP | `alloy` service defined in `docker-compose.prod.yml:458`, zero non-comment occurrences in `scripts/deploy.sh` |
| 11 | WAIVE-PROPOSED | 17-05-SUMMARY.md ratification + cross-version restore proof; `docs/runbooks/backups.md` already corrected to 2.59.1 |
| 12 | **FIXED** (closed) | 6/6 mutating compose calls carry `--no-deps`; guard test 21/21 passing |
| 13 | **FIXED** (closed) | `strictExecutionOrder: true` present; `check-web-chunks` gate wired at `.github/workflows/ci.yml:78` |

**Resulting `open_count`: 7** (ids 1, 3, 5, 8, 9, 10, 11). These continue to block `/gsd-ship` by
design until the developer approves the waive proposals below and/or the confirmed defects are
fixed.

## Waive proposals awaiting developer approval (NOT applied — orchestrator must get approval before applying)

1. **Id 1** — "Un-fixable tombstone: pre-phase-12 ledger loss (5 entries) from a worktree force-commit overwriting an untracked file on merge; WINDOWS.md is now git-tracked (git ls-files confirms) and the exact recurrence action is now forbidden by standing executor constraints — nothing further can restore the lost entry or prevent a structurally identical loss."
2. **Id 3** — "Documented design deviation (11-02-SUMMARY.md, Rule 3 blocking-fix): audit-sends-history.ts uses SCAN_DATABASE_URL + a rollback-only per-workspace loop instead of a single DATABASE_URL connection, because RLS on sends/send_events makes the literal plan design structurally impossible; still the shipped code (packages/db/scripts/audit-sends-history.ts:220)."
3. **Id 9** — "Superseded plan assertion, not a defect: 17-05's literal WAL criterion ('failed_count is 0 in both reads') was unsatisfiable against this host's cumulative pg_stat_archiver history and was ratified-replaced by a strictly-better criterion (archived_count strictly increases, failed_count unchanged from baseline, last_failed unmoved), independently confirmed twice in the same plan (17-05-SUMMARY.md)."
4. **Id 11** — "pgBackRest 2.59.1-vs-2.59.0 drift ratified as expected (17-05-SUMMARY.md): unpinned apt-get install against pgdg, provenance/tag-immutability threats unaffected, cross-version restore (2.59.0-written backups restored by 2.59.1) proven live; docs/runbooks/backups.md already corrected to 2.59.1."

## Confirmed defects and next-milestone recommendations

1. **Id 5** — `/gsd-debug` on shared-Redis test isolation for `apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts`. Candidate fix: a per-suite unique BullMQ queue-name prefix or a dedicated Redis logical DB per worker test file.
2. **Id 8** — `/gsd-debug` on `packages/redaction/src/rules.ts`'s phone valueRule. Root cause identified (all-digit-group UUIDs have no hex-letter boundary for the `3cd3f0c` anchoring fix to exploit). Fix direction: exclude UUID-shaped values before applying the phone rule.
3. **Id 10** — next-milestone requirement: add `alloy` to `scripts/deploy.sh`'s mutating-service startup path (or a dedicated observability-stack startup step) so a fresh production bring-up durably (re)establishes the sidecar without requiring a manual operator step.

## Informational note (not a ledger entry, not blocking any waive)

`docker/postgres/Dockerfile`'s header comment (lines 32, 37) still reads "2.59.0" — cosmetic drift
already acknowledged as out-of-scope by 17-05-SUMMARY.md. Suggested `/gsd-quick` to update the
comment string for consistency; no urgency, no ledger action needed.

## Waive decisions (developer approval, 2026-08-25)

Proposals presented interactively; developer approved **ids 1, 3, 11** and declined **id 9**.

- id 1 — waived via `gsd-tools windows waive 1` (un-fixable tombstone; recurrence structurally closed).
- id 3 — waived via `gsd-tools windows waive 3` (documented 11-02 SCAN_DATABASE_URL deviation, shipped as designed).
- id 11 — waived via `gsd-tools windows waive 11` (ratified pgBackRest 2.59.1 drift, cross-version restore proven).
- id 9 — **declined by developer**, remains open (superseded WAL criterion; carry to next milestone as a decision item).

Final ledger counts after approvals: open_count=4 (ids 5, 8, 9, 10), fixed_count=6, waived_count=3, total_count=13.
Ship gate wording unchanged; `/gsd-ship` still blocks while open_count > 0.
