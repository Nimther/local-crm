# Project Research Summary

**Project:** Mega CRM v1.2 "Data Lifecycle & Delivery Trust"
**Domain:** Multi-tenant B2C email-marketing SaaS (compliance milestone)
**Researched:** 2026-08-20
**Confidence:** HIGH for architecture/stack; MEDIUM for pitfall prevention patterns

---

## Executive Summary

v1.2 is a **compliance and trust milestone**, not a feature-driven release. Five narrowly-scoped capabilities—campaign template correctness, per-contact data export (GDPR Art. 15/20), physical workspace purge, unsubscribe-link secret rotation, and dependency-audit CI gating—close gaps in an already-shipped production SaaS (v1.0 + v1.1, 95/95 requirements validated). All five are **table-stake expectations** that auditors and regulators expect from any serious email-marketing platform.

The research finding is **unambiguous and HIGH confidence: no new runtime dependencies are required for any of the five features**. Stack research confirms Fastify/Drizzle/BullMQ/React are already sufficient; the only new addition is **OSV-Scanner v2.5.1**, a CI-only vulnerability-scanning tool (not an npm package). This means the codebase is architecturally stable and the milestone's complexity is not about dependency integration, but about careful reasoning around compliance evidence, data isolation, and resumable background work.

**Primary risk:** The two largest features—workspace purge (irreversible, multi-table) and DSR export (PII-sensitive, cross-table join)—carry compliance risks if built carelessly. Workspace purge can silently destroy compliance evidence or weaken tenant isolation if a partition-drop pattern or RLS bypass is used; DSR export can leak other data subjects' PII if freeform JSONB fields are exported verbatim. Both risks are **preventable with the right patterns** (reuse Phase 13's erasure-scrub checkpointed shape and allowlist discipline; reuse Phase 15's RLS-scoped query discipline). The third-largest feature, unsubscribe-secret rotation, carries a non-obvious sizing risk: existing tokens have a **5-year TTL**, so a "previous secrets" list must be retained much longer than the standard webhook-rotation guides suggest (hours-to-days), not dropped early.

**Recommendation:** Ship in the order 5→4→1→2→3 (smallest, safest, most independent features first). Phase 5 (CI gate) is a quick win that then protects all subsequent dependency changes. Phases 4 and 1 are self-contained, no schema changes. Phase 2 (DSR export) can be shipped as a synchronous, bounded query before Phase 3's larger purge machinery. **Phase 3 (workspace purge) should be planned last**, after features 1–2 are stable, because it requires resolving two architectural decisions at plan time (privilege-grant vs dedicated-DSN for cross-tenant `organization` deletion; explicit closure on the pre-existing campaigns_scan/flows_scan soft-delete gap).

---

## Key Findings

### Recommended Stack

**Finding:** No new runtime dependencies. The existing stack (Fastify 5.9, React 19, Drizzle 0.45, BullMQ 5.79, Postgres 16+, Redis 7) is complete for the four data-lifecycle features. One CI-only tool addition:

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **OSV-Scanner** | v2.5.1 | Dependency-vulnerability CI gate (feature 5) | Actively maintained by Google (near-weekly releases through 2026), federated vulnerability DB (OSV.dev + GHSA + NVD), native `osv-scanner.toml` config with explicit `IgnoreVulns` block (id + ignoreUntil + reason), purpose-built for the "proven-unreachable tooling findings" acceptance mechanism the milestone requires |
| **google/osv-scanner-action** | v2.5.1 | GitHub Actions wrapper for OSV-Scanner | Same release cadence; two reusable workflows (PR-diff + scheduled full-scan) map cleanly onto "NEW via PR" and "newly-published against existing dep" advisory detection |

**Why not alternatives:** `audit-ci` (IBM, last release 2024-07-03 — dormant for 2+ years), `better-npm-audit` (stale since 2024-09-09), bare `npm audit` (no accept-list mechanism). All three are "solving a dependency-hygiene problem with a stale tool," which is self-defeating.

**What's already sufficient:**
- Template correctness (feature 1): fix in existing campaign-send path, no dependencies
- DSR export (feature 2): Fastify `reply.send()` with `Content-Disposition` header, reuse existing `timeline.repository` query shape
- Workspace purge (feature 3): extend existing Phase 13 erasure-scrub checkpointed pattern, no new libraries
- Unsubscribe rotation (feature 4): `node:crypto` `createHmac`/`timingSafeEqual` (already used elsewhere), no JWT/jose libraries

### Expected Features

All five features are **table-stake compliance expectations**, not differentiators (except DSR export UX is more polished than Klaviyo's segment-of-one workaround):

| Feature | Scope | Complexity | User/Compliance Value |
|---------|-------|-----------|----------------------|
| Campaign template correctness | Bug fix in existing send/launch/schedule/test-send paths | LOW–MEDIUM | HIGH (trust-destroying if wrong — "what I configured is what goes out") |
| DSR contact export (GDPR Art. 15/20) | One-click downloadable file for any workspace member | MEDIUM | HIGH (legal requirement) + polished UX |
| Workspace physical purge (after retention) | Checkpointed deletion of soft-deleted workspace after 30–90 day grace period | HIGH | HIGH (legal requirement, highest engineering risk) |
| Unsubscribe-secret rotation | Primary + previous-secrets list, graceful override of breaking webhook-rotation patterns | MEDIUM–HIGH | MEDIUM (risk reduction on a legally-required mechanism) |
| Dependency hygiene CI gate | OSV-Scanner + accept-list (osv-scanner.toml) | LOW–MEDIUM | MEDIUM (audit/engineering hygiene) |

**Key dependency:** Features 2 and 3 both enumerate "what counts as a contact's personal data" (profile + custom properties + consent history + events + send-related PII). **Do not let these enumerations diverge** — use a shared inventory so export is never more or less complete than purge, and so compliance claims stay honest.

### Architecture Approach

All five features attach to the existing four moving parts (web, api, worker, CI) with **no new processes, no new queue topologies, no new databases, no changes to RLS mechanics**. Three points ground this high-confidence assessment:

1. **Architecture is deterministic, not inferential**: Every finding is based on reading actual files (`SPECIFICATION.md` §1-8, source code line-number-specific reads for features 1–4, live `npm audit` output for feature 5), not best-practice guesses.

2. **Patterns are already proven**: Features 2 and 3 reuse Phase 13's checkpointed-scrub shape and evidence-allowlist discipline; Feature 5 reuses the Phase 8 CI quality-gate pattern; Feature 4 reuses existing HMAC/`crypto.timingSafeEqual` infrastructure.

3. **Build order is discovery-based, not theoretical**: The suggested order (5→4→1→2→3) emerges from dependencies discovered during architecture read: Feature 5 (CI) protects all subsequent changes but is independent; Features 4 and 1 are self-contained; Feature 2's keyset-pagination discipline on partitioned tables becomes fresh during implementation and directly informs Feature 3's batched-delete design; Feature 3's privilege-grant decision can only be resolved at plan time, so it must come last.

**Major components affected:**
1. **Web (React)** — dirty-guard + send-action guard on campaign builder (feature 1); DSR export button on contact card (feature 2); no purge UI changes (existing soft-delete already exists)
2. **API (Fastify)** — server-side template-id echo check (feature 1); DSR export route + timeline reuse (feature 2); workspace-purge-watchdog (10th dead-man's-switch, feature 3); unsubscribe-token multi-secret verification (feature 4)
3. **Worker (BullMQ)** — workspace-purge + workspace-purge-reclaim workers (feature 3), checkpointed per-table deletes
4. **CI (.github/workflows)** — new check:dependency-audit step (feature 5)
5. **Database** — one new platform-ops table (`workspace_purge_state`, feature 3, no RLS, no FK to org); no schema changes for features 1/2/4/5

### Critical Pitfalls

Research identified **17 distinct pitfalls** across the five features. Top 5 require explicit prevention during planning:

1. **DSR export leaks other data subjects' PII through freeform JSONB** (Pitfall 1) — event `properties` and send-event `payload` are tenant-defined JSON; a naive "dump the whole row" export ships embedded PII (another contact's email, order ID). **Prevention:** Evidence-allowlist for JSONB keys (reuse Phase 13's approach), not a deny-list. Test with a synthetic "other person's" field and confirm it's excluded.

2. **Workspace purge drops shared time-partitions** (Pitfall 5) — events/send_events are partitioned by month, not tenant. A partition-drop pattern (copied from Phase 14's retention machinery) is catastrophic here: any given partition holds all tenants' rows, and dropping it destroys sibling workspaces' data. **Prevention:** Batch deletes (`DELETE ... WHERE workspace_id = $1 LIMIT N`, keyset paginated) inside live partitions, never partition-drop. Test purging workspace A leaves workspace B's rows in the same monthly partition unchanged.

3. **Purge runs against ineligible workspace** (Pitfall 10a) — eligibility (soft-deleted AND past retention window) checked only at enqueue time. A workspace restored between enqueue and execution, or a mis-targeted purge, causes irreversible full data loss. **Prevention:** Re-verify eligibility inside the purge transaction itself, refuse (not skip) if check fails. Test: enqueue purge, restore workspace before worker processes it, assert worker refuses.

4. **Unsubscribe-secret retention underestimated** (Pitfall 11) — webhook-rotation guides assume hours-to-days overlap windows; "previous secrets keep working" combined with this project's actual **5-year token TTL** means previous secrets must be retained for years, not dropped early. **Prevention:** Make retention window an explicit operational decision tied to sent-link lifetime (conservatively: order of magnitude same as event/send-log retention per Phase 14, or effectively indefinite until operator decides). This is NOT a code detail, it's a compliance decision.

5. **Workspace purge weakens RLS via BYPASSRLS or owner connection** (Pitfall 6) — the purge worker needs to act outside a normal tenant session to delete across all tables for the target workspace. An expedient "just disable RLS" or "connect as table owner" weakens isolation permanently. **Prevention:** Reuse existing `mega_crm_scan` least-privilege admin-scan-policy pattern (migrations 0039, 0041–0045): dedicated role with narrow admin-policy requiring `workspace_id = $target` in its WHERE clause. Never introduce `BYPASSRLS` or `DISABLE ROW LEVEL SECURITY`.

6. **Purge is non-idempotent across crash** (Pitfall 8) — single unchunked transaction across many tables with FK ordering, no resumability. Mid-crash leaves workspace half-purged with no clean path to re-run. **Prevention:** Checkpointed worker (reuse Phase 12/13 sweep pattern) with a `workspace_purge_state` evidence table. Each batch is idempotent (`DELETE ... WHERE workspace_id = $1 AND <not-already-purged>`). Test with actual SIGKILL mid-purge, re-run to completion.

---

## Implications for Roadmap

Based on combined research, suggested phase structure (5 phases for 5 features):

### Phase 1: Dependency Audit CI Gate (Feature 5)

**Rationale:** Smallest, most independent feature; zero product-code coupling to features 1–4; once shipped, it protects every subsequent phase's own dependency changes.

**Delivers:**
- `scripts/check-dependency-audit.mjs` (runs `npm audit --omit=dev --json`, parses vulnerabilities, fails on HIGH+ not in accept-list)
- `dependency-audit-acceptance.json` (modeled on `coverage-baseline.json`, each accepted advisory has id, severity, reason, owner, expiry)
- `.github/workflows/ci.yml` integration (new `check:dependency-audit` step in static job)

**Avoids Pitfalls:**
- Alert fatigue (Pitfall 15): accept-list distinguishes new untriaged from previously accepted
- Stale acceptances (Pitfall 16): every entry carries owner + expiry/review date, scope to `--omit=dev` for runtime signal

**Stack:** Node builtins (`node:child_process`, same house style as existing `check:*` scripts)

---

### Phase 2: Unsubscribe-Secret Graceful Rotation (Feature 4)

**Rationale:** Small, self-contained; no schema changes; no cross-feature dependencies; no DB privilege decisions needed. Completes before DSR/purge so the unsubscribe mechanism is stable during subsequent feature testing.

**Delivers:**
- `packages/delivery-core/src/unsubscribe-token.ts` — multi-secret verification (primary, then each previous in order)
- Env config: `UNSUBSCRIBE_TOKEN_SECRETS_PREVIOUS` (optional, comma-separated)
- Operational decision documented: retention window for previous secrets (tied to sent-link lifetime, per Pitfall 11)

**Avoids Pitfalls:**
- Retention underestimation (Pitfall 11): explicit, documented retention policy (not a default)
- Timing-safety break (Pitfall 12): `crypto.timingSafeEqual` per secret, aggregate response identical across all outcomes
- Missed POST path (Pitfall 13): both GET unsubscribe link and RFC 8058 urlencoded POST routed through same verification function
- Unbounded list decay (Pitfall 14): per-secret expiry timestamp, operator-visible active-secrets list with expiry schedule

**Architecture:** No new tables, no new workers, pure code change to one file + env plumbing

---

### Phase 3: Campaign Template Correctness (Feature 1)

**Rationale:** Self-contained to campaigns module (web + api); no schema change; localized bug fix in existing send/launch/schedule/test-send path.

**Delivers:**
- Client: dirty-guard on template/segment/sender in CampaignBuilderPage, propagate unsaved-changes flag to LaunchScheduleActions/TestSendPanel
- API: `expectedTemplateId` field on launch/schedule/test-send routes, server re-validates `existing.templateId === expectedTemplateId` under FOR UPDATE
- Regression fix: exercise all three send paths (launch, schedule, test-send) with identical "change template then send" scenario

**Avoids Pitfalls:**
- Partial fix (Pitfall 17): fix applied to all three send paths identically, not just the reported one
- Client autosave race (Pitfall 18): dirty flag gates send actions, pass server-confirmed template_id, not local form state

**Architecture:** No new dependencies, no schema changes, reuses existing `CampaignStateError` / error-code pattern

---

### Phase 4: Per-Contact DSR Export (Feature 2)

**Rationale:** Implements as synchronous, index-bounded query; no async machinery needed. Query is bounded by `(workspace_id, contact_id)` indexes on every source table (verified against SPECIFICATION.md), so per-contact scope is fundamentally different from workspace scans. Should exist before anything gets physically purged, both operationally and as a verification tool during Phase 5's testing.

**Delivers:**
- `apps/api/src/modules/contacts/dsr-export.repository.ts` — keyset-paginated union of contacts + custom properties + subscription history + events + sends (reuse `timeline.repository` shape)
- `GET /api/workspaces/:slug/contacts/:id/export` route — synchronous stream with `Content-Disposition: attachment; filename="contact-<id>-export.json"`
- Guard: refuse export of already-anonymized contact with typed error `contact_anonymized`, not silent empty file

**Escalation path (future, not v1.2):** If a single contact's event history grows to a pathologically large size, the same query becomes an unbounded row-scan. If that becomes real, implement degraded response via `statement_timeout` (return partial export + error message), or move to async BullMQ job pattern — not needed until evidence of the problem exists.

**Avoids Pitfalls:**
- JSONB PII leakage (Pitfall 1): evidence-allowlist for freeform event/payload keys (test with synthetic "other person's" field)
- Cross-tenant leakage (Pitfall 2): queries strictly `WHERE workspace_id = $1 AND contact_id = $2`, under ordinary RLS session, never scan role (negative test: sibling-workspace contact id returns nothing)
- Timeout / PII-in-logs (Pitfall 3): error paths route through existing scrub() gate; no special PII disclosure risk vs other contact-querying routes
- Export of erased contact (Pitfall 4): design export's behavior for post-erasure row shapes (anonymized profile, scrubbed payloads, erasure_records evidence); test with Phase 13 erasure fixtures

**Architecture:** One new route, reuses existing timeline query, no schema changes, no workers

---

### Phase 5: Physical Workspace Purge (Feature 3)

**Rationale:** Largest and highest-risk; reserve for last so Features 1–4 are stable and their keyset-pagination/RLS disciplines are fresh; resolves two architectural decisions at plan time (grant-migration vs dedicated-DSN; quiesce-gap closure scope).

**Delivers:**
- New `workspace_purge_state` table (platform ops, no RLS, no FK to org) — one row per purged workspace, resume cursors (JSONB), per-table deletion evidence
- `apps/worker/src/queues/workspace-purge.worker.ts` — checkpointed, batched per-table deletes (FK-dependency order), secrets deletion before org-row deletion
- `apps/worker/src/queues/workspace-purge-reclaim.worker.ts` — periodic tick, same crash-recovery shape as erasure-scrub-reclaim
- `apps/api/src/modules/ops/workspace-purge-watchdog.ts` — 10th dead-man's-switch (same ops_alert_state primitive)
- Privilege decision (resolve at plan time): either (a) grant-migration adding `DELETE` on `organization` to `mega_crm_app` (simpler, wider privilege surface), or (b) dedicated elevated DSN (PARTITION_RELOCATION_ADMIN_DATABASE_URL pattern, more code, consistent with project precedent for privilege escalation)
- Quiesce decision (resolve at plan time): before physically deleting, cancel scheduled/sending campaigns and pause live flows for the target workspace (addresses verified gap: campaigns_scan/flows_scan don't check org.deletedAt today)

**Avoids Pitfalls:**
- Partition drop (Pitfall 5): batch deletes inside live partitions, reuse Phase 12/13 sweep shape
- RLS bypass (Pitfall 6): admin-scan-policy pattern, never BYPASSRLS
- Compliance evidence destruction (Pitfall 7): explicit exclusion list (`erasure_records`, suppression hashes survive purge), test that evidence rows survive
- Non-idempotent crash (Pitfall 8): checkpointed worker, real SIGKILL test, reusability proof
- In-flight job crash (Pitfall 9): queue-drain check before removing tenant secrets, dead-letter (not retry) on residual decrypt failure
- Backup overclaiming (Pitfall 10): documentation explicitly caveat: purged data persists in encrypted pgBackRest backups until retention window expires
- Mis-targeted workspace (Pitfall 10a): re-verify eligibility inside purge transaction, refuse if check fails, test restored-between-enqueue-and-execution scenario

**Architecture:** One new worker + reclaim + watchdog, one new platform-ops table, privilege-grant decision per (a) or (b) above, FK-driven deletion order enumeration required, no schema changes to domain tables

### Phase Ordering Rationale

1. **Feature 5 (CI) first:** Protects all subsequent work; no product-code coupling; independent of 1–4.
2. **Feature 4 (rotation) next:** Smallest compliance fix; self-contained; stable before export/purge are built.
3. **Feature 1 (template) third:** Self-contained; localized fix; no dependencies on 2/3/5.
4. **Feature 2 (DSR) fourth:** Requires DSR export to work before purge deletes anything; keyset-pagination discipline from this phase informs Phase 5's batch-delete design.
5. **Feature 3 (purge) last:** Highest risk; benefits from Features 1–2 already merged and stable; privilege/quiesce decisions resolved after design discussions in earlier phases.

### Research Flags

Phases likely needing deeper research during planning:

- **Phase 5 (Workspace Purge):** Complex multi-table topology with FK ordering constraints; privilege-grant vs dedicated-DSN decision impacts schema/env/pool architecture; quiesce-gap closure decision (cancel campaigns/pause flows vs file as separate tech debt) must be explicit; PITR backup retention documentation for compliance claims. Recommend 1-2 day spike on purge architecture before implementation.

Phases with standard patterns (skip research-phase):

- **Phases 1, 2, 4:** All reuse proven patterns (CI gates, HMAC verification, Fastify file-download). Can move directly to implementation planning.
- **Phase 3 (Campaign):** Localized bug fix in well-understood send path. Standard product-fix workflow.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| **Stack** | **HIGH** | Direct package metadata verification (npm registry, GitHub API) for OSV-Scanner v2.5.1 and google/osv-scanner-action. Alternatives evaluated via GitHub repo metadata (last-commit/last-release dates confirm audit-ci/better-npm-audit stale). No assumption gaps. |
| **Features** | **MEDIUM** | Features scoped via PROJECT.md requirements (HIGH confidence) and competitor analysis (web search, MEDIUM confidence). Complexity estimates grounded in codebase reads (timeline.repository, unsubscribe-token.ts, campaign.repository). Feature interactions (DSR/purge enumeration divergence) are reasoning-from-architecture, not verified. |
| **Architecture** | **HIGH** | Every integration grounded in source code reads with line numbers where useful (SPECIFICATION.md §1-8, feature 1 component reads, feature 3 table enumeration). Build order is discovery-based from dependency graph read, not inference. No "assumed best practice" gaps. |
| **Pitfalls** | **MEDIUM** | Generic patterns (multi-secret verification, partition-drop risks, sync vs async export) cross-checked via web search (multiple sources agree). Project-specific interactions (Phase 13 erasure allowlist precedent, Phase 14 partition-drop vs batch-delete distinction, 5-year token TTL implication) are primary-source grounded but reasoning-from-spec rather than verified by separate test. Pitch-specific precedent facts (04-14 gap-closure, Phase 13 `applyUnsubscribeWithSendFact` unification) are HIGH confidence (project history). |

**Overall confidence:** **HIGH** — architecture and stack are well-grounded; pitfall patterns are standard but project-specific interactions add some reasoning risk; no show-stoppers identified.

### Gaps to Address

1. **Feature 2 (DSR export): Permission scope** — Should any workspace member trigger an export, or only owner/admin (`requirePermission` gate)? Product/compliance decision, not resolved by research.

2. **Feature 3 (Workspace purge): Privilege grant decision** — Grant-only migration vs dedicated-DSN? Both options are viable; architectural choice requires team consensus on risk/complexity tradeoff.

3. **Feature 3 (Workspace purge): Quiesce-gap closure scope** — Is "cancel scheduled/sending campaigns and pause live flows" part of Feature 3's scope, or a separate tech-debt fix? Must be explicit at plan time to avoid half-measures.

4. **Feature 4 (Unsubscribe rotation): Previous-secret retention policy** — How long to keep previous secrets? Operational decision with real deadline (token TTL), not a code detail. Should be documented as a Key Decision before implementation.

5. **Feature 5 (CI gate): `drizzle-kit` reclassification** — `npm audit` finds drizzle-kit's esbuild chain carries MODERATE findings but drizzle-kit is dev-only. Should it be moved to devDependencies (accurate to actual usage) as part of Feature 5, or just accept-listed? Doubles as a minor dependency-hygiene improvement.

---

## Sources

### Primary Research Files (HIGH)
- `.planning/research/STACK.md` — Direct npm registry verification (npm view, GitHub API) for all packages; cross-checked against first-party documentation (OSV-Scanner docs, google/osv-scanner-action repo)
- `.planning/research/FEATURES.md` — Codebase cross-check for all existing features; competitor analysis (Klaviyo, Mailchimp, Braze GDPR/purge/rotation practices via public docs)
- `.planning/research/ARCHITECTURE.md` — Exhaustive source-code reads with line-number citations; SPECIFICATION.md §1-8 read in full; table enumeration verified against schema definition
- `.planning/research/PITFALLS.md` — 17 pitfalls with prevention strategies, cross-checked against web sources and project-specific precedents (Phase 13 erasure decisions, Phase 14 partition pattern, Phase 4 gap-closure history)

### Codebase Sources (HIGH)
- `SPECIFICATION.md` (dated 2026-07-15, actively maintained through Phase 17)
- Direct file reads: `apps/web/src/features/campaigns/*`, `apps/api/src/modules/campaigns/campaign.repository.ts`, `apps/worker/src/queues/send-dispatch.ts`, `packages/delivery-core/src/unsubscribe-token.ts`, `.github/workflows/ci.yml`, root `package.json`
- Live command output: `npm audit --omit=dev --json` (run 2026-08-20)

### Project Context (HIGH)
- `PROJECT.md` (v1.2 milestone scope, 5 features, Active requirements)
- Codebase conventions (CLAUDE.md, fail-closed patterns, evidence-based verification)
- Phase history (Phase 13 erasure patterns, Phase 14 partition retention, Phase 8 CI gates, etc.)

---

**Research completed:** 2026-08-20
**Ready for roadmap:** Yes — all five features scoped, build order suggested, architectural decisions identified, pitfalls enumerated with prevention strategies.
