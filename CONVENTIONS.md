# Conventions

How to write more of this codebase. [`SPECIFICATION.md`](./SPECIFICATION.md) records what exists; [`ARCHITECTURE.md`](./ARCHITECTURE.md) records why it is shaped that way; this file records the rules for adding to it.

**Every convention below is followed by a file in this repository that demonstrates it.** A convention nobody follows is a wish. If a rule here has no example, it does not belong here.

---

## Naming and module structure

**A workspace exports its source directly.** `main` and `types` both point at `./src/index.ts`; there is no build step between packages. The tsconfig extends the base and includes only `src`.
→ [`packages/delivery-core/package.json`](./packages/delivery-core/package.json), [`packages/delivery-core/tsconfig.json`](./packages/delivery-core/tsconfig.json)

**The dependency arrow points app → package, never back.** Every `apps/*` manifest may depend on `@mega-crm/*`; no `packages/*` manifest depends on an app. When a package needs something app-specific, it takes it as a parameter instead — a path, a callback, a handle.
→ [`packages/test-support/src/harness/spawn-and-kill.ts`](./packages/test-support/src/harness/spawn-and-kill.ts) is generic over an entrypoint path precisely so [`apps/worker/src/test/harness/sigkill-entrypoint.ts`](./apps/worker/src/test/harness/sigkill-entrypoint.ts) can stay in the app.

**Migration filenames carry a zero-padded numeric prefix.** Filename order *is* application order, and lexicographic sorting only agrees with numeric order while every name is padded — `9_x.sql` would apply before `10_x.sql`. This is enforced, not merely documented: `listMigrationFiles` throws on an unpadded name.
→ [`packages/db/migrations/`](./packages/db/migrations/), [`packages/test-support/src/migration-runner.ts`](./packages/test-support/src/migration-runner.ts)

**A path used from more than one place is resolved by a function, not repeated as a literal.**
→ [`scripts/env-path.mjs`](./scripts/env-path.mjs) is the only decision about where configuration lives; eleven call sites use it.

**Gate scripts are Node-builtins-only, with a pure exported function and a CLI behind an `import.meta.url` guard.** That shape is what lets the logic be unit-tested with in-memory fixtures instead of temp files.
→ [`scripts/lint-migrations.mjs`](./scripts/lint-migrations.mjs), [`scripts/coverage-gate.mjs`](./scripts/coverage-gate.mjs), [`scripts/check-root-hygiene.mjs`](./scripts/check-root-hygiene.mjs), [`scripts/lint-session-state.mjs`](./scripts/lint-session-state.mjs)

**A phase branch is named `gsd/phase-{phase}-{slug}`, from Phase 9 onward.** The name is not decoration: the tooling resolves it from the template and checks it out, so a branch whose name does not match is one the tooling will migrate work off. Work merges to `master` through a pull request, which is where the three required checks apply.
→ [`.planning/config.json`](./.planning/config.json) — `git.branching_strategy` and `git.phase_branch_template`

**Phase 8's branch is `phase-08-quality-gates`, and that is a recorded exception, not drift.** It was created while the strategy was still `none`, and it keeps its name deliberately — renaming a branch that is already pushed, already CI-verified and already referenced by this phase's reports buys nothing. Do not "fix" it. The consequence to know about while working on it: because the name does not match the template, `gsd-tools query commit` and `query init.phase-op` check out the templated branch and commit there. On that branch, commit reports with plain `git`. No later phase has this problem.

## Test patterns

**Tests live in a `__tests__/` directory beside the code they cover.**
→ [`apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts`](./apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts)

**A test database is provisioned per run and never shared with development.** The suite's `globalSetup` creates an ephemeral database, guards the resolved connection string against the development one, publishes it, and drops it on teardown. There is no fallback from the test connection string to the development one — its absence is a hard error, not a default.
→ [`packages/test-support/src/global-setup.ts`](./packages/test-support/src/global-setup.ts), [`packages/test-support/src/db-fixture.ts`](./packages/test-support/src/db-fixture.ts)

**One mechanism applies migrations.** The fixture and the migration tests share the same primitives; nobody writes a second loop.
→ [`packages/test-support/src/migration-runner.ts`](./packages/test-support/src/migration-runner.ts)

**A fixture insert into an RLS-forced table runs inside a tenant scope.** A bare pool query is silently filtered to zero rows, which turns a test that appears to seed data into one that asserts over an empty table.
→ [`apps/worker/src/test/failure-fixtures.ts`](./apps/worker/src/test/failure-fixtures.ts)

**A test that pins behaviour a later phase will change says so in the file**, naming the phase, so the change is deliberate rather than read as a regression.
→ [`apps/worker/src/queues/__tests__/failure-injection/timeout.test.ts`](./apps/worker/src/queues/__tests__/failure-injection/timeout.test.ts), [`packages/tenant-context/src/__tests__/tenant-context.test.ts`](./packages/tenant-context/src/__tests__/tenant-context.test.ts)

**Named failure modes are tracked by name, not by a coverage percentage.** A percentage measures which lines ran, not which failure modes were reproduced.
→ [`docs/failure-injection-scenarios.md`](./docs/failure-injection-scenarios.md)

## The escape-hatch policy

The same shape in all three places an exception can be made. This is **one principle, not three coincidences**: an exception must be scoped to the single site it applies to, name the specific thing it excepts, and carry a reason. Blanket forms are forbidden everywhere, because a blanket exception silently grows to cover things nobody examined.

| Where | Permitted form | Forbidden |
|---|---|---|
| Lint | `// eslint-disable-next-line <rule> -- <reason>` | a file-level disable, or one naming no rule |
| Destructive DDL | `-- destructive: <reason>` on the line immediately before the statement | a file-header marker covering the whole migration |
| Coverage | narrowing the measured scope with a recorded reason | lowering the recorded threshold |

Rule-level lint exceptions — the case where a rule genuinely does not fit the codebase — are registered separately with their violation count and reason at the time of the decision, so a reviewer can ask whether the exception still holds.
→ [`docs/lint-rule-exceptions.md`](./docs/lint-rule-exceptions.md), [`eslint.config.js`](./eslint.config.js)

The coverage row has teeth: lowering the recorded threshold is a failing check with no permitted margin.
→ [`scripts/coverage-ratchet.mjs`](./scripts/coverage-ratchet.mjs)

## Expand/contract

**Binding rule.** A migration that adds an enum value ships, and is confirmed applied, **before** any migration or application code references that value. Postgres refuses to let a freshly-added enum value be used inside the transaction that added it, and each migration file here is applied as one statement batch — so an add-and-use in a single file fails at deploy time, not at review time.

In practice that means: migration N adds the value → deploy N → confirm applied → migration N+1 and the code that uses it.

**Destructive DDL carries a reason-bearing marker on the immediately preceding line.** The accepted form is exactly:

```sql
-- destructive: <reason>
ALTER TABLE "contacts" DROP COLUMN "legacy_external_id";
```

The marker must be a single-line SQL comment beginning `-- destructive:` followed by non-empty text. Blank lines between the marker and the statement are tolerated; a marker in the file header is not — that is the blanket form the escape-hatch policy forbids. Destructive DDL means dropping a column, or adding a `NOT NULL` column with no default.

**A drizzle statement delimiter appears only at a statement boundary — never inside prose.** The delimiter `--> statement-breakpoint` has exactly two accepted placements, both of them what `drizzle-kit generate` emits: alone on its own line (leading indentation tolerated), or immediately after a completed statement's `;` (`ALTER TABLE ... ON UPDATE no action;--> statement-breakpoint`). Anything else — text following it on the same line, or a prefix that is not a completed statement — is a violation.

**Reason.** `readMigrationFiles` (`drizzle-orm/migrator.js`) splits every migration with a plain `query.split("--> statement-breakpoint")` over the **raw file bytes**: no comment awareness, no quote awareness, no trimming, no empty-chunk filtering. `PgDialect.migrate` then executes each resulting chunk verbatim. Because the delimiter is *itself* a `--` comment, it hides inside another comment while remaining fully active as a delimiter — which is exactly how migration `0057` shipped a comment discussing the convention, split mid-sentence, and failed with ``42601: syntax error at or near "`"`` on a chunk that began with a bare backtick. A migration comment that needs to name this convention writes it without the arrow, as `statement-breakpoint`.

The corollary is that **a hand-written migration carries zero delimiters and applies as one chunk.** This repo applies each migration file as a single statement batch, and multi-statement single chunks are proven to work — migration `0020` applies eight statements that way. So the fix for an accidental split is always to remove the split point, never to add real delimiters around it.

**All three rules are enforced, not merely written.** The linter is [`scripts/lint-migrations.mjs`](./scripts/lint-migrations.mjs), run as `npm run lint:migrations`. The wording above quotes what it accepts; the fixtures it is proven against are in [`tools/migration-fixtures/`](./tools/migration-fixtures/).

Adding a `NOT NULL` column with no default to a populated table is separately proven to be rejected by the incremental migration test, against a database that genuinely holds rows.
→ [`packages/db/src/__tests__/migrate-incremental.test.ts`](./packages/db/src/__tests__/migrate-incremental.test.ts)

## Session state is transaction-local only

**Binding rule.** Session state set on a pooled `pg` connection is transaction-local, never connection-scoped. The accepted forms are the `LOCAL` assignment qualifier (`SET LOCAL <name> = <value>`) and `set_config(name, value, true)` -- the third argument must be the literal `true`. Role switching is not used at all in this codebase, in any form: cross-tenant access (the admin-scan pool, `withCrossWorkspaceScan`) is a separate connection under a separate least-privilege login role, never a `SET ROLE` / `SET SESSION AUTHORIZATION` on an existing one.

**Reason.** A connection-scoped assignment (`SET` with no `LOCAL`, or `set_config(..., false)`/`set_config(..., <2 args>)`) survives COMMIT/ROLLBACK and leaks into the next request or job that reuses the same connection when it is returned to the pool. **Phase 14 (D-09) deliberately deferred PgBouncer** rather than shipping it — the connection budget backing that deferral lives in [`ARCHITECTURE.md` §14](./ARCHITECTURE.md), and the revisit trigger is real connection pressure against that table's numbers, not a fixed phase. If PgBouncer's transaction-mode pooling is ever adopted, connection reuse becomes both more frequent and less predictable than the current session-mode pooling — a violation that is harmless today would become a cross-tenant leak the day that ships, which is exactly why this rule is enforced now rather than deferred alongside the pooler itself.

**The rule is enforced, not merely written.** The checker is [`scripts/lint-session-state.mjs`](./scripts/lint-session-state.mjs), run as `npm run lint:session-state`, in the `static` CI job. It recursively walks `apps/api/src`, `apps/worker/src`, `packages/*/src`, and `packages/db/scripts` -- enumerated from the filesystem, not hand-listed -- and is proven against fixtures in [`scripts/__fixtures__/session-state/`](./scripts/__fixtures__/session-state/): `violating.ts` (three distinct violations, one per rule) and `compliant.ts` (every accepted form, plus a documented exception).

**The exception marker.** A single-line `// session-state-exception: <reason>` comment on the line immediately preceding a statement suppresses only that statement -- the same "no blanket file-header suppression" shape as the destructive-DDL marker above. A marker with no reason after the colon does not suppress. Documented in full, with the format a reviewer should expect, in [`docs/lint-rule-exceptions.md`](./docs/lint-rule-exceptions.md).

## Partition maintenance

**Partition DDL has exactly one source.** Monthly partitions for a range-partitioned table (`events`, `send_events`) are created by `ensurePartitions` in `packages/db/src/partitions/ensure-partitions.ts`, never by a per-month migration. A migration is permitted to create partitions only once, as a one-time catch-up to a fixed horizon — migration `0038` is that exception, not a precedent for a second one. Every attach against a table that has a DEFAULT partition goes through the CHECK-constraint-first sequence (`NOT VALID` → `VALIDATE CONSTRAINT` → `ATTACH PARTITION` → `DROP CONSTRAINT`) **unconditionally**, whether the child being attached is empty or already holds rows, and that sequence exists in exactly one function. A second copy is the failure mode this rule exists to prevent: the copy that drifts from the reviewed original is the one that runs in production the day DEFAULT already has rows in it. A new partitioned table registers itself in the `PARTITIONED_TABLES` constant rather than growing its own maintenance path.
→ [`packages/db/src/partitions/ensure-partitions.ts`](./packages/db/src/partitions/ensure-partitions.ts), [`packages/db/src/partitions/relocate-default.ts`](./packages/db/src/partitions/relocate-default.ts) (reuses the same `attachPartitionCheckFirst`, does not reimplement it)

**A caller of `ensurePartitions`/`attachPartitionCheckFirst`/`runPartitionMaintenance` never hands it a tenant-scoped connection.** Attaching a partition that already holds rows makes Postgres re-validate the partitioned table's inherited foreign keys against the referenced table, and a connection recycled from a `withTenantTransaction`'s `SET LOCAL app.current_workspace_id` reverts that GUC to `''` (not `NULL`) for the rest of the connection's life — a bare-cast RLS policy on the referenced table then throws `invalid input syntax for type uuid: ""` regardless of what an admin-scan policy would otherwise permit. The rule is: keep a dedicated pool for this call path that has **never** run a tenant-scoped `SET LOCAL`, entirely separate from any `@mega-crm/tenant-context`-backed pool. Two independent plans in this phase (09-03, 09-04) hit this and fixed it identically, which is what makes it a rule rather than one test's incident.
→ [`packages/db/src/partitions/__tests__/relocate-default.test.ts`](./packages/db/src/partitions/__tests__/relocate-default.test.ts), [`packages/db/src/partitions/__tests__/ensure-partitions.test.ts`](./packages/db/src/partitions/__tests__/ensure-partitions.test.ts)

**A BullMQ tick that must run at a fixed wall-clock hour registers through the job-scheduler form (`upsertJobScheduler`) with a stable scheduler id and an explicit timezone; a tick that only needs a cadence may keep the interval form (`repeat: { every }`).** The distinction matters because a fixed hour is what lets a separate watchdog reason about staleness against a concrete threshold — "more than 26 hours since the last run" only means something if the run is expected at a known hour, not at a boot-relative offset that drifts with every restart. The four pre-existing interval-form ticks (`analytics-reconciliation`, `campaign-scheduler`, `flow-reconciliation`, `flow-segment-sweep`) are deliberate precedent, not drift — none of them is watched by a separate staleness check, so none of them needed the fixed-hour form, and a future reader should not "unify" them onto the job-scheduler form without a reason that actually requires it.
→ [`apps/worker/src/queues/partition-maintenance.worker.ts`](./apps/worker/src/queues/partition-maintenance.worker.ts) (job-scheduler form), [`apps/worker/src/queues/campaign-scheduler.worker.ts`](./apps/worker/src/queues/campaign-scheduler.worker.ts) (interval form, deliberate precedent)

## Deployment

**Every Postgres pool goes through the factory, never constructed directly.** `createPgPool(options)` is the single place a first-party production `pg.Pool` is built — it attaches an unconditional, redaction-routed error listener, resolves TLS from the connection string alone (see the next rule), and names an explicit size. A pool built with a bare `new Pool(...)` has no error listener by default, so an idle-connection drop that a healthy pool would simply log instead crashes the whole process on the first occurrence — the exact failure this rule exists to prevent from recurring after the phase that fixed it moves on.

**Reason.** Before this rule was enforced, two of this codebase's Postgres pools had gone their entire lifetime with no error listener at all, discovered only when a phase specifically audited for it — a silent gap that had already survived multiple prior reviews. A convention that depends on every future pool-construction site remembering to copy the pattern by hand is the same class of risk RLS's own "don't rely on every engineer remembering the filter" rule already rejects elsewhere in this document.

**The rule is enforced, not merely written.** The gate is [`scripts/lint-pg-pool-factory.mjs`](./scripts/lint-pg-pool-factory.mjs), run as `npm run lint:pg-pool-factory` in the `static` CI job — it fails on any bare `new Pool(...)` construction found anywhere in first-party production source, proven against fixtures in [`scripts/__fixtures__/pg-pool-factory/`](./scripts/__fixtures__/pg-pool-factory/).
→ [`packages/db/src/pool.ts`](./packages/db/src/pool.ts)

**TLS for a Postgres connection is driven by the connection string alone, never by a separately-constructed options object.** `createPgPool` never builds an `ssl` config object of its own — every TLS decision `pg`/`pg-connection-string` will ever make for a given connection is already encoded in the DSN (`sslmode=`, `sslrootcert=`, and the rest of that query-string vocabulary), and that is the only input this codebase supplies.

**Reason.** The installed `pg-connection-string` version's own resolution order lets a query-string parameter silently win over anything an `ssl` object would otherwise have asserted — confirmed by reading that package's source directly, not assumed from documentation. Code that constructs both a DSN and a separate `ssl` object can therefore believe it configured a TLS posture (say, disabling certificate verification for a self-signed cert) that the connection string quietly overrides the moment both are present, and the failure is invisible until a connection either fails unexpectedly or succeeds with a posture nobody intended. Driving TLS from exactly one input eliminates the disagreement by construction rather than by discipline.
→ [`packages/db/src/pool.ts`](./packages/db/src/pool.ts), [`docker/postgres/prod-tls-entrypoint.sh`](./docker/postgres/prod-tls-entrypoint.sh)

**A container's stop-grace-period is derived from the published constant, never hand-typed.** `WORKER_STOP_GRACE_PERIOD_SECONDS` (§10's drain budget, [`ARCHITECTURE.md`](./ARCHITECTURE.md)) is the one number a container orchestrator's stop-grace setting is allowed to come from — never a literal written directly into a compose file or a deploy script.

**Reason.** The published constant is itself derived from the SendGrid call timeout plus both transaction margins plus a safety margin — every one of those inputs can change as the send pipeline evolves, and a hand-typed grace period would silently stop agreeing with the actual drain time the moment any of them did, with no signal that it had drifted. Docker's own unconfigured default (10s) is already shorter than the SendGrid timeout alone, which is the failure mode a hand-typed *or default* value both leave open.
→ `docker/docker-compose.prod.yml`'s `worker.stop_grace_period: ${WORKER_STOP_GRACE_PERIOD_SECONDS}s` is the interpolation site; `scripts/print-stop-grace-period.mjs` is the publish script `scripts/deploy.sh` resolves it from at deploy time.

**The rule is enforced, not merely written, for the last two above.** [`scripts/validate-prod-compose.mjs`](./scripts/validate-prod-compose.mjs) (`npm run verify:prod-compose`, `static` CI job) fails the build if the compose file's resolved `stop_grace_period` ever disagrees with a fresh run of the publish script, and separately fails if `db`'s on-disk TLS entrypoint script ever stops setting `ssl=on` server-side — the machine check for the server half of the TLS rule; the DSN's own `sslmode=require&uselibpqcompat=true` query-string parameter is the client half, asserted by [`packages/db/src/__tests__/pg-tls.test.ts`](./packages/db/src/__tests__/pg-tls.test.ts) against a real negotiated connection rather than a compose-file grep.

---

## Forward-looking — not yet conventions

Named with the phase that establishes them, so nothing here reads as a current rule.

- **Phase 10** unifies the two RLS policy variants. Until then, both forms exist in the schema and which one a table carries is a fact to look up, not a convention to follow.
- **Phase 13** adds content-based secret scanning. The current working-root check is name-based and non-recursive by design — see [`scripts/check-root-hygiene.mjs`](./scripts/check-root-hygiene.mjs).
- **Phase 15** defines real alerting on top of the observability surfaces Phase 14 introduced (backup-check failures, the pgBackRest sidecar, and the existing watchdog channel), and Postgres `verify-full` TLS in place of the current self-signed interim posture (D-10) — deployment artifacts and their conventions now exist (see "Deployment" above); what remains open is what Phase 15 owns.
