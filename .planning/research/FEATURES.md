# Feature Research

**Domain:** B2C email marketing automation platform (Klaviyo-model) — v1.2 "Data Lifecycle & Delivery Trust" milestone
**Researched:** 2026-08-20
**Confidence:** MEDIUM (web search only, no first-party API/docs access to Klaviyo/Mailchimp/Braze internals; codebase cross-checked for dependency grounding — see Sources)

## Scope Note

Unlike a greenfield-product feature landscape, this milestone adds five narrowly-scoped capabilities to an already-shipped platform (v1.0 + v1.1, 95/95 requirements validated). None of the five are user-facing differentiators — they are **trust/compliance/engineering-hygiene table stakes** that a production email-marketing SaaS is expected to have before it can be trusted with real customer PII and sending reputation. This document evaluates each of the five against how comparable ESPs (Klaviyo, Mailchimp, Braze) and general SaaS/security practice handle the same problem, and flags complexity + dependencies on subsystems already built in v1.0/v1.1.

## Feature Landscape

### Table Stakes (Users/Auditors Expect These)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Campaign send uses the confirmed-saved template, never a stale in-flight selection | Baseline reliability expectation for *any* send platform — "what I configured is what goes out" is more fundamental than any compliance feature; a bug here (stale template after dropdown change) is a trust-destroying incident, not a missing nice-to-have | LOW–MEDIUM | Classic UI/state bug pattern (form state not re-synced to the persisted/confirmed value before an async action reads it). Fix belongs at the boundary where launch/schedule/test-send reads `templateId` — read from the last-saved server record, not from unsaved local form state. No ecosystem research needed beyond "read from source of truth, not from stale client state"; this is an internal-correctness fix, not a competitive feature. |
| Per-contact data export on request (DSAR/GDPR Art. 15 & 20) | Every major ESP operating in the EU (Klaviyo, Mailchimp, Braze) exposes *some* mechanism to pull one data subject's personal data — it is a baseline legal requirement (GDPR right of access + data portability), not a differentiator. Mailchimp formalizes this with a dedicated DSAR intake page; Klaviyo and Braze expose profile-level export via UI/API. | MEDIUM | Klaviyo's actual mechanism is a *workaround*, not a dedicated single-contact button: build a segment-of-one, export that segment to CSV. Mailchimp: per-contact "Export a Contact" CSV. Braze: whole-profile export via REST API/SDK, but explicitly **cannot** selectively export/delete individual behavioral events — only whole-profile. A first-class one-click "Export this contact's data" button on the contact card (as scoped for v1.2) is *more polished self-service UX* than what Klaviyo ships natively — see Differentiators. |
| Physical purge of a closed tenant's PII + secrets after a retention window | GDPR obligations do not end when a subscription/account is closed — "soft delete forever" is not a compliant end state; every serious SaaS/GDPR guide converges on a two-phase soft-delete → grace-period → hard-delete/anonymize lifecycle. Auditors and DPAs expect a documented, enforced retention default, not an indefinite "we'll get to it." | HIGH | Standard pattern: soft-delete flag + `deletion_scheduled_for` (commonly 30–90 days), then a scheduled job hard-deletes/anonymizes past that date. This project already has `organization.deletedAt` as a project-added soft-delete column (`packages/db/src/schema/auth.ts`) — the *soft*-delete half of the lifecycle likely already exists; v1.2 adds the *hard*-delete/purge half. Highest complexity of the five: must be idempotent, resumable, safe for sibling tenants (i.e., not accidentally touch shared/global tables), and must delete tenant secrets (SendGrid API key DEK) via the existing KMS envelope pattern, not just DB rows. |
| Graceful rotation of the unsubscribe-link signing secret | Security/compliance hygiene baseline: a secret that can never be rotated is a standing risk (compromise = permanent exposure, no recovery path) — every credential/signing-key rotation guide treats "can rotate without breaking existing users" as the non-negotiable bar, especially for something GDPR/CAN-SPAM requires to keep working (functioning unsubscribe links). | MEDIUM–HIGH | **Codebase-grounded finding, not assumption:** `packages/delivery-core/src/unsubscribe-token.ts` currently uses a single `UNSUBSCRIBE_TOKEN_SECRET`, HMAC-SHA256, no key ID, and `UNSUBSCRIBE_TOKEN_TTL_SECONDS = 5 years` (`apps/worker/src/queues/send-dispatch.ts`, `flow-send.ts`). This is materially different from typical JWT/webhook rotation guides, which assume overlap windows of hours-to-days — a 5-year token lifetime means "previous secrets" must remain valid for verification for up to 5 years after the last email carrying them was sent, not a short transition window. Standard `kid`-style pattern (embed a short key identifier alongside the signature so the verifier picks the right secret) applies directly and avoids O(n) try-every-secret verification. |
| CI blocks new untriaged HIGH/CRITICAL dependency advisories | Standard engineering hygiene for any production SaaS handling PII and payment-adjacent BYO API keys; "we'll notice eventually" is not an acceptable posture once in production. Every dependency-hygiene guide converges on: gate on severity threshold, allow a documented time-boxed exception, don't let noise force a fully-red pipeline. | LOW–MEDIUM | Policy-as-code pattern: committed allowlist/suppression file with owner + expiry + justification per accepted finding (tools like `audit-ci` implement this natively with module/advisory/path-scoped allowlist records); CI gate reads the allowlist and fails on any advisory ≥ threshold not present in it. This project already has a mature CI quality-gate pattern from Phase 8 (branch protection, admin-enforced red-PR blocking) — the dependency gate slots into that same pipeline rather than requiring new CI infrastructure. |

### Differentiators (Competitive Advantage)

| Feature | Value Proposition | Complexity | Notes |
|---------|--------------------|------------|-------|
| True one-click, in-UI, per-contact DSR export (not a segment-of-one workaround, not a support-ticket/staff-mediated DSAR process) | Klaviyo's actual mechanism for "export one person's data" is *build a segment containing just them, then export the segment* — a workaround, not a dedicated feature. Mailchimp's DSAR path is a formal intake form processed by Mailchimp staff, not self-service in the tenant's own UI. A marketer-facing "Export this contact's data" button directly on the contact card that produces an immediate downloadable file is meaningfully better self-service UX than either — worth calling out as a genuine (if narrow) advantage for smaller/mid-market tenants who don't want to file a ticket or hand-build a segment every time a customer asks "what do you have on me." | MEDIUM | Already scoped as required for v1.2, so this is "differentiator we get for free by doing table stakes well," not additional scope. |
| Documented, deterministic, resumable workspace purge (evidence of *when and what* was purged) | Most competitor/industry guidance describes purge only in the abstract ("have a retention policy"); few document a resumable, idempotent, per-tenant-scoped purge job as a first-class engineered capability with proof of completion. Given this platform already has a strong "evidence, not just claims" pattern (erasure_records from Phase 13, dead_letter_jobs, catalog-driven partition retention from Phase 14), extending that same evidence discipline to workspace purge is consistent with the platform's existing compliance posture and differentiates it from ESPs that only describe policy in a DPA without an auditable mechanism. | HIGH | Reuses the Phase 13 erasure evidence pattern (`erasure_records`) and the Phase 14 catalog-driven retention pattern (drop by bounds queried from catalog, not by table-name convention) — both are precedents to extend, not invent from scratch. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|------------------|-------------|
| Full self-service "privacy rights portal" covering every GDPR/CCPA right type (access, erasure, rectification, objection, portability) in one UI flow | Feels like "doing compliance properly once instead of piecemeal" | Massively over-scopes v1.2; erasure already exists (Phase 13, per-contact anonymization), export is being added now — building a generalized multi-right-type request-intake-and-workflow system is a different, much larger product (this is literally what third-party tools like DataGrail/TrustWorks exist to sell as an add-on layer on top of ESPs like Klaviyo/Mailchimp) | Ship the two rights actually in scope (export, erasure — erasure already done) as direct UI actions; do not build a generic "request type" workflow engine |
| Synchronous/blocking DSR export generation on the request thread | Feels simpler to implement — "just query and return a file" | A contact's data can span profile + custom properties + full consent history + full event history + send-related PII across potentially years of activity; blocking a request thread (or a UI spinner) risks timeouts and doesn't match how every reference implementation (Braze's async export-with-emailed-link, Userpilot/Salesforce/Braze all use async job + notification + expiring download link) actually does bulk-ish per-entity exports | Async job (reuse existing BullMQ queue infrastructure) generates the file, tenant is notified/polled in-UI, download link expires (industry examples range 2 days–7 days; Braze's dashboard exports expire in 4 hours) — but note: for a *single contact's* data (not a bulk workspace export) synchronous generation may in fact be fast enough in practice; validate against actual data volume before defaulting to async complexity |
| Immediate hard-delete on workspace soft-delete, no grace period | "Just get rid of it, why wait" — feels more thoroughly compliant | No path to undo an accidental or malicious soft-delete (support/ops error, compromised admin account); every SaaS retention guide treats the grace period as the safety mechanism, not an obstacle to compliance — GDPR gives up to 30 days as an accepted norm for erasure fulfillment anyway, so an immediate irreversible hard-delete buys no compliance benefit and adds operational risk | Platform-default grace period (operator-configurable per PROJECT.md scope: "платформенный default, задаёт оператор") between soft-delete and the purge job actually running |
| Invalidate/expire all previously-sent unsubscribe links immediately on secret rotation (single-secret cutover, no overlap) | Simpler to implement — one secret, no `kid` bookkeeping, no list of previous secrets to carry | Breaks a legally-required mechanism (working unsubscribe link) for every email already sent and sitting in inboxes — directly contradicts "graceful rotation" as scoped, and given the 5-year TTL already baked into this codebase, an immediate cutover would break unsubscribe for years of previously-sent mail simultaneously the moment rotation happens | Primary secret signs new tokens; ordered list of previous secrets is tried during verification (exactly as scoped) — the "previous secrets" list must be retained for as long as issued tokens remain within their TTL, not just a short transition window |
| Building a custom in-house vulnerability-scanning/SCA dashboard UI | Feels like a natural companion to "dependency hygiene" | Reinventing tooling that already exists and is well-maintained (npm audit, `audit-ci`, Dependabot, optionally Snyk) — a custom scanner/UI is pure maintenance burden with no product value; this is an engineering-process feature, not a customer-facing one | Use `audit-ci`-style CI gate + committed allowlist file (owner, justification, expiry) reviewed on a cadence; Dependabot for automated patch PRs. No new UI, no new service. |

## Feature Dependencies

```
Campaign template correctness
    └──no new dependency: fix within existing campaign send/launch path (Phase 4)

DSR contact export
    └──requires──> existing tenant-isolated RLS + per-table PII (contacts, custom properties,
                    consent history, events, send_events) — all already exist (Phases 2–5, 13)
    └──requires──> existing per-workspace scoping pattern (tenant_id filtering + RLS,
                    same discipline as every other tenant-scoped read)
    └──optionally-enhances-with──> existing BullMQ queue infra, IF async generation is chosen

Workspace physical purge
    └──requires──> workspace soft-delete state (organization.deletedAt — already exists)
    └──requires──> existing KMS envelope-encryption pattern (Phase 1) to delete tenant DEK/secret
                    material, not just delete rows
    └──requires──> existing catalog-driven, evidence-producing deletion precedent
                    (Phase 13 erasure_records anonymization pattern; Phase 14 catalog-driven
                    partition retention pattern) — extend, don't reinvent
    └──must-not-break──> RLS isolation for sibling tenants (purge job necessarily operates
                          with elevated/service-role privilege across the tenant boundary —
                          same risk class as the existing mega_crm_scan least-privilege role
                          pattern from Phase 10, not application-level tenant_id filtering alone)

Unsubscribe-secret rotation
    └──requires──> existing unsubscribe-token HMAC mechanism (packages/delivery-core/
                    unsubscribe-token.ts) — single secret today, no kid, 5-year TTL
    └──conflicts-with-naive-approach──> short-overlap-window rotation patterns from generic
                    JWT/webhook guides (those assume hours-to-days overlap; this system's
                    5-year token TTL means "previous secrets" retention is effectively
                    multi-year, not a short cutover window)
    └──optionally-uses──> existing KMS/secret-storage conventions for where rotated secrets live

Dependency hygiene CI gate
    └──requires──> existing CI quality-gate pipeline + branch protection (Phase 8)
    └──no dependency on other v1.2 features
```

### Dependency Notes

- **Workspace purge requires the KMS envelope-encryption pattern, not just row deletion:** tenant SendGrid API keys are stored as KMS-wrapped DEKs (Phase 1 pattern). "Delete tenant secrets" (explicitly named in the v1.2 scope) means destroying/unwrapping-then-discarding that key material, not merely deleting the row that references it, if the DEK or wrapped ciphertext could otherwise be reconstructed from other retained data.
- **Workspace purge must not break sibling-workspace isolation:** because a purge job necessarily crosses the tenant_id boundary that RLS normally enforces (it needs to find and delete data across all tables scoped to one workspace, likely via a service role), it belongs in the same risk class as the existing `mega_crm_scan`/`mega_crm_auth` least-privilege role pattern from Phase 10 — reuse that discipline (dedicated role, not blanket superuser) rather than the application-level `WHERE tenant_id = ?` pattern that's explicitly called out as *insufficient alone* elsewhere in this project's own stack research.
- **Unsubscribe-secret rotation's real complexity is the 5-year TTL, not the rotation mechanism itself:** the `kid`-header / "try each previous secret" pattern from the ecosystem research is standard and directly applicable, but standard guides assume short overlap windows; this project's actual token lifetime (`UNSUBSCRIBE_TOKEN_TTL_SECONDS = 60*60*24*365*5` in `send-dispatch.ts`/`flow-send.ts`) means the "previous secrets" list is a long-lived, possibly-growing list across the platform's lifetime, not a two-entry transient state — this has real implications for how many previous secrets need to be retained/configured and for how long, which the roadmap phase should size explicitly rather than copy a generic rotation pattern uncritically.
- **DSR export and workspace purge are related but must stay decoupled:** export reads a single contact's data without touching or destroying anything; purge destroys an entire workspace's data. Do not let purge's "what data categories count as tenant PII" enumeration silently diverge from export's "what data categories count as this contact's personal data" enumeration — both should derive from one shared inventory of PII-bearing tables/columns (profile, custom properties, consent history, events, send-related PII) to avoid one being more complete than the other.
- **Campaign template correctness has no cross-feature dependency** — it's a localized fix in the existing campaign launch/schedule/test-send path (`apps/web/src/features/campaigns/*`, Phase 4 origin) and should not be conflated architecturally with the other four (which are all compliance/security-hygiene additions).

## MVP Definition (v1.2 Scope)

### In This Milestone (already scoped as Active requirements)

- [ ] Campaign template correctness fix — reliability regression, blocks trust in the send path
- [ ] Per-contact DSR export (UI button → downloadable file) — closes the GDPR access/portability gap alongside existing erasure
- [ ] Workspace physical purge after retention — closes the GDPR erasure-past-account-closure gap
- [ ] Unsubscribe-secret graceful rotation — closes a standing single-point-of-compromise risk on a legally-required mechanism
- [ ] Dependency hygiene CI gate + triage mechanism — closes an audit-flagged engineering hygiene gap

### Explicitly Deferred (per PROJECT.md "осознанно НЕ вошедшие в v1.2")

- [ ] PgBouncer / connection pooling under real `max_connections` pressure (SCALE-02)
- [ ] Segmentation benchmark at 100k–1M contacts
- [ ] Remaining live compliance/operator-alert walkthroughs
- [ ] Two UI follow-ups from Phase 15 (LaunchConfirmDialog, CsvImportWizard)
- [ ] KMS quick-task Task 3 (production file-backed KEK provisioning)

### Future Consideration (beyond v1.2, not currently scoped)

- [ ] Generalized privacy-rights-request workflow (rectification, objection, multi-right intake) — explicitly an anti-feature for v1.2, see above
- [ ] Bulk/workspace-wide data export (distinct from single-contact DSR export) — not requested; would need its own async-job design if ever scoped
- [ ] Commercial SCA tooling (Snyk-style reachability analysis) beyond `npm audit`/Dependabot — worth revisiting only if the free-tooling allowlist becomes noisy at scale

## Feature Prioritization Matrix

| Feature | User/Compliance Value | Implementation Cost | Priority |
|---------|------------------------|----------------------|----------|
| Campaign template correctness | HIGH (trust-destroying bug) | LOW | P1 |
| DSR contact export | HIGH (legal requirement) | MEDIUM | P1 |
| Workspace physical purge | HIGH (legal requirement, highest engineering risk) | HIGH | P1 |
| Unsubscribe-secret rotation | MEDIUM (risk-reduction, not user-visible) | MEDIUM–HIGH (5-year TTL implication) | P1 |
| Dependency hygiene CI gate | MEDIUM (audit/engineering hygiene, not user-visible) | LOW–MEDIUM | P1 |

All five are already committed "Active" requirements for this milestone (per PROJECT.md), so this matrix is descriptive (informs phase ordering/sizing) rather than a scope-selection tool — the workspace purge item, being both HIGH-risk and HIGH-value, likely warrants the most roadmap attention/its own phase given its dependency on the KMS + cross-tenant-boundary risk class described above.

## Competitor Feature Analysis

| Feature | Klaviyo | Mailchimp | Braze | Our Approach (v1.2) |
|---------|---------|-----------|-------|----------------------|
| Per-contact data export | Segment-of-one CSV export workaround, no dedicated single-contact button | Per-contact "Export a Contact" CSV; separate formal DSAR intake page for staff-mediated requests | Whole-profile export via REST API/SDK; cannot selectively export individual behavioral events (all-or-nothing at profile level) | Dedicated one-click button on the contact card → immediate downloadable file covering profile, custom properties, consent history, events, and send-related PII — more direct self-service than any of the three references found |
| Account/tenant data purge after closure | Not documented in public sources found; presumed policy-level, not evidenced | Not documented in public sources found | Customers can self-delete entire user profiles; behavioral events only removable via full-profile deletion — no public documentation found on account-level (not per-profile) purge lifecycle | Idempotent, resumable, evidence-producing platform-level purge job on a policy-defined retention window, extending this project's own existing evidence-producing patterns (erasure_records, catalog-driven retention) |
| Signing-key/secret rotation for compliance-critical links | Not documented in public sources found | Not documented in public sources found | Not documented in public sources found | Primary/previous-secret HMAC verification with `kid`-style dispatch, sized explicitly for a 5-year token lifetime already present in this codebase — no comparable public documentation found for any reference ESP, likely because this is treated as an internal security practice, not a marketed feature |
| Dependency/supply-chain hygiene | N/A (not a customer-facing ESP feature for any platform) | N/A | N/A | Not competitive scope — purely internal engineering practice, included here for completeness per milestone scope |

Note: Klaviyo/Mailchimp/Braze purge-lifecycle and key-rotation practices were not publicly documented in the sources found (search access only, no vendor DPA/security-whitepaper review) — treat the "Not documented" cells as a research gap, not evidence of absence. If exact competitive parity on these two matters later, a deeper pass against each vendor's Trust/Security Center and DPA would be needed.

## Sources

- [How to handle GDPR and CCPA requests | Klaviyo Help Center](https://help.klaviyo.com/hc/en-us/articles/360004217631) — MEDIUM confidence
- [How to export all people in your account | Klaviyo Help Center](https://help.klaviyo.com/hc/en-us/articles/115005246168) — MEDIUM confidence
- [Export a Contact | Mailchimp](https://mailchimp.com/help/export-contacts/) — MEDIUM confidence
- [About Data Subject Access Reports | Mailchimp](https://mailchimp.com/legal/dsar-requests/) — MEDIUM confidence
- [Braze Data Retention Information](https://www.braze.com/docs/api/data_retention) — MEDIUM confidence
- [Braze Privacy Portal](https://www.braze.com/docs/user_guide/privacy_portal) — MEDIUM confidence
- [Is Braze GDPR compliant? (PDF FAQ)](https://marketing-assets.braze.com/production/legacy/documents/braze_gdpr_faq_004.pdf) — MEDIUM confidence
- [The Complete Guide to Data Subject Access Requests (DSAR)](https://complydog.com/blog/data-subject-access-requests-dsar) — MEDIUM confidence
- [GDPR Data Export Request Handler for SaaS Products | Yaro Labs](https://yaro-labs.com/blog/gdpr-data-export-handler) — MEDIUM confidence
- [Data Subject Requests for GDPR and CCPA | Microsoft Learn](https://learn.microsoft.com/en-us/compliance/regulatory/gdpr-data-subject-requests) — MEDIUM confidence
- [Soft delete vs hard delete: choose the right data lifecycle | AppMaster](https://appmaster.io/blog/soft-delete-vs-hard-delete) — MEDIUM confidence
- [Data Retention Policy for SaaS Startups (2026)](https://www.buildmvpfast.com/blog/data-retention-policy-saas-startup-guide-2026) — MEDIUM confidence
- [Data Isolation For Multi-Tenant SaaS: GDPR-Compliant Hosting Architectures | DCHost](https://www.dchost.com/blog/en/data-isolation-for-multi-tenant-saas-gdpr-compliant-hosting-architectures/) — MEDIUM confidence
- [SaaS Data Ownership & Exits | Turley Law](https://turleylaw.com/blog/saas-data-ownership-exit-strategy) — MEDIUM confidence
- [Token Signing Key Rotation | Curity Identity Server](https://curity.io/resources/learn/token-signing-key-rotation/) — MEDIUM confidence
- [Zero Downtime Secret Rotation for Webhooks | Svix Blog](https://www.svix.com/blog/zero-downtime-secret-rotation-webhooks/) — MEDIUM confidence
- [Rotate JWT Secrets Without Downtime | JWTSecrets](https://www.jwtsecretgenerator.com/blog/how-to-rotate-jwt-secrets) — MEDIUM confidence
- [JWT security: kid, JWKS and key rotation | Breachroad](https://breachroad.com/en/blog/jwt-security-kid-jwks/) — MEDIUM confidence
- [Secrets Management and Key Rotation: 2026 Reference](https://www.digitalapplied.com/blog/secrets-management-api-key-rotation-2026-engineering-reference) — MEDIUM confidence
- [GitHub - IBM/audit-ci](https://github.com/IBM/audit-ci) — MEDIUM confidence (first-party tool docs via GitHub)
- [npm audit: Which Vulnerabilities to Fix vs. Ignore](https://www.decryptiondigest.com/blog/npm-audit-which-vulnerabilities-to-fix-vs-ignore) — MEDIUM confidence
- [Dependabot vs Snyk vs Trivy vs npm audit comparison guide](https://tomodahinata.com/en/blog/dependabot-vs-snyk-trivy-npm-audit-sca-tools-comparison-guide) — MEDIUM confidence
- [Vulnerability Remediation: From Scan to Merge in AI Pipelines | Augment Code](https://www.augmentcode.com/guides/vulnerability-remediation-scan-to-merge) — MEDIUM confidence
- [Triage your Code Security Findings | Mend.io](https://docs.mend.io/platform/latest/triage-your-code-security-findings) — MEDIUM confidence
- Codebase (this repo, 2026-08-20 state): `packages/db/src/schema/auth.ts` (`organization.deletedAt`), `packages/delivery-core/src/unsubscribe-token.ts`, `apps/worker/src/queues/send-dispatch.ts`, `apps/worker/src/queues/flows/flow-send.ts` (all HIGH confidence — direct code read, primary source)

---
*Feature research for: B2C email marketing automation platform (Klaviyo-model), v1.2 Data Lifecycle & Delivery Trust milestone*
*Researched: 2026-08-20*
