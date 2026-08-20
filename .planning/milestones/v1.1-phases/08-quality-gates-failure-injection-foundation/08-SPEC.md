# Phase 8: Quality Gates & Failure-Injection Foundation — Specification

**Created:** 2026-07-27
**Ambiguity score:** 0.12 (gate: ≤ 0.20)
**Requirements:** 12 locked

## Goal

Изменение в send-pipeline нельзя смёржить в `master`, пока GitHub Actions не подтвердил typecheck + lint + build + весь vitest-прогон против живых Postgres и Redis; тесты физически не могут подключиться к dev-БД; каждый из пяти названных аудитом режимов отказа воспроизводится одной командой с проверяемым исходом; Redis настроен на `noeviction` с явным `maxmemory` и AOF.

## Background

Фактическое состояние репозитория на 2026-07-27 (v1.0 отгружена, 96 планов, Phase 1-7):

- **CI отсутствует полностью** — каталога `.github/` нет. Все 96 планов v1.0 закоммичены напрямую в `master` (`git.branching_strategy: none`), PR-ов не было ни одного. Единственный агрегат — корневой `npm test`, который делегирует в workspaces через `--if-present`.
- **Lint отсутствует полностью** — ни `.eslintrc*`, ни `eslint.config.*` нигде в репозитории. ESLint не установлен.
- **Coverage не измеряется** — `@vitest/coverage-v8` / `coverage.thresholds` не встречаются ни в одном из 6 vitest-конфигов. Число неизвестно.
- **Тестовая изоляция частичная.** `apps/api/vitest.config.ts` и `apps/worker/vitest.config.ts` подставляют `DATABASE_URL: process.env.TEST_DATABASE_URL ?? ""`, но `src/test/db-fixture.ts` (три копии: api, worker, delivery-core) делает `TEST_DATABASE_URL ?? DATABASE_URL` — fallback на dev-БД остаётся в коде. `apps/web/playwright.config.ts` поднимает `npm run dev -w apps/api` и `npm run dev`, то есть **все 5 e2e-спеков гоняются по dev-БД** и сейчас пишут в неё.
- **Тесты миграций отсутствуют** — 38 SQL-миграций в `packages/db/migrations`. `db-fixture.ts` применяет их по одной под advisory-lock `8472991` в трекинг-таблицу `_test_migrations_applied`, но ни один тест не проверяет применимость цепочки с нуля или поверх наполненной схемы.
- **Failure-injection частичный.** DI-шов `ProcessSendJobDeps.sendMail` (`apps/worker/src/queues/send-dispatch.ts:50-57`) уже существует и уже используется двумя файлами — `send-dispatch-idempotency.test.ts` и `send-dispatch-durability.test.ts` (последний симулирует крэш между commit'ом claim и терминальной записью). Нет сценариев таймаута, 429, разрыва соединения, реального SIGKILL и рестарта Redis; нет единой команды запуска.
- **Redis сконфигурирован дефолтно.** `docker-compose.yml` поднимает `redis:7` без `command:`, без `maxmemory`, без `--appendonly`. Именованный том `mega_crm_redis_data` есть, но персистентность — дефолтный RDB-снапшот, а не AOF.
- **Гигиена корня нарушена.** `.env` и `dump.rdb` лежат в рабочем корне репозитория. `.env` читается минимум из 6 точек: `--env-file=../../.env` (api и worker `dev`-скрипты), `process.loadEnvFile` в трёх vitest-конфигах, `scripts/check-env.mjs`, `scripts/migrate-dev.mjs`.
- **Документация.** `SPECIFICATION.md` есть (as-built для security review, с обязывающим правилом обновления в `CLAUDE.md`). `ARCHITECTURE.md` и `CONVENTIONS.md` отсутствуют; разделы `## Conventions` и `## Architecture` в `.claude/CLAUDE.md` содержат заглушки «not yet established» / «not yet mapped».
- **Expand/contract нигде не зафиксирован.** Phase 11 добавит `'reconciling'` в enum `send_status`; Postgres не позволяет использовать только что добавленное значение enum в той же транзакции.

Тест-корпус: 91 vitest-файл, из которых большинство в `apps/api` и `apps/worker` требуют живого Postgres, часть — живого Redis. Node v26, npm 11, workspaces `apps/*` + `packages/*`.

## Requirements

1. **CI-гейт**: GitHub Actions прогоняет typecheck, lint, build и весь vitest-корпус против сервис-контейнеров Postgres и Redis на каждый push и pull request; branch protection на `master` делает эти проверки required.
   - Current: `.github/` не существует; CI нет; прямой push в `master` разрешён; PR-ов в истории проекта нет
   - Target: workflow `.github/workflows/ci.yml` с blocking-job'ом, поднимающим `postgres:17` и `redis:7` как services и выполняющим typecheck → lint → build → `vitest run` по всем workspace; на `master` включён branch protection с этими проверками как required status checks
   - Acceptance: PR с намеренно сломанным тестом, с type error и с lint-нарушением показывает `merge blocked` в UI GitHub; PR, где все три чисты, показывает `merge allowed`

2. **Lint-гейт с нулевым долгом**: ESLint flat config с typescript-eslint покрывает все workspace, все существующие нарушения исправлены, CI гоняет lint с `--max-warnings=0`.
   - Current: eslint-конфига и зависимости в репозитории нет; число нарушений неизвестно
   - Target: `eslint.config.js` в корне + скрипт `lint`; `npx eslint` завершается кодом 0 при `--max-warnings=0` по всей кодовой базе; правила уровня `warn` валят гейт наравне с `error`
   - Acceptance: `npm run lint` выходит с кодом 0 на чистом дереве и с кодом 1 после внесения одиночного нарушения любого включённого правила; число проверенных файлов, выведенное линтером, не ниже зафиксированного в репозитории минимума

3. **Coverage-гейт на backend-ядре**: покрытие измеряется по `apps/api`, `apps/worker` и `packages/*`; измеренный baseline записан в репозиторий; CI падает при падении ниже порога.
   - Current: coverage не собирается вообще; провайдер не установлен; baseline неизвестен
   - Target: единый агрегированный прогон coverage по backend-области (`apps/web` вне области), измеренное значение зафиксировано в репозитории как порог с намеренной надбавкой; сравнение идёт по неокруглённому `covered/total`, равенство порогу — проход
   - Acceptance: прогон с покрытием ровно на пороге завершается успехом; прогон с покрытием на любую долю ниже порога завершается кодом 1; workspace, чьи тесты не отработали, приводит к падению гейта, а не к молчаливому исключению из знаменателя

4. **Fail-closed guard тестовой БД**: любой тестовый прогон, чья resolved connection string указывает на dev-БД, аварийно останавливается до выполнения первого теста; эфемерная тестовая БД создаётся одним скриптом, идентичным локально и в CI.
   - Current: `db-fixture.ts` (три копии) делает `TEST_DATABASE_URL ?? DATABASE_URL` — при пустом `TEST_DATABASE_URL` тесты уходят в dev-БД; Playwright гоняется по dev-БД через `npm run dev`; скрипта провижининга нет
   - Target: единый guard, применяемый и к vitest, и к Playwright: (а) имя БД обязано начинаться с `mega_crm_test`; (б) нормализованная тройка host+port+database (с схлопыванием `localhost`/`127.0.0.1`/`::1` и игнорированием кред и query-параметров) не равна тройке из `DATABASE_URL`; невыполнение любого условия либо отсутствие/пустота DSN → hard error до старта тестов. Скрипт провижининга/удаления эфемерной БД один и тот же локально и в CI, без CI-only ветки
   - Acceptance: прогон с `TEST_DATABASE_URL`, равным `DATABASE_URL`, падает с ненулевым кодом до выполнения первого теста; то же для `postgres://u@127.0.0.1:5432/mega_crm?sslmode=disable` против dev-`postgres://u@localhost:5432/mega_crm`; то же при незаданном `TEST_DATABASE_URL`; то же при имени БД без префикса `mega_crm_test`

5. **Тесты миграций**: два автоматических прогона — вся цепочка на пустую БД и остаток цепочки поверх ранее промигрированной БД с засеянными строками.
   - Current: тестов миграций нет; 38 миграций применяются только `db-fixture.ts` внутри обычных тестов
   - Target: прогон A применяет все 38+ миграций к пустой БД; прогон B мигрирует до контрольной точки предыдущего релиза, засевает представительные строки в затрагиваемые таблицы и применяет оставшиеся миграции; оба входят в блокирующий CI-job
   - Acceptance: оба прогона завершаются кодом 0 на текущем `master`; прогон B падает, если применилось менее одной миграции (защита от вакуумного зелёного); прогон B падает на миграции, добавляющей `NOT NULL` без `DEFAULT` к непустой таблице

6. **Failure-injection harness**: пять режимов отказа воспроизводятся по одной команде каждый, с проверяемым исходом.
   - Current: DI-шов `ProcessSendJobDeps.sendMail` существует и используется в `send-dispatch-idempotency.test.ts` / `send-dispatch-durability.test.ts`; сценариев таймаута, 429, разрыва соединения, реального SIGKILL и рестарта Redis нет; единой точки запуска нет
   - Target: harness поверх существующего шва (новый шов не вводится) со сценариями: (1) таймаут SendGrid, (2) ответ 429, (3) разрыв соединения, (4) SIGKILL реального worker-процесса mid-dispatch, (5) рестарт Redis-контейнера mid-queue; каждый запускается отдельной командой и утверждает исход состояния БД/очереди, а не наличие строки в логе
   - Acceptance: пять команд запускаются по отдельности и завершаются кодом 0; сценарий (4) убивает процесс именно в окне после commit'а claim и до терминальной записи, и утверждает, что после перезапуска письмо не отправляется повторно; сценарий (5) утверждает, что задания, поставленные до рестарта, обработаны после него

7. **Конфигурация Redis**: версионируемый `redis.conf` задаёт явный `maxmemory`, `maxmemory-policy noeviction` и `appendonly yes`; автотест читает `CONFIG GET` у живого Redis; задания переживают рестарт контейнера.
   - Current: `redis:7` в `docker-compose.yml` без `command:`, без `maxmemory` (значение `0` = без лимита), без AOF; при дефолтном `maxmemory=0` политика `noeviction` не может сработать вовсе
   - Target: файл `docker/redis.conf` под версионным контролем, смонтированный в контейнер; автотест утверждает `maxmemory > 0`, `maxmemory-policy = noeviction`, `appendonly = yes`
   - Acceptance: тест падает против Redis, поднятого с дефолтным конфигом (доказательство fail-first), и проходит против Redis, поднятого с `docker/redis.conf`; отдельная проверка утверждает, что задания, поставленные до `docker restart` контейнера Redis, присутствуют в очереди после него

8. **Дисциплина expand/contract**: правило записано в `CONVENTIONS.md` и подкреплено машинной проверкой в CI.
   - Current: правило нигде не зафиксировано; `CONVENTIONS.md` не существует; линтера миграций нет
   - Target: обязывающая формулировка «миграция N → подтверждение применения → деплой N+1» в `CONVENTIONS.md` плюс CI-шаг, падающий, когда один SQL-файл одновременно содержит `ALTER TYPE ... ADD VALUE` и использование добавленного значения, либо содержит разрушительный DDL (`DROP COLUMN`, `NOT NULL` без `DEFAULT`) без явного маркера
   - Acceptance: линтер падает на заведомо плохом фикстурном SQL-файле обоих видов (доказательство fail-first) и проходит на всех 38 существующих миграциях

9. **Гигиена рабочего корня**: `.env` и `dump.rdb` вынесены за пределы рабочего корня, все точки загрузки конфига переведены на новое расположение, CI падает при их повторном появлении.
   - Current: `.env` и `dump.rdb` лежат в корне репозитория; `.env` читается минимум из 6 точек (`--env-file=../../.env` ×2, `process.loadEnvFile` ×3, `check-env.mjs`, `migrate-dev.mjs`)
   - Target: расположение `.env` задаётся одной переменной/константой; все точки загрузки переведены на неё; снапшот Redis живёт только в docker-томе; CI-шаг проверяет рабочий корень по чёрному списку секретных и служебных файлов
   - Acceptance: `npm run dev` и `npm test` работают при отсутствии `.env` в рабочем корне; CI-проверка падает на дереве, где `.env` или `*.rdb` возвращены в корень (доказательство fail-first), и проходит на чистом дереве

10. **ARCHITECTURE.md**: описывает границы модулей, потоки данных и причины ключевых архитектурных решений, не дублируя as-built-факты из `SPECIFICATION.md`.
    - Current: файла нет; раздел `## Architecture` в `.claude/CLAUDE.md` — заглушка «not yet mapped»
    - Target: `ARCHITECTURE.md` в корне с разграничением ролей: `SPECIFICATION.md` = что есть, `ARCHITECTURE.md` = почему так; покрывает границы `apps/*` ↔ `packages/*`, путь события до отправки, две очереди BullMQ, модель multi-tenancy и RLS, envelope-шифрование ключей
    - Acceptance: файл существует; каждый из перечисленных пяти блоков присутствует; ни один факт (версия пакета, имя таблицы, имя переменной окружения) не дублирован из `SPECIFICATION.md` без ссылки на него

11. **CONVENTIONS.md**: фиксирует кодовые и архитектурные соглашения, фактически применяемые в репозитории.
    - Current: файла нет; раздел `## Conventions` в `.claude/CLAUDE.md` — заглушка «not yet established»
    - Target: `CONVENTIONS.md` в корне: именование, структура модулей, паттерны тестов (расположение `__tests__`, конвенция `TEST_DATABASE_URL`/`TEST_REDIS_URL`, `db-fixture`), правило expand/contract из требования 8
    - Acceptance: файл существует; правило expand/contract присутствует дословно как обязывающее; каждое записанное соглашение подтверждается минимум одним существующим файлом репозитория

12. **Правило обновления документации в CLAUDE.md**: `SPECIFICATION.md`, `ARCHITECTURE.md` и `CONVENTIONS.md` обязаны обновляться в том же изменении, что меняет описываемые ими решения.
    - Current: такое правило есть только для `SPECIFICATION.md`; для двух новых файлов правила нет
    - Target: раздел в `.claude/CLAUDE.md` распространяет обязывающее правило на все три документа и называет конкретные триггеры для каждого (для `ARCHITECTURE.md` — изменение границ модулей/потоков данных/очередей; для `CONVENTIONS.md` — изменение соглашений именования, структуры или правил миграций)
    - Acceptance: раздел присутствует; для каждого из трёх документов явно перечислены триггеры; формулировка обязывающая («дописать в том же изменении»), а не рекомендательная

## Boundaries

**In scope:**
- GitHub Actions workflow с блокирующим job'ом (typecheck, lint, build, весь vitest против services Postgres + Redis) и branch protection на `master`
- Отдельный **неблокирующий** CI-job для Playwright E2E, утверждающий фактически использованную connection string
- ESLint flat config + исправление всех существующих нарушений до нуля
- Coverage-провайдер, измеренный baseline и порог по области `apps/api` + `apps/worker` + `packages/*`
- Единый fail-closed guard тестовой БД (vitest + Playwright) и один скрипт провижининга эфемерной БД для локального и CI-прогона
- Два теста миграций (с нуля и инкрементально с данными)
- Failure-injection harness на 5 сценариев поверх существующего шва `ProcessSendJobDeps.sendMail`
- `docker/redis.conf` + автотест `CONFIG GET` + проверка выживания очереди при рестарте Redis
- CI-линтер миграций для expand/contract
- Вынос `.env` и `dump.rdb` из рабочего корня + CI-проверка чёрного списка
- `ARCHITECTURE.md`, `CONVENTIONS.md`, обязывающее правило обновления в `.claude/CLAUDE.md`

**Out of scope:**
- Playwright E2E в блокирующих required checks — браузерный прогон флакает и заблокировал бы мёрж ложно; гарантия QG-04 всё равно проверяется машинно в неблокирующем job'е
- Новые e2e-сценарии, расширение покрытия сверх достижения порога — фаза строит гейты, а не догоняет покрытие
- Введение самого шва инъекции в `send-dispatch.ts` — шов существует с Phase 4, фаза добавляет сценарии
- Изменение семантики машины состояний доставки, добавление `'reconciling'` в `send_status` — Phase 11; здесь фиксируется только правило expand/contract
- Per-tenant concurrency-cap, retention очередей, worker-reliability правки — Phase 12
- Автоматизация партиций `events`/`send_events` — Phase 9 (жёсткий дедлайн 2026-09-01)
- Разделение ролей Postgres, RLS на Better Auth таблицах — Phase 10
- PgBouncer, Docker-деплой, restore-репетиция, Sentry — Phases 14-15
- Перекройка `SPECIFICATION.md` под новые документы — as-built-точность нужна security review; новые файлы ссылаются на него, а не поглощают
- Прогон против реального SendGrid — Phase 16 (release barrier)

## Constraints

- **Blocking-гейт требует внешних сервисов.** Из 91 vitest-файла большинство в `apps/api`/`apps/worker` требует живого Postgres (`db-fixture` применяет 38 миграций под advisory-lock `8472991`), часть — живого Redis. CI-job обязан поднимать `postgres:17` и `redis:7` как services; прогон только unit-тестов гейтом не считается.
- **Порог coverage берётся от измеренного baseline плюс намеренная надбавка**, не от круглого числа (Pitfall 22). Процент покрытия не может подменять собой чеклист крэш/race-сценариев — сценарии из требования 6 отслеживаются отдельным чеклистом, отображённым на конкретные имена тестов.
- **Guard тестовой БД — жёсткий отказ, не graceful default** (Pitfall 21). Провижининг эфемерной БД идёт одним и тем же скриптом локально и в CI; CI-only ветки не допускается.
- **`maxmemory-policy noeviction` — дефолт Redis 7**, поэтому проверка только политики вакуумна: без явного `maxmemory > 0` политика не срабатывает никогда (Pitfall 20).
- **Failure-injection строится на существующем шве** `ProcessSendJobDeps.sendMail` (`apps/worker/src/queues/send-dispatch.ts:50-57`), уже используемом `send-dispatch-idempotency.test.ts` и `send-dispatch-durability.test.ts`.
- **`fileParallelism: false` в `apps/worker/vitest.config.ts`** установлено намеренно (06-12: реальный BullMQ Worker на глобальной очереди `flow-run-advance`). Ни CI-конфигурация, ни guard не должны его снимать.
- **`.env*` под hard-deny для инструментов исполнителя** — перенос `.env` планируется и документируется, но правки самого файла выполняет оператор вручную.
- **Дедлайн:** Phase 9 (DB-01/DB-02) зависит только от Phase 8 и обязана завершиться до **2026-09-01**. Объём Phase 8 не должен расти за счёт этого окна.

## Acceptance Criteria

- [ ] PR со сломанным тестом, с type error или с lint-нарушением показывает `merge blocked`; чистый PR показывает `merge allowed`
- [ ] Блокирующий CI-job поднимает Postgres и Redis как services и выполняет весь vitest-корпус, а не подмножество
- [ ] Playwright E2E существует как отдельный неблокирующий job и печатает фактически использованную connection string
- [ ] `npm run lint` → код 0 на чистом дереве, код 1 после внесения одиночного нарушения
- [ ] Число файлов, проверенных линтером, не ниже зафиксированного минимума (защита от конфига, проверяющего 0 файлов)
- [ ] Coverage ровно на пороге → PASS; на любую долю ниже → FAIL; сравнение по неокруглённому `covered/total`
- [ ] Workspace, чьи тесты не отработали, валит coverage-гейт, а не выпадает из знаменателя
- [ ] Тестовый прогон с `TEST_DATABASE_URL == DATABASE_URL` падает до выполнения первого теста
- [ ] То же для `127.0.0.1` против `localhost` с иными query-параметрами (нормализованное сравнение host+port+database)
- [ ] То же при незаданном `TEST_DATABASE_URL` и при имени БД без префикса `mega_crm_test`
- [ ] Прогон миграций с нуля завершается кодом 0
- [ ] Инкрементальный прогон миграций с засеянными данными завершается кодом 0 и падает, если применилось менее одной миграции
- [ ] Пять команд failure-injection запускаются по отдельности и завершаются кодом 0
- [ ] Сценарий SIGKILL убивает процесс в окне после commit'а claim и до терминальной записи и утверждает отсутствие повторной отправки
- [ ] Сценарий рестарта Redis утверждает, что задания, поставленные до рестарта, обработаны после него
- [ ] Тест Redis утверждает все три значения (`maxmemory > 0`, `maxmemory-policy = noeviction`, `appendonly = yes`) и падает против дефолтного Redis
- [ ] Линтер миграций падает на заведомо плохом фикстурном SQL обоих видов и проходит на всех 38 существующих миграциях
- [ ] `npm run dev` и `npm test` работают при отсутствии `.env` в рабочем корне
- [ ] CI-проверка чёрного списка падает на дереве с возвращённым в корень `.env` или `*.rdb`
- [ ] `ARCHITECTURE.md` существует и покрывает пять названных блоков без дублирования фактов из `SPECIFICATION.md`
- [ ] `CONVENTIONS.md` существует и содержит правило expand/contract как обязывающее
- [ ] `.claude/CLAUDE.md` содержит обязывающее правило обновления для всех трёх документов с конкретными триггерами по каждому

**Негативные критерии (из § Prohibitions):**

- [ ] Записанный порог coverage не уменьшается: CI падает, если в диффе значение порога стало меньше предыдущего
- [ ] Ни один файл не содержит файлового `/* eslint-disable */` без имени правила и причины
- [ ] Ни один сценарий failure-injection не выполняет сетевой вызов к `api.sendgrid.com` и не отправляет реального письма
- [ ] В коде guard'а нет env-переменной или флага, отключающего проверку
- [ ] Скрипт провижининга ни при каких аргументах не выполняет `DROP`/`TRUNCATE` над БД, чьё имя не прошло test-проверку
- [ ] Недоступность Redis приводит к FAIL проверки WRK-12, а не к `skipped`
- [ ] `ARCHITECTURE.md`/`CONVENTIONS.md` не описывают нереализованное как действующее; расхождения помечены явно

## Edge Coverage

**Coverage:** 15/33 applicable edges resolved (12 covered · 3 backstop) · 18 dismissed · 0 unresolved

| Category | Requirement | Status | Resolution / Reason |
|----------|-------------|--------|---------------------|
| boundary | R2 | ✅ covered | `--max-warnings=0`: правило уровня `warn` валит гейт наравне с `error` — критерий «код 1 после одиночного нарушения любого включённого правила» |
| empty | R2 | ✅ covered | ESLint с неверными глобами проверяет 0 файлов и выходит кодом 0 → критерий «число проверенных файлов не ниже зафиксированного минимума» |
| boundary | R3 | ✅ covered | Равенство порогу = PASS, любая доля ниже = FAIL |
| precision | R3 | ✅ covered | Сравнение по неокруглённому `covered/total`: 84.996% при пороге 85 → FAIL, а не «85.0% → PASS» |
| concurrency | R3 | ✅ covered | Единый агрегированный прогон по backend-области; workspace без отработавших тестов валит гейт, а не выпадает из знаменателя |
| adjacency | R4 | ✅ covered | Нормализованное сравнение host+port+database (схлопывание `localhost`/`127.0.0.1`/`::1`, игнор кред и query) + обязательный префикс `mega_crm_test` — два независимых условия |
| empty | R4 | ✅ covered | Незаданный/пустой DSN → hard error (fail-closed), а не вакуумный проход |
| empty | R5 | ✅ covered | Инкрементальный прогон падает, если применилось < 1 миграции |
| concurrency | R6 | ✅ covered | SIGKILL инжектируется именно в окно после commit'а claim и до терминальной записи; произвольный момент убийства ничего не доказывает |
| unclassified | R7 | ✅ covered | `CONFIG GET maxmemory` = `0` означает «без лимита», а `noeviction` — дефолт Redis 7 → утверждаются все три значения + fail-first против дефолтного Redis |
| adjacency | R9 | ✅ covered | Проверка чёрного списка доказывается fail-first: падает на дереве с возвращённым `.env`/`*.rdb` |
| unclassified | R12 | ✅ covered | Правило обязано называть конкретные триггеры по каждому из трёх документов, иначе неприменимо |
| concurrency | R1 | 🧪 backstop | Два одновременных CI-прогона не должны делить одну эфемерную БД — held-out тест на уникальность имени БД в пределах прогона |
| concurrency | R4 | 🧪 backstop | `npm test --workspaces` может гнать api и worker параллельно по одной эфемерной БД: advisory-lock защищает миграции, но не данные — held-out тест на изоляцию или сериализацию |
| ordering | R5 | 🧪 backstop | `readdirSync().sort()` в `db-fixture.ts` даёт верный порядок только при zero-padded именах — held-out тест на миграцию без padding |
| adjacency, empty, ordering | R1 | ⛔ dismissed | Порядок job'ов задан DAG'ом workflow, а не контрактом на порядок вывода; docs-only PR — штатный проход, не edge |
| adjacency, ordering, precision | R2 | ⛔ dismissed | У линтера нет числового контракта и порядка вывода, влияющего на pass/fail; смежность правил не порождает граничного случая |
| encoding, ordering | R4 | ⛔ dismissed | Нормализация DSN (covered выше) уже задаёт, чьё определение равенства применяется; порядок неприменим — сравнение одиночное |
| adjacency | R5 | ⛔ dismissed | Смежность миграций покрыта инкрементальным прогоном; отдельного контракта «касаются/сливаются» нет |
| adjacency, empty, ordering | R6 | ⛔ dismissed | Пять сценариев независимы и запускаются по отдельности: нет ни коллекции на вход, ни порядка вывода |
| concurrency | R8 | ⛔ dismissed | Линтер миграций — чистая статическая проверка файлов, без разделяемого состояния; fail-first-доказательство вынесено в критерий приёмки |
| empty, ordering, concurrency | R9 | ⛔ dismissed | Проверка чёрного списка — статический обход рабочего корня без параллелизма и без контракта на порядок |
| unclassified | R10 | ⛔ dismissed | Прозаический документ: единственный содержательный must-NOT (не выдавать планируемое за текущее) поднят в § Prohibitions |
| unclassified | R11 | ⛔ dismissed | То же, что R10 |

## Prohibitions (must-NOT)

**Coverage:** 7/7 applicable prohibitions resolved · 0 unresolved

| Prohibition (must-NOT statement) | Requirement | Status | Verification / Reason |
|----------------------------------|-------------|--------|------------------------|
| MUST NOT понижать записанный порог coverage, чтобы сделать красный прогон зелёным | R3 | resolved | verification: test — CI падает, если в диффе значение порога меньше предыдущего. Дескриптор проверки не задан (авторится в plan-phase) |
| MUST NOT закрывать lint-гейт файловым `/* eslint-disable */` без имени правила и причины | R2 | resolved | verification: test (lint-rule) — правило запрещает blanket-disable. Дескриптор проверки не задан |
| MUST NOT выполнять сетевой вызов к `api.sendgrid.com` или отправлять реальное письмо из любого сценария failure-injection | R6 | resolved | verification: test — риск репутации домена тенанта. Дескриптор проверки не задан |
| MUST NOT предоставлять env-переменную или флаг, отключающий guard тестовой БД | R4 | resolved | verification: test — bypass сводит на нет всё требование. Дескриптор проверки не задан |
| MUST NOT выполнять `DROP`/`TRUNCATE` над БД, чьё имя не прошло test-проверку, ни при каких аргументах скрипта провижининга | R4 | resolved | verification: test — разрушительное действие над dev/prod-данными. Дескриптор проверки не задан |
| MUST NOT помечать проверку конфигурации Redis как `skipped` при недоступном Redis — это FAIL | R7 | resolved | verification: test — иначе WRK-12 выглядит выполненным на прогоне, где его никто не проверял. Дескриптор проверки не задан |
| MUST NOT описывать в `ARCHITECTURE.md`/`CONVENTIONS.md` планируемое как действующее | R10, R11 | resolved | verification: judgment — машинно не проверяется; расхождения должны быть помечены явно |

Дескрипторы wired-check (`check_kind` / `check_target` / `check_rule` / `check_violation_fixture` / `check_clean_fixture`) намеренно не заданы: соответствующие файлы проверок ещё не существуют, и назвать их путь сейчас означало бы выдумать его. Все шесть `test`-строк остаются fail-closed для `verify-phase` до тех пор, пока plan-phase не пропишет конкретные проверки.

## Ambiguity Report

| Dimension          | Score | Min  | Status | Notes                                                                 |
|--------------------|-------|------|--------|-----------------------------------------------------------------------|
| Goal Clarity       | 0.90  | 0.75 | ✓      | 12 требований, каждое с измеримым исходом                             |
| Boundary Clarity   | 0.88  | 0.70 | ✓      | Явный out-of-scope с отсылкой к Phases 9-16                           |
| Constraint Clarity | 0.85  | 0.65 | ✓      | Pitfalls 20/21/22 отражены; дедлайн Phase 9 учтён                     |
| Acceptance Criteria| 0.86  | 0.70 | ✓      | 22 позитивных + 7 негативных pass/fail критериев                      |
| **Ambiguity**      | 0.12  | ≤0.20| ✓      |                                                                       |

Status: ✓ = met minimum, ⚠ = below minimum (planner treats as assumption)

## Interview Log

| Round | Perspective     | Question summary                                      | Decision locked                                                                                          |
|-------|-----------------|-------------------------------------------------------|----------------------------------------------------------------------------------------------------------|
| 1     | Researcher      | Где стоит блокирующий гейт при `branching_strategy: none`? | GitHub Actions + branch protection на `master`; работа переходит на PR-модель                            |
| 1     | Researcher      | Какой набор failure-режимов обязателен?               | Все 5 из ROADMAP, включая реальный SIGKILL и рестарт Redis-контейнера                                    |
| 1     | Researcher      | Насколько широк запрет на подключение к dev-БД?       | Все тесты: Playwright + vitest-интеграция, единый guard                                                  |
| 2     | Researcher      | Что гоняет блокирующий CI-прогон?                     | Всё: unit + интеграция с PG+Redis как services + typecheck + lint + build                                |
| 2     | Simplifier      | Lint при нулевой базе: строгость vs объём правок?     | Нулевой долг — починить всё, `--max-warnings=0`                                                          |
| 2     | Simplifier      | Область coverage-порога?                              | Только backend-ядро: `apps/api`, `apps/worker`, `packages/*`; `apps/web` вне области                     |
| 3     | Boundary Keeper | Где живёт E2E, если он не в блокирующем гейте?        | Отдельный неблокирующий job в том же workflow, утверждающий connection string                            |
| 3     | Boundary Keeper | Насколько глубоко меняем загрузку конфига (QG-07)?    | Перенести и `.env`, и `dump.rdb`, обновить все точки загрузки, добавить CI-проверку чёрного списка        |
| 3     | Boundary Keeper | Граница SPECIFICATION / ARCHITECTURE / CONVENTIONS?   | Что есть / почему так / как писать — три непересекающиеся роли                                           |
| 4     | Failure Analyst | Как задаётся Redis-конфиг и что доказательство?       | `docker/redis.conf` в репо + тест, читающий `CONFIG GET`                                                 |
| 4     | Failure Analyst | Что такое «поверх существующей схемы» без prod-дампа? | Два прогона: с нуля и инкрементально с засеянными данными                                                |
| 4     | Failure Analyst | Что считать «expand/contract зафиксирован»?           | Правило в `CONVENTIONS.md` + машинная проверка в CI                                                      |
| 5.5   | Edge probe      | Нормализация DSN, граница coverage, вакуумные проходы, вакуумная проверка Redis | Префикс И нормализованное неравенство; неокруглённое сравнение, равенство = проход; ассерты на ненулевой объём работы; все три значения Redis + fail-first |
| 5.6   | Prohibition probe | 7 must-NOT формы «сделать гейт зелёным, не сделав систему безопаснее» | Все 7 зафиксированы как негативные критерии приёмки (6 test-tier, 1 judgment)                          |

---

*Phase: 08-quality-gates-failure-injection-foundation*
*Spec created: 2026-07-27*
*Next step: /gsd-discuss-phase 8 — решения по реализации (структура workflow, набор eslint-правил, механика провижининга эфемерной БД, форма harness)*
