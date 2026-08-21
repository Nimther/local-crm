---
phase: 19
slug: unsubscribe-secret-graceful-rotation
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-21
---

# Phase 19 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| public internet → `POST /unsubscribe/:token` | Unauthenticated, attacker-controllable token string; possession of a validly-signed token is the entire authorization for the mutation | HMAC-signed unsubscribe token |
| public internet → `GET /unsubscribe/:token` | Attacker-controllable token reaches the confirm page; page must not be a validity/era oracle | HMAC-signed unsubscribe token |
| operator environment → api/worker processes | `UNSUBSCRIBE_TOKEN_SECRET` and `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` cross at boot; zod schema (api), manual assertions (worker), `check-env.mjs` (predev) are the gates | HMAC signing secrets |
| process internals → log sink / Sentry | D-05 log line from `packages/delivery-core`'s package-local logger bypasses the redaction pipeline; call shape is the safeguard | `secretPosition` integer only |
| operator → deployment environment | Rotation is an operator env change plus restarts; the runbook is the only control on order of operations | Secret values (never committed) |
| repository → published documentation | `docker/prod.env.example`, `README.md`, `SPECIFICATION.md`, runbook are committed and readable by anyone with repo access | Variable names/purposes only |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-19-01 | Information Disclosure | `verifyUnsubscribeToken` per-candidate compare | high | mitigate | `timingSafeEqual` behind equal-length guard on every candidate; no raw equality (`unsubscribe-token.ts:123`) | closed |
| T-19-02 | Information Disclosure | `verifyUnsubscribeToken` loop iteration count | medium | mitigate | Exhaustive loop, no early break; `matchedIndex` recorded without terminating (`unsubscribe-token.ts:91-128`); call-count test in `unsubscribe-token-rotation.test.ts` | closed |
| T-19-03 | Information Disclosure | D-05 log call inside `verifyUnsubscribeToken` | high | mitigate | Log object carries only `{ secretPosition: matchedIndex }` integer (`unsubscribe-token.ts:161`); contents asserted directly in 19-04 tests; redaction rules added in 19-03 as defence in depth | closed |
| T-19-04 | Information Disclosure | `POST /unsubscribe/:token` response shape | high | mitigate | Route untouched (plan prohibition); byte-identical response assertions in `apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts` | closed |
| T-19-05 | Elevation of Privilege | multi-secret verification | high | mitigate | Previous secrets verify-only; `signUnsubscribeToken` uses primary resolver only; negative control test proves unlisted secret grants nothing | closed |
| T-19-06 | Denial of Service | malformed `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` (19-01 window) | medium | accept | Bounded to one commit: reader degrades safely (empty fragments never match); superseded by 19-02's fail-loud boot validation, now implemented at all three sites | closed |
| T-19-SC | Tampering | npm install of `pino` into `packages/delivery-core` | high | mitigate | No new package: `pino@10.3.1` already installed/audited (`apps/api`, `apps/worker`, `packages/contacts-core`); Phase 18 `check:dependency-advisories` gate covers the tree | closed |
| T-19-07 | Denial of Service | malformed `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` at boot | medium | mitigate | Fail-loud boot validation at all three sites: `apps/api/src/env.ts` (zod superRefine), `apps/worker/src/server.ts:204-223`, `scripts/check-env.mjs:157-202` | closed |
| T-19-08 | Information Disclosure | validation error messages | high | mitigate | Messages name variable, rule, 1-based position only — never a value or fragment; asserted by tests in 19-02 Tasks 2–3 | closed |
| T-19-09 | Tampering | unbounded retired-secret list | medium | mitigate | `MAX_UNSUBSCRIBE_PREVIOUS_SECRETS = 5` enforced at all three sites with parity guard (D-07, SC4) | closed |
| T-19-10 | Spoofing | retired secret re-entering service via primary slot while still listed previous | low | mitigate | Duplicate-of-primary rule rejected at boot (`check-env.mjs:192`, mirrored in api/worker validators) | closed |
| T-19-11 | Tampering | ambiguous list parsing (comma/whitespace inside a secret) | high | mitigate | D-03 charset rule on both variables at all three sites; makes delivery-core's comma split unambiguous | closed |
| T-19-12 | Information Disclosure | logged object carrying a signing-secret variable as field name | high | mitigate | Both env-var names added to redaction rule table (`packages/redaction/src/rules.ts:73,78`); compiled forms cover five nesting depths, proven by `rules-parity.test.ts` | closed |
| T-19-13 | Information Disclosure | secret reaching a log under an unenumerated field name | medium | accept | Documented pre-existing limitation of a field-name rule table (`pino-redact.ts` header); no value-pattern rule possible without false positives; bounded — env values are never logged directly in this codebase | closed |
| T-19-14 | Tampering | second rule literal drifting into a compiled form | medium | mitigate | Only `rules.ts` edited; parity test fails on divergence; untouched-file criterion covers the two consumers | closed |
| T-19-15 | Information Disclosure | POST response distinguishing previous-match from primary-match or forgery | high | mitigate | Four-way byte-identical assertion (primary-valid, previous-valid, unretained, forged) plus expired case in one test (`unsubscribe-rotation.test.ts`) | closed |
| T-19-16 | Information Disclosure | GET confirm page revealing token validity or era | high | mitigate | Page bodies compared across three token classes after placeholder substitution; page asserted non-mutating for previous-secret token | closed |
| T-19-17 | Information Disclosure | loop iteration count leaking matched position | medium | mitigate | HMAC invocation counts asserted equal across primary-match, last-previous-match, no-match, and equal to candidate count | closed |
| T-19-18 | Information Disclosure | D-05 log line carrying secret material | high | mitigate | Serialised log argument and message asserted to contain no secret values and no token-signature substring (vi.mock on package-local logger) | closed |
| T-19-19 | Repudiation | no evidence whether retired-secret links still arrive before pruning | low | mitigate | Position-carrying log line fires exactly once per previous-secret verification, never for primary (`matchedIndex > 0` gate, `unsubscribe-token.ts:160`) | closed |
| T-19-20 | Denial of Service | promoting a new primary before every process can verify it | high | mitigate | Runbook two-step ordering with explicit window warning; Step 1 requires restart on every service before Step 2 (`docs/runbooks/unsubscribe-secret-rotation.md:63-104`); proven live in UAT rotation rehearsal (2026-08-21) | closed |
| T-19-21 | Information Disclosure | secret value committed into template/README/SPECIFICATION/runbook | high | mitigate | Env template entry is an empty assignment (`docker/prod.env.example:210,220`); runbook examples are obvious placeholders; names/sources/purposes only | closed |
| T-19-22 | Repudiation | secret pruned without evidence its links are dead | medium | mitigate | Retention rule and per-secret dates in runbook rotation log and `SPECIFICATION.md` §Секреты; previous-secret-match log line gives observational evidence | closed |
| T-19-23 | Tampering | retention window silently shortening into an unstated default | medium | mitigate | D-06 recorded as named, published operator commitment in runbook and `SPECIFICATION.md:464` with inline rationale — shortening must be an argued change | closed |
| T-19-24 | Denial of Service | operator retaining more secrets than the boot bound allows | low | accept | Documented prerequisite: maximum stated in runbook Prerequisites; boot failure names variable and rule — loud and self-explanatory | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-19-01 | T-19-06 | Single-commit window in 19-01 where a malformed previous-secrets value degrades safely instead of failing loud; variable absent in every existing deploy (D-01); superseded by 19-02 boot validation in the same phase | plan 19-01 threat model | 2026-08-21 |
| AR-19-02 | T-19-13 | Field-name rule tables cannot enumerate all possible field names; a value-pattern rule for operator-generated random strings would match legitimate identifiers (`scrub-identifier-false-positive.test.ts` guards this); env values are never logged directly in this codebase | plan 19-03 threat model | 2026-08-21 |
| AR-19-03 | T-19-24 | Retaining more than `MAX_UNSUBSCRIBE_PREVIOUS_SECRETS = 5` secrets fails loud at boot with variable name and rule; documented as a runbook prerequisite rather than mitigated in code | plan 19-05 threat model | 2026-08-21 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-21 | 24 | 24 | 0 | gsd-secure-phase orchestrator (L1 short-circuit — plan-time register, grep-depth verification) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-21
