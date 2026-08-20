# Phase 19: Unsubscribe Secret Graceful Rotation - Research

**Researched:** 2026-08-20
**Domain:** HMAC signing-key rotation for a per-message, self-verifying token (internal codebase change, no new external dependencies)
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Secret supply format**
- D-01: `UNSUBSCRIBE_TOKEN_SECRET` keeps its exact current meaning — the single primary (signing) secret. A NEW optional env var `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` holds a comma-separated, ordered list of retired secrets used for verification only. Absent var = empty list = the normal pre-rotation state. Zero migration: every existing deploy env file, test config, and check-env entry stays valid as-is.
- D-02: Full validation parity for the new var at boot: when present, every entry ≥ 32 chars, no empty entries, no duplicates (of each other or of the primary). Enforced at all three existing validation sites — `apps/api/src/env.ts` (zod), `apps/worker/src/server.ts` (boot check), `scripts/check-env.mjs` (dev presence check follows its existing optional-var conventions). A redaction rule for the new var goes into `packages/redaction` so it can never leak into logs/Sentry.
- D-03: Charset contract: validation rejects any secret (primary or previous) containing a comma or whitespace; documented as part of the operator contract. Keeps comma-separated parsing unambiguous. Secrets are operator-generated random strings, so this costs nothing in practice.

**Verification strategy**
- D-04: Try-all loop, token format UNCHANGED: `verifyUnsubscribeToken` tries the primary first, then each previous secret in list order, with a timing-safe comparison per candidate (SC3's exact wording). No key id (kid) is added to tokens — already-sent tokens have no kid and live until ~2031, so the fallback loop must exist regardless; a kid would only optimize new tokens at the cost of a second token format. — Reversibility: reversible — a kid could be added to newly signed tokens later without breaking the loop.
- D-05: Observability for retirement decisions: on successful verification via a previous (non-primary) secret, emit a structured Pino log line recording the matched secret's list position — NEVER the secret value itself. Server-side only; the HTTP response stays byte-identical (no oracle). This is the operator's only evidence for whether old-secret links still arrive.

**Retention window (the roadmap's named Key Decision)**
- D-06: A previous secret is retained until 5 years after its last use as primary — i.e., until the TTL of the last token it ever signed has elapsed. This is the only window that provably breaks zero links, which is the phase goal verbatim. Rotations are rare, so the list stays at 1-2 entries in practice. — Reversibility: costly — shortening it later knowingly kills live links; the decision is a published operator commitment recorded in SPECIFICATION.md and the runbook.
- D-07: Recording + enforcement split: the 5-year rule and each secret's retirement date live in documentation — SPECIFICATION.md §3 «Секреты» and the rotation runbook's rotation log. Code enforces one soft structural bound: a maximum previous-list length (~5 entries) rejected at boot, satisfying SC4's "not an unbounded list" without dates-in-env machinery.

**Rotation procedure**
- D-08: Two-step runbook rotation, zero-window by construction: Step 1 — add the new secret to `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` on ALL services and restart (every process can now verify it; nothing signs with it yet). Step 2 — promote it to `UNSUBSCRIBE_TOKEN_SECRET`, move the old primary into `_PREVIOUS`, restart. Lands as a runbook entry (the repo's source-derived runbook-coverage gate applies).
- D-09: The runbook ends with a canary smoke of BOTH link eras via the standing canary workspace: redeem a fresh post-rotation link (proves new primary signs and verifies) AND a pre-rotation link kept from before the swap (proves previous-secret verification on the real path).

### Claude's Discretion
- Loop mechanics (early-exit on match vs. exhaustive evaluation), where the candidate-secret set is read (keep delivery-core's lazy `process.env` reads vs. parse-once), exact max-list-length constant, log field naming, runbook file naming, and test wiring for the new env var in vitest/playwright configs — planner/executor decide within the decisions above.
- Exact zod/check-env error message texts and check-env.mjs treatment of the optional var.

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

## Summary

This phase extends `packages/delivery-core/src/unsubscribe-token.ts`'s single-secret HMAC verify into an ordered multi-secret try-all loop, and threads a new optional env var (`UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS`) through the three existing env-validation sites. Every architectural decision that would normally require research (secret supply format, verification strategy, retention window, rotation procedure) is already locked in `19-CONTEXT.md` (D-01 through D-09) — this is not a "what should we do" phase, it is a "confirm the exact integration points and known pitfalls of what's already decided" phase.

The signing/verification primitive itself (`createHmac`/`timingSafeEqual` from Node's built-in `node:crypto`) is unchanged and requires no new packages — this phase adds zero new npm dependencies. The core engineering risk is not "which library" but "does the try-all loop preserve every invariant the single-secret version already had documented and tested": never-throws degradation, byte-identical response across all failure shapes, and a genuinely timing-safe compare against every candidate the loop evaluates (not just the first).

**Primary recommendation:** Extend `verifyUnsubscribeToken` to iterate `[primary, ...previous]` (in that order, matching D-08's promotion semantics — the current primary and any retired secrets), doing a full `timingSafeEqual` per candidate the loop actually evaluates, returning the parsed payload on first structural+signature match and `null` if none match — preserving the function's existing "never throws" contract exactly. Wire the new var through all three validation sites named in CONTEXT.md's canonical refs, using the SAME `min(32)` per-entry floor as the primary secret (D-02).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Multi-secret HMAC verify (try-all loop) | Shared package (`packages/delivery-core`) | — | Both API (route) and worker (signing) import this package; verification logic must live in the one place both consume, exactly as the single-secret version does today |
| Env var parsing/validation (new `_PREVIOUS` var) | API / Backend (`apps/api/src/env.ts` zod schema) | Worker boot check (`apps/worker/src/server.ts`), dev tooling (`scripts/check-env.mjs`) | Each process independently validates its own env at boot — no shared runtime config service exists in this codebase; the pattern is triplicated by design (SPECIFICATION.md §3.1) |
| Redaction of the new secret var | Shared package (`packages/redaction`) | — | Both api and worker logger pipelines consume the same rule table; a rule added once covers both `pino-redact.ts` (structured fields) and `scrub.ts` (freeform payload backstop) |
| GET/POST unsubscribe route behavior | API / Backend (`apps/api/src/modules/delivery/unsubscribe.routes.ts`) | — | Public HTTP surface; route layer is a pure consumer of `verifyUnsubscribeToken`'s null-or-payload contract and needs NO code change per CONTEXT.md's code_context |
| Token signing at send time | Worker (`apps/worker/src/queues/send-dispatch.ts`, `flows/flow-send.ts`) | — | Signing always uses the single current primary secret; no change to any of the three call sites' signing logic, only to which secret `getSecret()`-equivalent resolves as primary |
| Rotation runbook + operator procedure | Documentation (`docs/runbooks/`) | Operator-executed (two-step env change + restart) | No code path performs rotation automatically (explicitly out of scope per REQUIREMENTS.md "Автоматическая ротация... по расписанию — вне scope"); the runbook IS the rotation mechanism |
| Retention-window enforcement | Documentation (SPECIFICATION.md §3, runbook rotation log) | Code (boot-time max-list-length guard only) | D-07 deliberately splits "the 5-year rule" (documented, not enforced by machinery) from "an unbounded list" (the one thing code enforces) |

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ROT-01 | Оператор может ввести новый primary unsubscribe-secret — новые письма подписываются им, без инвалидации ранее разосланных ссылок | D-01/D-08 rotation procedure + verified signing call sites (3 locations, all read primary secret only); Code Examples section shows the exact `getSecret()`/`getPreviousSecrets()` split |
| ROT-02 | Previous secrets продолжают проверять старые ссылки на обоих путях (GET и RFC 8058 POST) с timing-safe сравнением и byte-identical ответами (no-token-oracle инвариант сохранён) | Verified: GET path never verifies (confirmed unchanged, route needs no edit); POST path's `verifyUnsubscribeToken` call site confirmed to already route all failure shapes through one code path (byte-identical invariant pre-exists and must be preserved, not re-implemented); Common Pitfalls documents the per-candidate timing-safe requirement and the position-based total-loop-time consideration |
</phase_requirements>

## Standard Stack

### Core

No new libraries. This phase is a pure extension of existing, already-adopted primitives.

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:crypto` (built-in) | Node 22.x runtime (repo pinned, verified `node --version` → v26 locally, `engines: >=22` in package.json) | `createHmac`, `timingSafeEqual` | Already the sole primitive in `unsubscribe-token.ts`; no reason to introduce a JWT/JOSE library for a token format that is explicitly staying unchanged (D-04) |
| `zod` | 4.4.3 (verified in `apps/api/package.json`) | `apps/api/src/env.ts` schema — the new `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` var joins this schema | Already the project's single env-validation library; D-02 mandates this exact site |
| `pino` | 10.3.1 (verified in `apps/api/package.json`) | D-05's structured log line for previous-secret-match | Already the project's structured logger (Phase 15 convention); no new transport/sink needed |

### Supporting

Not applicable — no supporting libraries are introduced.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Comma-separated env var (D-01) | JSON array in a single env var, or numbered vars (`_PREVIOUS_1`, `_PREVIOUS_2`, ...) | Both rejected by CONTEXT.md discussion in favor of the comma-list — JSON adds a parse-failure mode at boot for a value operators hand-edit; numbered vars need an unbounded-name enumeration step. Comma-separated matches D-03's charset contract (secrets never contain commas) and needs zero new parsing dependency (`.split(",")`) |
| Try-all verification loop (D-04) | Key ID (`kid`) embedded in new tokens, O(1) lookup | Rejected in D-04 itself: already-issued tokens (in flight for up to 5 years) have no `kid` field, so the fallback loop is mandatory regardless of whether new tokens gain a `kid` — adding one now only optimizes a case that isn't the bottleneck (rotations are rare, list stays 1-2 entries) |

**Installation:**
No install step — zero new packages. Confirm no `package.json` diff is needed for this phase beyond code changes.

**Version verification:** Not applicable (no new packages). Existing pinned versions (`zod@4.4.3`, `pino@10.3.1`) verified directly from `apps/api/package.json`.

## Package Legitimacy Audit

**Not applicable — this phase introduces zero new npm packages.** All primitives used (`node:crypto`, `zod`, `pino`) are Node built-ins or already-installed, already-audited dependencies from prior phases (Phase 18's dependency hygiene gate already covers them going forward).

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
                 SIGNING PATH (unchanged call sites, primary secret only)
  ┌──────────────────────────┐
  │ apps/worker               │
  │  send-dispatch.ts (x2)    │──┐
  │  flows/flow-send.ts       │  │
  └──────────────────────────┘  │
                                 ▼
                    signUnsubscribeToken(payload)
                                 │  reads primary secret ONLY
                                 ▼
                    packages/delivery-core/unsubscribe-token.ts
                                 │
                                 ▼
                 `${base64url(payload)}.${hmac-sha256}` token
                                 │
                                 ▼
                    email List-Unsubscribe link (5-yr exp baked in)


                 VERIFICATION PATH (extended: try-all loop)
  ┌───────────────────────────────────────────┐
  │ mail client / browser                       │
  │  GET  /unsubscribe/:token  (confirm page)    │──▶ NO verification (unchanged)
  │  POST /unsubscribe/:token  (RFC 8058 / form) │
  └───────────────────────────────────────────┘
                                 │ POST only
                                 ▼
                    verifyUnsubscribeToken(token)
                                 │
                                 ▼
              candidates = [primary, ...previous]   (D-04 order)
                                 │
                    ┌────────────┴────────────┐
                    ▼                          ▼
         for each candidate:          all candidates exhausted,
         timingSafeEqual(sig,         no match
         candidateSig)                        │
                    │  match                    ▼
                    ▼                     return null
         if matched candidate !== primary:
           emit Pino log (D-05: position only, never the secret)
                    │
                    ▼
         return parsed payload  (SAME null-or-payload contract as today)
                    │
                    ▼
         route applies unsubscribe (byte-identical response regardless
         of which candidate matched, or none)
```

### Recommended Project Structure

No new directories. All changes land inside existing files:

```
packages/delivery-core/src/
├── unsubscribe-token.ts       # extend getSecret()/verify loop -- the ONLY file where verification logic changes
└── __tests__/
    └── unsubscribe-token.test.ts   # extend with rotation scenarios

apps/api/src/
├── env.ts                     # add UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS to zod schema + superRefine validation
└── __tests__/
    └── env-schema.test.ts     # extend with new var's validation tests

apps/worker/src/
└── server.ts                  # add matching boot check (:218-221 today, per CONTEXT.md canonical refs)

packages/redaction/src/
└── rules.ts                   # add UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS as a keyRule

scripts/
└── check-env.mjs              # optional-var presence-check convention (D-02)

docs/runbooks/
└── unsubscribe-secret-rotation.md   # NEW -- D-08/D-09 procedure + D-06/D-07 retention record

packages/delivery-core/src/
└── logger.ts                  # NEW -- minimal pino logger for D-05's log line, mirrors packages/contacts-core/src/logger.ts (see Pattern 1's "Verified integration gap")
packages/delivery-core/
└── package.json               # add `pino` to dependencies (currently absent -- only @mega-crm/tenant-context + pg)

SPECIFICATION.md                 # §3 «Секреты» -- MUST be updated in the SAME change (hard CLAUDE.md rule + CONTEXT canonical ref): new env var, its validation, and D-06's retention decision. §8 only if anything here diverges from CLAUDE.md's Technology Stack section (unlikely for this phase -- no new library).
```

### Pattern 1: Ordered try-all HMAC verification

**What:** Verification tries an ordered list of candidate secrets `[primary, ...previous]`, running a genuinely timing-safe compare for every candidate the loop evaluates, returning the parsed payload on the first match.

**When to use:** Any HMAC-based token whose issuer rotates signing keys while old, unexpired tokens must remain verifiable — the exact shape of this phase.

**Verified integration gap:** `packages/delivery-core` has NO existing logger today (`grep -rn "pino\|logger" packages/delivery-core/src --include="*.ts"` returns nothing outside `__tests__`). D-05's log line must live INSIDE `verifyUnsubscribeToken` (the route never learns which candidate matched — its contract is unchanged null-or-payload), so this phase must add a net-new minimal logger to `packages/delivery-core`, mirroring the existing precedent in `packages/contacts-core/src/logger.ts`:
```typescript
// packages/contacts-core/src/logger.ts -- the precedent to copy, not invent from scratch
import pino from "pino";
// "Deliberately independent of apps/api/src/logger.ts (which pulls in env.ts
// and KMS/redaction concerns specific to the API app) -- this package is
// imported by BOTH apps/api and apps/worker, so it cannot depend back on
// either app." (verbatim rationale, applies identically to delivery-core.)
export const logger = pino({ level: process.env.NODE_ENV === "test" ? "silent" : "info" });
```
This requires: (1) a new `packages/delivery-core/src/logger.ts`, (2) adding `pino` (pin to the same `10.3.1` already used elsewhere) to `packages/delivery-core/package.json` `dependencies` (it is currently absent — only `@mega-crm/tenant-context` and `pg` are listed). This is a real, net-new task the plan must include, not a one-line addition inside `unsubscribe-token.ts`. Since this minimal logger does not flow through `packages/redaction`'s pino-redact pipeline (same as `contacts-core`'s precedent), D-05's own constraint — log ONLY the integer position, never the secret — is the sole safeguard; there is no redaction backstop for this specific call site, so the log call's shape matters more, not less.

**Example (extends the existing file, preserves the never-throws contract; loop uses EXHAUSTIVE evaluation per Pitfall 2's recommendation — no early `break`, so total loop time depends only on `candidates.length`, never on which candidate matched):**
```typescript
// packages/delivery-core/src/unsubscribe-token.ts
// Source: existing file (Read 2026-08-20) + D-01/D-04 (19-CONTEXT.md)
import { logger } from "./logger.js"; // NEW file, see integration gap above

function getPrimarySecret(): string {
  const secret = process.env.UNSUBSCRIBE_TOKEN_SECRET;
  if (!secret) {
    throw new Error("UNSUBSCRIBE_TOKEN_SECRET is not set");
  }
  return secret;
}

/**
 * D-01: comma-separated, ordered, optional. Absent/empty var -> empty list,
 * the normal pre-rotation state. D-03: entries never contain commas or
 * whitespace, so a plain split is unambiguous.
 */
function getPreviousSecrets(): string[] {
  const raw = process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
  if (!raw) return [];
  return raw.split(",");
}

function signWith(secret: string, encodedPayload: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

// signUnsubscribeToken unchanged -- always signs with getPrimarySecret() only.

export function verifyUnsubscribeToken(token: string): UnsubscribeTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return null;

  let actualSigBuf: Buffer;
  try {
    actualSigBuf = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }

  const candidates = [getPrimarySecret(), ...getPreviousSecrets()];
  let matchedIndex = -1;

  // Exhaustive evaluation (Pitfall 2): deliberately NO early `break` on
  // match. Every candidate gets its timing-safe compare regardless of
  // whether an earlier one already matched, so total loop duration is a
  // function of candidates.length alone (fixed until the next rotation),
  // never of WHICH candidate matched or whether any did. Only the FIRST
  // match is recorded (matchedIndex stays at its first-set value).
  for (let i = 0; i < candidates.length; i++) {
    let expectedSigBuf: Buffer;
    try {
      expectedSigBuf = Buffer.from(signWith(candidates[i], encodedPayload), "base64url");
    } catch {
      continue;
    }
    // Per-candidate timing-safe compare -- SC3's exact wording, no
    // short-circuit that skips this primitive for any candidate evaluated.
    const isMatch =
      expectedSigBuf.length === actualSigBuf.length &&
      timingSafeEqual(expectedSigBuf, actualSigBuf);
    if (isMatch && matchedIndex === -1) {
      matchedIndex = i;
    }
  }

  if (matchedIndex === -1) return null;

  if (matchedIndex > 0) {
    // D-05: position only, never the secret value, server-side only.
    logger.info({ secretPosition: matchedIndex }, "unsubscribe token verified via previous secret");
  }

  // ... existing payload parse/shape-check logic, unchanged ...
}
```

### Pattern 2: Env-validation triple with a new optional, list-shaped var

**What:** The existing api/worker/check-env triple (SPECIFICATION.md §3.1) each independently validate the same contract for a new optional var, exactly mirroring how `KMS_KEK_ID`/`KMS_FILE_KEK_PATH` are conditionally-required optionals today.

**D-03 scope correction — this is not purely additive.** D-03's charset contract applies to "any secret (primary or previous)". `UNSUBSCRIBE_TOKEN_SECRET` today is validated with only `z.string().min(32)` — no comma/whitespace check. Adding rotation therefore requires TIGHTENING the existing primary-secret validation at all three sites too, not just adding rules for the new var. This is a genuine (if narrow) behavior change to existing checks, and it is why D-01's "every existing deploy env file... stays valid as-is" and D-03's charset rule do not actually conflict: D-03 itself notes "secrets are operator-generated random strings, so this costs nothing in practice" — the reconciliation is that a real deployed secret is vanishingly unlikely to already contain a comma or whitespace, so tightening the check is expected to be a no-op against any existing, correctly-generated production value. The planner should still flag this as a deploy-time verification step (confirm the current production `UNSUBSCRIBE_TOKEN_SECRET` passes the new charset check before shipping), not skip it as "just the new var."

One structural note: post-`.split(",")`, a comma embedded INSIDE a previous-secret entry is unobservable — it silently becomes a list boundary, so the min-32/empty-entry checks are what catch a mis-typed entry, not a dedicated comma check on each split fragment. The comma/whitespace rule from D-03 is therefore only directly testable against the PRIMARY secret's raw string (which is never split) and against the raw `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` string as a whole (whitespace within an entry IS observable after splitting on comma only, since whitespace isn't the split delimiter).

**Example (zod, `apps/api/src/env.ts`):**
```typescript
// Source: apps/api/src/env.ts (Read 2026-08-20), extended per D-01/D-02/D-03
UNSUBSCRIBE_TOKEN_SECRET: z
  .string()
  .min(32, "UNSUBSCRIBE_TOKEN_SECRET must be at least 32 characters")
  .refine((v) => !/[,\s]/.test(v), "UNSUBSCRIBE_TOKEN_SECRET must not contain a comma or whitespace (D-03)"),
UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS: z.string().optional(),
// ... inside the existing .superRefine((val, ctx) => { ... }):
if (val.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS) {
  if (/\s/.test(val.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS)) {
    // Catches whitespace WITHIN an entry (commas are the split delimiter,
    // so a stray comma inside an intended single secret is unobservable
    // here -- see the structural note above; the min-32/empty-entry checks
    // below are the practical backstop for a mis-typed entry).
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS entries must not contain whitespace (D-03)", path: ["UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS"] });
  }
  const entries = val.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS.split(",");
  const MAX_PREVIOUS = 5; // D-07: soft structural bound, not a date-based purge
  if (entries.length > MAX_PREVIOUS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS supports at most ${MAX_PREVIOUS} retired secrets`, path: ["UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS"] });
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.length < 32) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "each UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS entry must be at least 32 characters", path: ["UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS"] }); }
    if (entry.length === 0) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS must not contain empty entries", path: ["UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS"] }); }
    if (entry === val.UNSUBSCRIBE_TOKEN_SECRET || seen.has(entry)) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS must not duplicate the primary secret or another entry", path: ["UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS"] }); }
    seen.add(entry);
  }
}
```
The worker's manual check (`apps/worker/src/server.ts:218-221`) and `scripts/check-env.mjs` need the equivalent logic in their respective idioms (throw-on-fail; presence-only warn, per D-02's "check-env.mjs's existing optional-var conventions") — including the same tightened primary-secret charset check, since the worker's boot check currently only enforces `length < 32`.

### Anti-Patterns to Avoid
- **Adding a `kid` to new tokens as a substitute for the fallback loop:** D-04 explicitly rejects this — already-issued tokens have no `kid` and live 5 years, so the loop is unconditionally required; a `kid` optimization is a separate, later, reversible improvement, not a replacement.
- **Branching the HTTP response on which secret matched:** D-05's log line is the ONLY externally-invisible signal allowed to vary; the response (status/body/headers) must stay byte-identical regardless of primary-match, previous-match, or no-match — the existing route code already achieves this by construction (single response-building code path) and must not gain a new branch.
- **Parsing `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` on every request:** delivery-core's existing pattern is lazy per-call `process.env` reads (no module-level caching) — Claude's Discretion permits either lazy-per-call or parse-once, but parse-once introduces a state-management question (when does it re-read after a restart-free rotation, which doesn't exist here since D-08 mandates restarts) that lazy reads avoid entirely; lazy reads are the lower-risk default matching existing code.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Constant-time byte comparison | A custom XOR-accumulator loop | `node:crypto`'s `timingSafeEqual` (already in use) | Node's built-in is the audited, standard primitive; hand-rolling constant-time code is a classic source of compiler-optimization-induced timing leaks (the JIT can still short-circuit a naively-written loop) |
| Comma-separated list parsing with validation | A mini env-var-list parsing library | Plain `.split(",")` + explicit loop validation (per D-01/D-03's simple charset contract) | The charset contract (D-03: no commas/whitespace in secrets) makes this trivially unambiguous; a parsing library is unjustified complexity for one line of logic |
| Retention-date tracking/expiry automation | A scheduled job that purges old secrets after N days | Documentation-only tracking (SPECIFICATION.md + runbook rotation log), enforced only by the max-list-length boot guard | D-07 explicitly rejects "dates-in-env machinery" — automating retirement decisions is out of scope per REQUIREMENTS.md's explicit exclusion ("Автоматическая ротация... — операционное решение позже") |

**Key insight:** Every piece of this phase that could tempt a "build a small system for this" instinct (kid-based lookup, scheduled purge, generic secret-list config format) has already been explicitly rejected by name in CONTEXT.md's decisions, with the reversible/costly tradeoff spelled out. The planner's job is to implement the loop, not redesign around it.

## Common Pitfalls

### Pitfall 1: Per-candidate compare that isn't actually timing-safe end-to-end
**What goes wrong:** A loop that does `if (candidateSig === actualSig)` (string/Buffer `===`) for a cheap pre-filter before falling back to `timingSafeEqual`, or that string-compares signature lengths before the timing-safe call in a way that leaks length info differently per candidate.
**Why it happens:** Developers optimize "let's skip the expensive constant-time compare when it obviously won't match" — but "obviously" is exactly the leak.
**How to avoid:** Every candidate the loop evaluates must go straight to `timingSafeEqual` (with an equal-length guard that itself doesn't leak new information beyond what the existing single-secret code already does — the existing code already guards `expectedSigBuf.length !== actualSigBuf.length` before calling `timingSafeEqual`, which is fine to keep per-candidate since signature length is fixed by the HMAC algorithm and doesn't vary by secret).
**Warning signs:** Any `===`/`.equals()` on signature bytes anywhere in the loop; any early return before the per-candidate `timingSafeEqual` call based on candidate content.

### Pitfall 2: Position-based total-loop-time signal (early-exit vs exhaustive evaluation)
**What goes wrong:** With early-exit-on-match (the natural loop shape), a token signed by the primary secret returns after 1 compare; a token signed by the 2nd previous secret returns after 3 compares; a forged token (no match) always evaluates ALL candidates. This means total wall-clock time correlates with "how far down the candidate list the match was" — a signal that per-candidate `timingSafeEqual` alone does not eliminate, because it operates on individual comparisons, not on how many comparisons the loop performs.
**Why it happens:** D-04's requirement ("timing-safe comparison per candidate secret") is about the compare PRIMITIVE, not about loop iteration count — and CONTEXT.md explicitly leaves early-exit-vs-exhaustive as Claude's Discretion.
**How to avoid:** Given the low cost (list stays 1-2 entries per D-06, so exhaustive evaluation costs at most ~2 extra HMAC computations per verify call — negligible even at hundreds-of-thousands-of-sends/day POST volume, since verification only happens per-unsubscribe-click, not per-send), recommend **exhaustive evaluation** (always loop through every candidate, track the first match, return after the full loop) as the safer default. This makes total loop time depend only on `candidates.length` (a boot-time-fixed constant across the whole rotation window), not on which candidate matched or whether any matched at all — fully closing the position-based side channel with no measurable performance cost. This is a recommendation for the planner to make an explicit choice on, not a re-litigation of CONTEXT.md's discretion grant.
**Warning signs:** A load test or code review showing average POST response time differs measurably between primary-secret-signed and previous-secret-signed tokens.

### Pitfall 3: Weakening the existing byte-identical-response invariant while adding new logic
**What goes wrong:** Adding the D-05 log line, or any new code path for the rotation feature, accidentally introduces a new branch that reaches the response-building code differently for primary-match vs previous-match vs no-match (e.g., an `await` ordering change that makes one path measurably slower at the HTTP-response layer, or a conditional that changes response headers).
**Why it happens:** The route file (`unsubscribe.routes.ts`) has extensive inline threat-model documentation (T-04-03-01/02, CR-01) precisely because this invariant has been hard-won across multiple prior phases; new code near it is high-risk-of-regression by proximity even when the route itself needs no edit per CONTEXT.md.
**How to avoid:** Confirm (and write a test asserting) that `unsubscribe.routes.ts` requires ZERO changes — all rotation logic lives inside `verifyUnsubscribeToken`'s existing null-or-payload contract, which the route already consumes without modification. If the plan proposes any edit to the route file, that is a signal the design has leaked verification-specific logic into the wrong tier.
**Warning signs:** A diff touching `unsubscribe.routes.ts` for this phase; a log call anywhere in the request-handling code that isn't clearly server-side-only (e.g., accidentally included in a response object).

### Pitfall 4: Boot-check drift across the three validation sites
**What goes wrong:** The zod schema, the worker's manual check, and check-env.mjs enforce three independently-hand-written versions of "min 32 chars, no duplicates, no commas/whitespace, max 5 entries" — and one of the three drifts (e.g., the max-list-length constant is 5 in zod but forgotten in the worker check, or check-env.mjs treats a malformed value as valid because it's presence-only per its stated convention).
**Why it happens:** This is a documented, pre-existing pattern in this codebase (SPECIFICATION.md §3.1 explicitly notes the worker "has no full schema of its own — only three manual checks") — triplication is the accepted tradeoff, but only if all three are updated together.
**How to avoid:** Treat "wire the new var through all three sites" as one task with three sub-steps verified together, not three independently-plannable tasks that could land in different waves. Add or extend a negative test (mirroring `env-schema.test.ts`'s existing pattern of asserting exact behavior) for at least the zod site; the worker/check-env sites are typically covered by boot-smoke rather than unit tests in this codebase (confirm actual test coverage convention when planning Wave 0).
**Warning signs:** A `git diff` for this phase that touches `apps/api/src/env.ts` but not `apps/worker/src/server.ts` or `scripts/check-env.mjs` (or vice versa).

### Pitfall 5: Runbook-coverage gate does not automatically pick up this runbook
**What goes wrong:** CONTEXT.md's D-08 states "the repo's source-derived runbook-coverage gate applies" — but `scripts/check-runbook-coverage.mjs` (verified by reading its source) is narrowly scoped: it enumerates `export const *_ALERT_NAME` string-literal constants from `apps/api/src/modules/ops/*.ts` and asserts a matching `docs/runbooks/{alertName}-alert.md` exists. This mechanism has NO knowledge of, and will NOT be triggered by, a rotation runbook — there is no `*_ALERT_NAME` constant for secret rotation, and it isn't an ops-alert. Planning a task that expects `npm run check:runbook-coverage` to fail/pass based on the rotation runbook's presence will be planning around a gate that structurally cannot see it.
**Why it happens:** The gate's own source comments explicitly warn about this: "`docs/runbooks/log-shipping-and-backstop-alerts.md`... and `docs/runbooks/bull-board-access.md`... are NOT enumerated here... A future reader should not 'fix' this gate to also require those two — they are real, required runbooks, just not ones this specific enumeration mechanism can discover automatically." The rotation runbook is in the same category as those two.
**How to avoid:** Treat the rotation runbook as following the ESTABLISHED CONVENTION (opening line citing the requirement + decision IDs and CONTEXT.md path, e.g. `docs/runbooks/backups.md`'s exact opening pattern: "Implements requirement **X-YY** and decisions **D-NN**... (`.planning/phases/.../XX-CONTEXT.md`)"), not as something the automated gate will verify. If the plan includes a verification step referencing `check:runbook-coverage`, correct it — this phase's runbook verification is manual/review-based, matching how `backups.md`, `restore-drill.md`, `migration-rollback-and-roll-forward.md`, and `data-retention.md` are verified (none of those are covered by the alert-name gate either).
**Warning signs:** A plan task that says "runbook passes `npm run check:runbook-coverage`" as its verification criterion for the rotation runbook specifically.

## Code Examples

Verified patterns from the existing codebase (2026-08-20 read):

### Existing verify contract (must be preserved exactly)
```typescript
// Source: packages/delivery-core/src/unsubscribe-token.ts (current, pre-rotation)
// verifyUnsubscribeToken returns UnsubscribeTokenPayload | null, NEVER throws.
// The route (unsubscribe.routes.ts) relies on this: any failure shape --
// bad base64, wrong part count, JSON parse error, signature mismatch --
// collapses to the same `null`, which the route treats identically to an
// unknown-contact case. This contract is what makes the byte-identical
// response possible without the route needing to distinguish failure types.
```

### Existing test fixture pattern (extend, don't replace)
```typescript
// Source: packages/delivery-core/src/__tests__/unsubscribe-token.test.ts
beforeAll(() => {
  process.env.UNSUBSCRIBE_TOKEN_SECRET = "test-only-secret-at-least-32-bytes-long-000";
  process.env.PUBLIC_APP_URL = "https://api.example.com";
});
// Rotation tests add: process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = "old-secret-at-least-32-bytes-long-0000000,older-secret-at-least-32-bytes-0000000";
// then: sign with what WAS primary, THEN swap UNSUBSCRIBE_TOKEN_SECRET to a new value
// and move the old primary into _PREVIOUS, THEN assert the old token still verifies --
// this exactly mirrors D-08's two-step rotation, proven at the unit level.
```

### Env test wiring locations (verified, corrects CONTEXT.md's canonical refs)
```
apps/api/vitest.config.ts:62-63        -- hardcodes UNSUBSCRIBE_TOKEN_SECRET
apps/worker/vitest.base.config.ts:145-146  -- hardcodes UNSUBSCRIBE_TOKEN_SECRET
                                            (NOT apps/worker/vitest.config.ts --
                                             that file only imports workerTestBase
                                             from vitest.base.config.ts; the env
                                             block lives in the base file, shared
                                             with vitest.loadtest.config.ts too)
apps/web/playwright.config.ts:110      -- hardcodes UNSUBSCRIBE_TOKEN_SECRET
```
All three need a `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` entry ONLY if a specific test scenario requires a non-empty previous-list in that environment; since D-01 makes the var's absence the normal/valid state, most of these three files may need NO change at all -- only the tests that specifically exercise rotation need to set the var (likely inline in the test file itself via `process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = ...` in a `beforeAll`/`afterAll` pair that restores state, matching the existing `unsubscribe-token.test.ts` pattern).

## State of the Art

Not applicable in the conventional sense (no library/framework version drift to track) — but one relevant point:

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Single static `UNSUBSCRIBE_TOKEN_SECRET`, no rotation path | Primary + ordered previous-secrets list, try-all verify | This phase (19) | Enables ROT-01/ROT-02 without any token-format change; purely additive to the existing HMAC scheme |

**Deprecated/outdated:** Nothing in this phase deprecates prior work — `signUnsubscribeToken`'s signature, the token wire format (`${base64url}.${signature}`), and the 5-year TTL constant are all explicitly unchanged (D-04, phase boundary "the 5-year token TTL itself unchanged").

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | "Standard HMAC key rotation try-all pattern" and "constant-time comparison per candidate" reflect general industry practice (websearch, LOW confidence per classify-confidence — no MCP doc providers configured in this project) | Common Pitfalls, Code Examples | Low — these are widely-known, uncontroversial cryptographic engineering practices (constant-time comparison for secret material is textbook), and the actual design (D-04) was independently locked by the user in CONTEXT.md before this research ran, so this research corroborates rather than originates the approach |
| A2 | RFC 8058's POST-body/response-shape requirements as summarized in the RFC 8058 websearch digest | Architecture Patterns (confirmation only) | None — the existing route already implements this and is explicitly unchanged by this phase; this claim is not load-bearing for any new work |

**If this table is empty:** N/A — two low-risk, non-load-bearing corroborating claims are listed above; every decision that actually drives implementation (secret format, verification order, retention window, rotation procedure) is a locked CONTEXT.md decision, not a research assumption.

## Open Questions

1. **Does the worker's manual boot check need the SAME max-list-length constant (5) hard-coded independently, or should it import a shared constant from `packages/delivery-core`?**
   - What we know: The zod schema and worker check are independently hand-written today (SPECIFICATION.md §3.1 confirms this triplication pattern is accepted/existing), and CONTEXT.md leaves "exact max-list-length constant" as Claude's Discretion.
   - What's unclear: Whether introducing a shared exported constant (e.g., `MAX_PREVIOUS_SECRETS` from `packages/delivery-core`) is worth the cross-package import for a single integer, or whether independently hard-coding `5` in both places (as the existing pattern does for e.g. the `min(32)` floor) is more consistent with the codebase's established convention.
   - Recommendation: Follow the established triplication convention (hard-code independently) unless the planner has a specific reason to centralize — the codebase's own documented reasoning for triplication (each process validates its own env autonomously, no shared runtime config service) applies equally to this constant.

2. **Should `check-env.mjs` validate the new var's format at all, or purely check presence when set?**
   - What we know: D-02 says check-env.mjs follows "its existing optional-var conventions." Reading its source, ALL of its current checks are presence-only (it delegates format validation to `apps/api/src/env.ts`'s zod schema entirely) — e.g., `OPERATOR_ALERT_EMAIL`'s email-format validation happens only in zod, not in check-env.mjs.
   - What's unclear: Whether "presence-only" even applies here, since `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` is OPTIONAL — there's nothing to "require the presence of." The var may need NO entry in check-env.mjs's `required` list at all, only a comment explaining why it's absent (mirroring how `SIGKILL_HARNESS_JOB_DATA` or other optional vars are handled, if any precedent exists).
   - Recommendation: Planner should verify whether check-env.mjs has any precedent for "optional, format-validated-elsewhere, no presence check needed" vars, and if none exists, treat this as the first one — documenting the absence explicitly (matching this script's own commenting convention of explaining every inclusion/exclusion decision).

## Environment Availability

Skipped — this phase has no new external tool/service/runtime dependencies. All work happens inside the existing Node/TypeScript codebase using already-installed packages (`node:crypto`, `zod`, `pino`) and already-provisioned dev environment (verified: Node v26 running locally, satisfies `engines: >=22`).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (repo-wide standard; `packages/delivery-core` and `apps/api` both use it) |
| Config file | `packages/delivery-core/vitest.config.ts` (unit tests for the token module); `apps/api/vitest.config.ts` + `apps/api/vitest.config.ts`'s env block (env-schema tests); `apps/worker/vitest.base.config.ts` (worker boot-check tests, if any exist today — verify at plan time) |
| Quick run command | `npm run test -w packages/delivery-core -- unsubscribe-token` |
| Full suite command | `npm run coverage` (root aggregate, per SPECIFICATION.md's project-wide convention) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ROT-01 | New primary secret signs new tokens; previously-mailed (old-primary-signed) tokens still verify after rotation | unit | `npm run test -w packages/delivery-core -- unsubscribe-token` | ✅ (extend `packages/delivery-core/src/__tests__/unsubscribe-token.test.ts`) |
| ROT-02 | Previous secret verifies on BOTH GET (no-op, confirm page unaffected) and POST paths; forged/expired token produces byte-identical response | unit + integration | `npm run test -w packages/delivery-core -- unsubscribe-token` (unit) + `npm run test -w apps/api -- unsubscribe` (route-level, if an existing route test file covers T-04-03-0x — verify at plan time) | ✅ unit / ⚠️ confirm route-level test file exists — grep `apps/api/src/modules/delivery/__tests__/` at plan time |
| D-02 | New var's zod validation (length/dup/charset/max-count) | unit | `npm run test -w apps/api -- env-schema` | ✅ (extend `apps/api/src/__tests__/env-schema.test.ts`) |
| D-05 | Previous-secret-match log line fires with position, never the secret | unit | `npm run test -w packages/delivery-core -- unsubscribe-token` (spy/mock logger) | ❌ Wave 0 — needs a logger-spy test added |

### Sampling Rate
- **Per task commit:** `npm run test -w packages/delivery-core -- unsubscribe-token` and `npm run test -w apps/api -- env-schema` (fast, targeted)
- **Per wave merge:** `npm run coverage` (full aggregate, catches worker-side boot-check regressions and route-level integration)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] Confirm whether `apps/api/src/modules/delivery/__tests__/unsubscribe.routes.test.ts` (or equivalent) exists — the route file's extensive T-04-03-0x inline documentation strongly implies dedicated tests exist; locate and extend them with a previous-secret-signed-token scenario rather than assuming route-level coverage is unit-test-only. The added scenario must assert byte-identical responses across BOTH POST entry shapes per SC2's literal wording — the browser confirm-form submit (`Accept: text/html`) and the RFC 8058 one-click `application/x-www-form-urlencoded` POST — not just one of the two.
- [ ] Confirm whether `apps/worker/src/server.ts`'s manual boot checks have ANY existing test coverage (unlike the zod schema, this is imperative code inside `buildWorker()` — grep `apps/worker/src/__tests__/` for a boot-check/server test file before assuming this needs net-new test infrastructure).
- [ ] Add the D-05 logger-spy test (no existing precedent found for asserting on a specific Pino log call in `unsubscribe-token.test.ts` — this is new test surface, not an extension).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | This token is a scoped-capability bearer token (unsubscribe-this-send), not an authentication credential |
| V3 Session Management | No | Stateless, self-verifying token; no session store involved |
| V4 Access Control | Marginal | The token itself IS the access-control mechanism (possession = authorization to unsubscribe that specific send/contact); rotation must not weaken this — verified: multi-secret verify still requires possession of a validly-signed token, no new bypass introduced |
| V5 Input Validation | Yes | The new env var's format (D-02/D-03: length floor, no commas/whitespace, no duplicates, max count) IS input validation, enforced via the existing zod pattern |
| V6 Cryptography | Yes | HMAC-SHA256 signing/verification (unchanged primitive, `node:crypto`); the rotation logic must not introduce a weaker comparison (Pitfall 1) or a new timing side-channel (Pitfall 2) — never hand-roll constant-time comparison |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Timing oracle via per-byte comparison of a secret-derived value | Information Disclosure | `timingSafeEqual` per candidate (already in place; D-04 explicitly requires this survive rotation) |
| Timing oracle via total request time correlating with candidate-list position | Information Disclosure | Exhaustive loop evaluation recommended (Pitfall 2) — closes a signal that per-candidate compare alone does not |
| Response-shape divergence between "forged token" and "valid but retired-contact token" | Information Disclosure (no-token-oracle) | Byte-identical response invariant (T-04-03-01/02, pre-existing, must not regress — Pitfall 3) |
| Secret leakage into logs when adding new observability (D-05) | Information Disclosure | `packages/redaction` rule for `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS`; log ONLY the matched position (an integer), never any secret material — verified this is exactly D-05's stated design |
| Env var injection / malformed list causing a crash-loop instead of a clean boot failure | Denial of Service (self-inflicted, operator error) | Zod validation with clear error messages (existing pattern: `env.ts`'s `safeParse` + formatted issue list) fails loud at boot rather than crashing mid-request |

## Sources

### Primary (HIGH confidence)
- Direct codebase reads (2026-08-20): `packages/delivery-core/src/unsubscribe-token.ts`, `apps/api/src/modules/delivery/unsubscribe.routes.ts`, `apps/api/src/env.ts`, `apps/worker/src/server.ts` (lines 190-240), `packages/redaction/src/rules.ts`, `scripts/check-env.mjs`, `apps/worker/src/queues/send-dispatch.ts` (signing call sites), `apps/worker/src/queues/flows/flow-send.ts`, `packages/delivery-core/src/__tests__/unsubscribe-token.test.ts`, `apps/api/src/__tests__/env-schema.test.ts`, `SPECIFICATION.md` §3, `docs/runbooks/backups.md`, `scripts/check-runbook-coverage.mjs`, `apps/worker/vitest.config.ts` / `vitest.base.config.ts`, `apps/web/playwright.config.ts`, `.planning/config.json`
- `apps/api/package.json` (verified `zod@4.4.3`, `pino@10.3.1` exact pinned versions)

### Secondary (MEDIUM confidence)
- None used at MEDIUM tier this session — all codebase claims verified HIGH via direct read; external claims classified LOW per `classify-confidence --provider websearch` (no MCP doc providers configured in `.planning/config.json`)

### Tertiary (LOW confidence)
- WebSearch: "HMAC signing key rotation with a list of previous keys for verification (try-all pattern)" — general industry corroboration only, not load-bearing (the design is independently locked by CONTEXT.md)
- WebSearch: "Timing-safe comparison pitfalls when checking a token against multiple candidate secrets" — informed Pitfall 1/2's framing, not load-bearing for the locked design
- WebSearch: "RFC 8058 List-Unsubscribe-Post one-click unsubscribe implementation requirements" — confirmation only; existing route already implements this and is unchanged by this phase

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new dependencies, all versions verified directly from `package.json`
- Architecture: HIGH — every integration point verified by direct file read, including two corrections to CONTEXT.md's canonical refs (worker vitest config file location; runbook-coverage gate's actual narrow scope)
- Pitfalls: HIGH for codebase-specific pitfalls (verified against actual code); LOW/corroborating for general cryptographic-engineering pitfalls (industry-standard knowledge, not project-specific)

**Research date:** 2026-08-20
**Valid until:** Effectively unbounded for the locked-decision content (this is an internal-code phase with no external version drift risk); re-verify file line numbers if Phase 20+ touches any of the same files before this phase executes.
