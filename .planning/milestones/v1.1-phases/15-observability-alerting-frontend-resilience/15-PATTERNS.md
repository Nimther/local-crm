# Phase 15: Observability, Alerting & Frontend Resilience - Pattern Map

**Mapped:** 2026-08-14
**Files analyzed:** 24 (new/modified, per RESEARCH.md Recommended Project Structure + CONTEXT.md canonical_refs)
**Analogs found:** 21 / 24

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `apps/worker/src/logger.ts` | utility (logger) | transform | `apps/api/src/logger.ts` | exact |
| `apps/worker/src/sentry.ts` | config/init | event-driven | `packages/redaction/src/sentry-scrub.ts` (new, shared) + Sentry docs pattern | role-match (no existing Sentry init in repo) |
| `apps/api/src/sentry.ts` | config/init | event-driven | same as above | role-match |
| `apps/web/src/lib/sentry.ts` | config/init | event-driven | same as above | role-match |
| `packages/redaction/src/sentry-scrub.ts` | utility (scrub) | transform | `packages/redaction/src/index.ts` / `rules.ts` (exports `scrub`) | exact |
| `packages/redaction/src/pino-redact.ts` (MODIFIED) | utility (redaction config) | transform | itself, current state (deepen wildcard paths) | exact |
| `apps/worker/src/processor-wrapper.ts` | middleware (job wrapper) | event-driven | `apps/worker/src/server.ts`'s `attachSharedListeners` (shared-over-array wrapper precedent) | role-match |
| `apps/worker/src/bull-board.ts` | controller (admin UI mount) | request-response | `apps/worker/src/health-server.ts` (localhost-bound HTTP surface) + `apps/worker/src/queues/queue-registry.ts` (Queue handle registry) | role-match |
| `apps/worker/src/health-server.ts` (MODIFIED — Fastify embed) | controller | request-response | itself, current state (`node:http`-based) | exact (self, being upgraded) |
| `apps/worker/src/queues/*.worker.ts` (MODIFIED — wrap processors) | service (queue processor) | event-driven | `apps/worker/src/queues/send-dispatch.ts` (shared processor invoked by two workers — precedent for a shared processor function) | role-match |
| `apps/worker/src/queues/erasure-scrub.worker.ts` (console.* replacement) | service | event-driven | itself — 3 raw `console.error` call sites at lines 444, 469, 513 | exact (self) |
| `apps/worker/src/queues/partition-maintenance.worker.ts` (console.* replacement) | service | event-driven | itself — comment at line 134 explicitly marks "Pino arrives in Phase 15" | exact (self) |
| `apps/api/src/server.ts` (MODIFIED — onRequest hook, ALS.run) | middleware | request-response | itself, current state; `apps/worker/src/server.ts`'s `main()`/shutdown-hook wiring style for the analogous "wire a cross-cutting concern once at boot" shape | role-match |
| `apps/api/src/logger.ts` (MODIFIED — mixin + deeper redaction) | utility (logger) | transform | itself, current state | exact (self) |
| `apps/api/src/modules/ops/queue-depth-watchdog.ts` | service (watchdog) | batch/pub-sub | `apps/api/src/modules/ops/send-reconciler-watchdog.ts` | exact |
| `apps/api/src/modules/ops/failed-send-share-watchdog.ts` | service (watchdog) | batch/pub-sub | `apps/api/src/modules/ops/send-reconciler-watchdog.ts` | exact |
| `apps/api/src/modules/ops/webhook-lag-watchdog.ts` | service (watchdog) | batch/pub-sub | `apps/api/src/modules/ops/send-reconciler-watchdog.ts` | exact |
| `packages/tenant-context/src/index.ts` (MODIFIED — ALS merge + `application_name`) | utility (ALS/db context) | request-response | itself, current state (`withTenant`/`withTenantTransaction`) | exact (self) |
| `apps/web/src/App.tsx` (MODIFIED — data router + lazy routes) | provider/router config | request-response | itself, current state (`BrowserRouter`/`Routes`) | exact (self) |
| `apps/web/src/components/RouteErrorBoundary.tsx` | component (boundary) | request-response | none in repo (no ErrorBoundary exists yet) — Sentry's own `Sentry.ErrorBoundary` API is the analog | no analog — see below |
| `apps/web/src/components/StaleDataBanner.tsx` | component | request-response | `apps/web/src/features/contacts/ContactsListPage.tsx` (Card/Skeleton compositional style) | partial |
| `apps/web/src/features/flows/useUnsavedChangesGuard.ts` | hook | event-driven | none — first `useBlocker` usage in repo; React Router docs are the source | no analog |
| `apps/web/vite.config.ts` (MODIFIED — `advancedChunks`) | config | build/transform | itself, current state | exact (self) |
| `docker/docker-compose.prod.yml` (MODIFIED — alloy service, logging blocks) | config (infra) | batch | itself, current state (6 existing services, none with a `logging:` block) | exact (self) |
| `docs/runbooks/*.md` (5 new files) | docs | — | Phase 14's existing runbook files under `docs/runbooks/` (not read this session — location confirmed via CONTEXT.md canonical_refs) | role-match |

## Pattern Assignments

### `apps/worker/src/logger.ts` (utility, transform)

**Analog:** `apps/api/src/logger.ts` (read in full, 25 lines)

**Exact current content to mirror verbatim, plus the new `mixin()` this phase adds to BOTH files:**
```typescript
import pino from "pino";
import { PINO_REDACT_OPTIONS } from "@mega-crm/redaction";
import { env } from "./env.js";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : "info",
  redact: PINO_REDACT_OPTIONS,
  mixin() {
    const ctx = getCorrelationContext(); // new @mega-crm/tenant-context export; returns {} outside any ALS scope
    return ctx;
  },
});
```
Note: `apps/api/src/logger.ts` imports `./env.js` for `NODE_ENV` — `apps/worker` has no equivalent `env.ts` today (it reads `process.env.*` directly in `server.ts`, e.g. `process.env.REDIS_URL`). The new worker logger should follow whichever convention `apps/worker` already uses for env access (grep `apps/worker/src/env.ts` before assuming one exists) rather than inventing a new one.

**Doc-comment convention to preserve:** the existing file's header comment explains SEC-13's "redaction rules live in ONE place" decision and the scrub()-for-freeform-payloads caveat — copy this explanatory style, don't just copy code.

---

### `packages/redaction/src/pino-redact.ts` (MODIFIED — deepen wildcard paths)

**Analog:** itself, current state (not shown in full this session, but RESEARCH.md Code Examples section quotes the exact current-vs-target diff, verified against the real file this same research session)

**Current state → target state (from RESEARCH.md, CITED against real file):**
```typescript
export const PINO_REDACT_OPTIONS: { paths: string[]; censor: string } = {
  paths: REDACTION_RULES.keyRules.flatMap((rule) => [
    rule.key,
    `*.${rule.key}`,
    `*.*.${rule.key}`,
    `*.*.*.${rule.key}`,      // NEW — one more level of defense-in-depth
    `*.*.*.*.${rule.key}`,    // NEW
  ]),
  censor: CENSOR,
};
```
Package root re-exports (`packages/redaction/src/index.ts`, read in full): `CENSOR`, `REDACTION_RULES`, `PINO_REDACT_OPTIONS`, `scrub`, `scrubbedConsole` — the new `sentry-scrub.ts` module should add a `sentryBeforeSend` export here too, following this same barrel-export convention.

---

### `packages/redaction/src/sentry-scrub.ts` (NEW)

**Analog:** the package's own `scrub()` (re-exported from `index.ts`, defined in `scrub.ts` — not read directly this session, but its signature and recursive/unbounded-depth behavior is documented in `apps/api/src/logger.ts`'s own header comment: "Freeform payloads... go through `@mega-crm/redaction`'s `scrub()` instead, which has no depth ceiling and also matches by value pattern")

**Pattern to implement (per RESEARCH.md Code Examples, consistent with the package's existing barrel-export shape in `index.ts`):**
```typescript
import type { ErrorEvent, EventHint } from "@sentry/node";
import { scrub } from "./scrub.js";

export function sentryBeforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  return scrub(event) as ErrorEvent;
}
```
Wire into all three `Sentry.init()` calls (`apps/api/src/sentry.ts`, `apps/worker/src/sentry.ts`, `apps/web/src/lib/sentry.ts`) as both `beforeSend` and `beforeSendTransaction`.

---

### `apps/worker/src/processor-wrapper.ts` (NEW — shared BullMQ wrapper)

**Analog:** `apps/worker/src/server.ts`'s `attachSharedListeners` (read in full) — the existing precedent for "one function wraps every worker in the array rather than each factory wiring it individually":
```typescript
// apps/worker/src/server.ts lines 119-130 — the EXISTING shared-wrapper shape
export function attachSharedListeners(workers: Worker[]): void {
  const onTerminalFailure = (job: Job | undefined, err: Error, queueName: string): Promise<void> | undefined => {
    if (!job || !isTerminalJobFailure(job)) {
      return undefined;
    }
    return writeDeadLetterOnTerminalFailure(job, err, queueName);
  };

  for (const worker of workers) {
    attachSharedErrorListeners(worker, worker.name, { onTerminalFailure });
  }
}
```
The new `wrapProcessor()` (RESEARCH.md Pattern 3) is a *per-job-invocation* wrapper (wraps the processor function itself, called inside each `create*Worker` factory), a different shape from `attachSharedListeners` (an *event-listener* attachment over the built array) — but both share the "single shared helper, no per-factory drift" design intent. Concrete target shape (from RESEARCH.md, cross-checked against this repo's real `DelayedError`/`UnrecoverableError` BullMQ usage precedent in `send-dispatch.ts`'s rate-limit-deferral commentary):
```typescript
import { DelayedError, UnrecoverableError } from "bullmq";
import * as Sentry from "@sentry/node";

const CONTROL_FLOW_ERRORS = [DelayedError, UnrecoverableError];

export function wrapProcessor<T>(queueName: string, handler: (job: Job<T>) => Promise<unknown>) {
  return async (job: Job<T>) => {
    const child = logger.child({ queue: queueName, jobId: job.id });
    const start = Date.now();
    try {
      return await withCorrelation({ jobId: job.id, requestId: job.data.requestId }, () => handler(job));
    } catch (err) {
      const isControlFlow = CONTROL_FLOW_ERRORS.some((cls) => err instanceof cls);
      if (!isControlFlow) {
        Sentry.captureException(err, { tags: { queue: queueName, jobId: job.id } });
      }
      child.error({ err, durationMs: Date.now() - start, controlFlow: isControlFlow }, "job failed");
      throw err; // NEVER swallow
    }
  };
}
```
**Critical gotcha (Pitfall re: control-flow allowlist):** `send-dispatch.ts`'s existing rate-limit deferral (`outcome: "rate_limited"`) returns a *result value*, it does not throw `DelayedError` itself — the actual `DelayedError`/`Worker.RateLimitError()` throw happens in the thin per-queue Worker wrapper around `processSendJob`'s return value (per that file's own doc comments), not inside `processSendJob`. Confirm exactly which layer throws `DelayedError` before wiring the allowlist — grep each `create*Worker` factory's own processor callback, not `send-dispatch.ts` itself.

---

### `apps/worker/src/bull-board.ts` (NEW)

**Analog:** `apps/worker/src/queues/queue-registry.ts` (referenced by name in `server.ts` — `closeTrackedQueues`, `registerTrackedQueue` per RESEARCH.md Pitfall 4 — not read directly this session but its shutdown-registry role is confirmed via `server.ts`'s import and the `closeWorkerRuntime` call site) and `apps/worker/src/health-server.ts` (read in full) for the localhost-only-bind convention:
```typescript
// apps/worker/src/health-server.ts lines 50, 291-292 — the loopback-bind precedent to copy
export const WORKER_HEALTH_HOST = "127.0.0.1"; // literal, never "localhost" or "0.0.0.0"
// ...
const port = deps.port ?? Number(process.env.WORKER_HEALTH_PORT ?? WORKER_HEALTH_PORT_DEFAULT);
server.listen(port, WORKER_HEALTH_HOST, () => { ... });
```
**Pitfall 4 (from RESEARCH.md, HIGH confidence — verified against `server.ts`'s real `WorkerRuntime.workers: Worker[]` type):** Bull Board's `BullMQAdapter` needs `Queue` instances, not the `Worker[]` array `server.ts` already builds. Construct one `new Queue(name, { connection })` per queue name (grep every `create*Worker(...)` call site in `server.ts` — 19 factories listed lines 182-265 — for the underlying queue-name constant each one uses), register each through the existing `registerTrackedQueue` shutdown registry (`queue-registry.ts`), pass those into `BullMQAdapter`. This is additive to `server.ts`, not a replacement of `workers`.

---

### `apps/worker/src/health-server.ts` (MODIFIED — Fastify embed for Bull Board)

**Analog:** itself, current state (read in full, 334 lines) — the byte-for-byte contract this modification MUST preserve:
```typescript
// Exact response shape (lines 192-199, 252-280) that docker-compose.prod.yml's
// healthchecks and the deploy script's readiness gate depend on unchanged:
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
// /healthz: always 200, zero I/O. /readyz: 200 iff every check passes, else 503
// naming failing check(s). Both set "Connection: close" (line 235).
```
`fastify` currently sits in `apps/worker/package.json` as a devDependency only (RESEARCH.md Pitfall confirmed against the real file) — moving it to `dependencies` is a `package.json`-only change, but embedding Fastify into (or alongside) this exact listener must not alter the `/healthz`/`/readyz` contract shown above. `WORKER_HEALTH_HOST = "127.0.0.1"` (never `"localhost"`, never `"0.0.0.0"`) is the loopback-bind convention Bull Board's own listener must also follow.

---

### `apps/worker/src/queues/erasure-scrub.worker.ts` / `partition-maintenance.worker.ts` (console.* replacement sites)

**Analog:** themselves — exact call sites found via grep this session:
```
apps/worker/src/queues/erasure-scrub.worker.ts:444:  console.error("erasure-scrub: erasure_records row not found, skipping", { erasureRecordId });
apps/worker/src/queues/erasure-scrub.worker.ts:469:  console.error("erasure-scrub: failed to record scrub failure on the erasure record", markErr);
apps/worker/src/queues/erasure-scrub.worker.ts:513:  console.error("erasure-scrub: deferring job with an unrecognized payload shape", { jobId: job.id });
apps/worker/src/queues/partition-maintenance.worker.ts:134:  // Pino arrives in Phase 15 / OPS-06 -- console.log carries the same
```
Replace each `console.error(msg, data)` with `logger.error({ ...data }, msg)` (Pino's `(mergingObject, msg)` argument order — note this is the REVERSE of `console.error(msg, data)`'s order). `send-dispatch.ts` already imports and uses `scrubbedConsole` (not raw `console`) for its own error/warn logging (lines 124, 645) — decide per CONTEXT.md's own open discretion point ("whether `scrubbedConsole` survives as a fallback") whether these two files' sites go straight to the new `logger` or via `scrubbedConsole` first.

---

### `apps/api/src/modules/ops/{queue-depth,failed-send-share,webhook-lag}-watchdog.ts` (NEW, all three)

**Analog:** `apps/api/src/modules/ops/send-reconciler-watchdog.ts` (read in full, 295 lines) — the exact shape to replicate three times:

**Imports/constants pattern (lines 25-64):**
```typescript
import type { ReconcilerRunClient, ReconcilerRunRow } from "@mega-crm/db/src/reconciler/reconciler-run.js";
import { readLatestReconcilerRun } from "@mega-crm/db/src/reconciler/reconciler-run.js";

export const RECONCILER_WATCHDOG_INTERVAL_MS = 15 * 60_000; // versioned constant, rationale comment
export const RECONCILER_STALE_THRESHOLD_MINUTES = 30;
export const RECONCILING_AGE_ALERT_HOURS = 30;
export const RECONCILER_ALERT_DEDUP_HOURS = 6;
```

**Pure health-evaluation function (lines 92-118) — no I/O, testable in isolation:**
```typescript
export function evaluateReconcilerHealth(
  row: ReconcilerRunRow | null,
  now: Date,
  thresholds: ReconcilerHealthThresholds,
): ReconcilerHealthResult {
  if (!row) {
    return { healthy: false, reasons: ["missing_health_row"] }; // missing data = UNHEALTHY, never healthy
  }
  const reasons: ReconcilerHealthReason[] = [];
  // ... threshold comparisons, strictly greater-than at the boundary
  return { healthy: reasons.length === 0, reasons };
}
```

**Plain-text alert body renderer (lines 132-178):** no PII, no workspace/contact/send id, only counters/timestamps/reason names, ends with an "ACTION REQUIRED" line.

**Atomic per-row claim (lines 206-220) — the exact multi-replica-safe SQL shape to reuse:**
```typescript
export async function claimReconcilerAlertSlot(
  client: ReconcilerRunClient,
  now: Date,
  dedupHours: number,
): Promise<boolean> {
  const { rows } = await client.query(
    `UPDATE send_reconciler_runs
        SET last_alert_sent_at = $1::timestamptz
      WHERE id = 1
        AND (last_alert_sent_at IS NULL OR last_alert_sent_at < $1::timestamptz - make_interval(hours => $2))
      RETURNING last_alert_sent_at`,
    [now, dedupHours],
  );
  return rows.length > 0;
}
```

**Full check-and-alert orchestration with claim-release-on-send-failure (lines 245-272):**
```typescript
export async function checkReconcilerHealthAndAlert(deps: ReconcilerWatchdogDeps): Promise<void> {
  const row = await readLatestReconcilerRun(deps.client);
  const result = evaluateReconcilerHealth(row, deps.now, { /* thresholds */ });
  if (result.healthy) return;
  const claimed = await claimReconcilerAlertSlot(deps.client, deps.now, RECONCILER_ALERT_DEDUP_HOURS);
  if (!claimed) return;
  const text = renderReconcilerAlertText(row, result.reasons, deps.now);
  try {
    await deps.sendMail({ to: deps.operatorEmail, text });
  } catch (err) {
    await deps.client.query(
      `UPDATE send_reconciler_runs SET last_alert_sent_at = NULL WHERE id = 1 AND last_alert_sent_at = $1::timestamptz`,
      [deps.now],
    ).catch(() => undefined);
    throw err; // never swallowed
  }
}
```

**Interval registration (lines 288-294):**
```typescript
export function startSendReconcilerWatchdog(deps: StartSendReconcilerWatchdogDeps): NodeJS.Timeout {
  return setInterval(() => {
    void checkReconcilerHealthAndAlert({ ...deps, now: new Date() }).catch((err: unknown) => {
      console.error("send-reconciler-watchdog: health check failed", err);
    });
  }, RECONCILER_WATCHDOG_INTERVAL_MS);
}
```

**Design decision baked into every field of this analog, to replicate exactly:** module imports NO tenancy/KMS/env module — every dependency is injected via the `deps` parameter object, and boot-time wiring happens in `apps/api/src/server.ts` (task 3 elsewhere), never inside the watchdog module itself. The three new watchdogs (queue depth reads Redis/BullMQ directly, failed-send-share and webhook-lag query `reconciling_since`/Postgres) will each need their own health-row storage per RESEARCH.md Open Question 2 (recommends one shared `ops_alert_state(alert_name, last_alert_sent_at)` table over four dedicated tables) — this changes the `UPDATE ... WHERE id = 1` shape above to `UPDATE ... WHERE alert_name = $1`.

---

### `packages/tenant-context/src/index.ts` (MODIFIED — ALS merge fix + `application_name`)

**Analog:** itself, current state (read in full, 182 lines)

**Current `withTenant` (lines 53-56) — THE BUG this phase must fix (Pitfall 7, highest-severity finding in RESEARCH.md):**
```typescript
const tenantContext = new AsyncLocalStorage<{ workspaceId: string }>();

export function withTenant<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ workspaceId }, fn); // REPLACES the store, does not merge
}
```
**Required fix (per RESEARCH.md Pitfall 7):** `tenantContext.run({ ...tenantContext.getStore(), workspaceId }, fn)` — spread the current store forward so an outer `requestId`/`jobId` binding survives a nested `withTenant` call. Apply the identical merge discipline to whatever new `withCorrelation({ requestId, jobId })` helper is added alongside `withTenant`.

**`withTenantTransaction`'s existing `SET LOCAL` (lines 79-112, specifically line 91-93) — the one-line extension point for `application_name` (Pattern 4):**
```typescript
// CURRENT:
await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [ctx.workspaceId]);
// TARGET (folds application_name into the SAME statement, no new round trip):
await client.query(
  "SELECT set_config('app.current_workspace_id', $1, true), set_config('application_name', $2, true)",
  [ctx.workspaceId, `req=${ctx.requestId ?? "-"} job=${ctx.jobId ?? "-"}`],
);
```
Note the file's own BEGIN/ROLLBACK/`client.release(releaseWithError)` discipline (lines 87-112) must be preserved exactly — this is the same transaction wrapper `withPreTenantLookup` (lines 158-181) already mirrors, so a third near-identical copy of that try/catch/finally shape is the established convention here, not an anti-pattern to consolidate away in this phase.

---

### `apps/web/src/App.tsx` (MODIFIED — data router + lazy routes)

**Analog:** itself, current state (read in full, 107 lines) — current `<BrowserRouter><Routes>` tree (lines 70-102) must migrate to `createRoutesFromElements`/`createBrowserRouter`/`RouterProvider` (RESEARCH.md Pattern 2, Pitfall 1) with the exact same `<Route>` JSX preserved:
```typescript
// CURRENT shape (lines 67-106) to migrate, route list unchanged:
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          {/* ...18 more <Route> elements, including nested /w/:slug parent */}
        </Routes>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  );
}
// TARGET shape:
const router = createBrowserRouter(
  createRoutesFromElements(
    <>
      <Route path="/" element={<RootRedirect />} />
      {/* same 18 routes, unchanged */}
    </>
  )
);
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  );
}
```
Every feature-page import currently at lines 9-34 (18 imports: `RegisterPage`, `WorkspaceDashboard`, `ContactsListPage`, `FlowDetailPage`, etc.) is a `React.lazy()` conversion candidate per D-14 — wrap each behind `Suspense` with a route-level skeleton, and apply Vite `manualChunks`/`advancedChunks` (see `vite.config.ts` below) to pin `@xyflow/react` (used by `FlowDetailPage`) and `recharts`/dashboard chunks (`WorkspaceDashboard`) separately.

---

### `apps/web/vite.config.ts` (MODIFIED — chunk boundaries)

**Analog:** itself, current state (read in full, 24 lines) — no `build.rollupOptions` block exists today:
```typescript
// CURRENT (full file):
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: { port: 5173, proxy: { "/api": { target: "http://localhost:4000", changeOrigin: true } } },
});
// TARGET — add (Pitfall 2: object-form manualChunks unsupported under Vite 8's Rolldown default):
build: {
  rollupOptions: {
    output: {
      advancedChunks: {
        groups: [
          { name: "canvas-vendor", test: /node_modules\/@xyflow\/react/ },
          { name: "charts-vendor", test: /node_modules\/recharts/ },
        ],
      },
    },
  },
},
```

---

### `apps/web/src/components/RouteErrorBoundary.tsx` (NEW — no analog)

No existing ErrorBoundary in `apps/web` (confirmed: `App.tsx` has none, RESEARCH.md's own read of the codebase confirms this). Use `Sentry.ErrorBoundary` (from `@sentry/react`) directly rather than hand-rolling — Don't-Hand-Roll table entry in RESEARCH.md. Wrap each route-level element (or the `<Route path="/w/:slug" element={<AppShell />}>` parent) with this component so a render error in one feature page shows a contained fallback panel while `AppShell`'s nav/shell survives (D-11).

---

### `apps/web/src/features/contacts/ContactsListPage.tsx` (representative existing list page — pattern source for D-11/D-17)

**Read (lines 1-90 + grep for isError/isLoading):** confirms this repo's TanStack Query convention today has **no `isError` handling at all** — only `isLoading`/`isFetching` distinctions (line 186: `const isInitialLoad = contactsQuery.isLoading;`). This is the gap D-11 fills: every list/detail/chart region across `apps/web/src/features/*` needs an `isError` branch added following this same query-object-destructuring style, with a Retry button calling `refetch()`. `ContactsListPage.tsx`'s existing `useDebouncedValue` local hook (lines 42-49) and Card/Skeleton composition (imports lines 15-28) are the established idiom for how a new inline-error state component should be composed into these pages — no new state-management library, just an added conditional branch.

---

## Shared Patterns

### Redaction (SEC-13, extended this phase)
**Source:** `packages/redaction/src/index.ts` (barrel), `pino-redact.ts` (deepened wildcard paths), new `sentry-scrub.ts`
**Apply to:** `apps/worker/src/logger.ts` (new), `apps/api/src/logger.ts` (modified), all three `Sentry.init()` call sites
```typescript
export const PINO_REDACT_OPTIONS: { paths: string[]; censor: string } = {
  paths: REDACTION_RULES.keyRules.flatMap((rule) => [rule.key, `*.${rule.key}`, `*.*.${rule.key}`, `*.*.*.${rule.key}`, `*.*.*.*.${rule.key}`]),
  censor: CENSOR,
};
```

### ALS correlation context (extends Phase 1's `withTenant`)
**Source:** `packages/tenant-context/src/index.ts`
**Apply to:** every request-path and job-path file that logs or opens a `withTenantTransaction` — the merge-not-replace fix (Pitfall 7) is the single most load-bearing shared change in this phase.

### Watchdog + `claimAlertSlot` pattern (Phases 9-13, extended by OPS-13)
**Source:** `apps/api/src/modules/ops/send-reconciler-watchdog.ts` (and its siblings `partition-watchdog.ts`, `dead-letter-watchdog.ts`, `reputation-watchdog.ts`, `ingestion-health-watchdog.ts` — not read this session but confirmed present via `ls`)
**Apply to:** `queue-depth-watchdog.ts`, `failed-send-share-watchdog.ts`, `webhook-lag-watchdog.ts` (all three new files)

### Shared BullMQ processor wrapper (new this phase, but modeled on `attachSharedListeners`'s "wrap the whole array once" discipline)
**Source:** `apps/worker/src/server.ts` lines 119-130 (existing precedent) + RESEARCH.md Pattern 3 (target shape)
**Apply to:** every `create*Worker` factory under `apps/worker/src/queues/**` (~20 sites)

### TanStack Query inline error + Retry (new convention this phase — no existing analog with `isError`)
**Source:** `apps/web/src/features/contacts/ContactsListPage.tsx`'s existing query-destructuring/Card/Skeleton idiom, extended with an `isError` branch
**Apply to:** every list/chart/detail-panel component across `apps/web/src/features/*` (D-11)

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `apps/web/src/components/RouteErrorBoundary.tsx` | component | request-response | No ErrorBoundary exists anywhere in `apps/web` today; use `Sentry.ErrorBoundary` from `@sentry/react` directly per Don't-Hand-Roll guidance rather than a hand-rolled `componentDidCatch` |
| `apps/web/src/features/flows/useUnsavedChangesGuard.ts` | hook | event-driven | First `useBlocker` usage in the repo — React Router's own docs/decision doc are the source, not an existing codebase pattern; requires the `App.tsx` data-router migration to land first (Pitfall 1) |
| `apps/{api,worker}/src/sentry.ts`, `apps/web/src/lib/sentry.ts` | config/init | event-driven | No Sentry SDK is initialized anywhere in this codebase yet — all three inits are genuinely new, following Sentry's own official `Sentry.init({...})` signature (cited in RESEARCH.md), not a repo precedent |
| `docker/alloy/config.alloy` | config (infra) | batch | No log-shipping agent config exists in the repo today — Grafana's own `discovery.docker`/`loki.source.docker`/`loki.write` component docs are the source |

## Metadata

**Analog search scope:** `apps/api/src/{logger.ts,server.ts,modules/ops/*}`, `apps/worker/src/{server.ts,health-server.ts,queues/*}`, `packages/{tenant-context,redaction}/src/*`, `apps/web/src/{App.tsx,features/contacts/*,vite.config.ts}`
**Files scanned (Read/Grep):** 9 fully read (`apps/api/src/logger.ts`, `packages/tenant-context/src/index.ts`, `packages/redaction/src/index.ts`, `apps/worker/src/server.ts`, `apps/worker/src/health-server.ts`, `apps/api/src/modules/ops/send-reconciler-watchdog.ts`, `apps/worker/src/queues/send-dispatch.ts`, `apps/web/src/App.tsx`, `apps/web/src/features/contacts/ContactsListPage.tsx` partial), plus `apps/web/vite.config.ts` and 2 grep sweeps (console.* sites, isError/isLoading usage)
**Pattern extraction date:** 2026-08-14
