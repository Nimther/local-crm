# Phase 11: Delivery Correctness - Context

**Gathered:** 2026-08-09
**Status:** Ready for planning

<domain>
## Phase Boundary

No email is lost, duplicated, or wrongly classified when SendGrid is slow, when SendGrid returns an ambiguous result, or when the process dies mid-send. Covers DLV-01…DLV-09 (см. `.planning/REQUIREMENTS.md`): the formal delivery state machine with `reconciling` (and, per this discussion, terminal `unknown`), a classification-only reconciler, an explicit SendGrid timeout with abort, a deterministic idempotency key, a documented delivery model, crash tests at the three boundaries, and a send-duration metric.

**Already locked at ROADMAP level (do not re-litigate):**
- Reconciler claims rows via `SELECT … FOR UPDATE SKIP LOCKED` inside `withTenantTransaction`; the retry path never calls SendGrid for a `reconciling` row (Pitfall 1). DLV-08's crash tests include the reconciler-and-retry-worker three-way race.
- Correlation is by `send_id` only (`custom_args.send_id`, already on every request and read back by `webhook-events.worker.ts`); never re-derive by heuristics.
- `ALTER TYPE send_status ADD VALUE` ships as its own standalone migration, applied before the code that references it (DB-08; Phase 8's migration linter enforces this). No historical-row backfill in the same migration; `workspace_daily_rollup` historical totals must be unchanged after migration (Pitfall 2). A read-only audit of production-shaped `sends` history runs before the migration is written.
- `AbortController` timeout strictly below BullMQ `lockDuration` with margin for the claim and terminal-write transactions (Pitfall 5).
- No second outbox table — `sends` IS the outbox. Add `reconciling_since timestamptz` (do not overload `queued_at`; Phase 15's webhook-lag alert queries `reconciling_since`).
- The `interrupted` branch stops incrementing `failed_count`/rollup counters; the reconciler owns an idempotent "resolve → terminal, backfill counters once" path (a naive `applyEventSideEffects` re-run will not fire — `setFactColumnOnce`'s `justSet` gate already consumed the fact).
- Reconciler's cross-tenant discovery uses Phase 10's `mega_crm_scan` role through the `withCrossWorkspaceScan` helper (10-CONTEXT D-01/D-02) — this phase adopts, never re-implements, that entry point.
- Every changed BullMQ job payload carries an explicit `schemaVersion`; the worker defers payload versions it does not recognize (ROADMAP § Sequencing Decisions, R-05).
- The state machine is a reviewed design artifact BEFORE `send-dispatch.ts` is touched (DLV-01 is a design deliverable).
- Crash tests build on the existing Phase 8 harness seam `ProcessSendJobDeps.sendMail` — scenarios are added, no new seam.

</domain>

<decisions>
## Implementation Decisions

### Reconciler verdict model (DLV-03/DLV-07)

- **D-01:** **Classification-only reconciler (strict at-most-once).** The reconciler resolves `reconciling` rows to a terminal state and NEVER calls SendGrid. Lost-but-unproven mail is accepted as the cost of guaranteed no-duplicates. The documented delivery model (DLV-07): at-most-once at the acceptance boundary, effectively-once across retries before acceptance. — **Reversibility:** costly — the reconciler's concurrency proof (DLV-04), the crash-test matrix, and the DLV-07 document all assume a non-sending reconciler; adding re-dispatch later means re-running the pre-send gate design and re-proving the race matrix.
- **D-02:** **No-evidence terminal state is a new enum value `unknown`.** Honest terminal state (PROJECT.md's own vocabulary: "state machine с `unknown`/`reconciling`"). Its own standalone migration under the same DB-08 expand/contract rule as `reconciling`. — **Reversibility:** one-way — Postgres enum values cannot be dropped without a type rebuild; the value becomes part of the published send-status contract read by send log, rollups, and Phase 13.
- **D-03:** **The reconciler is the sole writer of every `reconciling → terminal` transition.** The webhook worker keeps recording evidence (fact columns / `send_events`) exactly as today and never touches `status`. One audited function may leave `reconciling`.
- **D-04:** **Late evidence on a terminal `unknown` row is handled by bounded re-scan:** each tick the reconciler also re-examines `unknown` rows younger than a bounded horizon (~72h, SendGrid's full deferral cycle) and upgrades `unknown → sent` when evidence appears — same single writer, same idempotent counter-backfill path. `unknown` becomes fully immutable only after the horizon passes; the DLV-07 doc states this explicitly.

### Evidence source & resolution windows (DLV-03)

- **D-05:** **Webhook evidence only.** The reconciler resolves from `send_events`/fact columns correlated by `send_id` and makes NO provider API calls. SendGrid Email Activity API rejected: it is a paid per-account add-on the platform cannot assume under BYO keys, and it is heavily rate-limited. The reconciler is a pure Postgres reader.
- **D-06:** **The auto-provisioned webhook subscription gains SendGrid's `processed` event** as the primary acceptance evidence (arrives within seconds of acceptance; proves "SendGrid accepted" directly). `deferred` is NOT added (fires repeatedly per message, volume multiplier for marginal proof). Existing tenants are updated through the Phase 5 provisioning/Reconnect machinery. ~1 extra `send_events` row per send; partitioned monthly, storage managed. — **Reversibility:** reversible — removing the event type from the provisioned config is a config change; ingested rows age out with partitions.
- **D-07:** **Resolution window ~24h** (`reconciling` with no evidence → `unknown`), **re-scan horizon ~72h**. Both are versioned constants in code with rationale comments (Phase 9 D-12 convention — changes must be visible in a diff), exact values tunable by the planner.
- **D-08:** **The reconciler also sweeps stale `dispatching` orphans:** rows older than a generous age threshold (well above max job lifetime including all retries) transition `dispatching → reconciling` and resolve through the normal evidence path. No row can be stuck forever regardless of what Redis lost; historical pre-Phase-11 orphans are adopted the same way. The DLV-01 matrix records two writers for `dispatching → reconciling`: the worker (ambiguous outcome / interrupted redelivery) and the reconciler (stale-age sweep).

### Idempotency key & claim lifecycle (DLV-05/DLV-06)

- **D-09:** **`sends.id` becomes deterministic — UUIDv5 derived from the send intent** (workspace+campaign+contact for campaign sends; workspace+flowRun+node for flow sends; namespace constant at planner's discretion). The existing release/re-claim flow survives, but every re-claim reproduces the SAME id, so webhook events from any prior (phantom-accepted) attempt always correlate to the live row. — **Reversibility:** costly — the id becomes the cross-attempt correlation contract embedded in `custom_args` of every outbound message; reverting to random ids reopens the orphaned-phantom-event hole.
- **D-10:** **Outcome classification (user-specified, verbatim intent):**
  - Timeout and connection reset where the request body MAY have been sent → ambiguous → `reconciling`.
  - Provably pre-connection errors (DNS failure, connection refused — the request could not have left) → retryable.
  - HTTP 429 / 5xx → release claim + **bounded exponential retry** (a deliberate change from today's unbounded `Retry-After`-driven backoff).
  - Permanent 4xx → `failed`, no retry.
  - **Fail-closed default:** if the transport layer cannot prove whether bytes were sent → `reconciling`.
- **D-11:** **Test sends (`kind='test'`) stay entirely outside the delivery ledger, reconciliation, and analytics.** DLV-07's guarantees apply to campaign/flow sends only. No automatic retry for test sends. The test-send response contract gains a third outcome: a definite HTTP error is shown as a plain error; a timeout/reset without a definitive response is shown as **"outcome unknown — check the inbox before manually re-sending"**.

### Campaign lifecycle & visibility

- **D-12:** **`reconciling`/`unknown` count toward campaign completion.** A campaign reaches `sent` once dispatch is finished; the reconciler backfills `sent_count`/`failed_count` idempotently as rows resolve. `incrementCampaignSendCounter`'s `WHERE status='sending'` guard gains an explicit reconciler-backfill path (post-completion increments allowed only through the reconciler's idempotent resolution). No 24h campaign hangs on a single ambiguous send.
- **D-13:** **Minimal-honest visibility in this phase:** the send log shows and filters the new statuses (status column already exists); daily rollups EXCLUDE `unknown` from sent/failed counts (documented); campaign-card `unknown` stats and dashboard treatment are deferred to Phases 13/15 where those surfaces are being reworked anyway.
- **D-14:** **Interim stuck-reconciler alerting reuses the Phase 9 machinery:** the reconciler writes a health row; the existing API-side watchdog + `OPERATOR_ALERT_EMAIL` channel alerts when ticks stop or `reconciling` rows age past threshold. Phase 15 (OPS-13) re-plumbs the same signal into real alerting via `reconciling_since`.

### Timeout & operational parameters (DLV-06/DLV-09)

- **D-15:** **Explicit `lockDuration` (~60s) and SendGrid `AbortController` timeout (~20s), with a test asserting `timeout + transaction margin < lockDuration`.** Today the workers ride BullMQ's implicit 30s default and `sendTenantMailV3` has no timeout at all — the invariant must be visible, versioned configuration, not a library default. Written so Phase 12's WRK-11 (single definition of queue options) absorbs rather than duplicates it. Exact numbers are planner-tunable versioned constants.
- **D-16:** **Reconciler cadence ~5 min:** repeatable BullMQ tick (`upsertJobScheduler`, stable scheduler id per the WRK-13 note), bounded batch per tick (bound at planner's discretion). Discovery via scan role, then per-tenant claims.
- **D-17:** **Send duration lives on `sends`:** `dispatched_at` (call start) + `dispatch_duration_ms`, written in the terminal/ambiguous-write transaction. SQL-queryable immediately (satisfies DLV-09 before any metrics infra exists); doubles as forensics for the stale-`dispatching` sweep and crash-test assertions; Phase 15 exports it.
- **D-18:** **The DLV-01 state machine + DLV-07 delivery model live as an `ARCHITECTURE.md` section** (mermaid state diagram + per-transition writer matrix), committed and reviewed BEFORE `send-dispatch.ts` changes. `SPECIFICATION.md` receives the factual entries (§4 schema, §5 queues/reconciler, §7 alerting) in the same change per the binding update rule.

### Claude's Discretion

- UUIDv5 namespace constant and helper location; exact key-composition strings.
- Exact timeout/lockDuration/window/horizon/cadence numbers within the decided orders of magnitude — all as versioned constants with rationale comments.
- Reconciler batch bound per tick; stale-`dispatching` age threshold (must exceed max job lifetime incl. retries with margin).
- Bounded-exponential-retry parameters for 429/5xx (attempts cap, base/max delay) and how they interact with the existing `worker.rateLimit()` signal.
- Shape of the transport-layer classification (how undici/fetch errors are mapped to "pre-connection" vs "possibly sent") and its unit-test fixtures.
- Reconciler health-row schema (may mirror `partition_maintenance_runs`) and watchdog threshold.
- Whether `SendJobResult` gains new outcome variants now (e.g. `ambiguous`) — note Phase 12 will split `cause: "tenant_bucket" | "provider_backoff"`; design the shape so Phase 12 extends rather than reshapes it.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements and phase boundaries
- `.planning/ROADMAP.md` § Phase 11 — goal, 5 success criteria, sequencing/pitfall notes (Pitfalls 1/2/5, no-second-outbox, correlation-by-send_id, deploy-safety `schemaVersion` contract)
- `.planning/REQUIREMENTS.md` — DLV-01…DLV-09
- `.planning/AUDIT-2026-07-27-production-readiness.md` — v1.1 requirements source; delivery-correctness findings
- `.planning/research/PITFALLS.md` — Pitfall 1 (reconciler exclusive claim), Pitfall 2 (enum migration / no backfill), Pitfall 5 (timeout below lockDuration)

### Existing send-pipeline code (as-is state)
- `apps/worker/src/queues/send-dispatch.ts` — `processSendJob`, three-unit discipline (claim tx → SendGrid call → record tx), `ProcessSendJobDeps.sendMail` seam, `SendJobResult`, the `interrupted` branch this phase rewrites (currently records `failed`), `parseRetryAfter`
- `packages/delivery-core/src/send-ledger.ts` — `dispatchSendGate`/`claimFlowSend` (interrupted detection), `releaseDispatchClaim` (**deletes** the row — intersects D-09), `recordSendResult`/`recordFlowStepResult`, `recordExcluded` status guards, `incrementCampaignSendCounter` (`WHERE status='sending'` — D-12 target), `tryCompleteCampaign` (completion formula — D-12 target)
- `packages/delivery-core/src/send-mail.ts` — `sendTenantMailV3` (bare fetch, no timeout — D-15 target), `buildMailSendRequest` (`custom_args.send_id` correlation), `redactApiKey`
- `packages/db/src/schema/sends.ts` — `send_status` enum (`dispatching|sent|failed|excluded`), unique intent constraints (campaign triple + flow partial index), fact columns
- `apps/worker/src/queues/webhook-events.worker.ts` — `setFactColumnOnce` first-write gate, `applyEventSideEffects`, send_id correlation readback; D-06's `processed` ingestion lands here
- `apps/worker/src/queues/email-broadcast.worker.ts`, `apps/worker/src/queues/email-triggered.worker.ts` — thin Worker wrappers (`worker.rateLimit()` on `rate_limited`); lockDuration config lands here
- `apps/api/src/modules/tenancy/` webhook auto-provisioning + Reconnect (Phase 5) — mechanism for D-06's event-type addition
- `packages/shared-schemas` — job payload schemas gaining `schemaVersion`

### Phase 8/9/10 infrastructure this phase builds on
- `.planning/phases/10-tenant-isolation-trust-boundaries/10-CONTEXT.md` — D-01/D-02: `mega_crm_scan` role + `withCrossWorkspaceScan` helper in `packages/tenant-context` (the reconciler's discovery entry point)
- `.planning/phases/08-quality-gates-failure-injection-foundation/08-CONTEXT.md` — failure-injection harness (D-21…D-24: five scenarios, SIGKILL via IPC-frozen `sendMail`, `packages/test-support` harness entrypoint), migration linter (D-30: enum-value-use-in-same-file rule built expressly for this phase)
- `.planning/phases/09-partition-automation-boundary-safety/09-CONTEXT.md` — repeatable-tick + health-row + API-watchdog + `OPERATOR_ALERT_EMAIL` pattern (D-14 reuses); versioned-constants convention (D-12)
- `apps/worker/src/queues/partition-maintenance.worker.ts` — `upsertJobScheduler` precedent for D-16
- `apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts`, `send-dispatch-idempotency.test.ts` — existing crash/idempotency test shapes the DLV-08 suite extends

### Documents that MUST be updated in the same change
- `ARCHITECTURE.md` — new state-machine section (D-18) reviewed before code; mermaid diagram + writer matrix + delivery model
- `SPECIFICATION.md` — §4 (enum values, `reconciling_since`, `dispatched_at`/`dispatch_duration_ms`, UUIDv5 ids), §5 (reconciler queue/tick, retry-policy change), §6 (webhook event-type addition), §7 (reconciler health/alerting) — per the binding rule in `.claude/CLAUDE.md`
- `CONVENTIONS.md` — if the transport-classification or schemaVersion patterns become conventions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Three-unit dispatch discipline** (`send-dispatch.ts`): claim tx → provider call → record tx is already correct; this phase changes classifications at the boundaries, not the architecture.
- **`dispatchSendGate`/`claimFlowSend` interrupted detection**: the exact hook where `dispatching → reconciling` (instead of → `failed`) is written for the redelivery path.
- **`ProcessSendJobDeps.sendMail` seam + Phase 8 harness**: all DLV-08 crash scenarios (including the three-way reconciler/retry race) are new scenario files on the existing seam and `packages/test-support` fixtures.
- **Phase 9 watchdog stack** (`partition_maintenance_runs`, `claimAlertSlot`, API-side checker, plain-text operator email): the template for D-14's reconciler health monitoring.
- **`withCrossWorkspaceScan` + `mega_crm_scan`** (Phase 10): ready-made audited cross-tenant discovery for the reconciler; the phase adds a consumer, not a mechanism.
- **`setFactColumnOnce` first-write-only fact columns**: evidence storage is already idempotent and out-of-order-safe; `processed` ingestion follows the same shape.
- **Migration linter enum rule** (Phase 8 D-30): purpose-built to force `reconciling`/`unknown` into standalone migrations.

### Established Patterns
- Versioned constants with rationale comments and plan-number references (Phase 9 D-12) — all new timing values follow it.
- Hand-written SQL migrations for what Drizzle can't express; expand/contract discipline (DB-08).
- `SET LOCAL`/`set_config(..., true)` only; scan access exclusively through the Phase 10 helper.
- Phase-branch → PR workflow with blocking CI (`static`/`test`/`failure-injection` required checks) — the new crash scenarios join the `failure-injection` job.

### Integration Points
- `packages/db/migrations/` — two standalone enum migrations (`reconciling`, `unknown`) + additive columns migration (`reconciling_since`, `dispatched_at`, `dispatch_duration_ms`), each ordered before dependent code deploys.
- `apps/worker/src/server.ts` — reconciler worker/tick registration (same registry as all workers).
- `apps/worker/src/queues/` — new `send-reconciler.worker.ts` (name at planner's discretion) alongside the existing tick family.
- `apps/api` watchdog — extend the Phase 9 checker to read the reconciler health row.
- `apps/web` send log — status filter vocabulary gains `reconciling`/`unknown` (minimal-honest, D-13).
- Test-send API route/UI — third outcome variant ("outcome unknown", D-11).

</code_context>

<specifics>
## Specific Ideas

- **Fail-closed ambiguity as a principle (user's own formulation):** "если транспортный слой не позволяет доказать, были ли отправлены байты, безопасный default — `reconciling`" — when in doubt about whether the request left the process, classify ambiguous, never retry. This is the load-bearing rule for the transport-error mapping.
- **One writer per transition, written down:** the DLV-01 artifact is a matrix — every transition names its writer(s), and the only transition with two writers is `dispatching → reconciling` (worker + reconciler stale-sweep), explicitly.
- **Bounded, not unbounded, retries:** the user explicitly tightened 429/5xx handling to bounded exponential retry — today's unbounded `Retry-After` loop is not to be preserved.
- **The test-send UX must tell the truth:** "outcome unknown — check the inbox before manually re-sending" — the ambiguity concept surfaces even where the ledger doesn't reach.

</specifics>

<deferred>
## Deferred Ideas

- **Operator/marketer re-send tooling for lost-but-unproven sends** (recovery UI/CLI for `unknown` rows) — recovery stays a documented manual action; tooling belongs to a future phase.
- **`deferred` event ingestion** — revisit only if `processed`+delivered/bounced evidence proves insufficient in practice.
- **Campaign-card `unknown` stat / dashboard treatment** — Phase 13 (rollup semantics) and Phase 15 (frontend states) own those surfaces (D-13).
- **Real alerting on `reconciling_since` age** — Phase 15 (OPS-13); this phase ships the interim email channel only (D-14).
- **`SendJobResult` cause split (`tenant_bucket` vs `provider_backoff`)** — Phase 12 (WRK-01); this phase only avoids shapes that would force a Phase 12 rewrite.

</deferred>

---

*Phase: 11-delivery-correctness*
*Context gathered: 2026-08-09*
