# Phase 8: Quality Gates & Failure-Injection Foundation - Context

**Gathered:** 2026-07-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Фаза строит инфраструктуру доказательства для send-pipeline: блокирующий CI-гейт на GitHub Actions, физическую невозможность тестового прогона уйти в dev-БД, воспроизводимость пяти названных аудитом режимов отказа одной командой каждый, безопасную конфигурацию Redis, гигиену рабочего корня и три документа (`SPECIFICATION.md` / `ARCHITECTURE.md` / `CONVENTIONS.md`) с обязывающим правилом обновления.

Фаза строит **гейты**, а не догоняет покрытие и не меняет поведение системы. Единственное исключение — надбавка ~1 п.п. к coverage-порогу (см. D-16), закрываемая точечными тестами на `packages/kms` и `packages/tenant-context`.

</domain>

<spec_lock>
## Requirements (locked via SPEC.md)

**12 requirements are locked.** См. `08-SPEC.md` для полных требований, границ и критериев приёмки (ambiguity score 0.12, gate ≤ 0.20).

Downstream-агенты ОБЯЗАНЫ прочитать `08-SPEC.md` перед планированием и реализацией. Требования здесь не дублируются.

**In scope (из SPEC.md):**
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

**Out of scope (из SPEC.md):**
- Playwright E2E в блокирующих required checks
- Новые e2e-сценарии, расширение покрытия сверх достижения порога
- Введение самого шва инъекции в `send-dispatch.ts` — шов существует с Phase 4
- Изменение семантики машины состояний доставки, добавление `'reconciling'` в `send_status` — Phase 11
- Per-tenant concurrency-cap, retention очередей, worker-reliability правки — Phase 12
- Автоматизация партиций `events`/`send_events` — Phase 9 (жёсткий дедлайн 2026-09-01)
- Разделение ролей Postgres, RLS на Better Auth таблицах — Phase 10
- PgBouncer, Docker-деплой, restore-репетиция, Sentry — Phases 14-15
- Перекройка `SPECIFICATION.md` под новые документы
- Прогон против реального SendGrid — Phase 16 (release barrier)

</spec_lock>

<decisions>
## Implementation Decisions

### CI-гейт и модель работы с git

- **D-01:** Работа переходит на модель **ветка на фазу → PR в конце фазы**. Все планы фазы коммитятся в ветку `phase-NN-*`; CI триггерится и на `push` в ветку, и на `pull_request`, поэтому обратная связь ранняя, а PR — только точка мёржа. PR формируется через `/gsd-pr-branch` (фильтрует `.planning/`-коммиты). Branch protection на `master` включается **без admin-bypass** — иначе гейт декоративен и критерий R1 не выполняется.
  — **Reversibility:** costly — меняет процесс работы для всех оставшихся фаз milestone (9-16) и требует правки `git.branching_strategy` в конфиге GSD; откат означает снятие branch protection, то есть отказ от требования 1.

- **D-02:** Блокирующий CI разбит на **два job'а**: `static` (typecheck + lint + build, без сервисов) и `test` (сервисы + весь vitest-корпус + coverage) — плюс **неблокирующий** `e2e` и **блокирующий** `failure-injection` (см. D-21). Обоснование: прогон 85 backend-файлов против живого Postgres — единственный по-настоящему долгий шаг; вынос lint и typecheck за его спину даёт минуты обратной связи.

- **D-03:** Postgres и Redis в CI поднимаются через **`docker compose up -d --wait`**, а не через GHA `services:`. Причина техническая и обязательная: GHA `services:` не позволяет переопределить `command`/entrypoint контейнера, поэтому `docker/redis.conf` (требование 7) применить нельзя, а сценарий (5) требует `docker restart` контейнера Redis. Побочно это выполняет constraint R4 «один и тот же путь локально и в CI, без CI-only ветки».
  — **Уточнение к SPEC R1:** формулировка «поднимающим `postgres:17` и `redis:7` **как services**» трактуется как намерение («живые PG и Redis, а не моки»), а не как выбор механизма GHA `services:`. Это осознанное расхождение с буквой текста, зафиксированное здесь.

- **D-04:** Отдельного скрипта `typecheck` не заводится — **шаг `npm run build --workspaces` и есть typecheck**. Проверено: project references не используются, `strict: true` включён везде, `apps/api/tsconfig.json` имеет `include: ["src"]` (то есть `tsc -p` типизирует и тесты), `apps/web` build = `tsc --noEmit && vite build`. Второй проход `tsc --noEmit` не ловит ничего нового и стоит ~40-60% времени `static`-job'а. Корневой solution-tsconfig отвергнут: `apps/web` живёт на `moduleResolution: Bundler` + JSX, остальные — на `NodeNext`.
  — **Уточнение к SPEC R1:** три шага «typecheck → lint → build» схлопываются в два; type error в PR по-прежнему валит гейт.

### Lint

- **D-05:** База — **`typescript-eslint recommended-type-checked`** с `projectService`. Обоснование: только type-aware tier даёт `no-floating-promises`, `no-misused-promises`, `await-thenable`, `require-await` — ровно тот класс багов, который аудит нашёл в async send-pipeline и BullMQ-воркерах. `strict-type-checked` отвергнут: на 57k LOC brownfield это преимущественно вкусовые правила и риск для окна до дедлайна Phase 9 (2026-09-01). `recommended` без типов отвергнут как содержательно пустой для этого кода.

- **D-06:** Escape hatch **по порогу**: системное нарушение (много мест, правило не подходит проекту) → правило выключается в `eslint.config.js` с комментарием-обоснованием; единичное → `// eslint-disable-next-line rule-name -- причина`. Понижение до `warn` бессмысленно — `--max-warnings=0` делает warn блокирующим наравне с error. Файловый blanket-`/* eslint-disable */` без имени правила и причины запрещён (негативный критерий SPEC).

- **D-07:** Плагины сверх `typescript-eslint`: **`react-hooks`** (rules-of-hooks + exhaustive-deps), **запрет `.only`/focused-тестов** (`no-only-tests` или `vitest/no-focused-tests`), **`import/no-extraneous-dependencies`**. Запрет `.only` выбран прицельно: забытый `.only` даёт вакуумно-зелёный прогон — ровно тот failure mode, против которого построена вся фаза. `jsx-a11y` и `import/order` отвергнуты как отдельный пласт долга вне boundary.

- **D-08:** Критерий «число проверенных файлов не ниже зафиксированного минимума» реализуется как **число-пол в версионируемом файле** + шаг, сравнивающий его с длиной массива из `eslint --format json`. Снижение пола видно в диффе. Динамический подсчёт по glob отвергнут: он неизбежно разойдётся с `ignores` из flat config и станет источником ложных падений.

### Эфемерная тестовая БД и fail-closed guard

- **D-09:** Провижининг живёт в **`globalSetup`** — у vitest каждого workspace и у Playwright. Это единственная точка, которую vitest и Playwright разделяют буквально одним кодом (как требует R4); teardown гарантирован раннером даже при падении тестов. `pretest`/`posttest` отвергнут (`posttest` не выполняется при ненулевом коде — БД протекают; Playwright эту точку не использует). Отдельный CI-шаг отвергнут как прямое создание CI-only ветки.

- **D-10:** Гранулярность — **БД на workspace**, имя вида `mega_crm_test_<workspace>_<run-id>`. Закрывает оба backstop-edge из SPEC: уникальность имени между одновременными CI-прогонами и изоляция api/worker друг от друга.

- **D-11:** Провижининг подключается **админским DSN** (роль `postgres`), а тесты получают DSN под **non-superuser ролью `mega_crm_app`** — иначе RLS в тестах не enforce'ится (это уже зафиксировано комментарием в `db-fixture.ts` и `.env.example`).

- **D-12:** Схема попадает в свежую БД **существующим механизмом `db-fixture`** — 38 миграций под advisory-lock `8472991`. Путь «с нуля» всё равно обязателен требованием 5, поэтому получает максимальный пробег. Template-БД отвергнута: механизм инвалидации шаблона создаёт риск молчаливо устаревшей схемы. SQL-снапшот отвергнут как второй источник правды рядом с миграциями.

- **D-13:** Создаётся новый workspace **`packages/test-support`**: guard, провижининг, консолидированный `db-fixture`, harness-энтрипоинт, тесты миграций. Три существующие копии `db-fixture.ts` (`apps/api`, `apps/worker`, `packages/delivery-core`) заменяются импортом.
  — **Reversibility:** costly — новый workspace попадает в `SPECIFICATION.md` §2, tsconfig'и и зависимости трёх потребителей; откат означает возврат к трём расходящимся копиям.

- **D-14:** Guard **двухслойный**: (а) hard error в `globalSetup` до выполнения первого теста; (б) отсутствие fallback `?? DATABASE_URL` внутри `db-fixture` — так что тестовый энтрипоинт мимо `globalSetup` тоже не проваливается в dev-БД. Оба условия R4 (префикс `mega_crm_test` И нормализованное неравенство тройки host+port+database) проверяются в одном месте. Env-переменной или флага, отключающего guard, не существует (негативный критерий SPEC).

- **D-15:** Playwright поднимает стек **новыми скриптами `dev:e2e` без `--env-file`**; переменные приходят единственным путём — из `webServer.env`, заполняемого Playwright `globalSetup`. **`reuseExistingServer` меняется с `true` на `false`** — текущее значение является дырой: при уже запущенном локальном dev-стеке Playwright переиспользует его и уходит в dev-БД, даже если провижининг отработал. Прогон против собранных артефактов отложен в Phase 15.

### Coverage

- **D-16:** Агрегация — **корневой `vitest.config.ts` с `test.projects`** (Vitest 4.1.9 в репо). Один прогон → один отчёт → один знаменатель. Решающий довод: `packages/kms` (envelope-шифрование), `packages/tenant-context` (RLS) и `packages/contacts-core` не имеют собственных тестов, но **исполняются** тестами `apps/api`; при пофайловой склейке отчётов они показали бы 0% и утянули порог в бессмысленно низкое число. Per-project `env` и `fileParallelism: false` у worker сохраняются. Провайдер — `@vitest/coverage-v8` (на усмотрение исполнителя).

- **D-17:** Знаменатель — **только файлы, реально загруженные во время прогона** (дефолт провайдера). Принято осознанно: при едином агрегированном прогоне это почти вся backend-кодовая база; выпадает только код, который не импортирует ни один тест. Критерий R3 «workspace, чьи тесты не отработали, валит гейт, а не выпадает из знаменателя» закрывается **семантикой `projects`** — упавший или не отработавший project валит весь прогон — а не составом знаменателя.

- **D-18:** Порог живёт в **`coverage-baseline.json`**, проверяется **собственным gate-скриптом** поверх `json-summary`: сравнение по неокруглённому `covered/total`, равенство порогу = проход. Отдельный **ratchet-шаг** сравнивает значение с base-веткой (`git show origin/master:coverage-baseline.json`) и падает при понижении. Встроенные `coverage.thresholds` Vitest отвергнуты: они не дают ни неокруглённого сравнения, ни защиты от понижения, а ratchet-шагу пришлось бы парсить TS-конфиг.

- **D-19:** Порог = **измеренный baseline + ~1 п.п.**, метрика — `lines`. Надбавка закрывается точечными тестами на `packages/kms` и `packages/tenant-context` — оба сейчас без единого собственного теста при том, что это шифрование ключей тенантов и RLS-контекст. Выполняет constraint SPEC «baseline плюс намеренная надбавка, не круглое число», удерживая объём работы в рамках boundary.

- **D-20:** **Чеклист пяти крэш/race-сценариев требования 6, отображённый на конкретные имена тестов, ведётся отдельно от процента покрытия.** Процент покрытия не является и не может служить доказательством их существования (constraint SPEC, Pitfall 22).

### Failure-injection harness

- **D-21:** Все пять сценариев живут как **vitest-файлы + пять npm-скриптов-обёрток** (`failure:timeout`, `failure:429`, `failure:reset`, `failure:sigkill`, `failure:redis-restart`), каждый = `vitest run <file>`. Единая форма, единые фикстуры из `packages/test-support`, ассерты через `expect`. Критерий «пять команд запускаются по отдельности» выполняется буквально. Standalone-скрипты отвергнуты: потребовали бы дублирования фикстуры БД и самописной assertion-механики.

- **D-22:** Сценарий (4) SIGKILL использует **harness-энтрипоинт в `packages/test-support`**: настоящий отдельный процесс, настоящий BullMQ Worker, живые Postgres и Redis; через существующий шов `ProcessSendJobDeps.sendMail` инжектируется **только** `sendMail`. Реальный `apps/worker/src/server.ts` запускать нельзя: `https://api.sendgrid.com/v3/mail/send` захардкожен в `packages/delivery-core/src/send-mail.ts:120`, а негативный критерий SPEC запрещает любой сетевой вызов к SendGrid из failure-сценариев. Конфигурируемый base URL отвергнут в этой фазе как выход за boundary «новый шов не вводится» (отложен, см. Deferred).

- **D-23:** Попадание SIGKILL в окно гарантируется **сигналом из инжектированного `sendMail`**: подменённый `sendMail` сообщает родителю через IPC и **никогда не резолвится**, поэтому процесс физически заморожен внутри окна (claim через `dispatchSendGate` уже закоммичен, терминальной записи ещё нет) до момента убийства. Гонки нет. Поллинг БД до состояния `dispatching` и убийство по таймеру отвергнуты как недетерминированные — SPEC прямо называет произвольный момент убийства ничего не доказывающим.

- **D-24:** Пять сценариев гоняются в **отдельном блокирующем job'е `failure-injection`** в required checks. Обоснование: QG-06 назван в ROADMAP hard-блокером для Phase 11, и неблокирующий job означал бы тихое гниение сценариев к моменту, когда они понадобятся. Аргумент, по которому E2E вынесен в неблокирующие, здесь не работает: у Playwright флак идёт от браузера, а тут всё детерминировано (сигнал вместо таймера, `docker compose --wait` вместо ожидания вслепую).

### Инфраструктура и гигиена

- **D-25:** `maxmemory` задаётся **фиксированным значением (~512mb) прямо в версионируемом `docker/redis.conf`**, одинаково локально и в CI, с комментарием в файле, что sizing под production-VPS относится к Phase 15. Параметризация через env отвергнута: `redis.conf` не поддерживает подстановку переменных нативно, потребовался бы entrypoint-скрипт или `command`-override, то есть расхождение конфигурации между средами. Файл монтируется тем же способом, что уже применяется для `docker/init-app-role.sql`.

- **D-26:** **`appendfsync everysec`** при `appendonly yes`. Критерий «задания, поставленные до `docker restart`, присутствуют после» выполняется: `docker restart` шлёт SIGTERM, Redis делает финальный fsync. `always` отвергнут — кратная просадка пропускной способности на горячем пути постановки заданий ради сценария (жёсткий крэш хоста), который в этой фазе не тестируется; вопрос возвращается в Phase 12 (worker reliability) и Phase 14 (backup/PITR).

- **D-27:** `.env` переезжает в **`~/.config/mega-crm/.env`**, путь переопределяется переменной **`MEGA_CRM_ENV_FILE`**. Техническое следствие: `--env-file` — флаг Node в строке npm-скрипта, подставить туда JS-константу нельзя, поэтому **dev-энтрипоинты `apps/api` и `apps/worker` переходят с флага на загрузку в коде** (`process.loadEnvFile(resolveEnvPath())` в начале `server.ts`). Иначе «одна переменная/константа» из R9 недостижима. CI файл не использует вовсе — переменные экспортируются в окружение.
  — **Операторская задача:** constraint SPEC ставит `.env*` под hard-deny для инструментов исполнителя. План обязан содержать явную инструкцию оператору: скопировать файл в новое место и удалить из корня **руками**; агент этого не делает.

- **D-28:** Всего точек загрузки `.env` шесть, и все переводятся на новую константу: `--env-file=../../.env` в dev-скриптах `apps/api` и `apps/worker`, `process.loadEnvFile` в трёх vitest-конфигах, `scripts/check-env.mjs`, `scripts/migrate-dev.mjs`.

- **D-29:** CI-проверка чёрного списка — **нерекурсивный обход рабочего корня**. Список: `.env`, `.env.*` кроме `.env.example`, `*.rdb`, `*.aof`, `.DS_Store`. Fail-first доказывается возвратом `.env` или `*.rdb` в корень. Рекурсивный обход отвергнут: легитимные тестовые фикстуры начали бы валить гейт, список исключений разросся бы и проверка деградировала. Сканер секретов по содержимому — другой класс проверки, отложен.

### Линтер миграций и документация

- **D-30:** Линтер миграций — **самописный node-скрипт** (снятие комментариев → матчинг двух правил), покрытый юнит-тестом с fail-first фикстурами обоих видов. Решающий довод: правило «`ALTER TYPE … ADD VALUE` и использование добавленного значения в одном файле» специфично для этого проекта и отсутствует в готовых линтерах (включая `squawk`) — раз его всё равно писать, добавить второе правило дешевле, чем вводить внешний бинарник в CI ради половины проверки. Именно это правило защищает Phase 11 от попытки использовать `'reconciling'` в транзакции, которая его добавила.

- **D-31:** Намеренно разрушительный DDL помечается **построчным SQL-комментарием над конкретным оператором, с обязательной причиной**. Гасится только следующий оператор, остальные в том же файле продолжают ловиться. Заголовочный комментарий на файл отвергнут — это тот же blanket-disable, что запрещён в D-06. Реестр-файл отвергнут: маркер оторван от кода и невидим в ревью.

- **D-32:** `ARCHITECTURE.md` и `CONVENTIONS.md` — **компактные**: пять обязательных блоков по несколько абзацев «почему», факты — ссылкой в `SPECIFICATION.md`, плюс **одна mermaid-диаграмма пути события до отправки**. Обоснование: требование 12 делает обновление обязательным при каждом изменении границ/потоков/очередей; чем подробнее документ, тем чаще правило срабатывает и тем быстрее документ расходится с реальностью — что прямо запрещено негативным критерием «не описывать планируемое как действующее». Диаграмма пути события оправдана: это центральный поток продукта, стабильный с Phase 4.

- **D-33:** Правило обновления в `.claude/CLAUDE.md` реализуется **расширением существующего раздела** «Project Specification (SPECIFICATION.md)» до трёх документов, с таблицей конкретных триггеров по каждому. Требование 12 сформулировано в единственном числе («раздел распространяет правило на все три документа»). Дополнительно: заглушки `## Conventions` («not yet established») и `## Architecture` («not yet mapped») заменяются ссылками на новые файлы — иначе `CLAUDE.md` продолжит утверждать, что соглашений не существует, ровно после того, как они записаны.

### Claude's Discretion

- Версия Node в CI: пин на локальную (v26) через `.nvmrc` / `actions/setup-node` — гейт обязан проверять ту же среду, в которой идёт разработка (`engines` в `package.json` объявляет `>=22`).
- `concurrency: cancel-in-progress` по ветке; кеш npm через `actions/setup-node`.
- Провайдер coverage: `@vitest/coverage-v8` (официальный дефолт Vitest; прогон упирается в Postgres-I/O, а не в инструментацию).
- Точные глобы `coverage.include`/`exclude`, конкретное число lint-пола, конкретное значение `maxmemory` в пределах ~512mb.
- Механика оркестрации дочернего процесса и `docker restart` внутри vitest-сценариев (`node:child_process` / `execa`).
- Судьба `dump.rdb`: удалить из корня, добавить в `.gitignore`, снапшот живёт только в именованном docker-томе `mega_crm_redis_data`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream-агенты ОБЯЗАНЫ прочитать это перед планированием и реализацией.**

### Требования и границы фазы
- `.planning/phases/08-quality-gates-failure-injection-foundation/08-SPEC.md` — **locked requirements, MUST read before planning.** 12 требований, boundaries, constraints, 22 позитивных + 7 негативных критериев приёмки, Edge Coverage и Prohibitions
- `.planning/ROADMAP.md` § Phase 8 — цель фазы, 5 success criteria, sequencing-заметки (QG-06 как hard blocker для Phase 11, QG-03/QG-04 pitfalls 21/22, обоснование размещения WRK-12 и DB-08)
- `.planning/REQUIREMENTS.md` — REQ-ID для QG-01…QG-10, WRK-12, DB-08
- `.planning/AUDIT-2026-07-27-production-readiness.md` — первоисточник всех требований v1.1; findings по quality gates

### As-built состояние системы
- `SPECIFICATION.md` — as-built описание для security review: фактические зависимости и версии (§2), секреты (§3), схема данных и RLS (§4), планировщик и пайплайн отправки (§5), публичные точки входа (§6), наблюдаемость (§7), расхождения со стеком (§8). **Обязательно к обновлению в том же изменении** — новый workspace `packages/test-support`, новые devDependencies (ESLint, coverage-провайдер), `docker/redis.conf`, новая переменная `MEGA_CRM_ENV_FILE`, новый CI-workflow
- `.claude/CLAUDE.md` § Project Specification — действующее обязывающее правило обновления документации и таблица «куда писать»; расширяется по D-33

### Существующий шов и код, на который опирается фаза
- `apps/worker/src/queues/send-dispatch.ts` — `ProcessSendJobDeps` (`sendMail`, `redisClient`), `processSendJob`. **Шов не вводится заново, фаза добавляет сценарии**
- `apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts` — существующая внутрипроцессная симуляция крэша между commit'ом claim и терминальной записью; образец для сценариев harness'а
- `apps/worker/src/queues/__tests__/send-dispatch-idempotency.test.ts` — существующее использование шва
- `apps/api/src/test/db-fixture.ts`, `apps/worker/src/test/db-fixture.ts`, `packages/delivery-core/src/test/db-fixture.ts` — три копии, консолидируются по D-13; содержат опасный `TEST_DATABASE_URL ?? DATABASE_URL`
- `packages/delivery-core/src/send-mail.ts:120` — захардкоженный `https://api.sendgrid.com/v3/mail/send`; причина, по которой реальный `server.ts` в harness не запускается (D-22)
- `apps/web/playwright.config.ts` — `webServer` на `npm run dev`, `reuseExistingServer: true` (дыра, закрывается D-15)
- `apps/worker/vitest.config.ts` — `fileParallelism: false` установлено намеренно (06-12, реальный BullMQ Worker на глобальной очереди `flow-run-advance`). **Ни CI-конфигурация, ни guard не должны его снимать**
- `docker-compose.yml` — `redis:7` без `command`/`maxmemory`/AOF; `docker/init-app-role.sql` монтируется в `db` (образец монтирования для `docker/redis.conf`)
- `packages/db/migrations/` — 38 SQL-миграций, вход для тестов миграций (R5) и линтера (R8)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **DI-шов `ProcessSendJobDeps.sendMail`** (`apps/worker/src/queues/send-dispatch.ts`): существует с Phase 4, уже используется двумя тестовыми файлами. Все пять failure-сценариев строятся поверх него — новый шов не вводится.
- **`db-fixture.ts`**: применение 38 миграций под advisory-lock `8472991` в трекинг-таблицу `_test_migrations_applied`. Переиспользуется как есть (D-12), переезжает в `packages/test-support` (D-13).
- **Паттерн монтирования конфига в docker-compose**: `./docker/init-app-role.sql:/docker-entrypoint-initdb.d/01-init-app-role.sql:ro` — готовый образец для `docker/redis.conf`.
- **Конвенция `TEST_DATABASE_URL` / `TEST_REDIS_URL`**: уже принята во всех vitest-конфигах (`REDIS_URL` тестов указывает на logical DB 1, отдельный от dev DB 0). Guard встраивается в существующую конвенцию, а не заменяет её.
- **`nock`** уже используется в `apps/api` для перехвата вызовов к `api.sendgrid.com` — подтверждает, что запрет на сетевые вызовы к SendGrid в тестах является действующей практикой репозитория.

### Established Patterns
- **`strict: true` в `tsconfig.base.json`** для всех workspace, `skipLibCheck: true`, `module/moduleResolution: NodeNext` (кроме `apps/web` — `ESNext`/`Bundler` + JSX). Project references не используются.
- **`include: ["src"]` в tsconfig'ах api/worker** означает, что `tsc -p` типизирует и тесты; отсюда `exclude: ["dist/**"]` в vitest-конфигах (иначе тесты гонялись бы дважды — из src и из скомпилированного dist).
- **Комментарии-обоснования в конфигах**: существующие vitest-конфиги содержат развёрнутые комментарии со ссылками на номер плана (`04-03`, `05-12`, `06-12`) и причину. Новые конфиги (ESLint, coverage, redis.conf) должны следовать той же конвенции.
- **npm-workspaces `apps/*` + `packages/*`**, `npm run test --workspaces --if-present` в корне; `packages/segments-core` и `packages/shared-schemas` имеют `test`-скрипт **без** собственного `vitest.config.ts` (полагаются на дефолты) — учесть при сведении в `test.projects`.

### Integration Points
- **`packages/test-support` → `apps/api`, `apps/worker`, `packages/delivery-core`**: новый workspace становится их devDependency, три копии `db-fixture` заменяются импортом.
- **`globalSetup` в 4+ vitest-конфигах и в `playwright.config.ts`**: единая точка вызова guard'а и провижининга.
- **`.claude/CLAUDE.md`**: расширение раздела правила обновления + замена заглушек `## Conventions` / `## Architecture` ссылками.
- **`docker-compose.yml`**: добавление `command` и монтирования `docker/redis.conf` в сервис `redis`.
- **`package.json` (корень и workspaces)**: новые скрипты `lint`, `dev:e2e`, пять `failure:*`, скрипты провижининга и gate-проверок.

### Распределение тестов (замерено 2026-07-28)
`apps/api` 48 файлов · `apps/worker` 24 · `packages/delivery-core` 8 · `packages/flows-core` 2 · `packages/shared-schemas` 2 · `packages/segments-core` 1 · `apps/web` 6 (вне coverage-области). Итого 91, из них 85 в backend-области.
**Без единого теста:** `packages/contacts-core`, `packages/db`, `packages/kms`, `packages/tenant-context`.

</code_context>

<specifics>
## Specific Ideas

- **Запрет `.only` в тестах — не стилистика, а часть темы фазы.** Забытый `.only` даёт зелёный прогон, в котором ничего не проверено; это тот же класс провала, что «ESLint проверил 0 файлов» и «coverage-порог обошли понижением». Все три закрываются одним принципом: **любое ослабление гейта обязано быть видимым — в диффе или в упавшей проверке.**
- **Симметрия escape hatch'ей.** Три места, где допустимо ослабление, оформлены одинаково — с обязательным именем правила и причиной: `eslint-disable-next-line` (D-06), маркер разрушительного DDL (D-31), исключения в coverage-конфиге. Blanket-варианты запрещены везде.
- **Fail-first как способ доказательства.** Требования 2, 5, 7, 8, 9 содержат критерии вида «падает на заведомо плохом входе». Каждая такая проверка должна иметь фикстуру или шаг, демонстрирующий падение, а не только успешный прогон.

</specifics>

<deferred>
## Deferred Ideas

- **Конфигурируемый base URL SendGrid** (env-переменная вместо хардкода в `packages/delivery-core/src/send-mail.ts:120`) — позволил бы гонять failure-сценарии через настоящий `fetch` против локального stub-сервера и убивать буквально production-энтрипоинт. Естественное место — **Phase 16** (live SendGrid UAT), где конфигурируемый эндпоинт и так понадобится. В Phase 8 не вводится: выходит за boundary «новый шов не вводится».
- **Template-БД** (`CREATE DATABASE … TEMPLATE` с предмигрированного шаблона) для ускорения провижининга — оптимизация без измеренной необходимости. Вернуться, если время прогона станет проблемой.
- **E2E против собранных артефактов** (`node dist/server.js` + `vite preview` вместо dev-серверов) — **Phase 15** (Docker-деплой), где production-подобный запуск и так в scope.
- **Сканер секретов по содержимому** (gitleaks / trufflehog) вместо/в дополнение к чёрному списку имён — **Phase 13** (security & tenant isolation), где секреты и redaction в scope.
- **Пересмотр `maxmemory` и `appendfsync` под production-VPS** — **Phase 15** (sizing) и **Phase 12/14** (worker reliability, backup/PITR).
- **`import/order` и `jsx-a11y`** — отдельный пласт качества UI и кодстайла, вне boundary фазы гейтов.

</deferred>

---

*Phase: 8-quality-gates-failure-injection-foundation*
*Context gathered: 2026-07-28*
