# Architecture Research — Production Hardening Integration (v1.1)

**Domain:** Multi-tenant B2C marketing automation (email), production-hardening milestone on an existing brownfield system
**Researched:** 2026-07-27
**Confidence:** HIGH for integration points/file paths (grounded directly in current source), MEDIUM for specific numeric tuning values (batch sizes, timeout windows — these need load-test confirmation, flagged inline), LOW/explicitly-open for the Better Auth trust-boundary decision (presented as a tradeoff per PROJECT.md's own note that it needs discuss-phase)

This supersedes the earlier (2026-07-03, pre-build) `ARCHITECTURE.md` — that document described the *intended* greenfield architecture before v1.0 was built. This document describes how v1.1's production-hardening capabilities integrate into the *actual, shipped* v1.0 codebase (~57k LOC). It is not a generic "standard architecture" survey — every recommendation below is a diff against concrete, already-read code in `apps/api`, `apps/worker`, `packages/delivery-core`, `packages/tenant-context`, `packages/db`, `packages/segments-core`. File paths, function names, and table/column names are exact unless marked "(new)".

---

## 0. System Overview (as it exists today, for reference)

```
┌────────────────────────────────────────────────────────────────────────┐
│ apps/api (Fastify)                apps/worker (BullMQ, no HTTP)        │
│  routes → resolveWorkspaceMember   13 Workers, 4 repeatable ticks       │
│  (×9 duplicated copies)            (campaign-scheduler, flow-           │
│  → withTenant/withTenantTransaction  reconciliation, analytics-         │
│                                     reconciliation, flow-segment-sweep) │
└──────────────┬─────────────────────────────┬───────────────────────────┘
               │  packages/tenant-context     │  (same package, same pool)
               │  pool = new Pool(DATABASE_URL)  role: mega_crm_app       │
               │  withTenant() (AsyncLocalStorage)                       │
               │  withTenantTransaction() → SET LOCAL app.current_       │
               │    workspace_id, per-tx                                 │
               ▼                                                         │
┌────────────────────────────────────────────────────────────────────────┐
│ PostgreSQL 17 — ONE role (mega_crm_app) owns + queries everything      │
│  22 domain tables: RLS ENABLE+FORCE, workspace_isolation policy        │
│  7 better-auth tables (user/session/account/verification/organization/ │
│    member/invitation): NO RLS, queried via packages/db's SEPARATE      │
│    pool (same DATABASE_URL, same role, no SET LOCAL at all)            │
│  admin_scan: 3 GUC-gated SELECT policies (campaigns/flow_runs/flows),  │
│    set via plain `SET LOCAL app.admin_scan='true'` on the SAME pool    │
│  events / send_events: RANGE partitioned on occurred_at, 2 named       │
│    partitions (2026-07, -08) + DEFAULT, no maintenance code            │
└────────────────────────────────────────────────────────────────────────┘
               │
               ▼
        Redis 7 — BullMQ backend (per-Worker own connection) +
        rate-limiter-flexible token bucket (own lazy ioredis singleton)
```

The send pipeline (`packages/delivery-core` + `apps/worker/src/queues/send-dispatch.ts` + `apps/worker/src/queues/flows/flow-send.ts`) already implements a disciplined **three-unit dispatch pattern** — claim transaction → SendGrid call outside any transaction → record transaction — shared identically by campaign (`kind: "campaign"`), flow-step (`kind: "flow"`), and test (`kind: "test"`) sends. This is the single most important existing asset: most of the recommendations below are targeted extensions of patterns *already present*, not new architecture.

---

## 1. Delivery state machine: `reconciling` placement

### What's already correct (don't rebuild it)

`dispatchSendGate`/`claimFlowSend` (`packages/delivery-core/src/send-ledger.ts:27-62`, `146-181`) already implement an outbox-shaped claim: `INSERT ... ON CONFLICT (workspace_id, campaign_id, contact_id) DO NOTHING ... RETURNING id`, falling back to `SELECT ... FOR UPDATE` on conflict. This row **is** the outbox entry — a `'dispatching'` row committed *before* the SendGrid call is exactly the durability guarantee a transactional-outbox table would add. **Do not build a parallel outbox table** — it would duplicate `sends` for no benefit, since `sends` already has the right shape and the right commit ordering.

The SendGrid payload already carries `custom_args.send_id = sends.id` (`packages/delivery-core/src/send-mail.ts:66-71`) on every request, campaign or flow. This means **the correlation ID the audit asks for already exists and is already propagated end-to-end**: HTTP-triggered dispatch → claim tx → SendGrid → SendGrid's Event Webhook → `webhook-events.worker.ts`'s `extractEventRow` reads `custom_args.send_id` back off the payload (`webhook-events.worker.ts:86-91`) and resolves it to the same `sends` row. What's missing is not a new ID — it's (a) a state to hold the ambiguous window, and (b) a job that resolves it, and (c) making sure that resolution corrects everything downstream that already assumed a wrong terminal status.

### The actual gap

`claimCampaignSend`'s `interrupted` branch (`send-dispatch.ts:224-233`, mirrored in `flow-send.ts:158-163`) fires when a **redelivered** job finds its own prior claim still sitting in `'dispatching'`. Today it unconditionally writes `status: 'failed'` and increments `failed_count` — without knowing whether SendGrid actually accepted the message. Three real scenarios collapse into this one branch, and none of them can be told apart at this point:

1. Crash before the `fetch` to SendGrid ever went out → genuinely never sent.
2. Crash after SendGrid returned 2xx, before unit 3's record transaction committed → **was sent**, marked `failed`.
3. `fetch` timed out / connection dropped after SendGrid received the request but before the response arrived → **unknown**, could be either.

Also: `packages/delivery-core/src/send-mail.ts`'s `sendTenantMailV3` (lines 115-132) has no `AbortController`/timeout at all — a hung TCP connection occupies a worker concurrency slot indefinitely, which is its own separate High-priority fix (audit 3.3) but produces the exact same "ambiguous outcome" shape as case 3 above, so it should resolve through the same state machine, not a separate one.

### Where the fix lives

**Modify, not new**, for the synchronous half:
- `send_status` enum: add `'reconciling'` (`ALTER TYPE send_status ADD VALUE 'reconciling'` — its own standalone migration file, see §5 for why it can't share a transaction with anything that references the new value).
- `packages/delivery-core/src/send-ledger.ts`: add `markReconciling(client, sendId)` next to `recordSendResult`/`recordFlowStepResult`; change the `interrupted` branches in `claimCampaignSend` (`send-dispatch.ts:224-233`) and `claimFlowSend` (`flow-send.ts:158-163`) to call it instead of `recordSendResult(..., {status:"failed"})`, and **do not** increment `failed_count`/rollup counters at this point — the interrupted branch no longer knows the real outcome, so it must stop pretending to.
- `packages/delivery-core/src/send-mail.ts`: add `AbortSignal.timeout(SENDGRID_REQUEST_TIMEOUT_MS)` (new exported constant, MEDIUM confidence starting value ~10-15s — needs load-test confirmation, same caveat as `DEFAULT_TENANT_RPS`) to the `fetch` call; classify a caught `AbortError` distinctly (tag it, don't just `redactApiKey` it into a generic Error) so callers can route it through the exact same "leave as reconciling, don't call SendGrid again on redelivery" path rather than the `rate_limited` path it would otherwise fall into via the existing uncaught-exception → BullMQ-retry → `interrupted`-branch flow.

**One important existing fact that changes the risk profile**: `webhook-events.worker.ts`'s `applyEventSideEffects` (lines 254-400) writes fact columns (`delivered_at`, `bounced_at`, `first_opened_at`, …) keyed purely off `send.id`/`campaignId`/`contactId` looked up from `sends` — **it never checks `sends.status` at all**. So even under the current buggy behavior, a send later proven `delivered` by the webhook *does* get `delivered_at` set even if `status` is stuck at `'failed'`. The bug is narrower than "delivery is silently lost" — it's: (a) `sends.status` (the summary/display column) and campaign/rollup **counters** (`failed_count`, `sent_count`, `workspace_daily_rollup`) are wrong and never self-correct, because `incrementCampaignSendCounter`/`incrementWorkspaceDailyRollup` only fire from the dispatch path, never from the webhook path; (b) a truly-never-sent message (no webhook will ever arrive for it) has no fact columns and stays wrong forever with no path to `failed` being *authoritative* rather than just *assumed*.

### The reconciler: repeatable job, mirroring the existing `flow-reconciliation.worker.ts` shape exactly

**New file**: `apps/worker/src/queues/send-reconciliation.worker.ts`. Same two-phase shape as `flow-reconciliation.worker.ts` (already the established pattern for "durable backstop scan for a state that should self-heal but might not"):

1. **Admin-side discovery** (cross-tenant, SELECT-only): scan `sends WHERE status IN ('dispatching','reconciling') AND queued_at < now() - INTERVAL '<grace>'`. Grace period must be longer than BullMQ's own stall/attempts-exhaustion window (currently `attempts:5` + exponential backoff from 2000ms → several minutes worst case) so this backstop never fires on a send that's simply still legitimately in flight. This scan should run against the **new `mega_crm_admin_scan` role** (§3), not the current `app.admin_scan` GUC pattern — no reason to add a fourth consumer of a mechanism the audit is asking to replace.
2. **Per-tenant resolution** (re-enters `withTenant`/`withTenantTransaction`, same discipline as every other write in this codebase):
   - If `send_events` already has a row for this `send_id` (arrived via webhook in the meantime — the common case, since `custom_args.send_id` correlation is independent of when/whether the dispatch path ever recorded a terminal status): derive the correct terminal status from those facts using the **already-existing** `deriveCurrentStatus` (`packages/delivery-core/src/send-status.ts:30-38`) and reconcile `sends.status` + retroactively fire the counter increments that never fired (this needs a small new helper — the counter-increment logic in `applyEventSideEffects` assumes it's the first time a fact is set via `setFactColumnOnce`'s `justSet` gate, which won't fire again for facts a webhook already set while the row was `reconciling`; the reconciler needs its own idempotent "resolve reconciling → terminal, backfill counters once" path, not a naive re-run of `applyEventSideEffects`).
   - If no `send_events` row exists **and** the row has been `reconciling` longer than a second, longer bound (e.g., a few hours — SendGrid's webhook latency is normally seconds-to-minutes, so absence after hours is meaningful, though not certain, evidence) → resolve to `failed`. **This is a genuine, explicit tradeoff, not a solved problem**: without querying SendGrid's Email Activity API (rate-limited, not available on all plan tiers, and BYO-key-per-tenant makes it operationally heavier — one more per-tenant credentialed call per ambiguous send), there is no authoritative way to distinguish "never reached SendGrid" from "SendGrid processed it but every downstream webhook was somehow lost." Ship the timeout-based resolution first; treat an Activity-API-backed active check as a later enhancement, not an MVP blocker for this milestone.
   - Never re-calls SendGrid. At-most-once for the actual send is preserved by construction — the reconciler only ever *reads* facts and *writes* `sends`/counters, exactly like the analytics-reconciliation worker already does for rollups.

**Schema addition worth its cost**: add `sends.reconciling_since timestamptz NULL` (set when the `interrupted` branch fires) rather than overloading `queued_at` for this — `queued_at` already means "when the claim was first committed," and conflating "how long has this specific ambiguous window been open" with that makes the discovery-scan predicate harder to reason about and harder to alert on (§6 wants "webhook lag" style alerts; a dedicated `reconciling_since` is exactly what that alert queries).

### Why this is the minimal-disruption choice among the alternatives

- **Not a new BullMQ queue per ambiguous send** — there's no natural "one job per uncertain send" trigger; the uncertainty is discovered by absence-of-signal, not by an event, which is a scan's job, not a queue's.
- **Not a transactional-outbox table** — `sends` already IS the outbox; adding a second one duplicates state and adds a second reconciliation problem (keeping the outbox and `sends` in sync) instead of solving the first one.
- **A repeatable job** (BullMQ `repeat: { every }`, same as `flow-reconciliation`/`campaign-scheduler`/`analytics-reconciliation`) is the pattern this codebase has already converged on three times independently for "durable backstop for a state that should self-heal." A fourth instance of the same pattern is the lowest-surprise choice for whoever reads this code next.

---

## 2. Tenant-fair throttling: replacing `worker.rateLimit()`

### The exact bug, confirmed in code

`consumeTenantToken` (`apps/worker/src/queues/rate-limiter.ts:56-74`) is already correctly tenant-scoped — it keys the Redis token bucket by `workspaceId`. The bug is one layer up: when a tenant's own bucket is exhausted, `processSendJob` returns `{outcome: "rate_limited", rateLimitMs}`, and **both** `email-broadcast.worker.ts:22-28` and `email-triggered.worker.ts:20-26` respond identically:

```ts
await worker.rateLimit(result.rateLimitMs);
throw Worker.RateLimitError();
```

`Worker#rateLimit()` is a **global, worker-instance-scoped** pause in BullMQ — it stops that whole `Worker` (i.e., that whole queue's job draining, all tenants) for `rateLimitMs`, not just the job for the tenant that triggered it. So the exact failure the architecture is supposed to prevent (`CLAUDE.md`'s own stated constraint: "rate limits SendGrid не должны ронять отправку при росте базы") is reproduced by the fix for a *different* problem (SendGrid-level 429/5xx) being reused for the *tenant-bucket* case, which needed the opposite behavior.

Note this also means: the two-queue split (`email-broadcast` vs `email-triggered`) does not fully solve tenant fairness either — it solves *lane* fairness (broadcast vs triggered), not *tenant* fairness *within* a lane. Two different tenants both sending triggered flow-step emails share `email-triggered`'s single `Worker` instance; today, tenant A hitting its bucket pauses tenant B's triggered sends too.

### What replaces it — evaluated against the four options in the question

| Option | Fit here |
|---|---|
| (a) `job.moveToDelayed` | **Best fit.** BullMQ's documented mechanism for "this specific job isn't ready yet, retry it later, but keep the worker draining other jobs" (`job.moveToDelayed(timestamp, token)` inside the processor, then return/no-throw so the job leaves `active` without consuming an `attempts` slot). This is a per-job operation — it never touches the Worker's own pause state, so tenant B's jobs keep flowing while tenant A's job is deferred. |
| (b) Per-tenant BullMQ job groups | Not available — `CLAUDE.md`/`STACK.md` already documents (and the code already reflects) that BullMQ OSS removed group-key rate limiting in v3+; this is why `rate-limiter-flexible` exists in the codebase at all. Re-litigating this would contradict an already-verified, already-implemented decision. |
| (c) Dispatcher/scheduler that only enqueues what a bucket allows | Architecturally heavier: requires a new admission-control component sitting in front of `email-broadcast`/`email-triggered`, duplicating logic `consumeTenantToken` already has, and reintroduces exactly the "who enqueues, who dequeues, how do they agree on remaining budget" coordination problem BullMQ+Redis is supposed to remove. Worth it only if token-bucket contention under `job.moveToDelayed` churn becomes an observed problem (see BullMQ Pro note below) — not a day-one need. |
| (d) BullMQ Pro groups | Real, purpose-built fix (per-group rate limiting is exactly this problem) — but paid, and `STACK.md`'s own "Alternatives Considered" table already flags it as "worth paying for once the app-level approach shows operational friction... revisit at scale, not upfront." No new information here changes that conclusion. |

**Recommended change**, concrete and scoped to the two files the audit already names:

```ts
// email-broadcast.worker.ts / email-triggered.worker.ts, both processors:
const result = await processSendJob(job.data);
if (result.outcome === "rate_limited") {
  if (result.cause === "sendgrid_429_5xx") {
    // SendGrid itself is rejecting -- this genuinely is a worker-wide
    // backpressure signal (SendGrid outage/global throttling), keep the
    // existing worker.rateLimit() behavior for THIS case only.
    await worker.rateLimit(result.rateLimitMs);
    throw Worker.RateLimitError();
  }
  // Tenant-bucket exhaustion: defer only THIS job, worker keeps draining.
  await job.moveToDelayed(Date.now() + result.rateLimitMs, job.token);
  throw Worker.DelayedError(); // BullMQ's required signal after moveToDelayed
}
```

This requires `processSendJob`'s `SendJobResult` (`send-dispatch.ts:43-48`) to distinguish *why* it's rate-limited — today `{outcome: "rate_limited", rateLimitMs}` conflates the SendGrid-429/5xx path (`send-dispatch.ts:353-358`, `441-443`, `519-522`) with the tenant-bucket path (`rate-limiter.ts` via `consumeTenantToken`'s `allowed: false`, consumed at `send-dispatch.ts:329-335`, `423-426`, `497-501`). Add a `cause: "tenant_bucket" | "provider_backoff"` field to that result type — small, additive, no schema change, and the split maps 1:1 onto behavior the audit already wants split.

**Claim-release interaction**: every tenant-bucket-exhausted path already calls `releaseDispatchClaim` (e.g. `send-dispatch.ts:333`) before returning `rate_limited` — this is unaffected by switching from `worker.rateLimit` to `job.moveToDelayed`; the claim is released either way, so a delayed retry re-claims cleanly. No change needed there.

**BullMQ APIs actually involved**: `Job#moveToDelayed(timestamp, token)`, `Worker.DelayedError` (the required throw after `moveToDelayed`, mirroring how `Worker.RateLimitError` is required after `worker.rateLimit`), `job.token` (already available as a property on the `Job` passed into the processor — no new plumbing needed to obtain it).

---

## 3. Postgres role separation

### Current state (grounded)

Exactly **one** login role exists: `mega_crm_app` (`docker/init-app-role.sql`), created `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, and it **owns the entire database** (`ALTER DATABASE mega_crm OWNER TO mega_crm_app`). FORCE RLS is load-bearing specifically *because* the querying role and the owning role are the same (Postgres exempts table owners from RLS by default — `0001_rls_policies.sql`'s own comment says this explicitly). Two separate `pg.Pool` instances exist today (`packages/tenant-context/src/index.ts:15` and `packages/db/src/index.ts:56`), but both connect with the **same** `DATABASE_URL` → same role. The pool split today is purely about *code organization* (tenant-scoped RLS-aware queries vs. better-auth/non-tenant queries), not about privilege separation.

`app.admin_scan` (three GUC-gated SELECT policies: `campaign_scheduler_due_scan` on `campaigns` migration `0018`, `flow_runs_due_scan` on `flow_runs` migration `0027`, `flows_segment_sweep_scan` on `flows` migration `0032`) is settable by **any** code holding a `PoolClient` from the tenant-context pool — it's a plain session GUC, not tied to role identity. `0027`/`0032` additionally have **no predicate beyond the GUC check itself** (unlike `0018`, which the migration's own comment says they were supposed to mirror) — so `app.admin_scan='true'` currently grants unrestricted cross-tenant SELECT on all of `flows`/`flow_runs`, in any status, to any code that can reach that GUC. `analytics-reconciliation.worker.ts` uses a *third*, even looser pattern: `pool.query("SELECT id FROM organization")` directly against the tenant-context pool with **no GUC at all**, relying purely on `organization` having no RLS.

### Target: three roles, mapped to pools by function, not by process

```
mega_crm_app          — owns + queries all 22 domain tables. FORCE RLS stays.
                         Used by: packages/tenant-context's pool (both apps/api and apps/worker).

mega_crm_auth         — owns the 7 better-auth tables only. (new)
                         Used by: packages/db's pool (better-auth + any legitimate
                         non-tenant org/slug lookup — same call sites as today).

mega_crm_admin_scan   — SELECT-only, narrow grants on exactly the tables
                         background discovery scans need: campaigns, flow_runs,
                         flows, sends (new, for §1's reconciler), organization
                         (for analytics-reconciliation's full-workspace scan —
                         this becomes this role's job, not mega_crm_app's).
                         Used by: apps/worker only, via a NEW dedicated pool. (new)
```

`mega_crm_app` is `REVOKE`d from the 7 auth tables (whichever trust-boundary option below is chosen) and from doing the cross-tenant admin-scan SELECTs directly — those move to the new role. This directly fixes audit 4.1 ("выделить отдельную DB role") and closes the "any PoolClient can flip `app.admin_scan`" gap, because `CREATE POLICY ... TO mega_crm_admin_scan` scopes the policy to a *role identity*, which `mega_crm_app`-authenticated connections structurally cannot assume without deliberately elevating.

### `SET LOCAL ROLE` vs. a genuinely separate pool — a real sub-decision, not just an implementation detail

Postgres supports `SET LOCAL ROLE rolename` exactly like `SET LOCAL app.current_workspace_id` — transaction-scoped, auto-resets on commit/rollback, safe under connection-pool reuse (same mechanism `withTenantTransaction` already relies on for the tenant GUC). Two ways to actually connect "as" `mega_crm_admin_scan`:

- **(A) Separate physical pool + separate DB credential** (recommended default): `packages/tenant-context` gains a sibling `withAdminScan(fn)` backed by its own small `Pool` (2-4 max connections — this role only serves a handful of low-frequency repeatable-tick discovery scans, not request-path traffic) constructed from a new `ADMIN_SCAN_DATABASE_URL`. Strongest boundary: a compromised or buggy `mega_crm_app`-authenticated code path (SQL injection, a copy-paste bug reusing the wrong pool) simply cannot reach admin-scan privileges — there is no credential material for that role anywhere in the `mega_crm_app`-authenticated process's reachable config. Cost: one more secret to provision/rotate, one more pool to monitor.
- **(B) `SET LOCAL ROLE` on the existing tenant-context pool**, with `GRANT mega_crm_admin_scan TO mega_crm_app`: smaller diff — the existing `pool.connect()` call sites in `campaign-scheduler.worker.ts`, `flow-reconciliation.worker.ts`, `flow-segment-sweep.worker.ts` (and the new `send-reconciliation.worker.ts`) swap `SELECT set_config('app.admin_scan','true',true)` for `SET LOCAL ROLE mega_crm_admin_scan`. Still a real improvement over today (the *policy* is now role-scoped, not GUC-scoped, so it can't be triggered by accident from unrelated code that doesn't know to `SET ROLE`), but weaker than (A): `mega_crm_app` holding role membership means a sufficiently-controlled `mega_crm_app` session (e.g., via injection) *can* still `SET ROLE` and read cross-tenant.

**Recommendation**: (A) for the reasons above — the "least privilege" framing the audit uses implies defense against a compromised/buggy runtime credential, not just against accidental misuse, and the cost (one more `Pool`, matching the existing two-pools-by-function precedent this codebase already has) is small. (B) is a legitimate fallback if provisioning a third DB credential is judged not worth it for this team's size — worth a one-line ADR either way so a future reader knows it was a considered choice, not an oversight.

Both (A) and (B) require rewriting `0027`/`0032`'s policies to add the missing predicate the migration comments already say they were supposed to have (mirroring `0018` — `flow_runs`: `status='waiting' AND next_wake_at<=now()`; `flows`: `status='live' AND trigger_type='segment'`), *in addition to* scoping `TO mega_crm_admin_scan` — role-scoping and predicate-narrowing are complementary, not substitutes (audit findings 9.1 and 9.2 in the numbered summary are two separate gaps, both should close together since they're the same three policies).

### The Better Auth trust boundary — presented as the open decision it is (PROJECT.md flags this explicitly)

**Option 1 — RLS on the 7 auth tables.** Consistent with every other table in the schema; a bug in unrelated domain code reading through the wrong pool still can't cross tenants. **Real cost**: better-auth (`better-auth@1.6.23`, third-party, no source in this repo) issues its own SQL through its Drizzle adapter and **never** calls `withTenant`/`SET LOCAL app.current_workspace_id` — it has no concept of this codebase's tenant GUC at all. A `workspace_id`-shaped RLS policy is also not a structural fit: `user`/`session`/`account`/`verification` don't even have a `workspace_id` column (their tenant boundary, such as it is, runs through `userId`/`organizationId`, a materially different shape). Making this work means either forking/wrapping better-auth's adapter to set a GUC on every one of its queries (fragile against upstream version bumps — this is a fast-moving dependency, and `SPECIFICATION.md` already notes `CLAUDE.md` doesn't even mention this library despite it owning the whole authz foundation), or hand-writing bespoke per-table policies keyed on a different GUC (`app.current_user_id`) that better-auth also doesn't know to set.

**Option 2 — dedicated `mega_crm_auth` role, no RLS** (the audit's own stated preference, and the smaller integration cost). better-auth's Drizzle client (`packages/db/src/index.ts`) is repointed at a role that owns *only* these 7 tables; `mega_crm_app` is `REVOKE`d from them entirely (no grant at all — not even SELECT), so a domain-module bug simply gets a permission-denied error, not silent cross-tenant access, if it ever tries to touch `session.token`/`account.password` through the wrong pool. Zero changes to better-auth's own query behavior — it keeps running exactly as it does today, just under a different, narrower credential. **Refinement worth doing at the same time**: move the 7 tables into a dedicated Postgres schema (e.g. `auth.*`, `ALTER TABLE "user" SET SCHEMA auth` etc.) so the boundary is `REVOKE ALL ON SCHEMA auth FROM mega_crm_app` (one statement) instead of seven table-level revokes, and so the separation is visible in every future migration file without relying on tribal knowledge of "these 7 tables are special."

**A concrete site this decision must account for either way**: `analytics-reconciliation.worker.ts`'s `pool.query("SELECT id FROM organization")` (currently on the `mega_crm_app`-authenticated tenant pool, relying on `organization` having no RLS) breaks under **both** options as written today — Option 2 revokes `mega_crm_app` from `organization` outright; Option 1's per-workspace RLS policy on `organization` would also block a "list every org" scan unless `organization` additionally gets its own admin-scan-shaped SELECT policy (the same third-policy-type problem `campaigns`/`flow_runs`/`flows` already have). Either way, this read must move onto the new `mega_crm_admin_scan` role's pool as part of this phase, not be left where it is.

**This document does not pick between Option 1 and Option 2** — surfacing it for the discuss-phase per PROJECT.md's own note, with a lean toward Option 2 for the integration-cost reasons above.

---

## 4. Bounded background processing: segment sweep

### The exact bug, and the pattern already proven elsewhere in this codebase

`flow-segment-sweep.worker.ts`'s `sweepOneFlow` (lines 94-151) runs, **per matching flow, per 15-minute tick**: one `SELECT c.id FROM contacts c WHERE ${whereSql}` with no `LIMIT`, inside one transaction bounded only by a 60s `statement_timeout`, then a synchronous `for` loop calling `enterSegmentTriggeredFlow` once per newly-matched contact — all still inside that same transaction. At 100k-1M contacts, a broadly-matching segment either blows the 60s timeout (rolling back the whole batch, achieving nothing, repeating identically next tick forever) or, if it squeaks under the timeout, holds one connection and one long transaction open for the duration, with no checkpoint if the process is killed mid-loop.

**This codebase has already solved the identical shape of problem once**, for campaign audience fan-out: `apps/worker/src/queues/recipient-snapshot.ts`'s `materializeBatch`/`materializeCampaignSnapshot` (lines 42-132) does exactly keyset pagination on `contacts.id` (`c.id > $cursor ORDER BY c.id LIMIT SNAPSHOT_BATCH_SIZE`, 10,000-row pages), a per-batch `statement_timeout`, and a **persisted resume cursor** (`campaigns.snapshot_cursor`, written atomically in the same transaction as the batch insert) — consumed by `campaign-kickoff.worker.ts`'s outer `while(true)` loop, which is itself resumable (re-reads `fan_out_complete`/`snapshot_cursor` on redelivery, `ON CONFLICT DO NOTHING` as a second idempotency layer). This is the model to copy, not invent from scratch.

### Why it can't be copied verbatim — and what changes

Campaign snapshotting is a **one-shot freeze**: `campaigns.snapshot_cursor` means "how far this campaign's single, never-repeated audience freeze has walked," and it's fine for it to persist forever once `fan_out_complete=true`. Segment-triggered flow sweeping is **perpetual**: it needs to re-run the same query every 15 minutes against a segment whose matching set keeps changing, diffed against `flow_segment_membership_snapshot`. A single permanent cursor column would mean "the sweep only ever looks at contacts newly added past wherever the last tick happened to stop" — silently missing contacts inserted with an `id` sorting *before* the cursor's current position between ticks.

**Recommended shape** (new): split the current single worker into a thin **discovery + enqueue** job (mirroring `campaign-scheduler.worker.ts`'s own split from `campaign-kickoff.worker.ts`) plus a **bounded, per-flow child worker**:

- `flow-segment-sweep.worker.ts` (modified): keeps its 15-minute repeatable tick and `findLiveSegmentTriggeredFlows()` discovery scan (unchanged, still admin-scan-scoped — see §3 for which role), but instead of calling `sweepOneFlow` inline, enqueues one job per due flow onto a **new** bounded-concurrency queue, `flow-segment-sweep-flow` (new `FLOW_SEGMENT_SWEEP_FLOW_QUEUE` in `packages/shared-schemas`), with a **deterministic `jobId: flow.id`** — exactly the same "duplicate enqueue is a safe no-op" convention `campaign-kickoff`'s `email-broadcast` fan-out already uses, so a flow whose sweep is still running when the next 15-minute tick fires doesn't get double-enqueued.
- `flow-segment-sweep-flow.worker.ts` (new file): the actual per-flow walk, reshaped as `recipient-snapshot.ts`'s loop — keyset-paginated `SELECT c.id FROM contacts c WHERE ${whereSql} AND c.id > $cursor ORDER BY c.id LIMIT <page size, MEDIUM-confidence starting value 5,000-10,000>`, each page its own short `withTenantTransaction`, cursor persisted per-page. Because this is perpetual (not one-shot), the cursor needs a home that means "how far *this tick's* walk has gotten" and is naturally reset at the start of the *next* tick — either (a) a new nullable `flows.segment_sweep_cursor` column, written mid-walk and set back to `NULL` on successful full completion of a walk (so the next tick starts from the beginning again and catches everything, including contacts whose `id` sorts earlier than wherever the walk stopped), or (b) a tiny dedicated table `flow_segment_sweep_progress (flow_id PK, workspace_id, cursor_contact_id, tick_started_at)` if keeping this off the hot `flows` row is preferred (marginal either way at this table's write frequency — a plain column is simpler and consistent with `campaigns.snapshot_cursor`'s existing precedent).
- The **stale-snapshot anti-join `DELETE`** (`flow-segment-sweep.worker.ts:114-119`, currently one unbounded statement per flow per tick) needs the same batching treatment — a `LIMIT`-bounded delete run in a loop until it deletes 0 rows, not a structural change, just applying the same "bound every statement that scales with contact count" discipline consistently.

This decomposition mirrors an already-established pattern in this exact codebase (`campaign-scheduler` discovers → `campaign-kickoff` does the bounded walk → `email-broadcast` does the actual per-contact work), so it's the lowest-surprise shape for whoever plans/reviews this phase.

### Interaction with `segments-core`

No change needed to `packages/segments-core/src/compile.ts` — `compileSegmentDefinition(def, workspaceId)` already returns a plain `{whereSql, params}` fragment designed to be embedded into an arbitrary caller-composed query (it's already used this way by three different callers: segment preview, `recipient-snapshot.ts`, and the sweep). Keyset pagination is purely a matter of the *caller* appending `AND c.id > $N ORDER BY c.id LIMIT $M` to the fragment — exactly what `recipient-snapshot.ts:52-53` already does. The compiler's one-WHERE-clause design is what makes this decomposition easy; nothing about it constrains pagination strategy.

---

## 5. Partition lifecycle + migration pipeline

### Partition creation: application code, not an extension, not the migration pipeline's normal path

The `events`/`send_events` migrations (`0007`, `0020`) already flag the intended follow-up in their own comments: *"pg_partman's `run_maintenance_proc` is the standard automation layer on top of native declarative partitioning, if the extension is available."* Given the fixed decision is Docker on a **self-hosted VPS** (full control of the Postgres image), installing `pg_partman` is possible — but it adds an extension dependency + its own maintenance/cron wiring that this team would then own without prior operational experience with it, for a problem this codebase can solve with a small amount of idempotent DDL the team already fully understands (every existing partition-creation statement is already hand-written SQL in migrations `0007`/`0020`).

**Recommended**: a **new BullMQ repeatable job** (`apps/worker/src/queues/db-maintenance/partition-maintenance.worker.ts`), same shape as the other four repeatable ticks already in this process — daily cadence is enough (partitions are month-granular; daily gives ample lead time to alert before the 2-3-month buffer the audit wants is exhausted). Each run: for `events` and `send_events`, compute the next N months' boundaries and `CREATE TABLE IF NOT EXISTS events_YYYY_MM PARTITION OF events FOR VALUES FROM (...) TO (...)` (idempotent — safe to run daily without a "did I already do this" check beyond `IF NOT EXISTS`). No new DB role is needed for this: `mega_crm_app` already **owns** `events`/`send_events` (it owns the whole database), and attaching/creating a partition of a table you own requires no privilege beyond that ownership — this is a different privilege axis from the admin-scan cross-tenant-*read* concern in §3, and shouldn't be routed through that role. RLS on the parent (`ALTER TABLE events ENABLE/FORCE ROW LEVEL SECURITY`) already propagates automatically to every child partition per Postgres's own documented behavior and per `0007`'s own comment — no per-partition RLS wiring needed on each new monthly table.

**Monitoring**: emit a metric/log line each run with "months of buffer remaining" and alert (§6/Sentry or the hosted logs SaaS) if that buffer drops under a threshold (e.g., 1 month) — catches both "the job itself stopped running" and "someone changed the lookahead constant without updating the alert threshold."

**DEFAULT-partition migration**: this milestone's hard deadline is *preventing* more data from landing in `events_default`/`send_events_default` past 2026-09-01 — the job above, shipped before that date, is what matters. Migrating data *already* in the DEFAULT partitions (July/August rows that predate this job, if any land there before it ships) into proper monthly partitions is a separate, lower-urgency one-time operational runbook (detach DEFAULT, create the missing partition, re-insert/re-partition the DEFAULT rows, reattach an empty DEFAULT) — worth a documented runbook, not application code, since it's a one-time historical cleanup rather than a recurring concern.

### Migration gate: advisory lock + a dedicated deploy-time step

Today: **neither** `apps/api` nor `apps/worker` apply migrations at startup at all (`SPECIFICATION.md` §4.6 confirms this via grep — `db:migrate`/`drizzle-kit migrate` only appear in dev-only npm scripts and `scripts/migrate-dev.mjs`). This is the actual gap, not "multiple containers racing" per se — there is currently no non-dev migration path at all.

**Recommended shape**, standard for this class of deployment (self-hosted Docker, no Kubernetes-style init-container primitives assumed):

- **New script**: `scripts/migrate-deploy.mjs` — wraps `drizzle-kit migrate` (or drizzle-orm's programmatic `migrate()`) in `SELECT pg_advisory_lock(<fixed constant>)` / `pg_advisory_unlock(...)` (session-level, blocking — a second concurrent invocation simply waits rather than racing). This is defense-in-depth against a human or CI re-running the deploy step concurrently; it does not replace having a single, explicit deploy-pipeline step.
- **New Docker Compose / deploy-manifest service**: a one-shot `migrate` service that runs `node scripts/migrate-deploy.mjs` and exits 0/1; `api`/`worker` services depend on its successful completion (`depends_on: migrate: condition: service_completed_successfully` in Compose, or the equivalent sequencing in whatever deploy script drives the VPS) before starting. This is the standard "migrate once, explicitly, before the fleet starts" pattern — preferred over "every replica tries to migrate on boot," which is what the advisory lock alone would otherwise be compensating for on every single container start rather than once per deploy.
- **Rollback/roll-forward**: given `drizzle-kit`'s migration model is forward-only SQL files (no auto-generated down-migrations — confirmed by the existing `migrations/` directory containing no `*_down.sql` counterparts), "rollback" in practice means either (a) a hand-written compensating migration checked in as the next numbered file (safe, consistent with how `0019` already compensates for `0006`'s gap in this exact codebase), or (b) restoring from the PITR backup this milestone is also introducing, for anything a forward-fix can't cleanly undo (e.g., a destructive `DROP COLUMN`). Document both paths in the runbook this milestone already scopes; don't build new tooling for (a) beyond what already exists (numbered migration files).

### Expand/contract against a running worker fleet mid-send

Given `apps/worker` runs long-lived jobs that can genuinely span a deploy boundary (a flow run mid-`wait` for days, a campaign kickoff fan-out over 1M contacts, a send sitting in the new `reconciling` state for hours per §1) — migrations touching columns/enums those in-flight jobs' code paths depend on must follow additive-then-destructive sequencing across *separate* deploys, not "everything in one migration file":

- **Expand** (safe within one deploy, old and new code both keep working against it): new nullable columns, new tables, `ALTER TYPE ... ADD VALUE` for enums, new indexes (created `CONCURRENTLY` to avoid locking `sends`/`events` under write load during business hours).
- **Contract** (only after every worker/api instance is confirmed running code that no longer needs the old shape): `DROP COLUMN`, `NOT NULL` tightening, enum value removal (not directly supported by Postgres anyway — would require a full type rebuild), renames.

**Concrete instance already in this plan**: `ALTER TYPE send_status ADD VALUE 'reconciling'` (§1) is expand-only by nature, but has a Postgres-specific sequencing constraint worth naming explicitly: a newly-added enum value **cannot be referenced in the same transaction that added it** (pre-PG12 this was an absolute prohibition; PG12+ relaxed it to "not the same transaction," which is still exactly what a single-transaction migration file would violate if it tried to both add the value and, say, backfill rows using it). Concretely: the enum-add migration must be its own standalone migration file (already how `drizzle-kit` numbers migrations — one file per step, each its own transaction by default), applied and confirmed *before* the deploy that ships the `send-dispatch.ts`/`flow-send.ts` code referencing `'reconciling'` as a literal. Sequence: migration N (enum value) → confirm applied → deploy N+1 (code referencing it). Not a big engineering lift, but a real ordering constraint the phase plan for §1 needs to encode explicitly, not discover mid-deploy.

---

## 6. Observability wiring

### Where IDs get created (current state has none of this — every piece below is new)

- **`request_id`**: Fastify already auto-generates a `reqId` and attaches it to `request.log` by default (`Fastify({ loggerInstance: logger, ... })` in `apps/api/src/server.ts:34-42` doesn't currently override `genReqId`). Configure `genReqId` to prefer an incoming `X-Request-Id`/similar header when present (behind a reverse proxy that sets one) and fall back to Fastify's default UUID generation otherwise — small, additive config change, no new dependency.
- **`tenant_id` (workspace_id)**: currently resolved independently in **9 duplicated copies** of `resolveWorkspaceMember` (`SPECIFICATION.md` §6.4, audit finding 20) — `contacts.routes.ts:58`, `csv-import.routes.ts:37`, `send-log.routes.ts:42`, `campaigns.routes.ts:142`, `flows.routes.ts:119`, `segments.routes.ts:98`, and three `analytics/*.routes.ts` files. Centralizing this into a single Fastify decorator/plugin is *already* independently justified by audit finding 20 (the anti-enumeration 404 invariant isn't uniformly enforced across those 9 copies) — doing it as part of this milestone's observability work means the **same** centralization point becomes where `workspace_id` gets attached to the request-scoped Pino child logger (`request.log = request.log.child({ workspace_id, request_id })`) and to Sentry's scope (`Sentry.setTag('workspace_id', ...)`), rather than needing a second, separate refactor later. Recommend sequencing this centralization explicitly as part of the observability phase, not deferring it — it's cheaper to do once.
- **`job_id`**: already exists structurally — every queue in this codebase already assigns deterministic or semi-deterministic `jobId`s (documented per-queue in `SPECIFICATION.md` §5.3-5.6: `${flowRunId}-${nodeId}`, `${workspaceId}-${campaignId}-${contactId}`, `${flowRunId}-${Date.now()}`, etc.). Nothing new needs to be minted — `job.id` just needs to actually be *logged*, which it currently isn't (workers use bare `console.log`/`console.error`, no structured fields at all).
- **`send_id`**: already the pipeline's strongest correlation ID (§1) — `sends.id`, embedded in SendGrid's `custom_args.send_id`, read back by the webhook processor. Needs to be threaded into every worker log line for a send-related job, not newly created.

### Propagation mechanism: extend the AsyncLocalStorage context that already threads through both processes

`packages/tenant-context`'s `tenantContext` (`index.ts:34`) is **already** the one piece of request/job-scoped context shared identically by `apps/api` and `apps/worker` (its own doc comment says so explicitly). Extending its stored shape from `{workspaceId}` to `{workspaceId, requestId, jobId?}` (and adding a parallel `getRequestId()` accessor next to the existing `getWorkspaceId()`) is the single cheapest way to make correlation data available to any deeply-nested code (`packages/delivery-core`, `packages/contacts-core`, etc.) without threading extra parameters through every function signature. For HTTP-triggered flows, this context is populated in the same `onRequest` hook doing tenant resolution; for BullMQ jobs, populated once at the top of each `create*Worker`'s processor, wrapping the existing `withTenant(workspaceId, ...)` call each worker already makes.

**Job schemas** (`packages/shared-schemas`): add an optional `requestId`/`correlationId` field to job payload schemas so HTTP-originated jobs (e.g. a campaign launch enqueuing `campaign-kickoff`) carry the originating request's ID across the queue boundary; jobs with no HTTP origin (repeatable ticks, webhook-driven, delayed flow wakeups) simply don't set it and fall back to `job.id` as their correlation key — no need to invent a synthetic ID for those.

**Worker → Postgres**: no schema/column changes needed purely for correlation — `sends.id` already suffices for the send pipeline specifically. For general query-level correlation (slow-query logs, `pg_stat_activity`), a cheap, standard, no-migration option is worth naming: prefix queries with a SQL comment (`/* request_id=... */`) or set `SET LOCAL application_name = '<short correlation tag>'` at the top of `withTenantTransaction` — both are visible in `pg_stat_activity`/slow-query logs without any schema change, useful for the DBA-facing debugging side of observability rather than the app-log-facing side.

### Sentry wiring

- **Fastify**: `@sentry/node`'s Fastify integration (current SDKs expose `Sentry.setupFastifyErrorHandler(app)`) attached in `apps/api/src/server.ts`'s `buildServer()`, alongside the same `onRequest` hook that resolves `workspace_id`/`request_id` — set `Sentry.setTag('workspace_id', ...)` / `Sentry.setTag('request_id', ...)` there so every captured error is pre-tagged without per-route boilerplate.
- **BullMQ workers**: no first-party Sentry-BullMQ integration exists — the standard pattern is wrapping each processor. Given this codebase already has **13 near-identical** `create*Worker(connection)` factory functions (every file under `apps/worker/src/queues/`), the right integration point is **one new shared helper** (`apps/worker/src/observability/wrap-processor.ts`, new) that each factory passes its processor through: attaches the Pino child logger (`workspace_id`/`job_id`/`send_id` where derivable from `job.data`), times the job (feeds a duration metric to the hosted metrics SaaS), and on a caught exception calls `Sentry.captureException(err, {tags: {queue: name, job_id: job.id, ...}})` before **re-throwing** (never swallowing — BullMQ's own retry/failed-job semantics must be preserved unchanged). This is a single new file touching 13 call sites with a one-line wrap each, rather than 13 independent edits.

### OpenTelemetry

Given the fixed decision is Sentry + a **hosted** logs/metrics SaaS (not a self-run collector), full OTel SDK adoption is not required to hit this milestone's goals — the AsyncLocalStorage-based context above already gives the same practical benefit (request/job/tenant-scoped context available anywhere in the call stack) that OTel's own context API provides, because Node's OTel SDK **also** uses AsyncLocalStorage internally for context propagation — this is the same primitive, not a competing one. Practical implication: if OTel (or a hosted APM that speaks OTLP) is adopted later, it's additive on top of this milestone's work, not a rearchitecture, *as long as* the correlation-ID plumbing above is built on `AsyncLocalStorage` (as recommended) rather than ad hoc parameter-passing or module-level globals. No OTel SDK dependency needs to be added in this milestone unless the chosen hosted logs/metrics vendor specifically requires an OTLP exporter to ingest traces — a vendor-selection detail, not an architecture one.

---

## 7. Suggested build order

Seven stages, with explicit dependency reasoning. Stage numbers are dependency order, not necessarily audit priority order (the audit's own "Фаза 1-7" in §12 of the audit is close to this, but this ordering makes the *why* explicit against this specific codebase rather than restating the audit's list).

### Stage 1 — Test & deploy infrastructure foundation
CI, lint/coverage gates, isolated Playwright E2E database, the migration-gate script + advisory lock + one-shot `migrate` deploy step (§5), Dockerfiles, and — the part that actually gates Stage 3 — a **failure-injection harness** extending the dependency-injection seam that already exists (`ProcessSendJobDeps.sendMail` in `send-dispatch.ts:50-60`, already used by the existing `send-dispatch-idempotency.test.ts`/`backoff.test.ts`/`send-dispatch-durability.test.ts` per the file's own doc comments — this class of test already has a foothold, it needs new scenarios, not a new seam).

**Why first, unconditionally**: no migration described in §1/§3/§4/§5 is safe to apply to a real environment without a working migration-gate; no change to `send-dispatch.ts`'s crash-boundary logic (§1) is safe to make without a way to *prove* the new `interrupted`→`reconciling` transition behaves correctly under simulated crash timing — this is explicitly what the question is pointing at with "can you change the delivery state machine before you have failure-injection tests?" — no.

### Stage 2 — Partition automation
The new `partition-maintenance.worker.ts` job (§5). Only depends on Stage 1's migration pipeline existing (to ship its own schema-free changes safely, and to give the new repeatable-job registration a CI gate). Otherwise fully independent of every other stage — sequenced early because it has a **hard external deadline** (before 2026-09-01) that doesn't care about the rest of this ordering.

### Stage 3 — Delivery correctness: state machine + timeout
The `reconciling` state, `interrupted`-branch change, `AbortController` timeout in `send-mail.ts`, the `cause` split in `SendJobResult` (§1, §2's prerequisite). Scoped to per-tenant `withTenant`/`withTenantTransaction` code paths only — **not** yet the cross-tenant reconciler backstop scan (that needs Stage 5's role). Depends on Stage 1's failure-injection harness. This is the audit's single highest-priority item and the one most explicitly gated by test infrastructure.

### Stage 4 — Tenant-fair throttling
`job.moveToDelayed`/`Worker.DelayedError` replacing `worker.rateLimit()` for the tenant-bucket case (§2). Sequenced immediately after Stage 3 because it touches the **same files** (`send-dispatch.ts`, `email-broadcast.worker.ts`, `email-triggered.worker.ts`) and the same `SendJobResult.cause` field Stage 3 introduces — doing them back-to-back (same phase or adjacent phases) avoids two plans mid-air on the same hot files, and both are the audit's two "blocks production" delivery findings, naturally shipped as one hardening slice.

### Stage 5 — DB role separation
`mega_crm_admin_scan` (+ pool, per §3), the auth trust-boundary decision and implementation, the `0027`/`0032` policy predicate fix. Independent of Stages 2-4's code paths, but touches the same `packages/tenant-context` package (adding `withAdminScan`) that Stage 3's later reconciler backstop scan and Stage 6's segment-sweep discovery both want to build on — sequenced before Stage 6 so both of those rewrite their admin-scan usage **once**, against the final role, rather than against the old GUC pattern first and then again later.

### Stage 6 — Bounded background processing + delivery reconciler backstop
Segment sweep keyset pagination + checkpoint + parent/child split (§4), and the `send-reconciliation.worker.ts` backstop scan that completes §1 (the synchronous half shipped in Stage 3; the cross-tenant discovery half needs Stage 5's role). Grouped together because both are "worker reliability" audit-category items sharing the identical keyset-pagination-plus-checkpoint pattern already proven by `recipient-snapshot.ts` — one engineer/plan doing both back-to-back reuses the same mental model, and Stage 6 literally cannot be correctly scoped for the reconciler's cross-tenant scan half without Stage 5 existing first.

### Stage 7 — Compliance/analytics, observability wiring, remaining security hardening
Correlation-ID plumbing + Sentry + worker structured logging (§6), unsubscribe-propagation atomicity, UTC rollup semantics, API key scopes enforcement, webhook replay protection, invite privacy, distributed (Redis-backed) API rate limiting, frontend route splitting. Largely independent of Stages 2-6, but deliberately last: observability is most valuable once the higher-risk subsystems it needs to monitor (delivery pipeline, throttling, background sweeps) have already been hardened rather than instrumented in their pre-fix state, and the correlation-ID work (§6) is cheapest once Stage 6's reconciler has already established the `send_id`/`workspace_id` tagging conventions it reuses (Sentry tags, log fields) rather than inventing them twice.

---

## Anti-Patterns specific to this milestone (do not do these)

### Anti-Pattern: building a second outbox table for delivery reconciliation
**What people do**: introduce a dedicated `send_outbox`/`delivery_attempts` table to track "was this actually sent" separately from `sends`.
**Why it's wrong here**: `sends` (committed `'dispatching'` before the SendGrid call, per the existing three-unit pattern) already *is* the outbox. A second table means keeping two sources of truth in sync, which is strictly more reconciliation surface, not less.
**Do this instead**: add the `reconciling` state directly to `sends.status` (§1).

### Anti-Pattern: routing every cross-tenant background scan through one over-broad "admin" role/GUC
**What people do**: fix the audit's admin_scan finding by making the *predicate* stricter but leaving one shared, unscoped mechanism (a single GUC or a single overly-broad role) that every background job uses for every kind of cross-tenant read.
**Why it's wrong here**: `flow_runs_due_scan`/`flows_segment_sweep_scan` already show what happens when a policy is copy-pasted without its predicate (audit finding 9.1) — a shared, generic "admin" escape hatch invites the same class of mistake again the next time a new background job is added.
**Do this instead**: `mega_crm_admin_scan` gets narrow, per-table, per-purpose SELECT policies (role-scoped **and** predicate-scoped, §3) — every new cross-tenant scan added in the future should require its own explicit, reviewed policy, not inherit blanket access from an existing one.

### Anti-Pattern: unbounded single-transaction fan-out for "small" background jobs
**What people do**: assume a background job (unlike a request handler) can safely hold one long transaction because "it's not user-facing."
**Why it's wrong here**: this is exactly what `flow-segment-sweep.worker.ts`'s current bug is (§4) — the transaction-per-page pattern (`recipient-snapshot.ts`) is *already* the established fix in this codebase; there's no reason for a new background job to regress to the unbounded shape it already moved away from once.
**Do this instead**: keyset pagination + persisted cursor + short per-page transactions, for any new batch/sweep/backfill job this milestone or future ones introduce.

---

## Sources

- Direct source reads (HIGH confidence, this is the authoritative ground truth for this document): `apps/worker/src/queues/send-dispatch.ts`, `apps/worker/src/queues/flows/flow-send.ts`, `packages/delivery-core/src/send-mail.ts`, `packages/delivery-core/src/send-ledger.ts`, `packages/delivery-core/src/send-status.ts`, `apps/worker/src/queues/webhook-events.worker.ts`, `apps/worker/src/queues/email-broadcast.worker.ts`, `apps/worker/src/queues/email-triggered.worker.ts`, `apps/worker/src/queues/rate-limiter.ts`, `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts`, `apps/worker/src/queues/flows/flow-reconciliation.worker.ts`, `apps/worker/src/queues/recipient-snapshot.ts`, `apps/worker/src/queues/campaign-kickoff.worker.ts`, `apps/worker/src/queues/flows/flow-queues.ts`, `apps/worker/src/queues/connection.ts`, `apps/worker/src/server.ts`, `apps/api/src/server.ts`, `apps/api/src/logger.ts`, `packages/tenant-context/src/index.ts`, `packages/db/src/index.ts`, `packages/db/src/rls.ts`, `packages/segments-core/src/compile.ts`, `packages/db/migrations/0001_rls_policies.sql`, `0007_events_partitioned.sql`, `0018_campaign_scheduler_due_scan_policy.sql`, `docker/init-app-role.sql`.
- `SPECIFICATION.md` (as-built, 2026-07-15) — authoritative for schema/RLS/queue inventory not directly re-verified against source in this pass (e.g. full route list, secrets handling).
- `.planning/AUDIT-2026-07-27-production-readiness.md` — the requirements source this document integrates against.
- `.planning/PROJECT.md` — milestone scope, fixed decisions, and the explicit "open decision" flag on the Better Auth trust boundary.
- BullMQ's own `moveToDelayed`/`DelayedError`/`rateLimit`/`RateLimitError` semantics — MEDIUM confidence (not re-verified against BullMQ's live docs in this research pass; consistent with the codebase's own existing correct usage of the `rateLimit`/`RateLimitError` pair, which implies the parallel `moveToDelayed`/`DelayedError` pairing follows the same required-throw-after-call convention BullMQ documents for both).
- Postgres `ALTER TYPE ... ADD VALUE` transaction-scoping behavior — MEDIUM confidence, general Postgres knowledge (PG12+ relaxed same-transaction-block usage but still disallows using a value in the same transaction that added it); not re-verified against Postgres's release notes in this pass.

---
*Architecture research for: production hardening integration, Mega CRM v1.1*
*Researched: 2026-07-27*
