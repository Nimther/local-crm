---
phase: 05
slug: webhook-processing-delivery-tracking
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-07-09
---

# Phase 05 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| SendGrid → public webhook route | Untrusted HTTP; trust anchors are the unguessable pathToken (pre-verification tenant resolution) and the ECDSA signature (authenticity) | Signed event batches (recipient emails, delivery outcomes) |
| API route → BullMQ queue | Only signature-verified batches are enqueued | Verified event batches + workspaceId |
| Worker job → Postgres | workspaceId re-derived from job.data; RLS + withTenant enforce isolation | send_events, sends, campaigns, contacts, workspace_suppressions writes |
| API → SendGrid provisioning API | Tenant BYO key outbound calls; key redacted from all errors/logs | Decrypted tenant SendGrid API key (headers only) |
| Authenticated webhook-settings routes | Session + role gates; health member-read, reconnect Owner/Admin | Health status, curated warning copy |
| env/config → provisioning | PUBLIC_APP_URL (operator config) determines the callback URL sent to SendGrid | Webhook callback URL |
| committed docs → repo | Live-UAT runbook must never embed real tenant keys or tunnel secrets | Placeholder-only documentation |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-05-01 | Spoofing | POST /webhooks/sendgrid/:pathToken | high | mitigate | ECDSA verify via @sendgrid/eventwebhook against raw body; invalid/missing signature → 400, no enqueue (`signature-verify.ts`, `webhooks.routes.ts`; 5 passing signature tests) | closed |
| T-05-02 | Tampering | raw-body capture | high | mitigate | Scoped `addContentTypeParser(..., {parseAs:"buffer"})` inside route registration; verify before JSON.parse; parser never global | closed |
| T-05-03 | Information Disclosure | pathToken lookup / health route | medium | mitigate | `crypto.randomBytes(32)` pathToken; unknown token → uniform 404 before signature attempt; health route never returns pathToken/publicKey | closed |
| T-05-04 | Tampering / Repudiation | forged unsubscribe/spam poisoning suppression | high | mitigate | Upstream ECDSA gate + dedup RETURNING + is_test + workspace-scoped send resolution gate every suppression write; per-event single-row writes only | closed |
| T-05-06 | Elevation of Privilege | webhook-events worker DB writes | high | mitigate | `withTenant(workspaceId)` + `withTenantTransaction` on every write; ENABLE+FORCE RLS on send_events + workspace_webhook_endpoints | closed |
| T-05-07 | Tampering | test-send mislabeled as real | medium | mitigate | `test='true'` custom_arg emitted only for kind='test' (`send-mail.ts`); unit test asserts campaign sends never carry it | closed |
| T-05-08 | Repudiation | suppression logic drift across code paths | medium | mitigate | Single pure `resolveSuppression` decision table; all suppression decisions route through it, unit-tested per event/reason | closed |
| T-05-09 | Tampering | double-count / fact overwrite via replay | medium | mitigate | `ON CONFLICT (workspace_id, sg_event_id, occurred_at) DO NOTHING` dedup; first-write `WHERE col IS NULL` gates counters | closed |
| T-05-10 | Information Disclosure | tenant SendGrid key in provisioning errors | high | mitigate | `redactApiKey` on any thrown/logged error (`sendgrid-webhook-provision.ts:71`); typed graceful errors; regression-tested | closed |
| T-05-11 | Elevation of Privilege | Member triggering reconnect | medium | mitigate | `requirePermission("sendgridKey","update")` on reconnect/recheck; health read-only for members | closed |
| T-05-12 | Spoofing | duplicate/hijacked webhook via re-POST | medium | mitigate | Persist + reuse `sendgridWebhookId`; PATCH in place; never touches tenant's other webhooks | closed |
| T-05-13 | Elevation of Privilege | Member seeing/triggering Reconnect (UI) | low | mitigate | Reconnect rendered only for canManage; server independently enforces requirePermission (client gating cosmetic) | closed |
| T-05-14 | Information Disclosure | health card leaking pathToken/key | low | mitigate | Health API returns only connected/provisionStatus/lastEventAt | closed |
| T-05-G1-01 | Tampering | `extractEventRow` occurred_at fallback | high | mitigate | Events without a finite, in-range Unix-seconds timestamp are skipped (never wall-clock substitution), so dedup key is deterministic on redelivery; regression Test A | closed |
| T-05-G1-02 | Denial of Service | out-of-range timestamp crashing batch | high | mitigate | Bounds check (`Math.abs(ts*1000) <= 8.64e15`) before Date construction; malformed event skipped, batch survives; regression Test B | closed |
| T-05-G2-01 | Spoofing / Tampering | `createWebhook` reuse-by-name cross-workspace takeover | high | mitigate | Workspace-scoped `webhookFriendlyName(workspaceId)` — each workspace matches/creates/patches only its own webhook; sibling-adoption regression test | closed |
| T-05-G2-02 | Information Disclosure / Tampering | reused webhook keeping stale pathToken URL | high | mitigate | Reused webhook's `url` PATCHed to the caller's callbackUrl before returning; repoint regression test | closed |
| T-05-08-01 | Information Disclosure | logNonOkProvisionResponse | high | mitigate | `redactSecret(text, apiKey)` before `console.warn`; Authorization header never logged; test asserts logged output excludes the key | closed |
| T-05-08-02 | Information Disclosure | provision_error column | medium | mitigate | Persists ONLY the typed `ProvisionEventWebhookError` enum value, never raw SendGrid response bodies | closed |
| T-05-09-01 | Information Disclosure | webhook-health/reconnect responses + UI copy | high | mitigate | API returns only curated Russian copy via `webhookWarningFor` enum mapping; raw SendGrid bodies and keys never returned; pathToken/publicKey omitted | closed |
| T-05-09-02 | Elevation of Privilege | POST webhook-reconnect / recheck | high | mitigate | `requirePermission("sendgridKey","update")` retained server-side; frontend gate cosmetic | closed |
| T-05-09-03 | Spoofing | connect-time scope detection | medium | mitigate | `webhookScopePresent` derived only from authenticated /v3/scopes for the tenant's own key; missing scope degrades to warning, provisioning short-circuits | closed |
| T-05-10-01 | Information Disclosure | docs/webhook-live-uat.md | medium | mitigate | Placeholders only; explicit instruction never to commit a real key; grep confirms zero real-looking keys in file | closed |
| T-05-11-01 | Information Disclosure | patchWebhook 404 logging on fallback path | medium | mitigate | 404 body logged only through existing `logNonOkProvisionResponse` redaction path; guarded by existing redaction test | closed |
| T-05-12-01 | Information Disclosure | insecure_url warning copy | medium | mitigate | Fixed curated string, no interpolation of URL/key/SendGrid body; `webhookWarningFor` maps a typed enum | closed |
| T-05-12-02 | Denial of Service | provisionEventWebhook outbound call on http URL | low | mitigate | Pre-flight https guard short-circuits before any fetch (`insecure_url`) | closed |
| T-05-12-03 | Tampering | production boot with non-https PUBLIC_APP_URL | medium | mitigate | `env.ts` superRefine hard-fails production boot on non-https PUBLIC_APP_URL; dev/test allow http for tunnels | closed |
| T-05-G5-01 | Spoofing | `extractEventRow` top-level send_id read | medium | mitigate | Upstream raw-body ECDSA check authenticates payload origin before worker; unauthenticated attackers cannot inject markers | closed |
| T-05-G5-02 | Tampering / cross-tenant integrity | batch send-resolution SELECT | high | mitigate | Resolution SELECT is `WHERE workspace_id = <job workspace> AND id = ANY(...)`; non-resolving ids nulled (D-15) — foreign send_id can never attribute cross-tenant | closed |
| T-05-G5-03 | Information Disclosure (metrics integrity) | campaign counters / sends fact columns | high | mitigate | 05-13 fix restores accurate attribution; attribution test + real-shape fixtures prevent false-zero regression; live-confirmed in round-6 UAT | closed |
| T-05-SC | Tampering | npm install @sendgrid/eventwebhook | high | accept | Package Legitimacy Audit verdict OK (first-party SendGrid publisher, no postinstall) | closed |
| T-05-08-03 | Information Disclosure | findWebhookEndpointByToken (public receiver) | low | accept | Pre-tenant-context lookup returns only workspaceId + publicKey; never the provision_error column | closed |
| T-05-10-02 | Spoofing / Tampering | public tunnel exposing receiver during UAT | low | accept | Receiver verifies every event's ECDSA signature against raw body before parsing; exposure inherent to live webhook testing, accepted for the UAT window | closed |
| T-05-11-02 | Spoofing / Tampering | createWebhook reuse-by-name via fallback | low | accept | Reuse matches only the workspace-scoped friendly name (T-05-G2-01 fix); tenant's own key against tenant's own account — inside trust boundary | closed |
| T-05-11-03 | Denial of Service | extra SendGrid calls on repeated 404 | low | accept | Bounded, user-triggered, permission-gated; no re-entrant loop; SendGrid rate limits bound abuse | closed |
| T-05-09-04 | Information Disclosure | webhook-notice.ts fallback copy | low | accept | Fixed generic Russian string; never interpolates server errors beyond curated provisionError | closed |
| T-05-G1-SC / T-05-G2-SC / T-05-08-SC / T-05-09-SC / T-05-10-SC / T-05-11-SC / T-05-12-SC / T-05-G5-SC | Tampering | package installs (gap-closure rounds) | low | accept | No new package installs in any gap-closure round — no new supply-chain surface | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-05-01 | T-05-SC | @sendgrid/eventwebhook is a first-party SendGrid package, no postinstall scripts; Package Legitimacy Audit verdict OK at plan time | plan-time register (05-01) | 2026-07-09 |
| AR-05-02 | T-05-08-03 | Pre-tenant-context token lookup exposes only workspaceId + publicKey by design; the provision_error column is unreachable from the public receiver path | plan-time register (05-08) | 2026-07-09 |
| AR-05-03 | T-05-10-02 | Internet exposure of the receiver via tunnel is inherent to live webhook UAT; ECDSA verification remains the enforcement point | plan-time register (05-10) | 2026-07-09 |
| AR-05-04 | T-05-11-02, T-05-11-03 | Fallback list+create+PATCH sequence runs the tenant's own key against the tenant's own account, permission-gated and bounded | plan-time register (05-11) | 2026-07-09 |
| AR-05-05 | T-05-09-04 | Client fallback copy is a fixed generic string with no error interpolation | plan-time register (05-09) | 2026-07-09 |
| AR-05-06 | *-SC entries | No package installs in gap-closure rounds 1–5 — no new supply-chain surface | plan-time registers | 2026-07-09 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-09 | 37 | 37 | 0 | gsd-secure-phase (L1 short-circuit: plan-time register, all mitigations grep-verified + cross-checked against 05-VERIFICATION.md direct code reads and 05-REVIEW.md) |

**Non-blocking observations carried from 05-REVIEW.md (Warning severity, not register threats):** WR-01 (cross-tenant raw-payload storage in `send_events` when one BYO SendGrid key backs multiple workspaces — flattened `workspace_id` not checked by the worker; workspace-scoped resolution prevents cross-attribution but raw payloads persist in sibling rows), WR-02 (upsertWebhookEndpoint SELECT-then-branch race, no `UNIQUE(workspace_id)`), WR-03 (no webhook timestamp freshness check — replayed signed requests can refresh delivery-health), WR-07 (worker UPDATEs rely on RLS alone contra defense-in-depth convention). None falsify a register mitigation; WR-01 is recommended as a dedicated follow-up (drop events whose flattened `workspace_id` mismatches the receiving endpoint's workspace).

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-09
