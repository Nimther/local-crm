import type { FastifyInstance } from "fastify";
import { upsertContactApiSchema } from "@mega-crm/shared-schemas";
import { withTenant, withTenantTransaction } from "../../middleware/tenant-context.js";
import { apiKeyAuth } from "../api-keys/api-key-auth.js";
import { upsertContactByIdentity } from "./contact.repository.js";

/**
 * CONT-03/EVNT-02-readiness: API-key-authed Contacts integration API. Mounted
 * in its own encapsulated plugin scope whose `onRequest` hook is `apiKeyAuth`
 * (T-02-04-03/T-02-04-04) -- the workspace is resolved EXCLUSIVELY from
 * `request.apiKeyWorkspaceId`, never a `:slug` param or session, so this
 * scope never falls back to session/slug resolution. Reuses the exact same
 * `upsertContactByIdentity` the events:ingest worker (02-06) and imports:csv
 * worker (02-07) will call, so CONT-04's identity rules cannot drift between
 * call sites.
 */
export async function registerContactsApiRoutes(fastify: FastifyInstance): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: app.register() resolves the returned promise, and the declared Promise<void> is part of that signature -- dropping async would change it, not simplify it
  await fastify.register(async (scope) => {
    // onRequest (not preHandler): must run BEFORE Fastify parses the request
    // body (Pitfall 3) -- important since this route can receive a batch.
    scope.addHook("onRequest", apiKeyAuth);

    scope.post(
      "/v1/contacts",
      {
        // T-02-04-03: rate-limit + a bounded body size on this unauthenticated-
        // until-key-checked surface. @fastify/rate-limit is registered at the
        // app root with `global: false` (server.ts) -- opting in here via
        // `config.rateLimit` applies it to just this route.
        config: { rateLimit: { max: 100, timeWindow: "1 minute" } },
        bodyLimit: 1024 * 1024,
      },
      async (request, reply) => {
        const parsed = upsertContactApiSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.flatten() });
        }

        // T-02-04-04: workspace resolved SOLELY from the verified API key --
        // apiKeyAuth already ran on onRequest and either set this or replied
        // 401 before this handler could ever run.
        const workspaceId = request.apiKeyWorkspaceId as string;

        const items = Array.isArray(parsed.data) ? parsed.data : [parsed.data];

        const results = await withTenant(workspaceId, () =>
          withTenantTransaction(async (client) => {
            const out = [];
            for (const item of items) {
              out.push(await upsertContactByIdentity(client, workspaceId, item));
            }
            return out;
          })
        );

        if (Array.isArray(parsed.data)) {
          return reply.code(200).send({
            results: results.map((r) => ({
              id: r.contactId,
              attached: r.attached ?? false,
              emailChangeSkipped: r.emailChangeSkipped ?? false,
            })),
          });
        }

        const [result] = results;
        return reply.code(200).send({
          id: result.contactId,
          attached: result.attached ?? false,
          emailChangeSkipped: result.emailChangeSkipped ?? false,
        });
      }
    );
  });
}
