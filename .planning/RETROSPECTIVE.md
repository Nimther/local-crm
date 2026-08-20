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

## Milestone: v1.1 — Production Hardening

**Shipped:** 2026-08-20
**Phases:** 10 (8–17) | **Plans:** 128 | **Tasks:** 345 | **Commits:** 929 | **Timeline:** 25 days (2026-07-27 roadmap → 2026-08-20 shipped)

### What Was Built

- Fail-closed quality gates: CI with type-aware lint, unrounded coverage gate, migration linter, branch protection, per-run ephemeral test databases, and all five audit-named failure modes reproducible by one command (429/timeout/reset/SIGKILL/Redis restart)
- Automated partition lifecycle with a two-process dead-man's switch and batched DEFAULT relocation — the 2026-09-01 hard deadline closed 25 days early
- Tenant isolation by database identity: 22 RLS policies unified fail-closed (bare-cast throws, never zero rows), least-privilege `mega_crm_scan`/`mega_crm_auth` roles, per-route API-key scopes, replay-window webhook validation, 38 negative cross-tenant tests
- Delivery correctness: explicit send state machine (`reconciling`/`unknown`), evidence-only reconciler under exclusive claims, UUIDv5 idempotent send ids, AbortSignal timeout < lockDuration, real-SIGKILL crash tests at all three boundaries in required CI
- Worker fairness (tenant+lane deferral, TTL-leased Redis semaphore, two-tenant fairness proof) and compliance integrity (atomic unsubscribe, HMAC-hashed erasure with allowlist scrub, server-controlled dedup keys, quarantine, UTC day semantics with dirty-day reconciliation)
- Production operations: one-command readiness-gated deploy/rollback of GHCR SHA-tagged images, advisory-locked migrations, pgBackRest off-host encrypted PITR backups with performed drills, full observability (correlation ids to Postgres `application_name`, Sentry behind a CI redaction gate, Loki shipping, 9 alert watchdogs + runbooks), honest frontend error/empty/stale states
- Live verification as a release barrier: all five delivery guarantees confirmed against real SendGrid (5/5 UAT), plus a Phase 17 tech-debt closure pass (WR-06 UTC pinning, CI-built postgres image, self-recording restore drill)

### What Worked

- **Verification stack scaled up cleanly** — verifier + UAT + Nyquist validation + security auditor + milestone audit each caught distinct defect classes; the milestone audit's 3-source requirement cross-reference (REQUIREMENTS/VERIFICATION/SUMMARY) found zero orphans across 95 requirements
- **Tech-debt closure as an appended phase** — Phase 17 (roadmap evolution) converted the audit's open items into plans with evidence clauses, and D-12's "executor may not award security verdicts" rule kept the register honest: closure came only from a gsd-security-auditor re-run
- **Blocking operator checkpoints for live actions** — real deploy/rollback (14-09), real backups (14-10), PITR drills (14-11), live UAT (16), production cutover (17-05) all ran as approved checkpoints with pasted evidence, so "performed" never degraded into "configured"
- **v1.0 lessons held:** capture-real-payloads-first (Phase 16 committed a genuinely signed SendGrid fixture with frozen-clock CI), env checkers front-loaded (Phase 8's `MEGA_CRM_ENV_FILE` resolver + fail-closed DSN guard), shared constants over parallel literals (`SEND_STATUS_TRANSITIONS`, `@mega-crm/queue-core` single definitions)

### What Was Inefficient

- **Claims recorded without evidence resurfaced later** — Phase 15's UAT test-5 "live redeploy confirmed" turned out to have no evidence artifact and was contradicted by the audit; Phase 17 had to establish Alloy on production for the first time. Evidence-or-it-didn't-happen needs to apply to UAT approvals, not just executor claims
- **Gap-closure waves still dominated phase tails** (G-10-1, G-12-1..3, G-14-4, G-15-1..4) — though root causes shifted from client/server contract drift (v1.0) to environment/infra reality (compose interpolation eating DSNs, Alloy rejecting `#` comments, npm-10 lockfile desync, `autorun: undefined` clobbering BullMQ defaults)
- **Same-day re-audits were needed** because Nyquist validation ran after the first milestone audit rather than per-phase at verify:post from the start
- **The stale-projection problem persists** — init.manager flagged Phase 10 `stale` at close despite a passed verification and a passing re-audit; timestamp-based staleness heuristics disagree with content-based verification

### Patterns Established

- Infrastructure configs are parsed by the real binary in CI, never only statically linted (`alloy fmt` under the pinned image, `ALLOY_VALIDATE_REQUIRE_BINARY=1`; unavailable Docker = violation, not skip)
- Watchdog state lives in one keyed `ops_alert_state` table with a single atomic claim primitive; every alert has a runbook, enforced by a source-derived coverage gate
- Two-process dead-man's switch (worker writes health row, API watchdog reads and alerts) — reused for partitions, reconciler, dead-letter, queue depth
- BullMQ worker options passed only when explicitly set (conditional spread) — `undefined` clobbers defaults
- Security registers flip status only via gsd-security-auditor runs (D-12); executors attach evidence clauses without touching status
- Deploy mutations always `--no-deps`; images pull-only on immutable SHA tags, including the database image

### Key Lessons

1. **An approval without a pasted artifact is not evidence.** The one false "confirmed" of the milestone (Phase 15 alloy redeploy) was an approval recorded without output attached — and it survived two audits before Phase 17 caught it against production reality.
2. **Fail-closed beats fail-empty at every layer.** The RLS bare-cast decision (throw vs zero rows), the DSN guard, the webhook journal 5xx, the drill's missing-tag refusal — each converted a silent-wrong-answer class into a loud error, and none caused operational pain.
3. **Live confirmation is a phase, not a hope.** Making UAT its own release-barrier phase (16) prevented the v1.0 failure mode (deferred live UAT becoming accepted debt); the standing canary + smoke procedure keeps it repeatable.
4. **Deadline-shaped phases should be minimal and dependency-light.** Phase 9 (partition deadline) depended only on Phase 8 and shipped 25 days ahead of the hard date precisely because nothing else was bundled into it.
5. **Roadmap evolution beats scope creep denial.** Appending Phase 17 for audit findings kept the milestone's definition of done honest instead of either ignoring the findings or silently widening Phase 16.

### Cost Observations

- Model mix: not tracked (config `model_profile: adaptive`)
- Sessions: not tracked
- Notable: 128 plans in ~16 execution days (2026-08-04 → 2026-08-20); real-host operator checkpoints (deploy, backups, drills, live UAT, cutover) were the long poles, not code execution

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 7 | 96 | Baseline: walking-skeleton phases + verifier/UAT gap-closure loops established |
| v1.1 | 10 | 128 | Added: Nyquist validation, per-phase security registers with auditor-only status flips, milestone audit with 3-source cross-reference, blocking operator checkpoints for live actions, tech-debt closure as an appended phase |

### Cumulative Quality

| Milestone | Requirements | Verified Phases | Debt Accepted |
|-----------|--------------|-----------------|---------------|
| v1.0 | 49/49 | 7/7 | env/live-email UAT items (see v1.0-MILESTONE-AUDIT.md) |
| v1.1 | 95/95 | 10/10 (Phase 10 stale-projection override, verification itself passed) | live operator-alert email; remaining Phase 13 live walkthroughs; KEK quick-task Task 3; Phase 15 threshold assumptions + Sentry workspace_id gap + 2 UI follow-ups |

### Top Lessons (Verified Across Milestones)

1. **Capture-real-payloads-first: verified.** v1.0's fictional `custom_args` wrapper → v1.1's committed genuinely-signed SendGrid fixture with frozen-clock CI regression. The pattern held and paid off.
2. **Env checkers in phase 1: verified.** Phase 8 front-loaded the env resolver and fail-closed DSN guard; env-drift debug sessions dropped from 3 (v1.0) to effectively 0 — remaining gap-closures were infra-reality, not missing-var, failures.
3. **Shared constants over parallel literals: verified.** Extended beyond values into behavior (`SEND_STATUS_TRANSITIONS` executable mirror, `@mega-crm/queue-core` cross-app single-definition tests).
4. **New candidate for v1.2: approvals must carry pasted evidence** — the only false "confirmed" in two milestones was a checkpoint approval recorded without an artifact.
