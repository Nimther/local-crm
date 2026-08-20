# Phase 10: Tenant Isolation & Trust Boundaries - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-07
**Phase:** 10-tenant-isolation-trust-boundaries
**Areas discussed:** SEC-01 scan-role connection shape, SEC-05 Better Auth trust boundary, API key scope taxonomy + existing-key migration, Redaction module shape
**Mode:** `--all --analyze` (all gray areas auto-selected; trade-off table presented before each question)

---

## SEC-01 — Scan-role connection shape

| Option | Description | Selected |
|--------|-------------|----------|
| Separate pool + credential | New login role with worker-only DSN env var; P3 provable by env-schema absence | ✓ |
| SET LOCAL ROLE on existing pool | Requires GRANT to mega_crm_app, which the API also connects as — P3 unsatisfiable | |
| Split worker/API login roles | Cleanest identity separation but far larger blast radius than R2 requires | |

**User's choice:** Separate pool + dedicated credential (recommended option)
**Notes:** Deciding fact from code: API and worker share the single `mega_crm_app` login role today, so any membership-based approach leaks the scan capability into the API process.

## SEC-01 follow-up — How consumers reach the scan pool

| Option | Description | Selected |
|--------|-------------|----------|
| Shared helper in tenant-context | `withCrossWorkspaceScan`-style function beside `withTenantTransaction`; lazy pool init; one audited entry point | ✓ |
| Helper in packages/db | Beside ensure-partitions, but splits session discipline across packages | |
| Per-consumer pools | Five copies of the discipline the CI audit must cover | |

**User's choice:** Shared helper in tenant-context (recommended option)

---

## SEC-05 — Better Auth trust boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated auth role + grants | `mega_crm_auth` role + own DSN for the adapter pool; session/account/verification auth-role-only; app role keeps needed reads | ✓ |
| RLS on auth tables | Role-keyed policies only (no GUC from Better Auth) — grants expressed as RLS with Pitfall 12's silent-failure mode | |
| auth.* schema move + role | Cleanest namespace but rewrites FKs from every tenant table to organization(id) | |

**User's choice:** Dedicated auth role + grant partitioning (recommended option)
**Notes:** Grant matrix left to planner with the principle: write grants default to the auth role; app role keeps only what live query sites prove it needs.

---

## API key scope taxonomy + existing-key migration (R4)

| Option | Description | Selected |
|--------|-------------|----------|
| resource:action + backfill | contacts:read / contacts:write / events:write; existing keys backfilled with full set; new keys default full | ✓ |
| resource:action + no backfill | Same taxonomy; existing keys refused everywhere at deploy — guaranteed integration breakage | |
| Coarse resources + backfill | contacts / events only; read-only keys inexpressible | |

**User's choice:** resource:action + backfill (recommended option)

---

## Redaction module shape (R9)

| Option | Description | Selected |
|--------|-------------|----------|
| Hybrid rule source | One rule table compiled into pino redact.paths (API hot path) + recursive scrub() (worker now, Sentry beforeSend in Phase 15) | ✓ |
| Pino paths only | Fixed-depth wildcards fail the nested-JSONB backstop; unusable by worker/Sentry | |
| scrub() function only | Every API log pays the full recursive walk; pino hook more invasive | |

**User's choice:** Hybrid rule source (recommended option)
**Notes:** Codebase correction recorded: `apps/api/src/logger.ts` already carries a pino redact path list (SPEC background said none existed); it is absorbed into the shared rule table.

---

## Claude's Discretion

- Role names, DSN env-var names, role-creation location (migration vs init script)
- Per-table grant matrices for both new roles (derived from actual query sites)
- CI bare-`SET`/`SET ROLE` audit mechanism (ESLint rule vs script)
- Redaction package name/location; worker console-wrapper shape
- Webhook rate-limit bucket sizing; @fastify/rate-limit Redis store wiring
- Anti-enumeration sweep test shape; negative cross-tenant suite structure

## Deferred Ideas

- Scope-picker UI at API-key creation — future UI phase; R4 requires enforcement only
- Splitting worker/API login roles for tenant-path access — revisit if Phase 14 pooling touches connection identity
