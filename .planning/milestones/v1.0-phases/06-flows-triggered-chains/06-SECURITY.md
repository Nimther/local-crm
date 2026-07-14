---
phase: 6
slug: flows-triggered-chains
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-07-14
---

# Phase 6 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

Register origin: authored at plan time — all 24 PLAN.md files carry a `<threat_model>` block. Verification depth: L1 (grep + passing automated tests recorded in 06-UAT.md coverage entries). SUMMARY threat flags: 06-14 and 06-15 both report "None" with rationale; no escalations.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| worker/API → Postgres | Every flow-table read/write crosses the RLS boundary; pooled connections can carry stale GUCs | Tenant flow/run/contact data (high) |
| client canvas → publish API | Untrusted node/edge JSON; server is the publish authority | Flow definitions (medium) |
| BullMQ redelivery → dispatch/advance | At-least-once delivery; DB claim is the only durable dedupe | Send jobs, wake nudges (high) |
| worker → SendGrid | Tenant BYO key; per-tenant RPS enforced in one place | Email + API keys (high) |
| cross-tenant discovery scan → per-tenant write | admin_scan SELECT-only; writes re-enter withTenant | Due-run candidates (high) |
| ingested event → run creation | Untrusted event name selects flow enrollment; concurrent duplicates possible | Events, run rows (medium) |
| client → contact/settings/CSV API | Untrusted IANA timezone strings flow into Intl at dispatch time | Timezone strings (medium) |
| npm registry → build | Canvas package supply chain (@xyflow/react) | Build artifacts (high) |
| schedule time vs dispatch time | Quiet-hours settings/timezone can change between scheduling and sending | Send timing (compliance) |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-06-01-01 | Information Disclosure | flow tables without RLS | high | mitigate | ENABLE+FORCE RLS + workspace_isolation on all 5 tables (0026); psql-verified (UAT 06-01-D1) | closed |
| T-06-01-02 | Denial of Service | bare ::uuid cast on empty GUC | high | mitigate | NULLIF-guarded policy in 0026; psql-verified (UAT 06-01-D1) | closed |
| T-06-01-03 | Elevation of Privilege | admin_scan permissive policy | medium | mitigate | flow_runs_due_scan SELECT-only; writes re-enter withTenant (UAT 06-05-D4) | closed |
| T-06-01-04 | Tampering | duplicate flow-step send on redelivery | high | mitigate | sends_flow_run_node_unique partial index; psql-verified (UAT 06-01-D3) | closed |
| T-06-02-01 | Tampering | client bypasses canvas validation | high | mitigate | validateFlowDefinition re-run server-side in publish tx (UAT 06-04-D2) | closed |
| T-06-02-02 | Input Validation | malformed definition persisted | medium | mitigate | flowDefinitionSchema Zod rejection (UAT 06-02-D1) | closed |
| T-06-03-01 | Tampering | duplicate send on redelivery | high | mitigate | claimFlowSend ON CONFLICT DO NOTHING; flow-send-idempotency.test.ts (UAT 06-03-D1) | closed |
| T-06-03-02 | Denial of Service | second rate limiter bypasses tenant RPS | high | mitigate | single consumeTenantToken bucket for all kinds (UAT 06-03-D2) | closed |
| T-06-03-03 | Repudiation | flow send skips pre-send gate | high | mitigate | same evaluatePreSendGate; excluded recorded (UAT 06-03-D4) | closed |
| T-06-03-04 | Information Disclosure | worker DB call without tenant context | medium | mitigate | withTenant/withTenantTransaction on all flow-send DB work (UAT 06-03-D3) | closed |
| T-06-04-01 | Elevation of Privilege | Member publishes/pauses via API | high | mitigate | requirePermission("flow","publish") on publish/pause/resume; flows.routes.ts:268-461 (UAT 06-04-D4) | closed |
| T-06-04-02 | Tampering | broken flow published | high | mitigate | server-side re-validation, 422 {fields} (UAT 06-04-D2) | closed |
| T-06-04-03 | Tampering | segment deleted under active flow | high | mitigate | restrict pre-check + 23503 → referenced_by_flow 409 (UAT 06-04-D5) | closed |
| T-06-04-04 | Information Disclosure | cross-tenant flow read | medium | mitigate | withTenantTransaction + forced RLS (UAT 06-04-D1) | closed |
| T-06-04-05 | Tampering | live-flow edit mutates in-flight version | high | mitigate | publish snapshots immutable version; draft lazy-recreated (UAT 06-04-D3) | closed |
| T-06-05-01 | Tampering | duplicate advance from redelivered nudge | high | mitigate | FOR UPDATE SKIP LOCKED + stale-nudge no-op + deterministic jobId (UAT 06-05-D1/D3) | closed |
| T-06-05-02 | Information Disclosure | admin-scan cross-tenant writes | high | mitigate | SELECT-only discovery; tenant-rescoped transitionAndNudge (UAT 06-05-D4) | closed |
| T-06-05-03 | Repudiation | run advances against mutated version | high | mitigate | pinned flow_version_id, never live_version_id (UAT 06-05-D1) | closed |
| T-06-05-04 | Denial of Service | lost delayed job strands run | medium | mitigate | 60s reconciliation scan; Postgres is timer source of truth (UAT 06-05-D4) | closed |
| T-06-06-01 | Tampering | duplicate runs from concurrent triggers | high | mitigate | one-active-run partial index + ON CONFLICT + canEnterFlow (UAT 06-06-D3) | closed |
| T-06-06-02 | Information Disclosure | evaluator cross-tenant read | medium | mitigate | withTenant(workspaceId from payload) (UAT 06-06-D1) | closed |
| T-06-06-03 | Repudiation | run pinned to mutating version | high | mitigate | flow_version_id stamped at entry, never re-pointed (UAT 06-06-D1) | closed |
| T-06-06-04 | Denial of Service | event flood on evaluator | low | accept | See Accepted Risks Log (AR-01) | closed |
| T-06-07-01 | Tampering/DoS | invalid IANA zone crashes worker | high | mitigate | Intl.supportedValuesOf allowlist on write + dispatch try/catch → UTC; quiet-hours.ts:21 (UAT 06-07-D1, 06-07-D5) | closed |
| T-06-07-02 | Repudiation | send inside quiet window | high | mitigate | dispatch-time isInsideQuietHours defers to window end (UAT 06-07-D4) | closed |
| T-06-07-03 | Denial of Service | in-worker timer loses state | medium | mitigate | next_wake_at in Postgres + delayed nudge + reconciliation (UAT 06-07-D3) | closed |
| T-06-07-04 | Input Validation | timezone in freeform properties | medium | mitigate | standard field, validated on every write path (UAT 06-07-D5) | closed |
| T-06-08-01 | Denial of Service | O(flows×contacts) sweep | high | mitigate | bulk per-segment diff vs snapshot, chunked (UAT 06-08-D5) | closed |
| T-06-08-02 | Information Disclosure | sweep admin-scan cross-tenant writes | high | mitigate | SELECT-only discovery; per-tenant writes (UAT 06-08-D3) | closed |
| T-06-08-03 | Tampering | membership drift duplicates runs | high | mitigate | canEnterFlow + one-active-run guard on every entry path (UAT 06-08-D2/D3) | closed |
| T-06-08-04 | Denial of Service | giant enroll transaction | medium | mitigate | resumable-cursor chunking (UAT 06-08-D4) | closed |
| T-06-09-01 | Elevation of Privilege | Member ejects/deletes via API | high | mitigate | requirePermission Owner/Admin on eject+delete (UAT 06-09-D2/D3) | closed |
| T-06-09-02 | Tampering | deleting live flow orphans runs | high | mitigate | D-22 guard: 409 unless never-published or paused-zero-active (UAT 06-09-D3) | closed |
| T-06-09-03 | Information Disclosure | run list leaks cross-tenant | medium | mitigate | withTenantTransaction + forced RLS (UAT 06-09-D1) | closed |
| T-06-10-SC | Tampering | @xyflow/react supply chain | high | mitigate | human legitimacy checkpoint at install; pinned 12.11.2 in apps/web/package.json:35; no reactflow anywhere (grep 2026-07-14) | closed |
| T-06-10-01 | Tampering | client-only publish validation | high | mitigate | server re-runs validateFlowDefinition (UAT 06-04-D2) | closed |
| T-06-10-02 | Input Validation | malformed node/edge in draft | medium | mitigate | flowDefinitionSchema shape + server PATCH re-validation (UAT 06-02-D1) | closed |
| T-06-11-01 | Elevation of Privilege | Member uses privileged UI control | high | mitigate | canManage=owner/admin gates + disabled/tooltip (FlowDetailPage.tsx:63-64,192-222); server re-checks D-23 (UAT 06-04-D4) | closed |
| T-06-11-02 | Tampering | client-only publish validation (UI) | high | mitigate | server-returned 422 blocker list rendered; server authoritative (UAT test 5 pass) | closed |
| T-06-11-03 | Input Validation | invalid IANA timezone entered | medium | mitigate | TimezoneCombobox constrained to Intl.supportedValuesOf; server re-validates (UAT 06-07-D5, test 10 pass) | closed |
| T-06-12-01 | Denial of Service | advance-queue jobId dedupe removal | medium | mitigate | idempotent re-read + SKIP LOCKED + removeOnComplete (UAT 06-12-D1) | closed |
| T-06-12-02 | Tampering | enqueueFlowRunAdvance payload | low | accept | See Accepted Risks Log (AR-02) | closed |
| T-06-12-03 | Denial of Service | failed advance jobs accumulate | low | mitigate | removeOnFail bounded + reconciliation re-enqueue (UAT 06-12-D1) | closed |
| T-06-13-01 | Tampering | quiet_hours_mode vocabulary mismatch | high | mitigate | canonical enum; worker branches on 'custom', fails toward workspace window (UAT 06-13-D1/D2) | closed |
| T-06-13-02 | Tampering | 0034 cross-tenant data migration | medium | mitigate | value-scoped idempotent UPDATEs, normalize-only (UAT 06-13-D3) | closed |
| T-06-13-03 | Information Disclosure | send-node timezone resolution | low | accept | See Accepted Risks Log (AR-03) | closed |
| T-06-14-01 | Tampering | draft edit re-targets live enrollment | high | mitigate | trigger columns sync only while status='draft'; publish re-derives (UAT 06-14-D1/D2) | closed |
| T-06-14-02 | Elevation of Privilege | publish-changes UI action | medium | mitigate | role-gated button + server D-23 enforcement (UAT 06-04-D4) | closed |
| T-06-14-03 | Tampering | segment referenced only by unpublished draft | low | accept | See Accepted Risks Log (AR-04) | closed |
| T-06-15-01 | Tampering/Compliance | swapped timezone bind in send/delay nodes | high | mitigate | contact-timezone fix; regression tests (UAT 06-15-D1/D2) | closed |
| T-06-15-02 | Information Disclosure | shared loadContactTimezone | medium | mitigate | WHERE workspace_id + id, inside withTenantTransaction (UAT test 12 grep evidence) | closed |
| T-06-15-03 | Denial of Service | worker crash on bad zone | low | accept | See Accepted Risks Log (AR-05) | closed |
| T-06-16-01 | Unintended Action | publish silently resumes paused flow | high | mitigate | paused preserved on publish; regression test + dialog copy (UAT 06-16-D1) | closed |
| T-06-16-02 | Spoofing/Authorization | publish route role gate | medium | accept | See Accepted Risks Log (AR-06) | closed |
| T-06-16-03 | Repudiation | silent state change on publish | low | accept | See Accepted Risks Log (AR-07) | closed |
| T-06-17-01 | Denial of Service | unbounded advance loop | high | mitigate | MAX_STEPS_PER_RUN force-exit before dispatch (UAT 06-17-D3) | closed |
| T-06-17-02 | Tampering | publishable cycle | high | mitigate | cycle_detected at publish (DFS); 422 server-side (UAT 06-17-D1) | closed |
| T-06-17-03 | Denial of Service | dead-end trigger → NULL current_node_id | medium | mitigate | no_entry validation at publish (UAT 06-17-D2) | closed |
| T-06-18-01 | Tampering/Compliance | "only new entrants" choice defeated | high | mitigate | snapshot seeded atomically in publish tx (UAT 06-18-D1) | closed |
| T-06-18-02 | Denial of Service | mass unsolicited send via empty snapshot | high | mitigate | no post-commit window; sweep always sees seeded rows (UAT 06-18-D1) | closed |
| T-06-18-03 | Bounded Resource Use | in-transaction INSERT...SELECT seed | low | accept | See Accepted Risks Log (AR-08) | closed |
| T-06-19-01 | Tampering | re-entry mode silently disabled | high | mitigate | stale snapshot rows deleted on leave; every_time re-enters (UAT 06-19-D1/D2) | closed |
| T-06-19-02 | Unwanted Re-enrollment | stale-delete bypasses canEnterFlow | medium | mitigate | anti-join delete; once_ever stays blocked (UAT 06-19-D3) | closed |
| T-06-19-03 | Information Disclosure | bounded DELETE cross-tenant | low | accept | See Accepted Risks Log (AR-09) | closed |
| T-06-20-01 | Error Handling | opaque 500 instead of 409 | medium | mitigate | SAVEPOINT wrap; SegmentConflictError regression test (UAT 06-20-D1) | closed |
| T-06-20-02 | Integrity | flow-vs-campaign disambiguation race | low | mitigate | ROLLBACK TO SAVEPOINT keeps D-24 re-check live (UAT 06-20-D2) | closed |
| T-06-20-03 | Information Disclosure | deleteSegment cross-tenant | low | accept | See Accepted Risks Log (AR-10) | closed |
| T-06-21-01 | Repudiation/Integrity | false «Сохранено» after failed save | medium | mitigate | deriveAutosaveState from isError+dirty; unit tests (UAT 06-21-D1) | closed |
| T-06-21-02 | Denial of Service | retry hot-loop | low | mitigate | single bounded delayed retry with cleanup (UAT 06-21-D1) | closed |
| T-06-22-01 | Tampering | dry-run defaultTimezone input | low | mitigate | server-side isValidIanaTimezone in shared applyCsvRowMapping; csv-mapping.ts:116 | closed |
| T-06-22-02 | Information Disclosure | csv_imports.default_timezone at rest | low | mitigate | csv_imports RLS workspace_isolation inherited by new column | closed |
| T-06-22-03 | Tampering | dry-run/apply drift | low | mitigate | single shared applyCsvRowMapping for both processes | closed |
| T-06-23-01 | Tampering | default-timezone client input | low | mitigate | constrained TimezoneCombobox (CsvImportWizard.tsx:306) + server re-validation (T-06-22-01); UAT test 10 pass | closed |
| T-06-24-01 | Spoofing (UI integrity) | autosave state indicator | low | mitigate | isPaused modeled in deriveAutosaveState (useAutosaveDraft.ts:92); UAT test 11 pass | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-01 | T-06-06-04 | Event ingest is already the throughput boundary and unchanged; evaluator is a bounded per-event job on its own queue; send rate handled by tenant token bucket | plan 06-06 threat model | 2026-07-14 |
| AR-02 | T-06-12-02 | Advance payload is internal (in-process producers only); workspaceId re-scoped via withTenant on consume, RLS re-validates every row | plan 06-12 threat model | 2026-07-14 |
| AR-03 | T-06-13-03 | Pre-existing resolveTimezone try/catch → UTC fallback unchanged by the 06-13 fix; corrupt stored zone cannot crash a worker | plan 06-13 threat model | 2026-07-14 |
| AR-04 | T-06-14-03 | Segment referenced only by an unpublished draft (jsonb, no FK) is a pre-existing v1 edge; live flows keep FK ON DELETE RESTRICT protection | plan 06-14 threat model | 2026-07-14 |
| AR-05 | T-06-15-03 | Pre-existing defensive try/catch → UTC in send-node and resolveTimezone validation in delay-node unchanged | plan 06-15 threat model | 2026-07-14 |
| AR-06 | T-06-16-02 | No change to the existing D-23 role gate; its test remains green in the suite | plan 06-16 threat model | 2026-07-14 |
| AR-07 | T-06-16-03 | updated_at records the publish; status now reflects true post-publish state | plan 06-16 threat model | 2026-07-14 |
| AR-08 | T-06-18-03 | Seed is a single bounded (statement_timeout 60s) INSERT...SELECT; acceptable for a publish action | plan 06-18 threat model | 2026-07-14 |
| AR-09 | T-06-19-03 | DELETE runs inside withTenantTransaction (RLS-scoped), filtered by workspace_id + flow_id | plan 06-19 threat model | 2026-07-14 |
| AR-10 | T-06-20-03 | All queries inside withTenantTransaction; savepoint changes only transaction-abort recovery, not tenant scoping | plan 06-20 threat model | 2026-07-14 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-14 | 72 | 72 | 0 | gsd-secure-phase (L1 short-circuit: plan-time register, all mitigations verified via passing tests + grep) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-14
