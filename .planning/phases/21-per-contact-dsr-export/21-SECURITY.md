---
phase: 21
slug: per-contact-dsr-export
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-23
---

# Phase 21 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| browser → API (`GET .../dsr-export`) | Session-cookie-authenticated but role-untrusted request; `:slug` and `:id` are attacker-controlled | Contact id, workspace slug |
| API → Postgres | Tenant-scoped reads; RLS is defence-in-depth under explicit `workspace_id` filters | Full contact PII |
| exported artifact → outside party | Response body leaves the platform's trust boundary entirely — handed to the data subject | Contact profile, consent, events, sends, journeys |
| tenant-supplied JSONB → exported artifact | `send_events.payload` / `events.properties` written by tenant integrations and the provider webhook | Freeform, potentially third-party PII |
| shared package → two runtimes | One allowlist definition consumed by `apps/api` (disclose) and `apps/worker` (erase) | Payload key policy |
| concurrent erasure scrub → in-flight export | Two transactions on the same rows; export must not straddle the scrub's commit | Half-scrubbed PII |
| stale client cache → export request | Browser may hold an already-erased contact; API remains the authority | Erasure state |
| SPA / attacker-controlled page → API | State-changing verbs across origin; CORS-preflight properties of headers | Session cookie |
| rendered-but-invisible UI → user intent | Controls in the DOM outside the visible viewport can be actuated unseen | Destructive delete action |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-21-01-01 | Elevation of Privilege | dsr-export route gate | high | mitigate | `requirePermission("contact","export")` preHandler (dsr-export.routes.ts:43); 403 test | closed |
| T-21-01-02 | Information Disclosure | `:id` cross-tenant IDOR | critical | mitigate | `workspace_id = $1 AND id = $2` in tenant-bound txn, RLS underneath, `NOT_FOUND_BODY` 404 (routes.ts:76, repository.ts:527); byte-identical-404 test | closed |
| T-21-01-03 | Information Disclosure | exported artifact contents | high | mitigate | Requester identity never assembled into document; test asserts no requester substring in body | closed |
| T-21-01-04 | Information Disclosure | Content-Disposition filename | medium | mitigate | `dsr-export-{uuid}-{date}.json`, uuid-validated id (routes.ts:79; test at dsr-export.test.ts:155) | closed |
| T-21-01-05 | Information Disclosure | half-scrubbed read during concurrent erasure | high | mitigate | Single `withTenantTransactionRepeatableRead` snapshot; `anonymized_at` is first read inside it (repository.ts:488-546); isolation test in plan 21-05 | closed |
| T-21-01-06 | Repudiation | who exported whose data | low | accept | Structured Pino line via correlation pipeline into Loki; durable table deliberately deferred (see Accepted Risks) | closed |
| T-21-01-07 | Denial of Service | unbounded synchronous read | medium | mitigate | Bounded 500-row keyset pages via `walkToExhaustion`; existing `@fastify/rate-limit` | closed |
| T-21-01-SC | Tampering | supply chain | low | accept | No package installs in this phase (see Accepted Risks) | closed |
| T-21-02-01 | Information Disclosure | send_events.payload allowlist | high | mitigate | Build-up reconstruction `buildExportSendEventPayload` over fixed named list (send-event-payload-allowlist.ts:171); nested-PII-absent test | closed |
| T-21-02-02 | Information Disclosure | allowlist drift export vs erasure | high | mitigate | `SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST` declared as spread of evidence list — superset relation structural; set-difference test | closed |
| T-21-02-03 | Tampering | relocation changing erasure behaviour | medium | mitigate | Verbatim move; pre-existing `erasure-scrub.test.ts` passes byte-unchanged | closed |
| T-21-02-04 | Information Disclosure | inventory drift from schema | medium | mitigate | Every inventoried column checked against `packages/db/src/schema/`; same-change rule binds Phase 22 | closed |
| T-21-02-SC | Tampering | supply chain | low | accept | No package installs (see Accepted Risks) | closed |
| T-21-03-01 | Information Disclosure | events.properties | high | mitigate | Column never named in export SELECT (repository.ts:116 selects only id/name/occurred_at/received_at); seeded-PII-absent test | closed |
| T-21-03-02 | Information Disclosure | contact-scoping of both walks | high | mitigate | Explicit `workspace_id = $1 AND contact_id = $2` per page (repository.ts:82), RLS underneath; foreign-rows-absent tests | closed |
| T-21-03-03 | Tampering | silent truncation across pages | high | mitigate | Walk-to-exhaustion with cursor advance; `DSR_EXPORT_PAGE_LIMIT + 7` multi-page test; unique-id assertion; `metadata.sectionRowCounts` from real array lengths | closed |
| T-21-03-04 | Information Disclosure | unstable paging on partitioned table | medium | mitigate | `occurred_at`-leading keyset `(occurred_at, id)` (repository.ts:109,119); no LIMIT/OFFSET paging | closed |
| T-21-03-SC | Tampering | supply chain | low | accept | No package installs (see Accepted Risks) | closed |
| T-21-04-01 | Information Disclosure | widening contact response shape | low | mitigate | Only lifecycle timestamp `anonymizedAt` added; tenant-facing selects keep filtering anonymized rows | closed |
| T-21-04-02 | Elevation of Privilege | relaxing a read filter for UI state | high | mitigate | `anonymized_at IS NULL` predicate set untouched (present in contact.repository.ts, contacts.routes.ts, dashboard.repository.ts); `CONTACT_COLUMNS` unmodified | closed |
| T-21-04-03 | Spoofing | trusting client erased/enabled state | medium | mitigate | Disabled state is courtesy; typed 410 from route is enforcement point (routes.ts:102) — confirmed live in UAT Test 2 | closed |
| T-21-04-04 | Information Disclosure | erased-contact reason copy | low | accept | Fixed string names no personal data (see Accepted Risks) | closed |
| T-21-04-SC | Tampering | supply chain | low | accept | No package installs (see Accepted Risks) | closed |
| T-21-05-01 | Information Disclosure | tenant-invented payload keys | critical | mitigate | Build-up reconstruction on every row; synthetic-field test seeds foreign PII under innocuous keys incl. embedded free text, asserts absent | closed |
| T-21-05-02 | Information Disclosure | send events via join | high | mitigate | `se.workspace_id = $1 AND s.contact_id = $2` per page, RLS underneath; foreign-send-events-absent test | closed |
| T-21-05-03 | Information Disclosure | half-scrubbed payloads during erasure | high | mitigate | Whole export in one REPEATABLE READ snapshot; proven against real interleaved scrub with READ COMMITTED control failing same assertion | closed |
| T-21-05-04 | Tampering | truncation of partitioned-table walk | high | mitigate | `occurred_at`-leading keyset, walk to exhaustion, `+3` multi-page test, unique-id assertion, independent `sendEvents` count | closed |
| T-21-05-05 | Information Disclosure | applying the wrong allowlist | high | mitigate | Erasure builder provably absent from export path (grep gate); export-only-keys-survive test | closed |
| T-21-05-SC | Tampering | supply chain | low | accept | No package installs (see Accepted Risks) | closed |
| T-21-06-01 | Information Disclosure | journey-table contact scoping | high | mitigate | Explicit `workspace_id + contact_id` on run/membership walks; steps only via this contact's run ids; RLS; foreign-rows-absent test | closed |
| T-21-06-02 | Tampering | silent omission of terminal flow runs | high | mitigate | No status predicate on run walk; explicit terminal-run-present test; migration 0067 unconditional index | closed |
| T-21-06-03 | Denial of Service | uncovered sequential scan per export | medium | mitigate | Migration `0067_dsr_export_contact_indexes.sql`: two `(workspace_id, contact_id)` indexes + `flow_run_steps` FK index; both migration test paths | closed |
| T-21-06-04 | Repudiation | as-built record overstating guarantee | medium | mitigate | Documented claims spot-checked against route/repository source; SUMMARYs are authority | closed |
| T-21-06-05 | Tampering | migration applied under broken path | medium | mitigate | Plain `CREATE INDEX`; `lint:migrations` + `test:migrations` + `ensureTestDbMigrated` = three independent applies | closed |
| T-21-06-SC | Tampering | supply chain | low | accept | No package installs; absence recorded in SPECIFICATION.md §2 (see Accepted Risks) | closed |
| T-21-07-01 | Spoofing (CSRF) | apiFetch header construction | medium | mitigate | Content-Type dropped only for bodyless requests (api.ts:34); DELETE is not CORS-simple; body-carrying verbs keep `application/json` — preflight-forcing property pinned by per-verb matrix test | closed |
| T-21-07-02 | Tampering | Fastify content-type parser | high | transfer | Rejected server-side fix stays rejected: no `addContentTypeParser` change; strict default JSON contract guards public event-ingestion and webhook signature verification. Documented so the client fix is never "simplified" into a server relaxation | closed |
| T-21-07-03 | Information Disclosure | e2e fixtures | low | accept | Synthetic `@example.com` contacts in run-scoped ephemeral DB, dropped after run (see Accepted Risks) | closed |
| T-21-07-SC | Tampering | supply chain | low | accept | No package installs; spec uses already-declared `@playwright/test` (see Accepted Risks) | closed |
| T-21-08-01 | Elevation of Privilege | mobile drawer rendering WorkspaceNav | low | mitigate | Drawer renders identical NavLink set behind same `/w/:slug` route guard; no new route/fetch/role-dependent link; server-side authz unchanged | closed |
| T-21-08-02 | Tampering | duplicate nav rendering | medium | mitigate | Sheet content unmounted while closed; desktop aside out of layout below md; segments.spec.ts role-based link queries would fail on a duplicate. WR-01 resize edge case human-verified in UAT Test 4 (pass) | closed |
| T-21-08-03 | Repudiation | destructive Delete rendered off-viewport | medium | mitigate | Bounding-box assertions in contact-card-narrow-viewport.spec.ts make on-screen placement machine-checked (RED 1220px → GREEN 375px) | closed |
| T-21-08-04 | Information Disclosure | inline export error reflow | low | accept | Fixed non-interpolated strings per UI-SPEC copy contract; no PII can enter the slot (see Accepted Risks) | closed |
| T-21-08-SC | Tampering | supply chain | low | accept | No package installs; `@radix-ui/react-dialog` and `lucide-react` already declared (see Accepted Risks) | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-21-01 | T-21-01-06 | Export audit trace is a structured Pino line (requester/workspace/contact/counts) through the existing correlation pipeline into Loki; a durable `dsr_export_records` table was considered and deliberately deferred (CONTEXT.md Deferred Ideas) — no DSR-* requirement asks for it | plan 21-01 threat model (user-approved plan) | 2026-08-22 |
| AR-21-02 | T-21-04-04 | Erased-contact reason copy states personal data was deleted and names no personal data; identical fixed string in disabled state and 410 branch | plan 21-04 threat model | 2026-08-22 |
| AR-21-03 | T-21-07-03 | E2e spec creates synthetic `@example.com` contacts in the run-scoped ephemeral database dropped by `e2e/run-e2e.ts` after the run; no production data touched | plan 21-07 threat model | 2026-08-23 |
| AR-21-04 | T-21-08-04 | Inline export message slot carries only fixed, non-interpolated Russian sentences per the 21-UI-SPEC copywriting contract; reflow exposes nothing new | plan 21-08 threat model | 2026-08-23 |
| AR-21-SC | T-21-01-SC … T-21-08-SC (8 threats) | No package-manager install task exists anywhere in Phase 21 — RESEARCH.md Package Legitimacy Audit records "not applicable: no new external packages", verified against every workspace `package.json`; plan 21-06 additionally records the absence in SPECIFICATION.md §2 | phase 21 research + plan threat models | 2026-08-22 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-23 | 41 | 41 | 0 | /gsd-secure-phase orchestrator (L1 grep-depth verification; short-circuit — register authored at plan time, asvs_level 1). Mitigation evidence cross-checked against 21-VERIFICATION.md (18/18) and completed 21-UAT.md (4/4 passed incl. live 410-race and drawer human checks) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-23
