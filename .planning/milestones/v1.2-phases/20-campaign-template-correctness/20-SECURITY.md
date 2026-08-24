---
phase: 20
slug: campaign-template-correctness
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-21
---

# Phase 20 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| migration → live database | DDL executed by the deploy/dev applier under `mega_crm_app`; the only writer of schema shape | schema DDL (`campaigns.version` column) |
| repository → `campaigns` row | every read/write of the version column goes through `packages/db` schema + `apps/api` repository, never ad-hoc SQL | campaign row state, version counter |
| browser → launch/schedule/test-send routes | untrusted JSON bodies; each carries a required integer `expectedVersion` precondition | client-supplied precondition (integer) |
| route → locked campaign row | the single send-decision point; the row, not the request, supplies template/sender/segment | template id, sender, segment, status |
| api → SendGrid `/v3/verified_senders` | outbound read resolving a sender id to an address; never trusts a client-supplied address | sender id → verified address |
| route → Redis (email-broadcast queue) | enqueue boundary the D-12 test-send snapshot crosses; consumed by apps/worker | job payload (ids + snapshot templateId/fromEmail) |
| Redis (email-broadcast queue) → worker | job payload; already the trusted carrier of workspaceId/campaignId/testTo | job payload |
| worker → SendGrid mail/send | the tenant's own decrypted key sends the resolved template to the resolved address | tenant API key, recipient address |
| browser form state → send actions | local form state must never be what a send acts on, nor be silently ignored | unsaved form edits |
| API error response → browser | the typed `code` selects the recovery path; the body is data, never instructions | typed error code, currentVersion |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-20-01-01 | Tampering | `ALTER TABLE campaigns ADD COLUMN version` | low | accept | Constant-default ADD COLUMN, no backfill; pre-existing rows deterministically read 1 (`packages/db/migrations/0066_campaigns_version.sql`) | closed |
| T-20-01-02 | Denial of Service | `ACCESS EXCLUSIVE` lock during ALTER | low | accept | Postgres ≥11 non-volatile default = no table rewrite; `campaigns` is small, sub-second lock window | closed |
| T-20-01-03 | Tampering | reversibility registries (`MIGRATION_TIERS`/`MIGRATION_INVERSES`) | medium | mitigate | Tier entry `packages/db/src/migration-tiers.ts:139`; inverse registered in rollback rehearsal (`migration-rollback-rehearsal.test.ts:107`); enforced by `npm run test:migrations` | closed |
| T-20-01-SC | Tampering | npm/pip/cargo installs | n/a | accept | No packages installed in this phase (RESEARCH.md Package Legitimacy Audit: not applicable) | closed |
| T-20-02-01 | Tampering | launch precondition (check-then-act) | high | mitigate | Version compared inside the same `SELECT … FOR UPDATE` transaction as status flip + bump (`campaign.repository.ts:253-282`); stale-version integration test asserts row untouched | closed |
| T-20-02-02 | Tampering | send decision reading client fields | high | mitigate | `launchCampaignSchema` = exactly one integer field (`packages/shared-schemas/src/campaign.ts:54`); template/sender/segment read from locked row; kickoff job carries ids only | closed |
| T-20-02-03 | Spoofing | sender resolution ahead of the lock | medium | mitigate | Read-only match against SendGrid `/v3/verified_senders` (`sender-resolver.ts:88`); result persisted only inside the locked transaction | closed |
| T-20-02-04 | Information Disclosure | `currentVersion` in 409 body | low | accept | Integer counter disclosed only to callers holding workspace membership + `campaign:launch`; reveals only "this row changed" | closed |
| T-20-02-05 | Repudiation | launch the marketer never confirmed | high | mitigate | Precondition required (400 without it), compared under lock; conflict path returns before kickoff enqueue (`campaigns.routes.ts:98-102,323,348`) | closed |
| T-20-02-SC | Tampering | npm/pip/cargo installs | n/a | accept | No packages installed in this plan | closed |
| T-20-03-01 | Tampering | schedule precondition (check-then-act) | high | mitigate | Version compare inside `scheduleCampaign`'s existing `SELECT … FOR UPDATE` transaction (`campaign.repository.ts:325-348`) | closed |
| T-20-03-02 | Tampering | test-send precondition | high | mitigate | `prepareCampaignTestSend` performs a locked read + version compare; route reaches `queue.add` only after the transaction committed (`campaign.repository.ts:411+`, `campaigns.routes.ts:518`) | closed |
| T-20-03-03 | Tampering | enqueue → dispatch async gap (test send) | high | mitigate | `templateId`/`fromEmail` captured from the verified locked row into the job payload (`packages/shared-schemas/src/queues.ts:169-188`); worker-side consumption pinned in 20-04 | closed |
| T-20-03-04 | Tampering | job payload as trust surface | medium | accept | Redis unreachable by tenants; new fields no more privileged than existing `workspaceId`/`campaignId`/`testTo` — accepted on the same basis | closed |
| T-20-03-05 | Denial of Service | rolling deploy: old worker drains new-shaped jobs | low | mitigate | Both fields optional, no `schemaVersion` bump (the `requestId` precedent); old worker validates and falls back to its current row read; `from_email` stays persisted | closed |
| T-20-03-06 | Repudiation | test send the marketer never confirmed | high | mitigate | Precondition required (400), compared under lock (409 before any enqueue); mail carries the template the passing check observed | closed |
| T-20-03-SC | Tampering | npm/pip/cargo installs | n/a | accept | No installs in this plan or phase | closed |
| T-20-04-01 | Tampering | worker preferring payload-supplied template/sender | medium | mitigate | Override consulted ONLY in the `kind === "test"` branch; campaign/flow claim paths call `readSendPrereqs` with no override (`send-dispatch.ts:214-278`); pinned by `test-send-template-snapshot.test.ts` | closed |
| T-20-04-02 | Spoofing | forged job injecting arbitrary template id | low | accept | Redis unreachable by tenants; send uses the tenant's OWN decrypted key, so a template id can only address that tenant's own account — no cross-tenant reach | closed |
| T-20-04-03 | Denial of Service | snapshot naming a deleted template | low | accept | SendGrid answers a definite 4xx; existing `classifyTransportError` records `failed` with no retry storm; failure visible in the outcome | closed |
| T-20-04-04 | Information Disclosure | logging the snapshot fields | low | mitigate | Dispatch log lines carry ids and outcomes only (`send-dispatch.ts:511,631,808`); no log line includes `templateId`/`fromEmail`/`testTo` | closed |
| T-20-04-SC | Tampering | npm/pip/cargo installs | n/a | accept | No installs in this plan or phase | closed |
| T-20-05-01 | Repudiation | send the marketer believes used their on-screen selection | high | mitigate | All three actions disabled while dirty: launch/schedule share the single gated trigger (`LaunchScheduleDialogs.tsx:396,423` — `disabled = !canLaunch \|\| incompleteReason \|\| isDirty`), test-send gated at `TestSendPanel.tsx:158`; inline copy names the reason; server precondition remains authoritative | closed |
| T-20-05-02 | Tampering | client-side blocking treated as the security control | medium | mitigate | Recorded explicitly as a UX guard; enforcement is the required `expectedVersion` compared under lock server-side — a bypassed client still cannot send a stale template | closed |
| T-20-05-03 | Denial of Service | render loop between publishing builder and providing page | low | mitigate | Publish effect dependency list is exactly the four compared fields + isSaving/enabled (`CampaignDirtyStateContext.tsx:130-142`); provider re-render cannot re-fire it | closed |
| T-20-05-SC | Tampering | npm/pip/cargo installs | n/a | accept | No installs; uses dependencies `apps/web` already has | closed |
| T-20-06-01 | Repudiation | automatic retry sending unconfirmed mail | high | mitigate | Error handler only sets state and invalidates queries; mutation never re-invoked, no `retry` option (TanStack mutation default is no retry); `campaignSendConflict.ts` never calls a mutation; request-count assertion in e2e spec | closed |
| T-20-06-02 | Information Disclosure | error copy echoing server internals | low | mitigate | Copy composed from typed code + campaign status label (`campaignSendConflict.ts`); `err.message` is never rendered | closed |
| T-20-06-03 | Tampering | client-side classification treated as the control | low | accept | Refusal already happened server-side under lock (plans 20-02/20-03); this layer is presentation and recovery only | closed |
| T-20-06-04 | Repudiation | unsaved edits replaced by refetch with no notice | medium | mitigate | `CONFLICT_REFRESH_NOTICE` rendered via `toast()` on every conflict path (`LaunchScheduleDialogs.tsx:106,204`, `TestSendPanel.tsx:103`) | closed |
| T-20-06-SC | Tampering | npm/pip/cargo installs | n/a | accept | No installs; `@playwright/test` and all dependencies already pinned in `apps/web` | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-20-01 | T-20-01-01 | Constant-default ADD COLUMN cannot read, move or overwrite tenant values; pre-existing rows deterministically read 1 | plan-time register (20-01-PLAN.md) | 2026-08-21 |
| AR-20-02 | T-20-01-02 | No table rewrite on Postgres ≥11; `campaigns` is orders of magnitude smaller than `sends`/`events`, sub-second lock window | plan-time register (20-01-PLAN.md) | 2026-08-21 |
| AR-20-03 | T-20-02-04 | 409 `currentVersion` is an integer counter for a campaign the caller already holds workspace membership and `campaign:launch` for | plan-time register (20-02-PLAN.md) | 2026-08-21 |
| AR-20-04 | T-20-03-04 | Broadcast payload is already the trusted carrier of workspaceId/campaignId/testTo; Redis not tenant-reachable; new fields no more privileged | plan-time register (20-03-PLAN.md) | 2026-08-21 |
| AR-20-05 | T-20-04-02 | Send uses the tenant's own decrypted SendGrid key — a forged template id has no cross-tenant reach | plan-time register (20-04-PLAN.md) | 2026-08-21 |
| AR-20-06 | T-20-04-03 | Deleted-template snapshot yields a definite SendGrid 4xx → `failed`, no retry storm; cause is the tenant's own deletion | plan-time register (20-04-PLAN.md) | 2026-08-21 |
| AR-20-07 | T-20-06-03 | Client-side classification is presentation/recovery only; the authoritative refusal is server-side under lock | plan-time register (20-06-PLAN.md) | 2026-08-21 |
| AR-20-SC | T-20-01-SC, T-20-02-SC, T-20-03-SC, T-20-04-SC, T-20-05-SC, T-20-06-SC | Phase 20 installs no packages; RESEARCH.md Package Legitimacy Audit records "not applicable — no new external packages"; no plan contains an install step | plan-time registers (all six plans) | 2026-08-21 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-21 | 31 | 31 | 0 | /gsd-secure-phase orchestrator (L1 short-circuit — plan-time register, grep-depth verification) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-21
