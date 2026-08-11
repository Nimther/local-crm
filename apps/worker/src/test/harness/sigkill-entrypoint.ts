import type { SendGridMailSendRequest, SendTenantMailResult } from "@mega-crm/delivery-core";
import type { EmailBroadcastJob, EmailTriggeredJob } from "@mega-crm/shared-schemas";
import { scrubbedConsole } from "@mega-crm/redaction";

import { processSendJob } from "../../queues/send-dispatch.js";

/**
 * 08-12 (QG-06 scenario 4, D-22/D-23), extended 11-11 (DLV-08 boundaries 1
 * and 2) -- the child process that freezes at a selectable point inside the
 * dispatch pipeline and waits to be killed.
 *
 * TEST HARNESS ONLY. Nothing in production imports this file.
 *
 * Two freeze points, selected by `SIGKILL_HARNESS_FREEZE_AT`
 * (`SigkillFreezePoint`), defaulting to `in_claim_window` so the ORIGINAL
 * (08-12) scenario's behavior is completely unchanged by this extension:
 *
 * - `in_claim_window` (the original window, where the CR-04 duplicate-send
 *   bug lived): `dispatchSendGate` commits a `dispatching` row in its own
 *   transaction, and only then is the mail call made. The injected mail
 *   function posts `SIGKILL_HARNESS_READY` the INSTANT it is invoked -- before
 *   doing anything that could resemble contacting a provider -- and then
 *   never settles. A process killed here has committed the claim but never
 *   even attempted to reach SendGrid.
 *
 * - `after_provider_accept` (DLV-08 boundary 2, the phase's headline
 *   scenario): the injected mail function posts `SIGKILL_HARNESS_ACCEPTED`
 *   and then never settles. Posting that marker IS the simulated fact that
 *   SendGrid has taken custody of the message -- the process is then killed
 *   while it holds no record of that. This is a FAITHFUL SIMULATION of the
 *   boundary, not a literal in-process "return a 202, then die": a real 202
 *   response would be handled by unit 3's own record transaction, so letting
 *   the fake actually resolve would just make the process commit the record
 *   normally -- no crash would have occurred, and the scenario would prove
 *   nothing. The only way to reproduce "SendGrid has the message, this
 *   process does not" deterministically is to freeze BEFORE any resolution,
 *   with the marker itself standing in for the acceptance.
 *
 * An unrecognized `SIGKILL_HARNESS_FREEZE_AT` value calls `fail()` -- a typo
 * must kill the child loudly rather than silently run the wrong scenario and
 * produce a confusing, unrelated assertion failure in the parent.
 *
 * The freeze mechanism is the injected mail function, and the ORDER of its
 * two statements is load-bearing for BOTH freeze points (D-23): it posts the
 * marker FIRST and only then returns a promise that never settles. The
 * parent kills in response to that marker, so the kill provably lands inside
 * the window rather than somewhere near it. A timer or a database poll would
 * land at an arbitrary instant, which SPEC R6 says outright proves nothing --
 * and there is deliberately no timer anywhere in this file.
 *
 * This process does NOT boot the real queue runtime, for either freeze
 * point. That boot registers the live BullMQ consumers, which reach
 * `sendTenantMailV3`, and `packages/delivery-core/src/send-mail.ts`
 * hardcodes the SendGrid endpoint -- starting it would risk real mail
 * leaving a tenant's account, which the SPEC negative criterion forbids
 * outright. `processSendJob` is imported directly and only `sendMail` is
 * injected; injecting anything more would mean exercising the harness rather
 * than the production dispatch path.
 */

/** Selects which point in the dispatch pipeline the child freezes at. Defaults to `in_claim_window`. */
export type SigkillFreezePoint = "in_claim_window" | "after_provider_accept";

/** Posted to the parent from inside the frozen mail call, for `in_claim_window`. */
export const SIGKILL_HARNESS_READY = "sigkill-harness:frozen-in-claim-window";

/** Posted to the parent from inside the frozen mail call, for `after_provider_accept` (DLV-08 boundary 2). */
export const SIGKILL_HARNESS_ACCEPTED = "sigkill-harness:provider-accepted";

/** The parent's go-ahead. */
export const SIGKILL_HARNESS_RUN = "run";

function fail(message: string): never {
  scrubbedConsole.error(`sigkill-entrypoint: ${message}`);
  process.exit(1);
}

/**
 * Reads and validates `SIGKILL_HARNESS_FREEZE_AT`, defaulting to
 * `in_claim_window` -- an unset variable must reproduce the pre-11-11
 * scenario exactly, not silently do nothing. An unrecognized value is a
 * harness misconfiguration (a typo in a test file), not a scenario choice,
 * so it fails loudly via `fail()` rather than falling back to a default that
 * would make the typo invisible.
 */
function readFreezePoint(): SigkillFreezePoint {
  const raw = process.env.SIGKILL_HARNESS_FREEZE_AT ?? "in_claim_window";
  if (raw !== "in_claim_window" && raw !== "after_provider_accept") {
    fail(`SIGKILL_HARNESS_FREEZE_AT is not a recognized freeze point: "${raw}"`);
  }
  return raw;
}

function readJobData(): EmailBroadcastJob | EmailTriggeredJob {
  const raw = process.env.SIGKILL_HARNESS_JOB_DATA;
  if (!raw) {
    // A child that starts, finds no payload and exits quietly would make the
    // parent's ready-wait time out, and a timeout reads as flakiness.
    fail("SIGKILL_HARNESS_JOB_DATA is not set — refusing to start with no job payload.");
  }
  try {
    return JSON.parse(raw) as EmailBroadcastJob | EmailTriggeredJob;
  } catch (err) {
    fail(
      `SIGKILL_HARNESS_JOB_DATA is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

/**
 * Reports that the selected freeze point has been reached, then never
 * returns.
 *
 * For `in_claim_window`, `processSendJob` invokes this immediately after the
 * claim transaction commits, so by the time the marker is posted the row
 * exists at `dispatching` and no terminal write can have happened. For
 * `after_provider_accept`, the SAME call site posts a different marker whose
 * semantics are "SendGrid now has this message" -- see this file's own
 * header comment for why that marker IS the simulated acceptance rather than
 * a literal HTTP response. Either way, the frozen call is the only thing
 * that could produce a terminal write, and it never does.
 */
function freezeAfterSignalling(
  freezeAt: SigkillFreezePoint,
): (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult> {
  const marker = freezeAt === "after_provider_accept" ? SIGKILL_HARNESS_ACCEPTED : SIGKILL_HARNESS_READY;
  return () => {
    process.send?.(marker);
    // Never settles. The open IPC channel keeps this process alive, so no timer
    // is needed — and a timer here would be the very thing D-23 rules out.
    return new Promise<SendTenantMailResult>(() => {
      /* intentionally never resolved or rejected */
    });
  };
}

process.on("message", (message: unknown) => {
  if (message !== SIGKILL_HARNESS_RUN) return;

  const freezeAt = readFreezePoint();
  const jobData = readJobData();

  processSendJob(jobData, { sendMail: freezeAfterSignalling(freezeAt) }).catch((err: unknown) => {
    // Reaching here means the freeze did not hold and dispatch failed for some
    // other reason — surface it rather than exiting silently, or the parent
    // sees an unexplained early exit.
    scrubbedConsole.error(
      `sigkill-entrypoint: processSendJob rejected before the freeze: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }`,
    );
    process.exit(2);
  });
});
