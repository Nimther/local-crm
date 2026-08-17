# Phase 16: Live SendGrid Verification - Context

**Gathered:** 2026-08-17
**Status:** Ready for planning

<domain>
## Phase Boundary

The milestone's release barrier: every delivery guarantee v1.1 claims is confirmed against the **real** SendGrid API and a **real inbox**, on the **deployed production environment** from Phase 14 — not against a mock. Covers UAT-01..05 (см. `.planning/REQUIREMENTS.md`): a live BYO-key send through a Dynamic Template arrives in a real inbox (UAT-01); real delivered/opened/clicked/bounced events land on the correct send, flow step and campaign (UAT-02); a genuinely signed webhook payload passes verification through the full HTTP stack and a redelivery of it counts exactly once (UAT-03/04); a real 429/transient error defers the affected tenant's sends and resolves without duplicate or lost mail (UAT-05).

This is a verification phase, not a feature phase — with **one deliberate exception**: the configurable SendGrid base URL seam that Phase 8 explicitly deferred here (`.planning/phases/08-quality-gates-failure-injection-foundation/08-CONTEXT.md`, D-22 + Deferred), plus the CI fixture/test fallout from UAT-03's captured payload (D-10 below).

**Already locked at ROADMAP level (do not re-litigate):**
- Phase 16 does not replace per-phase verification — Phases 8–15 verified locally against the failure-injection harness; this phase confirms against the real provider.
- Requires the deployed env + verified sender from Phase 14 (exists and is live-verified: deploy/rollback, backups, restore drill).
- UAT-05 spans Phase 11 (ambiguous outcomes) and Phase 12 (tenant fairness); UAT-03/04 span Phase 10 (signature/replay) and Phase 13 (dedup).

</domain>

<decisions>
## Implementation Decisions

### Tenant, inbox & environment setup

- **D-01:** **Tenant BYO key = a second API key from the one real SendGrid account** (the platform account with the Phase 14 verified sender), entered as the UAT workspace's BYO key through the normal key-entry flow. No second SendGrid account — the BYO code path is identical regardless of which account owns the key.
- **D-02:** **Receiving inboxes = operator's own real mailboxes** (1–2 addresses the operator controls, e.g. a Gmail plus the work address). The operator opens the mail and clicks the link by hand — real-inbox evidence, and Gmail's image-proxy/link handling is exactly the real-world condition open/click tracking must survive.
- **D-03:** **Environment = production VPS, dedicated UAT workspace** created for this phase. Verifies the actual release environment (real Caddy, real webhook URL, real TLS) while UAT contacts/sends stay fenced inside one tenant boundary the platform already isolates. No staging deploy.
- **D-04:** **Dynamic Template = create a minimal purpose-built UAT template** in the SendGrid account: a couple of handlebars variables (proves dynamic data flows) and a visible clickable link (generates the clicked event). Used by both the UAT campaign and the UAT flow — UAT-02's success criterion requires events attributed to a campaign AND a flow step, so both send kinds run.

### Inducing bounce & 429/transient live

- **D-05:** **Bounce (UAT-02) = send to a nonexistent mailbox at a real domain** that rejects unknown recipients — a genuine 550 hard bounce producing a real bounced webhook event. Researcher picks the most predictable rejecting domain. One bounce has negligible reputation impact.
- **D-06:** **429/transient (UAT-05) = land the Phase-8-deferred `SENDGRID_BASE_URL` seam + a pass-through fault proxy on the VPS.** The env var (read in `packages/delivery-core/src/send-mail.ts`, today hardcoding `https://api.sendgrid.com/v3/mail/send`) points the deployed worker at a tiny proxy that forwards to real SendGrid but injects one 429 (and one network timeout) on command. The worker experiences a real HTTP 429 through its production fetch path; the deferred send then resolves against real SendGrid to a real inbox. Genuinely exceeding the real rate ceiling rejected (not reproducible on demand, burns real sends). — **Reversibility:** reversible — the seam defaults to the real URL; the proxy is a UAT-session artifact.
- **D-07:** **Seam guardrails: env var with real-URL default + loud boot log.** Absent env var → behavior byte-identical to today. When the override IS set, the worker logs it prominently at boot so a forgotten proxy setting can't silently linger in prod. A NODE_ENV production-guard rejected (the UAT itself runs on the prod VPS — the guard would need an escape hatch, reducing it to ceremony). Phase 8's failure-injection tests MAY adopt the seam (kill the literal production entrypoint against a local stub) — planner discretion whether that lands here or is noted for later.
- **D-08:** **UAT-05 live scope = single tenant: defer + retry + exactly-once arrival.** The live proof is that the affected tenant's send is deferred on 429, retried, and lands exactly once in the real inbox (no duplicate, no loss). The "other tenants unaffected" half rests on Phase 12's CI two-tenant fairness evidence — no second live workspace.

### Webhook replay & dedup (UAT-03/04)

- **D-09:** **Redelivery = byte-exact re-POST of a captured genuinely-signed batch** through the public Caddy URL via curl. Capture the raw signed body + signature headers from a real event delivery (Phase 13's `ingress_journal` journals batches; researcher confirms whether signature headers are journaled or need capture at delivery time). Same bytes → signature still verifies (UAT-03's "genuinely signed, full HTTP stack"), and the duplicate must count exactly once (UAT-04). Forcing SendGrid's own 5xx-retry rejected as the dedup vehicle: a 5xx'd delivery is never ingested (fail-closed journal), so its retry isn't a true duplicate.
- **D-10:** **The captured payload becomes a committed CI fixture + integration test**, closing the flag carried since Phase 5 (no HTTP-signature-layer replay test exists; only worker-layer attribution). Fixture = raw body + signature headers + the verification public key; the test replays it through the full HTTP stack in CI. Payload contains only UAT-workspace data, so committing it is PII-safe.
- **D-11:** **Negative signature check included:** flip one byte in the captured body, re-POST — must be rejected by signature verification with nothing ingested. Same curl harness, proves verification discriminates rather than merely accepts.
- **D-12:** **"Counted exactly once" is proven at both layers:** exactly one `send_events` row for the dedup key `(workspace_id, send_id, event_type, occurred_at)` AND daily rollup / campaign counters unchanged by the second delivery.

### Execution & evidence

- **D-13:** **Execution = blocking real-host checkpoints per UAT test + scripted asserts** (the proven Phase 14 pattern). The executor stages everything (template, workspace, proxy, replay harness, exact commands); the operator performs the live actions (open the mail, click the link, run the staged commands) and approves the checkpoint on evidence. Verification queries are scripted so "passed" means a query returned the expected rows, not an eyeball.
- **D-14:** **Evidence artifact = one committed `16-UAT-REPORT.md`** mapping each of UAT-01..05 to its evidence (timestamps, `sg_message_id`, verification-query outputs, checkpoint approvals), plus per-plan SUMMARYs as usual. One place an auditor reads.
- **D-15:** **UAT workspace is kept as a standing canary** after the phase — the smoke-test workspace for future releases (rerun a live send after any risky deploy). Not erased, not deleted; fenced by tenant isolation.
- **D-16:** **Failure protocol = gap-closure plans in-phase:** a live failure is recorded in the UAT report, a gap-closure plan lands the fix, it deploys via `deploy.sh <sha>`, and the failed UAT test reruns from scratch (the G-15-4 pattern from Phase 15). Phase 16 completes only at 5/5 live passes.

### Claude's Discretion

- Fault-proxy implementation shape (tiny Node script vs off-the-shelf; where it runs in the compose topology; how injection is toggled).
- Exact bounce-target domain and address (D-05).
- Capture mechanics for the signed payload (ingress_journal vs delivery-time tee) and fixture file layout.
- UAT flow definition (what event triggers it) and campaign/segment shape in the UAT workspace — minimal versions that exercise the attribution paths.
- Plan breakdown (one plan per UAT test vs grouped), checkpoint wording, verification-query design.
- Whether Phase 8's failure-injection scenarios adopt the SENDGRID_BASE_URL seam in this phase or that's noted as a follow-up.
- SPECIFICATION.md/ARCHITECTURE.md update mechanics (SENDGRID_BASE_URL env var → §3; the seam → §5/§8 as applicable, per the binding CLAUDE.md rule).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements and phase boundary
- `.planning/ROADMAP.md` § Phase 16 — goal, 4 success criteria, "why UAT is its own final phase" rationale
- `.planning/REQUIREMENTS.md` — UAT-01..05 (lines ~137–141)

### Deployment substrate (where the UAT runs)
- `.planning/phases/14-deployment-database-durability/14-CONTEXT.md` — prod topology: single VPS, compose, Caddy public entry, GHCR images, `deploy.sh <sha>`, `MEGA_CRM_ENV_FILE`
- `docs/runbooks/production-topology.md` — as-built production layout
- `docs/runbooks/deploy-and-rollback.md` — the deploy/rerun mechanism D-16's gap-closure loop uses
- `docs/runbooks/reprovision-webhook-event-types.md` — webhook subscription provisioning (`POST /api/workspaces/:slug/webhook-reconnect`), needed when wiring the UAT workspace's webhook

### The seam and the send path
- `.planning/phases/08-quality-gates-failure-injection-foundation/08-CONTEXT.md` — D-22 + Deferred section: the explicit deferral of the configurable SendGrid base URL to Phase 16, and why the real worker entrypoint could never be used in failure scenarios
- `packages/delivery-core/src/send-mail.ts` — `sendTenantMailV3` with the hardcoded `https://api.sendgrid.com/v3/mail/send` (D-06's edit target), `SENDGRID_TIMEOUT_MS`, request shape (custom_args `send_id`/`workspace_id`/`campaign_id`, forced open/click tracking)
- `apps/worker/src/queues/send-dispatch.ts` — `ProcessSendJobDeps.sendMail` seam, 429 `rate_limited` deferral paths, ambiguous-outcome handling the live 429/timeout will traverse

### What the UATs verify (prior-phase contracts)
- `.planning/phases/11-delivery-correctness/11-CONTEXT.md` — send state machine, reconciling semantics, at-most-once delivery model
- `.planning/phases/12-worker-reliability-tenant-fairness/12-CONTEXT.md` — tenant-scoped rate_limited deferral (D-08's CI-evidence anchor)
- `.planning/phases/13-compliance-analytics-integrity/13-CONTEXT.md` — dedup key `(workspace_id, send_id, event_type, occurred_at)`, `ingress_journal` fail-closed journaling, replay-sweep semantics
- `apps/api/src/modules/webhooks/signature-verify.ts` (+ raw-body route exclusion in `apps/api/src/server.ts`) — the verification path UAT-03 exercises and D-10's CI test targets

### Documents that MUST be updated in the same change
- `SPECIFICATION.md` — §3 (new env var `SENDGRID_BASE_URL`; any proxy/UAT credentials), §2 if any new package lands, §8 if the seam diverges from the stack doc — per the binding rule in `.claude/CLAUDE.md`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`ProcessSendJobDeps.sendMail` seam + `sendTenantMailV3`** — the only SendGrid call site; D-06's env-var read is a one-line-scale change at `send-mail.ts:153`.
- **`ingress_journal` (Phase 13)** — already journals raw webhook batches before enqueue; the natural capture source for D-09's byte-exact replay.
- **Webhook provisioning flow** (`apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` + `webhook-reconnect` route) — creates the UAT workspace's signed webhook subscription against the real account.
- **Phase 14 checkpoint pattern + `deploy.sh <sha>`** — the execution and gap-closure machinery D-13/D-16 reuse verbatim.
- **Watchdog/ops evidence surface** — `send_events`, `workspace_daily_rollup`, campaign counters: the scripted asserts in D-12 query existing tables, nothing new.
- **Failure-injection npm scripts (Phase 8)** — the 429/timeout scenario vocabulary the fault proxy mirrors live.

### Established Patterns
- Blocking real-host checkpoints with operator approval on evidence (Phase 14: deploy, backups, restore drill; Phase 15: live redeploy confirmation).
- Fail-closed posture — the seam's default-real-URL + loud-log design follows it.
- Gap-closure plans within the phase until verification passes (Phase 15's G-15-4 loop).
- Env vars via `MEGA_CRM_ENV_FILE` outside the repo root; env_file (not compose interpolation) delivery per Phase 15 CR-01.

### Integration Points
- `packages/delivery-core/src/send-mail.ts` — SENDGRID_BASE_URL env read (the phase's only production-code change of substance).
- Prod compose on the VPS — where the fault proxy container/process lives for the UAT-05 session.
- CI test suite — the new HTTP-layer signed-replay integration test (D-10) joins existing gates.
- SendGrid account — new Dynamic Template, second API key (tenant BYO), webhook subscription for the UAT workspace.

</code_context>

<specifics>
## Specific Ideas

- **"Real inbox" means the operator's own mailbox** — a human opens the mail and clicks the link; Gmail's image proxy and link wrapping are part of what's being verified, not noise.
- **The proxy injects; SendGrid resolves** — the 429 is experienced through the production fetch path, but the recovery send must reach the real inbox via real SendGrid, exactly once.
- **A 5xx'd webhook delivery is not a duplicate** — the fail-closed journal means SendGrid's retry after a 5xx is a first ingest; only a byte-exact replay of an accepted batch tests dedup.
- **The UAT capture is an asset, not just evidence** — the signed payload becomes the CI fixture that closes a flag carried since Phase 5.
- **The UAT workspace outlives the phase** — a standing canary for post-deploy smoke tests on every future release.

</specifics>

<deferred>
## Deferred Ideas

- **Adopting the SENDGRID_BASE_URL seam in Phase 8's failure-injection scenarios** (killing the literal production entrypoint against a local stub) — planner may fold it in if cheap; otherwise an explicit follow-up. **Planning decision (2026-08-17): NOT folded into Phase 16** — the planner judged it out of scope for a verification phase (D-07 permitted either). Recorded here as the explicit follow-up D-07's Deferred section requires; pick up in a future quality/failure-injection phase.
- **Real rate-ceiling burst as bonus UAT-05 evidence** — rejected as the gate; could be attempted opportunistically but is not part of this phase's pass criteria.
- **Two-live-workspace fairness demonstration** — rests on Phase 12 CI evidence; revisit only if a real multi-tenant incident suggests the CI scenario diverges from production behavior.

</deferred>

---

*Phase: 16-live-sendgrid-verification*
*Context gathered: 2026-08-17*
