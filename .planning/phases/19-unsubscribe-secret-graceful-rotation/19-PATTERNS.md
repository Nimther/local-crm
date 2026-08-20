# Phase 19: Unsubscribe Secret Graceful Rotation - Pattern Map

**Mapped:** 2026-08-20
**Files analyzed:** 9 (1 new, 8 modified)
**Analogs found:** 9 / 9 (all are self-analogs — extend the existing file itself, or a same-package precedent)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `packages/delivery-core/src/unsubscribe-token.ts` | utility (crypto verify) | request-response (pure function, no I/O) | itself (extend in place) | exact |
| `packages/delivery-core/src/logger.ts` (NEW) | utility (logging) | event-driven (log emission) | `packages/contacts-core/src/logger.ts` | exact |
| `packages/delivery-core/package.json` | config | — | `packages/contacts-core/package.json` (already depends on `pino`) | exact |
| `apps/api/src/env.ts` | config (zod schema) | request-response (boot-time validate) | itself — extend existing `UNSUBSCRIBE_TOKEN_SECRET` field + `KMS_KEK_ID`/`KMS_FILE_KEK_PATH` conditional-optional pattern in the same file | exact |
| `apps/worker/src/server.ts` (:218-223 today) | config (manual boot check) | request-response (boot-time validate) | itself — extend existing `unsubscribeTokenSecret` check block in the same file | exact |
| `scripts/check-env.mjs` | config (dev presence check) | request-response (predev check) | itself — existing `UNSUBSCRIBE_TOKEN_SECRET` line (105) + `KMS_KEK_ID` conditional-push pattern (120) | exact |
| `packages/redaction/src/rules.ts` | config (redaction rule table) | transform (log/payload scrub) | itself — existing `secret` / `token` keyRule entries | exact |
| `packages/delivery-core/src/__tests__/unsubscribe-token.test.ts` | test | request-response | itself — existing rotation-adjacent fixture pattern | exact |
| `apps/api/src/__tests__/env-schema.test.ts` | test | request-response | itself — existing negative-test pattern for other conditional fields | exact |
| `apps/api/src/modules/delivery/__tests__/unsubscribe.test.ts` (+ siblings: `unsubscribe-content-type.test.ts`, `unsubscribe-xss.test.ts`, `unsubscribe-test-send.test.ts`) | test | request-response | itself — extend with a previous-secret-signed-token scenario | exact |
| `docs/runbooks/unsubscribe-secret-rotation.md` (NEW) | doc/runbook | — | `docs/runbooks/backups.md` (opening-line convention) | role-match |
| `SPECIFICATION.md` §3 «Секреты» | doc | — | existing §3 entries for other secrets (e.g. `UNSUBSCRIBE_TOKEN_SECRET`'s current entry) | exact |

**No route-layer file needs a code change** — `apps/api/src/modules/delivery/unsubscribe.routes.ts` is a pure consumer of `verifyUnsubscribeToken`'s unchanged null-or-payload contract (see Anti-Pattern note below). It is listed only because its existing tests get extended.

## Pattern Assignments

### `packages/delivery-core/src/unsubscribe-token.ts` (utility, request-response)

**Analog:** itself (current file, read in full — 105 lines, no re-read needed)

**Current single-secret shape to extend** (lines 22-32):
```typescript
function getSecret(): string {
  const secret = process.env.UNSUBSCRIBE_TOKEN_SECRET;
  if (!secret) {
    throw new Error("UNSUBSCRIBE_TOKEN_SECRET is not set");
  }
  return secret;
}

function sign(encodedPayload: string): string {
  return createHmac("sha256", getSecret()).update(encodedPayload).digest("base64url");
}
```
`getSecret()` stays as the PRIMARY-only resolver for `signUnsubscribeToken` (signing path is unchanged, D-04). Rename conceptually to `getPrimarySecret()` and add a sibling `getPreviousSecrets()`:
```typescript
function getPreviousSecrets(): string[] {
  const raw = process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
  if (!raw) return [];
  return raw.split(",");
}
```

**Core verify pattern to extend** (lines 52-95, the "never throws, null-or-payload" contract — MUST be preserved exactly):
```typescript
export function verifyUnsubscribeToken(token: string): UnsubscribeTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return null;

  let expectedSigBuf: Buffer;
  let actualSigBuf: Buffer;
  try {
    expectedSigBuf = Buffer.from(sign(encodedPayload), "base64url");
    actualSigBuf = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }

  if (expectedSigBuf.length !== actualSigBuf.length || !timingSafeEqual(expectedSigBuf, actualSigBuf)) {
    return null;
  }
  // ... payload parse/shape-check unchanged below this point ...
}
```
Replace the single `sign(encodedPayload)` compare with the exhaustive `[primary, ...previous]` loop (RESEARCH.md's verified Pattern 1 code, reproduced below verbatim — this is the primary implementation template, already reconciled against this exact file's current contract):
```typescript
const candidates = [getPrimarySecret(), ...getPreviousSecrets()];
let matchedIndex = -1;

// Exhaustive evaluation (no early break) -- total loop time depends only on
// candidates.length, never on which candidate matched or whether any did.
for (let i = 0; i < candidates.length; i++) {
  let expectedSigBuf: Buffer;
  try {
    expectedSigBuf = Buffer.from(signWith(candidates[i], encodedPayload), "base64url");
  } catch {
    continue;
  }
  const isMatch =
    expectedSigBuf.length === actualSigBuf.length &&
    timingSafeEqual(expectedSigBuf, actualSigBuf);
  if (isMatch && matchedIndex === -1) {
    matchedIndex = i;
  }
}

if (matchedIndex === -1) return null;
if (matchedIndex > 0) {
  logger.info({ secretPosition: matchedIndex }, "unsubscribe token verified via previous secret");
}
```

**Error handling pattern:** every failure shape (bad base64, wrong part count, no match after exhausting candidates, JSON parse error) collapses to `return null` — no new branch, no new throw. This is the file's existing convention (lines 54, 59, 68, 84, 93) and must be extended identically for the new loop.

---

### `packages/delivery-core/src/logger.ts` (NEW) (utility, event-driven)

**Analog:** `packages/contacts-core/src/logger.ts` (full file, 15 lines — read in full, no re-read needed)

**Full pattern to copy verbatim, changing only the doc-comment's referent** (lines 1-15):
```typescript
import pino from "pino";

/**
 * Minimal structured logger for this shared package (D-05 previous-secret
 * verification logging inside `verifyUnsubscribeToken`). Deliberately
 * independent of `apps/api/src/logger.ts` (which pulls in `env.ts` and
 * KMS/redaction concerns specific to the API app) -- `@mega-crm/delivery-core`
 * is imported by BOTH `apps/api` and `apps/worker`, so it cannot depend back
 * on either app (mirrors `@mega-crm/contacts-core`'s same-shaped logger for
 * the same reason).
 */
export const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : "info",
});
```
Also add `pino` (pin `10.3.1`, matching `apps/api/package.json`'s pinned version) to `packages/delivery-core/package.json` `dependencies` — currently only `@mega-crm/tenant-context` and `pg` are listed there; `packages/contacts-core/package.json` already has this exact `pino` entry to copy from.

---

### `apps/api/src/env.ts` (config, request-response)

**Analog:** itself — the file's own `KMS_KEK_ID`/`KMS_FILE_KEK_PATH` conditional-optional pattern (lines 41-42, 93-106) is the closest existing precedent for "optional var with cross-field validation in `.superRefine`."

**Existing primary-secret field to tighten** (lines 47-49):
```typescript
UNSUBSCRIBE_TOKEN_SECRET: z
  .string()
  .min(32, "UNSUBSCRIBE_TOKEN_SECRET must be at least 32 characters"),
```
Add `.refine((v) => !/[,\s]/.test(v), "...")` per D-03 (charset contract now applies to the primary too — RESEARCH.md flags this as a real, narrow behavior change, not purely additive). Add the sibling optional field:
```typescript
UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS: z.string().optional(),
```

**Conditional-validation pattern to copy** (`.superRefine`, lines 80-134 — this exact block is where new cross-field checks land; follow the `ctx.addIssue({ code: z.ZodIssueCode.custom, message, path })` shape used throughout):
```typescript
if (val.KMS_PROVIDER === "aws" && !val.KMS_KEK_ID) {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "KMS_KEK_ID is required when KMS_PROVIDER=aws",
    path: ["KMS_KEK_ID"],
  });
}
```
Extend with the D-02/D-03/D-07 checks for `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` (whitespace-in-raw-string, per-entry `min(32)`/non-empty, no duplicate-of-primary-or-each-other, max 5 entries) — see RESEARCH.md Pattern 2's full worked example for the exact `superRefine` body; that example was already written against this file's real content and needs no further translation.

**Error surfacing pattern** (lines 137-151) — unchanged, already collects all `ctx.addIssue` messages into one boot-failure error; no new file needed, the new issues flow through automatically.

---

### `apps/worker/src/server.ts` (config, request-response)

**Analog:** itself — existing manual throw-on-fail block for the same secret (lines 218-223, confirmed at this exact location by direct read)

**Pattern to extend**:
```typescript
const unsubscribeTokenSecret = process.env.UNSUBSCRIBE_TOKEN_SECRET;
if (!unsubscribeTokenSecret || unsubscribeTokenSecret.length < 32) {
  throw new Error(
    "UNSUBSCRIBE_TOKEN_SECRET (>=32 chars) is required for apps/worker to start -- it signs every List-Unsubscribe token"
  );
}
```
Add a parallel block for `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` (optional — only validate if present) mirroring this exact `if (...) throw new Error(...)` shape, plus tighten this existing block with the same charset check added to `env.ts` (the worker's manual check today only enforces `length < 32`, per RESEARCH.md Pitfall 4 — it must gain the comma/whitespace rejection too, independently hard-coded, matching this codebase's established triplication convention rather than importing a shared validator).

---

### `scripts/check-env.mjs` (config, request-response)

**Analog:** itself — existing `UNSUBSCRIBE_TOKEN_SECRET` presence-check line (line 105) and the conditional-optional-push pattern used for `KMS_KEK_ID` (line 120: `required.push("KMS_KEK_ID")` inside a provider-conditional block)

Since `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` is itself optional (not conditionally-required like `KMS_KEK_ID`), the closest-fitting action is likely "no entry needed" or a documented no-op — this script's own convention (per RESEARCH.md Open Question 2) is presence-only checks that delegate all format validation to `env.ts`'s zod schema; there is no existing "optional, no presence check, comment explains why" precedent in this file yet, so this would be the first one. Executor should read the full file at plan time to confirm placement of an explanatory comment near line 105.

---

### `packages/redaction/src/rules.ts` (config, transform)

**Analog:** itself — existing `secret` / `token` `keyRules` entries (lines 59, 57)

**Pattern to copy** (the `KeyRule` shape, line 35-40 interface + entries like line 59):
```typescript
{ key: "secret", protects: "generic secret material (API-key secret half, signing secrets)" },
```
Add a new entry:
```typescript
{ key: "unsubscribeTokenSecretPrevious", protects: "retired unsubscribe-token HMAC signing secrets (comma-separated list, verification-only) -- packages/delivery-core/src/unsubscribe-token.ts" },
```
Note: the existing `secret` keyRule (line 59) already matches on field name `secret` case-insensitively at any depth, so `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` may already be substring/field-shape covered depending on how env values ever reach a logged object (they normally don't — env vars aren't logged directly). Confirm at plan time whether a dedicated rule is needed or the existing generic `secret`/`token` rules already provide coverage; the `rules-parity.test.ts` test (referenced in this file's own header comment, lines 1-10) is the verification point for whichever choice is made.

---

## Shared Patterns

### Env-validation triple (structural convention, not a single file)
**Source:** `apps/api/src/env.ts` (zod) + `apps/worker/src/server.ts` (:218-223 manual throw) + `scripts/check-env.mjs` (:105 presence check)
**Apply to:** All three sites must be updated TOGETHER as one task, never independently (RESEARCH.md Pitfall 4 — documented drift risk, confirmed by direct read: SPECIFICATION.md §3.1 explicitly accepts this triplication as a tradeoff, contingent on synchronized updates). Each site independently hard-codes constants (`min(32)`, `MAX_PREVIOUS = 5`) rather than importing a shared constant, matching the established no-shared-runtime-config-service convention.

### Never-throws / null-or-payload contract
**Source:** `packages/delivery-core/src/unsubscribe-token.ts` lines 52-95 (existing, pre-rotation)
**Apply to:** The extended `verifyUnsubscribeToken` — every new failure/no-match branch must return `null`, never throw, so `apps/api/src/modules/delivery/unsubscribe.routes.ts` needs zero code changes (confirmed: this file must NOT appear in the phase's diff — its extensive T-04-03-01/02 threat-model comments document why byte-identical responses depend on this contract staying exactly as-is).

### Package-local minimal logger (dependency-light, app-independent)
**Source:** `packages/contacts-core/src/logger.ts` (full file, copied above)
**Apply to:** `packages/delivery-core/src/logger.ts` (new) — same shape, same `NODE_ENV === "test" ? "silent" : "info"` level logic, same rationale for not depending on `apps/api/src/logger.ts`.

### Doc-comment attribution convention (decision traceability)
**Source:** pervasive across `apps/api/src/env.ts` (e.g. lines 26-35, 36-42) and `apps/worker/src/server.ts` (lines 198-209, 211-217, 231-234)
**Apply to:** Every new/modified block in this phase — each should carry a short comment citing the requirement/decision id (ROT-01/ROT-02, D-0x) and a one-line "why," matching this codebase's dense inline-rationale style. This is not optional flourish; it's the established convention for every field in `env.ts` and every check in `server.ts`.

### Runbook opening-line convention
**Source:** `docs/runbooks/backups.md` (per RESEARCH.md Pitfall 5, verified structure)
**Apply to:** `docs/runbooks/unsubscribe-secret-rotation.md` (new) — opening line format: "Implements requirement **ROT-01/ROT-02** and decisions **D-06 through D-09**... (`.planning/phases/19-unsubscribe-secret-graceful-rotation/19-CONTEXT.md`)". This runbook is NOT covered by `scripts/check-runbook-coverage.mjs`'s automated gate (that gate only enumerates `*_ALERT_NAME` constants from `apps/api/src/modules/ops/*.ts`) — verification is manual/review-based, same as `backups.md`, `restore-drill.md`, `migration-rollback-and-roll-forward.md`, `data-retention.md`. Do not plan a task whose verification criterion is "passes `check:runbook-coverage`."

## No Analog Found

None — every file in scope either extends itself (the dominant pattern for this phase, since it is almost entirely a same-file extension of already-existing, already-tested machinery) or has a direct same-package precedent (`contacts-core/src/logger.ts` for the new logger).

## Anti-Patterns to Avoid (from RESEARCH.md, restated as pattern guidance)

- **Do not touch `apps/api/src/modules/delivery/unsubscribe.routes.ts`.** Any diff there is a signal that verification-specific logic leaked into the wrong tier — extend only its test files (`unsubscribe.test.ts` + 3 siblings in `apps/api/src/modules/delivery/__tests__/`).
- **Do not early-exit the candidate loop on first match.** Use exhaustive evaluation (see the `unsubscribe-token.ts` excerpt above) to avoid a position-based timing side-channel.
- **Do not add a `kid` field to the token payload.** D-04 explicitly rejects this; the token wire format (`${base64url}.${signature}`) stays byte-identical to today.

## Metadata

**Analog search scope:** `packages/delivery-core/src`, `packages/contacts-core/src`, `apps/api/src` (env.ts, modules/delivery), `apps/worker/src` (server.ts), `packages/redaction/src`, `scripts/check-env.mjs`, `docs/runbooks/`
**Files scanned:** 9 direct reads (all cited above) + RESEARCH.md's own prior verified reads (2026-08-20 session), cross-checked, no contradictions found
**Pattern extraction date:** 2026-08-20
