# Requirements: Mega CRM — B2C Marketing Automation Platform

**Defined:** 2026-07-03
**Core Value:** Маркетолог настраивает триггерную цепочку или кампанию — и письма надёжно и вовремя доходят до нужных контактов, со сквозным отслеживанием статусов.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Tenancy & Workspaces

- [x] **TENANT-01**: Пользователь может зарегистрироваться и создать воркспейс (тенант)
- [x] **TENANT-02**: Пользователь может пригласить коллег в воркспейс по email
- [x] **TENANT-03**: Роли Owner/Admin/Member различают права: запуск кампаний/цепочек и смена SendGrid-ключа доступны только Owner/Admin
- [x] **TENANT-04**: Пользователь может подключить SendGrid API key воркспейса; ключ хранится зашифрованным и валидируется при подключении
- [x] **TENANT-05**: Все данные (контакты, события, цепочки, кампании, статистика) изолированы по воркспейсу — пользователь не может увидеть данные чужого тенанта

### Contacts

- [x] **CONT-01**: Пользователь может создавать, просматривать, редактировать и удалять контакты в UI
- [x] **CONT-02**: Пользователь может импортировать контакты из CSV с маппингом колонок на атрибуты, превью перед применением и отчётом об ошибках/дубликатах
- [x] **CONT-03**: Разработчик тенанта может создавать/обновлять контакты через Contacts CRUD API
- [x] **CONT-04**: Контакт идентифицируется по external_id (основной ключ) с email как запасным; события и API выполняют upsert по этой паре
- [x] **CONT-05**: Контакт хранит произвольные кастомные свойства профиля, доступные в сегментации

### Event Ingestion

- [x] **EVNT-01**: Бэкенд тенанта может отправлять события через HTTP API с API-ключом: произвольное имя события + JSON-свойства, без предварительной регистрации типов
- [x] **EVNT-02**: Событие для несуществующего контакта создаёт его автоматически (upsert по external_id/email)
- [x] **EVNT-03**: Event API отвечает быстро (2xx сразу), обработка события асинхронная через очередь

### Segmentation

- [x] **SEGM-01**: Пользователь может создать динамический сегмент по свойствам профиля (страна, теги, кастомные атрибуты)
- [x] **SEGM-02**: Пользователь может добавить поведенческие условия по событиям («сделал заказ за 30 дней», «не открывал письма за 90 дней») с count/timeframe
- [x] **SEGM-03**: Один и тот же движок оценки сегментов используется цепочками (триггеры входа, exit conditions) и кампаниями (аудитория) — единое определение «кто в сегменте»
- [x] **SEGM-04**: При построении сегмента пользователь видит live-превью количества подходящих контактов

### Subscription & Suppression

- [x] **SUBS-01**: Каждый контакт имеет 3-state статус: subscribed / unsubscribed / suppressed (bounce, spam complaint) — с разной семантикой повторной подписки
- [ ] **SUBS-02**: Unsubscribe/bounce/spam-события из SendGrid webhook автоматически обновляют статус контакта
- [ ] **SUBS-03**: Перед каждой отправкой (цепочка или кампания) применяется pre-send фильтр по статусу подписки и suppression — недоставляемым и отписанным письма не отправляются
- [ ] **SUBS-04**: Каждое отправляемое письмо содержит one-click List-Unsubscribe header (требование Gmail/Yahoo для bulk-senders)

### Flows (Triggered Chains)

- [ ] **FLOW-01**: Пользователь может построить цепочку в визуальном canvas-редакторе с drag-and-drop: узлы trigger, delay/wait, условная развилка, send email, явный exit/end на каждой ветке
- [ ] **FLOW-02**: Цепочка запускается по событию или по входу контакта в сегмент
- [ ] **FLOW-03**: Пользователь может задать exit conditions — контакт покидает цепочку при наступлении условия (например, «сделал заказ»)
- [ ] **FLOW-04**: Пользователь может настроить re-entry control: once ever / once per N days / every time
- [ ] **FLOW-05**: Пользователь может задать quiet hours — письма не отправляются в окно тишины, откладываются до его окончания
- [ ] **FLOW-06**: Цепочка имеет state machine: draft → live → paused; изменения вносятся в draft и применяются публикацией
- [ ] **FLOW-07**: Опубликованная версия цепочки иммутабельна: контакты, находящиеся в цепочке, продолжают идти по версии, на которой вошли — правки не ломают in-flight прохождения

### Broadcast Campaigns

- [ ] **CAMP-01**: Пользователь может создать broadcast-кампанию: выбрать сегмент-аудиторию и SendGrid Dynamic Template (template_id + переменные)
- [ ] **CAMP-02**: Пользователь может запустить кампанию сразу или запланировать на дату/время
- [ ] **CAMP-03**: Кампания имеет state machine: draft → scheduled → sending → sent; случайный запуск черновика невозможен
- [ ] **CAMP-04**: Пользователь может отправить тестовое письмо кампании на свой адрес с тестовыми dynamic_template_data
- [ ] **CAMP-05**: Во время отправки пользователь видит прогресс кампании (отправлено/всего)

### Send Pipeline

- [ ] **SEND-01**: Все отправки — и триггерные, и broadcast — проходят через очередь; прямых отправок в обход очереди нет
- [ ] **SEND-02**: Отправка троттлится по RPS отдельно на каждый тенант (под лимиты его SendGrid-плана)
- [ ] **SEND-03**: Триггерные письма имеют приоритет над broadcast: массовая кампания не задерживает триггерные письма (SLO: триггерное письмо уходит за минуты, не часы)
- [ ] **SEND-04**: Глобальный frequency cap на контакт применяется поверх всех цепочек и кампаний через единый журнал отправок
- [ ] **SEND-05**: Письма отправляются через SendGrid v3 mail/send с template_id + dynamic_template_data; платформа не рендерит контент
- [ ] **SEND-06**: Отправка идемпотентна: ретраи джобов и сбои воркеров не приводят к дублям писем
- [ ] **SEND-07**: Ответы 429/5xx от SendGrid обрабатываются с backoff-ретраями без потери писем

### Webhook Processing

- [ ] **WBHK-01**: Платформа принимает SendGrid Event Webhook на per-tenant URL с проверкой ECDSA-подписи по сырому телу запроса
- [ ] **WBHK-02**: Обрабатываются события delivered / opened / clicked / bounced / unsubscribed / spam report / dropped
- [ ] **WBHK-03**: События дедуплицируются по sg_event_id — повторная доставка webhook не искажает статистику
- [ ] **WBHK-04**: Webhook-события обновляют статус конкретного письма в send log и статус подписки контакта

### Analytics

- [ ] **ANLT-01**: Пользователь видит метрики кампании: sent / delivered / opened / clicked / bounced / unsubscribed (счётчики и проценты)
- [ ] **ANLT-02**: Пользователь видит метрики каждого шага цепочки — какой шаг недорабатывает
- [ ] **ANLT-03**: В карточке контакта отображается timeline: кастомные события, отправленные письма, открытия, клики, смены статуса подписки
- [ ] **ANLT-04**: Сводный дашборд воркспейса: динамика отправок/доставок/открытий за период, рост базы контактов
- [ ] **ANLT-05**: По-письмовый send log с текущим статусом каждого письма и фильтрами (контакт, кампания/цепочка, статус, период)

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Flows

- **FLOW-V2-01**: A/B-тестирование внутри цепочек (ветки/письма, автовыбор победителя)
- **FLOW-V2-02**: Валидация/линтинг canvas-цепочек (мёртвые ветки, отсутствующий exit, orphan-узлы)

### Events

- **EVNT-V2-01**: Реестр обнаруженных типов событий (surface наблюдаемых схем без их enforcement)

### Segmentation

- **SEGM-V2-01**: RFM / предиктивная сегментация (churn risk, CLV)
- **SEGM-V2-02**: Sunset/win-back инструменты (автопометка неактивных контактов, win-back сегменты)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Модуль сделок / sales-пайплайн | Платформа для маркетинга, не для продаж — принципиальное решение |
| Собственный редактор шаблонов писем | Конфликтует с архитектурой SendGrid Dynamic Templates; платформа передаёт только template_id + данные |
| Каналы кроме email (SMS, push, мессенджеры) | Email-only в v1: глубина важнее охвата; каждый канал — свой compliance и провайдер |
| ИИ-генерация контента, автоперевод | Нет in-app поверхности контента; явное решение первого этапа |
| JS-сниппет onsite-трекинга | События в v1 только через server-side API |
| Батч-интеграции с e-commerce платформами | В v1 достаточно CSV-импорта и API |
| Общий SendGrid-аккаунт платформы (subusers) | Общая репутация отправки — риск; BYO key проще и безопаснее для MVP |
| Строгие схемы/валидация событий | Трение при интеграции; свободная модель как у Klaviyo |
| Real-time streaming-аналитика | На масштабе года-1 достаточно периодических rollups (1–5 мин лаг) |
| Биллинг/тарификация тенантов | Не в v1 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| TENANT-01 | Phase 1 | Complete |
| TENANT-02 | Phase 1 | Complete |
| TENANT-03 | Phase 1 | Complete |
| TENANT-04 | Phase 1 | Complete |
| TENANT-05 | Phase 1 | Complete |
| CONT-01 | Phase 2 | Complete |
| CONT-02 | Phase 2 | Complete |
| CONT-03 | Phase 2 | Complete |
| CONT-04 | Phase 2 | Complete |
| CONT-05 | Phase 2 | Complete |
| EVNT-01 | Phase 2 | Complete |
| EVNT-02 | Phase 2 | Complete |
| EVNT-03 | Phase 2 | Complete |
| SUBS-01 | Phase 2 | Complete |
| SEGM-01 | Phase 3 | Complete |
| SEGM-02 | Phase 3 | Complete |
| SEGM-03 | Phase 3 | Complete |
| SEGM-04 | Phase 3 | Complete |
| CAMP-01 | Phase 4 | Pending |
| CAMP-02 | Phase 4 | Pending |
| CAMP-03 | Phase 4 | Pending |
| CAMP-04 | Phase 4 | Pending |
| CAMP-05 | Phase 4 | Pending |
| SEND-01 | Phase 4 | Pending |
| SEND-02 | Phase 4 | Pending |
| SEND-03 | Phase 4 | Pending |
| SEND-04 | Phase 4 | Pending |
| SEND-05 | Phase 4 | Pending |
| SEND-06 | Phase 4 | Pending |
| SEND-07 | Phase 4 | Pending |
| SUBS-03 | Phase 4 | Pending |
| SUBS-04 | Phase 4 | Pending |
| WBHK-01 | Phase 5 | Pending |
| WBHK-02 | Phase 5 | Pending |
| WBHK-03 | Phase 5 | Pending |
| WBHK-04 | Phase 5 | Pending |
| SUBS-02 | Phase 5 | Pending |
| FLOW-01 | Phase 6 | Pending |
| FLOW-02 | Phase 6 | Pending |
| FLOW-03 | Phase 6 | Pending |
| FLOW-04 | Phase 6 | Pending |
| FLOW-05 | Phase 6 | Pending |
| FLOW-06 | Phase 6 | Pending |
| FLOW-07 | Phase 6 | Pending |
| ANLT-01 | Phase 7 | Pending |
| ANLT-02 | Phase 7 | Pending |
| ANLT-03 | Phase 7 | Pending |
| ANLT-04 | Phase 7 | Pending |
| ANLT-05 | Phase 7 | Pending |

**Coverage:**

- v1 requirements: 49 total
- Mapped to phases: 49
- Unmapped: 0 ✓

> Note: an earlier draft of this file recorded "41 total"; the actual v1 requirement-ID count is 49. Count corrected during roadmap creation.

---
*Requirements defined: 2026-07-03*
*Last updated: 2026-07-03 after roadmap creation (traceability populated, 49/49 mapped)*
