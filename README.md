# Mega CRM

B2C marketing automation platform, multi-tenant SaaS.

Mega CRM — платформа маркетинговой автоматизации для B2C-компаний, аналог Klaviyo по модели, но без модуля сделок и sales-пайплайна. Маркетологи компаний-тенантов ведут базу контактов и сегменты, строят триггерные цепочки (событие → условие → серия писем) в визуальном canvas-редакторе и запускают разовые broadcast-кампании по сегментам.

Доставка писем — через SendGrid Transactional API v3 (`mail/send`) по модели BYO API key: каждый тенант подключает собственный SendGrid-ключ, репутация домена и контент (SendGrid Dynamic Templates) остаются в его аккаунте. Платформа сама письма не рендерит — только собирает данные и вызывает SendGrid.

Каждое письмо, шаг цепочки и кампания сквозно отслеживаются по статусам delivered/opened/clicked/bounced через SendGrid Event Webhook, с автоматическим suppression подписки при bounce/spam/unsubscribe.

**Текущее состояние:** v1.0 MVP выпущен 2026-07-14, все 7 фаз roadmap завершены.

## Возможности

- Multi-tenant воркспейсы с приглашением команды по email и ролями Owner/Admin/Member
- Подключение SendGrid-ключа тенанта с live-валидацией и хранением через envelope encryption (KMS)
- Управление контактами: CRUD в UI, CSV-импорт с маппингом колонок, Contacts API, автосоздание контакта из событий (upsert)
- Идентификация контакта по `external_id` с email как запасным ключом
- Server-side event ingestion со свободной JSON-схемой событий (имя + произвольные свойства)
- Динамические сегменты по свойствам профиля и по поведению/событиям
- Broadcast-кампании: сегмент + Dynamic Template, тестовое письмо, планирование запуска, live-прогресс отправки
- Триггерные цепочки в визуальном canvas-редакторе с версионированной публикацией (draft → live → paused)
- Правила цепочек: exit conditions, контроль повторного входа, quiet hours, глобальный frequency cap на контакт
- Очередь отправки с раздельными потоками `email:triggered` / `email:broadcast` и per-tenant RPS-троттлингом
- SendGrid Event Webhook с проверкой подписи и авто-suppression контактов по bounce/spam/unsubscribe
- Аналитика: метрики кампаний и шагов цепочек, timeline контакта, сводный дашборд воркспейса, журнал отправок с фильтрами

## Архитектура

Монорепо на npm workspaces (`apps/*`, `packages/*`).

**Приложения:**

| Путь | Пакет | Назначение |
|------|-------|------------|
| `apps/api` | `@mega-crm/api` | Fastify HTTP API |
| `apps/web` | `@mega-crm/web` | React 19 + Vite SPA |
| `apps/worker` | `@mega-crm/worker` | BullMQ воркеры отправки и обработки событий |

**Пакеты:**

| Путь | Назначение |
|------|------------|
| `packages/db` | Drizzle-схема и миграции |
| `packages/tenant-context` | Контекст тенанта / RLS |
| `packages/contacts-core` | Shared upsert контактов |
| `packages/segments-core` | Компилятор определений сегментов в SQL |
| `packages/delivery-core` | Send pipeline, unsubscribe-токены |
| `packages/flows-core` | Модель и валидация графа триггерных цепочек |
| `packages/kms` | Envelope encryption (провайдеры local/aws) |
| `packages/shared-schemas` | Общие Zod-схемы |

**Хранилища:** Postgres с Row-Level Security на tenant-таблицах и партиционированными таблицами `events`/`send_events`; Redis как backend очередей BullMQ и per-tenant token bucket для RPS-троттлинга.

## Технологический стек

| Слой | Технологии |
|------|------------|
| Язык и рантайм | Node >= 22, TypeScript ^5.9.3 |
| Backend (API) | fastify 5.9.0, zod 4.4.3, @fastify/type-provider-zod 1.0.0, drizzle-orm 0.45.2, pg 8.22.0, better-auth 1.6.23, @sendgrid/mail 8.1.6, @sendgrid/eventwebhook ^8.0.0, csv-parse 7.0.1, pino 10.3.1 |
| Очереди и воркеры | bullmq 5.79.1, ioredis 5.11.0, rate-limiter-flexible 11.2.0 |
| База данных | postgres:17, redis:7, drizzle-kit 0.31.10 |
| Frontend | react 19.2.7, vite 8.1.3, @xyflow/react 12.11.2, @tanstack/react-query 5.101.2, @tanstack/react-table ^8.21.3, zustand 5.0.14, react-hook-form 7.80.0, react-router 8.1.0, recharts 3.9.2, tailwindcss 3.4.19, Radix UI primitives |
| Тесты | vitest 4.1.9, @playwright/test 1.61.1 |

## Быстрый старт

1. Требования: Node >= 22 (поле `engines` в корневом `package.json`), npm, Docker.

2. Поднять Postgres и Redis:

   ```bash
   docker compose up -d
   ```

   Поднимает Postgres 17 (порт 5432, база `mega_crm`, пользователь/пароль `postgres`/`postgres`) и Redis 7 (порт 6379).

3. Скопировать `.env.example` в `.env` и заполнить значения (см. раздел «Переменные окружения» ниже):

   ```bash
   cp .env.example .env
   ```

4. Установить зависимости всех workspace:

   ```bash
   npm install
   ```

5. Запустить api, web и worker:

   ```bash
   npm run dev
   ```

   Перед стартом npm автоматически запускает `predev`: `scripts/check-env.mjs` (падает с ошибкой, если обязательная переменная окружения отсутствует или пустая) и `scripts/migrate-dev.mjs` (применяет ещё не накатанные Drizzle-миграции).

6. Адреса после старта:
   - API — http://localhost:4000
   - Веб-интерфейс — http://localhost:5173 (Vite dev-сервер проксирует `/api` на API)
   - Worker собственного HTTP-порта не слушает

## Переменные окружения

| Переменная | Обязательна | Описание |
|------------|-------------|----------|
| `DATABASE_URL` | Да | Строка подключения к Postgres |
| `REDIS_URL` | Да | Строка подключения к Redis (backend BullMQ) |
| `BETTER_AUTH_SECRET` | Да | Секрет better-auth, минимум 16 символов |
| `BETTER_AUTH_URL` | Да | Базовый URL better-auth, должен быть валидным URL |
| `WEB_URL` | Да | URL веб-приложения, должен быть валидным URL |
| `PLATFORM_SENDGRID_API_KEY` | Да | Ключ SendGrid платформы для системных писем (verify/reset/invite), отдельный от BYO-ключей тенантов |
| `PLATFORM_MAIL_FROM` | Да | Адрес отправителя системных писем, должен быть валидным email |
| `UNSUBSCRIBE_TOKEN_SECRET` | Да | HMAC-секрет для one-click unsubscribe-токенов, минимум 32 символа |
| `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` | Нет | Упорядоченный список через запятую отозванных HMAC-секретов, нужен только для верификации уже разосланных ссылок при ротации `UNSUBSCRIBE_TOKEN_SECRET`; см. `docs/runbooks/unsubscribe-secret-rotation.md` |
| `PUBLIC_APP_URL` | Да | Публичный URL приложения, должен быть валидным URL; при `NODE_ENV=production` обязан использовать https |
| `KMS_PROVIDER` | Нет (default `local`) | `local` (dev-KEK) или `aws`; `local` запрещён при `NODE_ENV=production` |
| `KMS_LOCAL_KEK` | Условно | Обязательна, если `KMS_PROVIDER=local` (значение по умолчанию) |
| `KMS_KEK_ID` | Условно | Обязательна, если `KMS_PROVIDER=aws` |
| `API_PORT` | Нет (default `4000`) | Порт, на котором слушает Fastify API |
| `NODE_ENV` | Нет (default `development`) | Одно из `development` \| `test` \| `production` |

Реальные значения секретов в этом файле не приводятся, только имена переменных — заполняйте `.env` своими значениями (например, `<ваш-sendgrid-ключ>`).

Для живой доставки событий SendGrid Event Webhook `PUBLIC_APP_URL` должен быть публично доступным https-адресом (например, туннель через ngrok/cloudflared) — localhost и обычный http не работают, SendGrid не сможет достучаться до вебхука. Подробности — в `docs/webhook-live-uat.md`.

## Команды

| Команда | Что делает |
|---------|------------|
| `npm run dev` | Поднимает api, web и worker одновременно через concurrently (сначала прогоняется `predev`) |
| `npm run build` | Собирает все workspace, где есть скрипт `build` |
| `npm run test` | Запускает тесты во всех workspace, где есть скрипт `test` |
| `npm run db:generate` | Генерирует Drizzle-миграции (`packages/db`) |
| `npm run db:migrate` | Применяет Drizzle-миграции (`packages/db`) |
| `npm run dev -w apps/api` | Запускает только API (`tsx watch`) |
| `npm run dev -w apps/web` | Запускает только веб-приложение (Vite dev-сервер) |
| `npm run dev -w apps/worker` | Запускает только BullMQ worker |
| `npm run test -w apps/api` | Тесты API (vitest) |
| `npm --workspace=apps/web run test:e2e` | E2E-тесты веб-приложения (Playwright) |
| `npm start -w apps/api` | Запускает собранный API из `dist/` |
| `npm start -w apps/worker` | Запускает собранный worker из `dist/` |

## Структура проекта

```
apps/
  api/                # Fastify HTTP API
  web/                # React 19 + Vite SPA
  worker/             # BullMQ воркеры
packages/
  db/                 # Drizzle-схема и миграции
  tenant-context/     # Контекст тенанта / RLS
  contacts-core/      # Shared upsert контактов
  segments-core/      # Компилятор сегментов в SQL
  delivery-core/      # Send pipeline, unsubscribe-токены
  flows-core/         # Модель и валидация графа цепочек
  kms/                # Envelope encryption (local/aws)
  shared-schemas/     # Общие Zod-схемы
docker/               # init-скрипт роли приложения для Postgres
docs/                 # Runbook'и (например, live UAT SendGrid webhook)
scripts/              # check-env.mjs, migrate-dev.mjs — pre-dev проверки
.planning/            # GSD-артефакты планирования проекта
docker-compose.yml    # Postgres 17 + Redis 7 для локальной разработки
package.json          # Корневой манифест npm workspaces
tsconfig.base.json    # Общая TypeScript-конфигурация
```

## Документация

- `.planning/PROJECT.md` — контекст продукта, требования, ключевые решения
- `docs/webhook-live-uat.md` — runbook живого UAT SendGrid webhook: настройка туннеля и scope ключа
</content>
