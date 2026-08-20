# Phase 19: Unsubscribe Secret Graceful Rotation - Context

**Gathered:** 2026-08-20
**Status:** Ready for planning

<domain>
## Phase Boundary

The operator can put a new unsubscribe signing secret into service without breaking a single already-mailed link. New mail is signed with the new primary secret; links signed by any retained previous secret still verify on both redemption paths (the GET link in the email and the RFC 8058 one-click urlencoded POST). The no-token-oracle invariant survives rotation: a forged or expired-secret token produces a byte-identical response to a valid one, with a timing-safe comparison performed per candidate secret. The retention window for previous secrets is an explicit, documented decision tied to the real 5-year token TTL. Requirements: ROT-01, ROT-02.

Non-negotiable (locked by ROADMAP success criteria, not discussion): timing-safe compare per candidate, byte-identical responses across all failure/success shapes, both GET and POST paths covered, the 5-year token TTL itself unchanged.

</domain>

<decisions>
## Implementation Decisions

### Secret supply format
- **D-01:** `UNSUBSCRIBE_TOKEN_SECRET` keeps its exact current meaning — the single primary (signing) secret. A NEW optional env var `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` holds a comma-separated, ordered list of retired secrets used for verification only. Absent var = empty list = the normal pre-rotation state. Zero migration: every existing deploy env file, test config, and check-env entry stays valid as-is.
- **D-02:** Full validation parity for the new var at boot: when present, every entry ≥ 32 chars, no empty entries, no duplicates (of each other or of the primary). Enforced at all three existing validation sites — `apps/api/src/env.ts` (zod), `apps/worker/src/server.ts` (boot check), `scripts/check-env.mjs` (dev presence check follows its existing optional-var conventions). A redaction rule for the new var goes into `packages/redaction` so it can never leak into logs/Sentry.
- **D-03:** Charset contract: validation rejects any secret (primary or previous) containing a comma or whitespace; documented as part of the operator contract. Keeps comma-separated parsing unambiguous. Secrets are operator-generated random strings, so this costs nothing in practice.

### Verification strategy
- **D-04:** Try-all loop, token format UNCHANGED: `verifyUnsubscribeToken` tries the primary first, then each previous secret in list order, with a timing-safe comparison per candidate (SC3's exact wording). No key id (kid) is added to tokens — already-sent tokens have no kid and live until ~2031, so the fallback loop must exist regardless; a kid would only optimize new tokens at the cost of a second token format. — **Reversibility:** reversible — a kid could be added to newly signed tokens later without breaking the loop.
- **D-05:** Observability for retirement decisions: on successful verification via a previous (non-primary) secret, emit a structured Pino log line recording the matched secret's list position — NEVER the secret value itself. Server-side only; the HTTP response stays byte-identical (no oracle). This is the operator's only evidence for whether old-secret links still arrive.

### Retention window (the roadmap's named Key Decision)
- **D-06:** **A previous secret is retained until 5 years after its last use as primary** — i.e., until the TTL of the last token it ever signed has elapsed. This is the only window that provably breaks zero links, which is the phase goal verbatim. Rotations are rare, so the list stays at 1-2 entries in practice. — **Reversibility:** costly — shortening it later knowingly kills live links; the decision is a published operator commitment recorded in SPECIFICATION.md and the runbook.
- **D-07:** Recording + enforcement split: the 5-year rule and each secret's retirement date live in documentation — SPECIFICATION.md §3 «Секреты» and the rotation runbook's rotation log. Code enforces one soft structural bound: a maximum previous-list length (~5 entries) rejected at boot, satisfying SC4's "not an unbounded list" without dates-in-env machinery.

### Rotation procedure
- **D-08:** Two-step runbook rotation, zero-window by construction: **Step 1** — add the new secret to `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` on ALL services and restart (every process can now verify it; nothing signs with it yet). **Step 2** — promote it to `UNSUBSCRIBE_TOKEN_SECRET`, move the old primary into `_PREVIOUS`, restart. Lands as a runbook entry (the repo's source-derived runbook-coverage gate applies).
- **D-09:** The runbook ends with a canary smoke of BOTH link eras via the standing canary workspace: redeem a fresh post-rotation link (proves new primary signs and verifies) AND a pre-rotation link kept from before the swap (proves previous-secret verification on the real path).

### Claude's Discretion
- Loop mechanics (early-exit on match vs. exhaustive evaluation), where the candidate-secret set is read (keep delivery-core's lazy `process.env` reads vs. parse-once), exact max-list-length constant, log field naming, runbook file naming, and test wiring for the new env var in vitest/playwright configs — planner/executor decide within the decisions above.
- Exact zod/check-env error message texts and check-env.mjs treatment of the optional var.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` — ROT-01, ROT-02 ("Unsubscribe Secret Rotation" section)
- `.planning/ROADMAP.md` — Phase 19 section: goal, 4 success criteria, plan-time decision on retention (now resolved by D-06/D-07)

### As-built documentation to update in the same change
- `SPECIFICATION.md` §3 «Секреты» — the new env var, its validation, and the retention decision MUST be documented here in the same change (hard project rule from `.claude/CLAUDE.md`); §6 if route behavior notes change
- `.claude/CLAUDE.md` — "Project Specification" section defines where new env vars get documented

### Token machinery (the code under change)
- `packages/delivery-core/src/unsubscribe-token.ts` — sign/verify implementation; `getSecret()` reads `process.env.UNSUBSCRIBE_TOKEN_SECRET` lazily; timing-safe compare already in place
- `apps/api/src/modules/delivery/unsubscribe.routes.ts` — both redemption paths (GET confirm page, POST mutate); byte-identical-response invariant documented inline (T-04-03-01/02, CR-01)
- `apps/worker/src/queues/send-dispatch.ts` — `UNSUBSCRIBE_TOKEN_TTL_SECONDS = 60*60*24*365*5` at line 51; two signing call sites (:325, :607)
- `apps/worker/src/queues/flows/flow-send.ts` — third signing call site (:186)

### Env validation sites (all three must gain the new var)
- `apps/api/src/env.ts` — zod schema (`UNSUBSCRIBE_TOKEN_SECRET: z.string().min(32)`)
- `apps/worker/src/server.ts` — manual boot check (:218-221)
- `scripts/check-env.mjs` — dev-only predev presence check

### Adjacent conventions
- `packages/redaction/src/rules.ts` — redaction rules; the new secret var needs an entry
- `apps/api/vitest.config.ts`, `apps/worker/vitest.config.ts`, `apps/web/playwright.config.ts` — hardcode the current test secret; test wiring for `_PREVIOUS` scenarios connects here
- Existing runbooks + `check-runbook-coverage` gate (Phase 15 convention) — the rotation runbook joins this set

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `verifyUnsubscribeToken` already does timing-safe compare and never-throws degradation — the rotation change is extending its single-secret compare into an ordered candidate loop, not rewriting it
- The route layer (`unsubscribe.routes.ts`) needs NO behavioral change: it consumes `verifyUnsubscribeToken`'s null-or-payload contract, which is unchanged
- Pino structured logging pipeline (Phase 15) for the previous-secret-match log line
- Standing canary workspace + smoke procedure (v1.1 UAT infrastructure) for D-09

### Established Patterns
- Env validation triple: zod in api, manual boot check in worker, presence check in check-env.mjs — the new var follows all three (D-02)
- Redaction-rule-per-secret convention in `packages/redaction`
- Runbook + source-derived coverage gate (Phase 15) — rotation runbook must register with the gate
- Byte-identical-response invariant has extensive inline threat-model documentation (T-04-03-0x) and existing tests — rotation tests extend these, never weaken them

### Integration Points
- `packages/delivery-core/src/unsubscribe-token.ts` — the only file where verification logic changes
- Three env validation sites + `.env` deploy files (operator-side)
- Both processes read env at boot only; there is no live-reload path for secrets — rotation is inherently env-change-plus-restart, which D-08's two-step procedure is built around

</code_context>

<specifics>
## Specific Ideas

- SC3's "timing-safe comparison per candidate secret" is interpreted literally: the loop performs `timingSafeEqual` for each candidate it evaluates — no short-circuit shortcuts that skip the timing-safe primitive.
- The previous-secret-match log (D-05) exists specifically to make D-06's retirement decision evidence-based rather than calendar-only: an operator can see whether previous-slot verifications still occur before pruning.
- The accept-no-oracle bar: the log line is the ONLY externally-invisible signal added; nothing about the HTTP response (status, body, headers, or which-secret-matched) may vary.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 19-Unsubscribe Secret Graceful Rotation*
*Context gathered: 2026-08-20*
