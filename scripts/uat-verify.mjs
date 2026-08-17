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

import path from "node:path";

import { resolveEnvPath } from "./env-path.mjs";

/** Subcommands this CLI accepts today. Later plans append to this list. */
const ACCEPTED_SUBCOMMANDS = ["send-attribution"];

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
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = rest[i + 1];
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

  // Unreachable given the ACCEPTED_SUBCOMMANDS guard above -- kept so the
  // dispatch shape stays extensible for 16-02/16-04/16-06's subcommands
  // without restructuring this function's control flow when they land.
  throw new Error(`uat-verify: subcommand "${subcommand}" has no flag parser registered`);
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
}

if (isDirectInvocation()) {
  main();
}
