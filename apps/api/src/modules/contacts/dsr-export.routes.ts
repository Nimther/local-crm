import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auth } from "../auth/auth.js";
import { toFetchHeaders, requirePermission } from "../../middleware/role-guard.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { resolveWorkspaceMember, NOT_FOUND_BODY } from "../tenancy/resolve-workspace-member.js";
import { getDsrExportDocument, ContactErasedError } from "./dsr-export.repository.js";

interface DsrExportAuditLogInput {
  requesterUserId: string;
  workspaceId: string;
  contactId: string;
  sectionRowCounts: Record<string, number>;
}

/**
 * D-11: the flat field object logged on a successful export -- requester
 * user id, workspace, contact id, and per-section row counts only. Never a
 * profile field, a property value, or any exported payload -- the export's
 * own data never crosses into the observability pipeline.
 */
export function buildDsrExportAuditLog(input: DsrExportAuditLogInput): DsrExportAuditLogInput {
  return { ...input };
}

function isoDateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Phase 21 plan 01 (DSR-01/DSR-04, tracer): a single Owner/Admin-gated
 * route that assembles and downloads one contact's DSR export document.
 * Registered alongside `registerContactsRoutes` in server.ts, but kept in
 * its own module/file (not added to contacts.routes.ts) because its
 * permission gate (`requirePermission("contact","export")`) and its
 * REPEATABLE READ transaction wrapper are both specific to this one route,
 * unlike every ordinary-membership route in contacts.routes.ts.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: app.register() resolves the returned promise
export async function registerDsrExportRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    "/api/workspaces/:slug/contacts/:id/dsr-export",
    { preHandler: requirePermission("contact", "export") },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };

      const resolved = await resolveWorkspaceMember(request, reply, slug);
      if (!resolved) return;
      const workspace = resolved.workspace;

      // WR-06 precedent (csv-import.routes.ts): validate the
      // attacker-controlled id AFTER resolveWorkspaceMember (so an
      // outsider's response bytes stay unchanged) but BEFORE it reaches
      // any query or the Content-Disposition header below.
      const parsedId = z.string().uuid().safeParse(id);
      if (!parsedId.success) {
        return reply.code(400).send({ error: "Invalid contact id" });
      }
      const contactId = parsedId.data;

      const session = await auth.api.getSession({ headers: toFetchHeaders(request) });
      if (!session) {
        return reply.code(401).send({ error: "Not authenticated" });
      }

      try {
        const doc = await withTenant(workspace.id, () =>
          getDsrExportDocument(workspace.id, workspace.name, contactId)
        );

        if (!doc) {
          // SC4: byte-identical to resolveWorkspaceMember's own missing-
          // workspace/non-member 404 -- imported reference, not a
          // re-typed literal, so this route cannot silently drift from
          // that byte-identical contract (see resolve-workspace-member.ts).
          return reply.code(404).send(NOT_FOUND_BODY);
        }

        const filename = `dsr-export-${contactId}-${isoDateStamp(new Date())}.json`;
        reply.header("Content-Type", "application/json");
        reply.header("Content-Disposition", `attachment; filename="${filename}"`);

        request.log.info(
          buildDsrExportAuditLog({
            requesterUserId: session.user.id,
            workspaceId: workspace.id,
            contactId,
            sectionRowCounts: doc.metadata.sectionRowCounts,
          }),
          "dsr_export_completed"
        );

        return reply.send(doc);
      } catch (err) {
        if (err instanceof ContactErasedError) {
          // D-13: an authorised same-tenant caller is told the personal
          // data no longer exists -- distinct from contacts.routes.ts's
          // "contact_anonymized" -> 404 mapping, which hides existence
          // from a tenant reading a LIVE contact. Both behaviours coexist
          // deliberately (Task 2 owns the test proving this, but the
          // divergence is recorded here where the catch branch lives).
          return reply.code(410).send({
            code: "contact_erased",
            erasedAt: err.erasedAt,
            erasureRecordId: err.erasureRecordId,
          });
        }
        throw err;
      }
    }
  );
}
