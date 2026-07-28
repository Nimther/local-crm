# Mega CRM — Спецификация проекта (as-built)

> **Статус документа:** описывает то, что **фактически есть в коде** на 2026-07-15 (commit рабочего дерева).
> Всё, чего в коде нет, помечено **«не определено»** — не додумано и не взято из планов/ресёрча.
> **Аудитория:** security review перед прод-деплоем.
> **Не путать с** разделом Technology Stack в `.claude/CLAUDE.md` — тот описывает *рекомендованный* стек по итогам ресёрча и местами расходится с кодом. Расхождения перечислены в разделе 8.

---

## 1. Топология

Монорепа на npm workspaces (`package.json` → `workspaces: ["apps/*", "packages/*"]`). Node `>=22` (`engines`).

### 1.1 Процессы

| Процесс | Путь | Что это | HTTP |
|---|---|---|---|
| **api** | `apps/api` | Fastify HTTP-сервер | Слушает `0.0.0.0:${API_PORT}` (default `4000`), `apps/api/src/server.ts` |
| **worker** | `apps/worker` | Долгоживущий процесс BullMQ-воркеров | **HTTP-листенера нет** (`apps/worker/src/server.ts:45-46`) |
| **web** | `apps/web` | React SPA (Vite) | Dev-сервер `:5173` с прокси `/api` → `http://localhost:4000` (`apps/web/vite.config.ts`) |

### 1.2 Внутренние пакеты

| Пакет | Назначение |
|---|---|
| `packages/db` | Drizzle-схема, миграции, **не-tenant** Drizzle-клиент (для better-auth) |
| `packages/tenant-context` | **Tenant-scoped `pg.Pool`** + `withTenant` / `withTenantTransaction` (механизм RLS) |
| `packages/kms` | Envelope encryption ключей SendGrid тенантов (провайдеры `local` / `aws`) |
| `packages/shared-schemas` | Zod-схемы + константы имён очередей (общие для api и worker) |
| `packages/delivery-core` | Pre-send gate, suppression, quiet hours, unsubscribe-токены, вызов SendGrid `mail/send` |
| `packages/contacts-core` | Репозиторий контактов, CSV-маппинг, property registry |
| `packages/segments-core` | Компиляция определения сегмента в SQL |
| `packages/flows-core` | Схема и валидация определения flow |
| `packages/test-support` | Fail-closed guard тестовой БД (`assertTestDatabaseUrl`), провижининг эфемерных БД (`createEphemeralDatabase`/`dropEphemeralDatabase`), vitest `globalSetup` и **единственный** migration-фикстур (`ensureTestDbMigrated`/`createTestPool`/`getTestDatabaseUrl`). С 08-06 три прежние копии `db-fixture.ts` (`apps/api/src/test`, `apps/worker/src/test`, `packages/delivery-core/src/test`) — тонкие ре-экспорты отсюда, хранящие только свои workspace-специфичные хелперы (`resetTestData`, `createFixtureFlowRun`). Fallback `TEST_DATABASE_URL ?? DATABASE_URL` удалён: отсутствие тестового DSN — жёсткая ошибка. С 08-04/08-12 пакет также поставляет **доменно-нейтральные** харнесс-хелперы в `src/harness/`: `startTempRedis` (временный `redis-server` на свободном порту, с `restart()` — SIGTERM и повторный старт из того же каталога данных, чем 08-13 проверяет выживание очереди) и `spawnAndAwaitReady`/`killAndAwaitExit` (fork дочернего процесса с IPC-каналом, ожидание ready-маркера, SIGKILL и ожидание выхода). Оба намеренно ничего не знают о доменe — именно это позволяет держать worker-специфичный entrypoint в `apps/worker` и не заводить зависимость `packages/*` → `apps/*`, которой в репозитории больше нигде нет |

### 1.3 Инфраструктура в репозитории

`docker-compose.yml`: только два сервиса.

- `db`: `postgres:17`, порт `5432:5432`, `POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=postgres` (dev-креды в открытом виде), volume `mega_crm_db_data`, init-скрипт `docker/init-app-role.sql`.
- `redis`: `redis:7`, порт `6379:6379`, volume `mega_crm_redis_data`. С 08-04 сервис запускается **явным `command: ["redis-server", "/usr/local/etc/redis/redis.conf"]`** и монтирует `./docker/redis.conf` в `/usr/local/etc/redis/redis.conf` в режиме `:ro` — без `command:` образ стартовал бы на дефолтах и смонтированный файл не имел бы эффекта. **Без `requirepass`** — Redis в dev-compose без аутентификации.

`docker/init-app-role.sql` создаёт роль `mega_crm_app` `NOSUPERUSER NOCREATEDB NOCREATEROLE **NOBYPASSRLS**` с паролем `mega_crm_dev_pw` и передаёт ей владение БД. Это единственное место, где кодифицировано требование «app-роль не должна иметь BYPASSRLS».

`docker/redis.conf` (добавлен в 08-04) содержит ровно четыре директивы:

| Директива | Значение |
|-----------|----------|
| `maxmemory` | `512mb` |
| `maxmemory-policy` | `noeviction` |
| `appendonly` | `yes` |
| `appendfsync` | `everysec` |

`maxmemory` и `maxmemory-policy` обязательны вместе: `noeviction` — дефолт Redis, и при `maxmemory 0` (без лимита) он не может сработать вовсе, поэтому проверка одной только политики проходит против полностью ненастроенного сервера. `512mb` — dev-значение, а не измеренное; сайзинг под прод отнесён к фазе 15. Значения не параметризуются через переменные окружения: у `redis.conf` нет подстановки переменных, а entrypoint-обёртка вернула бы ровно то расхождение local/CI, ради устранения которого файл и заведён.

Этот же файл — источник конфигурации для локальной проверки: `packages/test-support/src/harness/temp-redis.ts` поднимает из него **отдельный временный `redis-server`** на свободном порту с временным каталогом данных и гарантированно останавливает его и удаляет каталог. Системный Redis на `6379` при этом не читается, не перенастраивается и не перезапускается.

`scripts/verify-redis-config.mjs` (добавлен в 08-04) читает `CONFIG GET` живого сервера и утверждает все четыре значения. Скрипт получает `REDIS_URL` **извне** и не имеет ни дефолтного адреса, ни ветки «локально/CI» — это один и тот же код в обоих окружениях, различается только передаваемый URL. Реализован на встроенных модулях Node (минимальный RESP-клиент на `node:net`), без зависимостей, как и остальные скрипты-гейты. Недоступный Redis и отсутствующий бинарь `redis-server` дают ненулевой код возврата, а не `skipped`: пропуск завершился бы кодом 0, который CI прочитал бы как успех.

`.github/workflows/ci.yml` (добавлен в 08-01): workflow `CI`, триггеры `push` (без фильтра веток) и `pull_request` (`branches: [master]`) — оба обязательны, иначе required status check не появляется на PR. `concurrency` по `${{ github.workflow }}-${{ github.ref }}` с `cancel-in-progress: true`. Один job с id и name `test` на `ubuntu-latest`. Шаги: `actions/checkout` и `actions/setup-node` (оба закреплены на полный 40-символьный commit SHA, тег — только в комментарии) → `npm ci` → `docker compose up -d --wait` (поднимает `db` и `redis` по их существующим healthcheck'ам, без `sleep`) → создание эфемерной БД `mega_crm_test_worker` через `docker compose exec -T db psql -U postgres` → **`npm run verify:redis-config` с `REDIS_URL: redis://localhost:6379` (шаг добавлен в 08-04)** → `npm run build --workspaces --if-present` (**это и есть тайпчек**, отдельного `tsc --noEmit` нет) → `npm run test -w apps/worker`. Job-level `env`: `DATABASE_URL`, `TEST_DATABASE_URL`, `TEST_REDIS_URL` (dev-креды, те же что в compose).

CI — **единственное** место, где проверяется контейнерный путь применения `docker/redis.conf` (`command:` + `:ro`-mount): на машине без Docker его воспроизвести нечем. Локальный прогон проверяет тот же файл, но применённый к временному `redis-server`.

`.nvmrc` (добавлен в 08-01): `26` — мажорная версия Node, на которую `actions/setup-node` настраивается через `node-version-file`.

`eslint.config.js` (добавлен в 08-03): flat-config ESLint 10 из семи блоков. Type-aware ярус (`recommendedTypeChecked` + `projectService`) намеренно ограничен глобами `apps/*/src/**` и `packages/*/src/**` — каждый `tsconfig.json` в репозитории объявляет `include: ["src"]`, поэтому `projectService` падает с ошибкой парсинга на любом файле вне `src/`. Конфиг-файлы, `scripts/**/*.mjs` и Playwright-спеки покрыты отдельным не-type-aware ярусом. На момент добавления: **396 файлов проверяется, 536 нарушений** (522 error / 14 warning) — приведение к нулю выполняется в 08-07, а не здесь.

`vitest.config.ts` в корне (добавлен в 08-11): агрегирующий конфиг с `test.projects` — **один** прогон по всей backend-области с **одним** знаменателем покрытия. Перечислены восемь проектов: `apps/api`, `apps/worker`, `packages/db`, `packages/delivery-core`, `packages/flows-core`, `packages/test-support` (по путям к их собственным `vitest.config.ts`, чтобы наследовались их настройки — в частности `fileParallelism: false` у воркера), плюс `packages/segments-core` и `packages/shared-schemas` голыми путями к каталогам: своих конфигов у них нет, и Vitest 4.1.9 такой путь принимает (проверено эмпирически в 08-11). `apps/web` **не включён** — вне области покрытия по решению D-16, и смешивать jsdom-проект с node-агрегатом всё равно нельзя. Падение или неисполнение любого проекта роняет весь прогон, поэтому workspace не может тихо выпасть из знаменателя (проверено: намеренно сломанный тест в `flows-core` даёт exit 1).

Покрытие: провайдер `v8`, репортеры `text` и `json-summary`, каталог `./coverage` (гитигнорится), `include` — `apps/api/src/**`, `apps/worker/src/**`, `packages/*/src/**`. Опция `all` оставлена по умолчанию, то есть знаменатель — фактически загруженные прогоном файлы (D-17). Скрипт `npm run coverage` = `vitest run --coverage --testTimeout=60000`: увеличенный таймаут нужен именно инструментированному прогону — `csv-import.test.ts` строит payload >50 МБ и под инструментацией v8 выходит за штатные 20 с (без coverage тот же файл проходит за 6.5 с).

`coverage-baseline.json` в корне (добавлен в 08-11): порог покрытия и его происхождение. `lines` — **недруглённая доля** (не проценты), равная измеренной плюс `increment`; `measuredLines`, `measuredAt` (дата, точные `covered`/`total`) и `scope` записаны рядом, чтобы любое будущее изменение порога было проверяемо против собственного основания. На момент добавления: измерено **3366/4194 = 0.80258**, порог **0.81258**. Порог намеренно **выше** текущего результата — гейт красный по построению, пока 08-16 не добавит целевые тесты на `packages/kms` и `packages/tenant-context`.

**Расхождение окружения (08-01):** локальная машина разработчика запускает Postgres 17.10 и Redis 8.8.0 нативно через Homebrew, а не через `docker compose` — Docker на ней не установлен. На `ubuntu-latest` `docker compose` доступен, поэтому CI работает как описано; локально эквивалентом `docker compose exec -T db psql -U postgres` служит `psql -U <локальный суперюзер>` (роли `postgres` в Homebrew-инстансе нет). Локальный Redis — версии 8, а не `redis:7` из compose.

**Разрешение для административного DSN (08-07):** `provision-db.ts` создаёт и удаляет эфемерные БД под ролью `postgres`, которая есть в compose-сервисе `db`, но отсутствует в Homebrew-инстансе — из-за этого `provision-db.test.ts` и `db-fixture-isolation.test.ts` падали локально с `role "postgres" does not exist`, оставаясь зелёными в CI. Переопределение `TEST_ADMIN_DATABASE_URL` в `resolveAdminDsn` существовало с 08-02, но его негде было задать: `packages/test-support/vitest.config.ts` намеренно не грузил корневой `.env`. С 08-07 грузит (опционально, через `try`/`catch`, как в `apps/worker`), поэтому локально достаточно прописать в `.env` DSN локального суперюзера. Проверка на имя БД перед `DROP` при этом не ослаблена — она валидирует имя, а не DSN.

**Разрешение для Redis-конфигурации (08-04):** смонтированный в контейнер файл не может повлиять на Homebrew-Redis, поэтому локальный путь не мутирует системный сервер, а поднимает из `docker/redis.conf` отдельный временный `redis-server` (свободный порт, временный каталог данных, гарантированный teardown). Системный Redis на `6379` остаётся нетронутым — его `maxmemory` по-прежнему `0`, `appendonly` `no`. Расхождение, которое остаётся непроверяемым локально: сам механизм применения (`command:` + `:ro`-mount) и версия сервера (локально 8.8.0, в CI `redis:7`); обе директивные семантики в этих версиях совпадают. То же ограничение относится к 08-13, который перезапускает Redis-**контейнер**.

**Dockerfile, деплой-манифестов, healthcheck-эндпоинта в репозитории нет.** Как api/worker собираются и запускаются в staging/prod — **не определено**.

---

## 2. Зависимости и версии (фактические, из `package.json`)

### 2.1 Root

| Пакет | Версия | Тип |
|---|---|---|
| `concurrently` | `10.0.3` | dev |
| `typescript` | `^5.9.3` (установлено 5.9.3) | dev |
| `eslint` | `^10.8.0` | dev — добавлен в 08-03 |
| `typescript-eslint` | `^8.65.0` | dev — мета-пакет (`tseslint.config`, `recommendedTypeChecked`) |
| `@vitest/eslint-plugin` | `^1.6.24` | dev — правило `vitest/no-focused-tests` |
| `eslint-plugin-react-hooks` | `^7.1.1` | dev — `rules-of-hooks` / `exhaustive-deps` для `apps/web` |
| `eslint-plugin-no-only-tests` | `^3.4.0` | dev — `.only` в Playwright-спеках (плагин vitest их не видит) |
| `eslint-plugin-import-x` | `^4.17.1` | dev — **форк** `eslint-plugin-import`; используется ровно одно правило `import-x/no-extraneous-dependencies` |

### 2.2 `apps/api`

| Пакет | Версия |
|---|---|
| `fastify` | `5.9.0` |
| `fastify-plugin` | `^5.0.1` |
| `@fastify/cors` | `11.2.0` |
| `@fastify/helmet` | `13.0.2` |
| `@fastify/multipart` | `10.0.0` |
| `@fastify/rate-limit` | `11.1.0` |
| `@fastify/type-provider-zod` | `1.0.0` |
| `better-auth` | `1.6.23` |
| `bullmq` | `5.79.1` |
| `ioredis` | `5.11.0` |
| `drizzle-orm` | `0.45.2` |
| `pg` | `8.22.0` |
| `zod` | `4.4.3` |
| `pino` | `10.3.1` |
| `pino-http` | `11.0.0` — **объявлен, в коде не используется** (grep по `apps/api/src`: 0 вхождений) |
| `@sendgrid/mail` | `8.1.6` — используется **только** для платформенной почты (`platform-mail/client.ts`) |
| `@sendgrid/eventwebhook` | `^8.0.0` — верификация подписи вебхука |
| `csv-parse` | `7.0.1` |
| `nanoid` | `5.1.16` — единственное использование: `tenancy/workspaces.ts` |
| dev: `@types/node` `^22.10.5`, `@types/pg` `^8.15.6`, `nock` `14.0.16`, `tsx` `^4.19.2`, `typescript` `^5.9.3`, `vitest` `4.1.9`, `@vitest/coverage-v8` `^4.1.9` (08-11, провайдер покрытия; минор совпадает с `vitest`) |

### 2.3 `apps/worker`

| Пакет | Версия |
|---|---|
| `bullmq` | `5.79.1` |
| `ioredis` | `5.11.0` |
| `pg` | `8.22.0` |
| `rate-limiter-flexible` | `11.2.0` |
| dev: `@types/node`, `@types/pg`, `tsx`, `typescript`, `vitest` `4.1.9`, `@vitest/coverage-v8` `^4.1.9` (08-11) |

Внутренние: `@mega-crm/{contacts-core,db,delivery-core,flows-core,kms,segments-core,shared-schemas,tenant-context}`.

### 2.4 `apps/web`

| Пакет | Версия |
|---|---|
| `react` / `react-dom` | `19.2.7` |
| `vite` (dev) | `8.1.3` |
| `@vitejs/plugin-react` (dev) | `6.0.3` |
| `@xyflow/react` | `12.11.2` |
| `@tanstack/react-query` | `5.101.2` |
| `@tanstack/react-table` | `^8.21.3` |
| `react-router` | `8.1.0` |
| `react-hook-form` | `7.80.0` + `@hookform/resolvers` `5.4.0` |
| `recharts` | `3.9.2` |
| `better-auth` | `1.6.23` |
| `zod` | `4.4.3` |
| `zustand` | `5.0.14` — **объявлен, в коде не используется** (grep по `apps/web/src`: 0 вхождений) |
| `@radix-ui/*` | 16 пакетов (shadcn/ui-слой в `src/components/ui`) |
| `lucide-react` `1.23.0`, `sonner` `2.0.7`, `cmdk` `^1.1.1`, `class-variance-authority` `0.7.1`, `clsx` `2.1.1`, `tailwind-merge` `3.6.0` |
| dev: `@playwright/test` `1.61.1`, `tailwindcss` `3.4.19`, `tailwindcss-animate` `1.0.7`, `postcss` `8.5.16`, `autoprefixer` `10.5.2`, `typescript`, `@types/*`, `vitest` `4.1.9` (объявлен в 08-07 — до того пакет запускал `vitest run`, не объявляя его, и работал только за счёт hoisting'а из корня), `@mega-crm/test-support` `0.1.0` (08-10, провижининг эфемерной БД для E2E) |

### 2.5 Пакеты

| Пакет | Зависимости |
|---|---|
| `packages/db` | `drizzle-orm` `0.45.2`, `pg` `8.22.0`; dev: `drizzle-kit` `0.31.10`, `vitest` `4.1.9`, `@mega-crm/test-support` `0.1.0` (обе добавлены в 08-09 — у пакета появилась тестовая дорожка с `vitest.config.ts` и `globalSetup`, под два прогона цепочки миграций) |
| `packages/kms` | `@aws-sdk/client-kms` `3.1079.0` |
| `packages/delivery-core` | `@mega-crm/tenant-context`, `pg` |
| `packages/contacts-core` | `@mega-crm/delivery-core`, `pg`, `pino` `10.3.1` |
| `packages/segments-core` | нет runtime-зависимостей |
| `packages/flows-core` | `zod` `4.4.3` |
| `packages/shared-schemas` | `@mega-crm/flows-core`, `zod` |
| `packages/tenant-context` | `pg` `8.22.0` |
| `packages/test-support` | `pg` `8.22.0`, `ioredis` `5.11.0`; dev: `@types/node` `^22.10.5`, `@types/pg` `^8.15.6`, `typescript` `^5.9.3`, `vitest` `4.1.9`, `execa` `10.0.0`. `pg` используется с 08-02/08-06 (`provision-db.ts`, `db-fixture.ts`). **`ioredis` и `execa` объявлены, но кодом ещё не используются**: проверка конфигурации Redis (08-04) реализована на встроенных модулях Node, а не на `ioredis`; `execa` остаётся неиспользованным и после 08-12: SIGKILL-harness построен на `node:child_process.fork`, потому что IPC-канал — это ровно тот примитив, ради которого харнесс существует, и execa добавил бы слой поверх него |

---

## 3. Секреты: где хранятся и как читаются

### 3.1 `.env`

- `.env` лежит в корне репозитория, **гитигнорится** (`.gitignore:4`, подтверждено `git check-ignore -v .env`). В `git ls-files` его нет — в историю не попадал (проверено по текущему индексу; полный аудит истории коммитов **не проводился**).
- Загрузка: **только через флаг Node** — `tsx watch --env-file=../../.env src/server.ts` в `dev`-скриптах `apps/api` и `apps/worker`. Библиотеки `dotenv` в проекте **нет**. Скрипт `start` (`node dist/server.js`) `--env-file` **не передаёт** → в прод-режиме переменные должны приходить из окружения процесса. Как именно — **не определено**.
- **E2E-дорожка Playwright (08-10)** конфиг загружает `.env` **в собственный процесс** (`process.loadEnvFile` в `apps/web/playwright.config.ts`, как во всех `vitest.config.ts`) — ради `TEST_ADMIN_DATABASE_URL` для провижининга и ради `DATABASE_URL` как объекта сравнения в guard'е. Серверам эти значения **не передаются**: `apps/web/e2e/global-setup.ts` поднимает эфемерную БД через `@mega-crm/test-support` (`createEphemeralDatabase` → `assertTestDatabaseUrl` → `ensureTestDbMigrated`), перезаписывает `process.env.DATABASE_URL` её DSN и печатает его с затёртым паролем за маркером `[e2e:database]`; `apps/web/e2e/global-teardown.ts` удаляет БД (состояние между половинами передаётся через временный файл — у Playwright `globalSetup` и `globalTeardown` это два независимых модуля, и вернуть teardown из setup, как в vitest, нельзя). Оба `webServer` запускают новые скрипты **`dev:e2e`** (`apps/api`: `tsx watch src/server.ts`, `apps/web`: `vite`), которые **намеренно не несут `--env-file`** — вся среда API приходит из блока `webServer[].env` (перечислен по boot-схеме `apps/api/src/env.ts`, значения тестовые) плюс унаследованный `DATABASE_URL`. Следствие: прогон без отработавшего `globalSetup` не стартует вовсе, а не уходит тихо в dev-БД. `reuseExistingServer` на обоих сервисах — **`false`**: при уже поднятом dev-стеке Playwright отказывается запускаться с явной ошибкой, вместо того чтобы подключиться к чужим серверам и писать в dev-БД. Обычные `dev`-скрипты не изменены.
- `scripts/check-env.mjs` (`predev`-хук) читает и парсит `.env` **сам** (без зависимостей) и падает, если пусты: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `WEB_URL`, `PLATFORM_SENDGRID_API_KEY`, `PLATFORM_MAIL_FROM`, `REDIS_URL`, `UNSUBSCRIBE_TOKEN_SECRET`, `PUBLIC_APP_URL`, плюс `KMS_KEK_ID` (если `KMS_PROVIDER=aws`) либо `KMS_LOCAL_KEK`. Это dev-only проверка — прод её не выполняет.
- В рабочем дереве также присутствует `dump.rdb` (Redis-дамп, ~9.8 КБ) — гитигнорится по `*.rdb`, но физически лежит в папке проекта и может содержать данные очередей.

### 3.2 Полный список читаемых переменных окружения

| Переменная | Читается в | Валидация |
|---|---|---|
| `DATABASE_URL` | `packages/tenant-context/src/index.ts` (напрямую `process.env`), `packages/db/src/index.ts`, `packages/db/drizzle.config.ts`, `scripts/migrate-dev.mjs` | api: `z.string().min(1)`; в пакетах — throw при отсутствии |
| `REDIS_URL` | `apps/api/src/env.ts`; `apps/worker/src/server.ts`, `queues/send-dispatch.ts`, `queues/campaign-broadcast-producer.ts`, `queues/flows/flow-queues.ts` | `min(1)` / throw |
| `BETTER_AUTH_SECRET` | `apps/api/src/env.ts` → `modules/auth/auth.ts` | **`z.string().min(16)`** |
| `BETTER_AUTH_URL`, `WEB_URL`, `PUBLIC_APP_URL` | `apps/api/src/env.ts`; `PUBLIC_APP_URL` также в `apps/worker/src/server.ts` и `packages/delivery-core/src/unsubscribe-token.ts` | `z.string().url()` |
| `API_PORT` | `apps/api/src/env.ts` | `coerce.number().int().positive().default(4000)` |
| `NODE_ENV` | `apps/api/src/env.ts`, `packages/kms/src/env.ts`, `packages/contacts-core/src/logger.ts` | `z.enum(["development","test","production"]).default("development")` |
| `PLATFORM_SENDGRID_API_KEY` | `apps/api/src/env.ts` → `modules/platform-mail/client.ts` | `min(1)` |
| `PLATFORM_MAIL_FROM` | там же | `z.string().email()` |
| `KMS_PROVIDER` | `apps/api/src/env.ts`, `packages/kms/src/env.ts:19` | `z.enum(["local","aws"]).default("local")` |
| `KMS_LOCAL_KEK` | читается в `packages/kms/src/env.ts:20`, потребляется в `local-provider.ts` | optional в схеме; провайдер требует base64 → **ровно 32 байта** |
| `KMS_KEK_ID` | читается в `packages/kms/src/env.ts:21`, потребляется в `aws-provider.ts` | optional в схеме; обязателен при `KMS_PROVIDER=aws` (superRefine) |
| `UNSUBSCRIBE_TOKEN_SECRET` | `apps/api/src/env.ts`; `apps/worker/src/server.ts` (ручная проверка `>= 32`); лениво в `packages/delivery-core/src/unsubscribe-token.ts` | **`z.string().min(32)`** |
| `TEST_DATABASE_URL`, `TEST_REDIS_URL`, `TEST_PUBLIC_APP_URL` | `vitest.config.ts`; `TEST_DATABASE_URL` с 08-02 **выставляется самим** `packages/test-support/src/global-setup.ts` (DSN эфемерной БД), а не задаётся вызывающим | — |
| `TEST_ADMIN_DATABASE_URL` | `packages/test-support/src/provision-db.ts:59` (`resolveAdminDsn`) — административный DSN, под которым создаются и удаляются эфемерные БД | при отсутствии — `postgres://postgres:postgres@localhost:5432/postgres` |
| `TEST_APP_DB_PASSWORD` | `packages/test-support/src/provision-db.ts:73` (`buildAppDsn`) — пароль роли `mega_crm_app` в DSN созданной БД | при отсутствии — `mega_crm_dev_pw` |
| `SIGKILL_HARNESS_JOB_DATA` | `apps/worker/src/test/harness/sigkill-entrypoint.ts` — JSON job-payload, который родитель передаёт дочернему процессу SIGKILL-сценария (08-12) | обязателен: без него entrypoint выходит с кодом 1 и явным сообщением, чтобы отсутствие payload не выглядело как таймаут |
| `TEST_ADMIN_DATABASE_URL` | `packages/test-support/src/provision-db.ts` (`resolveAdminDsn`) | Admin/superuser DSN — используется **только** для `CREATE DATABASE` / `DROP DATABASE`. Дефолт `postgres://postgres:postgres@localhost:5432/postgres` (креды docker-compose). Локально, где сервисы подняты нативно через Homebrew и роли `postgres` нет, задаётся явно |
| `GSD_TEST_RUN_ID` | `packages/test-support/src/provision-db.ts` | Опциональный дискриминатор прогона в имени эфемерной БД. При отсутствии — `randomUUID().slice(0, 8)`. Задаётся в CI, чтобы имя БД было привязано к конкретному прогону |
| `TEST_APP_DB_PASSWORD` | `packages/test-support/src/provision-db.ts` (`buildAppDsn`) | Пароль роли `mega_crm_app` в DSN, который получают тесты. Дефолт `mega_crm_dev_pw` (из `docker/init-app-role.sql`) |
| `GSD_DEV_DATABASE_URL` | выставляется `packages/test-support/src/global-setup.ts`, читается `packages/test-support/src/db-fixture.ts` | Сохранённый **исходный** dev-DSN. `globalSetup` перезаписывает `DATABASE_URL` эфемерным DSN (иначе `packages/tenant-context`, читающий `DATABASE_URL` напрямую, ушёл бы в dev-БД), поэтому второй слой guard'а внутри тестового процесса (D-14 layer b) сравнивает именно с этим значением — сравнение с перезаписанным `DATABASE_URL` сравнивало бы DSN сам с собой |

**Важно:** `packages/tenant-context` (`src/index.ts:15`) и `packages/kms` (`src/env.ts:17-22`) читают `process.env` **напрямую**, минуя zod-схему `apps/api/src/env.ts`. Схема — не единственная точка входа конфигурации; она гарантирует только то, что **api-процесс** не стартует при плохом конфиге. Воркер собственной полной схемы не имеет — только три ручные проверки в `apps/worker/src/server.ts`: `REDIS_URL` (`:49-52`), `UNSUBSCRIBE_TOKEN_SECRET >= 32` (`:61-66`), `PUBLIC_APP_URL` (`:67-72`).

### 3.3 Boot-guard'ы (`apps/api/src/env.ts`, `superRefine`)

1. `NODE_ENV=production` + `KMS_PROVIDER=local` → отказ старта.
2. `KMS_PROVIDER=aws` без `KMS_KEK_ID` → отказ старта.
3. `NODE_ENV=production` + `PUBLIC_APP_URL` начинается с `http://` → отказ старта.

Дублирующий guard: `packages/kms/src/local-provider.ts` бросает на уровне модуля, если `NODE_ENV=production` (защищает воркер, у которого своей схемы нет).

### 3.4 Ключ SendGrid тенанта (BYO)

**Хранение** — таблица `workspace_sendgrid_keys` (PK = `workspace_id`, один ключ на воркспейс):

| Колонка | Содержимое |
|---|---|
| `ciphertext` | AES-256-GCM шифротекст ключа, base64 |
| `encrypted_dek` | DEK, обёрнутый KEK'ом активного провайдера, base64 |
| `iv` | 12 случайных байт, base64 (`randomBytes(12)` на каждое шифрование) |
| `auth_tag` | GCM auth tag, base64 |
| `key_mask` | несекретная маска для UI: первые ≤6 символов + `…` + последние 4 (`maskKey`, `sendgrid-key.ts:98-103`). Doc-комментарий на `:97` приводит пример `SG.aB3x…k9Qz` с 7-символьным префиксом — комментарий не соответствует коду (`Math.min(6, …)`); это дефект комментария, не логики |
| `status` | `'active' \| 'error'` — только на уровне приложения, CHECK-констрейнта нет |

**Реализация** — `packages/kms/src/client.ts`:

- `encryptTenantSecret(workspaceId, plaintext)`: `provider.generateDataKey()` → `createCipheriv("aes-256-gcm", plaintextDek, iv)` → возвращает `{encryptedDek, ciphertext, iv, authTag}`. Плейнтекст DEK зануляется `plaintextDek.fill(0)` в `finally` и наружу не отдаётся.
- `decryptTenantSecret` — обратная операция, то же зануление.
- Провайдер грузится **динамическим import'ом** по `KMS_PROVIDER`, поэтому `aws-provider.ts` не подтягивается в dev, а `local-provider.ts` — в prod.

**Провайдер `aws`** (`packages/kms/src/aws-provider.ts`): `KMSClient({})` — конфиг/креды берутся из дефолтной цепочки AWS SDK, **в репозитории не заданы** → **не определено**. `GenerateDataKey`/`Decrypt` с `KeySpec: "AES_256"` и `EncryptionContext: { workspaceId }` — DEK привязан к воркспейсу.

**Провайдер `local`** (dev-only): статический KEK из `KMS_LOCAL_KEK` (base64, ровно 32 байта), `aes-256-gcm` с `setAAD(workspaceId)`, формат обёртки `base64(iv[12] || authTag[16] || wrapped)`.

**Путь ключа в рантайме:**

- Приём: `POST /api/workspaces/:slug/sendgrid-key` — плейнтекст приходит **один раз** в теле запроса, живо валидируется через `GET /v3/scopes` + `/v3/verified_senders` (`tenancy/sendgrid-client.ts`), шифруется, сохраняется. Плейнтекст не персистится.
- Использование: `apps/worker/src/queues/send-dispatch.ts` → `readSendPrereqs()` читает 4 колонки, `decryptTenantSecret()`, ключ живёт в памяти воркера на время джоба, передаётся в `sendTenantMailV3(apiKey, payload)` как per-call заголовок `Authorization: Bearer` (`packages/delivery-core/src/send-mail.ts`). **Модульный синглтон `@sendgrid/mail` для тенантских отправок не используется** — сознательно, чтобы ключи не гонялись между тенантами.
- Recheck: `POST /api/workspaces/:slug/sendgrid-key/recheck` — расшифровывает ключ в API-процессе и делает живой вызов SendGrid.

**Защита от утечки в логи:**

- `send-mail.ts` → `redactApiKey(err, apiKey)`: подменяет ключ на `[REDACTED]` в `message` и `stack` любой ошибки от `fetch`.
- `apps/api/src/logger.ts` (pino): `redact.paths` = `sendgridKey`, `apiKey`, `password`, `token` + их варианты на 1 и 2 уровнях вложенности (`*.x`, `*.*.x`). **Глубже двух уровней редакция не действует.** Уровень: `silent` в тестах, иначе `info`. У воркера структурированного логгера нет — `console.log`/`console.error`.

### 3.5 Платформенный ключ SendGrid

`PLATFORM_SENDGRID_API_KEY` из env → `sgMail.setApiKey()` на уровне модуля в `apps/api/src/modules/platform-mail/client.ts`. Используется **только** для системных писем (верификация, сброс пароля, инвайт), тела — HTML-шаблоны в репозитории. Модуль структурно изолирован от тенантского пути (не импортирует KMS/хранилище ключей); в `__tests__/platform-mail.test.ts` есть assert на исходник, фиксирующий эту изоляцию.

### 3.6 Креды к БД

- **Единственный источник — `DATABASE_URL`.** Отдельных `PGUSER`/`PGPASSWORD` нет.
- **Два независимых пула** на одном `DATABASE_URL`:
  1. `packages/tenant-context/src/index.ts` → `new Pool({ connectionString: process.env.DATABASE_URL })` — **tenant-scoped**, через него идёт всё, что защищено RLS. Есть `pool.on("error")`-хендлер (иначе обрыв idle-соединения ронял бы процесс).
  2. `packages/db/src/index.ts` → свой `new Pool(...)` + Drizzle — для better-auth и не-tenant запросов. **`pool.on("error")` здесь нет.**
- TLS/`ssl` в опциях пулов **не задан** → поведение определяется строкой подключения. Как настроено в prod — **не определено**.
- PgBouncer/RDS Proxy в репозитории **отсутствуют** (grep по `docker-compose.yml`, `docker/`, исходникам: 0 вхождений).

### 3.7 Прочие секреты в БД

| Таблица.колонка | Что | Как |
|---|---|---|
| `workspace_api_keys.secret_hash` | **SHA-256 hex** секретной половины API-ключа | `createHash("sha256").update(secret).digest("hex")`, без соли. Сознательно не bcrypt/argon2 — секрет 256 бит. Сверка через `crypto.timingSafeEqual` с предварительной проверкой длины |
| `workspace_api_keys.id` | несекретный префикс, `randomBytes(8).toString("hex")` | он же PK и lookup-ключ |
| `workspace_webhook_endpoints.path_token` | **plaintext**, `randomBytes(32).toString("base64url")` | pre-auth trust anchor URL вебхука. Не хешируется |
| `workspace_webhook_endpoints.public_key` | **plaintext** ECDSA public key SendGrid | по документированному допущению — не секрет |
| `account.password` | better-auth | хеширование — внутри better-auth, **в этом репозитории кода нет** → алгоритм **не определён** |
| `account.accessToken/refreshToken/idToken`, `session.token` | plaintext `text` | **без шифрования и без RLS** (см. 4.3) |

Формат API-ключа: `mcrm_<id>.<secret>`, `secret = randomBytes(32).toString("base64url")` (256 бит). Полный ключ отдаётся один раз при создании. **Колонка `scopes` (`text[]`) хранится, но нигде не проверяется** — любой валидный ключ даёт полный доступ к `/v1/contacts` и `/v1/events` своего воркспейса.

Токен unsubscribe (`packages/delivery-core/src/unsubscribe-token.ts`): `base64url(JSON{sendId,contactId,workspaceId,exp}) + "." + base64url(HMAC-SHA256)`, секрет — `UNSUBSCRIBE_TOKEN_SECRET`, сверка `timingSafeEqual`. TTL при подписи — **5 лет**; константа `UNSUBSCRIBE_TOKEN_TTL_SECONDS = 60*60*24*365*5` **объявлена дважды** с одинаковым значением: `apps/worker/src/queues/send-dispatch.ts:41` и `apps/worker/src/queues/flows/flow-send.ts:26` — правка одной не чинит вторую. `exp` проверяется в роуте, не в верификаторе.

---

## 4. Схема данных

Диалект: PostgreSQL (`postgres:17` в compose; в коде требований к версии нет). `timestamp` ниже = `timestamp without time zone`, `timestamptz` = `with time zone` — записано ровно так, как в схеме.

> **Оговорка:** Drizzle-схема — не полная истина. Физический DDL таблиц `events` и `send_events` (партиционирование, составные PK, unique) существует **только** в рукописных миграциях `0007`, `0010`, `0020`; в `packages/db/src/schema/{events,send-events}.ts` объявлены лишь формы для вывода типов. Из 38 миграций snapshot в `migrations/meta/` есть только у **11**: `0000`, `0002`, `0003`, `0005`, `0008`, `0011`, `0016`, `0017`, `0024`, `0025`, `0034`. Остальные **27** — рукописные, без snapshot'а. Комментарий в `0034` фиксирует, что на момент его написания baseline drizzle-kit стоял на `0025` и `generate` выдавал ложный diff с полным пересозданием таблиц; `0034_snapshot.json` с тех пор закоммичен, так что это описание относится к диапазону `0026`–`0033`, а не ко всем последующим миграциям.

### 4.1 Таблицы better-auth (RLS НЕТ)

`user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` — `packages/db/src/schema/auth.ts`, миграции `0000`, `0002`. Имена колонок — quoted camelCase.

- **`user`**: `id` uuid PK dflt `gen_random_uuid()`, `name` text NN, `email` text NN UNIQUE (`user_email_unique`), `emailVerified` bool NN dflt `false`, `image` text, `createdAt`/`updatedAt` timestamp NN dflt `now()`.
- **`session`**: `id` uuid PK, `expiresAt` timestamp NN, `token` text NN UNIQUE, `createdAt`/`updatedAt` NN, `ipAddress` text, `userAgent` text, `userId` uuid NN → `user(id)` CASCADE, `activeOrganizationId` uuid **без FK**.
- **`account`**: `id` uuid PK, `accountId` text NN, `providerId` text NN, `userId` uuid NN → `user(id)` CASCADE, `accessToken`/`refreshToken`/`idToken`/`scope`/`password` text NULL, `accessTokenExpiresAt`/`refreshTokenExpiresAt` timestamp NULL, `createdAt`/`updatedAt` NN. Уникальных констрейнтов нет.
- **`verification`**: `id` uuid PK, `identifier` text NN, `value` text NN, `expiresAt` timestamp NN, `createdAt`/`updatedAt` timestamp **NULL** dflt `now()`.
- **`organization`** (= workspace, цель всех FK `workspace_id`): `id` uuid PK, `name` text NN, `slug` text NN UNIQUE, `logo` text, `createdAt` timestamp NN, `metadata` text, `deletedAt` timestamp NULL (soft-delete).
- **`member`**: `id` uuid PK, `organizationId` uuid NN → `organization(id)` CASCADE, `userId` uuid NN → `user(id)` CASCADE, `role` text NN dflt `'member'`, `createdAt` NN. **UNIQUE на `(organizationId, userId)` отсутствует.**
- **`invitation`**: `id` uuid PK, `organizationId` uuid NN → CASCADE, `email` text NN, `role` text NULL, `status` text NN dflt `'pending'`, `expiresAt` timestamp NN, `inviterId` uuid NN → `user(id)` CASCADE, `createdAt` timestamp NN dflt `now()` (добавлена в `0002`).

### 4.2 Доменные таблицы (все 22 — с RLS ENABLE + FORCE)

**`workspace_sendgrid_keys`** (`0000`) — PK `(workspace_id)` → `organization(id)` CASCADE. Колонки: `encrypted_dek`, `ciphertext`, `iv`, `auth_tag`, `key_mask` (все text NN), `status` text NN dflt `'active'`, `last_checked_at` timestamp NULL, `created_at`/`updated_at` NN.

**`contacts`** (`0003`, изм. `0023`/`0029`) — `id` uuid PK, `workspace_id` uuid NN → CASCADE, `external_id` text NULL, `email` text NULL, `first_name`/`last_name`/`phone`/`city`/`country` text NULL, `tags` text[] NN dflt `'{}'`, `properties` jsonb NN dflt `'{}'`, `subscription_status` enum NN dflt `'subscribed'`, `consecutive_soft_bounces` int NN dflt `0`, `timezone` text NULL (IANA, валидируется только приложением), `created_at`/`updated_at` NN.
UNIQUE `(workspace_id, external_id)`, UNIQUE `(workspace_id, email)` — обе колонки nullable, NULL'ы в Postgres различны, поэтому множество контактов без email/external_id в одном воркспейсе допустимо (сознательно).
Enum `subscription_status` = `('subscribed','unsubscribed','suppressed')`.

**`workspace_property_registry`** (`0003`) — `id` uuid PK, `workspace_id` NN → CASCADE, `key` text NN, `observed_type` text NN, `first_seen_at` NN. UNIQUE `(workspace_id, key)`. `observed_type ∈ string|number|bool|date` — только приложением.

**`workspace_suppressions`** (`0003`) — `id` uuid PK, `workspace_id` NN → CASCADE, `email` text NN, `reason` text NN dflt `'manual'`, `created_at` NN. UNIQUE `(workspace_id, email)`.

**`workspace_api_keys`** (`0005`) — `id` **text** PK (без default, генерится приложением), `workspace_id` NN → CASCADE, `name` text NN, `secret_hash` text NN, `key_mask` text NN, `scopes` text[] NN dflt `'{}'` (**не используется**), `created_at` NN, `revoked_at` timestamp NULL.

**`events`** (DDL: `0007` + `0010`) — `id` uuid NN **без default** (приходит от клиента), `workspace_id` uuid NN → CASCADE, `contact_id` uuid NN → `contacts(id)` CASCADE, `name` text NN, `properties` jsonb NN dflt `'{}'`, `occurred_at` timestamptz NN dflt `now()`, `received_at` timestamptz NN dflt `now()`.
**PK `(workspace_id, id, occurred_at)`** — расширен в `0010`; в комментарии миграции зафиксировано, что исходный `(id, occurred_at)` был дефектом изоляции тенантов (CR-01): чужой тенант мог занять eventId, и вставка жертвы молча гасилась `ON CONFLICT DO NOTHING` уже после отданного `202`.
`PARTITION BY RANGE (occurred_at)`.

**`csv_imports`** (`0008`, изм. `0035`) — `id` uuid PK, `workspace_id` NN → CASCADE, `file_name` text NN, `created_by_user_id` **text NN без FK на `user(id)`**, `status` text NN dflt `'uploaded'`, `duplicate_policy` text NN dflt `'update'`, `mapping` jsonb NULL, `default_timezone` text NULL, `total_rows`/`processed_rows` int NN dflt `0`, `summary` jsonb NULL, `created_at`/`updated_at` NN.

**`csv_import_rows`** (`0008`) — `id` uuid PK, `csv_import_id` NN → `csv_imports(id)` CASCADE, `workspace_id` NN → CASCADE, `row_number` int NN, `raw` jsonb NN (сырая строка CSV — произвольные загруженные PII at rest), `status` text NN dflt `'pending'`, `reason` text NULL. UNIQUE `(csv_import_id, row_number)`. Таймстемпов нет.

**`segments`** (`0011`) — `id` uuid PK, `workspace_id` NN → CASCADE, `name` text NN, `definition` jsonb NN, `created_by_user_id` text NN (без FK), `member_count` int NULL, `member_count_at` timestamp NULL, `created_at`/`updated_at` NN. `definition` компилируется в SQL на чтении через `@mega-crm/segments-core` — релевантно для ревью инъекций.

**`campaigns`** (`0013`+`0017`+`0024`) — `id` uuid PK, `workspace_id` NN → CASCADE, `name` text NN, `status` enum `campaign_status` NN dflt `'draft'`, `segment_id` uuid NN → **`segments(id)` ON DELETE RESTRICT**, `template_id`/`from_sender_id`/`from_email` text NULL, `scheduled_at` timestamptz NULL, `sendable_total`/`excluded_total` int NULL, `sent_count`/`failed_count`/`delivered_count`/`opened_count`/`clicked_count`/`bounced_count`/`unsubscribed_count` int NN dflt `0`, `snapshot_cursor` uuid NULL, `fan_out_complete` bool NN dflt `false`, `sending_started_at`/`terminal_at` timestamptz NULL, `created_by_user_id` text NN, `created_at`/`updated_at` NN.
Enum `campaign_status` = `('draft','scheduled','sending','sent','canceled')`. Переходы статусов — только на уровне репозитория, констрейнта нет.

**`campaign_recipients`** (`0014`) — `id` uuid PK, `campaign_id` NN → CASCADE, `workspace_id` NN → CASCADE, `contact_id` NN → CASCADE, `created_at` NN. UNIQUE `(campaign_id, contact_id)` — **без `workspace_id`**.

**`sends`** (`0015`+`0022`+`0028`+`0036`) — `id` uuid PK, `workspace_id` NN → CASCADE, `campaign_id` uuid NULL → **`campaigns(id)` ON DELETE SET NULL**, `contact_id` NN → CASCADE, `kind` text NN dflt `'campaign'`, `status` enum `send_status` NN dflt `'dispatching'`, `exclusion_reason` text NULL, `provider_message_id` text NULL, `queued_at` timestamptz NN dflt `now()`, `sent_at`/`delivered_at`/`first_opened_at`/`first_clicked_at`/`bounced_at`/`dropped_at`/`unsubscribed_at`/`spam_reported_at` timestamptz NULL, `bounce_reason`/`drop_reason` text NULL, `flow_run_id` uuid NULL → `flow_runs(id)` CASCADE, `node_id` text NULL, `open_count`/`click_count` int NN dflt `0`.
UNIQUE `(workspace_id, campaign_id, contact_id)` — `campaign_id` nullable, поэтому для flow-отправок этот констрейнт **не работает** (см. частичный индекс в 4.5).
Enum `send_status` = `('dispatching','sent','failed','excluded')`. Таймстемпов `created_at`/`updated_at` нет.

**`workspace_send_settings`** (`0016`+`0030`) — PK `(workspace_id)` → CASCADE, `frequency_cap` int NN dflt `3`, `frequency_window_hours` int NN dflt `24`, `rps_limit` int NULL, `default_timezone` text NULL, `quiet_hours_start`/`quiet_hours_end` int NULL (минуты от полуночи, без CHECK-диапазона), `quiet_hours_enabled` bool NN dflt `false`, `created_at`/`updated_at` NN.

**`send_events`** (DDL: `0020`) — `id` uuid NN **без default**, `workspace_id` NN → CASCADE, `sg_event_id` text NN, `send_id` uuid NULL → **`sends(id)` ON DELETE SET NULL**, `event_type` text NN, `reason` text NULL, `payload` jsonb NN dflt `'{}'` (сырое событие провайдера), `is_test` bool NN dflt `false`, `occurred_at` timestamptz NN **без default**, `received_at` timestamptz NN dflt `now()`.
**PK `(workspace_id, id, occurred_at)`**; **UNIQUE `(workspace_id, sg_event_id, occurred_at)`** — ключ дедупликации вебхука. `PARTITION BY RANGE (occurred_at)`.
**`occurred_at` берётся из поля `timestamp`, присланного SendGrid** — то есть значение, влияющее и на маршрутизацию по партициям, и на ключ дедупликации, приходит извне.

**`workspace_webhook_endpoints`** (`0021`+`0025`) — `id` uuid PK, `workspace_id` NN → CASCADE, `path_token` text NN UNIQUE, `sendgrid_webhook_id` text NULL, `public_key` text NULL, `provision_status` text NN dflt `'pending'`, `provision_error` text NULL, `last_event_at` timestamptz NULL, `created_at`/`updated_at` timestamptz NN.

**`flows`** (`0026`+`0031`+`0033`+`0034`) — `id` uuid PK, `workspace_id` NN → CASCADE, `name` text NN, `status` enum `flow_status` NN dflt `'draft'`, `trigger_type`/`trigger_event_name` text NULL, `trigger_segment_id` uuid NULL → **`segments(id)` ON DELETE RESTRICT**, `draft_version_id`/`live_version_id` uuid NULL — **без FK на `flow_versions(id)`**, `reentry_mode` text NN dflt `'every_time'`, `reentry_window_days` int NULL, `quiet_hours_mode` text NN dflt `'workspace_default'` (до `0034` было `'inherit'`), `quiet_hours_start`/`quiet_hours_end` int NULL, `exit_conditions` jsonb NN dflt `'[]'`, `enroll_cursor` uuid NULL, `created_by_user_id` text NN, `created_at`/`updated_at` NN.
Enum `flow_status` = `('draft','live','paused')`.

**`flow_versions`** (`0026`) — `id` uuid PK, `workspace_id` NN → CASCADE, `flow_id` NN → `flows(id)` CASCADE, `version_number` int NN, `definition` jsonb NN, `published_at` timestamptz NULL, `created_at` NN. **UNIQUE `(flow_id, version_number)` отсутствует** — неизменяемость и монотонность версий обеспечиваются только приложением.

**`flow_runs`** (`0026`) — `id` uuid PK, `workspace_id` NN → CASCADE, `flow_id` NN → CASCADE, `flow_version_id` NN → **`flow_versions(id)` ON DELETE RESTRICT** (пин версии), `contact_id` NN → CASCADE, `status` enum `flow_run_status` NN dflt `'waiting'`, `current_node_id` text NULL, `next_wake_at` timestamptz NULL, `entered_at`/`last_entry_at` timestamptz NN dflt `now()`, `exited_at` timestamptz NULL, `exit_reason` text NULL.
Enum `flow_run_status` = `('waiting','advancing','completed','exited','ejected')`.

**`flow_run_steps`** (`0026`) — `id` uuid PK, `workspace_id` NN → CASCADE, `flow_run_id` NN → CASCADE, `node_id` text NN, `node_type` text NN, `outcome` text NN, `send_id` uuid NULL → `sends(id)` SET NULL, `created_at` NN. Append-only только по соглашению — триггеров/грантов, запрещающих UPDATE/DELETE, нет.

**`flow_segment_membership_snapshot`** (`0026`) — `id` uuid PK, `workspace_id` NN → CASCADE, `flow_id` NN → CASCADE, `contact_id` NN → CASCADE, `seen_at` timestamptz NN dflt `now()`. UNIQUE `(workspace_id, flow_id, contact_id)`.

**`subscription_status_history`** (`0036`) — `id` uuid PK, `workspace_id` NN → CASCADE, `contact_id` NN → **`contacts(id)` CASCADE**, `old_status` text NULL, `new_status` text NN, `source` text NN, `reason` text NULL, `changed_at` timestamptz NN dflt `now()`.
`source ∈ webhook_suppression | webhook_unsubscribe | unsubscribe_route | manual_ui | csv_or_api_upsert` — только приложением. `old_status`/`new_status` — plain `text`, **не** enum. Это compliance-журнал согласий; CASCADE по `contact_id` означает, что удаление контакта уничтожает его историю согласий.

**`workspace_daily_rollup`** (`0037`) — `id` uuid PK, `workspace_id` NN → CASCADE, `day` date NN, `sent_count`/`delivered_count`/`opened_count`/`clicked_count`/`bounced_count`/`unsubscribed_count` int NN dflt `0`. UNIQUE `(workspace_id, day)` — цель `ON CONFLICT` для обоих путей записи. Таймстемпов нет.

### 4.3 RLS

**GUC:** `app.current_workspace_id` — константа `TENANT_GUC_KEY` в `packages/db/src/rls.ts`, реэкспорт из `packages/db/src/index.ts`.

**Как ставится:** `packages/tenant-context/src/index.ts` → `withTenantTransaction(fn)`: берёт `workspaceId` из `AsyncLocalStorage` (устанавливается `withTenant(workspaceId, fn)`), открывает транзакцию и выполняет
`SELECT set_config('app.current_workspace_id', $1, true)` — третий аргумент `true` = семантика `SET LOCAL`, значение живёт только внутри транзакции и не протекает на следующий запрос через пул. `apps/api/src/db.ts` и `apps/api/src/middleware/tenant-context.ts` — тонкие реэкспорт-шимы поверх этого пакета, то есть api и worker используют одну реализацию. Есть тест `apps/api/src/db/__tests__/rls-pooling-chaos.test.ts`.

**Таблицы БЕЗ RLS:** семь better-auth-таблиц (`user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`) — сознательно, задокументировано в `0001_rls_policies.sql`. Следствие: `organization` (реестр воркспейсов, куда указывают все FK `workspace_id`), `account.password`, `session.token` лежат вне RLS и читаются любым запросом через не-tenant Drizzle-пул без фильтра.

**Политика `workspace_isolation`** есть на каждой доменной таблице, `USING` и `WITH CHECK` совпадают, но существует в двух вариантах:

*Вариант A (голый каст):*
```sql
workspace_id = current_setting('app.current_workspace_id', true)::uuid
```
На: `workspace_sendgrid_keys`, `contacts`, `workspace_suppressions`, `workspace_property_registry`, `events`, `csv_imports`, `csv_import_rows`, `segments`, `campaign_recipients`, `sends`, `workspace_send_settings`, `send_events` — **12 таблиц**.

*Вариант B (с NULLIF-guard):*
```sql
workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
```
На: `workspace_api_keys` (`0006`), `campaigns` (`ALTER POLICY` в `0019`), `workspace_webhook_endpoints` (`0021`), `flows`, `flow_versions`, `flow_runs`, `flow_run_steps`, `flow_segment_membership_snapshot` (`0026`), `subscription_status_history` (`0036`), `workspace_daily_rollup` (`0037`) — **10 таблиц**.

Причина (в комментариях `0006` и `0019`): после того как кастомный GUC был хоть раз затронут в сессии, `current_setting(name, true)` возвращает `''`, а не NULL, до конца сессии; каст `''::uuid` бросает `invalid input syntax for type uuid` вместо «не совпало». `0019` — это фикс именно этого на `campaigns`. Postgres объединяет все permissive-политики команды через OR, поэтому ошибка в одной политике роняет весь запрос. Заявленное обоснование того, что вариант A оставлен: эти таблицы читаются только внутри `withTenantTransaction`, где значение всегда непустое. **Это инвариант приложения, БД его не проверяет.** В варианте A находятся в том числе `events` и `send_events` — обе пишутся воркером.

**Эмпирическое подтверждение (08-09):** `packages/db/src/__tests__/migrate-incremental.test.ts` наткнулся на это на практике. Соединение, которое один раз выполнило tenant-скоупленную транзакцию и вернулось в пул, при следующем не-скоупленном запросе к таблице варианта A падает с `invalid input syntax for type uuid: ""` — вместо того чтобы вернуть ноль строк. Поэтому тест держит **два пула**: один для DDL (никогда не скоупится), второй для скоупленных вставок и подсчётов. Инвариант «читаем только внутри `withTenantTransaction`» относится к прикладному коду; любой смешанный сценарий на одном пуле его нарушает.

**Дополнительные GUC и bypass-политики (все `FOR SELECT`):**

| GUC | Где ставится | Политика | Выражение |
|---|---|---|---|
| `app.api_key_lookup_id` | `api-keys.repository.ts:98` | `api_key_runtime_lookup` на `workspace_api_keys` (`0006`) | `id = current_setting('app.api_key_lookup_id', true)` — одна строка по уже известному PK |
| `app.webhook_path_token` | `webhook-endpoint.repository.ts:54` | `webhook_endpoint_runtime_lookup` на `workspace_webhook_endpoints` (`0021`) | `path_token = current_setting('app.webhook_path_token', true)` — pre-auth |
| `app.admin_scan` | `campaign-scheduler.worker.ts:40`, `flows/flow-reconciliation.worker.ts:32`, `flows/flow-segment-sweep.worker.ts:51` | `campaign_scheduler_due_scan` на `campaigns` (`0018`) | `current_setting('app.admin_scan',true)='true' AND status='scheduled' AND scheduled_at <= now()` |
| `app.admin_scan` | те же | `flow_runs_due_scan` на `flow_runs` (`0027`) | **`current_setting('app.admin_scan', true) = 'true'` — и всё** |
| `app.admin_scan` | те же | `flows_segment_sweep_scan` на `flows` (`0032`) | **`current_setting('app.admin_scan', true) = 'true'` — и всё** |

⚠️ Последние две политики, вопреки собственным комментариям («mirror the 0018 precedent exactly»), **не содержат никакого предиката помимо проверки GUC**. Установка `app.admin_scan='true'` открывает на чтение **все строки `flows` и `flow_runs` во всех воркспейсах, в любом статусе**. Фактические SQL-запросы воркеров сужают выборку сами (`WHERE status='waiting' AND next_wake_at<=now()` и т.п.), но политика не ограничивает ничего.

### 4.4 Партиционирование

| Таблица | Стратегия | Ключ | Партиции | Создано в |
|---|---|---|---|---|
| `events` | RANGE | `occurred_at` | `events_2026_07` `['2026-07-01','2026-08-01')`, `events_2026_08` `['2026-08-01','2026-09-01')`, `events_default` (DEFAULT) | `0007`; DEFAULT добавлена в `0010` |
| `send_events` | RANGE | `occurred_at` | `send_events_2026_07`, `send_events_2026_08`, `send_events_default` (DEFAULT) | `0020` |

**Кода, создающего будущие партиции, в репозитории нет.** Grep по `PARTITION OF` / `PARTITION BY` / `ATTACH PARTITION` / `DETACH PARTITION` / `pg_partman` / `create_parent` / `run_maintenance` во всех `*.ts`/`*.mjs`/`*.js`/`*.sql` (без `node_modules`, `dist`): вне `packages/db/migrations/` — только doc-комментарии (в `schema/events.ts`, `schema/send-events.ts`, `schema/workspace-daily-rollup.ts:8`, `contact.repository.ts:81` и одном тесте). Нет ни cron-джоба, ни pg_partman, ни воркера обслуживания. `0007` называет это «operational follow-up».

**Следствие:** выделенные партиции существуют только на июль и август 2026. С 2026-09-01 все события и все send_events бессрочно падают в DEFAULT-партицию. Это не потеря данных, но неограниченный рост и блокировка будущего `ATTACH PARTITION` без полного скана.

### 4.5 Индексы

Помимо неявных индексов PK/UNIQUE из 4.1–4.2:

| Таблица | Индекс | Определение |
|---|---|---|
| `events` | `idx_events_workspace_contact_time` | `(workspace_id, contact_id, occurred_at)` |
| `events` | `idx_events_workspace_name_time` | `(workspace_id, name, occurred_at)` |
| `contacts` | `idx_contacts_tags_gin` | `USING gin (tags)` |
| `campaigns` | `idx_campaigns_scheduled` | `(status, scheduled_at)` — **без префикса workspace**, под кросс-тенантный скан планировщика |
| `sends` | `idx_sends_workspace_contact_sent_at` | `(workspace_id, contact_id, sent_at)` — покрывающий для frequency cap |
| `sends` | `idx_sends_campaign_status` | `(campaign_id, status)` — без префикса workspace |
| `sends` | `sends_flow_run_node_unique` | **UNIQUE PARTIAL** `(workspace_id, flow_run_id, node_id) WHERE kind = 'flow'` — единственная гарантия идемпотентности flow-отправок |
| `send_events` | `idx_send_events_workspace_send` | `(workspace_id, send_id)` |
| `workspace_webhook_endpoints` | `idx_workspace_webhook_endpoints_workspace` | `(workspace_id)` |
| `flow_runs` | `idx_flow_runs_workspace_status_next_wake` | `(workspace_id, status, next_wake_at)` |
| `flow_runs` | `flow_runs_one_active_per_contact` | **UNIQUE PARTIAL** `(workspace_id, flow_id, contact_id) WHERE status IN ('waiting','advancing')` |
| `subscription_status_history` | `idx_subscription_status_history_workspace_contact_changed` | `(workspace_id, contact_id, changed_at)` |

Оба частичных unique-индекса написаны сырым SQL (Drizzle `unique()` не умеет `WHERE`) и **невидимы для drizzle-kit**.

На `contacts.properties` GIN-индекса сознательно нет — операторы кастомных свойств компилируются в `->>`, GIN их не ускоряет; вместо этого в `segment.repository.ts` стоит `statement_timeout`.

Без единого явного индекса (только PK/UNIQUE): все таблицы better-auth, `workspace_sendgrid_keys`, `workspace_property_registry`, `workspace_suppressions`, `workspace_api_keys`, `csv_imports`, `csv_import_rows`, `segments`, `campaign_recipients`, `workspace_send_settings`, `flows`, `flow_versions`, `flow_run_steps`, `flow_segment_membership_snapshot`, `workspace_daily_rollup`. Индекса на `sends.provider_message_id` нет.

### 4.6 Миграции

- Инструмент: **drizzle-kit `0.31.10`**. `packages/db/drizzle.config.ts`: `dialect: "postgresql"`, `schema: "./src/schema/*.ts"`, `out: "./migrations"`, `verbose: true`, `strict: true`; бросает при загрузке модуля, если нет `DATABASE_URL`.
- Скрипты: `db:generate` → `drizzle-kit generate`, `db:migrate` → `drizzle-kit migrate` (проксируются из root).
- `scripts/migrate-dev.mjs`: `process.loadEnvFile("../.env")` в try/catch → падает, если `DATABASE_URL` не задан → `execSync("npm run db:migrate")`.
- **Автоприменение только в dev**, через npm lifecycle: `predev` = `check-env.mjs && migrate-dev.mjs`, отрабатывает перед `dev`. **Ни api, ни worker не вызывают мигратор при старте.** Grep по `db:migrate` / `drizzle-kit migrate` / `migrate(`: только три package.json, `scripts/migrate-dev.mjs:37` и `apps/api/src/test/db-fixture.ts:82`. Как миграции доезжают до не-dev окружения — **не определено**.
- Журнал: `migrations/meta/_journal.json`, version 7, 38 записей (0–37). Snapshot'ы есть только у **11** миграций (`0000`, `0002`, `0003`, `0005`, `0008`, `0011`, `0016`, `0017`, `0024`, `0025`, `0034`); у остальных **27** — нет.

---

## 5. Планировщик и пайплайн отправки

### 5.1 Чем запускается воркер

**Ни cron, ни `setInterval`/`setTimeout`, ни системный таймер.** Всё — **BullMQ repeatable jobs**, регистрируемые в самом процессе воркера. Grep по `apps/worker/src` и `apps/api/src` (без тестов) на `repeat:|cron|setInterval|setTimeout(` даёт ровно 4 вхождения — все четыре это `repeat: { every: ... }`:

| Файл | Очередь-тик | Интервал | jobId |
|---|---|---|---|
| `campaign-scheduler.worker.ts:106` | `campaign-scheduler` | `SCAN_INTERVAL_MS = 60_000` (60 с) | `scan-due-campaigns` |
| `flows/flow-reconciliation.worker.ts:105` | `FLOW_RECONCILIATION_QUEUE` (`flow-reconciliation`) | `RECONCILIATION_INTERVAL_MS = 60_000` | `scan-due-flow-runs` |
| `analytics-reconciliation.worker.ts:117` | `analytics-reconcile` | `RECONCILE_INTERVAL_MS = 3 * 60_000` (3 мин) | `reconcile-rollups` |
| `flows/flow-segment-sweep.worker.ts:183` | `FLOW_SEGMENT_SWEEP_QUEUE` (`flow-segment-sweep`) | `SWEEP_INTERVAL_MS = 15 * 60_000` (15 мин) | `scan-segment-triggered-flows` |

Регистрация идемпотентна: BullMQ дедуплицирует repeatable job по repeat-конфигу + `jobId`, поэтому повторный boot воркера не плодит конкурирующие расписания. Состояние расписаний живёт **в Redis** — потеря Redis теряет и их (перерегистрируются при следующем старте процесса).

Точка входа процесса: `apps/worker/src/server.ts` → `buildWorker()`. Запускается через `main()` только при прямом запуске (`import.meta.url === file://${process.argv[1]}`). `dev`: `tsx watch --env-file=../../.env src/server.ts`; `start`: `node dist/server.js`. Graceful shutdown на `SIGINT`/`SIGTERM` → `worker.close()` для всех + `connection.disconnect()`.

### 5.2 Зарегистрированные воркеры (13)

`events-ingest`, `imports-csv`, `email-broadcast`, `email-triggered`, `campaign-kickoff`, `campaign-scheduler`, `webhook-events`, `analytics-reconciliation`, `flow-run-advance`, `flow-reconciliation`, `flow-trigger-evaluator`, `flow-segment-sweep`, `flow-enroll-existing`.

Каждый Worker получает **свои** `RedisOptions` из `buildRedisConnectionOptions(REDIS_URL)`, а не общий инстанс `Redis` (BullMQ бандлит собственную копию ioredis другой версии — номинальный конфликт типов). `maxRetriesPerRequest: null` обязателен для BullMQ. Пароль/юзер Redis берутся из URL.

### 5.3 Очереди (имена — `packages/shared-schemas/src/queues.ts`)

`events-ingest`, `imports-csv`, `email-broadcast`, `email-triggered`, `campaign-kickoff`, `webhook-events`, `flow-trigger-evaluator`, `flow-run-advance`, `flow-reconciliation`, `flow-segment-sweep`, `flow-enroll-existing`. Плюс два тик-имени, объявленных локально в файлах воркеров: `campaign-scheduler`, `analytics-reconcile`. Дефис вместо двоеточия — BullMQ запрещает `:` в имени очереди.

Разделение `email-broadcast` / `email-triggered` — два независимых Worker'а с разной concurrency, а **не** BullMQ `priority`: приоритет разрешает конкуренцию только внутри пула одной очереди.

- `email-broadcast`: `concurrency: 5` (ограниченный)
- `email-triggered`: `concurrency: 20` (always-on)

`defaultJobOptions` — `attempts: 5`, `backoff: { type: "exponential", delay: 2000 }`, `removeOnComplete: { age: 86400 }`, **`removeOnFail: false`** (проваленные джобы хранятся в Redis бессрочно) — этот блок **продублирован в 8 местах**: `apps/api/src/modules/campaigns/campaign-queues.ts:35`, `apps/api/src/modules/events/events-queue.ts:45`, `apps/api/src/modules/contacts/imports-csv-queue.ts:41-46`, `apps/api/src/modules/webhooks/enqueue.ts:43-48`, `apps/api/src/modules/flows/flow-queues.ts:30`, `apps/worker/src/queues/campaign-broadcast-producer.ts:11`, `apps/worker/src/queues/campaign-scheduler.worker.ts:9-14`, `apps/worker/src/queues/flows/flow-queues.ts:13`. Исключение — `FLOW_RUN_ADVANCE_JOB_OPTIONS` (`apps/worker/src/queues/flows/flow-queues.ts:29-34`): `removeOnComplete: true`, `removeOnFail: { age: 86400 }`.

**Durability-постура Redis под очередями (08-04).** Redis, на котором держится BullMQ, сконфигурирован через `docker/redis.conf` (см. §1.3) так, чтобы при достижении потолка памяти **отказывать в записи, а не вытеснять**: `maxmemory 512mb` + `maxmemory-policy noeviction`. Это прямо взаимодействует с `removeOnFail: false` выше — проваленные джобы копятся в Redis бессрочно, и при вытесняющей политике состояние джобов исчезало бы молча, без ошибки где-либо; под `noeviction` то же переполнение даёт явную ошибку записи. Обратная сторона: под потолком BullMQ может получить `OOM command not allowed` не только на `queue.add`, но и на внутренних Lua-скриптах смены статуса. Обработка этого состояния — **не** задача фазы 8, она отнесена к фазе 12; здесь зафиксирована только сама конфигурация.

`appendonly yes` + `appendfsync everysec` — то, что позволяет поставленным в очередь джобам пережить рестарт: `docker restart` шлёт SIGTERM, и Redis при штатном завершении делает финальный fsync. `everysec` вместо `always` — сознательный компромисс по пропускной способности с границей потери в одну секунду записей. Само выживание очереди через рестарт утверждается отдельно в 08-13.

### 5.4 Планировщик кампаний (`campaign-scheduler.worker.ts`)

Каждые 60 с:

1. `findDueCampaignCandidates()` — `pool.connect()` напрямую (**не** `withTenant`), короткая read-only транзакция, ставит только `app.admin_scan='true'`, читает `SELECT id, workspace_id FROM campaigns WHERE status='scheduled' AND scheduled_at <= now()`. Без `FOR UPDATE` — сознательно: RLS требует наличия применимой UPDATE-политики для блокирующего SELECT, а `campaign_scheduler_due_scan` — SELECT-only.
2. `transitionToSending(row)` — уже через `withTenant`/`withTenantTransaction`, `SELECT ... FOR UPDATE SKIP LOCKED` перепроверяет, что кампания всё ещё due, затем `UPDATE campaigns SET status='sending'`.
3. Только при фактическом переходе — `kickoffQueue.add("kickoff", {...}, { jobId: row.id })`. Тот же детерминированный `jobId`, что и у немедленного запуска из роута `launch`, — двойной kickoff невозможен.

Restart-safe: следующий тик просто пересканирует; отдельного delayed-состояния нет.

### 5.5 Диспетчер отправки (`send-dispatch.ts`)

Общий `processSendJob` для обоих send-воркеров — логика гейта/троттлинга/диспатча не расходится между лейнами.

**Троттлинг:** `rate-limiter-flexible` `RateLimiterRedis`, `keyPrefix: "send-rl"`, `points = rps`, `duration: 1` (в секунду), ключ бакета — `workspaceId`. RPS берётся из `workspace_send_settings.rps_limit`, при NULL — `DEFAULT_TENANT_RPS = 10` (`rate-limiter.ts:10`; в комментарии `:6-8` помечен как `[ASSUMED]`). Инстансы лимитера кешируются по значению rps (`points` фиксируется при конструировании). Клиент Redis для лимитера — **отдельный** ленивый синглтон `new Redis(REDIS_URL)`, не BullMQ-соединение. Настоящая ошибка Redis пробрасывается наверх, а не трактуется как «разрешено».
Встроенный BullMQ `limiter` **не используется** — он глобальный на воркер, а не на тенанта.

**Три единицы работы (внешний вызов SendGrid никогда не внутри транзакции):**

1. Claim-транзакция (`claimCampaignSend` / `claimFlowSend`): читает prereqs (расшифровка ключа, RPS, template/from), проверяет `campaigns.status === 'sending'`, `evaluatePreSendGate`, коммитит строку `sends` в статусе `dispatching`. Ветка `interrupted` (предыдущая попытка закоммитила claim и не завершилась) записывает `failed` и **никогда** не повторяет вызов SendGrid — окно дублей закрывается по семантике at-most-once.
2. `consumeTenantToken` → при отказе claim освобождается (`releaseDispatchClaim`) и возвращается `{outcome:"rate_limited", rateLimitMs}`.
3. Вызов `sendTenantMailV3` вне транзакции → отдельная транзакция записывает терминальный результат + счётчик кампании + `tryCompleteCampaign`.

**Обработка ответов SendGrid:** `429` или `>= 500` → освободить claim, `rate_limited` с backoff из `Retry-After` (сек) → иначе `X-RateLimit-Reset` (unix-сек) → иначе фиксированные 2000 мс. `>= 400` → `failed` (никогда не `sent`). Иначе `sent` + `providerMessageId` из заголовка `x-message-id`.

Воркер превращает `rate_limited` в `await worker.rateLimit(ms); throw Worker.RateLimitError()` — попытка джоба **не расходуется**.

**Запрос к SendGrid** (`packages/delivery-core/src/send-mail.ts`): сырой `fetch` `POST https://api.sendgrid.com/v3/mail/send`, `Authorization: Bearer <ключ тенанта>` per-call. Payload: `template_id`, `dynamic_template_data`, `custom_args: { send_id, workspace_id, campaign_id?, test? }`, заголовки `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, `tracking_settings`: `subscription_tracking.enable = false`, `open_tracking.enable = true`, `click_tracking.enable = true` (принудительно, независимо от настроек аккаунта тенанта).

### 5.6 Низколатентные пробуждения flow

`handlers/delay-node.ts` вычисляет `nextWakeAt`, пишет его в `flow_runs.next_wake_at` (durable source of truth) и ставит **BullMQ delayed job** через `enqueueFlowRunAdvance(payload, { delay })`. `jobId` уникален на каждое пробуждение (`${flowRunId}-${Date.now()}`) — иначе удержанный завершённый джоб с тем же id заглушил бы будущее пробуждение (задокументированный дефект CR-01). Идемпотентность обеспечивается не дедупом jobId, а перепроверками статуса/`next_wake_at` + `FOR UPDATE OF fr SKIP LOCKED` в консьюмере. Repeatable-скан `flow-reconciliation` (60 с) — **backstop** на случай потери delayed job (крах воркера, потеря данных Redis).

### 5.7 Кросс-тенантные сканы вне RLS-скоупа

`analytics-reconciliation.worker.ts` выполняет `pool.query("SELECT id FROM organization")` **напрямую, вне `withTenant`** — это работает, потому что на `organization` нет RLS (4.3). Отдельной admin-политики для этого не заводили. Дальше каждый воркспейс реконсилится в собственной `withTenant`-транзакции.

---

## 6. Публичные точки входа

### 6.1 Конфигурация сервера (`apps/api/src/server.ts`)

- `Fastify({ loggerInstance: logger, routerOptions: { maxParamLength: 1024 } })` — 1024 вместо дефолтных 100 из-за длины токена unsubscribe (~230–260 символов).
- `@fastify/rate-limit` зарегистрирован с **`{ global: false }`** — лимит действует только на явно opt-in роутах.
- `@fastify/helmet` — единственная регистрация на всё приложение:
  `defaultSrc: ["'none'"]`, `styleSrc: ["'unsafe-inline'"]`, `baseUri: ["'none'"]`, `frameAncestors: ["'none'"]`. `script-src` не задан → падает в `default-src 'none'`. Остальные middleware helmet (HSTS, noSniff, frameguard…) — на дефолтах `@fastify/helmet` 13.0.2.
- CORS (`modules/auth/plugin.ts:22-25`, внутри `fastify-plugin`-обёртки → **действует на всё приложение**): `origin: [env.WEB_URL]` (один точный origin, без wildcard/regex), `credentials: true`, остальное — дефолты `@fastify/cors` 11.2.0.
- **Healthcheck/readiness/metrics-эндпоинта нет.** Grep по `/health|/healthz|/ready|/live|/metrics` в `apps/`: 0 роутов.

**Парсеры тела:**

| Скоуп | Конфигурация |
|---|---|
| Глобально | Дефолт Fastify (JSON + text/plain) |
| `/api/auth/*` | `removeAllContentTypeParsers()` + catch-all `"*"` passthrough (сырой поток для better-auth) |
| `/webhooks/sendgrid/*` | `application/json` → **Buffer**, лимит 1 000 000 байт |
| `/unsubscribe/*` | `application/x-www-form-urlencoded` → Buffer, лимит 1024 Б, **отбрасывается** (`done(null, undefined)`) |
| `/api/workspaces/:slug/imports` | `@fastify/multipart` в изолированном скоупе, `fileSize: 50 MB` |

`fastify-plugin` использован **только** в `auth/plugin.ts:21` — переопределения парсеров в webhook/unsubscribe/multipart инкапсулированы и не ослабляют парсинг остальных роутов.

### 6.2 Роуты БЕЗ аутентификации

| METHOD | Путь | Защита | Rate limit |
|---|---|---|---|
| ALL | `/api/auth/*` | внутренняя, better-auth | **20 / 1 мин** (scope-global) |
| GET | `/unsubscribe/:token` | **токен не проверяется и ничего не мутирует** (сознательно: защита от prefetch-мутации и enumeration) | нет |
| POST | `/unsubscribe/:token` | подписанный HMAC-токен в пути — единственный authz-вход | **нет** |
| POST | `/webhooks/sendgrid/:pathToken` | секретный path token + ECDSA-подпись | **нет** |
| GET | `/api/invites/:invitationId` | **ничего** — отдаёт `email`, `role`, `organizationName`, `organizationSlug`, `status` | **нет** |
| POST | `/api/invites/:invitationId/register` | публично, создаёт аккаунт; email берётся из строки инвайта, не из тела | 10 / 1 мин |
| POST | `/api/invites/:invitationId/accept` | требует сессию (better-auth сверяет email) | 10 / 1 мин |

### 6.3 Роуты по bearer API-ключу

| METHOD | Путь | Rate limit | Лимит тела |
|---|---|---|---|
| POST | `/v1/contacts` | 100 / 1 мин | 1 MB |
| POST | `/v1/events` | 100 / 1 мин | 5 MB |

Воркспейс резолвится **только** из `request.apiKeyWorkspaceId` — никогда из slug или сессии. Хук — `onRequest` (до парсинга тела).

### 6.4 Роуты по сессии (членство в воркспейсе)

Всего в приложении **85 роутов**.

**Основной паттерн** (большинство роутов ниже): `resolveWorkspaceMember` → `getCallerRoles(headers, slug)` → `auth.api.getActiveMemberRole`; любой throw (неаутентифицирован / неизвестный slug / не член) схлопывается в **одинаковый 404** — анти-enumeration.

⚠️ **`resolveWorkspaceMember` — не общий middleware, а 9 независимых локальных копий** одной и той же функции: `contacts.routes.ts:58`, `csv-import.routes.ts:37`, `send-log.routes.ts:42`, `campaigns.routes.ts:142`, `flows.routes.ts:119`, `segments.routes.ts:98`, `analytics/flow-analytics.routes.ts:15`, `analytics/dashboard.routes.ts:24`, `analytics/timeline.routes.ts:21`. Анти-enumeration-инвариант скопирован по модулям, а не обеспечен централизованно.

⚠️ **Паттерн соблюдён не везде** — четыре роута из списка ниже ведут себя иначе:

| Роут | Фактическое поведение |
|---|---|
| `GET /api/workspaces/:slug/members` (`members.ts:24-51`) | `getCallerRoles` **не вызывается**; `findActiveWorkspaceBySlug` + `auth.api.listMembers`, ошибка → `reply.code(err.statusCode ?? 403)` (`:45-46`) — **403/401, а не единый 404** |
| `GET /api/workspaces/:slug` (`workspaces.ts:99-128`) | `getFullOrganization` + `getActiveMemberRole` инлайном, ошибка → `err.statusCode ?? 404` — статус better-auth пробрасывается наружу |
| `POST /api/profile/name` (`profile.ts:25-43`) | **нет `:slug` и нет резолва членства вообще**; ошибка → `err.statusCode ?? 400` |
| `POST /api/profile/password` (`profile.ts:45-65`) | то же |

Список: `POST|GET /api/workspaces`, `GET /api/workspaces/:slug`, `POST /api/profile/name`, `POST /api/profile/password`, `GET /api/workspaces/:slug/members`, `.../sendgrid-key` (GET), `.../webhook-health`, `.../send-settings` (GET), `.../contacts` (GET/POST), `.../contacts/:id` (GET/PATCH/DELETE), `.../contacts/:id/events`, `.../contacts/:id/timeline`, `.../property-registry`, `.../imports` (POST multipart / GET), `.../imports/:id`, `.../imports/:id/dry-run`, `.../imports/:id/apply`, `.../imports/:id/errors`, `.../segments` (GET/POST), `.../segments/event-names`, `.../segments/preview-count`, `.../segments/:id` (GET/PATCH/DELETE), `.../segments/:id/members`, `.../campaigns` (GET/POST), `.../campaigns/sendgrid/templates`, `.../campaigns/sendgrid/senders`, `.../campaigns/:id` (GET/PATCH/DELETE), `.../campaigns/:id/test-send`, `.../campaigns/:id/test-sample`, `.../campaigns/:id/progress`, `.../campaigns/:id/audience-breakdown`, `.../flows` (GET/POST), `.../flows/:id` (GET/PATCH), `.../flows/:id/enroll-preview`, `.../flows/:id/duplicate`, `.../flows/:id/runs`, `.../flows/:id/analytics`, `.../dashboard`, `.../send-log`, `.../send-log/:sendId/events`.

**Ни один из них не имеет rate limit.**

### 6.5 Роуты с ролевым гейтом (`requirePermission`)

Матрица ролей — `modules/auth/access-control.ts:40-79`: **member — пустой массив прав по каждому ресурсу**; **admin** — всё, кроме `organization:delete`; **owner** — всё.

| METHOD | Путь | Permission |
|---|---|---|
| DELETE | `/api/workspaces/:slug` | `organization:delete` (**только owner**) |
| POST/GET | `.../invites`, `.../invites/:id/revoke`, `.../invites/:id/resend` | `invitation:create` / `invitation:cancel` (+ owner-only при `role=admin`) |
| POST | `.../members/:memberId/role`, DELETE `.../members/:memberId` | `member:update` / `member:delete` (+ owner-only проверки внутри) |
| POST | `.../sendgrid-key` | `sendgridKey:update` **+ `requireVerifiedEmail`** |
| POST | `.../sendgrid-key/recheck`, `.../webhook-reconnect` | `sendgridKey:update` |
| GET/POST | `.../api-keys`, POST `.../api-keys/:id/revoke` | `apiKeys:create` / `apiKeys:revoke` |
| PUT | `.../send-settings` | `campaign:launch` |
| POST | `.../campaigns/:id/launch` (`campaigns.routes.ts:314-316`) | `campaign:launch` |
| POST | `.../campaigns/:id/schedule` (`:359-361`) | `campaign:launch` |
| POST | `.../campaigns/:id/cancel` (`:400-402`) | `campaign:launch` |
| POST | `.../campaigns/:id/duplicate` (`:421-423`) | `campaign:launch` |
| POST | `.../flows/:id/publish` (`flows.routes.ts:266-268`) | `flow:publish` |
| POST | `.../flows/:id/pause` (`:319-321`) | `flow:publish` |
| POST | `.../flows/:id/resume` (`:343-345`) | `flow:publish` |
| POST | `.../flows/:id/runs/eject` (`:426-428`) | `flow:publish` |
| DELETE | `.../flows/:id` (`:459-461`) | `flow:publish` |

### 6.6 Сессионная аутентификация

`better-auth@1.6.23`, смонтирован как `toNodeHandler(auth)` на `ALL /api/auth/*` с `reply.hijack()`.

- Секрет: `env.BETTER_AUTH_SECRET`, валидация **`min(16)`**.
- Сессия: скользящая, `expiresIn: 60*60*24*30` (30 дней), `updateAge: 60*60*24`.
- `trustedOrigins: [env.WEB_URL]` — это и есть CSRF-защита better-auth.
- `advanced.database.generateId: false` — id генерит Postgres (`gen_random_uuid()`), чтобы совпадать с `::uuid` в RLS.
- `emailAndPassword.enabled: true`, **`requireEmailVerification: false`** — аккаунт работоспособен сразу; верификация гейтит только подключение ключа SendGrid. `sendOnSignUp` не задан — письмо шлётся только по явному ресенду.
- `requireEmailVerificationOnInvitation: false`.
- Инвайты живут 7 дней (`invitationExpiresIn`).
- **Имя cookie, `sameSite`, `useSecureCookies`, `cookiePrefix` нигде в репозитории не конфигурируются** → действуют дефолты better-auth → **не определено** в терминах этого кода.

### 6.7 Аутентификация по API-ключу (`modules/api-keys/api-key-auth.ts`)

Формат `mcrm_<id>.<secret>` в `Authorization: Bearer`. Сверка: `createHash("sha256")` от секрета → `timingSafeEqual` с предварительной проверкой длины. Проверяется `revoked_at`. Все ветки отказа (нет заголовка, кривой токен, неизвестный id, неверный секрет, отозван) возвращают идентичный 401 `{ error: "Invalid or missing API key" }`.
Оговорка: `lookupApiKeyById(id)` — запрос в БД по несекретному префиксу — выполняется **до** timing-safe сравнения, поэтому существование ключа остаётся различимым по времени ответа (round-trip в БД против раннего выхода), несмотря на идентичные тела.
**Скоупов нет** — валидный ключ даёт полный доступ к обоим `/v1`-роутам своего воркспейса.

### 6.8 Вебхук SendGrid

`POST /webhooks/sendgrid/:pathToken`.

- Библиотека: `@sendgrid/eventwebhook@8.0.0` — `convertPublicKeyToECDSA()` + `verifySignature()`; своей реализации нет.
- **Сырое тело сохраняется:** модуль переопределяет `application/json`-парсер на `parseAs: "buffer"` и передаёт Buffer как есть → подпись считается по точным байтам. Модуль **не** обёрнут в `fastify-plugin`, поэтому переопределение локально.
- Заголовки: `x-twilio-email-event-webhook-signature`, `x-twilio-email-event-webhook-timestamp`.
- Порядок: резолв `pathToken` → 404 при неизвестном токене/отсутствии public key (**до** любой попытки верификации, анти-enumeration) → **верификация подписи** → 400 при неуспехе, без `JSON.parse` и без enqueue → только затем парсинг и постановка **всего батча одним джобом** в `webhook-events`, ack-fast 200.
- Fail-closed: `verifyWebhookSignature` возвращает `false` при отсутствии подписи/таймстемпа и нормализует любое исключение в `false`.
- ⚠️ **Защиты от replay нет.** `timestamp` передаётся в библиотеку только как вход подписи; проверки свежести/окна нет ни в роуте, ни в библиотеке. Практический эффект ограничен идемпотентностью ниже по стеку (UNIQUE `(workspace_id, sg_event_id, occurred_at)` на `send_events`), но на HTTP-уровне защиты нет, и rate limit на роуте отсутствует.

### 6.9 Unsubscribe

- `GET /unsubscribe/:token` рендерит страницу подтверждения, токен не верифицирует и ничего не мутирует. `POST` — мутирует `contacts.subscription_status` → `unsubscribed`.
- `exp` проверяется в роуте (`unsubscribe.routes.ts:174-175`), не в верификаторе.
- Токен привязан к конкретному `sendId` → не переиспользуется между отправками и аудируем. Серверной записи о единоразовом использовании нет — повторный POST идемпотентно даёт тот же результат.
- **CSRF-токена, проверки Origin/Referer нет — сознательно:** RFC 8058 one-click требует кросс-origin POST от почтового провайдера без браузерного контекста. Подписанный токен в пути — единственный вход авторизации; обработчик `request.body` не читает вообще. Следствие: любой, кто узнал токен (пересылка письма, сканеры ссылок, логи прокси), может отписать этот контакт. Радиус — один контакт, одна отправка.
- XSS: строгий формат-гард `/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/` → при несоответствии form action пустой; `escapeHtmlAttribute` на значении; плюс CSP `default-src 'none'`.
- Ответы байт-идентичны для «плохая подпись» / «кривой формат» / «истёк» / «валидный, но неизвестный контакт». Гард `isUuid` не даёт signature-valid не-UUID `contactId` дойти до uuid-колонки и породить отличимый 500.
- `withTenant(payload.workspaceId, ...)` доверяет `workspaceId` прямо из подписанного payload — корректно ровно настолько, насколько цел `UNSUBSCRIBE_TOKEN_SECRET`.

### 6.10 Прочее

`GET /api/workspaces` (`workspaces.ts:140-147`) вызывает `auth.api.listOrganizations` **без try/catch** — неаутентифицированный вызов даёт 500 вместо 401. Не обход авторизации, но необработанный путь ошибки.

---

## 7. Наблюдаемость

- API: pino (`apps/api/src/logger.ts`) как `loggerInstance` Fastify. `pino-http` объявлен, но не подключён.
- Worker: **структурированного логирования нет** — только `console.log`/`console.error` в `server.ts` и `pool.on("error")` в `tenant-context`.
- **Bull Board / UI очередей отсутствует** (не объявлен ни в одном package.json). В комментарии `apps/worker/src/server.ts:20` он упомянут как «future wiring».
- Метрик и трейсинга нет. HTTP-healthcheck'а у приложения нет (см. 6.1). Контейнерные healthcheck'и в `docker-compose.yml` есть, но это проверки самой инфраструктуры, а не приложения: `pg_isready -U postgres` для `db` и `redis-cli ping` для `redis`.

---

## 8. Расхождения с разделом Technology Stack в `.claude/CLAUDE.md`

CLAUDE.md описывает **рекомендованный** стек по итогам ресёрча. Ниже — где код от него отличается. Это не список дефектов; это список мест, где нельзя опираться на CLAUDE.md как на описание системы.

### 8.1 Заявлено в CLAUDE.md, но в коде отсутствует

| Заявлено | Факт |
|---|---|
| **TypeScript 6.0.x** («TS 6 Corsa-based… no reason to pin lower») | Везде `^5.9.3`, установлено **5.9.3**. TS 6 не используется нигде |
| **PgBouncer** (или RDS Proxy) — «поставить до инцидента, а не после» | В репозитории отсутствует полностью. В `docker-compose.yml` только postgres и redis; в коде — два прямых `pg.Pool` |
| **`@bull-board/api` + `@bull-board/fastify` 8.1.x** — «нужен на этих объёмах» | **Не объявлен ни в одном package.json.** UI очередей нет |
| **`@fastify/jwt` 10.x** | Не установлен. Аутентификация — `better-auth` 1.6.23 (cookie-сессии) |
| **`pino-http` 11.0.0** | Объявлен в `apps/api`, но **не используется** (0 вхождений в `src`) |
| **Zustand** — «для состояния canvas-редактора» | Объявлен в `apps/web`, но **не используется** (0 вхождений в `src`) |
| **Tremor** (как альтернатива Recharts) | Не установлен; используется Recharts `3.9.2` |
| Партиционирование `events` **«by month, on `created_at`»** | Партиционирование по **`occurred_at`**; колонки `created_at` в `events` нет вообще (есть `occurred_at` и `received_at`) |

### 8.2 Есть в коде, но в CLAUDE.md не описано

| Технология | Версия | Роль |
|---|---|---|
| **`better-auth`** | `1.6.23` | Ядро аутентификации + модель organization/member/invitation + матрица ролей. **CLAUDE.md не упоминает её ни разу**, хотя это фундамент всей authz-модели и владелец 7 таблиц без RLS |
| `@sendgrid/eventwebhook` | `^8.0.0` | Верификация ECDSA-подписи вебхука |
| `@sendgrid/mail` | `8.1.6` | Только платформенная почта (тенантские отправки — сырой `fetch`) |
| `react-router` | `8.1.0` | Роутинг SPA |
| `@radix-ui/*` (16 пакетов) + `tailwindcss` `3.4.19` + `class-variance-authority` + `clsx` + `tailwind-merge` + `cmdk` + `sonner` + `lucide-react` + `tailwindcss-animate` | — | Весь UI-слой (shadcn/ui) |
| `fastify-plugin` | `^5.0.1` | Инкапсуляция плагинов |
| `nanoid` | `5.1.16` | Только `tenancy/workspaces.ts` |
| `nock` | `14.0.16` | HTTP-моки в тестах |
| `concurrently` | `10.0.3` | Оркестрация dev |
| `@hookform/resolvers` | `5.4.0` | Мост react-hook-form ↔ zod |
| `postcss` / `autoprefixer` | `8.5.16` / `10.5.2` | Сборка стилей |
| `tsx` | `^4.19.2` | Рантайм dev + загрузчик `.env` (`--env-file`) |
| **GitHub Actions CI** (`.github/workflows/ci.yml`) | — | Гейт качества: тайпчек + тесты на каждый `push` и `pull_request` в `master`, живые Postgres/Redis через `docker compose up -d --wait`. **CLAUDE.md не упоминает CI вообще** — ни GitHub Actions, ни какую-либо другую систему; раздел Technology Stack описывает только рантайм-стек |
| `execa` | `10.0.0` | Объявлен в `packages/test-support` под spawn/kill дочерних процессов для SIGKILL-сценария; **кодом ещё не используется** |
| **ESLint + typescript-eslint** (`eslint.config.js`) | `10.8.0` / `8.65.0` | Линт-гейт с type-aware ярусом. **CLAUDE.md не упоминает линтер вообще** — раздел Technology Stack называет Vitest и Playwright, но ни ESLint, ни какой-либо другой линтер |
| `eslint-plugin-import-x` | `^4.17.1` | **Расхождение с планом 08-03:** план называл `eslint-plugin-import`, но его последняя версия `2.32.0` объявляет peer `eslint: ^2 … ^9` и не поддерживает ESLint 10. Установлен поддерживаемый форк, дающий то же правило `no-extraneous-dependencies` |

### 8.3 Совпадает с CLAUDE.md (для полноты)

`fastify` 5.9.0, `zod` 4.4.3, `drizzle-orm` 0.45.2 + `drizzle-kit` 0.31.10, `pg` 8.22.0, `bullmq` 5.79.1, `ioredis` 5.11.0, `rate-limiter-flexible` 11.2.0, `@xyflow/react` 12.11.2 (не `reactflow`), `@tanstack/react-query` 5.101.2, `@tanstack/react-table` 8.21.3, `react` 19.2.7, `vite` 8.1.3, `react-hook-form` 7.80.0, `recharts` 3.9.2, `csv-parse` 7.0.1, `pino` 10.3.1, `vitest` 4.1.9, `@playwright/test` 1.61.1, `@aws-sdk/client-kms` 3.1079.0, `@fastify/{cors,helmet,multipart,rate-limit,type-provider-zod}`, Node >=22, Postgres 17, Redis 7, Express не используется.

Также совпадают архитектурные предписания: две отдельные очереди вместо `priority`; per-tenant троттлинг через `rate-limiter-flexible`, а не BullMQ `limiter`; shared schema + `tenant_id` + RLS вместо schema-per-tenant; KMS envelope encryption вместо pgcrypto; верификация подписи вебхука до парсинга тела.

---

## 9. Сводка вопросов к ревью

Перечислено фактами, без оценки серьёзности.

1. `flow_runs_due_scan` (`0027`) и `flows_segment_sweep_scan` (`0032`) — безусловные кросс-тенантные SELECT-гранты по одному GUC, без предиката, в отличие от прецедента `0018`, на который они ссылаются.
2. 12 таблиц (включая `events` и `send_events`) несут вариант политики с голым кастом, который `0019` чинил на `campaigns`. Безопасность держится на непроверяемом БД инварианте.
3. `organization`, `session`, `account` — вне RLS. Там же `account.password` и `session.token`.
4. Кода обслуживания партиций нет. С 2026-09-01 всё пишется в DEFAULT-партиции.
5. Replay-защиты у вебхука SendGrid нет; rate limit на роуте отсутствует.
6. `GET /api/invites/:invitationId` — публичный и без лимита, отдаёт email приглашённого и название организации.
7. `BETTER_AUTH_SECRET` — минимум 16 символов против 32 у `UNSUBSCRIBE_TOKEN_SECRET`; отдельной проверки для production нет.
8. У API-ключей нет скоупов; колонка `scopes` хранится, но не проверяется.
9. Rate limit — in-memory на процесс, per-IP; общего Redis-стора нет, хотя Redis уже обязательная зависимость. При >1 реплики лимиты умножаются на число реплик.
10. Healthcheck/readiness/metrics отсутствуют; Bull Board не подключён; у воркера нет структурированного логгера.
11. Dockerfile, CI и деплой-манифестов в репозитории нет; как миграции применяются вне dev — не определено; конфигурация TLS для Postgres и credential chain для AWS KMS — не определены.
12. `removeOnFail: false` на большинстве очередей — проваленные джобы хранятся в Redis бессрочно.
13. `DEFAULT_TENANT_RPS = 10` помечен в коде как предположение, не подтверждённое ни одним планом SendGrid.
14. Redact-пути pino покрывают только 2 уровня вложенности; у воркера редакции нет вообще.
15. `subscription_status_history.contact_id` — CASCADE: удаление контакта уничтожает журнал его согласий.
16. `member` без UNIQUE `(organizationId, userId)`; `flow_versions` без UNIQUE `(flow_id, version_number)`; `flows.draft_version_id`/`live_version_id` без FK.
17. `send_events.occurred_at` приходит от SendGrid и одновременно является ключом маршрутизации партиций и частью ключа дедупликации.
18. Второй пул (`packages/db`) не имеет `pool.on("error")` — обрыв idle-соединения на нём необработан.
19. В рабочем дереве лежат `.env` (гитигнорится) и `dump.rdb` (дамп Redis).
20. `resolveWorkspaceMember` существует в 9 независимых копиях; анти-enumeration-инвариант (единый 404) не централизован и на 4 роутах не соблюдён — `GET /api/workspaces/:slug/members` отдаёт 403/401, `GET /api/workspaces/:slug` пробрасывает статус better-auth, оба `/api/profile/*` не резолвят членство вообще (см. 6.4).
21. Блок `defaultJobOptions` продублирован в 8 файлах, `buildRedisConnectionOptions` — в 4; `UNSUBSCRIBE_TOKEN_TTL_SECONDS` объявлена дважды. Правка в одном месте не распространяется на остальные.

---

## 10. Поддержание документа

При добавлении любой новой библиотеки или технологии — дописать её в соответствующий раздел этого файла (раздел 2 для зависимостей; 3 для секретов/конфигурации; 4 для схемы; 5 для очередей/планировщика; 6 для точек входа; 8 если возникает новое расхождение с CLAUDE.md). Правило закреплено в `.claude/CLAUDE.md`.
