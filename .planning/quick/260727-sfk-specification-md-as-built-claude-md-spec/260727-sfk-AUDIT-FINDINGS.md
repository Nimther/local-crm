GATE: PASS

## Method

Audited all ten sections of `SPECIFICATION.md` against the actual repository, section by
section, using `Read` with the offsets/limits supplied in the plan, plus targeted `Bash`
verification per section. Commands run (grouped by section):

**§1 Топология:** `ls apps packages`; `jq '.workspaces, .engines' package.json`; grep for
`listen`/port in `apps/api/src/server.ts`; `sed`/grep for the "no HTTP listener" comment block in
`apps/worker/src/server.ts`; full `cat docker-compose.yml`, `docker/init-app-role.sql`; `find`
for `Dockerfile*`, `.github/workflows`, other CI YAML.

**§2 Зависимости:** the plan's single `jq` dump command across
`package.json apps/api/package.json apps/worker/package.json apps/web/package.json
packages/*/package.json`; grep counts for `pino-http` under `apps/api/src` and `zustand` under
`apps/web/src`; grep for `nanoid` usage across `apps/api/src` (found in two files — confirmed one
is a comment, only `tenancy/workspaces.ts` has a real `import`); installed versions of
`typescript` and `drizzle-kit` from `node_modules/*/package.json`.

**§3 Секреты:** full read of `apps/api/src/env.ts` (byte count `wc -c` = 3998, matches spec);
`cat -n packages/kms/src/env.ts` (line numbers of `KMS_PROVIDER`/`KMS_LOCAL_KEK`/`KMS_KEK_ID`);
`sed -n` over `apps/worker/src/server.ts:48-73` for the three manual env checks and their exact
line spans; `sed -n '90,105p' apps/api/src/modules/tenancy/sendgrid-key.ts` for `maskKey`;
`sed -n '1,6p' .gitignore`; grep for `PgBouncer|pgbouncer` across `docker-compose.yml`, `docker/`,
`apps`, `packages`; grep for `TEST_DATABASE_URL|TEST_REDIS_URL|TEST_PUBLIC_APP_URL` restricted to
`vitest.config.ts` files; grep for `UNSUBSCRIBE_TOKEN_TTL_SECONDS` in both worker queue files;
grep for `workspace_sendgrid_keys`/`workspace_api_keys`/`path_token`/`public_key` column
definitions in `packages/db/migrations/*.sql`.

**§4 Схема данных:** `ls packages/db/migrations/*.sql | wc -l` (38) plus min/max numeric prefix
(0000..0037); `jq '{version,entries}' packages/db/migrations/meta/_journal.json` (version "7",
38 entries); `ls packages/db/migrations/meta/*_snapshot.json | wc -l` (11, matching the named
list); `grep -rh 'ENABLE ROW LEVEL SECURITY'` deduplicated by table name (23 raw hits → 22 unique
tables, one hit is inside a SQL comment — the plan's own calibration example, reproduced) cross-
checked against `FORCE ROW LEVEL SECURITY` (22, same set); grep for every named index by exact
name across `packages/db/migrations/*.sql`; grep for `PARTITION OF` to confirm the four named
partitions (`events_2026_07/08`, `events_default`, `send_events_2026_07/08`, `send_events_default`);
full RLS-policy-variant classification: grepped every `CREATE POLICY workspace_isolation` /
`ALTER POLICY` block and separately every occurrence of the `NULLIF(current_setting(...))` guard
across all migration files, then diffed the resulting two 12/10-table sets against the spec's
§4.3 Variant A / Variant B lists — exact match, including `campaigns`' migration-0019 override
from bare-cast to NULLIF-guard.

**§5 Планировщик:** grep for `create*Worker(` imports in `apps/worker/src/server.ts` (13, in the
same order as the spec's §5.2 list); `cat packages/shared-schemas/src/queues.ts` for the 11
exported queue-name constants; grep for the two locally-declared tick-queue name constants
(`campaign-scheduler`, `analytics-reconcile`); grep for `concurrency` in
`email-broadcast.worker.ts` (5) and `email-triggered.worker.ts` (20); grep for each of the four
repeatable-interval constants and their `jobId` registration call, confirming the exact line
numbers cited in the spec's §5.1 table (106/105/117/183); `grep -rl 'attempts: 5'` across
`apps/api/src` and `apps/worker/src` (8 files, matching the §5.3 dedup-location list exactly).

**§6 Публичные точки входа:** full read of `apps/api/src/server.ts` (plugin registration order,
`{ global: false }` rate-limit config, helmet CSP directives, `maxParamLength: 1024`); full read
of the CORS/rate-limit block in `apps/api/src/modules/auth/plugin.ts`; grep for
`import fp from "fastify-plugin"` (only `auth/plugin.ts:21` — the other two `fastify-plugin`
string hits are prose comments explicitly saying "not fastify-plugin", not imports — a second
instance of the plan's calibration pattern); route-count grep
`grep -rhoE '\.(get|post|patch|put|delete|all)\([\"'\''`]' apps/api/src` → 85, matching §6.4's
"Всего в приложении 85 роутов"; grep for all nine `resolveWorkspaceMember` local-copy
declarations by file:line, matching the §6.4 list exactly; grep for the `rateLimit` config blocks
on `/v1/contacts`, `/v1/events`, and the two invite routes (100/1min, 100/1min, 10/1min, 10/1min);
`sed -n '35,82p' apps/api/src/modules/auth/access-control.ts` plus `grep -n` for the exact
`member`/`owner` role block line numbers (40–79); grep for the nine cited
`campaigns.routes.ts`/`flows.routes.ts` route-path line numbers (314–316 … 459–461), confirming
each path string sits one line below the cited range's start (consistent with a
`fastify.post(\n  "path",` two-line call shape); grep in `apps/api/src/modules/auth/auth.ts` for
`expiresIn`/`updateAge`/`generateId`/`requireEmailVerification`/`invitationExpiresIn` (all match).

**§7 Наблюдаемость:** grep for `bull-board` across every `package.json` (zero hits); `sed -n
'15,25p' apps/worker/src/server.ts` for the "future @bull-board wiring" comment at line 20;
grep for `pool.on("error"` in both `packages/tenant-context/src/index.ts` (present) and
`packages/db/src/index.ts` (absent).

**§8 Расхождения:** cross-checked every 8.1/8.2/8.3 row against the `GSD:stack-start`/
`GSD:stack-end` block in `.claude/CLAUDE.md` (already in context); confirmed `@fastify/jwt` and
`@bull-board/*` are absent from every `package.json`; confirmed the `events` table has no
`created_at` column (`occurred_at` + `received_at` only) via the `0007_events_partitioned.sql`
`CREATE TABLE` block.

**§9/§10:** read-only per the plan; §10's section-number routing was re-verified as part of Task
2 below (all of sections 2–8 still exist with the same numbers after Task 1's single correction).

**Not checked / limitations:** `.env`/`.env.example` cross-check for §3 was not performed — tool
permissions deny reading `.env*` paths in this environment. This is the plan's documented,
expected, non-blocking limitation; §3's verdict is issued as OK on the strength of
`apps/api/src/env.ts` and `packages/kms/src/env.ts` alone, per the plan's explicit instruction.
Full commit-history audit of `.env` was not performed (spec itself already flags this as
unaudited, not a gap introduced by this pass).

## Verdicts

| Section | Title | Status |
|---|---|---|
| §1 | Топология | CORRECTED |
| §2 | Зависимости и версии | OK |
| §3 | Секреты | OK |
| §4 | Схема данных | OK |
| §5 | Планировщик и пайплайн отправки | OK |
| §6 | Публичные точки входа | OK |
| §7 | Наблюдаемость | OK |
| §8 | Расхождения с Technology Stack | OK |
| §9 | Сводка вопросов к ревью | OK |
| §10 | Поддержание документа | OK |

## Corrections applied

**1. [§1] Wrong line reference for the worker's "no HTTP listener" comment**
- **Found during:** Task 1, §1 verification of `apps/worker/src/server.ts`.
- **Issue:** The claim itself ("HTTP-листенера нет") is true, but the cited location
  `apps/worker/src/server.ts:46-47` points at the closing two lines of the doc-comment block
  (` * server.` / ` */`), not the sentence that actually states "No HTTP listener". That sentence
  spans lines 45-46 (` * No HTTP listener; this is a long-running background process, not a` /
  ` * server.`).
- **Fix:** Changed the cited range from `:46-47` to `:45-46` in the table cell under §1.1
  (the `worker` process row).
- **Evidence:** `Read apps/worker/src/server.ts` offset 40 limit 12 — line 45 reads "No HTTP
  listener; this is a long-running background process, not a", line 46 reads "server.".
- **Files modified:** `SPECIFICATION.md`.
- **Commit:** recorded in Task 3's combined commit (this correction is not committed separately;
  see the Task 3 commit for the actual hash).

## Not corrected

No other divergences of any kind were found across sections 2 through 10. Every literal checked —
every package version, unused-dependency claim, env-var name and validation rule, file:line
citation, table/column/enum/index/partition name, RLS policy variant classification (the full
12-table/10-table split was independently re-derived from the migrations and matches exactly,
including the `campaigns` migration-0019 override), worker/queue name and count, route count (85,
independently re-derived), `resolveWorkspaceMember` copy count and locations, role-matrix
permission set, and CLAUDE.md-vs-code discrepancy row — matched the document exactly. Two naive
greps that looked like they contradicted the spec were investigated per the plan's calibration
guidance and confirmed to be false positives, not spec defects:

- `grep -rn "fastify-plugin" apps/api/src` returns 3 files, which looks like it contradicts the
  spec's claim that `fastify-plugin` is used only in `auth/plugin.ts:21`. It does not: the other
  two hits (`unsubscribe.routes.ts`, `webhooks.routes.ts`) are prose comments that say "not
  fastify-plugin" — there is no `import fp from "fastify-plugin"` outside `auth/plugin.ts`.
- `grep -rln nanoid apps/api/src` returns 2 files, which looks like it contradicts the spec's
  claim that `tenancy/workspaces.ts` is nanoid's sole usage. It does not: `auth.ts:58` only
  mentions "nanoid" inside a comment contrasting it with better-auth's own ID generator; the only
  real `import { nanoid } from "nanoid"` is in `tenancy/workspaces.ts`.
