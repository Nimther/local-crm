---
phase: 03
slug: segmentation-engine
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-07-06
---

# Phase 03 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| client → API → compiler | `SegmentDefinition` JSON authored in the browser reaches the backend as untrusted input that directly shapes SQL | Untrusted JSON → SQL fragments |
| client → segments API | Session-authed workspace members POST definitions and pagination params; definition shapes SQL and count-query cost | Definitions, pagination params |
| API → Postgres (RLS) | Every segment/count/member query must carry the per-transaction tenant GUC | Tenant-scoped contact/segment rows |
| browser builder → segments API | Definition assembled client-side; server (Zod + allow-list) is the security authority | SegmentDefinition JSON |
| validated definition → SQL compiler | Compiler is the last line of defense; field names must never reach SQL as raw identifiers | Field/operator names, values |
| route handler → tenant DB pool | Every evaluation holds a pooled connection; unbounded queries would exhaust the pool | Compiled evaluation queries |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-03-01 | Tampering (SQL identifier injection) | segments-core compile.ts / operators.ts | high | mitigate | Null-prototype `STANDARD_FIELD_COLUMNS` allow-list (`operators.ts:25`), throw on unknown field (`compile.ts:49`); values only bound as `$N` params | closed |
| T-03-02 | Tampering | compile.ts AND/OR precedence | medium | mitigate | Every group's OR'd conditions unconditionally parenthesized (`compile.ts:22`) | closed |
| T-03-03 | Information Disclosure | segment.repository.ts CRUD/count/list | high | mitigate | All queries via `withTenantTransaction`; `segments` has ENABLE+FORCE RLS + `workspace_isolation` policy (`packages/db/migrations/0012_segments_rls_and_indexes.sql`); no `pool.query` bypass | closed |
| T-03-04 | Denial of Service | segment evaluation (preview-count, save, members) | high | mitigate | `SET LOCAL statement_timeout` via `set_config` on every evaluation path (`segment.repository.ts:76,104,166`); 57014 mapped to degraded/4xx (`segments.routes.ts:44`) | closed |
| T-03-05 | Information Disclosure | segments.routes.ts auth | low | mitigate | `resolveWorkspaceMember` returns 404 on unauthenticated/non-member/unknown-slug (`segments.routes.ts:97`) — no workspace-enumeration oracle | closed |
| T-03-06 | Denial of Service | event-names.repository.ts | medium | mitigate | Loose-index-scan recursive CTE (`event-names.repository.ts:15`) instead of `SELECT DISTINCT` | closed |
| T-03-07 | Tampering (validation bypass) | SegmentBuilder client validation | medium | mitigate | Client validation is UX-only; server-side Zod schemas + compiler allow-list are the authority (`packages/shared-schemas/src/segment.ts`) | closed |
| T-03-08 | Information Disclosure | GET /segments/:id/members | high | mitigate | `listSegmentMembers` under `withTenantTransaction`/RLS; 404-not-403 member gate | closed |
| T-03-09 | Denial of Service | live-count request storm | low | mitigate | 300ms debounce (`SegmentBuilder.tsx:525`, `useDebouncedValue.ts`) + server statement_timeout as the real bound | closed |
| T-03-10 | Information Disclosure | segment name / recap / error rendering | low | accept | React escapes interpolated text; rendered as text nodes, not HTML | closed |
| T-03-11 | Tampering (IDOR) | DELETE /segments/:id | medium | mitigate | `deleteSegment` RLS-scoped under `withTenantTransaction`; cross-workspace id resolves 404 | closed |
| T-03-12 | Tampering (incorrect membership) | contains/not_contains ILIKE | medium | mitigate | `escapeLikeWildcards` escapes `\`, `%`, `_` (`operators.ts:56-57`) | closed |
| T-03-13 | DoS / error amplification | unconstrained field at Zod boundary | high | mitigate | `STANDARD_FIELD_KEYS` allow-list + `superRefine` fails closed with 400 at the contract (`shared-schemas/src/segment.ts:43,76`) | closed |
| T-03-14 | Information Disclosure | 4xx error body on canceled evaluation | low | accept | Generic "definition too expensive" message; no query internals or tenant data echoed | closed |
| T-03-15 | Information Disclosure | not-found card on bad id | low | accept | Generic «Сегмент не найден» card; API returns 404 for cross-tenant/unknown ids | closed |
| T-03-16 | Tampering (test fidelity) | route-intercepted degraded-state E2E | low | accept | Interception mirrors the real `{ degraded: true }` route shape; API side proven by preview-count.test.ts | closed |
| T-03-SC | Tampering (supply chain) | npm installs | low | accept | No new external packages this phase; only internal workspace deps and already-pinned vitest reused | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-03-01 | T-03-10 | React escapes interpolated text by default; names/recaps rendered as text nodes | plan-time threat model (03-03/03-04/03-07 PLAN) | 2026-07-06 |
| AR-03-02 | T-03-14 | Error body is a fixed generic message with no internals | plan-time threat model (03-06 PLAN) | 2026-07-06 |
| AR-03-03 | T-03-15 | Not-found card leaks nothing about cross-tenant existence (API already 404s) | plan-time threat model (03-07 PLAN) | 2026-07-06 |
| AR-03-04 | T-03-16 | Test-only interception mirrors real route shape; production boundary unchanged | plan-time threat model (03-08 PLAN) | 2026-07-06 |
| AR-03-05 | T-03-SC | No new external packages installed across all 8 plans | plan-time threat model (all PLANs) | 2026-07-06 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-06 | 17 | 17 | 0 | gsd-secure-phase (L1 short-circuit — register authored at plan time, all mitigations grep-verified) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-06
