---
phase: 7
slug: analytics-dashboard-send-log
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-07-14
---

# Phase 7 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| worker → Postgres (tenant-scoped) | Webhook worker writes history + counters + rollup increments inside per-workspace transactions so RLS applies | Send events, subscription status, engagement counters |
| API request → Postgres (tenant-scoped) | Contact update / unsubscribe / analytics read routes run under the caller's workspace RLS context | Contact PII, subscription status, per-message send data |
| browser → API (session-authed) | Timeline, campaign summary, flow analytics, send-log, dashboard routes return workspace-scoped data | Cross-source contact activity, campaign/flow metrics, per-email log |
| reconciliation loop → many workspaces | Enumerates organization ids then re-enters a fresh per-workspace tenant context | Aggregate daily counts per workspace |
| SendGrid webhook → worker | Signed webhook events (verified upstream in Phase 05) cross into the worker | Delivery/open/click/bounce events |
| build → npm registry | recharts pulled as a new third-party dependency at install time | Build-time supply chain |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-07-01-01 | Information Disclosure | subscription_status_history table | high | mitigate | ENABLE + FORCE ROW LEVEL SECURITY with NULLIF-guarded workspace_isolation policy — verified in `packages/db/migrations/0036_analytics_status_history_counts.sql:33-36` | closed |
| T-07-01-02 | Tampering | open_count/click_count increment on webhook replay | medium | mitigate | Unique-send facts gated by `setFactColumnOnce` RETURNING (`justSet`); replayed batches insert zero new send_events rows and trigger zero rollup increments — verified in `apps/worker/src/queues/webhook-events.worker.ts` | closed |
| T-07-01-03 | Repudiation | subscription_status change with no audit trail | medium | mitigate | `recordSubscriptionStatusChange` writes source + old/new status at all four mutation sites — verified at `contact.repository.ts:366`, `unsubscribe.routes.ts:209`, `webhook-events.worker.ts:207,232`, `contacts-core/contact-repository.ts:390` | closed |
| T-07-01-SC | Tampering | npm/pip/cargo installs | high | mitigate | No new package installs in plan 07-01; slopcheck N/A | closed |
| T-07-02-01 | Information Disclosure | GET .../contacts/:id/timeline (IDOR) | high | mitigate | IDOR double-gate: explicit `getContact` existence check 404s foreign-workspace ids, plus RLS via `withTenant` — verified in `apps/api/src/modules/analytics/timeline.routes.ts:71-73` | closed |
| T-07-02-02 | Tampering | type-filter query param | low | mitigate | Local zod schema `z.enum(["all","events","emails","statuses"])` rejects unrecognized values — verified in `timeline.routes.ts:12` | closed |
| T-07-02-03 | Information Disclosure | UNION query workspace scoping | high | mitigate | Every UNION branch filters `workspace_id = $1` under tenant context — verified in `timeline.repository.ts:55,88,98,115` (all 4 branches scoped) | closed |
| T-07-02-SC | Tampering | npm/pip/cargo installs | high | mitigate | No new package installs in plan 07-02; slopcheck N/A | closed |
| T-07-03-01 | Information Disclosure | excluded-breakdown query over sends | medium | mitigate | Parameterized query inside `getCampaignProgress`'s tenant-scoped `withTenantTransaction` path — verified in `apps/api/src/modules/campaigns/campaign.repository.ts:433-459` | closed |
| T-07-03-02 | Tampering | rate math (division by zero) | low | mitigate | `computeRate` returns null on zero denominator (rendered «—»); no NaN/Infinity reaches UI — verified in `apps/web/src/lib/rates.ts` | closed |
| T-07-03-SC | Tampering | npm/pip/cargo installs | high | mitigate | No new package installs in plan 07-03; slopcheck N/A | closed |
| T-07-04-01 | Information Disclosure | GET .../flows/:id/analytics (IDOR) | high | mitigate | IDOR double-gate: explicit flow-existence check 404s foreign-workspace flow ids, plus RLS — verified in `apps/api/src/modules/analytics/flow-analytics.routes.ts:59-74` | closed |
| T-07-04-02 | Tampering | per-node aggregation grain (Pitfall 4) | medium | mitigate | `COUNT(DISTINCT fr.contact_id)` prevents re-entry inflation — verified in `flow-analytics.repository.ts:52` | closed |
| T-07-04-03 | Information Disclosure | cross-version node aggregation | low | mitigate | Aggregation scoped by `frs.workspace_id = $1 AND fr.flow_id = $2` under RLS — verified in `flow-analytics.repository.ts:55,77` | closed |
| T-07-04-SC | Tampering | npm/pip/cargo installs | high | mitigate | No new package installs in plan 07-04; slopcheck N/A | closed |
| T-07-05-01 | Tampering | send-log filter params → dynamic WHERE | high | mitigate | All values bound via `$N` placeholders built from zod-validated fields (status closed set via `z.enum(SEND_LOG_STATUSES)`, period preset) — verified in `send-log.routes.ts:19-24` and `send-log.repository.ts:105-169` | closed |
| T-07-05-02 | Information Disclosure | GET .../send-log/:sendId/events (IDOR) | high | mitigate | IDOR double-gate: explicit send-existence check (`SELECT id FROM sends WHERE workspace_id = $1 AND id = $2`) 404s foreign-workspace sendIds, plus workspace-scoped send_events read — verified in `send-log.routes.ts:132-146`, `send-log.repository.ts:191,216` | closed |
| T-07-05-03 | Information Disclosure | send-log list workspace scoping | high | mitigate | List query anchors `s.workspace_id = $1` under `withTenant` — verified in `send-log.repository.ts:105`, `send-log.routes.ts:114` | closed |
| T-07-05-SC | Tampering | npm/pip/cargo installs | high | mitigate | Only official shadcn `sheet` block added (`npx shadcn@latest add sheet`), no third-party registry or npm package install | closed |
| T-07-06-01 | Information Disclosure | workspace_daily_rollup table | high | mitigate | ENABLE + FORCE ROW LEVEL SECURITY with NULLIF-guarded workspace_isolation policy — verified in `packages/db/migrations/0037_workspace_daily_rollup.sql:24-28` | closed |
| T-07-06-02 | Tampering | reconciliation cross-workspace loop (Pitfall 5) | high | mitigate | Fresh `withTenant(workspaceId)` + `withTenantTransaction` per workspace, never a shared transaction/GUC — verified in `analytics-reconciliation.worker.ts:81-87` | closed |
| T-07-06-03 | Tampering | metric→column mapping in increment helper | medium | mitigate | Fixed `METRIC_COLUMN` allow-list (`Record<RollupMetric, string>`) maps metric literals to column names; caller input never interpolated — verified in `analytics-rollup.ts:3-9` | closed |
| T-07-06-04 | Tampering | reconciliation additive-vs-overwrite drift (Pitfall 2) | high | mitigate | `ON CONFLICT ... DO UPDATE SET <col> = EXCLUDED.<col>` absolute overwrite — verified in `analytics-reconciliation.worker.ts:31,57`; idempotence covered by `analytics-reconciliation.test.ts` | closed |
| T-07-06-SC | Tampering | npm/pip/cargo installs | high | mitigate | No new package installs in plan 07-06; slopcheck N/A | closed |
| T-07-07-01 | Information Disclosure | GET .../dashboard | high | mitigate | `resolveWorkspaceMember` + `withTenant` scope every read (rollup + contacts + mini-lists) to the caller's workspace under RLS — verified in `dashboard.routes.ts:50-65` | closed |
| T-07-07-02 | Tampering | period query param | low | mitigate | Validated to closed set 7\|30\|90 via local zod schema; other values 400 — verified in `dashboard.routes.ts:9-11` | closed |
| T-07-07-03 | Tampering | recharts supply-chain ([SUS] flag) | high | mitigate | Blocking human-verify checkpoint executed before install: npmjs.com verification (canonical recharts/recharts repo, tens-of-millions weekly downloads, non-deprecated, React ^19 peer dep); pinned exact `recharts@3.9.2` — documented in 07-07-SUMMARY.md | closed |
| T-07-07-SC | Tampering | npm/pip/cargo installs | high | mitigate | recharts install gated by the Task 2 blocking-human checkpoint (approved); no other package installed | closed |
| T-07-08-01 | Information Disclosure | `getCampaignProgress` reused by SummaryView for terminal campaigns | low | accept | No new endpoint or query; reuses the already-authorized `resolveWorkspaceMember` 404 double-gate + workspace-scoped path from 07-03 — see Accepted Risks Log AR-07-01 | closed |
| T-07-08-02 | Tampering | send-log deep link `?campaign={campaignId}` | low | accept | Link only pre-fills a query param; send-log page independently re-authorizes and validates server-side — see Accepted Risks Log AR-07-02 | closed |
| T-07-08-SC | Tampering (supply chain) | npm dependencies | low | accept | No new packages installed in plan 07-08 — see Accepted Risks Log AR-07-03 | closed |
| T-07-09-01 | Tampering (data integrity) | workspace_daily_rollup dual-writer conflict | high | mitigate | Incremental path gates opened/clicked on `justSet` and bounced on `isFirstNonDeliveryTerminal` (unique-send semantic matching the reconciler) — verified in `webhook-events.worker.ts:279,297,315,340`; invariant pinned by `analytics-rollup-reconciliation-invariant.test.ts` | closed |
| T-07-09-02 | Tampering (SQL injection) | `isFirstNonDeliveryTerminal` query + gated increments | low | accept | Static parameterized SELECT (only `$1 = sendId` bound); rollup columns from fixed allow-list — see Accepted Risks Log AR-07-04 | closed |
| T-07-09-03 | Repudiation / correctness | per-send repeat counters `sends.open_count`/`click_count` | low | accept | Left unconditional by design; `webhook-open-click-counts.test.ts` proves per-event counting — see Accepted Risks Log AR-07-05 | closed |
| T-07-09-SC | Tampering (supply chain) | npm dependencies | low | accept | No new packages installed in plan 07-09 (worker + tests only) — see Accepted Risks Log AR-07-06 | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-07-01 | T-07-08-01 | Terminal-campaign SummaryView reuses the existing authorized `GET .../campaigns/:id/progress` path (07-03's 404 double-gate + tenant transaction); no new data surface introduced | plan 07-08 threat model (plan-time disposition) | 2026-07-14 |
| AR-07-02 | T-07-08-02 | Deep link only pre-fills a query param; the send-log page independently re-authorizes workspace membership and validates filters server-side (07-05 behavior); a tampered id yields not-found/empty handling, not cross-tenant data | plan 07-08 threat model (plan-time disposition) | 2026-07-14 |
| AR-07-03 | T-07-08-SC | No new packages installed in plan 07-08; only existing UI primitives and TanStack Query reused | plan 07-08 threat model (plan-time disposition) | 2026-07-14 |
| AR-07-04 | T-07-09-02 | New helper SQL is a static parameterized SELECT with a single bound id; rollup column names come exclusively from the `RollupMetric` allow-list — no new interpolation surface | plan 07-09 threat model (plan-time disposition) | 2026-07-14 |
| AR-07-05 | T-07-09-03 | Per-send repeat counters intentionally stay per-event (raw engagement data) while the rollup adopts unique-send counts; behavior pinned by existing test | plan 07-09 threat model (plan-time disposition) | 2026-07-14 |
| AR-07-06 | T-07-09-SC | No new packages installed in plan 07-09 (worker + test changes only) | plan 07-09 threat model (plan-time disposition) | 2026-07-14 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-14 | 33 | 33 | 0 | gsd-secure-phase (L1 grep-depth, short-circuit: register authored at plan time, ASVS 1) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-14
