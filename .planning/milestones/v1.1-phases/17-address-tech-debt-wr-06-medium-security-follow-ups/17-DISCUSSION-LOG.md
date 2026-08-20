# Phase 17: Address tech debt: WR-06 + medium security follow-ups - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-19
**Phase:** 17-address-tech-debt-wr-06-medium-security-follow-ups
**Areas discussed:** WR-06 fix strategy, DB image immutability (T-14-58/88), Restore-drill metrics (T-14-73), Closure evidence & register updates

---

## WR-06 fix strategy

**Q: How should the WR-06 timezone hazard be fixed?**

| Option | Description | Selected |
|--------|-------------|----------|
| Both layers (Recommended) | Pin TimeZone='UTC' in the pool factory AND add read-site AT TIME ZONE 'UTC' cast — defense in depth | ✓ |
| Pool-level pin only | One change in packages/db/src/pool.ts anchors all connections | |
| Read-site cast only | Minimal change to dashboard.repository.ts matching reconcileWorkspaceDay | |

**Q: How strong should the WR-06 regression proof be?**

| Option | Description | Selected |
|--------|-------------|----------|
| Non-UTC Postgres test (Recommended) | Behavioral test against a deliberately non-UTC session/server proving UTC day boundaries hold | ✓ |
| SHOW timezone assertion only | Assert SHOW TimeZone = 'UTC' on a pooled connection | |
| Both + boot-time assert | Behavioral test + assertion + fail-loud runtime check in the pool factory | |

**Q: How broad should the read-site fix sweep be?**

| Option | Description | Selected |
|--------|-------------|----------|
| Audit-named site + audit others (Recommended) | Fix dashboard.repository.ts queries, grep-audit remaining bare ::date casts, record the rest verified-safe | ✓ |
| Named site only | Fix exactly the WR-06 citation | |
| Full repo-wide cast sweep | Mechanically convert every ::date cast on naive timestamps | |

**Q: Should the naive timestamp columns be migrated to timestamptz?**

| Option | Description | Selected |
|--------|-------------|----------|
| No migration (Recommended) | Keep timestamp columns; pin + casts close the hazard (matches Phase 13's handling) | ✓ |
| Migrate contacts only | ALTER contacts.created_at to timestamptz | |
| Defer as backlog note | Record a deferred idea for a future schema-hygiene phase | |

---

## DB image immutability (T-14-58/88)

**Q: How should the megacrm-postgres image come under the immutability discipline?**

| Option | Description | Selected |
|--------|-------------|----------|
| CI-build to GHCR (Recommended) | Build in GitHub Actions, push on SHA tags, drop build: sections, extend FIRST_PARTY_IMAGE_SERVICES | ✓ |
| Dedicated tag gate, keep host builds | validate-prod-compose check that POSTGRES_IMAGE_TAG is non-mutable | |
| Formal risk acceptance | AR rows accepting the host-built image | |

**Q: How should the CI-built megacrm-postgres image be tagged relative to the app images?**

| Option | Description | Selected |
|--------|-------------|----------|
| Same SHA, every merge (Recommended) | Built alongside api/worker/web on every master merge, same git SHA; deploy.sh keeps single-SHA interface | ✓ |
| Path-triggered, own tag | Build only when docker/postgres/** changes; independent tag lifecycle | |
| You decide | Planner picks based on script consumption | |

**Q: When and how does production switch to the CI-built postgres image?**

| Option | Description | Selected |
|--------|-------------|----------|
| Checkpointed cutover in-phase (Recommended) | Operator blocking checkpoint: pull, restart db+pgbackrest, verify health/RLS/WAL archiving | ✓ |
| Code now, switch at next deploy | Rows stay open-pending-deploy | |
| You decide | Planner weighs downtime tolerance | |

---

## Restore-drill metrics (T-14-73)

**Q: Does this phase actually run a restore drill to capture the T-14-73 figures?**

| Option | Description | Selected |
|--------|-------------|----------|
| Run drill in-phase (Recommended) | Checkpointed drill after the image cutover; doubles as proof the CI-built image restores | ✓ |
| Instrument only | Add capture to restore-drill.sh; T-14-73 stays open until next scheduled drill | |
| Instrument + run | Land instrumentation first, then run the drill | |

**Q: How are the drill's disk/duration figures captured?**

| Option | Description | Selected |
|--------|-------------|----------|
| Script self-records (Recommended) | Timing + disk-usage sampling added to restore-drill.sh output | ✓ |
| Manual this time | Operator hand-notes df output and wall-clock time | |

**Note:** Although "Run drill in-phase" was selected over "Instrument + run", the follow-up capture question selected script self-recording — the effective outcome equals instrument-then-run.

---

## Closure evidence & register updates

**Q: How thorough should the documentation closure trail be?**

| Option | Description | Selected |
|--------|-------------|----------|
| Full trail (Recommended) | 14-SECURITY.md row flips + milestone-audit annotation + SPECIFICATION.md updates | ✓ |
| Register + spec only | Leave the milestone-audit doc as a point-in-time snapshot | |
| Phase artifacts only | Closure lives in SUMMARYs/VERIFICATION only | |

**Q: Should the Phase 15 alloy prod-deploy confirmation ride along on this phase's cutover checkpoint?**

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, fold it in (Recommended) | Operator verifies alloy container stable + Loki receiving during the cutover session | ✓ |
| No, keep separate | Waits for a regular app deploy | |

**Q: What sign-off closes the T-14 threat rows?**

| Option | Description | Selected |
|--------|-------------|----------|
| Security-auditor re-run (Recommended) | /gsd-secure-phase verifies each mitigation before rows flip to closed | ✓ |
| In-phase verification only | VERIFICATION.md + checkpoint evidence justifies the flips | |
| You decide | Planner picks based on phase weight | |

---

## Claude's Discretion

- Exact pool-pin mechanism (Pool `options` vs connect-event `SET`), non-UTC test placement, CI provisioning of the non-UTC Postgres
- CI workflow shape for the postgres image build; dev-compose local build path; tag fallback behavior
- Drill PITR target choice; metrics output format
- Intra-phase sequencing beyond "drill after cutover"

## Deferred Ideas

- Full `timestamptz` migration of naive timestamp columns — future schema-hygiene candidate (rejected for this phase in D-04)
