---
gsd_state_version: 1.0
milestone: v1.2
milestone_name: Data Lifecycle & Delivery Trust
current_phase: 20
current_phase_name: Campaign Template Correctness
status: executing
stopped_at: Phase 20 context gathered
last_updated: "2026-08-21T07:37:54.293Z"
last_activity: 2026-08-21
last_activity_desc: Phase 19 complete, transitioned to Phase 20
progress:
  total_phases: 5
  completed_phases: 2
  total_plans: 15
  completed_plans: 9
  percent: 40
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-08-21 after Phase 19)

**Core value:** Маркетолог настраивает триггерную цепочку или кампанию — и письма надёжно и вовремя доходят до нужных контактов, со сквозным отслеживанием статусов (delivered/opened/clicked/bounced).
**Current focus:** Phase 20 — Campaign Template Correctness

## Current Position

Phase: 20 — Campaign Template Correctness
Plan: Not started
Status: Ready to execute
Last activity: 2026-08-21 — Phase 19 complete, transitioned to Phase 20

Progress: [████░░░░░░] 40% (2/5 v1.2 phases complete)

### Milestone v1.2 phase map

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 18 | Dependency Hygiene & Advisory Gate | DEP-01..03 | ✅ Complete (2026-08-20) |
| 19 | Unsubscribe Secret Graceful Rotation | ROT-01..02 | ✅ Complete (2026-08-21) |
| 20 | Campaign Template Correctness | TMPL-01..03 | Not started |
| 21 | Per-Contact DSR Export | DSR-01..04 | Not started |
| 22 | Workspace Quiesce & Physical Purge | PRG-01..06 | Not started |

Execution order: 18 → 19 → 20 → 21 → 22 (dependency gate first protects every later phase's dependency changes; purge last — largest surface, irreversible, two plan-time architectural decisions).

## Performance Metrics

- Total plans completed across milestones: 224 (v1.0: 96, v1.1: 128)
- v1.1: 929 commits, 716 files changed, ~139k LOC TypeScript total (was ~57k after v1.0)
- Per-plan execution metrics for v1.1 live in the archived phase summaries (`milestones/v1.1-phases/`)

## Accumulated Context

### Decisions

Full decision log lives in PROJECT.md (Key Decisions) and the archived phase summaries/CONTEXT files in `.planning/milestones/v1.0-phases/` and `.planning/milestones/v1.1-phases/`.

### Open decisions to resolve at plan time (v1.2)

| Phase | Decision | Why it cannot be settled now |
|-------|----------|------------------------------|
| 21 | JSONB inclusion/redaction rule for `events.properties` / `send_events.payload` (DSR-03) | Requires analysis of what other-subject data tenant-defined JSON can hold; must be shared with Phase 22's PII inventory so export and purge never diverge |
| 22 | Privilege model for cross-tenant deletion: grant migration on `organization` vs dedicated elevated DSN | Architectural tradeoff (privilege surface vs code volume); project has precedent for both |
| 22 | Exact quiesce mechanism closing the `campaigns_scan`/`flows_scan` gap (neither checks `organization.deletedAt` today) | Scope call: part of PRG-06 or separate fix — research demands it be explicit to avoid a half-measure |

Research flag: **Phase 22 needs deeper research at plan time** (multi-table FK ordering, privilege model, PITR-backup caveat for compliance claims). Phase 21 reuses proven patterns (Fastify file download); Phase 20 is a localized product fix. (Phase 18 done: drizzle-kit question closed. Phase 19 done: retention window settled as D-06 — retired secret kept 5 years from when it was last primary, recorded in the rotation runbook + SPECIFICATION.md; code enforces only `MAX_UNSUBSCRIBE_PREVIOUS_SECRETS = 5` at the three boot validators (D-07); live production rotation rehearsal passed, security review 24/24 threats closed.)

### Open Items Carried Forward (not blockers)

**Tech debt accepted at v1.1 close** (full wording in MILESTONES.md and `milestones/v1.1-MILESTONE-AUDIT.md`):

- ⚠️ Phase 9: live operator-alert email (platform key → `OPERATOR_ALERT_EMAIL`) never observed by a human; all layers to `sgMail.send()` proven by injected-seam tests
- ⚠️ Phase 13: remaining live compliance walkthroughs — unsubscribe atomicity, timezone-independence, erasure end-to-end (incl. quarantine survive-then-expire), out-of-bounds event integrity, backfill + reputation alerts. Phase 16 already covered CMP-07 dedup and CMP-01 replay-idempotency live
- ⚠️ Phase 15: all OPS-13 alert thresholds and `STALE_DATA_LAG_THRESHOLD_MINUTES=15` are flagged assumptions pending real load (constants/files named in the runbooks' Threshold Tuning sections)
- ⚠️ Phase 15: API-side Sentry gap — an exception inside route-level `withTenant(...)` reaches Sentry without `workspace_id` (`request_id` survives); documented + executable test; fix = ~10 route modules
- ⚠️ Phase 15: two UI follow-ups from the 15-07 sweep — `LaunchConfirmDialog` (failed audience breakdown silently hides the card, launch button stays active), `CsvImportWizard` (`if (!status)` conflates loading with a dead fetch, no error state/Retry)
- ⚠️ Phase 15: bullmq 5.79.1→5.79.4 lockstep bump (peer requirement of `@bull-board/api@8.6.1`) — technically verified, awaits explicit human ratification of the classification (15-16, coverage D8)
- ⚠️ Phase 16 residuals: historical 16-01/16-02 workspace's continued existence not independently checked; an unconfirmed flow-editor error-boundary observation from an interrupted session has no evidence artifact

**Research flags carried since v1.0:**

- Segmentation benchmark at 100k–1M contacts still outstanding — segments run on-the-fly bounded by statement_timeout; revisit materialized membership if broadcast audience selects hit the timeout at scale
- SCALE-02: PgBouncer explicitly deferred (Phase 14 D-09); revisit trigger = real `max_connections` pressure

**Operational prerequisites (any fresh environment):**

- `PLATFORM_SENDGRID_API_KEY` / `PLATFORM_MAIL_FROM` must be a real SendGrid key + verified sender before verification/reset/invite/operator-alert emails work. The env file lives OUTSIDE the working root — resolved via `MEGA_CRM_ENV_FILE`; `.env` in the repo root is blacklisted by the hygiene check
- `REDIS_URL=redis://localhost:6379` required (in the externally-resolved env file) before `npm run dev` boots api+worker
- Known dev-sandbox issue: `npm run db:migrate` (drizzle-kit CLI) hangs under Node v26 — migrations proven via `test:migrations` but must be applied to the dev DB by other means

### Quick Tasks Completed

| # | Description | Date | Commit | Status | Directory |
|---|-------------|------|--------|--------|-----------|
| 260722-q4t | Создать README.md в корне репозитория | 2026-07-22 | 939b816 | | [260722-q4t-readme-md](./quick/260722-q4t-readme-md/) |
| 260727-sfk | Audit SPECIFICATION.md as-built + relocate CLAUDE.md maintenance rule | 2026-07-27 | b63ca82 | Verified | [260727-sfk-specification-md-as-built-claude-md-spec](./quick/260727-sfk-specification-md-as-built-claude-md-spec/) |
| 260809-eqr | Close Phase 10 residual review findings WR-06/WR-07 + sync STATE.md to Phase 11 | 2026-08-09 | ebc754c | Complete | [260809-eqr-close-phase-10-residual-review-findings-](./quick/260809-eqr-close-phase-10-residual-review-findings-/) |
| 260811-qit | Append Codex follow-up review section to Phase 13 REVIEWS.md | 2026-08-11 | b37e7bd | Verified | [260811-qit-append-codex-follow-up-review-section-to](./quick/260811-qit-append-codex-follow-up-review-section-to/) |

## Deferred Items

Items acknowledged and deferred at milestone close on 2026-08-20 (open-artifact audit):

| Category | Item | Status | Disposition |
|----------|------|--------|-------------|
| quick_task | 260818-aqd-add-a-production-safe-file-backed-kek-pr | incomplete | Tasks 1–2 implemented and committed; Task 3 (production provisioning, deploy, live SendGrid UAT) is operator-only and intentionally not executed — carry into next milestone or run as an operator session |
| debug | docker-npm-ci-lockfile-desync | resolved at close | Root cause found 2026-08-13; fix shipped as gap-closure plan 14-14 (npm-10 lockfile repair + fail-loud guard); file moved to `debug/resolved/` during this close |
| debug | knowledge-base | false positive | `debug/knowledge-base.md` is the resolved-sessions knowledge base gsd-debugger reads, not an open session |
| uat | Phase 16 16-UAT-REPORT.md "unknown" | false positive | Report states 5/5 live requirements passed 2026-08-18; audit parser could not read its status format; 0 pending scenarios |

## Session Continuity

Last session: 2026-08-21T05:50:13.538Z
Stopped at: Phase 20 context gathered
Resume file: .planning/phases/20-campaign-template-correctness/20-CONTEXT.md

## Operator Next Steps

- **Plan the next phase:** `/clear` then `/gsd-discuss-phase 20` (Campaign Template Correctness) to gather context — or `/gsd-plan-phase 20` to plan directly.
- Deferred candidates explicitly NOT in v1.2 (still tech debt): SCALE-02 (PgBouncer), segmentation benchmark at target volume, remaining live walkthroughs (operator-alert email, Phase 13 compliance), Phase 15 UI follow-ups + threshold tuning, KEK quick-task 260818-aqd Task 3.
- Branch note: v1.1 closed on `gsd/phase-17-address-tech-debt-wr-06-medium-security-follow-ups` (planning-history lineage); code was merged to master via PR #17, tag `v1.1` points at the close commit on that branch. v1.2 phase branches follow `gsd/phase-{phase}-{slug}` — cut from an up-to-date `origin/master` (the local `master` ref is permanently stale in this repo).
