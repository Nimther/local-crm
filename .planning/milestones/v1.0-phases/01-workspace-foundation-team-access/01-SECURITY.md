---
phase: 1
slug: workspace-foundation-team-access
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-07-03
---

# Phase 1 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Browser → Fastify API | Untrusted registration/login/workspace/invite/key input (Zod-validated); session cookie | Credentials, invite tokens, plaintext tenant SendGrid key (once, over TLS) |
| Fastify API → Postgres | Tenant scoping; RLS is the last line of defense against a missed WHERE | Tenant-scoped rows incl. encrypted SendGrid keys |
| API → KMS | DEK generation/unwrap; KEK never reaches the DB tier | DEK material |
| API → Platform SendGrid | System email dispatch (verify/reset/invite) with the platform key only | Platform key, recipient emails |
| API → Tenant SendGrid | Live validation of the tenant BYO key | Decrypted tenant key (per-request) |
| Tenant user input → platform-sent email | Attacker-controllable orgName flows into HTML sent from the platform sender identity | orgName (HTML-escaped) |
| Invite link → API | Untrusted invitation token at accept time | Invite token |
| Local dev config → git history | Real secrets in `.env` must never reach committed files | Secrets |
| Build → npm registry | Third-party package code enters at install | Dependencies |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-01-01 | Info Disclosure / Tampering | tenant-context.ts + RLS on workspace_sendgrid_keys | high | mitigate | SET LOCAL via set_config(...,true) per transaction + AsyncLocalStorage + RLS policy; proven by rls-pooling-chaos.test.ts (UAT 12) | closed |
| T-01-02 | Info Disclosure | Tenant-scoped tables without RLS policy | high | mitigate | RLS enabled in 0001_rls_policies.sql; app role has no BYPASSRLS; migrations applied (UAT 13) | closed |
| T-01-03 | Spoofing | better-auth session cookie | medium | mitigate | HttpOnly + Secure + SameSite cookie; @fastify/rate-limit on sign-up/sign-in (grep: server.ts, auth/plugin.ts) | closed |
| T-01-04 | Elevation of Privilege | role-guard / access-control | medium | mitigate | Server-side createAccessControl; role matrix enforced server-side (UAT 25) | closed |
| T-01-SC | Tampering | npm installs (supply chain) | high | mitigate | RESEARCH.md Package Legitimacy Audit: 0 [SLOP], all [SUS] resolved to Approved; Pino redaction (logger.ts) | closed |
| T-01-05 | Spoofing | Session storage in browser | medium | mitigate | Session only in HttpOnly cookie; zero localStorage usage (grep-verified, 0 hits) | closed |
| T-01-06 (01-02) | Tampering | CSRF on cookie-based auth mutations | medium | mitigate | trustedOrigins: [env.WEB_URL] (auth.ts:17) + SameSite cookie; same-origin /api | closed |
| T-01-07 (01-02) | Info Disclosure | Auth error messages | low | accept | Generic login error copy avoids enumeration; accepted at L1 (see Accepted Risks AR-01) | closed |
| T-01-08 (01-02) | Elevation of Privilege | Client-side role gating | low | mitigate | Server role-guard is the enforcement layer; UI hiding convenience only (UAT 8, 25) | closed |
| T-01-09 (01-03) | Info Disclosure | platform-mail vs tenant key confusion | high | mitigate | Structurally separate platform-mail module; no import of tenant KMS module (UAT 19) | closed |
| T-01-10 (01-03) | Spoofing | Reset / verification tokens | medium | mitigate | Crypto-random single-use tokens with expiry; rate-limited reset-request (UAT 20) | closed |
| T-01-11 (01-03) | Info Disclosure | Reset-request account enumeration | low | accept | Generic success response; accepted at L1 (see Accepted Risks AR-02) | closed |
| T-01-12 (01-03) | Elevation of Privilege | Change-password without current password | medium | mitigate | better-auth changePassword requires current password; session rotation (UAT 6) | closed |
| T-01-13 | Spoofing | Invite token brute force / enumeration | high | mitigate | Crypto-random invitation tokens; rate-limit on accept (invites.ts); 7-day expiry (UAT 24) | closed |
| T-01-14 | Elevation of Privilege | Member/Admin exceeding role scope | high | mitigate | Server-side requirePermission on every mutation; owner-only checks (UAT 25) | closed |
| T-01-15 | Tampering | Accept invite binds wrong workspace/role | medium | mitigate | Workspace + role come from server-stored invite, not client input (UAT 23) | closed |
| T-01-16 | Tampering | Accidental / unauthorized workspace deletion | medium | mitigate | Owner-only; server re-validates typed name; soft delete (UAT 26) | closed |
| T-01-17 | Info Disclosure | Tenant SendGrid key at rest / in logs | high | mitigate | KMS envelope encryption (per-tenant DEK, KEK outside DB); Pino redaction; DEK zeroed (UAT 27, 30) | closed |
| T-01-18 | Elevation of Privilege | Member connecting/changing the key | high | mitigate | requirePermission('sendgridKey','update') server-side (UAT 29) | closed |
| T-01-19 | Elevation of Privilege | Unverified email connecting the key | medium | mitigate | requireVerifiedEmail preHandler on connect route (sendgrid-key.ts:73; UAT 29) | closed |
| T-01-20 | Tampering | KMS local provider reused in production | high | mitigate | local-provider.ts refuses boot under NODE_ENV=production (local-provider.ts:16; UAT 30) | closed |
| T-01-21 | Info Disclosure | Tenant vs platform key confusion | medium | mitigate | sendgrid-client.ts structurally separate from platform-mail; no shared import (UAT 19) | closed |
| T-01-06 (01-06) | Info Disclosure | GET sendgrid-key unauthenticated/non-member | critical | mitigate | Membership check → uniform 404 (CR-01 fix; UAT 31) | closed |
| T-01-07 (01-06) | Info Disclosure | GET sendgrid-key as workspace-enumeration oracle | high | mitigate | Identical 404 body for nonexistent workspace and non-member (UAT 31) | closed |
| T-01-08 (01-06) | Tampering / Spoofing | Invite email HTML body (orgName injection) | high | mitigate | escapeHtml() on orgName (invite.ts:13; CR-02 fix; UAT 33) | closed |
| T-01-09 (01-06) | Info Disclosure / EoP | GET /invites leaking accept tokens to Members | high | mitigate | requirePermission("invitation","create") preHandler → Member 403 (WR-02 fix; UAT 32) | closed |
| T-01-10 (01-06) | Denial of Service | Production pg Pool idle-connection error | high | mitigate | pool.on("error") listener logs instead of crashing (db.ts:19; CR-03 fix; UAT 34) | closed |
| T-01-11 (01-06) | Info Disclosure | Membership-check error mapping (fix-introduced) | medium | mitigate | try/catch maps better-auth APIError to uniform 404, never a leaking 500 (UAT 31) | closed |
| T-01-07-01 | Info Disclosure | .env.example / git | high | mitigate | .env gitignored (verified via git check-ignore); committed .env.example carries placeholders only | closed |
| T-01-07-02 | Tampering | KMS_LOCAL_KEK entropy | medium | mitigate | KEK generated with openssl rand -base64 32; local-provider.ts rejects non-32-byte values | closed |
| T-01-07-03 | Info Disclosure | env.ts boot error / check-env.mjs output | low | mitigate | Both surfaces emit variable NAMES + rule messages only, never process.env values | closed |
| T-01-07-SC | Tampering | Package installs (01-07) | low | accept | No install tasks in plan 01-07 (Node built-ins only); supply-chain gate N/A (see Accepted Risks AR-03) | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

Note: plan 01-06 reused threat IDs T-01-06…T-01-11 already assigned in plans 01-02/01-03; entries above are disambiguated with the plan number in parentheses.

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-01 | T-01-07 (01-02) | Generic «Неверный email или пароль» copy prevents account enumeration on login; residual timing/UX enumeration vectors acceptable at ASVS L1 for a dashboard SPA | Plan 01-02 threat model (plan-time disposition) | 2026-07-03 |
| AR-02 | T-01-11 (01-03) | Reset-request returns generic success regardless of account existence; residual enumeration risk acceptable at ASVS L1 | Plan 01-03 threat model (plan-time disposition) | 2026-07-03 |
| AR-03 | T-01-07-SC | Plan 01-07 introduced no new package installs (Node built-ins only); supply-chain gate not applicable | Plan 01-07 threat model (plan-time disposition) | 2026-07-03 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-03 | 31 | 31 | 0 | /gsd-secure-phase (L1 short-circuit: plan-time register, grep + automated-test evidence) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-03
