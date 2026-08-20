# Phase 17: Address tech debt: WR-06 + medium security follow-ups - Context

**Gathered:** 2026-08-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Close the concrete carry-over items named in `v1.1-MILESTONE-AUDIT.md`:

1. **WR-06** (13-REVIEW.md): the dashboard growth chart buckets `contacts.created_at` — a naive `timestamp` column — by bare `::date` with no UTC pinning anywhere in the connection stack. Day boundaries silently shift if the Postgres server default timezone is ever non-UTC.
2. **T-14-58 / T-14-88** (14-SECURITY.md): the host-built `megacrm-postgres` db/pgbackrest image rides a mutable `POSTGRES_IMAGE_TAG` (default `local`) with `build:` sections in the prod compose, excluded from the `FIRST_PARTY_IMAGE_SERVICES` immutability gate.
3. **T-14-73** (14-SECURITY.md): restore-drill disk-usage / duration figures remain a runbook placeholder.

Plus one folded operator item: the Phase 15 alloy/Loki prod-deploy confirmation rides along on this phase's live cutover session (see D-11).

Out of scope: Phase 13's five deferred live human-verification walkthroughs (unsubscribe atomicity, timezone-independence, erasure end-to-end, event integrity, backfill/reputation) — they remain tracked in the milestone audit, not this phase.

</domain>

<decisions>
## Implementation Decisions

### WR-06 timezone hazard

- **D-01:** **Fix at both layers.** Pin `TimeZone='UTC'` at the pool level in `packages/db/src/pool.ts` (the single mandatory pool factory enforced by the `lint:pg-pool-factory` CI gate) so every `now()`-derived naive-timestamp write repo-wide is provably UTC-anchored, AND add the read-site `(created_at AT TIME ZONE 'UTC')::date` cast to the growth-chart query, mirroring Phase 13's `reconcileWorkspaceDay` pattern. Defense in depth: the query stays correct even against a pool bypass or external client.
- **D-02:** **Regression proof = behavioral test against a deliberately non-UTC Postgres.** The test runs with a session/server timezone set to something like `America/New_York` and proves the pin + cast still yield UTC day boundaries. This exercises the exact failure mode the review said no existing test can catch (CI/dev Postgres defaults to UTC, masking the bug). A mere `SHOW timezone` assertion was rejected as insufficient on its own.
- **D-03:** **Sweep breadth = named site + recorded audit.** Fix the growth-chart query and the adjacent baseline count in `apps/api/src/modules/analytics/dashboard.repository.ts`, then grep-audit all remaining bare `::date` casts on naive timestamp columns; fix any that affect user-visible day bucketing, and record the rest as verified-safe in the plan/summary. A mechanical repo-wide cast rewrite was rejected (touches stable reviewed queries for a hazard the pool pin already closes).
- **D-04:** **No column-type migration.** `contacts.created_at` and sibling columns stay `timestamp` without time zone; pin + casts close the hazard. Matches how Phase 13 handled the identical hazard on `sends`/`send_events`. — **Reversibility:** reversible — a `timestamptz` migration remains available later if wanted.

### DB image immutability (T-14-58 / T-14-88)

- **D-05:** **`megacrm-postgres` becomes CI-built and registry-pulled.** Build in GitHub Actions like `api`/`worker`/`web`, push to GHCR on immutable SHA tags, drop the `build:` sections from `docker/docker-compose.prod.yml`, and add `db` + `pgbackrest` to `FIRST_PARTY_IMAGE_SERVICES` in `scripts/validate-prod-compose.mjs`. Closes both threat rows outright as *mitigated* (dedicated-tag-gate-with-host-builds and formal risk acceptance were both rejected). — **Reversibility:** costly — deploy.sh, restore-drill.sh, the compose gate, and the CI workflow all shift to the pulled-image model; going back re-opens both threat rows.
- **D-06:** **Tag scheme = same git SHA, built on every master merge**, alongside the three app images. `deploy.sh <sha>` keeps its single-SHA interface; `POSTGRES_IMAGE_TAG` becomes that SHA. Layer caching keeps the rarely-changing image cheap to rebuild; one tag lifecycle for the operator.
- **D-07:** **Production cutover happens in-phase via an operator blocking checkpoint** (the proven Phase 14/16 pattern): pull the GHCR image, restart `db` + `pgbackrest`, verify Postgres healthy, RLS enabled+forced posture intact, and WAL archiving resuming. Threat rows close on live evidence, not on code landing alone.

### Restore-drill metrics (T-14-73)

- **D-08:** **A real drill runs in-phase**, as a checkpointed operator step after the image cutover — it fills the runbook placeholder AND doubles as proof the CI-built image restores correctly via PITR.
- **D-09:** **`scripts/restore-drill.sh` gains automatic self-recording** of wall-clock duration and disk-usage sampling (high-water) into the drill output, so this drill and every future one records the figures without relying on operator memory — removing the failure mode that produced the placeholder in the first place.

### Closure evidence & register updates

- **D-10:** **Full documentation trail.** Flip T-14-58/T-14-73/T-14-88 rows to closed in `14-SECURITY.md` citing evidence; annotate the WR-06 entry as closed in `v1.1-MILESTONE-AUDIT.md`; update `SPECIFICATION.md` (§2/§5/§6 as applicable) for the pool TimeZone pin, the CI-built postgres image, and the drill instrumentation — per the CLAUDE.md rule that infra/pipeline changes must land in SPECIFICATION.md in the same change.
- **D-11:** **The Phase 15 alloy confirmation folds into the cutover checkpoint:** during the same live session the operator verifies the alloy container stays running (not restarting) and log lines keep arriving in Loki — clearing the last operator-side audit item with zero extra deploy events.
- **D-12:** **Register flips are signed off by a security-auditor re-run**, not the executor: after execution, run `/gsd-secure-phase` against the updated Phase 14 register so an auditor pass verifies each mitigation exists in code/evidence before rows flip to closed — matching how the register reached `verified` status originally.

### Claude's Discretion

- Exact mechanism for the pool-level pin (`options: '-c TimeZone=UTC'` in Pool config vs connect-event `SET`), where the non-UTC test lives, and how the non-UTC Postgres is provisioned in CI.
- CI workflow shape for the postgres image build (same workflow vs separate job), tag fallback behavior for dev compose, and whether the dev `docker-compose.yml` keeps a local build path.
- Drill PITR target choice and the exact output format of the self-recorded metrics.
- Sequencing of the cutover checkpoint vs the drill within the phase (drill after cutover is fixed; the rest is planner's).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Tracked findings being closed
- `.planning/phases/13-compliance-analytics-integrity/13-REVIEW.md` §WR-06 (lines ~208–221) — the exact hazard statement and the two fix mechanisms this phase implements
- `.planning/phases/14-deployment-database-durability/14-SECURITY.md` — threat rows T-14-58, T-14-73, T-14-88 (the "open (below block threshold)" rows this phase closes) and the register's recommended mitigations
- `.planning/v1.1-MILESTONE-AUDIT.md` — carried-items list naming all three items plus the Phase 15 alloy confirmation folded in via D-11

### Code and gates being modified
- `apps/api/src/modules/analytics/dashboard.repository.ts` (growth query ~lines 185–200) — the WR-06 read site
- `packages/db/src/pool.ts` — the mandatory pool factory (single choke point for the TimeZone pin)
- `scripts/lint-pg-pool-factory.mjs` — the gate that guarantees all pools go through the factory (why the pool pin is sufficient)
- `scripts/validate-prod-compose.mjs` — `FIRST_PARTY_IMAGE_SERVICES` set (~line 89) and the mutable-tag check (~lines 546–556) to extend
- `docker/docker-compose.prod.yml` — `db`/`pgbackrest` services with `build:` sections and `megacrm-postgres:${POSTGRES_IMAGE_TAG:-local}` image refs (lines 66, 186)
- `scripts/restore-drill.sh` — drill script to instrument (uses the same `megacrm-postgres` tag at lines ~285, ~349)
- `docker/prod.env.example` — `POSTGRES_IMAGE_TAG` documentation (line ~108)
- `docs/runbooks/backups.md` §~270–280 — the documented forward flag for the host-built image and the drill runbook placeholder to fill

### Documentation to update on closure (D-10)
- `SPECIFICATION.md` — §2 dependencies / §5 pipeline / §6 entry points as applicable
- `.planning/phases/14-deployment-database-durability/14-SECURITY.md` — row status flips (auditor-signed per D-12)
- `.planning/v1.1-MILESTONE-AUDIT.md` — closure annotations

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/db/src/pool.ts` + `lint:pg-pool-factory` CI gate: every pool in the codebase is already funneled through one factory — the TimeZone pin lands once and covers api, worker, and scripts.
- Phase 13's `(col AT TIME ZONE 'UTC')::date` pattern in `analytics-reconciliation.worker.ts` / `reconcileWorkspaceDay`: the established read-site idiom to mirror, with an extensive in-code comment explaining the hazard class.
- Phase 14/16 blocking-checkpoint pattern (executor stages exact commands + scripted verification queries; operator performs live actions and approves on evidence) — reuse for the cutover and drill.
- Existing GHCR build workflow for `api`/`worker`/`web` images (SHA tags, images.yml SHA-pinned actions) — extend rather than invent for the postgres image.
- `scripts/restore-drill.sh` already parses production names live and asserts scratch isolation — instrumentation is additive.

### Established Patterns
- Immutable-SHA-tag discipline with `MUTABLE_TAG_NAMES` rejection in `validate-prod-compose.mjs` — the postgres image joins an existing mechanism, not a new one.
- Security register rows close only with cited evidence; register status `verified` came from a gsd-security-auditor pass (D-12 preserves that bar).
- SPECIFICATION.md must be updated in the same change as any infra/pipeline modification (CLAUDE.md rule).

### Integration Points
- `deploy.sh` pull-and-flip flow gains the postgres image in its pull set (db/pgbackrest are NOT part of the app-container flip — the db restart is the separate checkpointed cutover, not a per-deploy action).
- `restore-drill.sh` consumes `POSTGRES_IMAGE_TAG` — must resolve to the pulled GHCR tag after cutover.
- The non-UTC behavioral test integrates with the existing Vitest + CI postgres setup (provisioning mechanism = Claude's discretion).

</code_context>

<specifics>
## Specific Ideas

- The in-phase drill deliberately doubles as validation that the CI-built image restores correctly — one operator session yields both T-14-73 figures and cutover confidence.
- The cutover checkpoint session is also the "next production deploy" moment the milestone audit was waiting on for the alloy/Loki confirmation — fold it in, don't schedule a separate event.

</specifics>

<deferred>
## Deferred Ideas

- Full `timestamptz` migration of naive timestamp columns — considered and rejected for this phase (D-04); may be evaluated in a future schema-hygiene pass if the pin+cast posture ever proves insufficient.

</deferred>

---

*Phase: 17-address-tech-debt-wr-06-medium-security-follow-ups*
*Context gathered: 2026-08-19*
