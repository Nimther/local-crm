import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { createTestPool, ensureTestDbMigrated, getScanTestDatabaseUrl, getTestDatabaseUrl } from "@mega-crm/test-support";
import { SEND_STATUSES, SEND_STATUS_TRANSITIONS, RECONCILE_RESOLUTION_WINDOW_MS } from "@mega-crm/delivery-core";

import { processSendJob } from "../send-dispatch.js";
import { runReconcilerTick } from "../send-reconciler.worker.js";
import {
  connectFixtureSendgridKey,
  countingSendMail,
  createFixtureCampaign,
  createFixtureContact,
  freshWorkspaceId,
  sendsStatusFor,
  throwingSendMail,
} from "../../test/failure-fixtures.js";

/**
 * 11-11 (DLV-07) — ARCHITECTURE.md ##9 ("The send delivery state machine")
 * is a published guarantee tenants rely on. This file is what keeps it from
 * becoming aspirational: every claim that section's prose makes is asserted
 * here as an executable proposition, against the SAME `SEND_STATUS_TRANSITIONS`
 * matrix that section names as its own executable mirror, and against the
 * SAME production code paths (`processSendJob`, `runReconcilerTick`) the
 * other failure-injection scenarios in this directory exercise. A future
 * edit to ARCHITECTURE.md ##9's prose has an obvious place to check itself
 * against: this file.
 *
 * The claims asserted below, verbatim from the document:
 *   - No `reconciling -> failed` or `unknown -> failed` transition exists.
 *   - Every non-terminal status has an outgoing transition (no row is stuck
 *     forever).
 *   - `dispatching -> reconciling` is the only two-writer transition.
 *   - An `unknown` send is never automatically re-sent.
 *   - At-most-once at the acceptance boundary (a `sent` row is never
 *     re-dispatched).
 *   - Effectively-once BEFORE acceptance becomes ambiguous (a provably
 *     pre-connection failure IS retried and DOES reach the provider — the
 *     model must not be so conservative that legitimate retries stop
 *     happening).
 */
describe("ARCHITECTURE.md ##9 delivery-model claims (DLV-07)", () => {
  describe("the executable state-machine matrix", () => {
    it("no transition leads from reconciling or unknown to failed", () => {
      for (const from of ["reconciling", "unknown"] as const) {
        const targets = SEND_STATUS_TRANSITIONS[from].map((t) => t.to);
        expect(targets, `${from} -> failed must never be representable`).not.toContain("failed");
      }
    });

    it("every non-terminal status has at least one outgoing transition — no row is stuck forever", () => {
      const terminal = new Set<string>(["sent", "failed", "excluded"]);
      for (const status of SEND_STATUSES) {
        if (terminal.has(status)) continue;
        expect(
          SEND_STATUS_TRANSITIONS[status].length,
          `${status} must have at least one outgoing transition`,
        ).toBeGreaterThan(0);
      }
    });

    it("dispatching -> reconciling is the only transition with more than one writer", () => {
      const multiWriterTransitions: string[] = [];
      for (const from of SEND_STATUSES) {
        for (const transition of SEND_STATUS_TRANSITIONS[from]) {
          if (transition.writers.length > 1) {
            multiWriterTransitions.push(`${from} -> ${transition.to}`);
          }
        }
      }
      expect(multiWriterTransitions).toEqual(["dispatching -> reconciling"]);
    });
  });

  describe("observed behavior matches the documented delivery model", () => {
    let pool: Pool;
    let redisClient: Redis;

    beforeAll(async () => {
      await ensureTestDbMigrated();
      process.env.DATABASE_URL = getTestDatabaseUrl();
      process.env.SCAN_DATABASE_URL = getScanTestDatabaseUrl();
      pool = createTestPool();
      redisClient = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/1");
    });

    afterAll(async () => {
      await pool.end();
      await redisClient.quit();
    });

    async function backdateReconcilingSince(workspaceId: string, campaignId: string, contactId: string, agoMs: number): Promise<void> {
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          client.query(
            `UPDATE sends SET reconciling_since = now() - ($4::bigint * INTERVAL '1 millisecond')
             WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3`,
            [workspaceId, campaignId, contactId, agoMs],
          ),
        ),
      );
    }

    async function withPatchedFetch<T>(run: () => Promise<T>): Promise<{ result: T; fetchCalls: number }> {
      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
        fetchCalls += 1;
        return originalFetch(...args);
      };
      try {
        const result = await run();
        return { result, fetchCalls };
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    it("an unknown send is never automatically re-sent: repeated ticks with no new evidence leave it unknown and call the provider zero times", async () => {
      const workspaceId = await freshWorkspaceId(pool, "claims-unknown-no-resend");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);

      // Drive the row to reconciling via a genuinely ambiguous provider
      // error -- this is the ONLY provider call this entire test ever makes.
      const throwing = throwingSendMail(new Error("boom"));
      const first = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: throwing.fn, redisClient },
      );
      expect(first.outcome).toBe("reconciling");

      // Push it past the resolution window with NO evidence ever supplied.
      await backdateReconcilingSince(workspaceId, campaignId, contactId, RECONCILE_RESOLUTION_WINDOW_MS + 60_000);

      const { fetchCalls: firstTickFetchCalls } = await withPatchedFetch(() => runReconcilerTick());
      expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("unknown");
      expect(firstTickFetchCalls, "the reconciler must never call the provider while resolving to unknown").toBe(0);

      // A SECOND tick with STILL no new evidence must leave it unknown --
      // never re-sent.
      const { fetchCalls: secondTickFetchCalls } = await withPatchedFetch(() => runReconcilerTick());
      expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("unknown");
      expect(secondTickFetchCalls).toBe(0);

      expect(
        throwing.callCount(),
        "the ORIGINAL ambiguous attempt is the only provider call across this entire test",
      ).toBe(1);
    });

    it("at-most-once at the acceptance boundary: redelivering a job for an already-sent row returns skipped with zero provider calls", async () => {
      const workspaceId = await freshWorkspaceId(pool, "claims-sent-no-resend");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);

      const first = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: countingSendMail(202).fn, redisClient },
      );
      expect(first.outcome).toBe("sent");

      const counting = countingSendMail(202);
      const redelivered = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: counting.fn, redisClient },
      );
      expect(redelivered.outcome).toBe("skipped");
      expect(counting.callCount(), "a send already accepted must never be re-dispatched").toBe(0);
    });

    it("effectively-once before acceptance: a provably pre-connection failure is retried and DOES reach the provider", async () => {
      const workspaceId = await freshWorkspaceId(pool, "claims-pre-connection-retry");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);

      const refusedError = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      const throwing = throwingSendMail(refusedError);
      await expect(
        processSendJob({ workspaceId, campaignId, kind: "campaign", contactId }, { sendMail: throwing.fn, redisClient }),
        "a provably pre-connection failure must rethrow for BullMQ's bounded retry",
      ).rejects.toBe(refusedError);
      expect(throwing.callCount()).toBe(1);

      // The claim was released (proved pre-connection, never accepted) -- a
      // retry must be free to reach the provider again. The model must not
      // be so conservative that legitimate retries stop happening.
      const counting = countingSendMail(202);
      const retried = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: counting.fn, redisClient },
      );
      expect(retried.outcome).toBe("sent");
      expect(counting.callCount(), "the retry must actually reach the provider — effectively-once, not never-once").toBe(1);
    });
  });
});
