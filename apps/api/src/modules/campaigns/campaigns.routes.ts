import type { FastifyInstance } from "fastify";
import {
  createCampaignSchema,
  updateCampaignSchema,
  campaignListQuerySchema,
  launchCampaignSchema,
  scheduleCampaignSchema,
  testSendCampaignSchema,
} from "@mega-crm/shared-schemas";
import { buildContactTemplateData, audienceExclusionBreakdown } from "@mega-crm/delivery-core";
import { decryptTenantSecret } from "@mega-crm/kms";
import { auth } from "../auth/auth.js";
import { requirePermission, toFetchHeaders } from "../../middleware/role-guard.js";
import { getCorrelationContext, withTenant, withTenantTransaction } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug } from "../tenancy/workspace-lookup.js";
import { resolveWorkspaceMember, NOT_FOUND_BODY } from "../tenancy/resolve-workspace-member.js";
import { getKey } from "../tenancy/sendgrid-key.repository.js";
import { listTenantSendGridTemplates, validateTenantSendGridKey } from "../tenancy/sendgrid-client.js";
import { getSegment, countSegmentMembers, listSegmentMembers } from "../segments/segment.repository.js";
import {
  CampaignStateError,
  cancelCampaign,
  createCampaign,
  deleteCampaign,
  duplicateCampaign,
  getCampaign,
  getCampaignProgress,
  launchCampaign,
  listCampaigns,
  prepareCampaignTestSend,
  scheduleCampaign,
  updateCampaign,
  type CampaignRow,
} from "./campaign.repository.js";
import { campaignKickoffQueue, emailBroadcastQueue } from "./campaign-queues.js";
import { CampaignSenderError, resolveCampaignSenderEmail } from "./sender-resolver.js";

/**
 * WR-03/T-03-04-style DoS-bounding statement_timeout, reused here for the
 * audience-breakdown segment count and the test-sample member lookup --
 * both re-evaluate a segment definition (compileSegmentDefinition) the same
 * way segments.routes.ts's save/members paths do.
 */
const SEGMENT_EVAL_STATEMENT_TIMEOUT_MS = 15000;

/** Postgres error code for a statement canceled due to statement_timeout. */
const QUERY_CANCELED_ERROR_CODE = "57014";

function isQueryCanceledError(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === QUERY_CANCELED_ERROR_CODE;
}

/** D-18/D-19 fallback sample when the campaign's segment has no members yet -- same buildContactTemplateData contract, placeholder values. */
const TEST_SAMPLE_PLACEHOLDER = buildContactTemplateData({
  firstName: "Иван",
  lastName: "Иванов",
  email: "example@example.com",
  phone: null,
  city: "Москва",
  country: "RU",
  tags: [],
  properties: {},
});

const MISSING_SEGMENT_COPY = "Выберите сегмент-аудиторию";
const MISSING_TEMPLATE_COPY = "Выберите шаблон письма";
const MISSING_SENDER_COPY = "Выберите отправителя";

/** Builds the per-field UI-SPEC copy for a launch rejected as 'incomplete'. */
function launchIncompleteFields(campaign: CampaignRow): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!campaign.segmentId) fields.segmentId = MISSING_SEGMENT_COPY;
  if (!campaign.templateId) fields.templateId = MISSING_TEMPLATE_COPY;
  if (!campaign.fromEmail && !campaign.fromSenderId) fields.sender = MISSING_SENDER_COPY;
  return fields;
}

/**
 * Maps a CampaignStateError to its HTTP status (D-03/D-08): `not_found`->404,
 * `illegal_transition`->409 (locked state machine rejected the transition),
 * `version_conflict`->409 (TMPL-02/D-05/D-06/D-07: the caller's
 * `expectedVersion` no longer matches the row, carries `currentVersion` so
 * the client can refetch without a second read), `incomplete`->422 (only
 * ever thrown by launchCampaign; callers that need the
 * launchIncompleteFields breakdown check `err.code === "incomplete"` BEFORE
 * falling back to this generic mapper). Every branch's body carries `code`
 * -- the client branches on it, so the field is part of the contract
 * rather than debug decoration (RESEARCH Pitfall #2). Returns `null` for
 * any other error so the caller re-throws (never swallows an unrelated
 * bug).
 */
function mapCampaignStateError(err: unknown): { code: number; body: Record<string, unknown> } | null {
  if (!(err instanceof CampaignStateError)) return null;
  if (err.code === "not_found") {
    return { code: 404, body: { error: "Campaign not found", code: err.code } };
  }
  if (err.code === "illegal_transition") {
    return { code: 409, body: { error: err.message, code: err.code } };
  }
  if (err.code === "version_conflict") {
    return {
      code: 409,
      body: { error: err.message, code: err.code, currentVersion: err.currentVersion },
    };
  }
  return { code: 422, body: { error: err.message, code: err.code } };
}

/**
 * CR-02: maps a `CampaignSenderError` (thrown by `resolveCampaignFromEmail`
 * or `resolveCampaignSenderEmail` when a campaign's `fromSenderId` cannot
 * be resolved to a verified email) to the same 422 + `fields.sender` shape
 * `launchIncompleteFields` already uses, so the UI's sender-field error
 * rendering handles both cases identically. Carries `code` for the same
 * reason `mapCampaignStateError` does -- one coherent error family.
 */
function mapCampaignSenderError(err: unknown): { code: number; body: Record<string, unknown> } | null {
  if (!(err instanceof CampaignSenderError)) return null;
  return {
    code: 422,
    body: { error: err.message, code: err.code, fields: { sender: MISSING_SENDER_COPY } },
  };
}

function toCampaignResponse(row: CampaignRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status,
    segmentId: row.segmentId,
    templateId: row.templateId,
    fromSenderId: row.fromSenderId,
    fromEmail: row.fromEmail,
    scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    sendableTotal: row.sendableTotal,
    sentCount: row.sentCount,
    failedCount: row.failedCount,
    // TMPL-02/D-05/RESEARCH Pitfall #4: the optimistic-lock token the
    // client echoes back as `expectedVersion` on the send paths -- without
    // this field the version is invisible to every consumer.
    version: row.version,
    excludedTotal: row.excludedTotal,
    sendingStartedAt: row.sendingStartedAt ? row.sendingStartedAt.toISOString() : null,
    terminalAt: row.terminalAt ? row.terminalAt.toISOString() : null,
    deliveredCount: row.deliveredCount,
    openedCount: row.openedCount,
    clickedCount: row.clickedCount,
    bouncedCount: row.bouncedCount,
    unsubscribedCount: row.unsubscribedCount,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Campaign lifecycle API (CAMP-01..05, SUBS-03). Ordinary workspace
 * membership is sufficient for create/edit/delete drafts, test-send, and
 * every read route (progress/audience-breakdown/test-sample/templates/
 * senders) -- launch/schedule/cancel/duplicate are Owner/Admin-only (D-19)
 * via `requirePermission("campaign", "launch")`.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: app.register() resolves the returned promise, and the declared Promise<void> is part of that signature -- dropping async would change it, not simplify it
export async function registerCampaignsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/workspaces/:slug/campaigns", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = campaignListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const result = await withTenant(workspace.id, () => listCampaigns(parsed.data));
    return reply.send({
      items: result.items.map(toCampaignResponse),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  });

  fastify.post("/api/workspaces/:slug/campaigns", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = createCampaignSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const session = await auth.api.getSession({ headers: toFetchHeaders(request) });
    if (!session) {
      return reply.code(401).send({ error: "Not authenticated" });
    }

    const created = await withTenant(workspace.id, () =>
      createCampaign({
        name: parsed.data.name,
        segmentId: parsed.data.segmentId,
        templateId: parsed.data.templateId,
        fromSenderId: parsed.data.fromSenderId,
        fromEmail: parsed.data.fromEmail,
        createdByUserId: session.user.id,
      })
    );
    return reply.code(201).send(toCampaignResponse(created));
  });

  // Static sub-paths registered ahead of `:id` so find-my-way's static-first
  // routing never has to disambiguate `sendgrid` from a campaign uuid.
  fastify.get("/api/workspaces/:slug/campaigns/sendgrid/templates", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const row = await withTenant(workspace.id, () => getKey());
    if (!row) {
      return reply.send({ templates: [] });
    }

    const plaintext = await decryptTenantSecret(workspace.id, {
      ciphertext: row.ciphertext,
      encryptedDek: row.encryptedDek,
      iv: row.iv,
      authTag: row.authTag,
    });
    const templates = await listTenantSendGridTemplates(plaintext);
    return reply.send({ templates });
  });

  fastify.get("/api/workspaces/:slug/campaigns/sendgrid/senders", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const row = await withTenant(workspace.id, () => getKey());
    if (!row) {
      return reply.send({ senders: [] });
    }

    const plaintext = await decryptTenantSecret(workspace.id, {
      ciphertext: row.ciphertext,
      encryptedDek: row.encryptedDek,
      iv: row.iv,
      authTag: row.authTag,
    });
    const validation = await validateTenantSendGridKey(plaintext);
    if (!validation.valid) {
      return reply.send({ senders: [] });
    }
    return reply.send({ senders: validation.verifiedSenders });
  });

  fastify.get("/api/workspaces/:slug/campaigns/:id", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const campaign = await withTenant(workspace.id, () => getCampaign(id));
    if (!campaign) {
      return reply.code(404).send({ error: "Campaign not found" });
    }
    return reply.send(toCampaignResponse(campaign));
  });

  fastify.patch("/api/workspaces/:slug/campaigns/:id", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const parsed = updateCampaignSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    try {
      const updated = await withTenant(workspace.id, () => updateCampaign(id, parsed.data));
      return reply.send(toCampaignResponse(updated));
    } catch (err) {
      const mapped = mapCampaignStateError(err);
      if (mapped) return reply.code(mapped.code).send(mapped.body);
      throw err;
    }
  });

  fastify.delete("/api/workspaces/:slug/campaigns/:id", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    try {
      const deleted = await withTenant(workspace.id, () => deleteCampaign(id));
      if (!deleted) {
        return reply.code(404).send({ error: "Campaign not found" });
      }
      return reply.send({ deleted: true });
    } catch (err) {
      const mapped = mapCampaignStateError(err);
      if (mapped) return reply.code(mapped.code).send(mapped.body);
      throw err;
    }
  });

  // D-19: launch/schedule/cancel/duplicate are Owner/Admin-only.
  fastify.post(
    "/api/workspaces/:slug/campaigns/:id/launch",
    { preHandler: requirePermission("campaign", "launch") },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };
      // TMPL-02/D-05/D-06: parse the optimistic-lock precondition before the
      // workspace lookup, same shape as the schedule handler's own block --
      // a request with no (or malformed) expectedVersion never gets far
      // enough to touch the campaign row at all.
      const parsed = launchCampaignSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send(NOT_FOUND_BODY);
      }

      try {
        // CR-02/TMPL-02/RESEARCH Pitfall #1: resolve the sender WITHOUT
        // persisting -- persistence now happens inside launchCampaign's own
        // locked transaction, in the SAME statement as the status flip and
        // the version bump, so a fromSenderId-based launch never bumps the
        // version more than once per marketer click.
        const preLaunch = await withTenant(workspace.id, () => getCampaign(id));
        const resolvedFromEmail =
          preLaunch && (preLaunch.fromSenderId || preLaunch.fromEmail)
            ? await resolveCampaignSenderEmail(workspace.id, preLaunch)
            : null;

        const launched = await withTenant(workspace.id, () =>
          launchCampaign(id, { expectedVersion: parsed.data.expectedVersion, resolvedFromEmail })
        );
        // SEND-03: the kickoff worker (04-06) re-derives recipients/template/
        // sender from the campaign row itself -- the job only ever carries ids.
        await campaignKickoffQueue.add(
          "kickoff",
          { workspaceId: workspace.id, campaignId: id },
          { jobId: id }
        );
        return reply.send(toCampaignResponse(launched));
      } catch (err) {
        const senderMapped = mapCampaignSenderError(err);
        if (senderMapped) return reply.code(senderMapped.code).send(senderMapped.body);
        if (err instanceof CampaignStateError && err.code === "incomplete") {
          const campaign = await withTenant(workspace.id, () => getCampaign(id));
          return reply.code(422).send({
            error: err.message,
            code: err.code,
            fields: campaign ? launchIncompleteFields(campaign) : {},
          });
        }
        const mapped = mapCampaignStateError(err);
        if (mapped) return reply.code(mapped.code).send(mapped.body);
        throw err;
      }
    }
  );

  fastify.post(
    "/api/workspaces/:slug/campaigns/:id/schedule",
    { preHandler: requirePermission("campaign", "launch") },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };
      const parsed = scheduleCampaignSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send(NOT_FOUND_BODY);
      }

      const scheduledAtDate = new Date(parsed.data.scheduledAt);
      if (Number.isNaN(scheduledAtDate.getTime()) || scheduledAtDate.getTime() <= Date.now()) {
        return reply.code(422).send({ error: "scheduledAt must be a valid future datetime" });
      }

      try {
        // CR-02/TMPL-02/RESEARCH Pitfall #1: resolve the sender WITHOUT
        // persisting -- persistence now happens inside scheduleCampaign's
        // own locked transaction, in the SAME statement as the status flip
        // and the version bump, exactly as the launch route (plan 20-02)
        // already does. The 04-06 scheduler worker still finds a populated
        // from_email at send time; it just gets written under the lock now,
        // not in a separate transaction ahead of it.
        const preSchedule = await withTenant(workspace.id, () => getCampaign(id));
        const resolvedFromEmail =
          preSchedule && (preSchedule.fromSenderId || preSchedule.fromEmail)
            ? await resolveCampaignSenderEmail(workspace.id, preSchedule)
            : null;

        const scheduled = await withTenant(workspace.id, () =>
          scheduleCampaign(id, {
            scheduledAt: scheduledAtDate,
            expectedVersion: parsed.data.expectedVersion,
            resolvedFromEmail,
          })
        );
        return reply.send(toCampaignResponse(scheduled));
      } catch (err) {
        const senderMapped = mapCampaignSenderError(err);
        if (senderMapped) return reply.code(senderMapped.code).send(senderMapped.body);
        const mapped = mapCampaignStateError(err);
        if (mapped) return reply.code(mapped.code).send(mapped.body);
        throw err;
      }
    }
  );

  fastify.post(
    "/api/workspaces/:slug/campaigns/:id/cancel",
    { preHandler: requirePermission("campaign", "launch") },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send(NOT_FOUND_BODY);
      }

      try {
        const canceled = await withTenant(workspace.id, () => cancelCampaign(id));
        return reply.send(toCampaignResponse(canceled));
      } catch (err) {
        const mapped = mapCampaignStateError(err);
        if (mapped) return reply.code(mapped.code).send(mapped.body);
        throw err;
      }
    }
  );

  fastify.post(
    "/api/workspaces/:slug/campaigns/:id/duplicate",
    { preHandler: requirePermission("campaign", "launch") },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send(NOT_FOUND_BODY);
      }

      const session = await auth.api.getSession({ headers: toFetchHeaders(request) });
      if (!session) {
        return reply.code(401).send({ error: "Not authenticated" });
      }

      try {
        const duplicated = await withTenant(workspace.id, () => duplicateCampaign(id, session.user.id));
        return reply.code(201).send(toCampaignResponse(duplicated));
      } catch (err) {
        const mapped = mapCampaignStateError(err);
        if (mapped) return reply.code(mapped.code).send(mapped.body);
        throw err;
      }
    }
  );

  // CAMP-04/D-12: ordinary-member level -- test sends never touch the
  // frequency cap/ledger and don't affect the state machine. NEVER a direct
  // SendGrid call here: always enqueued on the same broadcast queue the
  // 04-04 worker consumes, tagged kind='test'.
  fastify.post("/api/workspaces/:slug/campaigns/:id/test-send", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const parsed = testSendCampaignSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const campaign = await withTenant(workspace.id, () => getCampaign(id));
    if (!campaign) {
      return reply.code(404).send({ error: "Campaign not found" });
    }

    const session = await auth.api.getSession({ headers: toFetchHeaders(request) });
    if (!session) {
      return reply.code(401).send({ error: "Not authenticated" });
    }

    if (!campaign.fromSenderId && !campaign.fromEmail) {
      return reply.code(422).send({
        error: "Campaign has no sender configured",
        fields: { sender: MISSING_SENDER_COPY },
      });
    }

    // CR-02/TMPL-03/D-11/D-12: resolve WITHOUT persisting -- persistence
    // (when it changes anything) now happens inside prepareCampaignTestSend's
    // own locked transaction, in the SAME statement as the version compare
    // and bump, exactly as launch/schedule (plans 20-02/20-03) already do.
    // The returned row is the snapshot source for the job payload below --
    // never `request.body` (SC4).
    let prepared: CampaignRow;
    try {
      const resolvedFromEmail = await resolveCampaignSenderEmail(workspace.id, campaign);
      prepared = await withTenant(workspace.id, () =>
        prepareCampaignTestSend(id, {
          expectedVersion: parsed.data.expectedVersion,
          resolvedFromEmail,
        })
      );
    } catch (err) {
      const senderMapped = mapCampaignSenderError(err);
      if (senderMapped) return reply.code(senderMapped.code).send(senderMapped.body);
      if (err instanceof CampaignStateError && err.code === "incomplete") {
        return reply.code(422).send({
          error: err.message,
          code: err.code,
          fields: launchIncompleteFields(campaign),
        });
      }
      const mapped = mapCampaignStateError(err);
      if (mapped) return reply.code(mapped.code).send(mapped.body);
      throw err;
    }

    const testTo = parsed.data.to ?? session.user.email;
    const jobId = `${workspace.id}-test-${id}-${Date.now()}`;
    // Phase 15 plan 02 (OPS-11/OPS-12): carries the request's correlation id
    // across the HTTP->queue boundary -- server.ts's onRequest hook already
    // bound it for this request via withCorrelation, so it is read back
    // here, never re-derived or invented. Optional on the schema (no
    // schemaVersion bump) -- see queues.ts's own doc comment.
    const { requestId } = getCorrelationContext();
    await emailBroadcastQueue.add(
      "test",
      {
        workspaceId: workspace.id,
        campaignId: id,
        kind: "test",
        testTo,
        testData: parsed.data.dynamicTemplateData,
        // TMPL-03/D-12: the template/sender the locked precondition check
        // above just verified -- captured here, not re-read at dispatch
        // time, so a save between now and worker pickup can never redirect
        // this already-queued test send.
        ...(prepared.templateId !== null ? { templateId: prepared.templateId } : {}),
        ...(prepared.fromEmail !== null ? { fromEmail: prepared.fromEmail } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      },
      { jobId }
    );

    return reply.code(202).send({ queued: true, to: testTo });
  });

  // D-18/D-19: the single standardized buildContactTemplateData contract --
  // never an ad-hoc inline object -- so the test-send editor's prefill can
  // never drift from what the dispatch worker actually sends.
  fastify.get("/api/workspaces/:slug/campaigns/:id/test-sample", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const campaign = await withTenant(workspace.id, () => getCampaign(id));
    if (!campaign) {
      return reply.code(404).send({ error: "Campaign not found" });
    }

    const segment = await withTenant(workspace.id, () => getSegment(campaign.segmentId));
    if (!segment) {
      return reply.send({ sample: TEST_SAMPLE_PLACEHOLDER });
    }

    try {
      const { items } = await withTenant(workspace.id, () =>
        listSegmentMembers(segment.definition, 1, 1, { statementTimeoutMs: SEGMENT_EVAL_STATEMENT_TIMEOUT_MS })
      );
      const contact = items[0];
      if (!contact) {
        return reply.send({ sample: TEST_SAMPLE_PLACEHOLDER });
      }
      return reply.send({ sample: buildContactTemplateData(contact) });
    } catch (err) {
      if (isQueryCanceledError(err)) {
        return reply.send({ sample: TEST_SAMPLE_PLACEHOLDER });
      }
      throw err;
    }
  });

  fastify.get("/api/workspaces/:slug/campaigns/:id/progress", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const progress = await withTenant(workspace.id, () => getCampaignProgress(id));
    if (!progress) {
      return reply.code(404).send({ error: "Campaign not found" });
    }
    return reply.send(progress);
  });

  // D-04/SUBS-03: sendable segment count + the sends-ledger exclusion
  // breakdown grouped by reason, both statement_timeout-guarded (57014->4xx)
  // the same way segments.routes.ts's own evaluation paths already are.
  fastify.get("/api/workspaces/:slug/campaigns/:id/audience-breakdown", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const campaign = await withTenant(workspace.id, () => getCampaign(id));
    if (!campaign) {
      return reply.code(404).send({ error: "Campaign not found" });
    }

    const segment = await withTenant(workspace.id, () => getSegment(campaign.segmentId));
    if (!segment) {
      return reply.code(404).send({ error: "Segment not found" });
    }

    try {
      const sendableCount = await withTenant(workspace.id, () =>
        countSegmentMembers(segment.definition, { statementTimeoutMs: SEGMENT_EVAL_STATEMENT_TIMEOUT_MS })
      );
      const breakdown = await withTenant(workspace.id, () =>
        withTenantTransaction((client) =>
          audienceExclusionBreakdown(client, { workspaceId: workspace.id, campaignId: id })
        )
      );
      return reply.send({ sendableCount, breakdown });
    } catch (err) {
      if (isQueryCanceledError(err)) {
        return reply
          .code(400)
          .send({ error: "Segment definition is too expensive to evaluate — narrow the conditions" });
      }
      throw err;
    }
  });
}
