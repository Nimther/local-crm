# Architecture

Three documents, three jobs. Keeping them apart is what stops any of them from rotting:

| Document | Answers | Contains |
|---|---|---|
| [`SPECIFICATION.md`](./SPECIFICATION.md) | **what is** | as-built facts: dependencies and versions, the schema and its RLS policies, secret storage, the send pipeline, every public entry point |
| **this file** | **why it is that way** | the load-bearing decisions and what they cost |
| [`CONVENTIONS.md`](./CONVENTIONS.md) | **how to write more of it** | naming, module shape, test patterns, migration rules |

This document deliberately restates no package version, table name, column name or environment-variable name. Where a fact is needed it links to the `SPECIFICATION.md` section that holds it. A duplicated fact drifts, and the duplicate is always the copy that goes stale.

---

## 1. The `apps/*` ↔ `packages/*` boundary

Domain logic lives in `packages/*`. Transport and process concerns live in `apps/*`. An HTTP route knows how to parse a request, resolve the caller's membership and map an error to a status code; it does not know how a segment compiles to SQL or when a send is allowed. That split is what lets `apps/api` and `apps/worker` — two separate OS processes with no import path between them — apply exactly the same rules to the same data.

**The dependency arrow points app → package and never back.** Every `apps/*` manifest lists `@mega-crm/*` packages; no `packages/*` manifest lists an app. That is not stylistic. `apps/*` workspaces declare no export entry points, so an inverted arrow would require adding one, and the moment a package can reach into an app, "shared domain logic" becomes "whatever the app happened to export".

The rule has already changed a design in practice. The SIGKILL failure-injection harness needs a child process running the real dispatch path, which lives in `apps/worker`. Rather than invert the arrow, the generic spawn/IPC/kill orchestration went into `packages/test-support` — naming no domain concept at all, asserted by a source check — and the worker-specific entrypoint stayed in `apps/worker`, handed to it by path. The constraint produced a cleaner separation than the shortcut would have.

Topology and the package inventory: [`SPECIFICATION.md` §1](./SPECIFICATION.md).

## 2. From an ingested event to a delivered email

This is the product's centre, and the one flow that gets a diagram. Everything else here is prose, because every diagram is another surface to update on every architectural change — which is the rot the documentation-update rule exists to prevent.

```mermaid
flowchart TD
    A["Event arrives<br/>(public ingest endpoint or CSV import)"] --> B["events queue<br/>fast 2xx, work deferred"]
    B --> C["Trigger evaluation<br/>does this event start or advance a flow?"]
    C --> D["Flow run advances<br/>wait / condition / send nodes"]
    E["Campaign launched<br/>(operator action)"] --> F["Segment compiled to SQL<br/>audience resolved"]
    F --> G["broadcast queue<br/>one job per recipient"]
    D --> H["triggered queue<br/>one job per send"]
    G --> I["Dispatch<br/>unit 1: claim"]
    H --> I
    I --> J["Pre-send gate<br/>subscription status, suppression"]
    J --> K["Per-tenant rate limiter<br/>token bucket keyed by workspace"]
    K --> L["unit 2: send<br/>tenant's own provider key"]
    L --> M["unit 3: record<br/>terminal status"]
    M --> N["Delivery webhook<br/>delivered / opened / clicked / bounced"]
    N --> O["Send ledger + campaign counters"]
```

The dispatch step is three units on purpose, and the boundaries between them are where the failure modes live. Unit 1 commits a claim in its own transaction **before** the provider is contacted, so a redelivery cannot produce a second email. Unit 2 makes the call. Unit 3 records the terminal result. A process that dies between units 1 and 3 leaves a claim with no result, and the next delivery of that job takes an `interrupted` branch that resolves the row rather than sending again — the duplicate-send window, closed deliberately and reproducible on demand via the scenarios in [`docs/failure-injection-scenarios.md`](./docs/failure-injection-scenarios.md).

Queue names, worker registrations and the dispatcher's internals: [`SPECIFICATION.md` §5](./SPECIFICATION.md).

## 3. Two send queues, not one queue with priorities

Broadcast sends and triggered sends are **separate queues with separate workers**, deliberately, rather than one queue with job priorities.

Priority only resolves contention *within* a single worker pool. Put both kinds of work in one queue and a broadcast to a large audience monopolises every worker in that pool; a triggered send — a password reset, an order confirmation, the emails whose latency a recipient actually notices — waits behind however many broadcast jobs happen to be ahead of it. Priority reorders the queue, but the workers are already busy. Separate pools mean the triggered lane has workers of its own that a broadcast cannot occupy.

The cost is two topologies to operate instead of one, and concurrency that must be tuned per lane rather than globally. That is the trade being made.

The per-tenant rate limiter sits *below* both lanes, on a shared token bucket keyed by workspace, because the ceiling being respected belongs to the tenant's own provider account and does not care which lane a send came from.

## 4. Multi-tenancy: shared schema, tenant column, Row-Level Security

Every tenant's rows live in the same tables, discriminated by a workspace column, with Postgres Row-Level Security enforcing the boundary.

The alternatives were considered and rejected on scale. Schema-per-tenant multiplies catalog entries and turns every migration into a fan-out across N schemas; database-per-tenant multiplies connection management and migration orchestration on top of that. Both buy stronger physical isolation at a cost that grows linearly with tenant count, and this product's target is many tenants, not a few large ones.

**RLS is defence in depth, not the only defence.** Application code filters by workspace as well. The policies exist because relying on every engineer remembering the filter on every query, forever, is a single forgotten `WHERE` away from a cross-tenant leak. The session variable that the policies read is set with transaction scope, never session scope — a session-scoped setting would persist on a pooled connection and leak into whatever request picked it up next.

**The application role must never hold the bypass privilege.** RLS is also `FORCE`d, because a table's owner is otherwise exempt from its own policies and the application role owns these tables. Both properties are asserted directly by the migration-chain tests rather than assumed.

Policy shapes, the exact GUC, the tables without RLS and the known divergence between two policy variants: [`SPECIFICATION.md` §4.3](./SPECIFICATION.md).

## 5. Envelope encryption for tenant provider keys

Each tenant brings their own email-provider API key. That key controls their sending reputation, and it is the highest-value secret this platform holds.

It is protected by **envelope encryption**: a per-tenant data key encrypts the secret, and a key-encryption key wraps the data key. Only the wrapped data key and the ciphertext are stored.

The alternative — column encryption with a key the database can reach — fails the threat it exists to address. If the encryption key lives inside the same trust boundary as the ciphertext, a database compromise yields both, and the encryption bought nothing. Under envelope encryption the same compromise yields wrapped data keys the attacker cannot unwrap without the key-encryption key, which lives outside the database.

The tenant identity is bound into the wrap as additional authenticated data, so a payload sealed for one workspace does not decrypt under another's identity even with the key-encryption key in hand. The plaintext data key is zeroed immediately after use and never returned to a caller.

Provider selection, key storage and the local development path: [`SPECIFICATION.md` §3.4](./SPECIFICATION.md).

## 6. Partition maintenance and the dead-man's switch

`events` and `send_events` are range-partitioned by month, with a DEFAULT catch-all absorbing anything outside every partition explicitly created so far. A missing month is not a correctness failure — Postgres routes the row into DEFAULT and the insert succeeds — but it is a performance cliff waiting to happen: attaching a new monthly partition against a DEFAULT that has already absorbed real rows for that month forces Postgres to scan the entire DEFAULT partition under an `ACCESS EXCLUSIVE` lock to validate the attach, and on a live multi-tenant table that lock is felt by every tenant at once, not just the one whose data triggered it. The horizon has to stay ahead of the calendar precisely so that attach is never asked to do that scan.

Keeping the horizon ahead is one idempotent function's job, not a scattered set of call sites. `ensurePartitions` (`packages/db/src/partitions/ensure-partitions.ts`) is the single source of partition DDL for both tables, and every attach it performs goes through the same CHECK-constraint-first sequence unconditionally — add the constraint `NOT VALID`, validate it, attach, drop the now-redundant constraint — so a partition that already holds rows (the DEFAULT-relocation case) and a partition that has never held a row (the everyday case) are handled by exactly one code path (`attachPartitionCheckFirst`), not two that can drift apart. That function is called from three places: the daily worker tick, the same worker's boot-time immediate run (so a restart doesn't wait up to 24 hours to notice a gap), and the ephemeral-database test fixture — which is what makes "the tests pass" and "the horizon is actually maintained in production" the same claim instead of two that can diverge.

Attaching a NON-EMPTY child — only the DEFAULT-relocation procedure does this, never the everyday new-month case — needs one more piece: PostgreSQL automatically re-validates a partitioned table's inherited foreign keys against the referenced table when the attached child already holds rows, and `events.contact_id -> contacts(id)` / `send_events.send_id -> sends(id)` both reference tables under FORCE ROW LEVEL SECURITY. Through Phase 9 this used a session marker GUC (`app.admin_scan`) read by a permissive policy; Phase 10 (§7 below) retires that pattern everywhere, including here. The replacement is an explicit, optional `adminClient` parameter on `attachPartitionCheckFirst`: a connection backed by a Postgres role capable of bypassing row-level security (BYPASSRLS or superuser), supplied only by the operator-invoked relocation CLI (`packages/db/scripts/relocate-default-partition-rows.ts`, via `PARTITION_RELOCATION_ADMIN_DATABASE_URL`) and never by `apps/api` or `apps/worker`. The everyday `ensurePartitions` call path never supplies it — an empty child's FK re-validation trivially passes regardless of visibility, so the ordinary connection is sufficient there.

Whether that horizon is actually being maintained is answered by a two-process arrangement, not a self-report. The worker writes one row to Postgres (`partition_maintenance_runs`) every time it runs: how many months of buffer remain per table, whether either DEFAULT partition holds rows, and when the run happened. A separate process — inside `apps/api`, not inside `apps/worker` — polls that row on its own schedule and decides whether it looks healthy. This split is deliberate, not incidental: a watcher that lives inside the process it is watching cannot report that the process has stopped, because the watcher stops with it. Postgres is the only state shared between the two processes; there is no in-memory handoff, no direct RPC from worker to API. Sharing anything richer than a row in a table would reintroduce the coupling the split exists to remove — if the watchdog needed a live connection to the worker to ask "are you alive", the answer to "the worker crashed" would be silence indistinguishable from "everything is fine and quiet."

This arrangement is designed to make three failures loud, through one plain-text email to a platform operator: the maintenance job stopped running, the horizon is shrinking toward the calendar, and DEFAULT has started holding rows despite the horizon logic. It is not designed to provide dashboards, queue-depth alerting, or error aggregation — a failed maintenance run sits inspectable in Redis with no UI watching it, and turning that into real observability tooling is Phase 15's job, not this one's.

Queue name, cron schedule, the health-table columns, and the exact alert thresholds: [`SPECIFICATION.md` §4.4, §5.8, §7](./SPECIFICATION.md).

## 7. Cross-tenant scans run as a separate login role, not a session flag

A background job that must read across every tenant (campaign-scheduler's due-campaign discovery today; four more consumers in later plans of this phase) needs a genuine exception to Row-Level Security. Two shapes were considered for that exception, and the one this codebase used through Phase 9 — a session GUC (`app.admin_scan`) read by a permissive policy — was rejected going forward in favour of a dedicated, least-privilege Postgres login role (`mega_crm_scan`) reached through its own connection pool.

**Decision:** a separate pool connecting under its own login credential (`mega_crm_scan` — `NOBYPASSRLS`, owns no tables, holds only the grants each consumer's migration adds), reached through exactly one shared helper (`withCrossWorkspaceScan`, next to `withTenantTransaction`). The credential's DSN is a worker-process-only environment variable; the API's env schema never declares it. That absence is not a convention to remember — it is the proof: a process whose schema doesn't declare the variable cannot construct the pool, and `withCrossWorkspaceScan`'s pool is built lazily from that variable, so merely importing the package from the API process constructs nothing.

**Rejected: `SET LOCAL ROLE` on the existing tenant pool.** Switching role for the duration of a scan, on the same connection everything else uses, would have reused infrastructure instead of adding a second pool. It was rejected because it requires `GRANT mega_crm_scan TO mega_crm_app` — and the API connects as `mega_crm_app`. Granting the membership needed to make `SET LOCAL ROLE` work on the worker's pool would, by construction, also make it available to the API's identical login role. The claim this design exists to make provable — "the API process holds neither the scan role's credentials nor membership in it" — becomes false the moment that grant exists anywhere in the cluster, regardless of whether the API's code path ever exercises it.

**Rejected: keeping the session-flag GUC, with narrower policies.** The GUC pattern's actual weakness was never the policy predicates (those were already narrowable) — it was that any code holding the tenant pool can execute `SET`. The GUC is a convention enforced by code review, not an identity the database itself distinguishes. A login role is enforced by the connection handshake; nothing at the SQL layer can forge it.

**Reversibility:** costly. Four consumers in this phase adopt this exact shape (campaign-scheduler, flow-segment-sweep, flow-reconciliation, and analytics-reconciliation), and Phase 11's reconciler and Phase 12's sweep adopt it too. Changing the shape later means re-touching every consumer and the negative-test suite that proves the API cannot reach the role.

**The one consumer that could not adopt this shape: DEFAULT-partition relocation.** The scan role's whole design rests on owning no tables — an acceptance criterion of this phase, not an incidental property — but the DEFAULT-relocation procedure's ATTACH step issues `ALTER TABLE ... ATTACH PARTITION`, which Postgres requires table ownership to run. Granting the scan role that ownership, or membership in the owning role, would defeat the boundary this whole design exists to build; `mega_crm_scan` cannot be the answer for this one call site. Three shapes were considered at the plan 10-06 checkpoint: (a) restructure relocation to always attach an empty child and move rows afterward through the ordinary tenant-scoped path; (b) an operator-only elevated DSN, held only by the relocation CLI, for the ATTACH step specifically; (c) keep one marker-gated policy on `contacts`/`sends`, scoped to the app role. Option (b) was chosen: it keeps Phase 9's UAT'd build-then-attach operator procedure unchanged, and the elevated credential is held by no long-running service — the CLI is already operator-invoked and already builds its own dedicated pool, so a second, RLS-bypassing pool for this one step is a natural fit, not a new class of always-on risk. The credential is a real, documented bypass capability (Pitfall 9's warning applies), which is exactly why it is scoped this narrowly: one CLI script, one env var never declared in any service's schema, structurally asserted absent from `apps/api/src` and `apps/worker/src`.

Role attributes, the grant/policy matrix per table, the migration that first wires it, and the DEFAULT-relocation elevated-DSN credential: [`SPECIFICATION.md` §3, §4.3](./SPECIFICATION.md).

---

## 8. The Better Auth tables sit behind their own login role

Better Auth's seven tables (`user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`) carry no Row-Level Security at all — the same non-tenant Drizzle pool that resolves a workspace slug historically also served every one of Better Auth's own reads and writes, connecting as `mega_crm_app`, the same role every tenant-scoped query runs as. `session.token`, `account.password` and `verification.value` are the highest-value secret-bearing rows in the database after a tenant's SendGrid key, and until this plan they were reachable by any query issued through that pool.

**Decision:** a dedicated `mega_crm_auth` login role, reached through its own connection pool (`authDb`, built from its own `AUTH_DATABASE_URL`), holding exclusive `SELECT, INSERT, UPDATE, DELETE` on all seven tables. `mega_crm_app` is revoked entirely from `session`, `account` and `verification`; it keeps `SELECT` on the four workspace-shaped tables (`organization`, `member`, `invitation`, `user`) plus `UPDATE` on `organization`, matched exactly to the live query sites `workspace-lookup.ts`, `workspaces.ts`, `invites.ts` and `members.ts` genuinely use outside Better Auth's own adapter. `organization.id` is the value every one of the 22 tenant `workspace_id` columns FKs to and every `workspace_isolation` RLS policy casts against — that is why the four workspace-shaped tables stay app-readable rather than moving behind the boundary wholesale, while the three genuinely secret-bearing tables do not.

**Rejected: row-level security on the auth tables.** Better Auth's adapter sets no session GUC (unlike the tenant pool's `app.current_workspace_id`), so a policy on these tables could only key on connection role — which a `GRANT`/`REVOKE` partition expresses more directly, without adding a policy layer that does the same job worse. The concrete cost of getting this wrong is Pitfall 12: a naive RLS policy copy-pasted onto these tables returns **zero rows** to every Better Auth query, with no SQL error — signup, login and session validation all break platform-wide, silently, because Better Auth's own code has no reason to suspect the rows it wrote are being filtered back out of its own reads.

**Rejected: moving the seven tables into a separate `auth.*` schema.** The alternative boundary shape — `REVOKE ALL ON SCHEMA auth FROM mega_crm_app` instead of seven table-level revokes — was considered and rejected because `organization` is the FK target of all 22 tenant tables plus `member` and `invitation`; moving it (and its six siblings) to a new schema is the highest-risk migration available for the same end state, touching every foreign key in the schema for a boundary a grant partition achieves without moving a single table.

**Reversibility:** one-way. Grant revocations ship as forward-only migrations under DB-07's rollback model — undoing them means writing and shipping another migration, not rolling back this one. The acceptance gate is the auth-flow end-to-end suite (`apps/api/src/modules/auth/__tests__/auth-boundary.test.ts`): signup, login and invite-accept all run against the real server and the real database, never a mock, because Pitfall 12's failure mode is precisely the kind a mock cannot surface.

**The checkpoint-accepted caveat: `mega_crm_app` owns all seven tables, and an owner can always `GRANT` itself back in.** Table ownership did not move as part of this migration — moving it was considered at the plan 10-09 checkpoint (option-c) and rejected, because migrations apply as `mega_crm_app`, and an owner-less `mega_crm_app` would be unable to alter these tables without a privileged out-of-band step for every future Better Auth schema change. The checkpoint selected option-a (ship the grant matrix as audited, accept the caveat) over option-c (move ownership, close the caveat, accept the migration-authoring cost) and option-b (also leave `mega_crm_app` with privileges on `verification` "just in case" — rejected as an unjustified weakening of a secret-bearing table's boundary with no live query site evidence behind it). This migration is therefore a boundary against an application bug or an injected query, not against an attacker who already controls a session running as the owning role — documented here rather than left implicit, per the checkpoint's own instruction.

**Execution-discovered addition, beyond the checkpoint's application-level audit:** Postgres enforces every foreign key referencing `user` (from `account`, `session`, `member`, `invitation`) with an internal row-locking check that runs under the *referencing* table's owner — `mega_crm_app` — regardless of which role's connection performs the insert. That check requires `SELECT` **and** `UPDATE` on `user`, not `SELECT` alone (verified empirically; a `REFERENCES`-only grant does not substitute for it). Migration 0045 grants `mega_crm_app` `UPDATE` on `user` and `REFERENCES` on `organization` for this reason alone — no first-party application source performs `UPDATE "user"` outside Better Auth's own `mega_crm_auth`-backed adapter, and the checkpoint's SELECT-only conclusion for `user` at the application layer is unchanged. Both grants exist purely to satisfy Postgres's own constraint-enforcement and DDL-authoring mechanisms, which a plan-time audit of `apps/api/src` query sites has no way to surface.

Grant matrix per table, `AUTH_DATABASE_URL`, and the `BETTER_AUTH_SECRET` production floor: [`SPECIFICATION.md` §3, §4.1, §4.3](./SPECIFICATION.md).

---

## 9. The send delivery state machine

Every row in `sends` moves through a small set of statuses, and this section names, for every transition, the single component allowed to write it. That matrix is reviewed here, before any code in `send-dispatch.ts` changes (Phase 11 D-18) — the alternative, deciding "who resolves this row" ad hoc inside three different files as each is edited, is exactly how the duplicate-write race this phase exists to close would reappear. `packages/delivery-core/src/send-state-machine.ts` is the executable mirror of everything below: the same six statuses, the same transitions, the same writers, expressed as a `satisfies Record<SendStatus, ...>` matrix so an undocumented status is a `npm run typecheck` failure rather than a drift nobody notices.

```mermaid
stateDiagram-v2
    [*] --> dispatching: claim tx INSERT (id = uuidv5(intent))
    dispatching --> sent: unit 3, SendGrid 2xx
    dispatching --> failed: unit 3, SendGrid permanent 4xx
    dispatching --> reconciling: ambiguous throw or interrupted redelivery
    dispatching --> reconciling: stale-dispatching sweep
    reconciling --> sent: webhook evidence found
    reconciling --> unknown: resolution window elapsed, no evidence
    unknown --> sent: late evidence within re-scan horizon
    unknown --> unknown: horizon passed, immutable
    sent --> [*]
    failed --> [*]
    excluded --> [*]
```

### Per-transition writer matrix

| From | To | Writer(s) | Trigger |
|---|---|---|---|
| `dispatching` | `sent` | send worker | unit 3, SendGrid 2xx response |
| `dispatching` | `failed` | send worker | unit 3, SendGrid permanent 4xx response |
| `dispatching` | `reconciling` | **send worker AND reconciler** | send worker: unit 3 ambiguous throw (timeout/`ECONNRESET`/fail-closed default) or interrupted redelivery (a prior claim survived with no terminal write); reconciler: stale-`dispatching` sweep (age exceeds the max-job-lifetime threshold, no interrupted detection ever ran) |
| `reconciling` | `sent` | reconciler | webhook evidence found in `send_events` for this `send_id` |
| `reconciling` | `unknown` | reconciler | resolution window (~24h) elapsed with no evidence |
| `unknown` | `sent` | reconciler | late evidence found within the re-scan horizon (~72h) |

`dispatching -> reconciling` is the only row with two writers, and it is deliberate, not an oversight: the send worker observes the ambiguous/interrupted case in-band, at the moment it happens; the reconciler observes the stale-age case out-of-band, on its own tick, for rows no worker ever came back to report on. Every other row above has exactly one writer, and every transition whose `From` column is `reconciling` or `unknown` has the reconciler as that sole writer — nothing else is permitted to move a row out of either state.

### Why the reconciler never writes `failed`

`failed` means "SendGrid synchronously rejected the send with a permanent 4xx" — a fact only the job processor can observe, at send time, because it is the one holding the live HTTP response. A webhook is asynchronous, positive-only evidence: SendGrid tells you what a message *did* do, and it has no event that proves a message was *never* accepted. Give the reconciler a `-> failed` transition and it would be asserting a fact it has no way to know. **No `reconciling -> failed` transition exists in this matrix, and none should ever be added** — the matrix above has exactly two terminal writes leaving `reconciling`/`unknown` — `-> sent` (evidence found) and `-> unknown` (resolution window elapsed) — and no third option.

### Delivery model (DLV-07)

The platform's guarantee is **at-most-once at the SendGrid-acceptance boundary**: it never knowingly re-sends a message it cannot prove SendGrid did not accept. Retries are **effectively-once** strictly before acceptance becomes ambiguous — a 429/5xx response or a provably pre-connection failure (DNS failure, connection refused) proves the request either never left the process or was explicitly not accepted, so it is always safe to retry those cases with a bounded backoff.

A send that resolves to `unknown` is a deliberate, honestly-scoped trade-off, not a bug: it **may have reached the recipient, and it may have been lost** — SendGrid may have accepted it with no surviving webhook evidence, or evidence may exist but never have arrived. The platform will **not** re-send it automatically. Recovering a specific `unknown` send is a documented manual operator action; no re-send tooling exists in this milestone. Nothing in this system should ever claim stronger than this — no "no mail is ever lost", no guarantee of a single delivery attempt per message end to end — because the reconciler's own design (classification-only, no SendGrid calls, D-01) makes that claim provably false: guaranteeing no duplicates and guaranteeing no loss are in tension at the acceptance boundary, and this platform chooses no-duplicates.

### The `unknown` horizon

`unknown` is a terminal state in the sense that nothing but the reconciler may ever write to it or out of it, but it is not immediately immutable. Each reconciler tick also re-examines `unknown` rows younger than a bounded **re-scan horizon** and upgrades `unknown -> sent` if evidence has since appeared — late-arriving webhooks are not lost just because the row already resolved to `unknown` once. Only after that horizon passes does an `unknown` row become fully immutable: no future tick will look at it again. The **resolution window** (`reconciling -> unknown`, ~24h) and the **re-scan horizon** (`unknown -> unknown`/`unknown -> sent`, ~72h) are named here as concepts rather than numbers on purpose — their versioned constants, with rationale comments, live in `packages/delivery-core/src/reconciler.ts`, and restating the numbers here would just be a second place for them to go stale.

### `excluded` rows, and why rollups skip `unknown`

Not every row in `sends` passes through `dispatching`. `recordExcluded`/`recordFlowExcluded` insert `excluded` rows directly for contacts that never reach the claim gate at all — suppressed, unsubscribed, or frequency-capped before any SendGrid attempt is ever made — which is why the diagram above shows `excluded` as its own terminal state with no incoming edge from `dispatching`. Daily rollups are computed from fact columns (`sent_at`, `delivered_at`, and siblings), never from `status` directly, which is also why an `unknown` row contributes to no rollup count: it has no fact column set, by definition, and a rollup built from facts has nothing to count it as.

---

## 10. Worker reliability: tenant fairness, drain budget, and multi-instance safety

### Tenant fairness

One tenant's send volume must never starve another tenant's, and neither ceiling may be confused with genuine SendGrid-wide backpressure. Two independent ceilings enforce this, keyed differently on purpose, both resolving to the SAME deferral path:

- **RPS ceiling** (`rate-limiter.ts`, keyed by `workspaceId` alone) — models the tenant's own SendGrid account rate limit. One ceiling per tenant regardless of which lane (broadcast/triggered) the send came from, because SendGrid enforces it against the tenant's single API key, not per queue.
- **Concurrency-cap ceiling** (`tenant-lane-semaphore.ts`, keyed by `workspaceId` + `lane`) — bounds how many of the worker's OWN slots one tenant can occupy at once, independently in each lane. Deliberately a different key than the RPS ceiling: the RPS ceiling models a fact about the tenant's provider account; the concurrency ceiling models a fact about this process's own finite slot pool, which is a per-lane resource, not a per-tenant-account one.

Both triggers — RPS exhausted, concurrency cap exhausted — return the SAME `{ outcome: "rate_limited", cause: "tenant_bucket" }` shape from `processSendJob`, and the worker wrapper defers that job via `job.moveToDelayed` + `DelayedError`, never `worker.rateLimit()`. This is the load-bearing distinction: `worker.rateLimit()` pauses the ENTIRE worker's draining for every tenant sharing that queue, which is exactly the WRK-01 bug this mechanism replaces. **Only genuine provider backpressure** (`cause: "provider_backoff"` — a SendGrid 429/5xx) may ever pause a worker via `worker.rateLimit()`; every tenant-scoped cause, no matter which of the two ceilings raised it, is deferred through the tenant-scoped path so every other tenant's jobs keep draining.

Facts and exact values: [`SPECIFICATION.md` §5.5](./SPECIFICATION.md).

### Drain budget

A job legitimately mid-dispatch when the process receives SIGTERM must be allowed to finish — killing it mid-flight produces exactly the ambiguous "SendGrid may have accepted it, the process died before recording it" scenario Phase 11's `reconciling` state and reconciler exist to resolve. Every occurrence still costs a resolution-window delay a correctly-sized grace period avoids outright.

`apps/worker/src/shutdown-budget.ts` derives the worker's own required stop-grace-period from the same constants the send-timing invariant already checks: the SendGrid call's own timeout, plus the claim and record transaction margins that surround it, plus an explicit safety margin covering a slow terminal write under load and ordinary scheduling jitter. The derivation is computed from imported constants, never hand-typed, so a future change to any input changes the published budget automatically instead of silently disagreeing with a stale number written down here.

**The container runtime's stop-grace-period MUST be set from this module's published value, never left at a runtime default.** Docker's unconfigured default (10s) is already shorter than the SendGrid call timeout alone, before either transaction margin is added. **This is now satisfied.** `docker/docker-compose.prod.yml`'s `worker.stop_grace_period` is `${WORKER_STOP_GRACE_PERIOD_SECONDS}s` — an interpolated variable only, never a literal. The deploy script (`scripts/deploy.sh`) resolves that variable at deploy time by running `node scripts/print-stop-grace-period.mjs` against the just-built worker image, and exports the result before invoking Compose; a compose-invariant gate (`scripts/validate-prod-compose.mjs`, run in CI) independently re-invokes the same publish script and fails the build if the compose file's resolved value ever disagrees with it. The mechanism this section named as a requirement is therefore, as of Phase 14, the thing that enforces itself: a hand-typed number can no longer drift silently, because nothing in the deploy path ever types one.

Exact constants and their current value: [`SPECIFICATION.md` §5.1](./SPECIFICATION.md).

### Multi-instance safety — stated precisely, not overclaimed

`upsertJobScheduler`'s registration dedup is **schedule-registration idempotency, not execution exclusivity.** Calling it on every boot guarantees at most one *schedule entry* exists in Redis for a given scheduler id — it says nothing about how many worker *processes*, pointed at that same Redis, execute a given tick. Two worker processes sharing one Redis can both receive and execute the same tick.

**Single-instance worker deployment is therefore an explicit constraint of this milestone, not an emergent property of any registration mechanism used here.** Nothing in `apps/worker` provides cross-process execution exclusivity for a repeatable tick, and nothing should be assumed to. A future move to multi-instance worker deployment must add its own execution-exclusivity mechanism before that move is safe — `upsertJobScheduler` alone does not become that mechanism merely by continuing to be used.

This is more tolerable than it sounds for the ticks that already exist: several tick bodies (`campaign-scheduler`, `flow-reconciliation`, `send-reconciler`, `flow-segment-sweep`'s per-flow walk) already claim their rows exclusively at the data layer (`SELECT ... FOR UPDATE SKIP LOCKED`), which makes a duplicated tick a harmless no-op race for THOSE ticks specifically — but that per-row claim is a property of each tick's own body, not a property `upsertJobScheduler` grants, and a future tick author must not assume it comes for free.

---

## 11. The daily-metric day-semantics contract (CMP-02/CMP-03)

Every number in `workspace_daily_rollup` answers the same question — "how many of X happened on day D" — and this section is the single place that says what "day D" means, so it is stated once and referenced, not restated with a subtly different meaning every time a new counter is added. This contract has to agree word for word with the one written into `packages/db/src/schema/workspace-daily-rollup.ts`'s own doc comment, because that file is read by the engineers changing the write paths and this one is read by everyone else — two descriptions of the same rule is the exact failure this section exists to prevent.

**The contract:**

1. `day` is always a UTC calendar day, never a local or session-timezone day. Every day-bucketing cast forces `AT TIME ZONE 'UTC'` explicitly — a bare `::date` cast on a `timestamptz` converts through the session's `TimeZone` GUC first, which would otherwise make the same row report a different day depending on which pooled connection happened to serve the query.
2. `sent_count` is bucketed by `sends.sent_at` — the SendGrid-acceptance timestamp. The reconciliation worker is its sole writer; the incremental webhook-driven path never sets it, because a dispatched send produces no webhook event of its own to trigger an increment from.
3. Every event-derived counter (`delivered_count`, `opened_count`, `clicked_count`, `bounced_count`, `unsubscribed_count`) is bucketed by the provider event's own `occurred_at` UTC day on the incremental path, and by the corresponding `sends` fact column's UTC day on the reconciliation path. The two must agree, because reconciliation is an absolute overwrite of whatever the incremental path already wrote for that `(workspace, day)` — a disagreement here silently corrupts the number reconciliation was supposed to correct.
4. `unknown` sends are excluded from every rollup count. They get their own visible count instead, in campaign progress and send-log stats (plan 13-03) — a marketer reading "sent: 40, outcome unknown: 3" sees an honest accounting; folding those 3 silently into either `sent_count` or a failure count would assert something the platform does not know to be true.
5. An increment for any day other than today (UTC) marks that day's row dirty (`dirtied_at`, migration 0056) instead of trusting the incremental write alone. The next reconciliation tick re-verifies every dirty day against a fresh scan of `sends`, then clears the mark — but only if the mark predates the sweep's own start time, so a second late event arriving mid-sweep is never lost to an unconditional clear. Lateness is judged purely by UTC calendar day, independent of how wide the reconciler's own standing window happens to be — an event arriving in the last minute before UTC midnight is still caught, which a window-edge-relative predicate would have missed.

**One discontinuity worth naming plainly, because an unexplained step change in a dashboard series is exactly the kind of thing that gets investigated as a bug months later:** the public unsubscribe route started incrementing `workspace_daily_rollup.unsubscribed_count` as of plan 13-08 — it never did before, because the increment function was unreachable from `apps/api` until that plan relocated it into a package both applications import. Daily unsubscribe counts are higher from that plan's deploy date onward for the same underlying tenant behavior; nothing about how a marketer unsubscribes changed.

Exact column names, the reconciliation window, and the dirty-day sweep's page limit: [`SPECIFICATION.md` §4.2, §5.1](./SPECIFICATION.md).

## 12. The erasure-and-evidence model (CMP-04)

A contact-deletion request sits at the intersection of two obligations that pull in opposite directions: the right to have personal data erased, and the platform's own need to later prove a send or a suppression was lawful. A hard `DELETE` satisfies the first and destroys the second. This platform's answer is **anonymize in place, retain the evidence skeleton, scrub the linked PII asynchronously** — never a hard delete of the contact row, and never a permanent skip of the scrub.

**Synchronous, inside the delete request's own transaction:** the contact row is anonymized — every PII-bearing column nulled (or emptied, for the one `NOT NULL` array column), the row and every foreign key pointing at it left in place — subscription status and suppression are resolved immediately so mail to that address stops before the request even returns, an auditable erasure record is written proving the erasure happened and when, and a scrub job is queued. All four of these happen in the one transaction the delete request opens; nothing about "erasure happened" is left to a later, unobserved step.

**Asynchronous, bounded and resumable:** a scrub worker walks the linked partitioned tables in checkpointed pages and rewrites their JSONB payloads. The mechanism is allowlist reconstruction, never a denylist — one table's evidence-bearing column keeps only a small, explicitly named set of provider fields (the event type, the provider's own message and event ids, delivery status, and similar forensic-but-not-personal fields); a free-text field capable of embedding the recipient's own address in prose, or a tenant-invented field nobody anticipated at design time, is gone by construction because it was never on the list to begin with — not because something scanned for it and failed to find it. A second linked table's freeform properties have no allowlist at all, because their key space is tenant-defined and cannot be enumerated in advance; that column is unconditionally rewritten to empty.

**Deliberately NOT scrubbed, and why:** the webhook ingress journal (`ingress_journal`) and its quarantine table (`send_event_quarantine`) are exempt from this scrub. Both are aged out by the same scheduled webhook-ingress retention step, on equal, independently-settable horizons measured in single-digit days — faster than a typical erasure's own completion window, so by the time an erasure would reach that data, retention has already disposed of it. The two tables age out differently, though: the quarantine table's rows are deleted outright, while an un-ingested journal row survives its own horizon as a payload-free tombstone, because it is still the only evidence an operator has that a batch was lost — deleting it would end the alert by destroying the signal, not by fixing the problem. Building a second scrub path into short-lived operational tables that are already self-pruning would add a real mechanism to close a window that closes itself first. The exemption holds only while both horizons stay shorter than an erasure request's own completion window — if either is ever lengthened past that window, the exemption stops being justified and this scrub's scope has to be reconsidered, not assumed.

**What survives on purpose, permanently:** foreign keys, event types, and timestamps — the shape of evidence that a send or a suppression happened lawfully, stripped of the personal content that would make it identify anyone.

**Known limitation, stated rather than left to be discovered:** a contact hard-deleted before this model existed has no retrofittable evidence trail. There is nothing to migrate, because the row is already gone — this is a fact about history, not a defect in the current design.

Exact column names, the retention horizons, and the allowlist's contents: [`SPECIFICATION.md` §4.2, §5.13, §5.15, §6.16](./SPECIFICATION.md).

## 13. The webhook ingestion, backfill, and replay flow (CMP-05/CMP-07/CMP-08)

A SendGrid Event Webhook batch crosses four trust boundaries before it becomes a row this platform will act on, and the order they happen in is itself part of the design: verify the batch is genuinely from SendGrid and recent, durably record that a verified batch arrived, only then act on its contents, and keep a recovery path for every place a batch can still be lost after all of that.

**Order of operations, and why each step is where it is:** the request's signature and header timestamp are verified first, against the raw, unparsed bytes — parsing before verifying would let an attacker manipulate a JSON body between the byte string the signature was computed over and the object the platform actually reads. Only a batch that passes both checks is journaled — written to a durable table — and that journal write happens strictly before the batch is handed to the queue, inside the same request, so that a journal-write failure fails the request closed with nothing enqueued, rather than losing the batch's only record of ever having arrived. The route never falls back to enqueueing without a successful journal write; SendGrid's own retry window is the sole recovery path for that specific failure.

**Once journaled and queued**, each event's own provider-supplied timestamp is bounded to a narrow window before it is allowed to choose a partition or enter the dedup key — an event outside that window is quarantined individually, without failing the rest of the batch, because one manipulated or clock-skewed event should not cost every other event in the same delivery. Deduplication itself is keyed on `(workspace_id, send_id, event_type, occurred_at)` — a server-observed compound key — rather than the provider's own event id, because that id was found to be unstable across SendGrid's own redeliveries: a redelivered event carrying a *different* provider id used to insert a second row and double-count delivered/opened/clicked metrics. The provider id is retained as a forensic column, demoted out of the identity the platform relies on for correctness.

**Recovery from loss after receipt** has two paths at two different scales. A scheduled sweep periodically finds journaled batches that were never marked ingested and replays them through the identical path a live request would take — bounded by an attempt cap and a page limit per tick, so a systemic failure cannot turn the sweep itself into an unbounded resource drain. For a known incident affecting a specific window, an operator-invoked tool replays an explicit workspace and time range directly, without waiting for the sweep's own schedule. Both paths converge on the same durability guarantee: a verified batch that reached the platform is never silently lost to a crash between "received" and "processed," only ever delayed until the next opportunity to finish processing it.

Exact windows, queue names, and the dedup key's construction: [`SPECIFICATION.md` §4.2, §5.13, §6.8](./SPECIFICATION.md).

## 14. Deployment topology

**Six containers on one VPS, everything containerized under `docker compose`** — Postgres, Redis, `api`, `worker`, Caddy (`web`), and a one-shot `migrate` service that shares the `api` image rather than owning a separate build. Only `web` publishes a port to the host (80/443, the pair ACME's HTTP-01 challenge and the served HTTPS site both need); every other service is reachable only on the compose network. `api` and `worker` are therefore only observable from outside their own containers through their Docker health status, never through a direct HTTP call from the host — which is why both containers' healthchecks probe `/readyz`, not just `/healthz` (§9 above; [`SPECIFICATION.md` §6.17](./SPECIFICATION.md)).

**Images are named by SHA, immutably, never by a mutable tag.** Every first-party image (`api`, `worker`, `web`) is pushed to GHCR tagged with the full git SHA of the commit that built it, and nothing in this repository's CI ever pushes or pulls `latest`. This is what makes "deploy commit X" and "what is actually running" the same fact rather than two facts that can silently diverge — a mutable tag would let the registry serve different bytes under the same name at different times, defeating the entire premise of a reproducible deploy. `db` is the one exception: it is built locally from `docker/postgres/Dockerfile` (an OS-package layer on top of the official Postgres image, not application code) rather than published to GHCR, because it changes rarely and the extra publish-pipeline machinery was judged not worth adding for an image an operator rebuilds by hand on the occasions it changes.

**The connection budget is a table, not an assertion — it is the evidence D-09's deferral of PgBouncer rests on.**

| Consumer | `max` | Runs in |
|---|---|---|
| `db` | 10 | `apps/api`, `apps/worker` |
| `auth` | 10 | `apps/api` |
| `tenant-context` | 20 | `apps/api`, `apps/worker` |
| `tenant-context-scan` | 5 | `apps/api`, `apps/worker` |
| `worker-partition-maintenance` | 2 | `apps/worker` |
| `worker-dead-letter` | 2 | `apps/worker` |
| every `packages/db/scripts` operator CLI | 2 each (`PG_POOL_DEFAULT_MAX`) | one process at a time, never concurrent with itself |
| `migrate-runner.mjs`'s dedicated `pg.Client` | 1 (not a pool; excluded from the sum below) | only during the one-shot `migrate` step |
| `pgbackrest` sidecar's control connection | 1 superuser Unix-socket connection (not one of this codebase's `pg.Pool`s) | only during a scheduled backup/check |

Summed for one instance each of `apps/api` and `apps/worker` — the steady-state figure the deferral actually rests on — `apps/api` contributes 10+10+20+5 = **45** and `apps/worker` contributes 10+20+5+2+2 = **39**, for a total of **84**. `docker/docker-compose.prod.yml`'s `PG_MAX_CONNECTIONS` env var sets Postgres's own `max_connections` server parameter to **200** by default, not merely "more than 84": the higher figure deliberately covers a rolling-restart transient that can briefly double the single-instance sum (84 → ~168), Postgres's own `superuser_reserved_connections`, and operator CLIs running concurrently with the services. `scripts/validate-prod-compose.mjs` fails the build if the configured `max_connections` ever resolves to 84 or below — the table above is not a one-time calculation trusted forever, it is the number a CI gate re-derives against on every change.

**This table is exactly D-09's deferral of PgBouncer, made checkable.** The Technology Stack section recommends PgBouncer "before an incident, not after." Phase 14 defers it deliberately, and this table is the argument for why that is safe today rather than an assertion that it is: headroom exists between the steady-state sum and the configured ceiling, with margin for the transients the table's own footnotes name. The revisit trigger is real pressure against this number — observed connection exhaustion, a growth in replica count for either process, or the summed maxima climbing toward `PG_MAX_CONNECTIONS` — not a fixed date. Sizing derivation, the minimum-viable-VPS arithmetic this budget sits inside, and the revisit trigger's exact wording: [`docs/runbooks/production-topology.md`](./docs/runbooks/production-topology.md). Exact env var names and pool sizes: [`SPECIFICATION.md` §3.8, §5.17](./SPECIFICATION.md).

## 15. Migration gating

A production migrate step has exactly one job: apply every shipped migration exactly once, refuse to run concurrently with itself, and fail loudly rather than let a stale schema serve traffic. `scripts/migrate-runner.mjs` is that one-shot step — it opens a single dedicated connection (deliberately never a pool, because the guarantee below depends on the lock living and dying with one specific connection's lifetime), takes a Postgres advisory lock under a bounded retry budget, applies the shipped migration chain through the same programmatic migrator the rest of this codebase already trusts, and releases the connection. **The connection discipline is half the guarantee, not an implementation detail**: a session-scoped advisory lock is held by a connection, not by a transaction or a process id, so the only way to prove a crashed runner cannot leave a lock behind is to prove the lock dies the instant its one connection does — which is exactly what a dedicated, never-pooled connection makes true by construction, and exactly what a pooled connection would make false (a pool can hand the "same" logical connection to a different logical caller after a crash, or keep the physical socket alive across what the runner believed was its own lifetime).

**The retry is bounded, and a lock held by a foreign session is a loud failure, never a silent fall-through to migrating anyway.** Running the migrate step and applying migrations are two different claims — a runner that cannot acquire the lock must say so and exit non-zero, not proceed as though the lock did not matter. This is the ordering `scripts/deploy.sh` depends on: it runs `docker compose run --rm migrate` as an explicit, checked-exit-code step, strictly before any application container is replaced, and never expresses that ordering through a Compose `depends_on` completion condition — a documented Compose behavior can re-trigger a completed one-shot container on a later `up`, which would silently re-run a migrate step believed finished.

**Readiness independently re-verifies applied-versus-shipped, so a mis-sequenced container start cannot serve a stale schema even if the migrate step were somehow skipped.** `/readyz` on `apps/api` (§9 above) is not merely "did the migrate step run" — it asks the database directly, on every poll, whether every shipped migration is actually applied, using the same shared definition of "applied" the migrate runner itself uses. A container that starts serving before migrations land answers unready, by construction, regardless of what deploy step it thinks already ran. This is also why the deploy script waits on `/readyz` rather than a timer: a timer can be fooled by a slow migration finishing later than expected, and a direct database check cannot.

Exact lock key, retry budget, the shared "applied" definition, and `/readyz`'s response contract: [`SPECIFICATION.md` §5.17, §6.17](./SPECIFICATION.md); operator procedure: [`docs/runbooks/deploy-and-rollback.md`](./docs/runbooks/deploy-and-rollback.md), [`docs/runbooks/migration-rollback-and-roll-forward.md`](./docs/runbooks/migration-rollback-and-roll-forward.md).

## 16. Backup and point-in-time recovery

**Continuous WAL archiving plus scheduled backups to an off-host, encrypted repository** is this platform's first disaster-recovery path. The two are different guarantees and both are needed: WAL archiving alone gives point-in-time coverage but an unusably slow restore (replaying every WAL segment since the beginning of time), while scheduled backups alone give a fast restore but only to the moment of the last backup. Together, a restore replays the nearest preceding full/differential/incremental backup and then applies only the WAL since that backup to reach an arbitrary target moment.

**The mechanism that makes WAL archiving real, not merely configured, is that the archiving tool lives inside the database's own container.** `archive_command` is executed by the Postgres server process itself — a sidecar-only installation of the backup tool would produce a configuration that looks complete in every file this repository ships while zero WAL ever actually leaves the host, and that gap is invisible until the first restore is attempted. The database image is therefore the official Postgres image with the backup tool added on top, not a separate sidecar-only concern; a second, sidecar container shares that same image and runs the scheduled full/differential/incremental backups and the tool's own verification command on a cron-style schedule, sharing the database's data volume read-only and a Unix-socket volume for its own control connection.

**What a restore actually restores** is the full disaster-recovery path for anything this platform has ever done to its own primary datastore — not merely the row-level state Phase 9-13's application logic manages, but the schema itself, every role, and every grant. The repository is off-host object storage, encrypted with the backup tool's own repository cipher independent of whatever the storage provider offers at rest, so a compromise of the VPS alone does not also compromise the backup, and a compromise of the bucket alone does not yield readable data without the separately-escrowed cipher passphrase.

**The recovery-point and recovery-time expectations the cadence produces:** the recovery point is bounded by continuous WAL archiving, not by the backup schedule — on the order of seconds behind real time, as long as archiving is keeping up (a fact the tool's own verification command can confirm, and a fact this repository's observability surface names explicitly rather than merely implying, [`SPECIFICATION.md` §7](./SPECIFICATION.md)). The recovery time is bounded by restoring the most recent full backup plus, at most, one day's differential plus a few hours of incrementals — the weekly-full/daily-differential/multiple-daily-incremental cadence is a deliberate size-for-restore-speed trade, not a default: a restore only ever needs the full plus the single latest differential (never a chain of incrementals to replay on top of each other), which is what keeps restore time bounded even as the repository accumulates history between fulls.

**"Configured" and "backed up" are different claims, and this document does not conflate them.** A passing verification of the archive configuration and repository reachability proves the configuration is coherent; it does not prove a restore actually works. Only an actually-performed restore proves that, which is why this platform's backup requirement and its restore-drill requirement are two separate, deliberately sequenced obligations rather than one. Cadence, retention window, and the drill's own procedure: [`docs/runbooks/backups.md`](./docs/runbooks/backups.md), [`docs/runbooks/restore-drill.md`](./docs/runbooks/restore-drill.md).

## 17. Retention

**Partition drop is the deletion mechanism** for the range-partitioned tables this platform has always maintained the leading edge of (§6 above) — retention is the same idea applied to the trailing edge. A monthly partition whose data has aged past a versioned horizon is detached and dropped wholesale, catalog-driven the same way partition creation is (never by a table-name pattern, and never by a row-level `DELETE`, which on a table this size would be the slower and more lock-contentious of the two mechanisms for the same end state).

**The horizon is deliberately narrower than "keep everything," and the exclusions are deliberately named rather than left to a blanket rule.** A small, explicitly-named set of evidence-bearing tables — the send ledger, the daily rollups, subscription-status history, erasure records, and the suppression list — are excluded from this mechanism entirely, because each one exists specifically to prove something happened lawfully (a send occurred, a suppression was honored, an erasure was requested and completed) and that proof has to outlive the operational data it describes. Retention on the horizon-bearing tables is therefore a claim about operational data going stale, not a claim that the platform's compliance obligations have an expiry date.

**The combined recovery horizon is arithmetic across two numbers, and neither one alone answers the question a reader actually has.** Once a partition is dropped, its data is recoverable *only* from a backup, and *only* for as long as that backup has not itself expired — the partition-retention horizon and the backup-repository's own retention window are therefore not independent facts; the second one is the actual ceiling on how far back the first one's deletions can ever be undone. A twelve-month partition-retention horizon paired with a two-week backup-repository window means the true "how far back can we still recover a dropped partition's data" answer is bounded by the shorter of the two — which is why widening the backup-repository's retention window is a documented precondition to enabling partition-retention deletion at all, not a separate, unrelated operational choice. The feature flag governing whether this mechanism ever runs stays off until that precondition, and a real, actually-performed restore drill proving the backup path itself works, are both satisfied — "configured" and "safe to enable" are different claims here for the same reason they are in §16 above.

Exact horizon value, the excluded-table list, the flag name, and the backup-window widening procedure: [`SPECIFICATION.md` §4.7, §3.8](./SPECIFICATION.md), [`docs/runbooks/data-retention.md`](./docs/runbooks/data-retention.md).

---

## 18. The correlation model

One request produces work across three boundaries — an HTTP request, a
BullMQ job it enqueues, a Postgres transaction that job opens — and an
operator following one send through an incident needs all three to answer
to the same question: which lines, in which log file, belong to this one
thing. The correlation model is what makes that question answerable without
reconstructing the answer by hand from timestamps and guesswork.

**A single AsyncLocalStorage store, not four separate mechanisms.**
`packages/tenant-context`'s ALS store holds one object —
`{ workspaceId?, requestId?, jobId?, sendId? }` — and every field is
optional independently, because a repeatable-tick job (partition
maintenance, a scheduled campaign tick) has a `jobId` but no `requestId`
that originated it, and a webhook-triggered job has both. **The store must
merge, never replace, across nested scopes.** `withTenant` and
`withCorrelation` are the only two writers, and both spread the *current*
store forward before adding their own fields, regardless of which nests
inside the other. This is not a stylistic preference: `AsyncLocalStorage.run()`
replaces the entire store for its callback by default, and a naive nested
call would silently drop whatever the outer scope had already set —
`requestId` disappearing the moment a handler opens a tenant-scoped
transaction, discovered as a real pitfall, not a hypothetical one. The
single reader, `getCorrelationContext()`, returns `{}` outside any scope and
never throws — a logging call site should never crash because correlation
context happens to be absent, even though `getWorkspaceId()` and
`withTenantTransaction` still throw when a real workspace binding is
required and missing, which is a distinct guarantee from the logging path's
own leniency.

**The same fields cross into Postgres itself**, not just into log lines.
`withTenantTransaction`'s existing `set_config` call composes
`req=<requestId or -> job=<jobId or ->` into the same connection's
`application_name`, in the same round trip that already sets the tenant's
RLS session variable — no new query, no schema change. An operator staring
at `pg_stat_activity` during an incident sees which request or job opened
each live connection, without a second correlation mechanism for the
database layer specifically. Postgres itself truncates `application_name`
silently at 63 bytes; this codebase truncates deterministically first, on a
whole-character boundary, so a long id is cut predictably rather than
possibly mid-character by whichever truncation happens to run first.

**The mechanism is uniform; which fields land on a given line is not.** Both
Pino instances (`apps/api/src/logger.ts`, `apps/worker/src/logger.ts`)
install a `mixin()` that reads `getCorrelationContext()` on every log call —
no call site passes a correlation field explicitly, and neither logger file
declares its own list of what to attach. What varies is not the mechanism
but which scopes happen to be open at the point a given line is emitted:

- `workspaceId` — bound by `withTenant`/`withTenantTransaction`, so present
  once a tenant scope is open; absent on boot-time lines and on API lines
  emitted before a workspace is resolved.
- `requestId` — bound once per HTTP request by `apps/api/src/server.ts`'s
  `onRequest` hook, carried onto the `email-broadcast` job payload by the
  campaign test-send route, and rebound by `wrapProcessor`; absent on jobs
  whose schema declares no such field (repeatable ticks, webhook-originated
  jobs).
- `jobId` — bound by `wrapProcessor` for every job in every queue; never
  present on an `apps/api` line.
- `sendId` — bound by the three post-claim dispatch scopes in
  `apps/worker/src/queues/send-dispatch.ts` (campaign, test-send, flow) and
  by the per-event scope in `apps/worker/src/queues/webhook-events.worker.ts`,
  so a dispatch line and a provider-event line for the same send join on one
  value. NOT present on `wrapProcessor`'s own job-completed/job-failed
  lines, because those run as the external awaiter of an already-settled
  `withCorrelation` promise and Node's AsyncLocalStorage does not propagate
  a settled `run()` call's store into such a continuation — the same
  empirically-verified behaviour `ProcessorErrorContext`'s header already
  documents for the Sentry reporter. Not present on any `apps/api` line
  either: the API process never dispatches a send.

A Loki query filtering on one of these fields returns the lines where that
scope happened to be open — a real and useful subset, not every line the
process emitted.

`apps/worker`'s own job-processing wrapper (`processor-wrapper.ts`) is what
makes a BullMQ job carry a `requestId` at all: `wrapProcessor` opens a
correlation scope keyed by `job.data.requestId` when the job's schema
declares one; when the payload carries none, the field stays genuinely
unbound — no substitute value is put in its place
(`processor-wrapper.ts:196`, the WR-03 fix). The substitution it replaced
made `requestId` indistinguishable from `jobId` in every log line and
Sentry tag for every queue except the two send lanes, collapsing what
should be two independent correlation axes into one; `jobId` alone still
carries job-level correlation on those jobs, and `composeApplicationName`
already renders the unbound case as a `req=-` placeholder rather than an
empty or malformed `application_name`. The field name is deliberately camelCase
(`requestId`, not `request_id`) everywhere it appears — in the ALS store, in
every log line, and in the Grafana Cloud correlation query
(`docs/observability/grafana-cloud-alerts.md`) — because a query written
against the wrong casing does not error, it silently matches nothing.

Exact field list, the `application_name` byte budget, and the mixin
implementation: [`SPECIFICATION.md` §7](./SPECIFICATION.md).

## 19. Error-tracking topology

**Three Sentry projects, one shared scrub hook, applied before any of
them.** `apps/web`, `apps/api` and `apps/worker` each report to their own
Sentry project — not because they need different scrubbing rules, but
because a frontend error and a backend error are different audiences for
the same incident, and mixing them into one project makes triage slower for
both. All three share exactly one redaction function
(`sentryBeforeSend`, `packages/redaction`), never three separately
maintained scrub implementations that could drift apart from each other or
from `scrubbedConsole`'s own rules.

**The ordering rule is the load-bearing one: the redaction gate must be
proven correct before any `Sentry.init()` call exists anywhere in the
codebase, and stays a blocking CI check forever after.** Sentry has no
retroactive redaction — the only remedy for a secret or a contact's PII
reaching a live Sentry project is deleting that project's entire event
history, which is not a remedy anyone wants to reach for. The fixture test
proving `sentryBeforeSend` strips a planted needle from a full event
serialization runs as a named, blocking step inside the `static` CI job —
already a required check under branch protection — specifically so this
gate became blocking immediately, with no separate repository-admin action
needed to make it so.

**Tracing and profiling are structurally absent, not merely configured
off.** `tracesSampleRate: 0` on every SDK is one layer of that guarantee;
the frontend SDK additionally never imports `replayIntegration()` or
`browserTracingIntegration()` at all — a second, independent layer of the
same guarantee, because a sample rate pinned to zero is a runtime
configuration a future edit could silently change, while an integration
that was never imported cannot activate no matter what configuration value
gets set.

**Correlation reaches every captured event, through one seam, not through
each call site remembering to tag its own capture.** Both backend SDKs
attach `workspace_id`/`request_id`/`send_id` (`worker` also `job_id`) via a
single `Sentry.addEventProcessor` reading `getCorrelationContext()` — the
same correlation store §18 describes. The frontend has no per-request ALS
context (there is no server-side request in a browser), so it tags `route`
and `workspace_slug` instead, parsed from the URL at the moment of capture.

**A verified, honestly-documented residual gap:** a workspace id is only
present on a captured event when it was known *explicitly* at the point of
capture (from job payload data on the worker side, from an
explicitly-passed value on the API side) — not from `getCorrelationContext()`
alone, in either process. This was traced to a real, empirically-confirmed
property of `AsyncLocalStorage`: it does not propagate a nested scope's
store into a continuation registered by an outer `await`er after that
scope's own promise has already settled, which is exactly the position a
processor's catch block or a route's error handler executes in. `request_id`
does not share this gap (it is bound once, at the outermost hook, before any
nested scope exists) — only `workspace_id`, bound inside a nested scope
deeper in the call stack, does. Closing it fully would mean threading an
explicit workspace value through roughly ten route modules on the API side —
judged out of this phase's scope, and recorded here rather than silently
left to be rediscovered.

Exact DSN/environment variable names, the fixture test's five scenarios,
and the `RouteErrorBoundary` frontend integration:
[`SPECIFICATION.md` §7](./SPECIFICATION.md).

## 20. Alerting topology: nine in-app watchdogs, two cloud backstop rules

Every alert this platform sends answers one of two fundamentally different
questions, and the split between them is deliberate, not incidental: **is a
specific business condition inside this platform unhealthy**, or **is the
platform itself still running at all.** The first question can only be
answered from inside a running process; the second question cannot be
answered from inside a running process, because the one thing that could
answer it — the process itself — is exactly what may have stopped.

**Nine independent dead-man's-switches live inside `apps/api`,** each
watching a distinct condition: partition-maintenance health, the send
reconciler's own progress, the dead-letter table, webhook-ingestion
stalls, sender reputation, and (added this phase, OPS-13) queue depth per
lane, the oldest pending job's age, webhook delivery lag, and the share of
sends failing outright. Every one of these shares three properties on
purpose: it runs in a process **separate from** whatever it observes (the
watcher and the watched must not share a failure mode), it claims an
alert-dedup slot under its **own** name so no watchdog can mask or be
masked by another, and it emails the same `OPERATOR_ALERT_EMAIL` through
the same platform-only SendGrid key — never a tenant's own BYO key,
because the tenant whose reputation is failing is exactly the tenant whose
own key is least likely to still be working. `ops_alert_state` (this
phase's own migration) is the shared dedup primitive the four newest
watchdogs claim against, generalizing the same atomic
claim-then-send-then-release-on-failure pattern the five earlier,
independently-tabled watchdogs already used.

**Every one of those nine watchdogs shares the exact same structural blind
spot, and it is the reason a tenth mechanism exists outside `apps/api`
entirely.** A watchdog that lives inside `apps/api` cannot report that
`apps/api` itself has stopped — the code that would report it is exactly
what stopped. If the VPS goes dark, Docker itself stops, or the container
OOM-kills without a restart, all nine in-app watchdogs fall silent at the
same instant their own alerting ability does.

**The answer is two Grafana Cloud alert rules, evaluated entirely outside
this platform's VPS, reading only the log stream a sidecar ships there
independent of any application process staying alive.** A no-logs-received
rule fires when the log volume this pipeline normally emits falls to
(near) zero — meaning something upstream of even the shipping sidecar has
stopped, not merely that the platform happened to be quiet, since a
healthy stack emits infrastructure-level log lines continuously even at
zero user traffic. An error-rate-spike rule fires on the coarse ratio of
`error`/`fatal`-level log lines across `apps/api`/`apps/worker`, entirely
independent of whether any specific in-app watchdog's own condition
happens to be tuned to catch the underlying cause. Both point at the same
operator inbox every in-app watchdog uses — one contact point, not a
second parallel paging surface to maintain and eventually forget about.

**This is why the split is two locations, not one:** an alert that can only
run inside the process it protects is structurally blind to that process's
own death, and an alert that can only run outside the process has no view
of business-level conditions (a specific queue's depth, a specific
tenant's failure rate) that only the process itself can compute cheaply
and continuously. Neither location can replace the other; both are
required, and this phase's own closing state is both existing at once.

Exact thresholds, dedup windows, alert-name identifiers, and the LogQL
queries: [`SPECIFICATION.md` §7](./SPECIFICATION.md). Per-alert recovery
procedures: `docs/runbooks/queue-depth-alert.md`,
`docs/runbooks/oldest-job-age-alert.md`,
`docs/runbooks/webhook-lag-alert.md`,
`docs/runbooks/failed-send-share-alert.md`,
`docs/runbooks/log-shipping-and-backstop-alerts.md`; the Bull Board
observability UI's own access path: `docs/runbooks/bull-board-access.md`.

---

## Forward-looking — not yet true

Everything above describes code in this repository today. The items below do not exist yet and are named with the phase that introduces them, so nothing here can be mistaken for a description of the current system.

- **Phase 10 — RLS unification.** Two policy variants exist, and one of them errors rather than returning zero rows when no tenant is in scope on a recycled connection. Unifying them must go in the fail-closed direction. The current behaviour of both is pinned by tests in `packages/tenant-context` labelled as a pre-change baseline.
- **Phase 11 — the delivery state machine.** Dispatch has no timeout mechanism, so a timeout and a connection reset are indistinguishable to it today, and both resolve to a terminal failure. A reconciling state is planned. Three assertions encode the current terminal outcome and are listed by name in [`docs/failure-injection-scenarios.md`](./docs/failure-injection-scenarios.md).
- **Phase 12 — worker reliability.** Per-tenant concurrency caps now exist (§10 above). Queue retention is no longer open either — plan 12-09 bounded `removeOnFail` to a 7-day age now that the durable dead-letter path (plans 12-07/12-10) records every terminal failure in Postgres before the Redis record ages out; the shipped policy and its rationale are documented in [`SPECIFICATION.md` §5.3](./SPECIFICATION.md). What genuinely remains open is the queue's behaviour when its backing store reaches its memory ceiling.
- **Phase 14 — deployment and database durability.** Largely no longer forward-looking: container images, a deployment manifest, application health endpoints, migration gating, backup/PITR and retention all now exist and are described in §14-§17 above. What genuinely remains open, all gated on a real host this repository's own development environment cannot provide: the first real deploy against a live VPS (plan 14-09), the first real off-host backup and WAL shipment (plan 14-10), and the first real point-in-time restore drill (plan 14-11) — all three stopped at a blocking human-verify checkpoint as of this writing ([`SPECIFICATION.md` §8.4](./SPECIFICATION.md)). **Real alerting is no longer forward-looking** — §20 above describes the nine in-app watchdogs plus the two Grafana Cloud backstop rules Phase 15 built on top of the observability surfaces §14-§17 describe. Postgres `verify-full` TLS in place of the current self-signed interim posture (D-10) remains open, gated on the same real-VPS precondition as the three Phase 14 items above.
- **Phase 15 — observability, alerting and frontend resilience.** The correlation model (§18), error-tracking topology (§19), and alerting topology (§20) all now exist as described above. What remains a flagged assumption rather than a proven fact: every OPS-13 threshold value (`QUEUE_DEPTH_THRESHOLDS`, `OLDEST_PENDING_JOB_AGE_ALERT_HOURS`, `RECONCILING_SEND_AGE_ALERT_HOURS`, `WEBHOOK_LAG_ALERT_MINUTES`, `FAILED_SEND_SHARE_ALERT_THRESHOLD`/`_MIN_SAMPLE_SIZE`) is a first estimate, not yet validated against real production load — each alert's own runbook (`docs/runbooks/*-alert.md`) names its governing constant and how to tune it from real operation. Whether logs actually reach Grafana Cloud Loki and whether both cloud backstop rules actually fire is an operator-provisioning dependency this repository cannot prove automatically — `docs/runbooks/log-shipping-and-backstop-alerts.md` is the operator's own verification procedure for that gap.
