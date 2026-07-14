---
phase: 04
slug: broadcast-campaigns-send-pipeline
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-07-08
---

# Phase 04 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

All 19 plans in this phase carried plan-time `<threat_model>` blocks (register_authored_at_plan_time: true). Classification ran at ASVS L1 (grep-depth) with block_on: high. Every mitigate-disposition threat has its control verified present in the implementation; every accept-disposition threat is documented below. Evidence draws on direct code checks plus the 66 automated coverage entries in 04-UAT.md (all passing) and the 74/74 UAT completed 2026-07-07.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| worker/API → Postgres | Every tenant-scoped query; RLS is the enforcement, not app-level WHERE alone | All tenant data |
| public internet → GET/POST /unsubscribe/:token | Unauthenticated, token-verified surface reachable by mail clients and crawlers; attacker controls the :token path segment | Signed unsubscribe tokens, subscription status |
| worker → SendGrid API | Tenant's decrypted BYO key + recipient PII crosses to a third party | SendGrid API key, contact PII |
| Redis job payload → worker | Job data re-parsed and re-scoped; workspaceId re-derived, never ambient | Job payloads (ids only, never plaintext keys) |
| broadcast lane vs triggered lane | Two queues isolated so one cannot starve the other | Send jobs |
| client → campaign routes | Untrusted campaign input + role-gated launch actions | Campaign config, launch mutations |
| process env → send pipeline | UNSUBSCRIBE_TOKEN_SECRET authenticates every one-click unsubscribe token | HMAC secret |
| package → process.env (@mega-crm/kms) | KMS config read from ambient environment of api or worker | KEK/DEK key material (transient, memory only) |
| worker → signed token → API route | Worker signs contactId; API route trusts it (HMAC-bound) into a uuid-typed UPDATE | Token payload |
| dev bootstrap → dev database | predev migrate applies schema to DATABASE_URL target | Schema migrations |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-04-01-01 | Information Disclosure | campaigns/campaign_recipients/sends/workspace_send_settings tables | high | mitigate | ENABLE + FORCE RLS + workspace_isolation policy in migrations 0013–0016; pinned by UAT #17 | closed |
| T-04-01-02 | Tampering | sends idempotency | high | mitigate | UNIQUE(workspace_id, campaign_id, contact_id) in 0015_sends.sql:13; UAT #15 | closed |
| T-04-01-03 | Tampering | campaign→segment reference | medium | mitigate | segment_id FK ON DELETE RESTRICT; UAT #14, #43 (409 on delete) | closed |
| T-04-01-04 | Denial of Service | frequency-cap lookup at volume | medium | mitigate | idx_sends_workspace_contact_sent_at index-backed; UAT #16 | closed |
| T-04-02-01 | Information Disclosure | decrypted DEK / plaintext key | high | mitigate | plaintextDek.fill(0) in finally (packages/kms/src/client.ts:61,78); no plaintext logging | closed |
| T-04-02-02 | Elevation of Privilege | KMS_PROVIDER=local in production | high | mitigate | NODE_ENV=production refusal-to-boot guard retained after package move; env.ts superRefine | closed |
| T-04-02-03 | Tampering | two-key confusion (tenant vs platform key) | medium | mitigate | sendgrid-client takes key as argument; no @sendgrid/mail singleton import; UAT #20, #35 | closed |
| T-04-02-SC | Tampering | npm workspace resolution of moved @aws-sdk/client-kms | low | accept | Existing approved dependency relocated, no new install | closed |
| T-04-03-01 | Tampering / EoP | unsubscribe token forgery | high | mitigate | HMAC-SHA256 over sendId+contactId+workspaceId+exp, timingSafeEqual (unsubscribe-token.ts:71); UAT #21 | closed |
| T-04-03-02 | Information Disclosure | unsubscribe enumeration oracle | high | mitigate | Byte-identical responses for forged/expired/unknown tokens; UAT #28, #74 | closed |
| T-04-03-03 | Tampering | GET prefetch silently unsubscribing | medium | mitigate | GET never mutates; only POST flips status (RFC 8058); UAT #27 | closed |
| T-04-03-04 | Information Disclosure | SendGrid key in mail-send error logs | high | mitigate | redactApiKey strips key from message+stack (send-mail.ts:77–83) | closed |
| T-04-03-05 | Denial of Service | frequency-cap count query per send | medium | mitigate | Index-backed rolling-window count; UAT #23 | closed |
| T-04-04-01 | Spoofing / ID | tenant key used for wrong tenant | high | mitigate | Raw-fetch per-call dispatch; workspaceId re-derived from job.data via withTenant; UAT #35 | closed |
| T-04-04-02 | Tampering | duplicate sends on retry | high | mitigate | dispatchSendGate + UNIQUE constraint; deterministic jobId defense-in-depth; UAT #24, #30 | closed |
| T-04-04-03 | Denial of Service | broadcast starves triggered | high | mitigate | Two separate queues + independent workers (apps/worker/src/server.ts); UAT #35 | closed |
| T-04-04-04 | Information Disclosure | decrypted key in dispatch error logs | high | mitigate | Authorization redacted on any thrown/logged fetch error (delivery-core) | closed |
| T-04-04-05 | Tampering | supply-chain: rate-limiter-flexible install | high | mitigate | Human-verify checkpoint at install time, version pinned 11.2.0 | closed |
| T-04-05-01 | Elevation of Privilege | Member launching/scheduling | high | mitigate | requirePermission("campaign","launch") on launch/schedule/cancel/duplicate + settings PUT; UAT #42, human test 10 | closed |
| T-04-05-02 | Tampering | draft sent by accident / scheduled edit mid-flight | high | mitigate | SELECT FOR UPDATE state machine rejects illegal transitions; UAT #36–#40, human test 9 | closed |
| T-04-05-03 | Information Disclosure | cross-tenant campaign access via :slug | high | mitigate | resolveWorkspaceMember uniform-404 + withTenant RLS on every query | closed |
| T-04-05-04 | Information Disclosure | SendGrid key via templates/senders route | high | mitigate | Key decrypted server-side only; only template ids/sender emails reach browser | closed |
| T-04-05-05 | Denial of Service | pathological segment breakdown recompute | medium | mitigate | isQueryCanceledError 57014→4xx statement-timeout guard on audience-breakdown count | closed |
| T-04-06-01 | Information Disclosure | cross-tenant leak in scheduler scan | high | mitigate | Admin-side metadata scan re-enters withTenant per campaign; worker re-derives workspaceId from job.data | closed |
| T-04-06-02 | Denial of Service | unbounded snapshot at 1M contacts | high | mitigate | Batched keyset INSERT...SELECT, 60s statement_timeout, per-batch commit + resume cursor; UAT #45 | closed |
| T-04-06-03 | Tampering | redelivered kickoff double-enqueue | high | mitigate | Deterministic jobId + ON CONFLICT DO NOTHING + fan_out_complete flag; UAT #46 | closed |
| T-04-06-04 | Tampering | membership drift preview vs audience | medium | mitigate | Snapshot reuses compileSegmentDefinition (same engine); UAT #45 | closed |
| T-04-07-01 | Elevation of Privilege | Member seeing enabled launch controls | medium | mitigate | Controls disabled + Owner/Admin tooltip for Members; human test 10 | closed |
| T-04-07-02 | Tampering (XSS) | campaign/segment name in list | low | mitigate | React text-node escaping; no dangerouslySetInnerHTML | closed |
| T-04-07-03 | Information Disclosure | template/sender data to client | low | accept | Only non-secret template ids/names and verified sender emails reach the client | closed |
| T-04-08-01 | Elevation of Privilege | Member triggering launch via UI | high | mitigate | Client gate is defense-in-depth; server requirePermission is authoritative | closed |
| T-04-08-02 | Tampering | malformed test-send JSON | low | mitigate | JSON parse + testSendCampaignSchema validation client- and server-side | closed |
| T-04-08-03 | Tampering | wrong scheduled instant (timezone) | medium | mitigate | datetime-local → UTC ISO with resolved IANA zone shown (D-06); human test 8 | closed |
| T-04-08-04 | Tampering (XSS) | names in dialogs + breakdown | low | mitigate | React text-node escaping | closed |
| T-04-09-01 | Spoofing | resolveCampaignFromEmail | medium | mitigate | Only SendGrid /v3/verified_senders-listed ids accepted; unmatched fails closed 422; UAT #47–#49 | closed |
| T-04-09-02 | Information Disclosure | sender-resolver key handling | high | mitigate | Decrypted key used only for verified_senders fetch, never logged | closed |
| T-04-09-03 | Tampering | from_email persistence | low | mitigate | Workspace-scoped UPDATE inside withTenantTransaction/RLS | closed |
| T-04-09-SC | Tampering | dependencies | low | accept | No new installs; reuses @mega-crm/kms + sendgrid-client | closed |
| T-04-10-01 | Tampering | recordExcluded ON CONFLICT demotion | high | mitigate | Status-guarded ON CONFLICT; UAT #50–#52 | closed |
| T-04-10-02 | Repudiation | frequency-cap accounting | medium | mitigate | 'sent' rows preserved so rolling-window count stays accurate | closed |
| T-04-10-SC | Tampering | dependencies | low | accept | SQL-only change, no installs | closed |
| T-04-11-01 | Tampering (XSS) | GET renderConfirmPage token interpolation | high | mitigate | base64url format guard + attribute escaping + CSP default-src 'none'; UAT #53 | closed |
| T-04-11-02 | Elevation of Privilege | missing security headers | high | mitigate | @fastify/helmet with script-blocking CSP (apps/api/src/server.ts:59); UAT #54 | closed |
| T-04-11-03 | Spoofing | POST unsubscribe mutation | low | accept | Existing HMAC + expiry verification unchanged | closed |
| T-04-11-SC | Tampering | dependencies | low | accept | @fastify/helmet already present | closed |
| T-04-12-01 | Tampering | duplicate-send window (CR-04) | high | mitigate | 'dispatching' claim committed pre-SendGrid-call; redelivery records 'failed' not re-call; UAT #56 | closed |
| T-04-12-02 | Repudiation | 4xx recorded as sent (CR-03) | high | mitigate | status>=400 (non-429) → 'failed'; UAT #57 | closed |
| T-04-12-03 | Denial of Service | stranded 'dispatching' claim | medium | mitigate | releaseDispatchClaim on 429/5xx and limiter denial; UAT #58 | closed |
| T-04-12-SC | Tampering | dependencies | low | accept | Logic-only refactor, no installs | closed |
| T-04-13-01 | Denial of Service | cancel not honored (CR-06) | high | mitigate | Claim gate skips non-'sending' campaigns; kickoff re-reads status per page; UAT #61, #63 | closed |
| T-04-13-02 | Tampering | counter increment race | medium | mitigate | Atomic increment WHERE status='sending'; completion guarded; UAT #59, #62 | closed |
| T-04-13-03 | Repudiation | stuck 'sending' campaign (CR-05) | high | mitigate | tryCompleteCampaign after each terminal send AND fan-out completion; UAT #59, #60 | closed |
| T-04-13-SC | Tampering | dependencies | low | accept | Logic-only additions, no installs | closed |
| T-04-14-01 | Denial of Service | urlencoded parser on public POST | medium | mitigate | bodyLimit: 1024; body parsed as buffer and discarded | closed |
| T-04-14-02 | Tampering | content-type parser encapsulation scope | high | mitigate | Parser registered inside registerUnsubscribeRoutes only, media-type-specific; 415 scope-guard pinned by UAT #66 | closed |
| T-04-14-03 | Spoofing | forged/empty one-click POST body | low | accept | Body discarded; authorization is the HMAC token in the URL path | closed |
| T-04-14-SC | Tampering | installs | low | accept | Built-in Fastify API, no installs | closed |
| T-04-15-01 | Denial of Service | pageSize bound raise 100→200 | low | accept | Bound stays finite (201 rejected, pinned by UAT #67); low-cardinality tables, index-backed, RLS-scoped | closed |
| T-04-15-02 | Tampering | shared pagination constant drift | low | mitigate | One exported constant; pagination.test.ts pins client value against both schemas; UAT #67 | closed |
| T-04-16-01 | Spoofing | UNSUBSCRIBE_TOKEN_SECRET weakness | high | mitigate | Fail-fast ≥32-char boot validation in api env.ts + worker server.ts; UAT #68 | closed |
| T-04-16-02 | Denial of Service | worker send jobs on missing secret | high | mitigate | Worker dies at boot with named error instead of per-job retry burn; UAT #68, live-verified in re-test | closed |
| T-04-16-03 | Tampering | predev migrate against wrong DATABASE_URL | low | accept | Loads same root .env; fails closed if DATABASE_URL unset; dev-only path | closed |
| T-04-17-01 | Repudiation | test-send 4xx handling | medium | mitigate | Non-retryable 4xx returns 'failed'; regression test; UAT #70 | closed |
| T-04-17-02 | Information Disclosure | test-send sample copy | low | accept | Sample JSON exposes a segment contact's merge data by design (D-18/D-19); copy only labels it | closed |
| T-04-18-01 | Repudiation | mount-time-only D-03 warning | medium | mitigate | Save-time refetch + explicit confirm gate; UAT #71, human test 12 | closed |
| T-04-18-02 | Information Disclosure | swallowed lookup error | low | mitigate | Failed lookup surfaces a muted note instead of silent no-warning | closed |
| T-04-19-01 | Denial of Service | non-UUID contactId → 22P02 500 on public endpoint | high | mitigate | Worker signs randomUUID() (root cause) + isUuid() gate on UPDATE (unsubscribe.routes.ts:176); UAT #73, #74 | closed |
| T-04-19-02 | Information Disclosure | response uniformity break (enumeration oracle) | medium | mitigate | UUID guard falls through to identical response block; byte-identical assertion pinned; UAT #74 | closed |
| T-04-19-03 | Spoofing | token forgery | low | accept | Existing timing-safe HMAC compare unchanged | closed |
| T-04-19-SC | Tampering | installs | low | accept | No package installs in this gap plan | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-04-01 | T-04-02-SC | @aws-sdk/client-kms is an existing approved in-production dependency merely relocated to a shared package | plan 04-02 (plan-time disposition) | 2026-07-08 |
| AR-04-02 | T-04-07-03 | Only non-secret, tenant-owned template ids/names and verified sender emails reach the client; the key never leaves the API | plan 04-07 (plan-time disposition) | 2026-07-08 |
| AR-04-03 | T-04-11-03 | Existing HMAC signature + expiry verification already binds the unsubscribe mutation; unchanged by 04-11 | plan 04-11 (plan-time disposition) | 2026-07-08 |
| AR-04-04 | T-04-14-03 | One-click POST body is deliberately discarded; authorization is solely the HMAC-signed URL token, so a forged/empty body is a no-op | plan 04-14 (plan-time disposition) | 2026-07-08 |
| AR-04-05 | T-04-15-01 | pageSize ceiling raise 100→200 keeps a finite, regression-tested bound on low-cardinality, index-backed, RLS-scoped tables | plan 04-15 (plan-time disposition) | 2026-07-08 |
| AR-04-06 | T-04-16-03 | Dev-only migrate script loads the same root .env as the dev stack and fails closed without DATABASE_URL; applies only committed migrations | plan 04-16 (plan-time disposition) | 2026-07-08 |
| AR-04-07 | T-04-17-02 | Test-send sample JSON exposing a real segment contact's merge data is designed behavior (D-18/D-19); the change only labels it | plan 04-17 (plan-time disposition) | 2026-07-08 |
| AR-04-08 | T-04-19-03 | Timing-safe HMAC token verification pre-dates this plan and is unchanged; forged tokens degrade to the uniform response | plan 04-19 (plan-time disposition) | 2026-07-08 |
| AR-04-09 | T-04-09-SC, T-04-10-SC, T-04-11-SC, T-04-12-SC, T-04-13-SC, T-04-14-SC, T-04-19-SC | No-new-install supply-chain dispositions: each plan is logic-only or reuses in-tree/already-installed dependencies | plans 04-09…04-19 (plan-time dispositions) | 2026-07-08 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-08 | 70 | 70 | 0 | gsd-secure-phase (L1 short-circuit: plan-time register, all mitigations grep-verified + pinned by passing automated coverage in 04-UAT.md) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-08
