---
phase: 21
slug: per-contact-dsr-export
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-21
seeded_by: plan-phase
---

# Phase 21 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.x (`vitest run` per workspace) |
| **Config file** | `apps/api/vitest.config.ts` (Postgres-backed integration lane), `apps/web/vitest.config.ts` (node env, `renderToStaticMarkup` — no jsdom / @testing-library in this repo), `packages/delivery-core` and `packages/db` each with their own `vitest run` |
| **Quick run command** | `npm run test -w apps/api -- src/modules/contacts/__tests__/dsr-export.test.ts` |
| **Full suite command** | `npm run test` (all workspaces) |
| **Estimated runtime** | Not measured this session. The `apps/api` lane is Postgres-backed and dominates; measure with `time npm run test -w apps/api` before relying on a number. |

**Environment prerequisite:** the api lane needs a reachable Postgres (`ensureTestDbMigrated` / `getTestDatabaseUrl`). Per STATE.md the drizzle-kit `db:migrate` CLI hangs under this machine's Node version — migrations are proven via `npm run test:migrations`, never gated on `db:migrate`.

---

## Sampling Rate

- **After every task commit:** the task's own `<verify><automated>` command (a single targeted test file, typically under a minute).
- **After every plan wave:** `npm run test -w apps/api` plus `npm run test -w apps/worker` (the worker suite is the regression guard for plan 21-02's allowlist relocation) and `npm run lint`.
- **Before `/gsd-verify-work`:** `npm run test` green across all workspaces, `npm run lint` exit 0, `npm run build` succeeds.
- **Max feedback latency:** one targeted test file per task — no task ends without a runnable check.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 21-01-01 | 01 | 1 | DSR-01 | T-21-01-02 / T-21-01-05 | Export reads are workspace+contact scoped inside one REPEATABLE READ snapshot whose first read is the `anonymizedAt` gate | integration | `npm run test -w apps/api -- src/modules/contacts/__tests__/dsr-export.test.ts` | in-task (TDD RED) | ⬜ pending |
| 21-01-02 | 01 | 1 | DSR-04 | T-21-01-01 / T-21-01-02 | Member 403; foreign and nonexistent contact ids indistinguishable at 404; erased contact typed 410, no document | integration | `npm run test -w apps/api -- src/modules/contacts/__tests__/dsr-export.test.ts` | ✅ (21-01-01) | ⬜ pending |
| 21-01-03 | 01 | 1 | DSR-04 | T-21-01-01 / T-21-01-04 | Export action absent from the DOM for a member; PII-free download filename; no raw-JSON error tab | component | `npm run test -w apps/web -- src/features/contacts/__tests__/contact-dsr-export.test.tsx` | in-task (TDD RED) | ⬜ pending |
| 21-02-01 | 02 | 1 | DSR-03 | T-21-02-01 / T-21-02-02 / T-21-02-03 | Build-up allowlist only; export list structurally a superset of the evidence list; erasure behaviour unchanged | unit + regression | `npm run test -w packages/delivery-core -- src/__tests__/send-event-payload-allowlist.test.ts && npm run test -w apps/worker -- src/queues/__tests__/erasure-scrub.test.ts` | in-task (TDD RED) + ✅ existing | ⬜ pending |
| 21-02-02 | 02 | 1 | DSR-03 | T-21-02-04 | Every inventoried column exists in the schema; every excluded table carries a written reason | doc gate | `test -f docs/PII-INVENTORY.md && grep -q 'SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST' docs/PII-INVENTORY.md` | in-task | ⬜ pending |
| 21-03-01 | 03 | 2 | DSR-01 | T-21-03-02 / T-21-03-03 | Consent history complete and contact-scoped; count equals the real array length | integration | `npm run test -w apps/api -- src/modules/contacts/__tests__/dsr-export.test.ts` | ✅ | ⬜ pending |
| 21-03-02 | 03 | 2 | DSR-02 | T-21-03-01 / T-21-03-03 / T-21-03-04 | `events.properties` never read; multi-page walk exports every row | integration | `npm run test -w apps/api -- src/modules/contacts/__tests__/dsr-export.test.ts` | ✅ | ⬜ pending |
| 21-04-01 | 04 | 2 | DSR-01 | T-21-04-01 / T-21-04-02 | `anonymizedAt` added to the response without weakening any `anonymized_at IS NULL` read filter | integration | `npm run test -w apps/api -- src/modules/contacts/__tests__/contact-crud.test.ts` | ✅ existing | ⬜ pending |
| 21-04-02 | 04 | 2 | DSR-01 | T-21-04-03 / T-21-04-04 | Erased contact's action is visible-but-disabled with the reason on screen; the typed 410 stays the enforcement point | component | `npm run test -w apps/web -- src/features/contacts/__tests__/contact-dsr-export.test.tsx` | ✅ (21-01-03) | ⬜ pending |
| 21-05-01 | 05 | 3 | DSR-02 | T-21-05-02 | Sends contact-scoped and complete; dispatch telemetry excluded | integration | `npm run test -w apps/api -- src/modules/contacts/__tests__/dsr-export.test.ts` | ✅ | ⬜ pending |
| 21-05-02 | 05 | 3 | DSR-03 | T-21-05-01 / T-21-05-05 | Synthetic other-subject field provably absent from the whole document; the export list is applied, not the erasure list | integration | `npm run test -w apps/api -- src/modules/contacts/__tests__/dsr-export.test.ts` | ✅ | ⬜ pending |
| 21-05-03 | 05 | 3 | DSR-02 | T-21-05-03 | One snapshot across the whole export during a concurrent scrub, with a READ COMMITTED control that fails the same assertion | integration (concurrency) | `npm run test -w apps/api -- src/modules/contacts/__tests__/dsr-export-isolation.test.ts` | in-task (TDD RED) | ⬜ pending |
| 21-06-01 | 06 | 4 | DSR-02 | T-21-06-01 / T-21-06-02 | Journey history complete across every run status, contact-scoped; all eight sections counted | integration | `npm run test -w apps/api -- src/modules/contacts/__tests__/dsr-export.test.ts` | ✅ | ⬜ pending |
| 21-06-02 | 06 | 4 | DSR-03 | T-21-06-03 / T-21-06-05 | Contact-scoped indexes applied by both migration paths; no concurrent-index form in a single-transaction apply | migration | `npm run lint:migrations && npm run test:migrations` | ✅ existing | ⬜ pending |
| 21-06-03 | 06 | 4 | DSR-02 | T-21-06-04 / T-21-06-SC | As-built record matches the code; no-external-API declaration carries a reason | doc gate | `grep -q 'dsr-export' SPECIFICATION.md && npm run check:spec-env-coverage` | in-task | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

**No separate Wave 0 is required.** TDD mode is enabled and every new test file is authored inside the task that needs it, as that task's RED step, before its implementation:

- [x] `apps/api/src/modules/contacts/__tests__/dsr-export.test.ts` — created by task 21-01-01 (RED), extended by 21-01-02, 21-03-01/02, 21-05-01/02, 21-06-01
- [x] `apps/web/src/features/contacts/__tests__/contact-dsr-export.test.tsx` — created by task 21-01-03 (RED), extended by 21-04-02
- [x] `packages/delivery-core/src/__tests__/send-event-payload-allowlist.test.ts` — created by task 21-02-01 (RED)
- [x] `apps/api/src/modules/contacts/__tests__/dsr-export-isolation.test.ts` — created by task 21-05-03 (RED, with its own READ COMMITTED negative control as fail-first evidence)

No framework install is needed: Vitest is already configured in all four workspaces. The web lane has no jsdom and no `@testing-library`, so web assertions are markup-level (`renderToStaticMarkup`) by design — this is a pre-existing constraint, not a gap.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| The browser actually saves the file, with the D-08 filename, and the success toast appears | DSR-01 | `URL.createObjectURL` and a synthetic anchor click have no DOM in the repo's node-env web test lane | Dev stack running; open a contact card as Owner; click «Скачать данные контакта»; confirm `dsr-export-{contactId}-{today}.json` lands in Downloads, opens as readable JSON with all eight sections, and the toast «Файл с данными контакта скачан» appears (task 21-01-03 `<human-check>`) |
| Header actions row and inline message paragraph wrap rather than clip at narrow widths | DSR-01 | The three UI-SPEC `verification: backstop` items — no narrow-viewport test exists in this repo | Narrow the browser to ~380px on the contact card and confirm the Export + Delete row wraps and the inline reason/error paragraph wraps to multiple lines (task 21-01-03 `<human-check>`) |
| Mid-session erasure surfaces the typed reason rather than a raw JSON tab or a silent no-op | DSR-01 | Requires two concurrent browser sessions and a real erasure between them | Load the contact card in tab A; erase the contact in tab B; in tab A (no reload) click Export and confirm the inline erased reason appears, then the card settles into «Контакт не найден» after the refetch (task 21-04-02 `<human-check>`) |

Everything else in this phase — including SC3's API refusal, SC4's cross-tenant negative test and synthetic-field proof, and SC5's typed 410 and mid-scrub snapshot guarantee — has automated verification.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies — 15/15 tasks carry an `<automated>` command; none is `MISSING`
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references — no Wave 0 backlog; each new test file is authored in-task as its RED step
- [x] No watch-mode flags — every command is `vitest run` via `npm run test`, never `test:watch`
- [x] Feedback latency: one targeted test file per task
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending (seeded by plan-phase 2026-08-21; `status: validated` is set by `/gsd-validate-phase`)
