---
status: resolved
trigger: "UAT Test 11 (phase 06): autosave error state never shows — toolbar stuck at «Сохранение…» when save fails"
created: 2026-07-13T20:45:00.000Z
updated: 2026-07-13T20:55:00.000Z
mode: find_root_cause_only
symptoms_prefilled: true
---

## Current Focus

hypothesis: CONFIRMED — TanStack Query v5 default networkMode 'online' pauses the autosave mutation while the browser is offline: mutationFn never runs, status stays 'pending' (isPending:true, isPaused:true), isError never fires, so deriveAutosaveState returns "saving" forever
test: read query-core retryer.ts / mutation.ts source in node_modules to trace exact offline behavior; ran autosaveState unit test
expecting: n/a — root cause confirmed with direct source evidence
next_action: hand off to plan-phase --gaps (goal is find_root_cause_only; no fix applied)

## Symptoms

expected: "UAT Test 11: With a flow canvas open, simulate a save failure (stop the API or go offline in devtools) and make an edit. The toolbar shows an honest error/retrying state — NOT «Сохранено». Restore connectivity: the automatic retry re-fires the PATCH and the state returns to «Сохранено»."
actual: "ошибка не показывается. Просто висит статус «Сохранение...»" — toolbar hangs at «Сохранение…» indefinitely; error state never renders
errors: none reported (no console errors mentioned)
reproduction: .planning/phases/06-flows-triggered-chains/06-UAT.md Test 11 — open flow canvas, go offline in devtools (or stop API), make a canvas edit, observe toolbar
started: discovered during phase 6 UAT on 2026-07-13; plan 06-21 (WR-05) was supposed to have fixed exactly this behavior

## Eliminated

- hypothesis: "The toolbar renders directly from mutation.isPending instead of deriveAutosaveState"
  evidence: FlowCanvas.tsx:169 uses useAutosaveDraft's saveState; line 329 renders all three states from saveState. Wiring is correct.
  timestamp: 2026-07-13T20:50:00Z

- hypothesis: "deriveAutosaveState state machine is wrong (returns saving/idle for the error inputs)"
  evidence: apps/web/src/features/flows/canvas/__tests__/autosaveState.test.ts — 4/4 pass (ran vitest 2026-07-13). {isPending:false, isError:true, dirty:true} correctly returns "error". The function is correct for the inputs it is given.
  timestamp: 2026-07-13T20:52:00Z

- hypothesis: "The fetch wrapper swallows failures (doesn't throw on non-OK), so the mutation resolves as success"
  evidence: apps/web/src/lib/api.ts:40-42 throws ApiError on !res.ok, and fetch itself rejects on network failure. Wrapper is correct.
  timestamp: 2026-07-13T20:51:00Z

- hypothesis: "A query/mutation retry config keeps the request retrying indefinitely so isError never settles"
  evidence: apps/web/src/lib/queryClient.ts sets retry:1 for queries only; mutations get query-core default retry ?? 0 (node_modules/@tanstack/query-core/src/mutation.ts:199). No indefinite HTTP retry exists.
  timestamp: 2026-07-13T20:52:00Z

## Evidence

- timestamp: 2026-07-13T20:48:00Z
  checked: apps/web/src/features/flows/canvas/useAutosaveDraft.ts
  found: deriveAutosaveState({isPending, isError, dirty}) — isPending wins first ("saving"); error branch requires isPending:false AND isError:true. saveState is computed at line 170 from mutation.isPending/mutation.isError. mutation.isPaused is never read anywhere.
  implication: if the mutation can be pending-but-never-erroring, the toolbar is stuck at «Сохранение…» by construction.

- timestamp: 2026-07-13T20:49:00Z
  checked: apps/web/src/lib/queryClient.ts
  found: QueryClient sets only queries.retry:1 and refetchOnWindowFocus:false. No networkMode override for queries or mutations; useUpdateFlowDraft (apps/web/src/features/flows/api.ts:223-231) sets no networkMode/retry either.
  implication: TanStack Query default networkMode 'online' governs the autosave mutation.

- timestamp: 2026-07-13T20:53:00Z
  checked: node_modules/@tanstack/query-core/src/retryer.ts (v5.101.2)
  found: canFetch (line 53-57) returns onlineManager.isOnline() when networkMode defaults to 'online'. start() (lines 219-227) — `if (canStart()) run() else pause().then(run)`: while offline the mutationFn is NEVER invoked; the retryer sits in pause() until canContinue() (online again, lines 104-107). No rejection ever occurs while paused.
  implication: going offline in devtools means the PATCH promise never rejects — isError can never become true.

- timestamp: 2026-07-13T20:53:30Z
  checked: node_modules/@tanstack/query-core/src/mutation.ts execute() (v5.101.2)
  found: line 206 `const isPaused = !this.#retryer.canStart()`; line 213 dispatches `{type:'pending', variables, isPaused}` → mutation status is 'pending' (isPending:true) with isPaused:true. Line 199: `retry: this.options.retry ?? 0`.
  implication: offline mutate() → isPending:true + isPaused:true + isError:false, indefinitely. deriveAutosaveState receives {isPending:true,...} → "saving" → «Сохранение…» stuck. This is the exact reported symptom.

- timestamp: 2026-07-13T20:54:00Z
  checked: apps/web/src/features/flows/canvas/FlowCanvas.tsx lines 169, 322-329
  found: toolbar Panel renders `saveState === "saving" ? "Сохранение…" : saveState === "error" ? "Не сохранено — повтор…" : "Сохранено"` — correct wiring from useAutosaveDraft.
  implication: rendering is not the problem; the inputs are.

- timestamp: 2026-07-13T20:54:30Z
  checked: apps/web/src/features/flows/canvas/__tests__/autosaveState.test.ts + vitest run
  found: 4/4 tests pass. Tests only cover settled states ({isPending:false, isError:true, dirty:true} etc.). No test models the paused-offline input shape {isPending:true, isPaused:true, isError:false} because isPaused is not even an input to the function.
  implication: reconciles "unit test green, live behavior broken" — the WR-05 fix modeled the wrong failure mode. It fixed the settled-error case (API returns 4xx/5xx while online) but never handled the offline-pause case.

- timestamp: 2026-07-13T20:55:00Z
  checked: secondary path — hook's own 4s retry (useAutosaveDraft.ts:153-168) + "stop the API" variant
  found: with the API stopped but browser online (Vite proxy at vite.config.ts returns 500 on ECONNREFUSED), the first mutate() DOES settle to isError → «Не сохранено — повтор…» shows briefly, then the 4s retry re-fires mutate(), resetting the observer to isPending:true. If the browser is (or goes) offline, that re-fired mutation pauses → stuck «Сохранение…» again. TanStack auto-resumes paused mutations on reconnect, so the PATCH half of the truth may still fire eventually — but the displayed state while disconnected is a dishonest permanent «Сохранение…».
  implication: both UAT repro variants converge on the same root cause: the paused-mutation state (isPaused) is unmodeled in deriveAutosaveState.

reasoning_checkpoint:
  hypothesis: "Offline autosave mutations are paused by TanStack Query's default networkMode 'online' (isPending:true, isPaused:true, isError:false, mutationFn never invoked), and deriveAutosaveState has no isPaused input, so the toolbar shows «Сохранение…» indefinitely instead of the WR-05 error/retrying state"
  confirming_evidence:
    - "query-core v5.101.2 source: retryer.start() pauses without invoking mutationFn when offline (retryer.ts:219-227, canFetch:53-57); mutation.execute dispatches pending+isPaused (mutation.ts:206,213)"
    - "queryClient.ts and useUpdateFlowDraft set no networkMode — default 'online' applies"
    - "useAutosaveDraft.ts:170 feeds only isPending/isError/dirty to deriveAutosaveState; grep confirms isPaused is never read in apps/web"
    - "unit tests pass for settled inputs (4/4), proving the state machine is correct for inputs that never occur while offline — exactly matching 'test green, UAT red'"
  falsification_test: "In devtools offline mode, if React Query devtools showed the mutation in status 'error' (not 'pending/paused') after an edit, this hypothesis would be wrong"
  fix_rationale: "n/a — find_root_cause_only; fix direction handed to plan-phase --gaps"
  blind_spots: "Live browser reproduction not performed (read-only investigation); behavior derived from installed library source, which is deterministic. The stop-API-while-online variant briefly shows the error state before the 4s retry — the user's report ('просто висит Сохранение…') most directly matches the devtools-offline path."

## Resolution

root_cause: "TanStack Query v5's default networkMode 'online' pauses the autosave mutation while the browser is offline: mutate() dispatches status 'pending' with isPaused:true and the PATCH mutationFn is never invoked (query-core retryer.ts:219-227, mutation.ts:206/213), so isError never becomes true. deriveAutosaveState (useAutosaveDraft.ts:74-86) only models isPending/isError/dirty — isPending:true wins and the toolbar renders «Сохранение…» forever. The WR-05 unit tests cover only settled-error inputs that never occur offline, which is why they pass while UAT fails."
fix: ""
verification: ""
files_changed: []

suggested_fix_direction: "Feed mutation.isPaused into the autosave state derivation and map paused+dirty to the honest error/retrying (or an explicit offline) state — e.g. deriveAutosaveState({isPending, isPaused, isError, dirty}) with `if (isPending && isPaused) return 'error'` before the isPending check. Alternative: set networkMode 'always' on useUpdateFlowDraft so the fetch actually fires, fails, and settles to isError, letting the existing 4s bounded retry own reconnection (note: TanStack already auto-resumes paused mutations on reconnect, so with the isPaused approach the auto-retry half likely works as-is). Extend autosaveState.test.ts with the paused input shape."

## Closure Note (milestone v1.0 close)

Resolved at v1.0 milestone close on 2026-07-14: diagnosis was handed to plan-phase --gaps; fix shipped via gap-closure plans (see phase 01/04/05/06 gap plans) or recorded as external-env tech debt in v1.0-MILESTONE-AUDIT.md.
