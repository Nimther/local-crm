# Phase 9: Partition Automation & Boundary Safety - Context

**Gathered:** 2026-08-06
**Status:** Ready for planning

<domain>
## Phase Boundary

`events` и `send_events` всегда имеют месячные партиции минимум на 2 месяца вперёд, создаваемые без ручного вмешательства; отсутствие партиции или остановка автоматизации даёт громкий алерт, пока буфер ещё есть — до того, как хоть одна строка попадёт в DEFAULT; переход границы месяца (включая случай «автоматизация опоздала, DEFAULT уже держит строки») покрыт автотестом; строки из DEFAULT переносятся в правильные партиции документированной процедурой без длительного эксклюзивного лока на живой таблице.

⚠️ **HARD DEADLINE 2026-09-01** — партиции существуют только по `*_2026_08`. Фаза намеренно минимальна и зависит только от Phase 8; другую работу по БД (backups, TLS, retention, constraints) сюда **не** добавлять — она в Phase 14. «Phase 9 complete» должно буквально означать «дедлайн закрыт».

Требования: DB-01, DB-02, DB-03, DB-04 (см. `.planning/REQUIREMENTS.md`).

**Уже решено на уровне ROADMAP (не пересматривать):**
- Ежедневный BullMQ repeatable job (`partition-maintenance.worker.ts`) по образцу четырёх существующих тиков — **не** `pg_partman` (custom-образ Postgres, зависимость от extension, вторая парадигма планирования — отвергнуто)
- Новая DB-роль не нужна: `mega_crm_app` уже владеет обеими таблицами; RLS на родителе автоматически распространяется на новые child-партиции
- **Pitfall 13:** перед любым `ATTACH PARTITION` — проверить, держит ли `events_default`/`send_events_default` строки; если да — CHECK-constraint-first (CHECK на DEFAULT, доказывающий отсутствие строк нового диапазона, позволяет Postgres пропустить полный скан под `ACCESS EXCLUSIVE`)
- Каждый прогон job'а эмитит «месяцев буфера осталось» — алерт ловит и «job остановился», и «кто-то поменял lookahead, не тронув порог»
- `send_events.occurred_at` — провайдерский; процедура attach не предполагает, что все строки DEFAULT лежат в ожидаемом окне (Phase 13 / CMP-05 ограничит значение позже)

</domain>

<decisions>
## Implementation Decisions

### Канал алерта (до инфраструктуры Phase 15)

- **D-01:** Алерт = **email оператору через существующий `PLATFORM_SENDGRID_API_KEY`** (тот же ключ, что шлёт verification/invite-письма) **плюс громкий провал самого job'а** (failed job виден в Bull Board). Логика: лог, который никто не читает, — не «громко»; Sentry/hosted logs появятся только в Phase 15. Адрес получателя — новая env-переменная в externally-resolved env-файле (`MEGA_CRM_ENV_FILE`), имя на усмотрение исполнителя (напр. `OPERATOR_ALERT_EMAIL`). — **Reversibility:** reversible — Phase 15 подключит настоящий алертинг к тому же сигналу, email-канал останется или уйдёт.
- **D-02:** Случай «job вообще перестал запускаться» ловит **API-сторож**: job пишет last-run timestamp в Postgres; API-процесс (отдельный процесс от воркера — настоящая мёртвая рука) периодически проверяет его и сам шлёт алерт-письмо, если последний прогон старше порога (~26 часов при cron-запуске раз в сутки, точное значение — исполнителю).
- **D-03:** Повторные алерты — **каждый прогон, пока состояние unhealthy** (ежедневное письмо). Один оператор, редкое событие, пропустить нельзя; повтор дешевле логики дедупликации и хранения предыдущего состояния.
- **D-04:** Письмо — **plain-text, без Dynamic Template**: цифры (таблица, месяцев буфера, строк в DEFAULT) прямо в теле. Аварийный канал не должен зависеть от существования шаблона в SendGrid-аккаунте платформы.

### Источник DDL и отношения с миграциями

- **D-05:** Логика создания партиций — **идемпотентная функция `ensurePartitions(now, lookahead)` в `packages/db`**, единственный источник партиционного DDL. Её вызывают: (а) maintenance job в проде, (б) db-fixture/провижининг эфемерных БД после прогона миграций — свежая тестовая БД получает актуальные партиции тем же кодом, что и прод; миграции не плодятся каждый месяц. — **Reversibility:** costly — фикстура в `packages/test-support` и migration-тесты Phase 8 начинают зависеть от вызова функции; откат вернул бы расхождение тестовой среды с прод-схемой.
- **D-06:** Дополнительно к runtime-функции — **одноразовая hand-written catch-up миграция**, создающая партиции до горизонта (по прецеденту 0007/0020: `CREATE TABLE ... PARTITION OF ... FOR VALUES FROM ... TO ...`, без drizzle-kit снапшота). Дедлайн 2026-09-01 закрывается самим фактом деплоя миграции, даже если job ни разу не отработает. Job дальше ведёт горизонт бесконечно.
- **D-07:** `ensurePartitions` выполняется **и при бооте воркера** (немедленный одноразовый job при регистрации, плюс repeatable) — после любого простоя буфер восстанавливается в первые секунды, а не через сутки.

### Процедура переноса из DEFAULT (DB-03)

- **D-08:** Форма — **исполняемый npm-скрипт + runbook**. Скрипт: батчевый перенос строк из DEFAULT + CHECK-constraint-first attach (Pitfall 13), короткие транзакции, без длительного `ACCESS EXCLUSIVE`. Запускается оператором осознанно, не фоновой магией. Runbook описывает когда и как запускать. **Автотест критерия 3 («автоматизация опоздала, DEFAULT держит строки») гоняет именно этот скрипт** — процедура и тест не могут разойтись.
- **D-09:** Строки с occurred_at далеко вне ожидаемого окна (напр. 2031 год): **переносить всё** — скрипт создаёт месячную партицию под каждый фактически занятый месяц и переносит все строки. DEFAULT после прогона пуст → CHECK-first attach всегда возможен; странная партиция `*_2031_04` безвредна и видима. (Phase 13 / CMP-05 позже перекроет вход диким timestamps.)
- **D-10:** Ежедневный job **считает строки в обеих DEFAULT-партициях каждый прогон**; >0 → тот же алерт-канал (письмо + провал job'а) с явным указанием запустить процедуру переноса. Замыкает цикл: обнаружение → оператор → скрипт. В норме DEFAULT пуст, COUNT дёшев.

### Lookahead, пороги, расписание

- **D-11:** Числа: **создавать партиции на +3 месяца вперёд, алертить при буфере <2 месяцев**. Между нормой и порогом — месяц запаса: job может молчать до ~30 дней, прежде чем нарушится критерий «минимум 2 месяца в любой момент», и алерт срабатывает задолго до попадания строк в DEFAULT.
- **D-12:** Lookahead, порог алерта и расписание — **версионируемые константы в коде с комментарием-обоснованием** (конвенция существующих тиков: `SCAN_INTERVAL_MS` и пр. с отсылкой к номеру плана). Не env: изменение lookahead обязано быть видимым в диффе — в духе философии Phase 8 «любое ослабление гейта видно в диффе или в упавшей проверке»; порог и горизонт лежат рядом, рассинхрон ловится ревью.
- **D-13:** Расписание — **cron-паттерн BullMQ (`repeat: { pattern }`) на фиксированный час UTC** (напр. 03:00), а не `every` от момента боота. Предсказуемо для оператора и даёт API-сторожу чёткий порог «last run старше 26 часов». Регистрация — с учётом заметки WRK-13: предпочесть `upsertJobScheduler` со стабильным ID, если версия BullMQ в репо его поддерживает.

### Claude's Discretion

- Имена env-переменной адреса оператора, таблицы/строки для last-run timestamp, точный порог сторожа, час запуска cron.
- Механика batched-переноса (размер батча, `LIMIT`-цикл `INSERT ... DELETE RETURNING` vs промежуточная таблица) — при соблюдении инварианта «без длительного эксклюзивного лока».
- Дизайн boundary-теста (инжекция часов vs управляемое окно партиций в эфемерной БД) — тест обязан покрыть и штатный переход месяца, и кейс «опоздали, DEFAULT держит строки» (criterion 3).
- Где живёт runbook (напр. `docs/runbooks/` или рядом с `ARCHITECTURE.md`) — с учётом binding update rule из Phase 8.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Требования и границы фазы
- `.planning/ROADMAP.md` § Phase 9 — цель, 4 success criteria, sequencing/pitfall-заметки (дедлайн 2026-09-01, Pitfall 13, запрет pg_partman, cross-phase заметка про occurred_at)
- `.planning/REQUIREMENTS.md` — DB-01, DB-02, DB-03, DB-04 (дедлайн-блок вверху файла)
- `.planning/AUDIT-2026-07-27-production-readiness.md` — первоисточник требований v1.1; findings по партициям
- `.planning/research/PITFALLS.md` — Pitfall 13 (CHECK-constraint-first перед ATTACH при непустом DEFAULT)

### Существующий партиционный DDL
- `packages/db/migrations/0007_events_partitioned.sql` — `events` PARTITION BY RANGE (occurred_at), партиции 2026_07/2026_08; hand-written прецедент (Drizzle партиции не выражает, снапшота нет)
- `packages/db/migrations/0010_events_workspace_scoped_pk.sql` — composite PK + `events_default`; комментарий объясняет, почему DEFAULT — catch-all для корректности
- `packages/db/migrations/0020_send_events_partitioned.sql` — то же для `send_events` (2026_07/2026_08 + `send_events_default`)
- `packages/db/src/schema/events.ts`, `packages/db/src/schema/send-events.ts` — Drizzle-схемы type-inference only; физический DDL живёт в миграциях

### Паттерн repeatable job и точки интеграции
- `apps/worker/src/queues/campaign-scheduler.worker.ts` — образец repeatable tick: `tickQueue.add(name, {}, { repeat: { every }, jobId })`
- `apps/worker/src/queues/analytics-reconciliation.worker.ts` — второй образец тика
- `apps/worker/src/server.ts` — единственная точка регистрации всех воркеров (`buildWorker()`); новый воркер добавляется сюда
- `.planning/ROADMAP.md` § Phase 12, заметка WRK-13 — предпочтение `upsertJobScheduler` со стабильным scheduler ID

### Инфраструктура Phase 8, на которую фаза опирается
- `.planning/phases/08-quality-gates-failure-injection-foundation/08-CONTEXT.md` — решения Phase 8: `packages/test-support` (консолидированный db-fixture, D-13), провижининг в `globalSetup` (D-09), migration-тесты (D-12), линтер миграций (D-30/31), env вне корня (D-27/28)
- `packages/db/src/__tests__/migrate-from-empty.test.ts` — migration-тест «с нуля», который увидит catch-up миграцию и вызов `ensurePartitions` из фикстуры

### Обязательные к обновлению документы
- `SPECIFICATION.md` — §2 (новых зависимостей не ожидается), §3 (новая env-переменная адреса оператора), §4 (catch-up миграция, таблица last-run), §5 (новая очередь/repeatable job), §7 (алерт-канал) — **в том же изменении**
- `ARCHITECTURE.md`, `CONVENTIONS.md` — binding update rule из Phase 8 (`.claude/CLAUDE.md`): новая очередь и фоновый процесс — это изменение границ/потоков

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Паттерн repeatable tick** (`campaign-scheduler.worker.ts`, `analytics-reconciliation.worker.ts`): регистрация `{ repeat, jobId }` при создании воркера — форма для `partition-maintenance.worker.ts`.
- **`packages/test-support`** (Phase 8): консолидированный db-fixture + провижининг эфемерных БД в `globalSetup` — точка, куда встраивается вызов `ensurePartitions` после миграций (D-05).
- **Платформенный отправитель** (`PLATFORM_SENDGRID_API_KEY` / `PLATFORM_MAIL_FROM`): уже шлёт verification/invite-письма из API — механизм для алерт-писем; воркеру понадобится доступ к тому же ключу (или отправка через API-сторожа).
- **Hand-written миграции 0007/0010/0020**: готовый прецедент партиционного DDL без drizzle-kit снапшота — форма для catch-up миграции (D-06).
- **Bull Board** уже подключён — failed maintenance job виден без новой инфраструктуры.

### Established Patterns
- Константы интервалов с комментарием-обоснованием и номером плана (конвенция vitest/worker-конфигов) — D-12 следует ей.
- Линтер миграций Phase 8 (expand/contract + unmarked destructive DDL) прогонит catch-up миграцию; `CREATE TABLE ... PARTITION OF` не деструктивен, маркеры не понадобятся.
- Воркер логирует через `console.log` (Pino — только в Phase 15, OPS-06): алерт не может полагаться на structured logs, отсюда email-канал (D-01).

### Integration Points
- `apps/worker/src/server.ts` — регистрация нового воркера в `buildWorker()`.
- `apps/api` — API-сторож (D-02): периодическая проверка last-run timestamp; естественное место — существующий механизм периодики API или лёгкий `setInterval` в бут-коде (решает planner).
- `packages/db` — `ensurePartitions`, catch-up миграция, схема таблицы last-run.
- Externally-resolved env-файл (`MEGA_CRM_ENV_FILE`) — новая переменная адреса оператора; `.env.example` обновить.

</code_context>

<specifics>
## Specific Ideas

- «Громко» определяется через push-канал, а не через лог: алерт обязан дойти до оператора, даже когда никто не смотрит в Bull Board. Единственный настоящий push-канал платформы сегодня — её собственный SendGrid-ключ.
- Мёртвая рука должна жить в **другом процессе**, чем то, за чем она следит: сторож в API-процессе следит за job'ом в воркер-процессе.
- Дедлайн закрывается артефактом деплоя (миграция), а не поведением рантайма (job) — job делает систему вечной, миграция делает 1 сентября безопасным.
- Тест и процедура — один код: автотест критерия 3 запускает тот же скрипт переноса, который запустит оператор.

</specifics>

<deferred>
## Deferred Ideas

- **Ограничение провайдерского `occurred_at` на входе** — Phase 13 (CMP-05); фаза 9 лишь не предполагает валидность значения.
- **Настоящий алертинг (Sentry, hosted logs, алерты по queue depth)** — Phase 15; email-канал этой фазы — мост до него, сигнал (буфер, DEFAULT-count, last-run) уже структурирован для переподключения.
- **Retention/удаление старых партиций** — Phase 14 (DB-11); эта фаза только создаёт и переносит, ничего не удаляет.
- **`/readyz`-интеграция статуса партиций** — Phase 14 (OPS-05) может читать тот же last-run timestamp, если захочет.

</deferred>

---

*Phase: 9-partition-automation-boundary-safety*
*Context gathered: 2026-08-06*
