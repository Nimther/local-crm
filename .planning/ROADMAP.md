# Roadmap: Mega CRM — B2C Marketing Automation Platform

## Milestones

- ✅ **v1.0 MVP** — Phases 1-7 (shipped 2026-07-14) — [archive](milestones/v1.0-ROADMAP.md)
- 🚧 **v1.1 Production Hardening** — Phases 8-16 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-7) — SHIPPED 2026-07-14</summary>

- [x] Phase 1: Workspace Foundation & Team Access (7/7 plans) — completed 2026-07-03
- [x] Phase 2: Contacts & Event Ingestion (14/14 plans) — completed 2026-07-05
- [x] Phase 3: Segmentation Engine (8/8 plans) — completed 2026-07-06
- [x] Phase 4: Broadcast Campaigns & Send Pipeline (19/19 plans) — completed 2026-07-06
- [x] Phase 5: Webhook Processing & Delivery Tracking (13/13 plans) — completed 2026-07-09
- [x] Phase 6: Flows (Triggered Chains) (24/24 plans) — completed 2026-07-13
- [x] Phase 7: Analytics, Dashboard & Send Log (11/11 plans) — completed 2026-07-14

Full phase details: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)

</details>

### 🚧 v1.1 Production Hardening (Phases 8-16)

**Milestone Goal:** Take Mega CRM from a functionally complete MVP to a system that can be operated in production — correct sends at failure boundaries, proven tenant isolation, honest compliance and analytics, bounded and fault-tolerant background work, an automated database lifecycle, and a full operational loop.

**Character:** No new product functionality. Operational reliability of an already-working system.

**Source of scope:** `.planning/AUDIT-2026-07-27-production-readiness.md` (external audit of v1.0) plus 9 audit-missed gaps surfaced by research — see `.planning/research/SUMMARY.md`.

- [x] **Phase 8: Quality Gates & Failure-Injection Foundation** - CI, isolated E2E, migration tests, reproducible failure modes, correct Redis config (completed 2026-08-06)
- [x] **Phase 9: Partition Automation & Boundary Safety** - Partitions always exist ahead of data; missing ones are loud (HARD DEADLINE 2026-09-01) (completed 2026-08-07)
- [x] **Phase 10: Tenant Isolation & Trust Boundaries** - Cross-tenant access prevented by DB identity and policy, proven by negative tests (completed 2026-08-08)
- [x] **Phase 11: Delivery Correctness** - No mail lost, duplicated or misclassified at crash, timeout and ambiguous-outcome boundaries (completed 2026-08-09)
- [x] **Phase 12: Worker Reliability & Tenant Fairness** - One tenant, one huge segment, or a restart cannot degrade the platform (completed 2026-08-10)
- [ ] **Phase 13: Compliance & Analytics Integrity** - Consent and delivery numbers mean exactly what they claim
- [ ] **Phase 14: Deployment & Database Durability** - Reproducible deploy, gated migrations, rehearsed restore, enforced constraints
- [ ] **Phase 15: Observability, Alerting & Frontend Resilience** - The system reports its true state to operators and to users
- [ ] **Phase 16: Live SendGrid Verification** - Every delivery guarantee confirmed against the real provider (release barrier)

## Phase Details

### Phase 8: Quality Gates & Failure-Injection Foundation

**Goal**: Any change to the send pipeline can be proven safe before it ships — CI blocks broken code, tests cannot touch the dev database, and every failure mode the audit names can be reproduced on demand.
**Depends on**: Phase 7 (v1.0 shipped)
**Requirements**: QG-01, QG-02, QG-03, QG-04, QG-05, QG-06, QG-07, QG-08, QG-09, QG-10, WRK-12, DB-08
**Success Criteria** (what must be TRUE):

  1. A pull request carrying a failing test, a type error, a lint violation, or a coverage drop below the recorded baseline cannot be merged.
  2. An E2E run started without a provisioned ephemeral database aborts with a hard error instead of silently falling back to the dev database, and CI asserts which connection string the run actually used.
  3. Each failure mode named by the audit — SendGrid timeout, SendGrid 429, connection reset, process SIGKILL mid-dispatch, Redis restart mid-queue — is reproducible by a single command and produces an asserted outcome, not just a log line.
  4. Redis refuses new writes with an error instead of silently evicting when it hits its memory ceiling, and queued jobs survive a Redis container restart.
  5. A migration is automatically verified both from an empty database and on top of the current schema, and expand/contract sequencing is a written, enforced rule; `.env`/`dump.rdb` are out of the repo working root, and `ARCHITECTURE.md`/`CONVENTIONS.md` exist with a binding update rule in `CLAUDE.md`.

**Plans**: 18 plans (15 waves, tracer-first). Waves are largely sequential by necessity: root `package.json`, `SPECIFICATION.md` and `package-lock.json` are hub files touched by most plans, and two concurrent `npm install` runs in one workspace tree corrupt each other — so no two plans in a wave share a file. Parallel pairs: W2 (08-02+08-05), W6 (08-04+08-08), W14 (08-16+08-17).

Plans:
**Wave 1**

- [x] 08-01-PLAN.md — Tracer: end-to-end CI gate (one job, minimal fail-closed guard, worker suite, branch protection)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 08-02-PLAN.md — Fail-closed DSN guard + ephemeral database provisioning with an internally-guarded drop
- [x] 08-05-PLAN.md — Migration linter: expand/contract + unmarked destructive DDL

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 08-03-PLAN.md — ESLint flat config, fail-first fixtures, version-controlled lint file-count floor

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 08-06-PLAN.md — Consolidate `db-fixture`, remove the dev-DB fallback, wire every vitest globalSetup

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 08-07-PLAN.md — Zero lint debt across all workspaces

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 08-04-PLAN.md — Redis durability config (`docker/redis.conf`) with a fail-first `CONFIG GET` assertion
- [x] 08-08-PLAN.md — Failure scenarios: SendGrid 429, timeout, connection reset

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 08-11-PLAN.md — Root vitest aggregator, coverage provider, measured baseline

**Wave 8** *(blocked on Wave 7 completion)*

- [x] 08-14-PLAN.md — Coverage gate (unrounded, equality passes) + threshold ratchet

**Wave 9** *(blocked on Wave 8 completion)*

- [x] 08-09-PLAN.md — Migration tests: from empty + incremental over seeded data

**Wave 10** *(blocked on Wave 9 completion)*

- [x] 08-10-PLAN.md — Playwright fail-closed E2E lane (no dev-stack reuse, no dev config)

**Wave 11** *(blocked on Wave 10 completion)*

- [x] 08-15-PLAN.md — Root hygiene: `MEGA_CRM_ENV_FILE` resolver + blacklist check

**Wave 12** *(blocked on Wave 11 completion)*

- [x] 08-12-PLAN.md — SIGKILL scenario: real process killed inside the claim window

**Wave 13** *(blocked on Wave 12 completion)*

- [x] 08-13-PLAN.md — Redis-restart scenario + the five-scenario checklist

**Wave 14** *(blocked on Wave 13 completion)*

- [x] 08-16-PLAN.md — Close the coverage increment: `packages/kms` and `packages/tenant-context` tests
- [x] 08-17-PLAN.md — `ARCHITECTURE.md`, `CONVENTIONS.md`, binding update rule in `CLAUDE.md`

**Wave 15** *(blocked on Wave 14 completion)*

- [x] 08-18-PLAN.md — CI assembly: static/test/failure-injection/e2e + required checks on `master`

**Sequencing and pitfall notes:**

- **QG-06 is a hard blocker for Phase 11.** The delivery state machine cannot be safely changed without a harness that can prove the new `interrupted → reconciling` transition under simulated crash timing. Build the harness on the existing `ProcessSendJobDeps.sendMail` dependency-injection seam (`apps/worker/src/queues/send-dispatch.ts`) — that seam already exists and is already used by `send-dispatch-idempotency.test.ts` / `send-dispatch-durability.test.ts`; this phase adds scenarios, not a new seam.
- **QG-04 (Pitfall 21):** the guard must be a hard failure, not a graceful default. Assert the resolved test connection string is *not equal* to `DATABASE_URL` before any test runs, and provision the ephemeral database with the same script locally and in CI (no CI-only path).
- **QG-03 (Pitfall 22):** set the coverage threshold from the measured current baseline plus a deliberate increase, not a round number. Track the named crash/race scenarios as a separate checklist mapped to specific test names — the coverage percentage must never stand in as evidence that they exist.
- **WRK-12 is placed here deliberately.** `maxmemory-policy=noeviction` + explicit `maxmemory` + AOF is infrastructure, not app code, and every worker-reliability fix in Phase 12 is void without it (Pitfall 20). The Redis-restart test in criterion 3 is what proves it.
- **DB-08 is placed here deliberately.** Expand/contract must be an established rule *before* Phase 11 adds `'reconciling'` to `send_status`. That enum value must be its own standalone migration, applied and confirmed before any deploy ships code referencing it (Postgres will not let a newly-added enum value be used in the transaction that added it).

---

### Phase 9: Partition Automation & Boundary Safety

**Goal**: `events` and `send_events` always have partitions ahead of incoming data, and a missing partition is loud rather than silent.
**Depends on**: Phase 8 (migration tests + CI gate)
**Requirements**: DB-01, DB-02, DB-03, DB-04
**Success Criteria** (what must be TRUE):

  1. Partitions for `events` and `send_events` exist at least two months ahead of the current date at all times, created without manual intervention.
  2. If the maintenance job stops running or the next partition is missing, an alert fires while there is still buffer — before any row can land in DEFAULT.
  3. Crossing a month boundary is exercised by an automated test, including the case where the automation ran late and DEFAULT already holds rows.
  4. Rows already sitting in a DEFAULT partition can be relocated into their correct partition by a documented procedure that does not hold a long exclusive lock on the live table.

**Plans**: 5/5 plans executed

Plans:
**Wave 1**

- [x] 09-01-PLAN.md — Catch-up migration 0038 + `ensurePartitions` + health row + watchdog, wired end-to-end and verified

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 09-02-PLAN.md — Daily 03:00 UTC job scheduler + boot-time run, `OPERATOR_ALERT_EMAIL`, watchdog started in the API process
- [x] 09-04-PLAN.md — Batched DEFAULT relocation core + operator CLI + runbook + late-automation boundary test

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 09-03-PLAN.md — Drizzle schema for the health table, test-fixture partition parity, month-boundary and precision suite

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 09-05-PLAN.md — SPECIFICATION/ARCHITECTURE/CONVENTIONS as-built updates + phase gate incl. live alert confirmation

**Cross-cutting constraints:**

- Every partition bound is UTC-anchored, each new partition's lower bound is exactly the preceding partition's upper bound with no gap and no overlap (asserted through `pg_get_expr(relpartbound, oid)`), and buffer months are an integer calendar walk so a run at any hour of a 28/29/30/31-day month yields the same integer.

**Sequencing and pitfall notes:**

- ⚠️ **HARD EXTERNAL DEADLINE: 2026-09-01.** Partitions exist only through August 2026. From 1 September new rows land in DEFAULT, after which every subsequent `ATTACH PARTITION` requires a full DEFAULT scan under `ACCESS EXCLUSIVE` lock — an ingestion outage on the live events table.
- **This phase is deliberately small and depends only on Phase 8** so it can be scheduled independently of Phases 10-16 and so "Phase 9 complete" literally means "deadline met". Do not fold other database work into it.
- **Pitfall 13:** shipping the automation and *avoiding the DEFAULT-scan cost forever* are two different bars. Before any attach, query whether `events_default`/`send_events_default` already holds rows; if so, apply the CHECK-constraint-first technique (a CHECK on DEFAULT proving it cannot contain rows in the new range lets Postgres skip the scan) before attaching.
- Implement as a daily BullMQ repeatable job (`partition-maintenance.worker.ts`), same shape as the four existing repeatable ticks — not `pg_partman` (ruled out: custom Postgres image, extension dependency, second scheduling paradigm). No new DB role needed: `mega_crm_app` already owns both tables, and RLS on the parent propagates to new child partitions automatically.
- Emit "months of buffer remaining" each run so criterion 2's alert catches both "the job stopped" and "someone changed the lookahead without changing the threshold".
- **Cross-phase note:** `send_events.occurred_at` is provider-supplied, so a stray timestamp can route a row far outside the current-month window. Phase 13 (CMP-05) bounds that value; this phase's attach procedure must not assume all rows fall inside the expected window.

---

### Phase 10: Tenant Isolation & Trust Boundaries

**Goal**: Cross-tenant access is prevented by database identity and policy — not by a session flag and not by remembering to write a `WHERE` clause — and the prevention is proven by tests that actively try to break it.
**Depends on**: Phase 8
**Requirements**: SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-06, SEC-07, SEC-08, SEC-09, SEC-10, SEC-11, SEC-12, SEC-13, SEC-14, SEC-15, SEC-16
**Success Criteria** (what must be TRUE):

  1. A query against a tenant table with no tenant context raises an error rather than returning zero rows, and a test asserts that specific Postgres error class.
  2. Cross-tenant background scans run only under a dedicated least-privilege database role whose credentials the API process does not hold; no code path reachable from the public API can grant itself cross-tenant read access; and the Better Auth tables sit behind a decided, implemented trust boundary that login, signup and invite-accept still pass through end to end.
  3. Negative cross-tenant tests cover both API routes and background jobs, and a webhook event carrying a sibling workspace's data under a shared BYO SendGrid key is discarded rather than persisted.
  4. The webhook endpoint rejects a stale-timestamp or replayed delivery and is rate-limited independently of the rest of the API; an API key lacking the required scope is refused on every route, or scopes are removed outright as a guarantee the system does not actually make.
  5. Every route resolves workspace membership through one implementation and answers identically for a missing and a forbidden resource; API rate limiting stays correct with more than one API replica; secrets and PII are redacted through one shared rule set used by both API and worker; and a short `BETTER_AUTH_SECRET` is refused in production.

**Plans**: 15/15 plans executed

Plans:
**Wave 1**

- [x] 10-01-PLAN.md — Tracer: dedicated `mega_crm_scan` role wired end to end on one cross-workspace campaign scan (SEC-01, SEC-02)
- [x] 10-02-PLAN.md — Collapse nine duplicated membership resolvers into one `resolveWorkspaceMember` (SEC-14)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 10-03-PLAN.md — Scan-role grants and narrowed role-scoped policies; three remaining consumers migrated (SEC-01, SEC-02)
- [x] 10-04-PLAN.md — Parameterized missing-vs-forbidden 404 sweep and invite response identity (SEC-10, SEC-15)
- [x] 10-05-PLAN.md — CI-enforced session-state audit with a violating fixture (SEC-16)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 10-06-PLAN.md — Retire the cross-tenant marker GUC from policies and from the partition path (SEC-01, SEC-02)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 10-07-PLAN.md — Fail-closed unification of all 22 tenant RLS policies, role-scoped (SEC-03, SEC-04)

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 10-08-PLAN.md — Sibling-workspace webhook events dropped per event, counted, payload-free (SEC-09)

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 10-09-PLAN.md — Better Auth boundary via `mega_crm_auth` grant partitioning; production secret floor (SEC-05, SEC-12)

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 10-10-PLAN.md — Per-route API key scope enforcement with a same-change backfill (SEC-06)

**Wave 8** *(blocked on Wave 7 completion)*

- [x] 10-11-PLAN.md — Webhook signature-timestamp replay window (SEC-07)

**Wave 9** *(blocked on Wave 8 completion)*

- [x] 10-12-PLAN.md — Redis-backed rate limit, independent webhook bucket, two-instance proof (SEC-08, SEC-11)

**Wave 10** *(blocked on Wave 9 completion)*

- [x] 10-13-PLAN.md — Shared redaction rule set compiled for both the API logger and the worker (SEC-13)

**Wave 11** *(blocked on Wave 10 completion)*

- [x] 10-14-PLAN.md — Negative cross-tenant suites for every route module and job family (SEC-16)

**Wave 1 (gap closure — UAT G-10-1)**

- [x] 10-15-PLAN.md — `ensure-db-roles.mjs` loads the external env file before resolving its admin DSN; predev-chain env-loading guard (SEC-01, SEC-02)

**Open decisions — resolved during `/gsd-discuss-phase` (2026-08-07), recorded as ADRs during implementation:**

- **SEC-05 — Better Auth trust boundary.** Resolved: dedicated `mega_crm_auth` login role plus grant partitioning (CONTEXT D-04). Rejected alternatives, to be named in the ADR: RLS on the auth tables (Better Auth sets no session GUC, and Pitfall 12's silent zero-rows login breakage), and moving the seven tables into an `auth.*` schema (every tenant table has a foreign key to `organization(id)`). Implemented by plan 10-09.
- **SEC-01 — admin-scan connection shape.** Resolved: separate pool with a dedicated login credential held only by the worker (CONTEXT D-01). Implemented by plans 10-01, 10-03 and 10-06.

**Open decisions carried into execution (blocking checkpoints inside plans):**

- **Plan 10-06** — how the DEFAULT-partition relocation path obtains cross-workspace visibility for PostgreSQL's foreign-key re-validation once the marker policy is deleted. The scan role cannot take this over: `ALTER TABLE ... ATTACH PARTITION` requires table ownership, which the scan role must not have. Three options presented; also a precondition for plan 10-07.
- **Plan 10-09** — confirmation of the per-table Better Auth grant matrix before the forward-only revocations ship, including the acknowledged property that the owning role can re-grant itself.

**Sequencing and pitfall notes:**

- **This phase must precede Phase 11's reconciler (DLV-03) and Phase 12's bounded sweep (WRK-05).** Both are cross-tenant background scans; sequencing the role first means each rewrites its admin-scan usage *once*, against the final role, rather than against the GUC pattern and then again later.
- ⚠️ **SEC-03 must unify RLS policies in the fail-CLOSED direction (Pitfall 11).** The two variants today are bare-cast (`current_setting(...)::uuid` — throws when the GUC is unset) and NULLIF-guarded (returns zero rows). Unify toward **bare-cast**. Standardizing on NULLIF "because it looks more defensive" silently converts 12 currently-fail-closed tables — including `contacts`, `sends`, `events`, `send_events` — into fail-open-to-empty-result tables, which application code routinely misreads as "this record does not exist". SEC-04's test must assert the **thrown error**; a test asserting `rows.length === 0` passes under either variant and catches nothing. Run this unification as its own reviewed, isolated change — it touches 22 security-critical policies at once.
- ⚠️ **SEC-12 (Pitfall 12):** do not add RLS to Better Auth tables as a mechanical checklist item. Better Auth issues its own SQL through a non-tenant pool that never sets the workspace GUC, and `organization` has no `workspace_id` column to key on — a copy-pasted policy breaks login, signup and session validation platform-wide, silently (a zero-row policy produces no SQL error). Gate any change here on the SEC-05 decision above and re-test the full login/signup/invite-accept flow before it ships.
- **SEC-01/SEC-02 (Pitfall 9):** grant `NOBYPASSRLS` explicitly on every new role and verify none of them owns a table — "new role = safe by default" is false. Separately, `flow_runs_due_scan` (migration 0027) and `flows_segment_sweep_scan` (0032) currently have **no predicate at all** beyond the GUC check, unlike the `0018` precedent they claim to mirror; role-scoping (`CREATE POLICY ... TO mega_crm_admin_scan`) and predicate-narrowing are complementary, not substitutes — close both together. `analytics-reconciliation.worker.ts`'s bare `SELECT id FROM organization` on the tenant pool must move onto the new role in this phase.
- **SEC-16 (Pitfall 10):** include a codebase-wide audit for any bare `SET`/`SET ROLE` (not `SET LOCAL` / `set_config(..., true)`) as part of the negative-test work — this is the check that must pass before Phase 14 introduces pooling.
- **SEC-13 must land before Phase 15's Sentry work (Pitfall 18)** so the redaction rule set is defined once and reused by both pino and Sentry's `beforeSend`, rather than defined twice and drifting.
- **SEC-14** (single `resolveWorkspaceMember`, currently duplicated across ~9 route modules) is also the natural attachment point for Phase 15's `workspace_id`/`request_id` log and Sentry tagging — build it once here.
- **Cross-phase note:** SEC-07 (webhook timestamp replay window) and CMP-05/CMP-07 (Phase 13, bounding the payload's per-event `occurred_at` and decoupling dedup from it) touch the same endpoint but are **two different timestamp fields**. Bounding the signature timestamp does not bound the payload timestamp. Plan CMP-05 to extend this phase's validation, not to re-open it.

---

### Phase 11: Delivery Correctness

**Goal**: No email is lost, duplicated, or wrongly classified when SendGrid is slow, when SendGrid returns an ambiguous result, or when the process dies mid-send.
**Depends on**: Phase 8 (failure-injection harness), Phase 10 (least-privilege role for the reconciler's cross-tenant discovery scan)
**Requirements**: DLV-01, DLV-02, DLV-03, DLV-04, DLV-05, DLV-06, DLV-07, DLV-08, DLV-09
**Success Criteria** (what must be TRUE):

  1. A process killed after SendGrid accepted a message leaves that send in `reconciling`, not `failed`, and no retry path re-sends it.
  2. A reconciler resolves every `reconciling` send to a true terminal state, and a retry worker acting on the same row concurrently cannot produce a second terminal write or a second SendGrid call.
  3. A SendGrid request that hangs is aborted by an explicit timeout strictly shorter than the queue's lock duration, and the timeout is classified as an ambiguous outcome rather than a failure.
  4. Re-running the same send intent produces the same idempotency key, so a retry cannot create a second message.
  5. The documented delivery model (at-most-once / effectively-once) matches observed behavior under the crash tests at all three boundaries — before the send, after SendGrid accepted, before the result was written — and send duration is available as a metric.

**Plans**: 11/11 plans executed

Plans:
**Wave 1**

- [x] 11-01-PLAN.md — DLV-01/DLV-07 state machine + delivery model as a reviewed design artifact (ARCHITECTURE.md + executable transition matrix)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 11-02-PLAN.md — expand migrations: `reconciling`/`unknown` enum values, reconciliation/duration columns, reconciler health table, read-only history audit

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 11-03-PLAN.md — TRACER: interrupted send → `reconciling` → reconciler resolves to `sent`, end to end; plus the retry-worker half of DLV-04

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 11-04-PLAN.md — DLV-05 deterministic UUIDv5 send id derived from the send intent

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 11-05-PLAN.md — DLV-06 SendGrid abort timeout, transport-error classifier, explicit `lockDuration`, bounded provider retry

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 11-06-PLAN.md — ambiguous-outcome wiring on both send paths + `dispatched_at`/`dispatch_duration_ms` writes

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 11-07-PLAN.md — provision SendGrid's `processed` event as the reconciler's primary acceptance evidence

**Wave 8** *(blocked on Wave 7 completion)*

- [x] 11-08-PLAN.md — reconciler expansion: `unknown` verdict, late-evidence re-scan, stale-`dispatching` sweep, idempotent counter backfill

**Wave 9** *(blocked on Wave 8 completion)*

- [x] 11-09-PLAN.md — reconciler health row + API-side watchdog (two-process dead-man's switch)

**Wave 10** *(blocked on Wave 9 completion)*

- [x] 11-10-PLAN.md — send-log vocabulary for the new states + honest test-send outcome and copy

**Wave 11** *(blocked on Wave 10 completion)*

- [x] 11-11-PLAN.md — DLV-08 crash tests at all three boundaries + reconciler/retry race + delivery-model claims, wired into the required CI check

**Sequencing and pitfall notes:**

- ⚠️ **The reconciler must claim rows exclusively, or this phase recreates the duplicate-send bug one layer up (Pitfall 1).** Resolution must take `SELECT ... FOR UPDATE SKIP LOCKED` inside `withTenantTransaction` (matching the existing `claimCampaignSend` pattern) before reading provider state and writing a terminal status — never a blind `UPDATE sends SET status=... WHERE status='reconciling'`. The retry path must be forbidden from calling SendGrid for any row in `reconciling`: only the reconciler resolves that state, and the job processor treats it as "not my job", not "try again". DLV-08's crash tests must include the three-way race (reconciler *and* retry worker both touching one row), not just the three named crash points.
- **Design the state machine as an explicit reviewed artifact before touching `send-dispatch.ts`** — states, valid transitions, and *who is allowed to write each transition*. DLV-01 is a design deliverable, not documentation written after the code.
- **Correlation is by `send_id` only.** `custom_args.send_id` already exists on every SendGrid request and is already read back by `webhook-events.worker.ts` — the reconciler must match provider events to `sends` rows through it and never re-derive by (contact, timestamp, template) heuristics.
- ⚠️ **Pitfall 2:** the enum change must not backfill historical rows in the same migration. Before writing it, run a read-only audit against production-shaped `sends` history (how many `failed` rows have no matching `send_events`? how many predate the correlation column?). Reconciliation code must treat "row has no correlation ID" as out-of-scope, not as an exception. `workspace_daily_rollup` historical totals must be unchanged after the migration — a shift is the tell that old rows got reclassified.
- ⚠️ **Pitfall 5:** set the `AbortController` timeout strictly below BullMQ's `lockDuration`, with margin for the claim transaction and the terminal-write transaction around it. Otherwise a hung request gets stall-detected and double-scheduled onto another worker — the queue-level version of the same duplicate.
- **Do not build a second outbox table.** `sends` already is the outbox: the `'dispatching'` row is committed before the SendGrid call. Add `'reconciling'` to `send_status` and a `reconciling_since timestamptz` column (do not overload `queued_at` — Phase 15's webhook-lag alert queries `reconciling_since` directly).
- **The `interrupted` branch must stop incrementing `failed_count`/rollup counters** — it no longer knows the outcome, so it must stop pretending to. The reconciler needs its own idempotent "resolve → terminal, backfill counters once" path; a naive re-run of `applyEventSideEffects` will not fire, because `setFactColumnOnce`'s `justSet` gate already consumed the fact.
- **Deploy-safety contract (see Sequencing Decisions below):** every job payload changed in this phase carries an explicit `schemaVersion`, and the worker defers rather than best-effort-processes a payload version it does not recognize.

---

### Phase 12: Worker Reliability & Tenant Fairness

**Goal**: One tenant's limits, one oversized segment, or a restart cannot degrade the rest of the platform; background work is bounded, resumable and observable.
**Depends on**: Phase 11 (same files, same `SendJobResult` shape), Phase 10 (role for the sweep's cross-tenant discovery scan), Phase 8 (Redis `noeviction`)
**Requirements**: WRK-01, WRK-02, WRK-03, WRK-04, WRK-05, WRK-06, WRK-07, WRK-08, WRK-09, WRK-10, WRK-11, WRK-13
**Success Criteria** (what must be TRUE):

  1. Under load with tenant A over its rate limit, tenant B's send throughput is measurably unaffected — proven by a two-tenant load test, not by code review — and the configured per-tenant RPS is backed by that test or by SendGrid's documented limit rather than a guess.
  2. A single tenant cannot occupy more than its configured share of worker slots while other tenants have queued work.
  3. A segment sweep across the platform's target contact volume completes in bounded pages with short transactions, and resumes from its checkpoint after being killed mid-sweep without reprocessing everything already done.
  4. SIGTERM drains in-flight jobs and closes every Queue handle without losing the job in progress; every worker — including the repeatable ticks — reports errors through one shared listener, and the multi-instance-safety assumptions are written down.
  5. Failed jobs age out under a per-queue retention policy instead of accumulating forever, terminal failures land in an observable dead-letter path, and Redis connection options, `defaultJobOptions` and TTL values have exactly one definition.

**Plans**: 14/14 plans executed

Plans:
**Wave 1**

- [x] 12-01-PLAN.md — WRK-01 tenant-scoped deferral tracer (both send lanes) + phase coverage audit
- [x] 12-03-PLAN.md — tenant+lane TTL-leased concurrency semaphore, test-first (WRK-02)
- [x] 12-06-PLAN.md — bounded, checkpointed, resumable segment sweep (WRK-05/06)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 12-02-PLAN.md — `@mega-crm/queue-core` package + worker-side single-definition collapse (WRK-11)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 12-04-PLAN.md — semaphore wired into all three dispatch paths (WRK-02)
- [x] 12-11-PLAN.md — application-side single-definition collapse + cross-app invariant (WRK-11)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 12-05-PLAN.md — two-tenant fairness proof + `DEFAULT_TENANT_RPS` validation (WRK-03/04)
- [x] 12-07-PLAN.md — dead-letter tables, redacting terminal-failure writer, shared listener helper (WRK-08/10)

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 12-08-PLAN.md — shutdown closes every handle, listeners everywhere, scheduler migration, docs (WRK-07/08/13)

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 12-10-PLAN.md — dead-letter operator watchdog (WRK-10)

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 12-09-PLAN.md — bounded per-queue failed-job retention (WRK-09)

**Wave 8** *(gap closure — UAT G-12-1, blocker)*

- [x] 12-12-PLAN.md — five repeatable-tick workers never start their run loop: fix the undefined run-loop option in all five factories, production-shape regression test, backlog-burst absorption (WRK-13)

**Wave 9** *(gap closure — UAT G-12-2; blocked on Wave 8 completion)*

- [x] 12-13-PLAN.md — ARCHITECTURE.md forward-looking entry reduced to genuinely-open work; SPECIFICATION.md §5.1/§5.2 re-verified against observed consumption (WRK-09/WRK-13)

**Wave 10** *(gap closure — UAT G-12-3; blocked on Wave 8 completion)*

- [x] 12-14-PLAN.md — burst-absorption dedup assertion made non-vacuous: seed one past-due scheduled campaign, assert exactly one kickoff job and one transition, add an honest empty-scan control case, single shared seeding fixture (WRK-13)

**UI hint**: no

**Resolved decision — WRK-02 per-tenant concurrency-cap mechanism (D-01, `12-CONTEXT.md`):** a Redis semaphore at the application layer, keyed per tenant **and** lane, TTL-leased, with over-cap jobs taking the same deferral path as the RPS ceiling. BullMQ-native per-group concurrency rejected (paid tier only); bounded per-tier worker pools rejected. Implemented as a hand-rolled sorted-set primitive — the `redis-semaphore` package was evaluated at plan time and not adopted (new dependency outside the decision's stated option space, and this project chose the same way at the identical package gate in 11-04).

**Sequencing and pitfall notes:**

- ⚠️ **WRK-01 (Pitfall 4):** `worker.rateLimit()` is worker-scoped, not tenant-scoped — that is the bug. Replace it with `job.moveToDelayed(timestamp, job.token)` + `Worker.DelayedError()` **only for the tenant-bucket cause**; keep the existing `worker.rateLimit()` behavior for genuine SendGrid 429/5xx backpressure, which really is a worker-wide signal. This requires splitting `SendJobResult` with `cause: "tenant_bucket" | "provider_backoff"` (introduced in Phase 11 — this is why the two phases are adjacent and touch the same files). The two-queue split (`email-broadcast`/`email-triggered`) solves *lane* fairness, not *tenant* fairness within a lane.
- **WRK-05/WRK-06:** copy the pattern this codebase already proved in `recipient-snapshot.ts` / `campaign-kickoff.worker.ts` — keyset pagination on `contacts.id`, per-page `statement_timeout`, persisted resume cursor. It cannot be copied verbatim: campaign snapshotting is a one-shot freeze, while the segment sweep is perpetual, so a permanent cursor would silently skip contacts inserted before the cursor position between ticks. Reset the cursor on successful full completion of each walk. Split discovery-and-enqueue from the per-flow bounded walk (mirroring `campaign-scheduler` → `campaign-kickoff`), with a deterministic `jobId` per flow so a still-running sweep is not double-enqueued. The stale-snapshot anti-join `DELETE` needs the same `LIMIT`-bounded loop treatment.
- ⚠️ **WRK-09/WRK-11 (Pitfall 6):** do not collapse retention into one shared constant. The shared queue factory must take retention **as a per-queue parameter**. `flow-run-advance`'s existing differentiated policy is a deliberate precedent to preserve, not an inconsistency to erase. Retention for anything feeding the `reconciling`/dead-letter path must outlive the reconciliation window with margin — hours/days, not minutes.
- **WRK-07 (Pitfall 7):** `worker.close()` is already called on SIGTERM and is already correct. The gap this phase must close together with Phase 14 is the *container* stop grace period — SIGKILL arriving before drain finishes turns a routine deploy into the exact "died after SendGrid accepted" scenario Phase 11 exists to handle. Derive and document the timeout from SendGrid timeout + transaction margin; do not accept the Docker default unexamined.
- **WRK-13 (Pitfall 8):** BullMQ's repeatable-job dedup prevents duplicate *schedule registration*, not duplicate *execution* across instances. Multi-instance worker deployment is explicitly out of scope for v1.1, so document the single-instance constraint rather than asserting safety by extrapolation, and prefer `upsertJobScheduler` with a stable scheduler ID over the older registration path.
- **Deploy-safety contract:** as with Phase 11, changed job payloads carry `schemaVersion`.

---

### Phase 13: Compliance & Analytics Integrity

**Goal**: What the platform claims about consent and delivery matches what actually happened — an unsubscribe is honored everywhere at once, and a daily number means exactly one thing.
**Depends on**: Phase 10 (webhook ingress validation this phase extends), Phase 11 (settled send-status semantics)
**Requirements**: CMP-01, CMP-02, CMP-03, CMP-04, CMP-05, CMP-06, CMP-07, CMP-08, CMP-09
**Success Criteria** (what must be TRUE):

  1. An unsubscribe updates subscription status, consent history and the originating send as one atomic event — a crash partway through leaves no partial state anywhere.
  2. Daily metrics are computed from one documented UTC field, and a provider event that arrives late is counted on the day it occurred rather than the day it arrived.
  3. Deleting a contact removes personal data while leaving the minimum evidence needed to later prove a send or a suppression was lawful.
  4. A provider event carrying an out-of-range or manipulated timestamp cannot bypass deduplication or land outside its partition, and a redelivered event is counted once even when `sg_event_id` is not stable across retries.
  5. Metric drift is corrected by a scheduled reconciliation job rather than a one-off fix, events missed while the webhook endpoint was unreachable are recovered by backfill, and a tenant approaching the spam-complaint threshold raises an alert.

**Plans**: 15/15 plans executed

Plans:
**Wave 1**

- [x] 13-01-PLAN.md — [tracer] Ingress journal end-to-end: verified batch journaled before enqueue, worker marks it ingested; quarantine table DDL (CMP-08)
- [x] 13-02-PLAN.md — UTC day semantics: force `AT TIME ZONE 'UTC'` on every reconciliation cast, pin `sent_at` as the day authority, assert the recurring schedule (CMP-02, CMP-06)
- [x] 13-03-PLAN.md — `unknown`/`reconciling` sends get their own visible count in campaign stats; ledger provably sums to total sends (CMP-02 / D-16)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 13-04-PLAN.md — Bound provider `occurred_at` before partition routing and dedup; quarantine out-of-range events per event (CMP-05)
- [x] 13-05-PLAN.md — Dirty-day marking and sweep so a late event is re-verified against a fresh scan (CMP-03)
- [x] 13-06-PLAN.md — Journal replay sweep, operator range-replay CLI, and split retention: completed rows pruned, incomplete ones tombstoned (CMP-08)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 13-07-PLAN.md — Dedup re-base to `(workspace_id, send_id, event_type, occurred_at)`; partitioned unique-index migration with duplicate pre-check (CMP-07)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 13-08-PLAN.md — One shared atomic unsubscribe helper across route, webhook and dropped paths, with a crash test (CMP-01)
- [x] 13-09-PLAN.md — Per-tenant complaint and hard-bounce rates, tiered, into a keyed alert-state table (CMP-09)

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 13-10-PLAN.md — Contact erasure: anonymize in place, keep evidence FKs, write an auditable erasure record, queue the scrub (CMP-04)
- [x] 13-11-PLAN.md — Ingestion-health and reputation watchdogs, operator plus tenant alerts, boot wiring (CMP-08, CMP-09)

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 13-12-PLAN.md — Suppression list converted to a per-workspace HMAC; no plaintext address survives erasure (CMP-04)

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 13-13-PLAN.md — Bounded resumable JSONB scrub over linked event rows, rebuilt from an evidence allowlist, with completion tracking (CMP-04)

**Wave 8** *(blocked on Wave 7 completion)*

- [x] 13-15-PLAN.md — Erasure-record reclaim tick: a committed erasure whose scrub was never enqueued is recovered, proven by a crash-in-the-gap scenario (CMP-04)

**Wave 9** *(blocked on Wave 8 completion)*

- [x] 13-14-PLAN.md — SPECIFICATION/ARCHITECTURE/CONVENTIONS as-built update, coverage matrix, human phase verification (CMP-01…CMP-09)

**Sequencing and pitfall notes:**

- ⚠️ **CMP-05/CMP-07 (Pitfall 14):** `send_events.occurred_at` is provider-supplied and today does double duty — it routes the partition **and** forms part of the dedup key `(workspace_id, sg_event_id, occurred_at)`. Varying only the timestamp on a resent `sg_event_id` bypasses dedup entirely and double-counts delivered/opened/clicked. Bound `occurred_at` to a sane window *before* it is used for either purpose, keep server-side `received_at` as the separate authority, and re-base dedup on server-controlled fields. Route rejected events to an explicit quarantine path — a single malformed event must not fail the whole webhook batch, which is enqueued as one job.
- **CMP-07 rests on a verified fact, not an assumption:** `sg_event_id` is *not* reliably stable across SendGrid webhook retries (confirmed in a first-party SendGrid issue, despite SendGrid's docs implying otherwise). A compound-key fallback is required.
- **CMP-04:** the erasure/evidence tension resolves via anonymisation-with-retained-evidence (ICO guidance on erasure vs. suppression), matching the decision already recorded in PROJECT.md.
- **CMP-08** (webhook-downtime backfill) and **CMP-06** (metrics reconciliation as a recurring job) and **CMP-09** (per-tenant sender reputation vs. the 0.1%/0.3% Gmail/Yahoo complaint thresholds) are three of the nine gaps the code-only audit missed. The platform already ingests the bounce/complaint data CMP-09 needs — the alert is cheap.
- **CMP-01** must not fan out into separate writes: status, consent history and the send row change in one transaction, verified by a crash test from Phase 8's harness.

---

### Phase 14: Deployment & Database Durability

**Goal**: The platform can be deployed, rolled back and restored — and the database survives migrations, disasters and the passage of time.
**Depends on**: Phase 8 (migration tests), Phase 9 (the partition job must be deployable), Phases 11-12 (send-pipeline semantics settled before deployment automation is adopted)
**Requirements**: OPS-01, OPS-02, OPS-03, OPS-04, OPS-05, DB-05, DB-06, DB-07, DB-09, DB-10, DB-11, DB-12, DB-13, DB-14
**Success Criteria** (what must be TRUE):

  1. `api`, `web` and `worker` deploy to the VPS with one reproducible command, and a documented rollback returns the previous version without manual surgery.
  2. `/healthz` answers about process liveness and `/readyz` refuses readiness until Postgres and Redis are reachable and migrations have completed — and the deploy waits on `/readyz` rather than on a timer.
  3. Migrations run exactly once per deploy even when two processes start simultaneously, a migration process killed mid-run does not block the next deploy attempt, and a rollback / roll-forward has been rehearsed against the real migration history.
  4. A point-in-time restore from backup has actually been performed and written up, not merely configured.
  5. Postgres connections use TLS, every pool has an error handler, the missing constraints exist and are verifiably enforced, and retention deletes aged data on a defined schedule.

**Plans**: TBD

**Sequencing and pitfall notes:**

- **OPS-04/OPS-05 must land before OPS-02.** The recommended rolling-restart pattern is health-check-gated; deployment automation built before the health endpoints exist will gate on a timer instead, which is the failure mode it is supposed to prevent.
- ⚠️ **DB-05 (Pitfall 16):** use `pg_try_advisory_lock` in a bounded retry loop with an explicit loud failure path — never a blocking `pg_advisory_lock` that turns a stuck migration into a silently hanging deploy. Take the lock on a **dedicated short-lived connection** that is closed when the migration step ends, never on a connection returned to a shared pool. Prefer one explicit one-shot `migrate` service that runs to completion before `api`/`worker` start; the advisory lock is the safety net for concurrent deploys, not the primary mechanism. Test the unclean-death case: kill the migration mid-run and confirm the next deploy proceeds.
- ⚠️ **DB-12 (Pitfall 17):** run a pre-migration duplicate-check query for every new constraint **first**, as its own reviewed step — `member (organizationId, userId)` in particular could plausibly have duplicates from an invite-accept race. Use `CREATE UNIQUE INDEX CONCURRENTLY` + `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE USING INDEX`, and assert `pg_index.indisvalid` afterwards: a `CONCURRENTLY` build over existing duplicates leaves an `INVALID`, non-enforcing index with **no migration-time error at all**.
- **DB-07 (Pitfall 15):** drizzle-kit migrations are forward-only and 27 of 38 existing migrations have no snapshot. Rollback must be two explicit tiers — auto-reversible additive migrations vs. documented forward-only ones (enums, RLS policies, partition DDL). Backfilling the missing snapshots is an explicit task, not an assumed side effect; the migration test suite should assert `drizzle-kit generate` produces an empty diff against current schema as a smoke test.
- **DB-14 (Pitfall 10):** if PgBouncer is introduced, it must be transaction-mode with reset-on-return, and Phase 10's bare-`SET`/`SET ROLE` audit must have passed first — advisory locks and session state do not survive transaction-mode pooling, which also interacts with DB-05 above. Deferring PgBouncer to SCALE-02 remains a legitimate outcome; record it either way.
- ⚠️ **Pitfall 19:** set explicit per-container memory limits sized so no container's OOM event can starve Postgres, and tune `oom_score_adj` to favour killing `worker`/`api` over `postgres`. The bounded sweep from Phase 12 removes the largest known unbounded-memory path; container limits are the safety net for the ones not yet known.
- **Pitfall 7:** derive and document the container stop grace period here from SendGrid timeout + transaction margin, and verify with a real SIGTERM sent mid-load-test — not just that shutdown *starts*.
- **DB-11 sits with DB-09/DB-10 deliberately:** retention deletes data, so a rehearsed restore must exist before deletion is switched on.
- **DB-06 pairs with OPS-05** — "does not accept traffic until migrations complete" is implemented as readiness, not as a startup sleep.

---

### Phase 15: Observability, Alerting & Frontend Resilience

**Goal**: The system reports its true state — to an operator through structured logs, correlated traces and alerts, and to a user through honest error, empty and stale states.
**Depends on**: Phase 10 (shared redaction rule set, single membership resolver as the tagging point), Phase 14 (deployed environment to observe)
**Requirements**: OPS-06, OPS-07, OPS-08, OPS-09, OPS-10, OPS-11, OPS-12, OPS-13, OPS-14, OPS-15, OPS-16, OPS-17, OPS-18, OPS-19
**Success Criteria** (what must be TRUE):

  1. A single send can be followed from HTTP request through queue job to Postgres query using one correlation identifier, in structured API and worker logs that reach the hosted log provider.
  2. An exception from frontend, API or worker reaches Sentry tagged with tenant and request, and a test proves no SendGrid key, contact email or freeform JSONB payload reaches it.
  3. Alerts fire on queue depth, oldest job age, webhook lag and share of failed sends; Bull Board is reachable only behind administrative access; a runbook exists for each alert describing recovery.
  4. The app loads with route-level code splitting — canvas and heavy dashboard chunks arrive only when those routes are opened.
  5. A failed API call, an empty list, a paginated list, stale analytics and unsaved canvas changes each show the user what is actually true rather than a blank or silently-wrong screen.

**Plans**: TBD
**UI hint**: yes

**Sequencing and pitfall notes:**

- **OPS-06 must land before OPS-08/OPS-10/OPS-12.** The worker currently logs only through `console.log`/`console.error` with no structured fields and no redaction — hosted logs, Sentry and trace correlation are all meaningless until it has a real Pino logger. Small but load-bearing.
- ⚠️ **OPS-09 (Pitfall 18):** Sentry has **no retroactive redaction** — the only remedy for a leak is deleting the project's data. Sentry's default scrubbing does *not* cover email addresses or this system's secret shapes. Configure `beforeSend`/`beforeSendTransaction` on both API and worker SDKs, reusing Phase 10's shared redaction rules plus explicit scrubbing of `email`, `phone` and the freeform `properties`/`payload` JSONB blobs, and **test it against representative payloads before Sentry receives live traffic** — a thrown error from inside `sendTenantMailV3` with the decrypted key in scope, and a contact-upsert error with a `Contact` in context. Deepen pino's redaction beyond two levels using wildcard paths; JSONB nesting depth is not schema-bounded.
- **OPS-11/OPS-12:** extend the existing `packages/tenant-context` AsyncLocalStorage context from `{workspaceId}` to also carry `requestId`/`jobId` rather than threading parameters. Job payload schemas gain an optional `requestId` so HTTP-originated jobs carry their origin across the queue boundary; repeatable ticks and webhook-driven jobs fall back to `job.id`. `send_id` already exists end to end — it needs to be *logged*, not created. A `SET LOCAL application_name` or SQL comment makes the correlation visible in `pg_stat_activity` with no schema change.
- **Sentry + BullMQ:** there is no first-party integration. Wrap all 13 `create*Worker` processors through one shared helper that attaches the child logger, times the job, captures the exception and **re-throws** — never swallow, or BullMQ's retry semantics break.
- **OPS-13:** the "oldest job age" and "webhook lag" alerts should query Phase 11's `reconciling_since` directly.
- **OPS-16/OPS-17/OPS-18/OPS-19** are the user-facing half of the same goal: the frontend must not present a silent failure as an empty state. OPS-18 in particular pairs with Phase 13's rollup semantics — stale analytics must be labelled stale, not rendered as current.

---

### Phase 16: Live SendGrid Verification

**Goal**: Every delivery guarantee this milestone claims is confirmed against the real SendGrid account and a real inbox — not against a mock.
**Depends on**: Phases 10, 11, 12, 13, 14, 15
**Requirements**: UAT-01, UAT-02, UAT-03, UAT-04, UAT-05
**Success Criteria** (what must be TRUE):

  1. A live send using a tenant's own BYO key through a SendGrid Dynamic Template arrives in a real inbox.
  2. Real delivered, opened, clicked and bounced events from SendGrid land on the correct send, flow step and campaign.
  3. A genuinely signed SendGrid webhook payload passes signature verification through the full HTTP stack, and a redelivery of that same payload is counted exactly once.
  4. A real SendGrid 429 or transient error defers only the affected tenant's sends and resolves without duplicate or lost mail.

**Plans**: TBD

**Why UAT is its own final phase (deliberate decision):**

- It is named a **release barrier** for the milestone, not per-phase acceptance. Its scope is end-to-end confirmation across the whole pipeline, which no single earlier phase owns.
- Live verification needs a deployed environment with a real verified sender — that exists only after Phase 14. Attaching UAT-01/02 to Phase 11 would block the milestone's highest-priority correctness work on external environment readiness.
- UAT-05 spans Phase 11 (ambiguous outcomes) *and* Phase 12 (tenant fairness); UAT-03/04 span Phase 10 (signature/replay) *and* Phase 13 (dedup). Assigning them to any one phase would misrepresent what they verify.
- v1.0's accepted tech debt was precisely deferred live UAT. Making it a named, tracked phase with its own verification gate is what prevents it being deferred a second time — PROJECT.md already records this as a decision ("live SendGrid UAT — обязательный шаг фаз, не отложенный tech debt").
- **This does not replace per-phase verification.** Phases 8-15 each verify locally against the failure-injection harness and mocked/injected providers. Phase 16 is confirmation against the real provider, not the first test.

---

## Sequencing Decisions

**Deployment strategy vs. backward-compatible job payloads (research Pitfall 3).**
Running two dispatch code versions against one queue during a rolling restart can produce the exact duplicate-send bug this milestone fixes. Two ways to prevent it: define the deployment strategy before the send-pipeline changes roll out, or make those changes ship backward-compatible job payloads.

**Chosen: backward-compatible job payloads.** Phases 11, 12 and 13 add an explicit `schemaVersion` field to every changed BullMQ job payload, and the worker **defers** a payload version it does not recognize rather than best-effort processing it. Phase 14 then adopts **stop-old-then-start-new** for the worker specifically (a short queue-processing pause is safe — jobs wait in Redis; overlapping incompatible dispatch code is not) and adds the two-version-compatibility scenario to Phase 8's harness.

*Rationale:* the front of this milestone is already claimed by the 2026-09-01 partition deadline and by the failure-injection prerequisite. Pulling the full Docker/VPS deployment track ahead of delivery correctness would delay the audit's highest-priority finding behind ops work that itself depends on health endpoints (OPS-04/OPS-05) that do not yet exist. The payload contract is the cheaper, more local guarantee.

**Corollary — expand/contract ordering.** `ALTER TYPE send_status ADD VALUE 'reconciling'` ships as its own standalone migration, applied and confirmed **before** the deploy carrying code that references the value. Migration N (enum) → confirm applied → deploy N+1 (code). DB-08 in Phase 8 establishes this as the standing rule.

## Hard Sequencing Constraints (verify before reordering)

| Constraint | Reflected as |
|---|---|
| DB-01/DB-02 must complete before **2026-09-01** (external) | Phase 9, depends only on Phase 8, deliberately minimal so phase completion == deadline met |
| Failure-injection harness (QG-06) before delivery state machine (DLV-01..08) | Phase 8 → Phase 11 |
| Delivery state machine (DLV) before tenant-fair throttling (WRK-01/WRK-02) — same files | Phase 11 → Phase 12 |
| Postgres role separation (SEC-01/SEC-05) before cross-tenant scans (DLV-03 reconciler, WRK-05 sweep) | Phase 10 → Phases 11, 12 |
| Health endpoints (OPS-04/OPS-05) before deployment automation (OPS-02) | Intra-phase ordering in Phase 14 |
| Worker Pino logger (OPS-06) before Sentry / hosted logs / OTel (OPS-08, OPS-10, OPS-12) | Intra-phase ordering in Phase 15 |
| Redis `noeviction` + persistence (WRK-12) before worker-reliability fixes mean anything | Phase 8 → Phase 12 |
| Redaction rule set (SEC-13) before Sentry `beforeSend` (OPS-09) | Phase 10 → Phase 15 |
| Restore drill (DB-10) before retention deletion (DB-11) | Intra-phase ordering in Phase 14 |
| Deployment strategy vs. send-pipeline rollout | Resolved via backward-compatible payloads — see Sequencing Decisions |

## Open Decisions (for `/gsd-discuss-phase`)

| Decision | Phase | Options |
|---|---|---|
| **Better Auth trust boundary (SEC-05)** | Phase 10 | Dedicated least-privilege DB role (`mega_crm_auth` owning only the 7 auth tables, optionally in an `auth.*` schema; `mega_crm_app` revoked) **vs.** adding RLS to `organization`/`session`/`account`. Naive RLS breaks login platform-wide and silently — see Pitfall 12. |
| ~~**Per-tenant concurrency-cap mechanism (WRK-02)**~~ — **RESOLVED 2026-08-10 (D-01)** | Phase 12 | Redis semaphore at the application layer, keyed per tenant **and** lane (D-02), TTL-leased, over-cap jobs deferring through the same tenant-scoped path as the RPS ceiling. BullMQ-native per-group concurrency and bounded per-tier worker pools both rejected. See `.planning/phases/12-worker-reliability-tenant-fairness/12-CONTEXT.md`. |
| **Admin-scan connection shape (SEC-01)** | Phase 10 | Separate physical pool + separate credential (research's recommendation, strongest boundary) **vs.** `SET LOCAL ROLE` on the existing pool with role membership granted (smaller diff, weaker). Record as an ADR either way. |
| **PgBouncer now or defer to SCALE-02 (DB-14)** | Phase 14 | Introduce transaction-mode pooling now (requires Phase 10's bare-`SET` audit and interacts with DB-05's advisory lock) **vs.** explicitly defer until `max_connections` pressure is real. |

## Coverage

- v1.1 requirements: **95**
- Mapped to phases: **95**
- Unmapped: **0** ✓
- No requirement is mapped to more than one phase.

## Progress

**Execution Order:** Phases execute in numeric order: 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16.
Phase 9 has no dependents and may be scheduled in parallel at any point after Phase 8 — it must complete before 2026-09-01.

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Workspace Foundation & Team Access | v1.0 | 7/7 | Complete | 2026-07-03 |
| 2. Contacts & Event Ingestion | v1.0 | 14/14 | Complete | 2026-07-05 |
| 3. Segmentation Engine | v1.0 | 8/8 | Complete | 2026-07-06 |
| 4. Broadcast Campaigns & Send Pipeline | v1.0 | 19/19 | Complete | 2026-07-06 |
| 5. Webhook Processing & Delivery Tracking | v1.0 | 13/13 | Complete | 2026-07-09 |
| 6. Flows (Triggered Chains) | v1.0 | 24/24 | Complete | 2026-07-13 |
| 7. Analytics, Dashboard & Send Log | v1.0 | 11/11 | Complete | 2026-07-14 |
| 8. Quality Gates & Failure-Injection Foundation | v1.1 | 18/18 | Complete    | 2026-08-06 |
| 9. Partition Automation & Boundary Safety | v1.1 | 5/5 | Complete    | 2026-08-07 |
| 10. Tenant Isolation & Trust Boundaries | v1.1 | 15/15 | Complete    | 2026-08-09 |
| 11. Delivery Correctness | v1.1 | 11/11 | Complete    | 2026-08-09 |
| 12. Worker Reliability & Tenant Fairness | v1.1 | 14/14 | Complete    | 2026-08-11 |
| 13. Compliance & Analytics Integrity | v1.1 | 15/15 | In Progress|  |
| 14. Deployment & Database Durability | v1.1 | 0/TBD | Not started | - |
| 15. Observability, Alerting & Frontend Resilience | v1.1 | 0/TBD | Not started | - |
| 16. Live SendGrid Verification | v1.1 | 0/TBD | Not started | - |

---
*Roadmap for v1.1 created: 2026-07-27*
