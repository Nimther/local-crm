# Workspace Purge & Restore Runbook

Implements requirements **PRG-01**/**PRG-02** and decision **PT-02**
(`.planning/phases/22-workspace-quiesce-physical-purge/22-CONTEXT.md`): the
operator's end-to-end view of a workspace's life after its owner deletes it —
soft delete, quiesce, the report-only tick, the point of no return, restore,
and what a completed purge does and does not remove. This is the reference
for `apps/worker/src/queues/workspace-purge.worker.ts` (the state machine),
`packages/db/src/workspace-restore.ts` (the restore path) and
`packages/db/src/workspace-purge-report.ts` (the on-demand report) —
`docs/runbooks/workspace-purge-stuck-alert.md` is the triage runbook for one
signal inside this lifecycle, not a duplicate of it.

## The lifecycle

1. **Soft delete** — an owner deletes their workspace. This sets
   `organization."deletedAt"` and nothing else. No tenant row is touched, no
   mail already dispatching is recalled by this step alone.
2. **Quiesce — takes effect immediately, at every layer.** The instant
   `deletedAt` is non-null:
   - **Dispatch:** all three send paths (campaign, flow, test-send) and the
     campaign-kickoff fan-out refuse via the shared, fail-closed
     `isWorkspaceSoftDeleted` lookup (`packages/delivery-core/src/workspace-quiesce.ts`)
     — a job already queued when the delete happened is still refused, not
     just newly-enqueued work.
   - **Discovery:** `campaigns_scan`/`flows_scan`/`flow_runs_scan` (migration
     `0070`) exclude the workspace from every cross-tenant scan a moment
     later — a `flow_run` genuinely stops advancing, it does not merely stop
     sending mail.
   - **Ingestion:** every API-key-authenticated surface (`/v1/events`,
     `/v1/contacts`) refuses with a typed 403 (`code: "workspace_deleted"`);
     the SendGrid webhook route drops the workspace's signed batch as the
     SAME bare 404 an unknown `pathToken` already returns, before signature
     verification even runs; a job already queued in `events-ingest`/`webhook-events`
     when the delete happened resolves quietly and writes nothing.
3. **The retention window runs.** `WORKSPACE_PURGE_RETENTION_DAYS` (default
   30, floor 7 — `apps/worker/src/env.ts`) days must elapse from `deletedAt`
   before the workspace becomes eligible for physical destruction. Nothing
   about the workspace changes further during this window beyond what
   quiesce already did in step 2.
4. **The tick announces the workspace one tick before touching it.** Once
   eligible, the daily `workspace-purge` tick (`WORKSPACE_PURGE_TICK_CRON`,
   default `17 3 * * *` UTC) inserts a `purge_records` row with a
   pre-destruction census — a row count for every one of the ~25 tables the
   purge will walk — and moves it to `reported`. Because the tick's own
   destructive phase always runs BEFORE its reporting phase within one tick
   (`apps/worker/src/queues/workspace-purge.worker.ts`'s own header comment
   calls this out explicitly), a workspace reported in tick N cannot be
   destroyed until tick N+1 — this is D-07's announce-then-act guarantee,
   encoded as ordering, not as a timestamp comparison an operator has to
   trust.
5. **The destructive walk runs**, one tick later. A per-workspace advisory
   lock (`PURGE_ADVISORY_LOCK_NAMESPACE`) makes this single-flight. The walk
   destroys every table in `packages/db/src/workspace-purge-tables.ts`'s
   `PURGE_TABLE_ORDER` (the single source of truth for exactly which tables
   this is — this runbook does not restate the list, so the two cannot
   drift) in bounded, checkpointed 500-row batches, in FK-safe order. The
   three tenant secret tables are destroyed last, by the same ordinary walk
   — not a bespoke path — so a purge that fails halfway leaves credentials
   intact for an easier resume. After every tenant table is empty, a second,
   privilege-scoped step deletes the workspace's `member`/`invitation` rows
   through a dedicated `mega_crm_auth`-authenticated connection (the ordinary
   worker connection cannot do this — Phase 10's own Better Auth trust
   boundary forbids it). Finally the workspace ends as an **anonymized
   tombstone**: `organization` is updated (`name`/`slug` overwritten,
   `"purgedAt"` stamped), never deleted — `deletedAt` itself is left
   untouched, so the row still tells you the workspace was soft-deleted, and
   now also when it was physically purged.

## What an operator can do at each stage

- **Print the census on demand**, without waiting for the tick's own report:

  ```bash
  npm run db:workspace-purge-report -- --workspace-id <workspace-id>
  # or, for every workspace whose retention window has already elapsed:
  npm run db:workspace-purge-report -- --all-eligible
  ```

  Read-only — no lock taken, no `purge_records` row written or changed. Ids,
  timestamps, statuses and per-table counts only; never a workspace name
  (that is the tenant's own identifying data, and this report has no reason
  to reproduce it).

- **Restore, right up to the first destroyed row, and never after:**

  ```bash
  npm run db:restore-workspace -- --workspace-id <workspace-id>
  ```

  `restoreWorkspace` clears `organization."deletedAt"` at any point up to
  and including the whole report-only window (step 4 above) — a `reported`
  workspace can still be restored, since nothing has been destroyed yet.
  **The moment the purge's first destructive batch has run
  (`purge_records.first_destructive_batch_at` is set), restore refuses
  unconditionally.** There is no override flag, no force parameter, no
  operator escape hatch — a partially-purged workspace must never come back
  live with some tables gone and others intact. Restoring also flips any
  `scheduled` campaign whose `scheduled_at` has already passed back to
  `draft`, in the same transaction as the un-delete — otherwise a restored
  workspace could find itself immediately, silently due to send mail on a
  schedule that expired while it was gone.

- **Watch for the stuck-purge alert.** `docs/runbooks/workspace-purge-stuck-alert.md`
  is the triage runbook for the tenth in-app watchdog
  (`apps/api/src/modules/ops/purge-watchdog.ts`) — read that runbook for what
  fires it and the exact recovery statement for a `failed` row. This runbook
  does not repeat that procedure.

## What a purge removes

Every table named in `PURGE_TABLE_ORDER`
(`packages/db/src/workspace-purge-tables.ts` — the frozen, single source of
truth; this file is deliberately not re-listed here so the two cannot
drift), plus:

- **The three tenant secret tables** — `workspace_sendgrid_keys` (the
  envelope-encrypted BYO SendGrid key), `workspace_suppression_keys` (the
  per-workspace suppression HMAC key), `workspace_webhook_endpoints` (the
  webhook trust anchors) — destroyed last, by the same ordinary walk.
- **`member`/`invitation` rows** for this workspace — the second,
  privilege-scoped step described above.

## What survives, and why

**State this prominently: an operator or auditor finding these rows after a
purge must be able to tell "correct by design" from "purge incomplete" at a
glance.** Four evidence sets survive every completed purge, on purpose, each
proving something that must outlive the tenant:

| Survivor | What it proves |
|---|---|
| **`erasure_records`** | Proof of every individual GDPR erasure this workspace ever performed while it was live. `contact_id` is set to `NULL` (migration `0069`) when the contact it once described is destroyed by this same purge — the row survives, only the now-dangling reference is cleared. |
| **The `purge_records` row itself** | The durable, PII-free record of the purge — the workspace id, when it was soft-deleted, when it was purged, and the per-table row counts destroyed. This is the workspace-level analog of `erasure_records`. |
| **Hashed `workspace_suppressions` rows** | Proof that suppression was honored for a given address, kept as immutable, timestamped evidence — never a readable email address (that column was removed entirely in migration `0061`, long before this phase). |
| **`workspace_daily_rollup`** | Count-only aggregate daily metrics — sending-history/dispute evidence. References only `organization`, never `contacts`, so it is never at cascade risk from the purge's contact-level destruction. |

Plus the **tombstoned `organization` row** itself, described above — every
FK from the four evidence sets above (and from any table this platform ever
adds that references `organization`) continues to resolve, forever.

## Cryptographic erasure

The per-workspace suppression HMAC key (`workspace_suppression_keys`) is
destroyed along with the other two secrets, in the same ordinary walk. This
matters specifically because of what it does to the surviving hashed
`workspace_suppressions` rows above: once the key is gone, those rows still
*prove* that suppression was honored for whatever address they represent,
but no one — including this platform — can ever again compute the same hash
from a plaintext address and match it back to one of those rows. The
evidence survives; the ability to re-identify the address it protects does
not.

## Known leftovers outside our control

The tenant's own SendGrid account may retain an event-webhook subscription
pointing at a `pathToken` path that now returns a bare 404 forever (see
"Quiesce" above). Deprovisioning that subscription
(`DELETE /v3/user/webhooks/event/settings/{id}` against the tenant's own
SendGrid account) was a deliberate scope cut for this phase — the
subscription lives in the tenant's own account, 404s harmlessly against the
tombstoned path, and the tenant can remove it themselves. See this phase's
own `COVERAGE.md` for the recorded decision and its rationale. This is
expected, not a sign of an incomplete purge.

## The backup horizon

A purged workspace's data is gone from this platform's own Postgres instance
the moment the destructive walk finishes — but it is not gone everywhere
immediately. `docs/runbooks/backups.md`'s "Cadence and retention" section
carries the pgBackRest backup-retention window that bounds how long an
encrypted off-host backup copy of that data survives after this platform's
own copy is destroyed. Read that section — and its PT-02 note specifically —
before making any "immediately and permanently unrecoverable" claim about a
purged workspace's data to a customer or an auditor.
