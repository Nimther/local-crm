---
phase: 22
slug: workspace-quiesce-physical-purge
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-24
---

# Phase 22 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

All 12 plans (22-01 … 22-12) shipped plan-time `<threat_model>` registers (register_authored_at_plan_time: true). Classification ran at ASVS L1 grep depth against the implementation, backed by the passing 22-VERIFICATION.md (5/5), 22-VALIDATION.md, and per-plan SUMMARY threat-flag closures.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| purge worker → Postgres tenant tables | Destructive DML scoped by explicit `workspace_id` with RLS underneath | All tenant PII (contacts, events, sends) |
| purge worker → `organization` (platform table, no RLS) | Cross-tenant enumeration + tombstone UPDATE only | Workspace identity/state |
| purge worker → `mega_crm_auth` credential | Elevated second DB identity held by a background process | Better Auth membership rows |
| purge → surviving evidence set (`purge_records`, suppression, etc.) | The line between "PII destroyed" and "compliance record lost" | PII-free census/audit data |
| purge → tenant secrets (KMS-wrapped) | Destroys stored ciphertext + DEK incl. per-workspace HMAC key | Tenant SendGrid credential material |
| BullMQ queue → send dispatcher / ingest processors | Job payloads assert stale workspace state | Send/ingest payloads |
| send dispatcher → SendGrid (tenant account) | Point of no recall; all quiesce gates close before it | Outbound mail |
| untrusted client → events/contacts API (API key) | Key outlives the workspace's right to accept data | Inbound tenant PII |
| anonymous internet → SendGrid webhook route (`:pathToken`) | Unauthenticated until signature check; response differences are an oracle | Delivery events |
| `mega_crm_scan` role → tenant tables | Cross-tenant scan role; policy predicates are the whole boundary | Campaign/flow scan reads |
| operator shell → production database (restore CLI) | Un-deletes a tenant with full app credentials, no own auth | Workspace lifecycle state |
| purge worker → API watchdog (`purge_records` channel) | Two-process dead-man's switch, no shared memory | Purge progress metadata |
| alert text → operator mailbox | Content leaves platform storage into mail | IDs/statuses/timestamps only |
| tenant job payload → `dead_letter_jobs.payload` | Untrusted freeform data on terminal failure; `scrub()` is partial | Possibly-PII payloads (bounded retention) |
| documentation → security reviewer / operator under pressure | Overstated claims are false assurance; wrong runbook step causes damage | Claims, not data |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-22-01-01 | Tampering | `tombstoneOrganization` / org-row statements | critical | mitigate | Tombstone by UPDATE only; grep-verified zero `DELETE FROM organization` across all purge sources | closed |
| T-22-01-02 | Tampering | `deletePurgeBatch` table identifier | high | mitigate | Identifiers only from frozen `PURGE_TABLE_SPECS`, never caller strings | closed |
| T-22-01-03 | DoS (self-inflicted) | unbounded delete / long lock | high | mitigate | 500-row pages, `FOR UPDATE SKIP LOCKED`, one txn/page, per-workspace advisory lock (grep-verified) | closed |
| T-22-01-04 | Info Disclosure | purge_records + log lines | high | mitigate | IDs/timestamps/counts only; D-09 scrub replaces name/slug | closed |
| T-22-01-05 | Tampering | purge destroys restored tenant's data | critical | mitigate | Per-batch `deletedAt` re-read in-txn, `WorkspaceRestoredError` refusal, shared advisory lock (grep-verified) | closed |
| T-22-01-06 | Repudiation | no record of destruction | medium | mitigate | D-10 `purge_records` census + point-of-no-return + completion timestamps | closed |
| T-22-01-07 | EoP | RLS-free `purge_records` | medium | accept | Role-identity boundary precedent; no tenant PII held | closed |
| T-22-01-SC | Tampering | package installs | low | accept | No new packages (Package Legitimacy Audit) | closed |
| T-22-02-01 | Tampering | in-flight job dispatched after soft delete | high | mitigate | `isWorkspaceSoftDeleted` re-read at dispatch on all three paths (grep-verified in send-dispatch + workers) | closed |
| T-22-02-02 | Repudiation | refused send leaves no trace | medium | mitigate | D-03 excluded send fact `workspace_deleted`; structured refusal log on test-send path | closed |
| T-22-02-03 | EoP | lookup failure = permission to send | high | mitigate | Fail-closed: missing org row returns refuse; tested | closed |
| T-22-02-04 | DoS (self-inflicted) | per-contact lookup in broadcast loop | medium | mitigate | Lookup per job; kickoff guard stops fan-out at top | closed |
| T-22-02-05 | Tampering | quiesce mutating tenant state | medium | mitigate | D-02 freeze-never-cancel; byte-identical state test | closed |
| T-22-02-SC | Tampering | package installs | low | accept | No new packages | closed |
| T-22-03-01 | Tampering | new PII into workspace awaiting purge | high | mitigate | Fail-closed check in `apiKeyAuth`, webhook route, both ingest processors (grep-verified) | closed |
| T-22-03-02 | Info Disclosure | webhook 404 oracle | high | mitigate | Deleted branch returns identical bare 404 as unknown-token; response-equality test | closed |
| T-22-03-03 | Spoofing | quiesce check touching body pre-signature | high | mitigate | Check consumes only `endpoint.workspaceId`; no body read/parse reorder | closed |
| T-22-03-04 | EoP | unresolvable workspace treated as live | medium | mitigate | Missing org row → refuse, mirrors worker-side rule | closed |
| T-22-03-05 | DoS | extra lookup per authed request | low | accept | Single indexed PK read per request | closed |
| T-22-03-SC | Tampering | package installs | low | accept | No new packages | closed |
| T-22-04-01 | Tampering | `flow_runs_scan` gap mutates frozen tenant | high | mitigate | Migration 0070 patches third policy; unchanged-flow-run test | closed |
| T-22-04-02 | Tampering | scheduler enqueues mail for deleted workspace | high | mitigate | `campaigns_scan` predicate + independent 22-02 dispatch gate | closed |
| T-22-04-03 | EoP | widening `mega_crm_scan` grants | medium | mitigate | No GRANT added; zero-count grep | closed |
| T-22-04-04 | Tampering | evidence-row timestamp churn | low | mitigate | `findLiveWorkspaceIds` narrowing; byte-identical rollup test | closed |
| T-22-04-05 | DoS | policy subquery per scan read | low | accept | `NOT EXISTS` on PK per bounded candidate row | closed |
| T-22-04-SC | Tampering | package installs | low | accept | No new packages | closed |
| T-22-05-01 | Tampering | partition op removing neighbour rows | critical | mitigate | Only bounded row-level batched DELETE; neighbour full-content test + source scan | closed |
| T-22-05-02 | Tampering | cascade from out-of-order delete | high | mitigate | FK order asserted by index-position tests on `PURGE_TABLE_ORDER` | closed |
| T-22-05-03 | DoS | purge blocking live tenant writes | high | mitigate | `SKIP LOCKED` batches; concurrent-neighbour-write test with statement timeout | closed |
| T-22-05-04 | Repudiation | compliance evidence destroyed | critical | mitigate | `PURGE_EVIDENCE_TABLES` asserted disjoint from deletion order; survival test | closed |
| T-22-05-05 | Info Disclosure | PII table missing from order | high | mitigate | PII-INVENTORY reconciliation test with vacuous-pass guard | closed |
| T-22-05-06 | Tampering | identifier injection into purge SQL | high | mitigate | Frozen `PURGE_TABLE_SPECS`; every-spec-resolves DB test | closed |
| T-22-05-07 | Info Disclosure | destroyed key leaves suppression re-testable | medium | mitigate | D-11 HMAC key row destroyed with secrets; two-sided suppression test | closed |
| T-22-05-SC | Tampering | package installs | low | accept | No new packages | closed |
| T-22-06-01 | Tampering | partially purged workspace restored live | critical | mitigate | Unconditional `first_destructive_batch_at` refusal (zero-count override grep) + shared advisory lock; both race directions tested | closed |
| T-22-06-02 | Tampering | overdue campaign blasts after restore | high | mitigate | D-15 same-transaction flip to `draft`, narrowed to past-due `scheduled` | closed |
| T-22-06-03 | EoP | tenant-reachable restore path | high | mitigate | Operator CLI only (`db:restore-workspace`); no route/permission/UI (verified) | closed |
| T-22-06-04 | Info Disclosure | operator report leaking tenant data | medium | mitigate | Sentinel-value absence test on formatted output | closed |
| T-22-06-05 | DoS | restore waiting on purge lock | low | accept | `pg_try_advisory_lock` never waits; immediate typed refusal | closed |
| T-22-06-06 | Repudiation | no restore record | low | accept | `purge_records` row kept as history; CLI summary printable | closed |
| T-22-06-SC | Tampering | package installs | low | accept | No new packages | closed |
| T-22-07-01 | EoP | widening `mega_crm_app` grants | high | mitigate | PT-01 option (b); no grant migration; 42501 test | closed |
| T-22-07-02 | EoP | elevated connection over-use | high | mitigate | `deleteWorkspaceAuthRows` exactly two statements/two tables in one txn; statement-count assert | closed |
| T-22-07-03 | Tampering | deleting global identity rows | high | mitigate | `user`/`session`/`account` never targeted; sole-workspace-user test | closed |
| T-22-07-04 | Tampering | deleting neighbour membership of shared user | high | mitigate | Both deletes scoped by organization id; shared-user test | closed |
| T-22-07-05 | Repudiation | success reported with membership left | high | mitigate | Auth failure marks record failed, skips tombstone, re-throws; three-consequence test | closed |
| T-22-07-06 | Info Disclosure | auth DSN in logs/errors | medium | mitigate | Error names variable only; pool via project factory redaction rules | closed |
| T-22-07-07 | DoS | leaked auth connections | low | mitigate | Memoised single pool, closed in shutdown, no-op when never created | closed |
| T-22-07-SC | Tampering | package installs | low | accept | No new packages | closed |
| T-22-08-01 | Repudiation | unattended purge failing silently | high | mitigate | Two-process dead-man's switch (`purge-watchdog.ts`, grep-verified); staleness + failure predicates tested | closed |
| T-22-08-02 | Info Disclosure | tenant data in alert mail | high | mitigate | IDs/statuses/timestamps/error/runbook only; sentinel-absence test | closed |
| T-22-08-03 | DoS | alert storm across replicas | medium | mitigate | Shared `ops_alert_state` claim + dedup window; two-replica test | closed |
| T-22-08-04 | Tampering | watchdog "fixing" purge state | medium | mitigate | Read-only over `purge_records`; comment-stripped write grep zero | closed |
| T-22-08-05 | Repudiation | alert without documented response | medium | mitigate | `check:runbook-coverage` asserted green from test suite | closed |
| T-22-08-06 | DoS | false positives eroding trust | medium | mitigate | Four healthy-state controls; threshold documented with tuning location | closed |
| T-22-08-SC | Tampering | package installs | low | accept | No new packages | closed |
| T-22-09-01 | Repudiation | evidence inflated by double-counted resume | high | mitigate | Deep-equal `table_counts` vs uninterrupted control + pre-destruction census | closed |
| T-22-09-02 | Tampering | rows silently skipped by resume | critical | mitigate | Every table asserted empty post-resume + post-kill unfinished-table assert | closed |
| T-22-09-03 | Repudiation | purge complete with tail unfinished | high | mitigate | Kill-before-tail: `purged_at` null, no tombstone, membership present; completion after resume | closed |
| T-22-09-04 | DoS | flaky failure-injection scenario | medium | mitigate | Signal/poll-driven kill points, control workspace, foreground-only runs | closed |
| T-22-09-SC | Tampering | package installs | low | accept | No new packages | closed |
| T-22-10-01 | Repudiation | overstated irreversibility claim | high | mitigate | PT-02 caveat in `backups.md` + specification pointer | closed |
| T-22-10-02 | Info Disclosure | secret value in committed doc | high | mitigate | Names/sources/purposes only; env-example line ends at `=` | closed |
| T-22-10-03 | Repudiation | evidence rows mistaken for incomplete purge | medium | mitigate | Runbook names all four evidence sets with D-10 reasons | closed |
| T-22-10-04 | Tampering | docs drifting from shipped code | medium | mitigate | Values read from code/SUMMARYs; `check:spec-env-coverage` mechanical | closed |
| T-22-10-05 | Repudiation | duplicated backup cadence drifting | low | mitigate | Pointer to pgBackRest config/crontab; zero-count restatement grep | closed |
| T-22-10-SC | Tampering | package installs | low | accept | No new packages | closed |
| T-22-11-01 | Tampering | `purge_records.table_counts` overwrite | high | mitigate | New jsonb as LEFT concat operand (recorded value wins); write-once unit + eighth kill case | closed |
| T-22-11-02 | Repudiation | destroyed-row census unprovable | high | mitigate | Counts captured on platform pool BEFORE destructive delete; real-SIGKILL regression | closed |
| T-22-11-03 | EoP | auth pool over-use for counts | high | mitigate | Count query on `mega_crm_app` pool under migration 0045 SELECT grant; two-statement assert kept | closed |
| T-22-11-04 | Info Disclosure | worker structured logs | low | mitigate | Drift warn carries workspaceId + four integers only | closed |
| T-22-11-05 | DoS | two extra count(*) per purge | low | accept | Once per purge on indexed small auth tables | closed |
| T-22-11-06 | Spoofing | test-only `afterAuthDelete` seam | medium | mitigate | Optional dep field, harness under `src/test/`, no non-test call site | closed |
| T-22-11-SC | Tampering | package installs | high | mitigate | Installs nothing; lockfile/migrations-clean acceptance criteria | closed |
| T-22-12-01 | Info Disclosure | `dead_letter_jobs.payload` retained indefinitely | high | mitigate | Bounded retention sweep on daily purge tick (`dead-letter-retention.ts`, grep-verified), boot-validated ≤ purge window | closed |
| T-22-12-02 | Info Disclosure | `scrub()` partial coverage | medium | accept | Bounded lifetime instead of unbounded partial redaction; recorded in PII inventory | closed |
| T-22-12-03 | Repudiation | "correct by design" vs "purge incomplete" | high | mitigate | Runbook survivor section reconciled; explicit Excluded row in PII inventory | closed |
| T-22-12-04 | DoS | unbounded DELETE on large table | medium | mitigate | PK-scoped 500-row batches, one statement each, `failed_at` index | closed |
| T-22-12-05 | Tampering | sweep touching wrong table | high | mitigate | Only `dead_letter_jobs` named; `dead_letter_alert_state` byte-identical test + grep criterion | closed |
| T-22-12-06 | DoS | swept row silences watchdog | low | accept | Watchdog alerts every tick for full retention window first; documented in runbook | closed |
| T-22-12-SC | Tampering | package installs | high | mitigate | Installs nothing; no dependency-table row added to SPECIFICATION.md | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| R-22-01 | T-22-01-07 | `purge_records` deliberately RLS-free on the role-identity-boundary precedent (`ops_alert_state`, `dead_letter_jobs`, `partition_maintenance_runs`); holds no tenant PII | plan 22-01 disposition | 2026-08-24 |
| R-22-02 | T-22-03-05, T-22-04-05, T-22-11-05 | Marginal per-request/per-tick DB reads on indexed PKs; no amplification | plan dispositions | 2026-08-24 |
| R-22-03 | T-22-06-05, T-22-06-06 | Non-waiting advisory lock refusal; `purge_records` row retained as restore history, no durable restore-audit table required by any PRG requirement | plan 22-06 disposition | 2026-08-24 |
| R-22-04 | T-22-12-02 | Widening `scrub()` to an unenumerable tenant-controlled key space rejected per PII-INVENTORY precedent; bounded retention supersedes partial redaction | plan 22-12 disposition | 2026-08-24 |
| R-22-05 | T-22-12-06 | Watchdog alerts for the full retention window before the row is swept; documented in runbook | plan 22-12 disposition | 2026-08-24 |
| R-22-06 | T-22-*-SC (low-severity rows) | No package-manager install task in phase; Package Legitimacy Audit records "no new packages introduced" | RESEARCH.md audit | 2026-08-24 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-24 | 79 | 79 | 0 | gsd-secure-phase (L1 short-circuit: plan-time registers, grep-verified mitigations, 22-VERIFICATION.md 5/5) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-24
