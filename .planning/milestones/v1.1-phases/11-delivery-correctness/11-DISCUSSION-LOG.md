# Phase 11: Delivery Correctness - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-09
**Phase:** 11-delivery-correctness
**Areas discussed:** Reconciler verdict model, Evidence source & resolution windows, Idempotency key & claim lifecycle, Reconciling rows in campaign lifecycle & visibility, Timeout & operational parameters

Mode: `--all --analyze` (all gray areas auto-selected; trade-off table presented before each question).

---

## Reconciler verdict model

| Option | Description | Selected |
|--------|-------------|----------|
| Classification-only (Recommended) | Reconciler resolves to terminal states, never calls SendGrid | ✓ |
| Re-dispatch when proven unsent | Effectively-once via re-enqueue on evidence of non-acceptance | |
| Classification + deferred human re-send | Safety of option 1 with recovery tooling later | |

**User's choice:** Classification-only (strict at-most-once).

| Option | Description | Selected |
|--------|-------------|----------|
| Terminal `unknown` (Recommended) | New enum value; honest terminal state | ✓ |
| `failed` + distinct reason | Reuse existing terminal state, marked ambiguous | |
| You decide | | |

**User's choice:** Terminal `unknown`.

| Option | Description | Selected |
|--------|-------------|----------|
| Reconciler only (Recommended) | Sole writer of reconciling → terminal; webhook worker records evidence only | ✓ |
| Reconciler + webhook worker | Webhook worker promotes reconciling → sent directly | |

**User's choice:** Reconciler only.

| Option | Description | Selected |
|--------|-------------|----------|
| Bounded re-scan (Recommended) | Reconciler re-examines recent `unknown` rows (~72h) and upgrades on late evidence | ✓ |
| `unknown` is final | Facts recorded, status never changes | |
| You decide | | |

**User's choice:** Bounded re-scan.

---

## Evidence source & resolution windows

| Option | Description | Selected |
|--------|-------------|----------|
| Webhook evidence only (Recommended) | send_events/fact columns by send_id; no provider API calls | ✓ |
| Hybrid with Activity API | Webhook first, Activity API where tenant has the add-on | |
| Activity API as primary | Direct provider query per unresolved send | |

**User's choice:** Webhook evidence only.

| Option | Description | Selected |
|--------|-------------|----------|
| Add `processed` (Recommended) | Direct acceptance evidence, ~1 extra event per send | ✓ |
| Add `processed` + `deferred` | Richer but deferred fires repeatedly | |
| Keep current event set | Acceptance proven only indirectly | |

**User's choice:** Add `processed` only.

| Option | Description | Selected |
|--------|-------------|----------|
| ~24h (Recommended) | Survives realistic webhook outages; re-scan horizon ~72h | ✓ |
| Short ~1-2h | Fast definitive states, more unknown→sent churn | |
| Long 72h | Waits out full deferral cycle | |
| You decide | | |

**User's choice:** ~24h window / ~72h horizon, as versioned constants.

| Option | Description | Selected |
|--------|-------------|----------|
| Sweep stale orphans (Recommended) | Reconciler adopts aged `dispatching` rows | ✓ |
| Redelivery-only | Manual runbook for orphans | |

**User's choice:** Sweep stale orphans.

---

## Idempotency key & claim lifecycle

| Option | Description | Selected |
|--------|-------------|----------|
| UUIDv5 sends.id (Recommended) | Deterministic id from send intent; release/re-claim survives | ✓ |
| Stable row, no delete | Release becomes status transition; new state needed | |
| You decide | | |

**User's choice:** UUIDv5 sends.id.

| Option | Description | Selected |
|--------|-------------|----------|
| Timeout + reset ambiguous (Recommended) | 429/5xx stay retryable | (refined) |
| Timeout only ambiguous | Resets keep retrying | |
| Timeout + reset + 5xx ambiguous | Strictest | |

**User's choice:** Free-text refinement — timeout/reset after possible body send → `reconciling`; provably pre-connection errors → retryable; 429/5xx → release + **bounded** exponential retry; permanent 4xx → `failed`; fail-closed default → `reconciling` when transport can't prove whether bytes were sent.

| Option | Description | Selected |
|--------|-------------|----------|
| Outside, documented (Recommended) | Test sends excluded from state machine | (refined) |
| Bring into the machine | Test sends get ledger rows | |

**User's choice:** Free-text refinement — test sends outside ledger/reconciliation/analytics; no auto-retry; HTTP error shown plainly; ambiguous timeout/reset shown as "outcome unknown — check the inbox before manually re-sending".

---

## Reconciling rows in campaign lifecycle & visibility

| Option | Description | Selected |
|--------|-------------|----------|
| Count toward completion (Recommended) | Campaign completes on dispatch finish; idempotent counter backfill | ✓ |
| Block completion | Campaign waits out the full window | |
| New 'finalizing' status | Intermediate campaign state | |

**User's choice:** Count toward completion.

| Option | Description | Selected |
|--------|-------------|----------|
| Minimal-honest (Recommended) | Send log shows new statuses; rollups exclude unknown; UI depth deferred | ✓ |
| First-class everywhere | unknown_count on campaigns, rollup column, dashboard | |
| Fold into failed for display | No UI change, dishonest | |

**User's choice:** Minimal-honest.

| Option | Description | Selected |
|--------|-------------|----------|
| Phase 9 email channel (Recommended) | Health row + API watchdog + OPERATOR_ALERT_EMAIL | ✓ |
| Bull Board only | Passive visibility | |
| Defer to Phase 15 | No interim monitoring | |

**User's choice:** Phase 9 email channel.

---

## Timeout & operational parameters

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit 60s/20s + test (Recommended) | lockDuration explicit; invariant asserted by a test | ✓ |
| Implicit 30s lock, 20s timeout | Rely on BullMQ default | |
| You decide | | |

**User's choice:** Explicit 60s/20s + test-asserted invariant.

| Option | Description | Selected |
|--------|-------------|----------|
| ~5 min (Recommended) | Repeatable tick, bounded batches | ✓ |
| ~1 min | Fresher, 5× scans | |
| ~30-60 min | Cheapest, laggy | |
| You decide | | |

**User's choice:** ~5 min.

| Option | Description | Selected |
|--------|-------------|----------|
| Columns on sends (Recommended) | dispatched_at + dispatch_duration_ms | ✓ |
| Log-only | Unqueryable until Phase 15 | |
| You decide | | |

**User's choice:** Columns on sends.

| Option | Description | Selected |
|--------|-------------|----------|
| ARCHITECTURE.md section (Recommended) | Mermaid diagram + writer matrix, reviewed before code | ✓ |
| Standalone doc | Fourth binding document | |
| You decide | | |

**User's choice:** ARCHITECTURE.md section.

---

## Claude's Discretion

- UUIDv5 namespace/helper; key-composition strings
- Exact timing numbers (timeout, lockDuration, window, horizon, cadence, batch bound, stale-age threshold) within decided orders of magnitude
- Bounded-retry parameters for 429/5xx and interaction with `worker.rateLimit()`
- Transport-error → classification mapping mechanics and fixtures
- Reconciler health-row schema and watchdog threshold
- `SendJobResult` shape evolution (designed so Phase 12's cause split extends, not reshapes)

## Deferred Ideas

- Operator/marketer re-send tooling for `unknown` rows (recovery UI/CLI)
- `deferred` event ingestion (only if evidence proves insufficient)
- Campaign-card `unknown` stat / dashboard treatment → Phases 13/15
- Real alerting on `reconciling_since` age → Phase 15 (OPS-13)
- `SendJobResult` cause split (`tenant_bucket` vs `provider_backoff`) → Phase 12 (WRK-01)
