import { scrubbedConsole } from "@mega-crm/redaction";
import {
  COMPLAINT_RATE_CRITICAL,
  COMPLAINT_RATE_WARN,
  HARD_BOUNCE_RATE_CRITICAL,
  HARD_BOUNCE_RATE_WARN,
  type ReputationMetric,
  type ReputationTier,
} from "@mega-crm/delivery-core";

/**
 * Phase 13 (CMP-09, D-09 through D-12, plan 13-11): the FIFTH operator
 * watchdog in `apps/api/src/modules/ops/`, over `reputation_alert_state`
 * (migration 0058, plan 13-09). Plan 13-09's reputation-tick worker measures
 * and records; this module turns a recorded warn/critical crossing into
 * email -- for BOTH the operator (every prior watchdog's audience) AND, new
 * to this module, the affected workspace's own members (D-09) -- the tenant
 * owns the sending domain and is the only party who can act on a rising
 * complaint or bounce rate.
 *
 * Structurally a SIBLING of `dead-letter-watchdog.ts` (same periodic-check +
 * atomic-claim + platform-key-only-dispatch shape), with TWO deliberate
 * departures from every prior watchdog in this directory, both required to
 * be stated explicitly because copying the nearest precedent verbatim would
 * get each one wrong (13-RESEARCH.md Pitfall 5):
 *
 * 1. The claim is KEYED (`WHERE workspace_id = $1 AND metric = $2`), never a
 *    singleton (`WHERE id = 1`). Every other watchdog table
 *    (`partition_maintenance_runs`, `send_reconciler_runs`,
 *    `dead_letter_alert_state`, `ingestion_alert_state`) is a genuine
 *    platform-wide singleton -- there is no per-tenant watchdog anywhere
 *    else in this codebase to copy the keyed shape from. A tenant's
 *    complaint/bounce rate is inherently per-tenant (migration 0058's own
 *    header comment); a singleton claim here would collide every workspace's
 *    alert onto one row.
 * 2. Tier ESCALATION bypasses the dedup cooldown. The claim's `WHERE` gains
 *    a THIRD disjunct -- `alerted_tier = 'warn' AND` the newly observed tier
 *    is `'critical'` -- so a warn-to-critical crossing fires immediately even
 *    inside the 24h window, while a flat tier or a de-escalation does not.
 *    This is new logic with no analog anywhere else in this directory (no
 *    other watchdog has tiers), so it carries its own dedicated tests rather
 *    than inherited confidence from a sibling's test suite.
 *
 * Unlike `ingestion-health-watchdog.ts` (this same plan's OTHER new module),
 * this watchdog's health read does NOT go through the cross-workspace scan
 * helper (`@mega-crm/tenant-context`'s scan-role connection).
 * `reputation_alert_state` carries no RLS at all (migration 0058's own
 * header: "role identity is the boundary", same precedent as `organization`/
 * `dead_letter_jobs`) and `mega_crm_scan` was never granted access to it --
 * migration 0058's own comment states this explicitly: "No new grant to
 * mega_crm_scan is required" (the reputation tick's only cross-tenant read,
 * `SELECT id FROM organization`, is already covered by migration 0042's
 * grant). A scan-role read of `reputation_alert_state` would therefore throw
 * permission-denied on every tick -- reproducing, on THIS table, the exact
 * silent-failure mode T-13-11-08 documents for the other watchdog. Every
 * read and write in this module goes through the ordinary app-role pool
 * (`deps.client`), which owns both `reputation_alert_state` and the
 * better-auth `member`/`user` tables this module also reads for tenant
 * recipient resolution.
 *
 * D-11 (stated once here, load-bearing): this module NOTIFIES and does
 * NOTHING ELSE. No code path here pauses, throttles, or modifies a tenant's
 * sending configuration -- auto-pausing at the critical threshold is a
 * product-policy capability with its own UX (banners, an override/unblock
 * flow), deferred to a later phase.
 */

/**
 * D-09: one hour is well inside this watchdog's own 24h dedup window, but
 * this poll's OWN cadence is independent of the reputation-tick's 1-hour
 * measurement cadence (`REPUTATION_TICK_INTERVAL_MS`,
 * apps/worker/src/queues/reputation-tick.worker.ts) -- 15 minutes, matching
 * `send-reconciler-watchdog.ts`'s own `RECONCILER_WATCHDOG_INTERVAL_MS`, so a
 * fresh tier crossing is picked up well within the hour the underlying
 * measurement itself refreshes.
 */
export const REPUTATION_WATCHDOG_INTERVAL_MS = 15 * 60_000;

/**
 * D-09: the underlying ratio is computed over a 7-day rolling window
 * (`REPUTATION_WINDOW_DAYS`, `@mega-crm/delivery-core`) and moves slowly, so
 * a daily cooldown is the right cadence for a signal a tenant needs days to
 * act on -- copying a sibling's shorter (6h) event-driven dedup window here
 * would re-alert a tenant daily-scale noise on a weekly-scale signal. The
 * escalation disjunct (this module's own header, departure 2) is what
 * preserves urgency inside this longer window: a tenant whose complaint rate
 * moves from warn to critical mid-cooldown is a materially different
 * situation from one sitting flat at warn, and treating them the same would
 * either spam the flat case or hide the escalating one.
 */
export const REPUTATION_ALERT_DEDUP_HOURS = 24;

export interface ReputationAlertStateClient {
  query<T = Record<string, unknown>>(queryText: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface ReputationSnapshotRow {
  workspaceId: string;
  metric: ReputationMetric;
  /** Always `'warn'` or `'critical'` -- `readReputationSnapshot`'s own WHERE clause excludes `'none'` and unmeasured rows. */
  observedTier: ReputationTier;
  observedRate: number | null;
  observedNumerator: number;
  observedDenominator: number;
  /** The tier this watchdog last alerted on for this (workspace, metric) pair, or `null` if never alerted. Read-only here -- written exclusively by `claimReputationAlertSlot`. */
  alertedTier: ReputationTier | null;
}

interface RawReputationSnapshotRow {
  workspace_id: string;
  metric: ReputationMetric;
  observed_tier: ReputationTier;
  observed_rate: string | null;
  observed_numerator: number;
  observed_denominator: number;
  alerted_tier: ReputationTier | null;
}

/**
 * Reads every `reputation_alert_state` row whose `observed_tier` is `warn`
 * or `critical` -- a `'none'` row (healthy, or below the volume floor) is
 * excluded by this query itself, never filtered by the caller, so a `'none'`
 * workspace never even reaches the claim/alert decision (must_haves: "A
 * workspace at tier none receives no alert, including one below the volume
 * floor").
 */
export async function readReputationSnapshot(client: ReputationAlertStateClient): Promise<ReputationSnapshotRow[]> {
  const { rows } = await client.query<RawReputationSnapshotRow>(
    `SELECT workspace_id, metric, observed_tier, observed_rate, observed_numerator, observed_denominator, alerted_tier
       FROM reputation_alert_state
      WHERE observed_tier IN ('warn', 'critical')`,
  );
  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    metric: row.metric,
    observedTier: row.observed_tier,
    observedRate: row.observed_rate === null ? null : Number(row.observed_rate),
    observedNumerator: row.observed_numerator,
    observedDenominator: row.observed_denominator,
    alertedTier: row.alerted_tier,
  }));
}

const METRIC_LABEL_EN: Record<ReputationMetric, string> = {
  complaint_rate: "spam-complaint rate",
  hard_bounce_rate: "hard-bounce rate",
};

const METRIC_LABEL_RU: Record<ReputationMetric, string> = {
  complaint_rate: "доля жалоб на спам (spam-complaint rate)",
  hard_bounce_rate: "доля недоставленных писем (hard bounce rate)",
};

/** The threshold this observation's tier actually crossed, for the alert body -- `Observation.tier` is already computed by `classifyReputationRate`; this just names the number back. */
function thresholdFor(metric: ReputationMetric, tier: ReputationTier): number {
  if (metric === "complaint_rate") {
    return tier === "critical" ? COMPLAINT_RATE_CRITICAL : COMPLAINT_RATE_WARN;
  }
  return tier === "critical" ? HARD_BOUNCE_RATE_CRITICAL : HARD_BOUNCE_RATE_WARN;
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(3)}%`;
}

export type ReputationAlertAudience = "operator" | "tenant";

/**
 * Names the metric, the observed rate as a percentage, the numerator and
 * denominator (so the recipient can see the sample it was drawn from), and
 * the threshold that was crossed. Never a recipient address or contact
 * identifier -- the message is "your complaint rate is 0.32% over 1240
 * delivered", never a list of who complained.
 *
 * Two audiences, one function (the plan's own declared artifact list names
 * exactly one `renderReputationAlertText`, not two): the TENANT copy is in
 * Russian, matching the rest of the product's tenant-facing surfaces
 * (`platformMail`'s own templates); the OPERATOR copy is in English,
 * matching every sibling watchdog's own operator alert text, and additionally
 * names the workspace id (an internal identifier, not tenant PII) so the
 * operator knows which workspace the alert concerns -- the tenant copy omits
 * it, since the recipient already knows which workspace they are in.
 */
export function renderReputationAlertText(row: ReputationSnapshotRow, audience: ReputationAlertAudience): string {
  const threshold = thresholdFor(row.metric, row.observedTier);
  const observedPercent = row.observedRate === null ? "n/a" : formatPercent(row.observedRate);
  const thresholdPercent = formatPercent(threshold);
  const sample = `${row.observedNumerator}/${row.observedDenominator}`;

  if (audience === "tenant") {
    const lines: string[] = [];
    lines.push("Mega CRM — предупреждение о репутации отправителя");
    lines.push("");
    lines.push(`Метрика: ${METRIC_LABEL_RU[row.metric]}`);
    lines.push(`Текущее значение: ${observedPercent} (${sample})`);
    lines.push(
      `Уровень: ${row.observedTier === "critical" ? "критический" : "предупреждение"} (превышен порог ${thresholdPercent})`,
    );
    lines.push("");
    lines.push(
      "Проверьте качество базы контактов и содержание рассылок, чтобы снизить этот показатель — " +
        "устойчиво высокое значение может привести к фильтрации писем почтовыми провайдерами.",
    );
    return lines.join("\n");
  }

  const lines: string[] = [];
  lines.push("Mega CRM reputation alert");
  lines.push("");
  lines.push(`Workspace: ${row.workspaceId}`);
  lines.push(`Metric: ${METRIC_LABEL_EN[row.metric]}`);
  lines.push(`Observed rate: ${observedPercent} (${sample})`);
  lines.push(`Tier: ${row.observedTier} (threshold crossed: ${thresholdPercent})`);
  lines.push("");
  lines.push("This is a notification only -- nothing has been paused, throttled or modified.");
  return lines.join("\n");
}

export interface ReputationAlertMessage {
  to: string;
  text: string;
}

export interface ReputationWatchdogDeps {
  /** The ordinary app-role pool -- owns `reputation_alert_state` (no RLS) and the better-auth `member`/`user` tables. Never the scan pool (see module header). */
  client: ReputationAlertStateClient;
  now: Date;
  operatorEmail: string;
  sendMail: (message: ReputationAlertMessage) => Promise<void>;
}

/**
 * A single conditional `UPDATE ... RETURNING`, keyed by `(workspace_id,
 * metric)` -- the departure this module's own header names as departure 1.
 * The `SET` list names ONLY `alerted_tier`, `last_alert_sent_at` and
 * `updated_at` -- never any `observed_*` column, which belongs exclusively
 * to plan 13-09's reputation-tick (migration 0058's disjoint-column-set
 * contract).
 *
 * The `WHERE` clause's three disjuncts, in order: (a) never alerted before
 * -- `last_alert_sent_at IS NULL`; (b) the cooldown has elapsed; (c)
 * ESCALATION -- the prior alerted tier was `warn` and the newly observed
 * tier is `critical` (departure 2). A flat tier or a de-escalation (critical
 * -> warn) satisfies none of the three once (a)/(b) are false, so it is
 * correctly refused inside the cooldown.
 */
export async function claimReputationAlertSlot(
  client: ReputationAlertStateClient,
  workspaceId: string,
  metric: ReputationMetric,
  tier: ReputationTier,
  now: Date,
  dedupHours: number,
): Promise<boolean> {
  const { rows } = await client.query(
    `UPDATE reputation_alert_state
        SET alerted_tier = $3,
            last_alert_sent_at = $4::timestamptz,
            updated_at = now()
      WHERE workspace_id = $1
        AND metric = $2
        AND (
          last_alert_sent_at IS NULL
          OR last_alert_sent_at < $4::timestamptz - make_interval(hours => $5)
          OR (alerted_tier = 'warn' AND $3 = 'critical')
        )
      RETURNING last_alert_sent_at`,
    [workspaceId, metric, tier, now, dedupHours],
  );
  return rows.length > 0;
}

/**
 * Returns the email addresses of every member of `workspaceId`, via a plain
 * join over better-auth's own `member`/`user` tables -- neither carries RLS
 * (auth.ts's own header: better-auth tables are queried outside any tenant
 * transaction). This is the FIRST such query in `apps/api`: the existing
 * member-listing route (`modules/tenancy/members.ts`) goes through
 * `auth.api.listMembers`, which requires a live request's session headers
 * and cannot be called from a background watchdog with no request context.
 * Documented in this plan's SUMMARY as the first join of its kind, so a
 * future reader knows this is the query to consolidate onto if a second
 * background consumer of workspace membership ever appears.
 *
 * A workspace with zero resolvable members returns an empty array rather
 * than throwing -- `checkReputationHealthAndAlert` must still send the
 * operator alert in that case (the operator alert is the one that always
 * has a destination).
 */
export async function resolveWorkspaceAlertRecipients(client: ReputationAlertStateClient, workspaceId: string): Promise<string[]> {
  const { rows } = await client.query<{ email: string }>(
    `SELECT u.email AS email
       FROM "member" m
       JOIN "user" u ON u.id = m."userId"
      WHERE m."organizationId" = $1`,
    [workspaceId],
  );
  return rows.map((row) => row.email);
}

/**
 * Reads every warn/critical (workspace, metric) observation and, for each
 * one that WINS the atomic keyed claim, sends the operator alert (English)
 * and every resolvable workspace member's tenant alert (Russian) -- both
 * through the injected `sendMail`, which the boot wiring (task 3) backs with
 * the PLATFORM's own SendGrid key, never a tenant's BYO key (D-09/T-13-11-03:
 * a tenant whose reputation is collapsing may have a throttled or suspended
 * key, so the alert that matters most would be the one that fails).
 *
 * Two workspaces crossing warn independently each get their own claim and
 * their own alerts -- nothing here serializes or batches across workspaces,
 * so neither can suppress the other.
 *
 * CR-02 (mirrors every sibling watchdog's own check function): the claim
 * commits BEFORE any `sendMail` is attempted -- that ordering is what makes
 * it atomic across replicas. A rejected send releases the claimed slot,
 * restoring BOTH `alerted_tier` (captured from the pre-claim snapshot) and
 * `last_alert_sent_at` to their pre-claim values -- unlike every prior
 * watchdog's release (which only ever resets `last_alert_sent_at`, since
 * none of them write a second arbiter column), this claim's `alerted_tier`
 * is itself part of the escalation disjunct's WHERE evaluation, so a
 * half-applied claim left in place would silently absorb a future
 * escalation's bypass. The release is guarded to only clear the exact
 * `last_alert_sent_at` value THIS call just set.
 */
export async function checkReputationHealthAndAlert(deps: ReputationWatchdogDeps): Promise<void> {
  const rows = await readReputationSnapshot(deps.client);

  for (const row of rows) {
    const claimed = await claimReputationAlertSlot(deps.client, row.workspaceId, row.metric, row.observedTier, deps.now, REPUTATION_ALERT_DEDUP_HOURS);
    if (!claimed) continue;

    const operatorText = renderReputationAlertText(row, "operator");
    const tenantText = renderReputationAlertText(row, "tenant");

    try {
      await deps.sendMail({ to: deps.operatorEmail, text: operatorText });
      const recipients = await resolveWorkspaceAlertRecipients(deps.client, row.workspaceId);
      for (const email of recipients) {
        await deps.sendMail({ to: email, text: tenantText });
      }
    } catch (err) {
      await deps.client
        .query(
          `UPDATE reputation_alert_state
              SET alerted_tier = $3,
                  last_alert_sent_at = NULL
            WHERE workspace_id = $1
              AND metric = $2
              AND last_alert_sent_at = $4::timestamptz`,
          [row.workspaceId, row.metric, row.alertedTier, deps.now],
        )
        .catch(() => undefined);
      throw err;
    }
  }
}

export interface StartReputationWatchdogDeps {
  client: ReputationAlertStateClient;
  operatorEmail: string;
  sendMail: (message: ReputationAlertMessage) => Promise<void>;
}

/**
 * Registers the `REPUTATION_WATCHDOG_INTERVAL_MS` poll and returns the
 * interval handle (caller owns clearing it). NOT wired into
 * `apps/api/src/server.ts` by this module -- that boot-time call is task 3's
 * job. A rejected check is logged rather than crashing the interval --
 * there is no caller here to propagate to; this is the outermost boundary,
 * mirroring every sibling watchdog's own `startXWatchdog`.
 */
export function startReputationWatchdog(deps: StartReputationWatchdogDeps): NodeJS.Timeout {
  return setInterval(() => {
    void checkReputationHealthAndAlert({ ...deps, now: new Date() }).catch((err: unknown) => {
      scrubbedConsole.error("reputation-watchdog: health check failed", err);
    });
  }, REPUTATION_WATCHDOG_INTERVAL_MS);
}
