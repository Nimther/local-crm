# Mega CRM — B2C Marketing Automation Platform

## What This Is

Multi-tenant SaaS-платформа marketing automation для B2C-компаний — аналог Klaviyo по модели, но без модуля сделок и sales-пайплайна. Маркетологи компаний-тенантов управляют базой контактов и сегментами, строят триггерные цепочки (событие → условие → серия писем) в визуальном canvas-редакторе и запускают разовые broadcast-кампании по сегментам. Доставка — email через SendGrid (BYO API key у каждого тенанта), контент — через SendGrid Dynamic Templates.

## Core Value

Маркетолог настраивает триггерную цепочку или кампанию — и письма надёжно и вовремя доходят до нужных контактов, со сквозным отслеживанием статусов (delivered/opened/clicked/bounced) по каждому письму, шагу цепочки и кампании.

## Current State

**Phase 13 complete (2026-08-12):** compliance & analytics integrity (CMP-01..CMP-09) — см. запись в Current Milestone ниже. UAT 5/5, verification passed, security review 122/122 threats closed (threats_open: 0).

**Shipped:** v1.0 MVP (2026-07-14) — все 7 фаз roadmap завершены, 49/49 v1-требований выполнены, verified closeout.

Платформа работает end-to-end: регистрация → воркспейс → команда → BYO SendGrid key → контакты (UI/CSV/events API) → сегменты → broadcast-кампании и триггерные цепочки через общий throttled send pipeline → webhook-трекинг доставки с авто-suppression → аналитика (кампании, шаги цепочек, timeline контакта, дашборд, журнал отправок).

- **Кодовая база:** ~57k LOC TypeScript; npm-workspaces монорепо — `apps/api` (Fastify), `apps/web` (React 19/Vite), `apps/worker` (BullMQ), shared-пакеты `db`, `tenant-context`, `contacts-core`, `segments-core`, `delivery-core`, `flows-core`, `kms`, `shared-schemas`
- **Хранилища:** Postgres (RLS на всех tenant-таблицах, партиционированные `events`/`send_events`) + Redis (BullMQ, per-tenant token bucket)
- **Известный tech debt (принят при закрытии v1.0):** live-email внешние prerequisites (реальный PLATFORM_SENDGRID_API_KEY + verified sender), непройденные live SendGrid UAT click-through'ы, набор визуальных human-чеков — см. `.planning/milestones/v1.0-MILESTONE-AUDIT.md`

## Current Milestone: v1.1 Production Hardening

**Phase 13 complete (2026-08-12):** Compliance & Analytics Integrity — CMP-01..CMP-09, 16/16 планов (включая gap-closure 13-15/13-16), UAT 5/5 по пяти roadmap success criteria, security review 122/122 threats closed. Unsubscribe стал атомарным: оба entry-пойнта (public route и webhook worker) сходятся в общем `applyUnsubscribeWithSendFact` — статус подписки, consent history, `sends.unsubscribed_at` и счётчик кампании меняются ровно один раз в одной транзакции независимо от порядка и replay; public route отвечает byte-identical на все четыре исхода (нет token-оракула). Дневные метрики получили единую UTC-семантику (8 явных `AT TIME ZONE 'UTC'` кастов в `reconcileWorkspaceDay`, инвариантность к session timezone доказана тестами) и dirty-day reconciliation: поздние webhook-события помечают день грязным, bounded sweep (лимит 50 дней/тик) пересчитывает его абсолютной перезаписью — событие ложится на день, когда произошло, а не когда пришло. GDPR erasure end-to-end: обезличивание контакта + suppression по per-workspace HMAC-хэшу (плейнтекст-email удалён из suppression-таблицы, миграция 0061, KMS-wrapped ключи с TTL-кэшем и зануляемым key material), checkpointed scrub worker переписывает `send_events.payload`/`events.properties` по evidence-allowlist (deny-list не может покрыть tenant-defined ключи), reclaim-воркер добирает erasure, застрявшие между commit и enqueue; `erasure_records` — доказательство факта удаления; re-import бывшего external_id создаёт нового контакта, suppression продолжает отказывать. Целостность событий: `occurred_at` ограничен (7 дней назад / clock-skew вперёд) до partition routing, out-of-range события уходят per-event в `send_event_quarantine` (7-дневный retention по server-set `received_at`, gap 13-16) не роняя батч; dedup-ключ пересажен с нестабильного `sg_event_id` на `(workspace_id, send_id, event_type, occurred_at)` (миграция 0057, expand/contract без DELETE). Webhook-доставка стала durable: verified-батч журналируется в `ingress_journal` до enqueue (fail-closed 5xx при недоступности журнала → SendGrid ретраит), replay-sweep добирает не-ингестированные строки exactly-once, PII-payload журнала prune'ится с tombstone-строками как evidence. Reputation/ingestion watchdogs: hourly tick считает complaint/hard-bounce rates с floor=500, alert state per (workspace, metric) с claim-based дедупом и cooldown, эскалация в critical шлёт немедленно; алерты оператору и tenant-членам через platform key (никогда tenant BYO), в телах алертов нет PII (assert'ы в тестах). As-built документация сверена с кодом (SPECIFICATION/ARCHITECTURE, coverage matrix 25 capabilities). Ветка `gsd/phase-13-compliance-analytics-integrity`.

**Phase 12 complete (2026-08-10):** Worker Reliability & Tenant Fairness — WRK-01..WRK-11, WRK-13 verified 12/12 must-haves, 5/5 roadmap success criteria. Worker-wide `worker.rateLimit()` заменён на tenant-scoped deferral (`job.moveToDelayed` + `DelayedError` через общий helper обоих send-лейнов); per-tenant-per-lane concurrency cap — TTL-leased Redis-семафор, вшитый во все три dispatch-пути `send-dispatch.ts` (release в `finally` на всех исходах); fairness доказана измерением (two-tenant CI-сценарий) и `DEFAULT_TENANT_RPS` подтверждён sustained-run'ом; segment sweep переписан в bounded checkpointed walk (миграция 0053, kill-resume сценарий с реальным SIGKILL); терминальные падения джобов durable в Postgres (`dead_letter_jobs`, миграция 0054, redacting writer) + watchdog в другом процессе (`apps/api`); graceful shutdown закрывает все Queue handles внутри drain budget; общие error listeners на всех воркерах; retention failed jobs ограничен 7 днями с invariant-тестом на каждый constructed queue; все 11 queue-модулей обоих приложений сведены в `@mega-crm/queue-core` с cross-application single-definition тестом. Code review: 0 blockers, 3 warnings (WR-03 — percent-encoded Redis-пароль не декодируется в `queue-core/connection.ts`, fails loudly at boot; открыт). Известное: `npm run db:migrate` (drizzle-kit CLI) виснет в dev-sandbox под Node v26 — миграции 0053/0054 доказаны через test:migrations (56/56), но на dev-БД не применены. UAT (43 теста, 2026-08-11) закрыл три гэпа: G-12-1 (план 12-12 — пять tick-воркеров регистрировали scheduler, но не консюмили: `autorun: undefined` перекрывал default; live cold-start re-test пройден), G-12-2 (план 12-13 — doc staleness в ARCHITECTURE/SPECIFICATION), G-12-3 (план 12-14 — burst-absorption dedup-assertion была vacuous против пустой БД; теперь seeded end-to-end proof: exactly-one kickoff по пяти состояниям + transition-once re-check + control case, RED-evidence `expected +0 to be 1` зафиксирован в 12-14-SUMMARY.md). Final re-verification: passed 16/16. Code review 12-14-скоупа: 0 critical, 3 warnings (test-hygiene: утечка kickoff-Queue handle в двух старых кейсах, отсутствие таймаута на pickup-probe, non-optional return type `readDueCampaignState`). Ветка `gsd/phase-12-worker-reliability-tenant-fairness` (stacked на phase-11).

**Phase 11 complete (2026-08-09):** Delivery Correctness — DLV-01..DLV-09 verified 9/9, 5/5 roadmap success criteria. `sends.status` получил два честных состояния: `reconciling` («ещё выясняем, что произошло») и `unknown` («выяснить не удалось — письмо могло дойти и могло потеряться»), зафиксированные в `ARCHITECTURE.md` §9 как reviewed design artifact (D-18 gate) с исполняемым зеркалом `send-state-machine.ts` (`satisfies Record<SendStatus, …>`). Транзишена `reconciling → failed` не существует по построению — `ReconcileVerdict` не имеет члена `resolve_failed`, потому что webhook-evidence positive-only. Миграции 0047–0052; reconciler в отдельном воркере классифицирует только по `send_events` (D-01, ноль provider-вызовов), cross-workspace discovery через `mega_crm_scan`; `sends.id` — UUIDv5 от send intent (hand-rolled над `node:crypto`, сверено с эталонной Python `uuid5`; зависимость `uuid` осознанно не добавлена); SendGrid-вызов ограничен `SENDGRID_TIMEOUT_MS` при машинно-проверяемом неравенстве `timeout + margins < lockDuration`; ambiguous-исход на обоих send-путях идёт через один общий helper; dead-man's switch — health-row на каждый tick + watchdog в **другом процессе** (`apps/api`), причём P3-свойство Phase 10 сохранено (`SCAN_DATABASE_URL` в API-схему не попал). 8 failure-injection сценариев в CI, три границы краха покрыты реальным SIGKILL. Code review нашёл и закрыл Blocker CR-01 (reconciler мог ослепнуть: `unknown`-строки за 72h-горизонтом занимали весь батч и вытесняли живые `reconciling` — регресс-тест подтверждён падающим до фикса) и WR-01 (индекс не подходил под предикат запроса watchdog'а, миграция 0052). Осознанно оставлены открытыми: WR-02 (raw throw в claim gate под узкой гонкой), WR-03 (мёртвый `{ kind: "failed" }` в union). Ветка `gsd/phase-11-delivery-correctness` (stacked на phase-10).

**Phase 10 complete (2026-08-08, gap closure 2026-08-09):** Tenant Isolation & Trust Boundaries — SEC-01..SEC-16 verified 16/16. Dedicated least-privilege роли `mega_crm_scan`/`mega_crm_auth` заменили marker-GUC `app.admin_scan` (миграции 0041–0045); все 22 tenant RLS-политики переписаны fail-closed (0044); API-key scopes enforced (0046); anti-enumeration, webhook timestamp window, распределённый rate limiter, общий redaction-пакет; кросс-тенантный отказ доказан негативными сьютами (24 API + 14 worker тестов). UAT-гэп G-10-1 (cold start: `ensure-db-roles.mjs` не загружал внешний env-файл) закрыт планом 10-15 — предзагрузка через `resolveEnvPath()` + автогвард на всю predev-цепочку; re-verification passed 21/21. Ветка `gsd/phase-10-tenant-isolation-trust-boundaries` (stacked на phase-09, PR #7 ещё открыт).

**Goal:** Довести Mega CRM от функционально готового MVP до системы, которую можно эксплуатировать в production: корректность отправок на границах сбоев, доказанная изоляция тенантов, честные compliance и analytics, ограниченные и отказоустойчивые фоновые процессы, автоматизированный жизненный цикл БД и полный эксплуатационный контур.

**Источник требований:** `.planning/AUDIT-2026-07-27-production-readiness.md` — внешний аудит v1.0 (27.07.2026). Все findings в scope: High + Medium-High + Medium.

**Target features:**

1. **Quality gates** — CI, lint/coverage, изолированный Playwright E2E (не может использовать dev-БД), migration tests, failure-injection harness, repository hygiene (`.env`/`dump.rdb` из корня), правило обновления `SPECIFICATION.md`/`ARCHITECTURE.md`/`CONVENTIONS.md` (последние два создаются в этом milestone)
2. **Delivery correctness** — tenant-local throttling вместо глобального `worker.rateLimit`, timeout+`AbortController` на SendGrid, формальная delivery state machine с `unknown`/`reconciling`, зафиксированная at-most-once/effectively-once модель, correlation ID, crash-тесты на трёх границах
3. **Security & tenant isolation** — admin-scan RLS через отдельную DB role, унификация RLS-политик, trust boundary Better Auth, API key scopes, webhook replay protection, invite privacy, распределённый rate limit, secrets/redaction, единый `resolveWorkspaceMember`, одинаковое anti-enumeration поведение, отрицательные cross-tenant тесты (API + фоновые jobs), WR-01
4. **Compliance & analytics** — атомарное unsubscribe-событие с propagation в send analytics, единая UTC-семантика дневных метрик, consent history через обезличивание с сохранением evidence, ограничение provider `occurred_at` + server receive time, metrics reconciliation
5. **Worker reliability** — bounded segment sweep (keyset pagination + checkpoint), короткие транзакции, graceful shutdown с закрытием всех Queue handles, единые worker error listeners, retention failed jobs, общая queue factory (Redis options + `defaultJobOptions` + TTL), валидация `DEFAULT_TENANT_RPS` нагрузкой, dead-letter
6. **Database lifecycle** — автопартиции на 2–3 месяца вперёд с мониторингом, перенос данных из DEFAULT, migration pipeline с gate/rollback/roll-forward, backup/PITR + restore drill, retention, недостающие constraints, TLS и pooling
7. **Observability, deployment & performance** — Dockerfiles + деплой на self-hosted VPS с документированным rollback, `/healthz`+`/readyz`, Sentry, hosted logs с redaction, correlation (`request_id`/`tenant_id`/`job_id`/`send_id` + trace), alerts (queue depth, oldest job age, webhook lag, send failures), Bull Board, runbooks, frontend route-level code splitting и обработка error/empty/pagination/stale-analytics состояний

**Definition of Done (глобальный):** каждое замечание аудита должно быть исправлено, опровергнуто проверкой либо оформлено как явно принятое решение с владельцем и сроком. Незакрытых Critical/High в delivery, tenant isolation и compliance быть не должно.

**Жёсткий дедлайн:** партиции `events`/`send_events` заведены только по август 2026 — автопартиции (область 6) должны закрыться **до 1 сентября 2026**, иначе данные пойдут в DEFAULT partitions. ✓ **Закрыт Phase 9 (2026-08-07):** миграция 0038 + `ensurePartitions` дают 20 attached партиций (2026-09…2027-06), подтверждено catalog-запросом к мигрированной БД.

**Открытое решение внутри milestone:** trust boundary Better Auth (аудит 4.3) — отдельная DB role с минимальными привилегиями против RLS на `organization`/`session`/`account`. Требует архитектурной проработки на discuss-phase.

## Business Context

- **Customer**: B2C-компании (e-commerce, подписочные сервисы); пользователи — их маркетологи
- **Revenue model**: SaaS-подписка (детали тарификации — вне scope v1)
- **Success metric**: тенанты стабильно отправляют кампании и цепочки через платформу (активные воркспейсы с регулярными отправками)
- **Strategy notes**: —

## Requirements

### Validated

- [x] Multi-tenant воркспейсы: регистрация, приглашение команды по email, базовые роли (Owner/Admin/Member) — Validated in Phase 1: Workspace Foundation & Team Access
- [x] Подключение SendGrid (connect-половина): тенант привязывает свой API key, ключ валидируется на подключении и хранится зашифрованным (envelope encryption) — Validated in Phase 1; отправка от имени тенанта остаётся в Active
- [x] Управление контактами: CRUD в UI, CSV-импорт с маппингом колонок, Contacts CRUD API, автосоздание из событий (upsert) — Validated in Phase 2: UAT 13/13 (CRUD, CSV wizard с dry-run/отчётом об ошибках, upsert из событий)
- [x] Идентификация контакта: external_id (основной ключ) + email (запасной) — Validated in Phase 2: приоритет external_id→email в shared upsert, external_id иммутабелен после установки (D-06)
- [x] Event ingestion: server-side HTTP API с API-ключом, свободная схема событий (имя + JSON-свойства, как у Klaviyo) — Validated in Phase 2: POST /v1/events + BullMQ ingest worker, идемпотентность per-tenant, live event feed в карточке контакта
- [x] Сегментация: динамические сегменты по свойствам профиля И по поведению/событиям («сделал заказ за 30 дней», «не открывал письма») — Validated in Phase 3: компилятор условий (fails-closed allow-list → SQL с bind-параметрами), builder UI с live preview-count, статусы degraded при таймауте, RLS-изоляция, UAT 2/2
- [x] Broadcast-кампании: создание (сегмент + Dynamic Template), тестовое письмо, запуск/планирование, state machine draft → scheduled → sending → sent, live-прогресс — Validated in Phase 4: verification 5/5, полный send loop подтверждён
- [x] Отправка через SendGrid v3 mail/send + Dynamic Templates от имени тенанта (BYO key, send-половина) — Validated in Phase 4: расшифровка tenant key → mail/send с template_id + dynamic_template_data, one-click List-Unsubscribe header, working unsubscribe endpoint (включая RFC 8058 urlencoded POST, gap-closure 04-14)
- [x] Очередь отправки с контролем RPS: разделённые очереди email:triggered / email:broadcast, per-tenant token bucket (rate-limiter-flexible), идемпотентность отправок на ретраях, suppression-фильтрация перед отправкой — Validated in Phase 4
- [x] SendGrid Event Webhook: обработка delivered/opened/clicked/bounced/unsubscribed/spam/dropped — Validated in Phase 5: per-tenant signed webhook (ECDSA по raw body до парсинга), дедупликация по sg_event_id, статусы на каждом send + счётчики кампаний, авто-provisioning вебхука при подключении ключа (Klaviyo-модель) с self-healing Reconnect; live UAT round 6 подтвердил инкремент delivered/opened метрик
- [x] Статус подписки: платформа ведёт свой subscription status — Validated in Phase 5: bounce/spam/unsubscribe из webhook автоматически переводят контакт в suppressed/unsubscribed (введён в Phase 2, pre-send gate и one-click unsubscribe в Phase 4, webhook-driven suppression в Phase 5)

- [x] Триггерные цепочки: визуальный canvas-редактор с drag-and-drop (узлы, ветвления, соединения) — Validated in Phase 6: canvas builder (@xyflow/react, 5 типов узлов, autosave с honest error state), atomic publish с immutable versioning (draft → live → paused), publish-time валидация графа (включая cycle_detected / no_entry, gap-closure round 3); verification 4/4
- [x] Правила цепочек: exit conditions, контроль повторного входа (once ever / once per N days / every time), quiet hours, глобальный frequency cap на контакт — Validated in Phase 6: exit conditions + reconciliation, re-entry control (leave→rejoin для segment-triggered восстановлен в round 3), dispatch-time quiet hours с deferral, отправка через общий send pipeline с suppression и frequency cap

- [x] Аналитика: метрики по кампаниям и шагам цепочек (sent/delivered/opened/clicked/bounced/unsubscribed), timeline активности в карточке контакта, сводный дашборд воркспейса, по-письмовый лог отправок с фильтрами — Validated in Phase 7: Analytics, Dashboard & Send Log — verification 9/9 (D-01 rates + «Пропущено» breakdown на кампаниях, flow node badges + таблица «Аналитика», unified timeline контакта, rollup-дашборд (Recharts) с трендами и ростом базы, «Журнал отправок» с фильтрами contact/campaign-or-flow/status/period и drawer; 2 gap-closure раунда: campaign-фильтр после сброса (07-10), cmdk identity по id (07-11))

- [x] Quality gates: CI, lint/coverage, изолированный E2E, migration tests, failure-injection harness, repository hygiene, зафиксированные `ARCHITECTURE.md`/`CONVENTIONS.md` с правилом обновления — Validated in Phase 8: UAT 100/100 (86 автоматических, 14 human-чеков); 4 CI-джоба зелёные на реальном push, branch protection с admin enforcement блокирует красный PR; эфемерные тестовые БД с fail-closed DSN guard во всех DB-workspace'ах и Playwright E2E; migration линтер (enum/destructive DDL) + migration-цепочка на пустой и населённой БД с проверкой RLS ENABLED+FORCED; failure-injection harness (429/timeout/reset/SIGKILL/Redis restart) без единого обращения к реальному SendGrid; coverage-гейт по неокруглённой дроби; секреты вынесены из working root (MEGA_CRM_ENV_FILE)
- [x] Worker reliability: фоновые процессы ограничены по объёму, переживают рестарт и наблюдаемы (bounded sweep, graceful shutdown, retention, dead-letter) — Validated in Phase 12: UAT 43/43 (тенантная fairness доказана two-tenant CI-сценарием ≥90% baseline, bounded checkpointed segment sweep с kill-resume под реальным SIGKILL, durable dead-letter в Postgres + watchdog в другом процессе, 7-дневный retention failed jobs с invariant-тестом, graceful shutdown в пределах drain budget, все 11 queue-модулей сведены в @mega-crm/queue-core)
- [x] Compliance & analytics: отписка атомарно доходит до подписки, consent history и метрик; дневные метрики согласованы по единой UTC-семантике; удаление контакта обезличивает данные с сохранением compliance evidence — Validated in Phase 13: UAT 5/5 (атомарный unsubscribe с идемпотентным replay, session-timezone-независимые дневные метрики + dirty-day reconciliation поздних событий, erasure end-to-end включая scrub payload'ов и hashed suppression, quarantine out-of-range событий + dedup redelivery, journal replay после падения воркера + reputation-алерты с cooldown/эскалацией)

### Active

Scope milestone v1.1 Production Hardening. Детализация с REQ-ID — в `.planning/REQUIREMENTS.md`, первоисточник — `.planning/AUDIT-2026-07-27-production-readiness.md`.

- [ ] Delivery correctness: ни одно письмо не теряется, не дублируется и не классифицируется ложно при сбоях SendGrid, таймаутах и падении процесса
- [ ] Tenant isolation: один тенант не может затормозить отправку остальных; межтенантный доступ невозможен и доказан отрицательными тестами (включая WR-01 — отбрасывание событий чужого workspace при общем BYO-ключе)
- [ ] Database lifecycle: партиции, миграции, бэкапы и retention автоматизированы; restore drill отработан — *частично закрыто Phase 9 (2026-08-07): автопартиции `events`/`send_events` (+10 месяцев горизонта, дедлайн 2026-09-01 закрыт фактом каталога), daily maintenance job + watchdog c operator-алертом, relocation CLI из DEFAULT; остаются миграционный pipeline, бэкапы/PITR, retention, TLS/pooling*
- [ ] Observability, deployment & performance: сервис деплоится в Docker на VPS, сообщает о готовности, ошибки и метрики видны, алерты настроены, есть runbook'и; frontend bundle разделён по маршрутам

### Out of Scope

- Модуль сделок / sales-пайплайн — платформа для маркетинга, не для продаж; принципиальное решение
- ИИ-генерация контента и автоперевод — не в первом этапе
- Каналы кроме email (SMS, push, мессенджеры) — MVP-канал только email
- Собственный редактор шаблонов писем — шаблоны и переменные живут в SendGrid Dynamic Templates; платформа передаёт только template_id и данные
- JS-сниппет onsite-трекинга (просмотры страниц, брошенная корзина через браузер) — события в v1 только через server-side API
- Батч-интеграции с e-commerce платформами — отложено; в v1 CSV-импорт и API
- Общий SendGrid-аккаунт платформы (subusers, верификация доменов) — v1 работает по модели BYO key
- Строгие схемы/валидация событий — свободная модель как у Klaviyo; реестр типов возможен позже
- Биллинг/тарификация тенантов — не в v1

## Context

- Brownfield после v1.0: ~57k LOC TypeScript, 616 коммитов за 13 дней (2026-07-02 → 2026-07-14); стек Fastify + Drizzle/Postgres(RLS) + BullMQ/Redis + React 19/Vite + @xyflow/react подтверждён в бою
- Референс продуктовой модели — Klaviyo (flows, сегментация, событийная модель)
- Целевой масштаб первого года: 100k–1M контактов суммарно по тенантам, сотни тысяч писем в день — сегментация и отправка спроектированы под этот объём (партиционирование, батчинг, изоляция очередей), но бенчмарк сегментации на реальном объёме ещё не проводился
- Canvas-редактор цепочек (@xyflow/react) оказался ожидаемо самым дорогим UI-компонентом — Phase 6 заняла 24 плана из 96; ставка на TypeScript/React-экосистему оправдалась
- Паттерн исполнения: каждая фаза закрывалась через verifier + UAT + gap-closure раунды (до 5 раундов в Phase 4/5) — итеративное дозакрытие гэпов оказалось нормой, не исключением

## Constraints

- **Tech stack**: TypeScript full-stack (React на фронте, Node на бэке, Postgres + Redis/очередь) — один язык везде, богатая экосистема для canvas-UI; конкретные фреймворки уточняются на ресёрче
- **Delivery**: SendGrid Transactional API v3 (mail/send) + Dynamic Templates — контент на стороне SendGrid, платформа не рендерит письма
- **Delivery model**: BYO SendGrid API key у каждого тенанта — репутация домена и шаблоны в аккаунте тенанта
- **Architecture**: очередь отправки с троттлингом RPS закладывается в MVP с самого начала — rate limits SendGrid не должны ронять отправку при росте базы; broadcast-кампании не должны блокировать триггерные письма (приоритизация/изоляция потоков)
- **Multi-tenancy**: изоляция данных тенантов с первого дня — воркспейс как граница всех данных
- **Compliance**: собственный статус подписки и suppression перед каждой отправкой — обязательная часть email-маркетинга

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Multi-tenant SaaS с первого дня | Продукт для многих компаний, не внутренний инструмент | ✓ Phase 1: shared schema + tenant_id + RLS работает; изоляция доказана chaos-тестом пула и UAT-тестом изоляции |
| BYO SendGrid key у тенанта | Проще для MVP: репутация домена, шаблоны и верификация — в аккаунте тенанта | ✓ Phase 1 (connect-половина): live-валидация ключа + KMS envelope encryption подтверждены UAT с реальными ключами |
| Canvas drag-and-drop редактор цепочек в v1 | Ключевой дифференциатор UX, как Klaviyo/n8n; принято осознанно несмотря на стоимость | ✓ Phase 6: canvas builder на @xyflow/react (5 типов узлов, autosave с honest error state, publish-валидация графа) прошёл полный UAT 13/13; цепочки переиспользуют общий send pipeline (suppression, frequency cap, per-tenant RPS) |
| Свободная схема событий (имя + JSON) | Минимум трения при интеграции, модель Klaviyo; типы появляются в UI по мере поступления | ✓ Phase 2: события с произвольным JSON-payload принимаются, отображаются в feed; reserved-key denylist защищает системные свойства |
| external_id + email, upsert контакта из события | Стабильная идентификация при смене email; событие может создать контакт | ✓ Phase 2: shared upsert (contacts-core) используется API, CSV-воркером и event-воркером; конфликты email → D-04 hard error |
| Собственный subscription status + фильтрация перед отправкой | Статус виден в платформе и участвует в сегментации; не полагаемся только на SendGrid suppression | ✓ Phase 4+5: pre-send gate перед каждой отправкой (Phase 4); bounce/spam/unsubscribe из webhook автоматически переводят контакт в suppressed/unsubscribed (Phase 5) — цикл замкнут |
| Авто-provisioning Event Webhook (Klaviyo-модель, D-01/D-02) | Маркетолог не настраивает вебхук вручную — платформа сама создаёт/чинит его ключом тенанта | ✓ Phase 5: provisioning на connect/recheck, workspace-scoped friendly_name, PATCH-in-place, self-healing Reconnect, типизированные диагностируемые ошибки с курируемой копией |
| Поведенческая сегментация в v1 | Ядро ценности Klaviyo-подобного продукта; без неё триггерные сценарии слабые | ✓ Phase 3: единый компилятор SegmentDefinition → SQL (EXISTS-подзапросы по событиям, count/timeframe), on-the-fly вычисление со statement_timeout вместо материализации; движок общий для кампаний (Phase 4) и цепочек (Phase 6) |
| Сегменты вычисляются on-the-fly (без материализации membership) | Проще и всегда актуально; DoS-риск ограничен statement_timeout + degraded-ответом | ✓ Phase 3: preview-count 2s / save-eval 15s timeout, 57014 → degraded/4xx; бенчмарк на 100k–1M контактов остаётся открытым флагом |
| Очередь + RPS-троттлинг в MVP | Rate limits SendGrid; broadcast не должен блокировать триггерные письма | ✓ Phase 4: две BullMQ-очереди (email:triggered / email:broadcast) с отдельными воркерами, per-tenant token bucket через rate-limiter-flexible, идемпотентный dispatch без дублей на ретраях |
| TypeScript full-stack | Один язык, экосистема canvas-библиотек (React Flow и т.п.) | ✓ Phase 1: Fastify + Drizzle + React/Vite стек собран и прошёл полный UAT |
| Команда + базовые роли (Owner/Admin/Member) в v1 | SaaS для команд маркетинга; права на запуск кампаний и смену SendGrid-ключа | ✓ Phase 1: инвайты, серверная ролевая матрица и role-gated UI подтверждены UAT |
| v1.1: production hardening отдельным milestone, без переписывания | Аудит 27.07.2026 оценил готовность к production 6/10 при качестве реализации 7,5/10; риски на границах сбоев, а не в CRUD-коде | — Pending (milestone v1.1) |
| v1.1: деплой — Docker на self-hosted VPS | Полный контроль над окружением, приемлемая ops-нагрузка для текущего размера команды | — Pending (milestone v1.1) |
| v1.1: observability — SaaS (Sentry + hosted logs/metrics) | Быстрый запуск без содержания собственного стека мониторинга; провайдер логов уточняется на ресёрче | — Pending (milestone v1.1) |
| v1.1: удаление контакта обезличивает данные, compliance evidence сохраняется | Баланс между правом на забвение (GDPR erasure) и доказуемостью законности отправки/suppression в споре | — Pending (milestone v1.1) |
| v1.1: live SendGrid UAT — обязательный шаг фаз, не отложенный tech debt | Аудит назвал его выпускным барьером; аккаунт и verified sender доступны, блокера больше нет | — Pending (milestone v1.1) |
| Эфемерные тестовые БД с fail-closed DSN guard вместо общей dev-БД в тестах | Тесты, пишущие в dev-БД, маскируют баги и портят данные; guard без bypass-поверхности отсекает это классом, а не дисциплиной | ✓ Phase 8: все DB-workspace'ы и Playwright E2E самостоятельно создают/удаляют эфемерную БД; запуск E2E без provisioned БД падает на boot вместо тихого доступа к dev |
| Failure-injection как воспроизводимые npm-скрипты, SendGrid всегда фейк через `ProcessSendJobDeps.sendMail` seam | Границы сбоев (429/timeout/reset/SIGKILL/Redis restart) — главный риск аудита; сценарии должны быть детерминированными и запускаемыми в CI | ✓ Phase 8: пять audit-named сценариев зелёные и детерминированные; ни один не достигает реального SendGrid; настраиваемый base URL осознанно отложен до Phase 16 |
| Coverage-гейт по неокруглённой дроби с записанным порогом и provenance | Округление и смена deominator'а — типовые пути тихой деградации гейта; порог = измерение + осознанный инкремент | ✓ Phase 8: один агрегированный отчёт с одним знаменателем; 0.84996 не проходит порог 0.85; понижение порога — красная проверка |
| `ensurePartitions` — единственный источник partition-DDL; CHECK-constraint-first attach безусловно на каждом attach | Фаза существует потому, что «safe by default» уже однажды подвёл: full-scan под `ACCESS EXCLUSIVE` при attach к непустому DEFAULT | ✓ Phase 9: миграция 0038 (+10 мес. горизонта, дедлайн 2026-09-01 закрыт фактом каталога), daily job (`upsertJobScheduler`, 03:00 UTC) + boot-time repair + test fixture зовут одну и ту же функцию; правило закреплено в CONVENTIONS.md |
| Dead-man's switch двумя процессами: worker пишет health-строку, API-watchdog читает и шлёт plain-text алерт | Наблюдатель не должен разделять судьбу наблюдаемого; алерт-канал не должен зависеть от шаблона в SendGrid-аккаунте | ✓ Phase 9: `partition_maintenance_runs` + `claimAlertSlot` (атомарный дедуп 20ч между репликами); `OPERATOR_ALERT_EMAIL` обязателен на boot; живая доставка подтверждена UAT |
| Перенос строк из DEFAULT — только operator-invoked CLI (D-08), никогда по расписанию | `DELETE`/`INSERT` по живым tenant-таблицам не должен запускаться без человека; батчи + `SKIP LOCKED` вместо длинного эксклюзивного лока | ✓ Phase 9: `relocate:default-partition-rows` + runbook; CLI падает non-zero при ненулевом остатке; unattended-запуск исключён source-проверками |
| Admin-scan RLS policy для FK-ревалидации при attach (миграция 0039) | Attach партиции с реальными строками триггерит ревалидацию наследуемых FK против `contacts`/`sends` под FORCE RLS — обнаружено выполнением, не планированием | ✓ Phase 9 (deviation 09-04): `SET LOCAL app.admin_scan` внутри `attachPartitionCheckFirst` по прецеденту существующих admin-scan политик |
| Tenant-scoped deferral вместо worker-wide `worker.rateLimit()` + TTL-leased Redis-семафор для per-tenant-per-lane concurrency | Один тенант, упёршийся в свой RPS/concurrency-потолок, не должен останавливать воркер для всех остальных; BullMQ OSS не имеет group-rate-limiting | ✓ Phase 12: `job.moveToDelayed` + `DelayedError` через общий helper обоих send-лейнов; fairness доказана two-tenant CI-сценарием (B ≥ 90% собственного baseline при насыщении A) |
| Опции BullMQ Worker передавать только когда заданы явно — `autorun: undefined` перекрывает default `true` | UAT G-12-1: пять tick-воркеров регистрировали scheduler, но никогда не консюмили — `Object.assign` в BullMQ клоббepит default собственным `undefined`-ключом | ✓ Phase 12 (план 12-12): conditional-spread во всех пяти фабриках + regression-тест worker-autorun-default.test.ts против реального Redis |
| Dedup-ключ событий пересажен с `sg_event_id` на `(workspace_id, send_id, event_type, occurred_at)` | `sg_event_id` нестабилен между redelivery одного и того же события — дедуп по нему пропускает дубли; provider id остаётся NOT NULL forensic-колонкой | ✓ Phase 13 (миграция 0057): expand/contract без DELETE, RAISE при выживших дублях, redelivery с новым sg_event_id дедупится в одну строку (UAT test 4) |
| Erasure = обезличивание + hashed suppression + allowlist-scrub, не физическое удаление | GDPR right-to-erasure против доказуемости законности suppression в споре: evidence (send facts, suppression, `erasure_records`) сохраняется, PII — нет; deny-list не может покрыть tenant-defined ключи payload'ов | ✓ Phase 13: per-workspace HMAC-ключи (плейнтекст email удалён из suppression, миграция 0061), checkpointed scrub по evidence-allowlist, reclaim-воркер добирает застрявшие erasure, re-import бывшего контакта создаёт нового и suppression продолжает отказывать |
| Webhook-батч журналируется до enqueue; при недоступности журнала — fail-closed 5xx | Молчаливое расхождение между принятым и обработанным хуже отказа: SendGrid ретраит ~24h, replay-sweep добирает не-ингестированные строки exactly-once | ✓ Phase 13: `ingress_journal` + replay sweep + tombstone-строки как evidence после PII-prune; потеря ингестии видна watchdog'у, а не исчезает на retention-горизонте (UAT test 5) |
| Дневные метрики: единая UTC-семантика + dirty-day reconciliation вместо инкрементальных поправок | Поздние события должны ложиться на день, когда произошли; инкременты по живой таблице расходятся — абсолютная перезапись дня идемпотентна | ✓ Phase 13: `AT TIME ZONE 'UTC'` во всех кастах `reconcileWorkspaceDay`, session-timezone-инвариантность доказана тестами; bounded dirty-day sweep (50 дней/тик) с `dirtied_at <= sweep_start` против clear-race (UAT test 2) |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-12 after Phase 13*
