# Migration Rollback and Roll-Forward Runbook

Implements decision **D-15** (the rehearsal runs on every PR so it cannot
rot) and satisfies requirement **DB-07** ("процедура rollback / roll-forward
задокументирована и отработана" — documented AND rehearsed, not merely
described). The operator question this answers: **the deploy I just shipped
is bad — can I go back?**

There are no down migrations in this repository, and none are being added by
this runbook. "Can I go back" has two structurally different answers
depending on what the migration actually did, and confusing them is the
failure this runbook exists to prevent.

## The two tiers

Every shipped migration is classified into exactly one of two tiers in
`packages/db/src/migration-tiers.ts`'s `MIGRATION_TIERS` record — **this is
the one source of truth**; nothing in this runbook restates the
classification for any specific migration, because a second copy of the
same fact rots the first time someone adds a migration and forgets this
document.

- **`auto-reversible`** — a mechanical DDL inverse exists for everything the
  migration added (drop the table/column/index/constraint it added), and
  applying that inverse destroys nothing that existed **before** the
  migration ran. Rolling back is a **redeploy**: run the inverse DDL, mark
  the migration pending again, redeploy the previous image.
- **`forward-only`** — no such inverse exists. Reasons a migration lands
  here (see `migration-tiers.ts`'s own header comment for the full list with
  citations): it added an enum value, created/altered/dropped an RLS policy,
  attached a partition, dropped a column or constraint, ran an irreversible
  data mutation, or changed GRANT/REVOKE access-control posture. Rolling
  back is a **restore** — see [Forward-only recovery](#forward-only-recovery-restore-based)
  below.

`tierFor(tag)` throws for a tag it does not recognize, rather than guessing
— a guessed tier that happens to be wrong is exactly how an operator ends up
attempting a destructive "revert" on a migration that cannot be reverted.

## Determining which tier a deploy's migrations belong to

Given two deployed commit SHAs (the one you are on, and the one you would
roll back to):

1. Find the migration tags that shipped between them:

   ```bash
   git log --oneline <previous-sha>..<current-sha> -- packages/db/migrations/*.sql
   ```

   Each new `NNNN_name.sql` file's `NNNN_name` (minus the `.sql` extension)
   is its tag — the exact string `MIGRATION_TIERS` keys on.

2. Look up every one of those tags in `MIGRATION_TIERS`
   (`packages/db/src/migration-tiers.ts`):

   ```bash
   npx tsx -e '
     import { tierFor } from "./packages/db/src/migration-tiers.ts";
     console.log(tierFor("0062_member_unique_org_user"));
   '
   ```

   (Run from the repository root; `packages/db` is an ESM/TypeScript
   package with no build step, so `tsx` — already a `packages/db`
   devDependency — is what resolves it directly, the same way every other
   `tsx scripts/*.ts` command in this repository does.)

   (Or open the file and read the record directly — it is a plain object,
   one line per migration, with the reason in a trailing comment.)

3. **If every tag in that set is `auto-reversible`**, this is a redeploy —
   follow [Auto-reversible procedure](#auto-reversible-procedure) below.
4. **If even one tag is `forward-only`**, this is a restore — follow
   [Forward-only recovery](#forward-only-recovery-restore-based) below. A
   mixed set (some auto-reversible, some forward-only) is still a restore:
   there is no partial-rollback path that reverts only the reversible half
   while leaving a forward-only change in place, because the forward-only
   change is exactly the one you cannot undo with DDL.

## Auto-reversible procedure

This is exactly what `packages/db/src/__tests__/migration-rollback-
rehearsal.test.ts` does, on every PR, against an ephemeral database it
provisions and destroys itself — the commands below are the same
operations, run by hand against the real target.

1. **Identify the trailing auto-reversible run.** `newestAutoReversibleTier()`
   (also in `migration-tiers.ts`) returns the contiguous run of
   auto-reversible tags at the end of the shipped history. If the migrations
   you are rolling back are exactly this run (the common case — you are
   rolling back the deploy you JUST shipped), you can call it directly. If
   you are rolling back further, apply this procedure once per migration in
   the chain, newest first, confirming each one is still `auto-reversible`
   as you go.

2. **Apply the inverse DDL for each migration, newest first.** The inverse
   for a specific migration is NOT auto-generated — it is a hand-verified
   statement, read directly off that migration's own SQL, recorded in
   `MIGRATION_INVERSES` inside `migration-rollback-rehearsal.test.ts`. Look
   up the tag there and run the same statement(s) against the real target
   database. If a tag you need is not in `MIGRATION_INVERSES`, **stop** — an
   unregistered inverse for a tag classified `auto-reversible` means nobody
   has hand-verified it is safe yet; treat this the same way the rehearsal
   test does (a loud failure, not a guess), and get the inverse written and
   reviewed before proceeding.

3. **Mark the migration(s) pending again** by deleting their row(s) from
   `"drizzle"."__drizzle_migrations"`, matched on `created_at` equal to the
   migration's own `when` value in `packages/db/migrations/meta/_journal.json`:

   ```sql
   DELETE FROM "drizzle"."__drizzle_migrations" WHERE created_at = <when-value-from-journal>;
   ```

4. **Redeploy the previous container image.** The previous image's code no
   longer expects the schema change that migration made, and the schema no
   longer has it — the two are back in agreement.

5. **Roll forward again later** (if the fix is ready) by deploying the new
   image and letting `npm run migrate:prod`
   (`scripts/migrate-runner.mjs`, plan 14-01) re-apply the migration
   normally — it is now pending again, so the ordinary deploy-time migrate
   step picks it up with no special handling.

## Forward-only recovery (restore-based)

There is no DDL sequence that undoes a forward-only migration. The recovery
path is **restoring from backup to a point in time before the migration
ran** — this is [`docs/runbooks/restore-drill.md`](restore-drill.md) (plan
14-11), which this runbook cites rather than re-describes, so the two never
drift into disagreement about the actual restore procedure.

**Ordering constraint, stated honestly:** as of this plan (14-05), the
restore drill has been **configured but not yet performed** (plan 14-11 is
later in this same phase). Until plan 14-11's drill has actually run and
been written up, the forward-only tier's recovery path is a **documented**
procedure, not a **rehearsed** one — "restore from backup" is the correct
answer, but nobody has yet proven this repository's backups are actually
restorable to a usable database. Do not read this runbook's existence as
proof that a forward-only rollback has been tested end-to-end; check plan
14-11's own SUMMARY for whether the drill has since been performed.

## What the empty-diff check does and does not prove

`npm run db:check-empty-diff` (`packages/db/scripts/check-empty-diff.ts`,
also exercised by `migration-empty-diff.test.ts` on every CI run) asserts
that `packages/db/src/schema/*.ts` (the TypeScript schema) and the newest
`packages/db/migrations/meta/*_snapshot.json` file agree — running
`drizzle-kit generate`'s diff engine produces nothing new. **This is a
schema-to-snapshot comparison. It never connects to a live database.** A
manual, unrecorded `ALTER TABLE` run directly against production would pass
this check cleanly, because the check never looks at production, staging,
or any other live database at all.

An operator mid-incident is exactly the person most likely to misread a
green `db:check-empty-diff` result as "the database matches the code." It
does not mean that. The separate proof that the shipped SQL files actually
produce the expected schema when applied from empty is
`packages/db/src/__tests__/migrate-from-empty.test.ts`'s full-chain
application test — and even THAT only proves the SQL files are internally
consistent with each other, not that any particular live database has
actually had every one of them applied. For that, consult `/readyz`
(plan 14-01) or `packages/db/src/migration-journal.ts`'s
`assertMigrationsCurrent`, which compares the shipped journal against what a
specific live database's own `"drizzle"."__drizzle_migrations"` table
records.

Three independent proofs, answering three different questions — none of
them substitutes for either of the other two:

| Check | Question it answers |
|---|---|
| `db:check-empty-diff` | Does the TypeScript schema agree with the migration history's own snapshot? |
| `migrate-from-empty.test.ts` | Do the shipped SQL files, applied in order to an empty database, produce a consistent result? |
| `/readyz` / `assertMigrationsCurrent` | Has THIS specific live database actually applied every shipped migration? |

## Snapshot backfill (for context, not an ongoing obligation)

`drizzle-kit generate`'s diff engine reads only the alphabetically-last
snapshot file under `packages/db/migrations/meta/` — confirmed by reading
`node_modules/drizzle-kit/bin.cjs`'s `prepareOutFolder`/`preparePrevSnapshot`
directly, and by an empirical run against a scratch copy of this
repository's migrations. This repository shipped 63 migrations with only 11
snapshot files (newest at `0034_snapshot.json`) before this plan; the
empty-diff gate needed exactly **one** new snapshot
(`0062_snapshot.json`, matching the newest already-shipped migration) to
close — not a full historical backfill of the other ~51 missing files,
because `generate` was never going to read them regardless of whether they
existed. If a future audit finds the gate failing again, the fix is the
same: generate (via `drizzle-kit`'s own `generateDrizzleJson` API, never by
hand-editing a snapshot JSON file) a fresh snapshot matching the newest
shipped migration's actual cumulative schema state.

## See also

- `packages/db/src/migration-tiers.ts` — the tier classification and its
  five-plus-two forward-only reasons, each with a one-line justification.
- `packages/db/src/__tests__/migration-rollback-rehearsal.test.ts` — the
  automated rehearsal this runbook's auto-reversible procedure mirrors.
- `docs/runbooks/restore-drill.md` (plan 14-11) — the forward-only tier's
  actual recovery mechanics.
- `docs/runbooks/relocate-default-partition-rows.md` and
  `docs/runbooks/reprovision-webhook-event-types.md` — this repository's
  other operator runbooks, for format precedent.
