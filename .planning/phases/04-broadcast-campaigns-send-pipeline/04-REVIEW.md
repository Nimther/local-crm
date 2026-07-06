---
phase: 04-broadcast-campaigns-send-pipeline
reviewed: 2026-07-06T15:20:00Z
depth: standard
files_reviewed: 2
files_reviewed_list:
  - apps/api/src/modules/delivery/unsubscribe.routes.ts
  - apps/api/src/modules/delivery/__tests__/unsubscribe-content-type.test.ts
findings:
  critical: 0
  warning: 3
  info: 2
  total: 5
status: issues_found
---

# Phase 04: Code Review Report — Post-04-14 Delta Review

**Reviewed:** 2026-07-06T15:20:00Z
**Depth:** standard
**Files Reviewed:** 2
**Status:** issues_found (warnings only — no blockers)

> This is a delta review of the 04-14 gap-closure change only, superseding the
> prior full-phase report (93 files, one blocker CR-01: 415 on urlencoded
> unsubscribe POSTs). The prior report remains in git history. **CR-01 is
> confirmed fixed** — no Critical findings remain. All findings below are
> test-coverage warnings against the new regression suite; the source fix
> itself is correct, correctly scoped, and secure.

## Narrative Findings (AI reviewer)

## Summary

The 04-14 fix registers a scoped `addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "buffer", bodyLimit: 1024 }, ...)` inside `registerUnsubscribeRoutes` that buffers and discards the body (`done(null, undefined)`), since the signed URL-path token is the sole authorization input and the handler never reads `request.body`.

The four security-relevant properties named in the review scope were each verified against Fastify 5.9.0 source (`node_modules/fastify/lib/content-type-parser.js`, `plugin-override.js`) **and** empirically via a runtime probe against a scoped-parser Fastify instance:

1. **Scoping — correct, no leak.** `registerUnsubscribeRoutes` is a plain async function (not `fastify-plugin`-wrapped) mounted via `app.register()` (`apps/api/src/server.ts:82`). Fastify's `override()` builds a fresh `ContentTypeParser` copy for every encapsulated register scope (`plugin-override.js:46`), so the parser applies only to `/unsubscribe/*`. Probe: urlencoded POST to a sibling-scope route → **415**. The comment at `unsubscribe.routes.ts:126-130` is accurate.
2. **bodyLimit — correct.** With `parseAs: "buffer"`, Fastify enforces the parser-level 1024-byte limit both via the `Content-Length` pre-check and via streamed `receivedLength` accounting (chunked-encoding safe), returning **413** `FST_ERR_CTP_BODY_TOO_LARGE` with `connection: close`. Probe: 2KB body → **413**. Route-level `bodyLimit` is unset on both routes, so nothing overrides the 1024 limit. RFC 8058 bodies are ~26 bytes (`List-Unsubscribe=One-Click`); 1024 is a generous, fail-closed ceiling.
3. **Charset-parameterized content types — correctly matched.** Fastify 5.9's `getParser` falls back to a lowercased media-type-essence lookup after the exact-match miss (`content-type-parser.js:150`), so `application/x-www-form-urlencoded; charset=UTF-8` (and case variants) hit the scoped parser. Probe: charset-parameterized and uppercase variants → **200**. However this behavior is not pinned by any test — see WR-02.
4. **Security of discarding the body — sound.** The handler's only input is the HMAC-verified `:token` path param; `request.body` is never read on either route in this scope, so `undefined` body cannot influence any decision. The verify-then-mutate path is unchanged by this delta.

Remaining findings are all gaps in the regression suite: it locks in the two happy-path shapes but does not pin the encapsulation boundary, the charset variant, or the browser-form `Accept: text/html` branch — the exact class of framework-behavior regressions this fix exists to guard against.

## Warnings

### WR-01: Scope-guard test verifies media-type specificity, not encapsulation (T-04-14-02 untested)

**File:** `apps/api/src/modules/delivery/__tests__/unsubscribe-content-type.test.ts:142-150`
**Issue:** The test named "scope guard" POSTs `application/xml` to the **unsubscribe route** and asserts 415. That proves the parser is media-type-specific, but the actual scoping risk documented in the source comment (T-04-14-02: the parser "cannot weaken body parsing for any sibling route — /api/auth/*, campaigns, contacts, segments") is the **opposite direction**: it requires asserting that a **sibling-scope route** still rejects `application/x-www-form-urlencoded` with 415. Today encapsulation holds (verified empirically), but it holds only because `registerUnsubscribeRoutes` is a plain async function mounted via `app.register()`. If a future refactor wraps it in `fastify-plugin` (a routine "fix" when someone wants a decorator to escape the scope) or hoists the `addContentTypeParser` call into `buildServer`, the parser silently becomes app-wide — every authenticated JSON API route would start accepting urlencoded requests with `request.body === undefined` — and no test would fail.
**Fix:** Add one test that POSTs urlencoded to an existing sibling route and asserts 415:

```typescript
it("urlencoded parser does not leak to sibling scopes (T-04-14-02)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "name=x",
  });
  expect(res.statusCode).toBe(415);
});
```

### WR-02: Charset-parameterized content type (`; charset=UTF-8`) works but is unpinned by tests

**File:** `apps/api/src/modules/delivery/__tests__/unsubscribe-content-type.test.ts` (missing case); `apps/api/src/modules/delivery/unsubscribe.routes.ts:131-137`
**Issue:** Real HTTP clients and some mailbox providers send `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`. This currently matches the scoped parser only via Fastify 5.9's media-type-essence fallback (`content-type-parser.js:150` — a lookup the Fastify source itself annotates as reconciling "conflicting desires across our test suite"). CR-01 was precisely a framework content-type-matching behavior nobody had a test for; if a Fastify upgrade tightens string-parser matching to exact-match, charset-bearing one-click POSTs regress to 415 — silently failing unsubscribes, a compliance-relevant failure (RFC 8058 / CAN-SPAM exposure) — and this regression suite, whose sole purpose is content-type parsing, would stay green.
**Fix:** Add a third happy-path test identical to the one-click test but with `"content-type": "application/x-www-form-urlencoded; charset=UTF-8"`, asserting 2xx and `subscriptionStatus === "unsubscribed"`.

### WR-03: The `Accept: text/html` success-page branch has zero test coverage; the "confirm-page form POST" test does not actually simulate a browser form submit

**File:** `apps/api/src/modules/delivery/__tests__/unsubscribe-content-type.test.ts:118-140`; branch at `apps/api/src/modules/delivery/unsubscribe.routes.ts:153,176-179`
**Issue:** A real browser `<form method="POST">` submit sends **both** `Content-Type: application/x-www-form-urlencoded` **and** `Accept: text/html`. The new "confirm-page form POST" test sets only the content-type; `app.inject` sends no `Accept` header, so `acceptsHtml` is false and the test exercises the identical RFC-8058 empty-body branch as the first test. Grepping all three unsubscribe suites (`unsubscribe.test.ts`, `unsubscribe-xss.test.ts`, this file) confirms **no test anywhere sets an Accept header** — `renderSuccessPage()` and the `acceptsHtml` branch (`unsubscribe.routes.ts:176-179`) are entirely uncovered. The mutation still happens before the branch, so a rendering bug wouldn't lose the unsubscribe, but the human confirm-flow's visible outcome (the «Вы отписаны» page) could break — e.g., a serializer/type regression turning it into a 500 after the DB write — with no failing test, and the test's name/comment claim coverage it doesn't provide.
**Fix:** In the confirm-page test, add `accept: "text/html"` to the headers and strengthen assertions:

```typescript
headers: {
  "content-type": "application/x-www-form-urlencoded",
  accept: "text/html",
},
// ...
expect(res.statusCode).toBe(200);
expect(res.headers["content-type"]).toContain("text/html");
expect(res.body).toContain("Вы отписаны");
```

## Info

### IN-01: Oversized-body 413 behavior (bodyLimit: 1024) is untested and undocumented in the suite

**File:** `apps/api/src/modules/delivery/unsubscribe.routes.ts:133`; missing test in `unsubscribe-content-type.test.ts`
**Issue:** A urlencoded body over 1024 bytes gets 413 `FST_ERR_CTP_BODY_TOO_LARGE` (verified empirically). This is the intended fail-closed behavior (T-04-14-01), but no test pins either the limit or its failure mode; a later "helpful" bump or removal of `bodyLimit` would be invisible.
**Fix:** Add a test POSTing a >1024-byte urlencoded payload and asserting `expect(res.statusCode).toBe(413)`.

### IN-02: `toBeLessThan(300)` status assertions also admit 1xx responses

**File:** `apps/api/src/modules/delivery/__tests__/unsubscribe-content-type.test.ts:112,136`
**Issue:** `expect(res.statusCode).toBeLessThan(300)` passes for any 1xx status, not just 2xx. Fastify won't emit 1xx here in practice, but the assertion is looser than the RFC 8058 requirement ("2xx") the test comments cite.
**Fix:** Assert the exact expected code — `expect(res.statusCode).toBe(200)` — or bound both ends (`toBeGreaterThanOrEqual(200)` + `toBeLessThan(300)`).

---

_Reviewed: 2026-07-06T15:20:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
