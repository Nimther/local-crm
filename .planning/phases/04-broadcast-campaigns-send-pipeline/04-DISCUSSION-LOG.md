# Phase 4: Broadcast Campaigns & Send Pipeline - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-06
**Phase:** 4-Broadcast Campaigns & Send Pipeline
**Areas discussed:** Audience snapshot semantics, Campaign lifecycle & control, Frequency cap & unsubscribe compliance, Template & test-send UX

**Session note:** User selected all 4 areas and answered the first 6 questions interactively. From the timezone question onward there was no response within 60s (away-from-keyboard precedent from Phases 1–3) — remaining decisions were auto-selected recommended options, marked **(auto)** in CONTEXT.md.

---

## Audience snapshot semantics (user-answered)

### Q1: When is a scheduled campaign's segment resolved into recipients?

| Option | Description | Selected |
|--------|-------------|----------|
| At send time (Recommended) | Evaluated when sending starts; matches dynamic segments (Ph3 D-13) and Klaviyo; scheduled UI shows estimated count | ✓ |
| At schedule click | Frozen at scheduling; predictable but stale by send time | |
| User picks per campaign | Toggle per campaign; extra concept + two code paths | |

**User's choice:** At send time

### Q2: Is the recipient list frozen once sending starts?

| Option | Description | Selected |
|--------|-------------|----------|
| Freeze at send start (Recommended) | Materialized snapshot; stable denominator; deterministic retries | ✓ |
| Rolling evaluation during send | Mid-send joiners included; shifting totals, weaker idempotency | |

**User's choice:** Freeze at send start

### Q3: Segment referenced by a scheduled campaign is edited?

| Option | Description | Selected |
|--------|-------------|----------|
| Allow + warn (Recommended) | Edits apply (send-time resolution); editor shows "used by scheduled campaign X" notice | ✓ |
| Allow silently | Pure dynamic semantics, surprise risk | |
| Block while scheduled | Safest but frustrating, contradicts dynamic segments | |

**User's choice:** Allow + warn

### Q4: What does the campaign show as its audience given exclusions?

| Option | Description | Selected |
|--------|-------------|----------|
| Sendable + breakdown (Recommended) | Denominator = sendable; exclusion breakdown (unsubscribed/suppressed/no email) shown | ✓ |
| Sendable count only | No explanation of gap vs segment count | |
| Segment count as total | Excluded count as "processed"; sent never equals total | |

**User's choice:** Sendable + breakdown

### Q5: Sendable audience turns out to be 0?

| Option | Description | Selected |
|--------|-------------|----------|
| Complete + notice (Recommended) | Transitions to 'sent' with 0 sent and explicit notice; confirm dialog shows count pre-launch | ✓ |
| Failed state | Extra terminal state for a non-failure | |
| Block at launch, skip if scheduled | Return-to-draft surprising | |

**User's choice:** Complete + notice

### Q6: Scheduling timezone? *(no response — auto)*

| Option | Description | Selected |
|--------|-------------|----------|
| User's local, shown explicitly (Recommended) | Browser TZ with explicit label, stored UTC | ✓ (auto) |
| Workspace timezone setting | New settings surface | |
| Per-contact local time | Needs TZ data + staggered engine — v2 | |

---

## Campaign lifecycle & control (auto)

Recommended options auto-selected: cancel scheduled → draft; no in-place edit of scheduled (revert to draft first); cancel mid-send → terminal 'canceled' with actual counts; partial permanent failures → single 'sent' state with visible failed counter; duplicate-campaign enabled; test send from draft/scheduled, outside state machine and frequency cap.

---

## Frequency cap & unsubscribe compliance (auto)

Recommended options auto-selected: workspace-configurable cap with default (3 emails / rolling 24h, refinable by researcher) enforced via unified send ledger; capped contacts skipped (not deferred) and shown in exclusion breakdown; RFC 8058 one-click List-Unsubscribe-Post platform endpoint with signed per-message token + hosted confirmation page; platform subscription status is the source of truth (SendGrid subscription tracking disabled for these sends).

---

## Template & test-send UX (auto)

Recommended options auto-selected: Dynamic Template picked from fetched tenant SendGrid list (manual template_id fallback); from-address from verified senders (Phase 1 D-21 mechanism); dynamic_template_data = documented standard contact-profile shape (standard fields + tags + properties.*), no per-campaign mapping UI; test send to own address with sample data auto-filled from a real segment contact, editable JSON.

---

## Claude's Discretion

- Per-tenant RPS default/storage, token-bucket and backoff parameters, idempotency key format
- Recipient-snapshot schema and batched materialization at 100k+ scale
- Scheduler mechanism (delayed jobs vs due-scan), send-ledger schema (designed for Phases 5/6/7)
- Live-progress transport (polling vs SSE), unsubscribe-token crypto, RLS per established pattern

## Deferred Ideas

- Per-contact-timezone sending; workspace timezone setting
- Pause/resume mid-send (v1: cancel only); in-place edit of scheduled
- A/B testing, send-time optimization
- Per-campaign template-variable mapping UI
- Deferred (rather than skipped) frequency-capped sends — Phase 6/v2
- In-platform Dynamic Template preview (out of scope per PROJECT.md)
