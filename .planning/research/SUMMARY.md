# Project Research Summary

**Project:** Mega CRM — Multi-tenant B2C Email Marketing Automation
**Milestone:** v1.1 Production Hardening
**Domain:** Operational/reliability hardening of an existing, shipped SaaS multi-tenant platform
**Researched:** 2026-07-27
**Confidence:** HIGH (operational findings grounded in current codebase + first-party docs); MEDIUM (vendor-comparative claims, tested only against 2–3 sources)

---

## Executive Summary

Mega CRM v1.0 shipped a functionally complete multi-tenant email marketing platform with solid architectural foundations (Fastify + Drizzle RLS + BullMQ + SendGrid BYO keys). **v1.1's mission is not to build new features — it's to harden a live system handling hundreds of thousands of sends/day to production-trust levels**, validated through an external audit (`.planning/AUDIT-2026-07-27-production-readiness.md`).

The audit identified seven work areas spanning delivery correctness, security isolation, compliance analytics, and operational visibility. **Research across four parallel agents reveals a critical insight: the audit is technically sound but code-review-biased — it identifies *code* problems correctly but misses nine operational/architectural gaps that mature ESPs handle routinely but were invisible to a code-only review.** Most critical among these gaps: Redis persistence/eviction policy is infrastructure, not app code, yet every worker-reliability fix is void without it; the `sg_event_id` dedup assumes a stability SendGrid itself doesn't guarantee; and idempotency semantics must be retroactively analyzed against existing production data before any state-machine changes ship.

**The roadmap's three critical sequencing constraints:**

1. **Hard external deadline (2026-09-01)**: partition automation must ship before this date or production will silently collect rows in DEFAULT partitions, making every future monthly partition attachment a full-table scan under exclusive lock on the live events table. This work must run early and independently of all other tracks.
2. **Failure-injection test harness before delivery-state-machine changes**: the audit calls for crash-scenario testing (§3.2, §10), but adding a `reconciling` state without a harness to prove the new state transitions correctly under concurrent reconciler/retry workers reintroduces the exact duplicate-send bug being fixed. Test infrastructure is a hard blocker for delivery correctness.
3. **Deployment strategy before send-pipeline rollout**: rolling-deploy workers running two different code versions against the same queue is the recipe for race conditions on send claims. Deployment definition must precede or run parallel to the send-pipeline changes, or those changes must explicitly design for backward-compatible queued-job payloads.

**Overall approach:** leverage existing patterns (repeatable jobs, keyset pagination, claim transactions) that v1.0 already uses successfully three or more times; avoid introducing new operational dependencies (no `pg_partman` extension, no separate scheduler component); keep observability additive on top of existing AsyncLocalStorage correlation-ID plumbing. The milestone ships hardening, not rewrites.

---

## Key Findings

### Recommended Stack (v1.1 Hardening Scope)

Stack research covers only *new* operational capability for this milestone — the v1.0 core (Fastify, Drizzle, BullMQ, React) remains valid and is **not** re-researched. v1.1 additions:

**CI & Code Quality:** GitHub Actions + ESLint 10 flat config + `typescript-eslint` 8.65.0 (single linter ecosystem); coverage via `@vitest/coverage-v8`, kept in lockstep with the installed `vitest@4.1.9`.

**Docker Deployment:** `node:22-alpine` base + multi-stage Dockerfile (prune workspace dependencies per-image). Caddy 2 for TLS termination + health-check-gated rolling restarts. Docker Compose (extend existing). Advisory-lock migration gate via the `pg` pool (no new package).

**Observability:** Sentry (`@sentry/node@10.68.0`, `@sentry/react@10.68.0`) for exceptions — note there is **no separate `@sentry/fastify` package**; Fastify integration ships inside `@sentry/node` via `setupFastifyErrorHandler`. Better Stack (`@logtail/pino@0.5.8`) for hosted logs/alerts. OpenTelemetry SDK (minimal: `@opentelemetry/sdk-node` + app-specific instrumentations) for trace correlation, bridged to BullMQ via `bullmq-otel@2.0.0` — BullMQ has shipped native OTel telemetry since v5.71 and the project is already on 5.79.1.

**Partition Maintenance:** New BullMQ repeatable job (`partition-maintenance.worker.ts`, daily tick) creating 2–3 months of future partitions. Not `pg_partman` — avoids a custom Postgres image, an extension dependency, and a second scheduling paradigm.

**Backup & PITR:** pgBackRest (system binary, sidecar container). WAL archiving to local disk minimum, S3-compatible offsite recommended. `pg_dump` + cron is ruled out outright — it cannot do PITR, which the audit explicitly requires.

**Testing:** `@testcontainers/postgresql` and `@testcontainers/redis` (v12.0.4) for ephemeral test databases. `undici` MockAgent for raw `fetch()` testing — **not** `nock`, which has a documented compatibility gap with global fetch.

**Rate Limiting:** `@fastify/rate-limit` (already installed) with an `ioredis` Redis store (already present). **Zero new packages.** Explicitly do not reuse `rate-limiter-flexible` for this — it is already scoped to per-tenant SendGrid throttling in the worker.

### Expected Features (Operational Capabilities)

v1.1's features are operational, not product. Research defines 12 table stakes, 5 differentiators, and 5 anti-features.

**Table Stakes (must land in v1.1):**
- Delivery state machine with `unknown`/`reconciling` — resolvable outcomes, not failed assumptions
- Deterministic idempotency key (intent-derived, not random per attempt)
- Reconciliation job for unknown sends + webhook-downtime backfill
- Per-tenant rate limiting **and** per-tenant concurrency cap (distinct problems)
- Redis `maxmemory-policy=noeviction` + AOF (infrastructure prerequisite)
- Atomic unsubscribe event (subscription status + consent history + send updated atomically)
- Graceful worker shutdown on SIGTERM
- Expand/contract migration discipline

**Nine Audit-Missed Gaps (critical, must land):**

1. `sg_event_id` is **not** reliably stable across SendGrid webhook retries (confirmed via a first-party SendGrid GitHub issue, despite SendGrid's own docs implying otherwise) — dedup needs a compound-key fallback
2. Redis configuration absent from the audit — `maxmemory-policy` is load-bearing for every worker-reliability fix
3. SendGrid has **no native idempotency key** (unlike Resend/Stripe) — dedup is 100% the application's responsibility
4. Idempotency key must be derived from send *intent* (campaign/flow-step + contact + generation), not a random UUID per attempt
5. Webhook-endpoint-downtime backfill — reconciliation for events missed while the endpoint was down
6. Per-tenant concurrency fairness under backlog — independent from RPS throttling; a correct token bucket still lets one tenant's large backlog occupy worker slots ahead of another tenant's small batch
7. Sender-reputation monitoring (Gmail/Yahoo bulk-sender rules, 0.1–0.3% spam-complaint threshold, effective since Feb 2024) — the platform already ingests the bounce/complaint data needed for a cheap per-tenant alert
8. Metrics reconciliation as a recurring job, not a one-time fix
9. Expand/contract named as the concrete migration technique, not just the intent

### Architecture Approach (Integration into Shipped System)

Every recommendation is grounded in the actual v1.0 codebase (~57k LOC). Surgical hardening of patterns already working.

**Key assets to leverage:** the three-step send dispatch (claim → SendGrid → write), repeatable jobs for scheduled work, keyset pagination + cursor for bounded scans, AsyncLocalStorage context for correlation, claim transactions for safety.

Notably, the `sends` table's claim-before-SendGrid-call pattern (`dispatchSendGate`/`claimFlowSend` in `packages/delivery-core/src/send-ledger.ts`) **already is a transactional outbox** — no new outbox table is needed. The correlation ID the audit asks for **already exists** (`custom_args.send_id`, read back by the webhook processor). The fix is narrower than the audit implies: add a `reconciling` enum value, change the `interrupted` branch in `send-dispatch.ts`/`flow-send.ts` to stop guessing `failed`, and add a repeatable reconciler mirroring the existing `flow-reconciliation.worker.ts` shape.

Similarly, `recipient-snapshot.ts`/`campaign-kickoff.worker.ts` already implement the exact keyset-pagination + checkpoint pattern the segment sweep needs — bounded background processing is a "copy an existing pattern" task, not a new architecture problem.

**Three critical architectural decisions for v1.1:**

1. **Delivery state machine** — `reconciling` as a first-class state, design-reviewed before coding, crash tests covering the reconciler-vs-retry race
2. **Postgres role separation** — three roles (`mega_crm_app`, `mega_crm_auth`, `mega_crm_admin_scan`) with role-scoped RLS policies (`CREATE POLICY ... TO role`) replacing the GUC-only `app.admin_scan` pattern; separate pools vs `SET LOCAL ROLE` remains open
3. **Better Auth trust boundary** — RLS vs. separate role (explicitly open per PROJECT.md; adding RLS without design breaks login)

### Critical Pitfalls to Avoid

**Pitfall 1 — Reconciling reintroduces duplicates via concurrent writers.** Unless reconciliation claims the row (`SELECT ... FOR UPDATE`) before resolving, and retry logic never re-calls SendGrid for unknown states, the fix recreates the duplicate-send bug one layer up.

**Pitfall 3 — Rolling deploy with two code versions racing.** Old code's claim definitions diverge from new code's; both pass their own checks, both call SendGrid. Requires stop-old-then-start-new, or backward-compatible job payloads with a `schemaVersion` field.

**Pitfall 11 — RLS policy unification flips fail-closed tables to fail-open.** Unifying the two variants (bare-cast vs `NULLIF`-guard) *toward* `NULLIF` makes `events`/`sends`/`contacts` silently return zero rows when the GUC is unset, instead of throwing. **The safe direction is bare-cast** — the opposite of what the audit's phrasing suggests, and the audit's own recommended test ("query without tenant context") is designed to catch exactly this.

**Pitfall 13 — DEFAULT partition exclusive-lock on attach.** Hard deadline 2026-09-01. Once any row lands in DEFAULT, every future `ATTACH PARTITION` scans DEFAULT under `ACCESS EXCLUSIVE` lock (ingestion outage) unless a CHECK-constraint workaround is applied first.

**Pitfall 20 — Redis eviction policy omitted from the audit.** BullMQ's own docs name `maxmemory-policy=noeviction` as the single setting that guarantees correct queue behavior. Any eviction policy silently loses jobs.

**Additional high-stakes item:** Sentry has **no retroactive redaction** (confirmed via Sentry's own issue tracker). This system's two most sensitive values — decrypted tenant SendGrid keys and contact PII in freeform JSONB — are not covered by Sentry's default scrubbing. A redaction miss is a compliance incident, not a bug.

---

## Implications for Roadmap

### Suggested Phase Structure (Seven Stages)

**Stage 1 — Test Infrastructure Foundation.** CI, lint/coverage, isolated Playwright DB, migration gate, failure-injection harness. Blocks Stage 3. Delivers a working CI gate, Dockerfiles, migration-gate script, crash-scenario harness. Research flags: failure-injection design for SendGrid timeout + process SIGKILL + concurrent claim races. The existing `ProcessSendJobDeps.sendMail` seam is the natural injection point.

**Stage 2 — Partition Maintenance (HARD DEADLINE 2026-09-01).** Partition-creation repeatable job, monitoring for next-partition presence, DEFAULT-evacuation procedure. Independent track, runs in parallel with Stage 1. Avoids Pitfall 13.

**Stage 3 — Delivery Correctness: State Machine + Timeout.** `reconciling` state, `interrupted`-branch handling, `AbortController` timeout, failure-injection tests. Depends on Stage 1. Blocks Stage 4. Avoids Pitfalls 1 and 5.

**Stage 4 — Tenant-Fair Throttling.** `job.moveToDelayed` for tenant-bucket exhaustion, split `SendJobResult` with a `cause: "tenant_bucket" | "provider_backoff"` field, per-tenant concurrency cap. Touches the same files as Stage 3.

**Stage 5 — Postgres Role Separation.** Create admin-scan and auth roles, narrow policies, decide the auth trust boundary. Prerequisite for Stage 6.

**Stage 6 — Bounded Background Processing + Reconciler.** Segment-sweep keyset pagination + child workers, `send-reconciliation.worker.ts` cross-tenant scan. Depends on Stage 5. Completes Stage 3.

**Stage 7 — Observability Wiring + Deployment Strategy.** Correlation IDs in logs/Sentry, worker Pino logger, Docker automation, graceful shutdown, runbooks, expand/contract migration discipline, frontend code splitting.

### Cross-Cutting Sequencing Dependencies

**Hard dependencies:**
1. Failure-injection (Stage 1) → Delivery state machine (Stage 3)
2. Partition automation (Stage 2) → independent, external deadline
3. State machine (Stage 3) → Tenant-fair throttling (Stage 4) — same files
4. Role separation (Stage 5) → Background scans (Stage 6)
5. State machine (Stage 3) → Reconciliation (Stage 6)
6. Deploy strategy (Stage 7) → send-pipeline rollout (Stages 3–5), **or** Stages 3–5 must ship backward-compatible job payloads

**Additional prerequisites surfaced by research:**
- The worker currently logs via `console.log` only — it needs a real Pino logger **before** hosted-logs/Sentry/OTel work is meaningful. Small but load-bearing.
- `/healthz` and `/readyz` are a hard prerequisite for the recommended health-check-gated rolling-restart pattern — sequence health endpoints *before* deployment automation, not alongside it.
- If PgBouncer is introduced, it must be designed together with the migration-gate advisory-lock pattern — advisory locks break under transaction-mode pooling.

### Research Flags

**Need deeper research or a human decision:** idempotency key derivation (exact hashing strategy), reconciliation SLA tuning (webhook latency P95), Better Auth trust boundary, per-tenant concurrency-cap mechanism, horizontal worker scaling scope, `AbortSignal.timeout` value for SendGrid requests.

**Standard patterns (skip research):** GitHub Actions/ESLint, BullMQ repeatable jobs, Docker/Caddy, Testcontainers.

---

## Confidence Assessment

| Area | Confidence | Notes |
|---|---|---|
| Stack | HIGH | All package versions verified against the live npm registry, 2026-07-27 |
| Features | MEDIUM-HIGH | Audit findings code-verified; 9 gaps cross-checked against 2–5 sources each |
| Architecture | HIGH | File paths exact from source inspection; patterns verified against the v1.0 codebase |
| Pitfalls | HIGH (BullMQ/Postgres/RLS), MEDIUM (Sentry/Docker/Testcontainers) | First-party docs + GitHub issues; no incident postmortem specific to this exact stack combination |
| Vendor pricing comparisons | MEDIUM | Web-search-derived; re-verify against live pricing pages before budget commitment |

**Overall:** HIGH. Research converges on concrete, actionable recommendations. The nine audit-missed gaps represent genuine blind spots. Three open decisions (auth boundary, concurrency mechanism, deployment/scaling strategy) are documented as intentionally unresolved.

### Gaps to Address

1. **Idempotency key derivation** — exact strategy for intent-derived, collision-resistant keys. Action: inspect production `sends` id-distribution patterns.
2. **Reconciliation SLA** — "longer than the BullMQ stall window" needs real webhook-latency percentiles. Action: load test to measure P95.
3. **Better Auth trust boundary** — RLS vs. separate role. Action: decide at discuss-phase; test login in staging.
4. **Per-tenant concurrency-cap mechanism** — BullMQ config, Redis counter, or bounded per-tier worker pools. Action: decide during planning.
5. **Horizontal worker scaling** — repeatable-job dedup breaks under multi-instance; mitigation documented. Action: explicit accept/defer decision rather than a silent assumption.

---

## Sources

- Live npm registry (`npm view`) — package versions verified 2026-07-27: eslint, typescript-eslint, @vitest/coverage-v8, @sentry/node, @sentry/react, @logtail/pino, bullmq-otel, @opentelemetry/sdk-node, @testcontainers/postgresql, @testcontainers/redis, @fastify/rate-limit. HIGH confidence.
- BullMQ first-party documentation and GitHub issues — rate limiting (`worker.rateLimit` is worker-scoped), `job.moveToDelayed`, stalled jobs/`lockDuration`, `worker.close()` semantics, Redis `maxmemory-policy=noeviction` requirement, native OpenTelemetry support since v5.71. HIGH confidence.
- PostgreSQL official documentation and mailing-list threads — RLS policy semantics, `FORCE ROW LEVEL SECURITY`, owner bypass, `SET LOCAL` transaction scoping, declarative partitioning `ATTACH PARTITION` locking, DEFAULT partition scan behavior. HIGH confidence.
- SendGrid first-party docs + a verified SendGrid GitHub issue — `sg_event_id` stability across webhook retries (docs and observed behavior disagree), absence of native idempotency-key support, Event Webhook signature verification. MEDIUM-HIGH confidence.
- Sentry documentation and issue tracker — Fastify integration lives in `@sentry/node` (`setupFastifyErrorHandler`), no retroactive redaction of already-ingested events, default scrubbing scope. MEDIUM-HIGH confidence.
- ICO (UK regulator) guidance on erasure vs. suppression — the standard resolution to the GDPR-erasure/proof-of-consent tension. HIGH confidence.
- Gmail/Yahoo bulk sender requirements (effective Feb 2024) — 0.1%/0.3% spam-complaint thresholds; consistent across 5+ independent sources. HIGH confidence.
- Crunchy Data and EDB engineering blogs — batched DEFAULT-partition evacuation technique. MEDIUM-HIGH confidence.
- pgBackRest / WAL-G / Barman comparisons, 3 independent 2026 sources — converge on pgBackRest as the self-hosted standard. MEDIUM-HIGH confidence.
- PgBouncer transaction-pooling documentation — advisory locks and session state do not survive transaction-mode pooling. MEDIUM-HIGH confidence.
- Mega CRM source inspection — `apps/worker/src/queues/` (`email-broadcast.worker.ts`, `email-triggered.worker.ts`, `send-dispatch.ts`, `flows/flow-send.ts`, `flows/flow-segment-sweep.worker.ts`, `flow-reconciliation.worker.ts`, `campaign-kickoff.worker.ts`, `recipient-snapshot.ts`, `webhook-events.worker.ts`), `packages/delivery-core/src/` (`send-mail.ts`, `send-ledger.ts`), `packages/tenant-context/src/`, `packages/db/src/`, `docker/init-app-role.sql`, `SPECIFICATION.md`. HIGH confidence (direct observation).

---

*Research completed: 2026-07-27*
