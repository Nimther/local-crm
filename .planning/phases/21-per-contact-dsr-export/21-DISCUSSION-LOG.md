# Phase 21: Per-Contact DSR Export - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-21
**Phase:** 21-Per-Contact DSR Export
**Areas discussed:** JSONB allowlist rule (DSR-03), File format & structure, Delivery mechanics, Erased-contact & edge states (SC5)

---

## JSONB allowlist rule (DSR-03)

### events.properties handling

| Option | Description | Selected |
|--------|-------------|----------|
| Exclude entirely (Recommended) | Export non-JSONB event columns only; mirrors erasure ruling — tenant-defined keyspace is un-allowlistable, exclusion is the only provable SC4 bound | ✓ |
| Platform allowlist of safe keys | Static set of keys believed safe; contradicts Phase 13 reasoning — any named key is a guess about tenant schemas | |
| Include with marker | Full properties flagged as unverified; fails SC4 by construction | |

### send_events.payload allowlist

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse evidence allowlist as-is | Import SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST verbatim; zero divergence risk but subject never receives their own ip/useragent/url | |
| Extended export allowlist (Recommended) | Evidence keys + subject's own single-recipient fields (ip, useragent, url, reason); export ⊇ evidence, both explicit build-up allowlists | ✓ |
| You decide | Claude picks during planning | |

### Sharing with Phase 22

| Option | Description | Selected |
|--------|-------------|----------|
| Shared package + inventory doc (Recommended) | Allowlist constants in a shared package importable by api + worker; written PII-inventory enumerating per-table personal data; Phase 22 consumes both | ✓ |
| Code constants only | Shared package but no written inventory | |
| Duplicate + test lockstep | Two definitions held together only by a test | |

### Gray-zone table scope

| Option | Description | Selected |
|--------|-------------|----------|
| Journey tables too (Recommended) | Include flow_runs/flow_run_steps and campaign_recipients (processing history is personal data); exclude infrastructure rows with documented reasons | ✓ |
| Send-pipeline minimum | Only what DSR-01/02 literally name | |
| Everything keyed to contact_id | Mechanically include every table with a contact_id FK | |

---

## File format & structure

### Overall file shape

| Option | Description | Selected |
|--------|-------------|----------|
| Single JSON document (Recommended) | One .json with top-level sections; one HTTP response; allowlist compliance testable against whole document | ✓ |
| ZIP of per-table files | Klaviyo/Stripe export style; adds archive dependency | |
| NDJSON stream | Constant-memory streaming; least convenient to read | |

### Metadata block

| Option | Description | Selected |
|--------|-------------|----------|
| Full provenance (Recommended) | generated_at, workspace id + name, contact id, format version, allowlist version, per-section row counts | ✓ |
| Minimal | Just generated_at + contact id + format version | |
| Include requester identity too | Full provenance + requester; puts an employee's identity into a file handed to an outside party | |

### Field naming

| Option | Description | Selected |
|--------|-------------|----------|
| camelCase API convention (Recommended) | Same shapes the existing zod/API layer uses | ✓ |
| Raw snake_case DB names | Literal column names; diverges from every other platform contract | |

### Filename

| Option | Description | Selected |
|--------|-------------|----------|
| IDs only (Recommended) | dsr-export-{contactId}-{YYYY-MM-DD}.json — no PII in filenames | ✓ |
| Human-friendly with email | Subject's email lands in filesystem paths and logs | |
| You decide | — | |

---

## Delivery mechanics

### Production & delivery

| Option | Description | Selected |
|--------|-------------|----------|
| Synchronous download (Recommended) | One request → keyset-paginated assembly → Content-Disposition response; proven Fastify pattern | ✓ |
| Background job + ready link | BullMQ job + polling UI + artifact storage/retention; heavy for per-contact export | |
| Sync with async fallback | Two code paths to test and prove | |

### Volume bounds

| Option | Description | Selected |
|--------|-------------|----------|
| Complete, no truncation (Recommended) | Keyset-paginate every section to completion in bounded pages (500-row erasure precedent); truncated DSR file is a compliance defect | ✓ |
| Hard cap + truncation marker | Ships an incomplete subject-access answer by design | |
| Cap + refuse | Typed refusal above a threshold | |

### UI trigger

| Option | Description | Selected |
|--------|-------------|----------|
| Fetch + blob with states (Recommended) | Authenticated fetch, in-progress state, blob save, typed errors inline | ✓ |
| Plain link navigation | Errors render as raw JSON in a tab — weak fit for SC5 | |
| You decide | — | |

### Audit trace

| Option | Description | Selected |
|--------|-------------|----------|
| Structured log line (Recommended) | Pino log (requester, workspace, contact, counts) via existing correlation pipeline into Loki | ✓ |
| Dedicated audit table | dsr_export_records like erasure_records; better weighed as its own backlog item | |
| No trace | Compliance-flavored feature with zero record of use is an odd gap | |

---

## Erased-contact & edge states (SC5)

### API response for anonymized contact

| Option | Description | Selected |
|--------|-------------|----------|
| Typed status, no file (Recommended) | HTTP 410, code contact_erased, erasedAt, erasure-record reference | ✓ |
| File with erased-state section | File of empty shells could be mistaken for a real DSR answer | |
| You decide | — | |

### UI on erased contact

| Option | Description | Selected |
|--------|-------------|----------|
| Disabled with inline reason (Recommended) | Extends computeIncompleteReason disabled-button-with-inline-copy pattern; 410 remains race backstop | ✓ |
| Hidden entirely | No explanation why the action is missing | |
| Clickable, typed message on click | Invites clicks that can never succeed | |

### Erasure gate semantics

| Option | Description | Selected |
|--------|-------------|----------|
| anonymizedAt is the gate (Recommended) | Any non-null anonymizedAt → 410, checked in the reading transaction; fail-closed, mid-scrub export impossible | ✓ |
| Gate on scrub completion | Would allow export during the inconsistent erasure window | |
| You decide | — | |

### Refusal shapes

| Option | Description | Selected |
|--------|-------------|----------|
| 403 role / 404 anti-enum (Recommended) | Member → 403 via requirePermission; cross-tenant/unknown id → NOT_FOUND_BODY 404 | ✓ |
| 404 for everything | Diverges from every other role-gated route | |
| You decide | — | |

---

## Claude's Discretion

- Route path/verb, zod schema details, error body field names beyond typed codes
- Section ordering, timestamp serialization, exact pagination page size
- Location of the shared allowlist package (existing package vs new compliance module)
- PII inventory placement (SPECIFICATION.md section vs dedicated doc)
- Test harness for SC4 synthetic-field proof and cross-tenant negative test
- Export button placement/copy and UI states on ContactDetailPage

## Deferred Ideas

- Durable DSR export audit table (`dsr_export_records`) — deferred at D-11; revisit if a compliance requirement for export evidence emerges
