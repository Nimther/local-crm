# Phase 9: Partition Automation & Boundary Safety - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-06
**Phase:** 9-partition-automation-boundary-safety
**Areas discussed:** Канал алерта до Phase 15, Партиции vs миграции, Форма процедуры переноса, Lookahead и пороги

---

## Канал алерта до Phase 15

| Option | Description | Selected |
|--------|-------------|----------|
| Email через платформенный ключ | Письмо оператору через PLATFORM_SENDGRID_API_KEY + громкий провал job'а в Bull Board | ✓ |
| Только громкий провал job'а | Failed job в Bull Board + structured error log, без внешнего канала | |
| Запись в БД + healthcheck | Статус буфера в таблице, читается будущим /readyz (Phase 14) | |

**User's choice:** Email через платформенный ключ (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| API-сторож | Job пишет last-run timestamp в БД; API-процесс проверяет и алертит при просрочке | ✓ |
| Большой буфер + документация | Принять остаточный риск, зафиксировать как ограничение до Phase 15 | |
| Внешний cron/uptime-сервис | Dead-man's-switch через healthchecks.io и подобные | |

**User's choice:** API-сторож (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Каждый прогон | Ежедневное письмо, пока буфер ниже порога | ✓ |
| Только при смене состояния | Письмо на переходе healthy↔unhealthy | |

**User's choice:** Каждый прогон (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Plain-text без шаблона | Цифры прямо в теле письма, без зависимости от Dynamic Templates | ✓ |
| Dynamic Template | Шаблон в SendGrid-аккаунте платформы | |

**User's choice:** Plain-text без шаблона (Recommended)

---

## Партиции vs миграции

| Option | Description | Selected |
|--------|-------------|----------|
| Общая функция + вызов из фикстуры | Идемпотентная ensurePartitions в packages/db; вызывают job и db-fixture | ✓ |
| Job генерирует миграции | Партиции через историю миграций — нерабочая механика на живом сервере | |
| Runtime-DDL без интеграции с фикстурой | Тесты полагаются на DEFAULT; тестовая среда расходится с продом | |

**User's choice:** Общая функция + вызов из фикстуры (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Да, миграция + job | Hand-written catch-up миграция до горизонта — дедлайн закрыт самим деплоем | ✓ |
| Только runtime-функция | Дедлайн зависит от того, что воркер жив и тик зарегистрирован | |

**User's choice:** Да, миграция + job (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| И при бооте воркера | Немедленный одноразовый job при регистрации + repeatable | ✓ |
| Только ежедневный тик | Как четыре существующих тика, без особого поведения на бооте | |

**User's choice:** И при бооте воркера (Recommended)

---

## Форма процедуры переноса

| Option | Description | Selected |
|--------|-------------|----------|
| Скрипт + runbook | Исполняемый npm-скрипт (батчи + CHECK-first attach), запуск оператором; автотест гоняет скрипт | ✓ |
| Авто-drain в job'е | Maintenance job сам переносит строки каждый прогон | |
| Только runbook с SQL | Документ с SQL-шагами; автотест не может проверить без дублирования | |

**User's choice:** Скрипт + runbook (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Переносить всё | Партиция под каждый занятый месяц; DEFAULT после прогона пуст | ✓ |
| Переносить только ближнее окно | Экстремальные strays остаются в DEFAULT до Phase 13 | |

**User's choice:** Переносить всё (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Да, в каждый прогон | COUNT по обеим DEFAULT-партициям; >0 → алерт с указанием запустить перенос | ✓ |
| Нет, только буфер партиций | Job следит только за будущими партициями | |

**User's choice:** Да, в каждый прогон (Recommended)

---

## Lookahead и пороги

| Option | Description | Selected |
|--------|-------------|----------|
| Создавать +3, алерт <2 | Месяц запаса между нормой и порогом | ✓ |
| Создавать +2, алерт <1 | Минимум по букве DB-01, без запаса | |
| Создавать +6, алерт <3 | Щедрый запас, выходит за формулировку DB-01 | |

**User's choice:** Создавать +3, алерт <2 (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Константы в коде | Версионируемые константы с обоснованием, изменение видно в диффе | ✓ |
| Env-переменные | Гибко без деплоя, но невидимое изменение вне диффа | |

**User's choice:** Константы в коде (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Cron-паттерн, фикс. час UTC | Предсказуемо для оператора и API-сторожа | ✓ |
| repeat.every от боота | Единообразно с тиками, но время плывёт с рестартами | |
| На усмотрение исполнителя | Зафиксировать только «раз в сутки» | |

**User's choice:** Cron-паттерн, фикс. час UTC (Recommended)

---

## Claude's Discretion

- Имена env-переменной адреса оператора, таблицы last-run, точный порог сторожа, час запуска cron
- Механика batched-переноса (размер батча, форма цикла)
- Дизайн boundary-теста (инжекция часов vs управляемое окно партиций)
- Расположение runbook'а

## Deferred Ideas

- Ограничение провайдерского occurred_at — Phase 13 (CMP-05)
- Настоящий алертинг (Sentry, hosted logs) — Phase 15
- Retention/удаление старых партиций — Phase 14 (DB-11)
- /readyz-интеграция статуса партиций — Phase 14 (OPS-05)
