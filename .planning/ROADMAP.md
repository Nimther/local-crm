# Roadmap: Mega CRM — B2C Marketing Automation Platform

## Milestones

- ✅ **v1.0 MVP** — Phases 1-7 (shipped 2026-07-14) — [archive](milestones/v1.0-ROADMAP.md)
- ✅ **v1.1 Production Hardening** — Phases 8-17 (shipped 2026-08-20) — [archive](milestones/v1.1-ROADMAP.md)
- 🚧 **v1.2 Data Lifecycle & Delivery Trust** — Phases 18-22 (in progress)

## Phases

**Phase Numbering:**

- Integer phases (18, 19, 20): Planned milestone work
- Decimal phases (18.1, 18.2): Urgent insertions (marked with INSERTED)

<details>
<summary>✅ v1.0 MVP (Phases 1-7) — SHIPPED 2026-07-14</summary>

- [x] Phase 1: Workspace Foundation & Team Access (7/7 plans) — completed 2026-07-03
- [x] Phase 2: Contacts & Event Ingestion (14/14 plans) — completed 2026-07-05
- [x] Phase 3: Segmentation Engine (8/8 plans) — completed 2026-07-06
- [x] Phase 4: Broadcast Campaigns & Send Pipeline (19/19 plans) — completed 2026-07-06
- [x] Phase 5: Webhook Processing & Delivery Tracking (13/13 plans) — completed 2026-07-09
- [x] Phase 6: Flows (Triggered Chains) (24/24 plans) — completed 2026-07-13
- [x] Phase 7: Analytics, Dashboard & Send Log (11/11 plans) — completed 2026-07-14

Full phase details: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)

</details>

<details>
<summary>✅ v1.1 Production Hardening (Phases 8-17) — SHIPPED 2026-08-20</summary>

- [x] Phase 8: Quality Gates & Failure-Injection Foundation (18/18 plans) — completed 2026-08-06
- [x] Phase 9: Partition Automation & Boundary Safety (5/5 plans, HARD DEADLINE 2026-09-01 met) — completed 2026-08-07
- [x] Phase 10: Tenant Isolation & Trust Boundaries (15/15 plans) — completed 2026-08-09
- [x] Phase 11: Delivery Correctness (11/11 plans) — completed 2026-08-09
- [x] Phase 12: Worker Reliability & Tenant Fairness (14/14 plans) — completed 2026-08-11
- [x] Phase 13: Compliance & Analytics Integrity (16/16 plans) — completed 2026-08-12
- [x] Phase 14: Deployment & Database Durability (14/14 plans) — completed 2026-08-14
- [x] Phase 15: Observability, Alerting & Frontend Resilience (22/22 plans) — completed 2026-08-17
- [x] Phase 16: Live SendGrid Verification (7/7 plans, release barrier, UAT 5/5 live) — completed 2026-08-19
- [x] Phase 17: Address tech debt: WR-06 + medium security follow-ups (6/6 plans) — completed 2026-08-20

Full phase details: [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md)

</details>

### 🚧 v1.2 Data Lifecycle & Delivery Trust (Phases 18-22)

**Milestone Goal:** Close the data-lifecycle and delivery-trust gaps of a shipped production platform: what the marketer selects is what actually goes out, a data subject's personal data can be handed over on demand, a deleted workspace actually disappears without harming its neighbours, unsubscribe links survive a secret rotation, and vulnerable dependencies stop accumulating silently.

**Character:** Compliance and correctness on top of already-shipped subsystems. No re-planning of RLS, CI, backups, contact erasure, event retention, KMS, queues or observability — every new requirement integrates into the existing mechanism.

**Source of scope:** `.planning/REQUIREMENTS.md` (18 v1.2 requirements) informed by `.planning/research/SUMMARY.md` (5 features, 17 enumerated pitfalls, discovery-based build order).

**Build order rationale:** dependency hygiene first (the CI gate protects every subsequent phase's own dependency changes), then the two small self-contained fixes (rotation, template correctness), then DSR export (must exist and be stable before anything is physically purged, and its keyset discipline informs the purge batching), then workspace purge last (largest surface, irreversible, two architectural decisions resolvable only at plan time).

- [x] **Phase 18: Dependency Hygiene & Advisory Gate** - Vulnerable runtime deps fixed; new untriaged HIGH advisories blocked by CI with an expiring accept-list (completed 2026-08-20)
- [ ] **Phase 19: Unsubscribe Secret Graceful Rotation** - Operator rotates the signing secret without invalidating a single already-sent link
- [ ] **Phase 20: Campaign Template Correctness** - The template shown as selected is the template that actually sends, on all three send paths
- [ ] **Phase 21: Per-Contact DSR Export** - Owner/Admin hands a data subject their own data as one downloadable, tenant-isolated file
- [ ] **Phase 22: Workspace Quiesce & Physical Purge** - A soft-deleted workspace stops sending and physically disappears after retention, leaving neighbours and compliance evidence intact

## Phase Details

### Phase 18: Dependency Hygiene & Advisory Gate

**Goal**: Vulnerable runtime dependencies are fixed, and a new untriaged HIGH advisory can no longer reach master unnoticed — while findings proven unreachable are accepted explicitly, with an owner and an expiry, instead of being ignored.
**Depends on**: Nothing (first phase of v1.2; builds on the shipped v1.1 CI quality-gate machinery from Phase 8)
**Requirements**: DEP-01, DEP-02, DEP-03
**Success Criteria** (what must be TRUE):

  1. Every applicable HIGH advisory in a reachable production path is fixed by an actual upgrade; each one still present carries a written reachability analysis explaining why it cannot be reached.
  2. A pull request that introduces a dependency with a new untriaged HIGH advisory fails CI, naming the package and the advisory id — proven by a fail-first run against the pre-fix state.
  3. A scheduled full scan surfaces an advisory newly published against an already-installed dependency, with no code change on the branch, through the same reporting path.
  4. An accept-list entry without justification, owner or expiry — or one whose expiry has passed — is rejected by the gate, so an acceptance cannot silently become permanent.

**Plans**: 4/4 plans executed

Plans:
**Wave 1**

- [x] 18-01-PLAN.md — Advisory gate tracer: `scripts/check-dependency-advisories.mjs` + npm script + empty accept-list + ci.yml `static` step, proven RED against the live pre-fix tree (fail-first evidence for SC2)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 18-02-PLAN.md — Accept-list schema validation: mandatory fields, email owner, minimum justification, inclusive expiry capped at 90 days (SC4)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 18-03-PLAN.md — Upgrade every blocking advisory out of the tree (3 direct pins + `npm audit fix`), gate turns GREEN, SPECIFICATION.md §2/§8 filed (SC1)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 18-04-PLAN.md — Daily `advisory-scan.yml` running the same gate script, deduplicated labelled GitHub issue on failure, SPECIFICATION.md §7 (SC3)

**Plan-time decisions**: RESOLVED at planning — `drizzle-kit` needs neither reclassification nor an accept-list entry. It already sits in `devDependencies` of `packages/db`; its apparent production-tree presence via `better-auth` is an OPTIONAL peerDependency satisfied by workspace hoisting (better-auth's shipped `dist/` never references it), and its own advisory is MODERATE, below the HIGH/CRITICAL blocking threshold. The reachability finding is recorded in the gate script's header comment (D-10); no accept-list entry is manufactured for a non-blocking finding.
**UI hint**: no

### Phase 19: Unsubscribe Secret Graceful Rotation

**Goal**: The operator can put a new unsubscribe signing secret into service without breaking a single link that has already been mailed out.
**Depends on**: Phase 18 (advisory gate active before further dependency-touching work; no functional dependency)
**Requirements**: ROT-01, ROT-02
**Success Criteria** (what must be TRUE):

  1. After the operator introduces a new primary secret, newly sent mail is signed with it, and an unsubscribe link from mail sent before the rotation still unsubscribes the contact.
  2. Old and new links verify identically on both redemption paths — the GET link in the email and the RFC 8058 one-click urlencoded POST.
  3. A forged or expired-secret token produces a byte-identical response to a valid one (the no-token-oracle invariant survives rotation), with a timing-safe comparison performed per candidate secret.
  4. The retention window for previous secrets is an explicit, documented decision tied to the real lifetime of already-sent links (5-year token TTL) — not an unstated default, and not an unbounded list.

**Plans**: 1/5 plans executed

Plans:
**Wave 1**

- [x] 19-01-PLAN.md — Tracer: `verifyUnsubscribeToken` extended to an ordered, exhaustively-evaluated `[primary, ...previous]` candidate loop + package-local pino logger for the D-05 match line; both link eras proven end-to-end through the real RFC 8058 one-click POST route (SC1)

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 19-02-PLAN.md — Env-validation triple in one plan (zod / worker boot assertion / predev check-env): optional `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` with length, empty, duplicate and max-5 rules, D-03 charset tightening on the primary too, plus a three-site parity guard (SC4's code half)
- [ ] 19-03-PLAN.md — Redaction rules for both signing-secret variable names in the single rule table, spelled as env-var names because the scrub matcher is exact-match (D-02)
- [ ] 19-04-PLAN.md — ROT-02 closure: GET path + confirm-form POST for previous-secret links, four-way byte-identical POST responses, and executable gates on exhaustive loop evaluation and the D-05 log shape (SC2, SC3)

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 19-05-PLAN.md — Retention decision filed (SPECIFICATION.md), deployment template + README entries under `check:spec-env-coverage`, and the two-step rotation runbook ending in a both-eras canary smoke (SC4, D-06 through D-09)

**Plan-time decisions**: RESOLVED at planning — a previous secret is retained until **5 years after its last use as primary** (the TTL of the last token it ever signed), the only window that provably breaks zero links (D-06). Recording and enforcement are deliberately split (D-07): the 5-year rule and each secret's retirement date live in SPECIFICATION.md §3 and the rotation runbook's rotation log, while code enforces exactly one structural bound — a maximum of 5 retained previous secrets, rejected at boot at all three validation sites — satisfying SC4's "not an unbounded list" without dates-in-env machinery.
**UI hint**: no

### Phase 20: Campaign Template Correctness

**Goal**: What the marketer sees selected in a campaign is exactly what SendGrid receives — on launch, on schedule and on test-send — and an unsaved or conflicting change is refused loudly instead of sending the old template.
**Depends on**: Phase 18 (no functional dependency on Phase 19)
**Requirements**: TMPL-01, TMPL-02, TMPL-03
**Success Criteria** (what must be TRUE):

  1. A marketer who changes the template in the dropdown and has not saved sees an explicit unsaved-changes state, and launch, schedule and test-send are all blocked until the campaign is saved.
  2. A test send delivers exactly the template confirmed as saved on the campaign — the original bug scenario ("pick a new template, then send") is reproduced on all three send paths and yields the new template, never the previous one.
  3. Launch and schedule act only on the confirmed-saved campaign version; a concurrent or stale change produces a typed conflict error and no mail is dispatched at all.
  4. After a save, all three send paths agree on the same template id — none of them can fall back to local client form state.

**Plans**: TBD
**UI hint**: yes

### Phase 21: Per-Contact DSR Export

**Goal**: An Owner or Admin can hand a data subject their own personal data in one action — a machine-readable file scoped strictly to that contact in that workspace, containing no other subject's data.
**Depends on**: Phase 18 (no functional dependency on Phases 19-20; must precede Phase 22 so exports exist before anything is physically purged)
**Requirements**: DSR-01, DSR-02, DSR-03, DSR-04
**Success Criteria** (what must be TRUE):

  1. An Owner or Admin downloads, from the contact card, a machine-readable file containing the contact's profile, custom properties and consent history.
  2. The file also contains the contact's events and the send-related personal data (send facts, delivery statuses) belonging to that subject.
  3. A Member without the Owner/Admin role does not see the export action in the UI and is refused by the API.
  4. An export request naming a contact id from another workspace returns nothing (negative cross-tenant test), and freeform JSONB (`events.properties`, `send_events.payload`) reaches the file only through an explicit allowlist — a synthetic field holding another subject's data is provably absent from the export.
  5. Exporting an already-anonymized (erased) contact behaves predictably — a typed response describing the state, never a silently empty file.

**Plans**: TBD
**Plan-time decisions**: the JSONB inclusion/redaction rule (DSR-03) must be resolved as an explicit allowlist decision, shared with Phase 22's PII inventory so export and purge never diverge on what counts as a contact's personal data.
**UI hint**: yes

### Phase 22: Workspace Quiesce & Physical Purge

**Goal**: A soft-deleted workspace stops sending immediately and, after the platform retention window, physically ceases to exist — its PII and secrets gone, its neighbours untouched, and the compliance evidence that must outlive a tenant still intact.
**Depends on**: Phase 21 (DSR export must be available and stable before data is irreversibly destroyed; its per-contact keyset discipline informs the batched-delete design)
**Requirements**: PRG-01, PRG-02, PRG-03, PRG-04, PRG-05, PRG-06
**Success Criteria** (what must be TRUE):

  1. A soft-deleted workspace stops sending immediately: scheduled and in-flight campaigns and flow dispatches produce no further mail after the soft delete.
  2. Once the operator-configured platform retention has elapsed, the workspace's PII across every tenant table is deleted or anonymized and its secrets (SendGrid key ciphertext, DEK, webhook endpoints) are gone — while the compliance evidence required to outlive the tenant is still present and readable.
  3. A purge killed mid-run (real SIGKILL) resumes and completes on the next run, and re-running a finished purge changes nothing and fails nothing.
  4. Another workspace's rows in the same monthly partitions are provably unchanged after a purge — demonstrated by a negative test — and the purge performs no DROP, DETACH or TRUNCATE.
  5. A workspace restored after its purge was enqueued is not purged: eligibility is re-checked inside every batch and the purge refuses rather than silently skipping.

**Plans**: TBD
**Research flag**: deeper research at plan time (multi-table FK ordering, privilege model, PITR-backup caveat for compliance claims) — research recommends a short architecture spike before implementation.
**Plan-time decisions**: (a) privilege model for cross-tenant deletion — grant migration on `organization` for `mega_crm_app` vs a dedicated elevated DSN following the partition-relocation precedent; (b) exact quiesce mechanism closing the verified `campaigns_scan`/`flows_scan` gap (they do not check `organization.deletedAt` today); (c) documented caveat that purged data persists in encrypted pgBackRest backups until their retention expires.
**UI hint**: no

## Progress

**Execution Order:** 18 → 19 → 20 → 21 → 22

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Workspace Foundation & Team Access | v1.0 | 7/7 | Complete | 2026-07-03 |
| 2. Contacts & Event Ingestion | v1.0 | 14/14 | Complete | 2026-07-05 |
| 3. Segmentation Engine | v1.0 | 8/8 | Complete | 2026-07-06 |
| 4. Broadcast Campaigns & Send Pipeline | v1.0 | 19/19 | Complete | 2026-07-06 |
| 5. Webhook Processing & Delivery Tracking | v1.0 | 13/13 | Complete | 2026-07-09 |
| 6. Flows (Triggered Chains) | v1.0 | 24/24 | Complete | 2026-07-13 |
| 7. Analytics, Dashboard & Send Log | v1.0 | 11/11 | Complete | 2026-07-14 |
| 8. Quality Gates & Failure-Injection Foundation | v1.1 | 18/18 | Complete | 2026-08-06 |
| 9. Partition Automation & Boundary Safety | v1.1 | 5/5 | Complete | 2026-08-07 |
| 10. Tenant Isolation & Trust Boundaries | v1.1 | 15/15 | Complete | 2026-08-09 |
| 11. Delivery Correctness | v1.1 | 11/11 | Complete | 2026-08-09 |
| 12. Worker Reliability & Tenant Fairness | v1.1 | 14/14 | Complete | 2026-08-11 |
| 13. Compliance & Analytics Integrity | v1.1 | 16/16 | Complete | 2026-08-12 |
| 14. Deployment & Database Durability | v1.1 | 14/14 | Complete | 2026-08-14 |
| 15. Observability, Alerting & Frontend Resilience | v1.1 | 22/22 | Complete | 2026-08-17 |
| 16. Live SendGrid Verification | v1.1 | 7/7 | Complete | 2026-08-19 |
| 17. Address tech debt: WR-06 + security follow-ups | v1.1 | 6/6 | Complete | 2026-08-20 |
| 18. Dependency Hygiene & Advisory Gate | v1.2 | 4/4 | Complete    | 2026-08-20 |
| 19. Unsubscribe Secret Graceful Rotation | v1.2 | 1/5 | In Progress|  |
| 20. Campaign Template Correctness | v1.2 | 0/TBD | Not started | - |
| 21. Per-Contact DSR Export | v1.2 | 0/TBD | Not started | - |
| 22. Workspace Quiesce & Physical Purge | v1.2 | 0/TBD | Not started | - |

---
*v1.2 roadmap created 2026-08-20 — 18/18 requirements mapped, no orphans. Next: `/gsd-plan-phase 18`.*
