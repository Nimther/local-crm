# Walking Skeleton — Mega CRM (B2C Marketing Automation Platform)

**Phase:** 1
**Generated:** 2026-07-03

## Capability Proven End-to-End

> One sentence: the smallest user-visible capability that exercises the full stack.

A new user can register with email/password, create a workspace (becoming its Owner), and land on that workspace's home at `/w/{slug}` — where the workspace row, the Owner membership, and a tenant-isolated `workspace_sendgrid_keys` probe are all served by the deployed Fastify API over Postgres with Row-Level Security enforced per request.

The skeleton is delivered by **two plans together**: `01-01` (scaffold + backend + DB + RLS + migration, proven end-to-end via HTTP integration test) and `01-02` (the React UI wired to that API). Everything in Phase 1 (plans `01-03`..`01-05`) is a vertical slice layered on top of this skeleton without changing its architectural decisions.

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Repo layout | npm-workspaces monorepo: `apps/api`, `apps/web`, `packages/db`, `packages/shared-schemas` | RESEARCH.md "Recommended Project Structure"; one language everywhere, shared Zod schemas between API and UI |
| API framework | Fastify 5.9.x + `@fastify/type-provider-zod` | Locked in CLAUDE.md/STACK.md; schema-first validation on every auth/tenancy route |
| Auth + workspaces/roles/invites | better-auth 1.6.x with the `organization` plugin (Drizzle adapter) | Native cookie sessions, email verification, password reset, and an organization/membership/invite/Owner-Admin-Member model that maps directly onto D-13..D-19 — a major scope reduction over hand-rolling (RESEARCH.md Pattern 1) |
| Data layer | PostgreSQL 17 + Drizzle ORM 0.45.x, SQL-first migrations (`drizzle-kit generate` + `migrate`) | Locked; CLAUDE.md mandates committed SQL migrations, not runtime `push`; RLS policies live in hand-authored SQL migrations |
| Tenant isolation | Postgres Row-Level Security + `SET LOCAL app.current_workspace_id` inside every tenant transaction, request-scoped via `AsyncLocalStorage` | RESEARCH.md Pattern 2 / Pitfall 1; last line of defense against a missed `WHERE` clause; must survive pooled-connection reuse (TENANT-05, chaos-tested) |
| Session model | better-auth DB-backed HttpOnly cookie, 30-day sliding (`expiresIn` 30d, `updateAge` 1d) | D-04; no Redis needed for auth in this phase |
| Secret encryption | KMS envelope encryption (per-tenant DEK, KMS-held KEK) with a `KMS_PROVIDER=local\|aws` toggle; local dev uses a static dev-only KEK that refuses to boot under `NODE_ENV=production` | D-21/D-22, CLAUDE.md (pgcrypto-only forbidden); RESEARCH.md Pattern 3 / Pitfall 3 — enables Wave-0 verification without cloud credentials |
| System email | Separate platform SendGrid account/key + in-repo HTML templates, from `noreply@` platform domain | D-07/D-08/D-09; structurally distinct from tenant BYO keys (RESEARCH.md Pitfall 4) |
| Frontend | React 19 + Vite + shadcn (`new-york` / `neutral`), TanStack Query (server state), Zustand (UI state), React Hook Form + Zod | Locked; dashboard SPA behind auth, no metaframework |
| Directory layout | Feature-folders: `apps/api/src/modules/{auth,tenancy,platform-mail}`, `apps/web/src/features/*` | RESEARCH.md project structure |

## Stack Touched in Phase 1

- [x] Project scaffold (npm workspaces, Fastify, Vite/React, Drizzle, Vitest, Playwright, ESLint) — 01-01 + 01-02
- [x] Routing — Fastify better-auth handler + `/api/workspaces`; React Router `/register`, `/login`, `/w/:slug` — 01-01 + 01-02
- [x] Database — real write (workspace + Owner membership on registration→create-workspace) AND real read (RLS-scoped workspace home + `workspace_sendgrid_keys` probe) — 01-01
- [x] UI — register/create-workspace forms wired to the API, workspace home renders live server data — 01-02
- [x] Deployment — documented local full-stack run: `docker compose up db` (or local Postgres 17) + `npm run dev` at root runs API + web concurrently — 01-01

## Out of Scope (Deferred to Later Slices)

> Explicit list so later phases do not re-litigate Phase 1's minimalism.

- 2FA / TOTP, OAuth / SSO (D-06 — v2)
- Email change with confirmation, avatars (D-24 — v2)
- Workspace creation limits / billing (D-15 — v2)
- Contacts, events, segments, campaigns, flows, analytics (Phases 2–7)
- Redis / BullMQ send queue (starts Phase 4)
- Production cloud KMS provisioning (dev uses the local KEK provider; prod AWS/GCP KMS wired when staging stands up)
- RLS on better-auth's own auth/org tables — better-auth queries these outside our tenant transaction; Phase-1 RLS is enforced on `workspace_sendgrid_keys` (and every future domain table), and better-auth's session-bound active-organization scoping guards its own tables

## Subsequent Slice Plan

Each later plan/phase adds one vertical slice on top of this skeleton without altering its architectural decisions:

- **01-03:** Platform system email + password reset + soft email verification + profile (display name / change password)
- **01-04:** Team invites by email + membership/role management UI + delete workspace
- **01-05:** SendGrid key connect — validate on connect + KMS envelope encryption + masked status UI + role/verify gates + onboarding checklist finalize
- **Phase 2:** Contacts & event ingestion (first domain tables to inherit the RLS + tenant-context pattern established here)
- **Phase 3:** Segmentation engine
- **Phase 4:** Broadcast campaigns & send pipeline (introduces Redis/BullMQ)
- **Phase 5:** Webhook processing & delivery tracking
- **Phase 6:** Flows (triggered chains)
- **Phase 7:** Analytics, dashboard & send log
