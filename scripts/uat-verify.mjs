#!/usr/bin/env node
// Phase 16 plan 01 (UAT-01/UAT-02, D-13): the scripted-assert instrument
// every UAT test in this phase reuses. "Verification queries are scripted
// so 'passed' means a query returned the expected rows, not an eyeball"
// (D-13) -- this is the machine half of that decision.
//
// Structured exactly like scripts/check-spec-env-coverage.mjs: exported pure
// helpers (`parseArgs`, `formatReport`, `assertExpectations`) that are
// unit-testable with no database, plus a CLI behind an `import.meta.url`
// guard. All database I/O lives in the non-exported `runSendAttribution`
// below, which the pure helpers never call.
//
// LOAD-ORDER CONSTRAINT (found empirically while writing this script, not
// assumed): every `packages/*` workspace ships `"main": "./src/index.ts"` --
// read as TypeScript source directly by tsx/vitest, but NOT resolvable by
// plain `node` (its sibling `./foo.js`-specifier relative imports do not
// remap to `./foo.ts` under plain node's type-stripping -- confirmed against
// this repo's own `@mega-crm/tenant-context` -> `@mega-crm/redaction` import
// chain; see docker/patch-workspace-mains.mjs's header for the identical
// finding at image-build time). A static top-level
// `import { withTenant } from "@mega-crm/tenant-context"` would therefore
// crash `node scripts/uat-verify.mjs` (no args) with an unhandled
// ERR_MODULE_NOT_FOUND instead of the required "usage error, exit 2" --
// breaking this task's own acceptance criteria. `@mega-crm/tenant-context`
// is therefore imported with a DYNAMIC `import()`, deferred until
// `runSendAttribution` actually runs (i.e. only after `parseArgs` has
// already accepted a well-formed `send-attribution` invocation). Every
// top-level import in this file is a Node built-in plus this repo's own
// `env-path.mjs` convention -- nothing that requires tsx to resolve.
//
// INVOCATION FORM: this script needs `tsx`, not plain `node`, whenever it
// actually reaches `runSendAttribution` (real database access) -- `node`
// only works for the two usage-error paths the acceptance criteria checks
// directly. `docs/runbooks/uat-live-sendgrid.md` documents the one real
// invocation form (a bind-mounted one-shot `api` container in production,
// `tsx` from a repo checkout in a local/dev sandbox) -- see that file for
// why plain `node` cannot run this in the deployed environment either
// (scripts/ is not copied into the runtime image; see docker/Dockerfile.api).
//
// Later plans in this phase (16-02 event-coverage, 16-04 dedup, 16-06
// uat05-state) add sibling subcommands to the dispatch table below; the
// shared query module stays inside THIS file rather than a second module so
// the runbook's bind-mount invocation form only ever needs to mount one path
// (see this plan's SUMMARY for the discovery that drove that decision).

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveEnvPath } from "./env-path.mjs";

/** Subcommands this CLI accepts today. Later plans append to this list. */
const ACCEPTED_SUBCOMMANDS = ["send-attribution", "event-coverage", "dedup", "uat05-state"];

/**
 * Boolean (value-less) flags across every subcommand's parser below. Any
 * `--xxx` NOT in this set is treated as taking the following argv token as
 * its value (plan 16-01's original convention) -- `event-coverage`'s
 * `--require-campaign`/`--require-flow-step` switches are added here rather
 * than duplicating the parsing loop, so plan 16-01's `--json` handling stays
 * unchanged.
 */
const BOOLEAN_FLAGS = new Set(["json", "require-campaign", "require-flow-step"]);

/**
 * Parses `process.argv.slice(2)`-shaped argv into a subcommand-specific
 * options object. Pure -- no I/O, no process.exit -- throws a plain `Error`
 * on any usage problem; the CLI guard below is the only thing that turns a
 * thrown error into `process.exit(2)`.
 */
export function parseArgs(argv) {
  const [subcommand, ...rest] = argv;

  if (!subcommand || !ACCEPTED_SUBCOMMANDS.includes(subcommand)) {
    throw new Error(
      `uat-verify: unknown or missing subcommand "${subcommand ?? ""}". ` +
        `Accepted subcommands: ${ACCEPTED_SUBCOMMANDS.join(", ")}`,
    );
  }

  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
        continue;
      }
      flags[name] = rest[i + 1];
      i++;
      continue;
    }
  }

  if (subcommand === "send-attribution") {
    if (!flags.workspace) {
      throw new Error("uat-verify send-attribution: --workspace <uuid> is required");
    }
    if (!flags["send-id"] && !flags["message-id"]) {
      throw new Error(
        "uat-verify send-attribution: one of --send-id <uuid> or --message-id <sg_message_id> is required",
      );
    }
    const expectEvents = flags["expect-events"]
      ? flags["expect-events"]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    return {
      subcommand,
      workspace: flags.workspace,
      sendId: flags["send-id"] ?? null,
      messageId: flags["message-id"] ?? null,
      expectStatus: flags["expect-status"] ?? null,
      expectEvents,
      json: Boolean(flags.json),
    };
  }

  if (subcommand === "event-coverage") {
    if (!flags.workspace) {
      throw new Error("uat-verify event-coverage: --workspace <uuid> is required");
    }
    return {
      subcommand,
      workspace: flags.workspace,
      since: flags.since ?? null,
      requireCampaign: Boolean(flags["require-campaign"]),
      requireFlowStep: Boolean(flags["require-flow-step"]),
      json: Boolean(flags.json),
    };
  }

  if (subcommand === "dedup") {
    if (!flags.workspace) {
      throw new Error("uat-verify dedup: --workspace <uuid> is required");
    }
    if (!flags.mode || !["snapshot", "compare"].includes(flags.mode)) {
      throw new Error("uat-verify dedup: --mode snapshot|compare is required");
    }
    if (!flags.snapshot) {
      throw new Error("uat-verify dedup: --snapshot <path> is required");
    }
    if (!flags.capture) {
      throw new Error("uat-verify dedup: --capture <path> is required");
    }
    if (!flags["send-id"]) {
      throw new Error("uat-verify dedup: --send-id <uuid> is required");
    }
    if (!flags["event-type"]) {
      throw new Error("uat-verify dedup: --event-type <type> is required");
    }
    if (!flags["occurred-at"]) {
      throw new Error("uat-verify dedup: --occurred-at <iso8601> is required");
    }
    return {
      subcommand,
      workspace: flags.workspace,
      mode: flags.mode,
      snapshotPath: flags.snapshot,
      capturePath: flags.capture,
      sendId: flags["send-id"],
      eventType: flags["event-type"],
      occurredAt: flags["occurred-at"],
      json: Boolean(flags.json),
    };
  }

  if (subcommand === "uat05-state") {
    if (!flags.workspace) {
      throw new Error("uat-verify uat05-state: --workspace <uuid> is required");
    }
    if (!flags["send-id"]) {
      throw new Error("uat-verify uat05-state: --send-id <uuid> is required");
    }
    return {
      subcommand,
      workspace: flags.workspace,
      sendId: flags["send-id"],
      expectStatus: flags["expect-status"] ?? null,
      json: Boolean(flags.json),
    };
  }

  // Unreachable given the ACCEPTED_SUBCOMMANDS guard above -- kept so the
  // dispatch shape stays extensible for 16-04/16-06's subcommands without
  // restructuring this function's control flow when they land.
  throw new Error(`uat-verify: subcommand "${subcommand}" has no flag parser registered`);
}

/**
 * Reads the only capture field the dedup query needs without ever exposing
 * the signature, public key, or decoded recipient data in CLI output. The
 * decoded JSON is re-serialized solely as a parameter for Postgres `jsonb`
 * equality; a SHA-256 digest pins snapshot/compare to the same capture.
 */
export function parseCapturedRawBatch(captureText) {
  const capture = JSON.parse(captureText);
  const encoded = capture?.rawBodyBase64;
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error("capture must contain a non-empty rawBodyBase64 string");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error("capture rawBodyBase64 is not valid canonical base64");
  }

  const rawBytes = Buffer.from(encoded, "base64");
  if (rawBytes.toString("base64") !== encoded) {
    throw new Error("capture rawBodyBase64 is not valid canonical base64");
  }

  const rawBatch = JSON.parse(rawBytes.toString("utf8"));
  if (!Array.isArray(rawBatch) || rawBatch.length === 0) {
    throw new Error("capture rawBodyBase64 must decode to a non-empty SendGrid event array");
  }

  return {
    rawBatchJson: JSON.stringify(rawBatch),
    captureDigest: createHash("sha256").update(rawBytes).digest("hex"),
  };
}

/** Proves the CLI's four-column dedup selector names an event in the capture. */
export function validateCapturedDedupKey(rawBatchJson, { sendId, eventType, occurredAt }) {
  const occurredAtMs = Date.parse(occurredAt);
  if (!Number.isFinite(occurredAtMs)) return false;

  const rawBatch = JSON.parse(rawBatchJson);
  return rawBatch.some((event) => {
    const eventTimestampSeconds = Number(event?.timestamp);
    return (
      String(event?.send_id ?? "") === sendId &&
      String(event?.event ?? "") === eventType &&
      Number.isFinite(eventTimestampSeconds) &&
      eventTimestampSeconds * 1000 === occurredAtMs
    );
  });
}

/**
 * Pure assertion over an already-fetched observation. `observed` is
 * `{ send: {id,status,...} | null, events: [{eventType, occurredAt, ...}] }`;
 * `expectations` is `{ status?: string, events: string[] }`. Never throws --
 * returns `{ passed, reasons }` so the CLI decides the exit code and the
 * printed diagnostics.
 */
export function assertExpectations(observed, expectations) {
  const reasons = [];

  if (!observed.send) {
    reasons.push(
      "zero send rows were observed -- no send row matched the given --send-id/--message-id selector under this workspace",
    );
    return { passed: false, reasons };
  }

  if (expectations.status && observed.send.status !== expectations.status) {
    reasons.push(
      `observed send status "${observed.send.status}" does not match --expect-status "${expectations.status}"`,
    );
  }

  const observedEventTypes = new Set(observed.events.map((e) => e.eventType));
  for (const expectedType of expectations.events ?? []) {
    if (!observedEventTypes.has(expectedType)) {
      reasons.push(`expected event type "${expectedType}" was not found among the observed send_events rows`);
    }
  }

  return { passed: reasons.length === 0, reasons };
}

/**
 * Renders an observation as either a human-readable report or, under
 * `--json`, a single `JSON.parse`-able line carrying the same fields. Pure.
 */
export function formatReport(observed, { json = false } = {}) {
  const send = observed.send;
  const events = observed.events.map((e) => ({
    eventType: e.eventType,
    occurredAt: e.occurredAt,
    sgEventId: e.sgEventId ?? null,
  }));

  if (json) {
    return JSON.stringify({
      sendId: send?.id ?? null,
      sgMessageId: send?.sgMessageId ?? null,
      status: send?.status ?? null,
      events,
    });
  }

  const lines = [];
  lines.push(`send id: ${send?.id ?? "(none)"}`);
  lines.push(`sg_message_id: ${send?.sgMessageId ?? "(none)"}`);
  lines.push(`status: ${send?.status ?? "(none)"}`);
  lines.push(`observed ${String(events.length)} event(s):`);
  for (const e of events) {
    lines.push(`  ${e.eventType} at ${e.occurredAt}`);
  }
  return lines.join("\n");
}

/**
 * Phase 16 plan 06 (UAT-05). A provider 429 releases (deletes) the
 * `dispatching` ledger row before BullMQ delays the same job. That means
 * "deferred" is an observation composed from a retained queue job plus the
 * deliberate absence of its claim row; it is not a Postgres send_status.
 */
export function assertUat05State(observed, { status = null } = {}) {
  const reasons = [];
  if (!observed.send && !observed.queue) {
    reasons.push("zero send rows and zero matching BullMQ jobs were observed for this send id");
    return { passed: false, reasons };
  }
  if (!observed.queue) {
    reasons.push("no retained BullMQ job was found, so attempt count and queue state are unavailable");
  }
  if (status && observed.status !== status) {
    reasons.push(`observed UAT-05 status "${observed.status ?? "(none)"}" does not match --expect-status "${status}"`);
  }
  return { passed: reasons.length === 0, reasons };
}

function toIsoOrNull(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** Pure formatter for the per-send database + BullMQ observation. */
export function formatUat05StateReport(observed, { json = false } = {}) {
  const report = {
    sendId: observed.sendId,
    ledgerRowFound: Boolean(observed.send),
    status: observed.status,
    attemptCount: observed.queue?.attemptCount ?? null,
    queueState: observed.queue?.state ?? null,
    queueName: observed.queue?.name ?? null,
    queueJobId: observed.queue?.jobId ?? null,
    queuedAt: toIsoOrNull(observed.send?.queuedAt),
    dispatchedAt: toIsoOrNull(observed.send?.dispatchedAt),
    reconcilingSince: toIsoOrNull(observed.send?.reconcilingSince),
    sentAt: toIsoOrNull(observed.send?.sentAt),
    events: observed.events.map((event) => ({
      eventType: event.eventType,
      occurredAt: toIsoOrNull(event.occurredAt),
      sgEventId: event.sgEventId ?? null,
    })),
  };

  if (json) return JSON.stringify(report);

  const lines = [
    `send id: ${report.sendId}`,
    `ledger row: ${report.ledgerRowFound ? "found" : "not present (expected while a 429 retry is deferred)"}`,
    `status: ${report.status ?? "(none)"}`,
    `attempt count: ${report.attemptCount ?? "(unavailable)"}`,
    `queue state: ${report.queueState ?? "(unavailable)"}`,
    `queue: ${report.queueName ?? "(unavailable)"} / job ${report.queueJobId ?? "(unavailable)"}`,
    `queued_at: ${report.queuedAt ?? "(none)"}`,
    `dispatched_at: ${report.dispatchedAt ?? "(none)"}`,
    `reconciling_since: ${report.reconcilingSince ?? "(none)"}`,
    `sent_at: ${report.sentAt ?? "(none)"}`,
    `observed ${String(report.events.length)} event(s):`,
  ];
  for (const event of report.events) {
    lines.push(`  ${event.eventType} at ${event.occurredAt}`);
  }
  return lines.join("\n");
}

/**
 * Phase 16 plan 02 (UAT-02). The four SendGrid event types this plan's
 * checkpoint must observe live, spelled EXACTLY as
 * `apps/worker/src/queues/webhook-events.worker.ts`'s `extractEventRow`
 * stores them into `send_events.event_type` (`event.event`, SendGrid's own
 * wire field, stored VERBATIM -- never the normalized/human labels
 * "opened"/"clicked"/"bounced"). Cross-checked against
 * `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts`'s
 * `EVENT_FLAGS`, which provisions the identical wire spelling
 * (`delivered`, `bounce`, `open`, `click`). A hard-coded string anywhere
 * else in this file would silently drift from this source; this is the one
 * named constant every event-coverage check reads from.
 */
const EXPECTED_EVENT_TYPES = ["delivered", "open", "click", "bounce"];

/**
 * Pure summarisation over already-fetched `send_events` JOIN `sends` rows
 * (`{ eventType, occurredAt, sendId, campaignId, nodeId }`). No I/O, no
 * database -- unit-testable in the `scripts/` lane exactly like
 * `assertExpectations` above. `options.since` (an ISO-8601 string) excludes
 * rows whose `occurredAt` precedes it; `options.requireCampaign` /
 * `options.requireFlowStep` gate the result on at least one observed event
 * attributing to a send carrying a non-null `campaignId` / `nodeId`
 * respectively -- the flow "step" reference is `nodeId` (not `flowRunId`):
 * a flow send with a set `flowRunId` but a null `nodeId` is the exact
 * silent attribution gap `--require-flow-step` exists to catch
 * (packages/db/src/schema/sends.ts).
 */
export function summariseEventCoverage(rows, options = {}) {
  const { since = null, requireCampaign = false, requireFlowStep = false } = options;

  const sinceMs = since ? new Date(since).getTime() : null;
  const filteredRows = sinceMs === null ? rows : rows.filter((r) => new Date(r.occurredAt).getTime() >= sinceMs);

  const byType = new Map();
  const campaignAttributedSendIds = new Set();
  const flowStepAttributedSendIds = new Set();
  const unattributedCampaignSendIds = new Set();
  const unattributedFlowStepSendIds = new Set();

  for (const row of filteredRows) {
    if (!byType.has(row.eventType)) {
      byType.set(row.eventType, { count: 0, sendId: row.sendId });
    }
    byType.get(row.eventType).count += 1;

    if (row.campaignId) {
      campaignAttributedSendIds.add(row.sendId);
    } else {
      unattributedCampaignSendIds.add(row.sendId);
    }
    if (row.nodeId) {
      flowStepAttributedSendIds.add(row.sendId);
    } else {
      unattributedFlowStepSendIds.add(row.sendId);
    }
  }

  const observed = EXPECTED_EVENT_TYPES.filter((type) => byType.has(type)).map((type) => ({
    eventType: type,
    ...byType.get(type),
  }));
  // Any observed type outside the expected set is reported too, never
  // silently dropped -- unlikely (EVENT_FLAGS is the provisioning
  // superset), but a summarisation that hides an unrecognised row would
  // itself be a vacuous-pass risk.
  for (const [type, info] of byType) {
    if (!EXPECTED_EVENT_TYPES.includes(type)) {
      observed.push({ eventType: type, ...info });
    }
  }

  const missing = EXPECTED_EVENT_TYPES.filter((type) => !byType.has(type));

  const hasCampaignAttribution = campaignAttributedSendIds.size > 0;
  const hasFlowStepAttribution = flowStepAttributedSendIds.size > 0;

  const unattributed = {};
  if (requireCampaign && !hasCampaignAttribution) {
    unattributed.campaign = [...unattributedCampaignSendIds];
  }
  if (requireFlowStep && !hasFlowStepAttribution) {
    unattributed.flowStep = [...unattributedFlowStepSendIds];
  }

  const pass =
    missing.length === 0 &&
    (!requireCampaign || hasCampaignAttribution) &&
    (!requireFlowStep || hasFlowStepAttribution);

  return { pass, observed, missing, unattributed };
}

/**
 * Renders a `summariseEventCoverage` result as either a human-readable
 * report or, under `--json`, a single `JSON.parse`-able line. Pure --
 * mirrors `formatReport`'s json/human split above.
 */
export function formatEventCoverageReport(result, { json = false } = {}) {
  if (json) {
    return JSON.stringify(result);
  }

  const lines = [];
  lines.push(`event-coverage: ${result.pass ? "PASS" : "FAIL"}`);
  for (const o of result.observed) {
    lines.push(`  ${o.eventType}: ${String(o.count)} observed, attributed to send ${o.sendId ?? "(none)"}`);
  }
  if (result.missing.length > 0) {
    lines.push(`missing event type(s): ${result.missing.join(", ")}`);
  }
  if (result.unattributed.campaign) {
    lines.push(
      `no campaign-attributed send observed (unattributed send id(s): ${result.unattributed.campaign.join(", ")})`,
    );
  }
  if (result.unattributed.flowStep) {
    lines.push(
      `no flow-step-attributed send observed (unattributed send id(s): ${result.unattributed.flowStep.join(", ")})`,
    );
  }
  return lines.join("\n");
}

/**
 * Phase 16 plan 04 (UAT-03/UAT-04, D-12). Pure two-layer exactly-once
 * assertion over a before/after pair of dedup snapshots (each shaped exactly
 * like `collectDedupSnapshot`'s return value below). No I/O -- unit-testable
 * with in-memory fixtures, same discipline as `assertExpectations` and
 * `summariseEventCoverage` above.
 *
 * Encodes RESEARCH.md Pitfall 4's polarity EXPLICITLY, because getting it
 * backwards produces a false failure on a correctly-working system:
 *
 * 1. `after.sendEventsCount` must be exactly 1 -- the dedup key is the four
 *    columns of `send_events_dedup_v2_idx` (migration 0057:
 *    `workspace_id, send_id, event_type, occurred_at`; `sg_event_id` is a
 *    demoted forensic column, deliberately NOT part of the enforced key).
 *    A byte-exact replay of an already-ingested event must NOT produce a
 *    second row under this key -- 2 means a duplicate survived; 0 means the
 *    row is missing entirely (a different defect, reported as its own
 *    cause, never silently treated as "no duplicate, therefore pass").
 * 2. `after.ingressJournalCount - before.ingressJournalCount` must be
 *    exactly 1 -- `ingress_journal`'s job is "record every verified
 *    delivery attempt," not dedup (that lives one layer downstream at the
 *    `send_events` insert). A replay that reaches the verified webhook
 *    route is journaled AGAIN, and an increase of exactly one is the
 *    CORRECT, expected outcome, never a failure. The count is scoped to
 *    `raw_batch = captured batch`, so unrelated traffic on a shared
 *    SendGrid account cannot contaminate this assertion. A delta of 0 means
 *    the replay was never ingested (a real defect); any other delta is
 *    reported with the actual before/after numbers rather than a bare
 *    non-zero exit.
 * 3. Every `workspace_daily_rollup` counter and every `campaigns` counter
 *    must be byte-identical between `before` and `after` -- a dedup that
 *    stops the duplicate ROW but still double-increments an aggregate
 *    counter is a real defect this helper must catch, per D-12's own
 *    "counted exactly once, at both layers" requirement. Comparing at
 *    field granularity (not just "did state change") is what lets the
 *    failure message name exactly which counter drifted and by how much.
 *
 * Returns `{ passed, reasons }`, never throws -- the CLI decides the exit
 * code and how to print `reasons`.
 */
export function compareDedupSnapshot(before, after) {
  const reasons = [];

  if (before.captureDigest !== after.captureDigest) {
    reasons.push("dedup snapshot and compare used different capture payloads");
  }
  for (const field of ["workspaceId", "sendId", "eventType", "occurredAt"]) {
    if (before[field] !== after[field]) {
      reasons.push(`dedup snapshot and compare used a different dedup identity field: ${field}`);
    }
  }

  const sendEventsCount = after.sendEventsCount;
  if (sendEventsCount !== 1) {
    if (sendEventsCount > 1) {
      reasons.push(
        `send_events count for the dedup key (workspace_id=${String(after.workspaceId)}, send_id=${String(after.sendId)}, event_type=${String(after.eventType)}, occurred_at=${String(after.occurredAt)}) is ${String(sendEventsCount)} -- duplicate rows survived the replay; expected exactly 1.`,
      );
    } else {
      reasons.push(
        `send_events count for the dedup key (workspace_id=${String(after.workspaceId)}, send_id=${String(after.sendId)}, event_type=${String(after.eventType)}, occurred_at=${String(after.occurredAt)}) is 0 -- the row is absent, not merely undeduplicated; expected exactly 1.`,
      );
    }
  }

  const journalDelta = after.ingressJournalCount - before.ingressJournalCount;
  if (journalDelta !== 1) {
    if (journalDelta === 0) {
      reasons.push(
        `ingress_journal row count for the captured batch in workspace ${String(after.workspaceId)} did not increase (before=${String(before.ingressJournalCount)}, after=${String(after.ingressJournalCount)}) -- the replay was never ingested.`,
      );
    } else {
      reasons.push(
        `ingress_journal row count for the captured batch in workspace ${String(after.workspaceId)} changed by ${String(journalDelta)} (before=${String(before.ingressJournalCount)}, after=${String(after.ingressJournalCount)}), not the expected increase of exactly 1 -- an increase of exactly one is the correct outcome, not a failure, so any other delta is reported as its own defect.`,
      );
    }
  }

  const ROLLUP_FIELDS = [
    "sentCount",
    "deliveredCount",
    "openedCount",
    "clickedCount",
    "bouncedCount",
    "unsubscribedCount",
  ];
  for (const field of ROLLUP_FIELDS) {
    const beforeVal = before.rollup ? before.rollup[field] ?? null : null;
    const afterVal = after.rollup ? after.rollup[field] ?? null : null;
    if (beforeVal !== afterVal) {
      reasons.push(
        `workspace_daily_rollup.${field} changed from ${String(beforeVal)} to ${String(afterVal)} -- every rollup and campaign counter must be unchanged by a correctly-deduplicated replay.`,
      );
    }
  }

  const CAMPAIGN_FIELDS = [
    "sentCount",
    "failedCount",
    "deliveredCount",
    "openedCount",
    "clickedCount",
    "bouncedCount",
    "unsubscribedCount",
  ];
  for (const field of CAMPAIGN_FIELDS) {
    const beforeVal = before.campaignCounters ? before.campaignCounters[field] ?? null : null;
    const afterVal = after.campaignCounters ? after.campaignCounters[field] ?? null : null;
    if (beforeVal !== afterVal) {
      reasons.push(
        `campaigns.${field} changed from ${String(beforeVal)} to ${String(afterVal)} -- every rollup and campaign counter must be unchanged by a correctly-deduplicated replay.`,
      );
    }
  }

  return { passed: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Database access -- kept OUT of the pure helpers above on purpose (this
// repo's scripts/vitest.config.ts lane has no database globalSetup). Called
// only from the CLI path, never from a test.
// ---------------------------------------------------------------------------

/**
 * Runs the `send-attribution` subcommand: one row from `sends` matched by
 * id (or by `provider_message_id` when `--send-id` is absent), plus every
 * `send_events` row for that send. Scoped through `withTenant`/
 * `withTenantTransaction` bound to `--workspace` -- no new grant, no
 * cross-tenant read (T-16-01).
 *
 * NOTE: `sends`'s own column is `provider_message_id`, not `sg_message_id`
 * (packages/db/src/schema/sends.ts) -- this plan's own action text named the
 * column `sg_message_id`, which does not exist; this query aliases
 * `provider_message_id AS sg_message_id` so the CLI's own output field names
 * (and this repo's SendGrid terminology) still read as `sgMessageId`
 * everywhere outside this one query.
 */
async function runSendAttribution(parsed) {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(resolveEnvPath());
    } catch {
      // No configuration file -- rely on already-exported environment
      // variables (CI, containers: every variable is exported directly).
      // Mirrors scripts/migrate-runner.mjs's identical fallback.
    }
  }

  if (!process.env.DATABASE_URL) {
    console.error(
      "uat-verify: DATABASE_URL is required -- set it in the resolved env file or export it directly",
    );
    return 2;
  }

  // @mega-crm/tenant-context is a real, already-installed workspace package
  // (apps/api's and apps/worker's own "dependencies" entry) reached here via
  // workspace hoisting, same as every other @mega-crm/* deep-import in this
  // repo (e.g. packages/db/scripts/*.ts). It is not declared in THIS
  // package.json (root) because scripts/ has never needed a workspace
  // package before uat-verify.mjs; declaring it here only to satisfy this
  // lint rule would regenerate package-lock.json's unrelated pre-existing
  // npm10/npm11 resolution drift (confirmed empirically -- a ~650-line
  // incidental diff with no dependency actually added), which is out of
  // this plan's scope to fix.
  // eslint-disable-next-line import-x/no-extraneous-dependencies
  const { withTenant, withTenantTransaction, pool } = await import("@mega-crm/tenant-context");

  let observed;
  try {
    observed = await withTenant(parsed.workspace, () =>
      withTenantTransaction(async (client) => {
        const { rows: sendRows } = await client.query(
          `SELECT id, status, provider_message_id AS sg_message_id, campaign_id, flow_run_id, queued_at, sent_at
             FROM sends
            WHERE ($1::uuid IS NOT NULL AND id = $1::uuid)
               OR ($1::uuid IS NULL AND provider_message_id = $2)`,
          [parsed.sendId, parsed.messageId],
        );
        const sendRow = sendRows[0] ?? null;

        let eventRows = [];
        if (sendRow) {
          const result = await client.query(
            `SELECT event_type, occurred_at, sg_event_id
               FROM send_events
              WHERE send_id = $1
              ORDER BY occurred_at ASC`,
            [sendRow.id],
          );
          eventRows = result.rows;
        }

        return {
          send: sendRow
            ? {
                id: sendRow.id,
                status: sendRow.status,
                sgMessageId: sendRow.sg_message_id,
                campaignId: sendRow.campaign_id,
                flowRunId: sendRow.flow_run_id,
                queuedAt: sendRow.queued_at,
                sentAt: sendRow.sent_at,
              }
            : null,
          events: eventRows.map((r) => ({
            eventType: r.event_type,
            occurredAt: r.occurred_at,
            sgEventId: r.sg_event_id,
          })),
        };
      }),
    );
  } finally {
    await pool.end();
  }

  console.log(formatReport(observed, { json: parsed.json }));
  // Anti-vacuous-pass discipline (check-spec-env-coverage.mjs's own
  // convention): the observed-row count is printed on every run, so a
  // vacuous pass (zero rows, zero expectations) is visible rather than
  // hidden inside a bare exit 0.
  console.log(
    `observed ${String(observed.events.length)} send_events row(s); send row ${
      observed.send ? "found" : "NOT found"
    }.`,
  );

  const result = assertExpectations(observed, {
    status: parsed.expectStatus,
    events: parsed.expectEvents,
  });
  if (!result.passed) {
    for (const reason of result.reasons) {
      console.error(`FAIL: ${reason}`);
    }
    return 1;
  }
  return 0;
}

/**
 * Runs the `event-coverage` subcommand (Phase 16 plan 02, UAT-02): every
 * `send_events` row for this workspace, joined to `sends` for its campaign
 * and flow-step (`node_id`) reference, summarised by `summariseEventCoverage`.
 * Scoped through `withTenant`/`withTenantTransaction` exactly like
 * `runSendAttribution` above -- no new grant, no cross-tenant read (T-16-06).
 *
 * The JOIN's `send_id IS NOT NULL` guard mirrors D-15 (webhook worker,
 * migration-era note): a `send_events` row with no resolved send can never
 * carry campaign/flow-step attribution and is out of scope for this
 * subcommand's own truths (attribution, not raw event volume).
 */
async function runEventCoverage(parsed) {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(resolveEnvPath());
    } catch {
      // No configuration file -- rely on already-exported environment
      // variables (CI, containers: every variable is exported directly).
    }
  }

  if (!process.env.DATABASE_URL) {
    console.error(
      "uat-verify: DATABASE_URL is required -- set it in the resolved env file or export it directly",
    );
    return 2;
  }

  // eslint-disable-next-line import-x/no-extraneous-dependencies
  const { withTenant, withTenantTransaction, pool } = await import("@mega-crm/tenant-context");

  let rows;
  try {
    rows = await withTenant(parsed.workspace, () =>
      withTenantTransaction(async (client) => {
        const { rows: joined } = await client.query(
          `SELECT se.event_type, se.occurred_at, se.send_id, s.campaign_id, s.node_id
             FROM send_events se
             JOIN sends s ON s.id = se.send_id
            WHERE se.send_id IS NOT NULL
            ORDER BY se.occurred_at ASC`,
        );
        return joined.map((r) => ({
          eventType: r.event_type,
          occurredAt: r.occurred_at,
          sendId: r.send_id,
          campaignId: r.campaign_id,
          nodeId: r.node_id,
        }));
      }),
    );
  } finally {
    await pool.end();
  }

  const result = summariseEventCoverage(rows, {
    since: parsed.since,
    requireCampaign: parsed.requireCampaign,
    requireFlowStep: parsed.requireFlowStep,
  });

  console.log(formatEventCoverageReport(result, { json: parsed.json }));
  // Anti-vacuous-pass discipline, same convention as runSendAttribution.
  console.log(`observed ${String(rows.length)} send_events row(s) with a resolved send.`);

  if (!result.pass) {
    if (result.missing.length > 0) {
      console.error(`FAIL: missing event type(s): ${result.missing.join(", ")}`);
    }
    if (result.unattributed.campaign) {
      console.error(
        `FAIL: no campaign-attributed send observed among: ${result.unattributed.campaign.join(", ")}`,
      );
    }
    if (result.unattributed.flowStep) {
      console.error(
        `FAIL: no flow-step-attributed send observed among: ${result.unattributed.flowStep.join(", ")}`,
      );
    }
    return 1;
  }
  return 0;
}

/**
 * Phase 16 plan 04 (UAT-03/UAT-04, D-12): collects one dedup snapshot --
 * the `send_events` count for the exact four-column dedup key, the
 * `ingress_journal` count for the captured `raw_batch`, the `workspace_daily_rollup`
 * row for the UTC day of `occurred_at`, and the campaign counter columns for
 * the campaign the send belongs to (`null` when the send carries no
 * campaign, e.g. a flow-step send). Called identically from BOTH
 * `--mode snapshot` (written to disk) and `--mode compare` (the "after"
 * side, compared in-memory against the "before" side read from disk) --
 * `compareDedupSnapshot` above is what gives the two calls different
 * meaning, not this collection step.
 *
 * Scoped through `withTenant`/`withTenantTransaction` bound to `--workspace`,
 * same as `runSendAttribution`/`runEventCoverage` above -- no new grant, no
 * cross-tenant read.
 */
async function collectDedupSnapshot(client, parsed) {
  // Dedup key is EXACTLY these four columns -- send_events_dedup_v2_idx
  // (migration 0057, Phase 13 CMP-07/D-15). `sg_event_id` is a demoted,
  // NOT NULL forensic-correlation column, deliberately excluded from the
  // enforced uniqueness -- filtering on it here would test the wrong thing.
  const { rows: sendEventsRows } = await client.query(
    `SELECT count(*)::int AS count
       FROM send_events
      WHERE workspace_id = $1
        AND send_id = $2
        AND event_type = $3
        AND occurred_at = $4::timestamptz`,
    [parsed.workspace, parsed.sendId, parsed.eventType, parsed.occurredAt],
  );
  const sendEventsCount = sendEventsRows[0].count;

  const { rows: journalRows } = await client.query(
    `SELECT count(*)::int AS count
       FROM ingress_journal
      WHERE workspace_id = $1
        AND raw_batch = $2::jsonb`,
    [parsed.workspace, parsed.captureRawBatchJson],
  );
  const ingressJournalCount = journalRows[0].count;

  const { rows: sendRows } = await client.query(`SELECT campaign_id FROM sends WHERE id = $1`, [
    parsed.sendId,
  ]);
  const campaignId = sendRows[0]?.campaign_id ?? null;

  // Phase 13's UTC day semantics (workspace-daily-rollup.ts, CMP-02): bucket
  // by the SAME `AT TIME ZONE 'UTC'` cast the incremental/reconciliation
  // writers use -- a bare `::date` cast would depend on this session's
  // `TimeZone` GUC and could silently select the wrong day's row.
  const { rows: rollupRows } = await client.query(
    `SELECT sent_count, delivered_count, opened_count, clicked_count, bounced_count, unsubscribed_count
       FROM workspace_daily_rollup
      WHERE workspace_id = $1
        AND day = ($2::timestamptz AT TIME ZONE 'UTC')::date`,
    [parsed.workspace, parsed.occurredAt],
  );
  const rollupRow = rollupRows[0] ?? null;

  let campaignCounters = null;
  if (campaignId) {
    const { rows: campaignRows } = await client.query(
      `SELECT sent_count, failed_count, delivered_count, opened_count, clicked_count, bounced_count, unsubscribed_count
         FROM campaigns
        WHERE id = $1`,
      [campaignId],
    );
    const c = campaignRows[0];
    if (c) {
      campaignCounters = {
        sentCount: c.sent_count,
        failedCount: c.failed_count,
        deliveredCount: c.delivered_count,
        openedCount: c.opened_count,
        clickedCount: c.clicked_count,
        bouncedCount: c.bounced_count,
        unsubscribedCount: c.unsubscribed_count,
      };
    }
  }

  return {
    workspaceId: parsed.workspace,
    sendId: parsed.sendId,
    eventType: parsed.eventType,
    occurredAt: parsed.occurredAt,
    sendEventsCount,
    ingressJournalCount,
    captureDigest: parsed.captureDigest,
    campaignId,
    rollup: rollupRow
      ? {
          sentCount: rollupRow.sent_count,
          deliveredCount: rollupRow.delivered_count,
          openedCount: rollupRow.opened_count,
          clickedCount: rollupRow.clicked_count,
          bouncedCount: rollupRow.bounced_count,
          unsubscribedCount: rollupRow.unsubscribed_count,
        }
      : null,
    campaignCounters,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Runs the `dedup` subcommand (Phase 16 plan 04, UAT-03/UAT-04). In
 * `--mode snapshot`, collects and writes a snapshot file. In
 * `--mode compare`, reads that same file as the "before" side, collects a
 * fresh "after" snapshot, and hands both to `compareDedupSnapshot`.
 *
 * The snapshot-file read happens FIRST, before any DATABASE_URL check or
 * database access -- a missing or unparseable snapshot file is a usage
 * error (exit 2), never a false pass, and this ordering is what lets that
 * one failure mode be exercised by a plain `node` invocation with no
 * database at all (mirrors this file's own "usage error, exit 2" contract
 * for `parseArgs` failures, extended to this one runtime-only usage error
 * that `parseArgs` itself cannot detect, since the path could be well-formed
 * and merely point at a missing/corrupt file).
 */
async function runDedup(parsed) {
  let beforeSnapshot = null;
  if (parsed.mode === "compare") {
    try {
      beforeSnapshot = JSON.parse(readFileSync(parsed.snapshotPath, "utf8"));
    } catch (err) {
      console.error(
        `uat-verify dedup: could not read/parse snapshot file at "${parsed.snapshotPath}" -- ${describeError(err)}. Compare mode requires a valid snapshot written by a prior --mode snapshot run.`,
      );
      return 2;
    }
  }

  try {
    const capture = parseCapturedRawBatch(readFileSync(parsed.capturePath, "utf8"));
    if (!validateCapturedDedupKey(capture.rawBatchJson, parsed)) {
      throw new Error(
        "--send-id/--event-type/--occurred-at do not identify an event in the captured batch",
      );
    }
    parsed.captureRawBatchJson = capture.rawBatchJson;
    parsed.captureDigest = capture.captureDigest;
  } catch (err) {
    console.error(
      `uat-verify dedup: could not read/parse capture file at "${parsed.capturePath}" -- ${describeError(err)}. Both snapshot and compare require the same valid replay capture.`,
    );
    return 2;
  }

  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(resolveEnvPath());
    } catch {
      // No configuration file -- rely on already-exported environment
      // variables (CI, containers: every variable is exported directly).
    }
  }

  if (!process.env.DATABASE_URL) {
    console.error(
      "uat-verify: DATABASE_URL is required -- set it in the resolved env file or export it directly",
    );
    return 2;
  }

  // eslint-disable-next-line import-x/no-extraneous-dependencies
  const { withTenant, withTenantTransaction, pool } = await import("@mega-crm/tenant-context");

  let snapshot;
  try {
    snapshot = await withTenant(parsed.workspace, () =>
      withTenantTransaction((client) => collectDedupSnapshot(client, parsed)),
    );
  } finally {
    await pool.end();
  }

  if (parsed.mode === "snapshot") {
    writeFileSync(parsed.snapshotPath, JSON.stringify(snapshot, null, 2));
    console.log(`uat-verify dedup: snapshot written to ${parsed.snapshotPath}`);
    console.log(parsed.json ? JSON.stringify(snapshot) : JSON.stringify(snapshot, null, 2));
    return 0;
  }

  const result = compareDedupSnapshot(beforeSnapshot, snapshot);
  if (parsed.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`dedup compare: ${result.passed ? "PASS" : "FAIL"}`);
    for (const reason of result.reasons) {
      console.log(`  ${reason}`);
    }
  }
  // Anti-vacuous-pass discipline, same convention as the other subcommands.
  console.log(
    `send_events count for the dedup key: ${String(snapshot.sendEventsCount)}; ingress_journal delta: ${String(
      snapshot.ingressJournalCount - beforeSnapshot.ingressJournalCount,
    )}.`,
  );

  if (!result.passed) {
    for (const reason of result.reasons) {
      console.error(`FAIL: ${reason}`);
    }
    return 1;
  }
  return 0;
}

function deriveUat05Status(send, queue) {
  if (send) return send.status;
  if (!queue) return null;
  if (queue.state === "delayed" || (queue.state === "waiting" && queue.processedOn !== null)) {
    return "deferred";
  }
  return "pending";
}

function jobMatchesSendId(job, parsed, deriveCampaignSendId, deriveFlowSendId) {
  const data = job?.data;
  if (!data || data.workspaceId !== parsed.workspace) return false;
  try {
    if (data.kind === "flow" && data.flowRunId && data.nodeId) {
      return deriveFlowSendId(data.workspaceId, data.flowRunId, data.nodeId) === parsed.sendId;
    }
    if (data.kind === "campaign" && data.campaignId && data.contactId) {
      return deriveCampaignSendId(data.workspaceId, data.campaignId, data.contactId) === parsed.sendId;
    }
  } catch {
    return false;
  }
  return false;
}

async function observeQueueJob(queue, job) {
  return {
    name: queue.name,
    jobId: String(job.id),
    state: await job.getState(),
    attemptCount: job.attemptsMade,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
  };
}

async function findUat05QueueJob({ queues, send, parsed, deriveCampaignSendId, deriveFlowSendId }) {
  if (send) {
    const descriptor =
      send.kind === "flow" && send.flowRunId && send.nodeId
        ? { queueName: "email-triggered", jobId: `${send.flowRunId}-${send.nodeId}` }
        : send.campaignId && send.contactId
          ? {
              queueName: "email-broadcast",
              jobId: `${parsed.workspace}-${send.campaignId}-${send.contactId}`,
            }
          : null;
    if (descriptor) {
      const queue = queues.find((candidate) => candidate.name === descriptor.queueName);
      const job = await queue?.getJob(descriptor.jobId);
      if (job && jobMatchesSendId(job, parsed, deriveCampaignSendId, deriveFlowSendId)) {
        return observeQueueJob(queue, job);
      }
    }
  }

  // During a provider-429 deferral the claim row is deliberately deleted,
  // so there is no campaign/contact tuple to reconstruct the deterministic
  // BullMQ job id from. Search a bounded recent window and derive each
  // candidate's stable send id from its job payload. This remains bounded
  // even if another workspace has a large retained completed-job history.
  const states = ["active", "waiting", "delayed", "prioritized", "completed", "failed", "waiting-children"];
  for (const queue of queues) {
    const jobs = await queue.getJobs(states, 0, 1_999, false);
    const job = jobs.find((candidate) =>
      jobMatchesSendId(candidate, parsed, deriveCampaignSendId, deriveFlowSendId),
    );
    if (job) return observeQueueJob(queue, job);
  }
  return null;
}

/**
 * Phase 16 plan 06 (UAT-05): join the tenant-scoped send/event facts to the
 * retained BullMQ job that owns the attempt count and queue state.
 */
async function runUat05State(parsed) {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
    try {
      process.loadEnvFile(resolveEnvPath());
    } catch {
      // No configuration file -- rely on already-exported container/CI env.
    }
  }
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
    console.error(
      "uat-verify uat05-state: DATABASE_URL and REDIS_URL are required -- set them in the resolved env file or export them directly",
    );
    return 2;
  }

  // All workspace packages stay dynamically loaded for the plain-node usage
  // error contract documented at this file's top. The deployed api image
  // contains these compiled packages; local real invocations use tsx.
  // eslint-disable-next-line import-x/no-extraneous-dependencies
  const { withTenant, withTenantTransaction, pool } = await import("@mega-crm/tenant-context");
  // eslint-disable-next-line import-x/no-extraneous-dependencies
  const { buildRedisConnectionOptions } = await import("@mega-crm/queue-core");
  // eslint-disable-next-line import-x/no-extraneous-dependencies
  const { deriveCampaignSendId, deriveFlowSendId } = await import("@mega-crm/delivery-core");
  // eslint-disable-next-line import-x/no-extraneous-dependencies
  const { EMAIL_BROADCAST_QUEUE, EMAIL_TRIGGERED_QUEUE } = await import("@mega-crm/shared-schemas");
  // eslint-disable-next-line import-x/no-extraneous-dependencies
  const { Queue } = await import("bullmq");

  const connection = buildRedisConnectionOptions(process.env.REDIS_URL);
  const queues = [
    new Queue(EMAIL_BROADCAST_QUEUE, { connection }),
    new Queue(EMAIL_TRIGGERED_QUEUE, { connection }),
  ];
  for (const queue of queues) {
    // BullMQ forwards ioredis failures as EventEmitter `error` events. The
    // awaited getter still rejects with the actionable failure; this no-op
    // listener prevents EventEmitter from crashing before the CLI can print it.
    queue.on("error", () => {});
  }

  let send;
  let events;
  let queue;
  try {
    ({ send, events } = await withTenant(parsed.workspace, () =>
      withTenantTransaction(async (client) => {
        const { rows: sendRows } = await client.query(
          `SELECT id, kind, status, campaign_id, contact_id, flow_run_id, node_id,
                  provider_message_id, queued_at, dispatched_at, reconciling_since,
                  sent_at, dispatch_duration_ms
             FROM sends
            WHERE id = $1`,
          [parsed.sendId],
        );
        const row = sendRows[0] ?? null;
        const { rows: eventRows } = await client.query(
          `SELECT event_type, occurred_at, sg_event_id
             FROM send_events
            WHERE send_id = $1
            ORDER BY occurred_at ASC`,
          [parsed.sendId],
        );
        return {
          send: row
            ? {
                id: row.id,
                kind: row.kind,
                status: row.status,
                campaignId: row.campaign_id,
                contactId: row.contact_id,
                flowRunId: row.flow_run_id,
                nodeId: row.node_id,
                providerMessageId: row.provider_message_id,
                queuedAt: row.queued_at,
                dispatchedAt: row.dispatched_at,
                reconcilingSince: row.reconciling_since,
                sentAt: row.sent_at,
                dispatchDurationMs: row.dispatch_duration_ms,
              }
            : null,
          events: eventRows.map((event) => ({
            eventType: event.event_type,
            occurredAt: event.occurred_at,
            sgEventId: event.sg_event_id,
          })),
        };
      }),
    ));

    queue = await findUat05QueueJob({
      queues,
      send,
      parsed,
      deriveCampaignSendId,
      deriveFlowSendId,
    });
  } finally {
    await Promise.allSettled([...queues.map((entry) => entry.close()), pool.end()]);
  }

  const observed = {
    sendId: parsed.sendId,
    send,
    queue,
    status: deriveUat05Status(send, queue),
    events,
  };
  console.log(formatUat05StateReport(observed, { json: parsed.json }));
  if (!parsed.json) {
    console.log(
      `observed ${String(events.length)} send_events row(s); send row ${send ? "found" : "not present"}; queue job ${queue ? "found" : "NOT found"}.`,
    );
  }

  const result = assertUat05State(observed, { status: parsed.expectStatus });
  if (!result.passed) {
    for (const reason of result.reasons) console.error(`FAIL: ${reason}`);
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// CLI -- guarded so importing this module for tests does not execute it.
// ---------------------------------------------------------------------------

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${path.resolve(entry)}`;
}

/**
 * `AggregateError` (e.g. Node's own ECONNREFUSED for a `pg` connection
 * attempt) has an empty top-level `.message` -- the real diagnostic text
 * lives on its `.errors` array. Falls back to a plain `.message`/`String()`
 * for everything else, so a real connection failure is diagnosable from the
 * CLI's own stderr rather than printing a blank "FAILED --" line.
 */
function describeError(err) {
  if (err instanceof AggregateError) {
    return err.errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

async function main() {
  const argv = process.argv.slice(2);

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
    return;
  }

  if (parsed.subcommand === "send-attribution") {
    let exitCode;
    try {
      exitCode = await runSendAttribution(parsed);
    } catch (err) {
      console.error("uat-verify: FAILED --", describeError(err));
      exitCode = 1;
    }
    process.exit(exitCode);
  }

  if (parsed.subcommand === "event-coverage") {
    let exitCode;
    try {
      exitCode = await runEventCoverage(parsed);
    } catch (err) {
      console.error("uat-verify: FAILED --", describeError(err));
      exitCode = 1;
    }
    process.exit(exitCode);
  }

  if (parsed.subcommand === "dedup") {
    let exitCode;
    try {
      exitCode = await runDedup(parsed);
    } catch (err) {
      console.error("uat-verify: FAILED --", describeError(err));
      exitCode = 1;
    }
    process.exit(exitCode);
  }

  if (parsed.subcommand === "uat05-state") {
    let exitCode;
    try {
      exitCode = await runUat05State(parsed);
    } catch (err) {
      console.error("uat-verify: FAILED --", describeError(err));
      exitCode = 1;
    }
    process.exit(exitCode);
  }
}

if (isDirectInvocation()) {
  main();
}
