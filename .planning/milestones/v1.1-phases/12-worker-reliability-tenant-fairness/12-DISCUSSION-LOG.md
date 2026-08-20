# Phase 12: Worker Reliability & Tenant Fairness - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-10
**Phase:** 12-worker-reliability-tenant-fairness
**Areas discussed:** WRK-02 concurrency-cap mechanism, Fairness proof & RPS validation (WRK-03/04), Dead-letter path & observability (WRK-09/10), Sweep checkpoint storage (WRK-05/06), Shutdown drain & consolidation (WRK-07/08/11/13)

**Mode:** `--all --analyze` — all gray areas auto-selected; each question preceded by a trade-off table.

---

## WRK-02: Per-tenant concurrency-cap mechanism

### Question 1: Enforcement mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Redis semaphore (Recommended) | App-layer acquire/release counter keyed by tenant, TTL-leased against crash leaks; over-cap jobs take the same moveToDelayed tenant_bucket path as WRK-01 | ✓ |
| Bounded per-tier pools | Fixed worker-slot allocations per tenant tier; coarser, no per-job accounting | |
| BullMQ Pro groups | Paid license for native per-group concurrency; stack docs said "revisit at scale" | |

**User's choice:** Redis semaphore (Recommended)

### Question 2: Cap scope

| Option | Description | Selected |
|--------|-------------|----------|
| Per-lane cap (Recommended) | Separate semaphore per tenant per queue (broadcast/triggered) — preserves the Phase 4 lane-isolation invariant | ✓ |
| Single cap per tenant | One semaphore across both queues; a broadcast can starve the same tenant's triggered sends | |

**User's choice:** Per-lane cap (Recommended)

### Question 3: Cap configuration

| Option | Description | Selected |
|--------|-------------|----------|
| Constants + env (Recommended) | Platform-wide default per lane as versioned constants with env override, like DEFAULT_TENANT_RPS | ✓ |
| Per-tenant DB override | Nullable per-workspace column now; ready for tiers but no current consumer | |

**User's choice:** Constants + env (Recommended)

---

## Fairness proof & RPS validation (WRK-03/WRK-04)

### Question 1: Load-test form

| Option | Description | Selected |
|--------|-------------|----------|
| CI scenario + on-demand full (Recommended) | Scaled-down deterministic two-tenant scenario in the failure-injection CI job + full-volume on-demand npm variant, both on the fake sendMail seam | ✓ |
| On-demand script only | One manual full-volume run, documented; no CI regression protection | |
| Live SendGrid test | Realistic but non-deterministic, burns quota, contradicts Phase 8 fake-transport decision | |

**User's choice:** CI scenario + on-demand full (Recommended)

### Question 2: "Measurably unaffected" definition

| Option | Description | Selected |
|--------|-------------|----------|
| Relative baseline ≥~90% (Recommended) | Same run measures B solo, then B alongside saturating A; assert B keeps ≥~90% of its own baseline; percentage is a versioned constant | ✓ |
| Absolute throughput floor | B sustains ≥ N sends/sec; machine-dependent, brittle in CI | |
| Zero-starvation only | B's queue drains within a bound; proves a weaker property | |

**User's choice:** Relative baseline ≥~90% (Recommended)

### Question 3: DEFAULT_TENANT_RPS backing (WRK-04)

| Option | Description | Selected |
|--------|-------------|----------|
| Test + doc cross-check (Recommended) | Full-scale variant runs at DEFAULT_TENANT_RPS proving pipeline capacity; constant's rationale cites SendGrid docs + BYO plan-tier caveat | ✓ |
| SendGrid docs only | Cite published limits; no pipeline proof; plan-tier variance unaddressed | |
| Load test only | Pipeline proof only; provider ceiling undocumented | |

**User's choice:** Test + doc cross-check (Recommended)

---

## Dead-letter path & observability (WRK-09/WRK-10)

### Question 1: Dead-letter mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Postgres DLQ table (Recommended) | Shared final-failure listener writes queue, job id/name, redacted payload, error, timestamps to dead_letter_jobs; durable, SQL-queryable, watchdog-alertable | ✓ |
| Dedicated BullMQ DLQ queue | Terminal failures re-enqueued to a storage-only Redis queue; volatile, needs its own retention answer | |
| Long-retention failed set | Redis failed set as the DLQ; retention aging deletes the dead-letter record | |

**User's choice:** Postgres DLQ table (Recommended)

### Question 2: Observability channel this phase

| Option | Description | Selected |
|--------|-------------|----------|
| Watchdog + email (Recommended) | Extend the API-side watchdog: OPERATOR_ALERT_EMAIL on dead-letter rows, deduped via claimAlertSlot; Phase 15 re-plumbs | ✓ |
| SQL-only, defer alerts | Queryable but silent until Phase 15 | |
| Bull Board now | Drags Phase 15 ops-UI scope into this phase; misses the Postgres table | |

**User's choice:** Watchdog + email (Recommended)

---

## Sweep checkpoint storage (WRK-05/WRK-06)

### Question 1: Checkpoint persistence

| Option | Description | Selected |
|--------|-------------|----------|
| Postgres row per flow (Recommended) | Cursor committed in the same transaction as each page's enrollment work — exact resume after kill, survives Redis flush | ✓ |
| BullMQ job.updateData() | Cursor on the job; lost on Redis flush, not atomic with the page's DB work | |
| Redis key per flow | Cheap but volatile, hand-rolled lifecycle, no codebase precedent | |

**User's choice:** Postgres row per flow (Recommended)

---

## Shutdown drain & consolidation (WRK-07/WRK-08/WRK-11/WRK-13)

### Question 1: Shared queue-factory home (WRK-11)

| Option | Description | Selected |
|--------|-------------|----------|
| packages/queue-core (Recommended) | New workspace package both apps import: connection builder, factory with per-queue retention param, shared error-listener helper; absorbs Phase 11's queue-options.ts | ✓ |
| apps/worker as source | apps/api imports across the app boundary; breaks app/package separation | |
| Two lint-pinned copies | Drift-check-pinned per-app definitions — the WRK-11 violation itself | |

**User's choice:** packages/queue-core (Recommended)

---

## Claude's Discretion

- Exact semaphore primitive (rate-limiter-flexible pattern vs INCR/DECR+TTL Lua), lease TTL, slot-release placement
- Cap values per lane, fairness threshold percentage, load-test volumes — all versioned constants with rationale
- dead_letter_jobs schema, its own retention/pruning, payload redaction via @mega-crm/redaction
- Sweep checkpoint table schema, page size, stale-snapshot DELETE batch size
- Derived drain-timeout formula/value (SENDGRID_TIMEOUT_MS + margins; consumed by Phase 14's container stop-grace)
- Error-listener sink this phase (scrubbedConsole norm; Phase 15 swaps to Sentry) and attach-helper API
- packages/queue-core internal layout; boundary vs packages/shared-schemas
- Where the multi-instance-safety doc lands (ARCHITECTURE.md section vs standalone)

## Deferred Ideas

- Per-tenant concurrency-cap DB overrides / tiered plans — billing-era concern
- Bull Board + real alerting on queue depth / DLQ age — Phase 15 (OPS-13)
- BullMQ Pro migration for native group limits — revisit at scale
- Multi-instance worker deployment — out of v1.1 scope; documented constraint instead
