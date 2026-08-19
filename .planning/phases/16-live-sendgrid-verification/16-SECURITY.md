---
phase: 16
slug: live-sendgrid-verification
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-19
---

# Phase 16 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| operator workstation → production VPS | UAT commands executed against the live release environment | operator credentials, env configuration |
| platform worker → real SendGrid API | Real tenant API key used to send real mail to a real recipient | tenant BYO SendGrid key (high sensitivity) |
| SendGrid Event Webhook → public Caddy endpoint | Untrusted signed event payloads cross into the platform | signed webhook bytes, recipient addresses |
| process environment → tenant send path | `SENDGRID_BASE_URL` can redirect where real tenant mail is sent | outbound tenant mail |
| application logs → log pipeline (Loki, Sentry) | Raw webhook capture puts recipient addresses into the log stream | recipient addresses (PII, UAT-only) |
| container logs → operator workstation → repository | A raw signed payload moves from logs into a committed fixture | signed payload with recipient data |
| committed repository → every developer and CI runner | The committed fixture is distributed with the repo | UAT recipient event data only |
| production worker → fault proxy → real SendGrid | Real tenant mail routed through an injectable intermediary for one session | tenant API key in authorization header |
| compose network → fault proxy control endpoint | Unauthenticated control surface inside the compose network (session-scoped) | fault-mode control commands |
| UAT session configuration → ongoing production state | Session-scoped seams could persist into normal operation | env overrides, tolerance widening |
| retained UAT workspace → production tenant data | Canary workspace lives alongside real tenants indefinitely | tenant-isolated canary data |
| committed evidence artifact → repository readers | Session identifiers and addresses recorded permanently | operator-owned addresses, ids only |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-16-01 | Information Disclosure | `scripts/uat-verify.mjs` database reads | medium | mitigate | All queries scoped via `withTenant` (17 call sites verified); no `SCAN_DATABASE_URL` reference in the script | closed |
| T-16-02 | Information Disclosure | `docs/runbooks/uat-live-sendgrid.md` | medium | mitigate | Runbook grep for SendGrid-key and private-key shapes returns zero matches | closed |
| T-16-03 | Tampering | UAT workspace on shared production database | medium | mitigate | UAT workspace is a normal tenant behind existing Phase 10 RLS; no step disables or bypasses any policy | closed |
| T-16-04 | Spoofing | Tenant BYO key handling | low | mitigate | Key entered via existing key-entry flow, stored under existing KMS envelope encryption; absent from runbook, plans, and SUMMARYs | closed |
| T-16-05 | Repudiation | UAT verdicts | medium | mitigate | Verdicts recorded from `uat-verify.mjs` exit codes and row counts with timestamps in SUMMARYs; checkpoint approvals recorded verbatim | closed |
| T-16-06 | Spoofing | Cross-workspace event attribution on shared SendGrid account | medium | mitigate | Sibling-drop path unchanged; `event-coverage` query tenant-scoped through `withTenant` | closed |
| T-16-07 | Denial of Service | Sender reputation of shared SendGrid account | medium | accept | See Accepted Risks Log (R-16-01) | closed |
| T-16-08 | Information Disclosure | Bounce/recipient addresses in runbook and SUMMARY | low | mitigate | Only operator-owned addresses used; runbook credential-shape grep clean | closed |
| T-16-09 | Tampering | Verification verdict integrity | medium | mitigate | `event-coverage` fails naming missing types and unattributed send ids; soft bounce explicitly a non-pass in the runbook | closed |
| T-16-10 | Tampering / DoS | `SENDGRID_BASE_URL` left set in production | high | mitigate | Default is real endpoint; worker boot warn on every boot while set (`apps/worker/src/server.ts` + `sendgrid-base-url-boot-log.test.ts`); teardown verified absent by observation (16-07 checkpoint, 5/5) | closed |
| T-16-11 | Information Disclosure | Raw webhook capture logging recipient addresses | high | mitigate | Capture keyed to one exact workspace id via `WEBHOOK_RAW_CAPTURE_WORKSPACE_ID`, default-off; teardown verified — fresh canary delivery produced no capture line | closed |
| T-16-12 | Spoofing | Capture placed before signature verification | high | mitigate | Capture inserted after both gates; `webhooks-raw-capture.test.ts` asserts no capture line for unverified requests | closed |
| T-16-13 | Information Disclosure | Capture-active workspaces externally distinguishable | medium | mitigate | Capture adds no response branch; tests assert identical status/body for capture-active vs inactive on accepted and rejected paths | closed |
| T-16-14 | Tampering | Seam applied to platform system mail or key-check calls | medium | mitigate | `SENDGRID_BASE_URL` read only in `packages/delivery-core/src/send-mail.ts` (tenant send path) and worker boot-warn in `server.ts`; system-mail and key-check call sites untouched | closed |
| T-16-15 | Information Disclosure | Committed fixture containing third-party data | high | mitigate | Operator decoded and inspected the batch under 16-04's blocking gate; fixture README records provenance and confirms only throwaway UAT recipient data | closed |
| T-16-16 | Spoofing | Replay endpoint accepting a forged payload | high | mitigate | Byte-flip discrimination check was a blocking acceptance criterion; route unmodified by the plan | closed |
| T-16-17 | Elevation of Privilege | Widened webhook timestamp tolerance left in place | high | mitigate | Restoration a numbered runbook step; effective value read back at 16-07 teardown checkpoint — production default confirmed | closed |
| T-16-18 | Repudiation | Dedup verdict based on the wrong layer | medium | mitigate | Assertion encodes both layers with explicit polarity (journal grows, send_events fixed at one, counters unchanged) | closed |
| T-16-19 | Denial of Service | Replay traffic against production webhook endpoint | low | accept | See Accepted Risks Log (R-16-02) | closed |
| T-16-20 | Information Disclosure | Committed fixture distributed with the repository | high | mitigate | Fixture inspected under 16-04's blocking gate; `fixtures/README.md` records provenance, inspection gate, and replacement procedure | closed |
| T-16-21 | Tampering | Future change silently weakening the freshness gate | high | mitigate | Test sets no `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` override (asserted); frozen-clock mechanism documented in code comment | closed |
| T-16-22 | Repudiation | Vacuous test greening on a deleted/malformed fixture | medium | mitigate | Fixture-integrity block imports without try/catch, no skip helper; renaming the fixture reddens the suite | closed |
| T-16-23 | Spoofing | Verifier that accepts everything reading as a pass | high | mitigate | Negative cases present in `webhooks-signature-replay.test.ts`: one-byte mutation rejection and wrong-public-key rejection | closed |
| T-16-24 | Tampering | Rate-limit fault mode forwarding upstream (duplicate real send) | high | mitigate | No-forward rule asserted by test counting stub upstream requests at zero (`uat-fault-proxy.test.mjs`); live checkpoint counted mailbox copies | closed |
| T-16-25 | Denial of Service | Timeout mode dropping the connection (lost mail, stuck row) | high | mitigate | Forward-then-delay asserted by test (exactly one upstream request, latency above margin); reconciler closure observed live | closed |
| T-16-26 | Elevation of Privilege | Unauthenticated fault-proxy control endpoint | medium | accept | See Accepted Risks Log (R-16-03) — conditions enforced and proxy torn down | closed |
| T-16-27 | Tampering | Endpoint override left set after the fault session | high | mitigate | Boot warning fires while set; teardown numbered in runbook; 16-07 checkpoint verified absence by fresh-boot observation | closed |
| T-16-28 | Tampering | Fault proxy leaking into a normal deploy | high | mitigate | Proxy lives only in `docker/docker-compose.uat-proxy.yml`; production compose contains zero references (grep-verified); `verify:prod-compose` passed | closed |
| T-16-29 | Information Disclosure | Tenant API key transiting the proxy | medium | mitigate | Proxy forwards authorization header without logging headers/bodies; ran only inside the compose network for one session, removed at teardown | closed |
| T-16-30 | Tampering / DoS | Endpoint override surviving the phase | high | mitigate | Verified by fresh worker boot-log observation at the 16-07 teardown checkpoint (5/5); boot warning remains the standing detector | closed |
| T-16-31 | Information Disclosure | Raw-capture variable surviving the phase | high | mitigate | Verified by observation: fresh canary delivery produced no `UAT16_WEBHOOK_RAW_CAPTURE` marker line | closed |
| T-16-32 | Elevation of Privilege | Fault proxy or control endpoint surviving the phase | high | mitigate | Service absent from the running stack and port unanswered from off-host (16-07 checkpoint); override file referenced by no deploy path | closed |
| T-16-33 | Elevation of Privilege | Widened timestamp tolerance surviving the phase | high | mitigate | Effective value read back at teardown — production default confirmed | closed |
| T-16-34 | Information Disclosure | Evidence artifact carrying credentials or third-party addresses | medium | mitigate | Grep acceptance criterion rejects key/private-key shapes; only operator-owned addresses; report records identifiers, not secrets | closed |
| T-16-35 | Spoofing | Retained canary workspace mistaken for or used as a real tenant | low | mitigate | Workspace stays behind existing Phase 10 tenant isolation; documented as the canary in the runbook; no special privilege granted | closed |
| T-16-SC | Tampering | npm/pip/cargo installs (all 7 plans) | high | mitigate | No package installed in any plan (Package Legitimacy Audit: none); only `package.json` change was the `uat:verify` npm script invoking already-installed `tsx`; fault proxy deliberately dependency-free | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| R-16-01 | T-16-07 | One deliberate hard bounce against an operator-controlled domain has negligible reputation impact (D-05); volume is one message, target is not a third party | plan 16-02 (operator-approved checkpoint) | 2026-08-19 |
| R-16-02 | T-16-19 | Two additional replay requests during one operator session against an endpoint built for provider-volume traffic; existing API rate limit unchanged | plan 16-04 (operator-approved checkpoint) | 2026-08-19 |
| R-16-03 | T-16-26 | Unauthenticated proxy control endpoint accepted only under three enforced conditions: no published port in the override file (asserted — `docker-compose.uat-proxy.yml` has no `ports:` mapping), off-host unreachability confirmed at the checkpoint, and removal at teardown (verified by 16-07 checkpoint). The compose network is not internet-reachable | plan 16-06 (operator-approved checkpoint) | 2026-08-19 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-19 | 34 | 34 | 0 | /gsd-secure-phase (L1 grep-depth verification, short-circuit — register authored at plan time, ASVS 1) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-19

---

## Notes

- Two residual UAT observations from 16-07-SUMMARY (historical-workspace-absence unasserted; flow-editor UI error boundary) are operational follow-ups outside this phase's threat register — neither maps to a registered threat and neither is a security exposure.
