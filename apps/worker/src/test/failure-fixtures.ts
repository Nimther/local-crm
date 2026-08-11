import { Pool } from "pg";
import { scrubbedConsole } from "@mega-crm/redaction";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { encryptTenantSecret } from "@mega-crm/kms";
import { getAuthTestDatabaseUrl } from "@mega-crm/test-support";
import { dispatchSendGate } from "@mega-crm/delivery-core";
import type { SendGridMailSendRequest, SendTenantMailResult } from "@mega-crm/delivery-core";

/**
 * 08-08 (QG-06) — shared fixtures for the failure-injection scenarios.
 *
 * Definitions moved verbatim out of `send-dispatch-durability.test.ts`, which
 * had in turn copied them from `send-dispatch-idempotency.test.ts`. The three
 * scenarios in `queues/__tests__/failure-injection/` need exactly these, and a
 * third copy is how the two existing ones started drifting.
 *
 * Everything here injects through `ProcessSendJobDeps.sendMail`, the seam that
 * has existed since Phase 4. No scenario reaches
 * `packages/delivery-core/src/send-mail.ts`, so the real SendGrid endpoint is
 * never contacted and no tenant's sending reputation is at risk (T-08-08-01).
 *
 * RLS: `workspace_sendgrid_keys`, `segments`, `campaigns` and `contacts` all
 * carry ENABLE + FORCE ROW LEVEL SECURITY. Every insert below therefore runs
 * inside `withTenant`/`withTenantTransaction` and never a bare `pool.query`.
 * `organization` is the one exception — it is not tenant-scoped, which is why
 * `freshWorkspaceId` used to take the app-role pool directly.
 *
 * 10-09 (SEC-05): as of migration 0045, `mega_crm_app` (the app-role `pool`
 * every caller here used to pass) holds only SELECT on `organization` --
 * inserting a fixture workspace row now needs the mega_crm_auth-backed
 * connection instead, exactly like the production write sites that stayed
 * app-readable-only. Built lazily and cached module-level (mirrors
 * `packages/tenant-context/src/scan.ts`'s `getScanPool`) so importing this
 * file does not require `AUTH_DATABASE_URL` to be set until a test actually
 * calls `freshWorkspaceId`.
 */

let authPool: Pool | undefined;

function getAuthTestPool(): Pool {
  if (!authPool) {
    authPool = new Pool({ connectionString: getAuthTestDatabaseUrl() });
    authPool.on("error", (err) => {
      scrubbedConsole.error("idle auth test pool client error (connection dropped)", err);
    });
  }
  return authPool;
}

type SendMailFn = (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult>;

/** Resolves a crafted SendGrid response — the 2xx/4xx/429 branches under test. */
export function fakeSendMail(status: number, headers: Record<string, string> = {}): SendMailFn {
  // eslint-disable-next-line @typescript-eslint/require-await -- test double: the signature must match the async function it replaces at the DI seam; a stub having nothing to await is the point
  return async () => ({
    status,
    headers: new Headers(headers),
    messageId: status < 300 ? "sg-message-id-fixture" : null,
  });
}

/**
 * Same, but counting. The counter is the load-bearing part: a scenario that
 * asserts a redelivery made no further send attempt needs to distinguish "was
 * never called" from "was called and happened to do nothing".
 */
export function countingSendMail(status = 202): { fn: SendMailFn; callCount: () => number } {
  let calls = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- test double: the signature must match the async function it replaces at the DI seam; a stub having nothing to await is the point
    fn: async () => {
      calls += 1;
      return {
        status,
        headers: new Headers(),
        messageId: status < 300 ? "sg-message-id-fixture" : null,
      };
    },
    callCount: () => calls,
  };
}

/**
 * Throws instead of resolving — a send that fails mid-flight rather than
 * returning a status. Counts its calls for the same reason `countingSendMail`
 * does.
 */
export function throwingSendMail(error: unknown): { fn: SendMailFn; callCount: () => number } {
  let calls = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- test double: the signature must match the async function it replaces at the DI seam; the throw IS the behaviour under test
    fn: async () => {
      calls += 1;
      throw error;
    },
    callCount: () => calls,
  };
}

/**
 * `organization` is not tenant-scoped, so this one takes its own connection
 * rather than a tenant-scoped `withTenantTransaction`.
 *
 * 10-09 (SEC-05): the `pool` parameter is unused as of migration 0045 --
 * kept so every existing call site (which passes its own app-role
 * `createTestPool()` result) does not need to change -- the actual INSERT
 * now runs on the module-level auth-role pool above, since `mega_crm_app`
 * (whatever `pool` the caller passes) holds only SELECT on `organization`.
 */
export async function freshWorkspaceId(_pool: Pool, nameSeed: string): Promise<string> {
  return insertFixtureOrganization(nameSeed);
}

/**
 * The pool-free equivalent of `freshWorkspaceId` above, for the many test
 * files that define their own local `freshWorkspaceId(nameSeed)` wrapper
 * (each one previously duplicated this exact INSERT against the app-role
 * pool) -- 10-09 (SEC-05): call this instead of duplicating the
 * mega_crm_auth-backed INSERT a further 21 times.
 */
export async function insertFixtureOrganization(nameSeed: string): Promise<string> {
  const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await getAuthTestPool().query<{ id: string }>(
    `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
    [`${nameSeed} Co`, slug],
  );
  return rows[0].id;
}

export async function connectFixtureSendgridKey(workspaceId: string): Promise<void> {
  const encrypted = await encryptTenantSecret(workspaceId, "SG.fixture_test_key_0000000000000000");
  await withTenant(workspaceId, () =>
    withTenantTransaction((client) =>
      client.query(
        `INSERT INTO workspace_sendgrid_keys (workspace_id, encrypted_dek, ciphertext, iv, auth_tag, key_mask, status)
         VALUES ($1, $2, $3, $4, $5, 'SG.fi…0000', 'active')`,
        [workspaceId, encrypted.encryptedDek, encrypted.ciphertext, encrypted.iv, encrypted.authTag],
      ),
    ),
  );
}

export async function createFixtureCampaign(workspaceId: string): Promise<string> {
  return withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows: segmentRows } = await client.query<{ id: string }>(
        `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
         VALUES ($1, 'Fixture segment', $2, 'test-user') RETURNING id`,
        [workspaceId, { operator: "and", conditions: [] }],
      );
      const segmentId = segmentRows[0].id;

      const { rows: campaignRows } = await client.query<{ id: string }>(
        `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, created_by_user_id)
         VALUES ($1, 'Fixture campaign', 'sending', $2, 'd-fixture-template', 'sender@fixture.test', 'test-user')
         RETURNING id`,
        [workspaceId, segmentId],
      );
      return campaignRows[0].id;
    }),
  );
}

export async function createFixtureContact(workspaceId: string): Promise<string> {
  const email = `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
  return withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
         VALUES ($1, $2, 'Fixture', 'subscribed') RETURNING id`,
        [workspaceId, email],
      );
      return rows[0].id;
    }),
  );
}

export async function sendsStatusFor(
  workspaceId: string,
  campaignId: string,
  contactId: string,
): Promise<string | undefined> {
  return withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query<{ status: string }>(
        `SELECT status FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3`,
        [workspaceId, campaignId, contactId],
      );
      return rows[0]?.status;
    }),
  );
}

/**
 * Reads back the timing/reconciliation columns `recordSendResult`/
 * `recordFlowStepResult` write (Phase 11, DLV-09, plan 11-06) -- mirrors
 * `sendsStatusFor`'s own shape and tenant scoping so `send-duration.test.ts`
 * never inlines raw SQL for this.
 */
export async function sendsTimingFor(
  sendId: string,
  workspaceId: string,
): Promise<
  | { status: string; dispatchedAt: Date | null; dispatchDurationMs: number | null; reconcilingSince: Date | null; sentAt: Date | null }
  | undefined
> {
  return withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query<{
        status: string;
        dispatchedAt: Date | null;
        dispatchDurationMs: number | null;
        reconcilingSince: Date | null;
        sentAt: Date | null;
      }>(
        `SELECT status, dispatched_at as "dispatchedAt", dispatch_duration_ms as "dispatchDurationMs",
                reconciling_since as "reconcilingSince", sent_at as "sentAt"
         FROM sends WHERE id = $1`,
        [sendId],
      );
      return rows[0];
    }),
  );
}

/**
 * Arranges a committed `dispatching` claim, as if a process had crashed
 * strictly BETWEEN receiving SendGrid's response and its own unit-3 record
 * transaction (DLV-08 boundary 3, plan 11-11 Task 2) -- state-based rather
 * than kill-based. Boundaries 2 and 3 leave an IDENTICAL ledger state: a
 * committed `dispatching` claim with no terminal row. A second real-kill
 * harness for boundary 3 would add process machinery (a forked child, an IPC
 * marker, a SIGKILL) without adding a single new assertion, since the
 * REDELIVERY behavior under test (reconciling, zero further provider calls)
 * is identical to boundary 2's. What actually differs between the two
 * response variants of boundary 3 -- a 202 the process never got to record,
 * versus a permanent 4xx it never got to record -- is trivially
 * parameterised here via `providerResponse`, which this function simply
 * echoes back for the caller's own assertions; it performs no side effect
 * with it beyond that, since there is genuinely nothing else to arrange: the
 * whole point of this boundary is that the response arrived and then
 * vanished with the process.
 */
export async function arrangeCrashedBeforeResultWrite(
  workspaceId: string,
  campaignId: string,
  contactId: string,
  providerResponse: SendTenantMailResult,
): Promise<{ sendId: string; providerResponse: SendTenantMailResult }> {
  const sendId = await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const claim = await dispatchSendGate(client, { workspaceId, campaignId, contactId });
      if (claim === "skipped" || !claim.sendId) {
        throw new Error("test setup failure: expected a fresh dispatchSendGate claim");
      }
      return claim.sendId;
    }),
  );
  // Deliberately NO unit-3 write here -- the row is left exactly where a
  // crash strictly between the SendGrid response and the record transaction
  // would leave it: committed 'dispatching', no terminal status.
  return { sendId, providerResponse };
}

/**
 * G-12-3 (12-14, gap closure): the campaign-scheduler due-campaign seeding +
 * readback recipe, lifted verbatim (SQL unchanged, parameterised only by
 * `nameSeed`) from `campaign-scheduler-scan.test.ts`'s own local
 * `seedDueCampaign`/`campaignStatus` helpers -- this file's own header above
 * documents that a third copy of an INSERT is exactly the drift this module
 * exists to prevent. `worker-autorun-default.test.ts`'s burst-absorption case
 * and `campaign-scheduler-scan.test.ts` both import these instead of each
 * defining their own.
 */
export async function seedDueCampaign(nameSeed: string): Promise<{ workspaceId: string; campaignId: string }> {
  const workspaceId = await insertFixtureOrganization(nameSeed);

  const campaignId = await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows: segmentRows } = await client.query<{ id: string }>(
        `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
         VALUES ($1, 'Scheduler scan fixture segment', $2, 'test-user') RETURNING id`,
        [workspaceId, { operator: "and", conditions: [] }],
      );
      const { rows: campaignRows } = await client.query<{ id: string }>(
        `INSERT INTO campaigns (workspace_id, name, status, segment_id, scheduled_at, created_by_user_id)
         VALUES ($1, 'Scheduler scan fixture campaign', 'scheduled', $2, now() - interval '1 minute', 'test-user')
         RETURNING id`,
        [workspaceId, segmentRows[0].id],
      );
      return campaignRows[0].id;
    }),
  );

  return { workspaceId, campaignId };
}

/**
 * Widened readback of `seedDueCampaign`'s row -- also selects
 * `sending_started_at` so callers can pin "transitions only once" by
 * comparing it across a further scan tick, not just re-checking `status`.
 */
export async function readDueCampaignState(
  workspaceId: string,
  campaignId: string,
): Promise<{ status: string; sendingStartedAt: Date | null }> {
  return withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query<{ status: string; sendingStartedAt: Date | null }>(
        `SELECT status, sending_started_at as "sendingStartedAt" FROM campaigns WHERE id = $1`,
        [campaignId],
      );
      return rows[0];
    }),
  );
}

export async function sendsRowCountFor(
  workspaceId: string,
  campaignId: string,
  contactId: string,
): Promise<number> {
  return withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3`,
        [workspaceId, campaignId, contactId],
      );
      return rows.length;
    }),
  );
}
