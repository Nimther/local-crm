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

### Active

- [ ] Отправка через SendGrid от имени тенанта (BYO key) — connect выполнен в Phase 1, send-путь в Phase 4
- [ ] Управление контактами: CRUD в UI, CSV-импорт с маппингом колонок, Contacts CRUD API, автосоздание из событий (upsert)
- [ ] Идентификация контакта: external_id (основной ключ) + email (запасной)
- [ ] Event ingestion: server-side HTTP API с API-ключом, свободная схема событий (имя + JSON-свойства, как у Klaviyo)
- [ ] Сегментация: динамические сегменты по свойствам профиля И по поведению/событиям («сделал заказ за 30 дней», «не открывал письма»)
- [ ] Статус подписки: платформа ведёт свой subscription status, обрабатывает unsubscribe из SendGrid webhook, фильтрует перед отправкой
- [ ] Триггерные цепочки: визуальный canvas-редактор с drag-and-drop (узлы, ветвления, соединения)
- [ ] Правила цепочек: exit conditions, контроль повторного входа (once ever / once per N days / every time), quiet hours, глобальный frequency cap на контакт
- [ ] Broadcast-кампании: создание, выбор сегмента, запуск/планирование
- [ ] Отправка через SendGrid v3 mail/send + Dynamic Templates (template_id + dynamic_template_data)
- [ ] Очередь отправки с контролем RPS: и триггерные, и broadcast-письма через очередь; broadcast не блокирует триггерные
- [ ] SendGrid Event Webhook: обработка delivered/opened/clicked/bounced/unsubscribed
- [ ] Аналитика: метрики по кампаниям и шагам цепочек (sent/delivered/opened/clicked/bounced/unsubscribed), timeline активности в карточке контакта, сводный дашборд воркспейса, по-письмовый лог отправок с фильтрами

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
| Canvas drag-and-drop редактор цепочек в v1 | Ключевой дифференциатор UX, как Klaviyo/n8n; принято осознанно несмотря на стоимость | — Pending |
| Свободная схема событий (имя + JSON) | Минимум трения при интеграции, модель Klaviyo; типы появляются в UI по мере поступления | — Pending |
| external_id + email, upsert контакта из события | Стабильная идентификация при смене email; событие может создать контакт | — Pending |
| Собственный subscription status + фильтрация перед отправкой | Статус виден в платформе и участвует в сегментации; не полагаемся только на SendGrid suppression | — Pending |
| Поведенческая сегментация в v1 | Ядро ценности Klaviyo-подобного продукта; без неё триггерные сценарии слабые | — Pending |
| Очередь + RPS-троттлинг в MVP | Rate limits SendGrid; broadcast не должен блокировать триггерные письма | — Pending |
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
*Last updated: 2026-07-04 after Phase 1 transition (UAT passed 34/34, security verified, phase marked complete)*
