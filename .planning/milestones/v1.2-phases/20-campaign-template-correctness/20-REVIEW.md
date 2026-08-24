---
phase: 20-campaign-template-correctness
reviewed: 2026-08-21T00:00:00Z
depth: standard
files_reviewed: 27
files_reviewed_list:
  - apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts
  - apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts
  - apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts
  - apps/api/src/modules/campaigns/campaign.repository.ts
  - apps/api/src/modules/campaigns/campaigns.routes.ts
  - apps/api/src/modules/campaigns/sender-resolver.ts
  - apps/web/e2e/campaign-template-correctness.spec.ts
  - apps/web/src/features/campaigns/__tests__/campaign-dirty-blocking.test.tsx
  - apps/web/src/features/campaigns/__tests__/campaignDirtyState.test.ts
  - apps/web/src/features/campaigns/__tests__/campaignSendConflict.test.ts
  - apps/web/src/features/campaigns/api.ts
  - apps/web/src/features/campaigns/CampaignBuilderPage.tsx
  - apps/web/src/features/campaigns/CampaignDetailPage.tsx
  - apps/web/src/features/campaigns/campaignDirtyState.ts
  - apps/web/src/features/campaigns/CampaignDirtyStateContext.tsx
  - apps/web/src/features/campaigns/campaignSendConflict.ts
  - apps/web/src/features/campaigns/CampaignStatusBadge.tsx
  - apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx
  - apps/web/src/features/campaigns/TestSendPanel.tsx
  - apps/web/src/features/campaigns/UnsavedChangesBanner.tsx
  - apps/worker/src/queues/__tests__/test-send-template-snapshot.test.ts
  - apps/worker/src/queues/send-dispatch.ts
  - packages/db/migrations/0066_campaigns_version.sql
  - packages/db/migrations/meta/_journal.json
  - packages/db/migrations/meta/0066_snapshot.json
  - packages/db/src/__tests__/migration-empty-diff.test.ts
  - packages/db/src/__tests__/migration-rollback-rehearsal.test.ts
  - packages/db/src/__tests__/migration-tiers.test.ts
  - packages/db/src/migration-tiers.ts
  - packages/db/src/schema/campaigns.ts
  - packages/shared-schemas/src/campaign.ts
  - packages/shared-schemas/src/queues.ts
findings:
  critical: 1
  warning: 2
  info: 2
  total: 5
status: issues_found
---

# Phase 20: Code Review Report

**Reviewed:** 2026-08-21
**Depth:** standard
**Files Reviewed:** 27 (files_reviewed_list, above, is authoritative — the config's `files` count differed slightly from the actual list length; both are reconciled here)
**Status:** issues_found

## Summary

Reviewed the `campaigns.version` optimistic-lock column, the locked launch/schedule/test-send preconditions in `campaign.repository.ts`, the refactored `sender-resolver.ts`, the worker's snapshot-override precedence in `send-dispatch.ts`, and the full frontend dirty-state/conflict-recovery stack (`campaignDirtyState.ts`, `CampaignDirtyStateContext.tsx`, `campaignSendConflict.ts`, the builder/detail pages, the launch/schedule dialogs, and the test-send panel), plus the migration and its tier classification.

The version-check-inside-the-lock design is sound and consistently applied: every one of `launchCampaign`/`scheduleCampaign`/`prepareCampaignTestSend` reads-locks the row, checks status before version (so a concurrent state change reports the real state rather than a version conflict), checks version before any field-completeness check, and persists the sender-resolution result in the SAME statement as the version bump — closing the exact race (a separate pre-lock write bumping the version out from under its own check) the code comments call out as Pitfall #1. Tenant isolation on every new/changed query (`campaigns`, `workspace_sendgrid_keys`, the `sends` ledger re-aggregation) is consistently `workspace_id`-scoped in addition to RLS; no cross-tenant leak was found. The worker's `kind='test'` snapshot-override-vs-row-read precedence in `readSendPrereqs` is correctly scoped to `kind='test'` only — the `kind='campaign'`/`kind='flow'` paths never consult the override fields, matching the "launch/schedule are never editable after transition, so there is no window a snapshot needs to protect" design rationale, and this is directly exercised by `test-send-template-snapshot.test.ts`'s scoping-pin case.

One functional defect was found in the new frontend dirty-state comparator (CR-01 below): it silently produces a false "unsaved changes" state — blocking launch, schedule, and test-send — for any campaign whose persisted `name` is not already whitespace-trimmed, because the comparison trims only the live form value, not the saved value, while the campaign schemas that persist `name` (`createCampaignSchema`/`updateCampaignSchema`) do not enforce trimming themselves. Two warnings and two info-level items round out the rest.

## Critical Issues

### CR-01: Dirty-state comparator trims only the form side of `name`, producing a false-positive "unsaved changes" block for any campaign whose saved name has leading/trailing whitespace

**File:** `apps/web/src/features/campaigns/campaignDirtyState.ts:52`
**Issue:**

```ts
export function computeIsDirty(form: CampaignFormSnapshot, saved: CampaignFormSnapshot): boolean {
  if (form.name.trim() !== saved.name) return true;
  ...
```

Only `form.name` is trimmed before the comparison; `saved.name` is compared as-is. The doc comment states this trim exists so leading/trailing whitespace "alone never reads as dirty" — but that guarantee only holds if `saved.name` is *itself* already trimmed. Nothing enforces that:

- `createCampaignSchema`/`updateCampaignSchema` (`packages/shared-schemas/src/campaign.ts:10-34`) validate `name` with `z.string().min(1)` only — no `.trim()` transform. A campaign created or renamed through any client other than this exact builder UI (a script, an admin tool, a future integration, or simply a POST with a trailing space) persists `name` untrimmed.
- `duplicateCampaign` (`campaign.repository.ts:498-526`) copies `existing.name` verbatim into the new draft's `INSERT`, with no trim — so duplicating an already-untrimmed campaign propagates the untrimmed name to the new draft too.
- The only place that trims before persisting is this UI's own `handleSave` (`CampaignBuilderPage.tsx:150-167`, `body.name = name.trim()`), which is not authoritative over the API contract.

When such a campaign is opened in the builder, the server-row sync effect sets `form.name = campaign.name` (untrimmed) on load. `computeIsDirty` then evaluates `form.name.trim() !== saved.name` → `"Spring Sale" !== "Spring Sale "` → `true`, even though the marketer made no edit at all. `UnsavedChangesBanner` renders immediately on page load, and `LaunchScheduleActions`/`TestSendPanel` disable launch, schedule, and test-send — for a campaign that is otherwise complete and ready to send — until the marketer notices the banner and clicks "Сохранить" (which happens to fix it, since the save path does trim). This is a real, user-facing regression of the exact core functionality (CAMP-02/03/04) this phase is supposed to protect, triggered by data this phase's own schemas accept as fully valid.

The existing unit test (`campaignDirtyState.test.ts`, "trims the form name before comparing...") only covers the case where `saved.name` is *already* trimmed, so it does not catch this asymmetry.

**Fix:** Trim both sides in the comparator (belt-and-suspenders), and/or enforce trimming at the schema boundary so the invariant the comparator assumes is actually guaranteed:

```ts
// campaignDirtyState.ts
export function computeIsDirty(form: CampaignFormSnapshot, saved: CampaignFormSnapshot): boolean {
  if (form.name.trim() !== saved.name.trim()) return true;
  ...
```

```ts
// packages/shared-schemas/src/campaign.ts
export const createCampaignSchema = z.object({
  name: z.string().trim().min(1),
  ...
});
export const updateCampaignSchema = z.object({
  name: z.string().trim().min(1).optional(),
  ...
});
```

Add a regression test seeding a saved snapshot with an untrimmed `name` (e.g. `snapshot({ name: "Spring Sale " })`) compared against the same, already-trimmed form value, asserting `computeIsDirty` returns `false`.

## Warnings

### WR-01: Sender resolution (a real SendGrid network call) runs before the locked version check on launch/schedule/test-send, so a stale `expectedVersion` still spends the tenant's own SendGrid API quota on every retry

**File:** `apps/api/src/modules/campaigns/campaigns.routes.ts:341-349` (launch), `:404-416` (schedule), `:513-521` (test-send)
**Issue:** All three routes call `resolveCampaignSenderEmail` (which decrypts the tenant's SendGrid key and calls `/v3/scopes` + `/v3/verified_senders`) *before* the version-checked repository call that would reject a stale/conflicting request. A marketer (or a buggy client) retrying a launch/schedule/test-send with a stale `expectedVersion` — the exact scenario this phase's conflict-recovery UX is built around — pays a full SendGrid round-trip on every attempt before ever learning the version is stale. Since this is the tenant's own BYO SendGrid key, repeated retries (e.g. an automated client not respecting D-08/D-09's "no auto-retry" guidance, or a marketer double-clicking through a slow network) consume the same rate-limited API surface the actual send pipeline depends on.
**Fix:** Do a cheap version pre-check (a plain `getCampaign` read, already fetched as `preLaunch`/`preSchedule`/`campaign`) against `parsed.data.expectedVersion` before calling `resolveCampaignSenderEmail`, short-circuiting to the same `version_conflict` 409 shape without the external call. The authoritative check inside the locked transaction stays exactly as-is (this is purely an early-exit optimization, not a replacement for the lock):

```ts
const preLaunch = await withTenant(workspace.id, () => getCampaign(id));
if (preLaunch && preLaunch.version !== parsed.data.expectedVersion) {
  return reply.code(409).send({
    error: "Campaign was modified since it was loaded",
    code: "version_conflict",
    currentVersion: preLaunch.version,
  });
}
```

### WR-02: `CampaignBuilderPage`'s server-row sync effect resets ALL four form fields on any change to the shared query object, relying on an unenforced convention (every other mutation on the page is dirty-gated) rather than anything checked in code or tests

**File:** `apps/web/src/features/campaigns/CampaignBuilderPage.tsx:115-123`
**Issue:**

```ts
useEffect(() => {
  const campaign = campaignQuery.data;
  if (!campaign) return;
  setName(campaign.name);
  setSegmentId(campaign.segmentId);
  setTemplateId(campaign.templateId);
  setFromSenderId(campaign.fromSenderId);
  setHasSyncedFromServer(true);
}, [campaignQuery.data]);
```

This effect is keyed on the whole `campaignQuery.data` object reference and unconditionally overwrites every one of the four form fields whenever that reference changes — not just the field(s) that actually changed server-side. `campaignQuery` uses the exact same query key (`["workspace", slug, "campaigns", id]`) that `TestSendPanel`'s test-send mutation invalidates on success (to pick up a version bump from a persisted sender resolution). Today this causes no visible symptom only because every other action on this page that can invalidate this key (`TestSendPanel`, `LaunchScheduleActions`/its dialogs) is itself disabled while `isDirty` is true — so nothing *else* can mutate/invalidate this query while the marketer has unsaved edits in the same tab. That protection is an emergent property of the current set of consumers, not something this effect, `CampaignDirtyStateContext`, or any test enforces. A later phase adding any other action that touches this same query key without going through the dirty gate (or an eventual cross-tab/live-update feature) will silently reintroduce exactly the "an unsaved edit is discarded without the marketer's consent" bug (TMPL-01) this phase exists to prevent, and nothing in this test suite would catch it — `campaign-dirty-blocking.test.tsx` only asserts the disabled/reason rendering for a hand-made static context value, never that a live refetch preserves unrelated unsaved fields.
**Fix:** Either (a) scope the sync effect to only run on the initial load / an actual `id` change (not every refetch), or (b) have it skip re-setting fields while `hasSyncedFromServer && isDirty` (reading the dirty state it already has access to via `usePublishCampaignFormState`'s sibling context), and add a test that seeds a dirty form, triggers a refetch of the same query key with different-but-otherwise-unrelated data (e.g. only `version`/`fromEmail` changed), and asserts the untouched form fields are NOT reset.

## Info

### IN-01: Dead/misleading null-guards on the test-send job payload's snapshot fields

**File:** `apps/api/src/modules/campaigns/campaigns.routes.ts:557-558`
**Issue:** `...(prepared.templateId !== null ? { templateId: prepared.templateId } : {})` and the equivalent for `fromEmail` are unreachable: `prepareCampaignTestSend` throws `incomplete` before returning unless both fields are already truthy (empty string included, via the `!existing.templateId` falsy check). The conditional shape implies these fields can legitimately be omitted from the snapshot, which — per `queues.ts`'s own doc comment on `templateId`/`fromEmail` — is only supposed to happen for a job enqueued by pre-Phase-20 code, never for a fresh enqueue. Leaving the conditional in place invites a future edit to accidentally make one of these fields actually optional at this call site (e.g. relaxing `prepareCampaignTestSend`'s completeness check) without anyone noticing that doing so would silently fall back to a live row read at dispatch time — exactly the async-gap bug TMPL-03 closes.
**Fix:** Assert non-null instead of conditionally omitting, so a future regression fails loudly:
```ts
if (!prepared.templateId || !prepared.fromEmail) {
  throw new Error("test-send: prepareCampaignTestSend returned an incomplete row after passing its own completeness check");
}
await emailBroadcastQueue.add("test", { ..., templateId: prepared.templateId, fromEmail: prepared.fromEmail, ... }, { jobId });
```

### IN-02: `readSendPrereqs`'s error message is reused for two different failure causes

**File:** `apps/worker/src/queues/send-dispatch.ts:268-276`
**Issue:** `throw new Error(\`Campaign ${campaignId} is missing a templateId/fromEmail for dispatch\`)` fires both when the campaign row genuinely lacks a template/sender AND when the campaign row does not exist at all (`campaignRows[0]` undefined — e.g. deleted between enqueue and dispatch). An operator triaging a failed/DLQ'd job from this message alone would reasonably (and incorrectly) assume a configuration gap rather than a deleted campaign.
**Fix:** Split into two distinct messages:
```ts
if (!campaign) {
  throw new Error(`Campaign ${campaignId} not found in workspace ${workspaceId} for dispatch`);
}
...
if (!templateId || !fromEmail) {
  throw new Error(`Campaign ${campaignId} is missing a templateId/fromEmail for dispatch`);
}
```

---

_Reviewed: 2026-08-21_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
