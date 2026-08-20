# Milestones

## v1.1 Production Hardening (Shipped: 2026-08-20)

**Delivered:** Took the v1.0 MVP to a production-operable system: correct sends at every failure boundary (crash, timeout, ambiguous provider outcome), tenant isolation enforced by database identity and fail-closed RLS, honest compliance and analytics (atomic unsubscribe, erasure with retained evidence, UTC day semantics), bounded fault-tolerant background work with per-tenant fairness, an automated partition lifecycle closed ahead of the 2026-09-01 deadline, reproducible GHCR-image deploys with a rehearsed PITR restore, full observability (correlated logs to Loki, Sentry with CI-proven redaction, alert watchdogs + runbooks, honest frontend states), and every delivery guarantee confirmed live against real SendGrid. No new product functionality.

**Stats:** 10 phases (8–17), 128 plans, 345 tasks · 929 commits · 716 files · ~139k LOC TypeScript (from ~57k) · 2026-07-27 (roadmap) → 2026-08-20 (25 days)
**Closeout:** override_closeout — 95/95 v1.1 requirements complete, 10/10 phases `verification: passed`, security registers fully closed (`threats_open: 0` everywhere; T-14-58/T-14-73/T-14-88 flipped to closed by the gsd-security-auditor re-run on 2026-08-20). Override reasons: (a) init.manager projects Phase 10 verification as `stale` — a timestamp artifact: 10-VERIFICATION.md is `passed` (2026-08-09), its `re_verification` block explicitly covers the 10-15/G-10-1 closure, and the 2026-08-19 milestone audit re-verified the phase 21/21; (b) one acknowledged deferred item — quick task 260818-aqd Task 3 (operator-only, see Tech debt below). Known verification overrides: 1 (see STATE.md Deferred Items).

**Key accomplishments:**

1. **Quality gates & failure injection (Phase 8)** — fail-closed CI (typecheck, type-aware lint, unrounded coverage gate, migration linter, branch protection), per-run ephemeral test databases behind a guarded drop path, and all five audit-named failure modes (SendGrid 429/timeout/reset, SIGKILL mid-dispatch, Redis restart) reproducible by one command each with asserted outcomes.
2. **Partition automation (Phase 9)** — daily `ensurePartitions` tick with CHECK-constraint-first attach, a two-process dead-man's-switch (worker-written health row, API-side watchdog, operator email), and a batched DEFAULT-row relocation CLI; the hard 2026-09-01 deadline closed with 20 months of attached partitions confirmed by catalog query.
3. **Tenant isolation by database identity (Phase 10)** — all 22 RLS policies unified fail-closed (bare-cast: a query with no tenant context throws instead of returning zero rows), dedicated least-privilege `mega_crm_scan`/`mega_crm_auth` roles, sibling-workspace webhook events dropped per event, per-route API-key scopes, a signature-timestamp replay window, and 38 negative cross-tenant tests that found and fixed a real bug (T-10-14-03).
4. **Delivery correctness (Phase 11)** — explicit send state machine with `reconciling`/`unknown`, an evidence-only reconciler under exclusive row claims that never calls SendGrid, deterministic UUIDv5 send ids, an AbortSignal timeout strictly below BullMQ's lockDuration, and real-process crash tests at all three boundaries (plus the reconciler-vs-retry race) wired into the required `failure-injection` CI check.
5. **Worker fairness & compliance integrity (Phases 12–13)** — tenant+lane-scoped rate-limit deferral and a TTL-leased Redis concurrency semaphore proven by a two-tenant fairness test in CI; atomic unsubscribe across all entry points, erasure via anonymization + per-workspace HMAC suppression with a checkpointed JSONB scrub, webhook dedup re-based onto server-controlled keys with quarantine for out-of-range provider timestamps, and UTC day semantics with dirty-day reconciliation.
6. **Deploy, durability, observability & live verification (Phases 14–17)** — one-command readiness-gated deploy/rollback of GHCR SHA-tagged images (the custom postgres image CI-built and inside the immutability gate since Phase 17), advisory-locked migrations, pgBackRest off-host encrypted backups with PITR drills actually performed (self-recording duration/disk metrics: 119 s / 166 MB), correlated structured logs to Grafana Cloud Loki, Sentry behind a blocking CI redaction gate, nine alert watchdogs each with a runbook, route-level code splitting with honest error/empty/stale UI states — and all five delivery guarantees confirmed 5/5 live against real SendGrid (Phase 16, release barrier).

**Tech debt accepted at close** (full detail in `.planning/milestones/v1.1-MILESTONE-AUDIT.md`):

- Phase 9: a live operator-alert email (platform SendGrid key → `OPERATOR_ALERT_EMAIL`) has never been observed by a human; every layer up to `sgMail.send()` is proven by injected-seam tests.
- Phase 13: remaining live compliance walkthroughs (unsubscribe atomicity, timezone-independence, erasure end-to-end incl. quarantine survive-then-expire, out-of-bounds event integrity, backfill + reputation alerts) — Phase 16 already covered the CMP-07 dedup half and CMP-01's replay-idempotency half live; the rest are unexercised live.
- Quick task 260818-aqd Task 3: production provisioning of the file-backed KEK provider + live send (operator-only; Tasks 1–2 are implemented and committed).
- Phase 15 carried flags: OPS-13 alert thresholds and `STALE_DATA_LAG_THRESHOLD_MINUTES` are assumptions pending real load; API-side Sentry `workspace_id` gap inside route-level `withTenant` (~10 route modules, documented with an executable test); two UI follow-ups (LaunchConfirmDialog hides a failed audience breakdown, CsvImportWizard conflates loading with a dead fetch).

**Archived:**
- `.planning/milestones/v1.1-ROADMAP.md`
- `.planning/milestones/v1.1-REQUIREMENTS.md`
- `.planning/milestones/v1.1-MILESTONE-AUDIT.md`
- `.planning/milestones/v1.1-phases/` (10 phase directories, 128 plans + summaries)

---

## v1.0 MVP (Shipped: 2026-07-14)

**Delivered:** A working Klaviyo-class multi-tenant email-marketing platform: isolated workspaces with BYO SendGrid keys, a contact base fed by UI/CSV/events, dynamic segmentation, throttled idempotent broadcast campaigns, webhook-driven delivery tracking with auto-suppression, a visual canvas flow builder with a durable execution engine, and end-to-end analytics.

**Stats:** 7 phases, 96 plans, 243 tasks · 616 commits · 802 files · ~57k LOC TypeScript · 2026-07-02 → 2026-07-14 (13 days)
**Closeout:** verified_closeout — all 7 phases `verification: passed`, 49/49 v1 requirements complete, open-artifact audit clear (11 diagnose-only debug sessions resolved at close; fixes shipped via gap-closure plans or recorded as env tech debt in the milestone audit)

**Key accomplishments:**

1. **Multi-tenant foundation** — shared-schema Postgres with Row-Level Security on every tenant table, better-auth organizations (invites, Owner/Admin/Member role matrix), and KMS envelope encryption (per-tenant DEK, local/AWS KEK toggle) protecting live-validated BYO SendGrid keys.
2. **Contact base & event ingestion** — contact CRUD UI, streaming CSV import wizard with dry-run/error report, and an API-key-authed fast-2xx `/v1/events` pipeline over a partitioned events table with an idempotent BullMQ worker sharing one `upsertContactByIdentity` (external_id-first, email-fallback) across all three ingestion paths.
3. **Segmentation engine** — a fails-closed AND/OR condition compiler (`@mega-crm/segments-core`) producing one SQL WHERE reused verbatim by campaign audiences, flow triggers, and branch checks, with statement-timeout-guarded live preview counts in the builder UI.
4. **Broadcast send pipeline** — draft→scheduled→sending→sent state machine, batched recipient snapshots, two isolated BullMQ queues (triggered/broadcast) throttled by a per-tenant Redis token bucket, a commit-before-network idempotent dispatch that survives crashes without duplicate sends, pre-send suppression gate, and RFC 8058 one-click unsubscribe.
5. **Delivery tracking loop** — auto-provisioned per-tenant signed SendGrid Event Webhooks (self-healing reconnect), raw-body ECDSA verification, exactly-once dedup into partitioned `send_events`, per-message status facts, campaign counters, and automatic bounce/spam/unsubscribe suppression.
6. **Flows & analytics** — @xyflow/react canvas builder (5 node types, honest autosave, publish-time graph validation incl. cycle detection) driving a durable versioned execution engine (pinned versions, re-entry control, DST-correct delays, dispatch-time quiet hours), plus campaign/flow-node/contact-timeline/dashboard/send-log analytics on a dual-write daily rollup.

**Tech debt accepted at close** (see `.planning/milestones/v1.0-MILESTONE-AUDIT.md` for full list): live-email/external-env items requiring a real platform SendGrid key + verified sender, live SendGrid UAT click-throughs (test send to real inbox, one-click unsubscribe redemption), and a set of human visual/UX spot checks carried from phase plans.

**Archived:**

- `.planning/milestones/v1.0-ROADMAP.md`
- `.planning/milestones/v1.0-REQUIREMENTS.md`
- `.planning/milestones/v1.0-MILESTONE-AUDIT.md`
- `.planning/milestones/v1.0-phases/` (7 phase directories, 96 plans + summaries)
