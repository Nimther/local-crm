---
status: diagnosed
trigger: "UAT Phase 21 Test 2: Clicking 'Удалить контакт' sends DELETE with Content-Type: application/json but no body, so Fastify returns 400 FST_ERR_CTP_EMPTY_JSON_BODY and shows the generic error. Root cause per user: apiFetch always sets Content-Type: application/json, including bodyless apiDelete calls."
created: 2026-08-23T00:00:00Z
updated: 2026-08-23T00:40:00Z
mode: find_root_cause_only, symptoms_prefilled
---

## Current Focus

hypothesis: CONFIRMED — "apiFetch (apps/web/src/lib/api.ts:33-36) unconditionally sets Content-Type: application/json on every request; apiDelete without data (lines 70-75) therefore sends a bodyless DELETE with that header; Fastify 5.9.0 runs the JSON content-type parser whenever the header is present (regardless of content-length) and the default JSON parser rejects an empty payload with 400 FST_ERR_CTP_EMPTY_JSON_BODY"
test: "Static read of api.ts + Fastify 5.9.0 source (handle-request.js, fastify.js, content-type-parser.js) + standalone empirical repro against the installed fastify 5.9.0"
expecting: "—"
next_action: "Diagnosis complete — return ROOT CAUSE FOUND to orchestrator; fix to be planned by plan-phase --gaps"
bug_class: Bohrbug (deterministic — every bodyless apiDelete against this server fails identically)
known_pattern_candidate: none (knowledge-base.md has no FST_ERR_CTP_EMPTY_JSON_BODY / apiFetch / Content-Type entries)

reasoning_checkpoint:
  hypothesis: "Bodyless apiDelete requests carry Content-Type: application/json (set unconditionally by apiFetch); Fastify 5.9.0 classifies DELETE as a body-with method and, when a content-type header is present, always runs the content-type parser; the default JSON parser throws FST_ERR_CTP_EMPTY_JSON_BODY on an empty payload → 400 before the route handler ever runs."
  confirming_evidence:
    - "apps/web/src/lib/api.ts:33-36 sets the header on every request; :70-75 omits body when data is undefined"
    - "fastify@5.9.0 fastify.js:139-146 puts DELETE in bodywith; handle-request.js:55-66 runs the parser whenever ctHeader is defined (no content-length gate); content-type-parser.js:325 throws FST_ERR_CTP_EMPTY_JSON_BODY on empty body"
    - "Standalone repro against installed fastify 5.9.0: DELETE+CT+no-body → 400 FST_ERR_CTP_EMPTY_JSON_BODY; DELETE without CT → 200; DELETE+CT+body '{}' → 200"
    - "Live UAT observation (user, real browser): exactly this 400 on 'Удалить контакт'"
  falsification_test: "If a bodyless DELETE with Content-Type: application/json returned 200 against fastify 5.9.0, or if the wire request lacked the header, the hypothesis would be false — repro showed 400 and the header is explicitly set by apiFetch"
  fix_rationale: "Fix belongs in the client helper: only attach Content-Type: application/json when a body is actually sent (or attach it in the body-carrying wrappers instead of apiFetch). Server-side empty-JSON tolerance was considered and rejected (see Resolution tradeoff)."
  blind_spots: "Could not run the app or the e2e suite (worktree has no node_modules; constraints forbid it). segments.spec.ts:73-78 exercises this exact broken path and asserts success — mechanically it cannot pass against this server, and the e2e CI job is deliberately non-blocking (ci.yml:36), so a red run would not have blocked merges; its actual latest CI status was not verified from this session."
  candidate_causes:
    - "code (client): apiFetch unconditionally sets Content-Type — CONFIRMED cause"
    - "code (server): a global content-type parser override tolerating empty JSON might have been expected but absent — checked: only scoped overrides exist (auth /api/auth/* after removeAllContentTypeParsers, unsubscribe, webhooks); none applies to workspace routes, and a '*' parser cannot override the built-in application/json parser anyway (verified in repro)"
    - "environment/config: Fastify version change flipping DELETE parsing behavior — ELIMINATED: lockfile and apps/api/package.json show fastify pinned at 5.9.0 since first introduction (commit 0445177); server behavior has been constant across all phases"
    - "data: n/a — request payload is empty by construction"
  and_gate: "no — a single client-side condition (header without body) is sufficient; the server behaves per Fastify's documented default. The 'server could tolerate empty JSON' framing is a fix-direction tradeoff, not a second contributing cause."

## Symptoms

expected: "Clicking 'Удалить контакт' on the contact card performs the DELETE and the contact is erased/anonymized (enables two-tab erasure race flow in UAT Test 2)"
actual: "DELETE request is sent with Content-Type: application/json and no body; Fastify returns 400 FST_ERR_CTP_EMPTY_JSON_BODY; UI shows the generic error. Performing the same DELETE correctly via the API makes the downstream 410 race handling pass."
errors: "HTTP 400 FST_ERR_CTP_EMPTY_JSON_BODY (Fastify: Body cannot be empty when content-type is set to 'application/json')"
reproduction: "UAT Test 2 in .planning/phases/21-per-contact-dsr-export/21-UAT.md — open a contact card, click 'Удалить контакт'"
started: "Discovered during Phase 21 UAT (per-contact DSR export); latent defect in the shared apiFetch helper since Phase 01-04 (commit ec888af introduced apiDelete already bodyless-conditional with the unconditional header)"

## Eliminated

- hypothesis: "The server once tolerated empty JSON bodies (global content-type parser override) and a recent change removed it"
  evidence: "grep of apps/api/src for addContentTypeParser: only three overrides, all scoped — auth plugin (encapsulated scope serving only /api/auth/*, plugin.ts:27-47), unsubscribe.routes.ts:152, webhooks.routes.ts:76. None covers workspace routes. Additionally the standalone repro proved a '*' catch-all cannot override the built-in application/json parser."
  timestamp: 2026-08-23T00:25:00Z

- hypothesis: "A Fastify version bump (e.g. Phase 18 dependency hygiene) changed DELETE body-parsing behavior, breaking previously-working UI deletes"
  evidence: "git log -p on apps/api/package.json: fastify has been '5.9.0' in every commit that touches it, from introduction (0445177) through Phase 18 (02bf775 shows 5.9.0 → 5.9.0, formatting-only). package-lock.json in this worktree also pins fastify 5.9.0. Server behavior has been constant; the defect was latent client-side from Phase 1."
  timestamp: 2026-08-23T00:30:00Z

## Evidence

- timestamp: 2026-08-23T00:05:00Z
  checked: .planning/debug/knowledge-base.md headers + grep for FST_ERR_CTP_EMPTY_JSON_BODY/Content-Type/apiDelete/apiFetch
  found: No matching prior resolution (3 KB entries, none related)
  implication: Novel bug class for this project; fresh investigation

- timestamp: 2026-08-23T00:10:00Z
  checked: apps/web/src/lib/api.ts (full read)
  found: "apiFetch (line 29) sets headers: { 'Content-Type': 'application/json', ...init?.headers } (lines 33-36) on EVERY request regardless of body. apiDelete (lines 70-75) includes body only when data !== undefined → bodyless calls send DELETE + Content-Type: application/json + no body. apiPost/apiPatch/apiPut always JSON.stringify a required data argument (lines 57-68) — never empty. apiGet is bodyless with the header but GET is a Fastify 'bodyless' method (never parsed) — inert."
  implication: Client-side mechanism confirmed statically — matches user-reported root cause

- timestamp: 2026-08-23T00:15:00Z
  checked: All apiDelete call sites in apps/web/src (grep for 'apiDelete(' AND generic-typed 'apiDelete<')
  found: "Six call sites. BODYLESS (affected): (1) contacts/ContactDetailPage.tsx:134 — contact delete (the reported UAT failure); (2) team/TeamPage.tsx:78 — remove workspace member; (3) segments/api.ts:57 deleteSegment, called from segments/DeleteSegmentDialog.tsx:41; (4) campaigns/api.ts:85 deleteCampaign, called from campaigns/CampaignsListPage.tsx:104; (5) flows/api.ts:160 deleteFlow, called via useDeleteFlow (flows/api.ts:301-309) from flows/list/FlowsListPage.tsx. WITH BODY (unaffected): (6) team/DeleteWorkspaceDialog.tsx:29 — apiDelete(path, { confirmName }) sends a real JSON body → parses fine."
  implication: Every bodyless UI delete in the app is broken the same way; workspace deletion is the only working UI delete because it happens to carry a confirm body

- timestamp: 2026-08-23T00:18:00Z
  checked: Other request paths — all apiPost call sites (30+), direct fetch() calls outside lib/api.ts
  found: "Every apiPost/apiPatch/apiPut call passes a data argument (many pass {} which stringifies to '{}' — a valid non-empty JSON body). Only one direct fetch: contacts/CsvImportWizard.tsx:88 — POST with FormData and no explicit Content-Type (correct for multipart). No other bodyless request with a JSON Content-Type exists."
  implication: Blast radius is exactly the five bodyless apiDelete call sites; no other verbs affected

- timestamp: 2026-08-23T00:22:00Z
  checked: Server side — apps/api/src/modules/contacts/contacts.routes.ts:203-214 (DELETE route), all addContentTypeParser usage, fastify version
  found: "The contacts DELETE route declares no body schema and never reads a body; the 400 fires in Fastify's content-type parsing stage BEFORE the handler runs. No global empty-JSON-tolerant parser exists."
  implication: Nothing route-authors can do per-route (short of parser overrides) prevents this; the request as sent is malformed per Fastify's default contract

- timestamp: 2026-08-23T00:28:00Z
  checked: "Installed fastify 5.9.0 source (main checkout node_modules): lib/handle-request.js:30-67, fastify.js:132-147, lib/content-type-parser.js:325"
  found: "DELETE ∈ bodywith set (with OPTIONS/PATCH/PUT/POST); GET/HEAD/TRACE ∈ bodyless. In handle-request.js, when content-type IS present the parser ALWAYS runs (lines 55-66) — the empty-body skip (lines 39-49) applies only when content-type is ABSENT. The default JSON parser throws FST_ERR_CTP_EMPTY_JSON_BODY on empty payload (content-type-parser.js:325)."
  implication: Exact server mechanism identified; content-length does not gate the parser when the header is present

- timestamp: 2026-08-23T00:35:00Z
  checked: "Standalone empirical repro (scratchpad fastify-delete-repro.mjs) against the installed fastify 5.9.0 — NOT the app"
  found: "DELETE /thing/42 with Content-Type: application/json and no body → 400 {code: FST_ERR_CTP_EMPTY_JSON_BODY, message: \"Body cannot be empty when content-type is set to 'application/json'\"}. Same request WITHOUT the header → 200 {deleted:true}. Same request WITH body '{}' → 200. Also verified addContentTypeParser('*') does NOT rescue application/json requests (built-in parser takes precedence)."
  implication: Root cause and both viable fix shapes empirically demonstrated on the exact installed server version

- timestamp: 2026-08-23T00:42:00Z
  checked: "git show ec888af:apps/web/src/lib/api.ts (full apiFetch, introducing commit, Phase 01-04)"
  found: "apiFetch already carried the unconditional headers: { 'Content-Type': 'application/json', ...init?.headers } block AND apiDelete already had the conditional-body shape at introduction. No later commit changed either (history: ec888af → 77deb0c → c7f73bb → fb10e36, all preserve the header block)."
  implication: "Defect latent from the helper's birth — every bodyless UI delete (segments since Phase 3, team member removal since Phase 1) has been broken from the day it shipped; segments.spec.ts's delete step was mechanically red from birth, consistent with the e2e CI job being non-blocking"

- timestamp: 2026-08-23T00:38:00Z
  checked: "Secondary anomaly — apps/web/e2e/segments.spec.ts:73-78 clicks the UI delete ('Удалить' → 'Удалить сегмент') and asserts the row disappears; .github/workflows/ci.yml"
  found: "That spec exercises the exact broken path (DeleteSegmentDialog → bodyless deleteSegment). Mechanically it cannot pass against fastify 5.9.0. ci.yml:36 states the e2e job is deliberately NOT a required/blocking check on master ('a browser run that flakes would block every…'), so a red e2e would not have blocked merges. Latest actual CI e2e status not verified from this session."
  implication: Existing e2e coverage already encodes the regression test for this bug — fixing the helper should turn segments.spec.ts's delete step green; worth confirming e2e job status during fix verification

## Resolution

root_cause: "apps/web/src/lib/api.ts:33-36 — apiFetch unconditionally sets 'Content-Type: application/json' on every request, including bodyless ones. apiDelete (api.ts:70-75) correctly omits the body when no data is passed but inherits the header, producing DELETE requests with a JSON content-type and an empty payload. Fastify 5.9.0 treats DELETE as a body-carrying method (fastify.js:139-146) and, whenever a content-type header is present, always runs the content-type parser (lib/handle-request.js:55-66); the default JSON parser rejects the empty payload with 400 FST_ERR_CTP_EMPTY_JSON_BODY (lib/content-type-parser.js:325) before the route handler runs. Latent since Phase 01-04 (commit ec888af); affects all five bodyless UI delete actions (contacts, team members, segments, campaigns, flows), surfaced by Phase 21 UAT Test 2."
fix: ""  # find_root_cause_only — fix to be planned by plan-phase --gaps. Suggested direction: in apiFetch, attach Content-Type: application/json only when init.body is present (or move the header into apiPost/apiPatch/apiPut/apiDelete-with-data). Alternative (server-side addContentTypeParser override for application/json tolerating empty bodies) was considered and REJECTED as primary fix: it would mask malformed requests platform-wide (including the public event-ingestion surface), diverge from Fastify's documented default contract, and require touching parser behavior that webhook signature verification already carefully scopes — the client is simply sending a header that lies about the payload. A follow-up regression check: segments.spec.ts:73-78 already covers the segment path; contact-delete path needs its own test.
verification: ""
files_changed: []
