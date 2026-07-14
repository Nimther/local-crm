# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — MVP

**Shipped:** 2026-07-14
**Phases:** 7 | **Plans:** 96 | **Tasks:** 243 | **Commits:** 616 | **Timeline:** 13 days (2026-07-02 → 2026-07-14)

### What Was Built

- Multi-tenant workspace foundation: Postgres RLS on every tenant table, better-auth organizations (invites/roles), KMS envelope encryption for BYO SendGrid keys
- Contact base with three converging ingestion paths (UI CRUD, streaming CSV wizard, API-key-authed events API) sharing one `upsertContactByIdentity`
- Segmentation engine: one fails-closed SQL condition compiler reused by campaigns, flow triggers, and branch checks, with live preview counts
- Broadcast campaigns on a throttled, idempotent, crash-safe send pipeline (two isolated BullMQ queues + per-tenant Redis token bucket)
- Webhook-driven delivery tracking: auto-provisioned signed SendGrid Event Webhooks, exactly-once dedup, automatic suppression
- Canvas flow builder (@xyflow/react) + durable versioned execution engine (pinned versions, re-entry control, quiet hours, DST-correct delays)
- End-to-end analytics: campaign rates, per-flow-node metrics, contact timeline, rollup dashboard, filterable per-message send log

### What Worked

- **Shared-package extraction as the reuse mechanism** — `contacts-core`, `segments-core`, `delivery-core`, `flows-core`, `tenant-context`, `kms` each extracted the moment a second consumer appeared (worker vs API), so identity rules, suppression, and the send pipeline never forked
- **Walking-skeleton-first phases** — every phase opened with a thin end-to-end slice (schema + route + worker) before widening, so integration risk surfaced in plan 1, not plan N
- **Verifier + UAT + gap-closure loops** — goal-backward verification caught real defects (duplicate-send crash window, cross-workspace webhook adoption, swapped bind order in timezone lookup) that task-completion checks would have missed
- **RLS + chaos/fault-injection tests** — tenant isolation proven by pooled-connection chaos tests and `pg_terminate_backend` fault injection rather than asserted from source reading

### What Was Inefficient

- **Gap-closure rounds dominated the tail of every phase** — Phase 4 needed 5 rounds (11 of its 19 plans were gap closure), Phase 5 needed 5, Phase 6 needed 4. Root causes clustered in two buckets: contract drift between client and server (pageSize caps, quiet_hours_mode vocabulary, payload shapes) and env/config drift (unapplied migrations, missing secrets) masquerading as code bugs
- **SendGrid webhook payload shape was assumed, not captured** — the worker read a fictional nested `custom_args` wrapper for weeks; a single captured real payload early (05-01) would have avoided a whole debug-and-fix cycle (05-13)
- **11 debug sessions accumulated in `diagnosed` state** until milestone close — the diagnose→gap-plan→fix pipeline worked, but nothing moved sessions to `resolved/` when their fixes shipped
- **Live-email UAT repeatedly blocked on external env** (real SendGrid key, https tunnel, applied migrations) — these prerequisites were discovered mid-UAT instead of being front-loaded as a runbook (eventually written as 05-10)

### Patterns Established

- One shared Zod contract per domain in `shared-schemas`, imported by API routes, workers, and web forms — client/server drift became a named failure mode with a named fix (e.g., `EXHAUSTIVE_LOOKUP_PAGE_SIZE`)
- RLS policies always paired with `NULLIF(current_setting(...), '')::uuid` guards; runtime-lookup tables get a second GUC-scoped policy (`api_key_runtime_lookup` precedent)
- Queue workers: idempotency from DB claims (partial unique indexes, `FOR UPDATE SKIP LOCKED`, `ON CONFLICT DO NOTHING`), never from BullMQ jobId dedup; jobIds use `-` separators (BullMQ rejects `:`)
- Commit-before-network-call transaction split for any external-API dispatch
- Pure decision modules (DB-free) extracted for testability: suppression rules, status priority, autosave state, quiet-hours resolution
- `predev` env/migration checkers so a missing var or unapplied migration fails loudly instead of masquerading as a healthy dev server

### Key Lessons

1. **Capture a real external payload before writing the parser.** The nested-`custom_args` assumption survived unit tests (fixtures encoded the same wrong assumption) and only died against a live SendGrid event. Fixtures must derive from captured reality, not from documentation reading.
2. **Env drift produces the same symptoms as code bugs and costs the same debug time.** Three of the eleven v1.0 debug sessions were unapplied migrations or missing secrets. The predev bootstrap (04-16) and env checker (01-07) were the highest-ROI fixes of the milestone — build them in phase 1 next time.
3. **Shared constants beat parallel literals.** Every client/server drift bug (pageSize, quiet-hours vocabulary, page-size caps) was fixed by moving the value into `shared-schemas` and importing it from both sides.
4. **Verification rounds converge; plan for them.** No phase passed verification on round 1, and that was fine — the roadmap should budget gap-closure waves rather than treat them as overruns.
5. **Move debug sessions to `resolved/` when the fix ships,** not at milestone close — otherwise the close-out audit inherits an 11-item cleanup.

### Cost Observations

- Model mix: not tracked in v1.0 (config `model_profile: adaptive`)
- Sessions: not tracked
- Notable: 96 plans in 13 calendar days with median plan execution ~15 min; the single outlier was 07-07 (dashboard, 282 min), dominated by a human-verify checkpoint wait

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 7 | 96 | Baseline: walking-skeleton phases + verifier/UAT gap-closure loops established |

### Cumulative Quality

| Milestone | Requirements | Verified Phases | Debt Accepted |
|-----------|--------------|-----------------|---------------|
| v1.0 | 49/49 | 7/7 | env/live-email UAT items (see v1.0-MILESTONE-AUDIT.md) |

### Top Lessons (Verified Across Milestones)

1. (Single milestone so far — candidates to verify in v1.1: capture-real-payloads-first, env checkers in phase 1, shared constants over parallel literals)
