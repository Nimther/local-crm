---
phase: 16
slug: live-sendgrid-verification
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-17
---

# Phase 16 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.9 |
| **Config file** | Root `vitest.config.ts` aggregate + per-workspace configs (`scripts/vitest.config.ts`, `apps/api`, `apps/worker`, `packages/delivery-core`) — existing, unchanged by this phase |
| **Quick run command** | `npx vitest run --root scripts __tests__/uat-verify.test.mjs` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~5 s quick, full suite as today |

---

## Sampling Rate

- **After every task commit:** Run the task's own `<automated>` command (all are single-file vitest runs, < 30 s)
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite green AND all five blocking UAT checkpoints approved (D-16)
- **Max feedback latency:** 30 seconds for task-level, full-suite time for wave-level

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 16-01-01 | 01 | 1 | UAT-01, UAT-02 | T-16-01 | Every read is tenant-scoped through `withTenant`; no new grant | unit | `npx vitest run --root scripts __tests__/uat-verify.test.mjs` | ❌ W0 | ⬜ pending |
| 16-01-02 | 01 | 1 | UAT-01 | T-16-02 | Runbook carries no credential value | gate | `npm run check:runbook-coverage` | ✅ | ⬜ pending |
| 16-01-03 | 01 | 1 | UAT-01, UAT-02 | T-16-05 | Verdict is a query exit code, not an impression | manual (blocking checkpoint) | — (human-verify) | N/A | ⬜ pending |
| 16-02-01 | 02 | 2 | UAT-02 | T-16-09 | Partial event coverage cannot render as a pass | unit | `npx vitest run --root scripts __tests__/uat-verify.test.mjs` | ❌ W0 | ⬜ pending |
| 16-02-02 | 02 | 2 | UAT-02 | T-16-07 | Bounce target is operator-controlled, no catch-all | gate | `npm run check:runbook-coverage` | ✅ | ⬜ pending |
| 16-02-03 | 02 | 2 | UAT-02 | T-16-06 | Sibling-workspace events cannot be counted as evidence | manual (blocking checkpoint) | — (human-verify) | N/A | ⬜ pending |
| 16-03-01 | 03 | 2 | UAT-05 | T-16-10, T-16-14 | Absent override is byte-identical; present override warns loudly at boot | unit | `npx vitest run --root packages/delivery-core src/__tests__/send-mail.test.ts` | ❌ W0 | ⬜ pending |
| 16-03-02 | 03 | 2 | UAT-03 | T-16-11, T-16-12, T-16-13 | Capture strictly after verification, strictly before parse; one workspace only | integration | `npx vitest run --root apps/api src/modules/webhooks/__tests__/webhooks-raw-capture.test.ts` | ❌ W0 | ⬜ pending |
| 16-03-03 | 03 | 2 | UAT-03, UAT-05 | T-16-10 | Both env vars filed in the same change | gate | `npm run check:spec-env-coverage` | ✅ | ⬜ pending |
| 16-04-01 | 04 | 3 | UAT-04 | T-16-18 | Journal growth expected; send_events fixed at one; counters unchanged | unit | `npx vitest run --root scripts __tests__/uat-verify.test.mjs` | ❌ W0 | ⬜ pending |
| 16-04-02 | 04 | 3 | UAT-03, UAT-04 | T-16-17 | Byte-exact replay; tolerance restore is a numbered step | unit | `npx vitest run --root scripts __tests__/uat-replay-script.test.mjs` | ❌ W0 | ⬜ pending |
| 16-04-03 | 04 | 3 | UAT-03, UAT-04 | T-16-15, T-16-16 | Decode-and-inspect gate before the fixture is saved | manual (blocking checkpoint) | — (human-verify) | N/A | ⬜ pending |
| 16-05-01 | 05 | 4 | UAT-03 | T-16-20, T-16-22 | Absent fixture turns the suite red, never green | integration | `npx vitest run --root apps/api src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts` | ❌ W0 | ⬜ pending |
| 16-05-02 | 05 | 4 | UAT-03, UAT-04 | T-16-21, T-16-23 | Frozen clock, not a widened tolerance; two negative cases mandatory | integration | `npx vitest run --root apps/api src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts` | ❌ W0 | ⬜ pending |
| 16-06-01 | 06 | 4 | UAT-05 | T-16-24, T-16-25 | Rate-limit mode: zero upstream requests. Timeout mode: exactly one, delayed response | unit | `npx vitest run --root scripts __tests__/uat-fault-proxy.test.mjs` | ❌ W0 | ⬜ pending |
| 16-06-02 | 06 | 4 | UAT-05 | T-16-26, T-16-28 | Proxy publishes no port and is absent from the production compose file | gate | `npm run verify:prod-compose` | ✅ | ⬜ pending |
| 16-06-03 | 06 | 4 | UAT-05 | T-16-24, T-16-25, T-16-27 | Exactly one mailbox copy per leg; override removed | manual (blocking checkpoint) | — (human-verify) | N/A | ⬜ pending |
| 16-07-01 | 07 | 5 | UAT-01..05 | T-16-34 | Every claim cites a query output or an observed artifact | gate | `grep -c 'UAT-0' .planning/phases/16-live-sendgrid-verification/16-UAT-REPORT.md` | ❌ W0 | ⬜ pending |
| 16-07-02 | 07 | 5 | UAT-01..05 | T-16-30..33 | Teardown verified by observation, not by intention | gate | `npm run check:spec-env-coverage && npm run verify:prod-compose` | ✅ | ⬜ pending |
| 16-07-03 | 07 | 5 | UAT-01..05 | T-16-30, T-16-31, T-16-32, T-16-33 | No seam, proxy or widened tolerance survives the phase | manual (blocking checkpoint) | — (human-verify) | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Every automated command above whose file is marked ❌ W0 is created by the task that first names it — there is no separate Wave 0 plan, because each new test file is authored in the same task as the behaviour it covers:

- [ ] `scripts/__tests__/uat-verify.test.mjs` — created in 16-01-01, extended in 16-02-01, 16-04-01, 16-06-02
- [ ] `scripts/__tests__/uat-replay-script.test.mjs` — created in 16-04-02
- [ ] `scripts/__tests__/uat-fault-proxy.test.mjs` — created in 16-06-01
- [ ] `packages/delivery-core/src/__tests__/send-mail.test.ts` — created or extended in 16-03-01
- [ ] `apps/worker/src/__tests__/sendgrid-base-url-boot-log.test.ts` — created in 16-03-01
- [ ] `apps/api/src/modules/webhooks/__tests__/webhooks-raw-capture.test.ts` — created in 16-03-02
- [ ] `apps/api/src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts` — created in 16-05-01, extended in 16-05-02
- [ ] `apps/api/src/modules/webhooks/__tests__/fixtures/uat-signed-payload.json` — produced by 16-04's blocking checkpoint, not by code

Test framework, runners and configs already exist — nothing to install.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live BYO-key send through a Dynamic Template arrives in a real inbox with substitutions rendered | UAT-01 | No code can observe a third-party mailbox | `docs/runbooks/uat-live-sendgrid.md` UAT-01 procedure; checkpoint 16-01-03 |
| Opened and clicked events produced by a real mail client | UAT-02 | Requires a human to render a tracking pixel and follow a wrapped link | UAT-02 procedure; checkpoint 16-02-03 |
| Genuine hard bounce from a real receiving MTA | UAT-02 | The platform cannot produce a real 550 | UAT-02 procedure, bounce leg; checkpoint 16-02-03 |
| A genuinely SendGrid-signed payload accepted through the public HTTPS stack | UAT-03 | Only SendGrid's signing key can produce one; it exists nowhere in this codebase | UAT-03/04 procedure; checkpoint 16-04-03. Permanently regression-covered afterwards by `webhooks-signature-replay.test.ts` |
| Byte-exact redelivery counted exactly once, live | UAT-04 | Requires a real captured payload and the live database | UAT-03/04 procedure; checkpoint 16-04-03 |
| Exactly one mailbox copy after a real 429 and after a real timeout | UAT-05 | The claim is about physical mailbox contents, not database status | UAT-05 procedure, both legs; checkpoint 16-06-03 |
| No seam, proxy or widened tolerance survives the phase | UAT-01..05 | Requires observing the production host's env, containers and boot log | Teardown verification checklist; checkpoint 16-07-03 |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or are declared manual-only above
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30 s at task level
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
