# Phase 5: Webhook Processing & Delivery Tracking - Context

**Gathered:** 2026-07-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Замыкание send loop: SendGrid Event Webhook надёжно превращается в точные, дедуплицированные доставочные статусы писем в send-леджере и в автоматический suppression контактов. Платформа автонастраивает per-tenant webhook через SendGrid API, принимает события на per-tenant URL с ECDSA-верификацией по сырому телу, отвечает 2xx быстро и обрабатывает асинхронно через очередь, дедуплицирует по sg_event_id, обновляет статусы delivered/opened/clicked/bounced/dropped/unsubscribed/spam в леджере и счётчики в сводке кампании, и переводит контакты в unsubscribed/suppressed по событиям bounce/spam/unsubscribe. Требования: WBHK-01…04, SUBS-02. Режим фазы: MVP.

Зафиксировано до обсуждения (ROADMAP/PITFALLS/CLAUDE.md — не пересматривать):
- ECDSA-подпись проверяется по СЫРОМУ телу запроса до любого парсинга; webhook-роут исключён из глобального JSON body-parser (PITFALLS #2, CLAUDE.md «What NOT to Use»).
- Ack-fast: эндпоинт отвечает 2xx сразу, обработка асинхронная через BullMQ (PITFALLS #3).
- Дедуп на уровне ОТДЕЛЬНОГО события по sg_event_id, не по хэшу батча (WBHK-03, PITFALLS #3).
- Платформа — источник истины по статусу подписки (Phase 2 D-12, Phase 4 D-15).

</domain>

<decisions>
## Implementation Decisions

### Подключение webhook у тенанта
- **D-01:** Автонастройка через SendGrid API: при подключённом ключе платформа сама создаёт/обновляет Event Webhook тенантским ключом, включает подписанные события и сама забирает публичный ключ верификации. Ручная инструкция — НЕ основной путь.
- **D-02:** Автонастройка срабатывает автоматически при подключении/смене SendGrid-ключа. Для уже подключённых воркспейсов — кнопка/баннер «Включить отслеживание доставки» в настройках SendGrid-интеграции + пункт в онбординг-чеклисте (Phase 1 D-23).
- **D-03:** Здоровье webhook видно тенанту: индикатор «подключено / не подключено» + «последнее событие получено N назад» + кнопка «Переподключить». Расширенная диагностика (счётчики отклонённых подписей и т.п.) — Phase 7.
- **D-04:** Open/click tracking форсируется пер-письмо: tracking_settings (open + click on) передаются в каждом mail/send — не зависим от настроек аккаунта тенанта. Аналогично отключению subscription tracking (Phase 4 D-15).
- **D-05:** Платформа создаёт СВОЙ отдельный именованный Event Webhook (friendly name), хранит его id и обновляет только его. Существующие webhook'и тенанта не трогаем — его интеграции продолжают работать.

### Модель статуса письма
- **D-06:** В `sends` добавляются колонки-факты: delivered_at, first_opened_at, first_clicked_at, bounced_at, dropped_at, unsubscribed_at, spam_reported_at (+ причина bounce/drop). «Текущий статус» для UI вычисляется по приоритету: bounced/dropped/spam терминальны > clicked > opened > delivered > sent. Out-of-order события безопасны — факты не перезаписывают друг друга (PITFALLS #3).
- **D-07:** UI этой фазы — счётчики delivered/opened/clicked/bounced (не доставлено)/unsubscribed в уже существующей сводке кампании (Phase 4). Детальный по-письмовый лог с фильтрами — Phase 7, здесь его НЕ строим.
- **D-08:** dropped — отдельный терминальный исход (dropped_at + причина), в счётчиках группируется с bounced в «не доставлено», но причина различима в данных.
- **D-09:** Счётчики opened/clicked в сводке — уникальные получатели (по first_opened_at/first_clicked_at). Повторные открытия/клики — в сырых событиях для Phase 7.

### Правила suppression (SUBS-02)
- **D-10:** Hard bounce → subscription_status = suppressed сразу. Soft bounce/block → suppressed после 3 подряд неудач (N=3 — платформенная константа, без настройки); успешная доставка сбрасывает счётчик подряд-ошибок. Выбор пользователя: эскалация soft bounce нужна в v1, не отложена.
- **D-11:** spam report → suppressed. unsubscribe / group_unsubscribe → unsubscribed.
- **D-12:** dropped переводит контакт по причине: Bounced Address / Spam Reporting Address / Invalid → suppressed; Unsubscribed Address → unsubscribed; технические причины (например, доставка невозможна по иным причинам) маппятся по смыслу, без смены статуса, если причина не про адрес.
- **D-13:** Webhook-suppression пишет ОДНОВРЕМЕННО subscription_status = suppressed И email в workspace_suppressions с причиной (hard_bounce / spam_report / soft_bounce_streak / dropped_*). Гарантия D-08 (Phase 2) становится немедленной: удаление + реимпорт не воскрешает «мёртвый» адрес. Unsubscribe → только статус (как one-click из Phase 4 D-15).

### Хранение сырых событий
- **D-14:** Каждое webhook-событие — строка в новой таблице доставочных событий: sg_event_id UNIQUE (это и есть механизм дедупа WBHK-03), ссылка на send, тип события, timestamp события, полезные поля payload (причина bounce, URL клика и т.п.). Таблица partition-ready по времени — паттерн events из Phase 2 / CLAUDE.md.
- **D-15:** Матчинг по маркеру платформы: при отправке платформа кладёт custom_args (send_id, workspace_id) в каждое письмо — SendGrid возвращает их в каждом событии. События БЕЗ нашего маркера (письма тенанта мимо платформы) — подтверждаем (2xx) и отбрасываем, не храним и не суппрессим. Маркированные события без живого send (send удалён) — храним как есть. Тестовые письма (Phase 4 D-12) маркируем признаком test и отбрасываем из статистики и suppression.
- **D-16:** Retention — бессрочно в v1; партиции по месяцам с первого дня; политика удаления старых партиций — отложенное решение (v2/ops).

### Claude's Discretion
- Формат per-tenant webhook URL (path-токен воркспейса), его криптографическая непредсказуемость; хранение public verification key (шифровать ли как SendGrid-ключи — по паттерну Phase 1).
- Схема очереди обработки: одна очередь webhook-событий vs переиспользование существующей инфраструктуры воркеров; батчинг вставки событий (webhook POST несёт 5–50 событий).
- Точный набор SendGrid scopes для автонастройки; поведение при нехватке прав у ключа (graceful ошибка с объяснением; ручной fallback НЕ строим в v1 — сообщение об ошибке достаточно).
- Реализация счётчика soft-bounce-подряд (колонка контакта vs вычисление из событий) — с учётом гонок при параллельной обработке.
- Как считать и обновлять счётчики сводки кампании (инкрементально при обработке vs агрегатный запрос) — с оглядкой на дедуп и идемпотентность.
- Реакция на смену/отключение SendGrid-ключа: перепривязка webhook, инвалидация verification key.
- Обновление статуса «последнее событие получено» без лишней нагрузки (Redis/дебаунс).
- RLS новых таблиц по паттерну Phase 1–4; tenant context в воркере обработки (PITFALLS #5) — обязателен.
- Тексты русскоязычного UI в стиле Phase 2–4.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Ресёрч проекта (критично для этой фазы)
- `.planning/research/PITFALLS.md` — Pitfall #2 (raw body + ECDSA до парсинга — самый частый баг интеграции SendGrid webhook), Pitfall #3 (дедуп по sg_event_id, out-of-order, ack-fast), Pitfall #5 (tenant context в каждой транзакции воркера)
- `.planning/research/STACK.md` — BullMQ 5 + ioredis, Fastify 5 (webhook-роут исключить из глобального JSON-парсера), Drizzle + партиционирование
- `.planning/research/ARCHITECTURE.md` — границы компонентов, shared tables + workspace_id

### Требования и решения
- `.planning/REQUIREMENTS.md` — WBHK-01…04, SUBS-02 (эта фаза); ANLT-* (Phase 7 — потребитель сырых событий и счётчиков)
- `.planning/ROADMAP.md` §Phase 5 — goal, success criteria, предварительная разбивка 05-01…05-03
- `.planning/phases/04-broadcast-campaigns-send-pipeline/04-CONTEXT.md` — D-12 (тестовые письма вне статистики), D-15 (one-click unsubscribe, subscription tracking отключён), D-10 (счётчик failed в сводке); send ledger спроектирован под рост delivery-колонок
- `.planning/phases/02-contacts-event-ingestion/02-CONTEXT.md` — D-08 (suppression-список переживает удаление), D-11/D-12 (семантика 3-state статуса; suppressed необратим из UI)

### Схемы данных и код (точки расширения)
- `packages/db/src/schema/sends.ts` — send-леджер: сюда добавляются delivery-колонки (комментарий в схеме прямо это предусматривает); providerMessageId уже есть
- `packages/db/src/schema/suppressions.ts` — workspace_suppressions: сюда пишет webhook-suppression (D-13)
- `packages/db/src/schema/contacts.ts` — subscriptionStatusEnum; комментарий предусматривает установку suppressed из webhook
- `packages/db/src/schema/events.ts` — паттерн partition-ready таблицы для таблицы доставочных событий (D-14)
- `apps/api/src/modules/tenancy/sendgrid-client.ts` + `sendgrid-key.ts` — вызовы SendGrid API тенантским ключом: расширяются на управление Event Webhook (D-01, D-05)
- `apps/worker/src/queues/send-dispatch.ts` — место, где в mail/send добавляются custom_args (D-15) и tracking_settings (D-04)
- `apps/worker/src/queues/events-ingest.worker.ts` + `connection.ts` — паттерн идемпотентного BullMQ-воркера с tenant context
- `packages/tenant-context` — withTenantTransaction для всех запросов воркеров

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `sends` (Phase 4) — уже хранит provider_message_id; UNIQUE (workspace, campaign, contact); спроектирован под добавление delivery-колонок без структурных изменений
- `workspace_suppressions` (Phase 2 D-08) — готовая таблица с reason; webhook добавляет новые причины
- `sendgrid-client.ts` — аутентифицированные вызовы SendGrid API тенантским ключом (валидация, verified senders, templates) — расширяется на Event Webhook management API
- `apps/worker` — готовая воркер-инфраструктура BullMQ (connection, graceful shutdown, идемпотентность, tenant context) — воркер обработки webhook-событий добавляется рядом
- Сводка кампании (Phase 4 UI) — счётчики delivered/opened/clicked/bounced добавляются в существующий экран
- Онбординг-чеклист (Phase 1 D-23) — пункт «включить отслеживание доставки» для существующих воркспейсов

### Established Patterns
- RLS ENABLE+FORCE миграции для новых таблиц (delivery events); tenant context на транзакцию в воркерах (PITFALLS #5)
- Partition-ready схема по времени — паттерн events (Phase 2)
- Zod через @fastify/type-provider-zod; НО: webhook-роут работает с сырым телом — Zod-валидация только ПОСЛЕ верификации подписи и JSON.parse
- Публичная поверхность без сессии — паттерн unsubscribe-эндпоинта Phase 4 (webhook-эндпоинт тоже без сессии: аутентификация ECDSA-подписью + per-tenant URL)

### Integration Points
- Phase 6 (цепочки): триггерные письма пишут в тот же леджер — delivery-факты и suppression работают для них автоматически
- Phase 7 (аналитика): таблица доставочных событий (D-14) — источник timeline контакта и total-метрик; счётчики сводки (D-07/D-09) — основа campaign metrics
- Сегментация (Phase 3): смены subscription_status от webhook сразу видны сегментам по статусу подписки; поведенческие условия по opened/clicked писем — Phase 7 территория (segment-условия «не открывал письма» уже поддержаны моделью условий, данные появятся здесь)
- Pre-send гейт (Phase 4): автоматически начинает отфильтровывать контактов, суппрессированных webhook'ом — никакой доработки не требуется

</code_context>

<specifics>
## Specific Ideas

- «Надёжность видна пользователю» (сквозная тема Core Value): статус webhook с временем последнего события (D-03) и честная расшифровка «не доставлено» (bounced vs dropped, D-08) — продолжение философии live-счётчиков Phase 3/4.
- Одна кнопка «Подключить отслеживание» вместо инструкции на 8 шагов — модель Klaviyo: интеграция сама себя настраивает через API тенанта.
- Пользователь осознанно выбрал эскалацию soft bounce (3 подряд → suppressed) вместо MVP-минимума «только hard bounce» — защита репутации отправителя важнее простоты.

</specifics>

<deferred>
## Deferred Ideas

- Расширенная диагностика webhook (счётчики отклонённых подписей, лог ошибок обработки за 24ч) — Phase 7 (observability)
- Настройка порога soft bounce на воркспейс — v2; v1 живёт с платформенной константой N=3 (D-10)
- TTL/архивация старых партиций доставочных событий — v2/ops (D-16)
- Total-счётчики открытий/кликов (не уникальные) и по-письмовый лог с фильтрами — Phase 7 (D-07, D-09)
- Suppression по bounce чужих писем тенанта (мимо платформы) — отклонено для v1: неожиданные смены статуса «без причины в платформе» сложно объяснить пользователю (D-15)
- Ручной fallback-путь настройки webhook (показ URL + вставка ключа) — не строим в v1; при нехватке прав ключа — понятная ошибка

</deferred>

---

*Phase: 5-Webhook Processing & Delivery Tracking*
*Context gathered: 2026-07-08*
