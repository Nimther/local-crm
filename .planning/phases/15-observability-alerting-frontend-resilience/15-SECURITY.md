---
phase: 15
slug: observability-alerting-frontend-resilience
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-16
---

# Phase 15 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

All 21 plans carried a plan-time `<threat_model>` block (`register_authored_at_plan_time: true`). Summary threat flags (15-05, 15-07, 15-11) reported no new threats beyond the plan-time registers. Classification ran at ASVS L1 (grep-depth evidence) against the implementation, on top of the phase's passed re-verification (15-VERIFICATION.md, 5/5 must-haves).

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| npm registry → build | Third-party packages enter the build and deployed images | Untrusted code |
| client → API | Inbound `x-request-id` echoed into logs and a Postgres session parameter | Attacker-controlled header |
| API → queue → worker | Job payloads cross process boundaries, deserialized by possibly-older builds | Correlation fields |
| tenant data → log stream → Alloy → Grafana Cloud Loki | Log lines leave the host to a third-party store | Tenant-derived fields (redacted at source) |
| application/browser → Sentry SaaS (EU) | Error events leave the trust boundary; no field-level retraction | Scrubbed exception events |
| API → browser | Error responses and freshness metadata rendered into operator-facing UI | Error detail text, watermarks |
| public internet → VPS | Caddy sole public entry; worker listener (Bull Board) never published | — |
| operator SSH session → loopback listener | Only access path to Bull Board | Queue/job introspection |
| Docker socket → Alloy container | Container discovery requires host Docker socket | Root-equivalent host access |
| platform tick → operator email | Alert bodies leave the system to an external mailbox | Counters/queue names only |
| SendGrid (external) → `send_events` row → log call site | Ingested event fields are provider/attacker-controlled freeform text | `reason`/`payload` (never logged) |
| repository docs → operator action / git history | Runbooks and SPECIFICATION drive production actions; content is permanent | Names/sources only, never values |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-15-SC | Tampering | npm installs (all plans; installs consolidated in 15-01) + `grafana/alloy` image pull (15-17) | high | mitigate | Blocking non-auto-approvable human legitimacy checkpoint approved before install (15-01-SUMMARY, `human_judgment: true` record); all later plans install nothing; Alloy image pinned to immutable tag enforced by prod-compose gate | closed |
| T-15-01 | Elevation of Privilege | `fastify` promoted to runtime dep in `apps/worker` | medium | mitigate | Listener loopback-bound, no prod `ports:` mapping; `scripts/validate-prod-compose.mjs` CI gate | closed |
| T-15-02 | Information Disclosure | `packages/redaction` Sentry dependency | medium | mitigate | devDependency only (type imports) | closed |
| T-15-03 | Tampering | `package-lock.json` concurrent-install corruption | medium | mitigate | All phase installs consolidated into wave-1 plan 15-01 | closed |
| T-15-04 | Tampering | `x-request-id` header echo in `genReqId` | medium | mitigate | Bounded-length safe charset, fallback to `crypto.randomUUID()`; opaque label only | closed |
| T-15-05 | Information Disclosure | correlation fields in every log line via `mixin()` | high | mitigate | Mixin returns ids only; pino redaction applies to the rest of the line | closed |
| T-15-06 | Denial of Service | `application_name` composed from unbounded inputs | medium | mitigate | Deterministic truncation to 63-byte budget, test-asserted | closed |
| T-15-07 | Tampering | additive `requestId` on job payload during rolling deploy | low | accept | See Accepted Risks Log (R-15-01) | closed |
| T-15-08 | Denial of Service | lazy chunk fetch failure after deploy | medium | mitigate | Route-level Suspense + route error boundary (`RouteErrorBoundary.tsx`) renders contained retryable panel | closed |
| T-15-09 | Tampering | chunk configuration silently not applied | low | mitigate | `scripts/check-web-chunks.mjs` asserts against real build manifest, fails closed | closed |
| T-15-10 | Information Disclosure | secret nested deeper than enumerated wildcard depth | high | mitigate | Extra enumerated depths + depth tests (`packages/redaction/src/__tests__/scrub.test.ts`); freeform payloads through `scrub()` | closed |
| T-15-11 | Information Disclosure | redaction config drift between processes | high | mitigate | `logger-uniformity.test.ts` + `rules-parity.test.ts` behavioural/source guards | closed |
| T-15-12 | Information Disclosure | value-shaped secret under unlisted key name | medium | accept | See Accepted Risks Log (R-15-02) | closed |
| T-15-13 | Information Disclosure | raw API error bodies rendered in error region | medium | mitigate | `QueryErrorState` renders fixed message + short status-derived detail only | closed |
| T-15-14 | Repudiation | silent load failure presented as empty list | high | mitigate | Error and empty are distinct persistent branches (15-05-SUMMARY confirms per-region split) | closed |
| T-15-15 | Information Disclosure | decrypted tenant SendGrid key in Sentry event | critical | mitigate | `sentryBeforeSend` routes event through `scrub()`; blocking fixture gate (`sentry-scrub-fixtures.test.ts` Scenario A) in required CI job | closed |
| T-15-16 | Information Disclosure | contact email/phone in caught error context | high | mitigate | Fixture Scenario B asserts zero occurrences across serialized event | closed |
| T-15-17 | Information Disclosure | tenant JSONB nested past enumerated depth reaching Sentry | high | mitigate | `scrub()` depth-unbounded value-pattern matching; Scenario C asserts 5-level nesting | closed |
| T-15-18 | Repudiation | refactor silently disabling scrub hook | medium | mitigate | Negative-control case asserts needle present without hook | closed |
| T-15-19 | Repudiation | failed key-status fetch rendered as "no key configured" | high | mitigate | Explicit error branch with distinct copy + Retry (15-07-SUMMARY: isFullyErrored/isStaleErrored split) | closed |
| T-15-20 | Information Disclosure | raw API error bodies on settings pages | medium | mitigate | Shared `QueryErrorState`, fixed message only | closed |
| T-15-21 | Repudiation | dashboard widget failure shown as zero activity | high | mitigate | Per-widget error regions, no page-level early return | closed |
| T-15-22 | Denial of Service | control-flow throws reported as failures | high | mitigate | Allowlist from real throw sites (`DelayedError`, `UnrecoverableError`) in `processor-wrapper.ts`, test-asserted | closed |
| T-15-23 | Repudiation | wrapper swallowing errors, breaking BullMQ retry/defer | critical | mitigate | Re-throw on every path asserted per thrown type incl. non-Error (`processor-wrapper.test.ts`); failure-injection suites re-run | closed |
| T-15-24 | Information Disclosure | tenant payload values in job log lines | high | mitigate | Pino redaction on every line; value-pattern scrubbing for freeform values | closed |
| T-15-25 | Tampering | future factory bypassing instrumentation | medium | mitigate | Filesystem-enumerating coverage test fails on bare processor argument | closed |
| T-15-26 | Repudiation | silent loss of unsaved canvas work | high | mitigate | Router blocker + `beforeunload` guard (`useUnsavedChangesGuard.ts`, wired in `FlowCanvas.tsx`); e2e spec exists (`flow-unsaved-changes.spec.ts`), live-DB run pending as UAT item | closed |
| T-15-27 | Repudiation | failed save presented as transient dismissible signal | high | mitigate | Persistent inline banner with Retry, clears only on successful save | closed |
| T-15-28 | Denial of Service | retry loop hammering draft endpoint | medium | mitigate | Single bounded delayed retry preserved; Retry control user-initiated only | closed |
| T-15-29 | Information Disclosure | Sentry event bodies leaving trust boundary (api/worker) | critical | mitigate | `sentryBeforeSend` on `beforeSend` + `beforeSendTransaction` (`apps/api/src/sentry.ts`, `apps/worker/src/sentry.ts`); tags ids-only | closed |
| T-15-30 | Information Disclosure | tracing/profiling as second unscrubbed channel | high | mitigate | Tracing sample rate 0, profiling disabled, test-asserted; `beforeSendTransaction` scrubbed as defence in depth | closed |
| T-15-31 | Denial of Service | control-flow throws flooding Sentry quota | high | mitigate | Capture wired only through reporter seam allowlist; zero-capture test for `DelayedError` | closed |
| T-15-32 | Denial of Service | hanging Sentry flush extending SIGTERM shutdown | medium | mitigate | Bounded flush timeout in shutdown sequence | closed |
| T-15-33 | Information Disclosure | DSN secret-handling inconsistency | low | mitigate | Backend DSNs via `MEGA_CRM_ENV_FILE`; frontend DSN's non-secret build-time handling documented in SPECIFICATION §3 (15-21) | closed |
| T-15-34 | Information Disclosure | Session Replay recording tenant screens | critical | mitigate | Replay integration structurally absent from `apps/web/src/lib/sentry.ts` (D-08), sample rates asserted zero by test | closed |
| T-15-35 | Information Disclosure | React props/state in render-error event | high | mitigate | `beforeSend` routes whole event through shared `scrub()` | closed |
| T-15-36 | Information Disclosure | genuine secret supplied via build-arg channel | medium | mitigate | SPECIFICATION §3 records channel is non-secret-DSN-only; DSN kept out of `prod.env.example` | closed |
| T-15-37 | Denial of Service | unbounded error loop re-mounting/re-reporting | medium | accept | See Accepted Risks Log (R-15-03) | closed |
| T-15-38 | Information Disclosure | `ops_alert_state` reachable from tenant-facing query | medium | mitigate | No `workspace_id`; read only by platform-side ticks on platform pool; documented in migration header | closed |
| T-15-39 | Tampering | two replicas sending same alert | medium | mitigate | Single-statement atomic claim keyed by alert name; two-connection concurrency test | closed |
| T-15-40 | Denial of Service | false staleness signal on quiet tenants | medium | mitigate | Lag from unreconciled dirty marks, never data age; dedicated test | closed |
| T-15-41 | Information Disclosure | new analytics fields leaking cross-tenant data | high | mitigate | Computed inside workspace-scoped repository query under RLS | closed |
| T-15-42 | Information Disclosure | tenant data in alert email body (queue monitor) | high | mitigate | Renderers emit queue names/counters/ages/reasons only; planted-value-absence test (`queue-depth-watchdog.test.ts`) | closed |
| T-15-43 | Repudiation | blind monitor reporting healthy | high | mitigate | Unreadable is distinct unhealthy state, separate result shape end-to-end | closed |
| T-15-44 | Denial of Service | alert storms from persistent condition | medium | mitigate | Per-alert-name dedup window via shared keyed claim | closed |
| T-15-45 | Denial of Service | throwing tick killing API process | medium | mitigate | Interval registration catches and logs (fire-and-forget catch pattern) | closed |
| T-15-46 | Tampering | provider-supplied `occurred_at` in lag computation | medium | mitigate | Lag measured from server-set receipt timestamp only | closed |
| T-15-47 | Denial of Service | rate-limit deferrals counted as failures → false outage alerts | high | mitigate | Terminal/non-terminal split from exported status vocabulary; deferral/reconciling cases test-asserted healthy | closed |
| T-15-48 | Denial of Service | share alerts on tiny samples | medium | mitigate | Minimum-sample-size constant with rationale + test | closed |
| T-15-49 | Information Disclosure | tenant data in alert email body (send-share/webhook-lag) | high | mitigate | Planted-value-absence tests (`failed-send-share-watchdog.test.ts`, `webhook-lag-watchdog.test.ts`) | closed |
| T-15-50 | Denial of Service | two watchdogs alerting on one incident | medium | mitigate | Webhook-lag module states distinction from ingestion-health watchdog, non-colliding window | closed |
| T-15-51 | Repudiation | stale analytics rendered as current | high | mitigate | Always-visible watermark + conditional delay banner driven by API lag value; fresh/delayed/no-data asserted separately | closed |
| T-15-52 | Repudiation | live figure labelled with rollup watermark | medium | mitigate | Only rollup-derived regions labelled | closed |
| T-15-53 | Denial of Service | false staleness banner on quiet tenants | medium | mitigate | Banner driven by outstanding-lag value, never data age | closed |
| T-15-54 | Elevation of Privilege | Bull Board reachable from public internet | critical | mitigate | Literal `127.0.0.1` bind (`bull-board.ts`), no prod `ports:` mapping (compose gate), SSH tunnel only access (D-09); bind host test-asserted | closed |
| T-15-55 | Tampering | job mutation from unauthenticated admin surface | high | mitigate | `readOnlyMode: true` on every `BullMQAdapter` | closed |
| T-15-56 | Denial of Service | changed `/healthz` `/readyz` contract breaking healthchecks | critical | mitigate | `health-server-contract.test.ts` written pre-change, required to pass unchanged | closed |
| T-15-57 | Denial of Service | leaked Redis connections from board queue handles | medium | mitigate | Every handle in shutdown registry; closure test-asserted | closed |
| T-15-58 | Information Disclosure | job payloads visible in Bull Board | medium | accept | See Accepted Risks Log (R-15-04) | closed |
| T-15-59 | Elevation of Privilege | `/var/run/docker.sock` mounted into Alloy sidecar | high | accept | See Accepted Risks Log (R-15-05) | closed |
| T-15-60 | Information Disclosure | tenant data in log lines leaving host | high | mitigate | Redaction applied at source in both processes; Alloy adds no unredacted source | closed |
| T-15-61 | Information Disclosure | Loki credentials in committed file | high | mitigate | `docker/alloy/config.alloy` reads all credentials via `env()`; no literal values (grep-verified) | closed |
| T-15-62 | Denial of Service | unbounded json-file logs exhausting VPS disk | high | mitigate | Bounded `logging:` blocks on all 9 services in `docker-compose.prod.yml` | closed |
| T-15-63 | Denial of Service | Loki index blow-up from high-cardinality labels | medium | mitigate | Labels limited to service/container/level; correlation ids stay in JSON body | closed |
| T-15-64 | Information Disclosure | plaintext log push | medium | mitigate | https push endpoint required, asserted in env example + docs | closed |
| T-15-65 | Information Disclosure | credentials pasted into runbook | medium | mitigate | Names/sources/purposes only; grep for credential-shaped literals across `docs/runbooks/` | closed |
| T-15-66 | Repudiation | alert shipping without recovery procedure | medium | mitigate | `scripts/check-runbook-coverage.mjs` enumerates alert names from source, fails on missing runbook, anti-vacuous count | closed |
| T-15-67 | Elevation of Privilege | future contributor exposing Bull Board publicly | high | mitigate | Runbook states no-login design + rejected alternatives; prod-compose gate independently forbids publishing the port | closed |
| T-15-19-01 | Information Disclosure | four new `logger.*` call sites in `send-dispatch.ts` | high | mitigate | Fields are internal UUIDs/fixed discriminators only; grep gate forbids `claim.to`/`testTo`/`dynamicTemplateData`/`apiKey`/`.email`; test asserts fixture recipient absent from serialized line | closed |
| T-15-19-02 | Information Disclosure | `sendId` written to logs and shipped to Loki | low | accept | See Accepted Risks Log (R-15-06) | closed |
| T-15-19-03 | Information Disclosure | ambiguity line in `handleAmbiguousSendMailError` | medium | mitigate | Logs only the two-value classification enum, never the thrown value/message/cause | closed |
| T-15-19-04 | Tampering | `withCorrelation` wrappers around live dispatch control flow | high | mitigate | Wrapper returns callback value directly, no branch added; five pre-existing dispatch suites re-run unchanged + `tsc --noEmit` + diff-stat file restriction | closed |
| T-15-19-05 | Denial of Service | log volume growth on Loki free tier (dispatch) | low | accept | See Accepted Risks Log (R-15-07) | closed |
| T-15-20-01 | Information Disclosure | `logger.info` inside webhook per-event loop | high | mitigate | Line carries closed-enum `eventType` + boolean + mixin UUIDs; `reason`/`payload` never referenced; grep gate + planted-email-in-reason absence test | closed |
| T-15-20-02 | Spoofing | `send.id` used as correlation value | low | accept | See Accepted Risks Log (R-15-08) | closed |
| T-15-20-03 | Tampering | correlation scope placement (per event vs per batch) | medium | mitigate | Two-sends-in-one-batch test asserts two distinct `sendId` values; fails against hoisted scope | closed |
| T-15-20-04 | Tampering | wrapping a call inside a live shared transaction | high | mitigate | No branch introduced; throw path still aborts enclosing transaction; four webhook suites re-run unchanged + `tsc --noEmit` | closed |
| T-15-20-05 | Denial of Service | log volume from high-rate webhook batches | low | accept | See Accepted Risks Log (R-15-09) | closed |
| T-15-21-01 | Information Disclosure | SPECIFICATION §3 Sentry rows | high | mitigate | Names/sources/mechanism only; negative grep for DSN-shaped literal across whole file; transcription from compose comments, not secrets files | closed |
| T-15-21-02 | Repudiation | §3 row misdescribing secrets delivery | high | mitigate | Corrected rows carry mechanism + rationale; verify step re-asserts fact against `docker-compose.prod.yml` directly | closed |
| T-15-21-03 | Spoofing | ARCHITECTURE §18 correlation-coverage overclaim | medium | mitigate | Per-field presence with boundaries; region-scoped negative + positive verify checks | closed |
| T-15-21-04 | Tampering | scope creep from documentation plan into code | medium | mitigate | `git diff --name-only` zero-code-extension gate + `verify:prod-compose` re-run | closed |
| T-15-21-05 | Tampering | correcting one doc while sibling asserts opposite | medium | mitigate | §18 + SPECIFICATION §7 treated as one unit; both stale literals grepped to zero across whole files | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| R-15-01 | T-15-07 (low) | Additive optional `requestId` field on job payload is ignored by older worker builds during rolling deploy; no `schemaVersion` change, defer-unknown-version path never triggered. | plan 15-02 threat model (plan-time disposition) | 2026-08-16 |
| R-15-02 | T-15-12 (medium) | Value-shaped secret under an unlisted key name is structurally out of reach for a key-path matcher; `scrub()`'s value rules are the control and the boundary is asserted explicitly by a test so it cannot be silently forgotten. | plan 15-04 threat model | 2026-08-16 |
| R-15-03 | T-15-37 (medium) | Route error boundary renders a static fallback rather than re-rendering the failing subtree; Sentry SDK-side rate limiting bounds report volume from any residual loop. | plan 15-11 threat model | 2026-08-16 |
| R-15-04 | T-15-58 (medium) | Job payloads visible in Bull Board are inherent to queue introspection and scoped to an operator who already holds SSH and database access; the loopback/SSH network control is the boundary. | plan 15-16 threat model | 2026-08-16 |
| R-15-05 | T-15-59 (**high**) | Docker-socket access is effectively root-equivalent on the host and Alloy's container discovery requires it. Bounded by: read-only mount, single pinned-tag first-party-vendor sidecar, no published port. Accepted as the cost of the chosen log-shipping mechanism (D-02) rather than mounted silently. | plan 15-17 threat model | 2026-08-16 |
| R-15-06 | T-15-19-02 (low) | `sends.id` is a server-generated UUID (UUIDv5 from send intent, never contact PII), already present in SendGrid `custom_args`, unsubscribe token payload, and Sentry tags (D-06); logging it grants no new capability and buys OPS-11 correlation. | plan 15-19 threat model | 2026-08-16 |
| R-15-07 | T-15-19-05 (low) | One `info` line per claimed send on a path bounded by per-tenant RPS ceiling; json-file driver capped 10m×5 per service. | plan 15-19 threat model | 2026-08-16 |
| R-15-08 | T-15-20-02 (low) | Correlation binds `send.id` read back under RLS inside `withTenant`, never provider-supplied `custom_args.send_id`; forged markers resolve to nothing before any scope opens (UUID shape guard, live-send re-resolution, sibling-workspace drop, loop re-check). | plan 15-20 threat model | 2026-08-16 |
| R-15-09 | T-15-20-05 (low) | One `info` line per newly inserted, non-test, resolvable event; replays/duplicates filtered by `ON CONFLICT DO NOTHING` before the loop; json-file driver capped. | plan 15-20 threat model | 2026-08-16 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-16 | 83 (82 numbered threats + 1 consolidated T-15-SC row spanning all 21 plans) | 83 | 0 | gsd-secure-phase (L1 grep-depth, short-circuit: plan-time register, threats_open 0, ASVS 1) |

### Audit notes (2026-08-16)

- Register authored at plan time in all 21 PLAN.md files; summaries 15-05/15-07/15-11 flagged no new threats.
- L1 evidence verified for every critical and high threat: `sentry-scrub-fixtures.test.ts` (T-15-15/16/17), structural replay absence in `apps/web/src/lib/sentry.ts` (T-15-34), `bull-board.ts` loopback bind + `readOnlyMode` (T-15-54/55), `health-server-contract.test.ts` (T-15-56), `processor-wrapper.ts` allowlist + re-throw tests (T-15-22/23/31), `packages/redaction` depth/uniformity/parity tests (T-15-10/11), watchdog planted-value-absence tests (T-15-42/49), `docker/alloy/config.alloy` env()-only credentials (T-15-61), 9 bounded `logging:` blocks (T-15-62), `check-web-chunks.mjs` / `validate-prod-compose.mjs` / `check-runbook-coverage.mjs` gates (T-15-09/54/66), `useUnsavedChangesGuard.ts` + `FlowCanvas.tsx` wiring (T-15-26/27), `withCorrelation` in `send-dispatch.ts` and webhook path (T-15-19-04/T-15-20-04), 15-01-SUMMARY human-checkpoint approval record (T-15-SC).
- Outstanding runtime confirmations carried as UAT items in 15-VERIFICATION.md (not open threats — code mitigations verified present): (1) RouteErrorBoundary browser click-through (no DOM test env in repo; relates to T-15-08/R-15-03), (2) `flow-unsaved-changes.spec.ts` run against a live e2e DB (relates to T-15-26/27 — guard code and e2e spec exist; live run pending), (3) live Sentry DSN provisioning, (4) live Grafana Cloud provisioning (operator-side setup, no threat mapping).

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-16
