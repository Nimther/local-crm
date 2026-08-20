# Phase 16: Live SendGrid Verification - Pattern Map

**Mapped:** 2026-08-17
**Files analyzed:** 7 (3 modified production files, 2 new test/fixture files, 1 new script, 1 new evidence doc)
**Analogs found:** 7 / 7 (all analogs are files this phase itself modifies or their direct siblings — this is a verification phase over existing code, not new-system construction)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/delivery-core/src/send-mail.ts` (modify: env-var seam) | service (delivery) | request-response (outbound HTTP to SendGrid) | itself — existing `SENDGRID_TIMEOUT_MS` versioned-constant convention in the same file | exact (in-place edit, not a new file) |
| `apps/worker/src/server.ts` (modify: boot log) | config/bootstrap | event-driven (process boot) | itself — existing fail-fast env-var checks (`REDIS_URL`, `SCAN_DATABASE_URL`, `UNSUBSCRIBE_TOKEN_SECRET`, `PUBLIC_APP_URL`) at lines 163-199 | exact |
| `apps/api/src/modules/webhooks/webhooks.routes.ts` (modify: raw-capture) | route/controller | request-response (public webhook ingress) | itself — the file's own post-verification, pre-`JSON.parse` insertion point | exact |
| `apps/api/src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts` (NEW) | test | request-response (HTTP-stack integration test) | `apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts` | exact — same route, same `app.inject`-driven pattern, only the fixture source and replay/negative-signature assertions are new |
| `apps/api/src/modules/webhooks/__tests__/fixtures/uat-signed-payload.json` (NEW) | fixture/config | file-I/O (test fixture) | inline `PUBLIC_KEY`/`SIGNATURE`/`TIMESTAMP`/`PAYLOAD` constants in `webhooks-signature.test.ts` (currently inlined, not a separate file) | role-match — same content shape (raw body + sig headers + public key), different storage form (external JSON vs inline constants) |
| `scripts/uat-fault-proxy.mjs` (NEW) | utility/script | streaming/pass-through (HTTP proxy) | no close analog exists in the codebase (no prior proxy script); closest structural precedent is the content-type-parser buffer capture in `webhooks.routes.ts` (raw-body handling) and `docs/failure-injection-scenarios.md`'s fault vocabulary | no analog — build from RESEARCH.md's sketch (Architecture Pattern 2) |
| `.planning/phases/16-live-sendgrid-verification/16-UAT-REPORT.md` (NEW) | doc/evidence | batch (manual evidence compilation) | `.planning/phases/14-deployment-database-durability/` and `15-*` UAT/checkpoint SUMMARY docs (Phase 14/15 checkpoint pattern) | role-match |

## Pattern Assignments

### `packages/delivery-core/src/send-mail.ts` (service, request-response)

**Analog:** itself (in-place edit) — follow the file's own `SENDGRID_TIMEOUT_MS` versioned-constant convention (lines 94-117) and single-try/catch discipline (lines 148-166).

**Current call site to change** (line 153):
```typescript
const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(SENDGRID_TIMEOUT_MS),
});
```

**Target shape (D-06/D-07):**
```typescript
// Module-level, alongside SENDGRID_TIMEOUT_MS -- a versioned constant per
// this file's own Phase 9 D-12 convention: a change must be visible in a
// diff, never silently absorbed into a library default.
const SENDGRID_MAIL_SEND_URL =
  process.env.SENDGRID_BASE_URL ?? "https://api.sendgrid.com/v3/mail/send";

export async function sendTenantMailV3(
  apiKey: string,
  payload: SendGridMailSendRequest
): Promise<SendTenantMailResult> {
  try {
    const res = await fetch(SENDGRID_MAIL_SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SENDGRID_TIMEOUT_MS),
    });
    return { status: res.status, headers: res.headers, messageId: res.headers.get("x-message-id") };
  } catch (err) {
    throw redactApiKey(err, apiKey);
  }
}
```

**Do NOT touch:** the single `try`/`catch` block, `redactApiKey`, or the `@sendgrid/mail` avoidance rationale in the doc comment above `sendTenantMailV3` (lines 133-147) — this is a URL-string-only change per RESEARCH.md's explicit constraint.

**Structurally separate call sites that must NOT read this var** (confirm untouched): `apps/api/src/modules/tenancy/sendgrid-client.ts` (tenant key-check/webhook-provision) and the platform system-mail sender (`@sendgrid/mail`-based) — neither should gain a `SENDGRID_BASE_URL` read.

---

### `apps/worker/src/server.ts` (config/bootstrap, event-driven)

**Analog:** the file's own existing fail-fast env-var check block (lines 163-199).

**Pattern to copy — throw-on-missing-required-var style, adapted to warn-on-present-optional-var:**
```typescript
// Existing precedent (lines 174-179), same file:
const scanDatabaseUrl = process.env.SCAN_DATABASE_URL;
if (!scanDatabaseUrl) {
  throw new Error(
    "SCAN_DATABASE_URL is required for apps/worker to start -- cross-workspace scans connect as the dedicated least-privilege mega_crm_scan role"
  );
}
```

**New addition (D-07 loud boot log — inverse polarity: warn when SET, not when absent):**
```typescript
// apps/worker/src/server.ts -- import { logger } from "./logger.js" already
// exists in this codebase's convention (see apps/worker/src/sentry.ts,
// apps/worker/src/processor-wrapper.ts for the same import).
if (process.env.SENDGRID_BASE_URL) {
  logger.warn(
    { sendgridBaseUrl: process.env.SENDGRID_BASE_URL },
    "SENDGRID_BASE_URL override active -- tenant mail is NOT going to real SendGrid. " +
      "This must never be set outside a UAT fault-injection session."
  );
}
```

**Import needed:** `import { logger } from "./logger.js";` — confirm not already imported in `server.ts` before adding (grep first; `logger.ts` exports a Pino instance built the same way as `apps/api/src/logger.ts`).

**Error-handling pattern:** N/A for this addition (a log line, not a fail-fast check) — do not throw; the whole point is the override remains an opt-in, non-fatal seam per D-07's "no NODE_ENV production-guard" decision.

---

### `apps/api/src/modules/webhooks/webhooks.routes.ts` (route/controller, request-response)

**Analog:** itself — the file's own verified-batch, pre-`JSON.parse` insertion point (lines 123-142).

**Imports pattern** (lines 1-7, unchanged — reuse as-is):
```typescript
import type { FastifyInstance } from "fastify";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { writeIngressJournal } from "@mega-crm/db/src/webhooks/ingress-journal.js";
import { findWebhookEndpointByToken } from "./webhook-endpoint.repository.js";
import { verifyWebhookSignature, isWebhookTimestampFresh } from "./signature-verify.js";
import { enqueueWebhookBatch } from "./enqueue.js";
import { env } from "../../env.js";
```

**Auth/verification pattern already in place** (lines 123-130) — insertion point is immediately AFTER this block, BEFORE the `JSON.parse` at line 134:
```typescript
const isValid = verifyWebhookSignature(endpoint.publicKey, rawBody, signature, timestamp);
const isFresh = isWebhookTimestampFresh(timestamp, env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS);
if (!isValid || !isFresh) {
  return reply.code(400).send();
}

// >>> D-09 raw-capture insertion point goes HERE <<<
// (isValid && isFresh both true; rawBody/signature/timestamp already in scope)

let events: unknown[];
try {
  const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
  ...
```

**New addition (D-09), gated by a new env var `WEBHOOK_RAW_CAPTURE_WORKSPACE_ID`:**
```typescript
if (endpoint.workspaceId === process.env.WEBHOOK_RAW_CAPTURE_WORKSPACE_ID) {
  // logger not currently imported in this file -- check apps/api's
  // equivalent to apps/worker/src/logger.ts (likely apps/api/src/logger.ts)
  // and import it, matching the project's existing Pino-everywhere
  // convention rather than console.log.
  logger.info(
    { rawBodyBase64: rawBody.toString("base64"), signature, timestamp },
    "UAT raw webhook capture (WEBHOOK_RAW_CAPTURE_WORKSPACE_ID set)"
  );
}
```

**Fail-closed pattern to preserve (do not weaken):** the 404-before-signature (line 108-113) and 400-fail-closed-indistinguishable (line 125-130) branches are untouched by this addition — the capture sits strictly after both gates pass, matching CLAUDE.md's "never parse before signature verification" rule exactly (capture is a `logger.info` of already-verified bytes, not a parse).

---

### `apps/api/src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts` (test, request-response)

**Analog:** `apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts` (full file read — 288 lines, exact same route, same `app.inject`-driven HTTP-stack pattern).

**Imports pattern** (lines 1-7, copy verbatim, adjust only the queue/repo lookups actually needed):
```typescript
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { webhookEventsQueue } from "../enqueue.js";
import { findWebhookEndpointByToken } from "../webhook-endpoint.repository.js";
```

**Core pattern — real signed fixture through `app.inject`, freezing `Date` to the fixture's own timestamp (lines 128-158):**
```typescript
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(Number(TIMESTAMP) * 1000);
let res;
try {
  res = await app.inject({
    method: "POST",
    url: `/webhooks/sendgrid/${pathToken}`,
    headers: {
      "content-type": "application/json",
      "x-twilio-email-event-webhook-signature": SIGNATURE,
      "x-twilio-email-event-webhook-timestamp": TIMESTAMP,
    },
    payload: PAYLOAD,
  });
} finally {
  vi.useRealTimers();
}
```
**IMPORTANT deviation from the analog (Pitfall 1 in RESEARCH.md):** the analog fakes `Date` to the fixture's OWN captured timestamp so it stays "fresh" forever without touching signed bytes — reuse this exact mechanism for the D-10 fixture (do NOT rely on real wall-clock `now()` or an inflated `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` env override in this test file).

**Helper functions to copy verbatim:** `signUp`, `createWorkspace`, `provisionEndpoint`, `freshWorkspace` (lines 83-126 of the analog) — identical setup needed for a fresh workspace + provisioned endpoint with the UAT-captured `publicKey`.

**New assertions this file adds beyond the analog (D-11/D-12):**
- Negative signature check: flip one byte of the captured body, re-POST, expect 400 and `enqueueWebhookBatch`/queue count unchanged — mirrors the analog's "tampered signature -> 400" test (lines 176-201) but using the D-10 fixture's bytes instead of the SendGrid-published fixture.
- Dedup: two identical byte-exact POSTs of the captured payload, verify `send_events` count = 1 for the dedup key while `ingress_journal`/queue-enqueue count = 2 (Pitfall 4 — do not assert journal count unchanged).

**Fixture loading pattern (NEW, no direct analog):**
```typescript
import fixture from "./fixtures/uat-signed-payload.json" with { type: "json" };
// fixture: { rawBodyBase64: string, signature: string, timestamp: string, publicKey: string }
const PAYLOAD = Buffer.from(fixture.rawBodyBase64, "base64").toString("utf8");
```

---

### `apps/api/src/modules/webhooks/__tests__/fixtures/uat-signed-payload.json` (fixture, file-I/O)

**Analog:** the inline `PUBLIC_KEY`/`SIGNATURE`/`TIMESTAMP`/`PAYLOAD` constants in `webhooks-signature.test.ts` (lines 33-53) — same four fields, externalized to JSON per D-10's "committed fixture" decision.

**Shape to produce:**
```json
{
  "rawBodyBase64": "<base64 of the exact raw bytes captured from webhooks.routes.ts, INCLUDING any trailing bytes SendGrid sent>",
  "signature": "<x-twilio-email-event-webhook-signature header value, verbatim>",
  "timestamp": "<x-twilio-email-event-webhook-timestamp header value, verbatim>",
  "publicKey": "<the capturing workspace's workspace_webhook_endpoints.public_key>"
}
```
**PII note (D-10):** confirm the UAT workspace's captured payload contains only UAT-workspace test-contact data before committing — do not commit a fixture containing the operator's real personal email in `dynamic_template_data`/recipient fields.

---

### `scripts/uat-fault-proxy.mjs` (utility, streaming/pass-through)

**Analog:** none in the codebase — no prior proxy script exists. Build directly from RESEARCH.md's Architecture Pattern 2 sketch (already vetted against the exact `send-dispatch.ts` branch logic).

**Core pattern (verbatim sketch from RESEARCH.md, dependency-free `node:http` + `fetch`):**
```javascript
import { createServer } from "node:http";

let mode = "passthrough"; // "passthrough" | "429-once" | "timeout-once"

const server = createServer(async (req, res) => {
  if (req.url === "/__control" && req.method === "POST") {
    mode = await readModeFromBody(req);
    res.writeHead(200).end();
    return;
  }

  if (mode === "429-once") {
    mode = "passthrough";
    res.writeHead(429, { "retry-after": "1" }).end();
    return; // NEVER forwards -- a forwarded request here would double-send
  }

  const body = await readRawBody(req);
  const upstream = fetch("https://api.sendgrid.com/v3/mail/send", {
    method: req.method,
    headers: req.headers,
    body,
  });

  if (mode === "timeout-once") {
    mode = "passthrough";
    await upstream; // let SendGrid actually process the send
    await sleep(SENDGRID_TIMEOUT_MS_PLUS_MARGIN); // delay the RESPONSE only
  }

  const upstreamRes = await upstream;
  res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers));
  res.end(await upstreamRes.text());
});
```

**Critical non-negotiable (RESEARCH.md Pattern 2 / Pitfall 2):** 429 mode must NEVER forward upstream (produces a real duplicate send); timeout mode MUST forward upstream and only delay the response (dropping the connection produces genuinely lost mail stuck in `reconciling` forever). Do not swap these.

**Security constraint (RESEARCH.md Security Domain, V13):** never add a `ports:` mapping for this proxy in `docker-compose.prod.yml` — reachable only from inside the compose network, mirroring the existing "no service besides `web` publishes ports" invariant enforced by `scripts/validate-prod-compose.mjs` (grep that script to confirm the exact check name before writing the compose snippet).

**No analog for `SENDGRID_TIMEOUT_MS_PLUS_MARGIN`** — import the real constant from `packages/delivery-core/src/send-mail.ts`'s exported `SENDGRID_TIMEOUT_MS` (20_000) and add a margin (e.g., +2000ms) rather than hardcoding a duplicate number.

---

### `.planning/phases/16-live-sendgrid-verification/16-UAT-REPORT.md` (doc/evidence, batch)

**Analog:** Phase 14/15 checkpoint SUMMARY docs and `.planning/phases/14-deployment-database-durability/14-09-PLAN.md`'s `checkpoint:human-verify` task-type pattern (cited directly in RESEARCH.md Sources).

**Structure to follow:** one row per UAT-01..05 mapping to: timestamp, `sg_message_id` (for send-based tests), the exact verification-query text run, its output, and the checkpoint approval note — per D-14's "one place an auditor reads" requirement. Do not read the Phase 14 file's exact contents (not required for this pattern map — the planner/executor should read `14-09-PLAN.md` directly per the canonical_refs list already in CONTEXT.md).

## Shared Patterns

### Env-var seam: default-real-value + loud/optional log (D-06/D-07/D-09)
**Source:** `apps/worker/src/server.ts` lines 163-199 (fail-fast style) adapted to warn-only style for optional overrides.
**Apply to:** `send-mail.ts` (`SENDGRID_BASE_URL`), `webhooks.routes.ts` (`WEBHOOK_RAW_CAPTURE_WORKSPACE_ID`).
```typescript
const VALUE = process.env.SOME_VAR ?? "<safe-default>";
if (process.env.SOME_VAR) {
  logger.warn({ someVar: process.env.SOME_VAR }, "<loud, specific message>");
}
```

### Fail-closed webhook verification (unchanged, do not weaken)
**Source:** `apps/api/src/modules/webhooks/webhooks.routes.ts` lines 104-142.
**Apply to:** any new logic inserted into this route (D-09's capture) — must sit strictly after `isValid && isFresh`, never before, and must never introduce a new response code that distinguishes capture-active from capture-inactive workspaces to an external caller.

### Real-signed-fixture HTTP-stack test via `app.inject` + frozen `Date`
**Source:** `apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts` (full file, 288 lines).
**Apply to:** `webhooks-signature-replay.test.ts` — reuse `signUp`/`createWorkspace`/`provisionEndpoint`/`freshWorkspace` helpers verbatim; reuse the `vi.useFakeTimers({ toFake: ["Date"] })` + `vi.setSystemTime` pattern to keep a frozen fixture perpetually "fresh" without touching signed bytes.

### Versioned, comment-documented constants (project-wide convention)
**Source:** `packages/delivery-core/src/send-mail.ts` lines 94-117 (`SENDGRID_TIMEOUT_MS`).
**Apply to:** `SENDGRID_MAIL_SEND_URL` in the same file, and any timeout-margin constant the fault proxy needs — a bare number without a doc comment explaining WHY is against this codebase's established style.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `scripts/uat-fault-proxy.mjs` | utility | streaming/pass-through | No proxy script exists anywhere in the codebase; built from RESEARCH.md's Architecture Pattern 2 sketch instead (already traced against real `send-dispatch.ts` branch logic — treat that sketch as the source of truth, not a generic proxy-library example) |

## Metadata

**Analog search scope:** `packages/delivery-core/src`, `apps/worker/src` (server.ts, logger.ts), `apps/api/src/modules/webhooks` (routes + `__tests__`), `docs/failure-injection-scenarios.md`, `.planning/phases/14-*`/`15-*` checkpoint docs (referenced, not deep-read — out of this map's read budget since RESEARCH.md already cites them by path).
**Files read directly (full or targeted):** `packages/delivery-core/src/send-mail.ts` (full, 167 lines), `apps/api/src/modules/webhooks/webhooks.routes.ts` (full, 166 lines), `apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts` (full, 288 lines), `apps/worker/src/server.ts` (targeted, lines 155-199), `apps/worker/src/logger.ts`/`sentry.ts`/`processor-wrapper.ts` (grep-confirmed import convention only).
**Pattern extraction date:** 2026-08-17
