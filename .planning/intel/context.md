# Context Intel

Topic-keyed notes from DOC-classified sources. All entries below:
source: docs/research/crm-platform-research.md (research-only; recommendations are
PROPOSED, evidence labeled [Confirmed]/[Inference] in the source).

---

## Topic: Anchor use case and baseline

"When a tracked entity approaches a known future date, send an email reminder before
that date" — a date-attribute countdown trigger, one scheduled send relative to a
per-profile date field. Baseline stack: SQL + SendGrid transactional. No CDP, no event
pipeline, no queue infrastructure. Bottom line (§1): the MVP is a thin,
safety-hardened scheduler over the existing SQL database, dispatching through the
existing SendGrid account, with a webhook listener for delivery outcomes.

## Topic: Industry pattern survey

Eight reference tools studied (Customer.io, Braze, Klaviyo, Segment, HubSpot,
Iterable, OneSignal, SendGrid Marketing Campaigns). All share ten concepts: profiles,
attributes, events, lists/segments, triggers, campaigns, broadcasts, journeys,
templates, suppression/consent (§2). The trigger taxonomy converges everywhere on the
same five-way union: segment/list entry, event, date attribute, API call, fixed
schedule. Events are present everywhere but required for date-based sending nowhere.

## Topic: Two implementation archetypes for date-countdown

Pattern A — first-class date trigger backed by a daily look-ahead scan (Klaviyo,
Customer.io, HubSpot). Pattern B — recurring scheduled job + "date within future
window" filter (Braze, Iterable). Pattern A internally reduces to B plus
re-evaluation hooks; for a SQL baseline it degenerates to a daily indexed date-range
query (§2). No reference tool implements date-countdown as segment membership (§9).

## Topic: Date-trigger vendor mechanics (design references)

- Klaviyo (richest reference): daily full scan run a day ahead + re-evaluation on date
  add/update/delete; no backfill on activation; revalidation before every action —
  changed date skips the queued send and reschedules (§10).
- Customer.io: ISO 8601/Unix date attributes; offset before/on/after; once/yearly/
  monthly with month-end clamping; zero/false default dates cause unwanted sends;
  late-set attributes miss the send (§10). [Medium confidence — see R9.]
- HubSpot: annual recurrence ignores year; enrollment begins next day; all times in
  account timezone (§10).
- Braze: no date trigger; needs ≥24h lead and ~2-day windows; double-filter
  awkwardness is a design lesson — express "N days before date" natively (§9).

## Topic: Three correctness invariants (synthesis in source, §10)

1. Re-verify date, eligibility, suppression, and campaign state immediately before
   send — reservations are soft, not immutable queue entries.
2. Dedup on (campaign, recipient/entity, occurrence key = matched date).
3. No silent activation backfill — explicitly pick a rule for dates already inside
   the window at go-live (HubSpot proceeds next-day; Klaviyo skips).

## Topic: Tracked-entity modeling rationale

Person-level scalar date attributes break at cardinality > 1 (one person, two dated
things: last-write-wins destroys one). The industry retrofitted first-class entities
(Customer.io Objects & Relationships, Klaviyo custom objects, HubSpot custom-object
enrollment); Braze's array-in-profile alternative is weakly validated (100 KB cap,
silent drop). In SQL the entity table is the native pattern; the trigger enrolls the
entity, so a person with three policies gets three reminders (§4, §8). Data
minimization: the send pipeline needs email, date, maybe timezone, consent state —
do not sync whole CRM objects into it.

## Topic: Portable concepts inherited from event-model research (§7)

Even with zero events: (1) idempotency keys on inbound writes (Segment messageId,
Klaviyo unique_id); (2) two timestamps — occurred-at vs. received-at; (3) design every
consumer order-insensitive. Do NOT add a speculative events table — an events table
without a consumer is dead weight. Two concepts to steal when a sync boundary appears:
Klaviyo backfill=true (historical loads must not fire triggers) and Braze UPDATED_AT
watermarks (§12).

## Topic: Deferral table (§6) — build-when conditions

Event pipeline → first behavioral trigger demanded. Segment engine → reusable
audiences across campaigns. Journey builder → validated multi-step branching need
(M4's reservation row is deliberately the future journey-instance). Broadcasts →
one-to-many announcements required. Identity resolution → anonymous tracking enters
product. Multi-channel → email loop proven. Reverse-ETL → a real system boundary.
Frequency-cap engine → multiple competing campaign types. Per-recipient timezone →
meaningfully multi-timezone audience. RBAC → non-builder operators. Analytics/A-B →
optimization becomes the bottleneck. Outbound webhooks → external consumers.
Preference center → second message category. Dedicated IP → ~50k/month. Multi-provider
→ a concrete second provider actually required.

## Topic: Risks (§16)

R1 accidental mass send (HBO Max incident happened on this exact provider) → M9 rails.
R2 double-sends from date edits/reruns → occurrence-keyed ledger + revalidation.
R3 timezone/DST off-by-one-day → dates as dates, pinned evaluation timezone.
R4 late-arriving dates silently miss the send → surface as a product decision, display
the cutoff. R5 transactional vs. marketing misclassification → decide consent posture
(Q2) before first send. R6 deliverability cold start → M10 before any real send.
R7 the cron-script trap (underbuild) → trigger/filter stored as declarative data.
R8 scope creep toward reference tools (overbuild) → every addition must cite a §6
build-when condition. R9 research confidence gaps — Customer.io and Iterable mechanics
rest on search-snippet extracts (fetch-blocked); re-verify the two load-bearing
Customer.io claims (late-attribute cutoff; monthly clamping) during design.
R10 GDPR exposure via logs → erasure workflow + retention policy from day one.

## Topic: Open questions Q1–Q9 (§17) — scope gates for the roadmapper

Q1 what is the tracked entity, concretely (decides person-attribute vs. entity-table
modeling and dedup keying). Q2 consent posture: transactional vs. marketing (day-one
fork in the send path). Q3 audience geography (which of C-07/C-08/C-09 are
launch-blocking). Q4 recurrence: one-shot vs. yearly (occurrence-key subtleties).
Q5 activation backfill rule (send immediately vs. skip to next cycle). Q6 who operates
this (config UI depth, when RBAC stops being deferrable). Q7 single- vs. multi-tenant.
Q8 expected volume and timezone spread (shared-IP choice, Gmail 5k/day threshold).
Q9 where date changes come from (sizes the re-trigger guard and anomaly detector).
Source's stated single next step: resolve Q1–Q9 (above all Q1 and Q2) in
docs/decisions/mvp-scope-decisions.md; roughly half the data model is blocked on
Q1 + Q2.

## Topic: Proposed future documents (cross-refs, not yet existing)

In dependency order (§18): docs/decisions/mvp-scope-decisions.md,
docs/design/trigger-lifecycle-spec.md, docs/design/data-model.md,
docs/policy/consent-and-compliance.md, docs/ops/send-safety-runbook.md.

## Topic: Sources

Primary vendor docs read directly (SendGrid/Twilio, Klaviyo, Braze, HubSpot,
OneSignal); Customer.io and Iterable via official-page search extracts (direct fetch
blocked — medium confidence on secondary details); Segment via docs mirror;
regulatory: FTC CAN-SPAM, Google/Yahoo bulk-sender rules, ICO PECR, CRTC CASL. Full
index in §19/Appendix of the source.
