# Phase 16: Live SendGrid Verification - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-17
**Phase:** 16-live-sendgrid-verification
**Areas discussed:** Tenant & inbox setup, Inducing bounce & 429 live, Webhook replay method, Execution & evidence

---

## Tenant & inbox setup

| Option | Description | Selected |
|--------|-------------|----------|
| Same account as platform (Recommended) | Second API key from the one real SendGrid account (verified sender from Phase 14) entered as the UAT workspace's BYO key | ✓ |
| Separate second SendGrid account | Distinct account as the tenant — closest to real multi-tenancy but needs second signup/verification/template | |

**User's choice:** Same account as platform

| Option | Description | Selected |
|--------|-------------|----------|
| Operator's own mailboxes (Recommended) | 1–2 real addresses the operator controls; opens/clicks by hand; Gmail proxy/link handling is the real-world condition | ✓ |
| Dedicated fresh test address | New mailbox purely for UAT | |
| Mail-testing service (Mailosaur etc.) | API-driven inbox; scripted assertions but less "real user" evidence, paid dependency | |

**User's choice:** Operator's own mailboxes

| Option | Description | Selected |
|--------|-------------|----------|
| Prod VPS, dedicated UAT workspace (Recommended) | Real release environment; UAT data fenced in its own tenant boundary | ✓ |
| Prod VPS, existing workspace | Less setup; UAT data mixes into existing analytics | |
| Separate staging deploy | Cleanest isolation but no longer the released environment; doubles substrate | |

**User's choice:** Prod VPS, dedicated UAT workspace

| Option | Description | Selected |
|--------|-------------|----------|
| Create minimal UAT template (Recommended) | Purpose-built Dynamic Template: handlebars variables + clickable link; used by UAT campaign and flow | ✓ |
| Reuse an existing template | Use whatever already exists in the account | |
| You decide | Researcher/planner picks at execution time | |

**User's choice:** Create minimal UAT template

---

## Inducing bounce & 429 live

| Option | Description | Selected |
|--------|-------------|----------|
| Nonexistent mailbox, real domain (Recommended) | Made-up address at a domain rejecting unknown recipients → genuine 550 hard bounce | ✓ |
| Address known to bounce | Old/dead address known to reject | |
| You decide | Researcher picks the bounce-target strategy | |

**User's choice:** Nonexistent mailbox, real domain

| Option | Description | Selected |
|--------|-------------|----------|
| Configurable base URL + fault proxy (Recommended) | Land Phase-8-deferred SENDGRID_BASE_URL seam; VPS proxy forwards to real SendGrid, injects one 429/timeout on command | ✓ |
| Genuinely exceed the real rate ceiling | Burst real sends to draw an actual 429 — not reliably reproducible | |
| Both: proxy as baseline, real burst as stretch | Proxy is the gate; burst recorded as bonus evidence | |

**User's choice:** Configurable base URL + fault proxy

| Option | Description | Selected |
|--------|-------------|----------|
| Single tenant: defer + resolve (Recommended) | Live proof of defer→retry→exactly-once arrival; fairness half rests on Phase 12 CI evidence | ✓ |
| Two live workspaces | Second concurrent workspace demonstrating unaffected flow | |

**User's choice:** Single tenant: defer + resolve

| Option | Description | Selected |
|--------|-------------|----------|
| Env var, real default, loud log (Recommended) | Absent var = byte-identical behavior; override logged prominently at boot | ✓ |
| Env var + non-prod-only guard | Additional production boot guard — needs an escape hatch anyway | |
| You decide | Planner picks guardrail shape | |

**User's choice:** Env var, real default, loud log

---

## Webhook replay method

| Option | Description | Selected |
|--------|-------------|----------|
| Byte-exact re-POST of captured payload (Recommended) | Captured raw signed batch re-POSTed via curl through public Caddy; signature verifies; duplicate counts once | ✓ |
| Force SendGrid redelivery via 5xx | 5xx'd delivery is never ingested (fail-closed journal) — retry isn't a true duplicate | |
| Both | Replay as gate + one 5xx retry as bonus | |

**User's choice:** Byte-exact re-POST of captured payload

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, tampered replay too (Recommended) | Flip one byte, re-POST — must be rejected with nothing ingested | ✓ |
| Positive check only | Rejection paths stay unit-test-only | |

**User's choice:** Yes, tampered replay too

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — capture becomes CI fixture (Recommended) | Signed payload committed as fixture + CI integration test through full HTTP stack; closes carried Phase 5 flag | ✓ |
| No — keep phase pure UAT | Flag keeps being carried | |

**User's choice:** Yes — capture becomes CI fixture

| Option | Description | Selected |
|--------|-------------|----------|
| DB row + analytics counter (Recommended) | One send_events row for dedup key AND rollup/campaign counters unchanged | ✓ |
| DB row only | Ledger-level assertion only | |
| You decide | Planner picks assertion set | |

**User's choice:** DB row + analytics counter

---

## Execution & evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Checkpoints + scripted asserts (Recommended) | Blocking real-host checkpoint per UAT test; executor stages, operator acts, scripted queries define "passed" | ✓ |
| Fully manual runbook | Operator executes a written runbook end-to-end | |
| Maximally scripted runner | One UAT script drives everything automatable | |

**User's choice:** Checkpoints + scripted asserts

| Option | Description | Selected |
|--------|-------------|----------|
| One UAT report + per-plan SUMMARYs (Recommended) | Committed 16-UAT-REPORT.md maps UAT-01..05 to evidence; SUMMARYs carry execution detail | ✓ |
| Per-plan SUMMARYs only | No extra report document | |
| You decide | Planner picks artifact shape | |

**User's choice:** One UAT report + per-plan SUMMARYs

| Option | Description | Selected |
|--------|-------------|----------|
| Keep as standing canary (Recommended) | UAT workspace becomes the smoke-test workspace for future releases | ✓ |
| Erase via the erasure path | Bonus live exercise of erasure, destroys the canary | |
| Delete raw | Admin SQL drop; exercises nothing | |

**User's choice:** Keep as standing canary

| Option | Description | Selected |
|--------|-------------|----------|
| Gap-closure plans in-phase (Recommended) | Record failure → fix plan → deploy.sh <sha> → rerun test; phase completes at 5/5 (G-15-4 pattern) | ✓ |
| Severity-dependent | Blocking fixes in-phase; minor findings carried | |
| You decide | Planner encodes the protocol | |

**User's choice:** Gap-closure plans in-phase

---

## Claude's Discretion

- Fault-proxy implementation shape, compose placement, injection toggle
- Exact bounce-target domain/address
- Signed-payload capture mechanics (ingress_journal vs delivery-time tee) and fixture layout
- UAT flow trigger and campaign/segment shape in the UAT workspace
- Plan breakdown, checkpoint wording, verification-query design
- Whether Phase 8's failure-injection scenarios adopt the seam now or as follow-up
- SPECIFICATION.md/ARCHITECTURE.md update mechanics

## Deferred Ideas

- Adopting SENDGRID_BASE_URL seam in Phase 8 failure-injection scenarios (if not folded in)
- Real rate-ceiling burst as bonus UAT-05 evidence (not a gate)
- Two-live-workspace fairness demonstration (rests on Phase 12 CI evidence)
