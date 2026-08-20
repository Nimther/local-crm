---
phase: 08-quality-gates-failure-injection-foundation
plan: 16
subsystem: testing
tags: [coverage, kms, envelope-encryption, rls, tenant-isolation, campaigns]

requires:
  - phase: 08-14
    provides: the gate and ratchet this plan had to turn green without touching the threshold
provides:
  - packages/kms test lane and 10 envelope-encryption tests
  - packages/tenant-context test lane and 7 RLS-context tests
  - apps/api campaign route tests — 14 covering the previously untested HTTP surface
  - A green coverage gate reached without editing coverage-baseline.json
affects: [08-18, phase-10-rls-unification, phase-13-secrets]

tech-stack:
  added: ["vitest@4.1.9 in packages/kms and packages/tenant-context", "@mega-crm/test-support@0.1.0 in packages/tenant-context"]
  patterns:
    - "A test that encodes behaviour a later phase will change is labelled in the file as a pre-change baseline"

key-files:
  created:
    - packages/kms/vitest.config.ts
    - packages/kms/src/__tests__/envelope.test.ts
    - packages/tenant-context/vitest.config.ts
    - packages/tenant-context/src/__tests__/tenant-context.test.ts
    - apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts
  modified:
    - packages/kms/package.json
    - packages/tenant-context/package.json
    - vitest.config.ts

key-decisions:
  - "The two packages named by D-19 cannot close a one-percentage-point gap — 84 lines of 4264 — so the shortfall was reported rather than absorbed by lowering the threshold"
  - "Scope extended to campaigns.routes.ts, the largest uncovered block, on the user's decision"
  - "The two sendgrid/* routes stay uncovered: they call out to SendGrid, and no test in this phase makes a network call to that host"
  - "Tenant binding in kms is real and asserted rather than assumed — workspaceId is the AAD on the DEK wrap"

patterns-established:
  - "coverage-baseline.json is not an execution-time variable; when the gap cannot be closed, the answer is a scope decision, not an edit"

requirements-completed: [QG-03]

coverage:
  - id: D1
    description: "Envelope encryption has its own tests: round-trip, non-determinism, and rejection of tampered tag, ciphertext and wrapped key"
    requirement: QG-03
    verification:
      - kind: unit
        ref: "packages/kms/src/__tests__/envelope.test.ts — 10 tests"
        status: pass
    human_judgment: false
  - id: D2
    description: "A payload sealed for one workspace does not decrypt under another's identity"
    verification:
      - kind: unit
        ref: "envelope.test.ts#refuses to decrypt one workspace's payload under another's identity"
        status: pass
    human_judgment: false
  - id: D3
    description: "A row inserted under workspace A is invisible to a select under workspace B — asserted directly for the first time"
    verification:
      - kind: integration
        ref: "packages/tenant-context/src/__tests__/tenant-context.test.ts#hides one workspace's rows from another"
        status: pass
    human_judgment: false
  - id: D4
    description: "The tenant context fails closed with no tenant set, does not leak between scopes, and rolls back on a throw"
    verification:
      - kind: integration
        ref: "tenant-context.test.ts — 7 tests"
        status: pass
    human_judgment: false
  - id: D5
    description: "The coverage gate passes, reached by adding tests with the recorded threshold untouched"
    requirement: QG-03
    verification:
      - kind: integration
        ref: "npm run coverage:gate — 3494/4264 = 0.8194183864915572 vs threshold 0.8125751072961374, exit 0"
        status: pass
      - kind: integration
        ref: "npm run coverage:ratchet exit 0; git diff coverage-baseline.json empty"
        status: pass
    human_judgment: false
  - id: D6
    description: "The pre-Phase-10 RLS baseline is recorded in an executable form"
    verification:
      - kind: integration
        ref: "tenant-context.test.ts — 'no tenant in scope' describe block, two assertions labelled PRE-PHASE-10 BASELINE"
        status: pass
    human_judgment: true
    rationale: "Whether the recorded posture is the RIGHT one to carry into Phase 10 is that phase's decision; this only pins what the code does today so the change is deliberate."

duration: 38 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 16: Closing the Coverage Increment Summary

**Two packages of genuinely high consequence got their first tests, cross-tenant invisibility is asserted directly for the first time in this repository — and the gate went green through a third suite, because the two named packages turned out to be arithmetically incapable of closing the gap.**

## Performance

- **Duration:** 38 min
- **Started:** 2026-07-28T13:19:00Z
- **Completed:** 2026-07-28T13:57:00Z
- **Tasks:** 3
- **Files modified:** 8 (5 created, 3 modified)

## The gate

```
coverage:gate — lines 3494/4264
  actual    0.8194183864915572
  threshold 0.8125751072961374
coverage:gate — OK
```

`coverage:ratchet` exits 0 and `git diff coverage-baseline.json` is empty. Those two together are the evidence it went green the intended way.

| Stage | Fraction |
|---|---|
| 08-11 measurement | 0.8025751072961373 |
| after kms + tenant-context | 0.8027673545966229 |
| after campaign routes | **0.8194183864915572** |
| threshold | 0.8125751072961374 |

## The planning defect, and why it was reported rather than absorbed

D-19 named `packages/kms` and `packages/tenant-context` for the increment. Chosen correctly **by consequence** — one encrypts every tenant's SendGrid key, the other sets the session variable every RLS policy reads — but they are **84 lines of 4264**. The threshold needed **42 more covered lines**; their entire remaining headroom was:

| File | Covered | Headroom |
|---|---|---:|
| `packages/kms/src/aws-provider.ts` | 0/12 | 12 |
| `packages/kms/src/client.ts` | 19/20 | 1 |
| `packages/tenant-context/src/index.ts` | 23/24 | 1 |

**Maximum 14.** At 100% of both, the aggregate reaches 0.80605 — still 28 lines short. Not a matter of writing more tests in those files; the premise was arithmetically impossible.

The plan anticipated exactly this and said to stop and report rather than lower the number. Reported with the arithmetic; the user chose to extend scope. `campaigns.routes.ts` — the largest uncovered block in the repository at 80/242 — supplied 71 covered lines against the 42 needed.

## What the new tests actually establish

**Tenant binding in `packages/kms` is real.** `local-provider.ts` passes `workspaceId` as AAD on the DEK wrap, mirroring the AWS provider's `EncryptionContext`. So possessing the KEK and another tenant's stored row is not enough to decrypt it. The plan asked for this to be **checked rather than assumed**, and it holds — the contract is stronger than the plan was prepared to find.

**Cross-tenant invisibility is now asserted directly.** A row inserted under workspace A, selected under workspace B, expected absent. Every RLS policy in the schema exists to make that true, and until now it was only ever an implicit consequence of other suites passing.

**Two pre-Phase-10 baselines are pinned in executable form**, labelled as such in the file:

> With no tenant in scope, the same query behaves differently depending only on the connection's history — **zero rows** on a connection never scoped (the GUC reads NULL), and **`invalid input syntax for type uuid`** on one recycled from a scoped transaction (the custom GUC reverts to the empty string and the twelve bare-cast policies evaluate `''::uuid`).

`SPECIFICATION.md` §4.3 documents the mechanism; these assertions are where it is observable. Phase 10 unifies the variants and must move them in the fail-closed direction deliberately, not discover them.

**The campaign route layer had never been exercised.** Existing suites drive the repository functions directly or hit only `/:id`, `/launch`, `/progress` and `/test-send`. List, create, update, delete, audience-breakdown and test-sample went through no test at all — and the route layer is where validation, membership resolution and error mapping live. Fourteen tests now cover them, including the 400 and 404 paths, the D-09 null-means-clear convention, and a cross-workspace request that must not be served.

## Task Commits

1. **Tasks 1–2: the two packages** — `27b71fb` (test), `0171d8e` (fix)
2. **Task 3: registration + the suite that closed the gate** — `98c9586` (test)

## Decisions Made

- **The `sendgrid/*` routes stay uncovered.** They call out to SendGrid, and no test in this phase makes a network call to that host. Covering them means `nock` and belongs with whoever next touches those routes.
- **`aws-provider.ts` stays at 0/12.** It needs the AWS SDK mocked, and once `campaigns.routes.ts` closed the gap it was no longer load-bearing for the gate. It is the highest-value remaining gap in `kms` and is called out below rather than quietly left.
- **The KEK value is copied verbatim from `apps/api/vitest.config.ts`** into the new lane, asserted equal, so the two cannot drift.

## Deviations from Plan

### 1. [Rule 4 — Architectural, user-approved] The named packages could not close the gap

Described above. The plan's own instruction was to stop and report; the user extended scope to `campaigns.routes.ts`. `coverage-baseline.json` was never edited, and the ratchet confirms it.

### 2. [Rule 1 — Bug, in own work] A needless `async` on a callback that is never invoked

`withTenantTransaction` throws before acquiring a client when no tenant is in scope, so the callback in that assertion has nothing to await. `require-await` was right; committed before running lint, fixed immediately after in `0171d8e`. Running the gate before committing rather than after would have caught it — a small process lapse, not a code one.

### 3. [Rule 1 — Environment] `docker compose up -d --wait` in the `<verify>` blocks

As throughout this phase: native services on the same ports and DSNs.

---

**Total deviations:** 1 architectural (surfaced to the user with the arithmetic and decided by them), 1 auto-fixed, 1 environmental.
**Impact on plan:** Scope extended by one test file beyond `files_modified`, on an explicit decision. Every named artifact exists.

## Issues Encountered

- **`packages/kms/src/aws-provider.ts` remains at 0% (12 lines).** It is the **production** key-handling path — the local provider that is now well tested is the dev-only one. Covering it needs `@aws-sdk/client-kms` mocked. Worth doing on its own merits, independent of any coverage number, and it is the most consequential untested code left in that package.
- **The `test-sample` assertion accepts either 200 or 404.** The workspace has no contacts, so an empty sample is a legitimate outcome; what the test pins is that the route resolves rather than 500s. A tighter assertion needs a seeded contact and belongs with whoever specifies that route's empty-state contract.

## User Setup Required

None.

## Next Phase Readiness

- **08-18 can wire `coverage:gate` into the blocking job.** It is green, and 08-14's note about sequencing no longer applies.
- **QG-03 is complete in substance** across 08-11, 08-14 and this plan.
- **Phase 10** has its baseline in executable form, in the file it will change, labelled so it is not mistaken for a regression.
- **Phase 13** inherits the `aws-provider.ts` gap and the note that the local provider's tenant binding was verified — the AWS one's `EncryptionContext` is asserted only by the comment claiming they mirror each other.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
