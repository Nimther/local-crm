---
phase: 9
slug: partition-automation-boundary-safety
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-07
---

# Phase 9 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| worker process → Postgres | Maintenance job issues DDL with app-constructed identifiers that cannot be parameterised | SQL identifiers, date bounds |
| Postgres → apps/api watchdog | Only shared state between watched process and watcher; a wrong read is a silent dead-man's switch | partition health row |
| apps/api watchdog → SendGrid (platform account) | Outbound channel to a human operator, outside every tenant boundary | alert email body |
| DEFAULT partition ← untrusted `occurred_at` | Provider-supplied timestamp (unvalidated until Phase 13 / CMP-05) decides month routing | event timestamps |
| Redis → worker processor | Scheduler state controls how often DDL runs against the live database | job schedule |
| env file → apps/api boot | Operator address enters the process from an externally-resolved file | `OPERATOR_ALERT_EMAIL` |
| test fixture → every ephemeral database | Fixture now issues DDL reaching every database-touching suite | partition DDL |
| operator shell → live partitioned data | Operator-invoked script performs `DELETE`/`INSERT` on tenant-scoped tables | `events` / `send_events` rows |
| freestanding child → parent | Between create and attach, child carries `workspace_id` and inherits no RLS | tenant-scoped rows |
| documentation → security review | `SPECIFICATION.md` omissions are unreviewed surface | as-built system description |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-09-01 | Tampering | `ensure-partitions.ts` identifier construction | high | mitigate | Identifiers built only from `Date` arithmetic against frozen `PARTITIONED_TABLES` allowlist; DML bounds parameterised (`packages/db/src/partitions/ensure-partitions.ts`, `maintenance-run.ts`) | closed |
| T-09-02 | Information Disclosure | freestanding partition table between create and attach | high | mitigate | create → NOT VALID → VALIDATE → ATTACH in one transaction per month; tests assert zero `relispartition = false` relations after every run | closed |
| T-09-03 | Information Disclosure | operator alert email body | medium | mitigate | `renderOperatorAlertText` (apps/api/src/modules/ops/partition-watchdog.ts) emits only table names, month strings, counts, timestamps; negative-assertion test; confirmed against a real delivery in UAT test 1 | closed |
| T-09-04 | Spoofing | credential used for the platform alert | high | mitigate | Watchdog reads only `PLATFORM_SENDGRID_API_KEY`/`PLATFORM_MAIL_FROM` via `platform-mail/client.ts`; no tenancy/KMS imports | closed |
| T-09-05 | Denial of Service | watchdog poll cadence vs. alert cadence | medium | mitigate | Atomic `last_alert_sent_at` claim (conditional `UPDATE ... RETURNING`, 20h window) in partition-watchdog.ts, incl. CR-02 claim-before-send fix | closed |
| T-09-06 | Denial of Service | `ATTACH PARTITION` against non-empty DEFAULT | high | mitigate | `attachPartitionCheckFirst` applied unconditionally on every attach | closed |
| T-09-07 | Repudiation | maintenance run that failed but looks healthy | high | mitigate | `evaluatePartitionHealth` treats absent/unreadable health row as unhealthy; no internal try/catch in `runPartitionMaintenance` | closed |
| T-09-08 | Denial of Service | duplicate job schedulers | medium | mitigate | Stable id `partition-maintenance-daily` via `upsertJobScheduler` (apps/worker/src/queues/partition-maintenance.worker.ts); idempotency test | closed |
| T-09-09 | Repudiation | swallowed maintenance failure | high | mitigate | No try/catch in processor callback, `removeOnFail: false`; failure leaves health row stale → watchdog email | closed |
| T-09-10 | Information Disclosure | real SendGrid dispatch reachable from tests | medium | mitigate | Watchdog interval started only in `main()` under direct-run guard, never in `buildServer()` | closed |
| T-09-11 | Information Disclosure | boot log lines | low | mitigate | Boot line names only interval and threshold numbers | closed |
| T-09-12 | Tampering | alert channel silently unconfigured | high | mitigate | `OPERATOR_ALERT_EMAIL` required, no default, in zod schema (apps/api/src/env.ts:27) and hard-fail in scripts/check-env.mjs | closed |
| T-09-13 | Denial of Service | concurrent vitest workers racing on `CREATE TABLE` | medium | mitigate | `ensurePartitions` runs inside session-scoped advisory lock in db-fixture migration path (packages/test-support/src/db-fixture.ts) | closed |
| T-09-14 | Information Disclosure | orphaned freestanding partition table in test DB | medium | mitigate | Zero-`relispartition = false` assertion after every fixture call; per-month transaction from 09-01 | closed |
| T-09-15 | Repudiation | fixture silently proceeding without partitions | high | mitigate | No try/catch around fixture's `ensurePartitions` call; failure fails the whole run | closed |
| T-09-16 | Tampering | fixture reaching the developer's dev database | high | accept | Already mitigated by Phase 8 two-layer fail-closed DSN guard (`assertTestDatabaseUrl`); this phase adds no new DSN resolution — see Accepted Risks | closed |
| T-09-17 | Tampering | partition identifiers from discovery-query output | high | mitigate | Discovered months pass through `monthPartitionName` `Date` helper; no query result interpolated into identifiers (packages/db/src/partitions/relocate-default.ts) | closed |
| T-09-18 | Denial of Service | unbounded partition creation from wildly-varying `occurred_at` | medium | accept | Bounding `occurred_at` at ingestion is Phase 13 / CMP-05; partition-per-discovered-month accepted per D-09, recorded in runbook — see Accepted Risks | closed |
| T-09-19 | Information Disclosure | freestanding destination table before attach | high | mitigate | `relocateMonth` finishes via transactional `attachPartitionCheckFirst`; zero-freestanding assertions in tests | closed |
| T-09-20 | Information Disclosure | CLI output | medium | mitigate | Entrypoint prints resolved database name only; report carries table names, months, counts (packages/db/scripts/relocate-default-partition-rows.ts) | closed |
| T-09-21 | Denial of Service | long exclusive lock on live parent | high | mitigate | `RELOCATE_BATCH_SIZE`-bounded batches, one transaction each; NOT VALID → VALIDATE (SHARE UPDATE EXCLUSIVE) → scan-free ATTACH | closed |
| T-09-22 | Elevation of Privilege | relocation running unattended | high | mitigate | Core module constructs no scheduler/worker/interval; CLI referenced only by manual npm scripts (`relocate:default-partition-rows`), per D-08 | closed |
| T-09-23 | Repudiation | partial relocation run reported as success | medium | mitigate | CLI exits non-zero on residual DEFAULT count > 0; runbook instructs re-run until zero | closed |
| T-09-24 | Repudiation | unrecorded new surface in SPECIFICATION.md | high | mitigate | Section-by-section obligations enumerated as acceptance criteria in 09-05; `tsx` version assertion automated | closed |
| T-09-25 | Information Disclosure | documenting a secret's value | high | mitigate | Section 3 records variable name/reader/validation/location only; no credential value written; no new key material | closed |
| T-09-26 | Information Disclosure | the live confirmation email | medium | mitigate | UAT test 1 (passed 2026-08-07) confirmed delivered body contains no workspace id, contact identifier, event payload, or connection string | closed |
| T-09-27 | Repudiation | declaring deadline closed on automation alone | high | mitigate | Gate asserts ten attached partitions per table in a migrated database (journal-driven, not fixture-driven) | closed |
| T-09-28 | Repudiation | dead-man's switch never observed firing | high | mitigate | Live confirmation required and performed: UAT test 1 passed with a real delivered alert | closed |
| T-09-SC | Tampering | npm/pip/cargo installs (all five plans) | high | mitigate | No third-party package added; `@sendgrid/mail@8.1.6` reused (verdict OK); `tsx` added at range already pinned by apps/api & apps/worker; lockfile introduced no new registry entry | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| R-09-01 | T-09-16 | Fixture-reaches-dev-DB risk unchanged by this phase; Phase 8's two-layer fail-closed DSN guard (`assertTestDatabaseUrl` in `global-setup.ts` and `db-fixture.ts`, no dev-DSN fallback) remains the control. This phase adds DDL to an already-guarded path and introduces no new DSN resolution. | plan 09-03 (plan-time disposition) | 2026-08-07 |
| R-09-02 | T-09-18 | A writer pushing events with many distinct far-apart months causes one partition per distinct month. Bounding `occurred_at` at ingestion is Phase 13 / CMP-05 and out of this phase's scope; D-09 accepts partition-per-discovered-month as correct for now. Recorded in the relocation runbook as a known boundary. | plan 09-04 (plan-time disposition) | 2026-08-07 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-07 | 29 | 29 | 0 | /gsd-secure-phase (L1 grep-depth, plan-time register, short-circuit) |
| 2026-08-07 | 29 | 29 | 0 | /gsd-secure-phase (L1 re-audit against post-review code incl. WR-01 migration-deadline guard and WR-02 relocate advisory lock; all mitigations re-verified in place, short-circuit) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-07
