---
phase: 17
slug: address-tech-debt-wr-06-medium-security-follow-ups
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-20
---

# Phase 17 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
>
> Register authored at plan time (all six 17-0N-PLAN.md files carry `<threat_model>` blocks).
> Verified 2026-08-20 by gsd-security-auditor under `/gsd-secure-phase 17` — verdict SECURED,
> 43/43 closed (37 numbered rows + T-17-SC ×6 per-plan). The same run re-verified and closed
> the three Phase 14 rows this phase existed to discharge (T-14-58, T-14-73, T-14-88 — see
> `.planning/phases/14-deployment-database-durability/14-SECURITY.md`, D-12).

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| application process → Postgres session | Session GUCs (`TimeZone`) negotiated at handshake; anything unpinned is inherited from server defaults | timestamps written into naive `timestamp` columns |
| any Postgres session → growth query | Session `TimeZone` is an input the query does not control (bypass client, psql, future pooler) | tenant-visible day-bucketed business metrics |
| test process → shared Postgres cluster | Ephemeral test DBs share one cluster; cluster-scoped mutation would cross into concurrent suites | test timezone mutations (scoped via `ALTER DATABASE`) |
| operator working tree / GitHub Actions → GHCR → production runtime | A `build:` section lets unreviewed local content become the running database image; publish rights must never be reachable from a fork PR | `db`/`pgbackrest` container image, `POSTGRES_IMAGE_TAG` |
| drill script → scratch container / host filesystem | The drill must never reach production's container, volume, or PGDATA; metrics land outside the repo | PITR target string, duration/disk integers |
| operator shell → production containers | Live container recreate against a running database; the persistent named volume must survive untouched | production PGDATA, RLS posture, WAL chain |
| as-built reality → SPECIFICATION.md / security registers | A stale sentence is read as current by a security review; verdicts belong to the auditor, not the executor (D-12) | evidence citations, register statuses |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-17-01 | Tampering | `packages/db/src/pool.ts` write path into naive `timestamp` columns | medium | mitigate | `options: "-c TimeZone=UTC"` startup parameter in `createPgPool` (`pool.ts:303`); behavioral test vs America/New_York DB + unpinned negative control (`pg-timezone.test.ts:60-74`) | closed |
| T-17-02 | Tampering | future pool bypassing `createPgPool` | medium | mitigate | Pre-existing `scripts/lint-pg-pool-factory.mjs` CI gate rejects bare `new Pool()` outside test dirs; wired at `ci.yml:116` | closed |
| T-17-03 | Tampering | pin regressing to racy connect-event form | medium | mitigate | Startup-parameter form only; rationale header `pool.ts:109-136` (node-postgres #3265); guard `pool-factory.test.ts:214-241` asserts the exact literal and DSN-merge survival | closed |
| T-17-04 | DoS | D-02 test mutating shared cluster timezone | medium | mitigate | `ALTER DATABASE <ephemeral-db>` scoped to the per-run database (`pg-timezone.test.ts:36`); no `TZ`/`PGTZ`/`postgresql.conf` change | closed |
| T-17-05 | Info Disclosure | test output / DSNs in assertion failures | low | accept | AR-17-01 — see Accepted Risks Log | closed |
| T-17-06 | Tampering | `GROWTH_BY_DAY_SQL` day bucketing on a naive column | medium | mitigate | Double-hop `AT TIME ZONE 'UTC'` anchor (`dashboard.repository.ts:92,95`); tested under forced America/New_York session (`dashboard-timezone.test.ts:152-173`) | closed |
| T-17-07 | Tampering | future "simplification" to single-hop cast | medium | mitigate | Test 2 asserts single-hop returns the wrong day → CI fails; rationale + `relocate-default.ts` precedent committed above the constant | closed |
| T-17-08 | Info Disclosure | misleading tenant-visible growth metrics | medium | mitigate | Same anchor as T-17-06; `anonymized_at IS NULL` present in production SQL and every test variant | closed |
| T-17-09 | Tampering | test drifting from production SQL | medium | mitigate | Test imports and executes the exact exported constant; only labelled comparators are literals | closed |
| T-17-10 | DoS | cast defeating an index on large `contacts` | low | accept | AR-17-02 — see Accepted Risks Log | closed |
| T-17-11 | Tampering | `build:` sections in `docker/docker-compose.prod.yml` (closes T-14-58, T-14-88) | high | mitigate | Both `build:` sections deleted; `${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG}` only; `db`/`pgbackrest` in `FIRST_PARTY_IMAGE_SERVICES`; fixture `db-mutable-image-tag.yml`; gate executed 34/34 pass | closed |
| T-17-12 | EoP | `build-only-postgres` job on pull_request incl. forks | medium | mitigate | Job-level `permissions: contents: read`, no `docker/login-action`, `push: false` (`images.yml:198-223`) | closed |
| T-17-13 | Tampering | `POSTGRES_IMAGE_TAG` reverting to a mutable value | medium | mitigate | `:-local` fallback removed (unset fails at pull time); `prod.env.example` default is a 40-zero placeholder; `"local"` in `MUTABLE_TAG_NAMES` | closed |
| T-17-14 | DoS | `db`/`pgbackrest` drifting into `deploy.sh`'s routine restart path | medium | mitigate | Verified on current code: pull/up sets remain `api worker web` (`deploy.sh:294-302,358-399`); `deploy-script.test.mjs` 47/47 pass (file was modified mid-phase by escalated PR #17 — property verified in resulting code) | closed |
| T-17-15 | Tampering | pulling by registry tag rather than content digest | medium | accept | AR-17-03 — see Accepted Risks Log | closed |
| T-17-16 | Spoofing | new CI jobs pulling a re-pointed third-party action | medium | mitigate | All 14 `uses:` in `images.yml` are 40-char SHA pins reusing the four pre-existing action SHAs; none re-resolved | closed |
| T-17-17 | Repudiation | runbook instructing a manual host build after the model changed | low | mitigate | `backups.md:326-328` forward-flag bullet marked SUPERSEDED rather than deleted; decision trail preserved | closed |
| T-17-18 | Repudiation | unrecorded drill duration and disk envelope (closes T-14-73) | medium | mitigate | `write_drill_metrics` appends NDJSON + echoes both figures on success AND readiness-timeout paths (`restore-drill.sh:284-294,426,461`); tests 1-4 green | closed |
| T-17-19 | DoS | drill validating a stale host-built image post-cutover | medium | mitigate | `:?` guards on `GHCR_IMAGE_BASE`/`POSTGRES_IMAGE_TAG` fire before any container is created (`restore-drill.sh:387-388`); no fallback; observed firing in the live run | closed |
| T-17-20 | DoS | disk sampling aborting a drill under `set -Eeuo pipefail` | medium | mitigate | Sampling via `docker exec` with stderr discarded, `|| true` on the assignment, numeric regex — non-numeric = no sample; Test 5 asserts a failing sampler cannot fail the drill | closed |
| T-17-21 | Tampering | readiness-timeout failure branch weakened | medium | mitigate | `wait_for_scratch_ready` keeps its function/return-1 contract; failure-path + metrics-on-timeout tests assert no teardown ran | closed |
| T-17-22 | Info Disclosure | metrics record leaking secrets or tenant data | low | accept | AR-17-04 — see Accepted Risks Log | closed |
| T-17-23 | DoS | per-poll `du` adding load during a restore | low | accept | AR-17-05 — see Accepted Risks Log | closed |
| T-17-24 | Tampering | closing T-14-58/T-14-88 on code landing alone | high | mitigate | D-07 blocking checkpoint met with live pasted evidence: `docker inspect` GHCR ref, image id changed `de6a69e4…` → `e718495c…`, `compose config` shows no build key (`17-05-SUMMARY.md`, Attempt 3 APPROVED) | closed |
| T-17-25 | DoS | cutover leaving production down | high | mitigate | Pre-flight PostgreSQL 17.11 major-match before any production command; baseline image id + disk recorded; staged rollback existed and was NOT used in the approved attempt | closed |
| T-17-26 | Tampering | data loss during the container recreate | high | mitigate | Only `pull`/`up -d` for the two services; mount set compared pre/post and unchanged (three named `_prod` volumes) | closed |
| T-17-27 | EoP | RLS enabled-and-forced posture regressing across the image swap | high | mitigate | 28 tenant-scoped tables checked, all non-exempt `t/t`, `reputation_alert_state` `f/f` documented exemption, bad count 0; exempt set matches `verify-restored-database.ts:220` | closed |
| T-17-28 | Repudiation | WAL archiving silently not resuming after the recreate | high | mitigate | Bracketing `pg_stat_archiver` reads: `archived_count` 131→133, `failed_count` 67 unchanged, `last_failed` unmoved; verified against the ratified corrected criterion (`failed_count` is cumulative since 2026-08-14 stats reset — plan's literal "0" was unsatisfiable; correction committed to `backups.md:184-196`, WR-04) | closed |
| T-17-29 | DoS | drill exhausting host disk (T-14-73's own threat) | medium | mitigate | `df -h` pre-flight; self-measured high-water 170520 KB; derived free-disk-headroom rule (≥ 2× current PGDATA) at `restore-drill.md:287-300` | closed |
| T-17-30 | Tampering | emergency re-tag rollback silently persisting | medium | mitigate | Re-tag WAS used in Attempt 2, satisfied both required properties: reported immediately in the SUMMARY and not left in place (Attempt 3 cut over to GHCR and persists); Task 2 ran only against the GHCR ref | closed |
| T-17-31 | Repudiation | alloy/Loki confirmation from a crash-looping container | medium | mitigate | Two bracketing observations with identical `StartedAt` (`2026-08-19T14:51:16Z`), `RestartCount=0` in both — zero restarts across the whole bracket | closed |
| T-17-32 | Repudiation | executor flipping register rows without an auditor pass | high | mitigate | Commit `896b89e` diff: status column unchanged on every row; open-status count byte-identical (3==3); dated pending-auditor note names `/gsd-secure-phase` (D-12). The auditor pass has now run — see audit trail below | closed |
| T-17-33 | Tampering | `SPECIFICATION.md` describing the superseded locally-built image model | high | mitigate | §1.3/§2.6/§3.8 replaced with the CI-built/GHCR model; zero-count grep for the false claim; `check:spec-env-coverage` green (`package.json:23`, `ci.yml:184`) | closed |
| T-17-34 | Repudiation | evidence citations that do not resolve | medium | mitigate | Every citation names a SUMMARY file + heading; both cited headings exist with non-empty pasted output; §8.6 exists and is cited | closed |
| T-17-35 | Tampering | rewriting milestone-audit findings instead of annotating | medium | mitigate | Diff shows original finding text preserved verbatim with dated annotations appended; no finding line deleted | closed |
| T-17-36 | Info Disclosure | credential material pasted into planning documents | medium | mitigate | All `+` lines of the three 17-06 commits scanned for secret patterns: zero matches; citations by heading only | closed |
| T-17-37 | Tampering | `SPECIFICATION.md` gaining invented facts | medium | mitigate | Every newly written repository path resolves on disk (17/17); «не определено» rule honoured; no figure absent from a committed SUMMARY | closed |
| T-17-SC | Tampering | npm/pip/cargo installs (registered per-plan, ×6) | high | accept | AR-17-06 — see Accepted Risks Log | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-17-01 | T-17-05 | Ephemeral per-run test DSNs from `provision-db.ts` carry no production data and no real credential; no exposure beyond pre-existing `pg-tls.test.ts` | plan 17-01 threat model (plan-time disposition), verified by gsd-security-auditor | 2026-08-20 |
| AR-17-02 | T-17-10 | Row-elimination predicate `created_at >= $2::date` untouched; the cast was equally non-sargable before and after. Revisit trigger: dashboard latency regression at the 100k-1M contact target | plan 17-02 threat model, verified by gsd-security-auditor | 2026-08-20 |
| AR-17-03 | T-17-15 | Tag-not-digest pinning is the identical posture the three application images have carried since Phase 14 (OPS-01/OPS-02); digest pinning for one image alone would create two deploy models. Revisit trigger: any digest-pinning move must cover all four images in one change | plan 17-03 threat model, verified by gsd-security-auditor | 2026-08-20 |
| AR-17-04 | T-17-22 | Drill metrics record holds only the PITR target string, two integers, an outcome label and a UTC timestamp — no DSN, password, bucket name or row content; file lands outside the repo under `XDG_STATE_HOME` | plan 17-04 threat model, verified by gsd-security-auditor | 2026-08-20 |
| AR-17-05 | T-17-23 | Disk sampling reuses the existing readiness poll cadence (no second loop) against a scratch container in a drill window. Revisit trigger: drill against a materially larger data volume extending restore time | plan 17-04 threat model, verified by gsd-security-auditor | 2026-08-20 |
| AR-17-06 | T-17-SC (×6) | Zero new npm/pip/cargo dependencies phase-wide — empirically confirmed: no dependency-manifest commit exists during Phase 17 execution (from `17d274e`, 2026-08-19); the two 2026-08-18 manifest commits predate the phase and add no external package; escalated PRs #16/#17 touch no manifest. Stop-and-gate protocol documented in all six plans if an install ever becomes necessary | all six plan threat models, verified empirically by gsd-security-auditor | 2026-08-20 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-20 | 43 (37 numbered + T-17-SC ×6 per-plan) | 43 (37 verified-mitigated / accepted-with-evidence + 6 accepted T-17-SC) | 0 | gsd-security-auditor via `/gsd-secure-phase 17` (SECURED; same run re-verified and awarded FLIP-TO-CLOSED for 14-SECURITY.md's T-14-58/T-14-73/T-14-88 per D-12) |

**Non-blocking warnings recorded by the auditor (documentation-integrity residuals, no threat row, no verdict impact):**

1. `SPECIFICATION.md` §8.5 still asserts the VPS deploy/backup/restore facts are «не определено», contradicting the corrected §1.3 — same threat class as T-17-33 at a second anchor, deliberately left out of 17-06's scope. Candidate for a follow-up documentation pass.
2. `docker/postgres/Dockerfile:32,37` comments still say pgBackRest 2.59.0 while production observably runs 2.59.1 (ratified in-phase via the cross-version restore proof); `SPECIFICATION.md` and `backups.md` were corrected, the Dockerfile comment was out of scope.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-20 — gsd-security-auditor verdict SECURED under `/gsd-secure-phase 17`; register authored at plan time across all six plans; 17-VERIFICATION.md independently `status: passed` (32/32 must-haves).
