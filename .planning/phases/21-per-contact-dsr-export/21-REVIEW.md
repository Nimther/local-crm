---
phase: 21-per-contact-dsr-export
reviewed: 2026-08-22T13:31:54Z
depth: standard
files_reviewed: 27
files_reviewed_list:
  - apps/api/src/__tests__/negative-cross-tenant.test.ts
  - apps/api/src/modules/auth/access-control.ts
  - apps/api/src/modules/contacts/__tests__/contact-crud.test.ts
  - apps/api/src/modules/contacts/__tests__/dsr-export-isolation.test.ts
  - apps/api/src/modules/contacts/__tests__/dsr-export.test.ts
  - apps/api/src/modules/contacts/contact.repository.ts
  - apps/api/src/modules/contacts/contacts.routes.ts
  - apps/api/src/modules/contacts/dsr-export.repository.ts
  - apps/api/src/modules/contacts/dsr-export.routes.ts
  - apps/api/src/server.ts
  - apps/web/src/features/contacts/__tests__/contact-dsr-export.test.tsx
  - apps/web/src/features/contacts/ContactDetailPage.tsx
  - apps/worker/src/queues/erasure-scrub.worker.ts
  - docs/PII-INVENTORY.md
  - packages/db/migrations/0067_dsr_export_contact_indexes.sql
  - packages/db/migrations/meta/_journal.json
  - packages/db/src/__tests__/migration-empty-diff.test.ts
  - packages/db/src/__tests__/migration-rollback-rehearsal.test.ts
  - packages/db/src/__tests__/migration-tiers.test.ts
  - packages/db/src/migration-tiers.ts
  - packages/delivery-core/src/__tests__/send-event-payload-allowlist.test.ts
  - packages/delivery-core/src/index.ts
  - packages/delivery-core/src/send-event-payload-allowlist.ts
  - packages/shared-schemas/src/contact.ts
  - packages/shared-schemas/src/dsr-export.ts
  - packages/shared-schemas/src/index.ts
  - packages/tenant-context/src/index.ts
findings:
  critical: 0
  warning: 4
  info: 3
  total: 7
status: issues_found
---

# Phase 21: Code Review Report

**Reviewed:** 2026-08-22T13:31:54Z
**Depth:** standard
**Files Reviewed:** 27
**Status:** issues_found

## Summary

This phase adds a per-contact GDPR Art. 15 export route (`GET .../contacts/:id/dsr-export`), a keyset-paginated eight-section document builder, a shared JSONB disclosure allowlist (`@mega-crm/delivery-core`) consumed by both the export and the pre-existing erasure-scrub worker, a REPEATABLE READ transaction helper for snapshot consistency, migration 0067's three contact-scoped indexes, and the contact-card UI's disabled-export-on-erasure affordance.

The core security properties hold up under adversarial reading: every keyset-paginated reader is scoped by `workspace_id` (or reaches the contact only through an id list that was itself workspace/contact-scoped), the `anonymized_at` fail-closed gate is the first read inside the REPEATABLE READ snapshot (confirmed correct by the isolation test's real interleaved-scrub proof), the export/erasure allowlists are provably a superset/subset pair via a dedicated test, cross-tenant 404 byte-identity is asserted end-to-end, and keyset cursors round-trip timestamps as `::text` (avoiding the millisecond-truncation bug the erasure worker had to fix historically) so no page can skip or duplicate rows. No BLOCKER-tier defect was found: no cross-tenant data leak, no PII-allowlist bypass, no SQL injection, and no broken fail-closed ordering.

Four WARNING-tier and three INFO-tier issues are recorded below — mostly quality/consistency gaps (a timestamp-format inconsistency inside the export document itself, a missing defense-in-depth filter on one join that every sibling query in the same file otherwise includes, a documentation/implementation drift in `docs/PII-INVENTORY.md`, and an unenforced allowlist-version marker) plus three minor dead-code/redundancy/naming observations.

## Warnings

### WR-01: DSR export document mixes two different timestamp text formats

**File:** `apps/api/src/modules/contacts/dsr-export.repository.ts:508-669`
**Issue:** `metadata.generatedAt` and `profile.createdAt`/`profile.updatedAt` are produced via JS `Date.prototype.toISOString()` (`2026-08-22T13:31:54.000Z` — RFC3339/ISO-8601, `T` separator, `Z` suffix). Every other timestamp in the same document — `consentHistory[].changedAt`, `events[].occurredAt`/`receivedAt`, `sends[].queuedAt`/`sentAt`/... , `sends[].sendEvents[].occurredAt`/`receivedAt`, `flowParticipation[].enteredAt`/`lastEntryAt`/`exitedAt`, `flowParticipation[].steps[].createdAt`, `campaignMemberships[].createdAt` — is produced via a raw Postgres `column::text` cast (`occurred_at::text as "occurredAt"`, etc., see lines 80, 116, 187-202, 259-260, 330-333, 378, 409). Postgres's native text rendering of a `timestamptz` is `YYYY-MM-DD HH:MI:SS[.ffffff]+00` (space separator, `+00` offset, variable fractional-second precision) — not RFC3339. Because `packages/db/src/pool.ts` pins the session `TimeZone` to UTC, the underlying instant is always correct, but the two representations are textually different formats within one JSON document that exists specifically to be a portable, human/machine-readable GDPR Art. 15 artifact. `dsrExportDocumentSchema` (`packages/shared-schemas/src/dsr-export.ts`) types every one of these fields as a bare `z.string()`, so nothing catches the inconsistency, and it only "works" downstream because V8's `Date.parse` happens to be lenient about non-standard formats — a strict RFC3339 parser (or a non-JS consumer processing the exported file) would reject or mis-parse roughly 90% of the document's timestamps while accepting the other 10%.
**Fix:** Cast every keyset-paginated timestamp to a real ISO-8601 string, e.g. `to_char(occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` (session is already pinned to UTC), which preserves microsecond precision and still round-trips losslessly through `::timestamptz` for the keyset comparison. **Do not** reformat by parsing the existing `::text` value through `new Date(...).toISOString()` at the document-assembly step and leaving the cursor derived from that same reformatted field — `walkToExhaustion`'s `cursorFromRow` reads the *same field* that lands in the document (e.g. `last.changedAt`, `last.occurredAt`), and `Date` truncates to millisecond precision while Postgres `now()`-derived rows (e.g. `subscription_status_history.changed_at`, written on every real status transition) carry microsecond precision — reformatting that field would silently reintroduce the exact "cursor compares strictly greater than its own truncated self forever" unbounded-loop bug `erasure-scrub.worker.ts`'s own header comment documents at length (T-13-13). If reformatting must happen in JS rather than SQL, do it on a *separate* field from the one the cursor is built from, never on the cursor's own source value. Also add a schema-level `.datetime()`/regex check in `dsr-export.ts` so the format is machine-checked rather than incidental.

### WR-02: `selectSendEventsPage`'s join to `sends` omits an explicit `workspace_id` filter on the joined table

**File:** `apps/api/src/modules/contacts/dsr-export.repository.ts:228-268`
**Issue:** The query is `FROM send_events se JOIN sends s ON s.id = se.send_id WHERE se.workspace_id = $1 AND s.contact_id = $2 ...` — `s.workspace_id` is never compared to `$1`. Every other cross-table/contact-scoped reader in this same file filters `workspace_id` explicitly on every table it touches (`selectFlowRunStepsPage` filters `flow_run_steps.workspace_id = $1` directly; `selectSendsPage`, `selectFlowRunsPage`, `selectCampaignRecipientsPage`, `selectConsentHistoryPage`, `selectEventsPage` all filter `workspace_id = $1` on their one table). This one query relies solely on Postgres RLS to keep a cross-workspace `sends` row from ever satisfying the join, which is true today (RLS is fail-closed per migration 0044) but makes this query the only place in the file where an RLS regression (a dropped/misconfigured policy, a role temporarily granted `BYPASSRLS` for an unrelated migration/maintenance task, etc.) would produce a cross-tenant leak with no second layer of defense. The shape is inherited verbatim from `apps/worker/src/queues/erasure-scrub.worker.ts`'s pre-existing `scrubSendEventsPage`, but this phase introduces a second, independent call site of the same weaker pattern rather than hardening it.
**Fix:** Add `s.workspace_id = $1` to the `JOIN ... ON` clause (`JOIN sends s ON s.id = se.send_id AND s.workspace_id = $1`) so this reader matches the explicit-filter-on-every-table discipline the rest of the file already follows, closing the RLS-is-the-only-guard gap on both this reader and its erasure-worker sibling.

### WR-03: `docs/PII-INVENTORY.md` claims `flow_run_steps.flow_run_id` is an exported column, but the export never emits it

**File:** `docs/PII-INVENTORY.md:28`, cross-checked against `packages/shared-schemas/src/dsr-export.ts:153-161` and `apps/api/src/modules/contacts/dsr-export.repository.ts:343-386,610-618`
**Issue:** The inventory's `flow_run_steps` row lists `id, flow_run_id, node_id, node_type, outcome, send_id, created_at` as the "Personal data columns exported." The actual wire shape (`dsrExportFlowRunStepSchema`) has no `flowRunId` field at all — `dsr-export.repository.ts`'s own `getDsrExportDocument` explicitly destructures `flowRunId` out (`const { flowRunId, ...entry } of flowRunStepRows`) before placing the row under `flowParticipation[].steps`, by design (the nesting already carries the parent run's id). This document is explicitly the authority both Phase 21's export and Phase 22's planned purge are supposed to read to agree on "what counts as this contact's personal data" (see the doc's own header and "Consumed by" section) — a column listed here that the code does not actually emit undermines that authority for the next reader (or for Phase 22's purge-scope derivation) who takes this table at face value instead of re-deriving it from the code.
**Fix:** Remove `flow_run_id` from the `flow_run_steps` row's "Personal data columns exported" list (or add a footnote matching the code comment: "implied by nesting under `flowParticipation[].steps`, not a top-level field of the exported row").

### WR-04: `metadata.allowlistVersion` is a hardcoded literal with no mechanical link to the allowlist it names

**File:** `apps/api/src/modules/contacts/dsr-export.repository.ts:625-631`
**Issue:** `allowlistVersion: "1"` is a bare string literal written directly in `getDsrExportDocument`. Nothing in `@mega-crm/delivery-core`'s `send-event-payload-allowlist.ts` exports a version constant, and no test asserts that changing `SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST` (e.g., adding a fifth export-only key in a future phase) requires bumping this value. As written, `allowlistVersion` is decorative provenance metadata that a future editor of the allowlist has no structural reason to touch — exactly the kind of "documented but not enforced" invariant this codebase otherwise goes out of its way to make structural (see the allowlist file's own superset test, or `send-event-payload-allowlist.test.ts`'s exact-set-difference assertion).
**Fix:** Either derive `allowlistVersion` from a versioned constant exported alongside `SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST` in `delivery-core` (bump it in the same commit that changes the list, enforced by a test that hashes/snapshots the list contents against the version), or drop the field from `dsrExportMetadataSchema` until there is a mechanism that keeps it honest.

## Info

### IN-01: `dsr-export.routes.ts`'s explicit 401 branch is effectively unreachable given `resolveWorkspaceMember`'s own contract

**File:** `apps/api/src/modules/contacts/dsr-export.routes.ts:61-64`
**Issue:** By the time `const session = await auth.api.getSession(...)` runs, `resolveWorkspaceMember` (called two lines earlier) has already succeeded, which per its own doc comment means `getCallerRoles` did not throw for this caller — and `getCallerRoles` throws for an unauthenticated caller exactly like it does for a non-member, both mapped to the resolver's 404. In practice, then, `if (!session) return 401` can only fire in the vanishingly narrow window where a session is invalidated between the `resolveWorkspaceMember` call and this `getSession` call within the same request. The `getSession` call itself is still necessary (it is the only way this handler obtains `session.user.id` for the audit log), but the `401` branch reads as reachable dead code to someone auditing the refusal paths without also re-deriving `resolveWorkspaceMember`'s internals.
**Fix:** No functional change needed (the branch is harmless and correctly fails closed); consider a one-line comment noting the branch is a narrow-race defensive check, not the route's primary auth gate, so a future reader does not mistake it for the enforcement point.

### IN-02: `sectionRowCounts.customProperties` counts object keys, not "rows"

**File:** `apps/api/src/modules/contacts/dsr-export.repository.ts:633-643`
**Issue:** Every other entry in `sectionRowCounts` is a genuine row count from a keyset walk. `customProperties: Object.keys(customProperties).length` counts top-level keys of a JSONB object, which is a reasonable proxy but is conceptually a different kind of count (key count vs. row count) sitting in the same flat map with no type-level distinction. Purely a naming/documentation nuance — the tests already assert the intended semantics correctly (`sectionRowCounts.customProperties` vs. `Object.keys(body.customProperties).length`).
**Fix:** None required; optional: a one-line comment in `dsrExportMetadataSchema` noting that `customProperties` is a key count, not a row count, for a future reader of the open-ended `sectionRowCounts` map.

### IN-03: Two independent workspace-membership resolutions per request, with slightly different failure semantics if they ever diverge

**File:** `apps/api/src/modules/contacts/dsr-export.routes.ts:41-64`, `apps/api/src/middleware/role-guard.ts:37-89`, `apps/api/src/modules/tenancy/resolve-workspace-member.ts:41-61`
**Issue:** `requirePermission("contact", "export")`'s `preHandler` independently calls `findActiveWorkspaceBySlug(slug)` and `auth.api.hasPermission(...)` to resolve the workspace and check the permission; the route handler then calls `resolveWorkspaceMember`, which independently calls `findActiveWorkspaceBySlug(slug)` again and `getCallerRoles(...)` again. Both currently converge on the same 404 body (`NOT_FOUND_BODY`) for their respective failure paths, so behavior is correct today, but the two lookups are two separate round trips to resolve the identical fact (does this caller belong to this workspace) through two independently-maintained code paths that could, in a future edit to either helper, drift apart on an edge case (e.g., a workspace mid-soft-delete, or a role change that lands between the two calls in a slow request). This is not unique to this route — it is this codebase's established pattern for every permission-gated route — but it is worth noting as accumulated risk each time a new `requirePermission`-gated route is added on top of `resolveWorkspaceMember`.
**Fix:** No change required for this phase specifically (matches existing precedent); if a shared "resolve + permission-check" helper is ever introduced for other elevated routes, this route is a candidate to migrate onto it rather than reintroducing the double-lookup shape.

---

_Reviewed: 2026-08-22T13:31:54Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
