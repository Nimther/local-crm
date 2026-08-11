-- Phase 10 (SEC-01/SEC-02, D-01/D-02/D-03, checkpoint option-b) --
-- completes the retirement of the `app.admin_scan` session-marker GUC
-- pattern this codebase used through Phase 9. Drops the five legacy
-- policies whose predicate reads ONLY `current_setting('app.admin_scan',
-- true) = 'true'`: `campaign_scheduler_due_scan` (0018),
-- `flow_runs_due_scan` (0027), `flows_segment_sweep_scan` (0032), and
-- `partition_relocation_admin_scan` on BOTH `contacts` and `sends` (0039).
-- Each of the first three has already had its consumer migrated to
-- `mega_crm_scan`/`withCrossWorkspaceScan` with a role-scoped, predicate-
-- narrowed replacement (0041/0042); the fifth's consumer
-- (`attachPartitionCheckFirst`, `packages/db/src/partitions/ensure-partitions.ts`)
-- is migrated in this SAME plan (10-06) to an operator-supplied elevated
-- connection (`options.adminClient`, held only by
-- `packages/db/scripts/relocate-default-partition-rows.ts` via
-- `PARTITION_RELOCATION_ADMIN_DATABASE_URL`) instead of a session GUC.
--
-- The policy side (this file) and the code side (this plan's other
-- commits, same plan) ship together deliberately: reverting one without the
-- other would either leave a dead policy nobody sets (harmless but
-- misleading) or remove the policy while code still tries to set the GUC
-- and silently gets no visibility from it (a correctness regression the
-- next non-empty relocation attempt would surface as a spurious FK
-- violation, not a silent leak -- `attachPartitionCheckFirst` fails loudly
-- when FK re-validation cannot see the rows it needs). They must not be
-- reverted independently.
--
-- After this migration: no policy in `pg_policies` references
-- `app.admin_scan` anywhere in its `qual`/`with_check` (proven by
-- packages/tenant-context/src/__tests__/scan.test.ts's catalog assertion),
-- and no first-party source file sets it (proven by
-- `npm run lint:session-state` and the same test file's seeded negative
-- assertion).

-- destructive: superseded by campaigns_scan (migration 0041), which carries
-- the same status='scheduled' AND scheduled_at<=now() predicate, role-scoped
-- to mega_crm_scan instead of GUC-gated -- leaving this policy in place
-- keeps a session-settable path to cross-tenant campaign reads alive.
DROP POLICY campaign_scheduler_due_scan ON campaigns;

-- destructive: superseded by flow_runs_scan (migration 0042), which
-- restores the status='waiting' AND next_wake_at<=now() narrowing predicate
-- this policy never carried -- leaving this policy in place keeps an
-- unconditional, session-settable path to every workspace's flow_runs
-- alive.
DROP POLICY flow_runs_due_scan ON flow_runs;

-- destructive: superseded by flows_scan (migration 0042), which restores
-- the live/segment-triggered/published narrowing predicate this policy
-- never carried -- leaving this policy in place keeps an unconditional,
-- session-settable path to every workspace's flows alive.
DROP POLICY flows_segment_sweep_scan ON flows;

-- destructive: the DEFAULT-relocation ATTACH step (attachPartitionCheckFirst,
-- ensure-partitions.ts) no longer sets app.admin_scan -- it now runs on an
-- operator-supplied, RLS-bypassing elevated connection instead. Leaving this
-- policy in place keeps a session-settable path to every workspace's
-- contacts alive for any code holding the ordinary tenant pool.
DROP POLICY partition_relocation_admin_scan ON contacts;

-- destructive: same reasoning as the contacts policy above, on sends.
DROP POLICY partition_relocation_admin_scan ON sends;
