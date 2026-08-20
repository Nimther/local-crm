---
phase: 11
slug: delivery-correctness
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
validated: 2026-08-09
wave_0_complete: true
created: 2026-08-09
---

# Phase 11 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

Scope: 11 plans, 31 tasks — 29 carrying an `<automated>` command (one of them the
wave-3 tracer) plus 2 blocking human checkpoints — across waves 1–11, covering
requirements DLV-01 … DLV-09.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest `4.1.9` (root devDependency, already configured — no install needed) |
| **Config file** | Per-workspace: `apps/worker/vitest.config.ts`, `apps/api/vitest.config.ts`, `packages/delivery-core/vitest.config.ts`, `packages/db/vitest.config.ts`, `apps/web/vitest.config.ts`; aggregated by root `vitest.config.ts` (`test.projects`) |
| **Quick run command** | `npx vitest run --root <workspace> <test path>` — the exact per-task command from the table below |
| **Full suite command** | `npm run coverage` (root — aggregates all 12 backend projects into one denominator) |
| **Failure-injection suite** | `npm run failure:all` (5 scenarios today; 8 after 11-11) |
| **Estimated runtime** | quick run ~2–3 s measured; `npm run failure:all` **13.7 s** measured (5 scenarios) → ~30 s projected at 8; `npm run coverage` **66.9 s** measured (exit 0, 83.21% statements) |
| **Live dependencies** | Postgres + Redis (both confirmed up: `pg_isready` → accepting connections, `redis-cli ping` → PONG). `packages/test-support/src/global-setup.ts` provisions a per-run ephemeral DSN and fails closed if `TEST_DATABASE_URL` resolves to the same physical DB as `DATABASE_URL`. |
| **Watch mode** | None. Every command in this phase uses `vitest run`; `apps/worker/vitest.config.ts` additionally pins `watch: false`. |

---

## Sampling Rate

- **After every task commit:** run that task's exact `<automated>` command from the per-task map (~2–3 s).
- **After every plan wave:** run the wave's plan-level commands, plus `npm run failure:all` once waves 6+ have landed (the ambiguous-outcome path is what the failure scenarios assert against).
- **After waves that touch migrations (2, 8):** `npm run lint:migrations && npm run db:migrate` before any dependent wave starts.
- **Before `/gsd-verify-work`:** `npm run coverage` green (~67 s) **and** `npm run failure:all` green (8 scenarios).
- **Max feedback latency:** **3 s** per task; **67 s** to the full aggregated suite.

---

## Per-Task Verification Map

Task ID format: `{phase}-{plan}-{task}`. "File Exists" describes the state of the
test file *before* the task runs — every ❌ file is created by its own task's TDD
RED step (the file is listed in that task's `<files>`), so no task depends on a
scaffold another wave must produce.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 11-01-01 | 01 | 1 | DLV-01 | T-11-01-02 | Adding a `SendStatus` value without a transition row fails `npm run typecheck` (`satisfies Record<SendStatus, …>`) | unit | `npx vitest run --root packages/delivery-core src/__tests__/send-state-machine.test.ts` | ❌ new (created in-task, TDD) | ✅ green |
| 11-01-02 | 01 | 1 | DLV-01, DLV-07 | T-11-01-03 | Published delivery-model wording may not claim `exactly-once`; the check rejects it | doc assertion | `node -e "const s=require('fs').readFileSync('ARCHITECTURE.md','utf8'); const sec=s.split(/^## /m).find(b=>b.startsWith('9.')); if(!sec) throw new Error('section 9 missing'); for (const t of ['stateDiagram-v2','reconciling','unknown','at-most-once','Writer']) if(!sec.includes(t)) throw new Error('missing: '+t); if(/exactly-once/i.test(sec)) throw new Error('delivery model overstates guarantee'); console.log('ok')"` | ✅ `ARCHITECTURE.md` | ✅ green |
| 11-01-03 | 01 | 1 | DLV-01, DLV-07 | T-11-01-01 | Writer matrix reviewed **before** any dispatch code (D-18); an omission here becomes a production race in 8 later plans | checkpoint:human-verify (`blocking`) | manual review; step 6 re-runs `npx vitest run --root packages/delivery-core src/__tests__/send-state-machine.test.ts` | ❌ W0-in-task (11-01-01) | ✅ green |
| 11-02-01 | 02 | 2 | DLV-02, DLV-03 | T-11-02-02, T-11-02-03 | Audit script is provably read-only (no write keyword in comment-stripped source) and reports counts/timestamps/status names only — never addresses or ids | script + source assertion | `npm run db:audit-sends-history && node -e "…strip comments from audit-sends-history.ts, throw on any of INSERT/UPDATE/DELETE/ALTER/CREATE…"` (copy the one-liner verbatim from 11-02-PLAN.md Task 1 — it contains a regex alternation that a markdown table cannot carry losslessly) | ❌ new (script created in-task) | ✅ green |
| 11-02-02 | 02 | 2 | DLV-02, DLV-03, DLV-09 | T-11-02-01, T-11-02-04, T-11-02-05 | Enum add and enum use never share a migration file; no `UPDATE`/`DELETE` against `sends`; `send_reconciler_runs` carries no tenant data | migration + schema assertion | `npm run lint:migrations && npm run db:migrate && node -e "…enum_range(send_status) == [dispatching,excluded,failed,reconciling,sent,unknown]; reconciling_since/dispatched_at/dispatch_duration_ms present; to_regclass('send_reconciler_runs') non-null…"` (full one-liner in 11-02-PLAN.md Task 2) | ✅ `lint:migrations`, `db:migrate` exist | ✅ green |
| 11-02-03 | 02 | 2 | DLV-02, DLV-09 | T-11-02-01 | Growing the enum reclassifies no historical row — `workspace_daily_rollup` totals stay byte-identical | unit + integration | `npx vitest run --root packages/db src/__tests__/send-status-enum-parity.test.ts && npx vitest run --root apps/worker src/queues/__tests__/rollup-enum-migration-invariant.test.ts` | ❌ both new (created in-task) | ✅ green |
| 11-03-01 | 03 | 3 | DLV-02, DLV-03 | T-11-03-01, T-11-03-04, T-11-03-05, T-11-03-06, T-11-03-07, T-11-03-08 | Terminal write claimed under `FOR UPDATE SKIP LOCKED`; discovery scan runs through Phase 10's `mega_crm_scan` (SELECT-only, `NOBYPASSRLS`); unknown `schemaVersion` is deferred, never best-effort-processed | integration (tracer, end-to-end) | `npx vitest run --root apps/worker src/queues/__tests__/send-reconciler-tracer.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-03-02 | 03 | 3 | DLV-04 | T-11-03-02, T-11-03-03 | Retry worker refuses `reconciling`/`unknown` rows — asserted at `processSendJob` level with zero provider calls; `recordExcluded`'s `NOT IN` guard covers both new states | integration | `npx vitest run --root apps/worker src/queues/__tests__/claim-gate-exclusivity.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-04-00 | 04 | 4 | DLV-05 | T-11-04-SC | `uuid` is `[ASSUMED]`-tagged; install is gated on human verification of registry/repo/postinstall. Never auto-approvable (`workflow.auto_advance` ignored) | checkpoint:human-verify (`blocking-human`) | manual: npmjs.com/package/uuid + `npm view uuid dist-tags.latest repository.url scripts` | N/A (pre-install gate) | ✅ green |
| 11-04-01 | 04 | 4 | DLV-05 | T-11-04-02, T-11-04-04 | Golden vector pins both the `SEND_ID_NAMESPACE` literal and one full derivation, so an edit fails a test rather than silently orphaning historical correlations | unit | `npx vitest run --root packages/delivery-core src/__tests__/send-id.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-04-02 | 04 | 4 | DLV-05 | T-11-04-01 | Ids derive from tenant-scoped identifiers only; a guessed `send_id` cannot cross a workspace boundary (RLS still scopes the row) | integration | `npx vitest run --root apps/worker src/queues/__tests__/send-id-reclaim.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-05-01 | 05 | 5 | DLV-06 | T-11-05-05 | Classifier fails **closed** to `ambiguous` for every unrecognized shape, including non-object inputs — an unknown error can never be treated as safe to re-send | unit | `npx vitest run --root packages/delivery-core src/__tests__/transport-classify.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-05-02 | 05 | 5 | DLV-06 | T-11-05-01, T-11-05-03 | `AbortSignal.timeout(SENDGRID_TIMEOUT_MS)` bounds every provider call; the abort error still exits through `redactApiKey` | unit | `npx vitest run --root packages/delivery-core src/__tests__` | ✅ `packages/delivery-core/src/__tests__/send-mail.test.ts` — needs new abort/redaction assertions | ✅ green |
| 11-05-03 | 05 | 5 | DLV-06 | T-11-05-02, T-11-05-04, T-11-05-06 | `SENDGRID_TIMEOUT_MS + margins < SEND_LOCK_DURATION_MS` asserted against the **real exported constants**, so a future edit to either number fails the build; 429/5xx consumes bounded attempts instead of an unbounded `Retry-After` loop | unit (invariant) | `npx vitest run --root apps/worker src/queues/__tests__/send-timing-invariant.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-06-01 | 06 | 6 | DLV-02, DLV-09 | — | Ledger writes carry `dispatched_at`/`dispatch_duration_ms` and the `reconciling` status — the DLV-09 metric is populated, not just queryable | integration | `npx vitest run --root apps/worker src/queues/__tests__/send-duration.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-06-02 | 06 | 6 | DLV-02, DLV-06, DLV-08 | T-11-06-01, T-11-06-02, T-11-06-03, T-11-06-04, T-11-06-05 | An ambiguous outcome records `reconciling`, never `failed`, increments no counter, and triggers no completion check; only the three named pre-connection codes release the claim and retry | integration | `npx vitest run --root apps/worker src/queues/__tests__/ambiguous-outcome.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-06-03 | 06 | 6 | DLV-02 | T-11-06-01 | Flow-side interrupted branch reaches parity with the campaign path — no second code path can still write `failed` | integration | `npx vitest run --root apps/worker src/queues/__tests__/flow-send-idempotency.test.ts` | ✅ exists — needs new parity assertions | ✅ green |
| 11-07-01 | 07 | 7 | DLV-03 | T-11-07-01, T-11-07-04 | Create and patch bodies asserted identical, so a reconnect cannot silently drop a previously-enabled event type; all eight pre-existing flags asserted still true | unit | `npx vitest run --root apps/api src/modules/webhooks/__tests__/webhook-provision-event-flags.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-07-02 | 07 | 7 | DLV-03 | T-11-07-02, T-11-07-03, T-11-07-05 | `processed` is evidence and nothing else — no fact-column write, no status write; the channel is already ECDSA-verified against the raw body upstream | integration | `npx vitest run --root apps/worker src/queues/__tests__/webhook-events-processed.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-08-01 | 08 | 8 | DLV-03 | T-11-08-04 | `ReconcileVerdict` has no failure member — a reconciler-written `failed` is a compile error, not a review finding | unit | `npx vitest run --root packages/delivery-core src/__tests__/reconciler-classify.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-08-02 | 08 | 8 | DLV-03, DLV-04 | T-11-08-01, T-11-08-02, T-11-08-06 | Counter backfill fires only on an actual claimed transition; two concurrent ticks (`Promise.all`) produce one increment; `RECONCILER_BATCH_LIMIT` caps tick work | migration + integration | `npm run lint:migrations && npm run db:migrate && npx vitest run --root apps/worker src/queues/__tests__/campaign-completion.test.ts` | ✅ `campaign-completion.test.ts` exists — needs new ambiguity-aware assertions | ✅ green |
| 11-08-03 | 08 | 8 | DLV-03, DLV-04 | T-11-08-03, T-11-08-05, T-11-08-07 | `STALE_DISPATCHING_AGE_MS > SEND_MAX_JOB_LIFETIME_MS` asserted against real constants (D-08's 2 h threshold); evidence read only inside `withTenant`/`withTenantTransaction` under RLS; tick logs counts only | integration | `npx vitest run --root apps/worker src/queues/__tests__/send-reconciler-verdicts.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-09-01 | 09 | 9 | DLV-03 | T-11-09-01 | `evaluateReconcilerHealth(null, …)` returns unhealthy with `missing_health_row` — a missing row is not silently healthy | unit | `npx vitest run --root packages/db src/__tests__/reconciler-run.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-09-02 | 09 | 9 | DLV-03 | T-11-09-02, T-11-09-03 | Alert body mechanically asserted to match no UUID pattern, no email pattern, and to contain no `Bearer`; a single conditional `UPDATE … RETURNING` claim with a 6 h dedup window prevents a cross-replica alert storm | unit | `npx vitest run --root apps/api src/modules/ops/__tests__/send-reconciler-watchdog.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-09-03 | 09 | 9 | DLV-03 | T-11-09-04, T-11-09-05, T-11-09-06 | A throwing tick skips the health write entirely (no try/catch around it), so a failing reconciler cannot report itself alive; `recordReconcilerRun` never touches `last_alert_sent_at` | integration | `npx vitest run --root apps/worker src/queues/__tests__/send-reconciler-health.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-10-01 | 10 | 10 | DLV-02, DLV-07 | T-11-10-01, T-11-10-03 | An `unknown` row with every delivery fact null never renders as `sent` — the prohibition this phase turns on; `?status=` stays bound as `= ANY($n::text[])`, never interpolated | unit + integration | `npx vitest run --root apps/api src/modules/send-log/__tests__/send-log-filters.test.ts && npx vitest run --root apps/web src/features/send-log/__tests__/send-log-status-vocabulary.test.ts` | ✅ api file exists (needs new assertions) / ❌ web file new (created in-task) | ✅ green |
| 11-10-02 | 10 | 10 | DLV-02, DLV-07 | T-11-10-04, T-11-10-05 | An ambiguous test send **returns** rather than throws, so BullMQ completes instead of redelivering (no retry storm); the log line names campaign id + outcome only, never `testTo` | integration | `npx vitest run --root apps/worker src/queues/__tests__/test-send-outcome.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-10-03 | 10 | 10 | DLV-07 | T-11-10-02 | Confirmation copy describes the 202 (queued), not delivery — an acceptance criterion greps for the removed overstating literal | unit (component) + lint | `npx vitest run --root apps/web src/features/campaigns && npm run lint -- apps/web` | ✅ `apps/web/src/features/campaigns/__tests__/campaign-metrics.test.ts` exists; ❌ the copy assertion is new in that directory | ✅ green |
| 11-11-01 | 11 | 11 | **DLV-08 boundary 1 + boundary 2**, DLV-02 | T-11-11-01, T-11-11-04 | The kill harness injects only `sendMail` and never boots the queue runtime, so no scenario can reach real SendGrid; each real-kill scenario keeps the `survivor` `afterAll` cleanup so a failed assertion cannot orphan a child holding a DB connection | integration (real process kill) | `npx vitest run --root apps/worker src/queues/__tests__/failure-injection/crash-post-accept.test.ts` | ❌ new (created in-task); `sigkill.test.ts` exists and is retargeted `failed` → `reconciling` | ✅ green |
| 11-11-02a | 11 | 11 | **DLV-08 boundary 3** (pre-result-write) | — (state-based; no process spawned, so T-11-11-01/04 do not apply) | The 4xx variant asserts the row resolves to `unknown` and explicitly **not** `failed` — the accepted, documented cost of at-most-once; both variants assert zero provider calls on redelivery | integration (failure-injection) | `npx vitest run --root apps/worker src/queues/__tests__/failure-injection/crash-pre-result-write.test.ts src/queues/__tests__/failure-injection/reconciler-retry-race.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-11-02b | 11 | 11 | **DLV-08 three-way race**, DLV-04 | T-11-11-05 | The race runs a bounded loop of ≥10 fresh intents with genuine `Promise.all` concurrency and asserts the invariants on every iteration, so a lucky schedule cannot pass the suite | integration (failure-injection) | `npx vitest run --root apps/worker src/queues/__tests__/failure-injection/crash-pre-result-write.test.ts src/queues/__tests__/failure-injection/reconciler-retry-race.test.ts` | ❌ new (created in-task) | ✅ green |
| 11-11-03 | 11 | 11 | **DLV-07 delivery-model claims**, DLV-08 | T-11-11-02, T-11-11-03 | Each published guarantee becomes an executable proposition — the never-re-sent claim asserted by observed provider-call count, not by inspecting source; all eight scenarios wired into the `failure-injection` required check | unit + suite chain | `npx vitest run --root apps/worker src/queues/__tests__/delivery-model-claims.test.ts && npm run failure:all` | ❌ claims test new (created in-task); ✅ `failure:all` exists (extended 5 → 8) | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Requirement coverage roll-up:** DLV-01 → 11-01-01/02/03 · DLV-02 → 11-02-02/03, 11-03-01, 11-06-01/02/03, 11-10-01/02, 11-11-01 · DLV-03 → 11-02-01/02, 11-03-01, 11-07-01/02, 11-08-01/02/03, 11-09-01/02/03 · DLV-04 → 11-03-02, 11-08-02/03, 11-11-02b · DLV-05 → 11-04-00/01/02 · DLV-06 → 11-05-01/02/03, 11-06-02 · DLV-07 → 11-01-02/03, 11-10-01/02/03, 11-11-03 · DLV-08 → 11-06-02, 11-11-01/02a/02b/03 · DLV-09 → 11-02-02/03, 11-06-01. All nine requirements have at least one automated command.

---

## DLV-08 Crash-Boundary Scenario Coverage

DLV-08 requires crash coverage at three boundaries plus the reconciler/retry race.
All four land in plan 11-11, each with its own npm script and its own named step in
the `failure-injection` CI job — which is a **required status check on `master`**
(alongside `static` and `test`; `e2e` deliberately is not). Today `ci.yml` runs 5
`npm run failure:` steps; 11-11 Task 3 takes that to 8 and asserts it with
`grep -c "npm run failure:" .github/workflows/ci.yml` returning 8.

| Scenario | Requirement | Task | Test file | npm script | In `failure:all` | CI step |
|----------|-------------|------|-----------|------------|------------------|---------|
| Boundary 1 — crash before the provider call | DLV-08, DLV-02 | 11-11-01 | `apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts` (existing, assertion retargeted `failed` → `reconciling`) | `failure:sigkill` (exists) | ✅ already chained | ✅ exists (line 199) |
| **Boundary 2 — crash after SendGrid accepts** | **DLV-08** | 11-11-01 | `apps/worker/src/queues/__tests__/failure-injection/crash-post-accept.test.ts` (new, real process kill on `SIGKILL_HARNESS_ACCEPTED`) | `failure:crash-post-accept` (added by 11-11 Task 3) | ➕ added by 11-11 Task 3 | ➕ added by 11-11 Task 3 |
| **Boundary 3 — crash before the result write** | **DLV-08** | 11-11-02a | `apps/worker/src/queues/__tests__/failure-injection/crash-pre-result-write.test.ts` (new, state-based; 202 and permanent-4xx variants) | `failure:crash-pre-result-write` (added by 11-11 Task 3) | ➕ added by 11-11 Task 3 | ➕ added by 11-11 Task 3 |
| **Three-way race — reconciler vs retry worker** | **DLV-08, DLV-04** | 11-11-02b | `apps/worker/src/queues/__tests__/failure-injection/reconciler-retry-race.test.ts` (new, ≥10 iterations, genuine `Promise.all`) | `failure:reconciler-race` (added by 11-11 Task 3) | ➕ added by 11-11 Task 3 | ➕ added by 11-11 Task 3 |
| **Delivery-model claims cross-check** | **DLV-07** | 11-11-03 | `apps/worker/src/queues/__tests__/delivery-model-claims.test.ts` (new) | run directly via `npx vitest run --root apps/worker …`; gated in CI by the `test` job (aggregated `apps/worker` project) | n/a — not a failure-injection scenario | ✅ covered by the `test` required check |

Exact commands (as written in 11-11-PLAN.md, reproduced verbatim):

- Boundary 2: `npx vitest run --root apps/worker src/queues/__tests__/failure-injection/crash-post-accept.test.ts`
- Boundary 3 **and** three-way race: `npx vitest run --root apps/worker src/queues/__tests__/failure-injection/crash-pre-result-write.test.ts src/queues/__tests__/failure-injection/reconciler-retry-race.test.ts`
- Delivery-model claims: `npx vitest run --root apps/worker src/queues/__tests__/delivery-model-claims.test.ts && npm run failure:all`

Boundary 3 is deliberately state-based rather than kill-based: boundaries 2 and 3
leave an *identical* ledger state, so a second real-kill harness would add process
machinery without adding an assertion — while the provider response variant
(202 vs permanent 4xx), which is the thing that actually differs, is parameterised
directly. This is recorded here so a later reader does not read the absence of a
third `SIGKILL_HARNESS_FREEZE_AT` value as a coverage gap.

---

## Wave 0 Requirements

**No separate Wave 0 scaffolding wave is required for this phase.**

- **Framework install:** none. Vitest 4.1.9, the per-workspace configs, the live
  Postgres/Redis harness (`packages/test-support`), the ephemeral-DSN global setup,
  and the `failure-injection/` process-kill harness (`spawn-and-kill.ts`,
  `sigkill-entrypoint.ts`, `failure-fixtures.ts`) are all already in place and
  green — confirmed by a measured `npm run coverage` (exit 0) and
  `npm run failure:all` (exit 0) on this branch.
- **Test-file scaffolds:** every ❌ file in the map above is listed in its own
  task's `<files>` and is written by that task's TDD RED step. No task's
  `<automated>` command names a file that a *different* task must create first,
  and no plan contains a `MISSING — Wave 0 must create …` marker.

RESEARCH.md `### Wave 0 Gaps` items, and where each is closed:

- [x] Reconciler evidence-resolution + reconciler-side exclusivity (DLV-03/DLV-04) — split across `send-reconciler-tracer.test.ts` (11-03-01), `claim-gate-exclusivity.test.ts` (11-03-02) and `send-reconciler-verdicts.test.ts` (11-08-03) rather than one `send-reconciler.test.ts`, so each wave's evidence lands with the wave that produces it.
- [x] `failure-injection/reconciler-retry-race.test.ts` (DLV-04 three-way race) — 11-11-02b, same path as researched.
- [x] `packages/delivery-core/src/__tests__/send-id.test.ts` (DLV-05) — 11-04-01, same path as researched.
- [x] Pure invariant test asserting `SENDGRID_TIMEOUT_MS + margins < SEND_LOCK_DURATION_MS` against literal configured constants (DLV-06 / Pitfall 5) — 11-05-03, `send-timing-invariant.test.ts`.
- [x] `recordExcluded`/`recordFlowExcluded` leave a `reconciling`/`unknown` row untouched (Pitfall 3) — 11-03-02, `claim-gate-exclusivity.test.ts`.
- [x] Framework install — not needed, per above.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Writer matrix and delivery-model wording reviewed before implementation | DLV-01, DLV-07 | D-18 makes this a *reviewed* artifact, not documentation written after the code. Eight later plans write transitions from this matrix, so an error propagates rather than being caught locally. | 11-01 Task 3 (`checkpoint:human-verify`, `blocking`): read `ARCHITECTURE.md` §9; confirm exactly one writer per transition except `dispatching -> reconciling` (two); confirm no `reconciling -> failed` row and that the reason is stated; confirm you are willing to publish the delivery-model paragraph; confirm `SEND_STATUS_TRANSITIONS` matches the table row for row; run `npx vitest run --root packages/delivery-core src/__tests__/send-state-machine.test.ts`. |
| `uuid` package legitimacy before install | DLV-05 | `uuid` carries the `[ASSUMED]` provenance tag (name recalled before registry cross-check). Package-legitimacy checkpoints are never auto-approvable — `workflow.auto_advance` is ignored. | 11-04 Task 0 (`checkpoint:human-verify`, `blocking-human`): open `npmjs.com/package/uuid`, confirm repo `github.com/uuidjs/uuid`, hundreds of millions weekly downloads, latest 14.x; run `npm view uuid dist-tags.latest repository.url scripts` and confirm no `postinstall`; name the exact version to pin (recorded verbatim in `SPECIFICATION.md` §2). |
| `ARCHITECTURE.md` §9 completeness — every live `send_status` value appears in both the diagram and the writer matrix | DLV-01 | Completeness of a prose/mermaid artifact is a review judgment; the automated check in 11-01-02 asserts required tokens are *present*, not that nothing is *absent*. Declared `verification: backstop` in 11-01's `must_haves`. | Covered by the 11-01 Task 3 review above (steps 2, 3, 5). |
| Delivery-model prose states no guarantee that is not exercised, and omits none that is | DLV-07 | The converse direction is a review judgment; `delivery-model-claims.test.ts` proves each stated claim holds but cannot prove the prose is exhaustive. Declared `verification: backstop` in 11-11's `must_haves`. | At `/gsd-verify-work`: read `ARCHITECTURE.md` §9 alongside `delivery-model-claims.test.ts` and confirm each paragraph sentence maps to a named test and vice versa. |
| Post-migration history audit review (DLV-09 metric availability across the 11-02 → 11-06 seam) | DLV-02, DLV-09 | `npm run db:audit-sends-history` produces counts a human interprets before the enum ships; 11-02 lands the queryable columns and 11-06 lands the writes that populate them. Declared `verification: backstop` in 11-02's `must_haves`. | Read the audit output before running migration 0047: rows per status, `failed` rows with no matching `send_events`, rows whose `id` predates deterministic derivation. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies — 29 of 31 tasks carry an `<automated>` block; the 2 exceptions are `checkpoint:*` tasks (11-01-03, 11-04-00), which GSD exempts and which both carry an explicit manual procedure above.
- [x] Sampling continuity: no 3 consecutive tasks without automated verify — the longest run without one is 1 (a single checkpoint), at 11-01-03 and 11-04-00.
- [x] Wave 0 covers all MISSING references — no plan contains a `MISSING — Wave 0` marker; every test file is created by the task that verifies against it.
- [x] No watch-mode flags — every vitest invocation in the 11 plans' `<automated>` blocks is `vitest run`; `apps/worker/vitest.config.ts` also pins `watch: false`.
- [x] Feedback latency < 3 s per task, < 67 s to the full aggregated suite — both measured on this branch, not estimated.
- [x] `nyquist_compliant: true` set in frontmatter.

Sign-off scope: this is the **plan-time** contract — every task has a runnable
command, every requirement has an owner, and every command's prerequisites exist
or are created in-task. `status` stays `draft` until `/gsd-validate-phase` §6
observes these commands actually green on executed code, at which point it flips
to `validated` and the Status column fills in.

**Approval:** approved 2026-08-09 (plan-time contract)

---

## Validation Audit 2026-08-09

Run by `/gsd-validate-phase 11` against executed code on branch
`gsd/phase-11-delivery-correctness` (HEAD `cc1eb9a`). All 11 plans report
`status: complete` in their SUMMARYs.

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |

Observed evidence (commands actually run, all exit 0):

- **All 29 mapped test files exist** on disk, and `vitest list` per workspace
  confirms every one is collected by its project config — nothing is silently
  excluded from the aggregated suite.
- `npm run coverage` — exit 0, **83.86% statements** (4398/5244), all 12
  backend projects green.
- `npm run failure:all` — exit 0, all **8 scenarios** green (sigkill,
  crash-post-accept, crash-pre-result-write, reconciler-retry-race,
  connection-reset, rate-limit-429, timeout, redis-restart).
- `npx vitest run --root apps/web` — 7 files, 52 tests, all green;
  `npm run lint -- apps/web` clean.
- 11-01-02 doc assertion (`ARCHITECTURE.md` §9 tokens present, no
  `exactly-once` claim) — `ok`.
- 11-02-01 `npm run db:audit-sends-history` ran read-only end-to-end; the
  comment-stripped-source write-keyword scan printed `read-only ok`.
- 11-02-02 `npm run lint:migrations` (53 files, no violations) +
  migrations applied + live-schema assertion (`send_status` enum is exactly
  the 6 expected values; `reconciling_since`/`dispatched_at`/
  `dispatch_duration_ms` present; `send_reconciler_runs` exists) — `schema ok`.
- 11-11-03 CI wiring: `grep -c "npm run failure:" .github/workflows/ci.yml`
  returns **8**.

Checkpoint outcomes (manual-only rows):

- 11-01-03 (writer matrix / delivery-model review) — executed and
  human-approved per 11-01-SUMMARY.md, including the deliberate
  `unknown --> unknown` diagram-only annotation accepted as-is.
- 11-04-00 (`uuid` package legitimacy) — executed; the human decision was to
  **hand-roll UUIDv5 over `node:crypto`** instead of installing `uuid`, so no
  dependency was added. `send-id.test.ts` pins the published RFC 4122 vector
  (Python `uuid.uuid5(NAMESPACE_DNS, 'python.org')`) rather than a
  self-agreement value. The Manual-Only table entry above describes the gate
  as written at plan time; this is its recorded resolution.

Verdict: **Phase 11 is Nyquist-compliant** — every requirement (DLV-01 …
DLV-09) has at least one automated command observed green on executed code.
