---
phase: 10
slug: tenant-isolation-trust-boundaries
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-09
---

# Phase 10 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| worker process → Postgres (scan pool) | Cross-tenant read credential (`mega_crm_scan`); least-privilege, unreachable from the API | Cross-workspace campaign/flow/send metadata |
| API process → Postgres (tenant pool) | Public-facing process; holds no credential or membership granting cross-tenant read | Tenant-scoped rows under RLS |
| API process → Postgres (auth pool) | Second credential (`mega_crm_auth`) scoped to the seven Better Auth tables only | Session tokens, password material, verification tokens |
| superuser bootstrap → cluster roles | Role creation lives outside the migration chain (`docker/init-app-role.sql` + `scripts/ensure-db-roles.mjs`) | Role definitions/grants |
| HTTP client → route handler | Non-member/unauthenticated probing of `:slug` and resource ids; responses must not reveal existence | Workspace/resource existence signals |
| authenticated client → resource routes | A member of one workspace probing ids of another | Cross-tenant resource metadata |
| unauthenticated client → invite preview | Public endpoint keyed by id; response shape must not enumerate | Invite metadata (minimized payload) |
| pooled connection → next request/job | Session state outliving a transaction crosses tenants invisibly | Tenant context GUCs / role state |
| application code → RLS predicate | Last line of defence; fail-closed on absent tenant context | All tenant rows |
| pre-tenant lookup → tenant tables | Two grant-bearing paths (API-key auth, webhook receipt) read before workspace is known | API-key hashes, webhook endpoint config |
| SendGrid delivery → webhook endpoint | One BYO key can back several workspaces; deliveries can carry sibling events | Sibling workspaces' send events |
| public internet → webhook receiver | Unauthenticated by session; signature + freshness + path token are the trust anchors | Signed webhook payloads |
| API-key holder → integration routes | Credential capability breadth bounded by scopes | Contacts/events integration data |
| any HTTP client → rate-limited routes | Brute-force/abuse surface; limit shared across instances via Redis | Auth/invite/API-key request volume |
| application memory → log output | Decrypted provider keys, session tokens, contact PII on every error path | Secrets and PII (redacted) |
| hostile job payload → job handler | Background jobs take workspace id as data; crafted payload is the internal analogue of a crafted request | Cross-workspace job parameters |

---

## Threat Register

All 89 threats registered at plan time across the phase's 14 plans. Grep-level (ASVS L1) verification found evidence for every `mitigate` disposition; every `accept` disposition is documented in the Accepted Risks Log below.

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-10-01-01 | Elevation of Privilege | tenant-pool code paths | high | mitigate | API env schema declares no scan DSN; source-level negative tests | closed |
| T-10-01-02 | Elevation of Privilege | `mega_crm_scan` role | high | mitigate | `NOBYPASSRLS`, owns no tables (docker/init-app-role.sql, ensure-db-roles.mjs); catalog assertions in scan.test.ts | closed |
| T-10-01-03 | Information Disclosure | `campaigns_scan` predicate | medium | mitigate | Predicate narrowed to `status='scheduled' AND scheduled_at <= now()` (migration 0041) | closed |
| T-10-01-04 | Elevation of Privilege | role membership chain | high | mitigate | `pg_has_role` asserted false; no `GRANT mega_crm_scan TO mega_crm_app` | closed |
| T-10-01-05 | Denial of Service | migration 0041 on role-less cluster | medium | mitigate | Idempotent `scripts/ensure-db-roles.mjs` in `predev` + ephemeral DB provisioning | closed |
| T-10-01-06 | Tampering | dev-role password reuse | low | accept | See AR-01 | closed |
| T-10-01-SC | Tampering | package installs | high | accept | See AR-02 | closed |
| T-10-02-01 | Information Disclosure | divergent membership wrappers | high | mitigate | Single `resolveWorkspaceMember` + shared `NOT_FOUND_BODY`; grep asserts no second declaration | closed |
| T-10-02-02 | Information Disclosure | non-member vs nonexistent workspace | high | mitigate | Byte-identical 404 status+body asserted (invite-response-identity / resolve-workspace-member tests) | closed |
| T-10-02-03 | Elevation of Privilege | resolver returning `roles` | medium | mitigate | No caller authorization change; `requirePermission` guards unchanged; full suite green | closed |
| T-10-02-04 | Spoofing | `toFetchHeaders` conversion | low | accept | See AR-03 | closed |
| T-10-02-SC | Tampering | package installs | high | accept | See AR-02 | closed |
| T-10-03-01 | Information Disclosure | `flow_runs_scan`/`flows_scan` predicates | high | mitigate | Narrowing predicates in migration 0042; exclusion-seeding tests | closed |
| T-10-03-02 | Information Disclosure | `contacts_scan`/`sends_scan` unrestricted rows | medium | accept | See AR-04 | closed |
| T-10-03-03 | Elevation of Privilege | scan-role write access | high | mitigate | SELECT-only grants; acceptance criterion greps migration for write grants | closed |
| T-10-03-04 | Information Disclosure | unscoped app policies in scan plans | high | mitigate | `ALTER POLICY ... TO mega_crm_app` scoping (migrations 0041/0042) | closed |
| T-10-03-05 | Elevation of Privilege | scan role reaching ungranted tables | medium | mitigate | Test asserts `flow_versions` read rejects; grants are enumerated allowlist | closed |
| T-10-03-SC | Tampering | package installs | high | accept | See AR-02 | closed |
| T-10-04-01 | Information Disclosure | per-route 404 branches | high | mitigate | `anti-enumeration-sweep.test.ts` asserts byte-identical missing vs cross-tenant per route | closed |
| T-10-04-02 | Information Disclosure | `requirePermission` 404 literal | medium | mitigate | Imports shared `NOT_FOUND_BODY` (drift eliminated; extended by review fix WR-05) | closed |
| T-10-04-03 | Information Disclosure | invite preview payload breadth | medium | mitigate | Payload minimized; exact-key-list assertion | closed |
| T-10-04-04 | Information Disclosure | missing-vs-forbidden timing | low | accept | See AR-05 | closed |
| T-10-04-05 | Spoofing | vacuous sweep | medium | mitigate | Positive control asserts 200 for own resource in same file | closed |
| T-10-04-SC | Tampering | package installs | high | accept | See AR-02 | closed |
| T-10-05-01 | Information Disclosure | connection-scoped session assignment | high | mitigate | `scripts/lint-session-state.mjs`; blocking CI step (`npm run lint:session-state`, ci.yml:70) | closed |
| T-10-05-02 | Elevation of Privilege | role switch on pooled connection | high | mitigate | Audit reports role switches unconditionally; separate login role + pool is the accepted mechanism | closed |
| T-10-05-03 | Tampering | audit matching nothing | high | mitigate | Violating fixture (3 violations) asserted to produce exactly 3 reports | closed |
| T-10-05-04 | Tampering | blanket suppression marker | medium | mitigate | Marker suppresses one statement, requires reason; both tested | closed |
| T-10-05-05 | Information Disclosure | hand-maintained file list | high | mitigate | Walker enumerates the source tree | closed |
| T-10-05-SC | Tampering | package installs | high | accept | See AR-02 (Node built-ins only) | closed |
| T-10-06-01 | Elevation of Privilege | residual marker-gated policies | high | mitigate | Migration 0043 drops all five; catalog assertion on `pg_policies` | closed |
| T-10-06-02 | Elevation of Privilege | sixth GUC touchpoint | high | mitigate | Marker-setting call removed; session-state audit guards regression | closed |
| T-10-06-03 | Elevation of Privilege | elevated relocation credential | high | mitigate | Operator-invoked CLI only (`packages/db/scripts/relocate-default-partition-rows.ts`); asserted absent from api/worker src | closed |
| T-10-06-04 | Denial of Service | relocation breaking post-change | medium | mitigate | Phase 9 relocation suite + non-empty case under new mechanism | closed |
| T-10-06-05 | Repudiation | policy/code halves reverted independently | medium | mitigate | Migration header couples both halves; audit + catalog assertion each catch one side | closed |
| T-10-06-SC | Tampering | package installs | high | accept | See AR-02 | closed |
| T-10-07-01 | Information Disclosure | fail-open predicate misread | high | mitigate | Migration 0044: all 22 policies fail-closed (raise on absent context); error-class asserted | closed |
| T-10-07-02 | Information Disclosure | unification in fail-open direction | high | mitigate | Prohibition P2 asserted over `pg_policies.qual`/`with_check` (survives later migrations) | closed |
| T-10-07-03 | Information Disclosure | table left out of rewrite | high | mitigate | Catalog assertion: exactly 22 policies, distinct-predicate set of size one | closed |
| T-10-07-04 | Elevation of Privilege | policies applying to PUBLIC | high | mitigate | Explicit role scope on every policy; catalog assertion fails on `public` | closed |
| T-10-07-05 | Denial of Service | API-key auth / webhook receipt breaking | high | mitigate | `withPreTenantLookup` sentinel; end-to-end suites for both paths | closed |
| T-10-07-06 | Elevation of Privilege | sentinel as de-facto grant | medium | mitigate | Sentinel matches no real row; zero-`contacts`-rows test; helper doc requires narrow keying | closed |
| T-10-07-SC | Tampering | package installs | high | accept | See AR-02 | closed |
| T-10-08-01 | Information Disclosure | sibling payloads persisted | high | mitigate | Per-event ownership resolution drops non-matching before insert; mixed-batch test (`webhook-events-sibling-drop.test.ts`) | closed |
| T-10-08-02 | Information Disclosure | drop-path log leaking sibling content | high | mitigate | Three-scalar-field signal; negative-match test on email/payload marker/send id | closed |
| T-10-08-03 | Denial of Service | one sibling event failing the batch | medium | mitigate | Per-event filtering, no early return; batch-still-inserts test | closed |
| T-10-08-04 | Information Disclosure | over-broad cross-workspace SELECT | medium | mitigate | Two-column SELECT + SELECT-only grant | closed |
| T-10-08-05 | Spoofing | forged `send_id` naming sibling send | medium | mitigate | Upstream signature check + ownership drop | closed |
| T-10-08-06 | Tampering | orphan behaviour changing | medium | mitigate | D-15 orphan path pinned; four existing suites pass unmodified | closed |
| T-10-08-SC | Tampering | package installs | high | accept | See AR-02 | closed |
| T-10-09-01 | Information Disclosure | auth tables readable by tenant paths | high | mitigate | Migration 0045 revokes all privileges on session/account/verification from `mega_crm_app`; catalog + runtime tests | closed |
| T-10-09-02 | Spoofing | weak signing secret | high | mitigate | 32-char production floor at boot (env.ts:98-103) with actionable message | closed |
| T-10-09-03 | Denial of Service | RLS breaking login | high | mitigate | Grants (not RLS) on auth tables; signup/login/invite-accept as acceptance gate | closed |
| T-10-09-04 | Elevation of Privilege | over-broad auth-role grants | medium | accept | See AR-06 | closed |
| T-10-09-05 | Elevation of Privilege | owner re-granting revoked privileges | medium | accept | See AR-07 | closed |
| T-10-09-06 | Denial of Service | missed write site post-revocation | medium | mitigate | Enumerated audit of live query sites; full API + e2e suites as detection net | closed |
| T-10-09-SC | Tampering | package installs | high | accept | See AR-02 | closed |
| T-10-10-01 | Elevation of Privilege | scopes stored but never checked | high | mitigate | Per-route `requireApiKeyScope`; route-enumeration test fails on unguarded new route | closed |
| T-10-10-02 | Elevation of Privilege | empty scope list = unrestricted | high | mitigate | Set-membership check with no empty-list special case; per-route tests | closed |
| T-10-10-03 | Information Disclosure | 403 enumerating scope vocabulary | medium | mitigate | One fixed 403 body naming no scope; byte-identical across routes | closed |
| T-10-10-04 | Denial of Service | integrations breaking on enforcement day | high | mitigate | Backfill + enforcement in one change (migration 0046 + code, per D-07) | closed |
| T-10-10-05 | Spoofing | authz before authn | medium | mitigate | Guard reads `request.apiKeyScopes` set only by auth hook; invalid key → 401 not 403, tested | closed |
| T-10-10-SC | Tampering | package installs | high | accept | See AR-02 | closed |
| T-10-11-01 | Tampering / Spoofing | replay of captured delivery | high | mitigate | Timestamp age bounded to 600s default; replay-after-window test (`webhook-timestamp-window.test.ts`) | closed |
| T-10-11-02 | Spoofing | future-dated timestamp | medium | mitigate | Bound on absolute difference | closed |
| T-10-11-03 | Information Disclosure | distinguishable rejection reasons | medium | mitigate | Stale/malformed/missing/bad-signature all take identical 400 path; byte-for-byte asserted | closed |
| T-10-11-04 | Tampering | freshness replacing verification | high | mitigate | Separate predicates composed at the route; fresh-timestamp-wrong-signature test | closed |
| T-10-11-05 | Denial of Service | clock-skew rejections | medium | accept | See AR-08 | closed |
| T-10-11-06 | Tampering | bounding the wrong timestamp field | medium | mitigate | Predicate takes header value only; worker per-event extraction untouched | closed |
| T-10-11-SC | Tampering | package installs | high | accept | See AR-02 | closed |
| T-10-12-01 | Elevation of Privilege | per-process limiter × replicas | high | mitigate | Redis-backed shared store; two-instance exact-429-count test (`rate-limit-distributed.test.ts`) | closed |
| T-10-12-02 | Denial of Service | webhook flood consuming session allowance | medium | mitigate | Independent route-level bucket; isolation asserted both directions | closed |
| T-10-12-03 | Denial of Service | limiter store outage | medium | accept | See AR-09 | closed |
| T-10-12-04 | Repudiation | silent loss of limiting | high | mitigate | Error listener logs via structured logger; Redis-down test asserts entry | closed |
| T-10-12-05 | Tampering | limiter/queue key collision | medium | mitigate | Explicit key namespace on limiter registration | closed |
| T-10-12-06 | Denial of Service | limiter client hanging on slow store | medium | mitigate | Short connect timeout + low retry ceiling, distinct from queue client | closed |
| T-10-12-SC | Tampering | package installs | high | accept | See AR-02 (already-installed deps) | closed |
| T-10-13-01 | Information Disclosure | secrets in log output | high | mitigate | Single rule table (`packages/redaction/src/rules.ts`) applied by both consumers; parity test | closed |
| T-10-13-02 | Information Disclosure | PII nested beyond field list | high | mitigate | Recursive scrubbing, no depth ceiling; depth-seven backstop probe | closed |
| T-10-13-03 | Information Disclosure | worker unredacted console output | high | mitigate | `scrubbed-console` wrapper on all worker console calls, grep-verified | closed |
| T-10-13-04 | Tampering | rule lists drifting | medium | mitigate | Rules in exactly one file; parity test fails on divergence | closed |
| T-10-13-05 | Information Disclosure | narrowing coverage while centralizing | medium | mitigate | Previous path list captured as literal in parity test | closed |
| T-10-13-06 | Denial of Service | recursion on cyclic/large object | medium | mitigate | Visited-object tracking; tested | closed |
| T-10-13-SC | Tampering | package installs | high | accept | See AR-02 (workspace-internal, zero runtime deps) | closed |
| T-10-14-01 | Information Disclosure | route module bypassing membership gate | high | mitigate | Per-module cross-tenant read denial asserted externally (`negative-cross-tenant.test.ts`) | closed |
| T-10-14-02 | Tampering | cross-tenant write behind a 404 | high | mitigate | Every denied write re-reads target row and asserts unchanged | closed |
| T-10-14-03 | Elevation of Privilege | hostile job payload naming another workspace | high | mitigate | Per-family negative cases assert both workspaces' state; contactId∈workspaceId verified before flow entry (fix ca2eba9) | closed |
| T-10-14-04 | Elevation of Privilege | scan role reaching ungranted table (runtime) | high | mitigate | Runtime rejection test from consumer side, complementing catalog assertions | closed |
| T-10-14-05 | Repudiation | new module/job family without negative case | high | mitigate | Suites derive expected set from real registration lists with commented exclusions | closed |
| T-10-14-06 | Tampering | vacuously passing suite | medium | mitigate | Real access attempts against seeded second-workspace data; positive controls | closed |
| T-10-14-SC | Tampering | package installs | high | accept | See AR-02 | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-01 | T-10-01-06 | Dev-role password reuse is local-dev only; production DSNs carry their own secrets — role separation, not password strength, is the control | plan 10-01 | 2026-08-09 |
| AR-02 | T-10-{01..14}-SC | No package-manager installs anywhere in the phase; RESEARCH.md § Package Legitimacy Audit records zero new external packages (redaction package is workspace-internal source) | plans 10-01..10-14 | 2026-08-09 |
| AR-03 | T-10-02-04 | `toFetchHeaders` is an unchanged mechanism already exercised by every route test; the plan only moved the call site | plan 10-02 | 2026-08-09 |
| AR-04 | T-10-03-02 | Unrestricted `contacts_scan`/`sends_scan` rows unavoidable for FK re-validation and send-id resolution; bounded by SELECT-only grants, two known readers, and 10-08's payload-free assertion (RESEARCH.md Assumption A3) | plan 10-03 | 2026-08-09 |
| AR-05 | T-10-04-04 | Sub-millisecond timing side channel between missing and forbidden is out of scope at ASVS L1; both paths execute the same query shape | plan 10-04 | 2026-08-09 |
| AR-06 | T-10-09-04 | Auth role needs full DML on the seven Better Auth tables for its adapter; it holds nothing on tenant tables | plan 10-09 | 2026-08-09 |
| AR-07 | T-10-09-05 | Table owner could re-grant revoked privileges; closing requires moving ownership, which breaks the migration path — documented in the ADR | plan 10-09 (checkpoint) | 2026-08-09 |
| AR-08 | T-10-11-05 | ±10-minute window is wide tolerance for provider-to-host skew; value is environment-overridable without a code deploy | plan 10-11 | 2026-08-09 |
| AR-09 | T-10-12-03 | Deliberate fail-open on limiter-store outage: availability preferred over throttling; condition is logged so it cannot go unnoticed | plan 10-12 | 2026-08-09 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-09 | 89 | 89 | 0 | /gsd-secure-phase L1 short-circuit (plan-time register; grep-level evidence + VERIFICATION.md passed + 2-pass code review with 6 fixes applied) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-09
