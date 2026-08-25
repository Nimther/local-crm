---
status: resolved
trigger: "auth-session-lifecycle"
created: 2026-08-25T00:00:00Z
updated: 2026-08-25T18:40:00Z
mode: fix_and_verify
tdd_phase: green
---

## Current Focus

bug_class: "Bohrbug x2 (both deterministic given hidden state — a stale nanostores atom value for S2, an IP rate counter for S1; neither is a Heisenbug)"

hypothesis_S2: "From the app's own redirect path (/ -> /login), the better-auth session atom already holds the resolved logged-out value {data:null, isPending:false}. After signIn.email succeeds, login.tsx navigates to '/' immediately; RootRedirect (App.tsx:71-88) reads that stale value, sees !session with sessionPending false, and renders <Navigate to='/login' replace> — the perceived 'page just reloaded'. The second submit succeeds because by then the $sessionSignal-driven refetch has populated the atom. HOLE TO CLOSE: query.mjs:60 sets isPending = (data === null) on refetch start, so this only holds if the signal fires DEFERRED past React's render."
test_S2: "Read the $sessionSignal trigger site in better-auth/dist/client to see whether signal.set is deferred (setTimeout/microtask) relative to the awaited signIn call returning."
expecting_S2: "Deferred trigger => bounce is deterministic and mechanism proven. No deferral => mechanism unproven, must reproduce in a real browser with instrumentation before touching code."

hypothesis_S1: "Multi-leg (AND-gate). (a) /login has NO authenticated guard, so the re-login scenario is reachable at all. (b) login.tsx:37-40 maps EVERY error shape to 'Неверный email или пароль', so a 429/5xx is displayed as wrong credentials. (c) the auth plugin's limiter (plugin.ts:31-34, max 20 / 1 minute) is scope-wide over /api/auth/*, so session reads (get-session) spend the same budget as credential submits — an authenticated user browsing the app can exhaust it, making the next sign-in 429 => 'wrong login or password'. Intermittency = whether the IP's counter is already spent."
test_S1: "Two app.inject probes on an ephemeral DB: (1) sign-in with a valid session cookie attached -> status/body; (2) 20x get-session then sign-in -> 429?"
expecting_S1: "Probe 1 200 => 'better-auth rejects re-login' eliminated. Probe 2 429 => shared-budget leg proven."

next_action: "Human verification: sign in through the real app (npm run dev restores the stack — it is still DOWN, the e2e lane freed 4000/5173) and confirm (a) correct credentials authenticate on the FIRST submit, (b) an authenticated user opening /login is redirected to the workspace without the login form flashing, (c) a wrong password still says wrong password. On 'confirmed fixed': archive to .planning/debug/resolved/ and append the knowledge-base entry (Prevention block already drafted in Resolution.prevention)."

tdd_checkpoint:
  status: "green — both lanes pass, all 3 anti-cheat guards still green, fix committed"
  path_1_symptom_1:
    api_test_file: "apps/api/src/modules/auth/__tests__/auth-rate-limit-buckets.test.ts"
    driving_test: "does not let a burst of session reads deny a correct credential submit"
    status: "green (was red)"
    green_output: "Test Files 1 passed (1) | Tests 4 passed (4), 6.12s — driving test + all 3 guards"
    failure_output: "RED (historical): AssertionError: correct credentials were rejected after 30 session reads (read statuses: 200 x19, 429 x11); body: {\"statusCode\":429,\"error\":\"Too Many Requests\",\"message\":\"Rate limit exceeded, retry in 1 minute\"}: expected 429 to be 200"
    guards_still_green:
      - "still throttles repeated wrong-password submits (401,401,401… then 429 with retry-after and no `code`) — forbids fixing by loosening the credential ceiling"
      - "keeps session reads bounded by a limiter of their own — forbids fixing by exempting /get-session"
      - "accepts a correct sign-in while a live session cookie is already attached — pins that re-login is legitimate"
    browser_tests:
      - "an authenticated user is redirected off /login… — GREEN 1.8s (was red: outcome 'login-form' instead of 'redirected')"
      - "a throttled sign-in is not reported as wrong credentials — GREEN 1.0s (was red: credential copy present under a stubbed 429)"
    run_command: "cd apps/api && npx vitest run src/modules/auth/__tests__/auth-rate-limit-buckets.test.ts"
  path_2_symptom_2:
    browser_test_file: "apps/web/e2e/auth-session-lifecycle.spec.ts"
    driving_test: "correct credentials authenticate on the FIRST submission (symptom 2)"
    status: "green (was red)"
    green_output: "4 passed (16.1s) — T1 4.0s, T2 1.8s, T3 1.0s, T4 1.4s. No bounce: one navigation from /login straight to /w/:slug, with exactly one sign-in POST."
    failure_output: "RED (historical): TimeoutError: page.waitForURL: Timeout 30000ms exceeded. navigated to '/' -> '/login' -> '/login' (the bounce), final snapshot shows the 'Вход' card. Also red: 'a page refresh after signing in keeps the session' — dependent casualty of the same bounce."
    run_command: "cd apps/web && npm run test:e2e -- auth-session-lifecycle.spec.ts   # needs 4000/5173 free"
  shared_verification: "apps/web/e2e/auth-session-lifecycle.spec.ts is the single shared auth-lifecycle spec for both paths (first-submit login, authenticated-user guard + loading state, throttle messaging, refresh persistence)."
  committed: "Branch `fix/auth-session-lifecycle` off master, local only — NOT pushed, no PR. a7005a0 = the two RED test files; 8e5c153 = the fix + SPECIFICATION.md §6.2 (RED-commit-then-fix-commit, per repo practice)."

reasoning_checkpoint:
  hypothesis: |
    TWO distinct root causes, one shared design flaw.
    S1 — an authenticated user's correct credentials are answered "Неверный email или пароль" because
    /api/auth/* shares ONE 20/min per-IP bucket: better-auth's session reads spend the credential
    budget, the sign-in is answered 429, and login.tsx maps every error shape to the wrong-credentials
    copy. The same 429 on a get-session is what strands the user on the unguarded /login route.
    S2 — the first submit bounces back to /login because login.tsx navigates to "/" the instant
    signIn.email() resolves, while better-auth defers its session refresh by setTimeout(..., 10);
    RootRedirect therefore decides from the store's retained logged-out value.
  confirming_evidence:
    - "Probe (real server, ephemeral DB): 17 get-session reads then a CORRECT sign-in -> 429 {statusCode:429,error:'Too Many Requests'}, retry-after 60. Re-run as a test: 200x19 then 429x11, sign-in 429."
    - "Probe: wrong password -> 401 {code:'INVALID_EMAIL_OR_PASSWORD'} — a distinguishable shape login.tsx does not look at (it branches on `if (error)` alone)."
    - "better-auth/dist/client/proxy.mjs lines 60-66: `setTimeout(() => signal.set(!val), 10)` with the comment 'To avoid race conditions we set the signal in a setTimeout'."
    - "App.tsx:71-88 reads only {data, isPending} from useSession — never isRefetching, never error — and returns <Navigate to='/login' replace> for data===null."
    - "App.tsx:120-155: /login carries no authenticated guard at all."
    - "plugin.ts:31-34: one rateLimit registration, max 20 / 1 minute, no keyGenerator, covering the whole scope."
    - "Pre-existing corroboration: apps/web/e2e/helpers/workspace-setup.ts already backs off on 429 from this bucket, calling it 'the production-shaped shared bucket'."
  falsification_test: |
    S1: split the buckets and a correct sign-in after 30 session reads returns 200 while 20+ wrong-password
    submits still 429 (both assertions live in auth-rate-limit-buckets.test.ts). If session reads still
    denied the credential submit, or brute force stopped being throttled, the diagnosis is wrong.
    S2: with every get-session held open 1200ms, ONE submit must reach /w/:slug and exactly one
    sign-in POST may be sent. If the first submit still lands on /login, the ordering claim is wrong;
    if it passes only without the injected delay, the fix is timing luck, not a fix.
  fix_rationale: |
    S1 addresses the cause on both legs: give session reads their own bucket (keyGenerator/max split in
    plugin.ts) so reads cannot spend the credential budget, and map errors by SHAPE in login.tsx
    (401/INVALID_EMAIL_OR_PASSWORD -> credential copy; 429 -> "try again later"; other -> generic
    failure). Neither loosens the credential-stuffing ceiling. S2 addresses the ordering itself: gate the
    post-sign-in navigation on the session store actually HOLDING the session, and make /login redirect an
    authenticated visitor while treating "session unknown" (pending/refetching/errored) as neither
    authenticated nor anonymous. No delay, retry, or re-submission anywhere.
  blind_spots:
    - "Not yet reproduced in a real browser — the S2 chain is read off better-auth/nanostores source plus the reported behaviour. The Playwright RED run is exactly this gap; if T1 fails for a different reason than a /login bounce, revisit."
    - "The right ceiling for the session-read bucket is a design choice, not something evidence dictates. The guard test only forbids 'unbounded' (429 within 200 reads)."
    - "Other unguarded auth routes (/register, /reset, /reset-password, /invite/:id) share the same missing-guard shape; only /login is covered by these tests."
    - "Whether real users also hit better-auth's 401-on-expired-session path (which nulls the store legitimately) is untested — the fix must not turn a genuine logout into a stuck loading state."
  candidate_causes:
    - "CONFIG: plugin.ts's single scope-wide rate-limit registration (no per-path bucket) — proven by probe."
    - "CODE: login.tsx's blanket `if (error)` -> wrong-credentials mapping — read directly."
    - "CODE: App.tsx RootRedirect treating data===null as definitively anonymous, ignoring isRefetching/error — read directly."
    - "CODE: no authenticated guard on the /login route — read directly."
    - "DEPENDENCY/ENVIRONMENT: better-auth 1.6.23's deliberate 10ms signal deferral + nanostores' 1000ms STORE_UNMOUNT_DELAY — read from node_modules source."
    - "ELIMINATED (data): no corrupt session/account rows involved; the server re-authenticates a live session happily (200 + fresh token)."
  and_gate: |
    YES for S1 — three legs must hold simultaneously for the reported symptom: the shared bucket must be
    spent (config), the sign-in must therefore 429, and the UI must mislabel that 429 as bad credentials
    (code). Remove any one and the report changes: separate buckets -> no 429; correct mapping -> the user
    is told to retry, not that their password is wrong; a guard on /login -> the authenticated user is
    never at the form. NO for S2 — that one is a single deterministic ordering defect (navigate-on-resolve
    against a store refreshed 10ms later), which is why it reproduces on the first attempt every time
    rather than intermittently.

fix_shape_guardrails:
  - "S2: gate navigation on the session store actually HOLDING data (await/subscribe the store), never on elapsed time. No setTimeout/retry/re-submit."
  - "Error mapping: only better-auth's invalid-credential code/status maps to 'Неверный email или пароль'; 429 / 5xx / network get a distinct message."
  - "The /login authenticated-guard must respect isPending — Symptoms.expected explicitly forbids rendering the login page during the auth loading state."
  - "Rate-limit fix must SPLIT budgets (session reads vs credential submits), never weaken the credential-stuffing control."
  - "Legs interlock across symptoms: a 429 on the post-login get-session ALSO bounces to /login, because RootRedirect ignores the atom's `error` field entirely."
  - "DOCS (project CLAUDE.md, hard rule): changing plugin.ts's rate-limit configuration is a public-entry-point change — update SPECIFICATION.md раздел 6 «Публичные точки входа» in the SAME change (and раздел 2 only if a new dependency is added; none is expected for either fix)."
  - "Alternative explanation for T1/T4 already excluded: a real 429 from the shared bucket would leave `error` truthy so `navigate('/')` would never run and the navigation log would stop at two entries. Both logs show a THIRD navigation to /login after the click, i.e. the sign-in returned 200 and the bounce came from RootRedirect."

## Symptoms

expected: "Authenticated user cannot stay on /login and is redirected to the workspace page; correct credentials authenticate on the FIRST form submission; wrong credentials produce a proper error message; page refresh after successful login preserves the session; auth loading state must not incorrectly render the login page."
actual: "(1) An already-authenticated user can open /login; re-submitting correct credentials there sometimes returns 'Неправильный логин или пароль' (wrong login or password). (2) From an unauthenticated state, the first submission of correct credentials only reloads the page; authentication succeeds only on the second attempt."
errors:
  - "UI error on re-login while already authenticated: 'Неправильный логин или пароль' despite correct credentials"
  - "No visible error on first-submit failure from unauthenticated state — page just reloads"
reproduction: "(1) Log in, then navigate to /login manually and submit the same correct credentials — intermittently get the wrong-credentials error. (2) From logged-out state, submit correct credentials once — page reloads without logging in; second identical submission succeeds."
constraints:
  - "Each fix must be driven by a reproducible RED test first (TDD)"
  - "Regression coverage required at both API/session level and browser level (Playwright)"
  - "Do NOT mask the problem with delays, retries/re-submission, or setTimeout"
  - "If the two symptoms have distinct root causes, split into two proven fix paths but keep one shared auth-lifecycle verification"

## Evidence

- timestamp: 2026-08-25T00:10:00Z
  checked: ".planning/debug/knowledge-base.md + resolved/ (30 sessions)"
  found: "No entry matches auth/login/session-lifecycle keywords. Closest reusable pattern is segm-04-live-count-race: 'an intermittent failure is a gate reporting a real defect at a low duty cycle', and its technique of pinning a timing condition open with an INJECTED delay so the guard has teeth."
  implication: "No known-pattern shortcut. Reuse segm-04's injected-delay-as-stimulus pattern for the browser-level regression test."

- timestamp: 2026-08-25T00:12:00Z
  checked: "apps/web/src/App.tsx router tree (lines 120-155)"
  found: "<Route path='/login' element={withSuspense(<LoginPage />)} /> has NO authenticated guard. /register, /reset, /reset-password are equally unguarded. Only '/' (RootRedirect) makes any session decision."
  implication: "Symptom 1's precondition is structural: nothing stops an authenticated user from sitting on /login. Symptoms.expected requires a redirect off /login for authenticated users."

- timestamp: 2026-08-25T00:14:00Z
  checked: "apps/web/src/routes/login.tsx onSubmit (lines 30-45)"
  found: "TWO defects in 15 lines. (1) `if (error) setServerError('Неверный email или пароль…')` — every error shape (429 rate-limit, 5xx, network failure, CSRF/origin rejection) is reported as wrong credentials; the reported symptom string is the user's paraphrase of exactly this message (grep confirms 'Неправильный логин или пароль' exists nowhere in the codebase). (2) on success it calls `void navigate('/')` immediately, with no wait for the auth client's session store to actually hold the new session."
  implication: "(1) is the display mechanism for symptom 1 regardless of which error is underneath. (2) is the navigation half of symptom 2."

- timestamp: 2026-08-25T00:16:00Z
  checked: "apps/web/src/App.tsx RootRedirect (lines 70-88)"
  found: "Decides on `const { data: session, isPending: sessionPending } = useSession()`. Guards only `sessionPending`; then `if (!session) return <Navigate to='/login' replace />`. It reads neither `isRefetching` nor `error` from the session atom."
  implication: "Any state where the atom holds data=null with isPending=false — stale logged-out value, or a failed/429 get-session — is treated as 'definitively unauthenticated' and bounces to /login. This is the redirect half of symptom 2 AND the interlock that lets a 429 masquerade as logged-out."

- timestamp: 2026-08-25T00:18:00Z
  checked: "node_modules/better-auth/dist/client/query.mjs (useAuthQuery, better-auth 1.6.23)"
  found: "The session store is a nanostores atom initialized {data:null, isPending:true}. It retains its last value across unmount (line 9 atom + onMount). Line 87-99: the fetch fires ONCE via onMount/setTimeout(0) guarded by `isInitialized`; every later refresh comes only from an initializedAtom ($sessionSignal) subscription — remounting a component does NOT trigger a new fetch. onRequest (line 57-65) sets isPending = (currentValue.data === null), isRefetching = true. onError (line 42-55) sets isPending:false and keeps stale data unless status===401."
  implication: "Confirms the atom is a persistent cache, and that a component remount cannot refresh it. Also flags the hole in hypothesis_S2: if the signal fired synchronously before render, isPending would be true and no bounce could occur — so the bounce requires the signal.set to be DEFERRED past React's render. Must verify at the trigger site."

- timestamp: 2026-08-25T00:20:00Z
  checked: "apps/api/src/modules/auth/plugin.ts"
  found: "@fastify/rate-limit registered INSIDE the encapsulated auth scope with `{ max: 20, timeWindow: '1 minute' }` and no keyGenerator, so one per-IP budget is shared by every /api/auth/* route — credential submits (sign-in/email) and session reads (get-session) alike. Same scope strips all content-type parsers and hijacks the reply for better-auth's raw-body Node handler."
  historical_note: "Comment claims the limiter guards 'against credential stuffing / invite-token brute force' — the intent is credential-path protection, but the implementation is scope-wide."
  implication: "A plausible mechanism for symptom 1's intermittency: session reads spend the credential budget, so a sign-in can 429 and be displayed as wrong credentials. Needs an empirical probe — not assumed."

- timestamp: 2026-08-25T00:22:00Z
  checked: "apps/api/src/modules/auth/auth.ts + ~/.config/mega-crm/.env"
  found: "better-auth 1.6.23, emailAndPassword enabled, requireEmailVerification false, 30-day sliding session (expiresIn 30d / updateAge 1d), trustedOrigins [WEB_URL]. Dev env: BETTER_AUTH_URL=http://localhost:4000, WEB_URL=http://localhost:5173, NODE_ENV=development. No `rateLimit` block configured, and better-auth's own limiter defaults to production-only — so the Fastify scope limiter is the only one in play in dev."
  implication: "Rules out better-auth's internal rate limiter as the dev-time cause. Origin/trustedOrigins mismatch stays a candidate only for a 127.0.0.1-vs-localhost access pattern, and would be deterministic rather than 'sometimes'."

- timestamp: 2026-08-25T00:24:00Z
  checked: "Harness inventory: apps/api/src/modules/auth/__tests__/auth-boundary.test.ts, apps/web/e2e/, apps/web/package.json"
  found: "API level: buildServer() + app.inject() against a real ephemeral migrated DB, with signUp/signIn helpers that read the session cookie out of res.cookies — the exact vehicle for API/session-level regression coverage. Browser level: 13 Playwright specs (1.61.1) + e2e/helpers/workspace-setup.ts + run-e2e.ts wrapper. Web stack: react 19.2.7 under React.StrictMode, react-router 8.3.0 data router, better-auth 1.6.23 client with organizationClient plugin."
  implication: "Both required regression layers already have harnesses; no new infrastructure needed. StrictMode double-effects are a dev-only amplifier of any per-mount auth request."

- timestamp: 2026-08-25T00:26:00Z
  checked: "Live environment: docker ps, lsof on :4000 and :5173"
  found: "Dev stack is UP — mega-crm-db-1 healthy 4 days, API listening on :4000, Vite on :5173."
  implication: "Real-browser reproduction is available. But probes must NOT be curled at :4000 — that spends the live 20/min IP budget and writes the dev DB. Use app.inject on an ephemeral DB instead."

- timestamp: 2026-08-25T00:32:00Z
  checked: "node_modules/better-auth/dist/client/proxy.mjs (createDynamicPathProxy onSuccess) + session-atom.mjs + session-refresh.mjs + nanostores/lifecycle/index.js"
  found: "THE S2 HOLE IS CLOSED — the deferral is explicit and in better-auth's own source. proxy.mjs lines 60-66: after a matching endpoint (incl. /sign-in/email) succeeds, the session signal is set inside `setTimeout(() => signal.set(!val), 10)` with the literal comment 'To avoid race conditions we set the signal in a setTimeout'. So the session refetch begins ~10ms AFTER `await signIn.email()` resolves. Two supporting facts: (1) session-refresh.mjs setupSignalSubscription (signal -> fetchSession) is wired only inside refreshManager.init(), which runs only from onMount(session, ...) — so the signal only refetches while the session store has a subscriber; (2) nanostores STORE_UNMOUNT_DELAY = 1000ms keeps the store 'active' for 1s after the last unsubscribe."
  implication: "Symptom 2 is NOT a microtask race — it is a deterministic ordering defect. `void navigate('/')` renders RootRedirect synchronously (React flushes in a microtask, ~10ms before the signal fires), so RootRedirect reads the store's RETAINED logged-out value {data:null, isPending:false} and bounces to /login. It also explains why attempt 2 works: the bounce's brief RootRedirect mount subscribes the store, and nanostores' 1s unmount delay keeps that subscription alive long enough for the +10ms signal to fire fetchSession, so the session lands in the store while the user sits on /login. Sharp falsifiable prediction: a DIRECT hard load of /login (store never mounted, so isPending stays true) must SUCCEED on the first submit, while arriving via the app's own '/' -> /login redirect must FAIL."

- timestamp: 2026-08-25T00:40:00Z
  checked: "Empirical probe (apps/api/src/modules/auth/__tests__/probe-auth-lifecycle.test.ts, app.inject on an ephemeral migrated DB — temporary file, deleted after the run)"
  found: |
    P1 — sign-in WITH a live session cookie attached: 200 + a brand-new token. better-auth does not reject re-login at all.
    P3 — wrong password: 401 {"message":"Invalid email or password","code":"INVALID_EMAIL_OR_PASSWORD"}.
    P2 — PROVEN: after sign-up + re-sign-in + wrong-password (3 calls), 17 further GET /api/auth/get-session calls exhausted the budget: read #18 returned 429, and the very next sign-in/email with CORRECT credentials returned 429 {"statusCode":429,"error":"Too Many Requests","message":"Rate limit exceeded, retry in 1 minute"}, retry-after: 60. Statuses: 200x17 then 429.
  implication: "Symptom 1's server side is not a credential failure at all — it is the shared 20/min bucket being spent by SESSION READS and then denying the credential submit. The 429 body carries NO better-auth `code` field, so login.tsx's blanket `if (error)` renders it as 'Неверный email или пароль'. The 401 shape from P3 gives the fix a precise discriminator (status 401 / code INVALID_EMAIL_OR_PASSWORD) to key the credential message on."

- timestamp: 2026-08-25T00:44:00Z
  checked: "Interlock analysis across the two symptoms, using session-atom.mjs's error branch"
  found: "session-atom.mjs sets `data: isUnauthorized ? null : latest.data` — a 429 is not 401, so a rate-limited get-session keeps whatever data it had and sets isPending:false. On a FRESH page load the store has data:null, so a 429 on the first get-session leaves {data:null, error:429, isPending:false} — and RootRedirect, which reads neither `error` nor `isRefetching`, sends the still-authenticated user to /login."
  implication: "Explains the reported premise 'an already-authenticated user can open /login' without the user doing anything unusual: the app SENDS them there once the auth budget is spent. Their correct credentials then 429 -> 'wrong login or password'. The two symptoms share the same underlying design flaw: an auth decision made from a session store whose 'null' means three different things (never fetched / fetched-and-logged-out / fetch failed)."

- timestamp: 2026-08-25T00:46:00Z
  checked: "grep for better-auth organization client endpoints in apps/web/src"
  found: "The app deliberately uses /api/workspaces instead of better-auth's organization.list (D-20), so /api/auth/* traffic is essentially get-session only."
  implication: "The 20/min budget is consumed almost entirely by session reads — which better-auth fires on window focus (refetchOnWindowFocus default true, 5s floor), online/visibility changes, cross-tab broadcast, and every fresh store mount (doubled by React.StrictMode in dev). Alt-tabbing for ~100s is enough to spend it."

- timestamp: 2026-08-25T01:00:00Z
  checked: "apps/web/e2e/helpers/workspace-setup.ts (pre-existing code, written before this debug session)"
  found: "registerAndCreateWorkspace already carries a 429 retry-after backoff around sign-up, with the comment: 'The full serial E2E corpus legitimately exercises enough /api/auth/* requests to reach the production-shaped shared bucket.'"
  implication: "Independent corroboration of the S1 root cause from the repo's own history — the shared /api/auth bucket has ALREADY been observed denying legitimate credential submits, and was worked around in test code rather than diagnosed. Same 'low duty cycle gate' lesson as segm-04 and aggregate-coverage-run-fails."

- timestamp: 2026-08-25T01:05:00Z
  checked: "Rate-limit response headers on hijacked auth responses (probe, deleted after run)"
  found: "x-ratelimit-limit / -remaining / -reset come back EMPTY on successful /api/auth responses (both get-session and sign-in) and on /api/auth/ok. Only the 429 short-circuit carries retry-after: 60."
  implication: "The auth scope's reply.hijack() + reply.raw writes bypass Fastify's onSend header application, so header-based assertions would be vacuous. The regression test must use status codes as its oracle. (Also noted: /api/auth/ok — the E2E webServer health probe — sits inside the limited scope and spends the same budget.)"

- timestamp: 2026-08-25T01:10:00Z
  checked: "RED run of the new driving test: apps/api/src/modules/auth/__tests__/auth-rate-limit-buckets.test.ts (npx vitest run, foreground, single file)"
  found: |
    1 failed | 3 passed. The driving test fails with the reported mechanism verbatim:
    read statuses 200 x19 then 429 x11, and the following sign-in with CORRECT credentials -> 429
    {"statusCode":429,"error":"Too Many Requests","message":"Rate limit exceeded, retry in 1 minute"}.
    The three guard tests are GREEN already and must stay so: wrong-password submits are still
    throttled (401,401,401,... then 429 with retry-after and NO `code` field, vs a genuine 401
    carrying code INVALID_EMAIL_OR_PASSWORD); session reads are bounded; and a correct sign-in with a
    live session cookie attached returns 200 with a freshly reissued token.
  implication: "Symptom 1's server leg is now pinned by an executable RED test, and the security control plus the 401-vs-429 discriminator the UI fix needs are pinned by guards that already pass — so the fix cannot pass by loosening the credential limiter."

- timestamp: 2026-08-25T01:15:00Z
  checked: "CORRECTION to the earlier S2 note — which mechanism actually repopulates the store before the second submit"
  found: "nanostores' onMount fires on every unmounted->mounted transition, and getSessionAtom's onMount schedules setTimeout(0) -> fetchSession() AND re-inits the refresh manager (re-subscribing the signal). Realistically the user spends more than nanostores' 1000ms STORE_UNMOUNT_DELAY on /login before clicking, so by click time the store has fully unmounted and the deferred +10ms signal has NO listener — meaning the value that makes attempt 2 succeed comes from the bounce-remount's setTimeout(0) fetch, not from the signal."
  implication: "Does not change the fix shape — the store is stale at the instant RootRedirect decides, whichever path later fills it — but the green phase must not over-index on the signal path (e.g. by waiting on the signal alone). Gate on the DATA being present."

- timestamp: 2026-08-25T01:30:00Z
  checked: "Browser-layer RED run: `npm run test:e2e -- auth-session-lifecycle.spec.ts` from apps/web (foreground, own ephemeral DB, own servers). The dev stack had to be stopped first — playwright.config.ts sets reuseExistingServer:false on both servers by design, and it was holding 4000/5173."
  found: |
    4 failed / 0 passed, each for its OWN predicted reason:
    T1 (symptom 2, DRIVING) — waitForURL timeout; Playwright's navigation log is the reproduction
       verbatim: navigated to "/" -> "/login" -> (click) -> "/login" AGAIN, final snapshot showing the
       "Вход" card. One submit of correct credentials bounces straight back to the login form, with
       every get-session held open 1200ms so this cannot be timing luck on a fast machine.
    T2 (symptom 1, guard) — race outcome "login-form" instead of "redirected": an ALREADY-authenticated
       user is shown the login form (and never redirected off /login).
    T3 (symptom 1, mapping) — with sign-in stubbed 429, getByText(/Неверный email или пароль/i)
       resolved to 1 element where 0 was required: a throttle is reported as wrong credentials.
    T4 (refresh pin) — same double-"/login" navigation log as T1: a DEPENDENT casualty of symptom 2,
       not a fifth defect. It cannot reach its refresh assertion until the first-submit bounce is fixed.
  implication: "Both root causes are now pinned by executable RED tests at the browser layer, and symptom 2's diagnosis is confirmed by direct observation rather than source reading alone. The blind spot recorded in the reasoning checkpoint ('not yet reproduced in a real browser') is closed, and T1 failed for the predicted /login-bounce reason, not some other cause."

- timestamp: 2026-08-25T18:15:00Z
  checked: "INDEPENDENT RE-VERIFICATION of the RED state by the debug session manager (not the investigating agent), because the TDD checkpoint requires the red state to be confirmed rather than asserted. Both driving tests re-run from a clean manager context, foreground, single file each."
  found: |
    Lane 1 — `cd apps/api && npx vitest run src/modules/auth/__tests__/auth-rate-limit-buckets.test.ts`
      => "Test Files 1 failed (1) | Tests 1 failed | 3 passed (4)", duration 5.34s.
      Driving test "does not let a burst of session reads deny a correct credential submit" fails with:
      read statuses 200 x19 then 429 x11, sign-in body
      {"statusCode":429,"error":"Too Many Requests","message":"Rate limit exceeded, retry in 1 minute"},
      "expected 429 to be 200" at line 103. The 3 guards are green, as reported.
    Lane 2 — `cd apps/web && npm run test:e2e -- auth-session-lifecycle.spec.ts` => 4 failed.
      T1/T4 navigation log reproduced verbatim: "/" -> "/login" -> (click) -> "/login".
      T3 fails with getByText(/Неверный email или пароль/i) toHaveCount(0) receiving 1 (14 x resolved
      to 1 element) — a stubbed 429 rendered as a credential error.
      T2 fails with outcome "login-form" instead of "redirected".
    Git state confirmed: both test files are untracked (`??`) on branch master; no source files modified,
    so the RED state is genuinely pre-fix and not an artifact of a partial edit.
  implication: "RED is independently confirmed for BOTH fix paths, each failing for its own stated reason, with the anti-cheat guards already green. The TDD gate's factual precondition is satisfied. What remains is the human confirmation to enter the GREEN phase — which this manager cannot self-supply (no AskUserQuestion tool in its session), so the checkpoint is returned upward unresolved rather than assumed."

- timestamp: 2026-08-25T18:35:00Z
  checked: "GREEN phase — the two fixes applied on branch fix/auth-session-lifecycle, then both lanes re-run in the foreground (single file each, dev stack down, ports 4000/5173 confirmed free before the e2e lane)"
  found: |
    API lane `cd apps/api && npx vitest run src/modules/auth/__tests__/auth-rate-limit-buckets.test.ts`
      => "Test Files 1 passed (1) | Tests 4 passed (4)", 6.12s (was 1 failed / 3 passed).
      The three anti-cheat guards all still pass, so the split did not buy the driving test by
      loosening anything: wrong-password submits still throttle, session reads still hit 429 within
      200 reads, re-login with a live cookie still 200 + fresh token.
    Browser lane `cd apps/web && npm run test:e2e -- auth-session-lifecycle.spec.ts`
      => "4 passed (16.1s)" (was 4 failed). T1 first-submit login 4.0s — the "/" -> /login -> /login
      bounce is gone even with every get-session held open 1200ms, and the spec's own
      "exactly one sign-in POST" assertion holds, so it is not a silent re-submit. T2 1.8s, T3 1.0s,
      T4 1.4s.
    Regression + gates: apps/api auth module suite 13/13; rate-limit-distributed 5/5 (SEC-11 intact);
    apps/web unit suite 144/144 across 19 files; register-create-workspace.spec.ts 1/1 (the only other
    e2e spec walking an auth route, and it exercises the changed RootRedirect); `tsc --noEmit` clean on
    both apps; `npm run lint` (eslint . --max-warnings=0) clean.
  implication: "Both root causes are fixed at the cause, not the symptom, and the fix-acceptance guardrail is satisfied on every applicable signal. Mutation evidence comes free from the double-verified RED baseline: the same 8 assertions failed with only these three source files unmodified, so each assertion is load-bearing on this fix rather than vacuously true. Remaining step is human confirmation in the real app — no test can verify the reported user experience end to end."

## Eliminated

- hypothesis: "better-auth rejects sign-in when a valid session cookie is already present (a server-side 'already signed in' rejection)"
  evidence: "Probe P1: POST /api/auth/sign-in/email with the live session cookie attached returned 200 with a new session token. The server re-authenticates happily."
  timestamp: 2026-08-25T00:40:00Z

- hypothesis: "better-auth's own internal rate limiter is throttling sign-in"
  evidence: "auth.ts configures no `rateLimit` block, and better-auth's built-in limiter defaults to production-only; dev env is NODE_ENV=development. The 429 seen in the probe carries @fastify/rate-limit's body shape ({statusCode, error:'Too Many Requests'}), not a better-auth error code — so the Fastify scope limiter in plugin.ts is the one firing."
  timestamp: 2026-08-25T00:40:00Z

- hypothesis: "trustedOrigins / CSRF origin mismatch (e.g. 127.0.0.1 vs localhost) rejects the sign-in"
  evidence: "Dev env has WEB_URL=http://localhost:5173 matching the Vite dev server, and the probe's sign-in with Origin: http://localhost:5173 returned 200. It would also be deterministic, not the reported 'sometimes'."
  timestamp: 2026-08-25T00:40:00Z

- hypothesis: "Symptom 2 is a genuine microtask race between the session refetch and the router render (so the outcome would be machine/timing dependent)"
  evidence: "proxy.mjs defers signal.set by an explicit setTimeout(..., 10). A 10ms timer cannot beat React's microtask-flushed render, so the first-submit bounce is deterministic on every machine, not a race."
  timestamp: 2026-08-25T00:32:00Z

- hypothesis: "The 'page reloads' on first submit is a native form submission (missing preventDefault) or an explicit window.location reload"
  evidence: "login.tsx submits through react-hook-form's handleSubmit (which calls preventDefault synchronously) and grep finds no location.reload/href/assign anywhere in apps/web/src. The perceived 'reload' is <Navigate to='/login' replace> re-mounting the lazy LoginPage with empty fields."
  timestamp: 2026-08-25T00:16:00Z

## Resolution

root_cause: |
  TWO distinct root causes that share one design flaw — an authentication decision made from a session
  store whose `null` conflates three different states (never fetched / fetched-and-logged-out / fetch
  failed).

  S1 (correct credentials reported as wrong) — AND-gate, three legs, all confirmed:
    (a) CONFIG: apps/api/src/modules/auth/plugin.ts registers @fastify/rate-limit ONCE for the whole
        /api/auth/* scope (max 20 / 1 minute / IP, no keyGenerator), so better-auth's session READS
        spend the credential budget. Proven: 19 get-session reads pass, then reads AND a correct
        sign-in are answered 429 {"statusCode":429,"error":"Too Many Requests"} with retry-after 60.
    (b) CODE: apps/web/src/routes/login.tsx:37-40 maps EVERY error shape to
        "Неверный email или пароль", so that 429 is displayed as wrong credentials. The server does
        expose a discriminator it never reads — a genuine failure is 401 with
        code INVALID_EMAIL_OR_PASSWORD, while the throttle carries no `code` at all.
    (c) CODE: /login has no authenticated guard (App.tsx), and RootRedirect (App.tsx:71-88) reads
        neither `error` nor `isRefetching` — so a 429 on the first get-session of a fresh page load
        leaves {data:null, error:429, isPending:false} and the app SENDS the still-authenticated user
        to /login, where their correct credentials are then 429'd and mislabelled.

  S2 (first submit only "reloads" the page) — a single deterministic ordering defect, not a race:
    login.tsx calls `void navigate("/")` the instant `signIn.email()` resolves, but better-auth
    1.6.23 defers its own session refresh — client/proxy.mjs sets the session signal inside
    `setTimeout(..., 10)` ("To avoid race conditions we set the signal in a setTimeout"). React
    flushes the navigation in a microtask, ~10ms earlier, so RootRedirect reads the store's RETAINED
    logged-out value (left by the "/" -> /login redirect the user arrived through) and renders
    <Navigate to="/login" replace> — the perceived reload. The second attempt succeeds because the
    bounce's brief RootRedirect mount re-mounts the store, whose onMount schedules
    setTimeout(0) -> fetchSession (and re-subscribes the deferred signal); nanostores' 1000ms
    STORE_UNMOUNT_DELAY keeps that work alive, so the session lands in the store while the user sits
    on /login. Predicted asymmetry, and the fingerprint to test: a DIRECT hard load of /login (store
    never mounted, isPending stays true) submits fine on the FIRST try.

fix: |
  APPLIED on branch `fix/auth-session-lifecycle` (local only — not pushed, no PR).
  Commit a7005a0 = the two RED test files. Commit 8e5c153 = the fix + SPECIFICATION.md.

  S1(a) CONFIG — apps/api/src/modules/auth/plugin.ts: the single scope-wide `{ max: 20 }` became TWO
    independent per-IP buckets in one registration, separated by `keyGenerator`
    (`auth-read:<ip>` / `auth-credential:<ip>`) with `max` resolved per request.
    `auth-read` = GET/HEAD on an explicit allow-list (`/api/auth/get-session`, `/api/auth/ok`) at
    120/min; `auth-credential` = everything else at 20/min — the credential-stuffing ceiling is
    UNCHANGED. Per-route `config.rateLimit` was not an option: the scope serves better-auth through
    one catch-all route, so only keyGenerator/max can tell the paths apart. Store deliberately left
    as the in-memory default (the app-wide Redis store in server.ts is `{ global: false }` and never
    applied here) — pre-existing property, not touched.
  S1(b) CODE — apps/web/src/routes/login.tsx: `signInErrorMessage()` maps failures BY SHAPE.
    401 or `code: INVALID_EMAIL_OR_PASSWORD` -> credential copy; 429 -> "Слишком много попыток
    входа. Подождите минуту и войдите снова."; anything else -> a generic service-unavailable line.
    Only the credential shape may mention credentials.
  S1(c) + S2 CODE — apps/web/src/App.tsx: `resolveSessionStatus()` collapses the session store into
    authenticated / anonymous / UNKNOWN, where unknown = isPending || isRefetching || a non-401
    error, and a 401 is treated as anonymous (so a genuinely expired session still reaches the login
    form — blind spot #4 closed). New `RequireAnonymous` guard wraps /login: authenticated ->
    <Navigate to="/"/>, unknown -> `SessionUnknownState` (skeleton while pending, QueryErrorState +
    retry on error, so a failed session read cannot hang the page), anonymous -> the form.
    RootRedirect now routes off the same three-state value instead of `!session`, so a throttled or
    failed get-session no longer masquerades as "signed out".
  S2 ordering — login.tsx no longer calls `navigate("/")` on `signIn.email()` resolving. It kicks the
    session store's own `refetch()` and lets `RequireAnonymous` perform the redirect the moment the
    store actually HOLDS the session. Gated on data presence, never on elapsed time; no setTimeout,
    no retry, no re-submission (pinned by the spec's one-sign-in-request assertion). `refetch()` is
    called explicitly rather than relying on better-auth's internal deferred signal, so a successful
    sign-in can never become a silent no-op. `awaitingSession` keeps the submit button in its pending
    state for the render gap until the guard takes over, so a successful submit can never look
    submittable again.
  DOCS — SPECIFICATION.md §6.2: the `/api/auth/*` row now states both buckets, plus a bucket table,
    the reason for the split, the in-memory-store caveat and the hijack/no-`x-ratelimit-*` caveat.
    Раздел 2 untouched — no new dependency.
verification: |
  GREEN. Both lanes run in the foreground, single file each, dev stack down.
    API lane — `cd apps/api && npx vitest run src/modules/auth/__tests__/auth-rate-limit-buckets.test.ts`
      => "Test Files 1 passed (1) | Tests 4 passed (4)", 6.12s. Was 1 failed / 3 passed.
      All THREE anti-cheat guards still green: wrong-password submits still throttled (401,401,401 …
      then 429 with retry-after and no `code`), session reads still bounded (429 inside 200 reads —
      no blanket /get-session exemption), re-login with a live cookie still 200 + a fresh token.
    Browser lane — `cd apps/web && npm run test:e2e -- auth-session-lifecycle.spec.ts`
      => "4 passed (16.1s)". Was 4 failed. T1 first-submit login 4.0s, T2 authenticated-user guard
      1.8s, T3 throttle-not-credentials 1.0s, T4 refresh persistence 1.4s. T4 included.
  Regression + gates, all green:
    apps/api `npx vitest run src/modules/auth/__tests__/` -> 3 files / 13 tests passed
    apps/api `npx vitest run src/__tests__/rate-limit-distributed.test.ts` -> 5 passed (SEC-11 intact)
    apps/web `npx vitest run` -> 19 files / 144 tests passed
    apps/web `npm run test:e2e -- register-create-workspace.spec.ts` -> 1 passed (the only other spec
      that walks an auth route, and it exercises the changed RootRedirect)
    `npx tsc --noEmit` (web) and `npx tsc -p tsconfig.json --noEmit` (api) -> clean
    `npm run lint` (eslint . --max-warnings=0) -> clean
  Mutation evidence is the double-verified RED baseline itself: the same 8 assertions failed with only
  these three source files unmodified, so each is load-bearing on this fix rather than vacuously true.
  Not run: the full suite (per operating instructions — advisory-lock / flow-run-advance / temp-redis
  flake under full-suite load, and api+worker `sentry.test.ts` "no DSN" tests fail deterministically on
  this machine because of real DSNs in ~/.config/mega-crm/.env).
  INDEPENDENT MANAGER RE-VERIFICATION (2026-08-25T18:45:00Z, clean context, not the fixing agent —
  same discipline applied to GREEN as to RED, so no lane is green only on the implementer's word):
    API lane re-run => "Test Files 1 passed (1) | Tests 4 passed (4)", 6.46s. Confirmed.
    Browser lane re-run => "4 passed (14.6s)" — T1 3.9s, T2 1.8s, T3 998ms, T4 1.4s. Confirmed.
    plugin.ts diff read directly: CREDENTIAL_BUCKET_MAX stays 20/min (ceiling NOT loosened);
      SESSION_READ_BUCKET_MAX 120/min is finite; the read bucket is reachable only by GET/HEAD on an
      explicit 2-path allow-list (/api/auth/get-session, /api/auth/ok) with the query string stripped,
      so no POST credential route and no token-carrying GET can land in the roomier bucket — the split
      cannot widen the brute-force surface.
    Hard project rule verified: commit 8e5c153 contains SPECIFICATION.md AND plugin.ts together.
    Git verified: branch fix/auth-session-lifecycle, 3 commits ahead of origin/master, working tree
      clean, NOT present on the remote (`git ls-remote --heads origin 'fix/*'` shows only two unrelated
      older branches), knowledge-base.md untouched per git status after the last git operation.
  HUMAN-VERIFY CHECKPOINT DISPOSITION (answered by the user, relayed via the coordinator):
  the user replied "Push + PR сразу" — they explicitly TRUSTED the green API/e2e lanes and CHOSE TO
  SKIP the manual browser walkthrough, authorizing archive + push + PR (explicitly NOT merge).
  So the manual steps below were never executed by a human, and the three behavioral deltas in
  `behavioral_deltas_to_disclose` were accepted unseen rather than eyeballed — recorded here honestly
  because the fix's UX-visible surface (a brief skeleton on "/" and between submit and workspace) has
  machine proof of correctness but no human confirmation of feel. Automated evidence stands on its own:
  both lanes double-verified, guards green, credential ceiling unchanged.
behavioral_deltas_to_disclose:
  - "RootRedirect's undecided state renders the route skeleton instead of `null`, so '/' now shows a brief skeleton during the first get-session (previously a blank screen). Required by the unknown != anonymous constraint."
  - "/login now issues one get-session on load (the guard subscribes the session store) — in the roomier auth-read bucket."
  - "A successful sign-in briefly shows the skeleton instead of the form while the session store fills, then lands on /w/:slug — one navigation, no bounce."
prevention: |
  why not caught: none — no gate existed for this class. The shared /api/auth bucket denying legitimate
  credential submits had ALREADY been observed in this repo and worked around in test code rather than
  escalated: apps/web/e2e/helpers/workspace-setup.ts carries a 429 retry-after backoff around sign-up
  with the comment "the production-shaped shared bucket". Nothing tested the bucket's contract, and no
  test covered the auth session lifecycle in a browser, so the first-submit bounce was invisible to CI.
  guard: the two committed test files. auth-rate-limit-buckets.test.ts pins the bucket-split invariants
  in both directions (reads may not deny a credential submit; the credential ceiling and the read
  ceiling must both stay finite), and auth-session-lifecycle.spec.ts pins the browser-level lifecycle
  (first-submit login, no login form during the auth loading state, throttle != wrong credentials,
  refresh persistence) with an injected get-session delay so it cannot pass on timing luck.
  Same lesson as segm-04-live-count-race and aggregate-coverage-run-fails: a workaround added to test
  infrastructure is a defect report, not a fix.
follow_ups_not_in_scope:
  - "/register, /reset, /reset-password, /invite/:id and /create-workspace remain without an authenticated guard. They are not reachable into this defect (register.tsx navigates to /create-workspace, not '/'), so they were deliberately left alone; the RequireAnonymous component is ready to wrap them if wanted."
  - "The /api/auth/* limiter's counters are per process (in-memory), unlike the app-wide Redis-backed limiter — N API replicas together allow N x max on both auth buckets. Pre-existing; now documented in SPECIFICATION.md §6.2."
files_changed:
  - "apps/api/src/modules/auth/__tests__/auth-rate-limit-buckets.test.ts (NEW — RED test + 3 guards; commit a7005a0)"
  - "apps/web/e2e/auth-session-lifecycle.spec.ts (NEW — browser-level shared auth-lifecycle verification; commit a7005a0)"
  - "apps/api/src/modules/auth/plugin.ts (rate-limit split into auth-read / auth-credential buckets; commit 8e5c153)"
  - "apps/web/src/routes/login.tsx (error mapping by shape; eager navigate removed in favour of the store-gated guard; commit 8e5c153)"
  - "apps/web/src/App.tsx (resolveSessionStatus + SessionUnknownState + RequireAnonymous guard on /login; RootRedirect routes off the three-state value; commit 8e5c153)"
  - "SPECIFICATION.md (§6.2 — two /api/auth/* buckets, store and header caveats; commit 8e5c153)"
