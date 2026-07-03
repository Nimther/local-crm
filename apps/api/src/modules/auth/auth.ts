import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { db } from "@mega-crm/db";
import { env } from "../../env.js";
import { ac, admin, member, owner } from "./access-control.js";

/**
 * better-auth: the auth + workspace/role/invite backbone (RESEARCH.md
 * Pattern 1). D-13..D-19 map directly onto the `organization` plugin's
 * default org/member/invitation model — no parallel hand-rolled tables.
 */
export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.WEB_URL],
  database: drizzleAdapter(db, { provider: "pg" }),
  // D-02/Pitfall 2: soft verification — usable immediately, verification is
  // gated per-critical-action (SendGrid-key-connect, 01-05), never globally.
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  // D-04: 30-day sliding cookie session.
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  advanced: {
    // IDs are native Postgres uuid (gen_random_uuid() column default, see
    // packages/db/src/schema/auth.ts) — never better-auth's own nanoid ID,
    // so every workspace_id matches the ::uuid cast every RLS policy uses.
    database: {
      generateId: false,
    },
  },
  plugins: [
    organization({
      ac,
      roles: { owner, admin, member },
      // D-11: invites expire after 7 days.
      invitationExpiresIn: 60 * 60 * 24 * 7,
      schema: {
        organization: {
          additionalFields: {
            // D-20: soft-delete, physical cleanup deferred to 01-04.
            deletedAt: { type: "date", required: false, input: false },
          },
        },
      },
      sendInvitationEmail: async () => {
        // TODO(01-04): dispatch via the platform SendGrid account (D-07),
        // never a tenant's own key. Team invites land in 01-04; until then
        // this is a stub so `organization.createInvitation` doesn't throw.
      },
    }),
  ],
});
