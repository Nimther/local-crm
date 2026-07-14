# Phase 6: Flows (Triggered Chains) - Context

**Gathered:** 2026-07-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Маркетолог визуально строит триггерную цепочку на canvas (@xyflow/react): узлы trigger, delay/wait, условная развилка, send email, явный exit на каждой ветке — публикует её (draft → live → paused) и контакты проходят по ней автоматически: вход по событию или по входу в сегмент, задержки и ветвления соблюдаются, quiet hours откладывают письма, re-entry control (once ever / once per N days / every time) ограничивает повторные входы. Отправка едет через ГОТОВЫЙ send-пайплайн Phase 4/5: очередь `email-triggered`, per-tenant троттлинг, pre-send gate (подписка/suppression), frequency cap, идемпотентный dispatch, unified send ledger (`sends.kind`), delivery-факты из webhook. Опубликованная версия иммутабельна: правки живут в draft и применяются публикацией; in-flight контакты продолжают идти по версии входа (FLOW-07). Требования: FLOW-01…07. Режим фазы: MVP.

Зафиксировано до обсуждения (ROADMAP/PROJECT/CLAUDE.md — не пересматривать):
- Canvas-библиотека: `@xyflow/react` 12.x (НЕ пакет `reactflow` — stale, CLAUDE.md «What NOT to Use»).
- Очередь: существующая полоса `email-triggered` + общий `processSendJob` — никакого отдельного dispatch-пути для цепочек.
- Сегментный движок общий (SEGM-03): `isContactInSegment` спроектирован под триггеры/условия цепочек ещё в Phase 3.
- Frequency cap применяется к flow-письмам через единый журнал отправок (Phase 4 D-13).
- Запуск/публикация цепочек — Owner/Admin only (TENANT-03).

</domain>

<decisions>
## Implementation Decisions

### Триггеры и вход (FLOW-02)
- **D-01:** Event-триггер матчится ТОЛЬКО по имени события (picker из наблюдаемых имён воркспейса + свободный ввод — паттерн Phase 3 D-05). Фильтры по свойствам события — v2 (последовательно с Phase 3 D-07: freeform JSON без реестра схем не даёт типизированного UI).
- **D-02:** Детекция «контакт вошёл в сегмент» — гибрид: (а) event-driven re-check изменившегося контакта (после event ingest / правки контакта / смены статуса) через `isContactInSegment` + (б) периодический sweep-скан как страховка для time-based условий («не открывал 90 дней» становится истиной без каких-либо мутаций контакта). Оба механизма строятся в этой фазе; для trigger-сегментов ведётся per-flow membership snapshot для диффа.
- **D-03:** Один trigger-узел на цепочку: событие ИЛИ вход в сегмент. Нужны оба пути — строится две цепочки. Упрощает re-entry-учёт, версионирование и валидацию canvas.
- **D-04:** При публикации цепочки с сегмент-триггером диалог публикации спрашивает: «зачислить N уже находящихся в сегменте контактов?» — да (batch-enroll, уважая re-entry/frequency cap/quiet hours) или нет (только новые входы; существующие помечаются «seen» в snapshot без зачисления).
- **D-05:** Unsubscribed/suppressed контакты ВХОДЯТ в цепочку и идут по ней; их письма отфильтрует существующий pre-send gate (записи excluded в леджере). Ре-подписка mid-flow означает, что последующие письма возобновятся. Никакой второй проверки подписки на входе.

### Re-entry control (FLOW-04)
- **D-06:** «Once per N days» отсчитывается от момента ПОСЛЕДНЕГО ВХОДА контакта в цепочку (Klaviyo-модель; хранится last-entry timestamp per contact×flow).
- **D-07:** Максимум ОДИН активный run на пару contact×flow. Триггер, сработавший пока run активен, игнорируется (не ставится в очередь) — защита от interleaved-последовательностей. Правило действует поверх всех трёх режимов re-entry.

### Delays и quiet hours (FLOW-05)
- **D-08:** Timezone-источник для quiet hours: PER-CONTACT timezone — новое стандартное поле контакта `timezone` (IANA-имя, валидируется; задаётся через UI/CSV-маппинг/API), с fallback на новую настройку воркспейса «timezone по умолчанию» (в send settings). Оба слоя строятся в этой фазе. (Пользователь осознанно выбрал per-contact вместо workspace-only, пересмотрев дефолт Phase 4 D-06 для цепочек.)
- **D-09:** Quiet hours конфигурируются на воркспейсе (дефолтное окно в send settings) с per-flow override: цепочка может переопределить окно или отключить quiet hours целиком.
- **D-10:** Отложенные quiet-hours письма высвобождаются в момент окончания окна все сразу; сглаживание берёт на себя существующий per-tenant token bucket + triggered-полоса — никакого нового jitter-механизма.
- **D-11:** Delay-узел двух видов: фиксированная длительность (N минут/часов/дней) И wait-until («до следующих 10:00», «до понедельника») — wait-until вычисляется в той же timezone-логике, что quiet hours (contact TZ → workspace fallback). DST-математика — на планировщике/ресёрче.

### Ветвления и exit (FLOW-01, FLOW-03)
- **D-12:** Условная развилка проверяет ТОЛЬКО членство в сегменте («контакт ∈ сегмент X сейчас?») через `isContactInSegment` — один словарь условий на всю платформу (сегменты уже выражают атрибуты, теги и поведение). Inline-условия на canvas и проверки «открыл предыдущее письмо» — НЕ в v1 (deferred).
- **D-13:** Развилка бинарная: ровно два исходящих ребра (да/нет). Multi-way композируется цепочкой условий.
- **D-14:** Exit conditions вычисляются на ГРАНИЦАХ ШАГОВ: когда run просыпается действовать — после истечения delay, перед send — сначала проверяются exit-условия. Покупка посреди delay выведет контакта в момент окончания delay, ДО отправки письма. Непрерывного event-driven exit-вотчера нет.
- **D-15:** Exit conditions двух видов, конфигурируются на уровне цепочки: (а) сегментные — «контакт в сегменте X» / «контакт больше не в сегменте X»; (б) событийные — «событие {имя} произошло после входа в run» (проверка по таблице events с occurred_at > run started_at). Explicit exit-УЗЛЫ на ветках (FLOW-01) — отдельная вещь: просто маркеры конца пути.
- **D-16:** Send-узел конфигурируется по образцу кампаний: Dynamic Template из списка аккаунта тенанта (Phase 4 D-16), верифицированный отправитель (D-17), стандартная документированная форма dynamic_template_data (D-18). Никакого per-node маппинга переменных.
- **D-17:** Строгая publish-валидация, блокирующая ТОЛЬКО жёсткие ошибки: нет триггера, пустой send-узел (без шаблона/отправителя), ветка не заканчивается exit-узлом. Расширенный линтинг (мёртвые ветки, orphan-узлы) — v2 (FLOW-V2-02).

### Lifecycle и версионирование (FLOW-06, FLOW-07)
- **D-18:** Pause = полная заморозка: новых входов нет, шаги не исполняются — истекшие таймеры держатся, отправки стоят. Resume продолжает всех с того же места.
- **D-19:** На resume просроченные за паузу шаги исполняются НЕМЕДЛЕННО (сглаживание — token bucket; quiet hours всё равно уважаются на dispatch). Поздно — но никогда не пропущено; silent-skip эвристик нет.
- **D-20:** Модель редактирования live-цепочки: единственный working draft, автосоздаваемый из live-версии при первой правке. Publish атомарно делает draft новой live-версией; новые входы идут по ней, in-flight runs продолжают версию входа. Explicit version-list UI (просмотр/откат версий) — НЕ в v1; иммутабельные версии живут на уровне хранения.
- **D-21:** Видимость версий: страница цепочки показывает «N контактов в цепочке (M на старых версиях)». Единственная интервенция — «удалить контакта из цепочки» (eject, точечно или списком). Миграции runs между версиями НЕТ — FLOW-07 существует именно чтобы её не делать.
- **D-22:** Терминального состояния в v1 нет: «остановить навсегда» = pause. Удалять можно только никогда не публиковавшиеся цепочки и paused-цепочки с нулём активных runs. Archive/cleanup UX — позже.
- **D-23:** Publish/pause/resume/enroll-existing — Owner/Admin only; Member создаёт и редактирует драфты (зеркало матрицы кампаний Phase 4). «Дублировать цепочку» — есть: копия становится новым draft со всеми узлами (зеркало campaign D-11).
- **D-24:** Удаление сегмента, на который ссылается цепочка (триггер, развилка, exit) — заблокировано: restrict-when-referenced, тот же паттерн/error-mapping что campaigns (Phase 4 04-05, 23503 → conflict).

### Claude's Discretion
- Схема хранения flow definition (nodes/edges JSON), таблиц versions/runs/steps; RLS ENABLE+FORCE по паттерну Phase 1–5; tenant context в воркерах (PITFALLS #5) — обязателен.
- Механика execution engine: BullMQ delayed jobs vs периодический scheduler-scan для истечения delay (ROADMAP 06-04 упоминает reconciliation scan — надёжность при рестартах обязательна); идемпотентность шагов (retried job не шлёт письмо дважды — паттерн send ledger); формат jobId.
- Интервал sweep-скана сегмент-триггеров (D-02) и его нагрузка; структура membership snapshot; батчинг enroll-existing (D-04) на больших сегментах (statement_timeout движка 15s — координировать с бенчмарк-флагом STATE.md).
- Как frequency-capped flow-письмо обрабатывается — skip как в broadcast (Phase 4 D-14) или deferral; Phase 4 пометил deferral как «территорию Phase 6» — решить на ресёрче/планировании с учётом семантики цепочек.
- Детали canvas UX (палитра узлов, layout, autosave, зум/minimap) — UI-SPEC придёт из /gsd-ui-phase (ui_phase: yes); русские UI-тексты в стиле Phase 2–5.
- Валидация IANA timezone (список/библиотека), UI выбора timezone контакта и воркспейса.
- Структура flow-фичи на фронте (features/flows по образцу campaigns/segments), страница списка цепочек, страница цепочки (canvas + статус + счётчики runs).
- Что показывать про runs в этой фазе (минимум: счётчики активных/на старых версиях + eject) — детальная per-step аналитика это Phase 7 (ANLT-02).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Ресёрч проекта (критично для этой фазы)
- `.planning/research/STACK.md` — @xyflow/react 12.x (НЕ reactflow), BullMQ 5 delayed jobs/repeatable jobs для delay-шагов и sweep, две очереди email-triggered/email-broadcast, rate-limiter-flexible
- `.planning/research/PITFALLS.md` — Pitfall #5 (tenant context на каждую транзакцию воркера) критичен для flow-execution воркеров; уроки идемпотентности
- `.planning/research/ARCHITECTURE.md` — границы компонентов, shared tables + workspace_id

### Требования и решения
- `.planning/REQUIREMENTS.md` — FLOW-01…07 (эта фаза); FLOW-V2-01/02 (что явно отложено); ANLT-02/05 (Phase 7 — потребитель flow-step данных: проектировать runs/steps под неё, не строя её)
- `.planning/ROADMAP.md` §Phase 6 — goal, success criteria, предварительная разбивка 06-01…06-05
- `.planning/phases/04-broadcast-campaigns-send-pipeline/04-CONTEXT.md` — D-13/D-14 (frequency cap, deferral «территория Phase 6»), D-16/D-17/D-18 (шаблон/отправитель/dynamic_template_data — переиспользуются send-узлом), D-11 (duplicate)
- `.planning/phases/05-webhook-processing-delivery-tracking/05-CONTEXT.md` — D-15 (custom_args маркировка писем send_id/workspace_id — flow-письма получают её автоматически через processSendJob), delivery-факты для flow-писем
- `.planning/phases/03-segmentation-engine/03-CONTEXT.md` — D-13 (сегменты динамические, ссылка по id), D-14 (restrict-when-referenced — расширяется на цепочки), контракт движка под «контакт ∈ сегмент?»

### Схемы данных и код (точки расширения)
- `packages/db/src/schema/sends.ts` — unified send ledger: `kind` различает campaign/flow-step sends, `campaign_id` nullable под flow-сенды (комментарий в схеме прямо это предусматривает); flow-step send пишет сюда
- `apps/worker/src/queues/email-triggered.worker.ts` — готовая triggered-полоса (concurrency 20, тот же processSendJob); Phase 6 — её первый реальный producer
- `apps/worker/src/queues/send-dispatch.ts` — общий processSendJob: pre-send gate, token bucket, идемпотентность, backoff — flow-письма НЕ строят свой dispatch
- `packages/shared-schemas/src/queues.ts` — EMAIL_TRIGGERED_QUEUE + Zod job-схемы; сюда добавляются flow-очереди/джобы (BullMQ запрещает «:» в именах очередей — паттерн «flows-...»)
- `apps/api/src/modules/segments/segment.repository.ts` — isContactInSegment (триггеры D-02, развилки D-12, exits D-15) + countSegmentMembers (счётчик в publish-диалоге D-04)
- `packages/db/src/schema/events.ts` — таблица events: вход event-триггеров (D-01) и event-since-entry exits (D-15); партиционирована, PK (workspace_id, id, occurred_at)
- `packages/db/src/schema/workspace-send-settings.ts` — сюда добавляются workspace default timezone и default quiet hours (D-08/D-09)
- `packages/db/src/schema/contacts.ts` — сюда добавляется стандартное поле timezone (D-08); реестр свойств/CSV-маппинг должны его знать
- `apps/worker/src/queues/campaign-scheduler.worker.ts` — паттерн repeatable-job скана due-объектов (переиспользуется для sweep D-02 / reconciliation), включая app.admin_scan RLS-паттерн кросс-тенантного discovery (04-06)
- `packages/tenant-context` — withTenantTransaction для всех запросов воркеров

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `email-triggered` очередь + воркер (Phase 4) — полностью готовая полоса доставки flow-писем: pre-send gate, per-tenant RPS, идемпотентность, backoff, frequency cap, List-Unsubscribe — всё наследуется через processSendJob без доработки
- `sends` ledger — спроектирован под flow-сенды (kind, nullable campaign_id); delivery-факты Phase 5 лягут на flow-письма автоматически (custom_args send_id уже проставляется в processSendJob)
- Сегментный движок — isContactInSegment (точечная проверка) построен в Phase 3 именно под этот сценарий (SEGM-03); countSegmentMembers для publish-диалога
- `campaign-scheduler.worker.ts` — паттерн repeatable-scan + FOR UPDATE SKIP LOCKED + admin_scan RLS policy для кросс-тенантного discovery due-объектов — прямой образец для delay-таймеров/sweep/reconciliation
- `apps/web/src/features/campaigns` — паттерны builder/list/detail/state-machine-диалогов (launch/pause), role-gated UI; flows — новая фича по образцу
- SendGrid-интеграция: список Dynamic Templates + верифицированных отправителей (Phase 4) — переиспользуется send-узлом as-is

### Established Patterns
- RLS ENABLE+FORCE миграции для всех новых таблиц (flows, flow_versions, flow_runs, …); NULLIF-guard в policy (уроки 02-03/04-06)
- Воркеры устанавливают tenant context на транзакцию (PITFALLS #5); Pattern 2 — workspaceId всегда из job payload
- Идемпотентность через детерминированный jobId (workspace-scoped, разделитель «-», не «:») + DB-уровневые UNIQUE/ON CONFLICT
- Zod-схемы в packages/shared-schemas; @fastify/type-provider-zod на роутах; русскоязычный UI (Radix + react-hook-form + TanStack Query)

### Integration Points
- Phase 7 (аналитика): per-step метрики цепочек (ANLT-02) и flow-фильтр send log (ANLT-05) читают структуры этой фазы — runs/steps проектировать с оглядкой, не строя аналитику
- Contacts (Phase 2): новое стандартное поле timezone встраивается в contact form / CSV-маппинг / Contacts API / реестр свойств
- Send settings (Phase 4): workspace default timezone + default quiet hours добавляются в существующий экран настроек отправки
- Segments (Phase 3): restrict-delete расширяется — сегмент, на который ссылается цепочка, не удалить (D-24); редактор сегмента может показать предупреждение «используется цепочкой X» (паттерн Phase 4 D-03)
- Онбординг-чеклист (Phase 1 D-23): пункт «постройте первую цепочку» — опционально, discretion

</code_context>

<specifics>
## Specific Ideas

- Klaviyo — референс модели flows: single trigger, one active run per contact, «once per N days от входа», backfill-выбор при публикации, single working draft.
- «Надёжность видна пользователю» (сквозная тема Core Value): publish-диалог с явным числом зачисляемых контактов (D-04), счётчик «N в цепочке (M на старых версиях)» (D-21), честное «поздно, но не пропущено» после паузы (D-19).
- Пользователь осознанно выбрал per-contact timezone (D-08) — сильнее, чем workspace-only рекомендация: quiet hours должны быть тишиной для ПОЛУЧАТЕЛЯ. Это пересматривает дефолт Phase 4 D-06 для territory цепочек (кампании не трогаем).
- Пользователь выбрал «Both» для exit conditions (D-15) и «Duration + wait-until» для delays (D-11) — выразительность движка важнее минимализма; но словарь условий развилок сознательно сужен до сегментов (D-12).

</specifics>

<deferred>
## Deferred Ideas

- Фильтры по свойствам события в event-триггерах («заказ, где сумма > 100») — v2, вместе с сегментными property-фильтрами (Phase 3 D-07, EVNT-V2-01)
- Условие развилки «открыл/кликнул предыдущее письмо цепочки» (flow-local email-engagement checks) — v2; классический паттерн, но требует второго источника условий поверх сегментов
- Inline-условия на canvas (без сохранённого сегмента) — v2
- Multi-way switch-развилка (N веток из одного узла) — v2; v1 композирует бинарными
- Explicit version-list UI (история версий, откат, branch от старой версии) — v2; хранение версионное уже в v1 (D-20)
- Терминальное состояние «stopped»/архив цепочек — v2 (D-22)
- Bulk-действие «завершить все runs на старых версиях» — v2; emergency покрывается pause + eject (D-21)
- Continuous (event-driven) exit-вычисление в реальном времени — v2; v1 проверяет на границах шагов (D-14)
- Deferred-отправка frequency-capped писем — если ресёрч не решит иначе, остаётся open discretion-вопросом этой фазы (Phase 4 D-14 пометил её «территорией Phase 6»)
- A/B-ветки в цепочках — v2 (FLOW-V2-01, уже в REQUIREMENTS.md)
- Canvas-линтинг (мёртвые ветки, orphan-узлы) — v2 (FLOW-V2-02); v1 блокирует только жёсткие ошибки (D-17)

</deferred>

---

*Phase: 6-Flows (Triggered Chains)*
*Context gathered: 2026-07-09*
