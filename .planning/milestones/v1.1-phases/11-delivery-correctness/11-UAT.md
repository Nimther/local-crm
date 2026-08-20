---
status: complete
phase: 11-delivery-correctness
source: [11-01-SUMMARY.md, 11-02-SUMMARY.md, 11-03-SUMMARY.md, 11-04-SUMMARY.md, 11-05-SUMMARY.md, 11-06-SUMMARY.md, 11-07-SUMMARY.md, 11-08-SUMMARY.md, 11-09-SUMMARY.md, 11-10-SUMMARY.md, 11-11-SUMMARY.md]
started: 2026-08-09T20:21:00Z
updated: 2026-08-09T20:39:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Холодный старт (Cold Start Smoke Test)
expected: |
  Останови все процессы и запусти проект с нуля (`npm run dev`). predev-цепочка
  (`check-env` → `ensure-db-roles` → `migrate-dev`) проходит без ошибок; новые миграции
  0047–0052 применяются; api/web/worker поднимаются; `send-reconciler` воркер регистрируется
  без ошибок; watchdog в API-процессе стартует; журнал отправок открывается и отдаёт данные.
result: pass

### 2. Новые статусы в журнале отправок видны и фильтруются
expected: |
  Открой журнал отправок. В фильтре статусов присутствуют «Уточняется» (`reconciling`) и
  «Исход неизвестен» (`unknown`). Оба рендерятся янтарным (amber), не красным и не зелёным.
  Выбор каждого фильтра отдаёт только строки с этим статусом.
  Замечание: если в базе нет таких строк, фильтры всё равно должны присутствовать
  и отдавать пустой результат без ошибки.
result: pass
retest: "Повторно проверено пользователем 2026-08-09 после фикса cc1eb9a — две группы «Доставка»/«Неоднозначные», оба статуса видны без скролла и фильтруют."
first_run: "issue — «в фильтре нет этих пунктов» → уточнено: «видны при скролле» (severity minor, gap G-11-2, исправлено inline)"

### 3. Тестовое письмо не заявляет неподтверждённый исход
expected: |
  Отправь тестовое письмо из панели кампании. Тост говорит «Тестовое письмо поставлено
  в очередь на {email}» — именно «в очередь», НЕ «отправлено». Маршрут отвечает 202 до
  любого обращения к SendGrid, поэтому UI не должен утверждать факт отправки.
result: pass

### 4. ARCHITECTURE.md §9 — ревью design-артефакта (D-18)
expected: |
  Раздел 9 документирует state machine, writer-матрицу и delivery-модель публикуемым языком
  и совпадает с `send-state-machine.ts` строка-в-строку.
result: pass
source: automated
coverage_id: D2
reason: "Одобрено пользователем на чекпойнте плана 11-01 в сессии выполнения фазы (2026-08-09): writer-матрица, отсутствие `reconciling → failed` и формулировка DLV-07 были показаны и подтверждены ответом «approved». Расхождение mermaid-самопетли `unknown → unknown` было отдельно озвучено и осознанно оставлено."

### 5. Дневные rollup'ы продолжают исключать `unknown` из sent/failed
expected: |
  Строка со статусом `reconciling` или `unknown` не двигает ни один счётчик дневного rollup'а;
  `delivered_at IS NOT NULL` считается независимо от статуса.
result: pass
source: automated
coverage_id: D6
reason: "Покрыто тестом из плана 11-02 — `apps/worker/src/queues/__tests__/rollup-enum-migration-invariant.test.ts` (2/2 passed, проверено 2026-08-09): «a bare 'reconciling' row must not move any rollup count», «a bare 'unknown' row must not move any rollup count either», «delivered_at IS NOT NULL must count regardless of status». В 11-10-SUMMARY.md запись D6 имела пустой `verification: []` только потому, что покрывающий тест лежит в файле другого плана — это отсутствующая перекрёстная ссылка, а не непроверенное утверждение."

## Summary

total: 5
passed: 5
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

- gap_id: G-11-2
  truth: "Журнал отправок предлагает «Уточняется» (reconciling) и «Исход неизвестен» (unknown) в фильтре статусов — и они видны без скролла"
  status: resolved
  resolved_by: "cc1eb9a fix(11): G-11-2 group ambiguous send statuses so the filter reveals them (inline UAT fix, 2026-08-09)"
  resolved_at: 2026-08-09
  reason: "User reported: «в фильтре нет этих пунктов»; после проверки уточнил — «видны при скролле». Опции существуют и рендерятся, но обрезаны по высоте списка, поэтому маркетолог их не находит."
  severity: minor
  test: 2
  root_cause: "`CommandList` (`apps/web/src/components/ui/command.tsx:61`) имеет `max-h-[300px] overflow-y-auto`. План 11-10 добавил `reconciling`/`unknown` в КОНЕЦ `STATUS_OPTIONS`, доведя список до 11 пунктов (~11 x 32px + 8px padding ≈ 360px), т.е. ~60px переполнения — ровно два последних пункта уходят под фолд. cmdk не даёт визуального признака, что список скроллится, поэтому пункты выглядят отсутствующими. Функционально фильтр работает: после скролла оба пункта выбираются и фильтруют корректно."
  artifacts:
    - path: "apps/web/src/features/send-log/SendLogPage.tsx"
      issue: "STATUS_OPTIONS (строки 82-94): два новых статуса добавлены в конец списка из 11 пунктов, который не влезает в max-h-[300px]; PopoverContent w-64 без индикации скролла"
    - path: "apps/web/src/components/ui/command.tsx"
      issue: "CommandList жёстко ограничен max-h-[300px] (строка 61) — общий компонент, менять с осторожностью: используется и другими фичами"
  missing:
    - "Сделать два новых статуса обнаружимыми без скролла — например: сгруппировать «неоднозначные» статусы в отдельную CommandGroup с заголовком выше по списку, либо поднять высоту именно этого PopoverContent/CommandList (локально, не в общем ui/command.tsx), либо добавить видимую индикацию скролла"
    - "Не менять max-h в общем `ui/command.tsx` без проверки остальных потребителей CommandList"
  debug_session: ""
  fix: "Две CommandGroup с заголовками «Доставка» / «Неоднозначные» + локальный max-h-[460px] на этом PopoverContent (общий ui/command.tsx НЕ тронут — от его 300px зависят 6 других фич). STATUS_OPTION_GROUPS выводится из STATUS_OPTIONS фильтром по AMBIGUOUS_STATUSES, не дублируется руками; 3 новых ассерта в send-log-status-vocabulary.test.ts фиксируют, что группы покрывают каждый статус ровно один раз. apps/web 52/52, lint/build чисто."
  note: "Диагностировано в ходе UAT (2026-08-09) — отдельная debug-сессия не потребовалась: причина установлена чтением кода и подтверждена пользователем через скролл."

## Notes

47 из 49 deliverables по всем 11 планам детерминированно покрыты проходящими тестами
(`uat classify-coverage`, mode `coverage`) и не выносятся на ручную проверку.
Два `human_judgment`-пункта (D2 из 11-01, D6 из 11-10) разрешены выше с указанием
конкретного источника подтверждения.

Тесты 2 и 3 требуют запущенного приложения. Тест 1 (cold start) вставлен по правилу
workflow: фаза меняла `apps/api/src/server.ts`, `apps/worker/src/server.ts`,
`packages/db/migrations/*`, `packages/db/src/index.ts` — паттерны, при которых баги
проявляются только на чистом старте.

Открытая принятая техдолговая часть (не блокирует UAT, зафиксировано в 11-REVIEW.md):
WR-02 (raw throw в claim gate под узкой гонкой), WR-03 (мёртвый `{ kind: "failed" }`
в union), два Info-пункта, и устаревший doc-comment у `DispatchSendGateResult`.
