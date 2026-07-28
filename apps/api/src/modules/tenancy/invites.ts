import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { db, invitation, organization, user } from "@mega-crm/db";
import {
  acceptInviteSchema,
  inviteResponseSchema,
  inviteSchema,
  invitePreviewSchema,
  registerFromInviteSchema,
} from "@mega-crm/shared-schemas";
import { auth } from "../auth/auth.js";
import { requirePermission, toFetchHeaders } from "../../middleware/role-guard.js";
import { env } from "../../env.js";
import { findActiveWorkspaceBySlug } from "./workspace-lookup.js";
import { getCallerRoles } from "./member-roles.js";

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toInviteResponse(inv: {
  id: string;
  email: string;
  role: string | string[] | null;
  status: string;
  expiresAt: Date | string;
}) {
  return inviteResponseSchema.parse({
    id: inv.id,
    email: inv.email,
    role: Array.isArray(inv.role) ? inv.role.join(",") : (inv.role ?? "member"),
    status: inv.status,
    expiresAt: toIsoString(inv.expiresAt),
    inviteUrl: `${env.WEB_URL}/invite/${inv.id}`,
  });
}

/**
 * Invite lifecycle (TENANT-02, D-10/D-11/D-12) over better-auth's
 * organization plugin -- create/list/revoke/resend are workspace-scoped
 * (`/api/workspaces/:slug/invites*`, gated by role), while the recipient-side
 * preview/accept/register routes (`/api/invites/:invitationId*`) are NOT
 * slug-scoped: the invitee doesn't know or belong to the workspace yet.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: app.register() resolves the returned promise, and the declared Promise<void> is part of that signature -- dropping async would change it, not simplify it
export async function registerInviteRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    "/api/workspaces/:slug/invites",
    { preHandler: requirePermission("invitation", "create") },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const parsed = inviteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const headers = toFetchHeaders(request);

      // D-18: only the Owner may invite someone directly as Admin.
      if (parsed.data.role === "admin") {
        const callerRoles = await getCallerRoles(headers, slug);
        if (!callerRoles.includes("owner")) {
          return reply.code(403).send({ error: "Только владелец может назначать роль администратора" });
        }
      }

      try {
        const created = await auth.api.createInvitation({
          headers,
          body: { email: parsed.data.email, role: parsed.data.role, organizationId: workspace.id },
        });
        return reply.send(toInviteResponse(created));
      } catch (err) {
        if (err instanceof APIError) {
          return reply.code(err.statusCode ?? 400).send({ error: err.message });
        }
        throw err;
      }
    }
  );

  fastify.get(
    "/api/workspaces/:slug/invites",
    { preHandler: requirePermission("invitation", "create") },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      try {
        const invitations = await auth.api.listInvitations({
          headers: toFetchHeaders(request),
          query: { organizationId: workspace.id },
        });
        // Every non-pending invitation (accepted/canceled/rejected) is either
        // already reflected in the member list or no longer actionable --
        // pending ones (including silently expired-but-still-"pending" rows)
        // are what the team page's badge + revoke/resend actions operate on.
        const pending = invitations.filter((inv) => inv.status === "pending");
        return reply.send(pending.map((inv) => toInviteResponse(inv)));
      } catch (err) {
        if (err instanceof APIError) {
          return reply.code(err.statusCode ?? 403).send({ error: err.message });
        }
        throw err;
      }
    }
  );

  fastify.post(
    "/api/workspaces/:slug/invites/:invitationId/revoke",
    { preHandler: requirePermission("invitation", "cancel") },
    async (request, reply) => {
      const { invitationId } = request.params as { invitationId: string };
      try {
        await auth.api.cancelInvitation({
          headers: toFetchHeaders(request),
          body: { invitationId },
        });
        return reply.send({ status: true });
      } catch (err) {
        if (err instanceof APIError) {
          return reply.code(err.statusCode ?? 400).send({ error: err.message });
        }
        throw err;
      }
    }
  );

  fastify.post(
    "/api/workspaces/:slug/invites/:invitationId/resend",
    { preHandler: requirePermission("invitation", "create") },
    async (request, reply) => {
      const { slug, invitationId } = request.params as { slug: string; invitationId: string };
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const existing = await db.query.invitation.findFirst({
        where: eq(invitation.id, invitationId),
      });
      if (!existing || existing.organizationId !== workspace.id) {
        return reply.code(404).send({ error: "Invitation not found" });
      }

      try {
        const refreshed = await auth.api.createInvitation({
          headers: toFetchHeaders(request),
          body: {
            email: existing.email,
            // better-auth's org-plugin types the role param against its own
            // role union; `existing.role` comes back as a plain `string |
            // null` from our hand-authored Drizzle schema (it's whatever was
            // stored on the original invite, always one of our three roles).
            role: (existing.role ?? "member") as "member" | "admin" | "owner",
            organizationId: workspace.id,
            resend: true,
          },
        });
        return reply.send(toInviteResponse(refreshed));
      } catch (err) {
        if (err instanceof APIError) {
          return reply.code(err.statusCode ?? 400).send({ error: err.message });
        }
        throw err;
      }
    }
  );

  /**
   * Public preview (D-11 expired/revoked copy, D-12 register-from-invite
   * form): deliberately NOT better-auth's own `getInvitation`, which
   * requires a signed-in session whose email already matches the invite --
   * exactly the case D-12 (an invitee with no account yet) can never satisfy.
   * Reads the invitation/organization rows directly instead (no hand-rolled
   * table -- these are better-auth's own).
   */
  fastify.get("/api/invites/:invitationId", async (request, reply) => {
    const { invitationId } = request.params as { invitationId: string };

    const invite = await db.query.invitation.findFirst({
      where: eq(invitation.id, invitationId),
    });
    if (!invite) {
      return reply.code(404).send({ error: "Invitation not found" });
    }

    const org = await db.query.organization.findFirst({
      where: eq(organization.id, invite.organizationId),
    });
    if (!org) {
      return reply.code(404).send({ error: "Invitation not found" });
    }

    let status: "pending" | "expired" | "revoked" | "accepted";
    if (invite.status === "accepted") {
      status = "accepted";
    } else if (invite.status !== "pending") {
      // better-auth's org plugin only ever sets "canceled" or "rejected"
      // beyond pending/accepted -- both read as "no longer usable" to the
      // invitee, matching the UI-SPEC's single "revoked" copy for either.
      status = "revoked";
    } else if (new Date(invite.expiresAt) < new Date()) {
      status = "expired";
    } else {
      status = "pending";
    }

    return reply.send(
      invitePreviewSchema.parse({
        email: invite.email,
        role: invite.role ?? "member",
        organizationName: org.name,
        organizationSlug: org.slug,
        status,
      })
    );
  });

  /** Accept as an existing account -- the caller must already be signed in with a matching email (better-auth enforces this itself). */
  fastify.post(
    "/api/invites/:invitationId/accept",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = acceptInviteSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      try {
        await auth.api.acceptInvitation({
          headers: toFetchHeaders(request),
          body: { invitationId: parsed.data.invitationId },
        });
        return reply.send({ status: true });
      } catch (err) {
        if (err instanceof APIError) {
          return reply.code(err.statusCode ?? 400).send({ error: err.message });
        }
        throw err;
      }
    }
  );

  /**
   * D-12: register-from-invite -- creates the account with the invitation's
   * FIXED email (never client input) plus the submitted name/password, then
   * accepts the invitation as that brand-new session, then forwards the
   * fresh session cookie to the actual reply so the browser ends up signed
   * in. Rate-limited (RESEARCH.md invite-token brute-force mitigation,
   * T-01-13).
   */
  fastify.post(
    "/api/invites/:invitationId/register",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { invitationId } = request.params as { invitationId: string };
      const parsed = registerFromInviteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const invite = await db.query.invitation.findFirst({
        where: eq(invitation.id, invitationId),
      });
      if (!invite || invite.status !== "pending" || new Date(invite.expiresAt) < new Date()) {
        return reply.code(400).send({ error: "Invitation is no longer valid" });
      }

      const existingUser = await db.query.user.findFirst({
        where: eq(user.email, invite.email),
      });
      if (existingUser) {
        return reply
          .code(409)
          .send({ error: "An account with this email already exists. Log in to accept the invitation." });
      }

      let signUpResult: { headers: Headers };
      try {
        signUpResult = await auth.api.signUpEmail({
          body: { email: invite.email, password: parsed.data.password, name: parsed.data.name },
          returnHeaders: true,
        });
      } catch (err) {
        if (err instanceof APIError) {
          return reply.code(err.statusCode ?? 400).send({ error: err.message });
        }
        throw err;
      }

      const setCookies = signUpResult.headers.getSetCookie();
      const cookieHeader = setCookies.map((cookie) => cookie.split(";")[0]).join("; ");

      try {
        await auth.api.acceptInvitation({
          headers: new Headers({ cookie: cookieHeader }),
          body: { invitationId },
        });
      } catch (err) {
        if (err instanceof APIError) {
          return reply.code(err.statusCode ?? 400).send({ error: err.message });
        }
        throw err;
      }

      if (setCookies.length > 0) {
        reply.header("set-cookie", setCookies);
      }

      return reply.send({ status: true });
    }
  );
}
