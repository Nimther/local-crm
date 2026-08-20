# Phase 19: Unsubscribe Secret Graceful Rotation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-20
**Phase:** 19-Unsubscribe Secret Graceful Rotation
**Areas discussed:** Secret supply format, Verification strategy, Retention window, Rotation procedure

---

## Secret supply format

| Option | Description | Selected |
|--------|-------------|----------|
| Keep var + add _PREVIOUS | `UNSUBSCRIBE_TOKEN_SECRET` stays primary; new `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` comma-separated ordered list of retired secrets, verification only. Zero migration. | ✓ |
| One ordered-list var | Redefine existing var as a list (first signs, rest verify); requires coordinated updates across 3 validation sites and all deploy/test configs. | |
| Structured JSON with ids/dates | JSON entries {id, secret, retiredAt}; richest metadata, heaviest operator error surface. | |

**User's choice:** Keep var + add _PREVIOUS (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Full parity | Optional var; when present: entries ≥ 32 chars, non-empty, no duplicates; enforced in all 3 validation sites + redaction rule. | ✓ |
| Lenient | Only non-empty checked; malformed entries silently skipped. | |
| You decide | Claude picks during planning. | |

**User's choice:** Full parity (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Constrain charset | Reject secrets containing comma or whitespace; documented operator contract. | ✓ |
| Different delimiter | Rarer delimiter (space/semicolon); same problem class. | |
| You decide | Claude picks delimiter and charset rule. | |

**User's choice:** Constrain charset (recommended)

---

## Verification strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Try-all loop, format unchanged | Primary first, then each previous secret in order, timing-safe per candidate; no kid. | ✓ |
| Add key id to new tokens | New tokens embed a kid; legacy tokens fall back to loop; two formats in flight for marginal CPU win. | |

**User's choice:** Try-all loop, format unchanged (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Log which slot matched | Structured log of matched secret's list position (never the secret) on previous-secret verification; response stays byte-identical. | ✓ |
| No observability | Retention governed purely by documented window. | |
| You decide | Claude picks during planning. | |

**User's choice:** Log which slot matched (recommended)

---

## Retention window

| Option | Description | Selected |
|--------|-------------|----------|
| 5y after last use as primary | Retain until 5 years after the secret stopped signing — only window that provably breaks zero links. | ✓ |
| Shorter pragmatic window | 1-2 years; accepts old links dying early — contradicts the phase goal. | |
| Indefinite until manually dropped | Operator prunes at will — SC4 forbids an unbounded list. | |

**User's choice:** 5y after last use as primary (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Docs + soft code bound | SPECIFICATION.md §3 + runbook rotation log; code enforces a max list length (~5) at boot. | ✓ |
| Docs only | Purely procedural; nothing in code demonstrates "not unbounded". | |
| Dates in config, code-enforced | Retirement dates in JSON config, boot-enforced — reopens the supply-format decision. | |

**User's choice:** Docs + soft code bound (recommended)

---

## Rotation procedure

| Option | Description | Selected |
|--------|-------------|----------|
| Runbook two-step | Add-as-previous everywhere + restart, then promote to primary + restart; zero-window by construction. | ✓ |
| Single-deploy, accept the window | One env change + restart; seconds-to-minutes window documented as accepted limitation. | |
| You decide | Claude weighs deploy tooling during planning. | |

**User's choice:** Runbook two-step (recommended)

| Option | Description | Selected |
|--------|-------------|----------|
| Canary smoke both eras | Redeem fresh post-rotation link AND kept pre-rotation link via standing canary workspace. | ✓ |
| New-link check only | Verify only fresh mail; old-link coverage left to test suite. | |
| You decide | Claude decides verification depth. | |

**User's choice:** Canary smoke both eras (recommended)

---

## Claude's Discretion

- Loop mechanics (early-exit vs exhaustive), candidate-set read strategy (lazy env vs parse-once), exact max-list-length constant, log field naming, runbook file naming, test config wiring, error message texts.

## Deferred Ideas

None — discussion stayed within phase scope.
