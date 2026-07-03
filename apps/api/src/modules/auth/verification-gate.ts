import type { FastifyReply, FastifyRequest } from "fastify";
import { auth } from "./auth.js";
import { toFetchHeaders } from "../../middleware/role-guard.js";

type SessionLike = { user: { emailVerified: boolean } } | null | undefined;

/**
 * D-02: verification is soft -- the platform is usable before verifying.
 * This predicate is the single source of truth for "is this session's user
 * verified", reused both by this module's own preHandler and by any route
 * that wants to branch on verification state directly.
 */
export function isEmailVerified(session: SessionLike): boolean {
  return Boolean(session?.user?.emailVerified);
}

const UNVERIFIED_ERROR =
  "Подтвердите email, чтобы подключить SendGrid. Мы отправили письмо со ссылкой — проверьте почту.";

/**
 * Fastify preHandler gating a critical action (SendGrid-key-connect, wired
 * in 01-05) behind email verification. `emailAndPassword.requireEmailVerification`
 * and `organization.requireEmailVerificationOnInvitation` stay OFF globally in
 * auth.ts (RESEARCH.md Pitfall 2) -- this per-action gate is the enforcement
 * point instead, so D-02 (soft verification) and D-12 (invited users signing
 * up directly) both keep working.
 */
export async function requireVerifiedEmail(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const session = await auth.api.getSession({ headers: toFetchHeaders(request) });
  if (!isEmailVerified(session)) {
    await reply.code(403).send({ error: UNVERIFIED_ERROR });
  }
}
