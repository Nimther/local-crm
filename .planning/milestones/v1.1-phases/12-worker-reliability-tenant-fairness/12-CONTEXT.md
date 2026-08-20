# Phase 12: Worker Reliability & Tenant Fairness - Context

**Gathered:** 2026-08-10
**Status:** Ready for planning

<domain>
## Phase Boundary

One tenant's limits, one oversized segment, or a restart cannot degrade the rest of the platform; background work is bounded, resumable and observable. Covers WRK-01…WRK-11, WRK-13 (см. `.planning/REQUIREMENTS.md`; WRK-12 closed in Phase 8): tenant-scoped rate-limit deferral instead of worker-wide stalls, a per-tenant concurrency cap, a two-tenant fairness load test, a validated `DEFAULT_TENANT_RPS`, a bounded resumable segment sweep, graceful shutdown that closes every Queue handle, unified worker error listeners, per-queue failed-job retention, an observable dead-letter path, a single definition of Redis/queue options, and documented multi-instance-safety assumptions.

**Already locked at ROADMAP level (do not re-litigate):**
- **WRK-01 (Pitfall 4):** `job.moveToDelayed(timestamp, job.token)` + `throw Worker.DelayedError()` ONLY for `cause: "tenant_bucket"`; keep `worker.rateLimit()` + `Worker.RateLimitError()` for `cause: "provider_backoff"` (a genuine worker-wide signal). Phase 11 already shipped the `cause` discriminator on `SendJobResult` at all six `rate_limited` return sites.
- **WRK-05/06:** copy the `recipient-snapshot.ts` / `campaign-kickoff.worker.ts` keyset-pagination pattern (cursor on `contacts.id`, per-page `statement_timeout`), but reset the cursor on successful full completion of each walk — a permanent cursor would silently skip contacts inserted behind it between ticks. Split discovery-and-enqueue from the per-flow bounded walk (mirroring `campaign-scheduler` → `campaign-kickoff`), deterministic `jobId` per flow so a still-running sweep is not double-enqueued. The stale-snapshot anti-join `DELETE` gets the same `LIMIT`-bounded loop treatment.
- **WRK-09/11 (Pitfall 6):** retention is a **per-queue parameter** of the shared queue factory, never one shared constant. `flow-run-advance`'s differentiated policy (`removeOnComplete: true`, `removeOnFail: {age: 86400}`) is a deliberate precedent to preserve. Retention for anything feeding the `reconciling`/dead-letter path must outlive the reconciliation window (~24h) with margin — hours/days, not minutes.
- **WRK-07 (Pitfall 7):** `worker.close()` on SIGTERM is already called and correct; the gap is the *container stop grace period* (owned jointly with Phase 14) — derive and document the drain timeout from SendGrid timeout + transaction margins; do not accept the Docker default unexamined.
- **WRK-13 (Pitfall 8):** BullMQ repeatable-job dedup prevents duplicate *registration*, not duplicate *execution* across instances. Multi-instance worker deployment is out of scope for v1.1 — document the single-instance constraint rather than asserting safety. Prefer `upsertJobScheduler` with a stable scheduler id over the older `tickQueue.add({repeat})` registration path.
- **Deploy-safety contract (R-05):** every changed BullMQ job payload carries an explicit `schemaVersion`.
- **Phase 11 D-15 handshake:** `apps/worker/src/queues/queue-options.ts` was written expressly so WRK-11 *absorbs* it — the three literal copies of `{attempts: 5, backoff: {type: "exponential", delay: 2000}}` (campaign-broadcast-producer.ts, campaign-queues.ts, flow-queues.ts) collapse into imports of those constants.

</domain>

<decisions>
## Implementation Decisions

### Per-tenant concurrency cap (WRK-02 — the roadmap's flagged open decision)

- **D-01:** **Redis semaphore at the application layer.** An acquire/release counter keyed by tenant, held for the duration of the SendGrid dispatch, TTL-leased so a crashed worker cannot leak a slot forever. Over-cap jobs take the SAME `moveToDelayed`/`tenant_bucket` path as WRK-01's rate-limit deferral — one "tenant is over its share" flow, two triggers (RPS bucket, concurrency cap). BullMQ-native per-group concurrency rejected (OSS BullMQ doesn't have it — Pro-only, same story as group rate limiting); bounded per-tier worker pools rejected (coarse, drifts toward the queue-per-tenant topology the stack docs explicitly reject). Exact primitive (rate-limiter-flexible semaphore pattern vs. small INCR/DECR+TTL Lua pair) is planner discretion. — **Reversibility:** costly — the fairness load test (D-04/D-05) and the WRK-01 deferral path are built around the semaphore's acquire-before-dispatch semantics; swapping mechanisms later re-runs the fairness proof.
- **D-02:** **Cap is keyed per lane: tenant + queue** (separate slots in `email-broadcast` and `email-triggered`). A tenant's own big broadcast must not starve their own triggered sends — the Phase 4 two-queue lane-isolation invariant extends *within* a tenant. A tenant-only key was rejected because it recreates, inside one tenant, the exact starvation the two-queue split exists to prevent.
- **D-03:** **Cap values are platform-wide versioned constants with env override** (like `DEFAULT_TENANT_RPS`), one default per lane. No per-tenant DB storage this phase — per-tenant tiers are a billing-era concern; adding an override column later is a cheap additive migration.

### Fairness proof & RPS validation (WRK-03/WRK-04)

- **D-04:** **The two-tenant fairness load test follows the Phase 8 failure-injection pattern:** a scaled-down deterministic two-tenant scenario joins the existing failure-injection CI job (fairness regressions caught on every PR), plus an on-demand full-target-volume npm-script variant. Both run on the fake `ProcessSendJobDeps.sendMail` seam — zero real SendGrid traffic (live verification is Phase 16's job).
- **D-05:** **"Measurably unaffected" = relative-to-baseline assertion:** the same scenario run measures tenant B solo, then B alongside a saturating tenant A; assert B keeps ≥~90% of its own baseline throughput. The exact percentage is a versioned constant with rationale comment (Phase 9 D-12 convention). Absolute throughput floors rejected (machine-dependent, brittle in CI); drain-only assertions rejected (proves a weaker property).
- **D-06:** **`DEFAULT_TENANT_RPS` is backed by both halves:** the on-demand full-scale load-test variant runs at `DEFAULT_TENANT_RPS` proving the pipeline sustains it without backlog growth, AND the constant's rationale comment cites SendGrid's documented guidance with the BYO plan-tier caveat (each tenant's real provider ceiling depends on their own SendGrid plan — the platform can only verify its own half).

### Dead-letter path & observability (WRK-09/WRK-10)

- **D-07:** **The dead-letter mechanism is a Postgres table** (e.g. `dead_letter_jobs`): the shared final-failure listener (WRK-08) writes queue name, job id/name, redacted payload snapshot, error, and timestamps when a job exhausts its attempts. Durable across Redis flush/restart, SQL-queryable, watchdog-alertable. This unblocks WRK-09: with terminal failures durably recorded, Redis failed-set retention can age out freely per queue. For send jobs the `sends` ledger remains the terminal truth — the DLQ's chief value is the non-send lanes (ingest, webhooks, CSV, flow ticks) where a silently-aged-out job is lost data. Redis-based DLQ queue rejected (volatile, invisible to SQL, needs its own retention story). — **Reversibility:** costly — the table becomes the ops contract Phase 15's alerting reads; moving it back into Redis loses the durable history.
- **D-08:** **DLQ observability this phase = extend the existing API-side watchdog + `OPERATOR_ALERT_EMAIL`** (Phase 9 partition-watchdog / Phase 11 reconciler-health precedent, D-14): alert when dead-letter rows appear/accumulate, deduped via `claimAlertSlot`. Phase 15 (OPS-13) re-plumbs the same signal into real alerting; Bull Board stays in Phase 15.

### Segment sweep checkpoint (WRK-05/WRK-06)

- **D-09:** **The sweep's resume checkpoint is a Postgres row per flow, committed in the same transaction as that page's enrollment work.** A kill between pages is exactly resumable by construction; survives Redis flush (the failure-injection harness already tests Redis restart). `job.updateData()` rejected (lost on flush, not atomic with the page's DB work); bare Redis key rejected (volatile, no codebase precedent). Enrollment idempotency (one-active-run guard + re-entry control) makes page-level redo safe anyway — the atomic cursor makes resume exact rather than approximate.

### Shutdown & consolidation (WRK-07/WRK-08/WRK-11/WRK-13)

- **D-10:** **The shared queue factory lives in a new workspace package `packages/queue-core`**, imported by both `apps/worker` and `apps/api` (which creates queues in `campaign-queues.ts` / `imports-csv-queue.ts`): connection-options builder (absorbing `apps/worker/src/queues/connection.ts`), queue/worker factory taking retention as a per-queue parameter, `defaultJobOptions`/TTL constants (absorbing Phase 11's `queue-options.ts`), and the shared error-listener attach helper. Cross-app import from `apps/worker/src` rejected (breaks the app/package boundary); lint-pinned copies rejected (that *is* the WRK-11 violation). — **Reversibility:** reversible — package extraction is mechanical; the constants keep their names.
- **D-11:** Known concrete gaps the scout confirmed, to be closed by the plans: tick `Queue` handles created inside worker factories (`send-reconciler`, `analytics-reconciliation`, `campaign-scheduler`, `partition-maintenance`, `flow-segment-sweep`, `flow-reconciliation`) are never closed on SIGTERM — `WorkerRuntime.close()` closes only `Worker`s; there are NO `worker.on("failed")`/`on("error")` listeners anywhere in `apps/worker`; `removeOnFail: false` (keep forever) is copied verbatim across ~7 queues; four tick registrations still use the older `tickQueue.add({repeat})` path instead of `upsertJobScheduler`.

### Claude's Discretion

- Exact semaphore primitive (rate-limiter-flexible pattern vs. INCR/DECR+TTL Lua), lease TTL, and slot-release placement (`finally` semantics) — subject to D-01's acquire-before-dispatch shape.
- Exact cap values per lane, fairness threshold percentage, load-test volumes/durations — all versioned constants with rationale comments.
- `dead_letter_jobs` schema details (columns, indexes, retention/pruning of the table itself), redaction of payload snapshots via the existing `@mega-crm/redaction` package.
- Sweep checkpoint table schema and page size; stale-snapshot `DELETE` batch size.
- Derived drain-timeout formula and value (must account for `SENDGRID_TIMEOUT_MS` + margins; documented where Phase 14's container stop-grace-period will consume it).
- Error-listener sink this phase (scrubbedConsole with queue/job context is the codebase norm; Phase 15 swaps in Sentry) and the exact attach-helper API.
- `packages/queue-core` internal layout and what, if anything, of the queue-name/payload-schema surface moves there vs. stays in `packages/shared-schemas`.
- Where the multi-instance-safety assumptions document lands (`ARCHITECTURE.md` section vs. standalone doc) — must satisfy WRK-13's "written down".

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements and phase boundaries
- `.planning/ROADMAP.md` § Phase 12 — goal, 5 success criteria, WRK-02 open decision (resolved here as D-01), sequencing/pitfall notes (Pitfalls 4/6/7/8, deploy-safety `schemaVersion`)
- `.planning/REQUIREMENTS.md` — WRK-01…WRK-11, WRK-13 (WRK-12 complete in Phase 8; multi-instance deploy explicitly out of v1.1 scope)
- `.planning/AUDIT-2026-07-27-production-readiness.md` — v1.1 requirements source; worker-reliability findings
- `.planning/research/PITFALLS.md` — Pitfall 4 (worker-scoped rateLimit), Pitfall 6 (per-queue retention), Pitfall 7 (container stop grace), Pitfall 8 (repeatable-job multi-instance)

### Existing worker/queue code (as-is state)
- `apps/worker/src/queues/send-dispatch.ts` — `SendJobResult` with `cause: "tenant_bucket" | "provider_backoff"` at six return sites (Phase 11); the WRK-01 split branches on this
- `apps/worker/src/queues/email-broadcast.worker.ts`, `apps/worker/src/queues/email-triggered.worker.ts` — thin Worker wrappers currently calling `worker.rateLimit()` for BOTH causes (the WRK-01 bug); exported `handleEmailBroadcastJob`/`handleEmailTriggeredJob` processors (testable per Phase 11 pattern)
- `apps/worker/src/queues/queue-options.ts` — Phase 11 D-15 constants (`SEND_LOCK_DURATION_MS`, margins, `SEND_JOB_MAX_ATTEMPTS`, `SEND_JOB_BACKOFF_DELAY_MS`, `SEND_MAX_JOB_LIFETIME_MS`) written to be absorbed by `packages/queue-core` (D-10); its doc comments name the three literal-copy sites WRK-11 collapses
- `apps/worker/src/queues/connection.ts` — `buildRedisConnectionOptions` (`maxRetriesPerRequest: null`), the nominal-type reason each Worker gets plain options, moves into `queue-core`
- `apps/worker/src/queues/rate-limiter.ts` — per-tenant token bucket (rate-limiter-flexible); D-01's semaphore is its sibling
- `apps/worker/src/server.ts` — `buildWorker()` registry of all 15 workers, `WorkerRuntime.close()` (closes Workers but NOT the tick Queues — D-11 gap), SIGTERM/SIGINT wiring, `SCAN_DATABASE_URL` fail-fast (Phase 10 P3 — must stay worker-only)
- `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` — the unbounded sweep WRK-05/06 rewrites (`runFlowSegmentSweepTick` loops all flows, `tickQueue.add({repeat})` registration)
- `apps/worker/src/queues/recipient-snapshot.ts` — the keyset-pagination/short-transaction pattern the sweep copies (with the cursor-reset difference)
- `apps/worker/src/queues/flows/flow-queues.ts` — `flow-run-advance`'s differentiated retention policy (the Pitfall 6 precedent to preserve)
- `apps/api/src/modules/campaigns/campaign-queues.ts`, `apps/api/src/modules/contacts/imports-csv-queue.ts` — API-side queue creation; consumers of `packages/queue-core` (D-10)
- `apps/worker/src/queues/partition-maintenance.worker.ts`, `apps/worker/src/queues/send-reconciler.worker.ts` — `upsertJobScheduler` precedent (WRK-13 target state) + health-row/watchdog pattern D-08 extends
- `packages/shared-schemas` — job payload schemas; `schemaVersion` contract for any changed payloads

### Phase 8/9/10/11 infrastructure this phase builds on
- `.planning/phases/11-delivery-correctness/11-CONTEXT.md` — D-15 (lockDuration/timeout invariant test), D-16 (reconciler cadence), the `SendJobResult` shape contract Phase 12 extends rather than reshapes
- `.planning/phases/08-quality-gates-failure-injection-foundation/08-CONTEXT.md` — failure-injection harness (`packages/test-support`, fake `sendMail` seam, SIGKILL/Redis-restart fixtures) that D-04's scenarios and D-09's kill-resume test extend
- `.planning/phases/09-partition-automation-boundary-safety/09-CONTEXT.md` — versioned-constants convention (D-12), watchdog + `claimAlertSlot` + `OPERATOR_ALERT_EMAIL` pattern D-08 extends
- `.planning/phases/10-tenant-isolation-trust-boundaries/10-CONTEXT.md` — `mega_crm_scan`/`withCrossWorkspaceScan` for the sweep's cross-tenant discovery (adopt, never re-implement)
- `apps/worker/src/queues/__tests__/` + `apps/worker/src/test/failure-fixtures.ts` — existing crash/failure test shapes the new scenarios join

### Documents that MUST be updated in the same change
- `SPECIFICATION.md` — §2 (new `packages/queue-core` workspace), §4 (dead-letter + sweep-checkpoint tables), §5 (retention policies, concurrency cap, drain budget, scheduler migrations), §7 (DLQ watchdog) — per the binding rule in `.claude/CLAUDE.md`
- `ARCHITECTURE.md` — multi-instance-safety assumptions (WRK-13), drain-timeout derivation (WRK-07), tenant-fairness mechanism description
- `CONVENTIONS.md` — if the queue-factory usage becomes a convention (all new queues MUST go through `queue-core`)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`SendJobResult.cause` discriminator** (Phase 11): the WRK-01 split is a branch in two thin Worker wrappers — the classification work is already done.
- **Per-tenant token bucket** (`rate-limiter.ts`, rate-limiter-flexible on ioredis): the D-01 semaphore is architecturally its sibling — same keying, same Redis, same "check before dispatch" call site.
- **Phase 8 failure-injection harness** (`packages/test-support`, fake `sendMail` seam, SIGKILL + Redis-restart fixtures): D-04's fairness scenarios and D-09's kill-resume test are new scenario files on existing machinery.
- **Watchdog stack** (`partition_maintenance_runs`/reconciler health rows, `claimAlertSlot`, API-side checker, `OPERATOR_ALERT_EMAIL`): D-08 adds a third consumer of a twice-proven pattern.
- **`recipient-snapshot.ts` keyset pagination**: the sweep's page loop, with the documented cursor-reset difference.
- **`upsertJobScheduler` precedent** (partition-maintenance, send-reconciler): the WRK-13 target state for the four older tick registrations.
- **`@mega-crm/redaction`**: payload snapshots in `dead_letter_jobs` go through it.

### Established Patterns
- Versioned constants with rationale comments (Phase 9 D-12) — cap values, fairness threshold, drain budget, retention ages all follow it.
- Workspace packages for cross-app single-definition concerns (`delivery-core`, `tenant-context`, `redaction`) — `queue-core` (D-10) is the same move.
- Exported standalone processors (`handleEmailBroadcastJob` etc.) so behavior is testable without live Workers/timers.
- `schemaVersion` on changed job payloads; worker defers unrecognized versions (R-05).
- Phase-branch → PR with blocking `static`/`test`/`failure-injection` CI checks — new scenarios join the failure-injection job.

### Integration Points
- `apps/worker/src/server.ts` — `WorkerRuntime.close()` extended to close tick Queues; factories migrate to `queue-core`.
- Both send-worker wrappers — the WRK-01 `moveToDelayed` branch and the D-01 semaphore acquire.
- `packages/db/migrations/` — `dead_letter_jobs` + sweep-checkpoint tables (additive; RLS posture decided by planner consistent with Phase 10's fail-closed convention — note the DLQ table is platform-ops-scoped, not tenant-scoped, like `partition_maintenance_runs`).
- `apps/api` watchdog module — DLQ check joins the partition + reconciler checks.
- `apps/api` queue modules — swap to `queue-core` factory imports.
- CI `failure-injection` job — fairness scenario registration.

</code_context>

<specifics>
## Specific Ideas

- **One deferral flow, two triggers:** over-RPS and over-concurrency both route through the same `tenant_bucket`/`moveToDelayed` path — the worker never stalls wholesale for a tenant-scoped reason; only genuine provider backpressure (`provider_backoff`) may pause a worker.
- **Fairness is proven relative to self:** tenant B is compared against its own solo baseline inside the same run — no absolute numbers that rot with hardware.
- **The DLQ protects the lanes without a ledger:** send jobs already have `sends` as terminal truth; the dead-letter table exists chiefly so ingest/webhook/CSV/flow jobs can't vanish silently once retention starts aging the Redis failed set.

</specifics>

<deferred>
## Deferred Ideas

- **Per-tenant concurrency-cap DB overrides / tiered plans** — billing-era concern; additive migration later (D-03).
- **Bull Board wiring and real alerting on queue depth / DLQ age** — Phase 15 (OPS-13); this phase ships the interim watchdog email only (D-08).
- **BullMQ Pro migration for native group rate-limit/concurrency** — the stack docs' standing "revisit at scale" note; the D-01 semaphore is the OSS answer until operational friction proves otherwise.
- **Multi-instance worker deployment** — explicitly out of v1.1 scope; WRK-13 documents the single-instance constraint instead.

</deferred>

---

*Phase: 12-worker-reliability-tenant-fairness*
*Context gathered: 2026-08-10*
