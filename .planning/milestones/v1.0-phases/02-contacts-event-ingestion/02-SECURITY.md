---
phase: 2
slug: contacts-event-ingestion
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-07-05
---

# Phase 2 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| browser (session) → API | Authenticated marketer submits contact CRUD, CSV uploads, and reads | Contact PII, subscription status, uploaded CSV files |
| tenant backend → /v1 API (API key) | Untrusted server-to-server input (contacts upsert, event batches); Bearer key alone determines workspace | API key secrets, contact identities, event payloads |
| API → Postgres | Every tenant-scoped query must carry the RLS tenant GUC | All tenant data (contacts, suppressions, events, api keys, csv imports) |
| queue (Redis) → workers | Job payload is the sole trusted context; workspaceId re-derived from job data | Event/CSV job payloads; jobId is a global-per-queue namespace |
| worker → Postgres | Workers open their own RLS tenant transactions via shared @mega-crm/tenant-context | Contact upserts, partitioned event writes, staging rows |
| build/supply chain → runtime | npm dependencies (bullmq, ioredis, @bull-board/*, csv-parse, @fastify/multipart) | Executable code inside the trust boundary |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-02-01-01 | Information Disclosure | contacts / suppressions / registry tables | high | mitigate | ENABLE + FORCE RLS + `workspace_isolation` policy (`packages/db/migrations/0004_contacts_rls_policies.sql`); repository runs inside `withTenantTransaction` | closed |
| T-02-01-02 | Tampering | createContact/updateContact suppression bypass | high | mitigate | Suppression list forces suppressed status on create (D-08/D-11); D-12 transition guards reject suppressed→subscribed (`apps/api/src/modules/contacts/contact.repository.ts`) | closed |
| T-02-01-03 | Tampering | SQL injection via freeform properties | medium | mitigate | Parameterized $-placeholder queries; property values go into JSONB column, never SQL text | closed |
| T-02-01-04 | Spoofing | workspace enumeration via contact routes | low | mitigate | Uniform 404 non-enumeration pattern (`apps/api/src/modules/contacts/contacts.routes.ts:52-70`) | closed |
| T-02-02-01 | Elevation of Privilege | client-side role gating of contact actions | low | mitigate | Server (02-01 routes + RLS) is the enforcement layer; UI gating is cosmetic only | closed |
| T-02-02-02 | Tampering | un-suppressing a contact from the UI | medium | mitigate | Suppressed control non-actionable in UI (D-12); server rejects the transition | closed |
| T-02-03-01 | Spoofing | api-key brute-force / credential stuffing | high | mitigate | 256-bit secrets + SHA-256 hash storage + `crypto.timingSafeEqual` (`apps/api/src/modules/api-keys/api-key-auth.ts`); @fastify/rate-limit on /v1 routes | closed |
| T-02-03-02 | Information Disclosure | key enumeration via timing/error differences | medium | mitigate | Uniform 401 body + constant-time compare; unknown-prefix and wrong-secret indistinguishable | closed |
| T-02-03-03 | Information Disclosure | plaintext api-key secret at rest / in logs | high | mitigate | Only SHA-256 hash + mask persisted; secret returned once at creation, never logged (D-22) | closed |
| T-02-03-04 | Elevation of Privilege | Member creating/revoking api keys | high | mitigate | `requirePermission("apiKeys", ...)` gates create/revoke to Owner/Admin (`apps/api/src/modules/api-keys/api-keys.routes.ts:29,45,75`) | closed |
| T-02-03-05 | Information Disclosure | workspace_api_keys cross-tenant read | high | mitigate | ENABLE + FORCE RLS + `workspace_isolation` (`packages/db/migrations/0006_api_keys_rls_policies.sql`) | closed |
| T-02-04-01 | Tampering | reserved-key mass assignment via properties | high | mitigate | `RESERVED_CONTACT_PROPERTY_KEYS` denylist stripped before JSONB merge (`packages/contacts-core/src/contact-repository.ts:71-83`) | closed |
| T-02-04-02 | Tampering | identity-anchor overwrite (immutable external_id) | high | mitigate | Branch C ignores differing incoming external_id and logs `external_id_conflict` (`packages/contacts-core/src/contact-repository.ts:210-303`) | closed |
| T-02-04-03 | Denial of Service | unauthenticated large-body parsing on /v1/contacts | medium | mitigate | apiKeyAuth on onRequest before body parse + route-scoped rate limit (100/min) + bounded body size (`apps/api/src/modules/contacts/contacts-api.routes.ts:26-30`) | closed |
| T-02-04-04 | Information Disclosure | cross-tenant write via wrong workspace resolution | high | mitigate | Workspace resolved solely from `request.apiKeyWorkspaceId`; upsert inside withTenant + RLS | closed |
| T-02-04-05 | Repudiation | silent data conflicts (D-04/A1) | low | accept | Structured Pino conflict logs are the v1 visibility surface; conflicts UI deferred to v2 (D-05) — see Accepted Risks Log | closed |
| T-02-05-SC | Tampering | npm supply chain (bullmq, ioredis, @bull-board/*, csv-parse, @fastify/multipart) | high | mitigate | Blocking-human legitimacy checkpoint verified each package/registry/version before install (02-05 Task 1) | closed |
| T-02-05-01 | Info Disclosure / EoP | worker inventing its own tenant-scoping | high | mitigate | Single shared `@mega-crm/tenant-context` package imported by workers (`apps/worker/src/queues/*.worker.ts`); no re-implemented set_config | closed |
| T-02-05-02 | Denial of Service | API booting without reachable Redis | low | mitigate | `REDIS_URL` Zod-required at boot (`apps/api/src/env.ts:8`); missing config fails loudly before listen | closed |
| T-02-06-01 | Denial of Service | unbounded event payload / batch size | high | mitigate | Body limit + `eventBatchSchema` `.max(1000)` (`packages/shared-schemas/src/contact.ts:133`) + route rate limit; apiKeyAuth before body parse | closed |
| T-02-06-02 | Tampering | duplicate/double-counted events on retry | high | mitigate | Deterministic id + `ON CONFLICT (workspace_id, id, occurred_at) DO NOTHING` (`apps/worker/src/queues/events-ingest.worker.ts:43`) | closed |
| T-02-06-03 | Tampering | reserved-key mass assignment via event properties | high | mitigate | `upsertContactByIdentity` strips reserved keys before JSONB merge (shared with 02-04); worker test asserts subscription_status cannot flip | closed |
| T-02-06-04 | Info Disclosure / EoP | cross-tenant event write from worker | high | mitigate | Worker re-derives workspaceId from job.data; withTenantTransaction + RLS on partitioned events table (`packages/db/migrations/0007_events_partitioned.sql:50-53`) | closed |
| T-02-06-05 | Repudiation | client mistakes 202 "accepted" for "processed" | low | accept | Per-item status explicitly "accepted" (queued) in API contract (D-24) — see Accepted Risks Log | closed |
| T-02-07-01 | Denial of Service | oversized / malicious CSV upload | high | mitigate | Route-scoped @fastify/multipart `fileSize` limit (`apps/api/src/modules/contacts/csv-import.routes.ts:142`); true streaming via csv-parse into staging | closed |
| T-02-07-02 | Tampering | double-applied rows on job retry | high | mitigate | `UNIQUE(csv_import_id, row_number)` staging key (`packages/db/migrations/0008_exotic_skullbuster.sql:9`) makes redelivered chunks no-ops | closed |
| T-02-07-03 | Tampering | reserved-key mass assignment via CSV columns | high | mitigate | Rows flow through `upsertContactByIdentity` which strips reserved keys (shared path) | closed |
| T-02-07-04 | Info Disclosure / EoP | cross-tenant write from CSV worker | high | mitigate | Worker re-derives workspaceId from job.data; withTenantTransaction + RLS on csv_imports / csv_import_rows (`packages/db/migrations/0009_csv_imports_rls_policies.sql`) | closed |
| T-02-07-05 | Tampering | multipart breaking global JSON body parser | medium | mitigate | @fastify/multipart registered route-scoped only, never at root | closed |
| T-02-08-01 | Information Disclosure | contact-events read leaking cross-tenant events | high | mitigate | `listContactEvents` runs inside withTenantTransaction; RLS on events parent table | closed |
| T-02-08-02 | Denial of Service | unbounded event feed / import history reads | low | mitigate | Both reads paginated; feed reads newest-first with page limit | closed |
| T-02-09-01 | Tampering | updateContact `properties` full replacement | medium | mitigate | Standard columns written from typed fields only; `properties` is a separate JSONB column — a property named "email" cannot flip the real column | closed |
| T-02-09-02 | Information Disclosure | null-clearing standard fields | low | accept | Clearing to NULL affects only the caller's own tenant row (RLS) — see Accepted Risks Log | closed |
| T-02-09-03 | Elevation of Privilege | subscription_status via session PATCH | low | mitigate | D-12 transition guards in updateContact untouched; suppressed cannot be set or exited via this path | closed |
| T-02-10-01 | Spoofing / Tampering | client-supplied eventId as global jobId + events PK | high | mitigate | jobId scoped to `${workspaceId}-${eventId}` (`apps/api/src/modules/events/events-api.routes.ts:99`); PK/ON CONFLICT on `(workspace_id, id, occurred_at)` (`packages/db/migrations/0010_events_workspace_scoped_pk.sql`) — closes CR-01 at both queue and DB layers | closed |
| T-02-10-02 | Denial of Service (data loss) | out-of-window occurredAt drops accepted job | high | mitigate | `events_default` DEFAULT partition (`0010_events_workspace_scoped_pk.sql:36`); `attempts: 5` + exponential backoff on both queues (`events-queue.ts:46-47`, `imports-csv-queue.ts:42-43`) | closed |
| T-02-10-03 | Tampering | reserved-key property injection via event | low | accept | Unchanged shared strip path, proven by existing Pitfall-4 worker test — see Accepted Risks Log | closed |
| T-02-10-04 | Denial of Service | distinct-eventId flood bloating default partition | low | accept | Rate limit (100/min) bounds ingest per key; partition growth is an operational-monitoring follow-up — see Accepted Risks Log | closed |
| T-02-11-01 | Denial of Service | upsertContactByIdentity concurrent-insert race | medium | mitigate | SAVEPOINT + ROLLBACK TO SAVEPOINT survives 23505 (`packages/contacts-core/src/contact-repository.ts:234-263`); race resolves to winning row | closed |
| T-02-11-02 | Tampering / Repudiation | subscriptionStatus silently ignored on update | low | mitigate | Valid transitions applied on update branch with D-12 guards; suppressed still never settable via this path | closed |
| T-02-11-03 | Denial of Service | dead pooled connection re-checkout | medium | mitigate | `client.release(err)` on failed ROLLBACK destroys the client (`packages/tenant-context/src/index.ts:71-93`) | closed |
| T-02-12-01 | Elevation of Privilege | CSV setting subscriptionStatus=suppressed | medium | mitigate | `CSV_SETTABLE_SUBSCRIPTION_STATUSES` excludes suppressed; mapper refuses non-enum values (`packages/contacts-core/src/csv-mapping.ts:82-83`) | closed |
| T-02-12-02 | Tampering / Repudiation | false-success on malformed/truncated upload | medium | mitigate | Upload failure sets status `'failed'` (`csv-import.repository.ts:189`) and returns 413/non-success (`csv-import.routes.ts:211`) | closed |
| T-02-12-03 | Denial of Service | apply stuck 'applying' forever | low | mitigate | `stillPending > 0` throws so the job fails and retries (`apps/worker/src/queues/imports-csv.worker.ts:137-171`) | closed |
| T-02-12-04 | Information Disclosure | CSV formula injection in error report (IN-02) | low | accept | Error CSV originates from the tenant's own upload; noted for later hardening pass — see Accepted Risks Log | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-02-01 | T-02-04-05 | Silent data conflicts surfaced only via structured Pino logs; a conflicts UI is explicitly deferred to v2 (D-05). Low severity — repudiation visibility, not data loss. | plan author (02-04 threat model) | 2026-07-05 |
| AR-02-02 | T-02-06-05 | 202 means "accepted/queued", not "processed" — documented in the API contract (D-24). Client-side misinterpretation risk only. | plan author (02-06 threat model) | 2026-07-05 |
| AR-02-03 | T-02-09-02 | Null-clearing standard contact fields affects only the caller's own tenant row under RLS `workspace_isolation`; no cross-tenant reach. | plan author (02-09 threat model) | 2026-07-05 |
| AR-02-04 | T-02-10-03 | Reserved-key stripping path unchanged from 02-06 and proven by the existing Pitfall-4 worker test; 02-10 did not alter it. | plan author (02-10 threat model) | 2026-07-05 |
| AR-02-05 | T-02-10-04 | Ingest volume bounded per key by the 100/min rate limit; DEFAULT partition growth is an operational-monitoring concern. Partition pre-creation automation tracked as an operational follow-up. | plan author (02-10 threat model) | 2026-07-05 |
| AR-02-06 | T-02-12-04 | CSV formula injection in the error report (IN-02) is out of the 02-12 mandated scope; the error CSV originates from the tenant's own upload. Flagged for a later hardening pass. | plan author (02-12 threat model) | 2026-07-05 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-05 | 45 | 45 | 0 | gsd-secure-phase (L1 grep-depth, short-circuit: register authored at plan time, threats_open 0, asvs_level 1) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-05
