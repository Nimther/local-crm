# Phase 7: Analytics, Dashboard & Send Log - Context

**Gathered:** 2026-07-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Маркетолог видит сквозную картину производительности: метрики кампаний (счётчики + проценты, ANLT-01), per-step метрики цепочек (ANLT-02), timeline активности в карточке контакта (ANLT-03), сводный дашборд воркспейса с трендами за период и ростом базы (ANLT-04), по-письмовый send log с фильтрами по контакту/кампании-цепочке/статусу/периоду (ANLT-05). Фаза преимущественно ЧИТАЮЩАЯ: все первичные данные уже пишутся (sends ledger с delivery-фактами, send_events raw log, flow_run_steps, счётчики кампаний, events, flow_runs). Новые записывающие механизмы этой фазы: rollup-агрегация (ROADMAP 07-01: инкрементальная + периодическая сверка) и таблица истории смен subscription status (D-09). Режим фазы: MVP. UI hint: yes.

Зафиксировано до обсуждения (ROADMAP/PROJECT/CLAUDE.md — не пересматривать):
- Phase 5 D-06: «текущий статус» письма = приоритетная цепочка bounced/dropped/spam > clicked > opened > delivered > sent — используется как единый словарь статусов.
- Phase 5 D-09: счётчики кампаний = уникальные получатели; повторные открытия/клики живут в send_events.
- ROADMAP 07-01: rollup-таблицы + инкрементальная агрегация + периодическая сверка — архитектурная основа трендов/дашборда.
- Chart-библиотека: Recharts или Tremor (CLAUDE.md); не установлена — выбор на ресёрче/планировании.

</domain>

<decisions>
## Implementation Decisions

### Метрики кампаний и шагов (ANLT-01, ANLT-02)
- **D-01:** Проценты — индустриальный стандарт: open rate = opened/delivered, click rate = clicked/delivered; delivery rate и bounce rate — от sent. Один знаменатель на метрику, вторые проценты не показываем.
- **D-02:** Per-step метрики цепочки — по ВСЕМ узлам: на каждом узле количество прошедших контактов (источник — flow_run_steps, включая исходы развилок); на send-узлах дополнительно sent/delivered/opened/clicked/bounced. Видно и «утечки» на развилках/delays, и слабое письмо.
- **D-03:** Размещение per-step метрик — двойное: бейджи с цифрами прямо на узлах canvas (read-only оверлей, модель Klaviyo) + табличная вкладка «Аналитика» на странице цепочки для сравнения шагов списком.
- **D-04:** Метрики кампании живут в СУЩЕСТВУЮЩЕЙ сводке на детальной странице — обогащаем блок процентами и переходом в send log с предфильтром по кампании. Новых вкладок на странице кампании нет.
- **D-05:** Агрегация per-step метрик по версиям цепочки — по nodeId сквозно через все версии (метрика узла = сумма по всем версиям, где nodeId встречался). Canvas показывает live-версию; узлы, удалённые из live, остаются видимыми только во вкладке-таблице.
- **D-06:** Метрики в списках: кампании — sent / delivered% / opened% / clicked%; цепочки — активные runs + отправлено писем. Быстрое сравнение без захода в каждую.
- **D-07:** Excluded-письма видны в сводке кампании/цепочки отдельной строкой с разбивкой по причинам (подписка/suppression, frequency cap): «Пропущено: N». В проценты не входят. Продолжение темы «надёжность видна пользователю».

### Дашборд воркспейса (ANLT-04)
- **D-08:** Состав: график отправок/доставок/открытий по дням + график роста базы контактов + KPI-карточки за период (отправлено, delivered%, opened%, новые контакты, отписки) + мини-списки последних кампаний и активных цепочек с ключевыми метриками. Период: пресеты 7/30/90 дней, дефолт 30, гранулярность по дням; произвольный date-range — v2.
- **D-08a:** Дашборд становится ДОМАШНЕЙ страницей воркспейса (заменяет WorkspaceHome); онбординг-чеклист Phase 1 остаётся блоком сверху, пока не завершён.
- **D-08b:** Свежесть данных дашборда/трендов: лаг до нескольких минут допустим (инкрементальная rollup-агрегация, ROADMAP 07-01). Счётчики кампаний остаются near-real-time как есть. Никаких тяжёлых on-the-fly сканов сырых партиций на каждый заход.

### Timeline контакта (ANLT-03)
- **D-09:** Смены статуса подписки — НОВАЯ таблица истории (contact × старый→новый статус, источник/причина, timestamp), пишется из ВСЕХ точек смены: webhook-suppression, unsubscribe, ручная правка UI, CSV-импорт, API, shared upsert. История начинается с этой фазы — ретроспективную реконструкцию старых смен не делаем.
- **D-10:** Единый timeline: ContactEventFeed эволюционирует в общую хронологическую ленту (кастомные события + отправки + открытия/клики + смены статуса) с фильтром по типу записи (всё/события/письма/статусы). Отдельных вкладок нет.
- **D-11:** Повторные открытия/клики одного письма схлопываются: одна запись на первое открытие со счётчиком «×N»; клики аналогично, по URL. Сырые повторы остаются в send_events (данные не теряются).
- **D-12:** Расширенный состав сверх ANLT-03: входы/выходы из цепочек (из flow_runs, с причиной выхода) и excluded-письма с причиной — полная история «почему контакт получил/не получил письмо».

### Send log (ANLT-05)
- **D-13:** Отдельная страница «Журнал отправок» в сайдбаре — весь воркспейс, все фильтры (контакт, кампания/цепочка, статус, период). Со страниц кампании/цепочки/контакта — ссылки сюда с предвыставленным фильтром через URL-параметры. Одна таблица — много точек входа.
- **D-14:** Клик по строке — drawer/панель с полной хронологией событий письма из send_events (отправлено → доставлено → открыто ×N → клики по конкретным URL), причинами bounce/drop/exclusion и ссылками на контакт/кампанию/цепочку.
- **D-15:** Колонка и фильтр «статус» — ОДИН вычисляемый итоговый статус по цепочке Phase 5 D-06, расширенный failed и excluded; фильтр — multi-select по этим значениям.
- **D-16:** CSV-экспорт send log — НЕ в этой фазе (deferred).

### Claude's Discretion
- Схема rollup-таблиц (per-day × workspace / campaign / flow-node), механика инкрементальной агрегации и периодической сверки (ROADMAP 07-01); выбор триггера инкремента (при обработке webhook-событий vs периодический скан) — с оглядкой на идемпотентность и дедуп send_events.
- Выбор chart-библиотеки: Recharts или Tremor (CLAUDE.md допускает обе; в проекте ещё нет ни одной).
- Пагинация send log и timeline на больших объёмах (курсорная vs offset; партиционированные таблицы — учесть pruning по occurred_at), стратегия индексов под фильтры.
- Как считать «рост базы контактов» (created_at контактов vs дневные снапшоты) и «новые контакты» за период.
- RLS ENABLE+FORCE для всех новых таблиц (rollups, status history) по паттерну Phase 1–6; NULLIF-guard в policy; tenant context в воркерах агрегации (PITFALLS #5).
- Доступ по ролям: аналитика читается всеми членами воркспейса (Member включительно) — если ресёрч не выявит причин иного.
- Русские UI-тексты в стиле Phase 2–6; терминология статусов согласована с существующими бейджами (SubscriptionStatusBadge, счётчики кампаний).
- Детали UI (лейауты, скелетоны, empty states) — UI-SPEC придёт из /gsd-ui-phase (ui_phase: yes).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Ресёрч проекта
- `.planning/research/STACK.md` — Recharts/Tremor для дашбордов, TanStack Table (уже установлен) для send log, партиционирование Postgres, BullMQ repeatable jobs (для периодической сверки rollups)
- `.planning/research/PITFALLS.md` — Pitfall #5 (tenant context в каждой транзакции воркера) критичен для воркера агрегации; уроки идемпотентности
- `.planning/research/ARCHITECTURE.md` — границы компонентов, shared tables + workspace_id

### Требования и решения
- `.planning/REQUIREMENTS.md` — ANLT-01…05 (эта фаза)
- `.planning/ROADMAP.md` §Phase 7 — goal, success criteria, предварительная разбивка 07-01…07-05
- `.planning/phases/05-webhook-processing-delivery-tracking/05-CONTEXT.md` — D-06 (приоритетная цепочка статусов — единый словарь send log), D-07/D-09 (unique-счётчики; total-открытия и по-письмовый лог явно отложены В ЭТУ фазу), D-14 (send_events — источник timeline и повторных открытий), D-08 (bounced vs dropped различимы в данных)
- `.planning/phases/06-flows-triggered-chains/06-CONTEXT.md` — D-20/D-21 (иммутабельные версии, nodeId; per-step аналитика отложена в эту фазу), flow_run_steps спроектирован под ANLT-02
- `.planning/phases/04-broadcast-campaigns-send-pipeline/04-CONTEXT.md` — send ledger, exclusionReason (источник D-07/D-12), счётчики sentCount/failedCount

### Схемы данных и код (источники чтения этой фазы)
- `packages/db/src/schema/sends.ts` — unified send ledger: все delivery-факты, kind campaign/flow, flowRunId + nodeId (per-step атрибуция), exclusionReason — ГЛАВНЫЙ источник send log и метрик
- `packages/db/src/schema/send-events.ts` — сырой append-only лог webhook-событий (партиционирован по месяцам, hand-written миграции): повторные открытия/клики, URL кликов — источник drawer'а send log и схлопнутых записей timeline
- `packages/db/src/schema/flow-run-steps.ts` — append-only лог прохода узлов (nodeId, nodeType, outcome, sendId) — источник per-step проходимости (D-02)
- `packages/db/src/schema/flow-runs.ts` — входы/выходы из цепочек для timeline (D-12)
- `packages/db/src/schema/campaigns.ts` — существующие инкрементальные unique-счётчики (delivered/opened/clicked/bounced/unsubscribed) — основа обогащённой сводки (D-04)
- `packages/db/src/schema/events.ts` — кастомные события для timeline; паттерн партиционированной таблицы для новых rollup/history таблиц
- `packages/db/src/schema/contacts.ts` — subscription_status (точки смены для history-таблицы D-09), created_at (рост базы)
- `apps/worker/src/queues/webhook-events.worker.ts` — точка, где обновляются delivery-факты и счётчики — кандидат на инкремент rollup-агрегатов
- `apps/worker/src/queues/campaign-scheduler.worker.ts` — паттерн repeatable-scan + app.admin_scan RLS для периодической сверки rollups
- `apps/web/src/features/contacts/ContactEventFeed.tsx` — эволюционирует в единый timeline (D-10)
- `apps/web/src/features/campaigns/` — существующая сводка кампании (обогащается, D-04), паттерны list/detail
- `apps/web/src/features/flows/` — FlowDetailPage (вкладки canvas/settings/runs — добавляется «Аналитика»), FlowCanvas (бейджи метрик на узлах, D-03)
- `apps/web/src/features/workspace-home/` — WorkspaceHome заменяется дашбордом (D-08a), онбординг-чеклист сохраняется
- `packages/contacts-core` + `apps/api/src/modules/contacts/` — точки смены subscription status (UI/CSV/API/upsert) — все должны писать в history-таблицу (D-09)
- `packages/tenant-context` — withTenantTransaction для всех запросов воркеров

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Все первичные данные УЖЕ пишутся: sends (факты + причины + flow-атрибуция), send_events (сырые события с payload/URL), flow_run_steps (спроектирован в Phase 6 именно под ANLT-02), счётчики кампаний (near-real-time), events, flow_runs — фаза в основном строит чтение/агрегацию поверх готового
- TanStack Table 8.x установлен — send log и таблица шагов цепочки строятся на нём; chart-библиотеки НЕТ (установить Recharts или Tremor)
- CampaignProgress / SummaryView — существующий ряд из пяти счётчиков (Phase 5) — точка обогащения процентами
- Паттерн 02-13 (keepPreviousData + skeleton + isPlaceholderData dim) — стандарт для фильтруемых списков, применить к send log
- EXHAUSTIVE_LOOKUP_PAGE_SIZE / pagination.ts — единая константа пагинации (урок 04-15)

### Established Patterns
- RLS ENABLE+FORCE + NULLIF-guard для новых таблиц; hand-written миграции для партиционированных таблиц (0020 send_events); осторожность с drizzle-kit generate после ручных миграций (урок 06-13)
- Инкрементальные счётчики с first-write семантикой (WHERE col IS NULL) — идемпотентность агрегации при redelivery
- Воркеры: tenant context на транзакцию, workspaceId из job payload, детерминированный jobId с «-» разделителем
- Русскоязычный UI, Radix + react-hook-form + TanStack Query; NavLink-навигация в AppShell (новые пункты: Дашборд/Журнал отправок)

### Integration Points
- Сводка кампании (Phase 5 UI) — обогащение процентами + строка excluded + ссылка в send log
- FlowDetailPage (Phase 6, вкладки) — новая вкладка «Аналитика» + бейджи на FlowCanvas
- ContactDetailPage — ContactEventFeed → единый timeline
- AppShell sidebar — дашборд заменяет WorkspaceHome как индексный маршрут; новый пункт «Журнал отправок»
- Все точки смены subscription status (webhook worker, unsubscribe routes, contacts API/UI, CSV worker, shared upsert) — запись в history-таблицу

</code_context>

<specifics>
## Specific Ideas

- Klaviyo — референс: метрики шагов прямо на узлах canvas в контексте графа; дашборд как домашняя страница воркспейса.
- «Надёжность видна пользователю» (сквозная тема Core Value): excluded-письма с причинами в сводке (D-07) и в timeline (D-12), drawer send log с полной хронологией одного письма (D-14) — маркетолог всегда может ответить «почему это письмо не дошло».
- Пользователь везде выбирал рекомендованные варианты — стандартные индустриальные решения (rate от delivered, пресеты периодов, схлопывание повторов) без экзотики.

</specifics>

<deferred>
## Deferred Ideas

- CSV-экспорт send log по текущим фильтрам — фоновая генерация на сотнях тысяч строк, отдельная задача (D-16)
- Произвольный date-range picker на дашборде — v1 живёт с пресетами 7/30/90 (D-08)
- Селектор версии цепочки в per-step аналитике — v1 агрегирует по nodeId сквозно; вместе с version-list UI из Phase 6 v2-бэклога (D-05)
- Ретроспективная реконструкция смен subscription status до этой фазы — не делаем; история начинается с релиза history-таблицы (D-09)
- Расширенная диагностика webhook (счётчики отклонённых подписей, лог ошибок за 24ч) — упоминалась в Phase 5 deferred как «Phase 7 observability», НЕ вошла в обсуждение и НЕ входит в ANLT-01…05 — остаётся в бэклоге
- Второй знаменатель процентов (от sent) как настройка — отклонено для v1 (D-01)

</deferred>

---

*Phase: 7-Analytics, Dashboard & Send Log*
*Context gathered: 2026-07-14*
