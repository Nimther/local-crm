---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Production Hardening
current_phase: 17
status: completed
stopped_at: Phase 17 context gathered
last_updated: "2026-08-19T20:23:56.246Z"
last_activity: 2026-08-20
last_activity_desc: Phase 17 complete
progress:
  total_phases: 10
  completed_phases: 10
  total_plans: 128
  completed_plans: 128
  percent: 100
current_phase_name: address-tech-debt-wr-06-medium-security-follow-ups
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-08-17)

**Core value:** Маркетолог настраивает триггерную цепочку или кампанию — и письма надёжно и вовремя доходят до нужных контактов, со сквозным отслеживанием статусов (delivered/opened/clicked/bounced).
**Current focus:** Phase 17 — address-tech-debt-wr-06-medium-security-follow-ups

## Current Position

Milestone: v1.1 Production Hardening (Phases 8-16, 95 requirements) — COMPLETE
Phase: 17
Plan: Not started
Status: All phases complete
Last activity: 2026-08-20 — Phase 17 complete
Progress: [██████████] 122/122 plans (100%) — 9/9 v1.1 phases complete (8–16)

✓ **Deadline closed (2026-08-07):** Phase 9 (DB-01/DB-02 partition automation) completed ahead of the hard **2026-09-01** deadline — 20 attached monthly partitions (2026-09…2027-06) confirmed by catalog query against a migrated database.

## Pending Checkpoints (Phase 14)

All three real-host blocking checkpoints for Phase 14 are resolved. None remain pending.

✓ **14-09** deploy/rollback — RESOLVED 2026-08-14: checkpoint approved, real deploy + second deploy + rollback confirmed on the production VPS. See 14-09-SUMMARY.md.

✓ **14-10** pgBackRest backups — RESOLVED 2026-08-14: checkpoint approved, real full backup + WAL segments confirmed in the off-host Cloudflare R2 repository, scheduled backup ran unattended, bucket non-public, cipher passphrase escrowed. See 14-10-SUMMARY.md.

✓ **14-11** restore drill — RESOLVED 2026-08-14: checkpoint approved, real PITR restore performed twice against the real off-host repository (marker absent before target, present after — both directions of PITR demonstrated), verification passed, production untouched, scratch resources destroyed. Restore duration and disk high-water mark not reported at approval — capture at the next scheduled drill. See 14-11-SUMMARY.md. This satisfies the restore-drill precondition (D-08) for enabling plan 14-12's retention deletion; the operator pre-enable checklist in docs/runbooks/data-retention.md (widen pgBackRest's repo1-retention-full from 2 to 4-6, then flip PARTITION_RETENTION_ENABLED) still applies before retention is actually turned on.

All 14 phase-14 plans now have committed SUMMARYs (14-01 through 14-14, including the gaps-only wave). Phase verification is the next step, not yet run.

## Performance Metrics

**Velocity:**

- Total plans completed: 224
- Average duration: — min
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 7 | - | - |
| 02 | 14 | - | - |
| 03 | 8 | - | - |
| 04 | 19 | - | - |
| 05 | 13 | - | - |
| 06 | 24 | - | - |
| 07 | 11 | - | - |
| 08 | 18 | - | - |
| 09 | 5 | - | - |
| 10 | 15 | - | - |
| 11 | 11 | - | - |
| 12 | 14 | - | - |
| 13 | 16 | - | - |
| 14 | 14 | - | - |
| 15 | 22 | - | - |
| 16 | 7 | - | - |
| 17 | 6 | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 01 P01 | 45min | 3 tasks | 37 files |
| Phase 01 P02 | 25min | 4 tasks | 41 files |
| Phase 01 P03 | 8min | 3 tasks | 18 files |
| Phase 01 P04 | 7min | 3 tasks | 28 files |
| Phase 01 P05 | 7min | 3 tasks | 19 files |
| Phase 01 P06 | 2min | 3 tasks | 7 files |
| Phase 01 P07 | 10min | 3 tasks | 5 files |
| Phase 02 P01 | 45min | 3 tasks | 16 files |
| Phase 02 P03 | 16min | 3 tasks | 19 files |
| Phase 02 P05 | 20min | 3 tasks | 21 files |
| Phase 02 P04 | 20min | 2 tasks | 6 files |
| Phase 02 P02 | 10min | 3 tasks | 21 files |
| Phase 02 P06 | 30min | 3 tasks | 24 files |
| Phase 02 P07 | 13min | 3 tasks | 19 files |
| Phase 02 P08 | 25min | 2 tasks | 13 files |
| Phase 02 P09 | 3min | 3 tasks | 4 files |
| Phase 02 P11 | 15 | 3 tasks | 4 files |
| Phase 02 P10 | 6min | 3 tasks | 8 files |
| Phase 02 P12 | 15min | 3 tasks | 6 files |
| Phase 02 P13 | 13min | 2 tasks | 2 files |
| Phase 02 P14 | 12min | 1 tasks | 1 files |
| Phase 03 P01 | 20min | 2 tasks | 9 files |
| Phase 03 P02 | 55min | 3 tasks | 14 files |
| Phase 03 P03 | 14min | 3 tasks | 11 files |
| Phase 03 P04 | 25min | 2 tasks | 6 files |
| Phase 03 P05 | 15min | 2 tasks | 6 files |
| Phase 03 P06 | 15min | 2 tasks | 3 files |
| Phase 03 P07 | 15min | 2 tasks | 5 files |
| Phase 03 P08 | 15min | 2 tasks | 2 files |
| Phase 04 P01 | 20min | 4 tasks | 14 files |
| Phase 04 P02 | 9min | 2 tasks | 13 files |
| Phase 04 P03 | 25min | 3 tasks | 17 files |
| Phase 04 P04 | 20min | 3 tasks | 12 files |
| Phase 04 P05 | 35min | 3 tasks | 8 files |
| Phase 04 P06 | 22min | 3 tasks | 14 files |
| Phase 04 P07 | 25min | 3 tasks | 7 files |
| Phase 04 P08 | 35min | 3 tasks | 11 files |
| Phase 04 P09 | 20min | 2 tasks | 3 files |
| Phase 04 P10 | 12min | 2 tasks | 4 files |
| Phase 04 P11 | 20min | 2 tasks | 4 files |
| Phase 04 P12 | 20min | 3 tasks | 5 files |
| Phase 04 P13 | 20min | 3 tasks | 5 files |
| Phase 04 P14 | 10min | 2 tasks | 2 files |
| Phase 04 P15 | 15min | 2 tasks | 8 files |
| Phase 04 P16 | 12min | 2 tasks | 5 files |
| Phase 04 P17 | 8min | 2 tasks | 3 files |
| Phase 04 P18 | 20min | 2 tasks | 5 files |
| Phase 04 P19 | 15min | 2 tasks | 6 files |
| Phase 05 P01 | 15min | 3 tasks | 17 files |
| Phase 05 P02 | 15min | 3 tasks | 10 files |
| Phase 05 P03 | 20min | 3 tasks | 12 files |
| Phase 05 P04 | 15min | 3 tasks | 10 files |
| Phase 05 P05 | 20min | 3 tasks | 9 files |
| Phase 05 P06 | 6min | 2 tasks | 2 files |
| Phase 05 P07 | 12min | 2 tasks | 4 files |
| Phase 05 P08 | 5min | 3 tasks | 6 files |
| Phase 05 P10 | 10min | 2 tasks | 2 files |
| Phase 05 P09 | 25min | 3 tasks | 10 files |
| Phase 05 P11 | 11min | 2 tasks | 2 files |
| Phase 05 P12 | 8min | 3 tasks | 8 files |
| Phase 05 P13 | 12min | 3 tasks | 6 files |
| Phase 06 P01 | 10min | 3 tasks | 15 files |
| Phase 06 P02 | 5min | 3 tasks | 12 files |
| Phase 06 P03 | 20min | 3 tasks | 9 files |
| Phase 06 P04 | 30min | 3 tasks | 12 files |
| Phase 06 P05 | 20min | 3 tasks | 8 files |
| Phase 06 P10 | 17min | 3 tasks | 9 files |
| Phase 06 P06 | 24min | 3 tasks | 6 files |
| Phase 06 P07 | 32min | 3 tasks | 24 files |
| Phase 06 P09 | 20min | 2 tasks | 5 files |
| Phase 06 P08 | 25min | 3 tasks | 15 files |
| Phase 06 P11 | 20min | 4 tasks | 15 files |
| Phase 06 P12 | 25min | 3 tasks | 11 files |
| Phase 06 P14 | 25 | 3 tasks | 4 files |
| Phase 06 P13 | 20min | 3 tasks | 8 files |
| Phase 06 P15 | 12min | 2 tasks | 5 files |
| Phase 06 P16 | 12min | 2 tasks | 3 files |
| Phase 06 P17 | 15min | 2 tasks | 6 files |
| Phase 06 P18 | 15min | 2 tasks | 3 files |
| Phase 06 P19 | 8min | 2 tasks | 2 files |
| Phase 06 P20 | 12min | 2 tasks | 2 files |
| Phase 06-flows-triggered-chains P21 | 2min | 2 tasks | 3 files |
| Phase 06 P22 | 10min | 3 tasks | 9 files |
| Phase 06 P24 | 5min | 1 tasks | 2 files |
| Phase 06 P23 | 6min | 1 tasks | 1 files |
| Phase 07 P01 | 30min | 3 tasks | 13 files |
| Phase 07 P03 | 15min | 2 tasks | 7 files |
| Phase 07 P02 | 20min | 2 tasks | 6 files |
| Phase 07 P05 | 25min | 2 tasks | 12 files |
| Phase 07 P06 | 25min | 3 tasks | 11 files |
| Phase 07 P04 | 25min | 2 tasks | 9 files |
| Phase 07 P07 | 282min | 3 tasks | 10 files |
| Phase 07 P08 | 20min | 3 tasks | 5 files |
| Phase 07 P09 | 20min | 3 tasks | 4 files |
| Phase 07 P10 | 8min | 2 tasks | 4 files |
| Phase 07 P11 | 4min | 3 tasks | 3 files |
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 11 P01 | 3min | 3 tasks | 4 files |
| Phase 11 P02 | 28min | 3 tasks | 13 files |
| Phase 11 P03 | 25min | 2 tasks | 15 files |
| Phase 11 P04 | 35min | 2 tasks | 5 files |
| Phase 11 P05 | 50min | 3 tasks | 12 files |
| Phase 11-delivery-correctness P06 | ~55min | 3 tasks | 10 files |
| Phase 11 P07 | 35min | 2 tasks | 5 files |
| Phase 11 P08 | 90min | 3 tasks | 14 files |
| Phase 11 P09 | 75min | 3 tasks | 9 files |
| Phase 11-delivery-correctness P10 | ~70min | 3 tasks | 11 files |
| Phase 11 P11 | 50min | 3 tasks | 10 files |
| Phase 16 P07 | 4min | 3 tasks | 1 files |

## Accumulated Context

### Decisions

Full decision log for v1.0 lives in PROJECT.md (Key Decisions) and the archived phase summaries in .planning/milestones/v1.0-phases/.

**Phase 15 decisions (2026-08-17, full log in PROJECT.md and phase summaries):**

- Sentry-redaction CI-гейт (`check:sentry-redaction`, leak-фикстуры + negative control) собран ДО первого `Sentry.init()` в репозитории; `sentryBeforeSend` делегирует всё событие общему `scrub()` — второго rule-list'а не существует (Pitfall 18 закрыт)
- DSN-доставка исключительно через `env_file` (CR-01): compose-интерполяция `${VAR}` резолвится из invoking shell и молча стирала операторский DSN на каждом деплое; `IMAGE_TAG` — единственное легитимное исключение
- Worker-side Sentry-тэги читаются из job payload, не из ALS: `run()`-стор не переживает continuation boundary внешнего awaiter'а (доказано эмпирически); идентичное API-side ограничение задокументировано executable-тестом, не пофикшено (~10 route-модулей)
- `wrapProcessor` на всех 20 воркер-фабриках с filesystem-enumerating coverage-тестом; fallback `requestId → job.id` удалён (WR-03) — unbound поле честнее склейки двух осей корреляции
- Инфраструктурный конфиг парсится реальным бинарём в CI (урок G-15-4): `validate-alloy-config.mjs` = static-скан + `alloy fmt` под pinned-образом, resolved at run time из compose; `ALLOY_VALIDATE_REQUIRE_BINARY=1` в CI — недоступный Docker это violation, не skip
- `ops_alert_state` — одна keyed-таблица для всех watchdog'ов (миграция 0064), атомарный claim без seed-строки; terminal-сплит failed-send-share выведен из `SEND_STATUS_TRANSITIONS`, не hard-coded
- Миграция 0065 (human-approved override запрета «no new migration»): column-level `GRANT SELECT (last_event_at)` для webhook-lag — таблица несёт `path_token`/`public_key`, table-level grant недопустим
- Correlation ids остаются в JSON-теле логов (`| json` в LogQL), никогда не Loki-лейблы (кардинальность)

**Phase 13 decisions (2026-08-12, full log in PROJECT.md and phase summaries):**

- Dedup-ключ `send_events` пересажен с нестабильного `sg_event_id` на `(workspace_id, send_id, event_type, occurred_at)` (миграция 0057, expand/contract без DELETE, RAISE при выживших дублях); `sg_event_id` остаётся NOT NULL forensic-колонкой
- Erasure = обезличивание + hashed suppression (per-workspace HMAC-ключи, KMS-wrapped, TTL-кэш с зануляемым key material; плейнтекст email удалён из suppression — миграция 0061) + checkpointed scrub `send_events.payload`/`events.properties` по evidence-**allowlist** (deny-list не покрывает tenant-defined ключи) + reclaim-воркер для erasure, застрявших между commit и enqueue
- Webhook-батч журналируется в `ingress_journal` до enqueue; недоступность журнала → fail-closed 5xx (SendGrid ретраит); replay-sweep добирает не-ингестированные строки exactly-once; PII-prune оставляет tombstone-строки как evidence
- Дневные метрики: единая UTC-семантика (`AT TIME ZONE 'UTC'` во всех кастах) + dirty-day reconciliation абсолютной перезаписью дня (bounded 50 дней/тик, `dirtied_at <= sweep_start` против clear-race)
- Оба unsubscribe entry-пойнта сходятся в общем `applyUnsubscribeWithSendFact` (одна транзакция: статус + consent history + send fact + счётчик, идемпотентно к порядку и replay); public route отвечает byte-identical на все четыре исхода
- `occurred_at` ограничен до partition routing; out-of-range события — per-event в `send_event_quarantine` (7-дневный retention по server-set `received_at`, gap 13-16), батч не падает

**Phase 12 decisions (2026-08-11, full log in PROJECT.md and phase summaries):**

- Tenant-scoped rate_limited deferral (`job.moveToDelayed` + `DelayedError` через общий helper обоих send-лейнов) вместо worker-wide `worker.rateLimit()`; per-tenant-per-lane concurrency — TTL-leased Redis-семафор, release в `finally` на всех трёх dispatch-путях
- Все 11 queue-модулей обоих приложений строят connection options и job options только через `@mega-crm/queue-core`; cross-application single-definition тест падает при появлении локальной копии
- BullMQ Worker options передавать только при явном значении: `autorun: undefined` клоббepит default `true` (G-12-1 — пять tick-воркеров регистрировались, но не консюмили); фикс — conditional spread + regression-тест против реального Redis
- Retention failed jobs: 7 дней (строго больше 72h-горизонта reconciler'а, ~2.33x margin); `FLOW_RUN_ADVANCE_RETENTION` осознанно отдельный
- Kickoff-count assertions в burst-тестах — сумма по пяти состояниям очереди, не `completed` (ничто не консюмит CAMPAIGN_KICKOFF_QUEUE в harness'е; G-12-3)

**Phase 10 decisions (2026-08-09):** see .planning/phases/10-tenant-isolation-trust-boundaries/10-CONTEXT.md and the phase plan summaries.

**Phase 9 decisions (2026-08-07, full log in PROJECT.md):**

- `ensurePartitions` — единственный источник partition-DDL; CHECK-constraint-first attach безусловен на каждом attach; правило закреплено в CONVENTIONS.md
- Dead-man's switch двумя процессами: worker пишет `partition_maintenance_runs`, API-watchdog читает и шлёт plain-text алерт через platform SendGrid; `OPERATOR_ALERT_EMAIL` обязателен на boot; живая доставка подтверждена UAT
- Перенос строк из DEFAULT — только operator-invoked CLI (D-08) с батчами и `SKIP LOCKED`; никогда по расписанию
- Deviation 09-04: attach партиции с реальными строками триггерит FK-ревалидацию под FORCE RLS → admin-scan RLS policy (миграция 0039) + `SET LOCAL app.admin_scan` в `attachPartitionCheckFirst`
- Daily tick с фиксированным wall-clock часом — через BullMQ job-scheduler (`upsertJobScheduler`, стабильный id), не interval-form

**Phase 8 decisions (2026-08-06, full log in PROJECT.md):**

- Эфемерные тестовые БД с fail-closed DSN guard (без bypass-поверхности) во всех DB-workspace'ах и Playwright E2E; E2E без provisioned БД падает на boot
- Failure-injection — воспроизводимые npm-скрипты (429/timeout/reset/SIGKILL/Redis restart); SendGrid всегда фейк через `ProcessSendJobDeps.sendMail` seam; настраиваемый base URL отложен до Phase 16
- Coverage-гейт по неокруглённой дроби, порог = измерение + осознанный инкремент, с provenance
- Конфигурация/секреты вынесены из working root: резолвер `MEGA_CRM_ENV_FILE` с дефолтом вне репозитория; dev-скрипты без `--env-file`
- Branch protection: required checks static/test/failure-injection с admin enforcement; e2e — non-blocking

**v1.1 roadmap-level decisions (2026-07-27):**

| # | Decision | Rationale |
|---|----------|-----------|
| R-01 | Phase numbering continues from v1.0 — v1.1 is Phases 8-16, not a restart at 1 | Single continuous roadmap; v1.0 ended at Phase 7 |
| R-02 | Partition automation (DB-01..04) is its own minimal Phase 9, depending only on Phase 8 | Hard external deadline 2026-09-01; phase completion is the tracking unit, so "Phase 9 complete" must literally mean "deadline met". Bundling it with backups/TLS/pooling would hide the deadline mid-phase |
| R-03 | Postgres role separation (Phase 10) is sequenced **before** delivery correctness (Phase 11), diverging from research's Stage 3→5 order | DLV-03's reconciler and WRK-05's sweep are cross-tenant scans; sequencing the role first means each writes its admin-scan usage once, against the final role. Keeps all 9 DLV requirements in one cohesive phase |
| R-04 | Delivery correctness (11) and tenant-fair throttling (12) stay **separate adjacent** phases despite touching the same files | The phase boundary is a verification gate on the milestone's highest-risk change — the state machine must be *verified* before throttling edits the same files |
| R-05 | Deploy-safety resolved via **backward-compatible job payloads** (`schemaVersion`), not by front-loading the deployment track | Pulling Docker/VPS deployment ahead of delivery correctness would delay the audit's top finding behind ops work that itself depends on health endpoints (OPS-04/05). Phase 14 additionally adopts stop-old-then-start-new for the worker |
| R-06 | UAT-01..05 form their own final Phase 16 rather than attaching to the phases they verify | Named release barrier; needs a deployed env with a verified sender (Phase 14); each UAT spans 2+ phases; v1.0's accepted tech debt was precisely deferred live UAT |
| R-07 | Frontend resilience (OPS-16..19) folded into the observability phase rather than a standalone 4-requirement phase | Same goal from two sides: the system reports its true state to operators (logs/Sentry/alerts) and to users (error/empty/stale states). Avoids a thin phase |
| R-08 | 9 phases at `standard` granularity (nominal 4-6) | 95 requirements plus 8 hard sequencing constraints; further compression would either violate a dependency or produce 25+ requirement phases |

- [Phase ?]: Phase 11 plan 01 (D-18 gate, human-approved): dispatching->reconciling is the only two-writer transition (worker + reconciler stale-sweep); no reconciling/unknown -> failed transition exists (webhook evidence is positive-only); delivery model is at-most-once at SendGrid-acceptance, never exactly-once; ARCHITECTURE.md section 9's unknown->unknown self-loop annotation intentionally has no matrix row and was reviewed/accepted as-is.
- [Phase ?]: 11-02: send-status enum-parity test imports SEND_STATUSES from @mega-crm/delivery-core (added as packages/db devDependency) -- one source of truth for the six-value vocabulary, per 11-01's key_link
- [Phase ?]: 11-02: audit-sends-history.ts deviates from the plan's single-DATABASE_URL design (Rule 3) -- mega_crm_app cannot read sends/send_events cross-tenant at all under RLS's fail-closed predicate; uses a second SCAN_DATABASE_URL connection plus a rollback-only per-workspace loop instead, introducing no new grant
- [Phase ?]: 11-03: resolveReconcilingSend back-dates sent_at (COALESCE to dispatched_at/reconciling_since/queued_at) rather than now() -- workspace_daily_rollup groups by sent_at::date
- [Phase ?]: 11-03: DLV-04's retry-worker half is closed by a status branch (dispatchSendGate/claimFlowSend return skipped for reconciling/unknown), not by row locking -- FOR UPDATE SKIP LOCKED only protects reconciler-vs-reconciler
- [Phase ?]: 11-03: the interrupted branch stops incrementing campaign counters but the reconciler-side backfill is not yet implemented (later plan) -- campaigns with an unresolved reconciling send under-count until that lands
- [Phase ?]: 11-04: hand-rolled UUIDv5 over node:crypto (human decision at package gate) instead of the uuid npm package -- package.json/package-lock.json unchanged
- [Phase ?]: 11-04: sends.id for kind='campaign'/'flow' is now UUIDv5-derived from the send intent, computed inside each ledger function -- pre-existing rows keep their old random ids, no backfill
- [Phase ?]: classifyTransportError unwraps exactly one level of cause (undici fetch-failed wrapper), no deeper -- matches the actual runtime shape (Phase 11 plan 05)
- [Phase ?]: SEND_MAX_JOB_LIFETIME_MS adds one full SEND_LOCK_DURATION_MS of margin over the raw attempts*lock+backoff floor, strictly greater than it (Phase 11 plan 05)
- [Phase ?]: cause discriminator set at all six rate_limited return sites in send-dispatch.ts, including the two kind='test' sites not explicitly named in the plan action text, since the field is non-optional on SendJobResult (Phase 11 plan 05)
- [Phase ?]: 11-06: shared handleAmbiguousSendMailError helper decides classifyTransportError disposition once, invoked by both campaign and flow send branches, preventing per-path drift on what counts as ambiguous
- [Phase ?]: 11-06: flow-side interrupted claim now writes reconciling (not failed), reaching parity with the campaign path; no code in the send pipeline still writes failed for an outcome it did not observe
- [Phase ?]: 11-07: EVENT_FLAGS gains processed:true at both provisioning spread sites, deferred excluded; ingestion proven evidence-only (no production change needed -- normalizeEventType/webhook-events.worker.ts ordering already made processed inert); runbook documents no-automatic-backfill for existing tenants
- [Phase ?]: Reconciler's unknown->sent re-scan horizon measures age from queued_at (per plan spec), while the reconciling->unknown resolution window measures from reconciling_since (falling back to queued_at) -- two different anchors for two different transitions, both documented in reconciler.ts
- [Phase ?]: backfillCampaignSendCounter is exactly-once by construction of resolveReconcilingSend's exclusive row transition under FOR UPDATE SKIP LOCKED, not by a separate flag column
- [Phase ?]: tryCompleteCampaign's completion predicate counts reconciling/unknown rows toward sendable_total (dispatching excluded) so one ambiguous send cannot hang a campaign for the full resolution window
- [Phase ?]: Reconciler dead-man's-switch: health-row write mirrors partitions/maintenance-run.ts structurally, oldest_reconciling_since observed at discovery time (not post-resolution), watchdog dedup window shorter (6h) than partition-watchdog's (20h) to match the reconciler's own ~5min cadence
- [Phase ?]: Web/API send-log status vocabulary drift check pins a commented copy rather than cross-importing apps/api source (no package dependency exists between the two apps).
- [Phase ?]: email-broadcast.worker.ts/email-triggered.worker.ts processors factored into exported handleEmailBroadcastJob/handleEmailTriggeredJob (deps default {}) so the unknown-outcome-never-throws behavior is directly testable without duplicating branching logic.
- [Phase ?]: 11-11: boundary 3 covered state-based (arrangeCrashedBeforeResultWrite), not a second kill harness -- boundaries 2/3 are ledger-indistinguishable
- [Phase ?]: 11-11: reconciler-vs-retry race tolerates bounded follow-up ticks for liveness (dispatchSendGate's plain FOR UPDATE can legitimately win the lock ahead of the reconciler's SKIP LOCKED); the hard per-iteration invariant is the retry worker's own zero-call/never-transitions behavior
- [Phase ?]: 14-09: Worker replaced stop-old-then-start-new (R-05) with an explicit gone-check between; readiness observed via container health status, not an HTTP call from the host
- [Phase ?]: 14-09: Rollback reuses the same deploy sequence against an older SHA, printing a migration-tier warning rather than deciding the tier itself -- the runbook is where that judgement is made
- [Phase ?]: 14-10: One Dockerfile, two entrypoints -- `db` and the `pgbackrest` sidecar both build from the same custom Postgres 17 image (pgBackRest 2.59.0), sharing an identical binary, OS user and filesystem layout, because archive_command runs inside `db`'s own Postgres process
- [Phase ?]: 14-10: Retention is 2 full backups, count-based -- the actual recovery horizon plan 14-12's partition-drop retention tick depends on; post-checkpoint iteration added a CA trust store (20edff7, PR #10) so the image could verify the Cloudflare R2 repository's TLS certificate
- [Phase ?]: 14-11: PITR restore drill performed twice against the real off-host repository (marker absent before target, present after — both directions demonstrated); verification passed (partitions, RLS enabled-and-forced, row counts vs baseline); production untouched; scratch resources destroyed. DB-10 closed; satisfies the restore-drill precondition (D-08) for 14-12's retention deletion — the operator pre-enable checklist in data-retention.md (widen pgBackRest retention, flip PARTITION_RETENTION_ENABLED) still applies.
- [Phase ?]: 14-11: restore duration and disk high-water mark not reported at checkpoint approval — recorded as an open item to capture at the next scheduled drill, not invented. **Discharged 2026-08-20:** Phase 17 made the recording structural (`restore-drill.sh` self-records both figures) and a real drill captured `durationSeconds=119`/`diskHighWaterKb=170520`; T-14-73 closed by gsd-security-auditor re-run (`/gsd-secure-phase 17`).
- [Phase ?]: 14-11: post-checkpoint real-host iteration (8d31abe) — drill script's verification step needed to target the scratch database explicitly in local mode.
- [Phase 16]: Scope live webhook journal evidence to the captured raw_batch digest; keep migration 0057's four-column key for send_events. — Concurrent SendGrid fan-out can change workspace-wide journal totals and create false replay failures.
- [Phase 16]: Treat fe8fbbc6-6b25-490b-b3f5-7c739e325c9a as the current dedicated Phase 16 UAT workspace. — The effective production capture configuration, endpoint public-key hash, tenant-scoped send/contact ownership and decoded capture agree; earlier 16-01/16-02 references are stale.
- [Phase 16]: Commit live signed fixtures only after decode-and-inspect plus tenant ownership and endpoint-key verification; never edit or re-sign signed material. — A fixture enters permanent git history and must contain no third-party data while retaining byte-exact signature evidence.
- [Phase 16]: Freeze Date at the fixture timestamp for real-signature CI; never widen the webhook freshness tolerance. — This preserves both the signed bytes and the security gate indefinitely.
- [Phase 16]: Prove HTTP replay dedup by processing the two emitted queue payloads with the exported production webhook processor. — The API route stops at enqueue; querying send_events without the worker would be vacuous, while a test-local processor would duplicate production behavior.
- [Phase 16]: Keep the UAT fault proxy one-shot, workspace-targeted and internal-only; 429 never forwards while timeout always forwards once before delaying the response. — Reversing either branch creates the duplicate/lost-mail defect UAT-05 exists to detect.
- [Phase 16]: Preflight frequency-cap headroom for every live fault leg and restore any UAT-only temporary change. — The pre-send gate runs before the proxy, so an excluded campaign cannot exercise the armed fault.
- [Phase 16]: Start temporary proxy/worker services with compose --no-deps. — A UAT-only worker restart must not recreate production DB or Redis dependencies.
- [Phase ?]: Phase 16 Task 3 blocking checkpoint approved 2026-08-19: teardown 5/5 verified by observation, standing-canary smoke 1/1 delivered (send 6fadec0b, provider oIDnKGNTSO). Phase 16 closed at five-of-five live UAT passes (D-16); milestone v1.1 fully executed.

### Pending Todos

Open decisions to resolve at `/gsd-discuss-phase` (recorded in ROADMAP.md § Open Decisions):

- [x] **Phase 12 / WRK-02** — RESOLVED 2026-08-10 (D-01): Redis semaphore at the application layer, keyed per tenant + lane, TTL-leased; over-cap jobs defer through the same tenant-scoped path as the RPS ceiling.
- [x] **Phase 14 / DB-14** — RESOLVED 2026-08-12 (D-09): deferred to SCALE-02 as an explicit accepted decision; revisit trigger = real `max_connections` pressure. App-level pools get sizes + error handlers via shared `createPgPool` factory. See `.planning/phases/14-deployment-database-durability/14-CONTEXT.md`.

### Blockers/Concerns

**v1.1 pitfall warnings that change how a phase is built internally** (full detail in `.planning/research/PITFALLS.md`, carried into the affected phase sections of ROADMAP.md):

- **Phase 10 / SEC-03 (Pitfall 11):** RLS unification must go in the **fail-CLOSED (bare-cast)** direction. Standardizing on the NULLIF variant silently converts 12 currently-fail-closed tables (`contacts`, `sends`, `events`, `send_events`) to fail-open-to-zero-rows. SEC-04's test must assert the *thrown error*, not an empty result.
- **Phase 11 / DLV-03 (Pitfall 1):** the reconciler must claim rows exclusively (`SELECT ... FOR UPDATE SKIP LOCKED` inside `withTenantTransaction`) and the retry path must never call SendGrid for a row in `reconciling` — otherwise the fix recreates the duplicate-send bug one layer up.
- **Phase 11 (Pitfall 5):** the SendGrid `AbortController` timeout must be strictly below BullMQ's `lockDuration`, or a hung request gets stall-detected and double-scheduled.
- **Phase 11 (Pitfall 2):** the `send_status` enum change must not backfill historical rows in the same migration; verify `workspace_daily_rollup` totals are unchanged afterwards.
- **Phase 10 / SEC-05 (Pitfall 12):** adding RLS to Better Auth tables as a checklist item breaks login/signup/session validation platform-wide, with no SQL error.
- ~~Phase 14 (Pitfall 17): `CREATE UNIQUE INDEX CONCURRENTLY` over existing duplicates leaves an INVALID index~~ — closed by Phase 13 (миграция 0057: blocking parent-level build, RAISE unless `pg_index.indisvalid`, duplicate pre-check without DELETE).
- ~~Phase 15 (Pitfall 18): Sentry has no retroactive redaction — `beforeSend` scrub rules must be tested against representative leak payloads *before* Sentry receives live traffic~~ — closed by Phase 15 (15-06: `check:sentry-redaction` блокирующий CI-гейт собран до первого `Sentry.init()`; live UAT подтвердил отсутствие PII).

**Phase 15 open items (2026-08-17):**

- ⚠️ [Phase 15] Все пороги OPS-13-алертов и `STALE_DATA_LAG_THRESHOLD_MINUTES=15` — flagged assumptions, не валидированы реальной нагрузкой; константы и файлы названы в Threshold Tuning секциях runbook'ов
- ⚠️ [Phase 15] API-side Sentry gap: исключение внутри route-level `withTenant(...)` доходит до Sentry без `workspace_id` (`request_id` выживает); документировано + executable test, фикс = ~10 route-модулей
- ⚠️ [Phase 15] Два user-visible UI-дефекта из sweep'а 15-07 (вне scope фазы, follow-ups): `LaunchConfirmDialog` — упавший audience-breakdown молча скрывает карточку, кнопка запуска остаётся активной; `CsvImportWizard` — `if (!status)` смешивает loading и вечный fetch-fail без error-state/Retry
- ⚠️ [Phase 15] bullmq 5.79.1→5.79.4 lockstep bump (peer-требование `@bull-board/api@8.6.1`) — технически верифицирован, ждёт explicit human ratification классификации (15-16, coverage D8)
- ⚠️ [Phase 15] Робастность alloy-гейта: static-скан без backtick-raw-string state (false positive и false negative доказаны), untested image-resolution-fails branch, hardcoded образ в recovery-команде runbook'а — anti-patterns, backstop'ятся real-binary слоем CI

Research flags carried from v1.0:

- [Phase 3 → 4] Segments ship as on-the-fly evaluation bounded by statement_timeout (2s preview / 15s save-eval, 57014 → degraded/4xx) — the 100k–1M-contact benchmark is still outstanding; revisit materialized membership if Phase 4 broadcast audience selects hit the timeout at scale.
- ~~Phase 4: load-test triggered-vs-broadcast priority under a large broadcast~~ — closed by Phase 12 (12-05 D2: a tenant saturating its own broadcast lane does not cost its triggered-lane throughput; two-tenant fairness scenario in CI on every PR).
- Phase 5 (carried past completion): integration test that replays a real signed SendGrid payload through the full HTTP stack (raw-body verification) — worker-layer attribution test exists (05-13), HTTP-signature-layer replay does not.
- Phase 5 → hardening follow-up (05-REVIEW WR-01, now in PROJECT.md Active): worker ignores flattened workspace_id — with one BYO SendGrid key backing multiple workspaces, sibling workspaces' raw event payloads are persisted into each other's send_events (attribution unaffected; data-isolation concern).
- Operational prerequisite (any fresh environment): PLATFORM_SENDGRID_API_KEY / PLATFORM_MAIL_FROM must be a real SendGrid key + verified sender before verification/reset/invite emails work — placeholders cause a 500 on resend (hit and resolved during Phase 1 UAT). **Since Phase 8 (08-15) the env file lives OUTSIDE the working root** — location resolved via `MEGA_CRM_ENV_FILE` (default outside the repo); `.env` in the repo root is blacklisted by the hygiene check.
- Operational prerequisite (any fresh environment): REDIS_URL=redis://localhost:6379 required (in the externally-resolved env file, see above) before npm run dev boots api+worker.

### Quick Tasks Completed

| # | Description | Date | Commit | Status | Directory |
|---|-------------|------|--------|--------|-----------|
| 260722-q4t | Создать README.md в корне репозитория | 2026-07-22 | 939b816 | | [260722-q4t-readme-md](./quick/260722-q4t-readme-md/) |
| 260727-sfk | Audit SPECIFICATION.md as-built + relocate CLAUDE.md maintenance rule | 2026-07-27 | b63ca82 | Verified | [260727-sfk-specification-md-as-built-claude-md-spec](./quick/260727-sfk-specification-md-as-built-claude-md-spec/) |
| 260809-eqr | Close Phase 10 residual review findings WR-06/WR-07 + sync STATE.md to Phase 11 | 2026-08-09 | ebc754c | Complete | [260809-eqr-close-phase-10-residual-review-findings-](./quick/260809-eqr-close-phase-10-residual-review-findings-/) |
| 260811-qit | Append Codex follow-up review section to Phase 13 REVIEWS.md | 2026-08-11 | b37e7bd | Verified | [260811-qit-append-codex-follow-up-review-section-to](./quick/260811-qit-append-codex-follow-up-review-section-to/) |

### Roadmap Evolution

- Phase 17 added: Address tech debt: WR-06 + medium security follow-ups

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-08-19T08:22:35.889Z
Stopped at: Phase 17 context gathered
Resume file: .planning/phases/17-address-tech-debt-wr-06-medium-security-follow-ups/17-CONTEXT.md

## Operator Next Steps

- **Phase 16 complete (2026-08-19): 7/7 plans, UAT 5/5 live passes (UAT-01..05), Task 3 blocking checkpoint approved** — teardown 5/5 verified by observation, standing-canary smoke 1/1 delivered, production carries no residue of the UAT session. See 16-UAT-REPORT.md and 16-07-SUMMARY.md.
- **Milestone v1.1 Production Hardening (Phases 8-16) is now fully executed** (122/122 plans, 9/9 phases complete). Next step is milestone-level closeout (e.g. `/gsd-complete-milestone`), not further Phase 16 work.
- Phase 15 complete (2026-08-17): 22/22 plans (18 scoped + 4 gap-closure), UAT 5/5 passed (G-15-4 alloy-config gap closed by plan 15-22), verification passed, security verified (threats_open: 0). CORRECTION (2026-08-19, Phase 17): the UAT test-5 "live redeploy of the committed config confirmed" claim was recorded without evidence and contradicted the milestone audit's "outstanding" — Phase 17-05 established alloy on production for the first time (credentials provisioned, container started, RestartCount 0 across the full cutover session, seven Loki service labels confirmed); see 17-05-SUMMARY.md.
- Known operational item carried from Phase 12: `npm run db:migrate` (drizzle-kit CLI) hangs in the dev sandbox under Node v26 — migrations proven via test:migrations but not applied to the dev DB
- Residual items carried past Phase 16 close (not blockers): historical 16-01/16-02 workspace's continued existence not independently checked; an unconfirmed flow-editor UI error-boundary observation from an earlier interrupted session has no evidence artifact and is out of Phase 16's evidence-only scope.
- Branch note: per convention Phase 16 used branch `gsd/phase-16-live-sendgrid-verification` (Phase 15 branch: `gsd/phase-15-observability-alerting-frontend-resilience`)
