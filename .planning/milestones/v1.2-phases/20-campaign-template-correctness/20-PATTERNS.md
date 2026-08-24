# Phase 20: Campaign Template Correctness - Pattern Map

**Mapped:** 2026-08-21
**Files analyzed:** 10 (all modified, none new)
**Analogs found:** 10 / 10 (self-analog — every file's own current code is the pattern to extend; no cross-module analog needed since this is a localized correctness fix, not new infrastructure)

## File Classification

| Modified File | Role | Data Flow | Closest Analog | Match Quality |
|----------------|------|-----------|-----------------|---------------|
| `packages/db/src/schema/campaigns.ts` | model (Drizzle table) | CRUD | itself (add `version` column, follow `dirtied_at`-style doc comment convention from `packages/db/migrations/0056_...sql`) | exact |
| `packages/db/migrations/00XX_campaigns_version.sql` | migration | CRUD | `packages/db/migrations/0056_workspace_daily_rollup_dirtied_at.sql` | exact |
| `packages/shared-schemas/src/campaign.ts` | config (zod schema) | request-response | itself — `scheduleCampaignSchema`/`testSendCampaignSchema`/`launchCampaignSchema` | exact |
| `packages/shared-schemas/src/queues.ts` | config (zod schema) | event-driven (job payload) | itself — `emailBroadcastJobSchema`'s `requestId` additive-optional precedent (Phase 15/R-05) | exact |
| `apps/api/src/modules/campaigns/campaign.repository.ts` | service (repository) | CRUD (locked read-check-write) | itself — `launchCampaign`/`scheduleCampaign`/`updateCampaign`/`cancelCampaign` | exact |
| `apps/api/src/modules/campaigns/campaigns.routes.ts` | controller (Fastify routes) | request-response | itself — launch/schedule/test-send handlers + `mapCampaignStateError` | exact |
| `apps/api/src/modules/campaigns/sender-resolver.ts` | service | request-response | itself (`resolveCampaignFromEmail`'s persistence call sites — restructured, not rewritten) | exact |
| `apps/worker/src/queues/send-dispatch.ts` | service (BullMQ worker/processor) | event-driven | itself — `kind === "test"` branch, `readSendPrereqs` fallback | exact |
| `apps/web/src/features/campaigns/CampaignDetailPage.tsx` | component (page, composition seam) | request-response | itself — composes builder + siblings, owns lifted state | exact |
| `apps/web/src/features/campaigns/CampaignBuilderPage.tsx` | component | request-response | itself — form state, `saveMutation`, `useEffect` sync | exact |
| `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx` | component | request-response | itself — `computeIncompleteReason`, `LaunchConfirmDialog`/`ScheduleDialog` mutations | exact |
| `apps/web/src/features/campaigns/TestSendPanel.tsx` | component | request-response | itself — `testSendMutation` | exact |
| `apps/web/src/features/campaigns/api.ts` | service (client API layer) | request-response | itself — `launchCampaign`/`scheduleCampaign`/`testSendCampaign`/`CampaignResponse` | exact |

**Note on analogs:** Every touched file already implements the exact pattern this phase extends (locked transaction, typed error family, additive-optional job field, dirty-banner inline-copy shape). There are no *new* files in this phase — the planner should treat each file's **own current code** as its analog, extended in place. Cross-file reuse (e.g., amber Card style, `computeIncompleteReason` shape) is called out explicitly below.

## Pattern Assignments

### `packages/db/src/schema/campaigns.ts` (model, CRUD)

**Analog:** itself, lines 39-69 (current `campaigns` table)

**Core pattern — add column** (append inside the `pgTable` call, after `updatedAt` or near other integer counters):
```typescript
// D-05: monotonically-incrementing optimistic-lock token. Bumped by every
// mutation to this row (draft PATCH, launch, schedule, cancel) inside the
// same locked transaction that performs the write -- see
// campaign.repository.ts. Never written directly by application code
// outside a repository function; the client only ever echoes back a value
// it previously read via `expectedVersion`.
version: integer("version").notNull().default(1),
```

**Migration analog** (`packages/db/migrations/0056_workspace_daily_rollup_dirtied_at.sql` — doc-comment-then-ALTER convention):
```sql
-- Phase 20 (TMPL-02, D-05) -- version: optimistic-concurrency token for
-- campaigns. Bumped by every write (draft edit, launch, schedule, cancel)
-- inside the SAME locked transaction that performs the mutation, so exactly
-- one increment happens per user-initiated action. Clients read `version`
-- from the campaign GET response and echo it back as `expectedVersion` on
-- launch/schedule/test-send; a mismatch inside the FOR UPDATE-locked
-- read-check-write throws CampaignStateError('version_conflict').
ALTER TABLE campaigns ADD COLUMN version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN campaigns.version IS
  'TMPL-02 (D-05): optimistic-lock token, bumped on every mutation (draft edit + status transitions) inside the same locked transaction as the write. Checked (not just bumped) by launchCampaign/scheduleCampaign against the client-supplied expectedVersion.';
```

---

### `packages/shared-schemas/src/campaign.ts` (config/zod, request-response)

**Analog:** itself, lines 47-70 (`launchCampaignSchema`, `scheduleCampaignSchema`, `testSendCampaignSchema`)

**Core pattern — required precondition field** (D-06: required, not optional):
```typescript
// D-06: required on all three send-path bodies -- a request without it is a
// 400 (zod .safeParse failure), never a silently-bypassed soft check.
export const launchCampaignSchema = z.object({
  expectedVersion: z.number().int().min(1),
});
export type LaunchCampaignInput = z.infer<typeof launchCampaignSchema>;

export const scheduleCampaignSchema = z.object({
  scheduledAt: z.string().datetime(),
  expectedVersion: z.number().int().min(1),
});

export const testSendCampaignSchema = z.object({
  to: z.string().email().optional(),
  dynamicTemplateData: z.record(z.string(), z.unknown()).optional(),
  expectedVersion: z.number().int().min(1),
});
```

---

### `packages/shared-schemas/src/queues.ts` (config/zod, event-driven job payload)

**Analog:** itself, lines 150-178 — the `requestId` additive-optional precedent (Phase 15/R-05), doc comment style to copy verbatim in structure:
```typescript
// (existing requestId doc comment, lines 156-167, is the template to
// pattern-match for the new fields' own doc comment)
requestId: z.string().optional(),
```

**Core pattern — additive-optional snapshot fields (D-12)**, extend `emailBroadcastJobSchema`:
```typescript
export const emailBroadcastJobSchema = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
  kind: z.enum(["campaign", "test"]),
  contactId: z.string().uuid().optional(),
  testTo: z.string().email().optional(),
  testData: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string().optional(),
  // TMPL-03/D-12: snapshot of the confirmed-saved template/sender at
  // test-send enqueue time, additive-optional (same rolling-deploy-safe
  // convention as requestId above, NOT a schemaVersion bump) -- an in-flight
  // job enqueued before this change has neither field and the worker falls
  // back to its current row-read behavior.
  templateId: z.string().optional(),
  fromEmail: z.string().email().optional(),
});
```

**Error handling — no new pattern needed here** (schema-only file).

---

### `apps/api/src/modules/campaigns/campaign.repository.ts` (service, CRUD locked transaction)

**Analog:** itself, lines 214-243 (`launchCampaign`, current code) and lines 171-206 (`updateCampaign`)

**Imports pattern** (lines 1-2, unchanged):
```typescript
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";
import { SEND_STATUSES, type SendStatus } from "@mega-crm/delivery-core";
```

**Typed error family — extend `CampaignStateError`** (lines 69-77):
```typescript
export class CampaignStateError extends Error {
  constructor(
    message: string,
    public readonly code: "illegal_transition" | "incomplete" | "not_found" | "version_conflict",
    public readonly currentVersion?: number
  ) {
    super(message);
    this.name = "CampaignStateError";
  }
}
```

**Core pattern — version check inside the existing locked transaction** (extends `launchCampaign`, lines 214-243; same shape applies to `scheduleCampaign` lines 250-273 and `updateCampaign` lines 171-206):
```typescript
export async function launchCampaign(id: string, expectedVersion: number): Promise<CampaignRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<CampaignRow>(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = rows[0];
    if (!existing) throw new CampaignStateError("Campaign not found", "not_found");
    if (existing.status !== "draft") {
      throw new CampaignStateError("Only a draft campaign can be launched", "illegal_transition");
    }
    // D-07: version check joins the existing status check, same locked row,
    // BEFORE the incomplete-fields check (order matches D-08's "conflict
    // wins over incomplete" precedence -- verify against final route mapping).
    if (existing.version !== expectedVersion) {
      throw new CampaignStateError("Campaign was modified", "version_conflict", existing.version);
    }
    if (!existing.templateId || !(existing.fromEmail || existing.fromSenderId) || !existing.segmentId) {
      throw new CampaignStateError("Campaign is missing a required field before launch", "incomplete");
    }
    // Pitfall #1 fix: fold sender-resolution persistence into this SAME
    // UPDATE (one write, one version bump) rather than a prior separate
    // transaction in sender-resolver.ts / campaigns.routes.ts.
    const { rows: updated } = await client.query<CampaignRow>(
      `UPDATE campaigns SET status = 'sending', sending_started_at = now(),
         version = version + 1, updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [workspaceId, id]
    );
    return updated[0];
  });
}
```

**`updateCampaign` also bumps version (Pitfall #4)** — extend the existing `UPDATE` (lines 192-203):
```typescript
const { rows: updated } = await client.query<CampaignRow>(
  `UPDATE campaigns SET
     name = $3, segment_id = $4, template_id = $5, from_sender_id = $6,
     from_email = $7, version = version + 1, updated_at = now()
   WHERE workspace_id = $1 AND id = $2
   RETURNING ${CAMPAIGN_COLUMNS}`,
  [workspaceId, id, nextName, nextSegmentId, nextTemplateId, nextFromSenderId, nextFromEmail]
);
```

**`CampaignRow` interface** — add `version: number;` to the interface (lines 6-31) and `version as "version"` to `CAMPAIGN_COLUMNS` (lines 34-59).

**`cancelCampaign`** also bumps version (D-05: status transitions bump too) but takes no `expectedVersion` param (D-06 doesn't list cancel) — just add `version = version + 1` to both `UPDATE` branches at lines 294-299 and 304-309.

---

### `apps/api/src/modules/campaigns/campaigns.routes.ts` (controller, request-response)

**Analog:** itself — `mapCampaignStateError` (lines 84-93), launch handler (lines 294-337), schedule handler (lines 339-378), test-send handler (lines 431-492)

**Error-mapping pattern — widen to include `code` on every branch (Pitfall #2)**:
```typescript
function mapCampaignStateError(err: unknown): { code: number; body: Record<string, unknown> } | null {
  if (!(err instanceof CampaignStateError)) return null;
  if (err.code === "not_found") {
    return { code: 404, body: { error: "Campaign not found", code: err.code } };
  }
  if (err.code === "illegal_transition") {
    return { code: 409, body: { error: err.message, code: err.code } };
  }
  if (err.code === "version_conflict") {
    return {
      code: 409,
      body: { error: err.message, code: err.code, currentVersion: err.currentVersion },
    };
  }
  return { code: 422, body: { error: err.message, code: err.code } };
}
```

**Validation pattern — launch route's first-ever body parse (Pitfall #3)**, copy the schedule route's `parsed.success` shape (lines 344-347) verbatim into the launch handler:
```typescript
fastify.post(
  "/api/workspaces/:slug/campaigns/:id/launch",
  { preHandler: requirePermission("campaign", "launch") },
  async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const parsed = launchCampaignSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const workspace = await findActiveWorkspaceBySlug(slug);
    if (!workspace) return reply.code(404).send(NOT_FOUND_BODY);
    try {
      const launched = await withTenant(workspace.id, () =>
        launchCampaign(id, parsed.data.expectedVersion)
      );
      // ... existing kickoff enqueue unchanged
    } catch (err) {
      // ... existing senderMapped / incomplete / mapCampaignStateError chain unchanged
    }
  }
);
```

**Import addition** (line 6-7 area): add `launchCampaignSchema` to the `@mega-crm/shared-schemas` import block.

**Test-send snapshot pattern (D-12)** — extend the enqueue call at lines 478-489:
```typescript
await emailBroadcastQueue.add(
  "test",
  {
    workspaceId: workspace.id,
    campaignId: id,
    kind: "test",
    testTo,
    testData: parsed.data.dynamicTemplateData,
    // TMPL-03/D-12: snapshot the VERIFIED templateId + resolved fromEmail at
    // enqueue time -- closes the enqueue->dispatch async gap where a save
    // could swap the template under a queued test.
    templateId: campaign.templateId ?? undefined,
    fromEmail: resolvedFromEmail, // value returned by resolveCampaignFromEmail above
    ...(requestId !== undefined ? { requestId } : {}),
  },
  { jobId }
);
```

**Pitfall #1 restructure — sender resolution must not race the version check.** Do NOT call `resolveCampaignFromEmail`'s persisting write in a separate transaction before `launchCampaign`/`scheduleCampaign` (current lines 304-313, 359-368). Resolve without persisting (read-only SendGrid-facing call) outside the lock, then pass the resolved email into `launchCampaign`/`scheduleCampaign` so the repository persists it inside the SAME locked transaction as the version check + status flip. See RESEARCH.md Pitfall #1 for the full before/after contract — this is the single highest-risk change in the phase and needs its own regression test (fromSenderId campaign launches without spurious `version_conflict`).

---

### `apps/api/src/modules/campaigns/sender-resolver.ts` (service, request-response)

**Analog:** itself — current `resolveCampaignFromEmail`. Not fully read this session (RESEARCH.md already traced its shape in Pitfall #1); the planner must open this file directly to split "resolve" from "persist" per the restructure above. Read this file before implementing — RESEARCH.md's Pattern 3 / Pitfall #1 sections are the authoritative excerpt of its current call-site behavior.

---

### `apps/worker/src/queues/send-dispatch.ts` (service, event-driven)

**Analog:** itself, `kind === "test"` branch (RESEARCH.md cites line ~630, `readSendPrereqs`)

**Core pattern — prefer job snapshot, fallback to row-read**:
```typescript
// TMPL-03/D-12: for kind='test', prefer the enqueue-time snapshot (what the
// marketer confirmed) over a fresh row-read (which could have changed since
// enqueue). Absent fields (pre-Phase-20 in-flight jobs) fall back to the
// current readSendPrereqs row-read -- rolling-deploy-safe, matches the
// additive-optional convention on emailBroadcastJobSchema.
const templateId = job.data.kind === "test" && job.data.templateId
  ? job.data.templateId
  : prereqs.templateId;
const fromEmail = job.data.kind === "test" && job.data.fromEmail
  ? job.data.fromEmail
  : prereqs.fromEmail;
```
Do not change the `kind === "campaign"` branch — launch/schedule are verified safe by construction (Pattern 3 in RESEARCH.md), no snapshot needed there.

---

### `apps/web/src/features/campaigns/CampaignDetailPage.tsx` (component, composition seam)

**Analog:** RESEARCH.md's Architecture Diagram + Pattern 1 (this file was read in full during research but not in this session — re-open before implementing). It is the seam where lifted form state (from `CampaignBuilderPage`) and the dirty banner must live, per D-01's "Builder form state must be lifted/shared" decision. No existing sibling-sharing pattern exists elsewhere in this codebase to copy verbatim (Don't-Hand-Roll table recommends lifting to this common ancestor, not a new store).

---

### `apps/web/src/features/campaigns/CampaignBuilderPage.tsx` (component, request-response)

**Analog:** itself, lines 90-238

**Core pattern — dirty-state comparison** (fields already tracked at lines 96-99, saved-row sync at lines 110-117):
```typescript
// TMPL-01/D-02: dirty = ANY of these differs from the last-saved row.
// fromEmail excluded (system-resolved by CR-02, not marketer-edited --
// including it would cause a false-dirty flash right after resolution).
function computeIsDirty(
  form: { name: string; segmentId: string | null; templateId: string | null; fromSenderId: string | null },
  saved: CampaignResponse
): boolean {
  return (
    form.name.trim() !== saved.name ||
    form.segmentId !== saved.segmentId ||
    form.templateId !== saved.templateId ||
    form.fromSenderId !== saved.fromSenderId
  );
}
```

**Save mutation pattern to reuse for the banner's «Сохранить» button** (lines 121-142, `saveMutation`) — the banner (D-03) invokes this SAME mutation, not a duplicate.

**Amber Card style to reuse verbatim for the dirty banner** (lines 179-186):
```typescript
<Card className="border-amber-200 bg-amber-50">
  <CardContent className="p-4 text-sm text-amber-700">
    {/* D-01: "Есть несохранённые изменения…" + inline Сохранить button */}
  </CardContent>
</Card>
```

**`useEffect` server-row sync — D-10's "server wins" reset already implements this** (lines 110-117), reused unmodified as the refetch-then-resync behavior after a `version_conflict`/`illegal_transition` 409.

---

### `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx` (component, request-response)

**Analog:** itself — `computeIncompleteReason` (lines 271-277), `LaunchConfirmDialog`/`ScheduleDialog` mutations (lines 52-206)

**Reusable inline-copy pattern (D-01 analog for the dirty banner)**:
```typescript
function computeIncompleteReason(campaign: CampaignResponse): string | null {
  if (!campaign.segmentId) return "Выберите сегмент-аудиторию";
  if (!campaign.templateId) return "Выберите шаблон письма";
  if (!campaign.fromSenderId && !campaign.fromEmail) return "Выберите отправителя";
  return null;
}
// rendered as: {incompleteReason ? <p className="text-sm text-destructive">{incompleteReason}</p> : null}
```

**Core pattern — mutation gains `expectedVersion`, error handling gains typed-code branching (D-07/D-08/D-09)**, extends `launchMutation` (lines 72-81):
```typescript
const launchMutation = useMutation({
  mutationFn: () => launchCampaign(slug, campaign.id, { expectedVersion: campaign.version }),
  onSuccess: async () => {
    setServerError(null);
    await queryClient.invalidateQueries({ queryKey: campaignsQueryKey(slug) });
    toast.success("Кампания отправлена");
    onOpenChange(false);
  },
  onError: async (err) => {
    // D-08/D-09/Pitfall #2: branch on err.body.code, not err.message string.
    if (err instanceof ApiError && err.status === 409) {
      const code = (err.body as { code?: string })?.code;
      if (code === "version_conflict") {
        setServerError("Кампания была изменена — данные обновлены, проверьте и повторите");
        await queryClient.invalidateQueries({ queryKey: ["workspace", slug, "campaigns", campaign.id] });
        return; // dialog stays open (D-08) -- never auto-retry
      }
      if (code === "illegal_transition") {
        setServerError(`Кампания уже в статусе «${/* map campaign.status here */""}» — обновите страницу`);
        await queryClient.invalidateQueries({ queryKey: ["workspace", slug, "campaigns", campaign.id] });
        return;
      }
    }
    setServerError(GENERIC_ERROR);
  },
});
```
Apply the identical `onError` shape to `scheduleMutation` (lines 139-148). `ApiError`/`.body` access pattern verified in `apps/web/src/lib/api.ts:6-15,42-51` per RESEARCH.md Pitfall #2 — no fetch-wrapper change needed, only the mutation's `onError`.

---

### `apps/web/src/features/campaigns/TestSendPanel.tsx` (component, request-response)

**Analog:** itself, `testSendMutation` (lines 67-77)

**Core pattern — same `expectedVersion` precondition + conflict copy (D-11)**:
```typescript
const testSendMutation = useMutation({
  mutationFn: (body: { to?: string; dynamicTemplateData?: Record<string, unknown> }) =>
    testSendCampaign(slug, campaign.id, { ...body, expectedVersion: campaign.version }),
  onSuccess: (result) => {
    setServerError(null);
    toast.success(`Тестовое письмо поставлено в очередь на ${result.to}`, {
      description: TEST_SEND_QUEUED_DESCRIPTION,
    });
  },
  onError: (err) => {
    // Same code-branching pattern as LaunchScheduleDialogs' onError above --
    // 409 version_conflict gets the "изменена, обновлены" copy at discretion
    // (D-08's pattern, TestSendPanel's exact wording/placement is planner's
    // call per CONTEXT.md Discretion).
    setServerError(TEST_SEND_FAILURE);
  },
});
```

---

### `apps/web/src/features/campaigns/api.ts` (service, request-response)

**Analog:** itself, lines 82-113 (`launchCampaign`, `scheduleCampaign`, `testSendCampaign`) and `CampaignResponse` (lines 17-41)

**Core pattern — add `version` to the response type and `expectedVersion` to the three send-path calls**:
```typescript
export interface CampaignResponse {
  // ...unchanged fields...
  version: number; // TMPL-02: optimistic-lock token, echoed back as expectedVersion
}

export function launchCampaign(
  slug: string,
  id: string,
  body: { expectedVersion: number }
): Promise<CampaignResponse> {
  return apiPost<CampaignResponse>(`/api/workspaces/${slug}/campaigns/${id}/launch`, body);
}

export function scheduleCampaign(
  slug: string,
  id: string,
  body: ScheduleCampaignInput // now includes expectedVersion per shared-schemas change
): Promise<CampaignResponse> {
  return apiPost<CampaignResponse>(`/api/workspaces/${slug}/campaigns/${id}/schedule`, body);
}

export function testSendCampaign(
  slug: string,
  id: string,
  body: TestSendCampaignInput // now includes expectedVersion
): Promise<{ queued: boolean; to: string }> {
  return apiPost<{ queued: boolean; to: string }>(`/api/workspaces/${slug}/campaigns/${id}/test-send`, body);
}
```

**`toCampaignResponse` (backend, `campaigns.routes.ts:107-133`) must also add `version: row.version,`** so the client type and the server payload stay in lockstep.

## Shared Patterns

### Typed error family (`CampaignStateError`)
**Source:** `apps/api/src/modules/campaigns/campaign.repository.ts:69-77`
**Apply to:** `campaign.repository.ts` (new `"version_conflict"` code + `currentVersion` carrier), `campaigns.routes.ts` (`mapCampaignStateError` widened to include `code` on every branch — Pitfall #2)

### Locked read-check-write transaction shape
**Source:** `apps/api/src/modules/campaigns/campaign.repository.ts:214-243` (`launchCampaign`), `:250-273` (`scheduleCampaign`), `:171-206` (`updateCampaign`)
**Apply to:** every repository function that must check `version` before mutating — the version check is ONE more branch inside the SAME `SELECT ... FOR UPDATE` transaction, never a separate pre-check (TOCTOU anti-pattern, explicitly called out in RESEARCH.md)

### Amber notice Card style
**Source:** `apps/web/src/features/campaigns/CampaignBuilderPage.tsx:179-186` (`border-amber-200 bg-amber-50`)
**Apply to:** the new dirty-state banner in `CampaignDetailPage.tsx` (D-01)

### Inline disabled-reason copy (`string | null` function + `<p className="text-sm text-destructive">`)
**Source:** `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx:271-277` (`computeIncompleteReason`)
**Apply to:** the new `computeIsDirty`/dirty-reason copy (D-01), reusing the exact rendering shape

### `ApiError.body`-based error-code branching
**Source:** `apps/web/src/lib/api.ts:6-15,42-51` (verified by RESEARCH.md; not re-read this session — planner should re-verify signature before use)
**Apply to:** `LaunchScheduleDialogs.tsx`'s and `TestSendPanel.tsx`'s mutation `onError` handlers — branch on `err.body.code`, never on `err.message` string content (Pitfall #2's explicit warning sign)

### Additive-optional job-payload field convention (no `schemaVersion` bump)
**Source:** `packages/shared-schemas/src/queues.ts:156-176` (`requestId` doc comment + field, Phase 15/R-05 precedent)
**Apply to:** `emailBroadcastJobSchema`'s new `templateId`/`fromEmail` fields (D-12)

## No Analog Found

None — every touched file already contains the exact pattern this phase extends; no capability in this phase requires a pattern absent from the current codebase.

## Metadata

**Analog search scope:** `apps/api/src/modules/campaigns/`, `apps/worker/src/queues/`, `apps/web/src/features/campaigns/`, `apps/web/src/lib/api.ts`, `packages/db/src/schema/`, `packages/db/migrations/`, `packages/shared-schemas/src/`
**Files scanned:** 10 (all listed in CONTEXT.md's canonical_refs, all confirmed to exist and read in full or via targeted excerpt this session, except `sender-resolver.ts` and `CampaignDetailPage.tsx` which were traced via RESEARCH.md's direct-code-read citations rather than re-read in this session — flagged above for planner re-verification)
**Pattern extraction date:** 2026-08-21
