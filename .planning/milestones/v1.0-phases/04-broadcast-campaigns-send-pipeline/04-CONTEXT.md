# Phase 4: Broadcast Campaigns & Send Pipeline - Context

**Gathered:** 2026-07-06
**Status:** Ready for planning

> **⚠ Частично auto-выбранные решения.** Пользователь выбрал все 4 области и ответил на первые 6 вопросов (D-01…D-05 подтверждены пользователем), затем стал недоступен (нет ответа за 60с — прецедент Phase 1/2/3 «away from keyboard»). Решения, помеченные **(auto)**, — рекомендованные варианты, выбранные Claude. Пользователь может пересмотреть любое из них до/во время планирования — перезапустить `/gsd-discuss-phase 4` или отредактировать этот файл.

<domain>
## Phase Boundary

Первый полный цикл отправки: маркетолог создаёт broadcast-кампанию (сегмент-аудитория + SendGrid Dynamic Template + верифицированный отправитель), шлёт тестовое письмо себе, запускает сразу или планирует на дату/время — и письма надёжно уходят через троттлируемую, идемпотентную, suppression-aware очередь в SendGrid v3 mail/send. State machine draft → scheduled → sending → sent; live-прогресс (отправлено/всего); pre-send фильтр подписки/suppression; глобальный frequency cap через единый журнал отправок; one-click List-Unsubscribe; per-tenant RPS-троттлинг; приоритетная полоса для триггерных писем (сама полоса закладывается сейчас, триггерные письма появятся в Phase 6). Требования: CAMP-01…05, SEND-01…07, SUBS-03, SUBS-04. Режим фазы: MVP.

</domain>

<decisions>
## Implementation Decisions

### Аудитория и снапшот (D-01…D-05 подтверждены пользователем)
- **D-01:** Запланированная кампания резолвит сегмент в получателей **в момент старта отправки** (не при клике «Запланировать»). Согласуется с Phase 3 D-13 «сегменты всегда динамические» и моделью Klaviyo. Пока кампания scheduled, UI показывает оценочный счётчик («~12 400 на момент проверки»).
- **D-02:** При старте отправки состав **замораживается в снапшот получателей**: контакты, вошедшие в сегмент во время идущей отправки, в эту кампанию НЕ добавляются; знаменатель прогресса стабилен; ретраи детерминированы.
- **D-03:** Редактирование сегмента, на который ссылается scheduled-кампания, — **разрешено с предупреждением** в редакторе сегмента («Используется запланированной кампанией X — изменения повлияют на её аудиторию»). Удаление сегмента, на который ссылается кампания, — заблокировано (Phase 3 D-14, реализуется в этой фазе).
- **D-04:** Аудитория кампании = **sendable-контакты + расшифровка исключений**: знаменатель прогресса — реально отправляемые; кампания показывает breakdown «500 исключено — 320 unsubscribed, 130 suppressed, 50 без email» (+ frequency cap, см. D-14). Прозрачность фильтра = доверие («надёжность видна пользователю»).
- **D-05:** Пустая sendable-аудитория (в т.ч. по резолву в send time) → кампания завершает переход в **sent с 0 отправленных и явным уведомлением** («Аудитория была пуста: 200 исключено — все отписаны»). Отдельного failed-состояния для пустой аудитории нет; при интерактивном запуске confirm-диалог уже показывает sendable-счётчик до клика.

### Планирование по времени
- **D-06 (auto):** Дата/время планирования — в **локальной таймзоне пользователя с явной меткой** в пикере («09:00, Europe/Belgrade»), хранение в UTC. Никаких новых настроек воркспейса; per-contact local time — deferred.

### Жизненный цикл кампании и контроль
- **D-07 (auto):** Scheduled-кампанию можно **отменить в любой момент до старта** — возвращается в draft.
- **D-08 (auto):** In-place редактирование scheduled-кампании НЕ поддерживается: сначала «вернуть в draft» (D-07), отредактировать, перепланировать. Однозначная state machine без гонок «правка против старта».
- **D-09 (auto):** Отмена **во время отправки** поддерживается: прекращается диспетчеризация оставшихся писем, кампания переходит в терминальный статус **canceled** с фактическими счётчиками (отправлено N из M); уже отправленные письма не отзываются (это невозможно).
- **D-10 (auto):** Частичные постоянные сбои НЕ порождают отдельного статуса: терминальный статус — **sent, с видимым счётчиком failed** в прогрессе/сводке («12 355 отправлено, 45 ошибок»). Ошибки по типам — в сводке кампании; per-message лог — Phase 7.
- **D-11 (auto):** **Дублирование кампании** («создать копию») — включено: копия становится новым draft со всеми настройками (сегмент, шаблон, отправитель).
- **D-12 (auto):** Тестовое письмо (CAMP-04) доступно из draft и scheduled, на state machine не влияет, **не учитывается** в frequency cap / журнале отправок и не фильтруется по статусу подписки получателя-маркетолога.

### Frequency cap и compliance
- **D-13 (auto):** Глобальный frequency cap — **настройка воркспейса со значением по умолчанию** (стартовое: не более 3 маркетинговых писем контакту за скользящие 24 часа; ресёрчер/планировщик могут уточнить дефолт). Enforcement — через единый журнал отправок (SEND-04), который в Phase 6 разделят и цепочки. Cap применяется к broadcast + будущим триггерным письмам; системные письма платформы (Phase 1) вне cap.
- **D-14 (auto):** Контакты поверх cap в broadcast — **пропускаются, не откладываются**; попадают в расшифровку исключений как «frequency cap» (расширение D-04). Семантика отложенной отправки — территория цепочек (Phase 6).
- **D-15 (auto):** One-click unsubscribe (SUBS-04) — **собственный HTTPS-эндпоинт платформы** по RFC 8058: заголовки List-Unsubscribe (URL с подписанным per-message токеном) + List-Unsubscribe-Post: List-Unsubscribe=One-Click; плюс минимальная hosted-страница подтверждения («Вы отписаны») для переходов из почтовых клиентов. Клик немедленно ставит subscription_status = unsubscribed в платформе (источник истины — платформа, Phase 2 D-12); SendGrid subscription tracking для этих писем отключается, чтобы не было двух конкурирующих механизмов отписки.

### Шаблон, отправитель и тестовая отправка
- **D-16 (auto):** Выбор Dynamic Template — **из списка шаблонов аккаунта тенанта**, полученного через SendGrid API по сохранённому ключу (паттерн Phase 1 D-21 с верифицированными отправителями), с кнопкой «обновить список»; ручной ввод template_id — fallback.
- **D-17 (auto):** From-адрес кампании выбирается из **верифицированных отправителей** аккаунта SendGrid тенанта (список уже умеем получать — Phase 1 D-21).
- **D-18 (auto):** dynamic_template_data — **стандартизованная документированная форма профиля контакта**, передаваемая автоматически: стандартные поля (first_name, last_name, email, phone, city, country), tags, кастомные свойства (properties.*) + служебные поля (unsubscribe_url при необходимости шаблона). Per-campaign UI маппинга переменных НЕ строим в v1 — тенант проектирует шаблон под документированную форму.
- **D-19 (auto):** Тестовое письмо — на адрес текущего пользователя; sample dynamic_template_data **автозаполняется данными реального контакта из выбранного сегмента** (fallback — плейсхолдеры), с возможностью отредактировать JSON перед отправкой.

### Claude's Discretion
- Дефолт и хранение per-tenant RPS (настройка воркспейса vs платформенная), параметры token bucket (`rate-limiter-flexible`), параметры backoff при 429/5xx (уважать Retry-After), формат идемпотентных ключей джоб — по ресёрчу. Топология очередей ЗАФИКСИРОВАНА стеком: два queues `email:triggered`/`email:broadcast` с отдельными воркерами, троттлинг на уровне процессора, НЕ через BullMQ `limiter`, НЕ queue-per-tenant (CLAUDE.md / STACK.md).
- Схема снапшота получателей и батчинг его создания на масштабе 100k+ (statement_timeout сегментного движка 15s — возможно, materialization батчами; координировать с бенчмарк-флагом из STATE.md).
- Механизм планировщика (BullMQ delayed job vs периодический scan due-кампаний) — по ресёрчу, с учётом надёжности при рестартах.
- Схема единого журнала отправок (send ledger) — проектировать под Phase 6 (цепочки пишут в тот же журнал) и Phase 5/7 (статусы доставки, per-message лог), не строя их сейчас.
- Транспорт live-прогресса (polling vs SSE), интервал обновления — UI-SPEC / discretion.
- Криптография подписанного unsubscribe-токена, срок его жизни; путь/домен эндпоинта отписки.
- Валидация «кампания готова к запуску» (шаблон выбран, отправитель выбран, сегмент существует), тексты ошибок, пустые состояния, русские UI-тексты в стиле Phase 2/3.
- RLS новых таблиц (campaigns, recipient snapshot, send ledger) по паттерну Phase 1/2/3; tenant context в воркерах — обязателен (PITFALLS.md #5).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Ресёрч проекта (стек, архитектура, риски)
- `.planning/research/STACK.md` — BullMQ 5 + ioredis; ДВЕ очереди email:triggered/email:broadcast (приоритет ≠ изоляция); rate-limiter-flexible per-tenant token bucket ВМЕСТО BullMQ limiter (group-limit только в Pro); @sendgrid/mail / SendGrid v3 mail/send
- `.planning/research/ARCHITECTURE.md` — границы компонентов, shared tables + workspace_id
- `.planning/research/PITFALLS.md` — Pitfall #5 (tenant context на каждую транзакцию воркера) критичен для send-воркеров; предупреждение про raw body SendGrid webhook (Phase 5, но эндпоинт отписки — родственная поверхность)
- `.planning/research/SUMMARY.md` — сводные риски

### Требования и решения
- `.planning/REQUIREMENTS.md` — CAMP-01…05, SEND-01…07, SUBS-03, SUBS-04 (эта фаза); SUBS-02 (Phase 5), FLOW-* (Phase 6 — потребитель send-пайплайна и журнала отправок)
- `.planning/ROADMAP.md` §Phase 4 — goal, success criteria, предварительная разбивка планов 04-01…04-06
- `.planning/phases/03-segmentation-engine/03-CONTEXT.md` — D-04 (pre-send фильтр — независимый гейт), D-13 (динамические сегменты, ссылка по id), D-14 (restrict delete when referenced — реализуется здесь)
- `.planning/phases/02-contacts-event-ingestion/02-CONTEXT.md` — D-08 (suppression-список переживает удаление контакта), D-11/D-12 (семантика subscription status)
- `.planning/phases/01-workspace-foundation-team-access/01-CONTEXT.md` — D-17/D-19 (запуск кампаний Owner/Admin-only, Member — только черновики), D-21 (валидация ключа + верифицированные отправители)

### Схемы данных и код (вход пайплайна)
- `packages/db/src/schema/contacts.ts` — subscription_status, стандартные поля, properties JSONB (вход dynamic_template_data)
- `packages/db/src/schema/suppressions.ts` — suppression-список для pre-send фильтра
- `packages/db/src/schema/segments.ts` — таблица сегментов (сюда — restrict-when-referenced)
- `apps/api/src/modules/segments/segment.repository.ts` — countSegmentMembers / listSegmentMembers / isContactInSegment — движок резолва аудитории (SEGM-03)
- `apps/api/src/modules/tenancy/sendgrid-key.ts` + `sendgrid-client.ts` — расшифровка тенантского ключа (KMS) и вызовы SendGrid API
- `apps/worker/src/queues/connection.ts` + `events-ingest.worker.ts` — Redis-подключение и паттерн идемпотентного BullMQ-воркера с tenant context
- `packages/tenant-context` — withTenantTransaction для всех запросов воркеров

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/worker` — готовый воркер-процесс с BullMQ: connection, graceful shutdown, идемпотентность (workspace-scoped jobId из 02-10) — send-воркеры добавляются рядом с events-ingest/imports-csv
- Сегментный движок (`segment.repository.ts`) — резолв полного состава для снапшота аудитории; спроектирован под этот сценарий в Phase 3 (SEGM-03)
- `sendgrid-client.ts` — уже умеет валидировать ключ и получать верифицированных отправителей; расширяется на список Dynamic Templates (D-16) и mail/send
- `apps/web/src/features/*` — фичевая структура фронта; campaigns — новая фича по образцу segments/contacts; паттерны таблиц/форм/live-обновлений (keepPreviousData, debounce) переиспользуются для списка кампаний и live-прогресса
- `apps/api/src/middleware/role-guard.ts` — Owner/Admin-гейт на запуск/планирование (Phase 1 D-19); verification-gate для критичных действий

### Established Patterns
- Zod через @fastify/type-provider-zod на всех роутах; схемы кампаний — в `packages/shared-schemas`
- RLS ENABLE+FORCE миграции по паттерну Phase 1/2/3 для новых таблиц (campaigns, снапшот получателей, send ledger)
- Воркеры обязаны устанавливать tenant context на транзакцию (PITFALLS #5, паттерн events-ingest)
- Русскоязычный UI, Radix + react-hook-form + TanStack Query

### Integration Points
- Phase 5 (webhooks): статусы delivered/opened/clicked/bounced лягут поверх журнала отправок этой фазы — проектировать send ledger со ссылкой на SendGrid message id
- Phase 6 (цепочки): триггерные письма поедут через ту же очередь (полоса email:triggered закладывается сейчас), тот же pre-send фильтр, тот же frequency cap ledger
- Phase 7 (аналитика): per-message лог и метрики кампаний читают журнал отправок
- Онбординг-чеклист (Phase 1 D-23): пункт «запустите первую кампанию» — опционально, discretion
- Эндпоинт отписки (D-15) — публичная поверхность БЕЗ сессии/API-ключа: аутентификация подписанным токеном; учесть в структуре роутов

</code_context>

<specifics>
## Specific Ideas

- Klaviyo — референс поведения: динамическая аудитория до момента отправки, заморозка на send, campaign-копирование.
- «Надёжность видна пользователю» (сквозная тема Core Value): расшифровка исключений pre-send фильтра (D-04) и живой прогресс — та же философия, что live-счётчик сегментов (Phase 3) и лента событий (Phase 2).
- Двухочередная топология и per-tenant token bucket — жёстко зафиксированы стек-ресёрчем (CLAUDE.md «What NOT to Use»): НЕ полагаться на BullMQ limiter, НЕ строить queue-per-tenant.

</specifics>

<deferred>
## Deferred Ideas

- Отправка в локальной таймзоне получателя (per-contact send time, Klaviyo-style) — v2; требует timezone-данных контакта и staggered-движка
- Настройка таймзоны воркспейса — если distributed-команды попросят; v1 обходится локальной таймзоной с явной меткой (D-06)
- Пауза/возобновление идущей отправки — v1 имеет только cancel (D-09)
- In-place редактирование scheduled-кампании — v1 через «вернуть в draft» (D-08)
- A/B-тестирование кампаний, send-time optimization — v2
- Per-campaign UI маппинга переменных шаблона — v2; v1 использует документированную форму профиля (D-18)
- Отложенная (deferred) отправка frequency-capped контактов — семантика Phase 6/v2 (D-14)
- Preview рендера Dynamic Template в платформе — контент живёт в SendGrid (Out of Scope PROJECT.md)

</deferred>

---

*Phase: 4-Broadcast Campaigns & Send Pipeline*
*Context gathered: 2026-07-06*
