---
phase: 13
slug: compliance-analytics-integrity
status: verified
threats_open: 0
asvs_level: 1
created: 2026-08-12
---

# Phase 13 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Register authored at plan time across 16 plans (13-01 … 13-16); mitigations verified 2026-08-12 by gsd-security-auditor (opus), ASVS L1 presence-in-cited-location depth, block_on: high.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| SendGrid → public webhook route | Untrusted signed bytes; ECDSA signature + header timestamp are the only authority | Raw event batches (recipient email, IPs, user agents) |
| API/worker → Postgres | Verified-but-tenant-owned PII persisted under RLS (`ingress_journal`, `send_event_quarantine`, `erasure_records`, …) | Tenant PII, delivery facts |
| API → Redis (BullMQ payloads) | Job payloads carry journal/contact ids that must not cross workspaces | Workspace-scoped ids |
| Platform-mail alert channel | Operator + tenant reputation/ingestion alerts sent via platform key, never tenant BYO keys | Aggregate rates only — no tenant PII in bodies |
| Operator CLI (`replay-webhook-journal`) | Human-invoked replay; scoped to a single `--workspace`, dry-run supported | Journal rows |
| Public unsubscribe route | Token-authenticated, byte-identical responses across all four outcomes (no oracle) | HMAC tokens binding sendId/contactId/workspaceId |

---

## Threat Register

All 122 threats CLOSED (107 mitigations verified in implementation, 15 accepted risks per plan registers). Evidence is file:line or test at ASVS L1 depth.

### Supply chain (all 16 plans)

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-01-SC … T-13-16-SC | Tampering | npm installs | high | mitigate | Phase-13 `package-lock.json` diff adds zero registry-resolved packages — only workspace-internal `@mega-crm/*` links and already-locked externals at existing versions | closed |

### 13-01 — webhook ingress durability

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-01-01 | Tampering | `webhooks.routes.ts` journal write ordering | high | mitigate | Verify gate returns 400 (`webhooks.routes.ts:123-130`) before journal write (`:150-153`) | closed |
| T-13-01-02 | Info Disclosure | `ingress_journal`, `send_event_quarantine` | high | mitigate | Migration `0055:55-60,148-153` ENABLE+FORCE RLS, bare-cast policy; `tenant-context.test.ts:314,348` | closed |
| T-13-01-03 | Repudiation | Journal as replay source | medium | accept | Replay re-enqueues an idempotently-deduped job — no side effects beyond a legitimate retry | closed (accepted) |
| T-13-01-04 | DoS | Fail-closed 5xx on journal failure | medium | accept | Intended trade — SendGrid ~24h retry window recovers | closed (accepted) |
| T-13-01-05 | Tampering | `journalId` in BullMQ payload | low | mitigate | `webhook-events.worker.ts:584` — journal completion inside `withTenant(workspaceId, …)` | closed |
| T-13-01-06 | Info Disclosure | Scan-role read on `ingress_journal` | medium | mitigate | `0055:80` GRANT SELECT only; `:97-99` scan policy limited to un-ingested rows; no scan grant on quarantine | closed |
| T-13-01-07 | Repudiation | Silent alert failure (missing scan grant) | high | mitigate | Grant+policy in `0055`; `ingestion-health-watchdog.test.ts:188,195` exercises real scan read | closed |
| T-13-01-08 | Repudiation | False poison-batch alerts | high | mitigate | Both terminal outcomes mark complete: `webhook-events.worker.ts:690` and `:820-821` | closed |
| T-13-01-09 | Repudiation | Ingestion loss aging out at retention | high | mitigate | `ingress-journal.ts:171-175` DELETE gated on completed; `:206-212` payload purge leaves tombstones; `0055:46` CHECK | closed |
| T-13-01-10 | DoS | Unbounded tombstone accumulation | low | accept | Tombstones are payload-free; volume tracks failure rate | closed (accepted) |

### 13-02 — UTC day semantics

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-02-01 | Tampering | `reconcileWorkspaceDay` day casts | high | mitigate | `analytics-reconciliation.worker.ts:114-123` — 8 `AT TIME ZONE 'UTC'` casts; `reconcile-utc-day.test.ts:145-166` three session TZs | closed |
| T-13-02-02 | Repudiation | Daily metric integrity | medium | mitigate | `workspace-daily-rollup.ts:24-54` CMP-02 day-semantics contract block | closed |
| T-13-02-03 | Info Disclosure | Cross-workspace discovery in reconciler tick | low | accept | Unchanged scan-role enumeration, pre-existing pattern | closed (accepted) |

### 13-03 — campaign progress ledger

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-03-01 | Repudiation | `getCampaignProgress` ledger allow-list | medium | mitigate | `campaign.repository.ts:442-449` all-statuses initializer; ledger-sums-to-total test | closed |
| T-13-03-02 | Info Disclosure | Campaign progress read | low | accept | Route resolves workspace, reads inside `withTenant` | closed (accepted) |
| T-13-03-03 | Tampering | Cross-app status vocabulary drift | low | mitigate | `send-log-status-vocabulary.test.ts:53-54` pins array equality | closed |

### 13-04 — occurred_at bounding & quarantine

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-04-01 | Tampering | `extractEventRow` timestamp handling | high | mitigate | `occurred-at-bounds.ts:85,99-100` both bounds; called at `webhook-events.worker.ts:126` | closed |
| T-13-04-02 | Tampering | Partition routing via stray timestamp | high | mitigate | Rejected verdict → quarantine; only `kind:"extracted"` reaches INSERT (`worker:765`) | closed |
| T-13-04-03 | DoS | One malformed event failing a batch | medium | mitigate | `quarantine.ts:91` swallow-and-log; per-event loop; mixed-batch test | closed |
| T-13-04-04 | Info Disclosure | Raw rejected payload in quarantine | medium | mitigate | `0055:148-153` FORCE RLS + workspace_isolation; 7-day horizon | closed |
| T-13-04-05 | Repudiation | Losing forensic evidence of rejection | low | mitigate | `quarantine.ts:80-88` persists candidate/reason/raw_event; server-set `received_at` | closed |

### 13-05 — dirty-day rollup sweep

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-05-01 | Tampering | Retroactive rollup increment | high | mitigate | Dirty days re-run through `reconcileWorkspaceDay` absolute overwrite (`worker:267-268`) | closed |
| T-13-05-02 | Repudiation | Lost late-event tracking (clear race) | high | mitigate | `AND dirtied_at <= $1` (`worker:195-203`); post-sweep mark survives (test `:341`) | closed |
| T-13-05-03 | DoS | Unbounded dirty-day backlog | medium | mitigate | `DIRTY_DAY_SWEEP_PAGE_LIMIT = 50` (`:220`, applied `:263`) | closed |
| T-13-05-04 | Tampering | Forged `occurred_at` dirtying arbitrary days | medium | mitigate | Inherits `OCCURRED_AT_MAX_PAST_DAYS = 7` bound (via T-13-04-01) | closed |
| T-13-05-05 | Info Disclosure | Cross-workspace dirty-day discovery | low | accept | Dirty-day query already inside `withTenant` | closed (accepted) |

### 13-06 — journal replay & retention

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-06-01 | Repudiation | Replay duplicating side effects | high | mitigate | `ON CONFLICT … DO NOTHING` (`worker:765`); side effects gated on returned rows (`:771`) | closed |
| T-13-06-02 | DoS | Mass re-enqueue flooding live lane | high | mitigate | Sweep PAGE_LIMIT=200, MAX_ATTEMPTS=5; capped rows stay observable | closed |
| T-13-06-03 | Elev. of Privilege | Operator CLI blast radius | medium | mitigate | `replay-webhook-journal.ts:111-114` requires `--workspace`; `--dry-run` | closed |
| T-13-06-04 | Info Disclosure | Cross-workspace journal discovery in sweep | medium | mitigate | Scan used only for id enumeration; journal I/O in `withTenant` | closed |
| T-13-06-05 | Tampering | Replay minting new journal identity | medium | mitigate | Reuses `row.id` as `journalId` (`replay-webhook-journal.ts:287`) | closed |
| T-13-06-06 | Info Disclosure | Journal PII retention | medium | mitigate | Both retention calls every tick (`webhook-replay-sweep.worker.ts:299-300`) | closed |
| T-13-06-07 | Repudiation | Evidence disposal disguised as PII disposal | high | mitigate | DELETE constrained to completed rows; never-transitions-to-absent tests | closed |

### 13-07 — dedup key rebase

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-07-01 | Tampering | Dedup key on `sg_event_id` | high | mitigate | `0057:190` unique index on (workspace_id, send_id, event_type, occurred_at); `sg_event_id` demoted | closed |
| T-13-07-02 | Tampering | Non-enforcing invalid index | high | mitigate | Single blocking parent-level build; raises unless `indisvalid`; two-partition test | closed |
| T-13-07-03 | DoS | Unbounded duplicate-resolving DELETE | high | mitigate | Migration contains no DELETE; RAISE on survivors; opt-in operator script | closed |
| T-13-07-04 | Repudiation | Losing provider event-id correlation | medium | mitigate | `sg_event_id` stays NOT NULL forensic column | closed |
| T-13-07-05 | Repudiation | Dedup window with no protection | medium | mitigate | Expand/contract: DROP CONSTRAINT only after validity check + insert swap | closed |
| T-13-07-06 | Repudiation | Under-counting repeat engagement | low | accept | 1s provider granularity; pinned by test | closed (accepted) |
| T-13-07-07 | Repudiation | Orphan events not deduping | low | accept | Orphan events drive zero counters | closed (accepted) |
| T-13-07-08 | DoS | Ingestion failure during rolling deploy | medium | accept | ROADMAP R-05 stop-old-then-start-new; in migration header | closed (accepted) |
| T-13-07-09 | DoS | Write lock during index build | medium | accept | Worker stopped for migration window — lock contends with nothing | closed (accepted) |

### 13-08 — atomic unsubscribe convergence

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-08-01 | Repudiation | Partial unsubscribe state after crash | high | mitigate | Single `withTenantTransaction` (`unsubscribe.routes.ts:206-230`); failure-injection tests | closed |
| T-13-08-02 | Repudiation | Consent vs delivery evidence disagreement | high | mitigate | Both entry points call `applyUnsubscribeWithSendFact` (`unsubscribe-apply.ts:73`) | closed |
| T-13-08-03 | Tampering | Double-counting on either arrival order | medium | mitigate | `setFactColumnOnce` WHERE-null guard; increments gated on `sendFactJustSet` | closed |
| T-13-08-04 | Info Disclosure | Token-outcome oracle on public route | medium | mitigate | Response block outside validity guard — all four outcomes byte-identical | closed |
| T-13-08-05 | Tampering | Forged token naming another workspace's send | medium | accept | HMAC binds sendId/contactId/workspaceId; lookup inside `withTenant` | closed (accepted) |

### 13-09 — reputation observation

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-09-01 | Info Disclosure | Cross-tenant alert collision (singleton row) | high | mitigate | `0058:72` PK (workspace_id, metric); two-workspace isolation test | closed |
| T-13-09-02 | Info Disclosure | Cross-workspace read in tick | medium | mitigate | Scan for enumeration only; per-workspace `withTenant` (`reputation-tick.worker.ts:184`) | closed |
| T-13-09-03 | Info Disclosure | `reputation_alert_state` without RLS | medium | accept | Platform-job-only table, follows `organization`/`dead_letter_jobs` precedent | closed (accepted) |
| T-13-09-04 | Repudiation | Alarming on meaningless volume | medium | mitigate | `reputation-rates.ts:56,102` floor=500 gates tiering | closed |
| T-13-09-05 | Tampering | Observation write clobbering bookkeeping | medium | mitigate | SET list names only `observed_*` + `updated_at` (`worker:154-159`) | closed |
| T-13-09-06 | DoS | Hourly cross-tenant scan cost | low | accept | Bounded per-workspace counts, slow-moving ratio | closed (accepted) |

### 13-10 — contact erasure

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-10-01 | Info Disclosure | Incomplete PII scrub on contacts row | high | mitigate | Locking read then UPDATE nulling email/names/phone/external_id/city/country/timezone; `properties` emptied (`contact.repository.ts:553-584`) | closed |
| T-13-10-02 | Repudiation | Erasure without auditable proof | high | mitigate | `erasure_records` INSERT in same transaction (`:610-615`); exactly-one-record test | closed |
| T-13-10-03 | Info Disclosure | Scrubbed row leaking into tenant surface | high | mitigate | Anonymized-exclusion in repository, segments compile base predicate, dashboard | closed |
| T-13-10-04 | Tampering | Mail continuing to erased address | high | mitigate | Unconditional suppression INSERT from captured address (`:597-606`); audience excludes anonymized | closed |
| T-13-10-05 | Tampering | Resurrection via re-import/update | medium | mitigate | Upsert branches exclude anonymized (`contacts-core/contact-repository.ts:259,270`) | closed |
| T-13-10-06 | DoS | Duplicate scrub jobs | medium | mitigate | `buildErasureScrubJobId` shared by both producers | closed |
| T-13-10-07 | Repudiation | No trail for pre-phase deletions | low | accept | Pre-phase rows already gone; noted in `0059` comment | closed (accepted) |
| T-13-10-08 | Tampering | Erasure undone via external_id-first upsert | high | mitigate | `external_id = NULL` + every identity branch excludes anonymized | closed |
| T-13-10-09 | Repudiation | Committed erasure, scrub never queued | high | mitigate | Enqueue after transaction closes (`:620-628`); reclaimer backstop (13-15) | closed |

### 13-11 — reputation & ingestion watchdogs

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-11-01 | Info Disclosure | Cross-tenant alert leakage | high | mitigate | Claim keyed workspace_id+metric; per-workspace recipients; independence test | closed |
| T-13-11-02 | Info Disclosure | Tenant PII in alert body | high | mitigate | Absence assertions on rendered text (`not.toMatch(/@/)`, planted-marker absent) | closed |
| T-13-11-03 | Spoofing | Alert via tenant's SendGrid key | medium | mitigate | Sends via injected `deps.sendMail` (platform mail), never tenant key | closed |
| T-13-11-04 | DoS | Alert storm | medium | mitigate | Conditional claim + `REPUTATION_ALERT_DEDUP_HOURS` cooldown | closed |
| T-13-11-05 | Repudiation | Two replicas both/neither alerting | medium | mitigate | Single `UPDATE … RETURNING` claim before send; slot released on rejection | closed |
| T-13-11-06 | DoS | Failing check taking down API | medium | mitigate | Interval catch → `scrubbedConsole.error` | closed |
| T-13-11-07 | Elev. of Privilege | Alert path modifying tenant state | high | mitigate | Source-level test: no UPDATE on campaigns/sends/keys | closed |
| T-13-11-08 | Repudiation | Alert silently never firing (denied read) | high | mitigate | Scan grant+policy in `0055`; real scan-read test | closed |
| T-13-11-09 | Repudiation | Permanent loss never reported (pruned proof) | high | mitigate | 72h window; tombstones own category (`ingestion-health-watchdog.ts:93,132-134,159`) | closed |
| T-13-11-10 | DoS | Alert fatigue on permanent condition | medium | mitigate | Trigger on `payload_purged_at` recency; standing total in body | closed |

### 13-12 — suppression hashing

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-12-01 | Info Disclosure | Plaintext addresses surviving erasure | high | mitigate | `0061:94` DROP COLUMN email after backfill; information_schema test | closed |
| T-13-12-02 | Tampering | Suppression missing during partial conversion | high | mitigate | RAISE on null hashes, SET NOT NULL; all three call sites on hash | closed |
| T-13-12-03 | Info Disclosure | Rainbow-table attack on leaked key | medium | mitigate | Per-workspace keys (`workspace_suppression_keys`); workspace-keyed cache | closed |
| T-13-12-04 | Info Disclosure | Unwrapped key material leaking | high | mitigate | In-process Map only; `finally { keyMaterial.fill(0) }`; eviction zeroing | closed |
| T-13-12-05 | DoS | Key-unwrap on pre-send hot path | high | mitigate | `SUPPRESSION_KEY_CACHE_TTL_MS` per-workspace cache; one-unwrap-per-TTL test | closed |
| T-13-12-06 | Tampering | Case/whitespace bypassing suppression | medium | mitigate | `normalizeSuppressionEmail` before hashing; case test | closed |
| T-13-12-07 | Info Disclosure | Cross-workspace hash correlation | low | mitigate | Different digests per workspace (test) | closed |
| T-13-12-08 | Repudiation | Backfill run twice corrupting hashes | low | mitigate | Idempotency test; already-hashed rows untouched | closed |

### 13-13 — erasure scrub worker

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-13-01 | Info Disclosure | PII surviving in payloads after erasure | high | mitigate | `SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST` reconstruction; `events.properties` → `{}`; key-subset tests | closed |
| T-13-13-02 | Info Disclosure | Page skipped by crash between work and checkpoint | high | mitigate | Checkpoint committed with page UPDATE; failure-injection resume tests | closed |
| T-13-13-03 | Repudiation | Evidence destroyed by over-aggressive scrub | high | mitigate | Rewrite-only (UPDATE, no DELETE); type/occurred_at/received_at untouched | closed |
| T-13-13-04 | Repudiation | Failed scrub indistinguishable from not-run | medium | mitigate | `status = 'failed', scrub_error` persisted (`erasure-scrub.worker.ts:399`) | closed |
| T-13-13-05 | DoS | Unbounded UPDATE over partitioned table | medium | mitigate | `ERASURE_SCRUB_PAGE_LIMIT = 500`; keyset pagination | closed |
| T-13-13-06 | Info Disclosure | Denylist can't cover tenant key space | high | mitigate | Allowlist replaces denylist; tenant-invented-key + nested-object tests | closed |
| T-13-13-07 | Repudiation | Under-reported counts on resumed scrub | low | mitigate | Resume tests assert no skip/double-report across interruption | closed |

### 13-14 — as-built documentation

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-14-01 | Repudiation | Undocumented tables/queues/routes | high | mitigate | All 13 phase-13 objects present in SPECIFICATION.md | closed |
| T-13-14-02 | Repudiation | Aspirational docs describing unbuilt behavior | high | mitigate | 10 explicit not-implemented / «не определено» markers | closed |
| T-13-14-03 | Repudiation | Two docs stating day-semantics differently | medium | mitigate | ARCHITECTURE.md:230 and rollup schema agree on `sends.sent_at`; verify gate exit 0 | closed |
| T-13-14-04 | Repudiation | Undecided capability hole in coverage matrix | medium | mitigate | Coverage gate re-run: 8 opt-outs, all with reasons, exit 0 | closed |
| T-13-14-05 | Info Disclosure | Real tenant data in doc examples | low | mitigate | Zero email addresses in SPECIFICATION.md / ARCHITECTURE.md (regex scan) | closed |

### 13-15 — erasure scrub reclaimer

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-15-01 | Repudiation | Committed erasure, scrub never queued, unnoticed | high | mitigate | Pending-past-lease disjunct (`erasure-scrub-reclaim.worker.ts:151`); enqueue-crash test | closed |
| T-13-15-02 | Repudiation | Erasure stranded mid-scrub by worker death | high | mitigate | `status='scrubbing' AND scrub_started_at < now() - lease` (`:152`) | closed |
| T-13-15-03 | DoS | Duplicate scrubs (reclaim racing live job) | medium | mitigate | Shared `buildErasureScrubJobId` from both producers | closed |
| T-13-15-04 | DoS | Healthy scrub reclaimed underneath itself | medium | mitigate | 15-min lease keyed off `scrub_started_at` | closed |
| T-13-15-05 | Info Disclosure | Widening cross-tenant read on compliance table | medium | mitigate | `0059:94-97` FORCE RLS, no scan grant; scan reads `organization` only | closed |
| T-13-15-06 | DoS | Mass reclaim flood after Redis outage | medium | mitigate | `ERASURE_SCRUB_RECLAIM_PAGE_LIMIT = 100` | closed |
| T-13-15-07 | DoS | Retry loop on genuinely failed scrub | low | mitigate | `failed` in neither disjunct — `scrub_error` never overwritten | closed |
| T-13-15-08 | Elev. of Privilege | Reclaimer doing more than re-enqueue | medium | mitigate | Test asserts no writes against contacts/suppressions/send_events/events | closed |

### 13-16 — quarantine retention (CMP-04 closure)

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-13-16-01 | Info Disclosure | Quarantine PII retained indefinitely | high | mitigate | `pruneSendEventQuarantine` + `SEND_EVENT_QUARANTINE_RETENTION_DAYS`; per-workspace tick | closed |
| T-13-16-02 | Tampering | Provider timestamp influencing PII disposal | high | mitigate | Predicate names only server-set `received_at`; ancient-candidate-survives test | closed |
| T-13-16-03 | DoS | Unbounded DELETE in per-workspace tick | medium | accept | Mirrors `pruneIngressJournal` precedent; page-limit trigger documented in doc comment | closed (accepted) |
| T-13-16-04 | Info Disclosure | Cross-tenant reach in retention path | medium | mitigate | Prune inside `withTenant`; fail-closed policy; two-workspace test | closed |
| T-13-16-05 | Repudiation | Silent retention (unobservable disposal) | low | mitigate | `quarantineRowsPruned` own log field via `scrubbedConsole` | closed |
| T-13-16-06 | Tampering | Docs drift on self-pruning behavior | medium | mitigate | Code, SPECIFICATION.md, and ARCHITECTURE.md:247 agree | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-13-01 | T-13-01-03 | Journal replay re-enqueues an idempotently-deduped job; no side effects beyond a legitimate SendGrid retry | plan register (13-01) | 2026-08-12 |
| AR-13-02 | T-13-01-04 | Fail-closed 5xx on journal failure is the intended trade; SendGrid ~24h retry recovers | plan register (13-01) | 2026-08-12 |
| AR-13-03 | T-13-01-10 | Tombstones are payload-free; accumulation tracks failure rate | plan register (13-01) | 2026-08-12 |
| AR-13-04 | T-13-02-03 | Reconciler scan-role enumeration unchanged from pre-existing pattern | plan register (13-02) | 2026-08-12 |
| AR-13-05 | T-13-03-02 | Progress read resolves workspace and reads inside `withTenant` | plan register (13-03) | 2026-08-12 |
| AR-13-06 | T-13-05-05 | Dirty-day query already inside `withTenant` | plan register (13-05) | 2026-08-12 |
| AR-13-07 | T-13-07-06 | 1-second provider timestamp granularity may merge distinct rapid repeats; pinned by test | plan register (13-07) | 2026-08-12 |
| AR-13-08 | T-13-07-07 | Orphan events drive zero counters; not deduping among themselves is harmless | plan register (13-07) | 2026-08-12 |
| AR-13-09 | T-13-07-08 | Rolling-deploy ingestion gap avoided by ROADMAP R-05 stop-old-then-start-new | plan register (13-07) | 2026-08-12 |
| AR-13-10 | T-13-07-09 | Index-build write lock contends with nothing — worker stopped for migration window | plan register (13-07) | 2026-08-12 |
| AR-13-11 | T-13-08-05 | HMAC token binds sendId/contactId/workspaceId; lookup inside `withTenant` | plan register (13-08) | 2026-08-12 |
| AR-13-12 | T-13-09-03 | `reputation_alert_state` is platform-job-only, follows existing no-RLS precedent tables | plan register (13-09) | 2026-08-12 |
| AR-13-13 | T-13-09-06 | Hourly scan cost bounded per workspace; ratio is slow-moving | plan register (13-09) | 2026-08-12 |
| AR-13-14 | T-13-10-07 | Contacts deleted before this phase left no evidence trail to backfill | plan register (13-10) | 2026-08-12 |
| AR-13-15 | T-13-16-03 | Single-statement quarantine DELETE mirrors larger `pruneIngressJournal` precedent; page-limit trigger documented | plan register (13-16) | 2026-08-12 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-12 | 122 | 122 | 0 | gsd-security-auditor (opus, ASVS L1, block_on high) |

**Audit notes (2026-08-12):** Supply-chain rows verified via lockfile diff (zero new registry packages). Non-blocking observation: 11 of 16 SUMMARYs carry no `## Threat Flags` section (no executor attestation either way); each register row was verified directly against code and migrations instead — executor-template gap, not a security gap.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-12
