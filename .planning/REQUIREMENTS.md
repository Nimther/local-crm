# Requirements: Mega CRM — Milestone v1.1 Production Hardening

**Defined:** 2026-07-27
**Core Value:** Маркетолог настраивает триггерную цепочку или кампанию — и письма надёжно и вовремя доходят до нужных контактов, со сквозным отслеживанием статусов (delivered/opened/clicked/bounced) по каждому письму, шагу цепочки и кампании.

**Источник scope:** `.planning/AUDIT-2026-07-27-production-readiness.md` (внешний аудит v1.0) + 9 пропусков аудита, выявленных ресёрчем — см. `.planning/research/SUMMARY.md`.

**Характер milestone:** новой продуктовой функциональности не добавляется. Добавляется операционная надёжность уже работающей системы.

## Definition of Done (milestone-level)

> Каждое замечание аудита должно быть **исправлено**, **опровергнуто проверкой**, либо **оформлено как явно принятое решение с владельцем и сроком**. Незакрытых Critical/High в delivery, tenant isolation и compliance быть не должно.

Это условие проверяется при закрытии milestone поверх выполнения отдельных требований ниже.

## Жёсткий внешний дедлайн

Партиции `events` и `send_events` заведены только по август 2026. **С 1 сентября 2026** новые строки пойдут в DEFAULT partitions, после чего каждое последующее `ATTACH PARTITION` потребует полного сканирования DEFAULT под `ACCESS EXCLUSIVE` lock (простой ingestion). Требования **DB-01** и **DB-02** должны быть выполнены до этой даты.

## v1.1 Requirements

### Quality Gates

- [x] **QG-01**: CI прогоняет тесты, проверку типов и сборку на каждый push и pull request; красный прогон блокирует мёрж
- [x] **QG-02**: Lint настроен и нарушения блокируют CI
- [x] **QG-03**: Coverage измеряется, падение ниже установленного порога блокирует CI
- [x] **QG-04**: Playwright E2E работает против эфемерной изолированной БД и технически не может подключиться к dev-БД
- [x] **QG-05**: Миграции тестируются автоматически — применение с нуля и поверх существующей схемы
- [x] **QG-06**: Failure-injection harness воспроизводит таймаут SendGrid, ответ 429, разрыв соединения и падение процесса
- [x] **QG-07**: `.env` и `dump.rdb` вынесены из рабочего корня; служебные и секретные файлы не лежат в директории репозитория
- [x] **QG-08**: `ARCHITECTURE.md` создан и описывает фактическую архитектуру системы
- [x] **QG-09**: `CONVENTIONS.md` создан и фиксирует кодовые и архитектурные соглашения
- [x] **QG-10**: Правило обновления `SPECIFICATION.md`, `ARCHITECTURE.md` и `CONVENTIONS.md` при изменении соответствующих решений закреплено в `CLAUDE.md`

### Delivery Correctness

- [x] **DLV-01**: State machine отправки формально задокументирована, включая состояние `reconciling`
- [x] **DLV-02**: Прерванная отправка переходит в `reconciling`, а не классифицируется как `failed`
- [x] **DLV-03**: Reconciler определяет истинный исход отправки и закрывает состояние `reconciling`
- [x] **DLV-04**: Reconciler и retry-воркер не могут одновременно разрешить одну и ту же отправку
- [x] **DLV-05**: Ключ идемпотентности детерминированно выводится из намерения отправки, а не генерируется случайно на каждую попытку
- [x] **DLV-06**: SendGrid-запрос имеет явный timeout с отменой; timeout классифицируется как неоднозначный исход, а не как ошибка
- [x] **DLV-07**: Модель доставки (at-most-once / effectively-once) зафиксирована и задокументирована
- [x] **DLV-08**: Crash-тесты покрывают падение процесса до отправки, после принятия письма SendGrid и перед записью результата
- [x] **DLV-09**: Длительность отправки измеряется и доступна как метрика

### Security & Tenant Isolation

- [x] **SEC-01**: Cross-tenant сканирование работает через выделенную DB-роль с минимальными привилегиями вместо session flag
- [x] **SEC-02**: Cross-tenant сканирование невозможно включить из обычного API — подтверждено тестом
- [x] **SEC-03**: RLS-политики унифицированы в fail-closed направлении
- [x] **SEC-04**: Запрос без tenant context завершается ошибкой, а не возвращает ноль строк — подтверждено тестом
- [x] **SEC-05**: Trust boundary для таблиц Better Auth определён и реализован
- [x] **SEC-06**: API key scopes применяются на каждом маршруте либо удалены как несуществующая гарантия
- [x] **SEC-07**: Webhook отклоняет события со слишком старым timestamp
- [x] **SEC-08**: Webhook-маршрут имеет собственный rate limit
- [x] **SEC-09**: События чужого workspace отбрасываются при общем BYO SendGrid-ключе
- [x] **SEC-10**: Invite endpoint отдаёт минимально необходимые данные и отвечает одинаково для существующего и несуществующего приглашения
- [x] **SEC-11**: API rate limit распределённый и остаётся корректным при нескольких репликах API
- [x] **SEC-12**: `BETTER_AUTH_SECRET` имеет production-требование к длине
- [x] **SEC-13**: Redaction секретов и PII централизован и покрывает API и worker
- [x] **SEC-14**: `resolveWorkspaceMember` существует в единственной реализации
- [x] **SEC-15**: Anti-enumeration поведение одинаково на всех маршрутах
- [x] **SEC-16**: Отрицательные cross-tenant тесты покрывают API и фоновые jobs

### Compliance & Analytics

- [x] **CMP-01**: Отписка создаёт единое событие, атомарно обновляющее статус подписки, consent history и связанную отправку
- [x] **CMP-02**: Дневные метрики используют единую UTC-семантику; поле, определяющее день отправки, зафиксировано
- [x] **CMP-03**: Задержанные provider-события корректно учитываются в дневных метриках
- [x] **CMP-04**: Удаление контакта обезличивает персональные данные, сохраняя минимальное compliance evidence
- [x] **CMP-05**: Provider `occurred_at` ограничен допустимым диапазоном; время получения на сервере хранится отдельно
- [x] **CMP-06**: Metrics reconciliation работает как регулярная job, а не разовое исправление
- [x] **CMP-07**: Дедупликация webhook-событий устойчива к нестабильному `sg_event_id`
- [x] **CMP-08**: События, пропущенные при недоступности webhook-эндпоинта, восстанавливаются backfill'ом
- [x] **CMP-09**: Репутация отправителя отслеживается по тенанту с алертом при приближении к порогу жалоб

### Worker Reliability

- [x] **WRK-01**: Исчерпание лимита одного тенанта откладывает только его задания и не останавливает воркер целиком
- [x] **WRK-02**: Per-tenant concurrency cap ограничивает долю слотов воркера, занимаемых одним тенантом
- [x] **WRK-03**: Нагрузочный тест подтверждает: тенант A получил 429, тенант B продолжает отправку
- [x] **WRK-04**: `DEFAULT_TENANT_RPS` подтверждён нагрузочным тестом или конфигурацией SendGrid
- [x] **WRK-05**: Segment sweep ограничен по объёму — keyset pagination, checkpoint и короткие транзакции
- [x] **WRK-06**: Segment sweep возобновляется после частичного сбоя без повторной обработки всего объёма
- [x] **WRK-07**: Graceful shutdown по SIGTERM закрывает все Queue handles без потери задания в работе
- [x] **WRK-08**: Единые worker error listeners покрывают все воркеры
- [x] **WRK-09**: Failed jobs имеют ограниченную retention-политику вместо бессрочного хранения
- [x] **WRK-10**: Dead-letter механизм наблюдаем
- [x] **WRK-11**: Redis connection options, `defaultJobOptions` и значения TTL определены в единственном месте
- [x] **WRK-12**: Redis настроен на `maxmemory-policy=noeviction` с персистентностью
- [x] **WRK-13**: Repeatable jobs имеют централизованную обработку ошибок; код multi-instance-safe и это задокументировано

### Database Lifecycle

- [x] **DB-01**: Партиции `events` и `send_events` создаются автоматически на 2–3 месяца вперёд *(дедлайн 2026-09-01)*
- [x] **DB-02**: Отсутствие следующей партиции вызывает алерт *(дедлайн 2026-09-01)*
- [x] **DB-03**: Есть процедура переноса данных из DEFAULT-партиции без длительной блокировки таблицы
- [x] **DB-04**: Переход через границу месяца покрыт тестом
- [x] **DB-05**: Миграции при деплое применяются ровно одним процессом
- [x] **DB-06**: Приложение не принимает трафик до завершения миграций
- [x] **DB-07**: Процедура rollback / roll-forward задокументирована и отработана
- [x] **DB-08**: Дисциплина expand/contract зафиксирована как обязательная для миграций
- [x] **DB-09**: Бэкапы выполняются автоматически, PITR доступен
- [x] **DB-10**: Восстановление из бэкапа отработано на практике и задокументировано
- [x] **DB-11**: Retention данных определён и применяется
- [x] **DB-12**: Недостающие constraints добавлены после проверки и очистки существующих данных
- [x] **DB-13**: Соединение с PostgreSQL использует TLS
- [x] **DB-14**: Connection pooling настроен; все пулы имеют обработчик ошибок

### Observability, Deployment & Performance

- [x] **OPS-01**: Есть Dockerfiles для api, web и worker
- [x] **OPS-02**: Деплой на VPS выполняется воспроизводимой командой
- [x] **OPS-03**: Процедура отката деплоя задокументирована
- [x] **OPS-04**: `/healthz` отвечает о живости процесса
- [x] **OPS-05**: `/readyz` проверяет доступность PostgreSQL и Redis и не сообщает готовность до завершения миграций
- [x] **OPS-06**: Worker логирует структурно через Pino
- [x] **OPS-07**: Redaction применяется к логам worker и API единообразно
- [x] **OPS-08**: Sentry принимает исключения frontend, API и worker
- [x] **OPS-09**: Секреты и PII не попадают в Sentry — подтверждено тестом
- [x] **OPS-10**: Логи уходят в hosted-провайдер с настроенными алертами
- [x] **OPS-11**: `request_id`, `tenant_id`, `job_id` и `send_id` проходят сквозь HTTP, очередь и worker
- [x] **OPS-12**: Trace correlation связывает HTTP-запрос, job и запрос к Postgres
- [x] **OPS-13**: Алерты настроены на queue depth, oldest job age, webhook lag и долю неуспешных отправок
- [x] **OPS-14**: Bull Board доступен под закрытым административным доступом
- [x] **OPS-15**: Runbook'и описывают типовые инциденты и порядок восстановления
- [x] **OPS-16**: Frontend использует route-level code splitting; canvas/editor и тяжёлые dashboard-компоненты грузятся лениво
- [x] **OPS-17**: Frontend корректно обрабатывает ошибки API, пустые состояния и пагинацию
- [x] **OPS-18**: Устаревшая аналитика отображается честно
- [x] **OPS-19**: Несохранённые изменения canvas вызывают предупреждение; ошибка сохранения видна пользователю

### Live SendGrid Verification

Выпускной барьер milestone. Аккаунт и verified sender доступны — это не отложенный tech debt.

- [x] **UAT-01**: Live-отправка с BYO key через Dynamic Template подтверждена
- [x] **UAT-02**: Live-события delivered / opened / clicked / bounced подтверждены
- [x] **UAT-03**: Проверка подписи webhook подтверждена на реальном подписанном payload через полный HTTP-стек
- [x] **UAT-04**: Дедупликация повторно доставленных событий подтверждена live
- [x] **UAT-05**: Поведение при 429 и временных ошибках SendGrid подтверждено live

## Future Requirements

Отложено за пределы v1.1. Отслеживается, но не входит в текущий roadmap.

### Scaling

- **SCALE-01**: Горизонтальное масштабирование воркеров — несколько инстансов worker-контейнера с leader election для repeatable jobs
- **SCALE-02**: PgBouncer или внешний connection pooler — вводится при появлении реальной нагрузки на `max_connections`
- **SCALE-03**: Бенчмарк сегментации на 100k–1M контактов и пересмотр on-the-fly вычисления в пользу материализации, если упрётся в timeout

### Delivery

- **DELIV-01**: BullMQ Pro с нативным group rate limiting — при появлении операционного трения от app-level токен-бакета

## Out of Scope

| Feature | Reason |
|---------|--------|
| Новая продуктовая функциональность для маркетолога | Milestone целиком про операционную надёжность; продуктовый scope не расширяется |
| Разворачивание нескольких инстансов worker | Код пишется multi-instance-safe (WRK-13), но многоинстансовый деплой не разворачивается и не верифицируется в v1.1 — осознанное ограничение объёма |
| Kubernetes / managed-оркестрация | Зафиксирован деплой Docker на self-hosted VPS |
| Self-hosted стек мониторинга (Prometheus/Grafana/Loki) | Зафиксирован SaaS — Sentry + hosted logs; собственный стек мониторинга добавляет ops-нагрузку без выигрыша для текущего размера команды |
| `pg_partman` / `pg_cron` | Партиции обслуживаются собственной repeatable job — не требует кастомного образа Postgres и второй парадигмы планирования |
| `pg_dump` как основа резервного копирования | Не умеет PITR, который требуется явно |
| Переписывание системы | Аудит прямо рекомендует не переписывать: архитектура состоятельна, риски локализованы на границах сбоев |

## Traceability

Заполнено при создании roadmap v1.1 (2026-07-27). Каждое требование закреплено ровно за одной фазой.

| Requirement | Phase | Status |
|-------------|-------|--------|
| QG-01 | Phase 8 | Complete |
| QG-02 | Phase 8 | Complete |
| QG-03 | Phase 8 | Complete |
| QG-04 | Phase 8 | Complete |
| QG-05 | Phase 8 | Complete |
| QG-06 | Phase 8 | Complete |
| QG-07 | Phase 8 | Complete |
| QG-08 | Phase 8 | Complete |
| QG-09 | Phase 8 | Complete |
| QG-10 | Phase 8 | Complete |
| DLV-01 | Phase 11 | Complete |
| DLV-02 | Phase 11 | Complete |
| DLV-03 | Phase 11 | Complete |
| DLV-04 | Phase 11 | Complete |
| DLV-05 | Phase 11 | Complete |
| DLV-06 | Phase 11 | Complete |
| DLV-07 | Phase 11 | Complete |
| DLV-08 | Phase 11 | Complete |
| DLV-09 | Phase 11 | Complete |
| SEC-01 | Phase 10 | Complete |
| SEC-02 | Phase 10 | Complete |
| SEC-03 | Phase 10 | Complete |
| SEC-04 | Phase 10 | Complete |
| SEC-05 | Phase 10 | Complete |
| SEC-06 | Phase 10 | Complete |
| SEC-07 | Phase 10 | Complete |
| SEC-08 | Phase 10 | Complete |
| SEC-09 | Phase 10 | Complete |
| SEC-10 | Phase 10 | Complete |
| SEC-11 | Phase 10 | Complete |
| SEC-12 | Phase 10 | Complete |
| SEC-13 | Phase 10 | Complete |
| SEC-14 | Phase 10 | Complete |
| SEC-15 | Phase 10 | Complete |
| SEC-16 | Phase 10 | Complete |
| CMP-01 | Phase 13 | Complete |
| CMP-02 | Phase 13 | Complete |
| CMP-03 | Phase 13 | Complete |
| CMP-04 | Phase 13 | Complete |
| CMP-05 | Phase 13 | Complete |
| CMP-06 | Phase 13 | Complete |
| CMP-07 | Phase 13 | Complete |
| CMP-08 | Phase 13 | Complete |
| CMP-09 | Phase 13 | Complete |
| WRK-01 | Phase 12 | Complete |
| WRK-02 | Phase 12 | Complete |
| WRK-03 | Phase 12 | Complete |
| WRK-04 | Phase 12 | Complete |
| WRK-05 | Phase 12 | Complete |
| WRK-06 | Phase 12 | Complete |
| WRK-07 | Phase 12 | Complete |
| WRK-08 | Phase 12 | Complete |
| WRK-09 | Phase 12 | Complete |
| WRK-10 | Phase 12 | Complete |
| WRK-11 | Phase 12 | Complete |
| WRK-12 | Phase 8 | Complete |
| WRK-13 | Phase 12 | Complete |
| DB-01 | Phase 9 | Complete |
| DB-02 | Phase 9 | Complete |
| DB-03 | Phase 9 | Complete |
| DB-04 | Phase 9 | Complete |
| DB-05 | Phase 14 | Complete |
| DB-06 | Phase 14 | Complete |
| DB-07 | Phase 14 | Complete |
| DB-08 | Phase 8 | Complete |
| DB-09 | Phase 14 | Complete |
| DB-10 | Phase 14 | Complete |
| DB-11 | Phase 14 | Complete |
| DB-12 | Phase 14 | Complete |
| DB-13 | Phase 14 | Complete |
| DB-14 | Phase 14 | Complete |
| OPS-01 | Phase 14 | Complete |
| OPS-02 | Phase 14 | Complete |
| OPS-03 | Phase 14 | Complete |
| OPS-04 | Phase 14 | Complete |
| OPS-05 | Phase 14 | Complete |
| OPS-06 | Phase 15 | Complete |
| OPS-07 | Phase 15 | Complete |
| OPS-08 | Phase 15 | Complete |
| OPS-09 | Phase 15 | Complete |
| OPS-10 | Phase 15 | Complete |
| OPS-11 | Phase 15 | Complete |
| OPS-12 | Phase 15 | Complete |
| OPS-13 | Phase 15 | Complete |
| OPS-14 | Phase 15 | Complete |
| OPS-15 | Phase 15 | Complete |
| OPS-16 | Phase 15 | Complete |
| OPS-17 | Phase 15 | Complete |
| OPS-18 | Phase 15 | Complete |
| OPS-19 | Phase 15 | Complete |
| UAT-01 | Phase 16 | Complete |
| UAT-02 | Phase 16 | Complete |
| UAT-03 | Phase 16 | Complete |
| UAT-04 | Phase 16 | Complete |
| UAT-05 | Phase 16 | Complete |

### Phase Summary

| Phase | Requirements | Count |
|-------|--------------|-------|
| Phase 8 — Quality Gates & Failure-Injection Foundation | QG-01, QG-02, QG-03, QG-04, QG-05, QG-06, QG-07, QG-08, QG-09, QG-10, WRK-12, DB-08 | 12 |
| Phase 9 — Partition Automation & Boundary Safety | DB-01, DB-02, DB-03, DB-04 | 4 |
| Phase 10 — Tenant Isolation & Trust Boundaries | SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-06, SEC-07, SEC-08, SEC-09, SEC-10, SEC-11, SEC-12, SEC-13, SEC-14, SEC-15, SEC-16 | 16 |
| Phase 11 — Delivery Correctness | DLV-01, DLV-02, DLV-03, DLV-04, DLV-05, DLV-06, DLV-07, DLV-08, DLV-09 | 9 |
| Phase 12 — Worker Reliability & Tenant Fairness | WRK-01, WRK-02, WRK-03, WRK-04, WRK-05, WRK-06, WRK-07, WRK-08, WRK-09, WRK-10, WRK-11, WRK-13 | 12 |
| Phase 13 — Compliance & Analytics Integrity | CMP-01, CMP-02, CMP-03, CMP-04, CMP-05, CMP-06, CMP-07, CMP-08, CMP-09 | 9 |
| Phase 14 — Deployment & Database Durability | DB-05, DB-06, DB-07, DB-09, DB-10, DB-11, DB-12, DB-13, DB-14, OPS-01, OPS-02, OPS-03, OPS-04, OPS-05 | 14 |
| Phase 15 — Observability, Alerting & Frontend Resilience | OPS-06, OPS-07, OPS-08, OPS-09, OPS-10, OPS-11, OPS-12, OPS-13, OPS-14, OPS-15, OPS-16, OPS-17, OPS-18, OPS-19 | 14 |
| Phase 16 — Live SendGrid Verification | UAT-01, UAT-02, UAT-03, UAT-04, UAT-05 | 5 |

**Coverage:**

- v1.1 requirements: 95 total
- Mapped to phases: 95 ✓
- Unmapped: 0 ✓
- Duplicated across phases: 0 ✓

**Deadline-gated:** DB-01, DB-02 (Phase 9) — must complete before **2026-09-01**.

**Open decisions inside scope:** SEC-05 (Better Auth trust boundary, Phase 10), WRK-02 (per-tenant concurrency-cap mechanism, Phase 12) — см. `.planning/ROADMAP.md` § Open Decisions.

---
*Requirements defined: 2026-07-27*
*Last updated: 2026-08-19 during v1.1 milestone audit (CMP-01/03/04/05/07 traceability rows synced to Complete per 13-VERIFICATION.md re-verification)*
