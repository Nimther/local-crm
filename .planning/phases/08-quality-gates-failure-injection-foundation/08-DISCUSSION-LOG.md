# Phase 8: Quality Gates & Failure-Injection Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-28
**Phase:** 08-quality-gates-failure-injection-foundation
**Mode:** `--all --analyze` (все области выбраны автоматически, перед каждым вопросом — таблица trade-off)
**Areas discussed:** CI-гейт и PR-модель, Строгость lint, Эфемерная БД и guard, Coverage, Failure-injection harness, Инфраструктура и гигиена, Линтер миграций и документы

---

## CI-гейт и PR-модель

### Модель работы с git при branch protection

| Option | Description | Selected |
|--------|-------------|----------|
| Ветка на фазу, PR в конце | Одна ветка `phase-NN-*`, CI на каждый push, PR в конце фазы через `/gsd-pr-branch`; protection без исключений | ✓ |
| Ветка на план, PR на план | Гейт ловит регресс точечно, ~150 PR на milestone | |
| Ветка на фазу + PR на рискованные планы | Гибрид: планы, трогающие send-pipeline/миграции, идут отдельными PR | |

**User's choice:** Ветка на фазу, PR в конце
**Notes:** Признано, что `git.branching_strategy: none` (все 96 планов v1.0 прямыми коммитами) должен смениться; admin-bypass отвергнут как делающий гейт декоративным.

### Разбиение блокирующего CI на job'ы

| Option | Description | Selected |
|--------|-------------|----------|
| Два: `static` ∥ `test` | `static` без сервисов, `test` с PG+Redis и всем vitest; оба required | ✓ |
| Один job `verify` | Всё последовательно, один `npm ci`, одно имя проверки | |
| Job на каждый шаг | Максимум гранулярности, оверхед восстановления artifacts | |

**User's choice:** Два: static ∥ test
**Notes:** Прогон 85 backend-файлов против живого Postgres — единственный долгий шаг; вынос lint/typecheck за его спину даёт минуты фидбека.

### Способ поднятия Postgres и Redis в CI

| Option | Description | Selected |
|--------|-------------|----------|
| `docker compose up -d --wait` | Один compose локально и в CI; позволяет смонтировать `redis.conf` и делать `docker restart` | ✓ |
| GHA `services:` для обоих | Дословно по тексту SPEC R1, но `redis.conf` применить нельзя | |
| Гибрид: PG через services, Redis через compose | Два механизма в одном job'е | |

**User's choice:** docker compose up -d --wait
**Notes:** Техническое ограничение GHA `services:` (нет override для `command`/entrypoint) делает требование 7 и сценарий (5) недостижимыми; расхождение с буквой SPEC зафиксировано в CONTEXT как уточнение к R1.

### Реализация шага typecheck

| Option | Description | Selected |
|--------|-------------|----------|
| Поглотить в build | `npm run build --workspaces` и есть typecheck; `tsc -p` покрывает src включая тесты | ✓ |
| Отдельный typecheck-скрипт | `tsc --noEmit` в каждом workspace, дословно три шага, цена — второй проход tsc | |
| Ты решаешь | Отдать выбор планировщику по факту замера времени | |

**User's choice:** Поглотить в build
**Notes:** Корневой solution-tsconfig отвергнут технически: `apps/web` на `moduleResolution: Bundler` + JSX против `NodeNext` у остальных.

---

## Строгость lint

### Tier typescript-eslint

| Option | Description | Selected |
|--------|-------------|----------|
| `recommended-type-checked` | Type-aware: no-floating-promises, no-misused-promises, await-thenable, unsafe-any | ✓ |
| `strict-type-checked` | Максимум строгости, сотни правок на 57k LOC brownfield | |
| `recommended` (без типов) | Быстрее всего, но не ловит floating promises | |

**User's choice:** recommended-type-checked
**Notes:** Решающий довод — floating/misused promises в async send-pipeline и BullMQ-воркерах; `strict-type-checked` отвергнут как риск для окна до дедлайна Phase 9 (2026-09-01).

### Escape hatch для нарушений

| Option | Description | Selected |
|--------|-------------|----------|
| Оба, по порогу | Системное → выключить правило в конфиге с обоснованием; единичное → построчно с именем правила и причиной | ✓ |
| Только конфиг | Никаких disable-комментариев в коде вообще | |
| Только точечные disable | Ни одно правило пресета не выключается | |

**User's choice:** Оба, по порогу
**Notes:** Понижение до `warn` признано бессмысленным — `--max-warnings=0` делает warn блокирующим.

### Плагины сверх typescript-eslint

| Option | Description | Selected |
|--------|-------------|----------|
| `react-hooks` + запрет `.only` + `no-extraneous-deps` | Только правила, ловящие баги | ✓ |
| + стилистика импортов | Добавить `import/order` — десятки автофиксимых правок | |
| + `jsx-a11y` | Проверки доступности UI — отдельный пласт долга | |

**User's choice:** react-hooks + запрет .only + no-extraneous-deps
**Notes:** Запрет `.only` выбран прицельно как защита от вакуумно-зелёного прогона — тема всей фазы.

### Защита от «линтер проверил 0 файлов»

| Option | Description | Selected |
|--------|-------------|----------|
| Зафиксированный пол в репо | Число в версионируемом файле + сравнение с длиной `eslint --format json` | ✓ |
| Динамический подсчёт по glob | Не устаревает, но расходится с `ignores` из flat config | |
| Ты решаешь | Оставить планировщику | |

**User's choice:** Зафиксированный пол в репо
**Notes:** Устаревание пола принято как приемлемая цена — он защищает от катастрофы, а не измеряет полноту.

---

## Эфемерная БД и guard

### Точка вызова провижининга и гранулярность

| Option | Description | Selected |
|--------|-------------|----------|
| `globalSetup`, БД на workspace | Общий модуль у vitest каждого workspace и у Playwright; teardown гарантирован раннером | ✓ |
| `globalSetup`, одна БД на прогон | Быстрее, но backstop про изоляцию api/worker закрывать отдельно | |
| `pretest` в корневом package.json | Просто, но `posttest` не выполняется при падении; Playwright точку не использует | |

**User's choice:** globalSetup, БД на workspace
**Notes:** Отдельный CI-шаг отвергнут как прямое создание CI-only ветки, запрещённой constraint'ом R4. Побочно зафиксировано: провижининг — админским DSN, тесты — под non-superuser ролью `mega_crm_app` (иначе RLS не enforce'ится).

### Как схема попадает в свежую БД

| Option | Description | Selected |
|--------|-------------|----------|
| Миграции через `db-fixture` | Существующий механизм, 38 миграций под advisory-lock | ✓ |
| Template-БД | `CREATE DATABASE … TEMPLATE`, быстро, но нужна инвалидация шаблона | |
| SQL-снапшот схемы | `pg_dump` в версионируемый файл — второй источник правды | |

**User's choice:** Миграции через db-fixture
**Notes:** Путь «с нуля» всё равно обязателен требованием 5, поэтому получает максимальный пробег.

### Судьба трёх копий db-fixture

| Option | Description | Selected |
|--------|-------------|----------|
| Новый `packages/test-support` | Guard + провижининг + db-fixture + дом для harness и тестов миграций | ✓ |
| Только guard вынести | Копии остаются, fallback убирается, guard импортируется из одного модуля | |
| Guard только в `globalSetup` | Минимальная правка, один слой защиты | |

**User's choice:** Новый packages/test-support
**Notes:** Фаза создаёт минимум четыре куска общего тестового кода; без общего дома они расползлись бы по apps. Guard остаётся двухслойным.

### Как Playwright поднимает стек

| Option | Description | Selected |
|--------|-------------|----------|
| `dev:e2e` без env-file + `webServer.env` | Переменные только из Playwright globalSetup; `reuseExistingServer: false` | ✓ |
| Собранные артефакты | `node dist/server.js` + `vite preview` — детерминированнее, цена — build в e2e-job'е | |
| Ты решаешь | Оставить планировщику | |

**User's choice:** dev:e2e без env-file + webServer.env
**Notes:** Выявлена дыра в текущем конфиге: `reuseExistingServer: true` переиспользует локальный dev-стек на dev-БД, обходя любой провижининг.

---

## Coverage

### Механизм агрегации

| Option | Description | Selected |
|--------|-------------|----------|
| Корневой `vitest.config` с `test.projects` | Единый прогон, один отчёт, честный знаменатель | ✓ |
| Merge отчётов по workspace | Не трогает конфиги, но пакеты без своих тестов покажут 0% | |
| Ты решаешь | Оставить планировщику | |

**User's choice:** Корневой vitest.config с projects
**Notes:** Решающий факт — `kms`, `tenant-context`, `contacts-core` не имеют собственных тестов, но исполняются тестами `apps/api`; при склейке отчётов порог получился бы ложно низким.

### Состав знаменателя

| Option | Description | Selected |
|--------|-------------|----------|
| Весь src минус узкий список исключений | Непокрытый модуль виден как 0%; исключения видны в диффе | |
| Весь src без исключений | Максимальная честность ценой шума от тестовых файлов и фикстур | |
| Только загруженные файлы | Дефолт провайдера; число выше, неимпортированные модули выпадают | ✓ |

**User's choice:** Только загруженные файлы
**Notes:** Claude рекомендовал первый вариант; пользователь выбрал третий. Следствие проговорено и зафиксировано: при едином агрегированном прогоне «загруженные файлы» — почти вся backend-база, а критерий R3 про не отработавший workspace закрывается семантикой `projects` (упавший project валит прогон), а не составом знаменателя.

### Хранение и проверка порога

| Option | Description | Selected |
|--------|-------------|----------|
| `coverage-baseline.json` + gate-скрипт | Неокруглённое `covered/total`, равенство = проход, ratchet против base-ветки | ✓ |
| `thresholds` в vitest.config | Встроенный механизм, но ни неокруглённого сравнения, ни ratchet | |
| Ты решаешь | Оставить планировщику | |

**User's choice:** coverage-baseline.json + gate-скрипт
**Notes:** `thresholds.autoUpdate` отвергнут отдельно — от ручного понижения не защищает.

### Величина надбавки к baseline

| Option | Description | Selected |
|--------|-------------|----------|
| Baseline + ~1 п.п. на kms/tenant-context | Выполняет constraint; надбавка закрывается тестами на два security-критичных пакета | ✓ |
| Порог = baseline ровно | Ноль работы сверх гейтов, но расходится с формулировкой constraint'а | |
| Большая надбавка (5+ п.п.) | Риск для окна до дедлайна Phase 9 | |

**User's choice:** Baseline + ~1 п.п. на kms/tenant-context
**Notes:** Напряжение между constraint'ом («baseline плюс надбавка») и boundary («фаза строит гейты, а не догоняет покрытие») разрешено в пользу минимальной надбавки на самых голых модулях. Метрика — `lines`.

---

## Failure-injection harness

### Форма пяти сценариев

| Option | Description | Selected |
|--------|-------------|----------|
| Все пять — vitest + npm-обёртки | Единая форма, фикстуры из test-support, ассерты через `expect` | ✓ |
| Все пять — standalone-скрипты | Свобода оркестрации ценой дублирования фикстур | |
| Гибрид 1-3 / 4-5 | Каждый сценарий в своей среде, но две формы | |

**User's choice:** Все пять — vitest + npm-обёртки
**Notes:** Пять скриптов `failure:timeout` / `failure:429` / `failure:reset` / `failure:sigkill` / `failure:redis-restart`, каждый = `vitest run <file>`.

### Запуск реального процесса для SIGKILL

| Option | Description | Selected |
|--------|-------------|----------|
| Harness-энтрипоинт в test-support | Реальный процесс и Worker, инжектирован только `sendMail`, сети нет | ✓ |
| Конфигурируемый base URL + stub-сервер | Убивается настоящий `server.ts`, но добавляется конфиг-точка в delivery-core | |
| Ты решаешь | Оставить планировщику | |

**User's choice:** Harness-энтрипоинт в test-support
**Notes:** Обнаружено: `https://api.sendgrid.com/v3/mail/send` захардкожен в `delivery-core/src/send-mail.ts:120`, поэтому реальный `server.ts` пошёл бы в настоящий SendGrid — запрещено негативным критерием. Конфигурируемый base URL отложен в Phase 16.

### Точность окна SIGKILL

| Option | Description | Selected |
|--------|-------------|----------|
| Сигнал из `sendMail` + зависание | Процесс физически заморожен в окне, гонки нет | ✓ |
| Поллинг БД до `dispatching` | Гонка между наблюдением и доставкой сигнала остаётся | |
| Ты решаешь | Оставить планировщику | |

**User's choice:** Сигнал из sendMail + зависание
**Notes:** Убийство по таймеру отвергнуто прямо по тексту SPEC — «произвольный момент убийства ничего не доказывает».

### Место в CI

| Option | Description | Selected |
|--------|-------------|----------|
| Отдельный блокирующий job | Именованная required-проверка готовности к Phase 11 | ✓ |
| Внутри блокирующего test-job'а | Ничего нового, но медленные сценарии смешиваются с 85 файлами | |
| Отдельный неблокирующий job | Флак не блокирует мёрж, но сценарии могут тихо сгнить | |

**User's choice:** Отдельный блокирующий job
**Notes:** QG-06 назван в ROADMAP hard-блокером для Phase 11; аргумент «как у E2E» не применён, поскольку флак Playwright идёт от браузера, а здесь всё детерминировано.

---

## Инфраструктура и гигиена

### Задание maxmemory

| Option | Description | Selected |
|--------|-------------|----------|
| Фиксированное в файле (~512mb) | Одно число в версионируемом `docker/redis.conf` для всех сред | ✓ |
| Фиксированное, но крупнее (~2gb) | Запас под бурсты broadcast-очереди | |
| Параметризация через env | Гибко, но `redis.conf` не поддерживает подстановку нативно | |

**User's choice:** Фиксированное в файле (~512mb)
**Notes:** Комментарий в файле фиксирует, что sizing под production-VPS относится к Phase 15.

### Политика appendfsync

| Option | Description | Selected |
|--------|-------------|----------|
| `everysec` | Дефолт AOF; критерий выживания при `docker restart` выполняется | ✓ |
| `always` | Максимальная долговечность ценой кратной просадки на горячем пути | |
| Ты решаешь | Оставить планировщику | |

**User's choice:** everysec
**Notes:** `docker restart` — graceful stop с финальным fsync, обе политики его проходят; вопрос возвращается в Phase 12/14.

### Расположение .env

| Option | Description | Selected |
|--------|-------------|----------|
| `~/.config/mega-crm/.env` + `MEGA_CRM_ENV_FILE` | Полностью вне рабочего дерева; dev-энтрипоинты переходят на загрузку в коде | ✓ |
| `../mega-crm.env` рядом с репо | Привычнее, но ломается при клонировании в другое место | |
| Ты решаешь | Оставить планировщику | |

**User's choice:** ~/.config/mega-crm/.env + MEGA_CRM_ENV_FILE
**Notes:** Выявлено, что `--env-file` — флаг Node в строке npm-скрипта, поэтому «одна константа» из R9 требует перехода api/worker на `process.loadEnvFile(resolveEnvPath())`. Перенос самого файла — операторская задача (`.env*` под hard-deny).

### Область чёрного списка

| Option | Description | Selected |
|--------|-------------|----------|
| Только корень, нерекурсивно | `.env`, `.env.*` кроме `.env.example`, `*.rdb`, `*.aof`, `.DS_Store` | ✓ |
| Рекурсивно по репо | Шире, но легитимные фикстуры начнут валить гейт | |
| Сканер секретов (gitleaks) | Поиск по содержимому — другой класс проверки | |

**User's choice:** Только корень, нерекурсивно
**Notes:** Ровно по тексту R9; сканер секретов отложен в Phase 13.

---

## Линтер миграций и документы

### Реализация линтера

| Option | Description | Selected |
|--------|-------------|----------|
| Самописный node-скрипт | Два правила без внешних зависимостей, покрывается юнит-тестом с fail-first фикстурами | ✓ |
| `squawk` | Настоящий парсер, но правила про `ALTER TYPE ADD VALUE` в нём нет | |
| Гибрид | `squawk` на разрушительный DDL + свой скрипт на expand/contract | |

**User's choice:** Самописный node-скрипт
**Notes:** Ядро требования 8 — правило про `ALTER TYPE … ADD VALUE` + использование в том же файле — отсутствует в готовых линтерах; раз его всё равно писать, второе правило дешевле добавить туда же.

### Формат маркера разрушительного DDL

| Option | Description | Selected |
|--------|-------------|----------|
| Комментарий над оператором | Строчный маркер с обязательной причиной, гасит только следующий оператор | ✓ |
| Заголовочный комментарий файла | Проще матчить, но гасит проверку на весь файл | |
| Реестр-файл разрешённых | Обзор в одном месте ценой отрыва маркера от кода | |

**User's choice:** Комментарий над оператором
**Notes:** Тот же принцип, что и в lint: ослабление точечное, именованное, объяснённое.

### Глубина ARCHITECTURE.md / CONVENTIONS.md

| Option | Description | Selected |
|--------|-------------|----------|
| Компактный + 1 диаграмма | Пять блоков «почему», факты ссылкой в SPECIFICATION.md, mermaid пути события | ✓ |
| Подробный с диаграммами | C4 и sequence по каждой очереди — максимум пользы и максимум стоимости поддержки | |
| Минимальный | Буллеты без объяснений, дублирует SPECIFICATION.md | |

**User's choice:** Компактный + 1 диаграмма
**Notes:** Требование 12 делает обновление обязательным при каждом изменении границ/потоков; чем подробнее документ, тем быстрее он расходится с реальностью — что запрещено негативным критерием.

### Форма правила в CLAUDE.md

| Option | Description | Selected |
|--------|-------------|----------|
| Расширить существующий раздел | Раздел про SPECIFICATION.md → три документа с таблицей триггеров | ✓ |
| Новый отдельный раздел | Не трогать работающий текст, добавить второй рядом | |
| Три отдельных раздела | Максимально явно ценой тройного дублирования | |

**User's choice:** Расширить существующий раздел
**Notes:** Дополнительно зафиксировано: заглушки `## Conventions` / `## Architecture` в `.claude/CLAUDE.md` заменяются ссылками на новые файлы.

---

## Claude's Discretion

- Версия Node в CI (пин на локальную v26 через `.nvmrc`), `concurrency: cancel-in-progress`, кеш npm через `actions/setup-node`
- Провайдер coverage — `@vitest/coverage-v8`
- Точные глобы `coverage.include`/`exclude`, конкретное число lint-пола, конкретное значение `maxmemory` в пределах ~512mb
- Механика оркестрации дочернего процесса и `docker restart` внутри vitest-сценариев
- Судьба `dump.rdb`: удалить из корня, добавить в `.gitignore`, снапшот только в docker-томе

## Deferred Ideas

- Конфигурируемый base URL SendGrid вместо хардкода в `delivery-core/src/send-mail.ts:120` — Phase 16 (live SendGrid UAT)
- Template-БД для ускорения провижининга эфемерных БД — при появлении измеренной проблемы со временем прогона
- E2E против собранных артефактов (`node dist/server.js` + `vite preview`) — Phase 15 (Docker-деплой)
- Сканер секретов по содержимому (gitleaks / trufflehog) — Phase 13 (security & tenant isolation)
- Пересмотр `maxmemory` и `appendfsync` под production-VPS — Phase 15 (sizing), Phase 12/14 (worker reliability, backup/PITR)
- `import/order` и `jsx-a11y` — вне boundary фазы гейтов
