---
phase: 13-compliance-analytics-integrity
plan: 10
subsystem: database
tags: [postgres, rls, drizzle, contacts, gdpr, erasure, bullmq, segments]

requires:
  - phase: 13-compliance-analytics-integrity
    provides: "13-08's setFactColumnOnce/incrementCampaignCounter (packages/db/src/sends/fact-columns.ts) and applyUnsubscribeWithSendFact (packages/contacts-core/src/unsubscribe-apply.ts), read for house style; not modified by this plan"
provides:
  - "contacts.anonymized_at column + erasure_records table (migration 0059), fail-closed RLS"
  - "deleteContact rewritten as anonymize-in-place: FOR UPDATE capture -> anonymizing UPDATE -> unconditional suppression insert -> erasure_records insert, one transaction, scrub job enqueued after commit"
  - "ERASURE_SCRUB_QUEUE contract (shared-schemas): erasureScrubJobSchema, buildErasureScrubJobPayload, buildErasureScrubJobId, SUPPRESSION_REASON_CONTACT_DELETED -- ready for plan 13-13's consumer and plan 13-15's second producer"
  - "anonymized_at IS NULL filter on every tenant-facing contacts read: list/count/detail, isEmailTaken, both contacts-core identity-lookup functions, segments-core's single compileSegmentDefinition predicate (covers segment reads, campaign audience materialization, and every flow trigger/exit-condition/enroll-existing/segment-sweep read), and dashboard growth counts"
affects: [13-12, 13-13, 13-15]

tech-stack:
  added: []
  patterns:
    - "Anonymize-in-place erasure: PII columns nulled, row + FKs retained, auditable erasure_records row written in the same transaction"
    - "Post-commit BullMQ enqueue via an injectable deps.enqueueErasureScrub seam, mirroring ProcessSendJobDeps's deps-default-{} convention"
    - "Single compiled-predicate fix (segments-core) propagates a filter to every consumer of a shared query-compilation function instead of patching call sites"

key-files:
  created:
    - packages/db/migrations/0059_contact_erasure.sql
    - packages/db/src/schema/erasure-records.ts
    - packages/db/src/__tests__/migration-0059-contact-erasure.test.ts
    - apps/api/src/modules/contacts/__tests__/contact-erasure.test.ts
    - packages/contacts-core/src/__tests__/upsert-anonymized.test.ts
  modified:
    - apps/api/src/modules/contacts/contact.repository.ts
    - apps/api/src/modules/contacts/contacts.routes.ts
    - apps/api/src/modules/contacts/__tests__/contact-crud.test.ts
    - apps/api/src/modules/contacts/__tests__/subscription-status.test.ts
    - apps/api/src/modules/contacts/__tests__/csv-import.test.ts
    - apps/api/src/modules/analytics/dashboard.repository.ts
    - packages/contacts-core/src/contact-repository.ts
    - packages/segments-core/src/compile.ts
    - packages/segments-core/src/__tests__/compile.test.ts
    - packages/shared-schemas/src/queues.ts
    - packages/db/src/schema/contacts.ts
    - packages/db/src/index.ts
    - packages/db/migrations/meta/_journal.json
    - packages/tenant-context/src/__tests__/tenant-context.test.ts

key-decisions:
  - "The plan's must_haves referred to a JSONB column named `attributes`; the actual schema column is `properties`. Confirmed by reading packages/db/src/schema/contacts.ts (Task 1). Every instruction referring to `attributes` was implemented against `properties`."
  - "[Rule 2] The plan's own text named only email/first_name/last_name/phone/external_id/attributes for scrubbing. Task 1's schema read surfaced four MORE personal-data columns on `contacts` that the plan never named: city, country, timezone, tags. Because T-13-10-01's threat disposition is `mitigate` against 'incomplete PII scrub', closing this gap is a correctness requirement, not scope creep -- deleteContact's anonymizing UPDATE nulls all of them (tags emptied to '{}', not null, since it is text[] NOT NULL)."
  - "buildErasureScrubJobId(erasureRecordId) returns the erasureRecordId UNCHANGED (no prefix/transform) -- mirrors eventsIngestJobSchema's eventId-as-jobId convention. Plan 13-15's reclaimer must call this exact function, not re-derive the id, to stay collision-compatible."
  - "updateContact's refusal on an anonymized row throws ContactConflictError with a new code 'contact_anonymized', which contacts.routes.ts's PATCH handler maps to 404 (not the class's usual 409) -- an anonymized contact must never be distinguishable from a genuinely deleted one at the wire (threat T-13-10-03's prohibition). The typed error/code still exists internally so the refusal is explicit rather than a silent zero-row UPDATE."
  - "The single highest-leverage fix for 'segment/audience reads exclude anonymized rows' was packages/segments-core/src/compile.ts's ONE compileSegmentDefinition base predicate, not per-call-site patches -- every segment count/list/point-check, campaign audience materialization (recipient-snapshot.ts), and flow trigger/exit-condition/enroll-existing/segment-sweep read compiles through this one function."
  - "deleteContact's atomicity-test seam is a NEW deps.beforeErasureRecordWrite hook (not named by the plan text, which only mandated an injectable enqueue seam) -- added because the plan's own 'injecting a failure into the erasure_records insert' acceptance criterion needs a controllable failure point inside the transaction, and this hook is the narrowest one that proves it without a Proxy-wrapped client (deleteContact opens its own transaction internally, so the unsubscribe-atomic.test.ts Proxy technique does not apply directly)."

patterns-established:
  - "Anonymize-in-place erasure (contacts): row and FKs retained, PII nulled, erasure_records is the auditable proof, enqueue happens strictly after commit"
  - "DeleteContactDeps: default-{} injectable dependency object for post-commit side effects and pre-write failure injection, mirroring ProcessSendJobDeps"

requirements-completed: [CMP-04]

coverage:
  - id: D1
    description: "Migration 0059 -- contacts.anonymized_at + erasure_records table, fail-closed RLS, unique-constraint coexistence proven for both email and external_id"
    requirement: "CMP-04"
    verification:
      - kind: unit
        ref: "packages/db/src/__tests__/migration-0059-contact-erasure.test.ts (12 tests)"
        status: pass
      - kind: unit
        ref: "packages/tenant-context/src/__tests__/tenant-context.test.ts (26-policy count)"
        status: pass
    human_judgment: false
  - id: D2
    description: "deleteContact rewritten as anonymize-in-place with unconditional suppression, erasure record, and post-commit scrub enqueue"
    requirement: "CMP-04"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/contact-erasure.test.ts (19 tests)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/subscription-status.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Every tenant-facing contacts/segment/audience/dashboard read excludes anonymized rows; re-import via create/CSV/shared-upsert produces a new contact that stays suppressed"
    requirement: "CMP-04"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/contact-crud.test.ts, csv-import.test.ts"
        status: pass
      - kind: unit
        ref: "packages/contacts-core/src/__tests__/upsert-anonymized.test.ts (5 tests)"
        status: pass
      - kind: unit
        ref: "packages/segments-core/src/__tests__/compile.test.ts (19 tests)"
        status: pass
    human_judgment: true
    rationale: "The plan's own <verify> names a human-check step (deleting a contact through the UI, confirming segment/audience/send-log behavior) that this executor cannot perform -- no live dev environment or browser available in this session."

duration: ~130min
completed: 2026-08-11
status: complete
---

# Phase 13 Plan 10: Contact Erasure -- Anonymize-in-Place Summary

**`deleteContact` now anonymizes contacts in place (nulls all PII, keeps the row and its foreign keys) inside one transaction with an unconditional workspace_suppressions write and an auditable `erasure_records` row, then enqueues a deterministic scrub job after commit; every tenant-facing contacts/segment/audience read now excludes anonymized rows.**

## Performance

- **Duration:** ~130 min (estimate; PLAN_START_TIME was not captured programmatically at session start)
- **Tasks:** 3 completed
- **Files modified:** 14 modified, 5 created

## Accomplishments

- Migration 0059: `contacts.anonymized_at` (nullable timestamptz, partial index) and `erasure_records` (fail-closed RLS, `sends_scrub_cursor`/`events_scrub_cursor` jsonb for plan 13-13), proven non-destructive against a pre-existing seeded row and proven to coexist/collide correctly on both `email` and `external_id` uniqueness.
- `deleteContact` rewritten: `SELECT ... FOR UPDATE` captures the pre-erasure email/status under a row lock -> anonymizing `UPDATE` nulls every PII-bearing column the schema actually has -> unconditional `workspace_suppressions` insert -> `erasure_records` insert (status `pending`) -- all one transaction -- then a deterministic `erasure-scrub` job is enqueued strictly after commit via an injectable `deps.enqueueErasureScrub` seam.
- `ERASURE_SCRUB_QUEUE`/`erasureScrubJobSchema`/`buildErasureScrubJobPayload`/`buildErasureScrubJobId`/`SUPPRESSION_REASON_CONTACT_DELETED` added to `packages/shared-schemas/src/queues.ts` as the two-producer (this plan + plan 13-15) contract plan 13-13 will consume.
- `anonymized_at IS NULL` propagated to every tenant-facing `contacts` read: `listContacts`, `getContact`, `updateContact`'s existing-row check (refuses via a new `ContactConflictError` code mapped to 404), `isEmailTaken`, both branches of `findContactIdByIdentity`/`upsertContactByIdentity` (`contacts-core`), `compileSegmentDefinition`'s one base predicate (covers segment reads, campaign audience materialization, and every flow read that compiles through it), and dashboard growth/cumulative counts.

## Task Commits

1. **Task 1: Erasure schema -- anonymized_at, erasure_records, and [BLOCKING] apply** - `82f63a8` (feat)
2. **Task 2: Rewrite deleteContact as anonymize-in-place with an erasure record and a scrub job** - `a5fda30` (feat)
3. **Task 3: Keep the API's delete semantics -- anonymized rows are invisible to tenant reads** - `ac2bffd` (feat)

_No TDD RED/GREEN split -- `type="auto" tdd="true"` tasks here wrote tests and implementation together per task, each task's own commit contains both; every task's `<verify>` command was run and is green (see Verification below)._

## Files Created/Modified

- `packages/db/migrations/0059_contact_erasure.sql` - contacts.anonymized_at + erasure_records table, fail-closed RLS
- `packages/db/src/schema/erasure-records.ts` - Drizzle type-inference file for erasure_records
- `packages/db/src/schema/contacts.ts` - anonymizedAt column added
- `packages/db/src/index.ts` - erasure-records.ts registered (no schema/index.ts exists in this repo)
- `packages/db/migrations/meta/_journal.json` - 0059 journal entry
- `packages/db/src/__tests__/migration-0059-contact-erasure.test.ts` - dedicated migration test (not in files_modified, mirrors migration-0056's precedent)
- `packages/tenant-context/src/__tests__/tenant-context.test.ts` - workspace_isolation policy count 25 -> 26
- `apps/api/src/modules/contacts/contact.repository.ts` - deleteContact rewrite, getContact/listContacts/updateContact filters, DeleteContactDeps
- `apps/api/src/modules/contacts/contacts.routes.ts` - contact_anonymized -> 404 mapping
- `apps/api/src/modules/contacts/__tests__/contact-erasure.test.ts` - 19 tests, the plan's own dedicated file
- `apps/api/src/modules/contacts/__tests__/contact-crud.test.ts` - list/count/create/update-anonymized cases
- `apps/api/src/modules/contacts/__tests__/subscription-status.test.ts` - flipped the still-subscribed-delete gate assertion
- `apps/api/src/modules/contacts/__tests__/csv-import.test.ts` - erased-address re-import dry-run case
- `apps/api/src/modules/analytics/dashboard.repository.ts` - growth counts exclude anonymized rows (Rule 2, not in files_modified)
- `packages/contacts-core/src/contact-repository.ts` - findContactIdByIdentity/upsertContactByIdentity/isEmailTaken filters
- `packages/contacts-core/src/__tests__/upsert-anonymized.test.ts` - the plan's own dedicated shared-package test
- `packages/segments-core/src/compile.ts` - single base-predicate filter
- `packages/segments-core/src/__tests__/compile.test.ts` - two leading-predicate assertions updated
- `packages/shared-schemas/src/queues.ts` - erasure-scrub queue contract + SUPPRESSION_REASON_CONTACT_DELETED

## Decisions Made

See `key-decisions` in frontmatter. Summarized:

1. **`attributes` -> `properties`.** The plan's must_haves/action text repeatedly says "attributes" for the freeform JSONB column; the real schema column is `properties`. Confirmed via Task 1's mandated schema read. No schema rename was needed or made -- every action was retargeted to the real column name.
2. **[Rule 2] Full-column scrub, not just the four named.** `city`, `country`, `timezone`, `tags` also hold personal data and are nulled/emptied by the anonymizing UPDATE, beyond the four the plan text named (email/first_name/last_name/phone) plus external_id/properties. This directly answers the plan's own `flagged_assumptions` obligation ("confirm no further PII-bearing column exists") with "no -- four more exist, now closed."
3. **`buildErasureScrubJobId` is the identity function over the erasure-record id.** No prefix, no transform -- matches `eventsIngestJobSchema`'s `eventId`-as-`jobId` precedent. Plan 13-15's reclaimer must call this exact export.
4. **`contact_anonymized` maps to 404, not 409.** `updateContact` throws a typed `ContactConflictError` (internal clarity), but the route collapses it to the same "Contact not found" response a genuinely absent contact gets -- required by threat T-13-10-03's "never presented to a tenant as a live contact" prohibition and the plan's "API's delete semantics are unchanged" truth.
5. **`compileSegmentDefinition`'s ONE base predicate**, not per-call-site patches, is what makes "segment/audience reads exclude anonymized rows" hold across `apps/api` (segments, recipient-snapshot) AND `apps/worker` (flow triggers, branch-node exit conditions, enroll-existing, segment-sweep) without visiting each file individually.
6. **`deps.beforeErasureRecordWrite`** (not named by the plan text) is a new failure-injection seam inside `deleteContact`'s transaction, added because the plan's own "inject a failure into the erasure_records insert" acceptance criterion needs a controllable point inside the transaction that `deps.enqueueErasureScrub` (a post-commit seam) cannot reach.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Anonymizing UPDATE scrubs city/country/timezone/tags, not just the four PII columns the plan text named**
- **Found during:** Task 1 (schema read) / Task 2 (deleteContact rewrite)
- **Issue:** The plan's `must_haves`/action text names only email/first_name/last_name/phone/external_id/attributes for scrubbing. `contacts` has four more personal-data columns (`city`, `country`, `timezone`, `tags`) that would have survived an erasure request untouched, leaving residual identifying data on a row the tenant believes is erased. T-13-10-01's threat disposition is `mitigate` against "incomplete PII scrub," making this a correctness gap, not a discretionary addition.
- **Fix:** `deleteContact`'s anonymizing UPDATE nulls `city`/`country`/`timezone` and empties `tags` to `'{}'` (it is `text[] NOT NULL`, so null would violate the column).
- **Files modified:** `apps/api/src/modules/contacts/contact.repository.ts`
- **Verification:** `apps/api/src/modules/contacts/__tests__/contact-erasure.test.ts`'s "[Rule 2] scrubs every PII-bearing column" test asserts all four column-by-column.
- **Committed in:** `a5fda30` (Task 2 commit)

**2. [Rule 2 - Missing critical functionality] Dashboard growth/cumulative contact counts also filtered**
- **Found during:** Task 3 (audit of contacts read paths)
- **Issue:** `apps/api/src/modules/analytics/dashboard.repository.ts`'s two growth queries counted `contacts` rows without excluding anonymized ones -- an erased contact would have permanently inflated the tenant's reported contact count, a data-quality leak analogous to the segment/audience leak the plan explicitly worried about, just in a file the plan's `files_modified` list did not name.
- **Fix:** Added `anonymized_at IS NULL` to both the daily-grouped and cumulative-baseline queries.
- **Files modified:** `apps/api/src/modules/analytics/dashboard.repository.ts`
- **Verification:** `apps/api/src/modules/analytics/__tests__/dashboard.test.ts` (3 tests, unchanged assertions, still green).
- **Committed in:** `ac2bffd` (Task 3 commit)

**3. [Rule 3 - Blocking] `packages/db` has no `schema/index.ts`**
- **Found during:** Task 1
- **Issue:** The plan's `files_modified` names `packages/db/src/schema/index.ts` for registering the new schema module, but no such file exists in this repository -- schema modules are registered directly in `packages/db/src/index.ts` (confirmed by wave context and by reading the file).
- **Fix:** Registered `erasure-records.ts` in `packages/db/src/index.ts` instead.
- **Files modified:** `packages/db/src/index.ts`
- **Verification:** `npm run test:migrations` (115 tests) and `cd packages/db && npx tsc --noEmit` both green.
- **Committed in:** `82f63a8` (Task 1 commit)

**4. [Rule 3 - Blocking] `packages/tenant-context`'s hardcoded workspace_isolation policy count**
- **Found during:** Task 1 (wave context explicitly flagged this)
- **Issue:** `packages/tenant-context/src/__tests__/tenant-context.test.ts` asserts "exactly 25 workspace_isolation policies" -- adding `erasure_records`' policy makes 26.
- **Fix:** Bumped the assertion and its explanatory comment to 26.
- **Files modified:** `packages/tenant-context/src/__tests__/tenant-context.test.ts`
- **Verification:** `npx vitest run --root packages/tenant-context` (25 tests, all pass).
- **Committed in:** `82f63a8` (Task 1 commit)

**5. [Rule 1 - Bug/stale test] `subscription-status.test.ts`'s pre-13-10 suppression-gate assertion inverted**
- **Found during:** Task 2 (plan's own read_first explicitly called this out as expected)
- **Issue:** "D-08: deleting a still-subscribed contact does NOT add its email to the suppression list" encoded the OLD conditional-suppression gate this plan removes (Codex BLOCKER finding 1). Left unchanged, it would have asserted the exact behavior CMP-04 exists to eliminate.
- **Fix:** Renamed and inverted the assertion: re-creating the erased still-subscribed contact's address now expects `suppressed`, not `subscribed`. Also updated a stale comment on the neighboring "unsubscribed" test that referenced the old "ONLY unsubscribed/suppressed trigger the suppression write" rule.
- **Files modified:** `apps/api/src/modules/contacts/__tests__/subscription-status.test.ts`
- **Verification:** `npx vitest run --root apps/api src/modules/contacts/__tests__/subscription-status.test.ts` (7 tests, all pass).
- **Committed in:** `a5fda30` (Task 2 commit)

---

**Total deviations:** 5 auto-fixed (2 missing-critical, 2 blocking, 1 bug/stale-test)
**Impact on plan:** All five were either compliance-correctness gaps the plan itself flagged as needing confirmation (deviations 1, 5) or structural facts about this repository the plan's file list got wrong (deviations 2, 3, 4). No scope creep beyond what CMP-04's own threat register already required.

## Issues Encountered

- **`DELETE FROM organization` cascade fails even for a real superuser.** Migration 0045 revoked ALL privileges on `invitation`/`member` from `mega_crm_app` (their owner); Postgres's FK cascade-enforcement trigger runs under the REFERENCING table's owner privileges regardless of the connecting role, so even the test harness's cluster superuser cannot cascade-delete through `organization`. This is a pre-existing, already-documented limitation (`reputation-and-ingestion-alert-state.test.ts` hit and documented the identical finding for `reputation_alert_state` in plan 13-09). Resolved by verifying `erasure_records.workspace_id`'s `ON DELETE CASCADE` at the `pg_constraint` catalog level (mirroring that file's own workaround) and proving the live cascade instead via `contact_id -> contacts(id)`, which carries no such restriction.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. Plan 13-13 (the scrub worker consuming `ERASURE_SCRUB_QUEUE`) and plan 13-15 (the reclaimer, second producer of the same queue) are future plans this plan's contract is built for, not stubs within this plan's own scope -- the enqueue happens for real, against a real BullMQ queue, and the `erasure_records` row it references is durable and queryable today even with no consumer yet running.

## Threat Flags

None beyond what this plan's own `<threat_model>` already registers (T-13-10-01 through T-13-10-09, all disposition `mitigate` or `accept`, all addressed by this plan's implementation). No new security-relevant surface was introduced outside that register.

## Next Phase Readiness

- **Plan 13-13** (scrub worker) can consume `ERASURE_SCRUB_QUEUE`/`erasureScrubJobSchema` directly; `erasure_records.sends_scrub_cursor`/`events_scrub_cursor` (jsonb) are ready for its resume-cursor writes, one page's UPDATE per transaction, per its own migration comment.
- **Plan 13-15** (reclaimer) must call `buildErasureScrubJobId(erasureRecordId)` (identity function over the erasure-record id) to stay collision-compatible with this plan's own enqueue, and can use `apps/api/src/modules/contacts/contact.repository.ts`'s `DeleteContactDeps.enqueueErasureScrub` seam as its own failure-injection precedent for the crash-after-commit-before-enqueue scenario.
- **Plan 13-12** (suppression column -> HMAC): every one of `workspace_suppressions`'s insert call sites now includes THIS plan's -- previously conditional, now unconditional -- erasure path, so 13-12's conversion touches the erasure path on every delete, not a rare branch.
- One deferred assertion, explicitly out of this plan's reach per its own `flagged_assumptions`: an already-enqueued send job for a contact that gets erased mid-flight is not interceptable by this plan; whether the pre-send suppression gate catches it depends on plan 13-12's suppression check running against the freshly written suppression row.

## Self-Check: PASSED

- FOUND: packages/db/migrations/0059_contact_erasure.sql
- FOUND: packages/db/src/schema/erasure-records.ts
- FOUND: packages/db/src/__tests__/migration-0059-contact-erasure.test.ts
- FOUND: apps/api/src/modules/contacts/__tests__/contact-erasure.test.ts
- FOUND: packages/contacts-core/src/__tests__/upsert-anonymized.test.ts
- FOUND commit 82f63a8 (Task 1)
- FOUND commit a5fda30 (Task 2)
- FOUND commit ac2bffd (Task 3)

---
*Phase: 13-compliance-analytics-integrity*
*Plan: 10*
*Completed: 2026-08-11*
