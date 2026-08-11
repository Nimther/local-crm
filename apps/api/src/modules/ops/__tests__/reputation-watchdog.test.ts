import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// 10-09 (SEC-05): seeding an organization row directly for test setup is not
// a live application query site -- as of migration 0045 it needs the
// mega_crm_auth-backed client, not the app-role `db`.
import { authDb as sharedDb, member, organization, user } from "@mega-crm/db";
import { pool } from "@mega-crm/tenant-context";
import { scrubbedConsole } from "@mega-crm/redaction";
import type { ReputationMetric, ReputationTier } from "@mega-crm/delivery-core";

import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import {
  REPUTATION_ALERT_DEDUP_HOURS,
  REPUTATION_WATCHDOG_INTERVAL_MS,
  checkReputationHealthAndAlert,
  claimReputationAlertSlot,
  readReputationSnapshot,
  renderReputationAlertText,
  resolveWorkspaceAlertRecipients,
  startReputationWatchdog,
} from "../reputation-watchdog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Phase 13 (CMP-09, plan 13-11), Task 2: `reputation-watchdog.ts`'s own test
 * module, mirroring `dead-letter-watchdog.test.ts`'s structure, with the
 * escalation/de-escalation/two-workspace-independence/observed-columns
 * cases this module's own header calls out as having no inherited coverage.
 *
 * `reputation_alert_state` is read platform-WIDE (`readReputationSnapshot`
 * has no workspace-scoping override, matching the real production shape --
 * this is a genuine cross-tenant sweep), and no other apps/api test file
 * touches this table -- but THIS file's own test cases still each seed a
 * row that would otherwise remain visible to every later test in this same
 * file. Every seeded row is tracked by workspace id and deleted in
 * `afterEach` -- a row/workspace-scoped cleanup, never a blanket delete of
 * anything this file did not itself create.
 */

let createdWorkspaceIds: string[] = [];

async function freshWorkspaceId(nameSeed: string): Promise<string> {
  const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await sharedDb
    .insert(organization)
    .values({ id: randomUUID(), name: nameSeed, slug, createdAt: new Date() })
    .returning();
  createdWorkspaceIds.push(org.id);
  return org.id;
}

/**
 * `mega_crm_app` (the ordinary pool this test otherwise uses) has SELECT-only
 * on `user`/`member` as of migration 0045 -- INSERT/UPDATE/DELETE on
 * better-auth's own tables belongs exclusively to `mega_crm_auth`. Mirrors
 * `flow-enroll-atomic.test.ts`'s own precedent: fixture writes to these
 * tables go through `authDb` (Drizzle, `mega_crm_auth`-backed), never the
 * raw app pool.
 */
async function seedMember(workspaceId: string, email: string): Promise<void> {
  const [insertedUser] = await sharedDb.insert(user).values({ id: randomUUID(), name: "Fixture Member", email }).returning();
  await sharedDb.insert(member).values({ id: randomUUID(), organizationId: workspaceId, userId: insertedUser.id });
}

interface SeedReputationOverrides {
  metric?: ReputationMetric;
  observedTier?: ReputationTier;
  observedRate?: number | null;
  observedNumerator?: number;
  observedDenominator?: number;
  alertedTier?: ReputationTier | null;
  lastAlertSentAt?: Date | null;
}

async function seedReputationRow(workspaceId: string, overrides: SeedReputationOverrides = {}): Promise<void> {
  const {
    metric = "complaint_rate",
    observedTier = "warn",
    observedRate = 0.002,
    observedNumerator = 3,
    observedDenominator = 1500,
    alertedTier = null,
    lastAlertSentAt = null,
  } = overrides;
  await pool.query(
    `INSERT INTO reputation_alert_state (
       workspace_id, metric, observed_tier, observed_rate, observed_numerator, observed_denominator, observed_at, alerted_tier, last_alert_sent_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, now())
     ON CONFLICT (workspace_id, metric) DO UPDATE SET
       observed_tier = EXCLUDED.observed_tier,
       observed_rate = EXCLUDED.observed_rate,
       observed_numerator = EXCLUDED.observed_numerator,
       observed_denominator = EXCLUDED.observed_denominator,
       observed_at = EXCLUDED.observed_at,
       alerted_tier = EXCLUDED.alerted_tier,
       last_alert_sent_at = EXCLUDED.last_alert_sent_at,
       updated_at = now()`,
    [workspaceId, metric, observedTier, observedRate, observedNumerator, observedDenominator, alertedTier, lastAlertSentAt],
  );
}

describe("renderReputationAlertText (pure, no DB)", () => {
  it("names the metric, observed rate, numerator, denominator and the crossed threshold, for both audiences", () => {
    const row = {
      workspaceId: "ws-1",
      metric: "complaint_rate" as const,
      observedTier: "warn" as const,
      observedRate: 0.0032,
      observedNumerator: 4,
      observedDenominator: 1250,
      alertedTier: null,
    };

    const operatorText = renderReputationAlertText(row, "operator");
    expect(operatorText).toContain("ws-1");
    expect(operatorText).toContain("4/1250");
    expect(operatorText).toMatch(/0\.3\d+%/);
    expect(operatorText).not.toMatch(/@/);

    const tenantText = renderReputationAlertText(row, "tenant");
    expect(tenantText).toContain("4/1250");
    expect(tenantText).not.toContain("ws-1");
    expect(tenantText).not.toMatch(/@/);
  });

  it("a null observedRate (below the volume floor) renders without dereferencing it", () => {
    const row = {
      workspaceId: "ws-2",
      metric: "hard_bounce_rate" as const,
      observedTier: "warn" as const,
      observedRate: null,
      observedNumerator: 0,
      observedDenominator: 10,
      alertedTier: null,
    };
    expect(() => renderReputationAlertText(row, "operator")).not.toThrow();
    expect(renderReputationAlertText(row, "operator")).toContain("n/a");
  });
});

describe("T-13-11-07: no sending-configuration UPDATE anywhere in this module (D-11)", () => {
  it("the source contains no UPDATE against campaigns, sends, or workspace_sendgrid_keys", () => {
    const source = readFileSync(path.join(__dirname, "..", "reputation-watchdog.ts"), "utf8");
    expect(source).not.toMatch(/UPDATE\s+campaigns/i);
    expect(source).not.toMatch(/UPDATE\s+sends\b/i);
    expect(source).not.toMatch(/UPDATE\s+workspace_sendgrid_keys/i);
  });
});

describe("readReputationSnapshot / claimReputationAlertSlot / checkReputationHealthAndAlert", () => {
  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool.on("error", () => {
      // expected: the concurrent-replica test below deliberately drives two
      // independent pools against the same alert-state row.
    });
  });

  afterEach(async () => {
    const ids = createdWorkspaceIds;
    createdWorkspaceIds = [];
    if (ids.length > 0) {
      await pool.query(`DELETE FROM reputation_alert_state WHERE workspace_id = ANY($1::uuid[])`, [ids]);
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("a workspace observed at tier warn produces exactly two sendMail calls: one operator, one tenant member", async () => {
    const workspaceId = await freshWorkspaceId("rep-warn");
    await seedMember(workspaceId, `member-${randomUUID()}@example.com`);
    await seedReputationRow(workspaceId);

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkReputationHealthAndAlert({ client: pool, now: new Date(), operatorEmail: "ops@example.com", sendMail });

    expect(sent).toHaveLength(2);
    expect(sent.some((m) => m.to === "ops@example.com")).toBe(true);
  });

  it("a workspace observed at tier none produces zero sendMail calls", async () => {
    const workspaceId = await freshWorkspaceId("rep-none");
    await seedReputationRow(workspaceId, { observedTier: "none", observedRate: null, observedNumerator: 0, observedDenominator: 10 });

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkReputationHealthAndAlert({ client: pool, now: new Date(), operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(0);
  });

  it("a workspace still at warn on a later check inside the cooldown produces zero calls on the second check", async () => {
    const workspaceId = await freshWorkspaceId("rep-cooldown-flat");
    await seedReputationRow(workspaceId);

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    const t1 = new Date();
    await checkReputationHealthAndAlert({ client: pool, now: t1, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(1); // no member seeded -- operator only

    const t2 = new Date(t1.getTime() + 60_000);
    await checkReputationHealthAndAlert({ client: pool, now: t2, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(1);
  });

  it("a workspace escalating warn -> critical inside the cooldown produces an immediate second alert", async () => {
    const workspaceId = await freshWorkspaceId("rep-escalate");
    const lastAlertSentAt = new Date(Date.now() - 60 * 60 * 1000); // 1h ago, well inside the 24h cooldown
    await seedReputationRow(workspaceId, { observedTier: "critical", alertedTier: "warn", lastAlertSentAt });

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkReputationHealthAndAlert({ client: pool, now: new Date(), operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(1); // operator only, no member seeded
  });

  it("a workspace moving critical -> warn inside the cooldown produces zero calls (de-escalation never bypasses the cooldown)", async () => {
    const workspaceId = await freshWorkspaceId("rep-deescalate");
    const lastAlertSentAt = new Date(Date.now() - 60 * 60 * 1000);
    await seedReputationRow(workspaceId, { observedTier: "warn", alertedTier: "critical", lastAlertSentAt });

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkReputationHealthAndAlert({ client: pool, now: new Date(), operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(0);
  });

  it("two workspaces both at warn each receive their own operator and tenant alerts, independently", async () => {
    const workspaceA = await freshWorkspaceId("rep-two-a");
    const workspaceB = await freshWorkspaceId("rep-two-b");
    await seedMember(workspaceA, `member-a-${randomUUID()}@example.com`);
    await seedMember(workspaceB, `member-b-${randomUUID()}@example.com`);
    await seedReputationRow(workspaceA);
    await seedReputationRow(workspaceB);

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkReputationHealthAndAlert({ client: pool, now: new Date(), operatorEmail: "ops@example.com", sendMail });

    expect(sent).toHaveLength(4); // 2 workspaces x (1 operator + 1 tenant member)
    expect(sent.filter((m) => m.to === "ops@example.com")).toHaveLength(2);
  });

  it("a workspace with no resolvable members still sends the operator email and does not throw", async () => {
    const workspaceId = await freshWorkspaceId("rep-no-members");
    await seedReputationRow(workspaceId);

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await expect(
      checkReputationHealthAndAlert({ client: pool, now: new Date(), operatorEmail: "ops@example.com", sendMail }),
    ).resolves.not.toThrow();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("ops@example.com");

    const recipients = await resolveWorkspaceAlertRecipients(pool, workspaceId);
    expect(recipients).toEqual([]);
  });

  it("after a check, every observed_* column equals its pre-check value -- the claim writes only alerted_tier/last_alert_sent_at/updated_at", async () => {
    const workspaceId = await freshWorkspaceId("rep-observed-untouched");
    await seedReputationRow(workspaceId, { observedRate: 0.0021, observedNumerator: 5, observedDenominator: 2381 });

    const before = await readReputationSnapshot(pool);
    const beforeRow = before.find((row) => row.workspaceId === workspaceId);
    expect(beforeRow).toBeDefined();

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };
    await checkReputationHealthAndAlert({ client: pool, now: new Date(), operatorEmail: "ops@example.com", sendMail });

    const after = await readReputationSnapshot(pool);
    const afterRow = after.find((row) => row.workspaceId === workspaceId);
    expect(afterRow?.observedTier).toBe(beforeRow?.observedTier);
    expect(afterRow?.observedRate).toBe(beforeRow?.observedRate);
    expect(afterRow?.observedNumerator).toBe(beforeRow?.observedNumerator);
    expect(afterRow?.observedDenominator).toBe(beforeRow?.observedDenominator);
  });

  it("claimReputationAlertSlot's own atomicity -- a second claim inside the window, same tier, is refused", async () => {
    const workspaceId = await freshWorkspaceId("rep-claim-atomic");
    await seedReputationRow(workspaceId);

    const t1 = new Date();
    const firstClaim = await claimReputationAlertSlot(pool, workspaceId, "complaint_rate", "warn", t1, REPUTATION_ALERT_DEDUP_HOURS);
    expect(firstClaim).toBe(true);

    const secondClaim = await claimReputationAlertSlot(
      pool,
      workspaceId,
      "complaint_rate",
      "warn",
      new Date(t1.getTime() + 60_000),
      REPUTATION_ALERT_DEDUP_HOURS,
    );
    expect(secondClaim).toBe(false);
  });

  it("two concurrent checks against the same warn workspace produce exactly one alert pair (not two)", async () => {
    const workspaceId = await freshWorkspaceId("rep-race");
    await seedMember(workspaceId, `member-race-${randomUUID()}@example.com`);
    await seedReputationRow(workspaceId);

    const dsn = getTestDatabaseUrl();
    const poolA = new Pool({ connectionString: dsn, max: 2 });
    const poolB = new Pool({ connectionString: dsn, max: 2 });
    poolA.on("error", () => undefined);
    poolB.on("error", () => undefined);

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };
    const now = new Date();

    try {
      await Promise.all([
        checkReputationHealthAndAlert({ client: poolA, now, operatorEmail: "ops@example.com", sendMail }),
        checkReputationHealthAndAlert({ client: poolB, now, operatorEmail: "ops@example.com", sendMail }),
      ]);
    } finally {
      await poolA.end();
      await poolB.end();
    }

    expect(sent).toHaveLength(2); // 1 operator + 1 tenant, exactly once total
  });
});

describe("startReputationWatchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns an interval handle and a rejected check is caught and logged rather than escaping", async () => {
    vi.useFakeTimers();
    const scrubbedErrorSpy = vi.spyOn(scrubbedConsole, "error").mockImplementation(() => undefined);

    const client = {
      query: () => Promise.reject(new Error("db down")),
    };
    const handle = startReputationWatchdog({
      client,
      operatorEmail: "ops@example.com",
      sendMail: () => Promise.resolve(),
    });

    expect(handle).toBeDefined();

    await vi.advanceTimersByTimeAsync(REPUTATION_WATCHDOG_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(scrubbedErrorSpy).toHaveBeenCalledWith("reputation-watchdog: health check failed", expect.anything());

    clearInterval(handle);
  });
});
