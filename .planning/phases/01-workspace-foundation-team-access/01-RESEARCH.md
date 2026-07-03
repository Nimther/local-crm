# Phase 1: Workspace Foundation & Team Access - Research

**Researched:** 2026-07-03
**Domain:** Multi-tenant auth, workspace/membership modeling, Postgres RLS, KMS-backed secret storage, SendGrid BYO-key validation
**Confidence:** MEDIUM-HIGH (stack versions VERIFIED against npm registry; RLS/pooling/KMS patterns CITED against official docs and multiple independent practitioner sources; better-auth organization-plugin fit is a strong, verified match to the role model in CONTEXT.md)

## Summary

Phase 1 is the multi-tenant foundation every later phase depends on: registration/login, workspace creation, Owner/Admin/Member roles, email invites, and an encrypted, validated-on-connect SendGrid key — all under Postgres Row-Level Security that must survive connection-pool reuse. Nothing in the repo exists yet (verified: no `package.json`, no `src/`); this phase's first deliverable is also the project's walking skeleton (monorepo scaffold, one real DB read/write, one real UI interaction, dev deploy).

The single biggest research finding: **better-auth's `organization` plugin is a near-exact structural match for D-13 through D-19** in CONTEXT.md. It natively models organizations (= workspaces), memberships, invitations (by email, with expiry and resend/revoke), and a default `owner`/`admin`/`member` role triad with a `createAccessControl` API for custom per-resource permissions (e.g. restricting `sendgrid_key:update` and `campaign:launch` to owner/admin only, exactly matching D-19). This significantly de-risks D-05 (auth library choice) and D-17–D-19 (role model) — the plan should build on this plugin rather than hand-rolling membership/invite tables.

The second-biggest risk is **Postgres RLS + connection pooling** (PITFALLS.md #5/#8, and this phase's own success criterion 5). The correct pattern — `SET LOCAL app.tenant_id` inside the same transaction as every query, using Node's `AsyncLocalStorage` for request-scoped context, never a module-level variable — is well-documented and must be chaos-tested (kill a connection mid-transaction, confirm no cross-tenant leakage) as part of this phase's verification, not deferred.

The third risk area is **KMS envelope encryption in local/dev environments**: this machine has no AWS CLI and no cloud KMS reachable from a laptop dev loop. The plan must account for a local-dev KMS fallback (LocalStack, or a dev-only static KEK) distinct from the production KMS-backed path, otherwise Wave 0 cannot be verified without cloud credentials.

**Primary recommendation:** Scaffold an npm-workspaces monorepo (`apps/api` Fastify 5, `apps/web` React 19/Vite, `packages/db` Drizzle schema+RLS), wire better-auth's `organization` plugin (Drizzle adapter) as the auth/workspace/role/invite backbone, enforce tenant isolation via Postgres RLS with `SET LOCAL` + `AsyncLocalStorage`, and store the SendGrid key via KMS envelope encryption validated against SendGrid's `GET /v3/scopes` and verified-senders endpoints at connect time.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Registration / login / password reset | API / Backend (better-auth) | Browser (session cookie storage only) | better-auth issues and validates the session server-side; browser only holds the HttpOnly cookie, no client-side auth logic |
| Session management (sliding expiration) | API / Backend | Browser | `expiresIn`/`updateAge` sliding-window logic runs server-side on session read; cookie is opaque to the client |
| Workspace creation & switching | API / Backend | Browser / Client | Workspace = better-auth "organization" row; server owns creation/slug uniqueness; client only renders the switcher and holds "active org" in session |
| Membership & role assignment (Owner/Admin/Member) | API / Backend | Database | Role checks and mutations happen server-side (better-auth org plugin + custom access-control statement); Postgres stores the membership row as the source of truth |
| Tenant context / RLS enforcement | Database (Postgres RLS policies) | API / Backend (sets `SET LOCAL` per request) | RLS is the last line of defense against a missed `WHERE` clause; the app layer is responsible for populating the session GUC correctly every request |
| Team invites by email | API / Backend | Browser / Client (accept-invite UI, copy-link fallback) | Invite creation, token generation, expiry, and email dispatch are server-side; UI only renders state and the copyable link |
| System emails (verification, reset, invite) | API / Backend | — | Separate platform SendGrid account/key (D-07); no UI/browser role at all — pure backend-to-SendGrid integration |
| SendGrid key connect & validation | API / Backend | Database (encrypted storage) | Validation (`GET /v3/scopes`, verified senders) is a live API call the backend must make; DB only stores the encrypted result |
| Envelope encryption (KMS) | Backend / Infra (KMS client) | Database (ciphertext + encrypted DEK storage) | KMS key material never touches the DB tier; the API process is the only tier that ever holds a decrypted DEK, and only transiently |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `fastify` | 5.9.0 [VERIFIED: npm registry] | HTTP API server | Already locked in CLAUDE.md/STACK.md; schema-first validation lifecycle fits every auth/tenancy route in this phase |
| `@fastify/type-provider-zod` | 1.0.0 [VERIFIED: npm registry] | Zod-typed route schemas | Fastify-5-compatible per project STACK.md version-compatibility table |
| `zod` | 4.4.3 [VERIFIED: npm registry] | Schema validation | Shared validation for invite payloads, SendGrid-key form, registration form |
| `better-auth` | 1.6.23 [VERIFIED: npm registry, cross-checked GitHub org `better-auth/better-auth`] | Auth + organizations (workspaces/roles/invites) | Cookie-session auth, email verification, password reset all native (D-01–D-04); `organization` plugin natively models D-13–D-19 (workspaces, Owner/Admin/Member, invites) — see Architecture Patterns |
| `drizzle-orm` | 0.45.2 [VERIFIED: npm registry] | ORM / RLS-aware query layer | Already locked; better-auth ships an official Drizzle adapter |
| `drizzle-kit` | 0.31.10 [VERIFIED: npm registry] | Migrations | Keep in lockstep with `drizzle-orm` minor per STACK.md compatibility note |
| `pg` | 8.22.0 [VERIFIED: npm registry] | Postgres driver | Pool it explicitly; `SET LOCAL` requires manual client/transaction control (see Pattern 2) |
| `@aws-sdk/client-kms` | 3.1079.0 [VERIFIED: npm registry] | KMS envelope encryption client | `GenerateDataKeyCommand` / `DecryptCommand` for per-tenant DEK wrapping (see Code Examples) |
| `@sendgrid/mail` | 8.1.6 [VERIFIED: npm registry] | SendGrid v3 API client (both platform + validating tenant keys) | Official SDK; used both for system emails (D-07) and to validate tenant keys at connect (D-21) |
| `pino` / `pino-http` | 10.3.1 / 11.0.0 [VERIFIED: npm registry] | Structured logging | Already locked; **never log the decrypted SendGrid key or session tokens** — redact explicitly |
| `nanoid` | 5.1.16 [VERIFIED: npm registry] | Slug-collision suffixes, invite tokens | Small, audited, URL-safe random ID generator; used for workspace-slug disambiguation and invite token generation |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@fastify/cors` | 11.2.0 [VERIFIED: npm registry] | CORS | Frontend SPA on separate origin from API in dev |
| `@fastify/helmet` | 13.0.2 [VERIFIED: npm registry] | Security headers | Baseline hardening for every route from day one |
| `@fastify/rate-limit` | 11.1.0 [VERIFIED: npm registry] | API rate limiting | Protect `/register`, `/login`, `/invite/accept` from credential-stuffing / invite-token brute force |
| `react` / `react-dom` | 19.2.x [ASSUMED — exact patch not re-verified this session, matches STACK.md] | UI | Already locked |
| `vite` / `@vitejs/plugin-react` | 8.1.x / latest [ASSUMED — matches STACK.md] | Build tool | Already locked |
| `react-hook-form` + `@hookform/resolvers` + `zod` | latest [VERIFIED: npm registry for `@hookform/resolvers`] | Registration/invite/SendGrid-key forms | Shares Zod schemas with backend validation |
| `@tanstack/react-query` | 5.101.x [ASSUMED — matches STACK.md] | Server state | Session/workspace/membership data fetching |
| `zustand` | latest [VERIFIED: npm registry] | Client UI state | Workspace-switcher open/closed, onboarding-checklist local state |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| better-auth | Hand-rolled auth (bcrypt + custom session table) | More control, but re-implements email verification, password reset, and — critically — the entire organization/membership/invite data model that better-auth already ships; not justified given D-05 names better-auth as the candidate |
| better-auth `organization` plugin roles | Fully custom `memberships` table + hand-rolled RBAC | Only justified if the role model needs to diverge sharply from owner/admin/member later (e.g., custom per-workspace roles in v2); D-17–D-19 map cleanly onto the plugin's default roles + `createAccessControl` today |
| AWS KMS | GCP KMS / HashiCorp Vault Transit | CLAUDE.md explicitly allows "AWS KMS (or GCP KMS / cloud-agnostic equivalent)" — no cloud provider is locked yet; this is an open decision for the plan (see Open Questions) |
| `nanoid` for slug suffixes | `uuid` short-hash, or a sequential counter | `nanoid` is smaller and already used elsewhere in the Node ecosystem for exactly this (URL-safe random tokens); a sequential counter is fine too but requires a `SERIAL`/lock, more moving parts than a random suffix + retry-on-conflict |

**Installation:**
```bash
# apps/api
npm install fastify @fastify/type-provider-zod zod fastify-plugin
npm install @fastify/cors @fastify/helmet @fastify/rate-limit
npm install better-auth drizzle-orm pg drizzle-kit -D
npm install @aws-sdk/client-kms @sendgrid/mail nanoid
npm install pino pino-http

# apps/web
npm install react react-dom
npm install @tanstack/react-query zustand
npm install react-hook-form @hookform/resolvers zod

# dev/test
npm install -D typescript vite @vitejs/plugin-react vitest playwright @types/pg
```

**Version verification:** All Core-table versions above confirmed live via `npm view <pkg> version time.modified` on 2026-07-03; all match or refine the versions already locked in `.claude/CLAUDE.md`/STACK.md. No drift detected.

## Package Legitimacy Audit

Ran `gsd-tools query package-legitimacy check` against every package this phase introduces or newly requires. The gate's `too-new` heuristic compares each package's **latest published version** date to "now" — for actively-maintained, frequently-released packages (React, Vite, Vitest, TanStack Query, react-hook-form, fastify, pg, csv-parse, @fastify/rate-limit, better-auth, @aws-sdk/client-kms) this produces a false "SUS" on packages that are in fact years old with tens-to-hundreds of millions of weekly downloads. To resolve this, Step 2 registry verification (`npm view <pkg> time --json`) was run to check actual package **creation date**, not latest-release date, for every package the gate flagged.

| Package | Registry | Age (first publish) | Weekly Downloads | Source Repo | Gate Verdict | Disposition |
|---------|----------|----------------------|-------------------|-------------|---------|-------------|
| `better-auth` | npm | 2024-04-22 (2+ yrs, 912 versions) | 4.24M | github.com/better-auth/better-auth | SUS (`too-new`, false positive — verified age) | **Approved** |
| `@aws-sdk/client-kms` | npm | 2020-01-08 (6+ yrs) | 4.23M | github.com/aws/aws-sdk-js-v3 | SUS (`too-new`, false positive) | **Approved** |
| `nanoid` | npm | 2017-08-06 (9+ yrs) | 220.8M | github.com/ai/nanoid | SUS (`too-new`, false positive) | **Approved** |
| `pg` | npm | 2010-12-19 (15+ yrs) | 33.6M | github.com/brianc/node-postgres | SUS (`too-new`, false positive) | **Approved** |
| `fastify` | npm | 2016-10-07 (9+ yrs) | 8.85M | github.com/fastify/fastify | SUS (`too-new`, false positive) | **Approved** |
| `@fastify/rate-limit` | npm | pre-2024 (official Fastify org plugin) | 1.24M | github.com/fastify/fastify-rate-limit | SUS (`too-new`, false positive) | **Approved** |
| `csv-parse` | npm | 2013-10-25 (12+ yrs, Phase 2 dependency, checked for consistency) | 12.72M | github.com/adaltas/node-csv | SUS (`too-new`, false positive) | Approved (Phase 2 use) |
| `react` / `react-dom` | npm | Meta-owned, established since 2013 | 146M / 138M | github.com/facebook/react | OK | Approved |
| `vite` / `@vitejs/plugin-react` | npm | Established Vite core project | 141M / 65.6M | github.com/vitejs/vite / vite-plugin-react | SUS (`too-new`, false positive) | **Approved** |
| `react-hook-form` | npm | Established, high-download form library | 54.9M | github.com/react-hook-form/react-hook-form | SUS (`too-new`, false positive) | **Approved** |
| `@tanstack/react-query` | npm | Established TanStack project | 58.5M | github.com/TanStack/query | SUS (`too-new`, false positive) | **Approved** |
| `vitest` | npm | Established Vite-native test runner | 68.9M | github.com/vitest-dev/vitest | SUS (`too-new`, false positive) | **Approved** |
| `drizzle-orm` / `drizzle-kit` | npm | Established | 11.3M / 9.4M | github.com/drizzle-team/drizzle-orm | OK | Approved |
| `zod` | npm | Established | 209.7M | github.com/colinhacks/zod | OK | Approved |
| `@sendgrid/mail` | npm | Established (Twilio-owned) | 4.12M | github.com/sendgrid/sendgrid-nodejs | OK | Approved |
| `pino` | npm | Established | 37.2M | github.com/pinojs/pino | OK | Approved |
| `@fastify/type-provider-zod` | npm | Fastify-org plugin | 6,664 (small but official org repo, no postinstall risk) | github.com/fastify/fastify-type-provider-zod | OK | Approved |
| `@fastify/cors` / `@fastify/helmet` | npm | Official Fastify org plugins | 4.32M / 1.49M | github.com/fastify/* | OK | Approved |
| `@hookform/resolvers` / `zustand` | npm | Established | 46.6M / 41.8M | github.com/react-hook-form/resolvers / pmndrs/zustand | OK | Approved |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]` by the raw gate:** better-auth, @aws-sdk/client-kms, nanoid, pg, fastify, @fastify/rate-limit, csv-parse, vite, @vitejs/plugin-react, react-hook-form, @tanstack/react-query, vitest — **all resolved to Approved** after registry-age verification confirmed each is a multi-year-old, high-download, canonically-sourced package. No `checkpoint:human-verify` is warranted for these; the `too-new` heuristic is measuring release cadence, not package legitimacy, for this batch. None of the checked packages declared a `postinstall` script.

*All package names above were discovered via WebSearch/training knowledge and are tagged `[ASSUMED]` for provenance purposes per protocol, but each name's existence and legitimacy was independently confirmed against the npm registry directly (`npm view`) — not merely assumed.*

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│ BROWSER (React 19 SPA)                                               │
│  Register/Login forms → workspace switcher → invite-accept page      │
│  → SendGrid-key connect form (masked display, status badge)          │
└───────────────┬────────────────────────────────────────────────────-┘
                 │ HTTPS, HttpOnly session cookie
                 ▼
┌────────────────────────────────────────────────────────────────────┐
│ FASTIFY API (apps/api)                                              │
│                                                                      │
│  ┌───────────────┐   ┌──────────────────┐   ┌────────────────────┐ │
│  │ better-auth    │   │ Tenant Context    │   │ Role/Permission    │ │
│  │ handler        │──▶│ Middleware        │──▶│ Guard (per-route)  │ │
│  │ (login/register│   │ (AsyncLocalStorage│   │ owner/admin/member │ │
│  │  /reset/verify)│   │  + resolve active │   │ via better-auth AC │ │
│  │                │   │  workspace_id)    │   │                    │ │
│  └───────────────┘   └─────────┬─────────┘   └──────────┬─────────┘ │
│                                 │                        │           │
│                                 ▼                        ▼           │
│                    ┌──────────────────────────────────────────┐    │
│                    │ Route handlers: workspaces, invites,       │    │
│                    │ members, sendgrid-key                      │    │
│                    └──────────────────┬─────────────────────────┘   │
│                                        │                              │
│              ┌─────────────────────────┼───────────────────────┐    │
│              ▼                         ▼                       ▼    │
│    ┌──────────────────┐    ┌──────────────────┐   ┌─────────────────┐│
│    │ KMS Client        │    │ SendGrid Validate │   │ Platform SendGrid││
│    │ (encrypt/decrypt  │    │ Client (GET       │   │ Client (system   ││
│    │  tenant DEK)      │    │ /v3/scopes, senders│  │ emails: verify,  ││
│    │                   │    │ /v3/verified_senders│ │ reset, invite)   ││
│    └────────┬──────────┘    └──────────────────┘   └─────────────────┘│
└─────────────┼─────────────────────────────────────────────────────────┘
              │ decrypted only transiently, never persisted in plaintext
              ▼
┌────────────────────────────────────────────────────────────────────┐
│ POSTGRES (RLS enabled on every tenant-scoped table)                  │
│  workspaces │ workspace_members │ invitations │ users │ sessions      │
│  workspace_sendgrid_keys (ciphertext + encrypted DEK only)            │
│                                                                        │
│  Every query runs inside a transaction that first executes:           │
│  SET LOCAL app.current_workspace_id = '<uuid>';                       │
└────────────────────────────────────────────────────────────────────┘
```

Trace the primary use case (a marketer connects SendGrid): browser submits the pasted key → tenant-context middleware resolves `workspace_id` from the session and sets it as request-scoped `AsyncLocalStorage` state → the sendgrid-key route handler calls the SendGrid Validate Client to check `mail.send` scope and list verified senders → on success, the KMS Client generates a per-tenant DEK, encrypts the key locally, wraps the DEK with the KMS-held KEK → both ciphertexts are written to Postgres inside a transaction that also `SET LOCAL`s the tenant GUC, so the RLS policy on `workspace_sendgrid_keys` allows the write only for that workspace.

### Recommended Project Structure

```
mega-crm/
├── apps/
│   ├── api/                      # Fastify 5 backend
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── auth/         # better-auth config + Fastify handler wiring
│   │   │   │   ├── tenancy/      # workspace CRUD, membership, invites, sendgrid-key
│   │   │   │   └── platform-mail/ # system emails (verification/reset/invite), separate SG key
│   │   │   ├── db/               # Drizzle schema, RLS policies, migrations
│   │   │   ├── middleware/       # tenant-context (AsyncLocalStorage), role guards
│   │   │   ├── kms/              # envelope-encryption client wrapper
│   │   │   └── server.ts
│   │   └── drizzle.config.ts
│   └── web/                       # React 19 + Vite SPA
│       └── src/
│           ├── routes/            # /register, /login, /w/:slug/..., /invite/:token
│           ├── features/
│           │   ├── auth/
│           │   ├── workspace-switcher/
│           │   ├── team/          # invite UI, member list, role assignment
│           │   └── sendgrid-key/  # connect form, masked display, status badge
│           └── lib/queryClient.ts
├── packages/
│   └── shared-schemas/            # Zod schemas shared by api + web (invite payload, key form, etc.)
└── package.json                   # npm workspaces root
```

### Pattern 1: better-auth `organization` plugin as the workspace/role/invite backbone

**What:** Configure better-auth's `organization` plugin with a Drizzle adapter; treat each "organization" as a workspace. Use the plugin's built-in `owner`/`admin`/`member` roles plus a custom `createAccessControl` statement to gate `sendgrid_key:update` and `campaign:launch`/`flow:publish` to `owner`/`admin` only (D-19).
**When to use:** For every membership, invite, and role-check operation in this phase — do not build a parallel hand-rolled table for any of these.
**Example:**
```typescript
// Source: https://better-auth.com/docs/plugins/organization (CITED)
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
    requireEmailVerification: false, // D-02: soft verification, gated per-action instead
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days (D-04)
    updateAge: 60 * 60 * 24,      // sliding: refresh once/day of activity
  },
  plugins: [
    organization({
      ac,
      roles: { owner, admin, member },
      sendInvitationEmail: async (data) => {
        // dispatch via platform SendGrid account (D-07), not tenant key
        await platformMail.sendInvite({
          to: data.email,
          inviteUrl: `${WEB_URL}/invite/${data.id}`,
          orgName: data.organization.name,
        });
      },
      invitationExpiresIn: 60 * 60 * 24 * 7, // 7 days (D-11)
    }),
  ],
});
```

### Pattern 2: Request-scoped tenant context with `SET LOCAL` + `AsyncLocalStorage`

**What:** Every authenticated request resolves the active workspace_id, stores it in `AsyncLocalStorage` (never a module-level variable), and every DB transaction opens with `SET LOCAL app.current_workspace_id`, which auto-resets when the transaction ends — safe under connection-pool reuse.
**When to use:** Every route/worker that touches a tenant-scoped table, without exception, from day one.
**Example:**
```typescript
// Source: synthesized from AWS RLS guidance (CITED: aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security)
// and Postgres/pg pooling practitioner sources (CITED)
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
    // SET LOCAL, NOT SET — scoped to this transaction only, auto-resets on COMMIT/ROLLBACK
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [ctx.workspaceId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release(); // pool.release() alone does NOT reset session state under pgBouncer transaction mode
  }
}
```

```sql
-- Source: Drizzle RLS docs (CITED: orm.drizzle.team/docs/rls)
CREATE POLICY workspace_isolation ON contacts
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
```

### Pattern 3: KMS envelope encryption for the tenant SendGrid key

**What:** Generate a per-tenant Data Encryption Key (DEK) via KMS `GenerateDataKey`, encrypt the SendGrid API key locally with the plaintext DEK, discard the plaintext DEK immediately, store only the ciphertext + KMS-encrypted DEK in Postgres. Decrypt only at the moment of use (validation or dispatch), never at rest in memory longer than the single operation.
**When to use:** The SendGrid key connect flow (D-21/D-22) and any future dispatch worker reading it.
**Example:**
```typescript
// Source: AWS KMS GenerateDataKey API docs (CITED: docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html)
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const kms = new KMSClient({ region: process.env.AWS_REGION });

export async function encryptTenantSendGridKey(workspaceId: string, plaintextKey: string) {
  const { Plaintext, CiphertextBlob } = await kms.send(
    new GenerateDataKeyCommand({
      KeyId: process.env.KMS_KEK_ID,
      KeySpec: "AES_256",
      EncryptionContext: { workspaceId }, // binds the DEK to this tenant
    })
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Plaintext!, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextKey, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  Plaintext!.fill(0); // zero the plaintext DEK from memory immediately after use

  return {
    encryptedDek: Buffer.from(CiphertextBlob!).toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}
```

### Anti-Patterns to Avoid

- **Hand-rolled memberships/invites table alongside better-auth's own user table:** creates two sources of truth for "who is this user" — use better-auth's organization plugin tables as-is (extend with `drizzle-kit` migrations if extra columns are needed, don't fork).
- **`SET` instead of `SET LOCAL` for tenant context:** persists for the life of the pooled connection/session, leaking into the next request that reuses it (PITFALLS.md #8) — always `SET LOCAL` inside a transaction.
- **Storing tenant context in a module-level variable:** leaks across concurrent requests sharing the same Node event loop — `AsyncLocalStorage` only.
- **pgcrypto-only encryption for the SendGrid key:** explicitly called out as insufficient in CLAUDE.md/STACK.md — KMS envelope encryption is mandatory, not optional, for this specific secret.
- **`requireEmailVerification: true` globally in better-auth:** conflicts with D-02 (soft verification) and D-12 (invited users join immediately without a separate verification gate) — verification must be enforced per-action (gate the SendGrid-key-connect route specifically), not globally at login.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| Password hashing, session tokens, cookie signing | Custom bcrypt + JWT/session implementation | better-auth's built-in email/password + session handling | Battle-tested, avoids reimplementing timing-safe comparison, session rotation, cookie flags correctly |
| Organization/membership/role/invite data model | Custom `workspaces` + `memberships` + `invitations` tables and hand-rolled RBAC checks | better-auth `organization` plugin + `createAccessControl` | D-13–D-19 already match the plugin's default shape; hand-rolling duplicates ~2 years of edge-case handling (invite expiry races, role transitions, revoke/resend) |
| Encryption key management for tenant secrets | Storing keys with `pgcrypto` alone, or a single static app-level encryption key | KMS envelope encryption (per-tenant DEK, KMS-held KEK) | A DB compromise alone should never be sufficient to decrypt every tenant's SendGrid key; KMS keeps the KEK outside the DB's trust boundary |
| Multi-tenant query filtering | Relying solely on `WHERE workspace_id = ?` in application code | Postgres RLS policies as defense-in-depth on top of app-level filtering | One missed `WHERE` clause anywhere in the codebase, forever, is a cross-tenant leak (PITFALLS.md #8) — RLS makes the leak impossible even when app code forgets |

**Key insight:** This phase's temptation is to treat "auth" and "workspace/roles/invites" as two separate build efforts. better-auth's organization plugin already unifies them; splitting the work back apart (e.g., building invites as a bespoke feature next to a library-managed auth system) reintroduces exactly the "two sources of truth" problem PITFALLS.md warns about for subscription status (#7) — same failure shape, different domain.

## Common Pitfalls

### Pitfall 1: Multi-tenant data isolation fails under connection pooling
**What goes wrong:** A pooled connection retains a previous request's `app.current_workspace_id` after a crashed/aborted transaction, and the next request on that connection silently reads/writes the wrong workspace's data.
**Why it happens:** RLS is developed and tested against clean, single-request dev flows where connection reuse edge cases don't surface — it's an infra-level failure mode, invisible to query-level code review.
**How to avoid:** `SET LOCAL` (never `SET`) inside the same transaction as every query; `AsyncLocalStorage` for context, never module-level; never grant the app DB role `BYPASSRLS`; treat "new table with `workspace_id` needs an RLS policy" as a CI-enforced checklist item.
**Warning signs:** A chaos test (kill a connection mid-transaction) occasionally returns another tenant's rows; any tenant-scoped table missing an RLS policy.

### Pitfall 2: `requireEmailVerificationOnInvitation`/global verification conflicts with the invite flow
**What goes wrong:** Turning on better-auth's global email-verification requirement blocks D-12 ("invited user registers directly from the invite and immediately joins the workspace") because the plugin's `requireEmailVerificationOnInvitation` option gates invite acceptance on a verified email that a brand-new invited user cannot yet have.
**Why it happens:** better-auth's default posture assumes verification-before-trust; this project's decision (D-02, D-12) is verification-before-*specific-critical-actions*, not verification-before-workspace-access.
**How to avoid:** Leave `requireEmailVerification`/`requireEmailVerificationOnInvitation` off; implement the "verified email required" gate as a route-level check specifically on the SendGrid-key-connect endpoint (and any future critical-action route), independent of better-auth's global flag.
**Warning signs:** An invited user who registers straight from the invite link gets stuck unable to access the workspace they were just invited to.

### Pitfall 3: KMS unavailable in local/dev environment blocks Wave 0 verification
**What goes wrong:** The walking-skeleton deliverable ("one real DB read/write") includes the SendGrid-key-connect flow, which requires a live KMS call — but this dev machine has no AWS CLI, no configured cloud credentials, and no local KMS emulator running.
**Why it happens:** Envelope encryption is correctly designed to depend on a real external KMS in production, but that same design has no offline story unless one is explicitly built.
**How to avoid:** Plan for a `KMS_PROVIDER=local|aws` toggle: a `local` dev provider that does envelope encryption with a static, env-provided KEK (clearly marked dev-only, never used past local dev), and the real AWS/GCP KMS client in staging/prod. Document this as an explicit environment-parity gap, not a silent difference.
**Warning signs:** Wave 0 can't be verified without AWS credentials; CI has no way to test the SendGrid-key-connect flow without live cloud access.

### Pitfall 4: Two-key confusion — platform SendGrid key vs. tenant SendGrid key
**What goes wrong:** A code path meant to send a system email (invite, verification, reset) accidentally uses a tenant's decrypted key (or vice versa), because both are "a SendGrid client" and the distinction lives only in which credential was passed in.
**Why it happens:** D-07 requires two structurally identical SendGrid integrations (platform account for system mail, tenant BYO key for their sends) built in the same phase — easy to blur under time pressure.
**How to avoid:** Two distinct, non-interchangeable client wrapper modules (`platform-mail/client.ts` reading from env/secrets manager, `tenancy/sendgrid-client.ts` reading from the decrypted-per-request tenant key) with different function signatures, so a type error — not a runtime mix-up — catches misuse.
**Warning signs:** A tenant's SendGrid account shows a verification or invite email that was supposed to come from the platform's noreply@ domain.

## Code Examples

### SendGrid key validation at connect time (D-21)
```typescript
// Source: SendGrid API key permissions docs (CITED: docs.sendgrid.com/api-reference/api-key-permissions/retrieve-a-list-of-scopes-for-which-this-user-has-access)
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

### Workspace slug generation with collision retry
```typescript
// Standard slugify + retry-on-conflict; not a "don't hand-roll" case — trivial and well-understood
import { nanoid } from "nanoid";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "") // strip diacritics
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

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| NextAuth/Auth.js for full-stack auth | better-auth for framework-agnostic (non-Next-locked) auth with first-class organization/RBAC plugin | better-auth's organization plugin matured through 2025–2026 into the de facto choice for multi-tenant SaaS auth outside the Next.js ecosystem | Removes the need to hand-build a workspace/membership/invite layer next to auth — a meaningful scope reduction for this phase |
| Session-in-Redis / JWT access+refresh pairs | better-auth's DB-backed cookie session with sliding `updateAge` refresh and optional `cookieCache` | Standard as of better-auth 1.x | Matches D-04 (server-side cookie sessions) directly; no Redis dependency needed for auth in this phase |

**Deprecated/outdated:** N/A — no deprecated approaches identified in scope for this phase's domain.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|----------------|
| A1 | React 19.2.x / Vite 8.1.x exact patch versions not re-verified this session (relied on STACK.md, which was verified 2026-07-03 in the prior research pass) | Standard Stack | Low — same-day research pass, versions unlikely to have drifted; re-run `npm view react version` at scaffold time to confirm |
| A2 | Cloud KMS provider (AWS vs GCP vs Vault) is not locked — CLAUDE.md leaves it open ("AWS KMS or GCP KMS / cloud-agnostic equivalent") | Standard Stack, Architecture Patterns, Environment Availability | Medium — the plan currently assumes AWS KMS (`@aws-sdk/client-kms`) for code examples; if the team picks GCP KMS instead, the encryption module's SDK calls change (interface can stay the same if the KMS client is behind an internal abstraction) |
| A3 | `requireEmailVerification`/`requireEmailVerificationOnInvitation` should both be OFF globally, with verification enforced per-critical-action instead | Architecture Patterns, Common Pitfalls #2 | Medium — this is a reasoned inference from D-02+D-12, not an explicit user decision; confirm during plan review that "soft verification, hard-gated only at SendGrid-key-connect" is the intended interpretation |
| A4 | Local/dev KMS fallback (`KMS_PROVIDER=local` with a static dev KEK) is an acceptable pattern for Wave 0 | Common Pitfalls #3, Environment Availability | Low-Medium — reasonable engineering pattern, but the exact mechanism (LocalStack vs static-key toggle) is not user-confirmed; either resolves the blocking gap, pick during planning |

**If this table is empty:** N/A — see rows above.

## Open Questions

1. **Which cloud KMS provider — AWS, GCP, or a self-hosted alternative (Vault Transit)?**
   - What we know: CLAUDE.md explicitly leaves this open ("AWS KMS or GCP KMS / cloud-agnostic equivalent"); code examples in this research use AWS KMS as the concrete illustration.
   - What's unclear: whether the team already has an AWS or GCP account provisioned, which affects Wave 0's real (non-local-fallback) verification path.
   - Recommendation: Default to AWS KMS for the plan (matches STACK.md's primary recommendation) but implement the KMS client behind a small internal interface (`encrypt(dek, plaintext)` / `decrypt(...)`) so swapping providers later is a single-module change, not a schema change.

2. **Local-dev KMS strategy — LocalStack vs. static dev KEK vs. requiring real cloud credentials for every dev?**
   - What we know: no AWS CLI or KMS reachable on this dev machine today; a walking-skeleton "one real DB read/write" deliverable that includes the SendGrid-key flow needs *something* to encrypt against locally.
   - What's unclear: whether the team wants every developer to need real AWS credentials (simplest but highest friction), or a LocalStack container (higher fidelity, more setup), or a `local` provider with a static, clearly-dev-only key (lowest friction, lowest fidelity).
   - Recommendation: static dev-only KEK behind the same `KMS_PROVIDER` toggle described in Pitfall 3, gated by `NODE_ENV !== 'production'`, with a startup assertion that refuses to boot with `KMS_PROVIDER=local` if `NODE_ENV=production`.

3. **Exact custom `createAccessControl` resource/action names for better-auth's org plugin.**
   - What we know: D-19 requires gating "launch campaigns/flows" and "change SendGrid key" to Owner/Admin; D-17 requires Member to fully create/edit drafts of campaigns/flows but not publish/launch.
   - What's unclear: campaigns/flows don't exist as tables until Phase 4/6 — this phase only needs to define the *shape* of the permission statement (e.g., `sendgridKey: ["update"]`, `campaign: ["launch"]`, `flow: ["publish"]`) so later phases' route guards can reference stable action names.
   - Recommendation: define the full statement (including future `campaign`/`flow` actions) now, even though only `sendgridKey` is enforced by a real route in this phase — avoids an access-control schema migration later.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|--------------|-----------|---------|----------|
| Node.js | API/build runtime | ✓ | v26.0.0 (newer than STACK.md's targeted 22.x LTS) | None needed — v26 is forward-compatible; pin `engines` to `>=22` in package.json for CI/prod parity, don't require exactly v26 locally |
| npm | Package manager / workspaces | ✓ | 11.12.1 | — |
| PostgreSQL | Primary datastore, RLS | ✓ | 17.10 (Homebrew, locally running) | — |
| Redis | Not required by this phase (BullMQ starts Phase 4) | ✗ | — | No fallback needed — this phase has no queue/worker component |
| Docker | Optional local-infra orchestration (e.g., LocalStack for KMS) | ✗ | — | Install if the LocalStack-based local-KMS option (Open Question 2) is chosen; otherwise not required |
| AWS CLI / credentials | Live AWS KMS calls in dev/staging/prod | ✗ | — | Use the local-dev KMS fallback (Pitfall 3, Open Question 2) for local dev; real credentials required for any environment that exercises the real KMS path |

**Missing dependencies with no fallback:**
- None — every missing dependency above has a documented fallback or is genuinely out of scope for this phase.

**Missing dependencies with fallback:**
- Docker (only needed if LocalStack is chosen for local KMS emulation — otherwise skip)
- AWS CLI/credentials (local-dev KMS provider substitutes for local development; real credentials needed once staging/prod environments are stood up)

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (locked in STACK.md, not yet installed — greenfield repo) |
| Config file | none — see Wave 0 |
| Quick run command | `npm run test -- --run <file>` (per-package, once scaffolded) |
| Full suite command | `npm run test` (root, via npm workspaces) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|---------------------|--------------|
| TENANT-01 | New user registers, creates workspace, becomes Owner | integration | `vitest run apps/api/src/modules/tenancy/__tests__/workspace-creation.test.ts` | ❌ Wave 0 |
| TENANT-02 | Owner/Admin invites colleague by email, colleague joins with assigned role | integration | `vitest run apps/api/src/modules/tenancy/__tests__/invite-flow.test.ts` | ❌ Wave 0 |
| TENANT-03 | Member blocked from SendGrid-key change and campaign/flow launch; Owner/Admin allowed | unit + integration | `vitest run apps/api/src/modules/tenancy/__tests__/role-guard.test.ts` | ❌ Wave 0 |
| TENANT-04 | SendGrid key validated on connect (accept valid, reject invalid with clear error), stored encrypted | integration | `vitest run apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts` (mocks SendGrid API) | ❌ Wave 0 |
| TENANT-05 | Cross-tenant data isolation, including under a killed/reused pooled connection | integration (chaos) | `vitest run apps/api/src/db/__tests__/rls-pooling-chaos.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** targeted `vitest run <changed test file>`
- **Per wave merge:** `npm run test` (full suite)
- **Phase gate:** Full suite green, plus a manual/semi-automated pooled-connection chaos test for TENANT-05, before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] Root `package.json` with npm workspaces (`apps/*`, `packages/*`) — nothing exists yet
- [ ] `apps/api` Fastify scaffold + `vitest.config.ts`
- [ ] `apps/web` Vite/React scaffold
- [ ] `packages/db` Drizzle schema + RLS policy migrations, `drizzle.config.ts`
- [ ] Test DB setup/teardown fixture (a real Postgres test database, RLS-enabled, migrated) — required for TENANT-05's chaos test and any RLS-dependent integration test
- [ ] SendGrid API mock/fixture (nock or msw) for TENANT-04 tests, so CI doesn't depend on a live SendGrid account
- [ ] Framework install: `npm install -D vitest` at repo root plus per-workspace test scripts

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|---------------------|
| V2 Authentication | yes | better-auth email/password with configured min password length, rate-limited login (`@fastify/rate-limit`) |
| V3 Session Management | yes | better-auth HttpOnly, `SameSite`-scoped cookie session with sliding expiration (D-04); no session data in localStorage/JS-readable storage |
| V4 Access Control | yes | better-auth `organization` plugin RBAC (`createAccessControl`) enforced server-side on every mutating route; Postgres RLS as defense-in-depth |
| V5 Input Validation | yes | Zod schemas on every Fastify route via `@fastify/type-provider-zod`, shared with frontend forms via `packages/shared-schemas` |
| V6 Cryptography | yes | KMS envelope encryption (never hand-rolled) for the tenant SendGrid key; better-auth's built-in password hashing (do not implement custom hashing) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|------------------------|
| Cross-tenant data leak via pooled-connection RLS-context bleed | Information Disclosure / Tampering | `SET LOCAL` + `AsyncLocalStorage` (Pattern 2); RLS policy on every tenant-scoped table; CI check for tables missing a policy |
| Session cookie theft / fixation | Spoofing | HttpOnly + Secure + `SameSite` cookie flags (better-auth default); session rotation on privilege change (role update, password reset) |
| Broken access control — Member bypassing role guard to change SendGrid key or launch a campaign | Elevation of Privilege | Server-side `createAccessControl` check on the route handler itself, never client-side-only gating; RLS does not substitute for this (RLS scopes by workspace, not by role) |
| Plaintext tenant secret exposure (SendGrid key) via DB breach or log leakage | Information Disclosure | KMS envelope encryption at rest; explicit Pino redaction rules for any field named `sendgridKey`/`apiKey`; never `console.log` a decrypted key |
| Invite-token brute force / enumeration | Spoofing | Cryptographically random invite tokens (via better-auth, not a sequential ID); `@fastify/rate-limit` on the accept-invite route; 7-day expiry (D-11) bounds the exposure window |
| CSRF on cookie-based session mutations | Tampering | better-auth's origin/CSRF handling for cookie-auth flows (`trustedOrigins` config) + `SameSite=Lax/Strict` cookie default — verify this is configured, not assumed, during implementation |

## Sources

### Primary (HIGH confidence)
- npm registry (`npm view <pkg> version time.modified time --json`) — direct package metadata, verified 2026-07-03 for: fastify, @fastify/type-provider-zod, zod, better-auth, drizzle-orm, drizzle-kit, pg, @aws-sdk/client-kms, nanoid, @sendgrid/mail, pino, pino-http, csv-parse, @fastify/multipart, @fastify/cors, @fastify/helmet, @fastify/rate-limit, react, react-dom, vite, @vitejs/plugin-react, react-hook-form, @hookform/resolvers, @tanstack/react-query, zustand, vitest
- [Better Auth: Fastify integration](https://better-auth.com/docs/integrations/fastify) — CITED
- [Better Auth: Organization plugin](https://better-auth.com/docs/plugins/organization) — CITED
- [Better Auth: Session management](https://better-auth.com/docs/concepts/session-management) — CITED
- [Better Auth: Drizzle ORM Adapter](https://better-auth.com/docs/adapters/drizzle) — CITED
- [AWS: GenerateDataKey API reference](https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html) — CITED
- [SendGrid: Retrieve a list of scopes for which this user has access](https://docs.sendgrid.com/api-reference/api-key-permissions/retrieve-a-list-of-scopes-for-which-this-user-has-access) — CITED
- [SendGrid: List all authenticated domains](https://docs.sendgrid.com/api-reference/domain-authentication/list-all-authenticated-domains) — CITED
- [Drizzle ORM: Row-Level Security (RLS) docs](https://orm.drizzle.team/docs/rls) — CITED
- [AWS: Multi-tenant data isolation with PostgreSQL Row Level Security](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/) — CITED (also project ARCHITECTURE.md/STACK.md source)
- [PgBouncer official config/FAQ docs](https://www.pgbouncer.org/config.html), [PgBouncer FAQ](https://www.pgbouncer.org/faq.html) — CITED

### Secondary (MEDIUM confidence)
- Project's own prior research: `.planning/research/SUMMARY.md`, `STACK.md`, `ARCHITECTURE.md`, `PITFALLS.md` (2026-07-03) — treated as authoritative project-level context, re-confirmed against fresh registry checks in this session
- [Better Auth Discussion #3317: Multi-Tenant SaaS Setup with Roles, Subdomains & Teams](https://github.com/better-auth/better-auth/discussions/3317) — community discussion, cross-referenced against official docs
- WebSearch-aggregated practitioner write-ups on Postgres RLS + `SET LOCAL` + pg pool patterns (ricofritzsche.me, oneuptime.com, dev.to) — MEDIUM confidence, converged on the same `SET LOCAL`-inside-transaction pattern as the AWS/Drizzle official sources, cross-checked

### Tertiary (LOW confidence)
- Slug-generation best-practice write-ups (Medium/dev.to articles on unique URL slugs) — general pattern guidance, low domain specificity, but the underlying technique (slugify + collision retry) is standard and low-risk regardless of source quality

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every version claim directly verified against npm registry this session; matches already-locked project STACK.md with no drift
- Architecture: MEDIUM-HIGH — RLS/pooling pattern is CITED against official AWS/Drizzle/PgBouncer docs and cross-checked across multiple independent practitioner sources; better-auth-organization-plugin-as-workspace-backbone is a novel-to-this-project synthesis (not previously in STACK.md/ARCHITECTURE.md) but grounded directly in official better-auth docs
- Pitfalls: MEDIUM — connection-pooling pitfall is HIGH (matches PITFALLS.md #5/#8 exactly, multi-source corroborated); the better-auth-specific pitfalls (verification-flag conflict, KMS-local-dev gap) are this session's own analysis of how the chosen library interacts with locked decisions, not yet battle-tested against a real better-auth deployment for this project

**Research date:** 2026-07-03
**Valid until:** 2026-08-02 (30 days — stable domain, but better-auth ships frequently; re-verify version/API surface if planning is delayed past this window)

---
*Phase: 1-Workspace Foundation & Team Access*
*Research completed: 2026-07-03*
