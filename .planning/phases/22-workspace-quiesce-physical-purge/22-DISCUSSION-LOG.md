# Phase 22: Workspace Quiesce & Physical Purge - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-23
**Phase:** 22-Workspace Quiesce & Physical Purge
**Areas discussed:** Quiesce semantics, Retention & triggering, PII scope & evidence, Restore semantics

---

## Quiesce semantics

| Option | Description | Selected |
|--------|-------------|----------|
| Both layers | Fix campaigns_scan/flows_scan discovery filters AND add fail-closed dispatch-time check in the send path | ✓ |
| Discovery filter only | Exclude deleted workspaces at scan/scheduler layer; jobs already in BullMQ would still send | |
| Dispatch gate only | One check before SendGrid; schedulers keep churning forever | |

**User's choice:** Both layers (defense-in-depth, suppression-gate precedent)

| Option | Description | Selected |
|--------|-------------|----------|
| Freeze | No state mutation at soft-delete; both layers refuse work while deletedAt set; restore gets state back | ✓ |
| Terminal cancel | Actively cancel scheduled/sending campaigns and exit live flow_runs | |
| Cancel campaigns, freeze flows | Mixed model | |

**User's choice:** Freeze

| Option | Description | Selected |
|--------|-------------|----------|
| Excluded send fact | Send row gets status 'excluded' with new exclusion_reason 'workspace_deleted' | ✓ |
| Silent job completion | Ack + log only; send stuck in 'queued' would confuse reconciler | |
| You decide | Planner picks after examining dispatch paths | |

**User's choice:** Excluded send fact

| Option | Description | Selected |
|--------|-------------|----------|
| Quiesce ingestion too | API keys refuse events, inbound webhooks dropped/quarantined; no new PII accumulates | ✓ |
| Mail only | Events and webhooks keep writing during retention | |
| Mail + ingestion, webhooks keep landing | Late delivery evidence for pre-delete mail still processes | |

**User's choice:** Quiesce ingestion too

---

## Retention & triggering

| Option | Description | Selected |
|--------|-------------|----------|
| Automatic worker tick | Scheduled worker purges unattended; deletion by construction; PRG-05 re-check is the safety net | ✓ |
| Operator-invoked CLI only | Phase 9 relocate precedent literally; depends on operator discipline | |
| Auto-enqueue + operator arm switch | PURGE_ENABLED flag, ships dark, operator flips after checklist | |

**User's choice:** Automatic worker tick

| Option | Description | Selected |
|--------|-------------|----------|
| 30 days, validated floor | Default 30d via env with boot-validated minimum (≥7d) | ✓ |
| 90 days, validated floor | Longer grace, harder to defend under GDPR | |
| 30 days, no floor | Operator can set 0; one env edit from purge-on-delete | |

**User's choice:** 30 days, validated floor

| Option | Description | Selected |
|--------|-------------|----------|
| Report-only first tick | Eligibility report one full tick before first destructive batch + on-demand CLI report | ✓ |
| CLI dry-run command only | Preview is opt-in; worker just purges | |
| No dry-run | Retention window is the preview period | |
| You decide | Follow partition-retention pre-enable checklist precedent | |

**User's choice:** Report-only first tick

| Option | Description | Selected |
|--------|-------------|----------|
| Watchdog + completion log | Stuck/failed purge alerts via ops_alert_state; success = log + durable record | ✓ |
| Alert on both completion and failure | Positive confirmation at cost of routine noise | |
| Logs only | Stuck purge invisible until someone looks | |

**User's choice:** Watchdog + completion log

---

## PII scope & evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Anonymized tombstone | Org row survives scrubbed with purged_at; id stays as FK anchor; slug freed | ✓ |
| Full delete | Cleanest end state but evidence loses FK anchor | |
| You decide | Research maps FK dependencies first | |

**User's choice:** Anonymized tombstone

| Option (multi-select) | Description | Selected |
|--------|-------------|----------|
| erasure_records | Proof of past contact erasures, already PII-free | ✓ |
| New purge_records row | Durable PII-free record of the purge itself | ✓ |
| Hashed suppression rows | Proof suppression was honored | ✓ |
| Aggregate daily metrics | Count-only sending history | ✓ |

**User's choice:** All four survive

| Option | Description | Selected |
|--------|-------------|----------|
| Destroy the key | Hashes become permanently unmatchable — cryptographic erasure; rows still prove enforcement | ✓ |
| Keep the key | Future dispute re-check possible but retained tenant secret contradicts 'secrets gone' | |
| You decide | Research weighs evidential vs erasure trade-off | |

**User's choice:** Destroy the key

| Option | Description | Selected |
|--------|-------------|----------|
| Memberships + invites only | Better Auth user/session/account untouched (global identities) | ✓ |
| Also delete orphaned users | Fuller cleanup but touches auth trust boundary | |
| You decide | Research checks Better Auth adapter tolerance | |

**User's choice:** Memberships + invites only

---

## Restore semantics

| Option | Description | Selected |
|--------|-------------|----------|
| Operator CLI restore | Minimal operator-only script clearing deletedAt, refusing once purge started | ✓ |
| Purely defensive | No restore path; re-check guards manual DB intervention only | |
| Owner-facing restore in UI | New user-facing capability — arguably its own phase | |

**User's choice:** Operator CLI restore

| Option | Description | Selected |
|--------|-------------|----------|
| First destructive batch | Restore succeeds until the first row is destroyed; then typed refusal | ✓ |
| Purge enqueue | Refuse once claimed; forfeits announce-window recovery for no safety gain | |
| You decide | Planner sets boundary with the state machine | |

**User's choice:** First destructive batch

| Option | Description | Selected |
|--------|-------------|----------|
| Never auto-fire | Overdue scheduled campaigns do not launch on restore; human re-schedules | ✓ |
| Fire on restore | Purest freeze semantics but mail blasts on un-delete | |
| You decide | Planner maps campaign state machine interaction | |

**User's choice:** Never auto-fire

---

## Claude's Discretion

- Env var names, retention floor exact value, tick cadence, batch sizes, purge table/column naming
- Purge state machine states, claim primitive, checkpoint storage shape (outside tenant tables per PRG-03)
- Webhook drop vs quarantine for deleted workspaces
- Typed refusal shapes for quiesced ingestion and restore CLI
- FK deletion ordering (research/spike territory)
- Plan-time decisions carried to research: privilege model (PT-01), PITR backup caveat wording (PT-02), scan-filter mechanics incl. possible column-level grant (PT-03)

## Deferred Ideas

- Owner-facing restore in UI (tenant self-service un-delete)
- Orphaned Better Auth user cleanup after purge
- Durable DSR export audit table (carried from Phase 21)
