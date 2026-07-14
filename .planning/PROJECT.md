# Mega CRM — B2C Marketing Automation Platform

## What This Is

Multi-tenant SaaS-платформа marketing automation для B2C-компаний — аналог Klaviyo по модели, но без модуля сделок и sales-пайплайна. Маркетологи компаний-тенантов управляют базой контактов и сегментами, строят триггерные цепочки (событие → условие → серия писем) в визуальном canvas-редакторе и запускают разовые broadcast-кампании по сегментам. Доставка — email через SendGrid (BYO API key у каждого тенанта), контент — через SendGrid Dynamic Templates.

## Core Value

Маркетолог настраивает триггерную цепочку или кампанию — и письма надёжно и вовремя доходят до нужных контактов, со сквозным отслеживанием статусов (delivered/opened/clicked/bounced) по каждому письму, шагу цепочки и кампании.

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

### Active
- [ ] Webhook hardening (из 05-REVIEW WR-01): при общем BYO SendGrid-ключе на несколько воркспейсов отбрасывать события чужого workspace (сейчас сырые payload'ы соседнего workspace сохраняются в его send_events; атрибуция не страдает — resolution workspace-scoped)

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

- Greenfield: пустой репозиторий (`mega-crm`), git инициализирован, кода нет
- Референс продуктовой модели — Klaviyo (flows, сегментация, событийная модель)
- Целевой масштаб первого года: 100k–1M контактов суммарно по тенантам, сотни тысяч писем в день — сегментация и отправка проектируются под этот объём (батчинг, аккуратные индексы), без преждевременного оверинжиниринга
- Canvas-редактор цепочек — самый дорогой UI-компонент; экосистема TypeScript/React выбрана в том числе из-за зрелых библиотек графовых редакторов

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
*Last updated: 2026-07-14 after Phase 7 completion (11/11 планов; verification 9/9 после двух gap-closure раундов — 07-10 campaign/flow-селектор в журнале отправок, 07-11 cmdk selection identity по id (human-verify checkpoint approved); UAT-гэп и debug-сессия resolved; code review: 0 critical / 8 warnings / 11 info (advisory); security review: 0 threats open; последняя фаза roadmap v1.0 — milestone готов к аудиту/закрытию)*
