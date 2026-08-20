# Phase 12: Worker Reliability & Tenant Fairness - Research

**Researched:** 2026-08-10
**Domain:** BullMQ (5.79.1) job-queue reliability, Redis-backed per-tenant fairness primitives, resumable cross-tenant background scans, Postgres dead-letter persistence
**Confidence:** MEDIUM-HIGH — internal codebase evidence is exhaustive (every file this phase touches was read directly); external BullMQ/library claims are WebSearch/WebFetch-verified against official docs (no Context7/Exa/Brave available in this environment — see Sources), not training-data guesses.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **WRK-01 (Pitfall 4):** `job.moveToDelayed(timestamp, job.token)` + `throw Worker.DelayedError()` ONLY for `cause: "tenant_bucket"`; keep `worker.rateLimit()` + `Worker.RateLimitError()` for `cause: "provider_backoff"` (a genuine worker-wide signal). Phase 11 already shipped the `cause` discriminator on `SendJobResult` at all six `rate_limited` return sites.
- **D-01 (WRK-02):** Redis semaphore at the application layer. Acquire/release counter keyed by tenant, held for the duration of the SendGrid dispatch, TTL-leased so a crashed worker cannot leak a slot forever. Over-cap jobs take the SAME `moveToDelayed`/`tenant_bucket` path as WRK-01's rate-limit deferral. BullMQ-native per-group concurrency rejected (Pro-only); bounded per-tier worker pools rejected (drifts toward rejected queue-per-tenant topology). Exact primitive (rate-limiter-flexible semaphore pattern vs. small INCR/DECR+TTL Lua pair) is planner discretion. Reversibility: costly.
- **D-02 (WRK-02):** Cap is keyed per lane: tenant + queue (separate slots in `email-broadcast` and `email-triggered`). A tenant-only key was rejected (recreates within-tenant starvation).
- **D-03 (WRK-02):** Cap values are platform-wide versioned constants with env override, one default per lane. No per-tenant DB storage this phase.
- **D-04 (WRK-03/04):** The two-tenant fairness load test follows the Phase 8 failure-injection pattern: a scaled-down deterministic scenario joins the existing failure-injection CI job, plus an on-demand full-target-volume npm-script variant. Both run on the fake `ProcessSendJobDeps.sendMail` seam.
- **D-05 (WRK-03/04):** "Measurably unaffected" = relative-to-baseline assertion: same scenario measures tenant B solo, then B alongside a saturating tenant A; assert B keeps ≥~90% of its own baseline throughput. Percentage is a versioned constant with rationale comment. Absolute floors and drain-only assertions rejected.
- **D-06 (WRK-04):** `DEFAULT_TENANT_RPS` backed by both halves: the on-demand full-scale variant runs at `DEFAULT_TENANT_RPS` proving sustained throughput without backlog growth, AND the constant's rationale cites SendGrid's documented guidance with the BYO plan-tier caveat.
- **D-07 (WRK-09/10):** Dead-letter mechanism is a Postgres table (`dead_letter_jobs`): the shared final-failure listener writes queue name, job id/name, redacted payload snapshot, error, and timestamps on attempt exhaustion. Durable across Redis flush/restart, SQL-queryable, watchdog-alertable. Redis-based DLQ queue rejected. Reversibility: costly.
- **D-08 (WRK-09/10):** DLQ observability this phase = extend the existing API-side watchdog + `OPERATOR_ALERT_EMAIL` (partition-watchdog/reconciler-health precedent, D-14), alert when dead-letter rows appear/accumulate, deduped via `claimAlertSlot`. Phase 15 (OPS-13) re-plumbs into real alerting; Bull Board stays Phase 15.
- **D-09 (WRK-05/06):** Sweep's resume checkpoint is a Postgres row per flow, committed in the same transaction as that page's enrollment work. `job.updateData()` rejected (lost on flush); bare Redis key rejected (volatile, no precedent).
- **D-10 (WRK-11):** Shared queue factory lives in a new workspace package `packages/queue-core`, imported by both `apps/worker` and `apps/api`: connection-options builder, queue/worker factory taking retention as a per-queue parameter, `defaultJobOptions`/TTL constants, shared error-listener attach helper. Cross-app import from `apps/worker/src` rejected; lint-pinned copies rejected. Reversibility: reversible.
- **D-11:** Known concrete gaps: tick `Queue` handles created inside worker factories (`send-reconciler`, `analytics-reconciliation`, `campaign-scheduler`, `partition-maintenance`, `flow-segment-sweep`, `flow-reconciliation`) are never closed on SIGTERM; NO `worker.on("failed")`/`on("error")` listeners anywhere in `apps/worker`; `removeOnFail: false` copied verbatim across ~7 queues; four tick registrations still use the older `tickQueue.add({repeat})` path instead of `upsertJobScheduler`.
- **WRK-05/06:** copy the `recipient-snapshot.ts`/`campaign-kickoff.worker.ts` keyset-pagination pattern (cursor on `contacts.id`, per-page `statement_timeout`), but reset the cursor on successful full completion of each walk. Split discovery-and-enqueue from the per-flow bounded walk, deterministic `jobId` per flow. The stale-snapshot anti-join `DELETE` gets the same `LIMIT`-bounded loop treatment.
- **WRK-09/11 (Pitfall 6):** retention is a per-queue parameter of the shared queue factory, never one shared constant. `flow-run-advance`'s differentiated policy (`removeOnComplete: true`, `removeOnFail: {age: 86400}`) is a deliberate precedent to preserve.
- **WRK-07 (Pitfall 7):** `worker.close()` on SIGTERM is already called and correct; the gap is the container stop grace period (owned jointly with Phase 14) — derive and document the drain timeout from SendGrid timeout + transaction margins.
- **WRK-13 (Pitfall 8):** BullMQ repeatable-job dedup prevents duplicate registration, not duplicate execution across instances. Multi-instance worker deployment is out of scope for v1.1 — document the single-instance constraint. Prefer `upsertJobScheduler` with a stable scheduler id over the older `tickQueue.add({repeat})` path.
- **Deploy-safety contract (R-05):** every changed BullMQ job payload carries an explicit `schemaVersion`.
- **Phase 11 D-15 handshake:** `apps/worker/src/queues/queue-options.ts` was written expressly so WRK-11 absorbs it — the three literal copies of `{attempts: 5, backoff: {type: "exponential", delay: 2000}}` collapse into imports of those constants.

### Claude's Discretion

- Exact semaphore primitive (rate-limiter-flexible pattern vs. INCR/DECR+TTL Lua), lease TTL, and slot-release placement (`finally` semantics) — subject to D-01's acquire-before-dispatch shape.
- Exact cap values per lane, fairness threshold percentage, load-test volumes/durations — all versioned constants with rationale comments.
- `dead_letter_jobs` schema details (columns, indexes, retention/pruning of the table itself), redaction of payload snapshots via the existing `@mega-crm/redaction` package.
- Sweep checkpoint table schema and page size; stale-snapshot `DELETE` batch size.
- Derived drain-timeout formula and value (must account for `SENDGRID_TIMEOUT_MS` + margins; documented where Phase 14's container stop-grace-period will consume it).
- Error-listener sink this phase (scrubbedConsole with queue/job context is the codebase norm; Phase 15 swaps in Sentry) and the exact attach-helper API.
- `packages/queue-core` internal layout and what, if anything, of the queue-name/payload-schema surface moves there vs. stays in `packages/shared-schemas`.
- Where the multi-instance-safety assumptions document lands (`ARCHITECTURE.md` section vs. standalone doc) — must satisfy WRK-13's "written down".

### Deferred Ideas (OUT OF SCOPE)

- Per-tenant concurrency-cap DB overrides / tiered plans — billing-era concern; additive migration later (D-03).
- Bull Board wiring and real alerting on queue depth / DLQ age — Phase 15 (OPS-13); this phase ships the interim watchdog email only (D-08).
- BullMQ Pro migration for native group rate-limit/concurrency — the stack docs' standing "revisit at scale" note; the D-01 semaphore is the OSS answer until operational friction proves otherwise.
- Multi-instance worker deployment — explicitly out of v1.1 scope; WRK-13 documents the single-instance constraint instead.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| WRK-01 | Исчерпание лимита одного тенанта откладывает только его задания и не останавливает воркер целиком | Pattern 1 (`moveToDelayed`/`DelayedError` for `tenant_bucket`, keep `rateLimit()`/`RateLimitError` for `provider_backoff`); Pitfall 1 |
| WRK-02 | Per-tenant concurrency cap ограничивает долю слотов воркера, занимаемых одним тенантом | Standard Stack (`redis-semaphore` candidate vs. hand-rolled Lua pair); Don't Hand-Roll; Open Question 1; System Architecture Diagram |
| WRK-03 | Нагрузочный тест подтверждает: тенант A получил 429, тенант B продолжает отправку | Validation Architecture (Phase Requirements → Test Map row WRK-03/04); Open Question 2 |
| WRK-04 | `DEFAULT_TENANT_RPS` подтверждён нагрузочным тестом или конфигурацией SendGrid | Validation Architecture; Open Question 2 |
| WRK-05 | Segment sweep ограничен по объёму — keyset pagination, checkpoint и короткие транзакции | Pattern 2 (cross-tenant discovery via scan role), Pattern 3 (keyset pagination + checkpoint) |
| WRK-06 | Segment sweep возобновляется после частичного сбоя без повторной обработки всего объёма | Pattern 3 (cursor-reset-on-completion difference from `recipient-snapshot.ts`); Pitfall 3 |
| WRK-07 | Graceful shutdown по SIGTERM закрывает все Queue handles без потери задания в работе | Pattern 4; Anti-Patterns (unclosed tick `Queue`s); Pitfall 4 (six-plus leaked handles); Pitfall 5 (drain-timeout derivation) |
| WRK-08 | Единые worker error listeners покрывают все воркеры | Code Examples (`attachSharedErrorListeners`); Anti-Patterns |
| WRK-09 | Failed jobs имеют ограниченную retention-политику вместо бессрочного хранения | Anti-Patterns / Pitfall 6 (per-queue retention parameter, `flow-run-advance` precedent); Pitfall 7 (sequencing vs. WRK-10) |
| WRK-10 | Dead-letter механизм наблюдаем | Don't Hand-Roll (Postgres table, existing watchdog pattern); Code Examples (redaction); Pitfall 7 |
| WRK-11 | Redis connection options, `defaultJobOptions` и значения TTL определены в единственном месте | Recommended Project Structure (`packages/queue-core`); Pitfall 6 |
| WRK-13 | Repeatable jobs имеют централизованную обработку ошибок; код multi-instance-safe и это задокументировано | Pattern 4 (`upsertJobScheduler` target state, four remaining migrations); Pitfall 2 (registration-idempotency ≠ execution-exclusivity); State of the Art |
</phase_requirements>

## Summary

Phase 12 is almost entirely a **consolidation and correctness-hardening** phase over code that already exists and mostly follows the right shape. Every mechanism this phase needs a precedent for — `withCrossWorkspaceScan` cross-tenant discovery, keyset-paginated bounded batches with `statement_timeout`, `upsertJobScheduler` registration, a two-process health-row/watchdog/`claimAlertSlot` dead-man's-switch, an exported-processor-for-testability convention, a `schemaVersion` deploy-safety discriminator — is already implemented at least twice elsewhere in this codebase (`partition-maintenance.worker.ts`, `send-reconciler.worker.ts`, `recipient-snapshot.ts`, `flow-reconciliation.worker.ts`). The work is almost never "invent a pattern"; it is "apply an existing, proven pattern to the six concrete gaps the CONTEXT.md scout already enumerated" (WRK-01's `rateLimit()` misuse, WRK-02's missing concurrency cap, WRK-05/06's unbounded sweep, WRK-07/08's unclosed tick `Queue`s and missing error listeners, WRK-09/11's copy-pasted retention/connection options, WRK-13's four old-style repeatable registrations).

The one genuinely new primitive is **WRK-02's per-tenant-per-lane concurrency cap**. External research confirms `rate-limiter-flexible` (already a dependency) has no concurrency/semaphore primitive at all — every class it ships (`RateLimiterRedis`/`Memory`/`Queue`/`Union`/`Bursty`/etc.) models *requests-per-time-window*, not *N-concurrent-holders-until-released*. This is a genuinely different problem from the RPS token bucket already in `rate-limiter.ts`, and forces a real choice between (a) hand-rolling a small Redis Lua INCR/DECR-with-cap-check pair, TTL-leased as a crash safety net, or (b) adopting the dedicated, actively-maintained npm package `redis-semaphore` (verified `OK` via package-legitimacy check: 542k weekly downloads, last published 2026-02-27, Lua-atomic, ioredis-native, built-in lease refresh). Both satisfy D-01's acquire-before-dispatch shape; this research recommends evaluating `redis-semaphore` first since CLAUDE.md's "don't hand-roll" ethos applies here too, but flags it as a **new dependency requiring a `checkpoint:human-verify`** before install (see Package Legitimacy Audit).

The second area requiring precision rather than pattern-copying is **WRK-07's drain-timeout derivation**: `SENDGRID_TIMEOUT_MS` (20s, `packages/delivery-core/src/send-mail.ts`) plus `RECORD_TX_MARGIN_MS` (5s) means a send job legitimately in flight at SIGTERM can take up to ~25s to resolve — already more than double Docker's unconfigured 10-second default SIGTERM→SIGKILL grace period. This phase must derive and document an explicit stop-grace-period value (Phase 14 consumes it), not accept any container runtime's default.

**Primary recommendation:** Treat this phase as six independent, mechanically-scoped gap closures against files already read in full during this research (listed under Code Context below), plus one new small building block (the tenant+lane concurrency semaphore) and one new workspace package (`packages/queue-core`). Do not re-derive any of the cross-tenant-scan, keyset-pagination, or watchdog patterns from scratch — copy them.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Per-tenant RPS throttling (existing, WRK-01 fix) | Worker (background process) | Database / Storage (Redis token bucket) | `processSendJob` inside `apps/worker` checks the bucket before every SendGrid call; Redis is the shared state store, never the browser/API tier. |
| Per-tenant-per-lane concurrency cap (WRK-02) | Worker (background process) | Database / Storage (Redis semaphore) | Same tier as RPS throttling — acquired/released around the SendGrid dispatch call inside the same two Worker wrappers. |
| Fairness load test (WRK-03/04) | Worker (test harness, no live provider) | — | Runs entirely inside `apps/worker`'s own test suite against the fake `sendMail` seam; no browser/API involvement. |
| Segment sweep (WRK-05/06) | Worker (background process) | Database / Storage (Postgres cursor + `mega_crm_scan` role) | Cross-tenant discovery via the dedicated scan role (Phase 10), per-tenant work re-scoped through `withTenant`. |
| Graceful shutdown / Queue-handle closing (WRK-07) | Worker (process lifecycle) | CDN/Static — none | Signal handling and BullMQ handle lifecycle are entirely process-internal to `apps/worker`; Phase 14's container orchestration is the *consumer* of the derived timeout, not a co-owner of the mechanism. |
| Unified error listeners (WRK-08) | Worker (process lifecycle) | — | Attached at Worker/Queue construction time inside `packages/queue-core`; no cross-tier concern. |
| Failed-job retention / DLQ (WRK-09/10) | Worker (writer) | Database / Storage (`dead_letter_jobs` table) + API (watchdog reader) | The worker writes; the durable record lives in Postgres; the API-side watchdog (already a pattern, Phase 9/11) reads and alerts — a three-tier chain but each hop reuses an existing tier boundary. |
| Single connection/options definition (WRK-11) | Worker + API (shared package) | — | `packages/queue-core` is imported by both processes that construct BullMQ `Queue`/`Worker` instances (`apps/worker`, `apps/api`) — this is explicitly a cross-app package, not tier-scoped. |
| Repeatable-job scheduling safety (WRK-13) | Worker (process lifecycle) | — | `upsertJobScheduler` registration and the single-instance-safety documentation are worker-process concerns; no browser/API tier involvement. |

## Standard Stack

### Core (already installed — versions from `package.json`, no change this phase)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `bullmq` | 5.79.1 [VERIFIED: package.json] | Job queue | Already the project's queue library; this phase consolidates its usage, does not replace it. Do NOT upgrade to the 6.x major mid-phase (npm registry shows 6.0.9 as latest [VERIFIED: npm registry] — a major bump carries breaking-change risk this phase's scope does not need to absorb). |
| `ioredis` | 5.11.0 [VERIFIED: package.json] | Redis client (BullMQ's + the app-level limiter's) | Unchanged. |
| `rate-limiter-flexible` | 11.2.0 [VERIFIED: package.json] | Per-tenant RPS token bucket (existing `rate-limiter.ts`) | Unchanged — confirmed via WebFetch of its own wiki [CITED: github.com/animir/node-rate-limiter-flexible/wiki] that it has NO concurrency/semaphore primitive; it stays the RPS mechanism only, never the concurrency-cap mechanism. |
| `pg` | (see package.json) | Postgres driver | Unchanged; the sweep checkpoint and dead-letter tables use the existing pooled/`withTenantTransaction` access patterns. |

### New for this phase

| Library | Version | Purpose | Why |
|---------|---------|---------|-----|
| `redis-semaphore` | 5.7.0 [ASSUMED — discovered via WebSearch, not yet installed; package-legitimacy `OK`, see audit below] | WRK-02's per-tenant-per-lane concurrency cap primitive | Purpose-built for exactly "N concurrent holders, TTL-leased, Lua-atomic, ioredis-native, with built-in lease refresh" — the shape D-01 already describes as "INCR/DECR+TTL Lua pair," except already written, tested, and maintained. Candidate only — **not a locked decision**; D-01 leaves the exact primitive to planner discretion and this is a recommendation, not a mandate. The hand-rolled Lua pair remains a fully valid alternative with zero new dependency. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `redis-semaphore` package | Hand-rolled `INCR`/`DECR` + `PEXPIRE` Lua script | Zero new dependency, full control over exact TTL/release semantics, but reinvents lease-refresh and fairness-ordering logic `redis-semaphore` already has tested. Codebase already hand-rolls the sibling RPS bucket's call site (not the algorithm), so either choice is consistent with existing style. |
| `redis-semaphore` package | BullMQ Pro group concurrency | Rejected at CONTEXT.md/roadmap level already (paid license; same "revisit at scale" note as group rate limiting) — not re-litigated here. |
| Postgres `dead_letter_jobs` table (D-07, locked) | A dedicated Redis DLQ queue | Rejected at CONTEXT.md level already — included here only for completeness. Confirmed via WebSearch: BullMQ itself has no native DLQ primitive [CITED: community consensus, multiple blog sources]; a durable side table (D-07's choice) or a second BullMQ queue are the only two community patterns, and the second inherits Redis's own retention/volatility problem the DLQ exists to escape. |

**Installation (only if `redis-semaphore` is selected by the plan):**
```bash
npm install redis-semaphore --workspace=apps/worker
```

**Version verification performed:**
```
npm view bullmq version                  → 6.0.9 latest (installed: 5.79.1, do not bump this phase)
npm view rate-limiter-flexible version   → 11.2.0 (matches installed)
npm view redis-semaphore version         → 5.7.0, published 2026-02-27
```

## Package Legitimacy Audit

| Package | Registry | Age (latest publish) | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----------------------|-----------|--------------|---------|-------------|
| `redis-semaphore` | npm | 2026-02-27 | 542,632/wk | github.com/swarthy/redis-semaphore | OK | Approved as a *candidate* — planner must add `checkpoint:human-verify` before install per the package-legitimacy protocol (any newly-adopted dependency), even at `OK` verdict. |
| `bullmq` | npm | 2026-08-07 (latest patch of an already-installed major) | 7,902,115/wk | github.com/taskforcesh/bullmq | SUS (`too-new` — flags the LATEST PUBLISH date, not first-release age; this is a 5-years-mature, ubiquitous library already pinned at 5.79.1 in `package.json`) | Not a new install — no action. Flag is a false positive of the "too-new" heuristic against a fast-shipping mature package. |
| `rate-limiter-flexible` | npm | 2026-06-08 (latest patch) | 2,902,034/wk | github.com/animir/node-rate-limiter-flexible | OK | Not a new install — no action. |
| `ioredis` | npm | 2026-07-31 (latest patch) | 26,117,444/wk | github.com/redis/ioredis | SUS (`too-new`, same false-positive pattern as bullmq) | Not a new install — no action. |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** `bullmq`, `ioredis` — both false positives of the "latest patch is recent" heuristic against mature, already-installed, already-pinned dependencies; no `checkpoint:human-verify` warranted for either since neither is a new install this phase.
**New-dependency gate:** if the plan adopts `redis-semaphore`, insert a `checkpoint:human-verify` task before `npm install redis-semaphore` per protocol, even though its own verdict is `OK` — the protocol requires the gate for any package first discovered via WebSearch regardless of registry-check outcome.

## Architecture Patterns

### System Architecture Diagram

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    apps/worker process                  │
                    │                                                          │
  BullMQ job  ─────▶│  email-broadcast.worker.ts / email-triggered.worker.ts  │
  (send)            │           │                                             │
                    │           ▼                                             │
                    │   processSendJob (send-dispatch.ts)                     │
                    │           │                                             │
                    │           ├──▶ [NEW] acquireTenantLaneSlot(tenantId,     │
                    │           │     lane) ──▶ Redis semaphore ──▶ over cap? │
                    │           │     YES → { outcome:"rate_limited",         │
                    │           │             cause:"tenant_bucket" }          │
                    │           │                                             │
                    │           ├──▶ consumeTenantToken (rate-limiter.ts)      │
                    │           │     over RPS? YES → same tenant_bucket path  │
                    │           │                                             │
                    │           ▼                                             │
                    │   SendGrid mail/send (SENDGRID_TIMEOUT_MS=20s bound)     │
                    │           │                                             │
                    │           ▼                                             │
                    │   [FINALLY] releaseTenantLaneSlot(tenantId, lane)        │
                    │           │                                             │
                    │           ▼                                             │
                    │   sends ledger write (Postgres, per-tenant transaction)  │
                    │                                                          │
                    │  ── worker wrapper branch on cause ──                    │
                    │   cause=="tenant_bucket" → job.moveToDelayed(token) +    │
                    │                              throw Worker.DelayedError() │
                    │   cause=="provider_backoff" → worker.rateLimit() +      │
                    │                              throw Worker.RateLimitError│
                    │                                                          │
                    │  ── repeatable ticks (upsertJobScheduler) ──             │
                    │   flow-segment-sweep: findLiveSegmentTriggeredFlows      │
                    │     (mega_crm_scan role, cross-tenant discovery)         │
                    │     ──▶ per-flow keyset-paginated walk (contacts.id      │
                    │          cursor, statement_timeout, checkpoint row       │
                    │          committed with each page, Postgres)             │
                    │                                                          │
                    │  ── all Workers + tick Queues ──                         │
                    │   worker.on("error"/"failed") ──▶ shared listener        │
                    │     (queue-core) ──▶ on terminal failure ──▶             │
                    │     dead_letter_jobs INSERT (Postgres)                   │
                    │                                                          │
                    │  ── SIGTERM ──▶ WorkerRuntime.close(): await every       │
                    │     Worker.close() AND every tracked tick Queue.close()  │
                    │     (bounded by the derived drain-timeout margin)        │
                    └─────────────────────────────────────────────────────────┘
                                          │
                                          ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │                     apps/api process                    │
                    │  DLQ watchdog (extends partition/reconciler pattern):    │
                    │  poll dead_letter_jobs ──▶ claimAlertSlot ──▶            │
                    │  OPERATOR_ALERT_EMAIL via platform SendGrid key          │
                    └─────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
packages/queue-core/                       # NEW — D-10
├── src/
│   ├── connection.ts                      # buildRedisConnectionOptions (absorbs apps/worker's connection.ts + the 3 API-side copies)
│   ├── queue-options.ts                   # DEFAULT_JOB_OPTIONS factory taking retention as a PARAMETER (absorbs Phase 11's queue-options.ts constants)
│   ├── error-listeners.ts                 # attachSharedErrorListeners(worker) helper (WRK-08)
│   ├── tenant-fairness/
│   │   ├── tenant-rps-limiter.ts          # moved or re-exported from apps/worker/src/queues/rate-limiter.ts (planner discretion, D-10 note)
│   │   └── tenant-lane-semaphore.ts       # NEW — WRK-02's concurrency cap
│   └── index.ts
├── package.json
└── vitest.config.ts

apps/worker/src/queues/
├── flows/flow-segment-sweep.worker.ts     # REWRITE — bounded, resumable, checkpointed (WRK-05/06)
├── flows/flow-segment-sweep-checkpoint.ts # NEW — checkpoint table read/write, cursor-reset-on-completion
├── email-broadcast.worker.ts              # EDIT — WRK-01 cause split + WRK-02 semaphore acquire/release
├── email-triggered.worker.ts              # EDIT — same
├── server.ts                              # EDIT — WorkerRuntime.close() also closes tracked tick Queues (WRK-07)
└── dead-letter/dead-letter-writer.ts      # NEW — the shared terminal-failure listener's DB write (WRK-09/10)

packages/db/migrations/
├── 00NN_dead_letter_jobs.sql               # NEW (D-07)
└── 00NN_flow_segment_sweep_checkpoint.sql   # NEW (D-09) — or folded into the flow_segment_membership_snapshot migration family

apps/api/src/modules/ops/
└── dead-letter-watchdog.ts                 # NEW — third watchdog, mirrors partition-watchdog.ts/send-reconciler-watchdog.ts exactly (D-08)
```

### Pattern 1: Tenant-scoped deferral via `moveToDelayed` + `DelayedError` (WRK-01/WRK-02, the one shared mechanism for two triggers)

**What:** When a job cannot proceed for a *tenant-scoped* reason (RPS bucket exhausted, or — new this phase — concurrency cap exhausted), the processor calls `await job.moveToDelayed(Date.now() + delayMs, token)` then `throw new DelayedError()` (or `throw Worker.DelayedError()`, both bound to the same class). This returns the job to the delayed set without consuming `job.attemptsMade` and without pausing the worker's own draining of other tenants' jobs.

**When to use:** Exactly the two `cause: "tenant_bucket"` triggers (RPS, concurrency cap) — never for `cause: "provider_backoff"`, which stays on `worker.rateLimit()` + `Worker.RateLimitError()` because a SendGrid-wide 429/5xx genuinely is a worker-scoped signal.

**Example (verified pattern, WebFetch of BullMQ's own `process-step-jobs` doc page):**
```typescript
// Source: https://docs.bullmq.io/patterns/process-step-jobs (WebFetch, 2026-08-10)
import { DelayedError, Worker } from "bullmq";

const worker = new Worker(
  "email-broadcast",
  async (job, token) => {
    // token is the processor function's SECOND argument -- BullMQ supplies
    // it automatically; it is NOT something the caller constructs.
    const result = await processSendJob(job.data, deps);
    if (result.outcome === "rate_limited" && result.cause === "tenant_bucket") {
      await job.moveToDelayed(Date.now() + result.rateLimitMs, token);
      throw new DelayedError(); // do NOT let this fall through to a normal throw
    }
    // ...provider_backoff branch unchanged (worker.rateLimit() + RateLimitError)
  },
  { connection }
);
```
[VERIFIED: BullMQ own docs, WebFetch 2026-08-10] `DelayedError`/`RateLimitError`/`WaitingChildrenError` are the exact three exception types BullMQ excludes from `job.attemptsMade` increments — confirmed via a second independent WebSearch cross-check of a BullMQ GitHub issue thread discussing this exact exclusion list.

### Pattern 2: Cross-tenant discovery via the dedicated scan role, then per-tenant re-scoping (existing codebase pattern — copy, do not reinvent)

**What:** A background scan that must look across every tenant to find "what's due" runs through `withCrossWorkspaceScan` (the Phase 10 `mega_crm_scan` role, SELECT-only, narrowed by a role-scoped RLS policy per table). Every subsequent read/write for a discovered row re-enters `withTenant(row.workspaceId)` / `withTenantTransaction` — the admin exception grants nothing beyond the initial discovery.

**When to use:** WRK-05/06's segment sweep discovery step (already implemented this way in `flow-segment-sweep.worker.ts`'s `findLiveSegmentTriggeredFlows` — this phase does NOT change the discovery mechanism, only the per-flow walk that follows it).

**Example (from this codebase, `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts:51-63`):**
```typescript
async function findLiveSegmentTriggeredFlows(): Promise<DueSegmentFlowRow[]> {
  return withCrossWorkspaceScan(async (client) => {
    const { rows } = await client.query<DueSegmentFlowRow>(
      `SELECT id, workspace_id as "workspaceId", trigger_segment_id as "triggerSegmentId",
              live_version_id as "liveVersionId", reentry_mode as "reentryMode",
              reentry_window_days as "reentryWindowDays"
       FROM flows
       WHERE status = 'live' AND trigger_type = 'segment'
         AND trigger_segment_id IS NOT NULL AND live_version_id IS NOT NULL`
    );
    return rows;
  });
}
```

### Pattern 3: Keyset-paginated bounded batch with a persisted, transaction-atomic resume cursor (WRK-05/06 — copy `recipient-snapshot.ts`, adapt for perpetual re-walk)

**What:** Page on `contacts.id > $cursor ORDER BY id ASC LIMIT $batchSize`, never OFFSET/skip-ahead pagination (O(n²) at scale). Persist the cursor **in the same transaction** as the page's other writes, so a crash between page-commit and cursor-advance is structurally impossible — the "stop when a page returns 0 rows" loop-termination condition depends on this atomicity.

**Critical difference from `recipient-snapshot.ts` (D-09, locked):** `recipient-snapshot.ts`'s cursor is a **one-shot freeze** — once the walk completes, the campaign never re-walks, so the cursor stays forever. The segment sweep is **perpetual** — it re-walks every `SWEEP_INTERVAL_MS`. A cursor that is never reset would silently skip any contact inserted with an `id` sorting before the last cursor position between two ticks (a UUID or serial inserted "behind" the cursor is common with concurrent inserts). **Reset the cursor to `NULL` on successful full completion of each walk**, so the next tick's walk starts from the beginning again. This is the one clause that must NOT be copied verbatim from `recipient-snapshot.ts`.

**Example (adapted from `apps/worker/src/queues/recipient-snapshot.ts:42-76`, cursor-reset behavior is NEW for this phase — no existing file has this exact shape):**
```typescript
// Pattern, not verbatim copy — recipient-snapshot.ts's materializeBatch is the
// structural template; the checkpoint table + cursor-reset-on-completion below
// is new (D-09).
export async function sweepOneFlowPage(
  client: PoolClient,
  flowId: string,
  workspaceId: string,
  whereSql: string,
  params: unknown[],
  afterContactId: string | null
): Promise<{ matched: number; lastContactId: string | null }> {
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(BULK_QUERY_STATEMENT_TIMEOUT_MS)]);
  const cursorClause = afterContactId ? `AND c.id > $${params.length + 1}` : "";
  const cursorParams = afterContactId ? [...params, afterContactId, PAGE_SIZE] : [...params, PAGE_SIZE];
  const { rows } = await client.query<{ id: string }>(
    `SELECT c.id FROM contacts c WHERE ${whereSql} ${cursorClause} ORDER BY c.id ASC LIMIT $${cursorParams.length}`,
    cursorParams
  );
  const lastContactId = rows.at(-1)?.id ?? null;
  // ... enroll each matched contact via enterSegmentTriggeredFlow ...
  // Cursor write is in the SAME transaction as the enrollment writes above.
  if (lastContactId) {
    await client.query(
      `UPDATE flow_segment_sweep_checkpoint SET cursor = $2, updated_at = now() WHERE flow_id = $1`,
      [flowId, lastContactId]
    );
  } else {
    // Walk complete this tick -- RESET so the next tick re-walks from the start
    // (the difference from recipient-snapshot.ts's permanent cursor).
    await client.query(
      `UPDATE flow_segment_sweep_checkpoint SET cursor = NULL, updated_at = now() WHERE flow_id = $1`,
      [flowId]
    );
  }
  return { matched: rows.length, lastContactId };
}
```

### Pattern 4: Idempotent repeatable-tick registration via `upsertJobScheduler`, with a fire-and-forget try/finally that always closes the registration-time `Queue` (WRK-13, WRK-07's partial precedent)

**What:** `queue.upsertJobScheduler(schedulerId, repeatOpts, jobTemplate)` dedupes by a **stable scheduler id**, so calling it on every boot never creates a second competing schedule — this is registration-idempotency, not execution-exclusivity (see Pitfall below). The registration itself runs inside a `try { await queue.upsertJobScheduler(...); await queue.add(bootJob) } catch { log } finally { await queue.close() }` IIFE so a Redis hiccup at boot logs instead of crashing every other registered worker via an unhandled rejection, and the short-lived registration `Queue` handle is always closed.

**Already correctly implemented (copy exactly) in:** `partition-maintenance.worker.ts` and `send-reconciler.worker.ts`.

**NOT yet migrated (WRK-13's actual target list):** `campaign-scheduler.worker.ts`, `analytics-reconciliation.worker.ts`, `flow-segment-sweep.worker.ts`, `flow-reconciliation.worker.ts` — all four still use the older `tickQueue.add("name", {}, { repeat: { every: N }, jobId: "..." })` form with **no** `try/finally` and **no `queue.close()` at all**, meaning their tick `Queue` (and, in `campaign-scheduler.worker.ts`'s case, its second long-lived `kickoffQueue` producer handle) leaks a Redis connection for the life of the process and is invisible to `WorkerRuntime.close()`.

**Example (target state, from `apps/worker/src/queues/partition-maintenance.worker.ts:237-253`):**
```typescript
const registration = (async () => {
  try {
    await queue.upsertJobScheduler(
      JOB_SCHEDULER_ID,
      { pattern: PARTITION_MAINTENANCE_CRON, tz: "UTC" },
      { name: JOB_NAME, opts: DEFAULT_JOB_OPTIONS }
    );
    await queue.add(JOB_NAME, {}, { ...DEFAULT_JOB_OPTIONS, jobId: bootJobId });
  } catch (err) {
    scrubbedConsole.error("...: scheduler registration failed", err);
  } finally {
    await queue.close().catch(() => undefined);
  }
})();
```

### Anti-Patterns to Avoid

- **Using `worker.rateLimit()` for a tenant-scoped condition:** it pauses the ENTIRE worker's draining for every tenant, not just the offending one — this is the literal WRK-01 bug being fixed, confirmed by WebFetch of BullMQ's own rate-limiting doc: *"The rate limiter is global, so if you have for example 10 workers for one queue with the above settings, still only 10 jobs will be processed by second"* [CITED: docs.bullmq.io/guide/rate-limiting].
- **Treating `upsertJobScheduler`'s registration-idempotency as execution-exclusivity across multiple worker instances:** confirmed via WebSearch that it dedupes SCHEDULE registration only — it does not itself prevent two worker *processes* pointed at the same Redis from both picking up and executing the same tick. Multi-instance deployment is out of v1.1 scope (WRK-13), but the *documentation* this phase writes must say this precisely, not merely "BullMQ handles it."
- **Closing only the `Worker[]` array on SIGTERM and assuming that's "every Queue handle":** `WorkerRuntime.close()` today does exactly this — six tick-registration `Queue`s (and `campaign-scheduler.worker.ts`'s long-lived `kickoffQueue`) are constructed inside worker factories and never returned to `server.ts`, so they can never be closed there. The fix must either (a) have `WorkerRuntime` track and close every such handle, or (b) migrate every tick worker to the close-immediately-after-registration shape `partition-maintenance.worker.ts` already uses for its *registration* queue — but note `campaign-scheduler.worker.ts`'s `kickoffQueue` is a long-lived *producer*, not a one-shot registration queue, so it structurally cannot use the close-after-registration shape and MUST be tracked and closed at shutdown instead.
- **Accepting Docker's unconfigured default stop-timeout for the worker container:** confirmed via WebSearch — `docker stop` defaults to a 10-second SIGTERM→SIGKILL grace period on Linux [CITED: docs.docker.com/reference/cli/docker/container/stop, multiple independent sources converge on 10s]. A send job legitimately in flight can take up to `SENDGRID_TIMEOUT_MS` (20s, `packages/delivery-core/src/send-mail.ts:117`) + `RECORD_TX_MARGIN_MS` (5s, `apps/worker/src/queues/queue-options.ts:33`) ≈ 25s to resolve after SIGTERM — already 2.5× the unconfigured default. This is the exact "died after SendGrid accepted" scenario Phase 11's reconciler exists to handle, and it is entirely avoidable by setting an explicit, derived `stop_grace_period`/`--stop-timeout`/`terminationGracePeriodSeconds` well above 25s (documented for Phase 14 to consume).
- **Collapsing all queues' retention into one shared constant when building `packages/queue-core`:** `flow-run-advance`'s `removeOnComplete: true` / `removeOnFail: { age: 86400 }` is deliberately different from the ~7 other queues' `removeOnComplete: { age: 86400 }` / `removeOnFail: false` — a shared factory MUST take retention as a parameter, not bake in one shape (Pitfall 6, locked at CONTEXT.md level, re-verified in this research by reading `flow-queues.ts` directly).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Distributed concurrency cap (N-concurrent-holders, TTL-leased) | A bespoke Lua script from scratch | `redis-semaphore` npm package (candidate, gated by `checkpoint:human-verify`) OR, if the team prefers zero new dependencies, a small documented `INCR`/`PEXPIRE` Lua pair explicitly modeled on `redis-semaphore`'s own algorithm (its source is MIT-licensed and short) | Lease-refresh, fairness ordering under contention, and crash-safety (TTL expiry) are exactly the kind of "looks simple, is not" concurrency primitive this codebase's own CLAUDE.md philosophy (via `rate-limiter-flexible` already being chosen over a hand-rolled token bucket for the RPS cap) argues against reinventing. |
| Dead-letter observability | A bespoke Bull Board fork or a second BullMQ queue as the "dead letter queue" | Postgres `dead_letter_jobs` table (D-07, already locked) + the existing watchdog/`claimAlertSlot`/`OPERATOR_ALERT_EMAIL` pattern (D-08) | BullMQ has no native DLQ primitive [CITED: community consensus, multiple sources]; a second BullMQ queue inherits the exact volatility/retention problem the DLQ exists to escape, and Bull Board is explicitly Phase 15 scope. |
| Cross-tenant discovery scans | A session-level GUC bypass or an app-level `WHERE workspace_id IS NOT NULL` trick | `withCrossWorkspaceScan` (Phase 10's `mega_crm_scan` role) | Already the codebase's single audited cross-tenant read path; reinventing it here would violate Phase 10's SEC-01/SEC-02 guarantees this phase depends on. |
| Keyset pagination cursor math | A count-based OFFSET/LIMIT walk | The `c.id > $cursor ORDER BY id ASC LIMIT $n` pattern from `recipient-snapshot.ts` | OFFSET pagination degrades to O(n²) at 100k-1M-row scale — already documented as Pitfall 3 elsewhere in this project's research corpus. |

**Key insight:** every "don't hand-roll" item in this phase already has a first-party precedent *inside this repository* except the concurrency semaphore — for everything else, "don't hand-roll" means "don't invent a second implementation of a pattern this codebase already has once."

## Common Pitfalls

### Pitfall 1: `moveToDelayed` called without its required `token` argument, or without immediately throwing `DelayedError`
**What goes wrong:** BullMQ holds a job lock keyed by a `token` value while a processor runs; `moveToDelayed` needs that exact token to release the lock cleanly. Omitting it, or continuing normal processor logic after the call instead of immediately `throw`ing `DelayedError`, leaves BullMQ unable to tell "this job was intentionally delayed" from "this job's processor kept running and then also completed/threw" — a race between two conflicting resolution paths for the same job.
**Why it happens:** the token is the processor function's *second* parameter (`async (job, token) => {...}`), easy to omit if the existing processor signature (`handleEmailBroadcastJob(job, worker, deps)`) is edited without threading `token` through.
**How to avoid:** every branch that calls `job.moveToDelayed` must be immediately followed by `throw new DelayedError()` (or `Worker.DelayedError()`) with no other code path reachable afterward in that call.
**Warning signs:** a job that should have deferred instead appears in the completed or failed set; BullMQ logging a "Missing lock for job" error [CITED: github.com/taskforcesh/bullmq/discussions/1912].

### Pitfall 2: Treating `upsertJobScheduler`'s dedup as multi-instance execution safety
**What goes wrong:** a future engineer reads "idempotent registration" and assumes it also means "only one instance will ever execute this tick," then deploys two worker replicas.
**Why it happens:** the registration-time guarantee and the execution-time guarantee sound like the same property but are not; BullMQ's scheduler dedupes the *schedule entry* in Redis, not a distributed execution lock.
**How to avoid:** document explicitly (WRK-13's "written down" requirement) that single-instance worker deployment is a hard constraint for v1.1, not an emergent property of `upsertJobScheduler`; any future migration to multi-instance MUST add its own execution-exclusivity mechanism (e.g., the reconciler/campaign-scheduler's own `FOR UPDATE SKIP LOCKED` per-row claim already provides this at the *data* layer, but the *tick itself* firing twice is still possible and must be tolerated by that per-row idempotency, not prevented at the scheduler layer).
**Warning signs:** duplicate side effects from a single logical "tick" appearing in logs from two different process ids/hostnames.

### Pitfall 3: A permanent segment-sweep cursor silently skips contacts inserted "behind" it
**What goes wrong:** copying `recipient-snapshot.ts`'s cursor semantics verbatim (never reset) for a *perpetual* re-walk means any contact whose `id` sorts before the last-seen cursor position, inserted between two sweep ticks, is never picked up by the `c.id > $cursor` filter again.
**Why it happens:** `recipient-snapshot.ts`'s cursor exists for a one-shot freeze where "already walked past" is a permanently true fact; the segment sweep's walk is re-run every `SWEEP_INTERVAL_MS`, where "already walked past, this time" is not the same as "will never need re-checking."
**How to avoid:** reset the cursor to `NULL` on successful full completion of each walk (D-09, this research's Pattern 3).
**Warning signs:** a contact matching a segment-triggered flow's segment definition never enrolls despite the sweep running on schedule, and the event-driven re-check (`checkSegmentEntryForContact`) also never fired for that contact (e.g. a bulk CSV property update with no accompanying event).

### Pitfall 4: `WorkerRuntime.close()` closing only `Worker[]`, missing six-plus internal `Queue` handles
**What goes wrong:** `send-reconciler`, `analytics-reconciliation`, `campaign-scheduler` (two handles — `tickQueue` AND the long-lived `kickoffQueue`), `partition-maintenance`, `flow-segment-sweep`, `flow-reconciliation` all construct at least one `new Queue(...)` inside their factory function that is never returned to `server.ts`'s `workers: Worker[]` array. `partition-maintenance` and `send-reconciler`'s *registration-time* queues already self-close in a `finally` shortly after boot — but `campaign-scheduler.worker.ts`'s `kickoffQueue` is a genuinely long-lived producer (used on every tick, not just at registration) and has no close call anywhere.
**Why it happens:** each factory function was written in isolation, following the "tick queue" convention without a shared registry for shutdown.
**How to avoid:** either (a) have every factory function return its internal `Queue` handle(s) alongside the `Worker` so `server.ts` can track and close them, or (b) route every internal `Queue` construction through a `queue-core` helper that registers itself in a process-wide closeable registry automatically.
**Warning signs:** the worker process's Redis connection count does not drop to zero shortly after SIGTERM even though `process.exit(0)` was reached — some connections were never asked to close.

### Pitfall 5: A container's SIGTERM→SIGKILL grace period shorter than the worst-case in-flight send job
**What goes wrong:** the container runtime issues SIGKILL before `worker.close()`'s drain of an in-flight SendGrid dispatch finishes, producing exactly the "SendGrid accepted the email, but the process died before the `sends` row was written" ambiguous-outcome scenario Phase 11's `reconciling` state and reconciler exist to resolve — but every occurrence still costs a reconciliation-window resolution delay that a correctly-sized grace period would avoid entirely.
**Why it happens:** Docker's unconfigured default is 10 seconds [CITED: docs.docker.com]; nobody derives this number from the actual worst-case in-flight duration (`SENDGRID_TIMEOUT_MS` + `RECORD_TX_MARGIN_MS` ≈ 25s) unless told to.
**How to avoid:** derive and document an explicit stop-grace-period value with margin above the worst case (this research suggests documenting the formula as `SENDGRID_TIMEOUT_MS + RECORD_TX_MARGIN_MS + safety_margin`, landing well above 25s — the exact chosen value and its safety margin are planner/Phase-14-joint discretion per CONTEXT.md), and hand that documented value to Phase 14's container configuration rather than leaving it as an unexamined default.
**Warning signs:** an elevated rate of sends landing in `reconciling` correlated with deploy timestamps.

### Pitfall 6: Collapsing all queues' `defaultJobOptions` retention into one shared constant
**What goes wrong:** `flow-run-advance`'s `removeOnComplete: true` exists specifically to prevent a completed advance job's id from shadowing a future wake for the same run (a real, already-fixed bug — CR-01, 06-12); forcing it onto the shared 24h-retention shape every other queue uses would silently reintroduce that bug.
**Why it happens:** "consolidate into one factory" is an easy overreach from "consolidate the *connection/error-listener* boilerplate" into "also force one retention policy."
**How to avoid:** the `queue-core` factory's retention arguments are a required parameter with no default, or a default that is per-call-site-overridable and documented as such.
**Warning signs:** a flow run's wake job silently no-ops because a completed job with the same id is still retained.

### Pitfall 7: A DLQ table that races the failed-job listener against Redis's own retention aging out the failed set first
**What goes wrong:** if `removeOnFail`'s retention window is shortened (WRK-09) before the dead-letter write path (WRK-10) is reliably wired for every queue, a job could age out of Redis's failed set before the DLQ listener ever observes it as terminally failed.
**Why it happens:** WRK-09 (retention) and WRK-10 (DLQ) are separate requirements but causally ordered — D-07 in CONTEXT.md already states this explicitly ("this unblocks WRK-09: with terminal failures durably recorded, Redis failed-set retention can age out freely").
**How to avoid:** sequence the DLQ writer (attached via the shared error-listener) as a precondition before shortening any queue's `removeOnFail` retention from its current `false` (keep forever) to a bounded age — never ship the retention shortening first.
**Warning signs:** a terminally-failed job visible in neither Redis (aged out) nor `dead_letter_jobs` (listener not yet attached to that queue).

## Code Examples

### Attaching a shared error listener (WRK-08 target shape)
```typescript
// New helper, packages/queue-core/src/error-listeners.ts (D-10) — not yet
// written anywhere in this codebase; shape informed by BullMQ's own
// recommendation to attach worker.on("error", ...) on every Worker
// [CITED: WebSearch of docs.bullmq.io/guide/workers + docs.bullmq.io/guide/troubleshooting,
// which state that a missing error listener risks an unhandled exception].
import type { Worker } from "bullmq";
import { scrubbedConsole } from "@mega-crm/redaction";

export function attachSharedErrorListeners(worker: Worker, queueName: string): void {
  worker.on("error", (err) => {
    scrubbedConsole.error(`${queueName}: worker error`, err);
  });
  worker.on("failed", (job, err) => {
    scrubbedConsole.error(`${queueName}: job failed`, { jobId: job?.id, err: err.message });
    // WRK-10: dead-letter write happens here, gated on job.attemptsMade >= (job.opts.attempts ?? 1)
    // -- a mid-retry "failed" event is NOT a terminal failure and must not
    // write to dead_letter_jobs yet.
  });
}
```

### Redacting a payload before the dead-letter write (D-07's redaction requirement)
```typescript
// Existing primitive to reuse -- packages/redaction/src/index.ts exports
// `scrub`, NOT `redactPayload` (verify exact import name before using it).
import { scrub } from "@mega-crm/redaction";

const redactedPayload = scrub(job.data); // JSON-serializable snapshot, PII/secrets censored
```

### The `schemaVersion` deploy-safety contract (R-05, already established — extend, don't reinvent)
```typescript
// Source: packages/shared-schemas/src/queues.ts:88-93 (this codebase, Phase 11's
// first schemaVersion-carrying payload)
export const SEND_RECONCILER_TICK_SCHEMA_VERSION = 1;
export const sendReconcilerTickJobSchema = z.object({
  schemaVersion: z.literal(SEND_RECONCILER_TICK_SCHEMA_VERSION),
});
// Consumer defers (never throws) on mismatch -- apps/worker/src/queues/send-reconciler.worker.ts:378-385
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `tickQueue.add({repeat: {every: N}})` interval-from-boot registration | `queue.upsertJobScheduler(id, repeatOpts, template)` | BullMQ's job-scheduler API (already adopted by this codebase's Phase 9/11 work, `partition-maintenance.worker.ts`/`send-reconciler.worker.ts`) | Stable id-based dedup survives restarts more legibly than repeat-config+jobId dedup; this phase (WRK-13) finishes migrating the four remaining older-style registrations. |
| BullMQ OSS group/per-key rate limiting | Removed in BullMQ v3+, group rate limiting is BullMQ-Pro-only | Confirmed independently via WebFetch of `docs.bullmq.io/guide/rate-limiting` in this research session, matching the project's own CLAUDE.md STACK.md note | No OSS-native path exists for either per-tenant RPS (already solved via `rate-limiter-flexible`) or per-tenant concurrency (WRK-02's new problem) — both must be solved at the application layer, never by reaching for a BullMQ built-in. |

**Deprecated/outdated:** none identified specific to this phase beyond the above — this is a hardening phase over recently-written (Phase 8-11) code, not legacy code.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `redis-semaphore` (npm, 5.7.0) is a suitable off-the-shelf primitive for WRK-02's per-tenant-per-lane concurrency cap | Standard Stack / Don't Hand-Roll | If its lease-refresh or fairness-ordering semantics don't compose cleanly with BullMQ's own job-token lifecycle, the planner may need to fall back to a hand-rolled Lua pair mid-phase — no code has been written against this package yet, this is a WebSearch-informed recommendation only, not a verified integration. |
| A2 | An explicit stop-grace-period of "well above 25s" (derived from `SENDGRID_TIMEOUT_MS` + `RECORD_TX_MARGIN_MS`) is sufficient margin for WRK-07's drain budget | Common Pitfalls (Pitfall 5) | If BullMQ's own internal retry/backoff logic or a slow Postgres write under load pushes the true worst case higher, the derived value undercounts — the exact numeric value and its safety margin are explicitly left to planner/Phase-14-joint discretion in CONTEXT.md, not locked here. |
| A3 | BullMQ has no native dead-letter-queue primitive | Don't Hand-Roll, State of the Art | This was WebSearch-sourced (LOW confidence per the seam's own classification of unverified web results) rather than confirmed against BullMQ's official docs directly (the fetch of `docs.bullmq.io/guide/workers` did not surface DLQ-specific content) — CONTEXT.md's D-07 already locks the Postgres-table decision regardless, so this assumption does not change the plan, only its justification. |

## Open Questions

1. **Does `redis-semaphore`'s lease-refresh interval need to be tuned against `SEND_LOCK_DURATION_MS` (60s, BullMQ's own job lock)?**
   - What we know: `redis-semaphore`'s default `refreshInterval` is `lockTimeout * 0.8`; the semaphore's hold duration should track "how long this tenant+lane slot is occupied," which is bounded by the SendGrid dispatch + ledger write (~25s worst case), not by BullMQ's 60s job lock.
   - What's unclear: whether the semaphore's own `lockTimeout` should be set independently of `SEND_LOCK_DURATION_MS`, or deliberately derived from it (e.g., some fraction) to keep every timing constant in `queue-options.ts`'s single-source-of-truth spirit.
   - Recommendation: planner should size the semaphore lease TTL from the SAME derivation chain as `SEND_MAX_JOB_LIFETIME_MS` already uses (worst-case dispatch + margin), not from `SEND_LOCK_DURATION_MS` directly — they bound different things (BullMQ's redelivery risk vs. a Redis slot leak).

2. **Should the fairness load test's on-demand full-scale variant be gated behind an explicit npm script name, and does it need its own CI job or ride inside the existing `failure-injection` job?**
   - What we know: D-04 locks "joins the existing failure-injection CI job (scaled-down) + an on-demand full-target-volume npm-script variant" — the existing `.github/workflows/ci.yml` has a `failure-injection` required-status-check job and `package.json` has a `failure:all` aggregator script (`npm run failure:429 && ... && npm run failure:redis-restart`).
   - What's unclear: the exact new script name(s) — this research recommends following the existing `failure:<scenario>` naming convention (e.g., `failure:tenant-fairness`) for the CI-joining scaled-down scenario, and a separate, NOT-CI-wired script (e.g., `loadtest:tenant-rps`) for the on-demand full-scale variant, consistent with D-04/D-06's "both run on the fake sendMail seam" note.
   - Recommendation: planner names both scripts explicitly in the plan so the CI wiring task has an unambiguous target.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Redis | WRK-01/02/05 (rate limiter, semaphore, BullMQ) | ✓ (existing dev/CI setup — `TEST_REDIS_URL` already wired in `.github/workflows/ci.yml`) | 7.x (per CLAUDE.md stack; confirm actual server version in the deploy environment, not re-checked in this research session) | — |
| PostgreSQL | WRK-05/06/09/10 (checkpoint table, dead_letter_jobs) | ✓ (existing dev/CI setup) | 16/17 per CLAUDE.md stack | — |
| `mega_crm_scan` DB role | WRK-05/06's sweep discovery | ✓ (Phase 10 already provisioned it; `SCAN_DATABASE_URL` fail-fast already in `server.ts`) | — | — |
| npm registry access (for `redis-semaphore`, if adopted) | WRK-02 | ✓ (verified reachable during this research session via `npm view`) | 5.7.0 | Hand-rolled Lua pair (no new dependency) |

**Missing dependencies with no fallback:** none identified.
**Missing dependencies with fallback:** `redis-semaphore` (fallback: hand-rolled Lua INCR/DECR+TTL pair, zero new dependency, per D-01's own stated alternative).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (per-workspace `vitest.config.ts`; `apps/worker/vitest.config.ts` is the relevant one for this phase) |
| Config file | `apps/worker/vitest.config.ts` |
| Quick run command | `npm test --workspace=apps/worker -- <path/to/test.ts>` (or `vitest run --root apps/worker <file>`, matching the existing `failure:*` script shape) |
| Full suite command | `npm test --workspace=apps/worker` (plus `npm run failure:all` for the failure-injection suite this phase's fairness scenario joins) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| WRK-01 | `tenant_bucket` deferral uses `moveToDelayed`, never stalls the worker; `provider_backoff` still uses `worker.rateLimit()` | unit | `vitest run --root apps/worker src/queues/__tests__/failure-injection/rate-limit-429.test.ts` (existing, extend) | ✅ existing file, extend |
| WRK-02 | A tenant cannot exceed its configured lane slot share while another tenant has queued work | integration | New: `vitest run --root apps/worker src/queues/__tests__/tenant-concurrency-cap.test.ts` | ❌ Wave 0 |
| WRK-03/04 | Two-tenant fairness: B's throughput ≥~90% of solo baseline while A saturates | failure-injection scenario | New npm script joining `failure:all`, e.g. `failure:tenant-fairness` | ❌ Wave 0 |
| WRK-05/06 | Sweep resumes from checkpoint after kill mid-sweep, no full re-scan | failure-injection (extends existing SIGKILL fixture) | New: `vitest run --root apps/worker src/queues/__tests__/failure-injection/segment-sweep-kill-resume.test.ts` | ❌ Wave 0 (fixture reused from `apps/worker/src/test/failure-fixtures.ts`) |
| WRK-07 | SIGTERM drains in-flight job, closes every Queue handle | unit + manual | New: `vitest run --root apps/worker src/__tests__/graceful-shutdown.test.ts` | ❌ Wave 0 |
| WRK-08 | Every worker (including tick workers) reports errors through the shared listener | unit | New: `vitest run --root apps/worker src/queues/__tests__/shared-error-listener.test.ts` | ❌ Wave 0 |
| WRK-09/11 | Retention is per-queue-parameterized; connection/defaultJobOptions/TTL defined exactly once | static/unit | New: `vitest run --root apps/worker src/queues/__tests__/queue-core-single-definition.test.ts` (grep-style import assertion, mirrors `rollup-enum-migration-invariant.test.ts`'s style) | ❌ Wave 0 |
| WRK-13 | All four remaining tick workers use `upsertJobScheduler`; scheduler registration is idempotent | unit | Extend existing per-worker test files (`partition-maintenance.worker.test.ts` pattern) | ❌ Wave 0 (new assertions in existing-shaped files) |

### Sampling Rate
- **Per task commit:** targeted `vitest run --root apps/worker <changed test file>`
- **Per wave merge:** `npm test --workspace=apps/worker` + `npm run failure:all`
- **Phase gate:** full suite green, including the new fairness scenario in `failure:all`, before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `apps/worker/src/queues/__tests__/tenant-concurrency-cap.test.ts` — covers WRK-02
- [ ] `apps/worker/src/queues/__tests__/failure-injection/segment-sweep-kill-resume.test.ts` — covers WRK-05/06
- [ ] `apps/worker/src/__tests__/graceful-shutdown.test.ts` — covers WRK-07
- [ ] `apps/worker/src/queues/__tests__/shared-error-listener.test.ts` — covers WRK-08
- [ ] `apps/worker/src/queues/__tests__/queue-core-single-definition.test.ts` — covers WRK-09/WRK-11
- [ ] New npm script(s) for the two-tenant fairness load test (WRK-03/04) — see Open Question 2
- [ ] `packages/queue-core` workspace scaffold (package.json, tsconfig, vitest.config.ts) — no test infra exists for a package that doesn't exist yet

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | This phase touches no auth surface. |
| V3 Session Management | no | No session-layer change. |
| V4 Access Control | yes | The sweep's cross-tenant discovery MUST continue to use the Phase 10 `mega_crm_scan` role (`withCrossWorkspaceScan`) exclusively — never a session-flag bypass; the dead-letter table's own access control (platform-ops-scoped, no RLS, mirroring `partition_maintenance_runs`) must not accidentally grant any tenant-facing role SELECT/INSERT. |
| V5 Input Validation | yes | Any new/changed job payload (e.g. a `schemaVersion`-carrying sweep-tick payload) MUST validate via Zod before use, following `sendReconcilerTickJobSchema`'s exact defer-on-mismatch pattern (R-05). |
| V6 Cryptography | no | No new cryptographic material this phase. |
| V7 Error Handling & Logging | yes | Dead-letter payload snapshots MUST go through `@mega-crm/redaction`'s `scrub()` before persisting — this is the exact V7 control ("sensitive data must not appear in logs/error records") applied to a new persistence surface. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Cross-tenant data leak via the sweep's discovery scan being reachable from a normal API-authenticated path | Elevation of Privilege | `SCAN_DATABASE_URL` is declared ONLY in `apps/worker`'s env, never in `apps/api`'s env schema (Phase 10 P3 structural guarantee) — this phase must not introduce any new code path that reads `SCAN_DATABASE_URL` from `apps/api`. |
| Unredacted PII/secret leaking into `dead_letter_jobs` for a webhook/CSV/flow job whose payload contains contact PII or a signed token | Information Disclosure | `scrub()` on every payload snapshot before INSERT (see V7 above); write a test asserting a representative leak payload (email address, bearer token) is censored in the persisted row, mirroring the existing redaction test suite's own assertions in `packages/redaction/src/__tests__/`. |
| A Redis semaphore/lease that leaks (never released) after a worker crash, silently starving a tenant's own future sends forever | Denial of Service | TTL-based lease expiry (whether via `redis-semaphore`'s own `lockTimeout` or a hand-rolled Lua pair's `PEXPIRE`) is the required crash-safety net — an acquire with no TTL is not acceptable regardless of which primitive is chosen (D-01 already states this: "TTL-leased so a crashed worker cannot leak a slot forever"). |

## Sources

### Primary (HIGH confidence)
- This repository's own source files, read in full during this research session (listed under Code Context below) — the phase's dominant evidence base.
- `docs.docker.com/reference/cli/docker/container/stop` (via WebSearch synthesis, cross-checked against 3+ independent secondary sources converging on the same 10s default) — Docker SIGTERM grace period.

### Secondary (MEDIUM confidence — WebFetch/WebSearch of official BullMQ docs, cross-checked)
- `docs.bullmq.io/guide/rate-limiting` (WebFetch, 2026-08-10) — global-per-worker rate limiting, `worker.rateLimit()`/`Worker.RateLimitError()` semantics, group rate-limit removal in v3+.
- `docs.bullmq.io/patterns/process-step-jobs` (WebFetch, 2026-08-10) — `moveToDelayed(timestamp, token)` + `DelayedError` exact code shape.
- `docs.bullmq.io/guide/workers` (WebFetch, 2026-08-10 — partial; page's static excerpt did not surface `worker.close()` prose directly) — Worker event model (`completed`/`failed`/`progress`), stalled-job/lock-renewal mechanics.
- `github.com/animir/node-rate-limiter-flexible/wiki` (WebFetch, 2026-08-10) — full class list, confirmed no concurrency/semaphore primitive.
- `github.com/swarthy/redis-semaphore` + npm registry (`npm view redis-semaphore`, 2026-08-10) — candidate semaphore package, verified `OK` via `gsd-tools query package-legitimacy check`.

### Tertiary (LOW confidence — WebSearch synthesis only, not fetched from a primary page)
- BullMQ dead-letter-queue community pattern (no BullMQ-official DLQ primitive) — WebSearch synthesis only; CONTEXT.md's D-07 locks the Postgres-table answer regardless, so this does not change the plan.
- `github.com/taskforcesh/bullmq/issues/3000` (DelayedError/attempts interaction) — referenced via WebSearch snippet, not independently WebFetched; cross-checked against the `process-step-jobs` doc page's own attempt-exclusion language, which agrees.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every existing library/version is read directly from `package.json`; the one new candidate (`redis-semaphore`) is npm-registry-verified and legitimacy-checked, but not yet integration-tested against this codebase.
- Architecture: HIGH — every pattern this phase needs a precedent for already exists in this repository and was read in full.
- Pitfalls: HIGH for the six codebase-internal gaps (all directly observed via `grep`/file reads); MEDIUM for the BullMQ-external claims (`moveToDelayed`/`DelayedError`/`upsertJobScheduler` semantics), which are WebSearch/WebFetch-sourced against official docs but this environment had no Context7/library-ID resolution available to cross-verify against a second authoritative source.

**Research date:** 2026-08-10
**Valid until:** 30 days (stable BullMQ major version, no fast-moving dependency in this phase's critical path) — re-verify if `bullmq` is bumped to 6.x before this phase executes, since the 6.x major (6.0.9 latest on npm as of this research) has not been checked for API changes to `moveToDelayed`/`upsertJobScheduler`/rate-limiting semantics.
