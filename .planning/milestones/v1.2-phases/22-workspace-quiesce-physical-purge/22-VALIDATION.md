---
phase: 22
slug: workspace-quiesce-physical-purge
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-08-23
---

# Phase 22 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (per-workspace `vitest.config.ts`, unchanged by this phase) |
| **Config file** | `apps/worker/vitest.config.ts`, `apps/api/vitest.config.ts`, `packages/db/vitest.config.ts` |
| **Quick run command** | `npm run test -w apps/worker -- <file-stem>` (same form for `apps/api` / `packages/db`) |
| **Full suite command** | `npm test` |
| **Migration proof** | `npm run lint:migrations && npm run test:migrations` — the drizzle-kit `db:migrate` CLI hangs under this machine's Node version (STATE.md) and is deliberately not gated on |
| **Failure injection** | `npm run failure:workspace-purge-resume`, chained into `npm run failure:all` |
| **Estimated runtime** | targeted suites ~20-90s; `npm test` several minutes; `failure:all` many minutes (foreground only) |

---

## Sampling Rate

- **After every task commit:** the task's own `<automated>` command (targeted, < 90s)
- **After every plan wave:** `npm test` plus `npm run lint`
- **Before `/gsd-verify-work`:** `npm test`, `npm run failure:all`, `npm run lint:migrations`, `npm run check:spec-env-coverage`, `npm run check:runbook-coverage` all green
- **Max feedback latency:** 90 seconds for a task-level signal

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 22-01-01 | 01 | 1 | PRG-01/02/03/05 | T-22-01-01/03/04/05 | Org row tombstoned by UPDATE only; batches bounded; no PII in the evidence record | integration (real PG) | `npm run test -w apps/worker -- workspace-purge` | ❌ W0 | ⬜ pending |
| 22-01-02 | 01 | 1 | PRG-02 | T-22-01-06 | Evidence survives contact destruction | integration + migration | `npm run lint:migrations && npm run test:migrations && npm run test -w apps/worker -- workspace-purge` | ❌ W0 | ⬜ pending |
| 22-01-03 | 01 | 1 | PRG-03/05 | T-22-01-05 | Replay is a no-op; restored workspace refused, not skipped | integration | `npm run test -w apps/worker -- workspace-purge` | ❌ W0 | ⬜ pending |
| 22-02-01 | 02 | 1 | PRG-06 | T-22-02-01/02/03 | Fail-closed dispatch gate; refusal recorded as an excluded send fact | integration | `npm run test -w apps/worker -- workspace-quiesce-dispatch` | ❌ W0 | ⬜ pending |
| 22-02-02 | 02 | 1 | PRG-06 | T-22-02-04 | Test-send refuses without a ledger row; kickoff fans out nothing | integration | `npm run test -w apps/worker -- workspace-quiesce-dispatch` | ❌ W0 | ⬜ pending |
| 22-03-01 | 03 | 1 | PRG-06 | T-22-03-01/04 | Typed 403 on every API-key surface; nothing written | integration (HTTP) | `npm run test -w apps/api -- events-api-quiesce` | ❌ W0 | ⬜ pending |
| 22-03-02 | 03 | 1 | PRG-06 | T-22-03-02/03 | Webhook 404 indistinguishable from unknown token, pre-signature, pre-journal | integration (HTTP) | `npm run test -w apps/api -- webhooks-quiesce` | ❌ W0 | ⬜ pending |
| 22-03-03 | 03 | 1 | PRG-06 | T-22-03-01 | Queue-drain window closed on both ingest workers | integration | `npm run test -w apps/worker -- workspace-quiesce-ingest` | ❌ W0 | ⬜ pending |
| 22-04-01 | 04 | 2 | PRG-06 | T-22-04-01/02/03 | Three scan policies exclude deleted workspaces; no new grant | integration (real RLS) | `npm run test -w apps/worker -- workspace-quiesce-scan` | ❌ W0 | ⬜ pending |
| 22-04-02 | 04 | 2 | PRG-06 | T-22-04-04 | Evidence rollup stops churning for frozen workspaces | migration + integration | `npm run lint:migrations && npm run test:migrations && npm run test -w apps/worker -- workspace-quiesce-scan` | ❌ W0 | ⬜ pending |
| 22-05-01 | 05 | 2 | PRG-02/04 | T-22-05-02/05/06 | FK order asserted; PII inventory reconciled; identifiers from the frozen allowlist | integration | `npm run test -w apps/worker -- workspace-purge-tables` | ❌ W0 | ⬜ pending |
| 22-05-02 | 05 | 2 | PRG-02 | T-22-05-04/07 | Secrets destroyed, four evidence sets intact, cryptographic erasure of suppression matching | integration | `npm run test -w apps/worker -- workspace-purge-tables` | ❌ W0 | ⬜ pending |
| 22-05-03 | 05 | 2 | PRG-04 | T-22-05-01/03 | Neighbour rows byte-identical and unblocked; every partition still present | integration (real partitions) | `npm run test -w apps/worker -- workspace-purge-neighbour-safety` | ❌ W0 | ⬜ pending |
| 22-06-01 | 06 | 2 | PRG-05 | T-22-06-01/02 | Point-of-no-return refusal with no override; overdue campaigns defused atomically | integration | `npm run test -w packages/db -- workspace-restore` | ❌ W0 | ⬜ pending |
| 22-06-02 | 06 | 2 | PRG-01 | T-22-06-03/04 | Operator CLIs only, read-only report, no PII in output | integration | `npm run test -w packages/db -- workspace-restore` | ❌ W0 | ⬜ pending |
| 22-06-03 | 06 | 2 | PRG-05 | T-22-06-01 | Restore-vs-purge race decided by one shared lock, loser refuses visibly | integration | `npm run test -w packages/db -- workspace-restore` | ❌ W0 | ⬜ pending |
| 22-07-01 | 07 | 3 | PRG-02 | T-22-07-01/02/03 | Real 42501 on the ordinary pool; scoped auth pool; global identities untouched | integration (real grants) | `npm run test -w apps/worker -- workspace-purge-auth` | ❌ W0 | ⬜ pending |
| 22-07-02 | 07 | 3 | PRG-02 | T-22-07-05/07 | Auth failure fails the purge loudly, un-tombstoned; pool closed on shutdown | integration | `npm run test -w apps/worker -- workspace-purge-auth` | ❌ W0 | ⬜ pending |
| 22-08-01 | 08 | 3 | PRG-01/03 | T-22-08-01/02/03/06 | One deduplicated alert; no alert on the report-only window; no PII in alert text | unit + fake-client | `npm run test -w apps/api -- purge-watchdog` | ❌ W0 | ⬜ pending |
| 22-08-02 | 08 | 3 | PRG-01 | T-22-08-05 | Alert has a runbook at the derived path; watchdog registered at boot | gate + unit | `npm run check:runbook-coverage && npm run test -w apps/api -- purge-watchdog` | ❌ W0 | ⬜ pending |
| 22-09-01 | 09 | 4 | PRG-03 | T-22-09-01/02 | Real SIGKILL mid-walk resumes; counts equal an uninterrupted control run | failure injection | `npm run failure:workspace-purge-resume` | ❌ W0 | ⬜ pending |
| 22-09-02 | 09 | 4 | PRG-03 | T-22-09-03 | Kill between tables and before the tail leaves a correct intermediate state | failure injection | `npm run failure:workspace-purge-resume` | ❌ W0 | ⬜ pending |
| 22-10-01 | 10 | 5 | PRG-01/02 | T-22-10-02/04 | Env example and specification move in one commit; no secret values | gate | `npm run check:spec-env-coverage && npm run verify:prod-compose` | ✅ | ⬜ pending |
| 22-10-02 | 10 | 5 | PRG-01/02 | T-22-10-01/03/05 | Irreversibility claim qualified by the backup horizon; evidence sets documented | gate | `npm run check:runbook-coverage && npm run check:root-hygiene` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Every new test file below is created by the task that needs it, RED-first, inside its own plan — there is no separate Wave 0 plan because the existing Vitest infrastructure, the real-Postgres fixtures (`apps/worker/src/test/db-fixture.ts`, `@mega-crm/test-support`) and the failure-injection harness all already exist and are reused unchanged.

- [ ] `apps/worker/src/queues/__tests__/workspace-purge.test.ts` — PRG-01/02/03/05 (created in 22-01 Task 1)
- [ ] `apps/worker/src/queues/__tests__/workspace-quiesce-dispatch.test.ts` — PRG-06 (22-02 Task 1)
- [ ] `apps/api/src/modules/events/__tests__/events-api-quiesce.test.ts` — PRG-06 (22-03 Task 1)
- [ ] `apps/api/src/modules/webhooks/__tests__/webhooks-quiesce.test.ts` — PRG-06 (22-03 Task 2)
- [ ] `apps/worker/src/queues/__tests__/workspace-quiesce-ingest.test.ts` — PRG-06 (22-03 Task 3)
- [ ] `apps/worker/src/queues/__tests__/workspace-quiesce-scan.test.ts` — PRG-06 (22-04 Task 1)
- [ ] `apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts` — PRG-02/04 (22-05 Task 1)
- [ ] `apps/worker/src/queues/__tests__/workspace-purge-neighbour-safety.test.ts` — PRG-04 / SC4 (22-05 Task 3)
- [ ] `packages/db/src/__tests__/workspace-restore.test.ts` — PRG-05 (22-06 Task 1)
- [ ] `apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts` — PRG-02 / D-12 (22-07 Task 1)
- [ ] `apps/api/src/modules/ops/__tests__/purge-watchdog.test.ts` — D-08 (22-08 Task 1)
- [ ] `apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts` — PRG-03 / SC3 (22-09 Task 1)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| A stuck-purge operator alert actually arrives in a human's mailbox | PRG-01 / D-08 | The alert transport is the platform SendGrid key and a real inbox; every layer up to `sgMail.send()` is proven by injected-seam tests, but delivery to a human is not observable in CI (same carried gap as the Phase 9 operator-alert email) | Force a `purge_records` row into `failed` on a staging database, wait one watchdog interval, confirm the message arrives and that its text contains no workspace name or contact data |
| Purged data ages out of the encrypted pgBackRest repository on the documented schedule | PRG-02 / PT-02 | Requires waiting out a real backup-retention window against a real repository; the caveat is documented rather than tested | Follow `docs/runbooks/backups.md`; confirm the full-backup count and that the oldest full predating a purge has expired |

---

## Validation Sign-Off

- [x] All tasks have an `<automated>` verify command
- [x] Sampling continuity: no 3 consecutive tasks without an automated verify
- [x] Wave 0 coverage: every MISSING test file is created RED-first by the task that needs it
- [x] No watch-mode flags (`vitest run`, never `vitest`)
- [x] Feedback latency < 90s for targeted suites
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
