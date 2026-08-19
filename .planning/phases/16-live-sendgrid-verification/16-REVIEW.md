---
phase: 16-live-sendgrid-verification
reviewed: 2026-08-19T00:00:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - apps/api/src/modules/webhooks/__tests__/fixtures/README.md
  - apps/api/src/modules/webhooks/__tests__/fixtures/uat-signed-payload.json
  - apps/api/src/modules/webhooks/__tests__/webhooks-raw-capture.test.ts
  - apps/api/src/modules/webhooks/__tests__/webhooks-signature-replay.test.ts
  - apps/api/src/modules/webhooks/webhooks.routes.ts
  - apps/worker/src/__tests__/sendgrid-base-url-boot-log.test.ts
  - apps/worker/src/server.ts
  - docker/docker-compose.uat-proxy.yml
  - docker/prod.env.example
  - docs/runbooks/uat-live-sendgrid.md
  - packages/delivery-core/src/__tests__/send-mail.test.ts
  - packages/delivery-core/src/send-mail.ts
  - scripts/__tests__/uat-fault-proxy.test.mjs
  - scripts/__tests__/uat-replay-script.test.mjs
  - scripts/__tests__/uat-verify.test.mjs
  - scripts/uat-fault-proxy.mjs
  - scripts/uat-replay.sh
  - scripts/uat-verify.mjs
findings:
  critical: 1
  warning: 5
  info: 3
  total: 9
status: issues_found
---

# Phase 16: Code Review Report

**Reviewed:** 2026-08-19T00:00:00Z
**Depth:** standard
**Files Reviewed:** 17
**Status:** issues_found

## Summary

Phase 16 builds the live-SendGrid UAT harness: the webhook raw-capture seam,
the `SENDGRID_BASE_URL` override in `send-mail.ts`, the one-shot fault
proxy, and the `uat-verify`/`uat-replay` tooling. The core seams the review
prompt asked to weight most heavily — raw-body signature verification
ordering, the capture toggle's default-off/exact-match gating, and the
override's byte-identical fallback — are implemented correctly and are
well covered by tests (`webhooks-raw-capture.test.ts` in particular is
thorough: unset/other-workspace/empty-string/bad-signature/stale-timestamp/
unknown-token/response-parity are all exercised).

The most significant defect is in the deployment wiring, not the
application code: `docker/docker-compose.uat-proxy.yml` hands the
session-only fault-proxy container the **entire** production secrets file
via `env_file: - path: ${MEGA_CRM_ENV_FILE}`, even though the script it
runs (`scripts/uat-fault-proxy.mjs`) reads only four narrowly-scoped
`UAT_FAULT_PROXY_*` variables and never touches the database, KMS, or any
other credential. Combined with an admittedly unauthenticated `/__control`
endpoint reachable by any container on the same compose network, this is
an unnecessary and avoidable expansion of blast radius for a throwaway
diagnostic tool. Secondary findings include an edge-case bug in
`redactApiKey` (empty-key input mangles any error message), a missing body
size cap on the fault proxy's request reader, and a few lower-severity
observations about the raw-capture seam's lack of a workspace allowlist and
the inherent (documented, and effectively unavoidable) presence of real
operator PII in the byte-exact signed fixture.

## Critical Issues

### CR-01: Fault-proxy container is granted the entire production secrets file for no functional reason

**File:** `docker/docker-compose.uat-proxy.yml:6-9`
**Issue:** The `uat-fault-proxy` service's `command` overrides the worker
image's normal entrypoint to run only `scripts/uat-fault-proxy.mjs`
directly — it never calls `buildWorker()`, never touches Postgres, Redis,
KMS, or any other credential (confirmed by reading `scripts/uat-fault-proxy.mjs`
end to end: its only environment reads are `UAT_FAULT_PROXY_UPSTREAM_URL`,
`UAT_FAULT_PROXY_PORT`, `UAT_FAULT_PROXY_RESPONSE_DELAY_MS`, and
`UAT_FAULT_PROXY_WORKSPACE_ID`). Despite that, the service declares:

```yaml
env_file:
  - path: ${MEGA_CRM_ENV_FILE}
    required: false
```

`MEGA_CRM_ENV_FILE` (per `docker/prod.env.example`) contains every
production secret this platform has: `DATABASE_URL`, `AUTH_DATABASE_URL`,
`SCAN_DATABASE_URL`, `POSTGRES_PASSWORD`, `MEGA_CRM_APP_PASSWORD`,
`MEGA_CRM_SCAN_PASSWORD`, `MEGA_CRM_AUTH_PASSWORD`, `BETTER_AUTH_SECRET`,
`UNSUBSCRIBE_TOKEN_SECRET`, `PLATFORM_SENDGRID_API_KEY`, AWS/KMS
credentials, `PGBACKREST_REPO1_S3_KEY_SECRET`, `PGBACKREST_REPO1_CIPHER_PASS`,
`SENTRY_DSN_API`/`SENTRY_DSN_WORKER`, and `GRAFANA_CLOUD_API_TOKEN`. All of
these land in `process.env` of a container whose entire purpose is to run
a brand-new, admittedly less-hardened piece of code with an unauthenticated
HTTP control endpoint (`/__control`), on the internal docker network,
during a live production session. Unlike every other security-sensitive
decision in this phase (D-06 through D-12), there is no `D-xx` decision
comment anywhere in this file or in `scripts/uat-fault-proxy.mjs`
acknowledging or justifying this secrets exposure — it reads as an
oversight, not an accepted risk. If this proxy is ever compromised (a bug
in its own minimal HTTP-parsing/forwarding logic, or a future edit that
adds a debug/echo endpoint), the blast radius is "every production secret,"
not "nothing, because this service never needed a secret to begin with."
**Fix:** Replace the blanket `env_file` with an explicit `environment:`
allowlist naming only the variables this script actually reads:
```yaml
services:
  uat-fault-proxy:
    image: ${GHCR_IMAGE_BASE}/worker:${IMAGE_TAG}
    restart: "no"
    environment:
      UAT_FAULT_PROXY_UPSTREAM_URL: ${UAT_FAULT_PROXY_UPSTREAM_URL:-}
      UAT_FAULT_PROXY_PORT: ${UAT_FAULT_PROXY_PORT:-4180}
      UAT_FAULT_PROXY_RESPONSE_DELAY_MS: ${UAT_FAULT_PROXY_RESPONSE_DELAY_MS:-}
      UAT_FAULT_PROXY_WORKSPACE_ID: ${UAT_FAULT_PROXY_WORKSPACE_ID:-}
    command: ["node", "scripts/uat-fault-proxy.mjs"]
    ...
```
(the runbook's §14.2 step already sets `UAT_FAULT_PROXY_WORKSPACE_ID` in
`MEGA_CRM_ENV_FILE`; compose-level `${VAR}` interpolation reads from the
invoking shell, so the operator would need to `export` it instead, or this
service should read a small dedicated env file — either is strictly
better than shipping every production secret into a debug proxy that never
uses them).

## Warnings

### WR-01: Fault-proxy `/__control` endpoint has no authentication and is reachable by any container on the compose network

**File:** `scripts/uat-fault-proxy.mjs:115-140`, `docker/docker-compose.uat-proxy.yml:15-17`
**Issue:** The control endpoint that arms `rate-limit-once`/`timeout-once`
checks nothing beyond `request.method === "POST"` and a valid `mode` in the
JSON body — no shared secret, no header check, nothing. The compose file's
comment ("only the worker may route tenant mail through it") describes
intent, not an enforced boundary: omitting `ports:` only blocks
host/external access, not access from any other container joined to the
same compose network (the file's own comment says it "joins the production
project's default internal network"). Any other service on that network —
`web`, `api`, the `alloy` log-shipping sidecar, or a future addition — can
`POST /__control` and arm a fault against the target UAT workspace's real
sends without the worker's involvement, and can do so repeatedly since the
proxy also listens on `0.0.0.0` rather than a loopback-only bind. The
runbook (§14.2 step 5) acknowledges this is "safe only while it remains
internal and session-scoped," which is a process control, not a technical
one, and combined with CR-01 above, a compromised sibling container has
both the credentials and the reachable control surface.
**Fix:** Require a shared-secret header (e.g. a random token minted at
proxy start and required on `/__control`) or bind the control server to a
second, worker-only-reachable network alias rather than sharing the
proxy's own mail-send listener socket/network scope.

### WR-02: `redactApiKey` corrupts the error message/stack when `apiKey` is an empty string

**File:** `packages/delivery-core/src/send-mail.ts:144-151`
**Issue:**
```ts
function redactApiKey(err: unknown, apiKey: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const redacted = new Error(message.split(apiKey).join("[REDACTED]"));
  ...
}
```
`String.prototype.split("")` splits its input into an array of individual
characters. If `sendTenantMailV3` is ever called with `apiKey === ""` (a
plausible failure mode: a corrupted/empty decrypted tenant key from a KMS
or envelope-decryption defect), every thrown/caught error's message and
stack gets `"[REDACTED]"` spliced between literally every character,
turning a diagnosable error (e.g. `ECONNREFUSED`) into an unreadable,
massively inflated string dumped into logs — the opposite of this
function's own purpose (making an error safe and legible to log). None of
the existing tests in `send-mail.test.ts` exercise an empty `apiKey`.
**Fix:** Guard the empty/falsy case explicitly:
```ts
function redactApiKey(err: unknown, apiKey: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const redacted = new Error(
    apiKey.length > 0 ? message.split(apiKey).join("[REDACTED]") : message
  );
  if (err instanceof Error && err.stack) {
    redacted.stack = apiKey.length > 0 ? err.stack.split(apiKey).join("[REDACTED]") : err.stack;
  }
  return redacted;
}
```

### WR-03: Fault proxy's raw-body reader has no size limit

**File:** `scripts/uat-fault-proxy.mjs:38-45`
**Issue:** `readRawBody` accumulates every incoming chunk into an unbounded
`chunks` array with no maximum size check, unlike
`apps/api/src/modules/webhooks/webhooks.routes.ts`'s own content-type
parser, which enforces `bodyLimit: 1_000_000` on the equivalent real
webhook path. A request with an arbitrarily large body (from any reachable
caller, per WR-01) would be buffered entirely in memory before any
processing occurs, bounded in practice only by the container's
`mem_limit: 128m` (i.e. it would OOM-kill the proxy rather than reject the
request cleanly).
**Fix:** Track accumulated length in `readRawBody` and `request.destroy()`
/ reject once a reasonable ceiling (e.g. 1 MB, matching the real webhook
route) is exceeded.

### WR-04: Webhook raw-capture seam has no allowlist restricting which workspace can be targeted

**File:** `apps/api/src/modules/webhooks/webhooks.routes.ts:157-183`
**Issue:** `WEBHOOK_RAW_CAPTURE_WORKSPACE_ID` is compared for exact
equality against whatever workspace id happens to be set — there is no
code-level restriction (e.g. a compiled-in allowlist of the designated
Phase 16 UAT workspace) preventing this variable from being pointed at any
real tenant's workspace id. Once matched, the seam intentionally emits the
full decoded raw webhook body (potentially containing real customer email
addresses, IPs, and click/open telemetry for that tenant) via field names
chosen specifically to bypass Pino's `redact` path-matching. This is a
powerful, standing, generically-reusable "log any tenant's raw payload
around redaction" capability that ships to production permanently (only
removed by operational discipline — §16 of the runbook — not by the code
itself). Given this codebase's own stated compliance posture ("собственный
статус подписки и suppression... обязательная часть email-маркетинга"),
a seam that can defeat structured-log redaction for any tenant by setting
one env var deserves a stronger code-level guard than "matches whatever
string is configured."
**Fix:** At minimum, restrict the comparison to a single hardcoded
constant (the Phase 16 UAT workspace id) rather than an arbitrary
operator-supplied value, or require a second confirmation env var (e.g.
`WEBHOOK_RAW_CAPTURE_SESSION_TOKEN`) that is rotated/expired outside of
`MEGA_CRM_ENV_FILE`'s normal lifecycle.

### WR-05: `nextMode` return value ignores its own input, obscuring the one-shot contract at the call site

**File:** `scripts/uat-fault-proxy.mjs:31-36`
**Issue:**
```js
export function nextMode(current) {
  if (!MODES.has(current)) {
    throw new Error(`Unknown UAT fault-proxy mode: ${current}`);
  }
  return "pass-through";
}
```
The function accepts `current` and is named as if it computes a
transition, but for every valid input it returns the same constant
`"pass-through"` — the parameter exists only to validate membership. This
is easy to misread at the call site (`mode = nextMode(requestMode)`) as
"the next mode depends on the current one," when actually every armed mode
is a strict one-shot reset to pass-through. Not a functional bug (the
tests correctly assert the one-shot behavior), but the naming invites a
future edit to add a real state machine without noticing the function
currently has none.
**Fix:** Rename to something like `consumeOneShotMode(current)` or add a
one-line comment above the function stating explicitly that every mode is
single-shot and this always resets to pass-through.

## Info

### IN-01: `sg-signed-payload.json` fixture necessarily embeds real operator PII (email, IP) that cannot be scrubbed without invalidating the signature

**File:** `apps/api/src/modules/webhooks/__tests__/fixtures/uat-signed-payload.json`
**Issue:** Decoding `rawBodyBase64` reveals a real recipient email address,
a real client IP address, and live `workspace_id`/`campaign_id`/`send_id`
values from the production deployment. This is an unavoidable consequence
of the byte-exact, ECDSA-signed replay design (D-09/D-11/D-12): any
redaction of the payload would change the bytes SendGrid's signature
covers and invalidate the fixture's entire purpose. The accompanying
`README.md` is accurate in that the README text itself records neither the
address nor a credential, and the plan's own decode-and-inspect gate
(documented in the runbook, §13 step 8) confirms the batch contains only
the designated (self-owned) UAT recipient's data. Flagged here only for
visibility: this fixture is now permanently in git history and contains
directly identifying operator data, an inherent and accepted cost of this
otherwise well-reasoned test design, not an unreviewed oversight.

### IN-02: Fault proxy's 502 error path surfaces raw internal error text to any caller

**File:** `scripts/uat-fault-proxy.mjs:173-179`
**Issue:** On any exception during forwarding, the proxy responds
`{ error: "upstream_failure", detail: error.message }` verbatim. Combined
with WR-01 (unauthenticated, network-reachable control/mail-send paths),
this leaks internal error detail (e.g. DNS/connect failures potentially
naming the real upstream host) to any container that can reach the proxy,
not just the worker. Low severity given the proxy is not published to the
host.
**Fix:** Log the detail server-side only; return a generic `502` body to
the caller.

### IN-03: `CONTROL_PATH` comparison ignores query strings, silently falling through to mail-send forwarding

**File:** `scripts/uat-fault-proxy.mjs:117`
**Issue:** `request.url === CONTROL_PATH` is an exact match; a request to
`/__control?x=1` (or with a trailing slash) does not match and instead
falls through to be treated as a mail-send forward attempt, buffering its
body and issuing an upstream `fetch` to the real (or configured) SendGrid
endpoint. This is a minor robustness gap rather than an exploitable issue
in the current deployment (no external caller reaches this path), but a
mistyped control-arm command during a live session would silently forward
an unintended request instead of failing loudly.
**Fix:** Normalize/parse the URL (e.g. `new URL(request.url, "http://x").pathname`)
before comparing to `CONTROL_PATH`.

---

_Reviewed: 2026-08-19T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
