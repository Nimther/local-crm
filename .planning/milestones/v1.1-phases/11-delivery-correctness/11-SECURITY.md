---
phase: 11
slug: delivery-correctness
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on (high) — the blocking gate
threats_open: 0
threats_total: 62
threats_closed: 61
threats_open_non_blocking: 0
asvs_level: 1
block_on: high
register_authored_at_plan_time: true
created: 2026-08-09
audited: 2026-08-09
---

# Phase 11 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

Register origin: **authored at plan time** — all 11 PLAN files carry a `<threat_model>` block, so this audit verified declared mitigations rather than retroactively constructing a register. ASVS level 1, with L2 depth applied to the boundary-placement threats (RLS scoping, claim exclusivity, redaction exits).

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| worker process → SendGrid | Outbound call to a third party that may hang, reset, or answer ambiguously, holding a decrypted tenant BYO key | Tenant API key, recipient address, template data |
| worker process → cross-workspace scan role | The reconciler's discovery read crosses every tenant boundary at once on `SCAN_DATABASE_URL` | `sends` ids/workspace ids only (narrow SELECT) |
| reconciler ↔ send worker | Two independent processes able to write the same ledger row | `sends.status` transitions |
| reconciler tick ↔ reconciler tick | Concurrent or overlapping passes over one candidate set | Row locks, campaign counters |
| worker process → API process | Liveness asserted by one process, judged by another, deliberately, so neither masks the other's death | `send_reconciler_runs` health row |
| watchdog → operator inbox | Outbound email built from database contents, sent with the platform's own key | Counts, ages, timestamps, reason names |
| SendGrid → webhook ingestion | Untrusted external POST whose contents become the reconciler's only evidence | Signed event payloads |
| platform → tenant's SendGrid account | Provisioning writes subscription config into a tenant's own account with their BYO key | Event-type flags |
| ledger → tenant-visible surface | Where an internal state becomes a claim a marketer acts on | `reconciling` / `unknown` labels |
| migration → production data | DDL applied to a live ledger; stray DML rewrites delivery history and every derived analytic | `sends`, `send_events` |
| npm registry → build | A new third-party runtime dependency entering the send path | **Boundary not crossed — see R-01** |
| test harness → live provider | A harness booting the real queue runtime could send real mail from a tenant account | Fixture-only synthetic data |
| documentation → published guarantee | The delivery model is a claim tenants rely on; untested prose is an unbacked promise | DLV-07 statement |

---

## Threat Register

62 threats, 61 closed by verified mitigation, 1 closed by the accepted-risk entry below (R-02). Evidence is `file:line` or test name, independently verified by the auditor rather than taken from SUMMARY claims.

### 11-01 — state machine & delivery model

| Threat ID | Category | Component | Sev | Disp | Mitigation (verified) | Status |
|---|---|---|---|---|---|---|
| T-11-01-01 | Repudiation | ARCHITECTURE.md writer matrix | high | mitigate | `ARCHITECTURE.md:157-168` ↔ `send-state-machine.ts:82-123`; drift asserted `send-state-machine.test.ts:72-89`; human gate recorded `11-01-SUMMARY.md:57,92` | closed |
| T-11-01-02 | Tampering | `SendStatus` union | med | mitigate | `send-state-machine.ts:123` `as const satisfies Record<SendStatus, readonly SendTransition[]>` | closed |
| T-11-01-03 | Info Disclosure | delivery-model wording | med | mitigate | `ARCHITECTURE.md:174-178`; 0 occurrences of `exactly-once`; substance covered by `delivery-model-claims.test.ts:121,155,176` — see Residual RS-01 | closed |
| T-11-01-04 | DoS | none introduced | low | accept | `send-state-machine.ts` has zero imports — pure, I/O-free | closed |

### 11-02 — expand migrations & audit script

| Threat ID | Category | Component | Sev | Disp | Mitigation (verified) | Status |
|---|---|---|---|---|---|---|
| T-11-02-01 | Tampering | migrations 0047-0050 | high | mitigate | Zero `UPDATE/DELETE/INSERT … sends` across `0047`-`0052`; `rollup-enum-migration-invariant.test.ts:124,184`; `lint-migrations.mjs:68-70` `enum-add-value-used-same-file` | closed |
| T-11-02-02 | Tampering | `audit-sends-history.ts` | med | mitigate | `audit-sends-history.ts:111-129` `withWorkspaceReadOnly` always `ROLLBACK` (success `:121`, error `:124`); write-keyword scan re-run clean — see Residual RS-02 | closed |
| T-11-02-03 | Info Disclosure | audit script stdout | med | mitigate | `audit-sends-history.ts:170-207` emits status/kind labels, counts, ISO timestamps only; workspace ids read `:259`, never printed | closed |
| T-11-02-04 | Elev. of Privilege | `send_reconciler_runs` without RLS | low | accept | `0050:11-21` documents the acceptance; zero GRANT statements name the table | closed |
| T-11-02-05 | DoS | plain `CREATE INDEX` write lock | med | accept | **Accepted risk R-02** — physical fact verified (`0049`/`0051`/`0052` all plain `CREATE INDEX`) | closed |

### 11-03 — reconciler tracer

| Threat ID | Category | Component | Sev | Disp | Mitigation (verified) | Status |
|---|---|---|---|---|---|---|
| T-11-03-01 | Tampering | `resolveOneSend` terminal write | high | mitigate | `send-reconciler.worker.ts:227-228` `FOR UPDATE SKIP LOCKED`, status re-verified in lock; `send-ledger.ts:241,252` guard; `send-reconciler-tracer.test.ts:106` | closed |
| T-11-03-02 | Tampering | retry worker vs reconciler | high | mitigate | `send-ledger.ts:71-73`, `:399-401` → `"skipped"`; `claim-gate-exclusivity.test.ts:104,119,171` | closed |
| T-11-03-03 | Tampering | `recordExcluded` re-walk | high | mitigate | `send-ledger.ts:334`, `:496` `NOT IN (...)`; `claim-gate-exclusivity.test.ts:134,151` | closed |
| T-11-03-04 | Elev. of Privilege | discovery scan | med | mitigate | `send-reconciler.worker.ts:169` `withCrossWorkspaceScan`; `0042:9` grant list excludes `send_events`; evidence read forced to `:237` inside `withTenantTransaction` | closed |
| T-11-03-05 | DoS | unbounded discovery scan | med | mitigate | `:178-179` `LIMIT $3`; `0049` `sends_status_queued_at_idx`; **CR-01 fix** `:175` horizon bound; `send-reconciler-verdicts.test.ts:504,600` — **incompletely mitigated at plan time, see N-01** | closed |
| T-11-03-06 | Tampering | cross-deploy job payload | med | mitigate | `shared-schemas/src/queues.ts:88-92` `z.literal(SEND_RECONCILER_TICK_SCHEMA_VERSION)`; worker `:379-385` `safeParse` → log + return | closed |
| T-11-03-07 | DoS | scheduler registration at boot | med | mitigate | `:397-413` fire-and-forget `try/catch/finally` with `queue.close().catch()` | closed |
| T-11-03-08 | Info Disclosure | reconciler logging | low | mitigate | `:333` `scrubbedConsole.log` four-count summary; `:381` logs `jobId` only | closed |

### 11-04 — deterministic send id

| Threat ID | Category | Component | Sev | Disp | Mitigation (verified) | Status |
|---|---|---|---|---|---|---|
| T-11-04-SC | Tampering | new npm dependency in send path | high | mitigate | **Closed by elimination, stronger than planned — see R-01** | closed |
| T-11-04-01 | Spoofing | `custom_args.send_id` correlation | high | mitigate | `send-id.ts:114-125` derives from tenant-scoped ids only; `send-reconciler.worker.ts:215-237` correlates inside `withTenant(row.workspaceId)` under RLS | closed |
| T-11-04-02 | Tampering | `SEND_ID_NAMESPACE` | high | mitigate | `send-id.test.ts:63` pins the literal; `:79-81`, `:108` pin full derivations; both golden vectors recomputed against Python `uuid5` — byte-identical | closed |
| T-11-04-03 | Info Disclosure | id derivation inputs | low | accept | `send-id.ts:42-47` states UUIDv5 is not claimed as a confidentiality control | closed |
| T-11-04-04 | Repudiation | UUIDv5's internal SHA-1 | low | accept | `send-id.ts:42-47` documents the non-adversarial disposition per RFC 4122/9562 | closed |

### 11-05 — bounded provider call

| Threat ID | Category | Component | Sev | Disp | Mitigation (verified) | Status |
|---|---|---|---|---|---|---|
| T-11-05-01 | DoS | `sendTenantMailV3` | high | mitigate | `send-mail.ts:160` `signal: AbortSignal.timeout(SENDGRID_TIMEOUT_MS)`; `send-mail.test.ts:89` uses a real never-responding local server | closed |
| T-11-05-02 | Tampering | stalled-checker vs live processor | high | mitigate | `send-timing-invariant.test.ts:47-49` asserts `SENDGRID_TIMEOUT_MS + CLAIM_TX_MARGIN_MS + RECORD_TX_MARGIN_MS < SEND_LOCK_DURATION_MS` on real exports | closed |
| T-11-05-03 | Info Disclosure | thrown abort/reset errors | high | mitigate | `send-mail.ts:152-165` one `try`/`catch`, sole exit `throw redactApiKey(err, apiKey)` `:164`; `send-mail.test.ts:123` asserts message **and** stack redaction on the abort path | closed |
| T-11-05-04 | DoS | unbounded provider retry | med | mitigate | `email-broadcast.worker.ts:44` / `email-triggered.worker.ts:35` — `provider_backoff` throws into bounded attempts; unbounded `Retry-After` loop removed | closed |
| T-11-05-05 | Tampering | misclassified transport error | high | mitigate | `transport-classify.ts:46-52` (survives non-objects), `:60-83` with `return "ambiguous"` structurally last | closed |
| T-11-05-06 | DoS | tenant throughput ceiling | low | accept | `email-broadcast.worker.ts:29-35` — `tenant_bucket` still uses `worker.rateLimit()`, consuming no attempt | closed |

### 11-06 — ambiguous outcome routing

| Threat ID | Category | Component | Sev | Disp | Mitigation (verified) | Status |
|---|---|---|---|---|---|---|
| T-11-06-01 | Repudiation | outcome classification | high | mitigate | `send-dispatch.ts:316-332` `handleAmbiguousSendMailError` can only write `reconciling`; both paths `:445`, `:658`; `ambiguous-outcome.test.ts` | closed |
| T-11-06-02 | Tampering | campaign counters | high | mitigate | `send-dispatch.ts:330-331` ambiguous branch calls only `writeReconciling` — no counter, no completion check | closed |
| T-11-06-03 | Tampering | pre-connection retry | high | mitigate | `send-dispatch.ts:325-328` — only `pre_connection_retryable` releases + rethrows | closed |
| T-11-06-04 | Info Disclosure | thrown provider error in logs | med | mitigate | No raw-error log site added; `:327` rethrows the already-redacted instance | closed |
| T-11-06-05 | DoS | claim stranded by a rethrow | med | mitigate | `send-dispatch.ts:326` `releaseDispatchClaim` before `throw err` `:327`; WR-02 verified **not** to weaken this — see R-03 | closed |

### 11-07 — webhook `processed` event

| Threat ID | Category | Component | Sev | Disp | Mitigation (verified) | Status |
|---|---|---|---|---|---|---|
| T-11-07-01 | Tampering | tenant webhook subscription | med | mitigate | `sendgrid-webhook-provision.ts:29-48` single `EVENT_FLAGS` spread into both `postCreate:164` and `patchWebhook:250` — parity structural, not conventional | closed |
| T-11-07-02 | DoS | `send_events` volume | med | mitigate | `deferred` absent from `EVENT_FLAGS`, rationale `:49-54`; `send_events` monthly-partitioned (`0020`) | closed |
| T-11-07-03 | Spoofing | forged `processed` as false evidence | high | mitigate | `webhooks.routes.ts:49-55` `parseAs:"buffer"`; `:105` signature verified before `:116` `JSON.parse`. File's last commit is Phase 10 `b65c225` — undisturbed | closed |
| T-11-07-04 | Info Disclosure | provisioning error logs | med | mitigate | `:87-94` `redactApiKey`, `:105-107` `redactSecret`, `:116-119` `logNonOkProvisionResponse`; no new log site | closed |
| T-11-07-05 | Repudiation | tenants not reprovisioned | low | accept | `SPECIFICATION.md §5.11:744-751` + `docs/runbooks/reprovision-webhook-event-types.md` | closed |

### 11-08 — full reconciler

| Threat ID | Category | Component | Sev | Disp | Mitigation (verified) | Status |
|---|---|---|---|---|---|---|
| T-11-08-01 | Tampering | double counter increment | high | mitigate | `send-reconciler.worker.ts:255` `if (resolved && liveRow.campaignId)`; `send-reconciler-verdicts.test.ts:197` double-tick assertion | closed |
| T-11-08-02 | Tampering | concurrent ticks | high | mitigate | `:227-228` `FOR UPDATE SKIP LOCKED`; `send-reconciler-verdicts.test.ts:432` `Promise.all` two-tick | closed |
| T-11-08-03 | Tampering | stale sweep racing a live job | high | mitigate | `send-timing-invariant.test.ts:80-82` `STALE_DISPATCHING_AGE_MS > SEND_MAX_JOB_LIFETIME_MS`; `send-ledger.ts:286` `WHERE status='dispatching'` | closed |
| T-11-08-04 | Repudiation | reconciler inventing `failed` | high | mitigate | `reconciler.ts:84-88` (4 members, no failure); `send-ledger.ts:189-191` (2 members); `resolve_failed` only in a comment and a negative test. WR-03 verified **not** to weaken this — see R-04 | closed |
| T-11-08-05 | Elev. of Privilege | evidence read crossing tenants | med | mitigate | `0042:9` grants exclude `send_events`; read only at `:237` inside `withTenantTransaction` | closed |
| T-11-08-06 | DoS | unbounded tick work | med | mitigate | Batch cap tested `:600`; `0049`, `0051`, and **WR-01** `0052` indexes all exist — **incompletely mitigated at plan time, see N-01** | closed |
| T-11-08-07 | Info Disclosure | tick logging | low | mitigate | `:332-333` `scrubbedConsole.log` with counts only | closed |

### 11-09 — health row & watchdog

| Threat ID | Category | Component | Sev | Disp | Mitigation (verified) | Status |
|---|---|---|---|---|---|---|
| T-11-09-01 | Repudiation | missing/unreadable health row | high | mitigate | `send-reconciler-watchdog.ts:97-99` `missing_health_row` checked first; `0050` seeds singleton at epoch; `send-reconciler-watchdog.test.ts:179-181` | closed |
| T-11-09-02 | Info Disclosure | operator alert body | high | mitigate | `:132-178` counts/ages/timestamps/reason names only; module imports only `reconciler-run.js` `:25-26`; test `:161-181` asserts no UUID, no email, no `Bearer` | closed |
| T-11-09-03 | DoS | alert storm across replicas | med | mitigate | `:206-220` conditional `UPDATE … RETURNING` + 6h window; `:261-269` release guarded by `last_alert_sent_at = $1`; test `:271-280` | closed |
| T-11-09-04 | Spoofing | tick reporting itself alive after failing | high | mitigate | `send-reconciler.worker.ts:335` `recordReconcilerRun` after the loop, no surrounding `try/catch`; `send-reconciler-health.test.ts:196-218` throwing-tick test | closed |
| T-11-09-05 | Tampering | tick resetting alert dedup window | med | mitigate | `reconciler-run.ts:56-77` omits `last_alert_sent_at`; `reconciler-run.test.ts:150-152`, `:115-122` | closed |
| T-11-09-06 | DoS | watchdog interval in test processes | med | mitigate | `apps/api/src/server.ts:281` called only inside `main()` `:252`, never `buildServer()` `:65` | closed |

### 11-10 — tenant-visible surface

| Threat ID | Category | Component | Sev | Disp | Mitigation (verified) | Status |
|---|---|---|---|---|---|---|
| T-11-10-01 | Repudiation | send-log computed status | high | mitigate | `send-log.repository.ts:106` `reconciling` arm and `:113` `unknown` arm both before `ELSE s.status::text` `:114`; `send-log-status-vocabulary.test.ts` (7 passed). Reachability fixed by G-11-2 `cc1eb9a` | closed |
| T-11-10-02 | Repudiation | test-send confirmation copy | med | mitigate | `TestSendPanel.tsx:72` "поставлено в очередь"; `:34` states no automatic re-send | closed |
| T-11-10-03 | Tampering | `?status=` query parameter | low | accept | `send-log.routes.ts:22` `z.array(z.enum(SEND_LOG_STATUSES))`; `send-log.repository.ts:152-153` `= ANY($n::text[])`, never interpolated | closed |
| T-11-10-04 | DoS | test-send retry storm | med | mitigate | `send-dispatch.ts:565` returns rather than throws; `test-send-outcome.test.ts:68`, `:140` | closed |
| T-11-10-05 | Info Disclosure | ambiguous test-send log line | low | mitigate | `send-dispatch.ts:564` `scrubbedConsole.warn` with `{campaignId, outcome}` — `testTo` never passed | closed |

### 11-11 — failure injection

| Threat ID | Category | Component | Sev | Disp | Mitigation (verified) | Status |
|---|---|---|---|---|---|---|
| T-11-11-01 | Tampering | harness reaching real SendGrid | high | mitigate | `sigkill-entrypoint.ts:143` imports `processSendJob` directly, injects only `sendMail`; the one `new Worker(` (`redis-restart.test.ts:90`) targets a randomized throwaway queue `:52` | closed |
| T-11-11-02 | Repudiation | untested delivery-model prose | high | mitigate | `delivery-model-claims.test.ts:46,53,64` (matrix) and `:121,155,176` (observed, incl. never-re-sent by provider-call count) | closed |
| T-11-11-03 | Tampering | scenario not wired into CI | high | mitigate | `.github/workflows/ci.yml:189-211` exactly 8 `npm run failure:` steps; `package.json:38` chains all 8; `ci.yml:20` names `failure-injection` a required check | closed |
| T-11-11-04 | DoS | orphaned frozen child processes | med | mitigate | `sigkill.test.ts:67,76,79` and `crash-post-accept.test.ts:72,82,85` keep `survivor` + `afterAll killAndAwaitExit`; `crash-pre-result-write.test.ts` spawns no child `:27-31` | closed |
| T-11-11-05 | Tampering | race passing on a lucky schedule | med | mitigate | `reconciler-retry-race.test.ts:107` `ITERATIONS = 10`, `:112` fresh intents, `:123` genuine `Promise.all` | closed |
| T-11-11-06 | Info Disclosure | fixture data in CI logs | low | accept | `failure-fixtures.ts:131` `SG.fixture_test_key_…`, `:155` `sender@fixture.test`, `:165` generated `@fixture.test` | closed |

*Status: open · closed · open — below `high` threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above `block_on: high` count toward `threats_open`*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---|---|---|---|---|
| R-01 | T-11-04-SC | **Closed by elimination, not by the planned mitigation.** The plan proposed vetting `uuid` (zero-dep, no postinstall, exact-pinned, recorded in SPECIFICATION.md §2). At plan 11-04's `blocking-human` package gate the operator instead chose to hand-roll UUIDv5 over `node:crypto`, so the npm-registry→build boundary is **not crossed at all**: `uuid` appears 0 times in `package-lock.json`, and `packages/delivery-core/package.json` declares only `@mega-crm/tenant-context` + `pg`. Auditor independently recomputed 4 vectors (incl. empty-name) against Python `uuid5` — byte-identical; `parseUuid` (`send-id.ts:75-83`) applies its hex regex *before* `Buffer.from(hex,"hex")`, so malformed input throws rather than silently truncating. Residual cosmetic laxity: hyphens are stripped position-agnostically, so `6f1c-9a3e5d2b…` would parse — not exploitable, since the only namespace argument in the codebase is the pinned literal and any edit trips `send-id.test.ts:63`. | operator (11-04 gate) | 2026-08-09 |
| R-02 | T-11-02-05 | Plain (non-`CONCURRENTLY`) `CREATE INDEX` in `0049`/`0051`/`0052` takes a write lock on `sends`. Accepted at this deployment's scale and consistent with every prior index migration in this repo. The `CONCURRENTLY` path is deferred to Phase 14 (Pitfall 17). **This entry is the durable accepted-risk record the plan assumed existed** — the auditor found no `CONCURRENTLY` or `Pitfall 17` mention in any `.sql`/`.md` outside `.planning/`, so recording it here is what closes T-11-02-05. | operator (phase 11 audit) | 2026-08-09 |
| R-03 | WR-02 (code review) | `dispatchSendGate`/`claimFlowSend` can throw a raw unclassified `Error` under a narrow concurrent claim-then-release race (`send-ledger.ts:81`/`:409`: `INSERT … ON CONFLICT DO NOTHING` inserted nothing **and** the follow-up `SELECT` returned zero rows). Auditor traced it: the transaction holds no row, propagates out of `withTenantTransaction` (`send-dispatch.ts:395-397`) → rollback, nothing persisted, **no `dispatching` row stranded** — the row the loser saw was already `DELETE`d by the winner. Blast radius is a spurious failed-job entry polluting the operator signal. **Verified not to weaken T-11-06-05**, whose mitigation lives on the post-SendGrid ambiguous path. | operator (post-review decision) | 2026-08-09 |
| R-04 | WR-03 (code review) | Dead `{ kind: "failed"; sendId: string }` member remains in `ClaimResult` (`send-dispatch.ts:210`) and `FlowClaimResult` (`flow-send.ts:112`) with zero construction sites. **Verified not to weaken T-11-08-04**: that guarantee is type-level over the *reconciler's* unions (`reconciler.ts:84-88`, `send-ledger.ts:189-191`), both clean, and `resolveReconcilingSend` is the only writer onto a `reconciling`/`unknown` row. Even if constructed, it maps to a legitimate `dispatching → failed` worker edge and cannot reach the reconciler. It does erode the *worker-side* D-10 invariant's type-level enforcement — the shape a reverting change would need already exists and is already wired to a handler. | operator (post-review decision) | 2026-08-09 |

---

## Notes

**N-01 — T-11-03-05 / T-11-08-06 were incompletely mitigated at plan time.** Both declared `RECONCILER_BATCH_LIMIT` + an index as the DoS mitigation — a *work-per-tick* bound. The failure that actually occurred (code review CR-01) was a *liveness* failure strictly **inside** that bound: the cap was never exceeded, yet the 24h resolution SLA the phase exists to provide stopped being met, because `ORDER BY queued_at ASC` sorted permanently-inert past-horizon `unknown` rows to the front of every batch. A batch cap without a predicate guaranteeing candidate turnover is only half a DoS mitigation, and the register recorded it as whole. Closed by `47b8664`, which bounds the `unknown` arm by `RECONCILE_RESCAN_HORIZON_MS` as a bound parameter on the same `queued_at` column `classifyReconcilableSend` compares against, so discovery and classification agree at the boundary. Auditor traced the other two arms for the same defect — neither has it. Regression coverage is real: `send-reconciler-verdicts.test.ts:504` seeds more past-horizon rows than the batch admits alongside a fresh `reconciling` row, and was confirmed to fail against the pre-fix query.

*Residual capacity note (not a threat gap):* with `LIMIT 500` per ~5-minute tick, a sustained ambiguous-outcome rate above ~500/tick still bounds throughput — but oldest-first ordering means rows drain rather than starve. Scaling ceiling, not the CR-01 class.

**N-02 — unregistered flag (warning, non-blocking, no threat-register mapping).** `send-reconciler-watchdog.ts:290-292`'s outermost `.catch()` logs with bare `console.error("send-reconciler-watchdog: health check failed", err)`. That `err` can originate from `sendReconcilerOperatorAlert` (`apps/api/src/server.ts:243-250`), an `sgMail.send()` call authenticated with `PLATFORM_SENDGRID_API_KEY` — a new-in-Phase-11 SendGrid error path in `apps/api` that does **not** pass through `redactApiKey`/`redactSecret`/`scrubbedConsole`.

Mitigating context, independently confirmed: it is a **byte-for-byte structural clone** of the pre-existing `partition-watchdog.ts:262-263` (Phase 9), so a faithfully mirrored pattern rather than a Phase 11 regression; it carries the *platform* key, not a tenant BYO key; and `@sendgrid/mail` surfaces response body/headers rather than the request `Authorization` header. T-11-09-02's own scope (the alert *body*) is separately verified clean. Recorded so a future phase hardening `partition-watchdog`'s logging fixes both call sites together.

**RS-01 / RS-02 — declared automated checks that were never persisted.** Neither is an open threat (both substantive properties hold today, re-verified during this audit), but both were declared in the register as *automated* controls and exist only as one-shot execution-time `<verify>` steps, so neither guards against regression:

- **RS-01 (T-11-01-03)** — "Automated check rejects `exactly-once`." No such check exists in `scripts/`, `.github/`, `package.json`, or any test; `11-01-SUMMARY.md:60` confirms it was a Task-2 `<verify>` step. Property holds (0 occurrences in `ARCHITECTURE.md`) and the claim's *substance* has durable behavioral coverage in `delivery-model-claims.test.ts`, but nothing greps the published prose.
- **RS-02 (T-11-02-02)** — "automated check rejects any write keyword in the comment-stripped source." Not persisted; `audit-sends-history.ts` is referenced by no test or script. All eight write keywords re-confirmed absent. The primary control — the always-`ROLLBACK` wrapper at `:111-129` — *is* durable code and is what actually prevents a write.

Cheapest durable closure for both: one source-string test in the style already used at `reconciler-run.test.ts:150-152` and `env-schema.test.ts:198`.

---

## Cross-Phase Invariants

| Invariant | Verdict | Evidence |
|---|---|---|
| **Phase 10 P3** — `apps/api/src/env.ts` must not declare `SCAN_DATABASE_URL` | **HOLDS** | Full file read (124 lines); `:9-12` documents the deliberate omission. Only occurrences under `apps/api/src/` are inside the negative test (`env-schema.test.ts:191,196,198`), which still enforces via source-string assertion `:198`, plus `:217-219` asserting no non-test file imports `withCrossWorkspaceScan`. Phase 11's watchdog is the biggest exposure and is clean — imports only `reconciler-run.js` `:25-26`, receives its `client` by injection |
| **Fail-closed RLS** — no cross-tenant read without the scan role; no cross-tenant write by any role | **HOLDS** | `sends` `0015:33` and `send_events` `0020:77` both `FORCE ROW LEVEL SECURITY`. `mega_crm_scan` created `NOBYPASSRLS` in both bootstrap paths (`docker/init-app-role.sql:29-30`, `scripts/ensure-db-roles.mjs:67`), grants SELECT-only (`0041:21`, `0042:9`). Repo-wide grep for `GRANT (INSERT|UPDATE|DELETE|ALL)` returns only two `mega_crm_app` rows in `0045`. Phase 11 added no unscoped read; its one unscoped shared-pool use (`:335` → `recordReconcilerRun`) targets `send_reconciler_runs`, no-RLS by design and granted to nobody |
| **Webhook raw body** — ECDSA verified over raw bytes before parsing | **HOLDS, undisturbed** | `webhooks.routes.ts:49-55` route-scoped `parseAs:"buffer"`; `:97` reads Buffer; `:105` verifies signature; `JSON.parse` only at `:116` after signature + timestamp-freshness. Not `fastify-plugin`, so no other route's parsing is weakened (`:44-48`). Last commit on the file is Phase 10 `b65c225` — Phase 11 touched only `sendgrid-webhook-provision.ts` |
| **Secret redaction** — every SendGrid error path exits through redaction | **HOLDS for the declared surface** | `send-mail.ts:152-165` one `try`/`catch`, sole exit `throw redactApiKey(err, apiKey)` `:164`; abort path asserted (message + stack) `send-mail.test.ts:123`. Provisioning keeps `redactApiKey`/`redactSecret`, all non-ok responses via `logNonOkProvisionResponse`. One unregistered surface outside the declared scope — see N-02 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open (blocking) | Open (non-blocking) | ASVS | Run By |
|---|---|---|---|---|---|---|
| 2026-08-09 | 62 | 61 → 62 after R-02 | 0 | 1 → 0 after R-02 | 1 (L2 depth on boundary-placement threats) | gsd-security-auditor (opus) |

Audit scope included post-execution work: CR-01 (`47b8664`), WR-01 (`78ab4f4`), G-11-2 (`cc1eb9a`), and the two review findings left deliberately open (R-03, R-04).

---

## Sign-Off

- [x] All 62 threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log (R-01…R-04)
- [x] `threats_open: 0` confirmed — no open threat at or above `block_on: high`
- [x] Cross-phase invariants re-verified (Phase 10 P3, fail-closed RLS, webhook raw body, secret redaction)
- [x] Post-execution fixes verified adequate (CR-01, WR-01, G-11-2)
- [ ] N-02 unregistered flag carried forward — fix with `partition-watchdog`'s logging in a later phase
- [ ] RS-01 / RS-02 non-durable checks carried forward — one source-string test each would close both
