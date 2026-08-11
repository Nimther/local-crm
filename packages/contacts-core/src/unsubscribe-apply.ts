import type { PoolClient } from "pg";
import { setFactColumnOnce } from "@mega-crm/db/src/sends/fact-columns.js";
import {
  recordSubscriptionStatusChange,
  type SubscriptionStatusChangeSource,
} from "./subscription-status-history.js";

/**
 * CMP-01 (Phase 13, plan 13-08): the ONE shared atomic unsubscribe write
 * set -- status change, consent-history row, and the originating send's
 * `sends.unsubscribed_at` fact column -- called by all three unsubscribe
 * entry points in the platform: the public RFC 8058 route
 * (`apps/api/src/modules/delivery/unsubscribe.routes.ts`), the SendGrid
 * webhook's `unsubscribe`/`group_unsubscribe` cases, and the webhook's
 * `dropped`-with-unsubscribe-outcome case
 * (`apps/worker/src/queues/webhook-events.worker.ts`). Before this plan,
 * the route updated status and history but never touched the originating
 * send, while the webhook path wrote all three together -- one function, one
 * write set, three call sites, so the paths cannot drift apart again.
 *
 * PLACEMENT: lives in `contacts-core`, NOT `delivery-core`, even though
 * 13-RESEARCH.md Pattern 2 and 13-PATTERNS.md both suggested
 * `delivery-core`. `contacts-core` already declares `@mega-crm/delivery-core`
 * as a dependency (see `packages/contacts-core/package.json`), so a
 * `delivery-core` module importing `recordSubscriptionStatusChange` from
 * `contacts-core` would be a workspace dependency cycle. Both call sites
 * already import `contacts-core`, so this placement costs nothing.
 *
 * NEVER opens its own transaction -- operates entirely on the caller's
 * `PoolClient`, so it always participates in (and is rolled back with)
 * whichever tenant-scoped transaction the caller opened.
 *
 * Counter increments (campaign `unsubscribed_count`, the daily rollup) are
 * DELIBERATELY NOT performed here -- they live at each call site, because
 * the webhook path's rollup increment needs the standing-window argument
 * plan 13-05 added to `incrementWorkspaceDailyRollup`, and the route path has
 * no reconciler context of its own. Returning `sendFactJustSet` and
 * `campaignId` gives each call site exactly what it needs to gate its own
 * increments -- callers MUST gate any counter increment on `sendFactJustSet`
 * being `true`, or they will double-count on a replayed/duplicate call.
 */
export interface ApplyUnsubscribeInput {
  workspaceId: string;
  /** The caller's known contact id, or `null` when it must be resolved from the send row (the webhook's ResolvedSend call sites). */
  contactId: string | null;
  /** The originating send id, or `null` when the caller has none (e.g. a token predating sendId binding). A `sendId` naming no `sends` row is normal, not an error. */
  sendId: string | null;
  occurredAt: string;
  source: SubscriptionStatusChangeSource;
}

export interface ApplyUnsubscribeResult {
  statusChanged: boolean;
  /** Whether THIS call was the one that set `sends.unsubscribed_at` -- the exactly-once counter-increment gate callers must use. */
  sendFactJustSet: boolean;
  campaignId: string | null;
}

// CR-01 precedent (apps/api/src/modules/delivery/unsubscribe.routes.ts's own
// `isUuid`, apps/worker/src/queues/webhook-events.worker.ts's own `UUID_RE`):
// a signature-valid token's contactId is only trustworthy as an IDENTITY,
// never as a SHAPE. A non-UUID contactId must resolve to a total no-op here
// rather than let Postgres raise an uncaught 22P02 casting it to the
// uuid-typed `contacts.id` column.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ResolvedSendRow {
  id: string;
  campaignId: string | null;
  contactId: string;
}

export async function applyUnsubscribeWithSendFact(
  client: PoolClient,
  input: ApplyUnsubscribeInput
): Promise<ApplyUnsubscribeResult> {
  const { workspaceId, contactId, sendId, occurredAt, source } = input;

  // Step 1: resolve the send row when sendId is present, scoped to
  // workspaceId (RLS is already active on `client`'s transaction via the
  // caller's withTenant/withTenantTransaction -- the explicit workspace_id
  // predicate is defense-in-depth, matching this codebase's existing
  // convention). A missing row is normal -- a test send never writes a
  // `sends` row at all, and a pre-04-19 token can name a send that no
  // longer exists.
  let resolvedSend: ResolvedSendRow | null = null;
  if (sendId !== null) {
    const { rows } = await client.query<ResolvedSendRow>(
      `SELECT id, campaign_id as "campaignId", contact_id as "contactId"
       FROM sends WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, sendId]
    );
    resolvedSend = rows[0] ?? null;
  }
  const campaignId = resolvedSend?.campaignId ?? null;

  // Step 2: resolve the effective contact id -- the caller's when supplied
  // (the route has a token contactId), otherwise the resolved send row's
  // (the webhook cases have a full ResolvedSend in scope). This is what
  // makes all three call sites uniform.
  const effectiveContactId = contactId ?? resolvedSend?.contactId ?? null;

  // A missing or non-UUID-shaped effective contact id is a total no-op --
  // the route's CR-01 behavior depends on this falling through rather than
  // throwing. Deliberately returns BEFORE any send-fact write too: with no
  // valid contact to attribute the unsubscribe to, there is nothing to
  // record.
  if (effectiveContactId === null || !UUID_RE.test(effectiveContactId)) {
    return { statusChanged: false, sendFactJustSet: false, campaignId };
  }

  // Step 3: read the effective contact's current status BEFORE the UPDATE
  // (RETURNING only ever exposes the NEW row), so the history row's
  // old-to-new pair is accurate, and so an already-unsubscribed contact (or
  // an unknown/nonexistent contact id) writes no redundant row.
  const { rows: priorRows } = await client.query<{ subscriptionStatus: string }>(
    `SELECT subscription_status as "subscriptionStatus" FROM contacts WHERE id = $1`,
    [effectiveContactId]
  );
  const priorStatus = priorRows[0]?.subscriptionStatus ?? null;

  let statusChanged = false;
  if (priorStatus !== null && priorStatus !== "unsubscribed") {
    // Step 4: update status.
    await client.query(`UPDATE contacts SET subscription_status = 'unsubscribed', updated_at = now() WHERE id = $1`, [
      effectiveContactId,
    ]);

    // Step 5: history write, gated on the caller-gated no-op rule
    // (recordSubscriptionStatusChange itself never compares old vs new).
    await recordSubscriptionStatusChange(client, {
      workspaceId,
      contactId: effectiveContactId,
      oldStatus: priorStatus,
      newStatus: "unsubscribed",
      source,
    });
    statusChanged = true;
  }

  // Step 6: the fact-column write for `sends.unsubscribed_at`, independent
  // of whether the status/history write above ran -- its own
  // `WHERE unsubscribed_at IS NULL` gate (packages/db/src/sends/fact-columns.ts)
  // is what makes the two entry points converge idempotently by
  // construction: if the webhook event lands first, a later route
  // unsubscribe on the same send is a no-op on the column, and vice versa,
  // so neither ordering double-counts.
  let sendFactJustSet = false;
  if (resolvedSend !== null) {
    sendFactJustSet = await setFactColumnOnce(client, resolvedSend.id, "unsubscribed_at", occurredAt);
  }

  // Step 7: the caller decides whether/how to increment counters, gated on
  // `sendFactJustSet`.
  return { statusChanged, sendFactJustSet, campaignId };
}
