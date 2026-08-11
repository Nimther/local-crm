import { randomUUID } from "node:crypto";
import { Worker, type Job, type ConnectionOptions } from "bullmq";
import type { PoolClient } from "pg";
import { scrubbedConsole } from "@mega-crm/redaction";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { recordSubscriptionStatusChange } from "@mega-crm/contacts-core";
import { incrementWorkspaceDailyRollup } from "@mega-crm/db/src/analytics/daily-rollup.js";
import {
  classifyOccurredAt,
  normalizeEventType,
  resolveSuppression,
  SOFT_BOUNCE_SUPPRESS_THRESHOLD,
  type NormalizedEventType,
} from "@mega-crm/delivery-core";
import { WEBHOOK_EVENTS_QUEUE, webhookEventsJobSchema, type WebhookEventsJob } from "@mega-crm/shared-schemas";
import { markIngestionComplete } from "@mega-crm/db/src/webhooks/ingress-journal.js";
import { writeQuarantinedEvent } from "@mega-crm/db/src/webhooks/quarantine.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ExtractedEventRow {
  id: string;
  sgEventId: string;
  sendId: string | null;
  eventType: string;
  reason: string | null;
  payload: unknown;
  isTest: boolean;
  occurredAt: string;
  /** Pure-computed at extraction time (D-14) -- null for out-of-scope events (WBHK-02). */
  normalizedType: NormalizedEventType | null;
}

/**
 * `occurred_at_candidate` is a TEXT column (migration 0055) -- this
 * stringifies an `OccurredAtVerdict`'s `candidate: unknown` verbatim for
 * storage, without ever collapsing a non-primitive candidate to
 * `"[object Object]"` (`@typescript-eslint/no-base-to-string`'s own
 * concern with a bare `String(candidate)`).
 */
function stringifyOccurredAtCandidate(candidate: unknown): string | null {
  if (candidate === null || candidate === undefined) return null;
  if (typeof candidate === "string") return candidate;
  if (typeof candidate === "number" || typeof candidate === "boolean") return String(candidate);
  try {
    return JSON.stringify(candidate);
  } catch {
    return Object.prototype.toString.call(candidate);
  }
}

/** A rejected/unusable event that carries a usable `sg_event_id` -- routed to `send_event_quarantine` (CMP-05, D-15). */
interface QuarantineCandidate {
  sgEventId: string;
  eventType: string | null;
  rawEvent: unknown;
  reason: string;
  occurredAtCandidate: string | null;
}

/**
 * Three, and only three, outcomes of extracting one raw webhook event
 * (CMP-05, D-15, plan 13-04):
 *
 * - `extracted` -- an accepted `occurred_at` verdict; carries the row as
 *   before.
 * - `quarantine` -- the event carries a usable `sg_event_id` and its
 *   `classifyOccurredAt` verdict was either `rejected` (well-formed but out
 *   of range) or `unusable` (structurally not a timestamp). BOTH verdict
 *   kinds route here -- the verdict kind only selects the reason string an
 *   operator reads (`occurred-at-bounds.ts`'s own doc comment), never
 *   whether a quarantine row is written.
 * - `skip` -- the event carries NO usable `sg_event_id`. Stays a plain skip
 *   with no quarantine row: an unidentifiable payload gives the operator
 *   nothing to correlate, a different failure from a timestamp the platform
 *   refuses to trust.
 */
type ExtractEventOutcome =
  | { kind: "extracted"; row: ExtractedEventRow }
  | { kind: "quarantine"; candidate: QuarantineCandidate }
  | { kind: "skip" };

/**
 * Best-effort field extraction from a raw SendGrid webhook event (WBHK-01/02/
 * 03/04, D-14/D-15, CMP-05). `now` is captured ONCE per batch by the caller
 * and threaded through here, so every event in a batch is bounded against
 * the same instant (`occurred-at-bounds.ts`'s determinism contract).
 *
 * CMP-05 ordering guarantee: the `occurred_at` bound is applied HERE, at
 * extraction -- strictly before the value is used to construct the row the
 * INSERT below routes to a partition, and strictly before it participates
 * in the `ON CONFLICT` dedup key. An event past `classifyOccurredAt`
 * returns `skip` (no usable `sg_event_id`, an unidentifiable payload) or
 * `quarantine` (a usable `sg_event_id` but a rejected/unusable timestamp) --
 * neither ever reaches the row construction below.
 */
function extractEventRow(raw: unknown, now: Date): ExtractEventOutcome {
  if (typeof raw !== "object" || raw === null) {
    return { kind: "skip" };
  }
  const event = raw as Record<string, unknown>;

  const sgEventId = typeof event.sg_event_id === "string" ? event.sg_event_id.trim() : "";
  if (!sgEventId) {
    return { kind: "skip" };
  }

  const eventType = typeof event.event === "string" ? event.event : "unknown";

  // SendGrid's `timestamp` is Unix seconds. It must be deterministic
  // per-event -- the same replayed event always resolves to the same
  // occurred_at, which is what makes `ON CONFLICT (workspace_id,
  // sg_event_id, occurred_at)` dedupe correctly across redeliveries (see
  // send-events.ts's doc-comment). `classifyOccurredAt` never substitutes a
  // wall-clock fallback for a missing/unusable timestamp (WR-01: a
  // substituted `now` differs on every redelivery, defeating dedup), and
  // its `out_of_date_range` verdict is what stops an absurd numeric value
  // from making `new Date(...)` throw and crash the whole batch (WR-02).
  const verdict = classifyOccurredAt(event.timestamp, now);
  if (verdict.kind !== "accepted") {
    return {
      kind: "quarantine",
      candidate: {
        sgEventId,
        eventType: typeof event.event === "string" ? event.event : null,
        rawEvent: event,
        reason: verdict.reason,
        occurredAtCandidate: stringifyOccurredAtCandidate(verdict.candidate),
      },
    };
  }
  const occurredAt = verdict.occurredAt;

  const rawSubtype = typeof event.type === "string" ? event.type : undefined;
  const reason = typeof event.reason === "string" ? event.reason : null;

  // SendGrid's Event Webhook flattens the mail/send custom args directly
  // onto the event object's TOP LEVEL -- there is no nested wrapper in real
  // webhook payloads (confirmed against live UAT payloads; see
  // .planning/debug/campaign-metrics-zero-despite-events.md). The nested
  // read is retained only as a defensive fallback for any caller that still
  // constructs the older nested shape.
  const customArgs =
    event.custom_args && typeof event.custom_args === "object"
      ? (event.custom_args as Record<string, unknown>)
      : undefined;
  const rawSendId =
    typeof event.send_id === "string"
      ? event.send_id
      : typeof customArgs?.send_id === "string"
        ? customArgs.send_id
        : null;
  // D-15: the send_id marker may point at a deleted/orphaned send, or be
  // absent entirely (a tenant's own webhook traffic bypassing the platform)
  // -- the FK is nullable (ON DELETE SET NULL) for exactly this reason. A
  // structurally-invalid value (not UUID-shaped) is nulled out defensively
  // rather than passed through to a uuid-typed column, which would throw
  // 22P02 and abort the whole batch insert.
  const sendId = rawSendId && UUID_RE.test(rawSendId) ? rawSendId : null;
  const isTest = event.test === "true" || customArgs?.test === "true";

  return {
    kind: "extracted",
    row: {
      id: randomUUID(),
      sgEventId,
      sendId,
      eventType,
      reason,
      payload: event,
      isTest,
      occurredAt,
      normalizedType: normalizeEventType({ event: eventType, type: rawSubtype }),
    },
  };
}

/**
 * Idempotent "first write wins" fact-column update (D-06 Pattern 4):
 * `WHERE <column> IS NULL` gates the write so a replayed or out-of-order
 * event can never overwrite an already-set fact. Returns whether THIS call
 * was the one that set the column -- the exactly-once counter-increment gate
 * (D-09).
 */
async function setFactColumnOnce(
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
async function incrementCampaignCounter(client: PoolClient, campaignId: string, column: string): Promise<void> {
  await client.query(`UPDATE campaigns SET ${column} = ${column} + 1, updated_at = now() WHERE id = $1`, [
    campaignId,
  ]);
}

/**
 * 07-09 (D-08 OR-combined per-send terminal count): returns `true` iff
 * exactly one of `bounced_at`/`dropped_at`/`spam_reported_at` is currently
 * non-null on the send -- i.e. the terminal the caller's `setFactColumnOnce`
 * just set is this send's ONLY non-delivery terminal so far. Called only
 * after a successful `justSet` (the column it just set is already committed
 * in this transaction), so a second terminal on the same send (e.g. a spam
 * report after an earlier hard bounce) resolves to `false`, matching
 * `reconcileWorkspaceDay`'s OR-combined filter that counts a send once
 * regardless of how many of the three terminal columns are set.
 * `unsubscribed_at` is deliberately NOT part of this set -- it has its own
 * counter and is unaffected.
 */
async function isFirstNonDeliveryTerminal(client: PoolClient, sendId: string): Promise<boolean> {
  const { rows } = await client.query<{ terminalCount: number }>(
    `SELECT (
       (bounced_at IS NOT NULL)::int +
       (dropped_at IS NOT NULL)::int +
       (spam_reported_at IS NOT NULL)::int
     ) as "terminalCount"
     FROM sends WHERE id = $1`,
    [sendId]
  );
  return rows[0]?.terminalCount === 1;
}

/**
 * Suppression dual-write (D-13): flips `contacts.subscription_status` to
 * 'suppressed' AND inserts a `workspace_suppressions` row (per-event,
 * per-transaction single-row write -- never bulk), reading the contact's
 * email from the UPDATE's own RETURNING rather than a second query. A
 * contact with no email on file (external_id-only) still gets the status
 * flip; the suppression-list row is skipped since it requires an email.
 */
async function applySuppression(
  client: PoolClient,
  workspaceId: string,
  contactId: string,
  reason: string
): Promise<void> {
  // D-09 (07-01): capture the prior status BEFORE the UPDATE (RETURNING only
  // ever exposes the NEW row) so the history write's old->new pair is
  // accurate, and so a contact already suppressed writes no redundant row.
  const { rows: priorRows } = await client.query<{ subscriptionStatus: string }>(
    `SELECT subscription_status as "subscriptionStatus" FROM contacts WHERE id = $1`,
    [contactId]
  );
  const priorStatus = priorRows[0]?.subscriptionStatus ?? null;

  const { rows } = await client.query<{ email: string | null }>(
    `UPDATE contacts SET subscription_status = 'suppressed', updated_at = now() WHERE id = $1 RETURNING email`,
    [contactId]
  );
  const email = rows[0]?.email;
  if (email) {
    await client.query(
      `INSERT INTO workspace_suppressions (id, workspace_id, email, reason, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now())
       ON CONFLICT (workspace_id, email) DO NOTHING`,
      [workspaceId, email, reason]
    );
  }

  if (priorStatus !== null && priorStatus !== "suppressed") {
    await recordSubscriptionStatusChange(client, {
      workspaceId,
      contactId,
      oldStatus: priorStatus,
      newStatus: "suppressed",
      source: "webhook_suppression",
      reason,
    });
  }
}

/** Unsubscribe outcome (D-11/D-13): status change ONLY -- never a `workspace_suppressions` row. */
async function applyUnsubscribe(client: PoolClient, workspaceId: string, contactId: string): Promise<void> {
  // D-09 (07-01): same capture-before-write pattern as applySuppression.
  const { rows: priorRows } = await client.query<{ subscriptionStatus: string }>(
    `SELECT subscription_status as "subscriptionStatus" FROM contacts WHERE id = $1`,
    [contactId]
  );
  const priorStatus = priorRows[0]?.subscriptionStatus ?? null;

  await client.query(`UPDATE contacts SET subscription_status = 'unsubscribed', updated_at = now() WHERE id = $1`, [
    contactId,
  ]);

  if (priorStatus !== null && priorStatus !== "unsubscribed") {
    await recordSubscriptionStatusChange(client, {
      workspaceId,
      contactId,
      oldStatus: priorStatus,
      newStatus: "unsubscribed",
      source: "webhook_unsubscribe",
    });
  }
}

interface ResolvedSend {
  id: string;
  campaignId: string | null;
  contactId: string;
}

/**
 * Applies the full D-06/D-09/D-10/D-11/D-12/D-13 side-effect contract for
 * ONE genuinely-new, non-test, normalized event whose `send_id` resolved to
 * a live `sends` row. Never called for is_test rows or unresolved sends
 * (D-15) -- the caller gates both before invoking this.
 */
async function applyEventSideEffects(
  client: PoolClient,
  workspaceId: string,
  send: ResolvedSend,
  event: { normalizedType: NormalizedEventType; reason: string | null; occurredAt: string }
): Promise<void> {
  switch (event.normalizedType) {
    case "delivered": {
      const justSet = await setFactColumnOnce(client, send.id, "delivered_at", event.occurredAt);
      if (justSet) {
        if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "delivered_count");
        // D-10: a genuinely-new delivery resets the consecutive soft-bounce streak.
        await client.query(
          `UPDATE contacts SET consecutive_soft_bounces = 0, updated_at = now() WHERE id = $1`,
          [send.contactId]
        );
        // 07-06: same-transaction rollup increment, same idempotency guarantee.
        await incrementWorkspaceDailyRollup(client, workspaceId, event.occurredAt, "delivered");
      }
      break;
    }
    case "open": {
      const justSet = await setFactColumnOnce(client, send.id, "first_opened_at", event.occurredAt);
      if (justSet) {
        if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "opened_count");
        // 07-09: gated on justSet like the delivered case -- opened_count is
        // a unique-send count, matching reconcileWorkspaceDay's
        // first_opened_at-based COUNT and the campaign opened_count above.
        // Fires regardless of campaignId (flow sends have no campaign but
        // still count toward the workspace rollup, same as delivered).
        await incrementWorkspaceDailyRollup(client, workspaceId, event.occurredAt, "opened");
      }
      // A4/D-11: every genuinely-new open increments the per-send repeat
      // counter, independent of `justSet` -- this is the ONLY remaining
      // per-event (non-unique-send) counter; it stays outside the justSet
      // gate on purpose.
      await client.query(`UPDATE sends SET open_count = open_count + 1 WHERE id = $1`, [send.id]);
      break;
    }
    case "click": {
      const justSet = await setFactColumnOnce(client, send.id, "first_clicked_at", event.occurredAt);
      if (justSet) {
        if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "clicked_count");
        // 07-09: mirrors the open case -- unique-send count, gated on justSet.
        await incrementWorkspaceDailyRollup(client, workspaceId, event.occurredAt, "clicked");
      }
      // A4/D-11: mirror the open case -- climbs on every new click,
      // independent of justSet.
      await client.query(`UPDATE sends SET click_count = click_count + 1 WHERE id = $1`, [send.id]);
      break;
    }
    case "bounce_hard": {
      const justSet = await setFactColumnOnce(client, send.id, "bounced_at", event.occurredAt, {
        reasonColumn: "bounce_reason",
        reason: "hard_bounce",
      });
      if (justSet) {
        // 07-09: bounced_count is an OR-combined per-send terminal count
        // (D-08), matching reconcileWorkspaceDay -- only the FIRST
        // non-delivery terminal on this send counts. Suppression still
        // runs unconditionally on every genuinely-new terminal.
        if (await isFirstNonDeliveryTerminal(client, send.id)) {
          if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "bounced_count");
          await incrementWorkspaceDailyRollup(client, workspaceId, event.occurredAt, "bounced");
        }
        await applySuppression(client, workspaceId, send.contactId, "hard_bounce");
      }
      break;
    }
    case "bounce_soft": {
      // D-10 streak (atomic row-locked increment -- the outer dedup
      // RETURNING gate already guarantees this runs at most once per
      // genuinely-new soft-bounce event).
      const { rows } = await client.query<{ consecutiveSoftBounces: number }>(
        `UPDATE contacts SET consecutive_soft_bounces = consecutive_soft_bounces + 1, updated_at = now()
         WHERE id = $1 RETURNING consecutive_soft_bounces as "consecutiveSoftBounces"`,
        [send.contactId]
      );
      const streak = rows[0]?.consecutiveSoftBounces ?? 0;
      if (streak >= SOFT_BOUNCE_SUPPRESS_THRESHOLD) {
        const justSet = await setFactColumnOnce(client, send.id, "bounced_at", event.occurredAt, {
          reasonColumn: "bounce_reason",
          reason: "soft_bounce_streak",
        });
        if (justSet) {
          // 07-09: same first-terminal gating as bounce_hard.
          if (await isFirstNonDeliveryTerminal(client, send.id)) {
            if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "bounced_count");
            await incrementWorkspaceDailyRollup(client, workspaceId, event.occurredAt, "bounced");
          }
          await applySuppression(client, workspaceId, send.contactId, "soft_bounce_streak");
        }
      }
      break;
    }
    case "dropped": {
      const justSet = await setFactColumnOnce(client, send.id, "dropped_at", event.occurredAt, {
        reasonColumn: "drop_reason",
        reason: event.reason,
      });
      if (justSet) {
        // D-08: every address-drop terminal counts into bounced_count
        // ("не доставлено"), independent of the specific reason -- the
        // reason itself stays queryable via sends.drop_reason. 07-09: gated
        // on isFirstNonDeliveryTerminal, matching reconcileWorkspaceDay's
        // OR-combined per-send count.
        if (await isFirstNonDeliveryTerminal(client, send.id)) {
          if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "bounced_count");
          await incrementWorkspaceDailyRollup(client, workspaceId, event.occurredAt, "bounced");
        }

        const outcome = resolveSuppression("dropped", event.reason);
        if (outcome?.status === "suppressed") {
          await applySuppression(client, workspaceId, send.contactId, outcome.reason);
        } else if (outcome?.status === "unsubscribed") {
          await applyUnsubscribe(client, workspaceId, send.contactId);
        }
      }
      break;
    }
    case "spam_report": {
      const justSet = await setFactColumnOnce(client, send.id, "spam_reported_at", event.occurredAt);
      if (justSet) {
        // No dedicated spam counter exists (Task 1 decision) -- spam is a
        // non-delivery terminal, grouped into bounced_count like dropped.
        // 07-09: gated on isFirstNonDeliveryTerminal -- suppression still
        // runs unconditionally on every genuinely-new spam report.
        if (await isFirstNonDeliveryTerminal(client, send.id)) {
          if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "bounced_count");
          await incrementWorkspaceDailyRollup(client, workspaceId, event.occurredAt, "bounced");
        }
        await applySuppression(client, workspaceId, send.contactId, "spam_report");
      }
      break;
    }
    case "unsubscribe":
    case "group_unsubscribe": {
      const justSet = await setFactColumnOnce(client, send.id, "unsubscribed_at", event.occurredAt);
      if (justSet) {
        await applyUnsubscribe(client, workspaceId, send.contactId);
        if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "unsubscribed_count");
        await incrementWorkspaceDailyRollup(client, workspaceId, event.occurredAt, "unsubscribed");
      }
      break;
    }
  }
}

/** D-03: one conditional health-timestamp write per BATCH, never per event. */
async function debounceWebhookHealth(client: PoolClient, workspaceId: string): Promise<void> {
  await client.query(
    `UPDATE workspace_webhook_endpoints
     SET last_event_at = now(), updated_at = now()
     WHERE workspace_id = $1 AND (last_event_at IS NULL OR last_event_at < now() - interval '60 seconds')`,
    [workspaceId]
  );
}

/**
 * SEC-09 / WR-01 (RESEARCH.md Pitfall 4): resolves each candidate `send_id`'s
 * TRUE owning workspace via the scan role, and drops the events for any
 * `send_id` that resolves to a DIFFERENT workspace than the one receiving
 * this batch -- a sibling's raw event payload must never reach the
 * receiving workspace's `send_events`. This runs on the scan pool BEFORE any
 * tenant transaction opens (never nested inside `withTenant`/
 * `withTenantTransaction`): under RLS, a tenant-scoped query genuinely
 * cannot distinguish "this send_id belongs to a sibling workspace" from
 * "this send_id does not exist at all" -- both resolve to zero rows from
 * inside `withTenant(receivingWorkspaceId, ...)`. Only the scan role's
 * unrestricted `sends_scan` policy (migration 0042) can answer the ownership
 * question.
 *
 * The SELECT list is exactly `id, workspace_id` -- this is what makes the
 * payload-free drop-signal prohibition (P1: MUST NOT log or persist
 * sibling-workspace payload content) true BY CONSTRUCTION rather than by
 * review discipline: the query physically cannot read anything else to
 * leak.
 *
 * Filtering is per event, never a batch-level early return or throw
 * (T-10-08-03) -- one sibling event must never fail the whole delivery.
 * Three outcomes per candidate `send_id`:
 *   - resolves to the receiving workspace -> unchanged, flows into the
 *     existing per-tenant liveness check and insert path below;
 *   - resolves to a DIFFERENT workspace -> the event rows carrying that id
 *     are dropped from the surviving set entirely, and the drop is
 *     signalled (grouped by owning workspace, counts and workspace ids
 *     only -- never the send_id, event type, payload, or a contact
 *     identifier, which is itself a sibling workspace's identifier);
 *   - resolves to nothing (genuinely no such send anywhere) -> unchanged,
 *     keeps the existing D-15 orphan behaviour (stored with a null
 *     `send_id`, side effects skipped) via the per-tenant liveness check.
 */
async function dropSiblingWorkspaceEvents(
  workspaceId: string,
  rows: ExtractedEventRow[]
): Promise<ExtractedEventRow[]> {
  const candidateSendIds = [...new Set(rows.map((row) => row.sendId).filter((id): id is string => id !== null))];
  if (candidateSendIds.length === 0) {
    // Test 6: a batch with no send_id values at all performs no
    // cross-workspace lookup -- the scan pool is never touched.
    return rows;
  }

  const ownerRows = await withCrossWorkspaceScan(async (client) => {
    const { rows: owners } = await client.query<{ id: string; workspaceId: string }>(
      `SELECT id, workspace_id as "workspaceId" FROM sends WHERE id = ANY($1::uuid[])`,
      [candidateSendIds]
    );
    return owners;
  });
  const ownerBySendId = new Map(ownerRows.map((r) => [r.id, r.workspaceId]));

  const dropCountsByOwner = new Map<string, number>();
  const survivingRows = rows.filter((row) => {
    if (row.sendId === null) return true;
    const owningWorkspaceId = ownerBySendId.get(row.sendId);
    if (owningWorkspaceId === undefined || owningWorkspaceId === workspaceId) return true;
    dropCountsByOwner.set(owningWorkspaceId, (dropCountsByOwner.get(owningWorkspaceId) ?? 0) + 1);
    return false;
  });

  for (const [owningWorkspaceId, count] of dropCountsByOwner) {
    // P1: the payload is exactly these three scalar fields -- no send_id, no
    // event type, no payload, no contact identifier. 10-13 (SEC-13): routed
    // through scrubbedConsole like every other apps/worker log call site, so
    // that guarantee is mechanical rather than reviewed.
    scrubbedConsole.log("webhook.sibling_workspace_event_dropped", {
      receivingWorkspaceId: workspaceId,
      owningWorkspaceId,
      count,
    });
  }

  return survivingRows;
}

/**
 * Marks `journalId` complete (Phase 13, CMP-08, D-05, T-13-01-08) when one is
 * present -- opens its OWN small `withTenant`/`withTenantTransaction`, since
 * this is called from both the two zero-row early-return sites below (which
 * never open the main tenant transaction at all) and, implicitly via that
 * transaction's own tail, the normal insert path. `journalId` absent means a
 * legacy (pre-13-01) payload -- there is no journal row to mark, and this is
 * a silent no-op rather than a defensive throw, since an absent id is the
 * EXPECTED shape for such a payload, not an error.
 */
async function markJournalCompleteIfPresent(workspaceId: string, journalId: string | undefined): Promise<void> {
  if (journalId === undefined) return;
  await withTenant(workspaceId, () => withTenantTransaction((client) => markIngestionComplete(client, journalId)));
}

/**
 * The webhook-events job handler (WBHK-01/02/03/04, SUBS-02, D-14, SEC-09,
 * CMP-05): re-derives `workspaceId` from `job.data` (never ambient state).
 * Captures ONE `now` for the whole batch and threads it into every
 * `extractEventRow` call so every event is bounded against the same
 * instant. Before opening the tenant transaction, resolves and drops
 * sibling-workspace events via `dropSiblingWorkspaceEvents` -- that
 * ownership fact cannot come from inside the tenant transaction (see that
 * function's doc comment). Then performs ONE multi-row parameterized INSERT
 * into `send_events` with `ON CONFLICT (workspace_id, sg_event_id,
 * occurred_at) DO NOTHING RETURNING id` -- only rows Postgres actually
 * returns are "new" (RESEARCH.md Pattern 3). For each genuinely-new,
 * non-test event whose `custom_args.send_id` resolves to a live `sends`
 * row, applies the full fact-column + counter + suppression side-effect
 * contract, all inside the SAME tenant-scoped transaction as the dedup
 * insert. Finishes with a debounced webhook-health timestamp write.
 *
 * CMP-05 ordering guarantee (D-15, Pitfall 14 first half, plan 13-04): the
 * bound is applied at extraction (`extractEventRow`'s own doc comment),
 * strictly before the value is used to construct the row the INSERT below
 * routes to a partition and strictly before it participates in the
 * `ON CONFLICT` key. A rejected or unusable timestamp is quarantined (see
 * `writeQuarantinedEvent` below) per event, never a batch-level early
 * return or throw -- one bad timestamp costs its batch-mates nothing.
 *
 * Phase 13 (CMP-08, D-05): validates the payload with `safeParse` rather than
 * `parse` -- REVIEWS.md LOW finding. With `schemaVersion: z.literal(1).optional()`,
 * a future version-2 payload fails `.parse()` and throws into BullMQ
 * retries, the opposite of the "defer by logging and returning" the
 * schema's own doc comment promises. A failed parse whose every issue is
 * about `schemaVersion` is DEFERRED (logged via `scrubbedConsole`, returns
 * `{ inserted: 0 }`, marks no journal row); a failed parse for any other
 * reason (e.g. a missing/malformed `workspaceId`) keeps throwing -- a
 * structurally broken payload is a real error, not a forward-compatibility
 * case.
 *
 * Also restructures the zero-row early returns (a batch with no extractable
 * AND no quarantine-worthy events, a batch whose every survivor belongs to
 * a sibling workspace with no quarantine candidates either) to mark a
 * supplied `journalId` complete before returning -- REVIEWS.md HIGH
 * finding 1. A journaled batch that reached a terminal outcome is marked
 * ingested, INCLUDING when the correct outcome was to insert nothing:
 * sibling-only batches are not a hypothetical (`dropSiblingWorkspaceEvents`
 * exists precisely because one BYO SendGrid key backing multiple
 * workspaces makes them a proven production shape, Phase 10 SEC-09/WR-01),
 * and an all-quarantined batch (plan 13-04) is likewise a correct terminal
 * outcome, not a stuck one -- both are marked complete, the latter INSIDE
 * the same transaction that writes the quarantine rows (no second
 * transaction, no fourth zero-row return that bypasses the mark).
 *
 * Exported standalone (not only inside the Worker's inline processor) so
 * the webhook-events-*.test.ts suites can invoke it directly without a live
 * BullMQ Queue/Redis round-trip (mirrors processEventIngestJob's rationale).
 */
export async function processWebhookEventBatch(data: unknown): Promise<{ inserted: number }> {
  const parsed = webhookEventsJobSchema.safeParse(data);
  if (!parsed.success) {
    const isUnrecognizedSchemaVersion = parsed.error.issues.every((issue) => issue.path[0] === "schemaVersion");
    if (isUnrecognizedSchemaVersion) {
      scrubbedConsole.error("webhook-events: deferring job with an unrecognized schemaVersion", {
        issues: parsed.error.issues,
      });
      return { inserted: 0 };
    }
    throw parsed.error;
  }
  const { workspaceId, events, journalId } = parsed.data;

  const now = new Date();
  const outcomes = events.map((raw) => extractEventRow(raw, now));

  const extractedRows: ExtractedEventRow[] = [];
  const quarantineCandidates: QuarantineCandidate[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "extracted") extractedRows.push(outcome.row);
    else if (outcome.kind === "quarantine") quarantineCandidates.push(outcome.candidate);
    // "skip": no usable sg_event_id -- a plain drop, no quarantine row.
  }

  // SEC-09: runs even on an empty extractedRows array -- dropSiblingWorkspaceEvents
  // itself short-circuits (no candidateSendIds) without touching the scan pool.
  const rows = await dropSiblingWorkspaceEvents(workspaceId, extractedRows);

  if (rows.length === 0 && quarantineCandidates.length === 0) {
    // Nothing to insert AND nothing to quarantine -- every event was either
    // a sibling-workspace drop or had no usable sg_event_id. Returning here
    // also avoids an empty `VALUES ()` clause below, which the insert's
    // placeholder-join would otherwise produce.
    await markJournalCompleteIfPresent(workspaceId, journalId);
    return { inserted: 0 };
  }

  return withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      // Quarantine writes happen FIRST, in the SAME transaction as the
      // insert below -- T-13-04-03: quarantine is per event, never a
      // batch-level early return or throw, and `writeQuarantinedEvent`
      // itself swallows its own failure (plan 13-01) so one quarantine
      // write can never abort the surviving events' insert.
      for (const candidate of quarantineCandidates) {
        await writeQuarantinedEvent(client, workspaceId, {
          sgEventId: candidate.sgEventId,
          eventType: candidate.eventType,
          rawEvent: candidate.rawEvent,
          reason: candidate.reason,
          occurredAtCandidate: candidate.occurredAtCandidate,
        });
      }

      let insertedCount = 0;

      if (rows.length > 0) {
        // D-15: `send_events.send_id` carries a real FK to `sends(id)` --
        // Postgres enforces referential integrity at INSERT time regardless
        // of is_test/orphan intent, so a `custom_args.send_id` that never
        // corresponds to a live send (deleted, or Pitfall 2's kind='test'
        // dispatch that never writes a `sends` row at all) MUST be nulled
        // out here before insertion, not passed through as a dangling FK
        // value. (SEC-09: `rows` here has already had sibling-workspace
        // events dropped by `dropSiblingWorkspaceEvents` above -- a
        // send_id that resolves to THIS workspace or to nothing at all
        // still needs this per-tenant re-check, which is unchanged.)
        const candidateSendIds = [
          ...new Set(rows.map((row) => row.sendId).filter((id): id is string => id !== null)),
        ];
        let liveSendIds = new Set<string>();
        if (candidateSendIds.length > 0) {
          const { rows: liveSends } = await client.query<{ id: string }>(
            `SELECT id FROM sends WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
            [workspaceId, candidateSendIds]
          );
          liveSendIds = new Set(liveSends.map((r) => r.id));
        }
        const resolvedRows = rows.map((row) => ({
          ...row,
          sendId: row.sendId !== null && liveSendIds.has(row.sendId) ? row.sendId : null,
        }));

        const COLUMNS_PER_ROW = 9;
        const placeholders: string[] = [];
        const values: unknown[] = [];

        resolvedRows.forEach((row, index) => {
          const base = index * COLUMNS_PER_ROW;
          placeholders.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, now())`
          );
          values.push(
            row.id,
            workspaceId,
            row.sgEventId,
            row.sendId,
            row.eventType,
            row.reason,
            row.payload,
            row.isTest,
            row.occurredAt
          );
        });

        const { rows: insertedRows } = await client.query<{ id: string }>(
          `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, reason, payload, is_test, occurred_at, received_at)
           VALUES ${placeholders.join(", ")}
           ON CONFLICT (workspace_id, sg_event_id, occurred_at) DO NOTHING
           RETURNING id`,
          values
        );
        insertedCount = insertedRows.length;

        // Pattern 3: only rows Postgres actually returned are genuinely new
        // -- a replayed/duplicate event is skipped with zero side effects.
        const insertedIds = new Set(insertedRows.map((r) => r.id));
        const newRows = resolvedRows.filter((row) => insertedIds.has(row.id));

        for (const row of newRows) {
          // D-15 (Pitfall 2): a test-marked event is stored (already done by
          // the insert above) but produces zero status/counter/suppression
          // side effects.
          if (row.isTest) continue;
          // Out-of-scope SendGrid event type (e.g. processed/deferred) --
          // normalizeEventType already returned null for these.
          if (row.normalizedType === null) continue;
          // No send_id marker, or one that didn't resolve to a live send
          // (already nulled out above) -- nothing to process (D-15).
          if (row.sendId === null) continue;

          const { rows: sendRows } = await client.query<ResolvedSend>(
            `SELECT id, campaign_id as "campaignId", contact_id as "contactId"
             FROM sends WHERE id = $1 AND workspace_id = $2`,
            [row.sendId, workspaceId]
          );
          const send = sendRows[0];
          // Defensive re-check (row.sendId already validated live above;
          // this guards a same-transaction delete race).
          if (!send) continue;

          await applyEventSideEffects(client, workspaceId, send, {
            normalizedType: row.normalizedType,
            reason: row.reason,
            occurredAt: row.occurredAt,
          });
        }
      }

      // D-03: debounced once per batch, not once per event. Runs even when
      // `rows.length === 0` (an all-quarantined batch is still a batch this
      // workspace's endpoint received).
      await debounceWebhookHealth(client, workspaceId);

      // Phase 13 (CMP-08, D-05, T-13-01-08, T-13-04's all-quarantined
      // extension): a journaled batch that reached a terminal outcome is
      // marked ingested, including when the correct outcome was to insert
      // nothing (zero survivors, all quarantined, or a mix) -- completion
      // means the batch was PROCESSED, not that rows were written. Kept in
      // the SAME transaction as the insert/quarantine writes above (rather
      // than a separate withTenantTransaction call like the
      // nothing-to-insert-or-quarantine early return) so the completion
      // mark and the rows it covers commit or roll back together.
      if (journalId !== undefined) {
        await markIngestionComplete(client, journalId);
      }

      return { inserted: insertedCount };
    })
  );
}

/**
 * Constructs the actual BullMQ Worker consuming WEBHOOK_EVENTS_QUEUE --
 * registered in apps/worker/src/server.ts's buildWorker(). Takes plain
 * ioredis `ConnectionOptions` (not a constructed `Redis` client instance),
 * same nominal-type reason as createEventsIngestWorker.
 */
export function createWebhookEventsWorker(connection: ConnectionOptions): Worker<WebhookEventsJob> {
  return new Worker<WebhookEventsJob>(
    WEBHOOK_EVENTS_QUEUE,
    async (job: Job<WebhookEventsJob>) => {
      await processWebhookEventBatch(job.data);
    },
    { connection }
  );
}
