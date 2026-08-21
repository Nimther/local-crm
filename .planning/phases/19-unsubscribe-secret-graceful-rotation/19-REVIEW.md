---
phase: 19-unsubscribe-secret-graceful-rotation
reviewed: 2026-08-21T00:00:00Z
depth: standard
files_reviewed: 15
files_reviewed_list:
  - apps/api/src/__tests__/env-schema.test.ts
  - apps/api/src/env.ts
  - apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts
  - apps/worker/src/__tests__/unsubscribe-secret-boot-check.test.ts
  - apps/worker/src/server.ts
  - docker/prod.env.example
  - docs/runbooks/unsubscribe-secret-rotation.md
  - packages/delivery-core/package.json
  - packages/delivery-core/src/__tests__/unsubscribe-token-rotation.test.ts
  - packages/delivery-core/src/logger.ts
  - packages/delivery-core/src/unsubscribe-token.ts
  - packages/redaction/src/__tests__/rules-parity.test.ts
  - packages/redaction/src/rules.ts
  - scripts/__tests__/check-env-unsubscribe-previous.test.mjs
  - scripts/check-env.mjs
findings:
  critical: 1
  warning: 2
  info: 4
  total: 7
status: issues_found
---

# Phase 19: Code Review Report

**Reviewed:** 2026-08-21T00:00:00Z
**Depth:** standard
**Files Reviewed:** 15
**Status:** issues_found

## Summary

This phase extends single-secret HMAC unsubscribe-token verification into an
ordered `[primary, ...previous]` candidate loop, adds three independent
boot-time validators for `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS`
(`apps/api/src/env.ts`, `apps/worker/src/server.ts`,
`scripts/check-env.mjs`), adds redaction coverage for both secret env-var
names, and documents the two-step rotation procedure in a new runbook. The
core cryptographic change (the exhaustive, no-early-break candidate loop in
`verifyUnsubscribeToken`) is correct and well-defended: the length-guard
before `timingSafeEqual` avoids a throw, every candidate is evaluated
regardless of match position, and the exhaustiveness plus response-shape
invariant is covered by unit tests (HMAC call-count parity across
primary/last-previous/no-match) and an end-to-end test exercising real
Fastify routes across all four response classes. The three independent env
validators are logically equivalent (same accept/reject decision for any
input) despite different control flow (early-throw vs. issue-collection),
and a parity test enforces the `MAX_UNSUBSCRIBE_PREVIOUS_SECRETS = 5`
constant stays in sync across all three declarations. No secret value is
echoed by any validation error message, matching the stated T-19-08
requirement.

Two real defects were found: the rotation runbook's own documented
procedure produces an operator-facing production outage if followed
literally (Critical), and the refactor that introduced the candidate loop
silently dropped the pre-existing guarantee that `verifyUnsubscribeToken`
never throws (Warning — currently unreachable in production only because
boot-time validation happens to prevent the triggering condition).

## Critical Issues

### CR-01: Rotation runbook Step 2, followed literally, leaves the new primary duplicated in the previous list and crash-loops both processes

**File:** `docs/runbooks/unsubscribe-secret-rotation.md:63-95` (Step 1 and Step 2)

**Issue:** Step 1 instructs the operator to *append* the new secret to
`UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS`:

> "Append it to `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` — comma-separated,
> ordered — in `MEGA_CRM_ENV_FILE`, on every service."

Step 2 then says:

> "Move the current primary (`UNSUBSCRIBE_TOKEN_SECRET`'s existing value)
> into `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` ... Set the new secret (from
> Step 1) as the new `UNSUBSCRIBE_TOKEN_SECRET`."

Nowhere does Step 2 instruct the operator to *remove* the new secret from
`UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` before promoting it to primary. An
operator who executes Step 2 exactly as written ends up with:

- `UNSUBSCRIBE_TOKEN_SECRET` = new secret
- `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` = `<new secret>,<old primary>` (new
  secret still present from Step 1, old primary just added)

This is rejected by all three independent validators —
`apps/api/src/env.ts`'s `superRefine` (`entry === val.UNSUBSCRIBE_TOKEN_SECRET`,
line 197), `apps/worker/src/server.ts`'s `assertUnsubscribeTokenSecrets`
(`entry === unsubscribeTokenSecret`, line 225), and `scripts/check-env.mjs`
(`entry === primary`, line 190) — all three implement "no previous entry may
equal the primary" specifically to prevent this exact configuration. Both
`api` and `worker` therefore refuse to start on the Step 2 restart, and
crash-loop until an operator diagnoses the env file and manually removes the
now-primary secret from the previous list. This happens mid-rotation, after
Step 1's restart already succeeded, so it is a self-inflicted outage
produced by following the phase's own documented procedure.

The failure is not silent (all three validators name the variable and the
violated rule, never the secret value, per the Prerequisites section's own
claim), and the Rollback section's "swap the two values back" procedure does
cover recovery once diagnosed — but the runbook, as written, walks an
operator directly into a boot-time crash on every literal execution of
Step 2, with no step warning them to drop the just-promoted secret from the
previous list first.

**Fix:** Add an explicit instruction to Step 2 removing the new secret from
`UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` in the same edit that sets it as
primary, e.g.:

```markdown
## Step 2 — promote

Edit `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` and `UNSUBSCRIBE_TOKEN_SECRET`
together, in the same edit:

1. Remove the new secret (the one appended in Step 1) from
   `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS`.
2. Move the **current** primary (`UNSUBSCRIBE_TOKEN_SECRET`'s existing
   value) into `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` in its place (prepend or
   append -- list order does not affect correctness).
3. Set the new secret (from Step 1) as the new `UNSUBSCRIBE_TOKEN_SECRET`.

A secret may never appear as both the primary and a previous-list entry
simultaneously -- all three boot validators reject that configuration and
both `api` and `worker` will refuse to start if this step is done
out of order.
```

## Warnings

### WR-01: The candidate-loop refactor regressed `verifyUnsubscribeToken`'s "never throws" contract

**File:** `packages/delivery-core/src/unsubscribe-token.ts:96`

**Issue:** The function's doc comment (lines 65-70) states it "never
throws" for any failure and always degrades to `null`. Before this phase,
that was true by construction: the pre-existing code computed
`expectedSigBuf` via `sign(encodedPayload)` (which calls `getSecret()`,
throwing if `UNSUBSCRIBE_TOKEN_SECRET` is unset) **inside** a `try { ... }
catch { return null; }` block, so an unset primary degraded to `null` like
every other failure mode.

This phase's refactor moved the primary/previous-secret resolution out of
any try/catch:

```ts
const candidates = [getPrimarySecret(), ...getPreviousSecrets()];
```

`getPrimarySecret()` still throws (`"UNSUBSCRIBE_TOKEN_SECRET is not set"`)
if the env var is unset, and this call is no longer inside a try/catch —
so `verifyUnsubscribeToken` can now throw for the same condition that
previously returned `null`. In production this is currently unreachable
only because both `apps/api/src/env.ts` (module-load-time `safeParse`) and
`apps/worker/src/server.ts`'s `assertUnsubscribeTokenSecrets()` (called in
`buildWorker()` before any worker is constructed) independently guarantee
`UNSUBSCRIBE_TOKEN_SECRET` is set before either process is live. But the
guarantee now lives entirely in two callers, not in the function itself,
and the function's own doc comment overstates what it actually does. If
this were ever reached (a future caller that doesn't route through either
boot gate, or a test/script scenario where `process.env` is mutated after
boot), a well-formed token would 500 while a malformed token returns `null`
— i.e. a distinguishable response shape, which is exactly the
`T-04-03-02` byte-identical-response invariant the unsubscribe route and
this phase's own SC3 tests exist to prevent.

**Fix:** Restore the original guarantee by keeping candidate resolution
inside the existing try/catch, or wrapping it in its own:

```ts
let candidates: string[];
try {
  candidates = [getPrimarySecret(), ...getPreviousSecrets()];
} catch {
  return null;
}
```

### WR-02: The D-05 previous-secret log call reintroduces a timing asymmetry the exhaustive loop was built to eliminate

**File:** `packages/delivery-core/src/unsubscribe-token.ts:123-125`

**Issue:** The candidate loop is deliberately exhaustive with no early
break specifically so total loop duration is a pure function of
`candidates.length`, independent of which candidate (if any) matched — the
comment above the loop (lines 89-95) states this explicitly as the
mechanism that keeps the HTTP response "byte-identical regardless of which
secret ... produced the match." Immediately after the loop, however:

```ts
if (matchedIndex > 0) {
  logger.info({ secretPosition: matchedIndex }, "unsubscribe token verified via previous secret");
}
```

This conditionally performs a synchronous Pino write only when the match
occurred at a previous-list position (`matchedIndex > 0`), never when the
match was the primary (`matchedIndex === 0`) and never on no-match
(`matchedIndex === -1`). That means a request whose token verifies via a
previous secret now does measurably more work (and, being synchronous I/O,
takes measurably longer) than a request whose token verifies via the
primary or fails to verify at all. This does not create a valid-vs-invalid
oracle — primary-valid and invalid tokens take the identical (faster) path,
so SC3's stated no-oracle-for-forgery property is intact — but it does let
an observer distinguish "verified via previous secret" from "verified via
primary, or did not verify," purely through response latency, which is
exactly the class of signal this phase went out of its way to eliminate for
every other branch in this function. The existing E2E test (Test 7,
`unsubscribe-rotation.test.ts`) asserts body/header equality across all
four cases but does not (and, being an HTTP-level Fastify `inject()` test,
practically cannot) assert timing equality, so this asymmetry is untested.

**Fix:** Defer the log emission off the verification/response path, e.g.
`setImmediate(() => logger.info(...))`, so the synchronous work inside
`verifyUnsubscribeToken` itself stays uniform across all match outcomes; or,
if the residual timing signal is judged acceptable (its exploitability is
low — it does not help forge or distinguish valid-vs-invalid tokens), record
that as an explicit accepted-risk note next to the D-05 comment rather than
leaving the asymmetry undocumented alongside a comment that reads as if
"the HTTP response is unaffected" covers this dimension too.

## Info

### IN-01: Dead `catch` branch inside the candidate loop

**File:** `packages/delivery-core/src/unsubscribe-token.ts:100-105`

**Issue:** Each loop iteration wraps `Buffer.from(signWith(candidates[i],
encodedPayload), "base64url")` in `try { ... } catch { continue; }`.
`signWith` always returns a valid base64url string (the output of
`.digest("base64url")`), so decoding it back with `Buffer.from(..., "base64url")`
cannot throw for any string HMAC key `candidates[i]`. The catch branch is
unreachable in practice.

**Fix:** Either remove the try/catch (relying on the fact that HMAC never
throws for a string key and digest→decode round-trips cleanly), or add a
one-line comment noting it is defensive/belt-and-suspenders so a future
reader doesn't assume it is load-bearing for some case that doesn't
actually exist.

### IN-02: Unreachable fallback in `check-env.mjs`'s previous-secrets block

**File:** `scripts/check-env.mjs:167`

**Issue:** `const primary = values.UNSUBSCRIBE_TOKEN_SECRET || "";` falls
back to an empty string, but this block only executes after the earlier
`missing.length > 0` gate (line 137) has already `process.exit(1)`'d if
`UNSUBSCRIBE_TOKEN_SECRET` (a `baseRequired` entry) was empty or absent. By
the time this line runs, `values.UNSUBSCRIBE_TOKEN_SECRET` is guaranteed
non-empty, so the `|| ""` fallback never fires.

**Fix:** Drop the fallback (`const primary = values.UNSUBSCRIBE_TOKEN_SECRET;`)
or add a short comment noting it is unreachable-by-construction, to avoid a
future reader assuming this function can run with a missing primary.

### IN-03: Runbook's "boot only, no live-reload" claim is stronger than the implementation

**File:** `docs/runbooks/unsubscribe-secret-rotation.md:32-36`;
`packages/delivery-core/src/unsubscribe-token.ts:25-44`

**Issue:** The runbook states "Both `apps/api` and `apps/worker` read
`UNSUBSCRIBE_TOKEN_SECRET` and `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` from
`process.env` at boot only -- there is no live-reload path for either
variable." In fact, `getPrimarySecret()` and `getPreviousSecrets()` both
read `process.env` fresh on every call to `signUnsubscribeToken` /
`verifyUnsubscribeToken` (by design, per the existing doc comment on
`getPreviousSecrets`, so a restarted process picks up a new value with no
other code path needing to know the list exists). In a real deployment this
is functionally equivalent to "boot only" because `process.env` does not
change without a process restart — but the runbook's phrasing describes an
architectural guarantee ("no live-reload path") that the code does not
actually enforce; it is an environmental fact (containers don't mutate their
own env), not a code-level one. Worth a precise footnote so a future reader
doesn't rely on this function refusing to pick up an env mutation within a
long-lived process (e.g. a test harness, or a future admin-reload feature).

**Fix:** Soften the wording, e.g. "read from `process.env` on every call,
but in practice this is equivalent to boot-only because nothing in this
codebase mutates `process.env` after startup" — or, if the "boot only"
guarantee is meant to be load-bearing, cache the resolved secrets once at
module load instead of reading lazily.

### IN-04: Runbook Step 3's precondition is stated after the step it must precede

**File:** `docs/runbooks/unsubscribe-secret-rotation.md:97-108`

**Issue:** Step 3 ("canary smoke of both link eras") opens with "**Before
Step 2**, capture a pre-rotation unsubscribe link ..." An operator reading
the runbook linearly (Step 1, then Step 2, then Step 3) only learns about
this precondition after already having completed Step 2 — at which point,
per the same paragraph, "the canary's most recently sent link may already
carry the new primary's signature," so the precondition can no longer be
satisfied without triggering an extra send under the old primary
specifically to recover it.

**Fix:** Move the pre-rotation-link capture instruction into Step 2 itself
(as an explicit precondition to perform before restarting), or reorder the
sections so the capture step is numbered before Step 2 rather than nested
inside Step 3's narrative.

---

## Fix Report

**Fixed at:** 2026-08-21T00:32:00Z
**Fix scope:** CR-01, WR-01, WR-02 (Info findings IN-01..IN-04 out of scope)

### CR-01: Rotation runbook Step 2 crash-loop — fixed

**File:** `docs/runbooks/unsubscribe-secret-rotation.md`
**Commit:** `6facaf9`

Step 2 now explicitly instructs the operator to (1) remove the new secret
from `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` in the same edit that (2) moves the
current primary into the previous list and (3) sets the new secret as
primary — with an explicit warning that a secret may never appear as both
primary and a previous-list entry simultaneously, and that skipping/misordering
step 1 crash-loops both `api` and `worker`.

**Verification evidence:** Walked both restart-producing states the runbook
now yields, with a full valid base env (`scripts/check-env.mjs`'s
`baseRequired` set + `KMS_LOCAL_KEK`) plus:
- State after Step 1 (`UNSUBSCRIBE_TOKEN_SECRET=A`,
  `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS=B`) — `node scripts/check-env.mjs` →
  "Env check passed."
- State after the OLD (buggy) Step 2 literal instructions
  (`UNSUBSCRIBE_TOKEN_SECRET=B`, `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS=B,A`) —
  reproduces the reported crash: "Env check failed: ... entry 1 duplicates
  the primary secret or another entry."
- State after the FIXED Step 2 (`UNSUBSCRIBE_TOKEN_SECRET=B`,
  `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS=A`) — "Env check passed."

`apps/api/src/env.ts`'s `superRefine` and `apps/worker/src/server.ts`'s
`assertUnsubscribeTokenSecrets()` implement the identical `entry === primary`
rejection rule (confirmed by reading both, lines 197 and 225 respectively),
so the same buggy-state/fixed-state result holds for all three validators,
not just `check-env.mjs`.
`npm run check:runbook-coverage` passes and does not cover this file (as the
review itself notes — that gate is scoped to ops alert-name constants only).

### WR-01: `verifyUnsubscribeToken` never-throws contract — fixed

**File:** `packages/delivery-core/src/unsubscribe-token.ts`
**Commit:** `c2a4f3b`
**Status:** fixed: requires human verification (logic-contract fix — see
verification-strategy note on logic bugs below)

Candidate resolution (`getPrimarySecret()` + `getPreviousSecrets()`) is now
wrapped in its own `try { ... } catch { return null; }`, restoring the
function's documented "never throws" guarantee for an unset
`UNSUBSCRIBE_TOKEN_SECRET`, independent of boot-time validation in callers.
The exhaustive, no-early-break candidate loop is unchanged.

**Verification evidence:** `npx tsc --noEmit` on `packages/delivery-core`
clean; `npm run test -w packages/delivery-core -- unsubscribe` — 19/19
passed, unmodified; full package suite `npm run test -w packages/delivery-core`
— 176/176 passed. Direct runtime exercise of the restored no-throw path
(env var unset → function returns rather than throwing) was attempted via a
standalone script but blocked by this repo's ESM `.js`-extension resolution
outside the configured test loader, not by the fix itself — the existing
unit-test suite (which exercises the missing/invalid-secret paths this catch
now covers) is the verification of record. Flagged for human confirmation
per this agent's logic-bug policy since a `try/catch` scope change is a
control-flow edit, not purely additive.

### WR-02: D-05 log timing asymmetry — skipped (documented as accepted risk)

**File:** `packages/delivery-core/src/unsubscribe-token.ts:133-158`
**Reason:** Both fix options in the review's own **Fix:** section were
evaluated and rejected because they alter tested behavior, which the fixer's
governing constraint for this finding explicitly forbids:
- **Deferred logging** (`setImmediate(() => logger.info(...))`): the D-05
  test suite (`unsubscribe-token-rotation.test.ts`, lines 206-252) asserts
  `logger.info` call count/args synchronously immediately after
  `verifyUnsubscribeToken(token)` returns, with no `await`/timer-flush.
  Deferring the call makes those assertions fail deterministically (the log
  call has not fired by assertion time).
- **Equalizing per-path work** (making every match/no-match path perform
  identical logging work): incompatible in principle, not just in
  implementation — the same tests assert a **0-vs-1 call-count difference**
  between the primary/no-match paths and the previous-secret-match path as
  the intended, tested D-05 behavior. Any fix that removes that call-count
  difference removes the tested behavior itself.

Per the constraint ("mark as skipped with a written rationale ... choose (b)
if any fix would alter tested behavior"), this is skipped. A comment-only
change (no behavior change) was added next to the D-05 log line documenting
the asymmetry as an accepted, low-risk residual signal: it distinguishes
"verified via previous secret" from "verified via primary, or did not
verify" through response latency, but creates no valid-vs-invalid oracle
(primary-valid and invalid tokens share the identical, faster path), matching
the review's own conclusion.

**Original issue:** The `matchedIndex > 0` conditional synchronous Pino
write after the exhaustive candidate loop means a previous-secret match does
measurably more (and slower) synchronous work than a primary match or
no-match, reintroducing a timing signal on top of a loop that was built
specifically to eliminate one.

**Verification evidence:** `npm run test -w packages/delivery-core -- unsubscribe`
— 19/19 passed, unmodified (no test file touched); `npm run test -w apps/api -- unsubscribe`
— 25/25 passed, unmodified; `npx tsc --noEmit` clean.

### Summary

| Finding | Status | Commit |
|---|---|---|
| CR-01 | fixed | `6facaf9` |
| WR-01 | fixed: requires human verification | `c2a4f3b` |
| WR-02 | skipped: fix would alter tested behavior — documented as accepted risk | `da72a60` |

**Test results:** `packages/delivery-core` full suite 176/176 passed;
`apps/api` scoped `unsubscribe` suite 25/25 passed; `npx tsc --noEmit -p
packages/delivery-core/tsconfig.json` clean; `npm run check:runbook-coverage`
passed (does not cover this runbook, by design).

---

_Reviewed: 2026-08-21T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
_Fixed: 2026-08-21T00:32:00Z_
_Fixer: Claude (gsd-code-fixer)_
