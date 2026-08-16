---
phase: 15-observability-alerting-frontend-resilience
reviewed: 2026-08-16T00:00:00Z
depth: standard
files_reviewed: 104
files_reviewed_list:
  - .github/workflows/ci.yml
  - .github/workflows/images.yml
  - apps/api/src/env.ts
  - apps/api/src/logger.ts
  - apps/api/src/middleware/tenant-context.ts
  - apps/api/src/modules/analytics/dashboard.repository.ts
  - apps/api/src/modules/analytics/dashboard.routes.ts
  - apps/api/src/modules/campaigns/campaigns.routes.ts
  - apps/api/src/modules/contacts/contact.repository.ts
  - apps/api/src/modules/ops/failed-send-share-watchdog.ts
  - apps/api/src/modules/ops/oldest-job-age-watchdog.ts
  - apps/api/src/modules/ops/queue-depth-watchdog.ts
  - apps/api/src/modules/ops/queue-monitor.ts
  - apps/api/src/modules/ops/webhook-lag-watchdog.ts
  - apps/api/src/sentry.ts
  - apps/api/src/server.ts
  - apps/web/src/App.tsx
  - apps/web/src/components/DataAsOfLabel.tsx
  - apps/web/src/components/EmptyState.tsx
  - apps/web/src/components/QueryErrorState.tsx
  - apps/web/src/components/RouteErrorBoundary.tsx
  - apps/web/src/components/RouteSuspenseFallback.tsx
  - apps/web/src/components/StaleDataBanner.tsx
  - apps/web/src/features/api-keys/ApiKeysSettings.tsx
  - apps/web/src/features/campaigns/CampaignDetailPage.tsx
  - apps/web/src/features/campaigns/CampaignProgress.tsx
  - apps/web/src/features/campaigns/CampaignsListPage.tsx
  - apps/web/src/features/campaigns/SendSettingsPage.tsx
  - apps/web/src/features/campaigns/TemplateSenderPickers.tsx
  - apps/web/src/features/contacts/ContactDetailPage.tsx
  - apps/web/src/features/contacts/ContactEventFeed.tsx
  - apps/web/src/features/contacts/ContactsListPage.tsx
  - apps/web/src/features/contacts/CsvImportHistory.tsx
  - apps/web/src/features/dashboard/WorkspaceDashboard.tsx
  - apps/web/src/features/dashboard/api.ts
  - apps/web/src/features/flows/canvas/FlowCanvas.tsx
  - apps/web/src/features/flows/canvas/SaveErrorBanner.tsx
  - apps/web/src/features/flows/canvas/UnsavedChangesDialog.tsx
  - apps/web/src/features/flows/canvas/useAutosaveDraft.ts
  - apps/web/src/features/flows/canvas/useUnsavedChangesGuard.ts
  - apps/web/src/features/flows/detail/FlowAnalyticsTable.tsx
  - apps/web/src/features/flows/detail/FlowDetailPage.tsx
  - apps/web/src/features/flows/list/FlowsListPage.tsx
  - apps/web/src/features/segments/SegmentDetailPage.tsx
  - apps/web/src/features/segments/SegmentsListPage.tsx
  - apps/web/src/features/send-log/SendLogPage.tsx
  - apps/web/src/features/send-log/SendLogRowDrawer.tsx
  - apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx
  - apps/web/src/features/team/TeamPage.tsx
  - apps/web/src/features/workspace-home/WorkspaceHome.tsx
  - apps/web/src/lib/sentry.ts
  - apps/web/src/main.tsx
  - apps/web/vite.config.ts
  - apps/worker/src/bull-board.ts
  - apps/worker/src/health-server.ts
  - apps/worker/src/logger.ts
  - apps/worker/src/processor-wrapper.ts
  - apps/worker/src/queues/analytics-reconciliation.worker.ts
  - apps/worker/src/queues/board-queues.ts
  - apps/worker/src/queues/campaign-kickoff.worker.ts
  - apps/worker/src/queues/campaign-scheduler.worker.ts
  - apps/worker/src/queues/email-broadcast.worker.ts
  - apps/worker/src/queues/email-triggered.worker.ts
  - apps/worker/src/queues/erasure-scrub-reclaim.worker.ts
  - apps/worker/src/queues/erasure-scrub.worker.ts
  - apps/worker/src/queues/events-ingest.worker.ts
  - apps/worker/src/queues/flows/flow-enroll-existing.worker.ts
  - apps/worker/src/queues/flows/flow-reconciliation.worker.ts
  - apps/worker/src/queues/flows/flow-run-advance.worker.ts
  - apps/worker/src/queues/flows/flow-segment-sweep-flow.worker.ts
  - apps/worker/src/queues/flows/flow-segment-sweep.worker.ts
  - apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts
  - apps/worker/src/queues/imports-csv.worker.ts
  - apps/worker/src/queues/partition-maintenance.worker.ts
  - apps/worker/src/queues/reputation-tick.worker.ts
  - apps/worker/src/queues/send-dispatch.ts
  - apps/worker/src/queues/send-reconciler.worker.ts
  - apps/worker/src/queues/webhook-events.worker.ts
  - apps/worker/src/queues/webhook-replay-sweep.worker.ts
  - apps/worker/src/sentry.ts
  - apps/worker/src/server.ts
  - docker/Dockerfile.web
  - docker/alloy/config.alloy
  - docker/docker-compose.prod.yml
  - docker/prod.env.example
  - docker/redis.conf
  - packages/db/migrations/0064_ops_alert_state_and_rollup_watermark.sql
  - packages/db/migrations/0065_webhook_endpoints_scan_grant.sql
  - packages/db/src/analytics/daily-rollup.ts
  - packages/db/src/index.ts
  - packages/db/src/migration-tiers.ts
  - packages/db/src/ops/alert-state.ts
  - packages/db/src/schema/ops-alert-state.ts
  - packages/db/src/schema/workspace-daily-rollup.ts
  - packages/redaction/src/index.ts
  - packages/redaction/src/pino-redact.ts
  - packages/redaction/src/sentry-scrub.ts
  - packages/shared-schemas/src/analytics.ts
  - packages/shared-schemas/src/index.ts
  - packages/shared-schemas/src/queues.ts
  - packages/tenant-context/src/index.ts
  - scripts/check-runbook-coverage.mjs
  - scripts/check-web-chunks.mjs
  - scripts/validate-prod-compose.mjs
findings:
  critical: 1
  warning: 3
  info: 3
  total: 7
status: issues_found
---

# Phase 15: Code Review Report

**Reviewed:** 2026-08-16
**Depth:** standard
**Files Reviewed:** 104
**Status:** issues_found

## Scope note

Phase 15 touched 153 files in total. Per the workflow's scoping instructions,
test files, fixtures, docs/runbooks, package manifests (`package.json`/
`package-lock.json`), and migration `meta/_journal.json` bookkeeping were
deliberately excluded from this review's 104-file scope. The 104 files above
are every production-source file the workflow supplied for this review:
correlation tracing (`@mega-crm/tenant-context`), Pino redaction, the
Sentry init/scrub gate (api/worker/web), four new OPS-13 watchdogs +
alert-dedup primitive, Bull Board on the worker's loopback health listener,
Grafana Alloy log shipping, and the frontend-resilience half (route code
splitting, error/empty states, route error boundaries, the flow-canvas
unsaved-changes guard, and the dashboard staleness/freshness UI).

To resolve two findings below with certainty, `scripts/deploy.sh` and
`packages/delivery-core/src/send-state-machine.ts` were also read — both are
out of this phase's declared file scope (pre-existing, unchanged by Phase 15)
and are cited only as corroborating evidence, not as reviewed phase changes.

## Summary

Overall this phase is unusually disciplined: the OPS-17/D-11 "full error vs.
stale-error-with-retained-data" split is applied consistently across nearly
every list/detail page in `apps/web`, the Sentry redaction gate is wired as a
genuinely blocking CI step before any live-DSN capture path was permitted to
exist, the four new OPS-13 watchdogs correctly derive their terminal/lag
signals from the fields their own header comments claim (verified against
`send-state-machine.ts` and `daily-rollup.ts` directly), and the new
migrations/grants are appropriately least-privilege and additive-only.

One finding is a **confirmed, reachable Critical**: the production
`docker-compose.prod.yml` wires `SENTRY_DSN_API`/`SENTRY_DSN_WORKER`/
`SENTRY_ENVIRONMENT` through compose-level `${VAR}` interpolation inside the
`environment:` block, which Docker Compose resolves from the *invoking
shell's* environment, not from the `env_file: ${MEGA_CRM_ENV_FILE}` entry on
the same service — and `scripts/deploy.sh` never exports these three names.
Because Compose's `environment:` block takes precedence over `env_file:` for
the same key, this silently overwrites a correctly-configured
`MEGA_CRM_ENV_FILE` value with an empty string on every real deploy,
disabling error tracking for both `apps/api` and `apps/worker` with no error
or visible symptom — defeating this phase's own OPS-08 deliverable.

The remaining findings are narrower: one frontend page (`App.tsx`'s
`RootRedirect`) and one component (`FlowAnalyticsTable.tsx`) don't apply the
same isError/stale-data discipline the rest of this phase's UI work applies
everywhere else, and `processor-wrapper.ts`'s `requestId` fallback quietly
blurs the `requestId`/`jobId` correlation distinction the tracing design is
built around.

## Critical Issues

### CR-01: Production compose file silently disables Sentry for api/worker on every real deploy

**File:** `docker/docker-compose.prod.yml:271-282` (api service), `:315-323` (worker service)
**Issue:**

```yaml
  api:
    env_file:
      - path: ${MEGA_CRM_ENV_FILE}
        required: false
    environment:
      NODE_ENV: production
      SENTRY_DSN_API: ${SENTRY_DSN_API}
      SENTRY_ENVIRONMENT: ${SENTRY_ENVIRONMENT}
      IMAGE_TAG: ${IMAGE_TAG}
```

`${SENTRY_DSN_API}` / `${SENTRY_ENVIRONMENT}` here are **compose-file-level**
variable references — resolved by the `docker compose` CLI when it parses
the YAML text, from the *invoking shell's* environment (or a `.env` file
next to the compose file, which does not exist in this repo). This is a
completely different mechanism from `env_file: ${MEGA_CRM_ENV_FILE}`, which
loads key/value pairs into the *container's* process environment at
container start.

Docker Compose's documented merge order has `environment:` **override**
`env_file:` for the same key. So even though `MEGA_CRM_ENV_FILE` (per
`docker/prod.env.example`) is exactly where an operator is instructed to put
a real `SENTRY_DSN_API` value, that value is loaded via `env_file:` and then
unconditionally overwritten by the `environment:` block's own
`${SENTRY_DSN_API}` — which resolves to an empty string unless the deploying
shell itself happens to export `SENTRY_DSN_API`.

Confirmed empirically against `scripts/deploy.sh` (the actual deploy
entrypoint): it exports exactly five names before invoking `docker compose`
— `GHCR_IMAGE_BASE`, `SITE_ADDRESS`, `MEGA_CRM_ENV_FILE`, `IMAGE_TAG`,
`WORKER_STOP_GRACE_PERIOD_SECONDS` — and asserts only those three
(`GHCR_IMAGE_BASE`/`SITE_ADDRESS`/`MEGA_CRM_ENV_FILE`) as required. It never
exports `SENTRY_DSN_API`, `SENTRY_DSN_WORKER`, or `SENTRY_ENVIRONMENT`
(`grep -n "SENTRY" scripts/deploy.sh` returns nothing), and no `docker/.env`
file exists for Compose to auto-load instead.

The practical effect: on every real production deploy run via
`scripts/deploy.sh`, `docker compose` resolves `${SENTRY_DSN_API}` /
`${SENTRY_ENVIRONMENT}` (and the worker's `${SENTRY_DSN_WORKER}`) to blank,
Compose prints one easily-missed "variable is not set" warning, and both
`apps/api/src/sentry.ts`'s and `apps/worker/src/sentry.ts`'s `initSentry()`
see an empty DSN and silently no-op ("Sentry DSN not configured ... error
tracking disabled") — even though the operator followed
`docker/prod.env.example`'s instructions exactly and configured a real DSN
in `MEGA_CRM_ENV_FILE`. This is the entire OPS-08 deliverable (plan 15-10)
non-functional in production, with nothing in CI or the deploy script
catching it (`scripts/validate-prod-compose.mjs` validates against
`docker/prod.env.example`, whose `SENTRY_DSN_API=` line is *already* blank by
its own documented convention for secrets, so the gate cannot distinguish
"correctly blank in the example" from "will always resolve blank in
production regardless of the real secrets file").

**Fix:** Stop routing these three names through compose-level `${VAR}`
interpolation inside `environment:`. Either:
1. Remove `SENTRY_DSN_API` / `SENTRY_ENVIRONMENT` (and the worker's
   `SENTRY_DSN_WORKER`) from the `environment:` block entirely and let
   `env_file: ${MEGA_CRM_ENV_FILE}` supply them unmolested (this also
   requires `docker/prod.env.example` to document `IMAGE_TAG`/`SENTRY_*`
   consistently, since `IMAGE_TAG` is deliberately kept in `environment:`
   for a different, already-solved reason — it *is* exported by
   `deploy.sh`); or
2. Have `scripts/deploy.sh` export `SENTRY_DSN_API`, `SENTRY_DSN_WORKER`,
   and `SENTRY_ENVIRONMENT` (sourced from `$MEGA_CRM_ENV_FILE`) before every
   `docker compose` invocation, mirroring exactly what it already does for
   `GHCR_IMAGE_BASE`/`SITE_ADDRESS`/`IMAGE_TAG`/`WORKER_STOP_GRACE_PERIOD_SECONDS`.

Option 1 is simpler and removes an entire class of shell-vs-container env
confusion; option 2 preserves the current file's comments' stated intent
("passed through EXPLICITLY") but needs the export added where it was
apparently assumed to already exist.

Whichever option is chosen, treat an *exported-but-empty* `SENTRY_ENVIRONMENT`
as still broken, not merely "unset": `apps/api/src/sentry.ts:91` resolves
`options.environment ?? env.SENTRY_ENVIRONMENT ?? env.NODE_ENV` — `??` only
falls through on `null`/`undefined`, not on an empty string, so an exported
`SENTRY_ENVIRONMENT=""` will pin every Sentry event's `environment` tag to
`""` instead of falling back to `NODE_ENV`. Either guard with
`env.SENTRY_ENVIRONMENT || env.NODE_ENV` (or equivalent empty-string-aware
fallback) at the same time as fixing the compose wiring, or the fix will
silently trade "no Sentry events" for "Sentry events with a blank
environment tag."

## Warnings

### WR-01: `RootRedirect` treats a failed `/api/workspaces` fetch as "no workspace yet"

**File:** `apps/web/src/App.tsx:69-93`
**Issue:** The root route's redirect logic:

```tsx
const { data: workspaces, isPending: workspacesPending } = useQuery({
  queryKey: ["workspaces"],
  queryFn: () => apiGet<WorkspaceListItem[]>("/api/workspaces"),
  enabled: Boolean(session),
});

if (sessionPending || (session && workspacesPending)) { return null; }
if (!session) { return <Navigate to="/login" replace />; }
if (!workspaces || workspaces.length === 0) {
  return <Navigate to="/create-workspace" replace />;
}
return <Navigate to={`/w/${workspaces[0].slug}`} replace />;
```

never reads `isError`. Once the query settles (`isPending` false), a
rejected fetch leaves `workspaces` `undefined` exactly the same way a
successful-but-empty response would — both fall into
`!workspaces || workspaces.length === 0` and redirect an already-signed-in
user with real workspaces to `/create-workspace`, rather than showing a
retryable error. This is the identical branch every other page in this same
phase's file set (`WorkspaceHome.tsx`, `ContactDetailPage.tsx`,
`CampaignDetailPage.tsx`, `FlowDetailPage.tsx`, `SegmentDetailPage.tsx`, …)
was specifically restructured this phase (OPS-17/D-11) to split into a
distinct `isError` branch — `App.tsx` is the one root-level router
component in this same route tree that still has the pre-OPS-17 conflated
shape.

**Fix:**
```tsx
const { data: workspaces, isPending: workspacesPending, isError } = useQuery({ ... });
...
if (isError) {
  // render a retryable root-level error state instead of redirecting
}
if (!workspaces || workspaces.length === 0) { ... }
```

### WR-02: `FlowAnalyticsTable` clobbers previously-loaded rows on a background refetch failure

**File:** `apps/web/src/features/flows/detail/FlowAnalyticsTable.tsx:130-147`
**Issue:**
```tsx
if (analyticsQuery.isLoading) { return <Skeleton className="h-64 w-full" />; }
if (analyticsQuery.isError) {
  return <p className="text-sm text-destructive">Не удалось загрузить аналитику цепочки. Обновите страницу.</p>;
}
if (items.length === 0) { ... }
```
`analyticsQuery` (`useFlowAnalytics(slug, flowId)`) shares its exact query
key with `FlowDetailPage.tsx`'s own `analyticsQuery` (both key off
`[...flowKeys.detail(slug, id), "analytics"]`, confirmed in
`apps/web/src/features/flows/api.ts:348-354`) — so this data can be
invalidated/refetched in the background (e.g. after a pause/resume/publish
mutation elsewhere on the same detail page) while this tab is already
showing previously-loaded rows. `isError` here is checked with no
stale-data carve-out: a failed background refetch discards the entire
table in favor of a plain generic-error paragraph, with no Retry control —
exactly the "isError clobbers stale/successful data" anti-pattern this
phase's OPS-17/D-11 work (T-15-14) fixed everywhere else in
`apps/web` (every sibling list/detail page reviewed in this phase computes
`isFullyErrored = isError && !data` / `isStaleErrored = isError && data`
and only replaces the region on the former).

**Fix:** Apply the same split used by every other page in this phase, e.g.:
```tsx
const isFullyErrored = analyticsQuery.isError && !analyticsQuery.data;
const isStaleErrored = analyticsQuery.isError && Boolean(analyticsQuery.data);
if (analyticsQuery.isLoading) return <Skeleton .../>;
if (isFullyErrored) return <QueryErrorState title="..." onRetry={() => void analyticsQuery.refetch()} isFetching={analyticsQuery.isFetching} />;
// render the table with items, plus a QueryErrorState banner above it when isStaleErrored
```

### WR-03: `wrapProcessor`'s `requestId` fallback blurs the requestId/jobId correlation distinction it documents

**File:** `apps/worker/src/processor-wrapper.ts:184`
**Issue:**
```ts
const requestId = extractRequestId(job.data) ?? job.id;
...
const result = await withCorrelation({ jobId: job.id, requestId }, () => handler(job, token));
```
`extractRequestId`'s own doc comment (lines 113-129) explains that only
`emailBroadcastJobSchema` currently carries a real `requestId`, that every
other queue's payload has none, and that it "returns `undefined` rather than
throwing for any shape that doesn't carry a string `requestId`." That
contract holds inside `extractRequestId` itself, but the call site
immediately folds `job.id` into the same variable via `?? job.id` before
binding it into the correlation store as `requestId` — so for every queue
except `email-broadcast`/`email-triggered`, every log line's `requestId`
field, and the Sentry `request_id` tag `reportProcessorError`
(`apps/worker/src/sentry.ts:126-134`) attaches from
`ProcessorErrorContext.requestId`, is silently populated with the BullMQ
job id rather than being genuinely absent. Since `jobId` is *also* logged
and tagged separately, this doesn't lose information, but it does make
`requestId` and `jobId` indistinguishable in the vast majority of log lines
and Sentry events this phase's correlation work produces — an operator
correlating "did this specific HTTP request cause this job's failure" via
Loki's `| json` query (per `docker/alloy/config.alloy`'s own documented
correlation-query use case) cannot tell a genuine cross-boundary `requestId`
from a same-line `jobId` restated under a different key.

**Fix:** Either drop the `?? job.id` fallback and let `requestId` stay
genuinely `undefined` when the job carries none (matching
`extractRequestId`'s own documented contract, and relying on `jobId` alone
for job-level correlation), or, if a non-null value is wanted for log
readability, bind it under a distinct field name (e.g.
`correlationId: requestId ?? job.id`) rather than overloading
`requestId` itself.

## Info

### IN-01: `webhook-lag-watchdog`'s platform-wide signal can mask one tenant's dead webhook behind another's healthy one

**File:** `apps/api/src/modules/ops/webhook-lag-watchdog.ts:104-122`, `:182-198`
**Issue:** `readNewestWebhookEventAt` computes `MAX(last_event_at)` across
*every* workspace's `workspace_webhook_endpoints` row. If tenant A's webhook
is genuinely dead but tenant B (any other tenant) received a webhook batch
within `WEBHOOK_LAG_ALERT_MINUTES` (60m), the evaluation reports healthy for
the whole platform, and tenant A's dead webhook can go unnoticed
indefinitely by this alert. The alert's own action text
(`renderWebhookLagAlertText`) says "check whether the affected tenant(s)'
SendGrid Event Webhook is still provisioned" — but the signal this file
computes has no way to name which tenant(s) are affected; a healthy `MAX`
across all tenants gives the operator nothing to act on for a single dead
one. This appears to be an accepted, deliberate scope choice (the file's own
header discusses the alternatives rejected and why a platform-wide signal
was chosen, migration 0065's column-level-grant design), so this is
informational rather than a defect — flagged so the action-text/scope
mismatch is visible to whoever writes the runbook this alert requires.
**Fix (optional):** Either narrow the action text to "check whether *any*
tenant's" rather than implying per-tenant attribution, or note in the
runbook that this alert cannot identify which tenant is affected and a
secondary per-tenant check is needed once triggered.

### IN-02: `migration-tiers.ts` header comment is stale relative to the file it documents

**File:** `packages/db/src/migration-tiers.ts:63-64`
**Issue:** The module header states "Classified by reading every migration
in `packages/db/migrations/*.sql` (63 files, tags 0000-0062 at this
commit)". This phase's own migration (0064) and the follow-up grant-only
migration (0065) are both present and correctly classified in the
`MIGRATION_TIERS` map below that comment (as `auto-reversible` and
`forward-only` respectively), so the functional behavior is correct — only
the descriptive count/range in the comment is out of date. Purely cosmetic;
no behavior depends on this string.
**Fix:** Update the parenthetical to reflect the current file count/range
(or drop the specific numbers and just say "every migration... as of this
file's own last edit").

### IN-03: `TemplateSenderPickers.tsx` can render its fetch-error state twice at once

**File:** `apps/web/src/features/campaigns/TemplateSenderPickers.tsx:67-114`, `:180-226`
**Issue:** Both `TemplatePicker` and `SenderPicker` render a
`QueryErrorState` inside the popover's `CommandEmpty` (visible only while
the popover is open and the filtered list is empty) *and*, independently,
directly below the popover trigger whenever
`!isLoading && items.length === 0` (visible regardless of whether the
popover is open). When `isFullyErrored` is true and the popover happens to
be open, the same "Не удалось загрузить шаблоны/отправителей" card renders
twice on screen at once (once inside the popover content, once below the
trigger button). Purely a duplicated-UI cosmetic issue, not a functional or
data-correctness defect — flagged as a minor quality item.
**Fix:** Render the below-trigger error/empty block only while the popover
is closed (`!open && ...`), or drop one of the two render sites.

---

_Reviewed: 2026-08-16_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
