---
phase: 17-address-tech-debt-wr-06-medium-security-follow-ups
verified: 2026-08-19T20:21:38Z
status: passed
score: 32/32 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 17: Address tech debt: WR-06 + medium security follow-ups Verification Report

**Phase Goal:** WR-06's UTC day-boundary hazard is closed at both layers and proven by a
behavioral test against a deliberately non-UTC Postgres; the custom `megacrm-postgres`
`db`/`pgbackrest` image is CI-built, GHCR-pulled on an immutable SHA tag, inside the compose
immutability gate, and cut over live in production; and `scripts/restore-drill.sh`
self-records restore duration + disk high-water, with real figures captured from an
in-phase PITR drill — closing WR-06, T-14-58, T-14-73, T-14-88 and the outstanding Phase 15
alloy/Loki operator confirmation.

**Verified:** 2026-08-19T20:21:38Z
**Status:** passed
**Re-verification:** No — initial verification

## Requirement-ID Cross-Reference

Confirmed: `.planning/REQUIREMENTS.md` maps no rows to Phase 17 (`grep -n "Phase 17"` returns
nothing). `ROADMAP.md`'s own line for Phase 17 states `Requirements: TBD (none mapped —
closes named tech-debt/review findings, not REQUIREMENTS.md rows; scope authority is
17-CONTEXT.md's decisions D-01…D-12)`. This is confirmed intentional, not an orphaned
mapping — no requirements coverage table is produced for this phase.

## Goal Achievement

### Observable Truths

All truths below are merged from the six plans' `must_haves.truths` frontmatter (the roadmap
goal contains no separate machine-parseable success-criteria list; the goal sentence itself is
reproduced above and is discharged by the sum of the items below).

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Every physical connection opened by `createPgPool` reports `SHOW TimeZone = UTC` even against a database defaulted to America/New_York | ✓ VERIFIED | `packages/db/src/pool.ts:258` — `options: "-c TimeZone=UTC"` on `new Pool({...})`. Behavioral test re-run live by this verification: `npx vitest run --root packages/db src/__tests__/pg-timezone.test.ts` → 3/3 pass. |
| 2 | A naive `timestamp DEFAULT now()` column written through a `createPgPool` pool stores the true UTC wall-clock value | ✓ VERIFIED | Same test file, same live run (3/3 pass) — includes the write-path assertion comparing pinned vs. unpinned pool output. |
| 3 | The same write through a non-`createPgPool` pool stores the shifted, non-UTC local wall clock (negative control, proves the pin load-bearing) | ✓ VERIFIED | Same test file's negative-control case, part of the same 3/3 passing run. |
| 4 | The pin is a Postgres startup parameter (handshake), not a post-connect `SET` that can race | ✓ VERIFIED | `packages/db/src/pool.ts:258` uses `options:` on `new Pool()` construction (startup-parameter form), not `pool.on('connect', ...)`. Docker-less regression guard confirmed live: `npx vitest run --root packages/db src/__tests__/pool-factory.test.ts` → 19/19 pass, including the "carries the exact '-c TimeZone=UTC' startup-parameter string" case. |
| 5 | The growth-chart day-bucketing SQL returns the same UTC calendar day regardless of the reading session's TimeZone GUC | ✓ VERIFIED | `apps/api/src/modules/analytics/dashboard.repository.ts:78-81` — double-hop `((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date`. Behavioral test re-run live: `npx vitest run --root apps/api src/modules/analytics/__tests__/dashboard-timezone.test.ts` → 4/4 pass. |
| 6 | The single-hop form (13-REVIEW.md's/D-01's literal text) is proven WRONG by an executable assertion, locking it out of future "simplification" | ✓ VERIFIED | Same test file, Test 2 (part of the 4/4 passing run); 17-02-SUMMARY documents the RED mutation (single-hop substituted → test failed with wrong day; reverted → green). |
| 7 | The baseline cumulative-count query returns an identical count under a UTC and non-UTC session | ✓ VERIFIED | Same test file, Test 4 (part of the 4/4 passing run). |
| 8 | `contacts.created_at` and siblings keep type `timestamp without time zone` — no column-type migration | ✓ VERIFIED | `packages/db/src/schema/contacts.ts:52` — plain `timestamp(...)`, no `withTimezone`. `git log` shows no Drizzle migration file added by plans 17-01/17-02. |
| 9 | D-03 sweep audit: every remaining bare `::date` cast on a naive column is classified, with a residual gate that fails on any future unclassified site | ✓ VERIFIED | Residual gate re-run live: 0 lines. Unfiltered population re-run live: 22 lines (proves the gate filters a real, non-empty population, not vacuously). |
| 10 | The `megacrm-postgres` image is CI-built and pushed to GHCR on every push to master, tagged with the same git SHA as api/worker/web | ✓ VERIFIED | `.github/workflows/images.yml:157-190` — `build-and-push-postgres` job, `if: github.event_name == 'push'`, `tags: .../postgres:${{ github.sha }}`. |
| 11 | A `pull_request` build produces the same image without a registry credential and without pushing | ✓ VERIFIED | `.github/workflows/images.yml:198-217` — `build-only-postgres`, `if: github.event_name == 'pull_request'`, `permissions: contents: read`, no `docker/login-action` step, `push: false`. |
| 12 | `docker/docker-compose.prod.yml`'s `db`/`pgbackrest` reference a registry image only — no `build:` section | ✓ VERIFIED | Read full `db`/`pgbackrest` service blocks (lines 48-73, 174-195): both use `image: ${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG}`; no `build:` key anywhere in the file. |
| 13 | `db`/`pgbackrest` are inside `FIRST_PARTY_IMAGE_SERVICES`, and a fixture proves a mutable tag on `db` is rejected | ✓ VERIFIED | `scripts/validate-prod-compose.mjs:102` — set includes `"db", "pgbackrest"`. `scripts/__fixtures__/prod-compose/db-mutable-image-tag.yml` exists; `npx vitest run scripts/__tests__/validate-prod-compose.test.mjs` re-run live → 34/34 pass. |
| 14 | A forgotten `POSTGRES_IMAGE_TAG` fails loudly; `"local"` is a rejected tag | ✓ VERIFIED | Compose has no `:-` fallback on `POSTGRES_IMAGE_TAG`; `scripts/validate-prod-compose.mjs:109` — `MUTABLE_TAG_NAMES` includes `"local"`; `docker/prod.env.example:113` placeholder is a deliberately-invalid all-zero SHA. |
| 15 | `scripts/deploy.sh`'s routine pull/up set is unchanged — an app deploy never restarts the db container | ✓ VERIFIED | `grep -n "pull \|up -d"` on `deploy.sh` shows only `api worker web` throughout; `npx vitest run scripts/__tests__/deploy-script.test.mjs` re-run live → 21/21 pass. (Note: `deploy.sh` WAS touched in-phase, but only to add `--no-deps` guards on the existing app-only calls — a Rule-4-escalated fix from the live cutover, PR #17 — not to add db/pgbackrest to any set.) |
| 16 | Every real restore drill records its own duration + scratch-PGDATA disk high-water without operator memory, on success AND readiness-timeout paths | ✓ VERIFIED | `scripts/restore-drill.sh:270-307` (`record_disk_sample`/`write_drill_metrics`, called from both the timeout branch line 426 and the success branch line 461). `npx vitest run scripts/__tests__/restore-drill-script.test.mjs` re-run live → 26/26 pass. |
| 17 | The readiness-timeout branch still exits non-zero, prints READINESS TIMEOUT, prints the cleanup command, leaves resources in place | ✓ VERIFIED | 17-04-SUMMARY documents a byte-identical diff of the timeout message/cleanup text against the pre-plan commit; confirmed as part of the same 26/26 passing test run. |
| 18 | The high-water mark is the maximum observed sample, not the last | ✓ VERIFIED | `record_disk_sample` at `scripts/restore-drill.sh:274-275` only updates `DRILL_DISK_HIGH_WATER_KB` when `sample_kb > DRILL_DISK_HIGH_WATER_KB`; covered by the passing test suite's "high-water-is-max" case. |
| 19 | A disk-sampling failure can never abort a drill that would otherwise succeed | ✓ VERIFIED | Guarded assignment pattern in code; covered by the passing test suite's "sampler-failure non-fatal" case. |
| 20 | The drill launches the same CI-built GHCR image production runs, refusing to start on unset tag/registry rather than falling back to `local` | ✓ VERIFIED | `scripts/restore-drill.sh:387-388` — `:?`-guarded `GHCR_IMAGE_BASE`/`POSTGRES_IMAGE_TAG`; `grep -c 'POSTGRES_IMAGE_TAG:-local'` returns 0. Covered by the passing test suite's missing-variable-guard cases. |
| 21 | Production's `db`/`pgbackrest` containers run the CI-built, GHCR-pulled, SHA-tagged postgres image — observed live | ✓ VERIFIED | Orchestrator-attested live evidence, cross-checked against `17-05-SUMMARY.md` "Task 1 — Attempt 3 (APPROVED...)": `docker inspect Config.Image` = `ghcr.io/nimther/local-crm/postgres:1e061016dbf63016ab9aaeff9a3b995f8a55294f`; running image id changed `sha256:de6a69e4...` → `sha256:e718495c...`; consistent with the orchestrator's independently-supplied fact. |
| 22 | After cutover, every tenant-scoped table still has RLS enabled+forced, and WAL archiving resumed | ✓ VERIFIED (ratified corrected criterion) | 17-05-SUMMARY, Attempt 3: RLS 28/28 non-exempt tenant-scoped tables `t/t` (`reputation_alert_state` `f/f` is a pre-existing documented exemption); WAL `archived_count 131→133`, `failed_count 67` unchanged, `last_failed` unmoved. The literal must_haves text ("failed_count of zero") is superseded by an in-session ratified deviation (cumulative counter, historical 2026-08-14 failures, never zero on this host) — not treated as a failure per the orchestrator's pre-ratification and this verifier's own reading of the ratification rationale in 17-05-SUMMARY. |
| 23 | The alloy container stays running and log lines keep arriving in Loki across all expected service labels, in the same live session | ✓ VERIFIED (D-11 amended: establish-then-verify) | 17-05-SUMMARY: `RestartCount=0` at both B1 (baseline) and B2 (final), identical `StartedAt`, bracketing the full session; all seven service labels (`alloy, api, db, pgbackrest, redis, web, worker`) confirmed in Loki. `STATE.md:371` independently confirmed corrected with a dated Phase-17 note acknowledging the prior evidence-free claim. |
| 24 | A real PITR restore drill ran against the real off-host repository using the CI-built image and passed verification | ✓ VERIFIED | 17-05-SUMMARY, Task 2: target `2026-08-19 17:00:00+00`; `db:verify-restored` PASSED with correct PITR row-count deltas; cross-version proof (2.59.0-written backups restored by 2.59.1 binary). |
| 25 | The drill's duration + disk high-water figures exist as real recorded numbers, replacing the runbook placeholder | ✓ VERIFIED | Metrics NDJSON: `durationSeconds=119`, `diskHighWaterKb=170520`, target `2026-08-19 17:00:00+00`. Confirmed present in `docs/runbooks/restore-drill.md`'s "Recorded drill runs" table (digit-for-digit match documented in 17-05-SUMMARY). |
| 26 | Production data was never modified — only a read-only baseline query and a container recreate against the same persistent volume | ✓ VERIFIED | 17-05-SUMMARY: drill pre-flight explicitly limited production access to "a read-only row-count baseline"; cutover mount set (`docker_mega_crm_db_data_prod` etc.) unchanged before/after. |
| 27 | `SPECIFICATION.md` describes the system as actually built: pool pin, CI-built GHCR image, `POSTGRES_IMAGE_TAG` semantics, `RESTORE_DRILL_METRICS_FILE`, growth query's UTC anchor | ✓ VERIFIED | Live greps: `build-and-push-postgres`(3), `RESTORE_DRILL_METRICS_FILE`(2), `-c TimeZone=UTC`(2), `pg-timezone.test.ts`(3), `GROWTH_BY_DAY_SQL`(2), `dashboard-timezone.test.ts`(2), `3265`(1), `^### 8.6 `(1) — all present as claimed. |
| 28 | T-14-58/T-14-73/T-14-88 carry cited, checkable closure evidence | ✓ VERIFIED | Read `14-SECURITY.md` lines 136/151/154 directly — each row carries a dated "Phase 17 evidence" clause naming files, commands, and the exact `17-05-SUMMARY.md` section. |
| 29 | Those three rows' status is NOT flipped by this phase; the register says so explicitly | ✓ VERIFIED | `grep -c "open (below block threshold)"` on `14-SECURITY.md` returns 3 (all three rows unchanged); dated prose note names `/gsd-secure-phase` as the required next action (D-12). |
| 30 | `v1.1-MILESTONE-AUDIT.md`'s WR-06, three-medium-items, and alloy/Loki entries are annotated as addressed by Phase 17 | ✓ VERIFIED | `grep -c "Phase 17"` on the file returns 7 (≥6 required: WR-06 ×2, medium-items ×2, alloy/Loki ×2, plus one unplanned false-citation fix). |
| 31 | Every evidence citation resolves (named file exists, named SUMMARY section holds pasted output) | ✓ VERIFIED | Spot-checked: all files named in the 14-SECURITY.md/SPECIFICATION.md citations exist on disk (`pg-timezone.test.ts`, `dashboard-timezone.test.ts`, `dashboard.repository.ts`, `restore-drill.sh`, `docs/runbooks/restore-drill.md`, `docker-compose.prod.yml`, `images.yml`, `pool.ts`, `17-05-SUMMARY.md`); `17-05-SUMMARY.md`'s named sections ("Task 1 — Attempt 3", "Task 2 — restore drill") contain non-empty pasted command output, confirmed by direct read. |
| 32 | No deferred human-verification items were left in any plan's task bodies | ✓ VERIFIED | `grep -n "human-check" .planning/phases/17-*/17-0*-PLAN.md` returns no matches — no `<verify><human-check>` blocks were deferred from `checkpoint:human-verify` to end-of-phase; the two genuinely live checkpoints (17-05 Tasks 1/2) were executed and operator-approved during execution, not deferred to this verification. |

**Score:** 32/32 truths verified (0 present-but-behavior-unverified).

### D-01…D-12 Decision Discharge

| Decision | Discharged by | Status |
|---|---|---|
| D-01 (fix at both layers) | 17-01 (write/pool pin), 17-02 (read/double-hop anchor) | Discharged — see WR-02 caveat below |
| D-02 (behavioral proof against non-UTC Postgres) | 17-01 `pg-timezone.test.ts`, 17-02 `dashboard-timezone.test.ts` | Discharged, tests re-run live and pass |
| D-03 (sweep breadth: named site + recorded audit) | 17-02 | Discharged, residual gate re-run live (0 lines) |
| D-04 (no column-type migration) | 17-02 | Discharged, schema confirmed unchanged |
| D-05 (CI-built, GHCR-pulled image) | 17-03 | Discharged, code confirmed; live cutover in 17-05 |
| D-06 (tag scheme = git SHA on every master merge) | 17-03 | Discharged, confirmed in `images.yml` |
| D-07 (production cutover via operator blocking checkpoint) | 17-05 | Discharged, live evidence (Attempt 3) |
| D-08 (real drill in-phase) | 17-05 | Discharged, live PITR drill passed |
| D-09 (restore-drill.sh self-recording) | 17-04 | Discharged, code + tests confirmed |
| D-10 (full documentation trail) | 17-06 | Discharged, SPECIFICATION.md/14-SECURITY.md/v1.1-MILESTONE-AUDIT.md all updated |
| D-11 (alloy/Loki folded into cutover) | 17-05 (amended: establish-then-verify) | Discharged, live evidence; amendment ratified and recorded |
| D-12 (register flips await auditor re-run) | 17-06 | Discharged by design — status intentionally NOT flipped; `/gsd-secure-phase` is the documented next action, not a Phase 17 gap |

All twelve decisions are discharged. D-12 is discharged in the sense that its instruction ("don't flip status yourself") was followed — the actual status flip is out of Phase 17's scope by design.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/db/src/pool.ts` | TimeZone pin via startup parameter | ✓ VERIFIED | `options: "-c TimeZone=UTC"` on `new Pool()`, line 258 |
| `packages/db/src/__tests__/pg-timezone.test.ts` | Non-UTC behavioral test | ✓ VERIFIED | Exists, 3/3 pass (re-run live) |
| `packages/db/src/__tests__/pool-factory.test.ts` | Docker-less pin guard | ✓ VERIFIED | Exists, 19/19 pass (re-run live) |
| `apps/api/src/modules/analytics/dashboard.repository.ts` | Exported `GROWTH_BY_DAY_SQL`/`BASELINE_CONTACT_COUNT_SQL`, double-hop anchor | ✓ VERIFIED | Both constants exported and used by `getWorkspaceDashboard`; anchor present |
| `apps/api/src/modules/analytics/__tests__/dashboard-timezone.test.ts` | Non-UTC read-side test | ✓ VERIFIED | Exists, 4/4 pass (re-run live) |
| `.github/workflows/images.yml` | Postgres build-and-push/build-only job pair | ✓ VERIFIED | Both jobs present with correct trigger/permission boundaries |
| `docker/docker-compose.prod.yml` | `db`/`pgbackrest` pull-only, no `build:` | ✓ VERIFIED | Confirmed by direct read |
| `docker/prod.env.example` | SHA-shaped placeholder, no `local` default | ✓ VERIFIED | `POSTGRES_IMAGE_TAG=0000...0000` |
| `scripts/validate-prod-compose.mjs` | `db`/`pgbackrest` in immutable-tag gate; `"local"` rejected | ✓ VERIFIED | Set membership confirmed |
| `scripts/__fixtures__/prod-compose/db-mutable-image-tag.yml` | Fixture proving the gate rejects a mutable `db` tag | ✓ VERIFIED | Exists, exercised by the passing 34/34 test suite |
| `scripts/restore-drill.sh` | Self-recorded duration/disk-high-water; CI-image launch, fail-loud guards | ✓ VERIFIED | Confirmed by direct read + 26/26 passing tests |
| `scripts/__tests__/restore-drill-script.test.mjs` | Metrics + guard test coverage | ✓ VERIFIED | 26/26 pass (re-run live) |
| `docs/runbooks/restore-drill.md` | Real drill figures, GHCR prerequisite | ✓ VERIFIED | "Recorded drill runs" table present with matching figures |
| `SPECIFICATION.md` | As-built description updated at every phase anchor | ✓ VERIFIED | 8 anchors confirmed via grep |
| `.planning/phases/14-deployment-database-durability/14-SECURITY.md` | Cited evidence on 3 rows, status unchanged | ✓ VERIFIED | Confirmed by direct read |
| `.planning/v1.1-MILESTONE-AUDIT.md` | Carried items annotated | ✓ VERIFIED | 7 "Phase 17" mentions confirmed |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `createPgPool` | Every pool in `apps/api`, `apps/worker`, `packages/db/scripts` | `lint:pg-pool-factory` CI gate (pre-existing) | ✓ WIRED | Single choke point confirmed by 17-01-SUMMARY's own gate run (277 files, no violations) |
| `GROWTH_BY_DAY_SQL` constant | `getWorkspaceDashboard`'s `client.query` call AND `dashboard-timezone.test.ts`'s import | Exported module constant, one string two consumers | ✓ WIRED | Confirmed by direct read of `dashboard.repository.ts` (constant exported and used at line ~233) |
| `images.yml build-and-push-postgres` | GHCR `<base>/postgres:<sha>` | `docker/build-push-action`, `tags: .../postgres:${{ github.sha }}` | ✓ WIRED | Confirmed live: production runs `postgres:1e061016...` (the merged master SHA) |
| GHCR postgres image | `docker-compose.prod.yml` `db`/`pgbackrest` | `${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG}` | ✓ WIRED | Confirmed live cutover (image id change observed) |
| `scripts/restore-drill.sh`'s self-recorded metrics | Runbook figures / T-14-73 closure evidence | Metrics NDJSON → `docs/runbooks/restore-drill.md` table | ✓ WIRED | Digit-for-digit match table in 17-05-SUMMARY confirms no drift |

### Behavioral Spot-Checks (Step 7b — single named tests re-run live by this verification)

| Behavior | Command | Result | Status |
|---|---|---|---|
| Write-path TimeZone pin (pinned + negative control) | `npx vitest run --root packages/db src/__tests__/pg-timezone.test.ts` | 3/3 pass | ✓ PASS |
| Docker-less pin regression guard | `npx vitest run --root packages/db src/__tests__/pool-factory.test.ts` | 19/19 pass | ✓ PASS |
| Read-path UTC anchor (double-hop vs. single-hop vs. baseline) | `npx vitest run --root apps/api src/modules/analytics/__tests__/dashboard-timezone.test.ts` | 4/4 pass | ✓ PASS |
| Compose immutable-tag gate (incl. `db` mutable-tag fixture) | `npx vitest run scripts/__tests__/validate-prod-compose.test.mjs` | 34/34 pass | ✓ PASS |
| Restore-drill self-recorded metrics + fail-loud guards | `npx vitest run scripts/__tests__/restore-drill-script.test.mjs` | 26/26 pass | ✓ PASS |
| `deploy.sh` pull/up set unchanged, leg-isolation fix | `npx vitest run scripts/__tests__/deploy-script.test.mjs` | 21/21 pass | ✓ PASS |

All six suites were re-executed by this verifier against a real local Postgres 17 (not merely re-quoted from the SUMMARYs), with no failures.

### Probe Execution

No probes declared or discoverable: `find scripts -path '*/tests/probe-*.sh'` finds none, and no plan/SUMMARY references a `scripts/*/tests/probe-*.sh` path. Phase 17's own frontmatter records an explicit, visible probe skip ("Spec-less probe fallback: SKIPPED this run — no requirement IDs to probe"). Step 7c: no probes to run.

### Requirements Coverage

Not applicable — Phase 17 maps no REQUIREMENTS.md IDs (confirmed above). No orphaned requirements found for Phase 17 in `.planning/REQUIREMENTS.md`.

### Anti-Patterns Found

No debt markers (`TBD`/`FIXME`/`XXX`), `TODO`/`HACK`/`placeholder` strings, or stub patterns found in any file this phase modified (`pool.ts`, `dashboard.repository.ts`, `images.yml`, `docker-compose.prod.yml`, `validate-prod-compose.mjs`, `restore-drill.sh`, and their test files) — confirmed by direct grep.

**Unremediated code-review findings (17-REVIEW.md, all pre-existing at review time, none fixed by a subsequent plan — carried forward here for visibility, none are blockers):**

| Finding | File | Severity | Why not a blocker |
|---|---|---|---|
| WR-01: `options:` passthrough on `createPgPool` is unguarded against the same DSN-override hazard the file already documents/guards for `ssl` | `packages/db/src/pool.ts:258` | Warning | Latent — no DSN in this codebase sets `?options=` today; a real connection is still pinned correctly in the current configuration. Flagged for a follow-up hardening pass, not this phase's own goal. |
| WR-02: the read-path "fix" in `dashboard.repository.ts` is a behavioral no-op — the pre-existing plain `::date` cast was already session-independent for a naive column; only the single-hop form (never shipped) would have been wrong | `apps/api/src/modules/analytics/dashboard.repository.ts:78-82`; `SPECIFICATION.md` §5.17/§8.6 | Warning | The shipped behavior is correct today and is behaviorally proven by a passing test (Truth #5 above) — nothing incorrect ships. This does NOT contaminate the T-14-58/T-14-73/T-14-88 register evidence clauses in `14-SECURITY.md` (none of the three cites the read-path change; each cites only the image/gate/drill artifacts). It DOES affect `SPECIFICATION.md`'s own narrative accuracy. **Recommended before `/gsd-secure-phase` runs (D-12):** reframe `dashboard.repository.ts`'s comment and `SPECIFICATION.md` §5.17/§8.6/§9-23 from "closes/fixes read-path WR-06" to "read path was already session-independent for the shipped expression; this is a regression guard against a future simplification toward the single-hop form, not a behavior fix" (reviewer's own suggested fix). |
| WR-03: `check-web-chunks.mjs`'s new cycle-detection logic (added in-phase to fix a real 4-day production outage) has no dedicated unit test | `scripts/check-web-chunks.mjs:165-206` | Warning | Outside this phase's `must_haves` (the chunk-cycle fix was an escalated Rule-4 side-fix, PR #16, not a planned Phase 17 deliverable) — flagged for a follow-up plan. |
| WR-04: `docs/runbooks/backups.md`'s WAL-archiving health-check text ("`failed_count` should stay at zero", lines 184-185) contradicts this same phase's own ratified production finding (`failed_count` is cumulative, fixed at 67 since 2026-08-14, never zero on this host) | `docs/runbooks/backups.md:184-185` | Warning | Confirmed still present by direct read. Does not affect any Phase 17 must-have (the register evidence cites the ratified criterion correctly, in `14-SECURITY.md` and `docs/runbooks/restore-drill.md`); this stale sentence is in the day-to-day operational runbook and could mislead an operator during a future incident. Recommended fix (reviewer's own text): change to "`archived_count` should be increasing over time; `failed_count` should not increase from its previously observed value." |
| IN-01: `viteConfigHasStrictExecutionOrder`'s comment-stripping only removes full-line comments, not trailing `//` comments | `scripts/check-web-chunks.mjs:165-173` | Info | Same non-goal scope as WR-03. |

None of these five findings fail a must-have truth, block a key link, or match a Step 7 blocker pattern (no debt markers, no stub returns). They are carried forward from `17-REVIEW.md` for visibility and are appropriately advisory.

### Human Verification Required

None. All live-production truths (image cutover, RLS/WAL posture, alloy/Loki, PITR drill) were already executed and operator-approved during Phase 17's own execution (17-05, Tasks 1 and 2, both `checkpoint:human-verify` with `gate="blocking"`) — this verification cross-checked the pasted evidence rather than re-routing already-completed human checkpoints back to a new human-verification queue. No plan deferred a `<verify><human-check>` block to end-of-phase (confirmed by grep, zero matches). The remaining action — running `/gsd-secure-phase` to award the T-14-58/T-14-73/T-14-88 status flip — is a documented next step by design (D-12), not a gap in this phase's own goal.

### Gaps Summary

No gaps. All 32 merged must-have truths verified; all required artifacts present, substantive, and wired; all key links confirmed; all six relevant test suites re-run live by this verifier with 100% pass rates; live production evidence cross-checked against the orchestrator's independently-supplied facts and found consistent; D-01 through D-12 all discharged (D-12 discharged by design, deferring the register verdict to a future `/gsd-secure-phase` run — not a Phase 17 gap). Five review-only findings (WR-01 through WR-04, IN-01) are carried forward as non-blocking warnings for follow-up work.

---

_Verified: 2026-08-19T20:21:38Z_
_Verifier: Claude (gsd-verifier)_
