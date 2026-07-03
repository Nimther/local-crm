# Technology Stack

**Project:** Mega CRM — multi-tenant B2C email marketing automation SaaS
**Researched:** 2026-07-03
**Confidence:** MEDIUM (npm registry versions verified directly = HIGH; ecosystem/pattern claims via unauthenticated web search = LOW-MEDIUM, cross-checked against multiple independent sources where noted)

## Recommended Stack

### Core Framework

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **Fastify** | 5.9.x | HTTP API server | Fastest mainstream Node framework with schema-first validation (JSON Schema/Zod) built into the request lifecycle — exactly what a multi-tenant API with lots of input validation (contact CRUD, event ingestion, webhook payloads) needs. Lighter than NestJS (no DI/decorator ceremony for a small-to-mid team), far more structured than raw Express 5. Plugin architecture (`fastify-plugin`) maps cleanly onto per-domain modules (auth, contacts, flows, campaigns, webhooks). |
| **TypeScript** | 6.0.x | Language | Already a hard constraint. TS 6 (Corsa-based faster compiler) is current; no reason to pin lower. |
| **Node.js** | 22.x LTS | Runtime | Current Active LTS at time of research; required for modern `fetch`, native test runner, and best BullMQ/Drizzle compatibility. |
| **Zod** | 4.4.x | Runtime validation & type inference | Single schema definition shared between Fastify route validation (via `@fastify/type-provider-zod` 1.0.x), background job payloads, and frontend forms. Zod 4 has meaningfully faster parsing than v3 — matters at event-ingestion volume. |

**Confidence:** HIGH on framework choice rationale and cross-checked scaling reasoning (multiple independent sources agree Fastify > Express for schema-validated APIs, NestJS is heavier); MEDIUM on "Fastify over NestJS" being the *only* right answer — NestJS is a legitimate alternative for larger teams (see Alternatives).

### Database & ORM

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **PostgreSQL** | 16 or 17 | Primary datastore | Already a hard constraint. Use native **declarative partitioning** on the `events` table (by month, on `created_at`) from day one — this is the single highest-leverage decision for the 100k-1M contacts / hundreds-of-thousands-emails-per-day target, since events and email-send-log rows are the fastest-growing, time-ordered tables. |
| **Drizzle ORM** | 0.45.x | Query builder / ORM | SQL-first API maps directly to Postgres features you will need immediately: Row-Level Security policies, partial indexes, `JSONB` operators for freeform event properties, and raw SQL escape hatches for segmentation queries. ~7kb runtime footprint and ~45ms cold start vs Prisma's ~180kb/~320ms matters for worker processes that scale horizontally. Drizzle integrates naturally with Postgres RLS (see Multi-Tenancy below) because it doesn't abstract away the session/transaction layer the way Prisma's query engine historically has. |
| **drizzle-kit** | 0.31.x | Migrations | Companion CLI for schema migrations; use SQL-first migrations checked into git, not runtime schema sync. |
| **node-postgres (`pg`)** | 8.22.x | Postgres driver | Drizzle's Postgres driver of choice; pool it explicitly (see below) rather than letting Drizzle manage pooling implicitly, since you need one pooled client per request with `SET LOCAL app.tenant_id` for RLS (see Multi-Tenancy section). |
| **PgBouncer** (or RDS Proxy equivalent) | — | Connection pooling | At hundreds of thousands of sends/day plus event ingestion plus queue workers, direct Postgres connections will exhaust `max_connections` fast. Put PgBouncer (transaction-mode pooling) in front of Postgres before you need it, not after an incident. |

**Confidence:** MEDIUM. Drizzle vs Prisma is a live, actively-argued debate in 2025/2026 sources (one migration-report source found a team reverted Drizzle→Prisma at 80+ tables due to verbosity) — noted explicitly in Alternatives below. The RLS-native argument and cold-start numbers are the deciding factor for *this* project given the multi-tenant isolation requirement.

### Queue & Send Pipeline

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **BullMQ** | 5.79.x | Job queue (Redis-backed) | The de facto standard Node.js job queue (~14M+ monthly downloads), with delayed jobs, retries/backoff, priorities, and repeatable jobs — all things a flow engine (wait steps, quiet hours, scheduled broadcasts) needs natively. |
| **Redis** | 7.x (or Valkey 8.x) | Queue backend + cache | Already a hard constraint. Use a dedicated Redis instance (or logical DB) for BullMQ, separate from any general-purpose caching, so queue backpressure doesn't compete with cache eviction. |
| **ioredis** | 5.11.x | Redis client | BullMQ's underlying client; also reuse for the per-tenant rate limiter (see below) and for `SET LOCAL` session-scoped caching if needed. |
| **rate-limiter-flexible** | 11.2.x | Per-tenant RPS throttling | **Critical architectural point, verified against BullMQ's own docs:** BullMQ removed group-key rate limiting from the open-source package as of v3 (it now lives only in paid BullMQ Pro). BullMQ's built-in `limiter` option is *global per worker*, not per tenant/per-SendGrid-key. Since each tenant has its own SendGrid API key and therefore its own rate ceiling, throttling must happen at the application layer: a Redis-backed token bucket (`rate-limiter-flexible`, keyed by `tenant_id`) gates the actual `mail/send` call inside the BullMQ worker/processor, independent of BullMQ's own limiter. This avoids paying for BullMQ Pro while still getting correct per-tenant RPS control. |
| **@bull-board/api** + **@bull-board/fastify** | 8.1.x | Queue observability UI | Operational visibility into queue depth/failures — needed at this send volume to debug stuck sends without querying Redis by hand. |

**Queue topology (opinionated recommendation):**
- Two logically separate BullMQ queues: `email:triggered` and `email:broadcast`, each with its own `Worker` and its own concurrency setting. This — not BullMQ job `priority` alone — is what actually prevents broadcast sends from starving triggered sends: priority values only resolve contention *within* a single queue's worker pool, so a flooded broadcast queue can still monopolize a worker if triggered and broadcast jobs share one queue. Give `email:triggered` a higher worker concurrency allocation (e.g., always-on workers) and let `email:broadcast` workers back off automatically when triggered volume spikes (poll queue depth, or run broadcast workers in a smaller fixed pool).
- Both queues' *processors* pull from the same per-tenant `rate-limiter-flexible` token bucket before calling SendGrid, so the tenant-level RPS ceiling is enforced regardless of which queue the job came from.
- Do not build a queue-per-tenant topology (some SaaS guides suggest this) — it does not scale cleanly past a few hundred tenants on BullMQ/Redis (queue/key sprawl, harder global observability) and buys nothing here since the rate limiter, not the queue, is what's tenant-scoped.

**Confidence:** HIGH on "BullMQ group-rate-limiting removed from OSS in v3" (verified against BullMQ's own docs pages, cross-checked across 3 independent sources). MEDIUM on the specific two-queue topology recommendation — this is a synthesized pattern from general "separate queues by priority class" guidance, not a documented BullMQ recipe for this exact SendGrid-BYO-key scenario; validate under load during phase implementation.

### Frontend

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **React** | 19.2.x | UI library | Hard constraint. React 19 is current; no legacy-mode concerns for a greenfield app. |
| **Vite** | 8.1.x (or 6.x if avoiding a bleeding-edge major) | Build tool / dev server | Standard 2026 React tooling; replaced CRA entirely. Use `vite` + `@vitejs/plugin-react`, not a metaframework (Next.js) — this is a dashboard SPA behind auth, not a public site needing SSR/SEO, so a metaframework adds deployment complexity without benefit. |
| **@xyflow/react** | 12.11.x | Canvas flow builder | **Not** the `reactflow` package — see What NOT to Use. This is the actively maintained continuation of React Flow, purpose-built for exactly this use case (node/edge based flow editors), and is the library the project's own PROJECT.md context calls out as the reason TS/React was chosen. |
| **TanStack Query** | 5.101.x | Server state (API data fetching/caching) | Standard 2026 pairing for SaaS dashboards: handles all server-derived state (contacts, segments, flow definitions, campaign metrics) with caching/invalidation/optimistic updates, eliminating the need for a global store for anything that originates from the API. |
| **Zustand** | latest | Client/UI state | For canvas editor state (selected node, unsaved-changes flag, panel open/closed) that is *not* server data. Avoid Redux/Redux Toolkit — unnecessary boilerplate for this app's actual state shape; the flow canvas's own internal state is already managed by `@xyflow/react`. |
| **React Hook Form** + **Zod** resolver | latest | Forms | Contact CRUD forms, CSV column-mapping UI, campaign/segment builders — pairs with the same Zod schemas used on the backend for consistent validation messages. |
| **TanStack Table** | latest | Data grids | Per-email send log with filters, contact lists — needs a headless, virtualizable table for the row counts implied by hundreds of thousands of sends/day. |
| **Recharts** or **Tremor** | latest | Dashboard charts | Campaign/flow metrics visualization (sent/delivered/opened/clicked/bounced). Tremor if you want pre-built dashboard components faster; Recharts for more control. |

**Confidence:** HIGH on React/Vite/TanStack Query/Zustand pairing (strong, consistent multi-source agreement). HIGH on `@xyflow/react` vs `reactflow` (directly verified via npm registry metadata, not just web search — see below).

### Infrastructure & Cross-Cutting

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **AWS KMS** (or GCP KMS / cloud-agnostic equivalent) | — | Root key for envelope encryption | Per-tenant SendGrid API keys are the platform's highest-value secret (control tenant's entire email-sending reputation). Standard pattern: encrypt each tenant's SendGrid key with a per-tenant Data Encryption Key (DEK), encrypt the DEK with a KMS-held Key Encryption Key (KEK), store only the encrypted DEK + ciphertext in Postgres. Avoids the DB compromise surface fully exposing the master key the way a `pgcrypto`-only scheme would. |
| **@fastify/cors, @fastify/jwt, @fastify/rate-limit, @fastify/multipart, @fastify/helmet** | 11.x / 10.x / 11.x / 10.x / 13.x | Fastify plugin ecosystem | Cover CORS, session/JWT auth, API-level rate limiting (protects the event-ingestion endpoint from abuse), CSV upload (multipart), and standard security headers respectively. |
| **csv-parse** | 7.0.x | CSV import | Streaming CSV parser for the contacts CSV-import-with-column-mapping requirement — streams instead of loading the whole file in memory, important once tenants upload 100k+ row files. |
| **Pino** (`pino`, `pino-http`) | 10.3.x / 11.0.x | Structured logging | Fastify's native logger is Pino; keep it, don't swap in Winston — avoids double logging overhead in the framework that already ships with it. |
| **Vitest** | 4.1.x | Test runner | Vite-native, fast, shares config with the frontend build; use for both frontend and backend unit tests. |
| **Playwright** | 1.61.x | E2E testing | For canvas editor interactions and multi-step flows (drag-and-drop is notoriously hard to test — Playwright's mouse-event-level API handles it better than Testing Library's DOM-only approach). |

## Installation

```bash
# Backend core
npm install fastify @fastify/type-provider-zod zod fastify-plugin
npm install @fastify/cors @fastify/jwt @fastify/rate-limit @fastify/multipart @fastify/helmet
npm install drizzle-orm pg
npm install bullmq ioredis rate-limiter-flexible @bull-board/api @bull-board/fastify
npm install @sendgrid/mail
npm install csv-parse pino pino-http

# Frontend core
npm install react react-dom
npm install @xyflow/react
npm install @tanstack/react-query @tanstack/react-table zustand
npm install react-hook-form @hookform/resolvers zod
npm install recharts   # or: npm install @tremor/react

# Dev dependencies
npm install -D typescript vite @vitejs/plugin-react vitest playwright
npm install -D drizzle-kit
npm install -D @types/pg
```

## Alternatives Considered

| Category | Recommended | Alternative | Why Not (or when it's actually right) |
|----------|-------------|-------------|-----------------------------------------|
| Backend framework | Fastify | NestJS | Legitimate choice if the team is 3+ backend engineers and expects 50+ endpoints — NestJS's enforced DI/module structure pays for itself at that scale. For a leaner initial team, Fastify's lighter ceremony ships faster; you can still layer your own module boundaries manually. |
| Backend framework | Fastify | Hono | Hono wins on edge/serverless deployment (Cloudflare Workers, Bun) and bundle size, but this project needs long-lived BullMQ workers and pooled Postgres connections — a traditional Node process, not an edge runtime. No reason to take on Hono's smaller plugin ecosystem here. |
| ORM | Drizzle | Prisma | Prisma is the safer default if the team is less comfortable writing raw-ish SQL, or if the schema is expected to balloon past ~80 tables with deep relational joins — one migration report found a team reverted from Drizzle to Prisma at that scale due to verbosity. If your team leans toward Prisma's DX and is willing to hand-write raw SQL for RLS session variables (`$queryRaw`), it remains a fully valid choice. |
| Queue | BullMQ (OSS) + app-level rate limiter | BullMQ Pro | BullMQ Pro's native per-group rate limiting/concurrency is a cleaner, CPU-efficient implementation of exactly the per-tenant throttling this project needs — worth paying for once the app-level `rate-limiter-flexible` approach shows operational friction (e.g., token-bucket contention under very high tenant counts). Revisit at scale, not upfront. |
| Queue | BullMQ | pg-boss | Consider only if you want to avoid running Redis at all (Postgres-only ops surface). Caps around 100-200 jobs/sec on typical hardware due to `SKIP LOCKED` lock contention — below this project's target throughput (hundreds of thousands of emails/day ≈ several jobs/sec sustained, but with bursty broadcast spikes that could exceed pg-boss's ceiling). Not recommended given Redis is already a hard constraint anyway. |
| Frontend state | TanStack Query + Zustand | Redux Toolkit | Reasonable if the canvas editor's undo/redo and multi-step wizard state grows complex enough to want time-travel debugging and a single reducer graph. Not needed at MVP scope. |
| Canvas library | @xyflow/react | react-dnd + custom canvas | Building a node-based editor from a generic drag-and-drop primitive is a multi-month undertaking (edge routing, minimap, zoom/pan, node registry) that @xyflow/react already solves; only justified if you need behavior fundamentally incompatible with its node/edge model. |
| Secrets storage | KMS envelope encryption | pgcrypto column encryption alone | Simpler to implement (no KMS integration), but keeps the encryption key reachable within the same trust boundary (the database) that a breach is trying to protect — acceptable only for lower-sensitivity data, not for tenant SendGrid keys that control email-sending reputation. |
| Multi-tenancy | Shared schema + tenant_id + RLS | Schema-per-tenant | Schema-per-tenant gives stronger logical isolation but does not scale past a few hundred tenants (Postgres catalog bloat, migration fan-out across N schemas) — wrong choice for a SaaS aiming at many tenants. |
| Multi-tenancy | Shared schema + tenant_id + RLS | Database-per-tenant | Only justified for enterprise/high-compliance tenants requiring hard physical isolation (e.g., contractual data-residency terms) — adds significant ops overhead (connection management, migration orchestration across N databases) not warranted for this product's target segment (SMB/mid-market e-commerce). |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **`reactflow` (the npm package, not the project)** | Confirmed via npm registry metadata: last published June 2024, superseded by a rebrand. The library continues development exclusively under the `@xyflow/react` package name (last published June 2026, actively maintained). Installing `reactflow` today gets you a 2-year-stale dependency. | `@xyflow/react` |
| **Express (v4 or v5) as the primary API framework** | No built-in schema validation; every route needs manual validation wiring. At this project's scale (event ingestion, webhook parsing, multi-tenant auth on every request) that's meaningfully more boilerplate and more room for validation gaps than Fastify's schema-first request lifecycle. | Fastify + `@fastify/type-provider-zod` |
| **Relying on BullMQ's built-in `limiter` option for per-tenant throttling** | It is a global-per-worker limiter, not tenant-scoped (group-key rate limiting was removed from OSS in BullMQ v3+). Using it alone means one tenant's SendGrid key rate limit either throttles everyone or protects no one correctly. | `rate-limiter-flexible` token bucket keyed by `tenant_id`, invoked inside the job processor before the SendGrid call |
| **pgcrypto as the sole protection for tenant SendGrid API keys** | Encryption key and ciphertext live in the same trust boundary (Postgres) — a DB-level compromise defeats the protection entirely. | KMS-backed envelope encryption (DEK per tenant, KEK in KMS) |
| **Application-only tenant filtering (`WHERE tenant_id = ?`) without RLS** | Depends on every engineer remembering the filter on every query, forever — one missed `WHERE` clause is a cross-tenant data leak. Multiple independent sources converge on RLS as the standard mitigation for shared-schema multi-tenancy. | Postgres Row-Level Security policies + `SET LOCAL app.tenant_id` per transaction, as defense-in-depth on top of (not instead of) application-level filtering |
| **Parsing the SendGrid webhook body with a JSON body-parser before signature verification** | Changes the raw bytes the ECDSA signature was computed over; this is the single most common SendGrid webhook integration bug reported across GitHub issues and integration guides. | Capture/verify the raw request body (exclude the webhook route from the global JSON body-parser) before parsing |
| **Schema-per-tenant Postgres pattern** | Does not scale past a few hundred tenants (catalog/index bloat, migration fan-out); wrong fit for a SaaS that wants many tenants. | Shared schema + `tenant_id` + RLS |

## Stack Patterns by Variant

**If the team grows past ~4-5 backend engineers and the API surface exceeds ~50 endpoints:**
- Reconsider NestJS over Fastify for its enforced module/DI structure.
- Because at that team size, the lack of imposed architecture in Fastify becomes a coordination cost rather than a velocity win.

**If BullMQ's application-level per-tenant rate limiter shows contention or correctness issues under real load:**
- Migrate to BullMQ Pro's native group rate limiting/concurrency.
- Because it is a purpose-built, CPU-efficient solution to exactly this problem, at the cost of a paid license.

**If a subset of enterprise tenants demand contractual data-residency/hard isolation:**
- Consider database-per-tenant (or at minimum schema-per-tenant) for *that specific tier only*, keeping shared-schema+RLS as the default for the rest.
- Because hard isolation has real operational cost that shouldn't be paid by every tenant.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `drizzle-orm@0.45.x` | `pg@8.22.x`, `drizzle-kit@0.31.x` | Keep `drizzle-kit` and `drizzle-orm` minor versions in lockstep; Drizzle ships breaking changes between minors more often than semver-strict libraries. |
| `fastify@5.9.x` | `@fastify/type-provider-zod@1.0.x`, `zod@4.4.x` | Fastify v5 plugin ecosystem requires v5-compatible plugin majors (all versions listed in Installation are already v5-compatible as of this research). |
| `@xyflow/react@12.11.x` | `react@19.2.x` | Confirm peer-dependency range on install; the xyflow project tracks React majors closely. |
| `bullmq@5.79.x` | `ioredis@5.11.x` | BullMQ pins fairly tight Redis client compatibility; don't upgrade `ioredis` independently without checking BullMQ's changelog. |
| `vite@8.1.x` | `react@19.2.x`, `@vitejs/plugin-react` matching major | If team prefers more production mileage before adopting a very new Vite major, Vite 6.x is a safe, more battle-tested fallback with the same React 19 support. |

## Sources

- npm registry (`npm view <pkg> version` / `time.modified` / `description`) — direct package metadata, HIGH confidence, verified 2026-07-03 for: fastify, @nestjs/core, hono, drizzle-orm, drizzle-kit, prisma, bullmq, @xyflow/react, reactflow, zod, @tanstack/react-query, express, vite, react, typescript, pino, ioredis, pg, postgres, @sendgrid/mail, helmet, rate-limiter-flexible, bottleneck, p-queue, and the @fastify/* plugin family.
- [NestJS vs Fastify vs Hono 2026 comparison](https://encore.dev/articles/nestjs-vs-fastify-vs-hono) — MEDIUM confidence, cross-checked against 3 other independent framework-comparison sources returning consistent conclusions.
- [Drizzle vs Prisma in 2026](https://encore.dev/articles/drizzle-vs-prisma), [Prisma's own comparison docs](https://www.prisma.io/docs/orm/more/comparisons/prisma-and-drizzle), [Bytebase Drizzle vs Prisma](https://www.bytebase.com/blog/drizzle-vs-prisma/) — MEDIUM confidence; the "team reverted to Prisma at 80 tables" data point is a single anecdote, flagged as such in Alternatives.
- [BullMQ official rate-limiting docs](https://docs.bullmq.io/guide/rate-limiting), [BullMQ Pro groups rate-limiting docs](https://docs.bullmq.io/bullmq-pro/groups/rate-limiting) — HIGH confidence, first-party BullMQ documentation confirming OSS group-rate-limit removal in v3+.
- [PlanetScale: Approaches to tenancy in Postgres](https://planetscale.com/blog/approaches-to-tenancy-in-postgres), [AWS: Multi-tenant data isolation with PostgreSQL RLS](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/), [The Nile: Shipping multi-tenant SaaS with Postgres RLS](https://www.thenile.dev/blog/multi-tenant-rls) — MEDIUM-HIGH confidence, strong multi-source convergence on shared-schema+RLS as the default pattern.
- [AWS: Cost-conscious multi-tenant KMS key strategy](https://aws.amazon.com/blogs/architecture/simplify-multi-tenant-encryption-with-a-cost-conscious-aws-kms-key-strategy/) — MEDIUM confidence, first-party AWS architecture guidance on envelope encryption per tenant.
- [SendGrid Node.js event-webhook docs (GitHub)](https://github.com/sendgrid/sendgrid-nodejs/blob/main/docs/use-cases/event-webhook.md) — HIGH confidence, first-party SendGrid SDK documentation.
- [TanStack Query docs: does this replace Redux/MobX?](https://tanstack.com/query/v5/docs/framework/react/guides/does-this-replace-client-state) — HIGH confidence, first-party TanStack documentation.

---
*Stack research for: multi-tenant B2C email marketing automation SaaS (mega-crm)*
*Researched: 2026-07-03*
