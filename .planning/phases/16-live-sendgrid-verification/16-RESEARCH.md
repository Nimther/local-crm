# Phase 16: Live SendGrid Verification - Research

**Researched:** 2026-08-17
**Domain:** Live-provider verification (SendGrid mail/send, Event Webhook, ECDSA signature verification), fault injection against a production fetch path, dedup/replay proof
**Confidence:** MEDIUM-HIGH (the phase is almost entirely a verification exercise over code that already exists and was read directly; the residual LOW-confidence items are narrow: the exact bounce-triggering address and off-the-shelf SendGrid documentation gaps, both flagged below)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Tenant BYO key = a second API key from the one real SendGrid account (the platform account with the Phase 14 verified sender), entered as the UAT workspace's BYO key through the normal key-entry flow. No second SendGrid account.
- **D-02:** Receiving inboxes = operator's own real mailboxes (1–2 addresses the operator controls). The operator opens the mail and clicks the link by hand.
- **D-03:** Environment = production VPS, dedicated UAT workspace created for this phase. No staging deploy.
- **D-04:** Dynamic Template = create a minimal purpose-built UAT template in the SendGrid account: a couple of handlebars variables plus a visible clickable link. Used by both the UAT campaign and the UAT flow.
- **D-05:** Bounce (UAT-02) = send to a nonexistent mailbox at a real domain that rejects unknown recipients — a genuine 550 hard bounce. Researcher picks the most predictable rejecting domain. One bounce has negligible reputation impact.
- **D-06:** 429/transient (UAT-05) = land the Phase-8-deferred `SENDGRID_BASE_URL` seam + a pass-through fault proxy on the VPS. The env var (read in `packages/delivery-core/src/send-mail.ts`, hardcoding `https://api.sendgrid.com/v3/mail/send`) points the deployed worker at a tiny proxy that forwards to real SendGrid but injects one 429 (and one network timeout) on command. Genuinely exceeding the real rate ceiling rejected. Reversibility: reversible — the seam defaults to the real URL; the proxy is a UAT-session artifact.
- **D-07:** Seam guardrails: env var with real-URL default + loud boot log. Absent env var → behavior byte-identical to today. When the override IS set, the worker logs it prominently at boot. A NODE_ENV production-guard rejected. Phase 8's failure-injection tests MAY adopt the seam — planner discretion.
- **D-08:** UAT-05 live scope = single tenant: defer + retry + exactly-once arrival. The "other tenants unaffected" half rests on Phase 12's CI two-tenant fairness evidence — no second live workspace.
- **D-09:** Redelivery = byte-exact re-POST of a captured genuinely-signed batch through the public Caddy URL via curl. Capture the raw signed body + signature headers from a real event delivery (researcher confirms whether signature headers are journaled or need capture at delivery time — **RESOLVED by this research: they are NOT journaled; capture must happen at delivery time**, see Architecture Pattern 3). Forcing SendGrid's own 5xx-retry rejected as the dedup vehicle.
- **D-10:** The captured payload becomes a committed CI fixture + integration test, closing the flag carried since Phase 5. Fixture = raw body + signature headers + the verification public key; the test replays it through the full HTTP stack in CI. Payload contains only UAT-workspace data, so committing it is PII-safe.
- **D-11:** Negative signature check included: flip one byte in the captured body, re-POST — must be rejected by signature verification with nothing ingested.
- **D-12:** "Counted exactly once" is proven at both layers: exactly one `send_events` row for the dedup key `(workspace_id, send_id, event_type, occurred_at)` AND daily rollup / campaign counters unchanged by the second delivery.
- **D-13:** Execution = blocking real-host checkpoints per UAT test + scripted asserts (the proven Phase 14 pattern). The executor stages everything; the operator performs the live actions and approves the checkpoint on evidence. Verification queries are scripted so "passed" means a query returned the expected rows, not an eyeball.
- **D-14:** Evidence artifact = one committed `16-UAT-REPORT.md` mapping each of UAT-01..05 to its evidence, plus per-plan SUMMARYs as usual.
- **D-15:** UAT workspace is kept as a standing canary after the phase. Not erased, not deleted; fenced by tenant isolation.
- **D-16:** Failure protocol = gap-closure plans in-phase: a live failure is recorded in the UAT report, a gap-closure plan lands the fix, it deploys via `deploy.sh <sha>`, and the failed UAT test reruns from scratch (the G-15-4 pattern). Phase 16 completes only at 5/5 live passes.

### Claude's Discretion

- Fault-proxy implementation shape (tiny Node script vs off-the-shelf; where it runs in the compose topology; how injection is toggled).
- Exact bounce-target domain and address (D-05).
- Capture mechanics for the signed payload (ingress_journal vs delivery-time tee) and fixture file layout.
- UAT flow definition (what event triggers it) and campaign/segment shape in the UAT workspace — minimal versions that exercise the attribution paths.
- Plan breakdown (one plan per UAT test vs grouped), checkpoint wording, verification-query design.
- Whether Phase 8's failure-injection scenarios adopt the SENDGRID_BASE_URL seam in this phase or that's noted as a follow-up.
- SPECIFICATION.md/ARCHITECTURE.md update mechanics (SENDGRID_BASE_URL env var → §3; the seam → §5/§8 as applicable, per the binding CLAUDE.md rule).

### Deferred Ideas (OUT OF SCOPE)

- Adopting the SENDGRID_BASE_URL seam in Phase 8's failure-injection scenarios (killing the literal production entrypoint against a local stub) — planner may fold it in if cheap; otherwise an explicit follow-up.
- Real rate-ceiling burst as bonus UAT-05 evidence — rejected as the gate; could be attempted opportunistically but is not part of this phase's pass criteria.
- Two-live-workspace fairness demonstration — rests on Phase 12 CI evidence; revisit only if a real multi-tenant incident suggests the CI scenario diverges from production behavior.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| UAT-01 | Live-отправка с BYO key через Dynamic Template подтверждена | D-01/D-04 setup path confirmed against existing `sendTenantMailV3`/campaign+flow dispatch code (no code change needed for the send itself); Architecture Pattern 1 seam does not interfere with the normal, non-faulted path |
| UAT-02 | Live-события delivered/opened/clicked/bounced подтверждены | `EVENT_FLAGS` in `sendgrid-webhook-provision.ts` already provisions all four event types; Pitfall 5/Assumption A1 covers the bounce-inducement mechanism; Pitfall 6 covers expected cross-workspace event noise on the shared account |
| UAT-03 | Проверка подписи webhook подтверждена на реальном подписанном payload через полный HTTP-стек | Architecture Pattern 3 (capture mechanism) + Code Examples (signature verification internals, URL-independence of the signature) + Pitfall 1 (timestamp freshness) + D-10's committed fixture/test |
| UAT-04 | Дедупликация повторно доставленных событий подтверждена live | Code Examples (dedup index/ON CONFLICT target) + Pitfall 4 (journal count vs send_events count — do not conflate the two) + D-12's two-layer proof |
| UAT-05 | Поведение при 429 и временных ошибках SendGrid подтверждено live | Architecture Pattern 2 (the two asymmetric injection modes, traced directly from `send-dispatch.ts`) + Pitfall 2 (the consequence of getting them backwards) — this is the highest-risk requirement in the phase and the research resolves its core implementation question explicitly |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

Directives from `.claude/CLAUDE.md` that bind this phase's plans:

- **SPECIFICATION.md same-change rule (binding, project-wide):** "при добавлении любой новой библиотеки или технологии — дописать её в SPECIFICATION.md в соответствующий раздел в том же изменении." Concretely for this phase:
  - `SENDGRID_BASE_URL` (new env var, D-06) → §3 "Секреты" in the SAME commit that adds the env read.
  - `WEBHOOK_RAW_CAPTURE_WORKSPACE_ID` (new env var, this research's Pattern 3 recommendation for D-09) → also §3, same rule — this is a NEW variable this research introduces, not one CONTEXT.md already named, so the planner must not miss it just because it isn't in the Claude's Discretion list verbatim.
  - The webhook-route capture addition and the `SENDGRID_BASE_URL` read both plausibly touch §6 "Публичные точки входа" / §5 "Планировщик и пайплайн отправки" respectively — the planner should confirm which section per the routing table in CLAUDE.md ("новая переменная окружения... → раздел 3", "новый HTTP-роут... → раздел 6").
  - The fault-injection proxy (`scripts/uat-fault-proxy.mjs` or equivalent) is a session-scoped throwaway tool, not a dependency or a permanent architectural component — it does NOT trigger the SPECIFICATION.md package/dependency rule (§2) as long as no new npm package is added (see Package Legitimacy Audit: none is).
  - If any of the above lands with a version/library that diverges from the Technology Stack section of CLAUDE.md, §8 "Расхождения" also needs an entry — not expected here, since no new library is introduced.
- **"Never parse the SendGrid webhook body with a JSON body-parser before signature verification"** (CLAUDE.md What NOT to Use, restated from the codebase's own `webhooks.routes.ts` comments): the D-09 raw-capture insertion point in Architecture Pattern 3 above is placed AFTER `isValid`/`isFresh` both pass and BEFORE `JSON.parse` — this satisfies the directive as written, but the plan-checker should verify the insertion point explicitly rather than re-derive it, since misplacing it even slightly (e.g., capturing before signature verification, to "capture everything just in case") would violate this rule.
- **"Never `@sendgrid/mail`'s module-level `sgMail` singleton for tenant sends... always a per-call `Authorization: Bearer` header"** (CLAUDE.md What NOT to Use + `send-mail.ts`'s own doc comment): the `SENDGRID_BASE_URL` seam edit must change ONLY the URL string passed to `fetch`, not the raw-fetch-per-call architecture itself. Do not refactor `sendTenantMailV3` to use `@sendgrid/mail` while adding this seam.
- **No new npm packages without updating SPECIFICATION.md §2**: moot for this phase per the Package Legitimacy Audit (no new packages recommended), but binds any plan that deviates from this research's dependency-free-proxy recommendation.

## Summary

Phase 16 does not build a new system — it wires four small, reversible seams onto code that Phases 8–15 already built and verified against mocks, then proves each of UAT-01..05 against the real SendGrid account and a real inbox. Three of the four "new" surfaces are single-purpose and temporary: a `SENDGRID_BASE_URL` env read in `sendTenantMailV3` (one line, default-real-URL, D-06/D-07), a raw-webhook-capture mechanism for the UAT workspace only (D-09 — resolved below: `ingress_journal` cannot be the replay source), and a pass-through fault proxy for the 429/timeout session (D-06). The fourth is durable: a committed CI fixture that closes a signature-replay test gap carried since Phase 5 (D-10).

The single most consequential finding from reading the code directly: **`ingress_journal.raw_batch` stores `JSON.stringify`'d, already-`JSON.parse`'d events — not the raw request bytes, not the signature/timestamp headers.** CONTEXT.md's D-09 explicitly asks the researcher to confirm this; the answer is confirmed by reading `writeIngressJournal` and its call site in `webhooks.routes.ts`: journaling happens *after* the raw body has already been parsed into a JS array, and only the array is persisted. Byte-exact replay therefore requires a capture mechanism separate from the journal, added at delivery time.

The second most consequential finding: the fault-proxy's two injection modes (429, timeout) are **not symmetric** and must not share behavior. A 429 must be synthesized by the proxy *without forwarding* (the real send-dispatch code releases the claim and retries on 429 — forwarding a real send AND returning 429 would produce a genuine duplicate). A timeout must *forward the request upstream and delay the response* past `SENDGRID_TIMEOUT_MS` (the code treats a client-side timeout as ambiguous → `reconciling`, with the claim NOT released and no automatic retry — swallowing the request silently loses the mail and fails UAT-05's "no duplicate or lost mail" criterion outright). Get this backwards and either scenario produces a fabricated defect that isn't real.

Third: the webhook timestamp-freshness window (`WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`, default 600s) applies to BOTH the live redelivery (UAT-03/04, which must happen within ~10 minutes of the captured send unless the operator temporarily widens the env var) and the D-10 committed CI fixture (whose timestamp is frozen at capture time and will fail signature-freshness forever unless the CI test path overrides tolerance or injects `now`). This is the top entry in Common Pitfalls below.

**Primary recommendation:** Land the `SENDGRID_BASE_URL` seam and the raw-capture mechanism as the phase's only production-code changes; execute UAT-01..05 as five blocking real-host checkpoints against a dedicated UAT workspace on the same SendGrid account (D-01); commit the captured signed payload as a CI fixture with an explicit timestamp-tolerance override so it never goes stale; verify dedup with `send_events` count = 1 (not `ingress_journal` count, which correctly becomes 2 on replay).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Configurable SendGrid base URL (seam) | API/Backend (`packages/delivery-core`, consumed by `apps/worker`) | — | Single call site (`sendTenantMailV3`); no HTTP-layer or DB-layer involvement |
| Fault-injection proxy (429/timeout) | Infra / deploy substrate (VPS compose, session-scoped) | — | Sits between the worker process and the real SendGrid API; not application code, not committed to the main compose file long-term |
| Raw webhook payload capture (UAT-03/04) | API/Backend (`apps/api` webhook route) | Infra (log shipping / Loki, if that capture path is chosen) | The only place the pre-parse raw bytes + signature headers ever exist is inside `webhooks.routes.ts`, before `JSON.parse` |
| Signature verification + replay | API/Backend | — | `signature-verify.ts` + the route's raw-body content-type override; already built, verification-only in this phase |
| Dedup proof (`send_events` unique index) | Database / Storage | API/Backend (worker ingestion) | `send_events_dedup_v2_idx` (migration 0057) is the actual enforcement mechanism; the worker's `ON CONFLICT` target is the only write path |
| Dynamic Template + UAT campaign/flow | External (SendGrid account UI) | API/Backend (campaign/flow config referencing the template id) | Template content lives entirely in SendGrid per the platform's core architecture; the platform only references `template_id` |
| Bounce inducement | External (real mail infrastructure, operator's own domain) | — | Not something the platform's code produces — a real MTA rejection, observed via webhook |
| CI signature-replay fixture | CI / Quality Gates | — | Closes a gap flagged since Phase 5; lives alongside existing `webhooks-signature.test.ts` |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@sendgrid/eventwebhook` | `^8.0.0` (installed, `apps/api/package.json`) [VERIFIED: package.json] | ECDSA signature verification for SendGrid Event Webhook payloads | Already in use via `signature-verify.ts`'s `verifyWebhookSignature` — no new dependency; this phase only exercises the existing wrapper against a genuinely-signed live payload |
| `vitest` | `4.1.9` (installed) [VERIFIED: package.json] | Test runner for the new CI signature-replay fixture test (D-10) | Matches the existing `webhooks-signature.test.ts` suite exactly — no new test infra |
| Node.js built-ins (`node:http`, `fetch`) | Node 22.x LTS runtime (already the project's pinned runtime) [CITED: CLAUDE.md Technology Stack] | Fault-injection proxy implementation | No new npm dependency — a tiny pass-through/inject script is a better fit than an off-the-shelf proxy library for a session-scoped, throwaway tool; see Package Legitimacy Audit |

**No new production npm packages are required for this phase.** The only "new" surfaces are a one-line env read in existing code, a standalone script (proxy), and a committed test fixture.

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `curl` (already a deploy-host dependency, used throughout Phase 14/15 runbooks) | any recent | Byte-exact re-POST of the captured signed payload (D-09) through the public Caddy URL | UAT-03/04's redelivery and negative-signature-check steps |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| A tiny `node:http` pass-through script for the fault proxy | `http-proxy` / `http-proxy-middleware` npm packages | Off-the-shelf proxies solve a much larger problem (routing, load balancing, WebSocket upgrade) than "forward everything, but sometimes return a canned 429 or stall." A ~40-line hand-rolled script is easier to review, audit, and delete after the UAT session, and avoids adding a dependency (even a dev-only one) to the production `packages/delivery-core` surface it's proxying in front of. Only reconsider if the session needs TLS termination the compose network doesn't already provide. |
| A workspace-scoped env-flag raw-body capture in `webhooks.routes.ts` | A separate tee-proxy in front of the webhook route | The env-flag approach reuses the route's own already-verified raw `Buffer` and header reads with a ~5-line addition, gated by a `WEBHOOK_RAW_CAPTURE_WORKSPACE_ID` env var that defaults unset (no capture, no behavior change) — same "loud, reversible seam" shape as D-06/D-07. A tee-proxy is a second network hop with its own TLS/cert concerns on a route SendGrid's infrastructure must reach reliably; not worth it for a single capture. |

**Installation:**
```bash
# No new packages. If the fault-proxy is authored as its own tiny script,
# it needs nothing beyond Node's built-in http/fetch — do not add a package
# dependency for it.
```

**Version verification:** `@sendgrid/eventwebhook` and `vitest` versions above were read directly from `apps/api/package.json` and root `package.json` in this session (not looked up in the registry) — HIGH confidence, since these are the exact versions already running in this codebase, not a recommendation to change them.

## Package Legitimacy Audit

**No new external packages are introduced by this phase.** The fault-injection proxy is recommended as a dependency-free `node:http`/`fetch` script (see Alternatives Considered), and the raw-capture mechanism is an addition inside an existing route file. If the planner's discretion lands on an off-the-shelf proxy library instead, run the Package Legitimacy Gate protocol against that specific package name before it appears in any plan.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| *(none — no new packages)* | — | — | — | — | — | N/A |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
                     Operator's real inbox (D-02)
                             ▲
                             │ (human opens mail, clicks link)
                             │
   ┌─────────────────────────────────────────────────────────┐
   │  Real SendGrid account (single account, D-01)           │
   │                                                           │
   │  Platform key ─────► platform-mail (apps/api)            │
   │                        (system emails — NEVER proxied)   │
   │                                                           │
   │  UAT tenant key ────► sendTenantMailV3 (delivery-core)   │
   │        │                       │                          │
   │        │            SENDGRID_BASE_URL (D-06/D-07)        │
   │        │           default = real SendGrid URL           │
   │        │           override = fault-proxy URL            │
   │        ▼                       ▼                          │
   │  [normal path: UAT-01/02]  [UAT-05 session only]         │
   │                                 │                          │
   │                        ┌────────┴─────────┐                │
   │                        │  fault proxy      │                │
   │                        │  (VPS, session-   │                │
   │                        │   scoped)         │                │
   │                        │                   │                │
   │                        │  429 injection:   │                │
   │                        │  synthesize 429,  │                │
   │                        │  DO NOT forward   │                │
   │                        │                   │                │
   │                        │  timeout inject:  │                │
   │                        │  FORWARD, delay   │                │
   │                        │  response past    │                │
   │                        │  SENDGRID_        │                │
   │                        │  TIMEOUT_MS       │                │
   │                        └────────┬──────────┘                │
   │                                 ▼                          │
   │                    real api.sendgrid.com/v3/mail/send      │
   │                                 │                          │
   │  Event Webhook (per-workspace, all events fan out          │
   │  to every provisioned endpoint on this shared account) ────┼──► apps/api
   │                                                           │      /webhooks/sendgrid/:pathToken
   └─────────────────────────────────────────────────────────┘         │
                                                                        │ verifyWebhookSignature
                                                                        │ isWebhookTimestampFresh
                                                                        ▼
                                                              raw-capture (D-09, NEW):
                                                              base64(rawBody) + sig headers
                                                              logged for UAT workspace only
                                                                        │
                                                                        ▼
                                                              writeIngressJournal
                                                              (parsed events, NOT raw bytes)
                                                                        │
                                                                        ▼
                                                              enqueueWebhookBatch → worker
                                                                        │
                                                                        ▼
                                                              send_events (ON CONFLICT
                                                              send_events_dedup_v2_idx)
                                                                        │
                                                                        ▼
                                                    curl re-POST of captured payload
                                                    (byte-exact, from raw-capture —
                                                     NEVER from ingress_journal)
                                                                        │
                                                    ┌───────────────────┴──────────────────┐
                                                    ▼                                       ▼
                                        2nd ingress_journal row                  0 new send_events rows
                                        (EXPECTED — journal is                   (dedup index worked —
                                         not the dedup layer)                     THIS is UAT-04's proof)
```

### Recommended Project Structure

No new packages/directories. Changes land in existing files:

```
packages/delivery-core/src/send-mail.ts   # SENDGRID_BASE_URL env read (D-06)
apps/worker/src/server.ts                 # loud boot log when override is set (D-07)
apps/api/src/modules/webhooks/webhooks.routes.ts   # raw-capture addition, gated by env flag (D-09)
apps/api/src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts   # NEW — the D-10 fixture test
apps/api/src/modules/webhooks/__tests__/fixtures/uat-signed-payload.json    # NEW — committed fixture (raw body + sig headers + public key)
scripts/uat-fault-proxy.mjs                # NEW — the session-scoped fault proxy (or docker/ subfolder if run as a container)
.planning/phases/16-live-sendgrid-verification/16-UAT-REPORT.md   # NEW — the evidence artifact (D-14)
```

### Pattern 1: Env-var seam with real-default + loud boot log (D-06/D-07)

**What:** An environment variable that changes production behavior ONLY when explicitly set, with the absent-case behavior byte-identical to today, and a prominent boot-time log line when the override IS present.

**When to use:** Any production seam intentionally introduced for a temporary/session-scoped purpose (fault injection, live verification) where a forgotten override lingering in production would be dangerous.

**Example (matches existing code conventions — `packages/delivery-core` has no zod env schema; it reads `process.env` directly, per `unsubscribe-token.ts`'s established precedent):**
```typescript
// packages/delivery-core/src/send-mail.ts
// Source: existing pattern in this file (SENDGRID_TIMEOUT_MS) + unsubscribe-token.ts's process.env.PUBLIC_APP_URL precedent
const SENDGRID_MAIL_SEND_URL =
  process.env.SENDGRID_BASE_URL ?? "https://api.sendgrid.com/v3/mail/send";

export async function sendTenantMailV3(
  apiKey: string,
  payload: SendGridMailSendRequest
): Promise<SendTenantMailResult> {
  try {
    const res = await fetch(SENDGRID_MAIL_SEND_URL, { /* unchanged */ });
    // ...
  } catch (err) {
    throw redactApiKey(err, apiKey);
  }
}
```

```typescript
// apps/worker/src/server.ts — the loud boot log (delivery-core has no
// logger of its own; the worker DOES, and it already boots-logs
// OPERATOR_ALERT_EMAIL-equivalent config in this style elsewhere)
if (process.env.SENDGRID_BASE_URL) {
  logger.warn(
    { sendgridBaseUrl: process.env.SENDGRID_BASE_URL },
    "SENDGRID_BASE_URL override active -- tenant mail is NOT going to real SendGrid. " +
      "This must never be set outside a UAT fault-injection session."
  );
}
```

Note: `apps/api`'s `sendgrid-client.ts` (tenant-facing key-check/webhook-provision calls) and `apps/api`'s `platform-mail/client.ts` (system emails via `@sendgrid/mail`) are **structurally separate call sites** that never read `SENDGRID_BASE_URL` — only `sendTenantMailV3` in `delivery-core` does. The proxy therefore affects tenant `mail/send` calls only, never platform system mail, never key-check/webhook-provisioning calls.

### Pattern 2: Fault proxy with asymmetric injection modes (D-06)

**What:** A pass-through HTTP proxy that forwards to real SendGrid by default, but on command injects one of two *behaviorally distinct* fault modes.

**When to use:** UAT-05's live 429/transient-error session only. Never left running against live traffic.

**Critical distinction (derived from tracing `apps/worker/src/queues/send-dispatch.ts`'s actual branches, not assumed):**

| Injected fault | Correct proxy behavior | Why | Code path exercised |
|---|---|---|---|
| 429 rate limit | Synthesize the 429 response directly; **do not forward the request upstream** | `processSendJob` treats any 429/5xx response as `{ outcome: "rate_limited", cause: "provider_backoff" }` and **releases the already-committed dispatch claim** before a bounded retry. If the request were also forwarded, SendGrid would actually accept and send the mail — then the retry re-claims and sends a **second, genuinely duplicate** email. The 429 case must be a response the real SendGrid API never actually received a matching send for. | `send-dispatch.ts` lines ~538-543 (campaign), ~820-823 (flow) |
| Timeout / transient network error | **Forward the request upstream to real SendGrid, then delay the HTTP response** past `SENDGRID_TIMEOUT_MS` (20 000ms) so the worker's own `AbortSignal.timeout` fires first | A rejected `sendMail` call is classified `ambiguous` by `classifyTransportError` and resolves to `{ outcome: "reconciling" }` — the claim is **NOT released**, and there is **no automatic retry** for this outcome. If the proxy merely dropped/refused the connection (never reaching SendGrid), the send genuinely never happened — the row would hang in `reconciling` forever with no webhook evidence to resolve it, which is a real "lost mail" failure of UAT-05's own success criterion. By forwarding and only delaying the *response*, SendGrid actually accepts and sends the mail; the `processed`/`delivered` webhook events later let the reconciler (`send-reconciler.worker.ts`) resolve the row from `reconciling` to `sent` — proving the exact mechanism UAT-05 exists to verify, and incidentally live-exercising the reconciler itself (the strongest evidence achievable for this criterion). | `handleAmbiguousSendMailError` in `send-dispatch.ts`; `resolveOneSend` in `send-reconciler.worker.ts` |

**Implementation sketch (no new package — `node:http` + `fetch`):**
```javascript
// scripts/uat-fault-proxy.mjs (sketch; not a copy-paste-ready file)
import { createServer } from "node:http";

let mode = "passthrough"; // "passthrough" | "429-once" | "timeout-once"

const server = createServer(async (req, res) => {
  if (req.url === "/__control" && req.method === "POST") {
    // toggled by the operator's staged curl command during the checkpoint
    mode = await readModeFromBody(req);
    res.writeHead(200).end();
    return;
  }

  if (mode === "429-once") {
    mode = "passthrough"; // one-shot, then back to normal
    res.writeHead(429, { "retry-after": "1" }).end();
    return; // NEVER forwards -- see Pattern 2 table above
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

### Pattern 3: Raw webhook payload capture at delivery time (D-09 — resolved)

**What:** A workspace-scoped, default-off capture of the raw request body + signature headers, added directly to `webhooks.routes.ts`, gated by an env flag naming the UAT workspace.

**Why this is necessary (not optional):** `ingress_journal.raw_batch` is populated from the *already-`JSON.parse`'d* `events` array (`writeIngressJournal(client, endpoint.workspaceId, events)` — see `webhooks.routes.ts` line ~153, called with the parsed array, not the raw `Buffer`). `JSON.stringify`ing a re-parsed object is **not** byte-identical to the original wire bytes SendGrid's ECDSA signature was computed over — whitespace, key order, and numeric formatting are not guaranteed to round-trip. A byte-exact replay (UAT-03's own success criterion: "genuinely signed... through the full HTTP stack") is therefore **not achievable** from `ingress_journal` at all. Capture must happen before the `JSON.parse` call, at delivery time.

**Example:**
```typescript
// apps/api/src/modules/webhooks/webhooks.routes.ts, inserted after
// isValid/isFresh both pass, BEFORE JSON.parse -- gated by an env var
// naming the workspace id, default unset (no capture, zero behavior change)
if (endpoint.workspaceId === process.env.WEBHOOK_RAW_CAPTURE_WORKSPACE_ID) {
  logger.info(
    {
      rawBodyBase64: rawBody.toString("base64"),
      signature,
      timestamp,
    },
    "UAT raw webhook capture (WEBHOOK_RAW_CAPTURE_WORKSPACE_ID set)"
  );
}
```
Retrievable via the existing Grafana Cloud Loki pipeline (Phase 15, `alloy` sidecar) — no new log-shipping infrastructure needed. Same "loud, reversible seam" shape as D-06/D-07: absent env var, zero behavior change; present env var, an explicit, greppable log line marks that a capture session is active.

### Anti-Patterns to Avoid

- **Replaying from `ingress_journal`:** Confirmed unusable for byte-exact replay (see Pattern 3 above) — do not let a plan assume the journal is the capture source just because CONTEXT.md's D-09 phrased it as an open question.
- **Fault proxy forwarding on 429 injection:** Produces a real duplicate send (see Pattern 2 table). This is the single most consequential implementation mistake possible in this phase.
- **Fault proxy dropping the connection on timeout injection:** Produces genuinely lost mail and a permanently stuck `reconciling` row — the opposite of what UAT-05 is supposed to prove.
- **Committing the CI fixture with the route's default 600s tolerance unadjusted:** The fixture's timestamp is frozen at capture time; the test will pass today and fail on every subsequent day once wall-clock time exceeds the tolerance window. See Common Pitfalls #1.
- **Treating platform system mail as passing through the proxy:** It does not — `apps/api`'s `@sendgrid/mail`-based platform sender (`platform-mail/client.ts`) and the tenant key-check/webhook-provisioning calls (`sendgrid-client.ts`) are separate call sites that never read `SENDGRID_BASE_URL`. Only `sendTenantMailV3` does.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ECDSA signature verification | A custom ASN.1/DER parser or crypto-module wrapper for SendGrid's public key format | `@sendgrid/eventwebhook`'s `EventWebhook.convertPublicKeyToECDSA` + `verifySignature` (already wrapped in `signature-verify.ts`) | Already correctly implemented and tested (Phase 10/13); this phase verifies it against a real signed payload, it does not need reimplementation |
| Dedup enforcement | An application-level "have I seen this event" check before insert | The existing `send_events_dedup_v2_idx` unique index + `ON CONFLICT` in the worker's insert (migration 0057) | Already the enforced mechanism; UAT-04 proves it under real conditions, it does not need a parallel check |
| Rate-limit/backoff logic | A bespoke retry loop for the UAT-05 proxy scenario | The existing `rate-limiter-flexible` tenant bucket + BullMQ backoff already exercised by `processSendJob`'s `rate_limited` branch | The proxy's job is ONLY to produce a genuine HTTP 429/timeout through the real fetch path — all retry/backoff/deferral logic already exists and is what's being verified, not replaced |

**Key insight:** Every mechanism UAT-01..05 verifies already exists and was built/tested in Phases 8–15. This phase's only genuinely new code is the seam (one line + one log line), the capture addition (one conditional log block), and the proxy (a throwaway script). Resist any temptation to "improve" the mechanisms being verified as part of this phase — a live UAT failure should produce a gap-closure plan against the ALREADY-BUILT mechanism (D-16), not a redesign.

## Common Pitfalls

### Pitfall 1: Webhook timestamp freshness (600s) breaks both the live redelivery AND the committed CI fixture, on a delay

**What goes wrong:** `isWebhookTimestampFresh` rejects a signature header timestamp more than `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` (default 600 seconds) away from wall-clock "now", in either direction. This bounds only the `x-twilio-email-event-webhook-timestamp` header the signature is computed over — a structurally different value from each event's own `timestamp` field inside the batch body (that's CMP-05's territory, untouched here).

**Why it happens:** Two distinct consequences flow from the same 600s window:
1. **Live UAT-03/04:** the byte-exact re-POST (D-09) must happen within ~10 minutes of the ORIGINAL webhook delivery's own timestamp, or the redelivery itself gets rejected as stale — which would look like a signature failure but is actually a freshness failure, an easy false-negative to misdiagnose mid-checkpoint.
2. **D-10's committed CI fixture:** the fixture's timestamp header is frozen forever at capture time. Every day after the fixture is committed, "now minus captured timestamp" grows past 600 seconds. The test **will pass on the day it's written and fail permanently starting ~10 minutes later** unless something compensates.

**How to avoid:**
- For the live redelivery: script the checkpoint to either (a) capture and redeliver within the same session (well within 10 minutes), or (b) have the operator temporarily raise `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` in the UAT workspace's env before redelivering, then restore it.
- For the CI fixture: the test must NOT rely on the route's default env-driven tolerance evaluated against real `Date.now()`. Either (a) set an enormous `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` specifically in the test's own environment/config (the route reads it via `env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`, sourced from `apps/api/src/env.ts` — verify whether a test-scoped override is already the convention, per existing `webhook-timestamp-window.test.ts`), or (b) construct the fixture with a signature computed fresh at test-run time against a fixed body (loses "genuinely captured from production" but never goes stale) — the planner must pick one explicitly and record which; do not leave it implicit.

**Warning signs:** The D-10 test passes locally today and fails in CI a week later with a 400 that looks identical to "bad signature" — the route's fail-closed design deliberately makes stale-timestamp and bad-signature indistinguishable to the caller (by design, for security), which means the test failure output alone will not tell you which one broke.

### Pitfall 2: Fault-proxy 429/timeout asymmetry (see Pattern 2 above)

Restated here because it is the single highest-consequence implementation mistake in this phase: getting the two injection modes' forwarding behavior backwards fabricates either a real duplicate send or a real lost send — the exact opposite of what UAT-05 is supposed to demonstrate. See Architecture Pattern 2 for the full mechanism trace.

### Pitfall 3: `ingress_journal` is not the replay source (see Pattern 3 above)

Restated because CONTEXT.md's D-09 phrases this as an open research question ("researcher confirms whether signature headers are journaled or need capture at delivery time") — the answer, confirmed by reading the code, is that they are not journaled, and capture must happen at delivery time, in the route, before `JSON.parse`.

### Pitfall 4: Replaying the captured payload correctly increases `ingress_journal` row count — that is not a bug

**What goes wrong:** A byte-exact re-POST of an already-accepted, genuinely-signed batch passes signature verification again (it's the same valid signature) and is journaled again — `writeIngressJournal` runs unconditionally on every verified delivery, with no idea it has seen this exact body before. A naive verification query asserting "ingress_journal count unchanged" will fail even on a fully correct dedup implementation.

**Why it happens:** The journal's job is "record every verified delivery attempt," not "dedup deliveries" — dedup lives one layer downstream, at the `send_events` insert (`ON CONFLICT (workspace_id, send_id, event_type, occurred_at)`, the `send_events_dedup_v2_idx` unique index from migration 0057).

**How to avoid:** D-12's scripted asserts must check `ingress_journal` count = 2 (both the original and the replay were journaled — expected) AND `send_events` count = 1 for the specific `(workspace_id, send_id, event_type, occurred_at)` key (the actual dedup proof) AND daily rollup/campaign counters unchanged by the second delivery. Get this wrong and the verification script reports a false failure on a correctly-working system.

### Pitfall 5: No official SendGrid bounce-testing address exists

**What goes wrong:** Unlike some ESPs (e.g., Postmark's documented "blackhole" bounce domain), SendGrid does not publish an official sandbox address that reliably produces a 550 hard bounce on demand. [ASSUMED — verified by web search in this session, no authoritative SendGrid documentation found describing such an address]

**Why it happens:** SendGrid's bounce classification is driven by the REAL receiving mail server's SMTP response, not by anything SendGrid itself simulates for `mail/send` traffic (SendGrid's own sandbox mode, if used, suppresses delivery entirely rather than producing a realistic bounce — not applicable here since a real inbox delivery is required for UAT-01/02 anyway).

**How to avoid:** Multiple independent sources converge on the same practice: use a domain the operator genuinely controls and receives real mail on (satisfying "predictable" per D-05) with a syntactically-valid but definitely-nonexistent local part (e.g., a random string before `@`). Since the operator's own receiving domain (D-02's mailbox domain) already has live MX records and accepts real mail, sending to a nonexistent address at that SAME domain is the lowest-risk choice — it produces a genuine SMTP 550 from infrastructure the operator already controls, with no third-party reputation risk. **This claim (that the operator's own domain will produce a 550 rather than silently accepting/dropping) is `[ASSUMED]`** — it self-verifies during the UAT checkpoint itself (the webhook event either arrives as `bounce` or it doesn't), so treat it as a live-verified fact once the checkpoint passes, not before.

**Warning signs:** If the target domain has a catch-all mailbox configured, mail to a nonexistent address will NOT bounce — it will be silently accepted. Confirm the domain has no catch-all before selecting the address (ask the operator, or check the domain's own mail provider admin console).

### Pitfall 6: Shared-account cross-workspace event fan-out

**What goes wrong:** D-01's tenant BYO key is a second key on the SAME real SendGrid account as the platform sender. All Event Webhook subscriptions on one account see events for messages sent under any key on that account (SendGrid's Event Webhook is account-scoped for webhook delivery routing purposes, filtered by the platform's own `custom_args`/`workspace_id` at ingestion — not by SendGrid itself). The UAT workspace's webhook endpoint may therefore receive events attributable to platform system mail or sibling workspaces sharing the account.

**Why it happens:** This is not a bug introduced by this phase — it's the exact scenario `WR-01` (carried from Phase 5, referenced in STATE.md) already documented and the worker's existing sibling-drop path (`webhook-events-sibling-drop.test.ts`) already handles.

**How to avoid:** Nothing — the existing sibling-drop logic already discards events that don't attribute to this workspace's own sends. Just don't be surprised if the UAT workspace's `send_events` table shows a `dropped`/discarded count for events that were never meant for it; that is expected behavior being exercised live, not a defect to chase.

## Code Examples

Verified patterns from the actual codebase (not third-party docs — this phase modifies existing, already-reviewed code):

### The exact seam edit target
```typescript
// Source: packages/delivery-core/src/send-mail.ts (read directly in this session)
// CURRENT (line ~153):
const res = await fetch("https://api.sendgrid.com/v3/mail/send", { ... });

// TARGET SHAPE (D-06):
const SENDGRID_MAIL_SEND_URL = process.env.SENDGRID_BASE_URL ?? "https://api.sendgrid.com/v3/mail/send";
// ...
const res = await fetch(SENDGRID_MAIL_SEND_URL, { ... });
```

### The dedup ON CONFLICT target the D-12 verification query must match
```sql
-- Source: packages/db/migrations/0057_send_events_dedup_rebase.sql (read directly)
-- The unique index UAT-04's "counted exactly once" claim rests on:
CREATE UNIQUE INDEX send_events_dedup_v2_idx ON send_events (workspace_id, send_id, event_type, occurred_at);

-- Verification query (D-12):
SELECT count(*) FROM send_events
 WHERE workspace_id = $1 AND send_id = $2 AND event_type = $3 AND occurred_at = $4;
-- Expect exactly 1, even after the byte-exact replay.
```

### Signature verification, unmodified (what UAT-03 exercises, not rebuilds)
```typescript
// Source: apps/api/src/modules/webhooks/signature-verify.ts (read directly)
export function verifyWebhookSignature(
  publicKey: string, rawBody: Buffer, signature: string | undefined, timestamp: string | undefined
): boolean {
  if (!signature || !timestamp) return false;
  try {
    const eventWebhook = new EventWebhook();
    const ecPublicKey = eventWebhook.convertPublicKeyToECDSA(publicKey);
    return eventWebhook.verifySignature(ecPublicKey, rawBody, signature, timestamp);
  } catch { return false; }
}
```
Note: the signature covers the raw body + timestamp header only — **not the URL/pathToken**. This means the D-10 CI fixture test can post the captured payload against ANY provisioned test endpoint, as long as that endpoint's stored `public_key` matches the fixture's capturing workspace's key. The fixture layout should therefore bundle: raw body bytes, both signature headers, AND the public key — not assume a specific pathToken has to exist.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Live SendGrid verification deferred as accepted v1.0 tech debt | A named, tracked release-barrier phase (this phase) | v1.1 roadmap (2026-07-27), per PROJECT.md | The whole reason Phase 16 exists — v1.0's deferral is explicitly not being repeated |
| HTTP-signature-layer replay untested (only worker-layer attribution tested, since Phase 5) | Committed CI fixture + full-HTTP-stack replay test (D-10) | This phase | Closes a flag carried since Phase 5 05-13/05-REVIEW |

**Deprecated/outdated:** None — this phase does not deprecate anything; it verifies and closes gaps in already-current code.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | No official SendGrid bounce-testing address exists; a nonexistent local-part at a domain the operator controls with live, non-catch-all MX will reliably produce a real 550 | Common Pitfalls #5, D-05 | If wrong (domain has a catch-all, or the receiving MTA soft-bounces/queues instead of hard-rejecting), UAT-02's bounce leg fails to produce a bounce event; the checkpoint itself will surface this immediately (no bounce webhook arrives), so the risk is a wasted checkpoint attempt, not a silent gap |
| A2 | The D-09 raw-capture mechanism (env-flag + log line inside `webhooks.routes.ts`) is retrievable via the existing Loki/Alloy pipeline in time to extract before the 600s freshness window matters for the SAME delivery's own redelivery | Architecture Pattern 3 | If the capture isn't retrievable fast enough, the operator may need to widen `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` temporarily instead of relying on a tight capture-to-replay window — noted as the fallback already in Pitfall 1 |
| A3 | A dependency-free `node:http`/`fetch` script is sufficient for the fault proxy's two injection modes, without needing TLS termination of its own (the compose network's existing TLS boundary at Caddy is not in this call path since the worker calls out, not in) | Architecture Pattern 2 | If wrong (e.g., the worker's outbound fetch requires TLS the proxy can't terminate cleanly on the compose network), the fallback is an off-the-shelf proxy library — package legitimacy gate would then need to run against that specific package |

**If this table is empty:** N/A — three assumptions above need confirmation during execution, not before planning; none blocks planning itself.

## Open Questions

1. **Where exactly does the D-09 capture retrieval happen from — Loki query, or a direct docker log grep?**
   - What we know: Phase 15 already ships an `alloy` sidecar shipping structured logs to Grafana Cloud Loki; the capture log line (Pattern 3) would land there like any other worker/API log line.
   - What's unclear: Whether the operator's UAT session should query Loki (requiring the Grafana Cloud UI/API) or `docker compose logs api` directly on the VPS (faster, no external dependency) during the live checkpoint.
   - Recommendation: Default to `docker compose logs api | grep <marker>` on the VPS directly for speed during the live session — it needs no external service round-trip and the operator is already SSH'd into the host per D-13's checkpoint pattern. Note in the plan as the primary path; Loki as a fallback if the log has already rotated past the container's local buffer.

2. **Does `apps/api/src/env.ts`'s `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` schema entry support a large temporary override cleanly, or does raising it require a redeploy?**
   - What we know: The route reads it via `env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`, sourced from the zod-validated `apps/api/src/env.ts` schema, which in turn reads from `MEGA_CRM_ENV_FILE` (outside the repo, per Phase 8 convention).
   - What's unclear: Whether this specific value is read once at process boot (requiring an API container restart to change) or per-request (hot-reloadable). Given the zod schema pattern (`envSchema.parse(process.env)` typically runs once at module load), the likely answer is boot-time-only.
   - Recommendation: Plan for an API container restart (not just an env-file edit) if the operator needs to temporarily widen this tolerance for the redelivery checkpoint — verify at execution time by reading `apps/api/src/env.ts`'s own parse-invocation site.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Deployed production VPS (Phase 14) | All UAT tests — this phase runs against the real deployed env, no staging | ✓ (per STATE.md: Phase 14 deploy/rollback/backups/restore all checkpoint-approved) | — | none — hard prerequisite, already satisfied |
| Real SendGrid account with verified sender | UAT-01/02/03/04/05 | ✓ (per ROADMAP.md/CONTEXT.md: "account and verified sender available — not deferred tech debt") | — | none needed |
| Second SendGrid API key (tenant BYO, D-01) | UAT-01/02 | Operator action required (create in SendGrid UI) — not yet created as of research time | — | none — must be created before execution; trivial UI action |
| Operator's own real inbox(es) (D-02) | UAT-01/02 | Operator-controlled, assumed available | — | none |
| SSH access to the production VPS | All checkpoints (D-13 pattern) | ✓ (used throughout Phase 14/15 checkpoints per STATE.md) | — | none |
| `curl` on the VPS | D-09/D-11 redelivery and negative-signature-check | Assumed present (standard on any Linux VPS, already used by Phase 14/15 runbooks for health probes) | — | install via apt if somehow missing |

**Missing dependencies with no fallback:**
- Second SendGrid API key must be created by the operator before UAT-01 execution — a one-time UI action, not a blocker for planning.

**Missing dependencies with fallback:**
- None identified beyond the above.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.9 [VERIFIED: package.json] |
| Config file | Root + per-workspace `vitest.config.ts` (existing, unchanged by this phase) |
| Quick run command | `vitest run --root apps/api src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts` (new file, D-10) |
| Full suite command | `npm test` (root, existing) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| UAT-01 | Live BYO-key send via Dynamic Template arrives in a real inbox | manual-only (checkpoint:human-verify) — inherently requires a human to open a real mailbox | `checkpoint:human-verify` per D-13 | ❌ N/A — not automatable by design |
| UAT-02 | Real delivered/opened/clicked/bounced land on the correct send/step/campaign | checkpoint + scripted SQL assert | Scripted query against `send_events`/`sends`/campaign counters, human triggers the click/open | ❌ Wave 0 — verification-query script to be written this phase |
| UAT-03 | Genuinely signed payload passes verification through the full HTTP stack | integration (new, committed) + checkpoint for the LIVE leg | `vitest run --root apps/api src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts` (CI) + curl re-POST (live) | ❌ Wave 0 — new fixture + test file |
| UAT-04 | Redelivered duplicate counted exactly once | Same test file as UAT-03 (negative + dedup assertions) + live scripted SQL assert | Same as UAT-03, plus D-12's `send_events` count query | ❌ Wave 0 — same new file |
| UAT-05 | Real 429/transient defers only the affected tenant, resolves without dup/loss | checkpoint:human-verify with scripted pre/post asserts | Scripted `sends`/`send_events` row-count and status queries before/after the proxy session | ❌ Wave 0 — verification-query script + fault-proxy script |

### Sampling Rate
- **Per task commit:** `vitest run --root apps/api src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts` (fast, no live dependency)
- **Per wave merge:** `npm test` (full suite, existing gate)
- **Phase gate:** All 5 UAT checkpoints approved (D-16: 5/5 live passes) before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `apps/api/src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts` — covers UAT-03/UAT-04 (CI portion)
- [ ] `apps/api/src/modules/webhooks/__tests__/fixtures/uat-signed-payload.json` (or similar) — the committed fixture: raw body + both signature headers + public key
- [ ] Verification-query scripts for UAT-02 (send_events attribution), UAT-04 (dedup count), UAT-05 (pre/post row state) — these are the "scripted asserts" D-13 requires so "passed" means a query returned expected rows, not an eyeball
- [ ] `scripts/uat-fault-proxy.mjs` (or equivalent) — no test framework coverage needed (it's a throwaway session tool), but its two injection modes should have a quick manual smoke test before the live checkpoint

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | This phase touches no authentication surface |
| V3 Session Management | no | N/A |
| V4 Access Control | no | The UAT workspace uses the platform's existing tenant-isolation boundary (RLS), unchanged |
| V5 Input Validation | yes (webhook payload) | Existing `verifyWebhookSignature`/`isWebhookTimestampFresh` fail-closed pair — unchanged by this phase, only exercised live |
| V6 Cryptography | yes (ECDSA signature verification) | `@sendgrid/eventwebhook`'s wrapped ECDSA verify — never hand-rolled, unchanged |
| V13 API and Web Service | yes (the new fault-proxy is itself a small HTTP surface) | Session-scoped, VPS-network-internal only (never publicly routable — mirrors the existing "no `ports:` except `web`" invariant `validate-prod-compose.mjs` already enforces); the proxy must never be reachable from outside the compose network |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| `SENDGRID_BASE_URL` override left set in production after the UAT session ends | Tampering / Denial of Service | D-07's loud boot log (a warning on every worker boot while the var is set) is the primary mitigation; the plan should also include an explicit "unset this var" step in the phase's own teardown/close-out, not just rely on the log being noticed |
| Fault-proxy `/__control` endpoint reachable by anyone on the compose network (no auth) | Elevation of Privilege / Tampering | Acceptable ONLY because the proxy is session-scoped, torn down after the phase, and the compose network itself is not internet-reachable (T-14-43's existing invariant — no service besides `web` publishes ports). Do not add a `ports:` mapping for this proxy at all; reach it only from inside the compose network during the session |
| Raw webhook payload capture (D-09) logging PII (recipient email addresses inside the batch) to Loki | Information Disclosure | Mitigated by scope: the UAT workspace's own test/canary sends are the only payloads ever captured (env flag names ONE workspace id), and Phase 15's existing Sentry/log redaction discipline (`scrubbedConsole`, Pino redact options) should be checked against whether it also covers this NEW log call — if the existing redaction rules don't already scrub email-shaped strings from arbitrary log payloads, this specific log line needs its own redaction check before it ships, since it deliberately logs a full raw batch body that Phase 13's PII-redaction work never anticipated a capture-log use case for |
| Committed CI fixture (D-10) containing PII | Information Disclosure | Already addressed by D-10 itself: "Payload contains only UAT-workspace data, so committing it is PII-safe" — confirm the UAT workspace's test contact(s) use non-real, throwaway PII (not the operator's real personal email in the `dynamic_template_data`/recipient fields) before committing the fixture |

## Sources

### Primary (HIGH confidence — read directly from this codebase in this session)
- `packages/delivery-core/src/send-mail.ts` — `sendTenantMailV3`, hardcoded URL, `SENDGRID_TIMEOUT_MS`
- `apps/worker/src/queues/send-dispatch.ts` — 429/timeout/ambiguous branch logic, claim release semantics
- `apps/api/src/modules/webhooks/signature-verify.ts` — `verifyWebhookSignature`, `isWebhookTimestampFresh`
- `apps/api/src/modules/webhooks/webhooks.routes.ts` — raw-body content-type override, journal-before-enqueue ordering
- `packages/db/src/webhooks/ingress-journal.ts` — `writeIngressJournal` signature (confirms parsed-array, not raw-bytes, storage)
- `packages/db/migrations/0057_send_events_dedup_rebase.sql` — the dedup unique index and its rationale
- `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` — `EVENT_FLAGS`, friendly-name scoping
- `docs/runbooks/reprovision-webhook-event-types.md`, `docs/runbooks/production-topology.md` — deployed substrate facts
- `docker/docker-compose.prod.yml`, `scripts/deploy.sh` — topology and deploy mechanism the checkpoint pattern reuses
- `apps/api/package.json`, root `package.json` — installed dependency versions (`@sendgrid/eventwebhook@^8.0.0`, `vitest@4.1.9`)
- `.planning/phases/14-deployment-database-durability/14-09-PLAN.md` — the `checkpoint:human-verify` task-type pattern D-13 reuses
- `.planning/phases/16-live-sendgrid-verification/16-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md` — phase scope and decisions

### Secondary (MEDIUM confidence)
- WebSearch: SendGrid dynamic template creation UI + Handlebars/click-tracking mechanics (general documentation, consistent across multiple sources, not independently re-verified against SendGrid's own docs site in this session — outside the `gsd-tools research-plan` seam)

### Tertiary (LOW confidence — flagged for live self-verification)
- WebSearch: no official SendGrid bounce-testing address found; recommendation to use operator's own controlled domain with a nonexistent local part is industry-common practice per multiple independent sources (Suped, MailSlurp, general deliverability guidance) but not SendGrid-specific documentation — this claim self-verifies the moment the live checkpoint either produces a bounce webhook or doesn't (see Assumptions Log A1)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; existing versions read directly from package.json
- Architecture (seam placement, fault-proxy semantics, capture mechanism): HIGH — derived from direct code tracing of the actual branch logic, not assumed
- Bounce inducement (D-05 exact domain/address): LOW — no authoritative SendGrid documentation exists; treated as an assumption that self-verifies live
- Pitfalls: HIGH — the two most important ones (timestamp freshness, fault-proxy asymmetry) are derived from reading the exact code paths involved, not general knowledge

**Research date:** 2026-08-17
**Valid until:** This phase is a one-time verification exercise expected to complete within days of this research — validity window is not the usual 30-day stable-stack estimate; re-research only if the phase stalls long enough for SendGrid's own API/webhook contract to change (unlikely within weeks) or if Phase 14's deployed environment is re-provisioned before execution.
