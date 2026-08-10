---
phase: 12
slug: worker-reliability-tenant-fairness
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-10
---

# Phase 12 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| BullMQ job lock (Redis) → worker processor | Job token is the lock credential; mishandling lets two processors own one job | job lock tokens |
| tenant A's job → shared worker process | One tenant's throttling state must not become a platform-wide control signal | tenant send state |
| worker process → Redis (connections, semaphore keys) | Connection options and semaphore/cap state resolve from shared modules; unavailability must not silently disable caps | Redis credentials, semaphore lease state |
| tenant A's slot holders → tenant B's available slots | Cross-tenant fairness boundary the lane semaphore exists to enforce | per-tenant slot counts |
| dispatch path → Redis semaphore / dispatch claim (Postgres) | A call that skips the semaphore dispatches uncapped; a deferral that forgets the claim strands a send row | send dispatch claims |
| test harness → SendGrid | A scenario that accidentally constructs a real transport would send live mail from CI | provider API keys (fake only) |
| cross-workspace discovery scan → per-tenant work | Scan role sees every tenant's flows; everything after discovery drops back to tenant scope | flow metadata, sweep cursors |
| job payload → durable Postgres record | Payloads carry contact data and provider credentials; persisting verbatim would create a new exposure surface | contact PII, provider credentials (redacted) |
| worker event listener → process | A listener exception is an unhandled rejection that kills every worker in the process | — |
| container runtime signal → worker process | A grace period shorter than worst-case in-flight dispatch converts a deploy into a data-ambiguity event | in-flight send state |
| Redis failed set → durable record | Once retention is bounded, the Postgres record is the only lasting evidence of a terminal failure | failure metadata |
| dead-letter record → operator mail | Alert content leaves the system; anything it carries is exposed to the operator mailbox | counts/queue names only |
| application process → Redis (producer queues) | Producer queues resolve options from the same module as the worker; drift would desync policy | queue configuration |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-12-01-01 | Denial of Service | `handleEmailBroadcastJob` / `handleEmailTriggeredJob` | high | mitigate | Tenant-scoped rejection routes through `deferForTenantBucket` (per-job `moveToDelayed`), never BullMQ's global-per-worker limiter — `apps/worker/src/queues/tenant-deferral.ts`, asserted by two-workspace case in `apps/worker/src/queues/__tests__/tenant-deferral.test.ts` | closed |
| T-12-01-02 | Tampering | BullMQ job lock | medium | mitigate | `deferForTenantBucket` requires the processor-supplied token, throws before touching the job when absent; `never` return type forbids a second resolution path | closed |
| T-12-01-03 | Repudiation | provider-backoff path | low | accept | Failure still lands in the failed set with its error; dead-letter path (12-07) makes terminal failures durable | closed |
| T-12-02-01 | Denial of Service | retention collapsed into one shape | high | mitigate | Factory requires retention typed to the two known shapes (`packages/queue-core/src/index.ts`), preserving flow-run-advance's completion policy; expect-error test guards ad-hoc shapes | closed |
| T-12-02-02 | Tampering | deliberately divergent application-side Redis client | medium | mitigate | Client explicitly excluded from consolidation, named as a non-target; not a BullMQ connection, divergence documented inline | closed |
| T-12-02-03 | Information Disclosure | Redis credentials in the moved builder | low | accept | Builder parses credentials from the process's own environment exactly as before; relocation changes no exposure surface, adds no logging | closed |
| T-12-03-01 | Denial of Service | leaked semaphore slot after worker crash | high | mitigate | Per-holder lease scores + `zremrangebyscore` purge on every acquire; un-released holder stops counting after `SEND_SLOT_LEASE_TTL_MS` — `apps/worker/src/queues/tenant-lane-semaphore.ts`, lease-expiry test case | closed |
| T-12-03-02 | Denial of Service | one tenant saturating a lane | high | mitigate | Cap keyed on tenant and lane; holders can never exceed configured share nor consume the other lane's slots — isolation cases in `tenant-lane-semaphore.test.ts` / `tenant-concurrency-cap.test.ts` | closed |
| T-12-03-03 | Tampering | malformed lane-cap environment override | medium | mitigate | `resolveTenantLaneCap` accepts only a positive integer, otherwise falls back to versioned default with a warning | closed |
| T-12-03-04 | Spoofing | release of a slot the caller does not hold | low | mitigate | Release removes the caller's own randomly generated token only; unheld token is a no-op | closed |
| T-12-04-01 | Denial of Service | over-cap send stranding its dispatch claim | high | mitigate | Over-cap path releases the dispatch claim exactly as the rate-limited path does before returning — `apps/worker/src/queues/send-dispatch.ts`, campaign and flow deferral cases | closed |
| T-12-04-02 | Denial of Service | slot never released after an unusual exit | high | mitigate | Release sits in a `finally` spanning every return of each dispatch branch (success, provider-rejection, 4xx, thrown-`sendMail`, RPS-deferral); lease expiry (12-03) is the crash-time backstop — five release-path cases | closed |
| T-12-04-03 | Elevation of Privilege | lane derived from caller-supplied data | medium | mitigate | Lane derived from validated job kind by `laneForSendJobKind`, never passed as a separate argument | closed |
| T-12-04-04 | Information Disclosure | semaphore keys embedding a workspace id | low | accept | Redis keys already embed workspace id for the RPS bucket; no new identifier class, Redis is not a tenant-reachable surface | closed |
| T-12-05-01 | Spoofing | scenario reaching the real provider | high | mitigate | Both variants inject the fake `ProcessSendJobDeps.sendMail` seam; CI scenario asserts no real transport constructed — `apps/worker/src/queues/__tests__/failure-injection/tenant-fairness.test.ts` | closed |
| T-12-05-02 | Denial of Service | vacuously passing fairness assertion | high | mitigate | Scenario asserts tenant A actually received tenant-scoped deferrals during the contended phase | closed |
| T-12-05-03 | Repudiation | unsourced RPS default | medium | mitigate | Constant's rationale records provider figure, source URL, retrieval date — `apps/worker/src/test/fairness-constants.ts`, `tenant-rps-sustained.test.ts` | closed |
| T-12-05-04 | Information Disclosure | tenant identifiers in scenario output | low | accept | Scenario fixtures use generated workspace ids only; no production tenant data enters CI | closed |
| T-12-06-01 | Elevation of Privilege | sweep discovery scan | high | mitigate | `findLiveSegmentTriggeredFlows` unchanged: dedicated scan role with narrowed select-only policy; checkpoint table grants scan role nothing — `packages/db/migrations/0053_flow_segment_sweep_checkpoint.sql:24` | closed |
| T-12-06-02 | Denial of Service | unbounded per-flow query | high | mitigate | Pages limited to `SWEEP_PAGE_SIZE` under per-page statement timeout; stale-snapshot cleanup deletes in bounded batches; job bounded by `SWEEP_FLOW_JOB_BUDGET_MS` — `apps/worker/src/queues/flows/flow-segment-sweep-flow.worker.ts` | closed |
| T-12-06-03 | Tampering | walk job payload | medium | mitigate | Both payloads validated against zod schema with literal version field; unrecognised version defers | closed |
| T-12-06-04 | Information Disclosure | checkpoint rows across tenants | high | mitigate | `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` with fail-closed workspace predicate — `0053_flow_segment_sweep_checkpoint.sql:41-44` | closed |
| T-12-06-05 | Repudiation | silently skipped contact | medium | mitigate | Cursor resets on walk completion; scenario asserts a contact inserted behind the old cursor is enrolled by the following walk — `segment-sweep-kill-resume.test.ts` | closed |
| T-12-07-01 | Information Disclosure | dead-letter payload snapshot | high | mitigate | Every snapshot passes through `scrub` before insert — `packages/queue-core/src/dead-letter-writer.ts:78`; writer test asserts email, provider API key and bearer token are censored | closed |
| T-12-07-02 | Denial of Service | listener or writer exception | high | mitigate | Writer catches and logs DB errors (`dead-letter-writer.ts:99`); listener catches hook rejections (`error-listeners.ts:61`); neither can become the unhandled rejection that kills the worker | closed |
| T-12-07-03 | Elevation of Privilege | scan-role access to dead-letter table | medium | mitigate | Migration grants `mega_crm_scan` no privileges on either new table; header comment records platform scope, no tenant-facing read path — `0054_dead_letter_jobs.sql:18-30` | closed |
| T-12-07-04 | Repudiation | duplicate or missing terminal records | medium | mitigate | `UNIQUE (queue_name, job_id)` + `ON CONFLICT DO UPDATE` make repeated terminal writes idempotent — `0054_dead_letter_jobs.sql:45`, `dead-letter-writer.ts:83`; terminal gate keeps mid-retry failures out | closed |
| T-12-08-01 | Denial of Service | leaked Redis connections after shutdown | high | mitigate | Every long-lived handle registers with the tracked-queue registry (`apps/worker/src/queues/queue-registry.ts`); shutdown closes all after the workers — zero-open-handles check in `graceful-shutdown.test.ts` | closed |
| T-12-08-02 | Denial of Service | registration failure crashing the process | high | mitigate | All three migrated registrations run inside a guard that logs and swallows, matching the two existing precedents; rejecting-registration test asserts nothing escapes | closed |
| T-12-08-03 | Repudiation | silent worker failures | high | mitigate | Both listener kinds attached across the exhaustive worker registry; terminal failures reach the durable dead-letter record; test iterates the whole registry | closed |
| T-12-08-04 | Denial of Service | duplicate tick execution under multi-instance deployment | medium | accept | Execution exclusivity out of scope for this milestone; constraint documented in architecture notes with what a future multi-instance move must add. Flagged assumption A-1 | closed |
| T-12-08-05 | Tampering | in-flight job killed mid-dispatch by short grace period | high | mitigate | Drain budget derived from provider timeout + both transaction margins + explicit safety margin; published for the deployment phase as container stop-grace period | closed |
| T-12-09-01 | Repudiation | terminal failure aging out before it is recorded | high | mitigate | Plan carries a precondition halting if listener coverage test fails; invariant header comment records the ordering — `failed-job-retention.test.ts` | closed |
| T-12-09-02 | Denial of Service | unbounded Redis growth from retained failures | high | mitigate | Standard retention is an age bound in days applied to every queue using the shared shape; asserted at constant level by the invariant test | closed |
| T-12-09-03 | Tampering | differentiated queue policy erased by consolidation | high | mitigate | Flow-run-advance constant untouched; explicit case asserts both of its retention fields differ from the standard constant's | closed |
| T-12-10-01 | Information Disclosure | alert body | medium | mitigate | Alert carries only counts, queue names and a timestamp — never a payload field — `apps/api/src/modules/ops/dead-letter-watchdog.ts`, alert-body criterion in its test | closed |
| T-12-10-02 | Denial of Service | alert flooding the operator mailbox | medium | mitigate | Atomic single-statement claim on `dead_letter_alert_state` + dedup window bound alerts to one per window; failed send releases the claim | closed |
| T-12-10-03 | Repudiation | terminal failures nobody sees | high | mitigate | End-to-end case proves an exhausted job produces a durable row the watchdog surfaces — `dead-letter-watchdog.test.ts` | closed |
| T-12-10-04 | Elevation of Privilege | application process reading a platform table | low | accept | Watchdog reads platform-scoped dead-letter tables through the application's ordinary connection, as the two existing watchdogs do; no cross-tenant credential, scan role granted nothing | closed |
| T-12-11-01 | Tampering | queue configuration drift between the two processes | medium | mitigate | Both processes import connection and job options from one module (`packages/queue-core`); invariant test fails if a local copy reappears — `send-timing-invariant.test.ts` | closed |
| T-12-11-02 | Denial of Service | deliberately divergent non-BullMQ client collapsed into shared builder | medium | mitigate | Client excluded from the guarded set with an inline comment stating why; acceptance criteria assert the file unchanged | closed |
| T-12-11-03 | Information Disclosure | Redis credentials in the repointed modules | low | accept | Credentials continue to come from the process's validated environment, passed to BullMQ exactly as before; no new logging or exposure | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-12-01 | T-12-01-03 | Provider-backoff failure lands in the failed set with its error message; the dead-letter path (12-07) is where terminal failures become durable — no additional audit record needed in the deferral plan | plan-time disposition (12-01) | 2026-08-10 |
| AR-12-02 | T-12-02-03 | Relocating the Redis options builder changes no exposure surface: credentials still parsed from the process environment, no logging added | plan-time disposition (12-02) | 2026-08-10 |
| AR-12-03 | T-12-04-04 | Redis keys already embed workspace ids for the RPS bucket; the semaphore adds no new identifier class and Redis is not tenant-reachable | plan-time disposition (12-04) | 2026-08-10 |
| AR-12-04 | T-12-05-04 | Scenario fixtures use generated workspace ids only; no production tenant data enters CI | plan-time disposition (12-05) | 2026-08-10 |
| AR-12-05 | T-12-08-04 | Duplicate tick execution under a multi-instance deployment: execution exclusivity is out of scope for this milestone. Accepted with the constraint documented explicitly in the architecture notes, including what a future multi-instance move would have to add. Recorded as flagged assumption A-1 | plan-time disposition (12-08) | 2026-08-10 |
| AR-12-06 | T-12-10-04 | Watchdog reads the platform-scoped dead-letter tables through the application's ordinary connection, exactly as the two existing watchdogs read their health tables; no cross-tenant credential involved | plan-time disposition (12-10) | 2026-08-10 |
| AR-12-07 | T-12-11-03 | Credentials continue to come from the process's validated environment and are passed to BullMQ exactly as before; no new logging or exposure introduced | plan-time disposition (12-11) | 2026-08-10 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-10 | 40 | 40 | 0 | /gsd-secure-phase (L1 grep-depth, short-circuit: register authored at plan time, asvs_level 1) |

Notes: threat register built from `<threat_model>` blocks in all 11 PLAN files (all parseable — `register_authored_at_plan_time: true`). SUMMARY threat-flag sections reviewed across all 11 summaries; only 12-10 carried a section and it added nothing beyond the plan register. Mitigation anchors verified at grep level with spot-checks on the highest-severity claims: RLS enable+force on `flow_segment_sweep_checkpoint` (0053), scan-role zero grants and platform-scope comments on `dead_letter_jobs` (0054), `scrub` before dead-letter insert, writer/listener catch paths, and the `(queue_name, job_id)` idempotency constraint.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-10
