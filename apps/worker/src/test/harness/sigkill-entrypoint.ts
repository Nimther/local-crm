import type { SendGridMailSendRequest, SendTenantMailResult } from "@mega-crm/delivery-core";
import type { EmailBroadcastJob, EmailTriggeredJob } from "@mega-crm/shared-schemas";

import { processSendJob } from "../../queues/send-dispatch.js";

/**
 * 08-12 (QG-06 scenario 4, D-22/D-23) — the child process that freezes inside
 * the dispatch claim window and waits to be killed.
 *
 * TEST HARNESS ONLY. Nothing in production imports this file.
 *
 * The window this targets is where the CR-04 duplicate-send bug lived:
 * `dispatchSendGate` commits a `dispatching` row in its own transaction, and
 * only then is the mail call made. A process that dies between those two points
 * leaves a claim with no terminal result, and a naive redelivery would send the
 * email a second time.
 *
 * The freeze mechanism is the injected mail function, and the ORDER of its two
 * statements is load-bearing (D-23): it posts the ready marker FIRST and only
 * then returns a promise that never settles. The parent kills in response to
 * that marker, so the kill provably lands inside the window rather than
 * somewhere near it. A timer or a database poll would land at an arbitrary
 * instant, which SPEC R6 says outright proves nothing — and there is
 * deliberately no timer anywhere in this file.
 *
 * This process does NOT boot the real queue runtime. That boot registers the
 * live BullMQ consumers, which reach `sendTenantMailV3`, and
 * `packages/delivery-core/src/send-mail.ts` hardcodes the SendGrid endpoint —
 * starting it would risk real mail leaving a tenant's account, which the SPEC
 * negative criterion forbids outright. `processSendJob` is imported directly
 * and only `sendMail` is injected; injecting anything more would mean
 * exercising the harness rather than the production dispatch path.
 */

/** Posted to the parent from inside the frozen mail call. */
export const SIGKILL_HARNESS_READY = "sigkill-harness:frozen-in-claim-window";

/** The parent's go-ahead. */
export const SIGKILL_HARNESS_RUN = "run";

function fail(message: string): never {
  console.error(`sigkill-entrypoint: ${message}`);
  process.exit(1);
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
 * Reports that the claim has committed, then never returns.
 *
 * `processSendJob` calls this immediately after the claim transaction commits,
 * so by the time the marker is posted the row exists at `dispatching` and no
 * terminal write can have happened — the frozen call is the only thing that
 * could produce one.
 */
function freezeAfterSignalling(): (
  apiKey: string,
  payload: SendGridMailSendRequest,
) => Promise<SendTenantMailResult> {
  return () => {
    process.send?.(SIGKILL_HARNESS_READY);
    // Never settles. The open IPC channel keeps this process alive, so no timer
    // is needed — and a timer here would be the very thing D-23 rules out.
    return new Promise<SendTenantMailResult>(() => {
      /* intentionally never resolved or rejected */
    });
  };
}

process.on("message", (message: unknown) => {
  if (message !== SIGKILL_HARNESS_RUN) return;

  const jobData = readJobData();

  processSendJob(jobData, { sendMail: freezeAfterSignalling() }).catch((err: unknown) => {
    // Reaching here means the freeze did not hold and dispatch failed for some
    // other reason — surface it rather than exiting silently, or the parent
    // sees an unexplained early exit.
    console.error(
      `sigkill-entrypoint: processSendJob rejected before the freeze: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }`,
    );
    process.exit(2);
  });
});
