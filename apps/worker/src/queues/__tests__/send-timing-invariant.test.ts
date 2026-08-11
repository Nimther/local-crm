import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import {
  startTempRedis,
  type TempRedis,
  ensureTestDbMigrated,
  getTestDatabaseUrl,
  createTestPool,
} from "@mega-crm/test-support";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import {
  SENDGRID_TIMEOUT_MS,
  upsertWorkspaceSendSettings,
  STALE_DISPATCHING_AGE_MS,
  RECONCILE_RESOLUTION_WINDOW_MS,
  RECONCILE_RESCAN_HORIZON_MS,
} from "@mega-crm/delivery-core";
import {
  SEND_LOCK_DURATION_MS,
  CLAIM_TX_MARGIN_MS,
  RECORD_TX_MARGIN_MS,
  SEND_JOB_MAX_ATTEMPTS,
  SEND_JOB_BACKOFF_DELAY_MS,
  SEND_MAX_JOB_LIFETIME_MS,
  buildRedisConnectionOptions,
} from "@mega-crm/queue-core";
import { createEmailBroadcastWorker } from "../email-broadcast.worker.js";
import { createEmailTriggeredWorker } from "../email-triggered.worker.js";
import { processSendJob } from "../send-dispatch.js";
import {
  connectFixtureSendgridKey,
  createFixtureCampaign,
  createFixtureContact,
  fakeSendMail,
  freshWorkspaceId,
} from "../../test/failure-fixtures.js";

/**
 * Phase 11 (D-15/D-10, plan 11-05) -- every `<behavior>` item from
 * 11-05-PLAN.md's Task 3, asserted against the REAL exported constants
 * (never a restated literal, which would make a test agree with itself
 * instead of with the code).
 */
describe("send lane timing/retry invariants (D-15, D-10)", () => {
  describe("SENDGRID_TIMEOUT_MS + margins < SEND_LOCK_DURATION_MS (Pitfall 5)", () => {
    it("holds for the real exported constants", () => {
      expect(SENDGRID_TIMEOUT_MS + CLAIM_TX_MARGIN_MS + RECORD_TX_MARGIN_MS).toBeLessThan(SEND_LOCK_DURATION_MS);
    });
  });

  describe("SEND_MAX_JOB_LIFETIME_MS is a floor with margin, not merely equal to the raw attempt budget", () => {
    it("exceeds SEND_JOB_MAX_ATTEMPTS * SEND_LOCK_DURATION_MS plus the exponential backoff series", () => {
      let backoffSumMs = 0;
      for (let i = 0; i < SEND_JOB_MAX_ATTEMPTS - 1; i += 1) {
        backoffSumMs += SEND_JOB_BACKOFF_DELAY_MS * 2 ** i;
      }
      const rawAttemptBudgetMs = SEND_JOB_MAX_ATTEMPTS * SEND_LOCK_DURATION_MS + backoffSumMs;

      expect(SEND_MAX_JOB_LIFETIME_MS).toBeGreaterThan(rawAttemptBudgetMs);
    });
  });

  /**
   * Phase 11 (D-08, plan 11-08, Task 1): `STALE_DISPATCHING_AGE_MS`
   * (`packages/delivery-core/src/reconciler.ts`) must exceed
   * `SEND_MAX_JOB_LIFETIME_MS` (`apps/worker/src/queues/queue-options.ts`)
   * with margin -- the sweep can never claim a row whose worker job might
   * still be alive and about to write its own terminal/ambiguous result.
   * This assertion lives HERE, not in `packages/delivery-core`'s own test
   * project, because `packages/delivery-core` does not (and must not)
   * depend on `apps/worker` -- the workspace dependency points the other
   * way (`apps/worker` depends on `@mega-crm/delivery-core`). `apps/worker`
   * already imports both packages, so this is the one place both real
   * constants can be imported together without inventing a new dependency
   * direction. See `reconciler.ts`'s own `STALE_DISPATCHING_AGE_MS` comment
   * for the mirror-image note pointing back here.
   */
  describe("STALE_DISPATCHING_AGE_MS > SEND_MAX_JOB_LIFETIME_MS (D-08)", () => {
    it("holds for the real exported constants from both packages", () => {
      expect(STALE_DISPATCHING_AGE_MS).toBeGreaterThan(SEND_MAX_JOB_LIFETIME_MS);
    });
  });

  describe("RECONCILE_RESCAN_HORIZON_MS > RECONCILE_RESOLUTION_WINDOW_MS (D-04/D-07)", () => {
    it("holds for the real exported constants (both local to @mega-crm/delivery-core, also asserted in reconciler-classify.test.ts)", () => {
      expect(RECONCILE_RESCAN_HORIZON_MS).toBeGreaterThan(RECONCILE_RESOLUTION_WINDOW_MS);
    });
  });

  describe("both send Workers declare an explicit lockDuration", () => {
    let redis: TempRedis;

    beforeAll(async () => {
      redis = await startTempRedis({});
    });

    afterAll(async () => {
      await redis?.stop();
    });

    it("the broadcast Worker's constructor options include lockDuration === SEND_LOCK_DURATION_MS", async () => {
      const worker = createEmailBroadcastWorker(buildRedisConnectionOptions(redis.url));
      try {
        expect(worker.opts.lockDuration).toBe(SEND_LOCK_DURATION_MS);
      } finally {
        await worker.close();
      }
    });

    it("the triggered Worker's constructor options include the SAME lockDuration", async () => {
      const worker = createEmailTriggeredWorker(buildRedisConnectionOptions(redis.url));
      try {
        expect(worker.opts.lockDuration).toBe(SEND_LOCK_DURATION_MS);
      } finally {
        await worker.close();
      }
    });
  });

  describe("cause routing (D-10): tenant_bucket vs provider_backoff", () => {
    let pool: Pool;
    let redisClient: Redis;

    beforeAll(async () => {
      await ensureTestDbMigrated();
      process.env.DATABASE_URL = getTestDatabaseUrl();
      pool = createTestPool();
      redisClient = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/1");
    });

    afterAll(async () => {
      await pool.end();
      await redisClient.quit();
    });

    it("a SendGrid 429 yields cause: 'provider_backoff'", async () => {
      const workspaceId = await freshWorkspaceId(pool, "timing-invariant-429");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);

      const result = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: fakeSendMail(429, { "retry-after": "1" }), redisClient }
      );

      expect(result.outcome).toBe("rate_limited");
      if (result.outcome !== "rate_limited") throw new Error("unreachable -- narrowed above");
      expect(result.cause).toBe("provider_backoff");
    });

    it("a per-tenant token-bucket denial yields cause: 'tenant_bucket'", async () => {
      const workspaceId = await freshWorkspaceId(pool, "timing-invariant-bucket");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const firstContactId = await createFixtureContact(workspaceId);
      const secondContactId = await createFixtureContact(workspaceId);

      // A 1-RPS ceiling: the first send in this second consumes the only
      // token, the second one in the SAME second is denied by the bucket
      // itself, never reaching SendGrid.
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) => upsertWorkspaceSendSettings(client, workspaceId, { rpsLimit: 1 }))
      );

      const first = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId: firstContactId },
        { sendMail: fakeSendMail(202), redisClient }
      );
      expect(first.outcome).toBe("sent");

      const second = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId: secondContactId },
        { sendMail: fakeSendMail(202), redisClient }
      );

      expect(second.outcome).toBe("rate_limited");
      if (second.outcome !== "rate_limited") throw new Error("unreachable -- narrowed above");
      expect(second.cause).toBe("tenant_bucket");
    });
  });
});
