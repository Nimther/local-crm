# Phase 21: Per-Contact DSR Export - Research

**Researched:** 2026-08-21
**Domain:** Compliance data export (GDPR Art. 15) over an existing multi-tenant Postgres/Fastify/React stack — no new external technology, pure internal-pattern reuse and one genuinely new architectural piece (transaction-isolation-correct fail-closed erasure gating).
**Confidence:** HIGH (every claim below was checked directly against this repository's source, not recalled from training; the two PostgreSQL isolation-level claims are additionally cross-checked against official docs)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** `events.properties` is excluded entirely from the export. Each event exports only its non-JSONB columns (name, occurred_at, and similar row metadata). This mirrors the Phase 13 erasure ruling verbatim (`buildScrubbedEventProperties` returns `{}`).
- **D-02:** `send_events.payload` passes through an extended export allowlist: the 10 existing evidence keys (`SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST`) PLUS the subject's own single-recipient fields: `ip`, `useragent`, `url`, `reason`. The export list is a strict superset of the evidence list (export ⊇ evidence, relationship documented and test-asserted); tenant-defined keys (unique_args, categories, marketing_campaign_*) stay out. Both lists are explicit build-up allowlists.
- **D-03:** Allowlist constants move into a shared package importable by both `apps/api` (export) and `apps/worker` (erasure scrub) — single definition, no copy-drift — and this phase writes a PII inventory (SPECIFICATION.md section or dedicated doc) enumerating per-table what counts as the contact's personal data. Reversibility: costly.
- **D-04:** Table scope includes journey tables: `flow_runs`/`flow_run_steps` and `campaign_recipients`. Infrastructure rows excluded with documented reasons in the inventory: `suppressions` (HMAC-hashed, no plaintext), `send_event_quarantine`, `erasure_records`, checkpoints/plumbing.
- **D-05:** Single JSON document with top-level sections: `metadata`, `profile`, `custom_properties`, `consent_history`, `events`, `sends` (with nested send_events), `flow_participation`, `campaign_memberships`. One HTTP response. Reversibility: costly.
- **D-06:** `metadata` block carries full provenance: `generated_at`, workspace id + name, contact id, export format version, allowlist version/name, per-section row counts. Requester identity deliberately NOT embedded in the file.
- **D-07:** Field naming follows the existing camelCase API convention; export schemas extend existing `packages/shared-schemas` types where they exist.
- **D-08:** Download filename contains IDs only, no PII: `dsr-export-{contactId}-{YYYY-MM-DD}.json`.
- **D-09:** Synchronous download: one authenticated request → route assembles the document via keyset-paginated reads → response with `Content-Disposition: attachment`. No new queues, no artifact storage, no polling UI.
- **D-10:** Complete, no truncation: every section is keyset-paginated to completion in bounded pages (500-row precedent). A truncated DSR file is a compliance defect.
- **D-11:** Export leaves a structured Pino log line (requester user id, workspace, contact id, section counts) through the existing correlation/observability pipeline into Loki. No new audit table this phase.
- **D-12:** UI trigger is fetch + blob with states: Export button fires authenticated fetch, shows in-progress state, saves response as file on success, renders typed errors inline. Plain `<a href>` navigation rejected.
- **D-13:** Export of an anonymized contact returns a typed status, no file: HTTP 410 with body carrying code `contact_erased`, `erasedAt`, erasure-record reference.
- **D-14:** On an erased contact's card the Export button is visible but disabled with inline reason copy, extending `computeIncompleteReason` disabled-button-with-inline-copy pattern. The typed 410 remains the API backstop for races.
- **D-15:** `contacts.anonymizedAt` is the erasure gate, checked inside the same transaction that reads the export data. Fail-closed: any non-null `anonymizedAt` → typed 410 immediately, even while the scrub worker is still sweeping pages.
- **D-16:** Refusal shapes follow existing patterns exactly: Member → 403 via `requirePermission`; cross-tenant or nonexistent contact id → the same `NOT_FOUND_BODY` 404 used across the codebase.

**Non-negotiable (locked by ROADMAP success criteria):** Owner/Admin-only at both UI and API (SC3); cross-tenant contact id returns nothing, freeform JSONB reaches the file only through an explicit allowlist proven by a synthetic other-subject-field test (SC4); an already-erased contact gets a typed response, never a silently empty file (SC5).

**Scope limits:** per-contact export only — no bulk/workspace export, no self-service portal for data subjects, no async artifact storage. Phase 22 (purge) consumes this phase's PII inventory; the purge itself is out of scope here.

### Claude's Discretion

- Exact HTTP route path/verb, zod schema details, error body field names beyond the typed codes above.
- Section ordering inside the JSON document, timestamp serialization format, exact pagination page size (500-row precedent suggested, not mandated).
- Where the shared allowlist package lives (extend an existing package like `contacts-core`/`delivery-core` vs a new compliance module) — follow monorepo conventions.
- Whether the PII inventory is a SPECIFICATION.md section or a dedicated doc — whichever fits the SPECIFICATION.md same-change rule cleanly.
- Test harness choices for the SC4 synthetic other-subject-field proof and the cross-tenant negative test.
- Exact placement/copy of the Export button and states on `ContactDetailPage`.

### Deferred Ideas (OUT OF SCOPE)

- **Durable DSR export audit table** (`dsr_export_records`, mirroring `erasure_records`) — durable proof of who exported whose data that outlives log retention. Considered at D-11 and deliberately deferred: no DSR-* requirement asks for it; revisit if a compliance requirement for export evidence emerges.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DSR-01 | Owner/Admin can download a machine-readable file with the contact's personal data: profile, custom properties, consent history | `getContact`/`CONTACT_COLUMNS` pattern (contact.repository.ts) covers profile+properties; `subscription_status_history` table (already append-only, no new tracking) covers consent history — see Architecture Patterns / Recommended Project Structure |
| DSR-02 | Export includes the contact's events and send-related personal data (send facts, delivery statuses), scoped to that subject | Keyset-pagination Pattern 2 (adapted from `scrubEventsPage`/`scrubSendEventsPage`) covers `events` and `sends`+`send_events`; D-02's extended export allowlist covers `send_events.payload` disclosure bound — see Pattern 1/2 and Code Examples |
| DSR-03 | Data scoped strictly to workspace_id + contact_id; JSONB inclusion/redaction rule resolved via explicit allowlist, shared with Phase 22's PII inventory | D-01/D-02 allowlist rules (already locked in CONTEXT.md, reused verbatim here); D-03's shared-package relocation is fully specified in Recommended Project Structure + Pitfall 3; RLS + explicit `workspace_id`/`contact_id` filters per Pattern 3 |
| DSR-04 | Member without Owner/Admin role cannot trigger the export (API + UI gate) | Summary finding 1: `requirePermission` needs a NEW `contact`/`export` resource added to `access-control.ts` (statement + all 3 roles) — this is the concrete, verified gap CONTEXT.md's canonical refs did not surface; frontend gate via existing `workspaceQuery.data?.role` pattern (`CampaignDetailPage.tsx`) |

</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **SPECIFICATION.md same-change rule:** any new library/dependency, env var/secret, schema/migration/RLS/index change, queue/worker change, or new public route MUST be documented in the matching SPECIFICATION.md section in the SAME change. For this phase, concretely:
  - New route `GET .../contacts/:id/dsr-export` → SPECIFICATION.md §6.4 ("Роуты по сессии") — add the route, its typed error contracts (403/404/410), and its permission gate.
  - New access-control resource (`contact: ["export"]`) → no dedicated secrets/schema section, but worth a line in §6.4 alongside the route since it's the enforcement mechanism.
  - If Pitfall 2's indexes are added → SPECIFICATION.md §4.5 ("Индексы") and §4.6 ("Миграции").
  - The relocated allowlist constants (`@mega-crm/delivery-core`) → no version bump needed (internal package, not third-party), but note the relocation in §1.2 ("Внутренние пакеты") if that section enumerates package responsibilities/exports.
  - The PII inventory (D-03) → per CLAUDE.md's own instruction, lands in SPECIFICATION.md as a new subsection (or a dedicated doc, per CONTEXT.md's discretion note) — either way, written in the SAME change that introduces the allowlist relocation, not deferred.
  - **No new external npm package is introduced by this phase** (verified in Package Legitimacy Audit above) — so §2 ("Зависимости и версии") needs no new row, only confirmation there is nothing to add.
- **GSD workflow enforcement:** all file-changing work for this phase must go through `/gsd-plan-phase` → `/gsd-execute-phase` (or `/gsd-quick`/`/gsd-debug` for genuinely out-of-band fixes) — no direct repo edits outside a GSD workflow. This is an execution-time constraint for the planner/executor, not something this research needs to act on.
- **As-built accuracy:** the plan should include a task (or a task step) that updates SPECIFICATION.md in the same commit/PR as the route + migration + package-relocation code changes, not as an afterthought — code must never diverge from SPECIFICATION.md's as-built description.

## Summary

This phase adds exactly one new capability — a synchronous, keyset-paginated, Owner/Admin-only JSON export of one contact's personal data — to a codebase that already contains almost every building block it needs: the role-guard (`requirePermission`), the anti-enumeration 404 (`NOT_FOUND_BODY`), the build-up JSONB allowlist pattern (`buildScrubbedSendEventPayload`), and the keyset-pagination-in-bounded-pages precedent (erasure-scrub's 500-row walk). No new npm package, queue, or infrastructure is required. Every locked decision in CONTEXT.md (D-01 through D-16) is achievable with code already in the repository.

Two things CONTEXT.md's canonical refs did not fully anticipate, both verified directly against source in this session:

1. **The Owner/Admin permission gate needs a new resource in the access-control statement, not just a call to `requirePermission`.** `apps/api/src/modules/auth/access-control.ts`'s `statement` object has no `contact`/`dsr`/export-shaped resource today — the DELETE contact route currently runs with *ordinary membership*, no role gate at all. DSR-04's Owner/Admin gate requires adding a new resource+action (e.g. `contact: ["export"]`) to `statement`, `member`, `admin`, and `owner` — the same three-file edit pattern `campaign: ["launch"]` or `flow: ["publish"]` followed in earlier phases — before `requirePermission("contact", "export")` can be wired onto the route.

2. **D-15's fail-closed guarantee needs `REPEATABLE READ`, not the pool's default `READ COMMITTED`, and the existing `withTenantTransaction` helper cannot be reused unmodified to get it.** `contacts.anonymizedAt` is set synchronously (before any async scrub work happens), so a plain same-transaction check under `READ COMMITTED` correctly refuses an *already*-erased contact. But D-15's actual wording — "even while the asynchronous scrub worker is still sweeping pages" — describes a different race: erasure requested *after* the export's anonymizedAt check passes but *before* the export finishes reading every section. Under `READ COMMITTED` (a fresh snapshot per statement), a later page-read inside the *same* transaction can observe rows the scrub has since rewritten, producing exactly the half-scrubbed document D-15 forbids. `withTenantTransaction` issues `BEGIN` then an immediate `SELECT set_config(...)` as its first statement — and PostgreSQL only allows `SET TRANSACTION ISOLATION LEVEL` before the *first* query of a transaction — so calling `withTenantTransaction` and then trying to raise the isolation level inside the callback will error. The export route needs its own transaction wrapper that opens with `BEGIN ISOLATION LEVEL REPEATABLE READ` (combining BEGIN and the isolation clause in one statement sidesteps the ordering restriction) before doing the `set_config` RLS binding and the anonymizedAt check.

**Primary recommendation:** Build the export as one new route module (`apps/api/src/modules/contacts/dsr-export.routes.ts` + a sibling repository file), gated by a newly-added `contact: ["export"]` permission, running its reads inside a single `REPEATABLE READ` transaction (a small new helper, not the existing `withTenantTransaction`), reusing the erasure-scrub allowlist constants (relocated to `@mega-crm/delivery-core`, which both `apps/api` and `apps/worker` already depend on) for `send_events.payload`, and keyset-walking `events`, `send_events` (via `sends`), `flow_runs`+`flow_run_steps`, and `campaign_recipients` in 500-row pages exactly like the erasure scrub does today, but reading instead of rewriting.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Owner/Admin permission gate | API / Backend | Browser / Client | Server-side `requirePermission` is the authoritative gate (SC3); the UI disabling the button is a courtesy, not a security boundary — same split as every existing `requirePermission` call site in this codebase |
| Erasure-gate check (`anonymizedAt`) | API / Backend | — | Must run inside the same DB transaction as the data read (D-15); purely a backend/database concern, no client involvement |
| JSONB allowlist construction | Database / Storage boundary (shared package) | API / Backend, Worker (background) | The allowlist constants are data-shape knowledge shared by two runtime tiers (API export path, worker erasure-scrub path) — belongs in a shared package (`@mega-crm/delivery-core`), not duplicated in either tier |
| Keyset-paginated multi-table read | API / Backend | Database / Storage | The route orchestrates the walk; Postgres indexes/partitions are what make each page cheap — a missing index (see Common Pitfalls) pushes cost onto the DB tier |
| Document assembly + `Content-Disposition` response | API / Backend | — | One Fastify route builds and streams the whole JSON body; no CDN/static tier involved (this is per-tenant dynamic data, never cacheable) |
| Export trigger + typed-error rendering | Browser / Client | API / Backend (typed error contracts) | Fetch + blob-save is pure client-tier UX; the *meaning* of each error code (403/404/410) is defined server-side and merely rendered client-side |
| Erased-contact disabled-button state | Browser / Client | — | `contact.anonymizedAt` is already returned by the existing `GET /contacts/:id` response; no new endpoint needed for this UI state |

## Standard Stack

No new libraries. This phase is 100% internal-pattern reuse on top of the stack already locked in `.claude/CLAUDE.md` (Fastify 5.9.x, Zod 4.4.x, Drizzle/`pg` 8.22.x, React 19.2.x, TanStack Query 5.101.x). No `npm install` is needed for this phase.

### Alternatives Considered

| Instead of | Could use | Tradeoff |
|------------|-----------|----------|
| Synchronous single-request export | Async job + polling/notification (BullMQ) | Explicitly out of scope per REQUIREMENTS.md "Out of Scope" table and CONTEXT.md D-09 — per-contact volume is small and a synchronous response is simpler; revisit only if a workspace's per-contact history genuinely can't complete inside one HTTP request timeout |
| Bespoke `BEGIN ISOLATION LEVEL REPEATABLE READ` transaction wrapper for this route | Reuse `withTenantTransaction` as-is | Not viable — see Summary point 2; `withTenantTransaction`'s first statement (`SELECT set_config(...)`) forecloses raising the isolation level afterward. A new small helper (or a `withTenantTransaction` options param) is required |
| A new `contact: ["export"]` access-control resource | Reuse an existing resource (e.g. `campaign: ["launch"]`) for the export permission | Reusing an unrelated resource would make an Admin's "campaign launch" permission control DSR export access — semantically wrong and would silently break if `campaign` permissions are ever narrowed. A dedicated resource is the only correct choice, and it is a 4-line, well-precedented change |

## Package Legitimacy Audit

Not applicable — this phase installs no new external packages (verified: no new dependency appears anywhere in the plan; every capability is built from code already in `package.json` across `apps/api`, `apps/worker`, `packages/delivery-core`, `packages/shared-schemas`).

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
[Browser: ContactDetailPage]
        |
        | 1. GET /api/workspaces/:slug/contacts/:id/dsr-export
        |    (session cookie, credentials: include)
        v
[Fastify route: dsr-export.routes.ts]
        |
        | 2. resolveWorkspaceMember(slug)  --404 if not a member/unknown workspace (SC4 anti-enumeration)
        | 3. requirePermission("contact","export") preHandler --403 if caller role = member (SC3/DSR-04)
        v
[New transaction wrapper: BEGIN ISOLATION LEVEL REPEATABLE READ]
        |
        | 4. SELECT set_config('app.current_workspace_id', ...)      <- RLS binding, same tenant-context pattern
        | 5. SELECT anonymized_at FROM contacts WHERE workspace_id=$1 AND id=$2
        |         |
        |         +-- not found (wrong workspace or nonexistent) --> 404 NOT_FOUND_BODY-shaped (SC4)
        |         +-- anonymized_at IS NOT NULL --> 410 { code: "contact_erased", erasedAt, erasureRecordId } (SC5/D-13)
        |         +-- anonymized_at IS NULL --> continue, same transaction/snapshot from here on
        v
[Keyset walk, one SELECT-page-loop per section, ALL inside the one REPEATABLE READ snapshot]
        |
        +--> profile + custom_properties  (single-row read, contacts table)
        +--> consent_history               (subscription_status_history, append-only, no pagination needed at typical volume)
        +--> events                        (500-row keyset pages, ordered (occurred_at,id) -- mirrors scrubEventsPage)
        +--> sends + nested send_events    (500-row keyset pages via sends JOIN send_events -- mirrors scrubSendEventsPage;
        |                                   send_events.payload passed through the EXPORT allowlist, a superset of the
        |                                   erasure EVIDENCE allowlist -- both live in @mega-crm/delivery-core)
        +--> flow_participation            (flow_runs WHERE contact_id, then flow_run_steps WHERE flow_run_id IN (...))
        +--> campaign_memberships          (campaign_recipients WHERE contact_id)
        v
[Assemble one JSON document: metadata + 8 sections, row counts per section]
        |
        | 6. COMMIT (single transaction closes here -- the whole read was one consistent snapshot)
        v
[Fastify reply: Content-Type application/json, Content-Disposition attachment; filename="dsr-export-{contactId}-{date}.json"]
        |
        v
[Browser: fetch resolves -> res.json() (or res.blob() if bypassing apiFetch) -> save as file, or catch ApiError -> typed inline state]
```

### Recommended Project Structure

```
apps/api/src/modules/contacts/
├── dsr-export.routes.ts       # new: GET .../contacts/:id/dsr-export
├── dsr-export.repository.ts   # new: the transaction + keyset-walk + document assembly
├── contacts.routes.ts         # existing: register the new route alongside it, same module scope
└── contact.repository.ts      # existing: unchanged, but its CONTACT_COLUMNS / getContact pattern is the template

packages/delivery-core/src/
├── send-event-payload-allowlist.ts   # new: relocated SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST +
│                                      #      buildScrubbedSendEventPayload (from erasure-scrub.worker.ts)
│                                      #      + new SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST (D-02 superset) +
│                                      #      buildExportSendEventPayload
└── index.ts                          # add the new exports

packages/tenant-context/src/
└── index.ts                          # add an isolation-level option to withTenantTransaction, OR a
                                       # sibling withTenantTransactionRepeatableRead -- see Pitfall 1

apps/worker/src/queues/
└── erasure-scrub.worker.ts    # changes to a THIN re-export of the relocated constants/functions
                                # from @mega-crm/delivery-core -- pure relocation, no behavior change
                                # (erasure-scrub.test.ts imports these names from THIS file, unchanged path)

apps/web/src/features/contacts/
└── ContactDetailPage.tsx      # add the Export button + states (fetch, in-progress, typed error, disabled-if-erased)
```

### Pattern 1: Build-up JSONB allowlist (D-01/D-02)

**What:** Construct a brand-new object by copying ONLY named keys forward from an untrusted JSONB value; never start from the input and delete keys.
**When to use:** Any time tenant-controlled freeform JSON must cross a trust or disclosure boundary (export, erasure, logging).
**Example (existing code, to be relocated as-is per D-03):**
```typescript
// Source: apps/worker/src/queues/erasure-scrub.worker.ts (relocating to
// packages/delivery-core/src/send-event-payload-allowlist.ts)
export function buildScrubbedSendEventPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {};
  }
  const input = payload as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST) {
    if (key in input) result[key] = input[key];
  }
  return result;
}
```
The export variant (`buildExportSendEventPayload`) is the *identical* shape over a *superset* list (`SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST = [...SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST, "ip", "useragent", "url", "reason"]`, per D-02) — write it so a test can assert `EXPORT_ALLOWLIST` is a superset of `EVIDENCE_ALLOWLIST` (`EVIDENCE_ALLOWLIST.every(k => EXPORT_ALLOWLIST.includes(k))`), which is the specific regression D-02/the Specific Ideas section calls out.

### Pattern 2: Keyset pagination in bounded pages (D-10)

**What:** Page through a table's matching rows ordered by `(timestamp, id)`, carrying `(lastTimestamp, lastId)` as the cursor, looping until a page returns zero rows.
**When to use:** Any "read everything, completely, for one contact" requirement where OFFSET pagination would be unsafe under concurrent writes or where the source table is partitioned (partitioned tables require the partition key to lead any ordering that must be stable — see `send_events`' `occurred_at` requirement).
**Example (existing code, read-shape adaptation of the erasure-scrub SELECT):**
```typescript
// Source: apps/worker/src/queues/erasure-scrub.worker.ts's scrubEventsPage,
// adapted to READ instead of UPDATE for the export's events section
const { rows } = await client.query(
  `SELECT id, name, properties, occurred_at, received_at FROM events
   WHERE workspace_id = $1 AND contact_id = $2
     ${cursor ? "AND (occurred_at, id) > ($3::timestamptz, $4::uuid)" : ""}
   ORDER BY occurred_at ASC, id ASC
   LIMIT $N`,
  params
);
```
Note: unlike the erasure scrub (which commits a checkpoint row per page across many BullMQ job invocations, because scrubbing can span a long resumable background job), the export's pages are *within one HTTP request's single transaction* — no checkpoint table is needed here; the loop is purely an in-memory `while` over pages inside one `client`.

### Pattern 3: Anti-enumeration 404 (SC4)

**What:** A cross-tenant or nonexistent contact id must return byte-identical output to "workspace not found."
**When to use:** Every workspace-scoped lookup.
**Example:**
```typescript
// Source: apps/api/src/modules/tenancy/resolve-workspace-member.ts
export const NOT_FOUND_BODY = { error: "Workspace not found" } as const;
```
The export route's contact-not-found branch (wrong workspace, or a contact id that never existed) should reuse this exact constant/shape — do not invent a second "Contact not found" 404 body for the export path alone, or an attacker probing contact ids across two different route families gets a distinguishing signal.

### Anti-Patterns to Avoid

- **Filtering freeform JSONB with a denylist or regex instead of an allowlist:** `events.properties` explicitly has *no* allowlist because the entire key space is tenant-invented (D-01) — this is the Phase 13 REVIEWS.md BLOCKER finding the erasure scrub already fixed; do not re-introduce a denylist approach for the export path.
- **Tearing down instead of building up:** `delete payload[key]` for a denylist of known-bad keys leaks anything nobody thought to name. Every allowlist function in this codebase constructs a new object from nothing.
- **Reusing `withTenantTransaction` unmodified and assuming same-transaction implies snapshot-consistent:** see Common Pitfall 1 below — `READ COMMITTED` (the pool default) does NOT give a stable snapshot across statements in the same transaction.
- **Offset (`LIMIT/OFFSET`) pagination over `events`/`send_events`:** both are partitioned; keyset pagination ordered by `(occurred_at, id)` is the only stable-under-writes, partition-safe approach, and is already the proven precedent.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Owner/Admin role check | A bespoke `session.role === "owner" \|\| session.role === "admin"` check in the route handler | `requirePermission("contact", "export")` (after adding the resource to `access-control.ts`) | Every other Owner/Admin-gated route in this codebase uses this one preHandler; a hand-rolled check would diverge from the `hasPermission`-throws-on-non-member edge case `role-guard.ts` already handles (mapped to 404, not 401/403 — SEC-10/SEC-15) |
| Cross-tenant/nonexistent-contact 404 | A new `{ error: "Contact not found" }` literal | `resolveWorkspaceMember` + `NOT_FOUND_BODY` for the workspace-level check, and reuse the *identical* body shape for the contact-level check | SEC-14: nine near-identical copies of this exact 404 already had to be consolidated once; a tenth ad hoc copy for this route reopens that exact problem |
| JSONB field disclosure bound | A regex/keyword scanner over `send_events.payload` values | `buildScrubbedSendEventPayload`'s allowlist (relocated, extended per D-02) | Already proven insufficient once (REVIEWS.md BLOCKER 4) — a denylist/pattern approach cannot bound a field like `reason` that embeds an address inside free text under an innocuous key name |
| Multi-table keyset cursor bookkeeping | A generic "keyset paginator" abstraction | Copy the existing per-table SELECT-loop shape (scrubEventsPage/scrubSendEventsPage) | No such abstraction exists anywhere in this codebase today (checked); every keyset walk is a bespoke, table-shaped loop. Inventing a generic abstraction for this one phase is over-engineering — follow precedent, don't invent a new paradigm |

**Key insight:** every piece of this phase already has a working, tested analog somewhere in the repository except the transaction-isolation-level wrapper (genuinely new) and the access-control resource (a 4-line precedented addition). Resist inventing new abstractions; copy the existing shapes.

## Runtime State Inventory

Not applicable — Phase 21 adds a new read-only export capability; it does not rename, refactor, or migrate any existing identifier, table, or stored value. (Contrast with Phase 22, which purges/renames tenant state and will need this section.)

## Common Pitfalls

### Pitfall 1: `withTenantTransaction`'s default isolation level breaks D-15's atomicity guarantee

**What goes wrong:** A plan that says "check `anonymizedAt` inside the same transaction as the reads" and then implements that literally with `withTenantTransaction` gets a transaction where each SELECT is its own fresh snapshot (`READ COMMITTED`, the Postgres/`pg` default, and the level `withTenantTransaction` uses via a plain `BEGIN`). If the erasure-scrub worker commits a page's UPDATEs between two of the export's SELECTs, the export can legally read a mix of pre- and post-scrub rows inside "one transaction" — the exact half-scrubbed-document outcome D-15 forbids.
**Why it happens:** "Same transaction" is conflated with "same snapshot." They are only the same thing under `REPEATABLE READ` or `SERIALIZABLE`.
**How to avoid:** Open the export's transaction with `BEGIN ISOLATION LEVEL REPEATABLE READ` (a single combined statement — PostgreSQL forbids `SET TRANSACTION ISOLATION LEVEL` once any query, including a `SELECT`, has already run in that transaction [VERIFIED: PostgreSQL docs, `sql-set-transaction.html`], which rules out calling `withTenantTransaction` — whose first statement is a `SELECT set_config(...)` — and then trying to raise the isolation level inside the callback). Concretely: add either (a) an `options.isolationLevel` parameter to `withTenantTransaction` in `packages/tenant-context/src/index.ts` that changes the literal `"BEGIN"` to `"BEGIN ISOLATION LEVEL REPEATABLE READ"` when passed, or (b) a small dedicated wrapper in the export module that opens the transaction itself. Either way, the `anonymizedAt` check must be the FIRST read after that `BEGIN`, and every subsequent section read reuses the same `client`/transaction.
**Warning signs:** A plan or implementation that calls the existing `withTenantTransaction` for this route without any isolation-level change; a test that can't reproduce the race (because it never runs the scrub worker concurrently) giving false confidence.
**Reassurance:** the export transaction is read-only (no INSERT/UPDATE/DELETE), so `REPEATABLE READ` cannot produce a serialization failure here (that failure mode only arises from write-write conflicts, which is `SERIALIZABLE`'s concern, and even there only for transactions that write) — no retry/backoff logic is needed around this transaction on account of the isolation-level change.

### Pitfall 2: Missing `(workspace_id, contact_id)` indexes on `flow_runs` and `campaign_recipients` contradict the ROADMAP's stated justification for skipping async export

**What goes wrong:** `REQUIREMENTS.md`'s "Out of Scope" table asserts "leading (workspace_id, contact_id) индексы на всех таблицах" already exist as the reason a synchronous export is safe. Verified directly against the migrations (`packages/db/migrations/*.sql`), this is true for `events` (`idx_events_workspace_contact_time`) and `sends` (`idx_sends_workspace_contact_sent_at`), but **not** true for:
  - `flow_runs`: the only contact-scoped index is `flow_runs_one_active_per_contact`, a **partial** unique index on `(workspace_id, flow_id, contact_id)` covering only `status IN ('waiting','advancing')` — a completed/exited/ejected run (exactly what "processing history" (D-04) needs to show) is not covered by any index leading with `contact_id`.
  - `campaign_recipients`: the only index is `campaign_recipients_campaign_contact_unique` on `(campaign_id, contact_id)` — leads with `campaign_id`, not usable for "all campaigns this contact belongs to."
  - `flow_run_steps`: no index at all on `flow_run_id` beyond the implicit FK constraint (Postgres does **not** auto-create an index for a foreign-key column) — a lookup by a set of `flow_run_id`s (the second step of the flow-participation section) has no supporting index either.
  Checked and found adequately covered: `subscription_status_history` (consent history section) has `idx_subscription_status_history_workspace_contact_changed` on `(workspace_id, contact_id, changed_at)` — migration `0036_analytics_status_history_counts.sql` — no gap here.
**Why it happens:** These indexes were built for their *original* consumers (the flow scheduler's `next_wake_at` scan, the campaign recipient-snapshot idempotency check) — nobody needed a contact-scoped read path on these tables until now.
**How to avoid:** Add a migration in this phase (or flag it as a required follow-up before shipping) creating: `CREATE INDEX idx_flow_runs_workspace_contact ON flow_runs (workspace_id, contact_id);`, `CREATE INDEX idx_campaign_recipients_workspace_contact ON campaign_recipients (workspace_id, contact_id);`, and `CREATE INDEX idx_flow_run_steps_flow_run_id ON flow_run_steps (flow_run_id);`. Per-contact row counts are small in absolute terms, so a full-table scan on these two tables would not be *incorrect*, only potentially slow on a workspace with a large `flow_runs`/`campaign_recipients` table — but the ROADMAP's own stated justification for not needing async export rests on an index guarantee that is only half true. This should be surfaced to the user/planner as an explicit decision (add the indexes now vs. accept the scan cost).
**Warning signs:** `EXPLAIN` on the flow-participation or campaign-membership queries showing `Seq Scan` on `flow_runs`/`campaign_recipients` in a workspace with a large table.

### Pitfall 3: Moving the allowlist constants breaks the worker's module-source-check test if the import path changes

**What goes wrong:** `apps/worker/src/queues/__tests__/erasure-scrub.test.ts` imports `SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST`, `ERASURE_SCRUB_PAGE_LIMIT`, `buildScrubbedSendEventPayload`, and `buildScrubbedEventProperties` from `"../erasure-scrub.worker.js"` (the worker file itself, not the new shared package) — and separately does a raw-source-text check (`fs.readFile(".../erasure-scrub.worker.ts")`) asserting the file's source never imports from `@mega-crm/redaction`. If D-03's relocation removes the definitions from `erasure-scrub.worker.ts` without leaving a **re-export**, the test's import breaks; if the relocation is done correctly, importing `@mega-crm/delivery-core` (not `@mega-crm/redaction`) leaves the source-text check unaffected.
**Why it happens:** D-03 explicitly requires "the erasure worker's tests must keep passing unchanged" — this is only true if `erasure-scrub.worker.ts` re-exports (`export { SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST, buildScrubbedSendEventPayload, buildScrubbedEventProperties, ERASURE_SCRUB_PAGE_LIMIT } from "@mega-crm/delivery-core";`) rather than only removing the local definitions.
**How to avoid:** Relocate the definitions into `packages/delivery-core/src/send-event-payload-allowlist.ts`, export them from `delivery-core`'s `index.ts`, then replace the local definitions in `erasure-scrub.worker.ts` with a `export { ... } from "@mega-crm/delivery-core"` re-export line — a pure relocation, zero behavior change, and the existing test file's import path (`"../erasure-scrub.worker.js"`) keeps resolving.
**Warning signs:** `erasure-scrub.test.ts` failing on import resolution after the relocation commit.

### Pitfall 4: `apiFetch`'s always-`application/json`-request-header assumption is fine for this GET, but there is no existing blob-download helper on the frontend

**What goes wrong:** D-12 calls for "fetch + blob with states." A plan that assumes an existing `apiDownload`/blob helper exists (by analogy with `apiGet`/`apiPost`/`apiDelete` in `apps/web/src/lib/api.ts`) will be surprised: no such helper exists anywhere in `apps/web/src` today (verified: no `.blob()`/`createObjectURL`/`Content-Disposition` reference anywhere in the frontend source tree).
**Why it happens:** Every prior download-shaped feature (`csv-import.routes.ts`'s CSV error report) has no frontend consumer in this codebase yet either — this is a genuinely first frontend download flow.
**How to avoid:** Because the export response body IS `application/json` (not an opaque binary), the existing `apiGet<DsrExportDocument>(...)` (which already parses JSON and already throws a typed `ApiError` with the parsed body for non-2xx responses — covering the 403/404/410 typed-error requirement for free) can be reused for the fetch itself; the only new code needed is turning the successfully-parsed object into a downloadable file client-side: `new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })` + `URL.createObjectURL` + a synthetic anchor click, using the D-08 filename convention. This avoids inventing a raw-fetch/blob bypass of `apiFetch` and keeps the existing typed-error path intact.
**Warning signs:** A plan that writes a brand-new low-level `fetch()` call bypassing `apiFetch`/`ApiError` for this one route, duplicating error-body parsing that already exists.

## Code Examples

### Permission gate addition (mechanical pattern, not yet applied)
```typescript
// Source: apps/api/src/modules/auth/access-control.ts -- existing pattern
// (campaign: ["launch"]) shown as the template for the new resource this
// phase must add.
export const statement = {
  // ...existing resources...
  contact: ["export"], // NEW -- DSR-04
} as const;

export const member = ac.newRole({
  // ...existing...
  contact: [], // Member has no export permission
});

export const admin = ac.newRole({
  // ...existing...
  contact: ["export"],
});

export const owner = ac.newRole({
  // ...existing...
  contact: ["export"],
});
```

### Typed 410 for an already-erased contact (D-13)
```typescript
// Pattern to follow -- mirrors contacts.routes.ts's existing
// ContactConflictError "contact_anonymized" -> 404 mapping shape, but this
// route returns 410 per D-13's own typed-status requirement (distinct
// semantics: 404 hides existence entirely for cross-tenant; 410 tells an
// authorized same-tenant caller the resource specifically no longer exists
// in personal-data form).
if (anonymizedAt !== null) {
  return reply.code(410).send({
    code: "contact_erased",
    erasedAt: anonymizedAt.toISOString(),
    erasureRecordId, // from erasure_records, same workspace+contact
  });
}
```

### Role-gated route test harness (existing precedent to model DSR-04's tests on)
```typescript
// Source: apps/api/src/modules/tenancy/__tests__/role-guard.test.ts
async function addMemberWithRole(organizationId: string, role: "member" | "admin" | "owner") {
  // ...seeds a real member row with the given role for a real permission check,
  // rather than mocking better-auth's hasPermission...
}
```

## State of the Art

Not applicable in the usual sense (no external library version drift to track) — but one internal precedent superseded another during this codebase's own history, worth knowing for this phase:

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Denylist/pattern-matching redaction (`@mega-crm/redaction`'s `REDACTION_RULES`) for JSONB scrubbing | Build-up allowlist reconstruction (`buildScrubbedSendEventPayload`/`buildScrubbedEventProperties`) | Phase 13, REVIEWS.md (Codex) BLOCKER finding 4 | This phase's export allowlist (D-02) MUST follow the current (allowlist) approach, not the superseded denylist one — `@mega-crm/redaction` must not be imported anywhere in the export path |

**Deprecated/outdated:** `@mega-crm/redaction`'s regex-based rules, for this specific JSONB-disclosure-boundary use case — the package itself is presumably still used elsewhere (frontend scrubbed-console per SPECIFICATION.md §2.7.1) and is not being deprecated wholesale, just is the wrong tool for this phase's freeform-JSONB decisions.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The exact HTTP route path (`GET /api/workspaces/:slug/contacts/:id/dsr-export`) is a reasonable, RESTful choice consistent with this codebase's route-naming conventions — not verified against any written convention doc, just pattern-matched against `contacts.routes.ts`'s existing `:id/events` sub-resource route. | Architecture Patterns / Code Examples | Low — CONTEXT.md explicitly leaves exact route path to Claude's Discretion; a different path choice costs nothing to change before ship |
| A2 | Adding an `options.isolationLevel` parameter to the shared `withTenantTransaction` helper (rather than writing a fully separate, non-shared transaction wrapper just for this route) is the right layering choice. | Common Pitfall 1 / Recommended Project Structure | Medium — if `withTenantTransaction`'s ~100+ existing call sites have any assumption baked in about isolation level (e.g. relying on `READ COMMITTED`'s per-statement snapshot behavior for correctness elsewhere), extending the shared helper needs a careful audit; a self-contained wrapper local to the export module is the safer fallback if that audit turns up a conflict |
| A3 | A full-table scan on `flow_runs`/`campaign_recipients` (absent the new indexes in Pitfall 2) would be "acceptable but slow," not a hard blocker, at this project's stated 100k-1M contact target scale. | Common Pitfall 2 | Medium — if a workspace's `flow_runs` table is very large (years of flow history, high enrollment volume), an uncovered scan on every DSR export request could be a real operational cost; the safer default is to add the three indexes in this phase rather than defer them |

## Open Questions (RESOLVED)

Both questions below were plan-time decisions and both are now resolved by the phase plans. Kept for provenance.

1. **RESOLVED: Should the three missing indexes (Pitfall 2) be added in this phase's migration, or is that explicitly deferred?**
   - What we know: they are missing today, verified directly against migrations; `events`/`sends` already have the equivalent index.
   - What's unclear: whether the user considers this in-scope for Phase 21 (a schema change adjacent to, but not required by, the DSR-01..04 requirements as literally worded) or a Phase-22-adjacent follow-up.
   - Recommendation: raise explicitly at plan time — the safest default is to add the migration in this phase, since Phase 22 (purge) will also need to scan these same tables by contact and would benefit from the same indexes, and CONTEXT.md's own "reversibility: costly" framing for other decisions suggests this project's convention is to close known gaps rather than defer them silently.
   - **RESOLVED:** added in this phase, per the recommendation. `21-06-PLAN.md` Task 2 implements migration `0067_dsr_export_contact_indexes.sql` with all three contact-scoped indexes (`idx_flow_runs_workspace_contact`, `idx_campaign_recipients_workspace_contact`, `idx_flow_run_steps_flow_run_id`) plus the `_journal.json` entry, and `21-06-PLAN.md` Task 3 records them in SPECIFICATION.md §4.5/§4.6.

2. **RESOLVED: Does `withTenantTransaction` need a generic isolation-level option, or should this route bypass it entirely with a bespoke wrapper?**
   - What we know: the existing helper's first statement (`SELECT set_config`) forecloses raising isolation level afterward; a combined `BEGIN ISOLATION LEVEL REPEATABLE READ` statement is the fix.
   - What's unclear: whether extending the shared, widely-used helper is safer than a route-local wrapper, given how many call sites depend on its current exact behavior.
   - Recommendation: plan-time decision; either is workable, but the plan MUST explicitly name which one, since "just reuse `withTenantTransaction`" (the CONTEXT.md canonical-refs' implicit assumption) does not work unmodified.
   - **RESOLVED:** neither option as posed — `21-01-PLAN.md` Task 1 adds `withTenantTransactionRepeatableRead` as a dedicated sibling helper in `packages/tenant-context/src/index.ts` (copy of `withTenantTransaction` differing only in the combined `BEGIN ISOLATION LEVEL REPEATABLE READ` first statement). No isolation option is added to `withTenantTransaction` and its existing call sites keep READ COMMITTED.

## Environment Availability

Skipped — this phase has no new external dependency (tool, service, runtime, or CLI) beyond what's already running in this repository's existing dev/CI environment (Postgres, the existing Fastify/worker processes). No new probe is needed.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.x (`vitest run` per workspace `package.json`) |
| Config file | `apps/api/vitest.config.ts`, `apps/web/vitest.config.ts` (if a frontend unit test is added for the button state) |
| Quick run command | `npm run test -w apps/api -- src/modules/contacts/__tests__/dsr-export.test.ts` |
| Full suite command | `npm run test -w apps/api` (backend), `npm run test` (root, all workspaces) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DSR-01 | Owner/Admin downloads profile + custom properties + consent history for a contact | integration | `vitest run src/modules/contacts/__tests__/dsr-export.test.ts -t "profile"` | ❌ Wave 0 |
| DSR-02 | Export includes events and send-related personal data scoped to the subject | integration | `vitest run src/modules/contacts/__tests__/dsr-export.test.ts -t "events and sends"` | ❌ Wave 0 |
| DSR-03 | Freeform JSONB reaches the file only via explicit allowlist; synthetic other-subject field provably absent; export allowlist ⊇ evidence allowlist | unit + integration | `vitest run packages/delivery-core/src/__tests__/send-event-payload-allowlist.test.ts` + `vitest run src/modules/contacts/__tests__/dsr-export.test.ts -t "allowlist"` | ❌ Wave 0 |
| DSR-04 | Member refused at API (403) and UI (button hidden/disabled); cross-tenant contact id returns nothing (404, byte-identical to workspace-not-found) | integration | `vitest run src/modules/contacts/__tests__/dsr-export.test.ts -t "role guard"` (model on `role-guard.test.ts`'s `addMemberWithRole`) | ❌ Wave 0 |
| SC5 (erased contact) | Already-anonymized contact export returns typed 410, never an empty file | integration | `vitest run src/modules/contacts/__tests__/dsr-export.test.ts -t "erased"` | ❌ Wave 0 |
| SC5 (mid-scrub race) | An export whose transaction begins before an erasure request's scrub, and completes after, ships pre-erasure data consistently (REPEATABLE READ proof) | integration, concurrency-sensitive | `vitest run src/modules/contacts/__tests__/dsr-export-isolation.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** targeted `vitest run <new test file> -t "<behavior>"`
- **Per wave merge:** `npm run test -w apps/api` (full backend suite, including the pre-existing `erasure-scrub.test.ts` and `role-guard.test.ts` to confirm the relocation/permission-statement changes didn't regress them)
- **Phase gate:** full suite green (`npm run test`) before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `apps/api/src/modules/contacts/__tests__/dsr-export.test.ts` — covers DSR-01, DSR-02, DSR-04, SC5 (typed 410)
- [ ] `apps/api/src/modules/contacts/__tests__/dsr-export-isolation.test.ts` — covers the REPEATABLE READ mid-scrub race specifically (may need to drive the real `erasure-scrub` worker function concurrently with the export inside the test, or use two DB clients with explicit `pg_sleep`-based interleaving to force the race deterministically)
- [ ] `packages/delivery-core/src/__tests__/send-event-payload-allowlist.test.ts` — new home for the relocated allowlist tests (moved from `erasure-scrub.test.ts`'s pure-function `describe` blocks) plus the new export-allowlist superset assertion
- [ ] `apps/web/src/features/contacts/__tests__/ContactDetailPage.test.tsx` (or equivalent) — covers D-14's disabled-with-reason state and D-12's fetch/blob/typed-error states, if this project's frontend testing convention covers component-level behavior (check for an existing sibling test before assuming none exists)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (indirectly) | Existing session-cookie auth via better-auth; this phase adds no new auth mechanism, only a new permission check on top of it |
| V3 Session Management | no | No new session behavior |
| V4 Access Control | yes | `requirePermission("contact","export")` (new resource, existing enforcement mechanism); anti-enumeration `NOT_FOUND_BODY` reuse for cross-tenant/nonexistent contact ids |
| V5 Input Validation | yes | `z.string().uuid()` validation on the `:id` path param before it reaches any query (mirrors `csv-import.routes.ts`'s WR-06 precedent of validating an attacker-controlled id before it reaches a header/query) |
| V6 Cryptography | no | No new cryptographic operation; this phase does not touch KMS/envelope encryption |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Cross-tenant data disclosure via a contact id from another workspace | Information Disclosure | `resolveWorkspaceMember` + explicit `workspace_id = $1 AND id = $2` filter on every query, backed by RLS as defense-in-depth (SC4) |
| Privilege escalation — a Member calling the export route directly (bypassing the UI) | Elevation of Privilege | `requirePermission("contact","export")` preHandler, server-side, never trusting the client's role display (DSR-04) |
| PII leakage through unbounded freeform JSONB (`events.properties`, `send_events.payload`) carrying another subject's data under an unanticipated key | Information Disclosure | Build-up allowlist reconstruction, not a denylist (D-01/D-02); tested via a synthetic other-subject-field proof (SC4's "synthetic field" requirement) |
| Requester-identity leakage into a file handed to an outside party | Information Disclosure | D-06: requester identity deliberately excluded from the exported document; logged server-side only (D-11) |
| Filename-based information leakage (PII in a downloaded filename appearing in browser history/downloads folder) | Information Disclosure | D-08: filename contains only IDs and a date, no PII |
| Partial/half-scrubbed data disclosure due to a race with the async erasure-scrub worker | Information Disclosure / Tampering-adjacent (an inconsistent read) | `REPEATABLE READ` transaction isolation for the entire export read (see Common Pitfall 1) — the single most important, previously-unidentified control this research surfaces |

## Sources

### Primary (HIGH confidence — verified directly against this repository's source in this session)
- `apps/worker/src/queues/erasure-scrub.worker.ts` — allowlist constants, build-up reconstruction functions, keyset-pagination precedent, `ERASURE_SCRUB_PAGE_LIMIT`
- `apps/api/src/middleware/role-guard.ts`, `apps/api/src/modules/auth/access-control.ts` — `requirePermission` mechanism and the confirmed ABSENCE of a `contact`/export-shaped resource today
- `apps/api/src/modules/tenancy/resolve-workspace-member.ts` — `NOT_FOUND_BODY` anti-enumeration shape
- `packages/tenant-context/src/index.ts` — `withTenantTransaction`'s exact `BEGIN` + `SELECT set_config(...)` sequence (source of Pitfall 1)
- `packages/db/src/schema/{contacts,erasure-records,subscription-status-history,events,sends,send-events,flow-runs,flow-run-steps,campaign-recipients}.ts` and `packages/db/migrations/*.sql` — table shapes and the confirmed missing indexes (source of Pitfall 2)
- `apps/api/src/modules/contacts/csv-import.routes.ts` — the only existing `Content-Disposition` precedent in this codebase
- `apps/web/src/lib/api.ts`, `apps/web/src/features/contacts/ContactDetailPage.tsx`, `apps/web/src/features/campaigns/CampaignDetailPage.tsx`, `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx` — frontend fetch/error/role-display conventions
- `apps/api/src/modules/tenancy/__tests__/role-guard.test.ts` — role-gated route test harness precedent (`addMemberWithRole`)
- `apps/worker/src/queues/__tests__/erasure-scrub.test.ts` — the module-source-check test whose import path must survive the D-03 relocation (source of Pitfall 3)
- `packages/*/package.json` — confirmed both `apps/api` and `apps/worker` already depend on `@mega-crm/delivery-core` and `@mega-crm/contacts-core`

### Secondary (MEDIUM confidence)
- [PostgreSQL 18 docs — SET TRANSACTION](https://www.postgresql.org/docs/current/sql-set-transaction.html) — confirms isolation level cannot be changed after the first query of a transaction, and that `BEGIN ISOLATION LEVEL ...` is valid combined syntax
- [PostgreSQL 18 docs — Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html) — `REPEATABLE READ` takes one consistent snapshot at the transaction's first query

### Tertiary (LOW confidence)
- None used for load-bearing claims in this document.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries; every construct verified against this repo's own source
- Architecture: HIGH for the reused patterns (allowlist, role-guard, keyset pagination — all read directly from working code); MEDIUM-HIGH for the new isolation-level wrapper (the *need* for it is HIGH-confidence verified, the *exact API shape* to add to `withTenantTransaction` is a plan-time design choice, not yet written)
- Pitfalls: HIGH — all four are grounded in direct source reads (migrations, test files, the tenant-context transaction helper) plus one externally-verified PostgreSQL semantic, not speculation

**Research date:** 2026-08-21
**Valid until:** 30 days (stable internal codebase; no fast-moving external dependency in this phase) — but re-verify Pitfall 2's index gap and Pitfall 1's isolation-level fix against the actual code the moment Phase 22's research begins, since both are explicitly shared concerns between Phase 21 and Phase 22 per CONTEXT.md's dependency note.
