---
phase: 16-live-sendgrid-verification
verified: 2026-08-19T10:45:00Z
status: passed
score: 4/4 roadmap success criteria verified (39/39 plan-level must-have truths corroborated)
behavior_unverified: 0
overrides_applied: 0
---

# Phase 16: Live SendGrid Verification Verification Report

**Phase Goal:** Every delivery guarantee this milestone claims is confirmed against the real SendGrid account and a real inbox — not against a mock.
**Verified:** 2026-08-19T10:45:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Note on method

This is a live-UAT phase whose primary evidence is operator-observed live results captured at five blocking `checkpoint:human-verify` gates (D-13 override of end-of-phase mode), recorded in the plan SUMMARYs and compiled into `16-UAT-REPORT.md`. Per the task's explicit instruction, live sends were **not** re-run and the production host was **not** contacted. Verification here instead (1) confirms every claimed checkpoint approval actually exists in the SUMMARY/UAT-REPORT text with concrete identifiers (send ids, message ids, event counts, timestamps) rather than vague narrative, (2) independently re-runs every automated test the plans claim, (3) confirms every artifact exists and is wired, and (4) cross-checks the code-review findings (16-REVIEW.md) against what actually ships.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A live send using a tenant's own BYO key through a SendGrid Dynamic Template arrives in a real inbox | ✓ VERIFIED | 16-01 Task 3 blocking checkpoint, approved 2026-08-17. Operator confirmed real-mailbox arrival, both handlebars substitutions rendered, clickable link present. `send-attribution --expect-status sent --expect-events delivered` exited 0. Send `d9ac9629-1fb3-5521-9d4b-bdf625d8b9ca`, SendGrid message id `iU2gsMMHQKyB2hMP89dmEQ`, workspace `171285c6-a489-46be-9ee9-ba4ed6964356`. Instrument code (`scripts/uat-verify.mjs`) exists and its 12 `send-attribution` unit tests re-run green in this verification. |
| 2 | Real delivered, opened, clicked and bounced events from SendGrid land on the correct send, flow step and campaign | ✓ VERIFIED | 16-02 Task 3 blocking checkpoint, approved 2026-08-17 ("approved — UAT-02 passed"). `event-coverage --require-campaign --require-flow-step` exit 0; observed `delivered=3, open=4, click=1, bounce=1`, 13 resolved `send_events` rows, both attribution flags passed (flow `500c77d2-…`, bounce campaign `109811eb-…`, genuine hard bounce at operator-controlled no-catch-all domain). `event-coverage` subcommand's 13 new tests re-run green as part of the full 25/25 `uat-verify.test.mjs` suite (see below — actually 83/83 combined with 16-04's additions). |
| 3 | A genuinely signed SendGrid webhook payload passes signature verification through the full HTTP stack, and a redelivery of that same payload is counted exactly once | ✓ VERIFIED | Live: 16-04 Task 3 checkpoint — byte-exact replay of a real signed capture (click event, send `bf8355a4-…`, workspace `fe8fbbc6-…`) accepted through public HTTPS/Caddy/Fastify; one-byte mutation rejected 400 before parse/journal/enqueue. Dedup compare: `sendEventsCount=1, ingressJournalDelta=1, rollupUnchanged=true, campaignCountersUnchanged=true, passed=true`. **Permanent CI regression**, independently re-run in this verification: `apps/api/src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts` — 8/8 pass, exercising the real 663-byte fixture through the actual Fastify route + real ECDSA verification + real production `processWebhookEventBatch`, proving accept/reject-mutated-byte/reject-wrong-valid-key/exactly-one-dedup-row-from-two-deliveries. `webhooks-raw-capture.test.ts` (8/8, also re-run) proves the capture seam that produced the fixture is response-parity-safe and workspace-scoped. |
| 4 | A real SendGrid 429 or transient error defers only the affected tenant's sends and resolves without duplicate or lost mail | ✓ VERIFIED | 16-06 Task 3 checkpoint, approved 2026-08-18. 429 leg: send `0eb4edb8-…`, synthetic 429 at 09:57:07.609Z made zero upstream calls, BullMQ retried at 09:57:09.636Z, terminal `attemptCount=2`, real `processed`/`delivered` events, exactly one mailbox copy. Timeout leg: send `150e82da-…`, real upstream call succeeded, response delayed past `SENDGRID_TIMEOUT_MS`, `reconciling` from 10:02:38.688Z with no retry, scheduled reconciler resolved `sent` at 10:06:13.691Z from real webhook evidence, exactly one mailbox copy. Mailbox thread grew by exactly two messages total across both legs. Fault-proxy unit tests (`uat-fault-proxy.test.mjs`, 10/10) re-run green, independently confirming the asymmetric one-shot no-forward-on-429 / forward-then-delay-on-timeout contract the live session relied on. |

**Score:** 4/4 roadmap success criteria verified. `behavior_unverified: 0` — every state-transition claim (429→retry→sent; timeout→reconciling→reconciler→sent; accept/reject/dedup) has both a live checkpoint AND (for UAT-03/04) a permanent, independently-passing CI regression exercising the real code path; none rests on symbol presence alone.

### Requirement Traceability (UAT-01..05)

| Requirement | Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| UAT-01 | 16-01 | Live-отправка с BYO key через Dynamic Template подтверждена | ✓ SATISFIED | See SC1 above |
| UAT-02 | 16-01 (delivered leg), 16-02 | Live-события delivered/opened/clicked/bounced подтверждены | ✓ SATISFIED | See SC2 above |
| UAT-03 | 16-03, 16-04, 16-05 | Проверка подписи webhook подтверждена на реальном подписанном payload через полный HTTP-стек | ✓ SATISFIED | See SC3 above; live + permanent CI |
| UAT-04 | 16-04, 16-05 | Дедупликация повторно доставленных событий подтверждена live | ✓ SATISFIED | See SC3 above (dedup proof is joint with UAT-03) |
| UAT-05 | 16-03, 16-06 | Поведение при 429 и временных ошибках SendGrid подтверждено live | ✓ SATISFIED | See SC4 above |

No orphaned requirements: every UAT-01..05 ID declared in a plan's `requirements:` frontmatter (checked across all 7 plans) traces to REQUIREMENTS.md's Live SendGrid Verification section, and every ID in that section is claimed by at least one plan. `REQUIREMENTS.md`'s own Traceability table already marks UAT-01..05 as Complete/Phase 16, consistent with this verification.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `scripts/uat-verify.mjs` | Scripted-assert CLI: `send-attribution`, `event-coverage`, `dedup`, `uat05-state` | ✓ VERIFIED | Exists, all subcommands present, wired into `package.json` `uat:verify`; 56+ unit tests across these subcommands re-run green |
| `scripts/uat-replay.sh` | Byte-exact replay harness with one-byte-mutation mode and strict capture validation | ✓ VERIFIED | Exists; `scripts/__tests__/uat-replay-script.test.mjs` re-run green (part of the 83/83 combined `scripts/` suite) |
| `scripts/uat-fault-proxy.mjs` | One-shot asymmetric 429/timeout fault proxy | ✓ VERIFIED | Exists; 10/10 unit tests re-run green |
| `docker/docker-compose.uat-proxy.yml` | Session-only compose override, no host port, absent from prod compose/deploy path | ✓ VERIFIED (wiring), ⚠️ see CR-01 below | Confirmed absent from `docker-compose.prod.yml` and `deploy.sh`; runbook explicitly instructs it is never added to a routine deploy command |
| `apps/api/src/modules/webhooks/__tests__/fixtures/uat-signed-payload.json` | Real, decoded, inspected, byte-exact SendGrid-signed fixture | ✓ VERIFIED | Exists, 6-line strict 4-key JSON, README documents provenance/replacement contract; consumed by the permanent CI suite, which fails hard if the fixture is removed (per 16-05's design and its own RED confirmation) |
| `apps/api/src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts` | Permanent CI regression for UAT-03/UAT-04 | ✓ VERIFIED | 8/8 tests pass on independent re-run in this verification |
| `packages/delivery-core/src/send-mail.ts` (`SENDGRID_MAIL_SEND_URL`) | Default-off override seam, byte-identical when absent | ✓ VERIFIED | 13/13 `send-mail.test.ts` tests re-run green |
| `apps/worker/src/server.ts` (`logSendgridBaseUrlOverrideIfActive`) | Loud, non-fatal boot warning | ✓ VERIFIED | 3/3 tests re-run green |
| `docs/runbooks/uat-live-sendgrid.md` | Single operator document, 16 sections, no embedded credentials | ✓ VERIFIED | Exists; `check:runbook-coverage`/`check:root-hygiene` reported passing in every plan SUMMARY; grep for SendGrid-key/private-key shapes returns no match per 16-01's own acceptance check |
| `.planning/phases/16-live-sendgrid-verification/16-UAT-REPORT.md` | Single compiled evidence artifact mapping UAT-01..05 to live proof | ✓ VERIFIED | Exists, cites concrete send/message ids, commands, exit codes and event counts for every requirement; includes the Task 3 teardown/canary closeout dated 2026-08-19 |

### Data-Flow / Behavioral Verification (Level 4 + spot-checks)

Not applicable in the conventional sense (this phase ships operational UAT tooling and two reversible seams, not a data-rendering feature), but the equivalent check — "does the evidence trace to a real production code path and not a stub" — was performed:

| Check | Command | Result |
|---|---|---|
| `scripts/` UAT test suite (uat-verify, uat-replay-script, uat-fault-proxy) | `npx vitest run --root scripts __tests__/uat-verify.test.mjs __tests__/uat-replay-script.test.mjs __tests__/uat-fault-proxy.test.mjs` | 3 files, 83/83 passed |
| Webhook signature replay + raw capture (real Fastify HTTP stack) | `npx vitest run src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts src/modules/webhooks/__tests__/webhooks-raw-capture.test.ts` (from `apps/api`) | 2 files, 16/16 passed |
| `SENDGRID_BASE_URL` override seam | `npx vitest run src/__tests__/send-mail.test.ts` (from `packages/delivery-core`) | 1 file, 13/13 passed |
| Worker boot-warning seam | `npx vitest run src/__tests__/sendgrid-base-url-boot-log.test.ts` (from `apps/worker`) | 1 file, 3/3 passed |
| All commits referenced across all 7 SUMMARYs | `git log --oneline` | Every hash cited (cd4230b … e61a7e4) present in history |
| Documented env vars filed in SPECIFICATION.md per project rule | `grep SENDGRID_BASE_URL / WEBHOOK_RAW_CAPTURE_WORKSPACE_ID SPECIFICATION.md docker/prod.env.example` | Both present, both commented-out placeholders in the example file, both fully specified (call site, default behavior, redaction interaction) in SPECIFICATION.md §3.9/5.5/6.8 |
| Debt-marker gate | `grep -n -E "TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER"` across all 16 phase-modified files | Zero matches |

### Prohibitions (must_haves.prohibitions across all 7 plans — judgment-tier, resolved by live evidence)

All 22 prohibitions declared across the 7 plans carry `verification: unverified` in frontmatter (author-flagged, not machine-checked). Per the honest-verifier / ADR-550 handling, these route to human judgment; below is the disposition of every one, discharged against the concrete live/CI evidence gathered above rather than left as an open flag:

| Prohibition (paraphrased) | Disposition |
|---|---|
| 16-01: MUST NOT record UAT-01 passed on a platform-key/non-template send | Discharged — checkpoint explicitly confirms tenant BYO key + UAT Dynamic Template used |
| 16-01: MUST NOT use a non-operator-controlled mailbox | Discharged — checkpoint text: "operator's real mailbox" |
| 16-02: MUST NOT bounce a domain the operator doesn't control | Discharged — `phase16-hard-bounce-…@nimther.com`, operator-controlled, no-catch-all confirmed pre-use |
| 16-02: MUST NOT count sibling-workspace/platform-mail events as evidence | Discharged — `event-coverage` scopes to `--workspace`; existing sibling-drop path (Phase 5) unmodified |
| 16-02: MUST NOT simulate open/click | Discharged — checkpoint: real mail client rendered pixel and followed link |
| 16-03: MUST NOT log raw payloads for a non-configured workspace / default capture off | Discharged — `webhooks-raw-capture.test.ts` (8/8, re-run) explicitly tests unset/other-workspace produce zero capture lines |
| 16-03: MUST NOT capture pre-verification bytes | Discharged — code + test confirm capture strictly after `isValid && isFresh`, before `JSON.parse` |
| 16-03: MUST NOT make either override silently permanent | Discharged — boot warning test (3/3) proves loud non-fatal announcement |
| 16-04: MUST NOT commit a fixture with third-party/sibling data | Discharged — decode-and-inspect gate documented in README + SUMMARY; single throwaway UAT event confirmed |
| 16-04: MUST NOT hand-edit/re-sign the payload | Discharged — README states byte-for-byte as captured; fixture-integrity tests in 16-05 would fail on any edit (frozen clock, unconditional import) |
| 16-04: MUST NOT leave widened timestamp tolerance in place | Discharged — SUMMARY states `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` unset, effective default 600s, confirmed read back |
| 16-05: MUST NOT commit third-party data / weaken tolerance / skip on missing fixture | Discharged — all three are explicit, independently-verified test behaviors in the re-run suite (frozen Date, unconditional import, 4 fixture-integrity cases) |
| 16-06: MUST NOT forward on rate-limit / MUST NOT drop on timeout | Discharged — live evidence: 429 leg made zero upstream calls; timeout leg's real events arrived, proving the upstream call was made |
| 16-06: MUST NOT expose proxy outside compose network / leave it running | Discharged — no `ports:` mapping (confirmed in compose file read); teardown 5/5 confirmed port 4180 closed off-host and proxy absent |
| 16-06: MUST NOT route platform mail through the proxy | Discharged — `SENDGRID_BASE_URL` is read only at the tenant `sendTenantMailV3` call site (test-verified); platform sender structurally untouched |
| 16-07: MUST NOT record a pass without citing evidence / omit a failed first attempt / leave a seam active / delete the UAT workspace | Discharged — `16-UAT-REPORT.md`'s "First-attempt failures and closures" section explicitly documents 6 real first-attempt issues and their resolutions; Task 3 teardown 5/5 + canary 1/1; workspace retained as documented standing canary |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `docker/docker-compose.uat-proxy.yml` | 6-9 | Session-only fault-proxy container is granted the **entire** production secrets file (`env_file: - path: ${MEGA_CRM_ENV_FILE}`) though the script it runs reads only 4 narrowly-scoped `UAT_FAULT_PROXY_*` vars — 16-REVIEW.md CR-01 | ⚠️ Warning (not blocking) | Does not affect any of the 4 phase success criteria (the live sessions completed and teardown was verified 5/5 — the file was never actually reachable externally and was torn down). It IS a real intra-network blast-radius risk if this file is reused in a future release without the fix. Recommend landing the review's suggested `environment:` allowlist fix before the next standing-canary/fault-injection session reuses this file. |
| `scripts/uat-fault-proxy.mjs` | 115-140 | `/__control` endpoint has no auth, reachable by any container on the compose network (WR-01) | ℹ️ Info/Warning, non-blocking | Same session-only, non-deploy-path file; compounds CR-01 above but doesn't independently touch any success criterion |
| `packages/delivery-core/src/send-mail.ts` | 144-151 | `redactApiKey` mangles messages when `apiKey===""` (WR-02) | ℹ️ Info, non-blocking | Edge case affecting log readability only, not delivery correctness or any UAT criterion; not exercised by any live UAT path (a live send always has a real key) |
| `scripts/uat-fault-proxy.mjs` | 38-45 | No body-size cap on raw-body reader (WR-03) | ℹ️ Info, non-blocking | Session-only tool, `mem_limit: 128m` already bounds worst case to a container OOM-kill, not a data-integrity issue |
| `apps/api/src/modules/webhooks/webhooks.routes.ts` | 157-183 | Raw-capture seam has no compiled-in workspace allowlist (WR-04) | ℹ️ Info/Warning, non-blocking | Default-off, requires operator action to activate; response-parity and pre/post-verification-boundary tests (which I re-ran, 8/8 pass) are the actual safety property this phase's success criteria depend on |
| `scripts/uat-fault-proxy.mjs` | 31-36 | `nextMode` misleading name (WR-05) | ℹ️ Info, non-blocking | Naming/readability only; behavior is correctly one-shot per the passing test suite |
| `apps/api/src/modules/webhooks/__tests__/fixtures/uat-signed-payload.json` | — | Fixture necessarily embeds real operator PII (IN-01) | ℹ️ Info, accepted/documented | Explicitly an accepted, unavoidable cost of byte-exact ECDSA-signed replay design (D-09/D-11/D-12), documented in the fixture's own README |

Debt-marker gate (`TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER`) run across all 16 phase-modified files: **zero matches.**

### Human Verification Required

None outstanding. All human-dependent evidence (mailbox arrival, template rendering, opened/clicked/bounced events, live 429/timeout recovery, teardown, canary) was already gathered at five blocking `checkpoint:human-verify` gates during phase execution — this is the structural mechanism D-13 substitutes for end-of-phase human-verify mode specifically because this phase's evidence is inherently live and time-bound. Re-running any of these live checks was explicitly out of scope for this verification pass. Two items are recorded as open/residual by the phase's own report (not phase-blocking, not re-assertable by any verifier):
- Historical workspace `171285c6-a489-46be-9ee9-ba4ed6964356`'s continued presence/absence in production was not independently checked (16-UAT-REPORT.md, Residual items).
- An unconfirmed flow-editor UI error-boundary observation from an earlier interrupted session has no evidence artifact and is out of this phase's evidence-only scope.

### Gaps Summary

No gaps block phase goal achievement. All four ROADMAP success criteria have concrete, cited live evidence from operator-approved blocking checkpoints, and the two criteria (UAT-03, UAT-04) whose correctness rests on a state-transition/exactly-once invariant additionally have a permanent, independently re-run CI regression (8/8) exercising the real Fastify route, real ECDSA verification and the real production dedup processor — this is stronger evidence than a live-only pass would provide, since it is reproducible on every future CI run rather than resting solely on a point-in-time human observation.

The one carried-forward residual item worth a maintainer decision is **CR-01** (fault-proxy container over-exposure to production secrets) from the code review. It does not fail any must-have of this phase (the prohibition text scopes to "outside the compose network" and "left running after the session," both of which were verified clean at teardown), and the file is confirmed absent from every deploy path. It is nonetheless a real, unaddressed finding that should be fixed before this file is next reused (the milestone's own Definition of Done requires unclosed Critical/High findings in delivery/tenant-isolation/compliance to be resolved, refuted, or explicitly accepted with an owner — that milestone-level reconciliation, not this phase-level pass, is the right place to close it out).

---

_Verified: 2026-08-19T10:45:00Z_
_Verifier: Claude (gsd-verifier)_
