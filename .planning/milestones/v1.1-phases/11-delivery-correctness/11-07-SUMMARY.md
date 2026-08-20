---
phase: 11-delivery-correctness
plan: 07
subsystem: delivery
tags: [sendgrid, webhooks, provisioning, reconciler, event-normalize]

# Dependency graph
requires:
  - phase: 11-delivery-correctness (11-01/11-02/11-03/11-06)
    provides: "reconciling/unknown enum + reconciliation columns, send-reconciler.worker.ts's evidence-based resolveOneSend (ANY correlated send_events row, not processed specifically), both send paths landing ambiguous outcomes in reconciling"
provides:
  - "EVENT_FLAGS.processed: true at both the CREATE and PATCH provisioning spread sites (sendgrid-webhook-provision.ts) -- primary acceptance evidence for the reconciler, arriving within seconds instead of delivered's minutes-to-hours lag"
  - "Proof that processed ingestion is evidence-only: one send_events row, sends.status/fact-columns/counters/suppressions/subscription_status_history all unchanged, replay-deduped, unmatched send_id still stored with null FK -- and that a processed row against a reconciling send lets runReconcilerTick() resolve it to sent"
  - "docs/runbooks/reprovision-webhook-event-types.md -- the operator procedure for bringing an already-connected tenant's subscription forward (no automatic backfill exists)"
affects: [11-08 (unknown-horizon resolution and stale-dispatching sweep will resolve rows against the same evidence set, now including processed), phase-15 (webhook-lag alert benefits from processed's faster evidence arrival)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "A webhook event type can be added to the provisioned subscription and proven evidence-only WITHOUT touching normalizeEventType or the ingestion worker's side-effect ordering -- the raw send_events INSERT already runs before the normalizedType===null skip, so a new out-of-scope event type is stored by construction the moment it starts arriving"

key-files:
  created:
    - apps/api/src/modules/webhooks/__tests__/webhook-provision-event-flags.test.ts
    - apps/worker/src/queues/__tests__/webhook-events-processed.test.ts
    - docs/runbooks/reprovision-webhook-event-types.md
  modified:
    - apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts
    - SPECIFICATION.md

key-decisions:
  - "No production code change was needed in packages/delivery-core/src/event-normalize.ts or apps/worker/src/queues/webhook-events.worker.ts for Task 2 -- normalizeEventType already returned null for 'processed' (out of WBHK-02's original scope) and the raw send_events INSERT already ran before the per-row normalizedType===null skip. Task 2 is a regression-proof test file plus documentation, not a behavior change; this matches the plan's own read_first note verbatim."
  - "The parity assertion in webhook-provision-event-flags.test.ts compares the captured CREATE and PATCH bodies against EACH OTHER (filtering out enabled/url/friendly_name, the three non-flag fields), not against two independently hand-written flag lists -- a future edit to one spread site without the other fails this test directly, rather than only failing if someone remembers to update a second literal list."
  - "The runbook documents both provisioning entry points that reach the chokepoint (webhook-reconnect AND sendgrid-key/recheck) as equally valid, since both call provisionEventWebhook identically -- there is no preferred one."

patterns-established:
  - "A deliberately out-of-scope event type (normalizeEventType returning null) is still stored as raw evidence -- this is not a special case to build, it already falls out of the existing insert-then-conditionally-apply-side-effects ordering. Proving it with a comment-annotated regression test (rather than silently relying on it) is the pattern this plan sets for any future event type added to EVENT_FLAGS without a corresponding fact column."

requirements-completed: [DLV-03]

coverage:
  - id: D1
    description: "EVENT_FLAGS contains processed: true (first key) and no deferred key, at both the CREATE and PATCH provisioning spread sites, with every previously-enabled flag (delivered/bounce/dropped/open/click/unsubscribe/group_unsubscribe/spam_report) still true -- no regression to the Phase 5 subscription"
    requirement: "DLV-03"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-provision-event-flags.test.ts (5 cases: CREATE processed+no-deferred, PATCH processed+no-deferred, CREATE regression check, PATCH regression check, CREATE/PATCH parity-by-comparison)"
        status: pass
      - kind: other
        ref: "grep -c \"processed: true\" sendgrid-webhook-provision.ts == 1; node -e regex check for a bare `deferred:` key == exit 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "Ingesting a processed event correlated to a real send inserts exactly one send_events row (event_type='processed', non-null send_id), leaves sends.status/all seven fact columns/open_count/click_count/suppressions/subscription_status_history entirely unchanged, dedupes on replay, and still stores (with a null FK) when the send_id matches no row -- normalizeEventType and the ingestion worker's ordering are unchanged"
    requirement: "DLV-03"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-events-processed.test.ts (5 of 6 cases: basic-insert/status-unchanged, facts+counters null/zero, no-suppression/no-history, replay-dedup, orphan-send-id)"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-events-status.test.ts, webhook-events-idempotency.test.ts, webhook-events-attribution.test.ts, webhook-events-sibling-drop.test.ts (regression, unaffected by this plan's changes)"
        status: pass
    human_judgment: false
  - id: D3
    description: "After a processed row exists for a send in reconciling, one runReconcilerTick() resolves that send to sent -- the seam between webhook evidence arriving and the classification-only reconciler acting on it"
    requirement: "DLV-03"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-events-processed.test.ts#after a processed row exists for a send in reconciling, one runReconcilerTick() resolves that send to sent"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-reconciler-tracer.test.ts (regression, unaffected)"
        status: pass
    human_judgment: false
  - id: D4
    description: "docs/runbooks/reprovision-webhook-event-types.md names the recheck/reconnect routes by path, explains what changes on the SendGrid side, states plainly that no automatic backfill exists, and documents that a not-yet-reprovisioned tenant degrades to slower (not broken) resolution because the reconciler accepts ANY correlated send_events row as evidence"
    requirement: "DLV-03"
    verification:
      - kind: other
        ref: "grep for /api/workspaces/:slug/webhook-reconnect and /api/workspaces/:slug/sendgrid-key/recheck in the runbook file -- both present"
        status: pass
    human_judgment: false

# Metrics
duration: ~35min
completed: 2026-08-09
status: complete
---

# Phase 11 Plan 07: Provision the SendGrid `processed` event as faster reconciler evidence Summary

**`EVENT_FLAGS` gains `processed: true` (excluding `deferred` by explicit decision) on both the CREATE and PATCH provisioning paths, proven evidence-only end to end -- one `send_events` row, zero status/fact/counter/suppression side effects, and a demonstrated hand-off into `runReconcilerTick()` resolving a `reconciling` send to `sent` -- with an operator runbook for the existing tenants this change does not reach automatically.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-08-09
- **Tasks:** 2
- **Files modified:** 5 (3 created, 2 modified)

## Accomplishments

- `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts`'s `EVENT_FLAGS` const now leads with `processed: true`, with an inline comment naming the reconciler and the seconds-vs-hours evidence-latency rationale, and a trailing comment stating why `deferred` is deliberately absent. `provisionEventWebhook`'s doc comment gained a paragraph making the chokepoint consequence explicit: an existing tenant only picks this flag up on their next connect/recheck/reconnect pass, pointing at the new runbook.
- `webhook-provision-event-flags.test.ts` (5 cases): CREATE and PATCH bodies both carry `processed: true` and no `deferred` key; every one of the eight previously-enabled flags survives unchanged on both paths; a dedicated parity assertion compares the two captured bodies' flag sets against EACH OTHER (not two hand-written literal lists), so the two spread sites structurally cannot drift apart undetected.
- `webhook-events-processed.test.ts` (6 cases, driven directly through `processWebhookEventBatch` against live Postgres): a `processed` event correlated to a real send stores exactly one `send_events` row and leaves `sends.status`, all seven fact columns, `open_count`/`click_count`, `workspace_suppressions`, and `subscription_status_history` completely untouched; a replayed identical batch inserts no second row; an event whose `send_id` matches nothing is still stored with a null FK and throws nothing; and -- the seam proof -- once a `processed` row exists for a send sitting in `reconciling`, a single `runReconcilerTick()` resolves it to `sent`.
- **No production code changed for Task 2.** `packages/delivery-core/src/event-normalize.ts`'s `normalizeEventType` already returned `null` for `"processed"` (out of WBHK-02's original scope, unchanged by this plan), and `webhook-events.worker.ts`'s raw `send_events` INSERT already ran for every event in a batch before the per-row `normalizedType === null` skip that gates side effects. This plan's test file proves that pre-existing ordering is exactly what makes `processed` a safe, evidence-only addition -- it does not add new behavior to make it safe.
- `docs/runbooks/reprovision-webhook-event-types.md`: names both provisioning entry points an operator/tenant can use (`POST /api/workspaces/:slug/webhook-reconnect` and `POST /api/workspaces/:slug/sendgrid-key/recheck`), states plainly that no automatic backfill exists anywhere in the codebase, explains what does and does not change on the SendGrid side (in-place PATCH, no resend, no key/URL rotation), gives two ways to confirm it worked (direct SendGrid API check, or observing a `processed` row appear after a fresh send), and documents the accepted degraded-not-broken failure mode for tenants who are never reprovisioned.
- `SPECIFICATION.md` gained §5.11 (the `EVENT_FLAGS` event-type list, the `deferred` exclusion rationale, the evidence-only ingestion mechanism with the exact ordering that makes it safe, and the no-automatic-backfill fact) and a one-line pointer from §6.8 (the webhook ingest route section) to §5.11, since the ingest route and the provisioned subscription are two different concerns living in two different files.

## Task Commits

1. **Task 1: Provision the `processed` event, exclude `deferred`, on both create and patch** - `cb2cfa6` (feat)
2. **Task 2: `processed` ingestion is evidence and nothing else** - `402a85d` (test)

**Plan metadata:** pending (this commit)

## Files Created/Modified

- `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` - `EVENT_FLAGS.processed: true`, `deferred`-exclusion comment, chokepoint doc-comment addition
- `apps/api/src/modules/webhooks/__tests__/webhook-provision-event-flags.test.ts` - new, covers every Task 1 `<behavior>` item
- `apps/worker/src/queues/__tests__/webhook-events-processed.test.ts` - new, covers every Task 2 `<behavior>` item, drives `processWebhookEventBatch` and `runReconcilerTick` against live Postgres
- `docs/runbooks/reprovision-webhook-event-types.md` - new, operator procedure for bringing an existing tenant's subscription forward
- `SPECIFICATION.md` - new §5.11 (provisioned event-type set), one-line pointer added to §6.8

## Decisions Made

See `key-decisions` in frontmatter. In short: Task 2 required no production code change because the existing ingestion ordering (raw INSERT before the normalized-type side-effect gate) already made `processed` evidence-only by construction -- this plan proves that fact with a regression test rather than building anything new; the CREATE/PATCH parity assertion is structural (bodies compared to each other) rather than convention-based (two independent literal lists); and the runbook treats both provisioning-triggering routes as equally valid since they reach the identical chokepoint function.

## Deviations from Plan

None - plan executed exactly as written. Task 2's "no production code change" is not a deviation -- the plan's own `<read_first>` and `<action>` text explicitly anticipated and named this ("Do not change `normalizeEventType`... this plan does not change that").

## Issues Encountered

None.

## Known Stubs

None.

## Threat Flags

None -- every new surface this plan introduces is already covered by this plan's own `<threat_model>` (T-11-07-01 through T-11-07-05), and no threat there is left unmitigated:
- T-11-07-01 (Tampering, tenant webhook subscription) -- mitigated: the CREATE/PATCH parity test asserts a reconnect cannot silently drop a previously-enabled event type; all eight pre-existing flags are asserted still true on both paths.
- T-11-07-02 (DoS, send_events volume) -- mitigated: `deferred` is asserted absent via both the test suite and a mechanical grep-based acceptance check; `processed` adds roughly one row per send into the already-partitioned `send_events` table.
- T-11-07-03 (Spoofing, forged processed event) -- unchanged and already closed upstream (ECDSA signature verification before parsing, RLS-scoped `send_id` correlation); this plan adds an event type to an already-authenticated channel, not a new channel.
- T-11-07-04 (Information Disclosure, provisioning error logs) -- unchanged; no new log site was added.
- T-11-07-05 (Repudiation, tenants not reprovisioned) -- accepted per D-06 and documented explicitly in both the runbook and SPECIFICATION.md §5.11: the reconciler already accepts ANY correlated `send_events` row as evidence (verified pre-existing in `send-reconciler.worker.ts`'s `resolveOneSend`, not changed by this plan), so the failure mode for a skipped reprovisioning is slower resolution, never incorrect resolution.

## User Setup Required

None - no external service configuration required. The runbook documents an OPERATOR procedure (reprovisioning existing tenants) that is optional and self-serve via the existing UI, not a setup step blocking this plan's completion.

## Next Phase Readiness

- The reconciler's evidence set now includes `processed` for every newly-connected or freshly-reconnected/rechecked tenant, arriving within seconds instead of `delivered`'s minutes-to-hours lag -- no further plumbing needed on the reconciler side, since `resolveOneSend`'s `SELECT 1 FROM send_events WHERE send_id = $1 LIMIT 1` already treats any evidence row as sufficient (built in 11-03, unchanged here).
- Existing tenants remain on the pre-11-07 event set until they pass through connect/recheck/reconnect again -- this is the accepted, documented state (D-06/T-11-07-05), not a gap 11-08 needs to close. 11-08's `unknown`-horizon and stale-`dispatching` sweep work resolves against the same evidence set this plan just enriched, with no dependency on every tenant having been reprovisioned first.
- No stub was left where a decision belongs: the "no automatic backfill" fact is documented as the accepted mechanism in three places (this plan's threat register, the runbook, and SPECIFICATION.md §5.11), not left implicit.

## Self-Check: PASSED

- FOUND: apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts (EVENT_FLAGS.processed, deferred-exclusion comment)
- FOUND: apps/api/src/modules/webhooks/__tests__/webhook-provision-event-flags.test.ts
- FOUND: apps/worker/src/queues/__tests__/webhook-events-processed.test.ts
- FOUND: docs/runbooks/reprovision-webhook-event-types.md
- FOUND: SPECIFICATION.md §5.11
- FOUND commit: cb2cfa6 (Task 1)
- FOUND commit: 402a85d (Task 2)

---
*Phase: 11-delivery-correctness*
*Completed: 2026-08-09*
