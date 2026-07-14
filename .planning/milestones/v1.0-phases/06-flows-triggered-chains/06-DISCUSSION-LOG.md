# Phase 6: Flows (Triggered Chains) - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-09
**Phase:** 6-Flows (Triggered Chains)
**Areas discussed:** Triggers & re-entry, Delays & quiet hours, Branches & exits, Lifecycle & versioning

---

## Triggers & re-entry

### Event trigger matching

| Option | Description | Selected |
|--------|-------------|----------|
| Event name only (Recommended) | Trigger fires on any event with the chosen name; property filters go to v2 alongside SEGM's (Phase 3 D-07 rationale) | ✓ |
| Name + property filters | Also filter on event properties; contradicts freeform-JSON/no-registry reality | |

### Segment-entry detection

| Option | Description | Selected |
|--------|-------------|----------|
| Periodic diff scan (Recommended) | Scheduled worker diffs segment vs stored snapshot; entry latency = scan interval | |
| Event-driven re-check | Every contact mutation re-checks trigger segments; near-instant but heavy | |
| Hybrid | Event-driven re-check for the changed contact + periodic sweep for time-based conditions | ✓ |

**Notes:** User chose the most-correct option over the simpler recommendation — time-based segment conditions only flip via sweep.

### "Once per N days" anchor

| Option | Description | Selected |
|--------|-------------|----------|
| From last entry (Recommended) | N days after last ENTRY; Klaviyo model | ✓ |
| From last exit/completion | Guaranteed gap between runs but unpredictable for the marketer | |

### Concurrent runs

| Option | Description | Selected |
|--------|-------------|----------|
| One active run per contact (Recommended) | Trigger during an active run is ignored | ✓ |
| Concurrent runs allowed | Literal "every time"; interleaved sequences read as spam | |
| Queue the trigger | Remembered trigger starts a run later; surprising timing | |

### Segment deletion while referenced by a flow

| Option | Description | Selected |
|--------|-------------|----------|
| Block deletion (Recommended) | Restrict-when-referenced, same pattern as campaigns (04-05) | ✓ |
| Allow with flow auto-pause | Background side effect violates "reliability visible to user" | |

### Existing segment members at publish

| Option | Description | Selected |
|--------|-------------|----------|
| Only new joins (Recommended) | No mass send on publish; existing members marked seen | |
| Backfill existing members | Everyone currently in segment enters at publish | |
| Ask at publish | Publish dialog offers to enroll N existing members | ✓ |

**Notes:** User chose flexibility over the safe default — publish dialog must show the count and make enrollment an explicit choice.

### Multiple triggers per flow

| Option | Description | Selected |
|--------|-------------|----------|
| Single trigger per flow (Recommended) | One trigger node (event OR segment-entry); two paths = two flows | ✓ |
| Multiple triggers | Converging triggers complicate re-entry and validation | |

### Unsubscribed/suppressed contacts at entry

| Option | Description | Selected |
|--------|-------------|----------|
| Enter, filter at send (Recommended) | Pre-send gate skips their emails; re-subscribe mid-flow resumes later sends | ✓ |
| Block at entry | Second subscription check that can drift from the send gate | |

---

## Delays & quiet hours

### Quiet-hours timezone source

| Option | Description | Selected |
|--------|-------------|----------|
| Workspace timezone (Recommended) | One workspace setting; consistent with Phase 4 D-06 deferral | |
| Per-contact timezone | Contact-level timezone; most correct for geo-spread bases | ✓ |

**Notes:** Deliberate deviation from the recommendation — quiet hours should be quiet for the RECIPIENT. Revisits the Phase 4 D-06 deferral for flows territory only.

### Timezone fallback & sourcing

| Option | Description | Selected |
|--------|-------------|----------|
| Workspace TZ fallback (Recommended) | New standard contact field `timezone` (UI/CSV/API, IANA-validated) + workspace default in send settings | ✓ |
| Platform default fallback | Fixed constant (UTC) surprises every tenant | |

### Quiet-hours configuration scope

| Option | Description | Selected |
|--------|-------------|----------|
| Per-flow, workspace default (Recommended) | Workspace default window; each flow overrides or disables | ✓ |
| Workspace-wide only | All-or-nothing across chain types | |
| Per-flow only | Repetitive setup, easy to forget | |

### Deferred-send release at window end

| Option | Description | Selected |
|--------|-------------|----------|
| Release at window end, throttled (Recommended) | Re-enqueue at window end; existing token bucket smooths the burst | ✓ |
| Jittered release | Extra scheduling logic the throttle already provides | |

---

## Branches & exits

### Condition-node vocabulary

| Option | Description | Selected |
|--------|-------------|----------|
| Segment membership only (Recommended) | isContactInSegment; one condition vocabulary platform-wide | ✓ |
| Inline conditions | Second condition dialect duplicated inside the canvas | |
| Segment + prior-email checks | Adds flow-local engagement checks this phase | |

### Exit-condition evaluation timing

| Option | Description | Selected |
|--------|-------------|----------|
| At step boundaries (Recommended) | Checked when a run wakes to act; no email ever wrong | ✓ |
| Continuously (event-driven) | Real-time ejection; requires active-run scanning wiring | |

### Exit-condition vocabulary

| Option | Description | Selected |
|--------|-------------|----------|
| Segment-based, flow-level (Recommended) | "In / no longer in segment X" only | |
| Event-based exits | "Event happened since run start" only | |
| Both | Segment-based AND event-since-entry | ✓ |

**Notes:** User chose expressiveness — both mechanisms built this phase.

### Delay-node flavors

| Option | Description | Selected |
|--------|-------------|----------|
| Fixed duration (Recommended) | Wait N minutes/hours/days | |
| Duration + wait-until | Also "until next 10:00 / until Monday" in the flow's TZ logic | ✓ |

**Notes:** User chose the richer option; DST/calendar math flagged for research/planning.

### Branch shape

| Option | Description | Selected |
|--------|-------------|----------|
| Binary yes/no (Recommended) | Two outgoing edges; multi-way composes by chaining | ✓ |
| Multi-way switch | Ordering semantics + harder validation | |

### Send node & publish validation

| Option | Description | Selected |
|--------|-------------|----------|
| Campaign-style config + strict publish (Recommended) | Template list (D-16), verified sender (D-17), standard dynamic_template_data (D-18); publish blocks hard errors incl. branch without exit node | ✓ |
| Minimal validation | Contradicts FLOW-01's explicit-exit criterion | |

---

## Lifecycle & versioning

### Pause semantics

| Option | Description | Selected |
|--------|-------------|----------|
| Freeze everything (Recommended) | No entries, no step execution; emergency-stop semantics | ✓ |
| Stop entries, drain in-flight | Bad email keeps going out | |
| Freeze + hold overdue | Explicit release choice on resume; more UI | |

### Live-edit model

| Option | Description | Selected |
|--------|-------------|----------|
| Single working draft (Recommended) | Auto-created from live on first edit; publish swaps atomically | ✓ |
| Explicit version list | Full version-management UX; too much surface for v1 | |

### Old-version visibility & intervention

| Option | Description | Selected |
|--------|-------------|----------|
| Count + eject only (Recommended) | "N in flow (M on older versions)" + remove-from-flow; no migration | ✓ |
| Visibility only | No answer for support scenarios | |
| Count + eject + finish-old | Bulk stop covered by pause + eject | |

### Permanent stop / delete

| Option | Description | Selected |
|--------|-------------|----------|
| Stop = pause; delete drafts only (Recommended) | No terminal state in v1; delete never-published or paused-with-zero-runs | ✓ |
| Add 'stopped' terminal state | Another state-machine branch this phase | |

### Overdue timers on resume

| Option | Description | Selected |
|--------|-------------|----------|
| Execute overdue immediately (Recommended) | Late but never skipped; throttled; quiet hours respected at dispatch | ✓ |
| Skip stale steps | Silent-skip heuristic hard to explain | |

### Roles & duplication

| Option | Description | Selected |
|--------|-------------|----------|
| Owner/Admin gate + duplicate (Recommended) | Publish/pause/resume/enroll Owner/Admin only; Members draft; duplicate = new draft copy | ✓ |
| Owner/Admin gate, no duplicate | Marginal scope saving on a near-free feature | |

---

## Claude's Discretion

- Flow definition/versions/runs/steps storage schema; RLS pattern; tenant context in workers
- Execution engine mechanics: BullMQ delayed jobs vs scheduler scan; reconciliation; step idempotency; jobId format
- Sweep interval and membership-snapshot structure; enroll-existing batching at scale
- Frequency-capped flow email: skip vs defer (Phase 4 D-14 marked deferral "Phase 6 territory") — decide at research/planning
- Canvas UX details (deferred to /gsd-ui-phase UI-SPEC); Russian UI copy
- IANA timezone validation and pickers; flows feature structure on the web; what run info to show this phase

## Deferred Ideas

- Event-property trigger filters — v2 (with EVNT-V2-01)
- "Opened/clicked previous email" branch conditions — v2
- Inline (segment-less) canvas conditions — v2
- Multi-way switch branches — v2
- Explicit version-list UI (history/rollback) — v2
- Terminal "stopped" state / flow archive — v2
- Bulk "finish all runs on old versions" — v2
- Continuous event-driven exit evaluation — v2
- Deferred sending for frequency-capped emails — open discretion question this phase
- A/B branches (FLOW-V2-01), canvas linting (FLOW-V2-02) — already tracked in REQUIREMENTS.md v2
