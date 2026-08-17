/**
 * Phase 15 (OPS-13, plan 15-12 Task 2): the shared alert-dedup primitive over
 * `ops_alert_state` (migration 0064) that all four new OPS-13 watchdogs
 * (queue depth, oldest job age, webhook lag, failed-send share) will claim
 * against -- one keyed table, one claim helper, instead of four copies of
 * the same atomic-claim shape.
 *
 * Structurally mirrors `packages/db/src/reconciler/reconciler-run.ts`: an
 * injected, structural `{ query }`-shaped client type (never a concrete `pg`
 * `Pool`/`PoolClient`), no env module import, no tenancy import -- this
 * module is called from `apps/api`'s platform-side watchdog ticks on the
 * plain app-role pool, never inside a `withTenant` scope (the table carries
 * no `workspace_id`).
 *
 * `claimOpsAlertSlot` extends the existing watchdogs' proven single
 * `UPDATE ... RETURNING` discipline (`claimReconcilerAlertSlot`,
 * `apps/api/src/modules/ops/send-reconciler-watchdog.ts`) with an upsert, so
 * a first-ever claim for a name that has never appeared in this table works
 * without a seeded row -- `ops_alert_state` is deliberately never seeded by
 * migration 0064 (see that migration's own comment). Multi-replica safety
 * comes from the single statement's atomicity (Postgres's own row-level
 * locking on the `INSERT ... ON CONFLICT` target row), never from a
 * read-then-write pair: two concurrent claims for the same `alertName` can
 * never both win, because the first commit's new `last_alert_sent_at` makes
 * the second claim's own `WHERE` clause on the conflict path re-evaluate to
 * false once it proceeds.
 *
 * On the INSERT path (no existing row for this `alertName`), Postgres never
 * evaluates the `DO UPDATE ... WHERE` predicate at all -- it only gates the
 * UPDATE taken on a real conflict -- so a first-ever claim for a name always
 * succeeds regardless of the dedup window, exactly the "unseeded is not a
 * dead-man's-switch gap" property this table's own migration comment
 * documents.
 */

export interface OpsAlertStateClient {
  query<T = Record<string, unknown>>(queryText: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * A single atomic `INSERT ... ON CONFLICT (alert_name) DO UPDATE ... WHERE
 * ... RETURNING` -- deliberately NOT a `SELECT` followed by a separate
 * `UPDATE`/`INSERT` (see this module's own header comment for why). Resolves
 * `true` only when this call actually claimed the slot (the statement
 * matched and returned a row) -- the caller sends its alert only then.
 */
export async function claimOpsAlertSlot(
  client: OpsAlertStateClient,
  alertName: string,
  now: Date,
  dedupHours: number,
): Promise<boolean> {
  const { rows } = await client.query(
    `INSERT INTO ops_alert_state (alert_name, last_alert_sent_at, updated_at)
     VALUES ($1, $2::timestamptz, now())
     ON CONFLICT (alert_name) DO UPDATE
       SET last_alert_sent_at = $2::timestamptz,
           updated_at = now()
       WHERE ops_alert_state.last_alert_sent_at IS NULL
          OR ops_alert_state.last_alert_sent_at < $2::timestamptz - make_interval(hours => $3)
     RETURNING last_alert_sent_at`,
    [alertName, now, dedupHours],
  );
  return rows.length > 0;
}

/**
 * Releases a claim after a failed alert send, so the next tick -- this
 * replica or another, still inside the same dedup window -- can retry.
 * Conditional on `last_alert_sent_at` still being the EXACT value this
 * caller's own `claimOpsAlertSlot` call just set (guarded by the `now`
 * parameter, which must be the same `Date` passed to that call): if a
 * concurrent replica has already claimed a NEWER window by the time this
 * runs, that newer claim is never clobbered.
 */
export async function releaseOpsAlertSlot(client: OpsAlertStateClient, alertName: string, now: Date): Promise<void> {
  await client.query(
    `UPDATE ops_alert_state
        SET last_alert_sent_at = NULL,
            updated_at = now()
      WHERE alert_name = $1
        AND last_alert_sent_at = $2::timestamptz`,
    [alertName, now],
  );
}
