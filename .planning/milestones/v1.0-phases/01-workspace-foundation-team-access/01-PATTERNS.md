# Phase 1: Workspace Foundation & Team Access - Pattern Map

**Mapped:** 2026-07-03
**Status:** GREENFIELD — no existing source code in repository
**Files analyzed:** 0 pre-existing (repo contains only `.claude/` and `.planning/`)
**Analogs found:** 0 / 0 (N/A — no codebase to search)

## Greenfield Notice

This repository has **no source code yet** — verified via directory listing: only `.claude/CLAUDE.md` and `.planning/*` exist. There are no `apps/`, `packages/`, `src/`, or `package.json` files. Standard pattern-mapping (search codebase → find analog → extract excerpt) is not applicable because there is nothing to search.

Instead, this document records the **canonical patterns this phase must establish**, drawn directly from `01-RESEARCH.md`'s Architecture Patterns / Code Examples sections and `.claude/CLAUDE.md`'s locked stack conventions. Every file in Phase 1 is a **new file with no existing analog** — the planner should treat RESEARCH.md's code examples as the seed pattern for each, not search for codebase precedent.

Because this is Wave 0 (the walking skeleton), the patterns established here become the analogs for **every subsequent phase**. Plan actions should be explicit that these are precedent-setting, not precedent-following.

## File Classification (Planned Files, No Existing Analog)

| New File | Role | Data Flow | Seed Pattern Source | Match Quality |
|----------|------|-----------|----------------------|----------------|
| `package.json` (root, npm workspaces) | config | — | RESEARCH.md "Recommended Project Structure" | no-analog (seed) |
| `apps/api/src/server.ts` | config/bootstrap | request-response | RESEARCH.md Architecture Diagram + CLAUDE.md Fastify conventions | no-analog (seed) |
| `apps/api/src/modules/auth/*` (better-auth config + Fastify wiring) | service | request-response | RESEARCH.md Pattern 1 (better-auth organization plugin) | no-analog (seed) |
| `apps/api/src/modules/tenancy/workspaces.ts` (routes) | route/controller | CRUD | RESEARCH.md Architecture Diagram "Route handlers: workspaces" | no-analog (seed) |
| `apps/api/src/modules/tenancy/members.ts` (routes) | route/controller | CRUD | Same module family as workspaces.ts (internal consistency, not external analog) | no-analog (seed) |
| `apps/api/src/modules/tenancy/invites.ts` (routes) | route/controller | CRUD + event-driven (email dispatch) | RESEARCH.md Pattern 1 `sendInvitationEmail` callback | no-analog (seed) |
| `apps/api/src/modules/tenancy/sendgrid-key.ts` (routes) | route/controller | request-response (validate) + CRUD (store) | RESEARCH.md "SendGrid key validation at connect time" code example | no-analog (seed) |
| `apps/api/src/modules/platform-mail/client.ts` | service | request-response (outbound to SendGrid) | RESEARCH.md Anti-Pattern 4 (two-key confusion) — must be structurally distinct from tenant client | no-analog (seed) |
| `apps/api/src/middleware/tenant-context.ts` | middleware | request-response | RESEARCH.md Pattern 2 (AsyncLocalStorage + SET LOCAL) — copy verbatim | no-analog (seed) |
| `apps/api/src/middleware/role-guard.ts` | middleware | request-response | RESEARCH.md Pattern 1 `createAccessControl` statement | no-analog (seed) |
| `apps/api/src/kms/client.ts` | utility/service | transform (encrypt/decrypt) | RESEARCH.md Pattern 3 (KMS envelope encryption) — copy verbatim | no-analog (seed) |
| `packages/db/schema/*.ts` (Drizzle schema: workspaces, members, invitations, sendgrid_keys) | model | CRUD | RESEARCH.md Architecture Diagram Postgres block | no-analog (seed) |
| `packages/db/migrations/*.sql` (RLS policies) | migration | — | RESEARCH.md Pattern 2 SQL example (`CREATE POLICY workspace_isolation`) | no-analog (seed) |
| `packages/shared-schemas/*.ts` (Zod schemas) | utility | transform (validation) | CLAUDE.md "single schema definition shared between Fastify route validation... and frontend forms" | no-analog (seed) |
| `apps/web/src/routes/register.tsx`, `login.tsx` | component | request-response | RESEARCH.md System Architecture Diagram (Browser block) | no-analog (seed) |
| `apps/web/src/features/workspace-switcher/*` | component | request-response | Same | no-analog (seed) |
| `apps/web/src/features/team/*` (invite UI, member list) | component | CRUD | Same | no-analog (seed) |
| `apps/web/src/features/sendgrid-key/*` (connect form, masked display) | component | request-response | RESEARCH.md "SendGrid key validation at connect time" (client calls this) | no-analog (seed) |
| `apps/api/.../__tests__/*.test.ts` (5 test files, TENANT-01..05) | test | — | RESEARCH.md "Phase Requirements → Test Map" table | no-analog (seed) |

## Pattern Assignments (Canonical Patterns to Seed)

### Tenant context middleware — `apps/api/src/middleware/tenant-context.ts`

**Source:** RESEARCH.md Pattern 2, cited against AWS RLS guidance and Drizzle RLS docs.

**Core pattern — AsyncLocalStorage + SET LOCAL (copy near-verbatim):**
```typescript
import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";

const tenantContext = new AsyncLocalStorage<{ workspaceId: string }>();

export function withTenant<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ workspaceId }, fn);
}

export async function withTenantTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const ctx = tenantContext.getStore();
  if (!ctx) throw new Error("No tenant context set for this request");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [ctx.workspaceId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
```

**Hard rules (from Anti-Patterns / Pitfall 1):**
- Always `SET LOCAL`, never `SET` — bleeds into next pooled request otherwise.
- Never store tenant context in a module-level variable — `AsyncLocalStorage` only.
- Every tenant-scoped table MUST get an RLS policy — treat as CI-enforced checklist.

**Companion SQL (every tenant-scoped table):**
```sql
CREATE POLICY workspace_isolation ON contacts
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
```
Apply the same policy shape to `workspace_members`, `invitations`, `workspace_sendgrid_keys`.

---

### Auth + workspace/role/invite backbone — `apps/api/src/modules/auth/*`

**Source:** RESEARCH.md Pattern 1, cited against better-auth official docs.

**Core pattern (copy structure, adapt statement as domain grows):**
```typescript
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db";

const statement = {
  sendgridKey: ["update"],
  campaign: ["launch"],
  flow: ["publish"],
} as const;

const ac = createAccessControl(statement);
const member = ac.newRole({ sendgridKey: [], campaign: [], flow: [] });
const admin = ac.newRole({ sendgridKey: ["update"], campaign: ["launch"], flow: ["publish"] });
const owner = ac.newRole({ sendgridKey: ["update"], campaign: ["launch"], flow: ["publish"] });

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // D-02: soft verification, gated per-action
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // D-04: 30 days
    updateAge: 60 * 60 * 24,
  },
  plugins: [
    organization({
      ac,
      roles: { owner, admin, member },
      sendInvitationEmail: async (data) => {
        await platformMail.sendInvite({
          to: data.email,
          inviteUrl: `${WEB_URL}/invite/${data.id}`,
          orgName: data.organization.name,
        });
      },
      invitationExpiresIn: 60 * 60 * 24 * 7, // D-11: 7 days
    }),
  ],
});
```

**Do-not-hand-roll rule:** No parallel `memberships`/`invitations` tables — better-auth's organization plugin owns this data model (D-13–D-19 map directly onto its default shape).

**Pitfall to avoid explicitly (this is a decision, not an oversight):** Leave `requireEmailVerification` / `requireEmailVerificationOnInvitation` OFF globally (conflicts with D-02/D-12). Implement verified-email gate as a route-level check specifically on the SendGrid-key-connect endpoint.

---

### KMS envelope encryption — `apps/api/src/kms/client.ts`

**Source:** RESEARCH.md Pattern 3, cited against AWS KMS `GenerateDataKey` API docs.

**Core pattern (copy near-verbatim, adapt for `KMS_PROVIDER=local|aws` toggle per Pitfall 3):**
```typescript
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const kms = new KMSClient({ region: process.env.AWS_REGION });

export async function encryptTenantSendGridKey(workspaceId: string, plaintextKey: string) {
  const { Plaintext, CiphertextBlob } = await kms.send(
    new GenerateDataKeyCommand({
      KeyId: process.env.KMS_KEK_ID,
      KeySpec: "AES_256",
      EncryptionContext: { workspaceId },
    })
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Plaintext!, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextKey, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  Plaintext!.fill(0); // zero plaintext DEK immediately

  return {
    encryptedDek: Buffer.from(CiphertextBlob!).toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}
```

**Local-dev requirement (Pitfall 3, Open Question 2):** Gate behind `KMS_PROVIDER` env toggle; `local` provider uses a static dev-only KEK, must refuse to boot with `KMS_PROVIDER=local` if `NODE_ENV=production`.

**Never:** log the decrypted key/DEK (Pino redaction rules must explicitly cover `sendgridKey`/`apiKey` fields); never persist plaintext DEK past the single encrypt/decrypt operation.

---

### SendGrid key validation route — `apps/api/src/modules/tenancy/sendgrid-key.ts`

**Source:** RESEARCH.md "SendGrid key validation at connect time" (D-21), cited against SendGrid API docs.

```typescript
async function validateTenantSendGridKey(apiKey: string) {
  const scopesRes = await fetch("https://api.sendgrid.com/v3/scopes", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!scopesRes.ok) {
    return { valid: false, error: "Key rejected by SendGrid (invalid or revoked)" };
  }
  const { scopes } = await scopesRes.json();
  if (!scopes.includes("mail.send")) {
    return { valid: false, error: "Key is valid but missing the mail.send scope" };
  }

  const sendersRes = await fetch("https://api.sendgrid.com/v3/verified_senders", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const verifiedSenders = sendersRes.ok ? (await sendersRes.json()).results : [];

  return { valid: true, scopes, verifiedSenders };
}
```

**Two-key discipline (Pitfall 4):** This module (tenant key, decrypted per-request) must remain structurally non-interchangeable with `apps/api/src/modules/platform-mail/client.ts` (platform key, from env/secrets). Different function signatures — let TypeScript catch misuse, not code review.

---

### Workspace slug generation — used inside `workspaces.ts` route

**Source:** RESEARCH.md "Workspace slug generation with collision retry" (D-16, Claude's Discretion item).

```typescript
import { nanoid } from "nanoid";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

async function createUniqueWorkspaceSlug(name: string, db: Db): Promise<string> {
  const base = slugify(name) || "workspace";
  let candidate = base;
  let attempts = 0;
  while (await db.query.workspaces.findFirst({ where: eq(workspaces.slug, candidate) })) {
    attempts++;
    candidate = `${base}-${nanoid(6).toLowerCase()}`;
    if (attempts > 5) throw new Error("Could not generate a unique workspace slug");
  }
  return candidate;
}
```

## Shared Patterns

### Fastify + Zod route validation
**Source:** CLAUDE.md stack table (`@fastify/type-provider-zod`); no code example yet exists in repo — planner/implementer should establish the first instance in `apps/api/src/modules/tenancy/workspaces.ts` and treat it as the reference for every subsequent route file in later phases.
**Apply to:** All route files (workspaces, members, invites, sendgrid-key).

### Structured logging with redaction
**Source:** CLAUDE.md (`pino`/`pino-http` locked); RESEARCH.md explicitly requires redaction of `sendgridKey`/`apiKey` fields.
**Apply to:** All modules that touch the tenant SendGrid key or session tokens — configure Pino redaction paths once, in `server.ts`, reused everywhere.

### Tenant vs. platform SendGrid client separation
**Source:** RESEARCH.md Anti-Pattern/Pitfall 4.
**Apply to:** `modules/platform-mail/client.ts` and `modules/tenancy/sendgrid-client.ts` — keep as two distinct modules with different types from day one.

### RLS policy on every tenant-scoped table
**Source:** RESEARCH.md Pattern 2 SQL example.
**Apply to:** `packages/db/schema/*` — every table with a `workspace_id` column gets a matching `CREATE POLICY` migration in the same PR/task.

## No Analog Found

All files in this phase — there is no prior codebase. See Greenfield Notice above; RESEARCH.md code examples serve as the seed pattern for every file, not a codebase analog.

## Metadata

**Analog search scope:** Full repository root (`find` to depth 2) — confirmed empty of source code.
**Files scanned:** 0 source files (only `.claude/CLAUDE.md`, `.planning/*` present)
**Pattern extraction date:** 2026-07-03
