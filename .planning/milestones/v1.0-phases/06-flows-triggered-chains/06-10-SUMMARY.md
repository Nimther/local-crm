---
phase: 06-flows-triggered-chains
plan: 10
subsystem: web
tags: [react, xyflow, canvas, tanstack-query, zod, flows, autosave, shadcn]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains (06-02)
    provides: flowDefinitionSchema/flowNodeSchema/validateFlowDefinition (@mega-crm/flows-core), flow request DTOs (@mega-crm/shared-schemas)
  - phase: 06-flows-triggered-chains (06-04)
    provides: flow lifecycle API (GET/POST /flows, GET/PATCH /flows/:id, publish/pause/resume/duplicate), toFlowResponse shape
provides:
  - "flows API client + TanStack Query hooks: useFlows/useFlow/useCreateFlow/useUpdateFlowDraft/usePublishFlow/usePauseFlow/useResumeFlow/useDuplicateFlow, FlowResponse/FlowListResponse (apps/web/src/features/flows/api.ts)"
  - "Canvas flow builder: FlowCanvas (ReactFlow + Background/Controls/MiniMap/Panel, drag-drop add, labelled Да/Нет branch edges), five custom node types with UI-SPEC icon chips + invalid ring (canvas/nodeTypes.tsx), draggable NodePalette"
  - "NodeConfigPanel: type-switched config sections (trigger/delay/branch/send/exit) + computePublishBlockers (client-side D-17 feedback via the shared validateFlowDefinition)"
  - "useAutosaveDraft: 1s-debounced serialization to flowDefinitionSchema shape + PATCH /flows/:id with Сохранено/Сохранение… save state"
  - "@xyflow/react 12.11.2 (exact pin) + shadcn switch primitive (apps/web/src/components/ui/switch.tsx)"
affects: [06-11]

# Tech tracking
tech-stack:
  added: ["@xyflow/react@12.11.2 (exact pin, legitimacy checkpoint approved)", "@radix-ui/react-switch (via shadcn switch)"]
  patterns:
    - "Canvas node data = { config, invalidMessage } where invalidMessage is INJECTED per render (displayNodes useMemo) from computePublishBlockers + schema-incompleteness — node state itself stays clean, no validation results persisted"
    - "Autosave serializer per-node safeParses through flowNodeSchema and keeps only the valid subset (plus edges between kept nodes) — the server PATCH re-validates via updateFlowDraftSchema, so schema-incomplete nodes (branch without segment, delay without config) stay canvas-local until configured"
    - "Display-name caches (segmentName/templateName) live on node.data.config but are stripped by Zod parse at serialization — never persisted in the definition"

key-files:
  created:
    - apps/web/src/features/flows/api.ts
    - apps/web/src/features/flows/canvas/nodeTypes.tsx
    - apps/web/src/features/flows/canvas/NodePalette.tsx
    - apps/web/src/features/flows/canvas/FlowCanvas.tsx
    - apps/web/src/features/flows/canvas/NodeConfigPanel.tsx
    - apps/web/src/features/flows/canvas/useAutosaveDraft.ts
    - apps/web/src/components/ui/switch.tsx
  modified:
    - apps/web/package.json
    - package-lock.json

key-decisions:
  - "@xyflow/react pinned exactly to 12.11.2 (npm's default ^12.11.2 caret replaced) — the threat model requires a pinned 12.11.x and the repo's dominant convention is exact pins"
  - "apps/web gained an explicit @mega-crm/flows-core dependency (FlowDefinition typing in api.ts + validateFlowDefinition/flowNodeSchema in the canvas) — mirrors 06-04's identical explicit-dep precedent for apps/api"
  - "Send-node config stores fromEmail alongside fromSenderId — the flow dispatcher (06-03 flow-send.ts readFlowSendPrereqs) reads templateId + fromEmail off the node config, so persisting only the sender id would make every flow send fail"
  - "Autosave serializer skips schema-incomplete nodes rather than blocking all saves or sending placeholder values — forced by the server contract (flowDefinitionSchema requires branch.segmentId and delay.delay); incomplete nodes show the destructive ring + «Не настроено» until configured"
  - "Unconfigured trigger (event mode, no eventName) gets a local invalid-ring check in addition to validateFlowDefinition — the D-17 validator deliberately only counts trigger nodes, but the must-have requires unconfigured nodes to surface visually"

patterns-established:
  - "flows/api.ts exports both thin per-endpoint fetch fns (campaigns convention) AND TanStack Query hooks with a flowKeys query-key factory — draft PATCH updates the detail cache via setQueryData (never invalidates) so autosave cannot refetch-clobber mid-edit canvas state"

requirements-completed: [FLOW-01]

coverage:
  - id: D1
    description: "Five node types draggable from a palette onto the canvas, connectable with edges, each configurable in a side panel"
    requirement: "FLOW-01"
    verification:
      - kind: build
        ref: "npm run build -w apps/web (tsc --noEmit + vite) clean; nodeTypes/NodePalette/FlowCanvas/NodeConfigPanel all registered and wired"
        status: pass
      - kind: human
        ref: "Interactive drag-drop/connect/configure — deferred to phase UAT (canvas is not yet routed; 06-11 wires /w/{slug}/flows/:id)"
        status: needs-uat
    human_judgment: true
  - id: D2
    description: "Branch node renders exactly two labelled outgoing edges (Да / Нет) bound to sourceHandle yes/no (D-13)"
    requirement: "FLOW-01"
    verification:
      - kind: build
        ref: "LabelledFlowEdge labels by sourceHandleId; BranchNode exposes exactly two source handles id=yes/no; isValidConnection allows one edge per handle"
        status: pass
    human_judgment: false
  - id: D3
    description: "Draft changes autosave via a debounced (1s) mutation with Сохранено/Сохранение… status, no manual save button"
    requirement: "FLOW-01"
    verification:
      - kind: build
        ref: "useAutosaveDraft: 1s trailing debounce + last-saved baseline diff + PATCH /flows/:id; FlowCanvas top-right Panel renders the save state"
        status: pass
    human_judgment: false
  - id: D4
    description: "Publish-invalid/unconfigured nodes render destructive ring + «Не настроено», computed by the SAME validateFlowDefinition the server uses"
    requirement: "FLOW-01"
    verification:
      - kind: build
        ref: "NodeConfigPanel.computePublishBlockers wraps @mega-crm/flows-core validateFlowDefinition; FlowCanvas injects invalidMessage into node data; grep validateFlowDefinition in NodeConfigPanel.tsx passes"
        status: pass
    human_judgment: false

duration: 17min
completed: 2026-07-10
status: complete
---

# Phase 6 Plan 10: Canvas Flow Builder (FLOW-01) Summary

**The @xyflow/react (12.11.2, legitimacy-checkpoint-approved) canvas flow builder: five UI-SPEC node types with icon chips and invalid rings, a draggable palette, Да/Нет-labelled branch edges, a type-switched node-config side panel reusing the campaign template/sender pickers, and a 1s-debounced draft autosave that serializes through the shared flowDefinitionSchema — client validation via the same validateFlowDefinition the server runs, with the server staying the publish authority.**

## Performance

- **Duration:** ~17 min (plus the blocking-human package-legitimacy checkpoint)
- **Started:** 2026-07-10T04:53:52Z
- **Completed:** 2026-07-10T05:11:19Z
- **Tasks:** 3 auto + 1 blocking-human checkpoint (Task 0, approved by user)
- **Files modified:** 9

## Accomplishments

- **Task 0 (checkpoint):** `@xyflow/react` registry legitimacy verified before install — `npm view` confirmed version 12.11.2, `repository.url` = github.com/xyflow/xyflow, healthy dist-tags; user approved. The stale `reactflow` package was never installed (CLAUDE.md prohibition upheld).
- **flows/api.ts:** hand-mirrored `FlowResponse`/`FlowListResponse` (field-for-field from `toFlowResponse`), thin per-endpoint wrappers (campaigns convention), and the full TanStack Query hook set (`useFlows` with `keepPreviousData`, `useFlow`, `useCreateFlow`, `useUpdateFlowDraft`, `usePublishFlow`, `usePauseFlow`, `useResumeFlow`, `useDuplicateFlow`) with a `flowKeys` query-key factory. Draft PATCH updates the detail cache via `setQueryData` — never invalidates — so autosave can't refetch-clobber mid-edit canvas state.
- **nodeTypes.tsx:** five 240px card-styled node components with the exact UI-SPEC icon chips (Zap indigo / Clock amber / GitBranch blue — the one net-new hue, chips only / Mail green / LogOut neutral), header overflow menu (delete/duplicate via `NodeActionsContext`), Russian config summaries (incl. plural-correct delay formatting: «14 дней», «Ждать до 09:00 (пн)»), «Не настроено» placeholder, selected `ring-primary` / invalid `ring-destructive` + red dot + tooltip.
- **NodePalette.tsx + FlowCanvas.tsx:** top-left `Panel` palette with five draggable rows; ReactFlow chrome per UI-SPEC (dot-grid `Background` neutral-200 on neutral-50, `Controls` bottom-left, `MiniMap` bottom-right, `snapGrid [16,16]`); custom smoothstep edge, 2px neutral-300 (indigo-600 selected), inline «Да» (green-600) / «Нет» (neutral-500) labels bound to sourceHandle yes/no (D-13); drop-to-add at cursor position; connection guards (no self-loops, one outgoing edge per source handle); empty draft seeds a single unconfigured trigger node (the UI-SPEC empty state).
- **NodeConfigPanel.tsx:** right-docked panel switching by node type — trigger (event/segment radio + observed-event combobox with free-text fallback and «ещё не встречалось» helper, or segment picker), delay (D-11 radio: fixed amount+unit OR wait-until native time input + day-of-week select + timezone caption), branch (segment command+popover picker), send (campaign `TemplatePicker`/`SenderPicker` reused verbatim, D-16), exit (no config). Exports `computePublishBlockers` = `validateFlowDefinition` + UI-SPEC Russian copy map.
- **useAutosaveDraft.ts:** serializes nodes/edges into the `flowDefinitionSchema` shape (per-node `flowNodeSchema.safeParse`, T-06-10-02), 1s trailing debounce against a mount-time baseline, PATCHes `/flows/:id`, exposes `'idle' | 'saving'` rendered as «Сохранено»/«Сохранение…» in the canvas toolbar — no manual save button, no toasts.

## Task Commits

Each task was committed atomically:

1. **Task 0: Package-legitimacy gate (blocking-human)** — no commit (verification only; approved by user)
2. **Task 1: Install @xyflow/react + shadcn switch; scaffold flows API client** — `f7bf4b4` (feat)
3. **Task 2: Custom node types + palette + edges + canvas chrome** — `2f6dc8f` (feat)
4. **Task 3: Node-config side panel + debounced draft autosave** — `732be59` (feat)

## Files Created/Modified

- `apps/web/src/features/flows/api.ts` — FlowResponse/FlowListResponse + fetch wrappers + TanStack Query hooks + flowKeys factory
- `apps/web/src/features/flows/canvas/nodeTypes.tsx` — five custom node components, NODE_TYPE_META chips, NodeActionsContext, formatDelaySummary
- `apps/web/src/features/flows/canvas/NodePalette.tsx` — draggable five-row palette Panel, PALETTE_DND_MIME
- `apps/web/src/features/flows/canvas/FlowCanvas.tsx` — ReactFlow wiring, LabelledFlowEdge, definitionToCanvas, invalid-ring injection, toolbar (save state + blocker list), panel docking
- `apps/web/src/features/flows/canvas/NodeConfigPanel.tsx` — type-switched config sections, computePublishBlockers, PUBLISH_BLOCKER_MESSAGES, INCOMPLETE_NODE_MESSAGES
- `apps/web/src/features/flows/canvas/useAutosaveDraft.ts` — serializeCanvas + debounced autosave hook
- `apps/web/src/components/ui/switch.tsx` — shadcn switch (for 06-11's quiet-hours toggle)
- `apps/web/package.json` — @xyflow/react 12.11.2 (exact), @radix-ui/react-switch, @mega-crm/flows-core
- `package-lock.json` — lockfile entries

## Decisions Made

- `@xyflow/react` pinned exactly to `12.11.2` (replaced npm's default caret) per the threat model's "pinned 12.11.x" and the repo's exact-pin convention.
- `apps/web` added `@mega-crm/flows-core` as an explicit dependency (canvas imports `validateFlowDefinition`/`flowNodeSchema`/types) — same precedent as 06-04 adding it to `apps/api`.
- Send-node config persists `fromEmail` alongside `fromSenderId`: the flow dispatcher (`flow-send.ts` `readFlowSendPrereqs`, 06-03) dispatches from `node.templateId + node.fromEmail`, so id-only persistence would break every flow send.
- Autosave serializer keeps only the schema-valid node subset (branch without a segment / delay without a config stay canvas-local until configured) — the server's `updateFlowDraftSchema` re-validates the definition and would 400 otherwise; placeholder values (e.g. a fake segment uuid) were rejected as dangerous.
- Unconfigured trigger gets a local invalid-ring check on top of `validateFlowDefinition` (the D-17 validator deliberately only counts trigger nodes; the must-have requires unconfigured nodes to surface visually).
- «Сохранить узел» button confirms-and-deselects: config changes apply to the canvas live (autosave persists them), matching the UI-SPEC parenthetical "applies the node's config to the draft; still autosaves".

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] apps/web needed an explicit `@mega-crm/flows-core` dependency**
- **Found during:** Task 1
- **Issue:** `flows/api.ts` types `definition: FlowDefinition` and Task 3 imports `validateFlowDefinition`/`flowNodeSchema` — but `apps/web/package.json` had no `@mega-crm/flows-core` entry (would only resolve via unreliable workspace hoisting).
- **Fix:** Added `"@mega-crm/flows-core": "0.1.0"` to `apps/web` dependencies (06-04 set the identical precedent for `apps/api`).
- **Files modified:** `apps/web/package.json`, `package-lock.json`
- **Verification:** `npm run build -w apps/web` clean.
- **Committed in:** `f7bf4b4` (Task 1 commit)

**2. [Rule 2 - Missing Critical] Send-node config captures `fromEmail`, not just `fromSenderId`**
- **Found during:** Task 3 (reading `flow-send.ts` before building the send section)
- **Issue:** The plan's send-node config mirrored the campaign picker pattern (template + sender id), but the already-shipped flow dispatcher (06-03) throws when a send node lacks `templateId`/`fromEmail` — persisting only the sender id would make every published flow's sends fail at dispatch time.
- **Fix:** `SendConfigSection` resolves the picked sender's `fromEmail` from the (cache-shared) senders query and stores it in the node config; `flowSendNodeSchema` already accepts the field.
- **Files modified:** `apps/web/src/features/flows/canvas/NodeConfigPanel.tsx`
- **Verification:** build clean; `empty_send` validation passes once template+sender picked (validator requires templateId AND (fromSenderId OR fromEmail)).
- **Committed in:** `732be59` (Task 3 commit)

## Known Stubs

- **`FlowCanvas` is not yet routed** — no `<Route path="flows/:id">` exists in `App.tsx` (deliberately out of this plan's `files_modified` scope; 06-11 wires the flows list/detail routes and the publish dialog). The component is route-ready: it reads `useParams` itself and loads via `useFlow`.
- **Delay wait-until timezone caption is static copy** («…иначе — по часовому поясу воркспейса») rather than interpolating the actual workspace default zone — the workspace-settings timezone fields ship in 06-11's send-settings extension; interpolation can be added there.

## Issues Encountered

- One TypeScript strictness round: `Array.prototype.concat` rejected `CanvasNode` (optional `selected`) against the spread-widened element type — replaced with array-literal spreads. No runtime issues; build, typecheck, and the existing web test suite (18/18) all pass.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- 06-11 can wire `/w/{slug}/flows` + `/w/{slug}/flows/:id` routes directly to `FlowCanvas` and the `useFlows`/`usePublishFlow` hooks; the publish dialog can render server-returned 422 `{fields}` blockers with the same `PUBLISH_BLOCKER_MESSAGES` copy map.
- The shadcn `switch` primitive is installed for 06-11's per-flow quiet-hours override toggle (D-09).
- `serializeCanvas`/`definitionToCanvas` are exported for reuse (e.g. publish-time definition reads).

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED

All 8 created files verified present on disk (api.ts, nodeTypes.tsx, NodePalette.tsx, FlowCanvas.tsx, NodeConfigPanel.tsx, useAutosaveDraft.ts, switch.tsx, this SUMMARY); all 3 task commit hashes (f7bf4b4, 2f6dc8f, 732be59) verified present in git log.
