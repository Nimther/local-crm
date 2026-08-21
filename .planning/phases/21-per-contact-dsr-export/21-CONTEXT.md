# Phase 21: Per-Contact DSR Export - Context

**Gathered:** 2026-08-21
**Status:** Ready for planning

<domain>
## Phase Boundary

An Owner or Admin hands a data subject their own personal data in one action from the contact card: a machine-readable file scoped strictly to that contact in that workspace — profile, custom properties, consent history, events, and send-related personal data — containing no other subject's data. Requirements: DSR-01, DSR-02, DSR-03, DSR-04.

**Non-negotiable (locked by ROADMAP success criteria, not discussion):** Owner/Admin-only at both UI and API (SC3); cross-tenant contact id returns nothing, freeform JSONB reaches the file only through an explicit allowlist proven by a synthetic other-subject-field test (SC4); an already-erased contact gets a typed response, never a silently empty file (SC5).

**Scope limits:** per-contact export only — no bulk/workspace export, no self-service portal for data subjects, no async artifact storage. Phase 22 (purge) consumes this phase's PII inventory; the purge itself is out of scope here.

</domain>

<decisions>
## Implementation Decisions

### JSONB allowlist rule & PII inventory (DSR-03 — the ROADMAP-named plan-time decision)
- **D-01:** `events.properties` is **excluded entirely** from the export. Each event exports only its non-JSONB columns (name, occurred_at, and similar row metadata). This mirrors the Phase 13 erasure ruling verbatim (`buildScrubbedEventProperties` returns `{}`): the entire keyspace is tenant-supplied at ingestion, so no allowlist over it can be defended — a tenant could put another subject's email under any key name. What erasure can't defend keeping, export can't defend disclosing.
- **D-02:** `send_events.payload` passes through an **extended export allowlist**: the 9 existing evidence keys (`SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST`: event, type, timestamp, sg_event_id, sg_message_id, smtp-id, status, attempt, asm_group_id, bounce_classification) PLUS the subject's own single-recipient fields: `ip`, `useragent`, `url`, `reason`. Rationale: on a per-recipient send event these are THIS subject's personal data — a DSR answer without them is incomplete. The export list is a strict superset of the evidence list (export ⊇ evidence, relationship documented and test-asserted); tenant-defined keys (unique_args, categories, marketing_campaign_*) stay out. Both lists are explicit **build-up** allowlists (construct a new object copying only named keys — never tear keys out of the input), matching `buildScrubbedSendEventPayload`'s construction.
- **D-03:** Allowlist constants move into a **shared package** importable by both `apps/api` (export) and `apps/worker` (erasure scrub) — single definition, no copy-drift — and this phase writes a **PII inventory** (SPECIFICATION.md section or dedicated doc) enumerating per-table what counts as the contact's personal data. Phase 22's purge consumes both the shared constants and the inventory. — **Reversibility:** costly — Phase 22 is explicitly designed against this shared definition; moving or forking it later re-opens the export/purge divergence the ROADMAP forbids.
- **D-04:** Table scope includes **journey tables**: `flow_runs`/`flow_run_steps` (which automations processed this person, when) and `campaign_recipients` (which campaigns targeted them) — processing history is personal data under GDPR Art. 15. Infrastructure rows are excluded **with documented reasons in the inventory**: `suppressions` (HMAC-hashed, no plaintext to return), `send_event_quarantine`, `erasure_records` (relevant only post-erasure), checkpoints/plumbing.

### File format & structure
- **D-05:** Single JSON document with top-level sections: `metadata`, `profile`, `custom_properties`, `consent_history`, `events`, `sends` (with nested send_events), `flow_participation`, `campaign_memberships`. One HTTP response; allowlist compliance testable against the whole document. — **Reversibility:** costly — the document shape is a published artifact handed to outside parties; format changes after ship need the format version bump (D-06).
- **D-06:** `metadata` block carries full provenance: `generated_at`, workspace id + name, contact id, **export format version**, allowlist version/name, and per-section row counts (lets anyone verify nothing was truncated). Requester identity is deliberately NOT embedded in the file (an employee's identity must not land in a file handed to an outside party — the audit trace lives server-side, D-11).
- **D-07:** Field naming follows the existing camelCase API convention (`occurredAt`, `subscriptionStatus`); export schemas extend existing `packages/shared-schemas` types where they exist.
- **D-08:** Download filename contains IDs only, no PII: `dsr-export-{contactId}-{YYYY-MM-DD}.json` (filenames leak into browser history, download folders, screenshots).

### Delivery mechanics
- **D-09:** **Synchronous download**: one authenticated request → the route assembles the document via keyset-paginated reads → response with `Content-Disposition: attachment`. No new queues, no artifact storage, no polling UI.
- **D-10:** **Complete, no truncation**: every section is keyset-paginated to completion in bounded pages (follow the erasure-scrub 500-row page precedent). A truncated DSR file is a compliance defect; memory stays bounded by page size, and per-contact volume is naturally small.
- **D-11:** Export leaves a **structured Pino log line** (requester user id, workspace, contact id, section counts) through the existing correlation/observability pipeline into Loki. No new audit table this phase (a durable `dsr_export_records` table was considered and deliberately deferred — see Deferred Ideas).
- **D-12:** UI trigger is **fetch + blob with states**: the Export button on the contact card fires an authenticated fetch, shows an in-progress state, saves the response as a file on success, and renders typed errors inline (role refusal, erased contact, failure) — consistent with the app's mutation patterns; plain `<a href>` navigation rejected because error responses would render as raw JSON in a tab instead of a typed in-app state.

### Erased-contact & edge states (SC5)
- **D-13:** Export of an anonymized contact returns a **typed status, no file**: HTTP 410 with body carrying code `contact_erased`, `erasedAt`, and an erasure-record reference. Honest GDPR answer: the personal data no longer exists and the response says so. Never a file of empty shells that could be mistaken for a real DSR answer.
- **D-14:** On an erased contact's card the Export button is **visible but disabled with inline reason copy** («Контакт обезличен — персональные данные удалены») — extends the established `computeIncompleteReason` disabled-button-with-inline-copy pattern (Phase 20 D-01 analog). The typed 410 remains the API backstop for races (erased after page load).
- **D-15:** **`contacts.anonymizedAt` is the erasure gate**, checked inside the same transaction that reads the export data. Fail-closed: any non-null `anonymizedAt` → typed 410 immediately, even while the asynchronous scrub worker is still sweeping pages — a mid-scrub export can never ship half-scrubbed payloads of a person who asked to be forgotten.
- **D-16:** Refusal shapes follow existing patterns exactly: Member → **403** via the existing `requirePermission` role-guard (D-19 pattern in `role-guard.ts`); cross-tenant or nonexistent contact id → the same `NOT_FOUND_BODY` **404** used across the codebase, so an outsider cannot distinguish "exists in another workspace" from "doesn't exist".

### Claude's Discretion
- Exact HTTP route path/verb, zod schema details, error body field names beyond the typed codes above.
- Section ordering inside the JSON document, timestamp serialization format, exact pagination page size (500-row precedent suggested, not mandated).
- Where the shared allowlist package lives (extend an existing package like `contacts-core`/`delivery-core` vs a new compliance module) — follow monorepo conventions.
- Whether the PII inventory is a SPECIFICATION.md section or a dedicated doc — whichever fits the SPECIFICATION.md same-change rule cleanly.
- Test harness choices for the SC4 synthetic other-subject-field proof and the cross-tenant negative test.
- Exact placement/copy of the Export button and states on `ContactDetailPage`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — DSR-01..DSR-04 («DSR Contact Data Export» section)
- `.planning/ROADMAP.md` — Phase 21 section: goal, 5 success criteria, the DSR-03 plan-time decision note, dependency note toward Phase 22

### The allowlist precedent (the single most important code ref)
- `apps/worker/src/queues/erasure-scrub.worker.ts` — `SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST` (9 keys, D-02's base set), `buildScrubbedSendEventPayload` (build-up construction D-02 must copy), `buildScrubbedEventProperties` (the "events.properties is un-allowlistable" ruling D-01 rests on), `ERASURE_SCRUB_PAGE_LIMIT = 500` (D-10 pagination precedent)

### As-built documentation to update in the same change
- `SPECIFICATION.md` §6 «Публичные точки входа» — the new export route + typed error contracts; §4 if any schema changes; the PII inventory lands here or as a dedicated doc (D-03, discretion)
- `.claude/CLAUDE.md` — "Project Specification" section defines the same-change documentation rule

### Backend (route, guard, data access)
- `apps/api/src/middleware/role-guard.ts` — `requirePermission` (D-19 pattern) for the Owner/Admin gate (D-16)
- `apps/api/src/modules/tenancy/resolve-workspace-member.ts` — `NOT_FOUND_BODY` anti-enumeration shape (D-16)
- `apps/api/src/modules/contacts/contacts.routes.ts` + `contact.repository.ts` — the module the export route joins; existing contact read patterns
- `packages/db/src/schema/contacts.ts` — `anonymizedAt` (D-15 gate)
- `packages/db/src/schema/subscription-status-history.ts` — consent history table (append-only, one row per subscription_status transition)
- `packages/db/src/schema/erasure-records.ts` — erasure-record reference returned in the 410 body (D-13)
- `packages/db/src/schema/` — `events.ts`, `sends.ts`, `send-events.ts`, `flow-runs.ts`, `flow-run-steps.ts`, `campaign-recipients.ts` — the inventoried tables (D-04)

### Frontend
- `apps/web/src/features/contacts/ContactDetailPage.tsx` — where the Export button, states, and typed-error rendering land (D-12, D-14)
- `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx` — `computeIncompleteReason` disabled-button-with-inline-copy pattern D-14 extends

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST` + `buildScrubbedSendEventPayload` (erasure-scrub.worker.ts): the export payload builder is the same build-up construction with 4 more keys; D-03 moves the constants to a shared package so both import one definition
- `requirePermission(resource, action)` role guard: the Owner/Admin gate is a one-line reuse
- `NOT_FOUND_BODY` from resolve-workspace-member: the anti-enumeration 404 shape
- `subscription_status_history` table: consent history section reads it directly — no new tracking needed
- `erasure_records` table + `contacts.anonymizedAt`: everything the 410 typed response needs already exists
- Keyset pagination precedents: erasure scrub (500-row pages) and flow-segment sweep walk the same partitioned tables the export must read
- `computeIncompleteReason` disabled-button pattern + amber notice styling (Phase 20): the erased-state UI copy shape

### Established Patterns
- Zod schemas in `packages/shared-schemas` shared between route validation and client — export response typing follows this path (D-07)
- RLS + `withTenant` transaction scoping on every tenant read — the export queries run inside it; RLS is defense-in-depth for SC4's cross-tenant proof, role check is separate (role-guard.ts comment: "RLS scopes by workspace, not by role")
- SPECIFICATION.md same-change documentation rule for new routes (§6)
- Structured Pino logging with correlation ids (Phase 15) — D-11's audit log line rides it
- Only existing `Content-Disposition` precedent is in `csv-import.routes.ts` — check its shape before writing the download response

### Integration Points
- `ContactDetailPage.tsx` — the UI seam; the page already knows the contact row (including anonymizedAt) so the disabled state costs nothing extra
- `apps/api/src/modules/contacts/` — the export route joins the existing contacts module and its guard chain
- Shared allowlist package touches `apps/worker` imports — the erasure worker's tests must keep passing unchanged after the constants move (pure relocation, no behavior change)
- Phase 22 dependency: the PII inventory + shared constants are consumed by purge planning — write them as artifacts Phase 22 can cite, not inline comments

</code_context>

<specifics>
## Specific Ideas

- The user consistently chose the compliance-honest option over the convenient one: complete-or-refuse over truncation, typed-410-no-file over an empty-shell file, fail-closed anonymizedAt gate over scrub-completion checks, no PII in filenames, no requester identity inside the artifact. Planner should resolve micro-ambiguities in the same direction — honest and fail-closed over convenient.
- The export ⊇ evidence allowlist relationship (D-02) should be asserted by a test, not just documented — divergence between the two lists is exactly the Phase 22 risk the ROADMAP names.

</specifics>

<deferred>
## Deferred Ideas

- **Durable DSR export audit table** (`dsr_export_records`, mirroring `erasure_records`) — durable proof of who exported whose data that outlives log retention. Considered at D-11 and deliberately deferred: no DSR-* requirement asks for it; revisit if a compliance requirement for export evidence emerges (natural companion to Phase 22's evidence discipline).

</deferred>

---

*Phase: 21-Per-Contact DSR Export*
*Context gathered: 2026-08-21*
