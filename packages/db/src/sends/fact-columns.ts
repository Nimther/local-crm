import type { PoolClient } from "pg";

/**
 * `sends`-row fact-column write primitives (07-09/D-07/D-09), relocated here
 * from `apps/worker/src/queues/webhook-events.worker.ts` (Phase 13, plan
 * 13-08, CMP-01) SPECIFICALLY because a second caller needs them:
 * `apps/api`'s public unsubscribe route (`unsubscribe.routes.ts`) must set
 * `sends.unsubscribed_at` and increment the same campaign counter the
 * webhook path does, and `apps/api` declares no dependency on `apps/worker`
 * (a relative cross-app import is a hard `tsc` TS6059 error under
 * `apps/api/tsconfig.json`'s `rootDir: "src"` -- proven in plan 12-10's
 * `dead-letter-writer.ts` relocation for the identical reason).
 * `packages/db/src/<domain>/<module>.ts`, imported as
 * `@mega-crm/db/src/<domain>/<module>.js`, is this codebase's convention for
 * a `PoolClient`-first query helper shared across both apps -- see
 * `packages/db/src/reconciler/reconciler-run.ts` and
 * `packages/db/src/analytics/daily-rollup.ts` for the identical shape. There
 * is NO private copy left behind in `webhook-events.worker.ts` -- every call
 * site imports from here directly.
 *
 * The `WHERE <column> IS NULL` predicate in `setFactColumnOnce` is the
 * platform's exactly-once counter gate: it lets a replayed or out-of-order
 * event (or, as of plan 13-08, an unsubscribe arriving through either the
 * public route or the webhook path in either order) write the fact column
 * AT MOST once, and its `justSet`/`RETURNING id` return contract is what a
 * caller uses to gate its own counter increment on `incrementCampaignCounter`
 * below. A caller that drops this gate -- e.g. by writing an equivalent
 * `UPDATE` without the `IS NULL` predicate, or by calling
 * `incrementCampaignCounter` unconditionally instead of only after a
 * genuine `justSet` -- double-counts. One gate, one definition, every call
 * site in every app goes through it.
 */
export async function setFactColumnOnce(
  client: PoolClient,
  sendId: string,
  column: string,
  occurredAt: string,
  reasonWrite?: { reasonColumn: string; reason: string | null }
): Promise<boolean> {
  const sql = reasonWrite
    ? `UPDATE sends SET ${column} = $2, ${reasonWrite.reasonColumn} = $3 WHERE id = $1 AND ${column} IS NULL RETURNING id`
    : `UPDATE sends SET ${column} = $2 WHERE id = $1 AND ${column} IS NULL RETURNING id`;
  const params = reasonWrite ? [sendId, occurredAt, reasonWrite.reason] : [sendId, occurredAt];
  const { rows } = await client.query(sql, params);
  return rows.length > 0;
}

/** Unique-recipient campaign counter increment (D-07/D-09), only ever called after a `setFactColumnOnce` just-set. */
export async function incrementCampaignCounter(client: PoolClient, campaignId: string, column: string): Promise<void> {
  await client.query(`UPDATE campaigns SET ${column} = ${column} + 1, updated_at = now() WHERE id = $1`, [
    campaignId,
  ]);
}
