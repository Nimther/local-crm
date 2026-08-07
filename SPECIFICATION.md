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

`.github/workflows/ci.yml` (добавлен в 08-01, переписан в 08-18): workflow `CI`, триггеры `push` (без фильтра веток) и `pull_request` (`branches: [master]`) — оба обязательны, иначе required status check не появляется на PR. `concurrency` по `${{ github.workflow }}-${{ github.ref }}` с `cancel-in-progress: true`. Все `uses:` закреплены на полный 40-символьный commit SHA, тег — только в комментарии. `sleep` в workflow отсутствует: ожидание сервисов делает `docker compose up -d --wait` по healthcheck'ам из `docker-compose.yml`.

**Четыре job'а на `ubuntu-latest`:**

| Job | Сервисы | Шаги |
|-----|---------|------|
| `static` | нет | `npm ci` → `npm run build --workspaces --if-present` (**это и есть тайпчек**, отдельного `tsc --noEmit` нет) → `npm run lint` → `npm run lint:floor` → `npm run lint:migrations` → `npm run lint:session-state` (10-05, SEC-16) → `npm run check:root-hygiene` |
| `test` | `db`, `redis` | checkout с `fetch-depth: 0` → `npm ci` → `docker compose up -d --wait` → `npm run verify:redis-config` (`REDIS_URL: redis://localhost:6379`) → `npm run coverage` → `npm run coverage:gate` → `npm run coverage:ratchet` |
| `failure-injection` | `db`, `redis` | `npm ci` → установка пакета `redis-server` и `systemctl disable --now redis-server` → `docker compose up -d --wait` → **пять отдельных шагов**: `failure:429`, `failure:timeout`, `failure:reset`, `failure:sigkill`, `failure:redis-restart` |
| `e2e` | `db`, `redis` | `npm ci` → `docker compose up -d --wait` → `npx playwright install --with-deps chromium` → `npm run test:e2e` (шаг с явным `shell: bash`) → проверка маркера `[e2e:database]` в выводе |

Job-level `env` у трёх job'ов с сервисами: `DATABASE_URL` (dev-DSN — то, **с чем** сравнивает гард эфемерной БД; без него половина проверки прошла бы вхолостую) и `TEST_REDIS_URL`. `TEST_DATABASE_URL` намеренно **не** задаётся: каждый workspace создаёт свою эфемерную БД сам (vitest — в `globalSetup`, Playwright — на загрузке конфига) и публикует DSN.

Значимые детали, каждая — исправление реального дефекта:

- **`fetch-depth: 0` у `test`.** `coverage:ratchet` резолвит `git show origin/master:coverage-baseline.json`; в shallow-клоне по умолчанию `origin/master` не существует, а нечитаемый ref рэтчет трактует как ошибку, а не как проход.
- **`redis-server` ставится ДО `docker compose up`.** Установка пакета поднимает системный сервис на `6379` — том же порту, что публикует compose-сервис `redis`. При обратном порядке job падает на конфликте портов. Бинарь нужен сценарию `failure:redis-restart`, который поднимает собственный временный сервер из `docker/redis.conf`.
- **Пять отдельных шагов, а не агрегирующая команда.** Один общий шаг скрыл бы сценарий, который проходит только потому, что перед ним отработал соседний, и не назвал бы упавший сценарий в сводке job'а.
- **`shell: bash` на шаге захвата вывода E2E.** Шелл раннера по умолчанию — `bash -e` **без** `pipefail`, поэтому упавший Playwright, пропущенный через `tee`, вернул бы код `tee` (`0`) и шаг прошёл бы зелёным при полностью красном прогоне.
- **`e2e` — единственный job с `continue-on-error: true`.** Он сообщает, но не блокирует.

**Required status checks на `master`: `static`, `test`, `failure-injection`.** `e2e` в обязательный набор **не входит** — флапающий браузерный прогон блокировал бы каждый мёрдж ложно. Машинно-проверяемая часть его ценности при этом сохранена: job грепает обратно маркер `[e2e:database]` и падает, если прогон не сообщил БД из эфемерного пространства имён `mega_crm_test_e2e_*`. Сама branch protection — настройка репозитория GitHub, она живёт вне дерева и ни одной внутрирепозиторной проверкой не утверждается.

`npm run lint:floor` = `eslint . --format json | node scripts/check-lint-file-floor.mjs`. До 08-18 скрипт был голым `node scripts/…` и всегда получал путь к отчёту из verify-блока плана — как самостоятельная команда он читал пустой stdin и падал на `JSON.parse`. Пайп внутри npm-скрипта делает команду одинаковой локально и в CI, без CI-only обвязки; код возврата берётся от гейта, а не от ESLint, потому что за нарушения отвечает отдельный `npm run lint`. Непарсящийся отчёт (ESLint не стартовал вовсе) даёт внятную ошибку и exit 1, а не stack trace: это ровно тот вакуумный успех, ради которого гейт и заведён.

**Модель ветвления (08-18):** `.planning/config.json` → `git.branching_strategy` = `phase` (было `none`). Работа над фазой идёт в отдельной ветке, точка слияния — pull request, где и срабатывают три обязательные проверки. Шаблон ветки — `gsd/phase-{phase}-{slug}`.

Шаблон применяется **начиная с фазы 9**. Ветка фазы 8 называется `phase-08-quality-gates` — она создана до того, как стратегия была переключена с `none`, и остаётся под своим именем: это зафиксированное историческое исключение, а не расхождение, которое нужно чинить. Практическое следствие, о котором надо знать: пока имя ветки не совпадает с шаблоном, GSD-команды (`query init.phase-op`, `query commit`) делают checkout ветки по шаблону и коммитят туда — в фазе 8 это дважды увело коммит с рабочей ветки, и оба раза он возвращался fast-forward'ом. Внутри фазы 8 отчёты коммитятся обычным `git`, а не через `query commit`. С фазы 9 расхождения нет и обходной путь не нужен.

CI — **единственное** место, где проверяется контейнерный путь применения `docker/redis.conf` (`command:` + `:ro`-mount): на машине без Docker его воспроизвести нечем. Локальный прогон проверяет тот же файл, но применённый к временному `redis-server`.

`.nvmrc` (добавлен в 08-01): `26` — мажорная версия Node, на которую `actions/setup-node` настраивается через `node-version-file`.

`eslint.config.js` (добавлен в 08-03): flat-config ESLint 10 из семи блоков. Type-aware ярус (`recommendedTypeChecked` + `projectService`) намеренно ограничен глобами `apps/*/src/**` и `packages/*/src/**` — каждый `tsconfig.json` в репозитории объявляет `include: ["src"]`, поэтому `projectService` падает с ошибкой парсинга на любом файле вне `src/`. Конфиг-файлы, `scripts/**/*.mjs` и Playwright-спеки покрыты отдельным не-type-aware ярусом. На момент добавления: **396 файлов проверяется, 536 нарушений** (522 error / 14 warning) — приведение к нулю выполняется в 08-07, а не здесь.

`vitest.config.ts` в корне (добавлен в 08-11, дополнен в 10-05): агрегирующий конфиг с `test.projects` — **один** прогон по всей backend-области с **одним** знаменателем покрытия. Перечислены девять проектов: `apps/api`, `apps/worker`, `packages/db`, `packages/delivery-core`, `packages/flows-core`, `packages/test-support` (по путям к их собственным `vitest.config.ts`, чтобы наследовались их настройки — в частности `fileParallelism: false` у воркера), `packages/segments-core` и `packages/shared-schemas` голыми путями к каталогам (своих конфигов у них нет, и Vitest 4.1.9 такой путь принимает — проверено эмпирически в 08-11), и `scripts/vitest.config.ts` (10-05, SEC-16) — без него `npx vitest run scripts/__tests__/...` не находил ни одного файла («No test files found»), так как ни один из восьми исходных проектов не покрывает `scripts/`. `scripts/` при этом **не** входит в `coverage.include` ниже — новый проект добавляет тестовый прогон, но не расширяет знаменатель покрытия. `apps/web` **не включён** — вне области покрытия по решению D-16, и смешивать jsdom-проект с node-агрегатом всё равно нельзя. Падение или неисполнение любого проекта роняет весь прогон, поэтому workspace не может тихо выпасть из знаменателя (проверено: намеренно сломанный тест в `flows-core` даёт exit 1).

Покрытие: провайдер `v8`, репортеры `text` и `json-summary`, каталог `./coverage` (гитигнорится), `include` — `apps/api/src/**`, `apps/worker/src/**`, `packages/*/src/**`. Опция `all` оставлена по умолчанию, то есть знаменатель — фактически загруженные прогоном файлы (D-17). Скрипт `npm run coverage` = `vitest run --coverage --testTimeout=60000`: увеличенный таймаут нужен именно инструментированному прогону — `csv-import.test.ts` строит payload >50 МБ и под инструментацией v8 выходит за штатные 20 с (без coverage тот же файл проходит за 6.5 с).

`coverage-baseline.json` в корне (добавлен в 08-11): порог покрытия и его происхождение. `lines` — **недруглённая доля** (не проценты), равная измеренной плюс `increment`; `measuredLines`, `measuredAt` (дата, точные `covered`/`total`) и `scope` записаны рядом, чтобы любое будущее изменение порога было проверяемо против собственного основания. На момент добавления: измерено **3366/4194 = 0.80258**, порог **0.81258**. Порог намеренно **выше** текущего результата — гейт красный по построению, пока 08-16 не добавит целевые тесты на `packages/kms` и `packages/tenant-context`.

`scripts/check-root-hygiene.mjs` (добавлен в 08-15, скрипт `npm run check:root-hygiene`): **нерекурсивная** проверка рабочего корня по чёрному списку имён — `.env*` (кроме `.env.example`), `*.rdb`, `*.aof`, `.DS_Store`. Проверяет **содержимое каталога**, а не то, что отслеживает git: гитигнорируемый файл всё равно лежит на диске и читается всем, что работает в репозитории. Нерекурсивность намеренна (D-29) — рекурсивный обход сразу пометил бы легитимные фикстуры (`tools/lint-fixtures`, `tools/migration-fixtures`), и список исключений разросся бы до потери смысла. Контентное сканирование секретов — другой класс проверки, отнесён к фазе 13. Доказано fail-first: против временного каталога с `.env` и `dump.rdb` даёт exit 1 с перечислением обоих, против чистого — exit 0.

`scripts/lint-session-state.mjs` (добавлен в 10-05, SEC-16, скрипт `npm run lint:session-state`, шаг `Session-state audit` в `static`): машинная половина написанного в CONVENTIONS.md правила «session state только транзакционно-локальный». Без зависимостей (Node builtins), рекурсивно обходит `apps/api/src`, `apps/worker/src`, `packages/*/src`, `packages/db/scripts` (перечисление по файловой системе, не хардкод-список). Ловит: (1) SQL-строковый литерал, у которого ПЕРВОЕ ключевое слово — `SET` без `LOCAL` (регистрозависимо, только заглавные — иначе ложные срабатывания на `UPDATE ... SET ...` и на обычный английский текст вроде `{ onDelete: "set null" }` в Drizzle-схемах); (2) любой role-switch (`SET`/`RESET ROLE`, `SET SESSION AUTHORIZATION`) безусловно, даже с `LOCAL`; (3) `set_config(...)`, чей третий аргумент — не литерал `true`, включая двухаргументную форму. Исключение — комментарий `// session-state-exception: <причина>` на строке непосредственно перед оператором (без причины не подавляет, файл-заголовочная форма не поддерживается) — задокументировано в `docs/lint-rule-exceptions.md`. Фикстуры `scripts/__fixtures__/session-state/{violating,compliant}.ts` доказывают fail-first (три разных нарушения) и чистый прогон соответственно; сами исключены из tsconfig-сборки, ESLint и покрытия (не попадают ни под один `files`-глоб `eslint.config.js`, не входят в `coverage.include` корневого `vitest.config.ts`).

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
| `vitest` | `4.1.9` | dev — добавлен в 10-05; нужен на корневом уровне для `scripts/vitest.config.ts` (импорты `vitest`/`vitest/config` из `scripts/`, вне любого workspace) |

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
| `packages/db` | `drizzle-orm` `0.45.2`, `pg` `8.22.0`; dev: `drizzle-kit` `0.31.10`, `vitest` `4.1.9`, `@mega-crm/test-support` `0.1.0` (обе добавлены в 08-09 — у пакета появилась тестовая дорожка с `vitest.config.ts` и `globalSetup`, под два прогона цепочки миграций), `tsx` `^4.19.2` (09-04 — единственный runtime для оператор-CLI `scripts/relocate-default-partition-rows.ts`, npm-скрипт `relocate:default-partition-rows`; тот же диапазон версии уже был закреплён в `apps/api`/`apps/worker`, здесь — новое использование в третьем workspace) |
| `packages/kms` | `@aws-sdk/client-kms` `3.1079.0` |
| `packages/delivery-core` | `@mega-crm/tenant-context`, `pg` |
| `packages/contacts-core` | `@mega-crm/delivery-core`, `pg`, `pino` `10.3.1` |
| `packages/segments-core` | нет runtime-зависимостей |
| `packages/flows-core` | `zod` `4.4.3` |
| `packages/shared-schemas` | `@mega-crm/flows-core`, `zod` |
| `packages/tenant-context` | `pg` `8.22.0` |
| `packages/test-support` | `@mega-crm/db` `0.1.0` (09-03, D-05 — `db-fixture.ts` вызывает `ensurePartitions` через глубокий спецификатор `@mega-crm/db/src/partitions/ensure-partitions.js`, минуя `packages/db/src/index.ts`'s `DATABASE_URL`-throw при импорте; создаёт цикл в графе воркспейсов с обратной dev-зависимостью `packages/db` → `@mega-crm/test-support` ниже — признано безопасным: в репозитории нет TypeScript project references, каждый workspace `noEmit` и потребляет соседей как исходники через `main: ./src/index.ts`, поэтому порядка сборки, который цикл мог бы сломать, не существует), `pg` `8.22.0`, `ioredis` `5.11.0`; dev: `@types/node` `^22.10.5`, `@types/pg` `^8.15.6`, `typescript` `^5.9.3`, `vitest` `4.1.9`, `execa` `10.0.0`. `pg` используется с 08-02/08-06 (`provision-db.ts`, `db-fixture.ts`). **`ioredis` и `execa` объявлены, но кодом ещё не используются**: проверка конфигурации Redis (08-04) реализована на встроенных модулях Node, а не на `ioredis`; `execa` остаётся неиспользованным и после 08-12: SIGKILL-harness построен на `node:child_process.fork`, потому что IPC-канал — это ровно тот примитив, ради которого харнесс существует, и execa добавил бы слой поверх него |

**Фаза 9 в целом (09-01…09-05) не добавила ни одного нового third-party npm-пакета.** Единственная запись из раздела 2, появившаяся в этой фазе — `tsx` в `packages/db` (09-04, строка выше): уже существующий в репозитории диапазон версии, добавленный как devDependency в третий workspace ради тонкого оператор-CLI. Если читатель ищет здесь новую библиотеку под партиционирование/сторож/алертинг — её нет: вся автоматизация построена на уже присутствующих `pg`/`bullmq`/`@sendgrid/mail`.

---

## 3. Секреты: где хранятся и как читаются

### 3.1 `.env`

- `.env` лежит в корне репозитория, **гитигнорится** (`.gitignore:4`, подтверждено `git check-ignore -v .env`). В `git ls-files` его нет — в историю не попадал (проверено по текущему индексу; полный аудит истории коммитов **не проводился**).
- **Расположение решается в одном месте (08-15):** `resolveEnvPath()` в `scripts/env-path.mjs` возвращает `MEGA_CRM_ENV_FILE`, если она задана и непуста, иначе `$XDG_CONFIG_HOME/mega-crm/.env`, иначе `~/.config/mega-crm/.env` — то есть **вне рабочего корня репозитория**. До 08-15 путь был захардкожен независимо в девяти точках загрузки; теперь все они вызывают резолвер: `apps/api/src/load-env.ts`, `apps/worker/src/load-env.ts`, `scripts/check-env.mjs`, `scripts/migrate-dev.mjs` и шесть конфигов (`apps/api`, `apps/worker`, `packages/delivery-core`, `packages/db`, `packages/test-support` — vitest; `apps/web` — playwright).
- Загрузка: **в коде, а не флагом Node**. `dev`-скрипты `apps/api` и `apps/worker` больше **не** передают `--env-file`; вместо этого `server.ts` в обоих импортирует `./load-env.js` **первым импортом**. Порядок несущий: вычисление ES-модулей идёт по порядку импортов, а `apps/api/src/env.ts` парсит zod-схему на этапе вычисления модуля — загрузка после этого импорта прочла бы пустое окружение, и процесс упал бы с ошибкой валидации, выглядящей как отсутствующая конфигурация. Библиотеки `dotenv` в проекте **нет**. Скрипт `start` (`node dist/server.js`) остался без изменений → в прод-режиме переменные должны приходить из окружения процесса. Как именно — **не определено**.
- `process.loadEnvFile` **не перекрывает** уже заданные переменные окружения (проверено эмпирически в 08-15). Поэтому загрузка конфигурации в `server.ts` не ломает изоляцию E2E из 08-10: `webServer.env` и унаследованный `DATABASE_URL` выставлены раньше и выигрывают.
- **E2E-дорожка Playwright (08-10, переработана в 08-18)** конфиг загружает `.env` **в собственный процесс** (`process.loadEnvFile` в `apps/web/playwright.config.ts`, как во всех `vitest.config.ts`) — ради `TEST_ADMIN_DATABASE_URL` для провижининга и ради `DATABASE_URL` как объекта сравнения в guard'е.

  Провижининг выполняется `apps/web/e2e/provision-database.ts` и вызывается **на загрузке модуля конфига** (`await` на верхнем уровне), а не хуком `globalSetup`. Это не стилистика, а условие корректности. Playwright строит стартовые задачи в порядке (`playwright/lib/runner/index.js`, `createGlobalSetupTasks`): `createRemoveOutputDirsTask()` → `...createPluginSetupTasks(config)` (здесь стартует `webServer`) → `globalTeardowns` → `globalSetups`. То есть **`webServer` поднимается раньше `globalSetup`**, и до 08-18 API успевал прочитать `DATABASE_URL` до того, как хук подставлял эфемерный DSN. На машине разработчика прочитанное значение — dev-БД, где схема есть, поэтому все спеки проходили и изоляция выглядела рабочей; в CI dev-DSN указывает на пустую базу, и первый же запрос упал с `relation "user" does not exist`. Прямое подтверждение до исправления: **79 из 88 строк в dev-таблице `user`** были фикстурами вида `owner-<timestamp>@example.com`, свежайшие — от прогона, которым верифицировали 08-10.

  Модуль конфига вычисляется до любой стартовой задачи, поэтому DSN известен заранее и передаётся серверу **явным `DATABASE_URL` в `webServer[].env`**, а не наследованием — предположения о порядке не остаётся вовсе. Повторная загрузка конфига в воркер-процессах защищена переменной `MEGA_CRM_E2E_DATABASE_URL`: воркеры переиспользуют базу раннера, а не создают свою.

  Остальное без изменений: `createEphemeralDatabase` → `assertTestDatabaseUrl` → `ensureTestDbMigrated`, печать DSN с затёртым паролем за маркером `[e2e:database]`, удаление базы в `apps/web/e2e/global-teardown.ts` (состояние между половинами — через временный файл; `globalTeardown` остаётся хуком, потому что удалять надо после остановки серверов). Оба `webServer` запускают `dev:e2e`, вся среда API приходит из блока `webServer[].env` по boot-схеме `apps/api/src/env.ts` — другого источника DSN у сервера нет, поэтому прогон без провижининга не стартует, а не уходит тихо в dev-БД. `reuseExistingServer` на обоих — **`false`**. Обычные `dev`-скрипты не изменены.

  `apps/web/e2e/database-isolation.spec.ts` (08-18) — ассерт, которого не хватало: спек регистрируется через реальный UI, затем **сам** открывает соединение к эфемерной базе и требует, чтобы строка оказалась там. Всё, что проверяло 08-10, относилось к стороне провижининга; куда пишет сервер, не проверял никто. Доказан в обе стороны: с сервером, направленным на dev-БД, спек падает (`Expected "1", Received "0"`); после исправления 8 спеков проходят, счётчик пользователей в dev-БД до и после прогона одинаков, эфемерная база удаляется.
- `scripts/check-env.mjs` (`predev`-хук) читает и парсит `.env` **сам** (без зависимостей) и падает, если пусты: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `WEB_URL`, `PLATFORM_SENDGRID_API_KEY`, `PLATFORM_MAIL_FROM`, `OPERATOR_ALERT_EMAIL` (09-02, DB-02 — presence-only здесь; формат проверяет `apps/api/src/env.ts`; без него сторож партиций был бы бесшумно обезоружен), `REDIS_URL`, `UNSUBSCRIBE_TOKEN_SECRET`, `PUBLIC_APP_URL`, плюс `KMS_KEK_ID` (если `KMS_PROVIDER=aws`) либо `KMS_LOCAL_KEK`. Это dev-only проверка — прод её не выполняет.
- В рабочем дереве также присутствует `dump.rdb` (Redis-дамп, ~9.8 КБ) — гитигнорится по `*.rdb`, но физически лежит в папке проекта и может содержать данные очередей.

### 3.2 Полный список читаемых переменных окружения

| Переменная | Читается в | Валидация |
|---|---|---|
| `DATABASE_URL` | `packages/tenant-context/src/index.ts` (напрямую `process.env`), `packages/db/src/index.ts`, `packages/db/drizzle.config.ts`, `scripts/migrate-dev.mjs` | api: `z.string().min(1)`; в пакетах — throw при отсутствии |
| `REDIS_URL` | `apps/api/src/env.ts`; `apps/worker/src/server.ts`, `queues/send-dispatch.ts`, `queues/campaign-broadcast-producer.ts`, `queues/flows/flow-queues.ts` | `min(1)` / throw |
| `SCAN_DATABASE_URL` (Phase 10, SEC-01/SEC-02) | `packages/tenant-context/src/scan.ts` (`getScanPool`, напрямую `process.env`, лениво — не на этапе загрузки модуля); ручная проверка в `apps/worker/src/server.ts`'s `buildWorker` (после проверки `REDIS_URL`, до конструирования массива воркеров); `scripts/check-env.mjs`'s `baseRequired` (presence-only) | Throw с описательным текстом при отсутствии — и в `getScanPool()`, и в `buildWorker()`. **Сознательно отсутствует в `apps/api/src/env.ts`'s zod-схеме** — это структурная половина доказательства P3 («API-процесс не держит ни credentials, ни membership scan-роли»); подтверждается негативным тестом на исходники (`apps/api/src/__tests__/env-schema.test.ts`), а не только тем, что переменная сейчас не задана в API-окружении. Соединяется под ролью `mega_crm_scan` (§4.3), пароль — тот же dev-конвенционный `mega_crm_dev_pw`, что и у `mega_crm_app` (`docker/init-app-role.sql`) |
| `BETTER_AUTH_SECRET` | `apps/api/src/env.ts` → `modules/auth/auth.ts` | **`z.string().min(16)`** |
| `BETTER_AUTH_URL`, `WEB_URL`, `PUBLIC_APP_URL` | `apps/api/src/env.ts`; `PUBLIC_APP_URL` также в `apps/worker/src/server.ts` и `packages/delivery-core/src/unsubscribe-token.ts` | `z.string().url()` |
| `API_PORT` | `apps/api/src/env.ts` | `coerce.number().int().positive().default(4000)` |
| `NODE_ENV` | `apps/api/src/env.ts`, `packages/kms/src/env.ts`, `packages/contacts-core/src/logger.ts` | `z.enum(["development","test","production"]).default("development")` |
| `PLATFORM_SENDGRID_API_KEY` | `apps/api/src/env.ts` → `modules/platform-mail/client.ts` | `min(1)` |
| `PLATFORM_MAIL_FROM` | там же | `z.string().email()` |
| `OPERATOR_ALERT_EMAIL` | `apps/api/src/env.ts` → `apps/api/src/server.ts`'s `main()` (передаётся в `startPartitionWatchdog` как `operatorEmail`) — **читает только `apps/api`**, `apps/worker` эту переменную не видит | `z.string().email(...)`, **обязательна, без `.optional()`/`.default()`** — API отказывается стартовать без адреса, куда слать алерт сторожа партиций (09-02, DB-02, D-01). Резолвится через тот же `MEGA_CRM_ENV_FILE`-путь, что и остальные переменные (см. 3.1); отдельного секретного хранилища не заводит. Новых учётных данных фаза не вводит: алерт использует уже существующую пару `PLATFORM_SENDGRID_API_KEY`/`PLATFORM_MAIL_FROM`, никогда не BYO-ключ тенанта |
| `KMS_PROVIDER` | `apps/api/src/env.ts`, `packages/kms/src/env.ts:19` | `z.enum(["local","aws"]).default("local")` |
| `KMS_LOCAL_KEK` | читается в `packages/kms/src/env.ts:20`, потребляется в `local-provider.ts` | optional в схеме; провайдер требует base64 → **ровно 32 байта** |
| `KMS_KEK_ID` | читается в `packages/kms/src/env.ts:21`, потребляется в `aws-provider.ts` | optional в схеме; обязателен при `KMS_PROVIDER=aws` (superRefine) |
| `UNSUBSCRIBE_TOKEN_SECRET` | `apps/api/src/env.ts`; `apps/worker/src/server.ts` (ручная проверка `>= 32`); лениво в `packages/delivery-core/src/unsubscribe-token.ts` | **`z.string().min(32)`** |
| `TEST_DATABASE_URL`, `TEST_REDIS_URL`, `TEST_PUBLIC_APP_URL` | `vitest.config.ts`; `TEST_DATABASE_URL` с 08-02 **выставляется самим** `packages/test-support/src/global-setup.ts` (DSN эфемерной БД), а не задаётся вызывающим | — |
| `TEST_ADMIN_DATABASE_URL` | `packages/test-support/src/provision-db.ts:59` (`resolveAdminDsn`) — административный DSN, под которым создаются и удаляются эфемерные БД | при отсутствии — `postgres://postgres:postgres@localhost:5432/postgres` |
| `TEST_APP_DB_PASSWORD` | `packages/test-support/src/provision-db.ts:73` (`buildAppDsn`) — пароль роли `mega_crm_app` в DSN созданной БД | при отсутствии — `mega_crm_dev_pw` |
| `MEGA_CRM_E2E_DATABASE_URL` | выставляется и читается `apps/web/e2e/provision-database.ts` (08-18) | Re-entry guard провижининга E2E. Playwright загружает конфиг и в процессе-раннере, и в каждом воркере; воркеры наследуют эту переменную и переиспользуют базу раннера вместо того, чтобы каждый создавал свою и бросал её |
| `MEGA_CRM_ENV_FILE` | `scripts/env-path.mjs` (`resolveEnvPath`) — переопределяет путь к файлу конфигурации целиком | при отсутствии — `$XDG_CONFIG_HOME/mega-crm/.env`, иначе `~/.config/mega-crm/.env` |
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
- **Четыре независимых пула** (было три до Phase 10, было два до 09-REVIEW CR-03), на **разных** DSN начиная с Phase 10:
  1. `packages/tenant-context/src/index.ts` → `new Pool({ connectionString: process.env.DATABASE_URL })` — **tenant-scoped**, через него идёт всё, что защищено RLS. Есть `pool.on("error")`-хендлер (иначе обрыв idle-соединения ронял бы процесс).
  2. `packages/db/src/index.ts` → свой `new Pool(...)` + Drizzle — для better-auth и не-tenant запросов. **`pool.on("error")` здесь нет.**
  3. `apps/worker/src/queues/partition-maintenance.worker.ts` → собственный `new Pool(...)` (`partitionMaintenancePool`), **не** tenant-scoped, никогда не шарится с пулом #1 — `attachPartitionCheckFirst`'s admin-scan-инвариант (§4.3, §4.4) требует, чтобы соединение для этого пути никогда не выполняло tenant-scoped `SET LOCAL app.current_workspace_id`. Есть `pool.on("error")`-хендлер (тот же паттерн, что и у пула #1). До 09-REVIEW CR-03 этот воркер по умолчанию использовал пул #1 — нарушение того же инварианта, не эксплуатируемое только потому, что единственный путь вызова этого воркера (`ensurePartitions` против всегда-пустых новых месяцев) не тревожил admin-scan-политику на практике.
  4. **Phase 10 (SEC-01/SEC-02):** `packages/tenant-context/src/scan.ts` → `getScanPool()`, лениво создаваемый `new Pool({ connectionString: process.env.SCAN_DATABASE_URL })` — единственный из четырёх пулов на **отдельном от `DATABASE_URL` DSN**, соединяется под ролью `mega_crm_scan`, не под `mega_crm_app`. Лениво — импорт пакета из `apps/api` ничего не конструирует, поскольку `SCAN_DATABASE_URL` в API-окружении не объявлена (§3.2, P3). Есть `pool.on("error")`-хендлер (тот же паттерн). Единственный потребитель на сегодня — `campaign-scheduler.worker.ts`'s `findDueCampaignCandidates`; ещё четыре потребителя (`flow-segment-sweep`, `flow-reconciliation`, partition maintenance/relocation, `analytics-reconciliation`) мигрируют на него в последующих планах этой же фазы, продолжая пока пулы #1/#3 напрямую.
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

> **Оговорка:** Drizzle-схема — не полная истина. Физический DDL таблиц `events` и `send_events` (партиционирование, составные PK, unique) существует **только** в рукописных миграциях `0007`, `0010`, `0020`, `0038`; в `packages/db/src/schema/{events,send-events}.ts` объявлены лишь формы для вывода типов. `partition_maintenance_runs` (`0038`) с 09-03 **тоже** получил такой же type-inference-only файл — `packages/db/src/schema/partition-maintenance-runs.ts` — по тому же прецеденту: singleton-`CHECK (id = 1)` и сознательное отсутствие RLS у Drizzle `pgTable` выражения нет, поэтому физический DDL по-прежнему владеет миграцией `0038`, а файл лишь даёт типы для `packages/db/src/index.ts`'s `schema`-объекта. Из 39 миграций snapshot в `migrations/meta/` есть только у **11**: `0000`, `0002`, `0003`, `0005`, `0008`, `0011`, `0016`, `0017`, `0024`, `0025`, `0034`. Остальные **28** — рукописные, без snapshot'а. Комментарий в `0034` фиксирует, что на момент его написания baseline drizzle-kit стоял на `0025` и `generate` выдавал ложный diff с полным пересозданием таблиц; `0034_snapshot.json` с тех пор закоммичен, так что это описание относится к диапазону `0026`–`0033`, а не ко всем последующим миграциям.

### 4.1 Таблицы better-auth (RLS НЕТ)

`user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` — `packages/db/src/schema/auth.ts`, миграции `0000`, `0002`. Имена колонок — quoted camelCase.

- **`user`**: `id` uuid PK dflt `gen_random_uuid()`, `name` text NN, `email` text NN UNIQUE (`user_email_unique`), `emailVerified` bool NN dflt `false`, `image` text, `createdAt`/`updatedAt` timestamp NN dflt `now()`.
- **`session`**: `id` uuid PK, `expiresAt` timestamp NN, `token` text NN UNIQUE, `createdAt`/`updatedAt` NN, `ipAddress` text, `userAgent` text, `userId` uuid NN → `user(id)` CASCADE, `activeOrganizationId` uuid **без FK**.
- **`account`**: `id` uuid PK, `accountId` text NN, `providerId` text NN, `userId` uuid NN → `user(id)` CASCADE, `accessToken`/`refreshToken`/`idToken`/`scope`/`password` text NULL, `accessTokenExpiresAt`/`refreshTokenExpiresAt` timestamp NULL, `createdAt`/`updatedAt` NN. Уникальных констрейнтов нет.
- **`verification`**: `id` uuid PK, `identifier` text NN, `value` text NN, `expiresAt` timestamp NN, `createdAt`/`updatedAt` timestamp **NULL** dflt `now()`.
- **`organization`** (= workspace, цель всех FK `workspace_id`): `id` uuid PK, `name` text NN, `slug` text NN UNIQUE, `logo` text, `createdAt` timestamp NN, `metadata` text, `deletedAt` timestamp NULL (soft-delete).
- **`member`**: `id` uuid PK, `organizationId` uuid NN → `organization(id)` CASCADE, `userId` uuid NN → `user(id)` CASCADE, `role` text NN dflt `'member'`, `createdAt` NN. **UNIQUE на `(organizationId, userId)` отсутствует.**
- **`invitation`**: `id` uuid PK, `organizationId` uuid NN → CASCADE, `email` text NN, `role` text NULL, `status` text NN dflt `'pending'`, `expiresAt` timestamp NN, `inviterId` uuid NN → `user(id)` CASCADE, `createdAt` timestamp NN dflt `now()` (добавлена в `0002`).

### 4.2 Доменные таблицы (22 из 23 — с RLS ENABLE + FORCE; исключение — `partition_maintenance_runs`, см. конец раздела)

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

**`partition_maintenance_runs`** (`0038`, **RLS НЕТ**) — платформенная операционная таблица, без `workspace_id` и без тенантных данных; single-row (`id integer PK dflt 1 CHECK (id = 1)`). Колонки: `last_run_at` timestamptz NN, `lookahead_months`/`buffer_alert_threshold_months`/`events_buffer_months`/`send_events_buffer_months`/`buffer_months_remaining` int NN, `events_default_count`/`send_events_default_count` bigint NN, `partitions_created` text[] NN dflt `'{}'`, `last_alert_sent_at` timestamptz NULL (пишет только `apps/api`-сторож, см. §7), `updated_at` timestamptz NN dflt `now()`. Пишет `runPartitionMaintenance` (`packages/db/src/partitions/maintenance-run.ts`) — воркер, ещё не подключённый к `apps/worker/src/server.ts` в этом плане (09-02). Читает `checkPartitionHealthAndAlert` (`apps/api/src/modules/ops/partition-watchdog.ts`) — тоже ещё не подключён к `apps/api/src/server.ts`. С 09-03: `packages/db/src/schema/partition-maintenance-runs.ts` — type-inference-only Drizzle-объявление той же формы, зарегистрировано в `packages/db/src/index.ts`'s import/spread/export-тройке рядом с остальными 22 модулями схемы. **09-REVIEW CR-01 (`0040`):** `id = 1` теперь INSERTится (`ON CONFLICT (id) DO NOTHING`) прямо этой миграцией — `last_run_at = TIMESTAMPTZ 'epoch'`, `buffer_months_remaining = 0`, остальные числовые NN-колонки `0`, `partitions_created = '{}'`. До `0040` строка появлялась только после первого успешного прогона воркера, из-за чего `claimAlertSlot` (единственный `UPDATE ... WHERE id = 1 ... RETURNING`) не матчил ни одной строки на свежей БД и алерт не мог уйти ровно в сценарии «воркер ни разу не запускался». Строку никто не удаляет — `recordMaintenanceRun`'s `ON CONFLICT (id) DO UPDATE` только перезаписывает её.

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
| `app.admin_scan` | **никем** — легаси, см. ниже | `campaign_scheduler_due_scan` на `campaigns` (`0018`) | `current_setting('app.admin_scan',true)='true' AND status='scheduled' AND scheduled_at <= now()` |
| `app.admin_scan` | **никем** — легаси, см. ниже | `flow_runs_due_scan` на `flow_runs` (`0027`) | **`current_setting('app.admin_scan', true) = 'true'` — и всё** |
| `app.admin_scan` | **никем** — легаси, см. ниже | `flows_segment_sweep_scan` на `flows` (`0032`) | **`current_setting('app.admin_scan', true) = 'true'` — и всё** |
| `app.admin_scan` | `ensure-partitions.ts` → `attachPartitionCheckFirst` (внутри своей транзакции, сразу после `BEGIN`) — **единственное оставшееся место в кодовой базе, ставящее эту GUC** | `partition_relocation_admin_scan` на `contacts` **и** на `sends` (`0039`) | **`current_setting('app.admin_scan', true) = 'true'` — и всё** |

⚠️ Первые три политики, вопреки собственным комментариям («mirror the 0018 precedent exactly»), **не содержали никакого предиката помимо проверки GUC** — Pitfall 3, закрыт для их функциональных преемников миграциями `0041`/`0042` (роль-скоупленные `campaigns_scan`/`flow_runs_scan`/`flows_scan` с восстановленными предикатами, см. ниже), но сами эти три легаси-политики остаются в каталоге как есть, `PUBLIC`, **никем не устанавливаемые с Phase 10**: `campaign-scheduler.worker.ts` (план 10-01), `flow-reconciliation.worker.ts` и `flow-segment-sweep.worker.ts` (план 10-03) больше не выполняют `set_config('app.admin_scan', ...)` — все три мигрировали на `withCrossWorkspaceScan`/`mega_crm_scan`. Политика `partition_relocation_admin_scan` на `contacts`/`sends` (`0039`) — единственная из четырёх, чей GUC до сих пор реально ставится (`attachPartitionCheckFirst`), и **не содержит предиката помимо проверки GUC** и по сей день: снятие GUC-паттерна целиком, включая перевод `attachPartitionCheckFirst` на роль-based доступ, — работа плана 10-06.

**Phase 10 (SEC-01/SEC-02/SEC-05, миграция `0041`) — две новые кластерные login-роли, созданные вне миграционной цепочки.** `mega_crm_scan` и `mega_crm_auth`: `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOBYPASSRLS`, владеют нулём таблиц, без `ALTER DATABASE ... OWNER` и без `GRANT ALL PRIVILEGES ON DATABASE`. Создаются **не** пронумерованной миграцией — `mega_crm_app`, под которой применяются миграции, сама `NOCREATEROLE`. Источники создания: `docker/init-app-role.sql` (новые volume — тот же `DO $$ IF NOT EXISTS ... CREATE ROLE $$`-блок, что и у `mega_crm_app`) и `scripts/ensure-db-roles.mjs` (`npm run db:roles`, идемпотентно, для уже существующих volume — новый скрипт, зарегистрирован в корневом `predev` перед `migrate-dev.mjs`, а также вызывается тестовым провижинингом `packages/test-support/src/provision-db.ts`'s `ensureClusterRoles`, вшитой в `createEphemeralDatabase`). `mega_crm_auth` на данный момент **создана, но не имеет ни одного гранта** — grant-матрица для Better Auth-таблиц (SEC-05, D-04) добавляется отдельным планом фазы 10.

Миграция `0041_scan_role_bootstrap.sql` — первая GRANT/POLICY-миграция для `mega_crm_scan`: `GRANT USAGE ON SCHEMA public TO mega_crm_scan`, `GRANT SELECT ON campaigns TO mega_crm_scan`, новая роль-скоупленная политика `campaigns_scan ON campaigns FOR SELECT TO mega_crm_scan USING (status = 'scheduled' AND scheduled_at <= now())` (предикат унаследован буквально от `0018`'s `campaign_scheduler_due_scan`, Pitfall 3 — role-scoping не заменяет предикатное сужение), и `ALTER POLICY workspace_isolation ON campaigns TO mega_crm_app` (только `TO`-скоуп; сам предикат политики остаётся ровно таким, каким его оставила `0019` — bare-cast-унификация всех 22 таблиц в fail-closed направлении — отдельный, изолированный план SEC-03). Это первая политика в кодовой базе, явно скоупленная не на `PUBLIC` — без неё запрос под `mega_crm_scan` вычислял бы предикат `workspace_isolation` тоже (обе permissive-политики объединяются через OR), что воспроизвело бы баг миграции `0019` на слой выше. `campaign_scheduler_due_scan` (`0018`) миграцией `0041` **не удалена** — остаётся в каталоге, но инертна для `mega_crm_scan` (её GUC-предикат читает `app.admin_scan`, который эта роль никогда не устанавливает); удаление GUC-паттерна целиком — работа отдельного плана этой же фазы.

Доказательство P3 («API-процесс не держит ни credentials, ни membership `mega_crm_scan`») — структурное, не только по факту сегодняшнего окружения: `pg_has_role('mega_crm_app', 'mega_crm_scan', 'MEMBER')` = false (catalog-тест), `apps/api/src/env.ts` не содержит `SCAN_DATABASE_URL`, ни один файл `apps/api/src` (кроме `__tests__`) не импортирует `withCrossWorkspaceScan` (оба — тесты на исходник, `apps/api/src/__tests__/env-schema.test.ts`).

**Миграция `0042_scan_role_grants_and_policies.sql` (Phase 10, план 10-03, SEC-01/SEC-02)** — расширяет роль `mega_crm_scan` с одной таблицы тракер-среза (`campaigns`, `0041`) на все таблицы, которые фактически читают три оставшихся consumer-воркера этой фазы: `GRANT SELECT ON flow_runs, flows, contacts, sends, organization TO mega_crm_scan` — только `SELECT`, ни `INSERT`/`UPDATE`/`DELETE`, ни `USAGE` на последовательностях. Четыре новые роль-скоупленные политики:

| Политика | Таблица | `USING`-предикат |
|---|---|---|
| `flow_runs_scan` | `flow_runs` | `status = 'waiting' AND next_wake_at <= now()` |
| `flows_scan` | `flows` | `status = 'live' AND trigger_type = 'segment' AND trigger_segment_id IS NOT NULL AND live_version_id IS NOT NULL` |
| `contacts_scan` | `contacts` | `true` — **безусловная видимость строк** |
| `sends_scan` | `sends` | `true` — **безусловная видимость строк** |

`flow_runs_scan`/`flows_scan` буквально восстанавливают сужающий предикат, который `0027`'s `flow_runs_due_scan` и `0032`'s `flows_segment_sweep_scan` **никогда не реализовывали** (обе несли только проверку GUC, без единого дополнительного условия) — Pitfall 3: role-scoping и предикатное сужение дополняют друг друга, а не заменяют. `contacts_scan`/`sends_scan` — сознательно **безусловные** SELECT-политики, не оплошность: перенос строк из DEFAULT-партиции (0039's `partition_relocation_admin_scan`, план 10-06) не может заранее знать, какие строки `contacts` затронет ревалидация FK у конкретного бэклога, а межтенантное разрешение sibling-воркспейсов вебхука (план 10-08) не может заранее знать, какой `send_id` назовёт входящее событие — в обоих случаях сужающего `WHERE` не существует. Оба читателя выбирают только `id`/`workspace_id`; это ограничение колонок — прикладной код, не политика (у RLS нет колоночной гранулярности), закреплено тестом плана 10-08. Принято как ограниченный риск (T-10-03-02, disposition: accept) — только `SELECT`-грант, ровно два известных читателя.

`organization` не несёт RLS вообще (см. выше — таблица better-auth-семейства), поэтому для неё выпущен только `GRANT SELECT`, без политики: единственный читатель — `analytics-reconciliation.worker.ts`'s перечисление воркспейсов (§5.7).

Четыре существующие `workspace_isolation`-политики (на `flow_runs`, `flows`, `contacts`, `sends`) дополнительно получили `ALTER POLICY workspace_isolation ON <table> TO mega_crm_app` — только `TO`-скоуп, без изменения предиката (тот же паттерн, что `0041` уже применила к `campaigns`) — иначе запрос под `mega_crm_scan` дополнительно вычислял бы (или падал на) предикат `workspace_isolation` через OR permissive-политик, повторяя баг `0019` слоем выше.

**Легаси GUC-политики, оставленные нетронутыми `0042` (снятие — отдельный план 10-06):** `flow_runs_due_scan` (`0027`), `flows_segment_sweep_scan` (`0032`), `partition_relocation_admin_scan` на `contacts` и на `sends` (`0039`) — все четыре остаются в каталоге, `PUBLIC`, инертны для `mega_crm_scan` (их предикат читает `app.admin_scan`, который скан-пул никогда не ставит).

**09-04 (DB-03/DB-04):** `attachPartitionCheckFirst` теперь ставит `app.admin_scan='true'` перед `ATTACH PARTITION`. Причина: Postgres при attach непустого child-раздела автоматически ревалидирует унаследованные FK-констрейнты партиционированной таблицы против referenced-таблицы (`events.contact_id → contacts(id)`, `send_events.send_id → sends(id)`) — обе referenced-таблицы под `FORCE ROW LEVEL SECURITY`, и без этой политики ревалидация видит ноль строк `contacts`/`sends` (ни одно значение `app.current_workspace_id` не покрывает бэклог из нескольких тенантов разом), attach падает с ложным нарушением FK. Обнаружено в 09-04 task 1 — 09-01 никогда не attach'ил непустой child (только новые пустые месяцы), поэтому проблема не проявлялась раньше. **Сознательно НЕ добавлен NULLIF-guard на существующую `workspace_isolation` `contacts`/`sends`** (в отличие от компаньон-фикса `0019` для `campaigns`) — `contacts` зафиксирован как pre-Phase-10 bare-cast baseline в `packages/tenant-context/src/__tests__/tenant-context.test.ts`; конвертация всех 12 fail-closed таблиц — предмет отдельного скоординированного решения Phase 10 / SEC-03, не побочный эффект этой фичи. Вместо этого инвариант "соединение, на котором вызывается `attachPartitionCheckFirst`, никогда не было tenant-scoped" обеспечивается на уровне пула-вызывающего (отдельный `Pool`, никогда не шарится с `@mega-crm/tenant-context`) — тот же паттерн "два пула", что и в 08-09/`migrate-incremental.test.ts` (см. выше).

### 4.4 Партиционирование

| Таблица | Стратегия | Ключ | Партиции | Создано в |
|---|---|---|---|---|
| `events` | RANGE | `occurred_at` | `events_2026_07`…`events_2026_08` (`0007`), `events_2026_09`…`events_2027_06` (`0038`, 10 месяцев подряд, границы — явные UTC-timestamptz), `events_default` (DEFAULT) | `0007`/`0010`/`0038` |
| `send_events` | RANGE | `occurred_at` | `send_events_2026_07`…`send_events_2026_08` (`0020`), `send_events_2026_09`…`send_events_2027_06` (`0038`), `send_events_default` (DEFAULT) | `0020`/`0038` |

**09-01 (DB-01/DB-02):** дедлайн 2026-09-01 закрыт миграцией `0038` (файл `packages/db/migrations/0038_partition_catchup_and_maintenance_runs.sql`; catch-up-партиции по июнь 2027 включительно) независимо от того, запускался ли когда-либо воркер. Код, создающий партиции programmatically, теперь есть: `ensurePartitions`/`attachPartitionCheckFirst`/`computeBufferMonths` (`packages/db/src/partitions/ensure-partitions.ts`) — идемпотентная функция, единственный источник партиционного DDL, CHECK-constraint-first на каждом attach (`NOT VALID` → `VALIDATE CONSTRAINT` → `ATTACH PARTITION` → `DROP CONSTRAINT`, одна транзакция на месяц). Константы: `LOOKAHEAD_MONTHS=3`, `BUFFER_ALERT_THRESHOLD_MONTHS=2`, `PARTITION_MAINTENANCE_CRON="0 3 * * *"`. **В этом плане (09-01) функция ещё не вызывается ни из какого репитабл-джоба** — регистрация BullMQ-воркера (`partition-maintenance.worker.ts`, вызов из `apps/worker/src/server.ts`) и вызов из `packages/test-support`'s db-fixture — оба заявлены как работа плана 09-02 и последующих; на момент 09-01 `ensurePartitions` вызывается только из `runPartitionMaintenance` (`maintenance-run.ts`) и из тестов.

**09-REVIEW WR-01:** миграция `0038`'s 20 `CREATE TABLE ... PARTITION OF` — обычный DDL, не CHECK-constraint-first (CONVENTIONS.md прямо называет `0038` единственным санкционированным исключением из «эта последовательность существует ровно в одной функции» — поэтому дублировать её в самой миграции нельзя). Это безопасно только пока `events_default`/`send_events_default` пусты, то есть строго до 2026-09-01. Миграция теперь начинается с `DO $$ ... IF now() >= TIMESTAMPTZ '2026-09-01 00:00:00+00' THEN RAISE EXCEPTION ... END IF; END $$;` — если её применят на/после этой даты, она падает громко и сразу, вместо того чтобы молча повторить двадцать раз ACCESS EXCLUSIVE-скан DEFAULT. Тест `packages/db/src/__tests__/migration-0038-deadline-guard.test.ts` выполняет ровно этот блок, извлечённый из файла миграции (не переписанный), против живого Postgres — с реальной датой (не триггерится) и с подменённым на прошлое cutoff-литералом (триггерится).

**Здоровье автоматизации:** `partition_maintenance_runs` (см. 4.2) — платформенная singleton-таблица; `runPartitionMaintenance` пишет туда снапшот на каждый прогон. `apps/api/src/modules/ops/partition-watchdog.ts` — отдельный от воркера процесс-сторож (`evaluatePartitionHealth`/`checkPartitionHealthAndAlert`/`claimAlertSlot`), читает эту таблицу; unhealthy при отсутствующей/устаревшей (>26ч) строке, буфере <2 месяцев или непустой DEFAULT-партиции. Алерт — plain-text письмо через `PLATFORM_SENDGRID_API_KEY` (см. 7), не чаще одного раза в 20 часов на реплику (`claimAlertSlot`, атомарный `UPDATE ... RETURNING`). **Ни воркер, ни сторож ещё не подключены к своим процессам в этом плане** — `startPartitionWatchdog` не вызывается из `apps/api/src/server.ts`.

**09-04 (DB-03/DB-04):** `packages/db/src/partitions/relocate-default.ts` — оператор-вызываемая процедура переноса строк из `events_default`/`send_events_default` в корректно присоединённую месячную партицию. Экспортирует `relocateAllDefaultRows` (единственная точка входа, использует и CLI-скрипт, и criterion-3-тест), `relocateMonth`, `discoverDefaultMonths` (месяцы находятся запросом `date_trunc('month', ... AT TIME ZONE 'UTC')`, а не фиксированным окном — покрывает произвольно далёкие provider-таймстемпы), `countDefaultRowsForTable`, константу `RELOCATE_BATCH_SIZE=500`. Батч — одна транзакция, один SQL-стейтмент (`DELETE ... RETURNING` в CTE → `INSERT INTO <freestanding child> SELECT`), `FOR UPDATE SKIP LOCKED`; после исчерпания месяца — `attachPartitionCheckFirst` (переиспользуется без дублирования). Модуль ничего не запускает при импорте (нет scheduler/worker/interval) — перенос запускается только оператором. Не вызывается ни из какого воркера/lifecycle-скрипта/CI в этом плане.

**09-REVIEW WR-02:** `relocateAllDefaultRows` теперь берёт session-scoped advisory lock (`pg_try_advisory_lock`, неблокирующий, константа `RELOCATE_ADVISORY_LOCK_KEY = 8_472_995` — отдельная от `packages/test-support`'s `MIGRATION_ADVISORY_LOCK_KEY = 8_472_991`) на выделенном соединении на всё время вызова, снимает его явным `pg_advisory_unlock` перед `release()` в `finally` (просто `release()` без явного unlock оставил бы лок висеть на переиспользуемом физическом соединении пула). До этого фикса `CREATE TABLE IF NOT EXISTS` в `relocateMonth` был единственной (неатомарной) защитой от гонки двух параллельных запусков. Второй конкурентный вызов теперь падает сразу с понятным сообщением вместо возможной duplicate-relation-ошибки от гонки DDL.

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
- Журнал: `migrations/meta/_journal.json`, version 7, 43 записи (0–42, `0040` добавлена 09-REVIEW CR-01 — сид singleton-строки `partition_maintenance_runs`; `0041`/`0042` — Phase 10, план 10-01/10-03, scan-role бутстрап и расширение грантов/политик). Snapshot'ы есть только у **11** миграций (`0000`, `0002`, `0003`, `0005`, `0008`, `0011`, `0016`, `0017`, `0024`, `0025`, `0034`); у остальных **32** (включая `0038`, `0039`, `0040`, `0041`, `0042`) — нет.

---

## 5. Планировщик и пайплайн отправки

### 5.1 Чем запускается воркер

**Ни системный cron, ни голый `setTimeout`.** Тики воркера — **BullMQ repeatable jobs**, регистрируемые в самом процессе воркера, в двух формах. Четыре преэкзистирующих тика используют форму `repeat: { every: ... }` (интервал, отсчитываемый от boot-момента регистрации, не от фиксированного часа):

| Файл | Очередь-тик | Интервал | jobId |
|---|---|---|---|
| `campaign-scheduler.worker.ts:106` | `campaign-scheduler` | `SCAN_INTERVAL_MS = 60_000` (60 с) | `scan-due-campaigns` |
| `flows/flow-reconciliation.worker.ts:105` | `FLOW_RECONCILIATION_QUEUE` (`flow-reconciliation`) | `RECONCILIATION_INTERVAL_MS = 60_000` | `scan-due-flow-runs` |
| `analytics-reconciliation.worker.ts:117` | `analytics-reconcile` | `RECONCILE_INTERVAL_MS = 3 * 60_000` (3 мин) | `reconcile-rollups` |
| `flows/flow-segment-sweep.worker.ts:183` | `FLOW_SEGMENT_SWEEP_QUEUE` (`flow-segment-sweep`) | `SWEEP_INTERVAL_MS = 15 * 60_000` (15 мин) | `scan-segment-triggered-flows` |

**09-02 (DB-01/DB-02):** `partition-maintenance.worker.ts` добавляет **вторую, до этого не использовавшуюся в кодовой базе форму** — BullMQ's job-scheduler API (`queue.upsertJobScheduler`), а не `repeat: { every }`. Это первый и единственный тик, зарегистрированный так; см. §5.3 ниже и `CONVENTIONS.md`'s соответствующее binding-правило. `apps/api/src/modules/ops/partition-watchdog.ts` отдельно использует голый `setInterval` (см. §6.11) — это не BullMQ-тик воркера, а таймер **внутри процесса `apps/api`**, опрашивающий Postgres, а не Redis-очередь.

Регистрация repeatable-джобов идемпотентна в обеих формах: BullMQ дедуплицирует repeatable job по repeat-конфигу + `jobId` (интервальная форма) либо по стабильному id (`upsertJobScheduler`, форма планировщика) — повторный boot воркера не плодит конкурирующие расписания ни в одном случае. Состояние расписаний живёт **в Redis** — потеря Redis теряет и их (перерегистрируются при следующем старте процесса).

Точка входа процесса: `apps/worker/src/server.ts` → `buildWorker()`. Запускается через `main()` только при прямом запуске (`import.meta.url === file://${process.argv[1]}`). `dev`: `tsx watch --env-file=../../.env src/server.ts`; `start`: `node dist/server.js`. Graceful shutdown на `SIGINT`/`SIGTERM` → `worker.close()` для всех + `connection.disconnect()`.

### 5.2 Зарегистрированные воркеры (14)

`events-ingest`, `imports-csv`, `email-broadcast`, `email-triggered`, `campaign-kickoff`, `campaign-scheduler`, `webhook-events`, `analytics-reconciliation`, `flow-run-advance`, `flow-reconciliation`, `flow-trigger-evaluator`, `flow-segment-sweep`, `flow-enroll-existing`, `partition-maintenance` (09-02, четырнадцатый в композиционном корне `buildWorker()`).

Каждый Worker получает **свои** `RedisOptions` из `buildRedisConnectionOptions(REDIS_URL)`, а не общий инстанс `Redis` (BullMQ бандлит собственную копию ioredis другой версии — номинальный конфликт типов). `maxRetriesPerRequest: null` обязателен для BullMQ. Пароль/юзер Redis берутся из URL.

### 5.3 Очереди (имена — `packages/shared-schemas/src/queues.ts`)

`events-ingest`, `imports-csv`, `email-broadcast`, `email-triggered`, `campaign-kickoff`, `webhook-events`, `flow-trigger-evaluator`, `flow-run-advance`, `flow-reconciliation`, `flow-segment-sweep`, `flow-enroll-existing`. Плюс два тик-имени, объявленных локально в файлах воркеров: `campaign-scheduler`, `analytics-reconcile`. Плюс `partition-maintenance` (09-02, объявлена локально в `partition-maintenance.worker.ts` как `PARTITION_MAINTENANCE_QUEUE`) — **самопродюсируемая и самопотребляемая** очередь: единственный producer этой очереди — сам процесс `apps/worker`, тот же файл, что её и consume'ит; никакой роут или другой воркер в неё не пишет. Дефис вместо двоеточия — BullMQ запрещает `:` в имени очереди.

Разделение `email-broadcast` / `email-triggered` — два независимых Worker'а с разной concurrency, а **не** BullMQ `priority`: приоритет разрешает конкуренцию только внутри пула одной очереди.

- `email-broadcast`: `concurrency: 5` (ограниченный)
- `email-triggered`: `concurrency: 20` (always-on)

`defaultJobOptions` — `attempts: 5`, `backoff: { type: "exponential", delay: 2000 }`, `removeOnComplete: { age: 86400 }`, **`removeOnFail: false`** (проваленные джобы хранятся в Redis бессрочно) — этот блок **продублирован в 8 местах**: `apps/api/src/modules/campaigns/campaign-queues.ts:35`, `apps/api/src/modules/events/events-queue.ts:45`, `apps/api/src/modules/contacts/imports-csv-queue.ts:41-46`, `apps/api/src/modules/webhooks/enqueue.ts:43-48`, `apps/api/src/modules/flows/flow-queues.ts:30`, `apps/worker/src/queues/campaign-broadcast-producer.ts:11`, `apps/worker/src/queues/campaign-scheduler.worker.ts:9-14`, `apps/worker/src/queues/flows/flow-queues.ts:13`. Исключение — `FLOW_RUN_ADVANCE_JOB_OPTIONS` (`apps/worker/src/queues/flows/flow-queues.ts:29-34`): `removeOnComplete: true`, `removeOnFail: { age: 86400 }`.

**Durability-постура Redis под очередями (08-04).** Redis, на котором держится BullMQ, сконфигурирован через `docker/redis.conf` (см. §1.3) так, чтобы при достижении потолка памяти **отказывать в записи, а не вытеснять**: `maxmemory 512mb` + `maxmemory-policy noeviction`. Это прямо взаимодействует с `removeOnFail: false` выше — проваленные джобы копятся в Redis бессрочно, и при вытесняющей политике состояние джобов исчезало бы молча, без ошибки где-либо; под `noeviction` то же переполнение даёт явную ошибку записи. Обратная сторона: под потолком BullMQ может получить `OOM command not allowed` не только на `queue.add`, но и на внутренних Lua-скриптах смены статуса. Обработка этого состояния — **не** задача фазы 8, она отнесена к фазе 12; здесь зафиксирована только сама конфигурация.

`appendonly yes` + `appendfsync everysec` — то, что позволяет поставленным в очередь джобам пережить рестарт: `docker restart` шлёт SIGTERM, и Redis при штатном завершении делает финальный fsync. `everysec` вместо `always` — сознательный компромисс по пропускной способности с границей потери в одну секунду записей. Само выживание очереди через рестарт утверждается отдельно в 08-13.

### 5.4 Планировщик кампаний (`campaign-scheduler.worker.ts`)

Каждые 60 с:

1. **С Phase 10 (SEC-01/SEC-02, миграция `0041`):** `findDueCampaignCandidates()` идёт через `withCrossWorkspaceScan` (`packages/tenant-context/src/scan.ts`) — отдельный, лениво создаваемый пул, соединяющийся под ролью `mega_crm_scan` (worker-only `SCAN_DATABASE_URL`, §3.2, §4.3). Читает `SELECT id, workspace_id FROM campaigns WHERE status='scheduled' AND scheduled_at <= now()`; видимость строк даёт роль-scoped политика `campaigns_scan` (`0041`), не GUC. Прежний путь (`pool.connect()` напрямую + `SELECT set_config('app.admin_scan', 'true', true)`) удалён из этого файла; политика `campaign_scheduler_due_scan` (`0018`) в БД остаётся, но для `mega_crm_scan` инертна (её предикат читает GUC, который эта роль никогда не ставит) — снимается отдельным планом фазы 10 вместе с остальными GUC-точками. Без `FOR UPDATE` — сознательно: RLS требует наличия применимой UPDATE-политики для блокирующего SELECT, а `campaigns_scan` — SELECT-only.
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

`handlers/delay-node.ts` вычисляет `nextWakeAt`, пишет его в `flow_runs.next_wake_at` (durable source of truth) и ставит **BullMQ delayed job** через `enqueueFlowRunAdvance(payload, { delay })`. `jobId` уникален на каждое пробуждение (`${flowRunId}-${Date.now()}`) — иначе удержанный завершённый джоб с тем же id заглушил бы будущее пробуждение (задокументированный дефект CR-01). Идемпотентность обеспечивается не дедупом jobId, а перепроверками статуса/`next_wake_at` + `FOR UPDATE OF fr SKIP LOCKED` в консьюмере.

Repeatable-скан `flow-reconciliation` (60 с) — **backstop** на случай потери delayed job (крах воркера, потеря данных Redis). **С Phase 10 (SEC-01/SEC-02, план 10-03, миграция `0042`):** `findDueFlowRunCandidates()` идёт через `withCrossWorkspaceScan`, читает `SELECT id, workspace_id FROM flow_runs WHERE status='waiting' AND next_wake_at <= now()`; видимость даёт роль-scoped `flow_runs_scan` (`0042`), не GUC. `transitionAndNudge` — без изменений, `withTenant`/`withTenantTransaction`, `SELECT ... FOR UPDATE OF fr SKIP LOCKED`, перепроверяет ЕЩЁ И статус родительского `flow` (`f.status <> 'paused'`) в той же строке — `flow_runs_scan` покрывает только `flow_runs`, не `flows`, поэтому кандидат-лист может включать run приостановленного flow; именно per-tenant перепроверка это отсекает (D-18/D-19), не сама сканирующая политика.

Repeatable-скан `flow-segment-sweep` (15 мин, §5.1/§5.2) — периодический bulk-diff для сегмент-триггерных flow. **С Phase 10 (план 10-03, миграция `0042`):** `findLiveSegmentTriggeredFlows()` идёт через `withCrossWorkspaceScan`, читает `flows WHERE status='live' AND trigger_type='segment' AND trigger_segment_id IS NOT NULL AND live_version_id IS NOT NULL`; видимость даёт роль-scoped `flows_scan` (`0042`), не GUC. Дальнейший per-flow bulk-diff (`sweepOneFlow`) — без изменений, `withTenant`/`withTenantTransaction` на каждый flow отдельно.

### 5.7 Кросс-тенантные сканы вне RLS-скоупа

`analytics-reconciliation.worker.ts` перечисляет воркспейсы через `SELECT id FROM organization`. **С Phase 10 (план 10-03, миграция `0042`):** этот запрос теперь идёт через `withCrossWorkspaceScan` вместо прямого `pool.query` на тенантном пуле — тот же единый аудируемый вход в кросс-тенантное чтение, что и остальные четыре consumer'а этой фазы, независимо от того, что `organization` не несёт RLS вообще (§4.3) и формально не нуждается ни в какой политике: `mega_crm_scan` получает только `GRANT SELECT`, без сопровождающей политики. Дальше каждый воркспейс реконсилится в собственной `withTenant`-транзакции (без изменений).

### 5.8 Очередь `partition-maintenance` (09-02, DB-01/DB-02)

`apps/worker/src/queues/partition-maintenance.worker.ts` — платформенный (не tenant-scoped) тик, поддерживающий горизонт партиций `events`/`send_events` и здоровье автоматизации (§4.4).

- **Очередь:** `partition-maintenance` (`PARTITION_MAINTENANCE_QUEUE`) — самопродюсируемая/самопотребляемая (см. §5.3).
- **Регистрация:** BullMQ job-scheduler API, `queue.upsertJobScheduler(JOB_SCHEDULER_ID, { pattern, tz }, { name, opts })` — **первое использование этой формы в кодовой базе**, отдельно от четырёх `repeat: { every }`-тиков (§5.1). Стабильный id планировщика: `partition-maintenance-daily`. Cron-паттерн: `PARTITION_MAINTENANCE_CRON = "0 3 * * *"` (03:00 каждый день), таймзона — **явно `"UTC"`** (передаётся вторым полем опций планировщика, не полагается на таймзону хост-процесса).
- **`opts` (job options переданной джобы):** `attempts: 5`, `backoff: { type: "exponential", delay: 2000 }`, `removeOnComplete: { age: 86400 }`, `removeOnFail: false` — тот же блок, что и у остальных 8 мест в §5.3 (теперь **9 мест**, все с одинаковым буквальным содержимым, без общего фабричного модуля). `removeOnFail: false` здесь особенно нагружено смыслом: провал DDL-операции должен остаться инспектируемым в Redis, потому что Bull Board не установлен (см. §7) и никакой UI за очередями не следит — единственный громкий сигнал провала внутри самого воркера — это `console.log`/необработанный throw, наружу — только письмо оператору (ниже).
- **Boot-time immediate run:** при каждой конструкции воркера (не только по расписанию) в очередь добавляется одна дополнительная джоба с уникальным на каждый запуск `jobId` (`boot-<timestamp36>-<random>`), **не принадлежащая планировщику** — рестарт воркера чинит горизонт партиций за секунды, не дожидаясь ближайших 03:00 UTC.
- **09-REVIEW CR-04:** сама регистрация (`upsertJobScheduler` + `add` выше, плюс закрытие внутреннего `Queue`-хендла) — fire-and-forget async IIFE, ничем не awaited и не `.catch()`-нутый в проде (`buildWorker()` не вызывает `waitForPartitionMaintenanceRegistration` — это test-only хелпер). Теперь обёрнута в `try/catch/finally`: провал логируется через `console.error`, а не пробрасывается — до этого фикса необработанный `reject` внутри IIFE становился unhandled promise rejection и под Node's `--unhandled-rejections=throw` (дефолт) валил **весь** процесс `apps/worker` (все 14 воркеров), а не только эту джобу. `finally` также гарантирует `queue.close()` на любом исходе — раньше это был последний statement в цепочке и пропускался при более раннем throw, что утекало Redis-соединение внутреннего `Queue`.
- **Константы (`packages/db/src/partitions/ensure-partitions.ts`):** `LOOKAHEAD_MONTHS = 3` (на сколько месяцев вперёд от текущего момента поддерживается горизонт), `BUFFER_ALERT_THRESHOLD_MONTHS = 2` (порог, ниже которого сторож считает буфер нездоровым, см. §4.4/§7).
- **Что делает процессор на каждом прогоне** (`processPartitionMaintenance` → `runPartitionMaintenance`): (1) вызывает `ensurePartitions` — идемпотентно создаёт недостающие месячные партиции для обеих таблиц через CHECK-constraint-first attach; (2) считает буфер месяцев по каждой таблице (`computeBufferMonths`, до создания — см. §4.4); (3) считает число строк в обеих DEFAULT-партициях; (4) записывает один snapshot-ряд в `partition_maintenance_runs` (upsert по singleton PK). Никакого `try/catch` в файле — необработанный throw переводит BullMQ-джобу в failed-состояние осознанно (см. `removeOnFail: false` выше).
- **Клиент:** свой собственный, выделенный `Pool` (`partitionMaintenancePool`, `apps/worker/src/queues/partition-maintenance.worker.ts`) — **не** пул `@mega-crm/tenant-context`, использован напрямую, **не** через `withTenant`/`withTenantTransaction` — обслуживание партиций платформенное, не tenant-scoped, тем же паттерном, что и `analytics-reconciliation.worker.ts`'s `SELECT id FROM organization` (§5.7). **09-REVIEW CR-03:** до этого фикса дефолтом был пул `@mega-crm/tenant-context` — тот же пул, из которого `withTenantTransaction` берёт соединения для всех остальных тиков этого процесса; `attachPartitionCheckFirst`'s admin-scan-инвариант (§4.3/§4.4, миграция `0039`) требует, чтобы соединение здесь никогда не выполняло tenant-scoped `SET LOCAL app.current_workspace_id` — см. §3.6 (пул #3).

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

### 6.11 Фоновый процесс внутри `apps/api` (09-02, DB-02) — не HTTP-точка входа

Фаза 9 **не добавила ни одного HTTP-роута, Fastify-плагина, парсера тела, механизма аутентификации или rate limit**. Единственная новая публичная поверхность — не-HTTP: таймер, стартующий внутри самого процесса `apps/api`.

`apps/api/src/server.ts`'s `main()` вызывает `startPartitionWatchdog({ client: pool, operatorEmail: env.OPERATOR_ALERT_EMAIL, sendMail: sendOperatorAlert })` **после** `await app.listen(...)` резолвится — то есть таймер стартует, только когда сервер уже принимает соединения, а не во время построения приложения.

- **Реализация таймера:** голый `setInterval` внутри `apps/api/src/modules/ops/partition-watchdog.ts`'s `startPartitionWatchdog` — единственное место в кодовой базе, где `setInterval` используется как продовый механизм расписания (все остальные тики — BullMQ, §5).
- **Интервал опроса:** `WATCHDOG_INTERVAL_MS = 15 * 60_000` (15 мин).
- **Порог устаревания:** `STALE_THRESHOLD_HOURS = 26` — здоровая строка `partition_maintenance_runs` (§4.2/§4.4) не должна быть старше 26 часов (одна ежедневная джоба воркера плюс запас).
- **Почему именно в `main()`, а не в `buildServer()`:** каждый интеграционный тест `apps/api` вызывает `buildServer()`; таймер, зарегистрированный там, жил бы в каждом тестовом процессе, опрашивал бы тестовую БД на каденции `WATCHDOG_INTERVAL_MS` и мог бы достать реальный SendGrid-путь отправки из тестового прогона. `main()` выполняется только под `isDirectRun`-гардом — ровно та граница, которая нужна.
- **Что логируется при старте:** одна строка `pollIntervalMs`/`staleThresholdHours` — никогда адрес оператора и ничего производного от SendGrid-ключа (T-09-11).
- Подробнее о том, что делает сам сторож (health-условия, дедуп алерта, канал доставки): §4.4 и §7.

---

## 7. Наблюдаемость

- API: pino (`apps/api/src/logger.ts`) как `loggerInstance` Fastify. `pino-http` объявлен, но не подключён.
- Worker: **структурированного логирования нет** — только `console.log`/`console.error` в `server.ts` и `pool.on("error")` в `tenant-context`.
- **Bull Board / UI очередей отсутствует** (не объявлен ни в одном package.json). В комментарии `apps/worker/src/server.ts:20` он упомянут как «future wiring».
- Метрик и трейсинга нет. HTTP-healthcheck'а у приложения нет (см. 6.1). Контейнерные healthcheck'и в `docker-compose.yml` есть, но это проверки самой инфраструктуры, а не приложения: `pg_isready -U postgres` для `db` и `redis-cli ping` для `redis`.
- **09-01→09-02 (DB-01/DB-02): партиционный health-сигнал и его единственный push-канал.** `partition_maintenance_runs` (§4.2) хранит один snapshot-ряд, который каждый прогон `partition-maintenance`-воркера (§5.8) перезаписывает: `last_run_at`, буфер месяцев по каждой из двух таблиц + агрегированный минимум, оба счётчика строк в DEFAULT-партициях, список `partitions_created`, `last_alert_sent_at`. Сигнал **персистентен в Postgres и читаем чем угодно**, что умеет в неё запросить — отдельного API/дашборда над ним нет.
  Единственный push-канал — `apps/api/src/modules/ops/partition-watchdog.ts`: c 09-02 **подключён и активен** — `startPartitionWatchdog` вызывается из `apps/api/src/server.ts`'s `main()` (см. §6.11), адрес оператора читается из `env.OPERATOR_ALERT_EMAIL` (обязателен, boot-required, см. §3.2). Сторож — отдельный от воркера процесс, поэтому watchdog-внутри-того-же-процесса-который-он-проверяет не может сообщить, что процесс остановился; вместо этого он в своём процессе (`apps/api`) читает строку, которую пишет чужой процесс (`apps/worker`). Unhealthy-условия (§4.4): строка отсутствует, `last_run_at` старше `STALE_THRESHOLD_HOURS=26`, буфер < `BUFFER_ALERT_THRESHOLD_MONTHS=2` по любой из таблиц, либо любая DEFAULT-партиция непуста — все эти условия трактуются как unhealthy, никогда не по умолчанию healthy при отсутствующих данных. Алерт — plain-text письмо через `PLATFORM_SENDGRID_API_KEY`/`PLATFORM_MAIL_FROM` (§3.5), НЕ через `platform-mail`'s HTML-шаблоны — намеренно, чтобы аварийный канал не зависел от существования шаблона в платформенном SendGrid-аккаунте. Дедуп — `claimAlertSlot`, атомарный `UPDATE ... RETURNING` над `last_alert_sent_at`, не чаще одного письма на `ALERT_DEDUP_HOURS=20` окно, корректно под конкурентными репликами `apps/api`. Тело письма — только имена таблиц, число месяцев буфера по каждой, счётчики строк в DEFAULT-партициях, `last_run_at`; без workspace_id/contact_id/payload/ключей/connection string.
  **Честно об ограничении:** Bull Board не установлен (§8.1) — упавшая `partition-maintenance`-джоба остаётся инспектируемой в Redis (`removeOnFail: false`, §5.8), но никакой UI за очередями не следит. Настоящий алертинг/дашборды/агрегация ошибок — Phase 15.
- **Единственный регулярный сигнал о состоянии кода — CI** (`.github/workflows/ci.yml`, см. 1.3): четыре job'а — `static`, `test`, `failure-injection`, `e2e` — на каждый push и на каждый PR в `master`. Обязательных из них три: `static`, `test`, `failure-injection`; `e2e` сообщает, но не блокирует. Никакого мониторинга работающей системы это не заменяет: за пределами CI не наблюдается ничего.
- Отчёт покрытия (`json-summary`) пишется в `./coverage` и потребляется `coverage:gate` и `coverage:ratchet` внутри job'а `test`. Наружу — в дашборд, бэйдж или внешний сервис — он **не** публикуется, история значений нигде не хранится: единственная зафиксированная точка отсчёта — `coverage-baseline.json` в репозитории.
- Артефакты Playwright (`trace: retain-on-failure`) создаются в job'е `e2e`, но `actions/upload-artifact` не подключён — при падении трейс остаётся на раннере и пропадает вместе с ним.

---

## 8. Расхождения с разделом Technology Stack в `.claude/CLAUDE.md`

CLAUDE.md описывает **рекомендованный** стек по итогам ресёрча. Ниже — где код от него отличается. Это не список дефектов; это список мест, где нельзя опираться на CLAUDE.md как на описание системы.

### 8.1 Заявлено в CLAUDE.md, но в коде отсутствует

| Заявлено | Факт |
|---|---|
| **TypeScript 6.0.x** («TS 6 Corsa-based… no reason to pin lower») | Везде `^5.9.3`, установлено **5.9.3**. TS 6 не используется нигде |
| **PgBouncer** (или RDS Proxy) — «поставить до инцидента, а не после» | В репозитории отсутствует полностью. В `docker-compose.yml` только postgres и redis; в коде — два прямых `pg.Pool` |
| **`@bull-board/api` + `@bull-board/fastify` 8.1.x** — «нужен на этих объёмах» | **Не объявлен ни в одном package.json.** UI очередей нет. **09-05:** партиционный alert-дизайн (§5.8/§7) спроектирован специально так, чтобы **не полагаться** на Bull Board — единственный громкий сигнал провала `partition-maintenance`-джобы это plain-text письмо оператору, а не UI очереди, ровно потому что UI очереди в этом репозитории нет |
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

### 8.2b Операционная оговорка: первая миграция, зависящая от роли вне цепочки

`packages/db/migrations/0041_scan_role_bootstrap.sql` (Phase 10, SEC-01/SEC-02) — первая миграция за всю историю цепочки, чьи `GRANT`/`CREATE POLICY ... TO mega_crm_scan` падают, если роль `mega_crm_scan` ещё не существует на целевом кластере. Прежде миграционная цепочка была самодостаточна: применить её к пустой БД можно было, зная только суперюзерский DSN для `CREATE DATABASE` и `mega_crm_app` (созданную `docker/init-app-role.sql` при первой инициализации volume) — из БД. Начиная с `0041` разворачивание в НОВОЕ окружение (staging/prod, или локальный Postgres со старым volume) требует дополнительного шага **до** `db:migrate`: `npm run db:roles` (`scripts/ensure-db-roles.mjs`) либо эквивалентный ручной `CREATE ROLE` под суперюзером. Причина — `mega_crm_app`, под которой применяются все миграции, сама `NOCREATEROLE` (`docker/init-app-role.sql`), поэтому `CREATE ROLE` в пронумерованной миграции гарантированно упал бы. Зафиксировано в `user_setup` плана 10-01 и в `predev` (`scripts/ensure-db-roles.mjs` теперь идёт перед `scripts/migrate-dev.mjs`), но именно для **уже существующих** окружений это не автоматизировано вне `npm run dev`/явного вызова `npm run db:roles`.

`0042_scan_role_grants_and_policies.sql` (Phase 10, план 10-03) наследует то же самое условие (`GRANT SELECT ... TO mega_crm_scan` на пять таблиц) — не первый такой случай, но зависит от того же `npm run db:roles`/`docker/init-app-role.sql` предварительного шага; отдельного нового `user_setup`-шага эта миграция не добавляет, поскольку обе роли уже созданы в среде, где применена `0041`.

### 8.3 Совпадает с CLAUDE.md (для полноты)

`fastify` 5.9.0, `zod` 4.4.3, `drizzle-orm` 0.45.2 + `drizzle-kit` 0.31.10, `pg` 8.22.0, `bullmq` 5.79.1, `ioredis` 5.11.0, `rate-limiter-flexible` 11.2.0, `@xyflow/react` 12.11.2 (не `reactflow`), `@tanstack/react-query` 5.101.2, `@tanstack/react-table` 8.21.3, `react` 19.2.7, `vite` 8.1.3, `react-hook-form` 7.80.0, `recharts` 3.9.2, `csv-parse` 7.0.1, `pino` 10.3.1, `vitest` 4.1.9, `@playwright/test` 1.61.1, `@aws-sdk/client-kms` 3.1079.0, `@fastify/{cors,helmet,multipart,rate-limit,type-provider-zod}`, Node >=22, Postgres 17, Redis 7, Express не используется.

Также совпадают архитектурные предписания: две отдельные очереди вместо `priority`; per-tenant троттлинг через `rate-limiter-flexible`, а не BullMQ `limiter`; shared schema + `tenant_id` + RLS вместо schema-per-tenant; KMS envelope encryption вместо pgcrypto; верификация подписи вебхука до парсинга тела.

---

## 9. Сводка вопросов к ревью

Перечислено фактами, без оценки серьёзности.

1. `flow_runs_due_scan` (`0027`), `flows_segment_sweep_scan` (`0032`) и `partition_relocation_admin_scan` (`0039`, на `contacts` **и** `sends` — 09-04) — безусловные кросс-тенантные SELECT-гранты по одному GUC, без предиката, в отличие от прецедента `0018`, на который все три ссылаются в своих комментариях. `0039` — третий и самый широкий по площади (две дополнительные, самые тенант-чувствительные таблицы) экземпляр этого же паттерна.
2. 12 таблиц (включая `events` и `send_events`, а также `contacts` и `sends`, на которые `0039` навесил дополнительную admin-scan политику, но не тронул их собственную `workspace_isolation`) несут вариант политики с голым кастом, который `0019` чинил на `campaigns`. Безопасность держится на непроверяемом БД инварианте; для `attachPartitionCheckFirst`/`relocateAllDefaultRows` (09-04) этот инвариант обеспечен на уровне отдельного, никогда не tenant-scoped пула-вызывающего — см. §4.3's «Эмпирическое подтверждение» абзац и его 09-04-дополнение. Унификация всех 12 таблиц в fail-closed направлении — Phase 10 / SEC-03, не эта фаза.
3. `organization`, `session`, `account` — вне RLS. Там же `account.password` и `session.token`.
4. **09-01→09-05 закрыли этот пункт:** дедлайн 2026-09-01 закрыт миграцией `0038` (catch-up-партиции по июнь 2027 включительно, независимо от рантайм-поведения); программная поддержка горизонта — `ensurePartitions`, вызываемая ежедневным BullMQ-тиком (`partition-maintenance`, §5.8) плюс boot-time immediate run, плюс тем же путём, которым эфемерные тестовые БД получают партиции (09-03). Оператор-процедура `relocateAllDefaultRows` (09-04) переносит уже осевшие в DEFAULT строки в правильную месячную партицию, если автоматизация когда-либо отстанет. Оставшийся открытый вопрос — не «есть ли код», а живая проверка аварийного канала (см. SUMMARY этого плана, задача 3).
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
21. Блок `defaultJobOptions` продублирован в 9 файлах (09-02 добавил девятое место, `partition-maintenance.worker.ts`, с тем же буквальным содержимым), `buildRedisConnectionOptions` — в 4; `UNSUBSCRIBE_TOKEN_TTL_SECONDS` объявлена дважды. Правка в одном месте не распространяется на остальные.

---

## 10. Поддержание документа

При добавлении любой новой библиотеки или технологии — дописать её в соответствующий раздел этого файла (раздел 2 для зависимостей; 3 для секретов/конфигурации; 4 для схемы; 5 для очередей/планировщика; 6 для точек входа; 8 если возникает новое расхождение с CLAUDE.md). Правило закреплено в `.claude/CLAUDE.md`.

### Записи о верификации as-built разделов

- **2026-08-06 (09-05):** записи фазы 9 (partition automation & boundary safety) в разделах 2, 3, 4, 5, 6, 7 и 8 сверены с кодом: `packages/db/package.json` (буквенная версия `tsx`), `apps/api/src/env.ts` (`OPERATOR_ALERT_EMAIL`), `packages/db/migrations/0038_partition_catchup_and_maintenance_runs.sql` и `0039_partition_relocation_admin_scan.sql`, `apps/worker/src/queues/partition-maintenance.worker.ts`, `apps/api/src/modules/ops/partition-watchdog.ts`, `apps/api/src/server.ts`'s `main()`. Полный прогон `npm run lint`/`npm run lint:migrations`/`npm run build`/`npm test` — зелёный (11/11 воркспейсов); каталожный запрос против отдельно поднятой, полностью мигрированной эфемерной БД подтвердил 20 присоединённых месячных партиций (`events`×10 + `send_events`×10, 2026-09…2027-06, все `relispartition=true`). Живая проверка письма оператору — см. SUMMARY плана 09-05, задача 3 (не выполнена в этом прогоне: `OPERATOR_ALERT_EMAIL` не задан во внешнем env-файле этой машины).
