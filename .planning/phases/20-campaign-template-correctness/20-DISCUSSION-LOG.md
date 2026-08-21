# Phase 20: Campaign Template Correctness - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-21
**Phase:** 20-Campaign Template Correctness
**Areas discussed:** Dirty-state UX & blocking, Staleness token mechanism, Conflict presentation & recovery, Test-send parity

---

## Dirty-state UX & blocking

| Option | Description | Selected |
|--------|-------------|----------|
| Banner + disabled actions | Persistent amber banner near actions + launch/schedule/test-send disabled with inline reason; reuses computeIncompleteReason pattern | ✓ |
| Intercept dialog | Buttons enabled; clicking opens «Save first?» dialog with save-and-continue | |
| Badge on changed field only | «Not saved» marker next to the picker; actions disabled with tooltip | |

**User's choice:** Banner + disabled actions (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Any unsaved field | Template, sender, segment, or name differing from saved row all block | ✓ |
| Send-affecting fields only | Template/sender/segment block; unsaved name doesn't | |
| Template only | Strictly TMPL-01 wording — only template changes block | |

**User's choice:** Any unsaved field (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, save in banner | Banner carries a «Сохранить» button using the builder's save mutation | ✓ |
| No, point to the form | Banner informational only; user scrolls to the builder's save button | |
| Also offer discard | Banner offers both save and discard-changes | |

**User's choice:** Yes, save in banner (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| No nav guard | Block only the three send actions; navigation stays free | ✓ |
| Add router guard too | Warn on navigate-away with unsaved changes (blocker + beforeunload) | |

**User's choice:** No nav guard (Recommended)

---

## Staleness token mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Integer version column | campaigns.version, +1 per update, compared under FOR UPDATE; mismatch → typed conflict | ✓ |
| updated_at precondition | Client echoes updatedAt ISO string; fragile due to timestamp precision/JSON roundtrip | |
| Echo expected templateId | Client sends displayed field values; misses same-field races | |

**User's choice:** Integer version column (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Required in body | expectedVersion required in request schemas; 400 without it | ✓ |
| Optional, check when present | Missing expectedVersion skips the check — permanent bypass | |
| If-Match header | ETag-style precondition header; novel pattern in this codebase | |

**User's choice:** Required in body (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Every campaign mutation | updateCampaign AND status transitions bump version | ✓ |
| Draft edits only | Only updateCampaign bumps | |

**User's choice:** Every campaign mutation (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| 409 + CampaignStateError code | New code "version_conflict", 409 with { error, code, currentVersion } | ✓ |
| 409 with full current row | Conflict embeds the entire current campaign | |
| 412 Precondition Failed | HTTP-semantically precise but off-pattern for this codebase | |

**User's choice:** 409 + CampaignStateError code (Recommended)

---

## Conflict presentation & recovery

| Option | Description | Selected |
|--------|-------------|----------|
| In-dialog error + refresh | Dialog stays open with «Кампания была изменена…», page refetches, human re-confirms | ✓ |
| Toast + close dialog | Dialog closes, error toast, page refetches | |
| Auto-retry with fresh version | Silently refetch and retry the launch | |

**User's choice:** In-dialog error + refresh (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, name the real state | illegal_transition also gets specific copy + refetch, same pattern | ✓ |
| No, version_conflict only | Keep generic copy for illegal_transition | |

**User's choice:** Yes, name the real state (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Server wins, form resets | Builder re-syncs to fresh row; local edits dropped with a notice | ✓ |
| Keep local edits, mark dirty | Local edits survive; dirty banner prompts conscious save-over | |
| You decide | Planner picks based on existing useEffect sync | |

**User's choice:** Server wins, form resets (Recommended)

---

## Test-send parity

| Option | Description | Selected |
|--------|-------------|----------|
| Same precondition | Test-send also requires expectedVersion → 409 on mismatch | ✓ |
| Client-side block only | Test-send stays version-free; dirty banner blocks in UI only | |
| You decide | Planner chooses on route symmetry and test cost | |

**User's choice:** Same precondition (Recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Snapshot at enqueue | Route copies verified templateId (+ resolved fromEmail) into the kind='test' job payload | ✓ |
| Worker re-reads saved row | Test uses whatever is saved at dispatch moment | |
| You decide | Planner weighs payload schema change vs re-read simplicity | |

**User's choice:** Snapshot at enqueue (Recommended)

---

## Claude's Discretion

- State-sharing mechanism for dirtiness between builder and sibling components
- Conflict copy/placement in TestSendPanel (same pattern as dialogs)
- Test harness for SC2's three-path proof, migration mechanics, zod details, exact copy texts
- Launch/schedule payload beyond expectedVersion (no snapshot needed there by construction unless planner finds otherwise)

## Deferred Ideas

None — discussion stayed within phase scope.
