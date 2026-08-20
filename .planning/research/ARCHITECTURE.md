# Architecture Research — v1.2 Data Lifecycle & Delivery Trust

**Domain:** Integration architecture for 5 features onto an existing production multi-tenant B2C email-marketing SaaS (Mega CRM)
**Researched:** 2026-08-20
**Confidence:** HIGH — every finding below is grounded in the actual codebase (`apps/api`, `apps/worker`, `apps/web`, `packages/*`) and `SPECIFICATION.md` (as-built), not general best practice. File paths, migration numbers, and a live `npm audit` run are cited throughout.

**Scope discipline (per milestone context):** RLS, CI shape, backups, contact erasure, event retention, KMS, queues, and observability are already built and are NOT being redesigned. Every recommendation below is "attach to X using pattern Y", never "replace X."

---

## 1. System Overview — where the five features attach

```
┌────────────────────────────────────────────────────────────────────────────┐
│ apps/web (React 19/Vite SPA)                                                │
│  CampaignBuilderPage ─┐   ContactDetailPage        WorkspaceSettingsPage    │
│  LaunchScheduleDialogs│   [NEW] DsrExportButton     [existing] Danger Zone  │
│  TestSendPanel        │        (Feature 2)          soft-delete (Feature 3 │
│  [Feature 1 fix: dirty-guard + expectedTemplateId]                trigger) │
└──────────────┬────────────────────┬───────────────────────┬────────────────┘
               │ session-cookie      │ session-cookie        │ session-cookie
┌──────────────▼────────────────────▼───────────────────────▼────────────────┐
│ apps/api (Fastify)                                                          │
│  campaigns.routes.ts / campaign.repository.ts   [Feature 1: server-side    │
│    launchCampaign/scheduleCampaign/testSend       expectedTemplateId check] │
│  [NEW] contacts/dsr-export.routes.ts              (Feature 2, sync stream) │
│  workspaces.ts DELETE (existing soft-delete)      unchanged (Feature 3     │
│    trigger only — org.deletedAt already exists)    trigger, not the purge) │
│  unsubscribe.routes.ts + delivery-core/unsubscribe-token.ts                │
│    [Feature 4: PRIMARY + PREVIOUS secrets]                                 │
│  9 existing dead-man's-switch watchdogs in apps/api (§7 SPEC pattern)      │
│    [NEW 10th: workspace-purge-watchdog, same claimOpsAlertSlot primitive]  │
└──────────────┬───────────────────────────────────────────────┬─────────────┘
               │ BullMQ (Redis)                                 │ tenant-scoped
┌──────────────▼───────────────────────────────────────────────▼─────────────┐
│ apps/worker (BullMQ, @mega-crm/queue-core)                                 │
│  send-dispatch.ts / flows/flow-send.ts  — reads campaigns.template_id      │
│    from DB at dispatch time (ALREADY the source of truth — Feature 1      │
│    is a client+API problem, not a worker problem)                          │
│  erasure-scrub.worker.ts + erasure-scrub-reclaim.worker.ts (existing GDPR  │
│    per-contact pattern — Feature 3 reuses this shape at workspace scope)   │
│  [NEW] workspace-purge.worker.ts + workspace-purge-reclaim.worker.ts       │
│    (Feature 3 — checkpointed, cross-tenant discovery via existing          │
│    withCrossWorkspaceScan/mega_crm_scan)                                   │
└──────────────┬───────────────────────────────────────────────┬─────────────┘
               │                                                 │
┌──────────────▼─────────────────────────────────────────────────▼───────────┐
│ Postgres (RLS, partitioned events/send_events)      Redis (BullMQ)         │
│  campaigns.template_id (existing column, no schema change — Feature 1)     │
│  [NEW] platform ops table: workspace_purge_state (Feature 3, no RLS,       │
│    mirrors dead_letter_jobs/partition_retention_drops — NOT a tenant table)│
│  [NEW] workspace_sendgrid_keys / workspace_suppression_keys DELETE         │
│    (Feature 3's "delete tenant secrets")                                   │
│  UNSUBSCRIBE_TOKEN_SECRET → UNSUBSCRIBE_TOKEN_SECRETS_PREVIOUS (Feature 4, │
│    env-only, no schema change)                                             │
└───────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│ CI (.github/workflows/ci.yml)                                              │
│  static job: build → lint → lint:floor → lint:migrations →                 │
│    lint:session-state → check:lockfile-npm10 → check:root-hygiene          │
│    [NEW] npm audit gate (Feature 5) inserted here, root-level, single      │
│    lockfile — same "Node builtins, no dependency" house style as the       │
│    other static-job scripts                                                │
└────────────────────────────────────────────────────────────────────────────┘
```

None of the five features requires a new process, a new queue *topology*, a new database, or a change to RLS mechanics. All five are extensions inside the existing four moving parts (web, api, worker, CI).

---

## 2. Feature 1 — Campaign template correctness

### 2.1 What the code actually does today (verified, not assumed)

The bug is **not** a worker-side or dispatch-side problem — `apps/worker/src/queues/send-dispatch.ts`'s `readSendPrereqs()` (line ~235) does `SELECT template_id ... FROM campaigns WHERE id = $1` at dispatch time, and `flow-send.ts` reads the send-node's own persisted config. Both are already reading the confirmed-saved DB value, never anything passed from the client. `campaign.repository.ts`'s `launchCampaign`/`scheduleCampaign` take **no body at all** (`launchCampaign(slug, campaign.id)` in `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx:73`) — the server independently re-reads `existing.templateId` under `SELECT ... FOR UPDATE` before transitioning `draft → sending`.

The actual defect is a **client-side split-state race**, confirmed by reading the three components involved:

- `CampaignBuilderPage.tsx` owns `templateId` as local `useState`, populated from the query cache on load (`campaignQuery.data`), mutated locally by `TemplatePicker`'s `onChange`. It is **only** persisted to the server when the user clicks "Сохранить черновик" (`saveMutation`, explicit — there is no autosave in this component, unlike the flow canvas).
- `CampaignDetailPage.tsx` mounts `CampaignBuilderPage` (draft editor) as a **sibling**, not a parent, of `LaunchScheduleActions` and `TestSendPanel` — both of the latter receive `campaign` as a prop sourced from `CampaignDetailPage`'s **own** `campaignQuery` (same query key, `["workspace", slug, "campaigns", id]`, so it does reflect the last **persisted** value — but nothing forces it to reflect the **currently displayed but unsaved** dropdown selection in the sibling `CampaignBuilderPage`).
- `LaunchScheduleActions`'s `computeIncompleteReason` and `LaunchConfirmDialog` validate/launch against `campaign.templateId` — the last **saved** value, not the dropdown's current value.

**Reproduction:** open a draft campaign → change the template in the dropdown → do **not** click "Сохранить черновик" → click "Отправить сейчас". `incompleteReason` is `null` (the *old* template still satisfies the completeness check), the confirm dialog shows no template name at all (`LaunchConfirmDialog` today renders only the audience breakdown), and `launchCampaign(slug, id)` fires with no body — the server transitions the *already-persisted, old* `template_id` to `sending`. The dropdown visually shows the new template; the email that goes out uses the old one. This matches the reported symptom exactly.

### 2.2 Integration points (new vs modified)

| Component | Change | Type |
|---|---|---|
| `apps/web/src/features/campaigns/CampaignBuilderPage.tsx` | Track and expose a `isDirty` boolean (template/segment/sender differ from last-saved snapshot) via a shared hook or lifted state, mirroring the flow canvas's existing unsaved-guard shape (Phase 15 OPS-19: dirty flag + `useBlocker` + persistent `SaveErrorBanner`, not a toast) | Modified |
| `apps/web/src/features/campaigns/CampaignDetailPage.tsx` | Lift `templateId`/`segmentId`/`fromSenderId` (or just the dirty flag) up from `CampaignBuilderPage` so `LaunchScheduleActions`/`TestSendPanel` can see "there are unsaved edits" and disable themselves with inline copy ("Сохраните изменения перед запуском") | Modified |
| `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx` — `LaunchConfirmDialog` | Display the **template name/id being sent** (fetch it fresh, not from the stale `campaign` prop) before the user confirms — currently shows only audience breakdown | Modified |
| `apps/web/src/features/campaigns/api.ts` | `launchCampaign`/`scheduleCampaign`/`testSendCampaign` calls gain an `expectedTemplateId` (and ideally `expectedSegmentId`) field, populated from the value the confirm dialog just displayed | Modified |
| `apps/api/src/modules/campaigns/campaigns.routes.ts` | Parse the new optional `expectedTemplateId` field on `POST .../launch`, `.../schedule`, `.../test-send` | Modified |
| `apps/api/src/modules/campaigns/campaign.repository.ts` — `launchCampaign`/`scheduleCampaign` | Inside the existing `SELECT ... FOR UPDATE` transaction, if `expectedTemplateId` is present and `existing.templateId !== expectedTemplateId`, throw a new `CampaignStateError(..., "template_mismatch")` instead of proceeding — mirrors the existing `illegal_transition`/`incomplete` error-code pattern already used here | Modified |
| `apps/worker/src/queues/send-dispatch.ts` / `flow-send.ts` | **No change** — already reads DB directly | Unchanged (confirms scope) |

### 2.3 Why both layers (dirty-guard AND server-side echo check)

A client-only dirty guard closes the single-tab race described above but not a multi-tab/concurrent-editor race (two browser tabs, or two teammates, editing the same draft — `updateCampaign`'s existing `SELECT ... FOR UPDATE` already serializes concurrent *saves*, but does nothing about a *stale confirm dialog* open in a second tab while the first tab's save lands). The `expectedTemplateId` echo makes the guarantee hold server-side regardless of client staleness, at the cost of one extra field threaded through 3 routes/3 repository functions — small, and it follows the exact `CampaignStateError`/error-code precedent already in the file, so it is idiomatic to the codebase rather than a new pattern.

### 2.4 Data flow

```
User changes template dropdown (local state only)
    ↓
[missing today] no dirty signal reaches LaunchScheduleActions/TestSendPanel
    ↓
User clicks "Отправить сейчас" without saving
    ↓
LaunchConfirmDialog validates against stale `campaign.templateId` prop (passes)
    ↓
launchCampaign(slug, id) — no body — server re-reads OLD templateId — dispatches OLD template

[fixed flow]
User changes template dropdown → isDirty=true propagates to CampaignDetailPage
    ↓
LaunchScheduleActions/TestSendPanel disabled + "Сохраните изменения" copy
    ↓
User saves → saveMutation invalidates campaignQuery → isDirty=false, actions re-enable
    ↓
LaunchConfirmDialog shows the now-current template name, launches WITH expectedTemplateId
    ↓
API re-validates existing.templateId === expectedTemplateId under FOR UPDATE, then transitions
```

---

## 3. Feature 2 — Per-contact DSR export

### 3.1 Reuse target: `timeline.repository.ts`

`apps/api/src/modules/analytics/timeline.repository.ts`'s `listContactTimeline` already does exactly the aggregation this feature needs at the SQL level: a `UNION ALL` across `events`, `sends`, `subscription_status_history`, and `flow_runs`, all filtered `WHERE workspace_id = $1 AND contact_id = $2`, all inside `withTenantTransaction` (RLS-enforced). This is the direct template for the DSR export query — extend it (or add a sibling query using the same shape) to also project `contacts` (profile + `properties`), and to walk **to exhaustion** with keyset pagination on `(occurred_at, id)` rather than the timeline's UI page size — the same `(occurred_at, id)` keyset-on-partitioned-table pattern the `erasure-scrub.worker.ts` checkpoint already uses for exactly this reason (partitioned tables need the partition key leading the keyset).

### 3.2 Why sync, not async — verified against the actual index

The milestone context asks "sync request vs async job? How to bound the query cost on partitioned events tables under RLS?" The answer, verified against `SPECIFICATION.md` §4.5: `events` carries `idx_events_workspace_contact_time (workspace_id, contact_id, occurred_at)` and `sends` carries `idx_sends_workspace_contact_sent_at (workspace_id, contact_id, sent_at)` — both leading on `(workspace_id, contact_id)`. A DSR export is **scoped to one contact**, not the workspace, so every query in the union is an indexed lookup bounded by that one contact's row count, structurally different from — and far cheaper than — the workspace-wide scans this codebase is careful about elsewhere (segment compilation, reconciler discovery). There is no cost-bounding problem to solve at MVP scale: a synchronous, streamed HTTP response is sufficient and avoids inventing a new job/notification/download-ready UX for a feature that doesn't need one.

**Escalation path (flag for the roadmap, not solved now):** if a future large tenant has a contact with pathologically many events (e.g. a high-frequency IoT-like event stream into one contact), the same query becomes a scan the size of that contact's event history, still index-bound but unbounded in *rows returned*. If that becomes real, the fix is the same `statement_timeout` degraded-response pattern `segments-core` already uses, or moving to the async-job + BullMQ + downloadable-artifact shape — not needed until evidence of the problem exists.

### 3.3 Integration points (new vs modified)

| Component | Change | Type |
|---|---|---|
| `apps/api/src/modules/contacts/dsr-export.repository.ts` | New file: `buildContactDsrExport(contactId)` — profile from `contacts`, custom `properties`, full `subscription_status_history`, keyset-paginated `events`+`sends`(+joined `send_events` for delivery facts), all under `withTenantTransaction` | New |
| `apps/api/src/modules/contacts/contacts.routes.ts` | New route `GET /api/workspaces/:slug/contacts/:id/export` — same `resolveWorkspaceMember` local-copy pattern already used by every other route in this file (§6.4 SPEC — yes, this perpetuates the "9 independent copies" wart already documented as tech debt; do not centralize it as a side effect of this feature) | New route, existing pattern |
| Response shape | `Content-Disposition: attachment; filename="contact-<id>-export.json"` (or NDJSON for the event stream) — **reuse and heed** the `csv-import.routes.ts` WR-06 lesson: the `:id` is attacker-controlled and flows into the header, so it must be validated as a UUID (Zod) *before* string-interpolation into `Content-Disposition`, exactly as `csv-import.routes.ts:284` already does for the import-id | New, reusing existing security lesson |
| `apps/api/src/modules/contacts/contact.repository.ts` | Add an explicit guard: exporting an already-`anonymized_at`-set contact returns a typed error (`contact_anonymized`), mirroring `updateContact`'s existing `ContactConflictError` for the same condition (§4.2 SPEC) — there is nothing left to export once erasure has run, and the response must say so rather than silently returning an empty/null-filled file | Modified (small) |
| `apps/web/src/features/contacts/ContactDetailPage` (or wherever the contact card lives) | New "Экспорт данных" button, triggers a plain `window.location`/anchor download against the new endpoint (no client-side aggregation) | New |

### 3.4 Open question for the roadmap

Who can trigger a DSR export — any workspace member, or only owner/admin (`requirePermission`, §6.5 pattern)? The milestone description doesn't specify; this is a genuine product/compliance decision (GDPR data-subject requests are typically handled by whoever's designated as the data controller contact, which may not map to a specific in-app role) and should be resolved during phase discussion, not assumed here.

---

## 4. Feature 3 — Physical purge of soft-deleted workspaces

This is the largest and riskiest of the five — it is the only feature that deletes rows across (potentially) all 27 RLS-protected domain tables plus two partitioned tables plus tenant secrets, and it must not touch other tenants' data or destroy the evidence trail Phase 13's GDPR work built. Three things verified below materially change the design from "just cascade-delete the org row":

### 4.1 Verified constraint #1 — do not rely on the FK CASCADE

Every one of the 27 domain tables has `workspace_id NOT NULL REFERENCES organization(id) ON DELETE CASCADE` (§4.2/§4.3 SPEC). A naive `DELETE FROM organization WHERE id = $1` would work *functionally* but would be a single uncontrolled multi-table cascading delete touching `events`/`send_events` (partitioned, potentially large), all under one transaction with no checkpoint, no batching, and no ability to resume after a crash mid-delete. This is exactly the shape of operation this codebase has repeatedly rejected elsewhere: partition retention uses detach-and-drop instead of row-level `DELETE` (§4.7 SPEC, "механизм удаления — detach-and-drop, никогда row-level DELETE"); GDPR erasure uses a checkpointed, resumable, bounded-page worker instead of a single UPDATE (§5.15 SPEC). The purge worker must follow the same discipline: **explicit, batched, checkpointed deletes per table**, each batch scoped by a `DELETE ... WHERE id IN (SELECT id FROM <table> WHERE workspace_id = $1 LIMIT N)` subselect — the same batching shape `relocate-default.ts`'s `RELOCATE_BATCH_SIZE` already uses (`LIMIT` cannot appear directly on a bare `DELETE`), ordered by FK dependency (not just size — see the new §4.3a below), `organization` row deleted **last**, never a bare cascade.

### 4.2 Verified constraint #2 — `mega_crm_app` cannot `DELETE` from `organization`

The Phase 10 grant matrix for `organization` (§4.3 SPEC, migration `0045`) gives `mega_crm_app` only `SELECT, UPDATE, REFERENCES` — **not `DELETE`**. `DELETE` privilege on `organization` lives only with `mega_crm_auth`, and `apps/worker` structurally does not hold `AUTH_DATABASE_URL` (P3 invariant, enforced by `env-schema.test.ts`'s allowlist, §3.2/§4.3 SPEC). This means the purge worker's final step — deleting the `organization` row itself — **cannot run under either of the worker's existing pools today**. Two options, both following existing precedent, need an explicit decision at plan time:

1. **Grant-only migration** adding `DELETE` on `organization` to `mega_crm_app`, scoped narrowly (precedent: `0042`/`0065`, both grant-only migrations with no schema change) — simplest, but widens `mega_crm_app`'s privilege surface on a table it currently can only read/soft-update.
2. **Dedicated purge-admin DSN**, following the `PARTITION_RELOCATION_ADMIN_DATABASE_URL` precedent (§3.2/§3.6 SPEC pool #6) — an operator-scoped elevated connection used **only** for the final `DELETE FROM organization`, never for the per-table tenant deletes (those stay on the ordinary `withTenantTransaction` path so RLS still protects every intermediate step). This keeps `mega_crm_app`'s privilege surface unchanged and matches this codebase's stated preference (10-06 chose the equivalent option for the `ATTACH PARTITION` FK-revalidation problem over widening a role's grants).

Recommendation for the roadmap: option 2. It is more code (one more elevated DSN, one more `packages/db/scripts`-shaped operator surface) but it is consistent with how this project has resolved every other "worker needs a privilege `mega_crm_app` doesn't have" situation, and it keeps the blast radius of a bug in the purge worker itself contained to "can't finish deleting `organization`" rather than "can now also `DELETE` any `organization` row from any code path that reuses the pool."

### 4.3 Verified constraint #3 — purge checkpoints cannot live in a tenant table

Every `workspace_id`-bearing table CASCADEs to `organization`, **including `erasure_records`**, whose `sends_scrub_cursor`/`events_scrub_cursor` JSONB columns are the existing precedent for "resumable cursor storage." A purge resume-cursor stored in any tenant table would be destroyed by the purge itself mid-run (or block the final org delete via its own FK), which is self-defeating for a *resumable* worker. The purge checkpoint/evidence table must be a **platform ops table** — no `workspace_id` FK to `organization`, no RLS — following the existing `dead_letter_jobs`/`partition_retention_drops` shape (bare `uuid`/`text` workspace identifier column, no FK, append-only evidence). Consequence to state explicitly in the phase plan: **purge destroys the workspace's own `erasure_records` rows** (they cascade with everything else); the new platform table becomes the sole surviving evidence that a purge happened, for which workspace, and when — this is a deliberate trade-off, not an oversight, and should be named as such (mirrors how `erasure_records` itself documents "for contacts hard-deleted before this migration, the evidence trail is not retroactively recoverable").

### 4.3a Full table enumeration and FK-driven deletion order

The milestone brief asks explicitly to enumerate the real tables/secrets and the ordering constraints, not just gesture at "27 tables." Enumerated from the `SPECIFICATION.md` §4.2/§4.3 schema read:

**Tables with `workspace_id NOT NULL REFERENCES organization(id) ON DELETE CASCADE` (the 27 RLS-protected domain tables):** `workspace_sendgrid_keys`, `contacts`, `workspace_suppressions`, `workspace_property_registry`, `workspace_api_keys`, `events` (partitioned), `csv_imports`, `csv_import_rows`, `segments`, `campaigns`, `campaign_recipients`, `sends`, `workspace_send_settings`, `send_events` (partitioned), `workspace_webhook_endpoints`, `flows`, `flow_versions`, `flow_runs`, `flow_run_steps`, `flow_segment_membership_snapshot`, `subscription_status_history`, `workspace_daily_rollup`, `flow_segment_sweep_checkpoint`, `ingress_journal`, `send_event_quarantine`, `erasure_records`, `workspace_suppression_keys`.

**Plus three rows the "27 domain tables" framing misses:**
- `reputation_alert_state` — no RLS, but it *does* carry `workspace_id → organization(id) CASCADE` (§4.2 SPEC) — it is a platform ops table by RLS-exemption, not by FK exemption, so it still needs an explicit delete (or it cascades with the final org-row delete, which is acceptable since it holds no PII, only observed rates).
- better-auth `member`/`invitation` — `organizationId → organization(id) CASCADE`, not part of the RLS-protected 27 (§4.1 SPEC, grant-boundary not RLS) but still tenant data that must go. `invitation.email` is PII (a pending invitee's address) and belongs explicitly in the "secrets/PII enumerated" list, not just implied by "member/invitation get deleted too."
- `session.activeOrganizationId` — **no FK at all** to `organization` (§4.1 SPEC notes this explicitly: "без FK"). A purged workspace's id can be left dangling in a still-live user session's `activeOrganizationId` column — harmless (the app already handles an unknown/soft-deleted org id via the existing `deletedAt`-check on workspace routes) but worth naming so it isn't mistaken for an oversight during review.

**PII-bearing columns worth naming explicitly in the phase's own secrets/PII enumeration:** `csv_import_rows.raw` (jsonb) — arbitrary uploaded CSV row data at rest, exactly the kind of freeform PII this purge exists to remove, easy to overlook because it isn't a "core" contact field.

**FK-driven ordering constraints (this is what actually determines order — not table size):**

Deleting rows from a *referencing* (child) table never triggers any FK behavior on the *referenced* (parent) table — CASCADE/RESTRICT/SET NULL only fire when a **referenced** row is deleted. So the real constraint is: **never delete a parent row while tenant-scoped children that reference it via CASCADE still exist** (or the parent-row delete will itself trigger the exact unbounded cascade Anti-pattern 1 warns against), and **never attempt to delete a parent row that a RESTRICT FK still points to** (that delete errors outright, it does not cascade). Verified from the schema read:

| Rule | FK | Consequence for ordering |
|---|---|---|
| `events.contact_id → contacts(id) CASCADE` | CASCADE | `events` must be explicitly batch-deleted **before** `contacts` — otherwise deleting `contacts` triggers Postgres's own cascade into `events`, i.e. the exact single-uncontrolled-transaction failure mode Anti-pattern 1 exists to avoid, just triggered one table later than expected |
| `send_events.send_id → sends(id) SET NULL` | SET NULL | `send_events` should be deleted **before** `sends` — deleting `sends` first would instead trigger a cross-partition `UPDATE ... SET send_id = NULL` across every `send_events` partition, an update storm with the same shape (and same risk) as the cascade this design is built to avoid, just expressed as `UPDATE` instead of `DELETE` |
| `campaigns.segment_id → segments(id) RESTRICT`, `flows.trigger_segment_id → segments(id) RESTRICT` | RESTRICT | `campaigns` and `flows` **must** be deleted before `segments`, or the `segments` delete batch fails outright (RESTRICT blocks, it does not cascade) |
| `flow_runs.flow_version_id → flow_versions(id) RESTRICT` | RESTRICT | `flow_runs` must be deleted before `flow_versions` |
| `campaign_recipients.contact_id`, `sends.contact_id`, `subscription_status_history.contact_id` → `contacts(id) CASCADE` | CASCADE | same reasoning as the `events` row above — all three must precede `contacts` |
| `flow_run_steps.flow_run_id`, `flow_segment_membership_snapshot.flow_id`, `flow_segment_sweep_checkpoint.flow_id` → `flow_runs(id)`/`flows(id) CASCADE` | CASCADE | must precede `flow_runs`/`flows` respectively |
| `csv_import_rows.csv_import_id → csv_imports(id) CASCADE` | CASCADE | must precede `csv_imports` |
| `campaign_recipients.campaign_id → campaigns(id) CASCADE` | CASCADE | must precede `campaigns` |

This is enough to derive a safe leaf-first order (e.g.: `campaign_recipients`, `flow_run_steps`, `flow_segment_membership_snapshot`, `flow_segment_sweep_checkpoint`, `csv_import_rows`, `subscription_status_history`, `send_event_quarantine`, `ingress_journal`, `workspace_daily_rollup`, `erasure_records`, `workspace_property_registry`, `workspace_suppressions` → `send_events` → `sends` → `events` → `campaigns` → `flows` → `flow_runs` → `flow_versions` → `segments` → `csv_imports` → `contacts` → `workspace_send_settings`/`workspace_api_keys`/`workspace_webhook_endpoints` → `workspace_sendgrid_keys`/`workspace_suppression_keys` (secrets) → better-auth `member`/`invitation` → `organization`) — the exact final ordering should be pinned down and reviewed at plan time against a fresh schema read (this milestone may add/alter FKs before that phase starts), not treated as frozen by this research document.

### 4.4 Verified adjacent finding — soft-delete does not quiesce anything today

`organization.deletedAt` (soft-delete, existing) currently only affects **login-time workspace-list filtering** (`workspaces.ts`'s `active = orgs.filter(org => !org.deletedAt)`) and the explicit `deletedAt`-check on `GET /api/workspaces/:slug`-family routes. It is checked nowhere else. In particular, `campaigns_scan`'s RLS policy (migration `0041`, `USING (status = 'scheduled' AND scheduled_at <= now())`) has **no** join to `organization.deletedAt` — a scheduled campaign in a soft-deleted workspace is still discoverable and dispatchable by `campaign-scheduler.worker.ts` today. The same is true of `flow_runs_scan`/`flows_scan`. This is a pre-existing gap, not something Feature 3 introduces, but Feature 3's purge design must not make it worse: **before physically purging**, the purge worker (or a preceding "quiesce" step) should cancel any `scheduled`/`sending` campaigns and pause any `live` flows for the target workspace, tolerating the case where a BullMQ job for that workspace is already in flight (same "log and skip, don't crash the tick" discipline every existing cross-tenant worker already follows). Flag this as either an in-scope quiesce step of the purge plan, or an explicitly accepted pre-existing gap to fix separately — but do not silently assume soft-delete already stopped everything.

### 4.5 What "delete tenant secrets" concretely means

- **KMS-wrapped keys** (`workspace_sendgrid_keys`, `workspace_suppression_keys`): both store only `ciphertext`/`encrypted_dek`/`iv`/`auth_tag` — the plaintext DEK is never persisted (zeroed after use, per `packages/kms/src/client.ts`). There is no separate "per-tenant KMS key resource" to deprovision in any of the three providers (`local`/`aws`/`file`) — the KEK is platform-wide. **Deleting the row is sufficient**: once `ciphertext`+`encrypted_dek` are gone, the wrapped secret is unrecoverable even with the KEK, because the KEK alone cannot reconstruct a deleted ciphertext. No KMS-side API call is needed.
- **SendGrid Event Webhook deprovisioning** (`workspace_webhook_endpoints.sendgrid_webhook_id`): this is a resource that lives in the *tenant's own* SendGrid account, reachable only via the tenant's own (still-present, not-yet-deleted) API key. Best-effort: attempt `DELETE` of the provisioned webhook via the tenant's SendGrid key **before** deleting `workspace_sendgrid_keys`, but never block the purge on it — the same "self-healing, tolerant of an invalid/already-revoked key" posture the existing auto-provisioning/Reconnect flow (Phase 5, D-01/D-02) already has. If the tenant revoked or rotated their key independently, deprovisioning will simply fail and purge proceeds anyway; the row is being deleted regardless, so there is no user-visible harm.

### 4.6 Integration points (new vs modified)

| Component | Change | Type |
|---|---|---|
| Migration: `workspace_purge_state` (or similar) — platform ops table, no RLS, no FK to `organization`, `workspace_id uuid` bare column, `status`, per-table row-count evidence, resume cursors (JSONB, same shape as `erasure_records`' cursors) | Mirrors `dead_letter_jobs`/`partition_retention_drops`/`ops_alert_state` precedent | New table |
| Migration: grant `DELETE` on `organization` to a purge-scoped role/DSN (§4.2 decision) | Precedent: `0042`/`0065` grant-only, or a new `PARTITION_RELOCATION_ADMIN_DATABASE_URL`-shaped dedicated DSN | New migration + (if DSN route) new env var — **remember**: any new env var requires `docker/prod.env.example` + `SPECIFICATION.md` §3 in the same change (`check:spec-env-coverage` CI gate enforces the one-way check) |
| `apps/worker/src/queues/workspace-purge.worker.ts` | New: per-table, batched (subselect `LIMIT`/keyset), checkpointed delete walk across the full table set in §4.3a, ordered by FK dependency (leaf tables first, `organization` row last), all under `withTenantTransaction` except the final org-row delete | New (mirrors `erasure-scrub.worker.ts` shape) |
| `apps/worker/src/queues/workspace-purge-reclaim.worker.ts` | New: periodic tick, same "crash between commit and enqueue" recovery shape as `erasure-scrub-reclaim.worker.ts` (§5.16 SPEC) | New (mirrors `erasure-scrub-reclaim.worker.ts`) |
| Discovery: `withCrossWorkspaceScan` query for `organization` rows where `deletedAt` is older than the platform-default retention | `organization` already has an existing `GRANT SELECT` to `mega_crm_scan` with no row-scoping policy (used today only by `analytics-reconciliation.worker.ts`'s enumeration, §4.3 SPEC) — this query reuses that grant, no new one needed | Reuses existing grant |
| `apps/api/src/modules/ops/workspace-purge-watchdog.ts` | New 10th dead-man's-switch, same `claimOpsAlertSlot`/`ops_alert_state` primitive as the existing 9 (§7 SPEC) — alerts if purge-eligible workspaces are piling up unprocessed | New (mirrors existing watchdog pattern exactly) |
| Retention constant: `WORKSPACE_PURGE_RETENTION_DAYS` (platform default, operator-configurable) | Same shape as `PARTITION_RETENTION_ENABLED`/`PARTITION_RETENTION_MONTHS` — versioned constant + env override, default conservative, explicit operator opt-in before first production run (mirrors D-08's pre-enable checklist discipline for partition retention) | New env var + constant |

### 4.7 Data flow

```
Owner soft-deletes workspace (existing) → organization.deletedAt = now()
    ↓ [retention window elapses — platform default, operator-set]
[NEW] discovery tick (withCrossWorkspaceScan, reusing existing organization SELECT grant)
    finds organization rows with deletedAt < now() - retention
    ↓
[NEW] quiesce step: cancel scheduled/sending campaigns, pause live flows for this workspace
    (addresses §4.4's verified gap — campaigns_scan/flow_runs_scan don't check deletedAt)
    ↓
[NEW] workspace-purge.worker.ts: checkpointed, batched, per-table deletes (subselect-LIMIT batches)
    FK-dependency order (events before contacts, send_events before sends,
    campaigns/flows before segments, flow_runs before flow_versions -- see §4.3a)
    → workspace_sendgrid_keys / workspace_suppression_keys DELETE (secrets gone)
    → best-effort SendGrid webhook deprovision BEFORE the above two deletes
    → organization row DELETE last, via the elevated purge DSN (§4.2)
    ↓
[NEW] workspace_purge_state row: terminal evidence (what, when, row counts) — the ONLY
    surviving record, since erasure_records/subscription_status_history etc. are all
    gone by this point (they cascaded/were deleted as part of the same walk)
```

### 4.8 Build-order note specific to this feature

Feature 3 depends on nothing else in this milestone functionally, but it is the highest-risk feature (irreversible, cross-table, needs a privilege decision resolved at plan time, needs the quiesce gap addressed or explicitly deferred) — it should be planned last within the milestone so the grant-migration decision (§4.2) and the quiesce decision (§4.4) get the most discussion time, and so any patterns refined while building Features 1-2 (e.g., the keyset-pagination-on-partitioned-tables discipline from Feature 2) are already fresh.

---

## 5. Feature 4 — Unsubscribe-secret rotation

### 5.1 Current shape (verified)

`packages/delivery-core/src/unsubscribe-token.ts` signs/verifies with exactly **one** secret: `UNSUBSCRIBE_TOKEN_SECRET` (`getSecret()` reads `process.env` directly, `z.string().min(32)` in `apps/api/src/env.ts`, manual `>= 32` check in `apps/worker/src/server.ts`). Format: `base64url(JSON payload).base64url(HMAC-SHA256(payload))`. `verifyUnsubscribeToken` never throws — any failure (bad shape, bad base64, signature mismatch) returns `null`, and the route maps that uniformly to the same generic response (anti-oracle property, T-04-03-01/T-04-03-02). `exp` is checked in the route, not the verifier. **TTL is 5 years**, and the constant `UNSUBSCRIBE_TOKEN_TTL_SECONDS` is duplicated verbatim in two files (`apps/worker/src/queues/send-dispatch.ts:41` and `apps/worker/src/queues/flows/flow-send.ts:26` — a pre-existing, documented wart, not something to leave worse).

### 5.2 Integration points (new vs modified)

| Component | Change | Type |
|---|---|---|
| `packages/delivery-core/src/unsubscribe-token.ts` | `signUnsubscribeToken` unchanged (always signs with the primary secret). `verifyUnsubscribeToken` gains a secrets list: try primary first, then each of `UNSUBSCRIBE_TOKEN_SECRETS_PREVIOUS` (comma-separated) in order, same `timingSafeEqual` + null-on-any-failure contract for every attempt — the anti-oracle property must hold identically regardless of *which* secret in the list eventually matches | Modified |
| `apps/api/src/env.ts` | New optional field `UNSUBSCRIBE_TOKEN_SECRETS_PREVIOUS: z.string().optional()`, parsed as comma-separated, each entry validated `>= 32` chars (same bar as the primary) | Modified |
| `apps/worker/src/server.ts` | Same manual boot-check pattern already used for `UNSUBSCRIBE_TOKEN_SECRET` (worker has no `env.ts`/zod schema — §3.2 SPEC's final note) — read and validate the new var the same manual way | Modified |
| `scripts/check-env.mjs` | This is a presence-only dev-loop check today for the *required* vars; the new var is optional, so it should be explicitly excluded from the required list, not silently added — verify this deliberately when writing the script change | Modified (verify, don't assume) |
| `docker/prod.env.example` + `SPECIFICATION.md` §3 | New var name (never the value) — required by `check:spec-env-coverage`'s one-way gate and by this repo's own `CLAUDE.md` rule ("новая переменная окружения → SPECIFICATION §3 в том же изменении") | Modified (both, same change) |
| Consolidation (opportunistic, not required): `UNSUBSCRIBE_TOKEN_TTL_SECONDS` | Since this change touches the unsubscribe-token surface anyway, move the duplicated constant into `packages/delivery-core` and import it from both `send-dispatch.ts` and `flow-send.ts` — small, in-scope cleanup, not a separate phase | Modified (optional but cheap) |

### 5.3 The TTL interaction that must be an explicit decision, not a side effect

Tokens are signed for **5 years**. Rotating the primary secret without retaining the old one as "previous" would silently break every already-sent unsubscribe link until it naturally expires — up to 5 years of live links. The `PREVIOUS` list is exactly the mechanism to avoid that, but it means: **previous secrets must be retained for as long as the platform wants old links to keep working**, which in the worst case is ~5 years from the rotation. This is a genuine operational commitment (secret retention duration, and how many rotations back the list should hold), not a pure code change — the phase plan should say explicitly how many previous secrets are supported (e.g., "retain until the newest link signed under it would have expired") and who owns removing an entry from the list once its window has passed.

### 5.4 Data flow

```
Sign path (unchanged): send-dispatch.ts / flow-send.ts → signUnsubscribeToken(primary secret)
    ↓
Verify path (extended): POST /unsubscribe/:token
    → verifyUnsubscribeToken tries PRIMARY
        → match: proceed
        → no match: try each of PREVIOUS in order
            → match: proceed (old link still works)
            → none match: null → existing generic "invalid" response (unchanged contract)
```

---

## 6. Feature 5 — Dependency-audit CI gate

### 6.1 What the CI actually looks like today (verified) and what's missing

`.github/workflows/ci.yml`'s `static` job (no services, fastest feedback lane, ~1 minute) already runs a sequence of Node-builtins-only, no-new-dependency scripts in this exact house style: `check:lockfile-npm10`, `check:root-hygiene`, `lint:session-state`, `lint:pg-pool-factory`, `check:spec-env-coverage`. There is **no** dependency-vulnerability step anywhere in CI today — confirmed by grep across `.github/workflows/*.yml` and `package.json`'s `scripts` block (no `audit` script exists).

### 6.2 Live audit data (run against the actual repo, 2026-08-20) — use this, don't guess

```
npm audit --omit=dev --json → severity counts: { moderate: 4, high: 6 }
HIGH/CRITICAL (6):
  brace-expansion   — fixAvailable: true (simple bump)
  fast-uri          — fixAvailable: true (simple bump)
  find-my-way       — fixAvailable: true (simple bump) — THIS IS FASTIFY'S ROUTER, production path
  nanoid            — fixAvailable: true (simple bump)
  postcss           — fixAvailable: { version: 8.5.26, isSemVerMajor: false }
  react-router      — fixAvailable: { version: 8.3.0, isSemVerMajor: false }
```

All 6 HIGHs have a non-major fix available — the "update vulnerable runtime dependencies" half of this feature is a small, mechanical `npm update`, not a research task. `find-my-way` matters most: it is Fastify's internal router, sitting directly in the production request path of `apps/api`.

**Tooling-only findings, verified:** the 4 MODERATE findings trace to `drizzle-kit@0.31.10`'s `esbuild`/`@esbuild-kit/*` chain. `drizzle-kit` is a **direct dependency of `packages/db`**, listed in `dependencies` (not `devDependencies`) — confirmed by reading `packages/db/package.json`. It is invoked only via `db:generate`/`db:migrate` (migration tooling), never imported by any runtime request path in `apps/api`/`apps/worker`. This is a real example of the "provably unreachable tooling-only finding" the milestone description asks for an acceptance mechanism for — and moving `drizzle-kit` to `devDependencies` (where it more accurately belongs, since neither `apps/api` nor `apps/worker` ship it in their production Docker images per `docker/Dockerfile.{api,worker}`) is itself a legitimate remediation, not just an acceptance-file entry. This should be evaluated as part of the phase, not assumed away.

### 6.3 Integration points (new vs modified)

| Component | Change | Type |
|---|---|---|
| `scripts/check-dependency-audit.mjs` (or similar name, matching `check:*` convention) | New: runs `npm audit --omit=dev --json`, parses `vulnerabilities`, fails on any `high`/`critical` **not present in the acceptance file**, exits 0 on none/all-accepted — Node builtins only (`node:child_process` for the audit invocation), same house style as `check-lockfile-npm10.mjs`/`check-root-hygiene.mjs` | New |
| `dependency-audit-acceptance.json` (or similar, root-level) | New file, modeled directly on `coverage-baseline.json` (measured value + provenance) and `docs/lint-rule-exceptions.md` (reason + reviewer-facing justification) — each accepted advisory gets: package name, advisory ID/GHSA link, severity, **why it's unreachable** (e.g. "tooling-only, `packages/db` devDependency-shaped, never in a prod Docker image"), and ideally an owner/review-date so acceptance isn't permanent-by-default | New |
| `.github/workflows/ci.yml` — `static` job | One new step, same position/style as the existing `check:*` steps (after `check:lockfile-npm10`, before or after `check:root-hygiene` — ordering is cosmetic) | Modified |
| `package.json` | New `"check:dependency-audit"` script entry | Modified |

### 6.4 Gate semantics — explicitly not "zero HIGH"

The milestone description is explicit: "CI-контроль новых неразобранных HIGH advisories... без формального zero-HIGH требования." The gate must therefore be: **fail if any `high`/`critical` advisory exists that is not listed in the acceptance file** — not "fail if any high exists." This is the same shape as `coverage-baseline.json`'s ratchet (a threshold that can only move in the safe direction, checked against a recorded baseline) rather than an absolute bar. New advisories that appear after this gate ships (e.g. from a future `npm install`) fail CI immediately until either fixed or explicitly accepted with a reason — which is the actual goal (discipline on *new* findings), not retroactively blocking on the ecosystem's current state.

### 6.5 Monorepo lockfile reality (verified, relevant to how the script must run)

npm workspaces monorepo, **single root `package-lock.json`** — confirmed by `workspaces: ["apps/*", "packages/*"]` in root `package.json` and the existing `check:lockfile-npm10` gate's own framing ("this repo's package-lock.json satisfies both npm majors"). `npm audit` therefore needs to run exactly once, at the repo root, not per-workspace — there is no per-workspace lockfile to reconcile. One caveat worth carrying into the plan, by direct analogy with the `npm-10 lockfile guard`'s own documented caveat (§static job comment, WR-02 in `14-REVIEW.md`): if the audit script needs registry access beyond what's already fetched into `node_modules` (it generally doesn't — `npm audit` in recent npm versions can work against the installed tree plus the lockfile without a fresh registry round-trip for the vulnerability data itself, but this should be verified against the actual npm version pinned by `.nvmrc`/Node 26 rather than assumed), a registry-unavailability failure should be distinguishable from a real new-advisory failure in the CI error output.

---

## 7. Cross-cutting patterns to reuse (do not invent new ones)

| Need | Existing pattern to reuse | Where it already lives |
|---|---|---|
| Resumable, crash-safe, bounded background work | Checkpointed page-walk with a JSONB/uuid cursor, committed in the same transaction as the batch it advances | `erasure-scrub.worker.ts` + `erasure-scrub-checkpoint.ts`, `flow-segment-sweep-checkpoint.ts` |
| "Producer committed, enqueue crashed" recovery | Periodic reclaim tick, same deterministic `jobId` as the original producer so replay collides instead of duplicating | `erasure-scrub-reclaim.worker.ts` |
| Cross-tenant discovery without breaking RLS | `withCrossWorkspaceScan` + `mega_crm_scan` role, narrow `SELECT`-only grants, ideally with a row-scoping predicate (not `USING (true)` unless truly unavoidable) | `packages/tenant-context/src/scan.ts`, migrations `0041`/`0042` |
| Dead-man's-switch alerting | `claimOpsAlertSlot`/`ops_alert_state`, one row per `alert_name`, independent dedup windows | `apps/api/src/modules/ops/*-watchdog.ts` (9 existing) |
| Downloadable file from an authenticated route | `Content-Disposition: attachment`, validate attacker-controlled id **before** header interpolation | `csv-import.routes.ts`'s error-report download (WR-06 lesson) |
| Acceptance-with-provenance for an imperfect gate | Baseline/threshold file with measured value + reason, checked into git | `coverage-baseline.json`, `docs/lint-rule-exceptions.md` |
| Elevated-privilege operator-only DB access | Dedicated DSN env var, never granted to `apps/api`/`apps/worker`'s normal pools, CLI-only invocation | `PARTITION_RELOCATION_ADMIN_DATABASE_URL` |
| Client-side unsaved-changes guard | Dirty flag + `useBlocker` (cross-navigation) + persistent banner (not a toast) | Flow canvas, Phase 15 OPS-19 |
| New env var discipline | Add to `docker/prod.env.example` **and** `SPECIFICATION.md` §3 in the same change; `check:spec-env-coverage` enforces the env.example → SPEC direction | `scripts/check-spec-env-coverage.mjs`, this repo's own `CLAUDE.md` rule |

---

## 8. Anti-patterns to avoid in this milestone

### Anti-pattern 1: Trusting the FK CASCADE for the workspace purge
**What people do:** `DELETE FROM organization WHERE id = $1` and let 27 `ON DELETE CASCADE` FKs do the work.
**Why it's wrong:** Single uncontrolled transaction across partitioned tables with unbounded row counts, no checkpoint, no ability to resume after a crash, and it silently deletes the workspace's own `erasure_records` (its GDPR evidence) with no separate audit trail. This is exactly the "safe by default that wasn't" mistake this codebase already paid for once with partition attach-to-DEFAULT (§4.4 SPEC, 09-REVIEW WR-01).
**Do this instead:** Explicit, checkpointed, batched per-table deletes (§4.1-4.3 above), org row last, evidence in a platform (non-cascading) table.

### Anti-pattern 2: Treating the campaign template bug as a worker/dispatch bug
**What people do:** Assume "wrong template sent" means the dispatch path is reading a stale value and start auditing `send-dispatch.ts`.
**Why it's wrong:** Verified: the worker already reads `campaigns.template_id` fresh from Postgres at dispatch time. Time spent auditing the worker for this bug is time not spent on the actual defect (client-side split state across sibling components).
**Do this instead:** Fix the client (dirty-guard) and add a thin server-side echo-check (§2 above) — both are UI/API-layer changes, zero worker changes.

### Anti-pattern 3: An async job + notification UI for the DSR export
**What people do:** Default to "PII export = big job = queue it, poll for completion, email a download link" because that's the shape GDPR exports often take at larger scale.
**Why it's wrong:** Per-contact (not per-workspace) scope, backed by leading `(workspace_id, contact_id, ...)` indexes on every table in the union — this is a small, bounded, already-indexed query. Building async infrastructure for it is unjustified complexity for this codebase's actual scale, and adds a new job/notification surface that then needs its own observability, retention, and failure-injection coverage.
**Do this instead:** Synchronous streamed download (§3.2), reusing the existing CSV-download `Content-Disposition` pattern.

### Anti-pattern 4: Rotating the unsubscribe secret without a retention plan for `PREVIOUS`
**What people do:** Ship "primary + one previous secret" as a fixed two-slot mechanism without deciding how long a previous secret must be kept.
**Why it's wrong:** Tokens carry a 5-year TTL. A previous secret dropped from the list before its youngest token expires silently breaks real, already-delivered unsubscribe links — turning a compliance feature (graceful rotation) into a compliance regression (broken one-click unsubscribe, RFC 8058).
**Do this instead:** Make the retention window an explicit, documented operational decision (§5.3), not an implementation detail left to whoever writes the list.

### Anti-pattern 5: A dependency-audit gate that requires zero HIGH advisories
**What people do:** Wire `npm audit --audit-level=high` directly as a required check with no escape hatch.
**Why it's wrong:** The ecosystem produces new advisories on a schedule the team doesn't control; a hard zero-HIGH bar either blocks unrelated merges on an unfixable/tooling-only finding (see the live `drizzle-kit` chain above) or trains the team to `--force`/ignore the gate, defeating its purpose. The milestone description explicitly rejects this shape.
**Do this instead:** Baseline/acceptance-file gate (§6.4), same shape as `coverage-baseline.json`.

---

## 9. Suggested build order

**5 → 4 → 1 → 2 → 3**

1. **Feature 5 (dependency hygiene)** first: smallest, most independent, zero product-code coupling to the other four — and once it's live it protects every subsequent phase's own dependency changes (including any new deps Features 1-4 might pull in, though none of them are expected to need new runtime packages).
2. **Feature 4 (unsubscribe rotation)** next: small, self-contained (one file's verify function, three env-plumbing sites), no schema change, no cross-feature dependency.
3. **Feature 1 (template correctness)**: self-contained to the campaigns module (web + api), no schema change, no dependency on 2/3/5.
4. **Feature 2 (DSR export)** before Feature 3: reuses the `timeline.repository.ts` query shape directly, and — importantly — a working export capability should exist *before* anything gets physically purged, both operationally (a tenant should be able to export a contact's data before their workspace becomes purge-eligible) and as a natural verification tool during Feature 3's own testing (export a contact, purge the workspace, confirm the export is now correctly refused).
5. **Feature 3 (workspace purge)** last: largest surface, touches the most tables, is the only feature requiring a privilege-grant decision (§4.2) and a quiesce-gap decision (§4.4) to be resolved before implementation can start — it benefits from the keyset-pagination discipline exercised fresh in Feature 2, and from Features 1/4/5 being already merged and stable so purge testing isn't happening against a moving target.

---

## 10. Confidence and gaps

**Confidence: HIGH** for every "what the code does today" claim in this document — each is grounded in a direct file read (line numbers cited where useful) or a live command run against the actual repository (`npm audit`, `grep`), not inference from `SPECIFICATION.md` prose alone. `SPECIFICATION.md` itself is dated 2026-07-15 in its header banner but is being actively maintained through Phase 17 (2026-08-20) per its own changelog entries — treated here as reliable for architecture, cross-checked against source where the finding was load-bearing (Features 1 and 3 especially).

**Gaps intentionally left for phase-level discussion, not resolved here:**
- Feature 3 §4.2: grant-migration vs dedicated-DSN for the final `organization` DELETE — a real architectural choice, not a detail.
- Feature 3 §4.4: whether the campaigns_scan/flow_runs_scan `deletedAt`-blindness is fixed as part of this milestone's quiesce step or filed as separate tech debt.
- Feature 2 §3.4: who may trigger a DSR export (any member vs `requirePermission`-gated).
- Feature 5 §6.2: whether to also relocate `drizzle-kit` to `devDependencies` as part of the "update vulnerable dependencies" work, or treat it purely as an acceptance-file entry.
- Feature 4 §5.3: exact previous-secret retention policy/window — an operational decision with a real deadline (token TTL), not a code detail.

## 11. Sources

- `/Users/primeropanther/Projects/mega-crm/SPECIFICATION.md` (as-built, sections 1-8 read in full for this research) — HIGH confidence, primary source
- `/Users/primeropanther/Projects/mega-crm/.planning/PROJECT.md` — milestone scope and requirements
- Direct source reads: `apps/web/src/features/campaigns/{CampaignBuilderPage,CampaignDetailPage,LaunchScheduleDialogs,TestSendPanel}.tsx`, `apps/api/src/modules/campaigns/campaign.repository.ts`, `apps/worker/src/queues/send-dispatch.ts`, `apps/worker/src/queues/flows/flow-send.ts`, `apps/api/src/modules/analytics/timeline.repository.ts`, `apps/api/src/modules/tenancy/workspaces.ts`, `packages/delivery-core/src/unsubscribe-token.ts`, `apps/api/src/modules/contacts/{contact.repository.ts,csv-import.routes.ts,contacts.routes.ts}`, `.github/workflows/ci.yml`, root `package.json`, `packages/db/package.json`
- Live command output: `npm audit --omit=dev --json` (run 2026-08-20 against the current lockfile) — HIGH confidence, primary evidence, cited verbatim in §6.2
- `grep`/`find` sweeps confirming absence of an existing dependency-audit step, existing `resolveWorkspaceMember` duplication, and the `organization` grant matrix

---
*Architecture research for: v1.2 Data Lifecycle & Delivery Trust integration onto Mega CRM*
*Researched: 2026-08-20*
