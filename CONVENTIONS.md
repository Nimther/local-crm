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
→ [`scripts/lint-migrations.mjs`](./scripts/lint-migrations.mjs), [`scripts/coverage-gate.mjs`](./scripts/coverage-gate.mjs), [`scripts/check-root-hygiene.mjs`](./scripts/check-root-hygiene.mjs)

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

**Both rules are enforced, not merely written.** The linter is [`scripts/lint-migrations.mjs`](./scripts/lint-migrations.mjs), run as `npm run lint:migrations`. The wording above quotes what it accepts; the fixtures it is proven against are in [`tools/migration-fixtures/`](./tools/migration-fixtures/).

Adding a `NOT NULL` column with no default to a populated table is separately proven to be rejected by the incremental migration test, against a database that genuinely holds rows.
→ [`packages/db/src/__tests__/migrate-incremental.test.ts`](./packages/db/src/__tests__/migrate-incremental.test.ts)

## Partition maintenance

**Partition DDL has exactly one source.** Monthly partitions for a range-partitioned table (`events`, `send_events`) are created by `ensurePartitions` in `packages/db/src/partitions/ensure-partitions.ts`, never by a per-month migration. A migration is permitted to create partitions only once, as a one-time catch-up to a fixed horizon — migration `0038` is that exception, not a precedent for a second one. Every attach against a table that has a DEFAULT partition goes through the CHECK-constraint-first sequence (`NOT VALID` → `VALIDATE CONSTRAINT` → `ATTACH PARTITION` → `DROP CONSTRAINT`) **unconditionally**, whether the child being attached is empty or already holds rows, and that sequence exists in exactly one function. A second copy is the failure mode this rule exists to prevent: the copy that drifts from the reviewed original is the one that runs in production the day DEFAULT already has rows in it. A new partitioned table registers itself in the `PARTITIONED_TABLES` constant rather than growing its own maintenance path.
→ [`packages/db/src/partitions/ensure-partitions.ts`](./packages/db/src/partitions/ensure-partitions.ts), [`packages/db/src/partitions/relocate-default.ts`](./packages/db/src/partitions/relocate-default.ts) (reuses the same `attachPartitionCheckFirst`, does not reimplement it)

**A caller of `ensurePartitions`/`attachPartitionCheckFirst`/`runPartitionMaintenance` never hands it a tenant-scoped connection.** Attaching a partition that already holds rows makes Postgres re-validate the partitioned table's inherited foreign keys against the referenced table, and a connection recycled from a `withTenantTransaction`'s `SET LOCAL app.current_workspace_id` reverts that GUC to `''` (not `NULL`) for the rest of the connection's life — a bare-cast RLS policy on the referenced table then throws `invalid input syntax for type uuid: ""` regardless of what an admin-scan policy would otherwise permit. The rule is: keep a dedicated pool for this call path that has **never** run a tenant-scoped `SET LOCAL`, entirely separate from any `@mega-crm/tenant-context`-backed pool. Two independent plans in this phase (09-03, 09-04) hit this and fixed it identically, which is what makes it a rule rather than one test's incident.
→ [`packages/db/src/partitions/__tests__/relocate-default.test.ts`](./packages/db/src/partitions/__tests__/relocate-default.test.ts), [`packages/db/src/partitions/__tests__/ensure-partitions.test.ts`](./packages/db/src/partitions/__tests__/ensure-partitions.test.ts)

**A BullMQ tick that must run at a fixed wall-clock hour registers through the job-scheduler form (`upsertJobScheduler`) with a stable scheduler id and an explicit timezone; a tick that only needs a cadence may keep the interval form (`repeat: { every }`).** The distinction matters because a fixed hour is what lets a separate watchdog reason about staleness against a concrete threshold — "more than 26 hours since the last run" only means something if the run is expected at a known hour, not at a boot-relative offset that drifts with every restart. The four pre-existing interval-form ticks (`analytics-reconciliation`, `campaign-scheduler`, `flow-reconciliation`, `flow-segment-sweep`) are deliberate precedent, not drift — none of them is watched by a separate staleness check, so none of them needed the fixed-hour form, and a future reader should not "unify" them onto the job-scheduler form without a reason that actually requires it.
→ [`apps/worker/src/queues/partition-maintenance.worker.ts`](./apps/worker/src/queues/partition-maintenance.worker.ts) (job-scheduler form), [`apps/worker/src/queues/campaign-scheduler.worker.ts`](./apps/worker/src/queues/campaign-scheduler.worker.ts) (interval form, deliberate precedent)

---

## Forward-looking — not yet conventions

Named with the phase that establishes them, so nothing here reads as a current rule.

- **Phase 10** unifies the two RLS policy variants. Until then, both forms exist in the schema and which one a table carries is a fact to look up, not a convention to follow.
- **Phase 13** adds content-based secret scanning. The current working-root check is name-based and non-recursive by design — see [`scripts/check-root-hygiene.mjs`](./scripts/check-root-hygiene.mjs).
- **Phase 15** defines how these processes are built and run outside a developer machine. There is no convention for deployment artifacts yet because there are none.
