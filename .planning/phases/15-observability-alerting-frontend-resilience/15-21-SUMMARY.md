---
phase: 15-observability-alerting-frontend-resilience
plan: 21
subsystem: docs
tags: [documentation, correlation, sentry, gap-closure, spec-drift]

requires:
  - phase: 15-observability-alerting-frontend-resilience
    provides: "sendId bound on all three send-dispatch paths (plan 15-19) and on the per-event webhook path (plan 15-20); the WR-03 requestId fix (commit eaaafe0) and the CR-01 Sentry env_file fix (commit 32d2b22), both from the phase's code-review-fix wave"
provides:
  - "ARCHITECTURE.md §18 rewritten to state the shipped correlation model: requestId genuinely unbound (not job.id-substituted) when a job payload carries none, and per-field presence/absence stated for workspaceId/requestId/jobId/sendId including sendId's post-15-19/15-20 boundaries"
  - "SPECIFICATION.md §7 overview and план-15-08 paragraph corrected to match, both stale claims removed with no restatement of the opposite falsehood"
  - "SPECIFICATION.md §3's three Sentry rows corrected to state env_file-only delivery (CR-01), each tagged план 15-21, with the IMAGE_TAG compose-interpolation exception preserved"
affects: []

tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - ARCHITECTURE.md
    - SPECIFICATION.md

key-decisions:
  - "Kept the плановая-tag convention lowercase (\"план 15-21\", not \"План 15-21\") to match SPECIFICATION.md's existing casing after the verify script's literal-match check caught a capitalization slip mid-task"
  - "Ran `npm run build -w apps/worker` before `npm run verify:prod-compose` -- the compose invariant check depends on a fresh worker build to resolve the expected stop-grace-period constant, unrelated to this plan's own doc edits but required for the plan's own verify step to pass; apps/worker/dist/ is gitignored so this produced no tracked diff"
  - "Left ARCHITECTURE.md §18's ALS/merge-forward paragraph, application_name paragraph, camelCase field-naming note and §7 pointer byte-unchanged, per the plan's explicit prohibition against touching accurate prose while fixing adjacent stale claims"

requirements-completed: [OPS-15, OPS-08]

coverage:
  - id: D1
    description: "ARCHITECTURE.md §18 no longer describes any requestId-to-jobId substitution and states genuine unbinding matching processor-wrapper.ts:196 post-WR-03, with a per-field correlation-coverage table replacing the prior universal four-field claim"
    requirement: "OPS-15"
    verification:
      - kind: other
        ref: "node one-liner (region-scoped over ARCHITECTURE.md ## 18 / ## 19 boundary): banned literals absent, required citations (processor-wrapper.ts, send-dispatch.ts, webhook-events.worker.ts, WR-03, req=-) all present"
        status: pass
      - kind: other
        ref: "grep -c 'falling back to the job' ARCHITECTURE.md == 0; grep -c 'the same four fields' ARCHITECTURE.md == 0 (whole-file)"
        status: pass
    human_judgment: false
  - id: D2
    description: "SPECIFICATION.md §7 carries no surviving copy of either stale claim -- the overview sentence and the план-15-08 wrapProcessor paragraph both corrected, план-15-19/15-20 paragraphs left intact"
    requirement: "OPS-15"
    verification:
      - kind: other
        ref: "node one-liner (region-scoped over SPECIFICATION.md ## 7 / ## 8 boundary): banned literals absent, план 15-21/15-19/15-20 and WR-03 all present"
        status: pass
      - kind: other
        ref: "grep -c 'иначе fallback' SPECIFICATION.md == 0; grep -c 'на КАЖДУЮ строку лога' SPECIFICATION.md == 0 (whole-file)"
        status: pass
    human_judgment: false
  - id: D3
    description: "SPECIFICATION.md §3's SENTRY_DSN_API/SENTRY_DSN_WORKER/SENTRY_ENVIRONMENT rows state env_file-only delivery matching docker-compose.prod.yml post-CR-01, each tagged план 15-21, with the IMAGE_TAG compose-interpolation exception noted and no secret value written"
    requirement: "OPS-08"
    verification:
      - kind: other
        ref: "node one-liner (region-scoped over SPECIFICATION.md ## 3 / ## 4 boundary): banned literals absent, all three rows name env_file + MEGA_CRM_ENV_FILE + план 15-21, IMAGE_TAG exception present"
        status: pass
      - kind: other
        ref: "grep -cE 'https://[0-9a-zA-Z]+@[a-z0-9.-]*(sentry|ingest)' SPECIFICATION.md == 0 (no DSN-shaped literal)"
        status: pass
      - kind: other
        ref: "node one-liner against docker/docker-compose.prod.yml: no non-comment SENTRY_DSN_API/SENTRY_DSN_WORKER/SENTRY_ENVIRONMENT assignment inside either service's environment: block"
        status: pass
      - kind: other
        ref: "npm run check:spec-env-coverage (53 names checked, all present)"
        status: pass
      - kind: other
        ref: "npm run verify:prod-compose (8 services, 43 invariants, all OK)"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-08-16
status: complete
---

# Phase 15 Plan 21: Gap closure G-15-2/G-15-3 — correlation-model and Sentry-delivery doc corrections Summary

**Rewrote ARCHITECTURE.md §18's requestId-derivation claim and its field-coverage overclaim to match the shipped, post-15-19/15-20 correlation model, and corrected SPECIFICATION.md's two stale echoes plus its three Sentry env-var rows to the CR-01 env_file-only delivery mechanism — closing both documentation gaps the phase verifier flagged, with zero behavioral files touched.**

## Performance

- **Duration:** 25 min
- **Tasks:** 2 completed
- **Files modified:** 2 (ARCHITECTURE.md, SPECIFICATION.md)

## Accomplishments

- ARCHITECTURE.md §18: the requestId-derivation sentence no longer says `wrapProcessor` falls back to `job.id` — it now states the WR-03 shipped behaviour (`processor-wrapper.ts:196`): the field stays genuinely unbound when the job payload carries none, with the reason (job.id-substitution collapsed two independent correlation axes into one) and the `req=-` placeholder fact both stated.
- ARCHITECTURE.md §18: the universal "same four fields on every log line" claim replaced with a per-field presence/absence table (`workspaceId`, `requestId`, `jobId`, `sendId`) stating exactly where each is bound and where it is not — including that `sendId` is bound in send-dispatch's three post-claim scopes and webhook-events' per-event scope (plans 15-19/15-20), but absent from `wrapProcessor`'s own completion/failure lines (AsyncLocalStorage continuation boundary) and from every `apps/api` line.
- SPECIFICATION.md §7 overview sentence corrected to describe scope-dependent field presence instead of per-line universality, pointing at the `### Correlation-модель` subsection for detail rather than restating it.
- SPECIFICATION.md §7's план-15-08 paragraph corrected: `wrapProcessor`'s requestId derivation parenthetical no longer says "иначе fallback на `job.id`" — it now states the field stays fully unbound, tagged `план 15-21`, citing the WR-03 fix and the `req=-` rendering.
- SPECIFICATION.md §3's three Sentry rows (`SENTRY_DSN_API`, `SENTRY_DSN_WORKER`, `SENTRY_ENVIRONMENT`) rewritten to state the CR-01 shipped mechanism — exclusively via `env_file: ${MEGA_CRM_ENV_FILE}`, absent from either service's `environment:` block — each tagged `план 15-21`, with the reason (compose-level `${VAR}` interpolation reads the invoking shell, not the secrets file, and `environment:` overrides `env_file:` for the same key) stated so a future contributor cannot silently re-add the CR-01 defect.
- `IMAGE_TAG`'s legitimate compose-level interpolation exception preserved and made explicit in the same edit, so a reader applying "move everything to env_file" uniformly does not also break the one interpolation that is correct.

## Before/After quotes

### ARCHITECTURE.md §18 — requestId-derivation sentence

**Before:**
> `apps/worker`'s own job-processing wrapper (`processor-wrapper.ts`) is what makes a BullMQ job carry a `requestId` at all: it opens a correlation scope keyed by `job.data.requestId` when the job schema carries one, falling back to the job's own id for jobs with no originating HTTP request.

**After:**
> `apps/worker`'s own job-processing wrapper (`processor-wrapper.ts`) is what makes a BullMQ job carry a `requestId` at all: `wrapProcessor` opens a correlation scope keyed by `job.data.requestId` when the job's schema declares one; when the payload carries none, the field stays genuinely unbound — no substitute value is put in its place (`processor-wrapper.ts:196`, the WR-03 fix). The substitution it replaced made `requestId` indistinguishable from `jobId` in every log line and Sentry tag for every queue except the two send lanes, collapsing what should be two independent correlation axes into one; `jobId` alone still carries job-level correlation on those jobs, and `composeApplicationName` already renders the unbound case as a `req=-` placeholder rather than an empty or malformed `application_name`.

### ARCHITECTURE.md §18 — field-coverage claim

**Before:**
> **Every log line in both processes carries the same four fields, without any call site passing them explicitly.** Both Pino instances (`apps/api/src/logger.ts`, `apps/worker/src/logger.ts`) install a `mixin()` that reads `getCorrelationContext()` on every log call — the correlation fields ride along automatically, and neither logger file declares its own list of what to attach.

**After (per-field table, abridged — see ARCHITECTURE.md ≈L367-398 for full text):**
> **The mechanism is uniform; which fields land on a given line is not.** ... What varies is not the mechanism but which scopes happen to be open at the point a given line is emitted:
> - `workspaceId` — bound by `withTenant`/`withTenantTransaction` ... absent on boot-time lines and API lines before a workspace is resolved.
> - `requestId` — bound once per HTTP request by the `onRequest` hook ... absent on jobs whose schema declares none.
> - `jobId` — bound by `wrapProcessor` for every job in every queue; never present on an `apps/api` line.
> - `sendId` — bound by the three post-claim dispatch scopes in `send-dispatch.ts` and the per-event scope in `webhook-events.worker.ts` ... NOT present on `wrapProcessor`'s own job-completed/job-failed lines (AsyncLocalStorage continuation boundary) ... Not present on any `apps/api` line either.
> A Loki query filtering on one of these fields returns the lines where that scope happened to be open — a real and useful subset, not every line the process emitted.

### SPECIFICATION.md §7 overview

**Before:**
> **Correlation-модель** — один набор идентификаторов (`requestId`/`jobId`/`sendId`/`workspaceId`), проставленный на КАЖДУЮ строку лога в обоих процессах и переживающий переход HTTP → BullMQ → Postgres.

**After:**
> **Correlation-модель** — один набор идентификаторов (`requestId`/`jobId`/`sendId`/`workspaceId`), переживающий переход HTTP → BullMQ → Postgres и привязываемый БЕЗ явной передачи ни на одном call site (единый механизм — `mixin()`, читающий `getCorrelationContext()`); какое именно поле присутствует на конкретной строке зависит от того, какой скоуп открыт в момент её отправки — см. `### Correlation-модель` ниже за полным пофилдовым разбором (план 15-21).

### SPECIFICATION.md §7 план-15-08 paragraph (wrapProcessor requestId derivation)

**Before:**
> (`requestId` — из `job.data.requestId`, если поле есть в схеме джобы, иначе fallback на `job.id` — репитабл-тик/webhook-джоба не имеет исходного HTTP-запроса)

**After:**
> (`requestId` — из `job.data.requestId`, если поле есть в схеме джобы, иначе поле остаётся ПОЛНОСТЬЮ непривязанным — без подстановки `job.id` вместо него; **план 15-21**: старый fallback на `job.id` убран WR-03-фиксом (`apps/worker/src/processor-wrapper.ts:196`), потому что он делал `requestId` неотличимым от `jobId` в каждой строке лога и Sentry-теге для любой очереди, кроме двух send-лейнов — `jobId` сам по себе по-прежнему несёт job-level корреляцию, а `composeApplicationName` рендерит непривязанный случай как плейсхолдер `req=-`, а не как пустое/некорректное значение — репитабл-тик/webhook-джоба не имеет исходного HTTP-запроса)

### SPECIFICATION.md §3 — three Sentry rows

**Before (`SENTRY_DSN_API` row's delivery clause):**
> Передаётся ЯВНО в `docker-compose.prod.yml`'s `api.environment` (не через неявный `env_file`-проброс)

**After (`SENTRY_DSN_API` row's delivery clause):**
> **план 15-21 (CR-01 fix):** передаётся ИСКЛЮЧИТЕЛЬНО через `env_file: { path: ${MEGA_CRM_ENV_FILE}, required: false }` на сервисе `api` в `docker-compose.prod.yml`; имя отсутствует в `api.environment`-блоке. Раньше значилось там же как compose-level `${VAR}`-интерполяция — тот механизм резолвится из окружения ВЫЗЫВАЮЩЕЙ shell (или `docker/.env`, которого в репозитории нет), не из `MEGA_CRM_ENV_FILE`; поскольку `environment:` перебивает `env_file:` для одного и того же ключа, а `scripts/deploy.sh` не экспортирует ни одно из трёх имён, старая форма безусловно затирала реальный DSN оператора пустой строкой на каждом деплое — молча отключая Sentry без единой ошибки.

`SENTRY_DSN_WORKER` and `SENTRY_ENVIRONMENT` rows received the equivalent mirrored correction (same mechanism, same `план 15-21` tag, same reasoning, referencing their own service/both services respectively). `IMAGE_TAG`'s row gained one appended sentence noting it is the sole exception (legitimately still compose-level interpolation, since `scripts/deploy.sh` does export it).

## Fix-commit confirmation

- `git show --stat eaaafe0` (WR-03): touched `apps/worker/src/processor-wrapper.ts` and three test files only. Neither `ARCHITECTURE.md` nor `SPECIFICATION.md` in the file list — confirms why §18/§7's requestId claim went stale.
- `git show --stat 32d2b22` (CR-01): touched `docker/docker-compose.prod.yml`, `docker/prod.env.example`, `apps/api/src/sentry.ts`, `apps/worker/src/sentry.ts`. Neither `SPECIFICATION.md` in the file list — confirms why §3's Sentry rows went stale.

## Per-field presence table (as now stated in ARCHITECTURE.md §18)

| Field | Bound by | Present | Absent |
|---|---|---|---|
| `workspaceId` | `withTenant`/`withTenantTransaction` | once a tenant scope is open | boot-time lines; API lines before a workspace is resolved |
| `requestId` | `apps/api/src/server.ts`'s `onRequest` hook; carried onto `email-broadcast` payload by the campaign test-send route; rebound by `wrapProcessor` | HTTP requests and jobs whose schema declares the field | jobs whose schema declares no such field (repeatable ticks, webhook-originated jobs) |
| `jobId` | `wrapProcessor` | every job in every queue | never on an `apps/api` line |
| `sendId` | three post-claim scopes in `send-dispatch.ts` (campaign/test/flow); per-event scope in `webhook-events.worker.ts` | dispatch lines and provider-event lines for a live send | `wrapProcessor`'s own job-completed/job-failed lines (ALS continuation boundary); every `apps/api` line |

## `git diff --stat` (plan-wide, both tasks)

```
ARCHITECTURE.md  | 55 +++++++++++++++++++++++++++++++++++++++++++++----------
SPECIFICATION.md | 18 +++++++++++-------
2 files changed, 56 insertions(+), 17 deletions(-)
```

Exactly the two files this plan's `<verification>` step 8 names — no `.ts`/`.tsx`/`.mjs`/`.yml`/`.yaml`/`.json` file changed.

## Task Commits

Each task was committed atomically:

1. **Task 1: Rewrite the correlation model in ARCHITECTURE.md §18 and its two stale echoes in SPECIFICATION.md §7** - `bb5914c` (docs)
2. **Task 2: Correct SPECIFICATION.md §3's three Sentry rows to the shipped env_file-only delivery** - `a2a3fe6` (docs)

## Files Created/Modified

- `ARCHITECTURE.md` - §18's requestId-derivation sentence and field-coverage claim rewritten; ALS/merge-forward paragraph, application_name paragraph, camelCase note, §7 pointer left byte-unchanged
- `SPECIFICATION.md` - §7 overview sentence and план-15-08 paragraph corrected; §3's three Sentry rows rewritten to env_file-only delivery with `план 15-21` tags; `IMAGE_TAG` exception sentence added; `план 15-19`/`план 15-20` paragraphs in §7 left untouched

## Decisions Made

- Kept the тег convention lowercase (`план 15-21`) after the verify script's literal-match check caught a capitalization slip (`План 15-21`) mid-task — SPECIFICATION.md's existing convention (`план 15-19`, `план 15-20`) is lowercase throughout, and the verify script's positive marker is case-sensitive.
- Ran `npm run build -w apps/worker` before `npm run verify:prod-compose`, since the compose-invariant script's stop-grace-period check depends on a fresh worker build to resolve the running container's actual constant (Pitfall 7's own documented reason) — unrelated to this plan's doc edits but required for this plan's own verify step to exit 0. `apps/worker/dist/` is gitignored, so this produced no tracked diff.
- Left every paragraph outside the two acceptance-criteria-scoped edits untouched, including §18's first three paragraphs and §7's два plan-tagged Correlation-модель paragraphs from plans 15-19/15-20 — confirmed byte-identical by direct read-back against the pre-edit file content.

## Deviations from Plan

None - plan executed exactly as written. One in-flight self-correction (not a deviation from required behavior): a first-pass edit used capitalized `**План 15-21**` in the three §3 rows; the plan's own verify script requires the literal lowercase `план 15-21` (matching this file's existing tag casing), so all three rows were corrected to lowercase before commit.

## Issues Encountered

`npm run verify:prod-compose` initially failed with `stop-grace-period-undeterminable`/`stop-grace-period-drift` because `apps/worker/dist/shutdown-budget.js` did not exist in this worktree (no prior build in this checkout). Resolved by running `npm run build -w apps/worker` once; all 43 invariants then passed. This is a pre-existing build-artifact gap in the worktree, not a defect introduced by this plan's doc-only edits, and produced no change to any tracked file.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Gaps G-15-2 and G-15-3 are closed. ARCHITECTURE.md §18 and SPECIFICATION.md §7/§3 now describe the post-gap-closure system (post plans 15-19/15-20, post commits eaaafe0/32d2b22), with no surviving stale claim in either document.
- Phase 15 plan sequence (gap-closure wave: 15-19, 15-20, 15-21) is now complete at the code and documentation level. No blockers for phase-level re-verification.

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-16*
