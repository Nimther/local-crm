import { readShippedMigrations } from "./migration-journal.js";

/**
 * Phase 14 plan 05 (DB-07) -- every migration in this repository's history
 * classified into exactly one of two tiers, so "can I roll back the deploy I
 * just shipped" has a machine-checked answer instead of a hope.
 *
 * - "auto-reversible": a mechanical DDL inverse exists for everything this
 *   migration did (drop the table/column/index/constraint it added), and
 *   applying that inverse destroys nothing that existed BEFORE this
 *   migration ran. This is a claim about the SHAPE of the change, not a
 *   promise that reverting late in a live system is free -- any revert of a
 *   real, in-service migration can discard data written since it applied
 *   (that is inherent to schema rollback generally, see the runbook), but the
 *   inverse SQL statement itself always exists and always terminates.
 * - "forward-only": no such mechanical inverse exists, for one of five
 *   reasons (see below) -- reverting can only be done by restoring from a
 *   backup, never by running more DDL.
 *
 * Five reasons a migration is forward-only, one line each -- write these
 * here so the next person's instinct to "just write the down migration"
 * stops here instead of at 2am during an incident:
 *
 * 1. CREATE TYPE / ALTER TYPE ... ADD VALUE -- Postgres cannot remove an enum
 *    value (or the type it belongs to, once anything references it) without
 *    recreating the type from scratch under every dependent column.
 * 2. CREATE POLICY / ALTER POLICY -- an RLS policy revert changes the
 *    access-control posture that protects tenant isolation, not merely a
 *    table's shape; reverting one can silently widen or narrow who can read
 *    what, which is a security decision, not a schema decision.
 * 3. DROP POLICY -- the same access-control reasoning as (2), read backwards:
 *    reverting a drop means RE-adding an access rule that was deliberately
 *    retired, which is exactly as much a posture change as removing one.
 * 4. ATTACH PARTITION -- partition DDL moves live rows between physical
 *    relations; detaching one back out is not the same operation run in
 *    reverse, and can leave rows unreachable from either side mid-operation.
 * 5. DROP COLUMN / DROP CONSTRAINT -- the data (or the enforcement) is gone;
 *    re-adding the column or constraint recreates the SHAPE, never the
 *    values or the history of what was rejected while it was enforced.
 *
 * Two more reasons that produce the same tier without matching any of the
 * five SQL signatures above (the automated scan in this module's test only
 * checks for the five; these are judgment calls made by reading the
 * migration, per this plan's own instruction not to pattern-match alone):
 *
 * - An irreversible DATA mutation (an UPDATE/backfill that overwrites values
 *   with no way to tell, after the fact, which rows were touched and what
 *   they held before) is forward-only even though it is not a DDL statement
 *   at all -- 0034 and 0046 below.
 * - A GRANT/REVOKE-only migration (0045) has no table/column/index/
 *   constraint to derive a "drop the X" inverse from, AND revoking/
 *   re-granting broad privileges on secret-bearing tables is itself an
 *   access-control posture change -- same category as (2)/(3) above, by a
 *   different mechanism.
 * - A pure data INSERT with no accompanying DDL in the same file (0040) has
 *   no table/column/index/constraint of its OWN to drop -- the table it
 *   seeds was created by an earlier, already-shipped migration, so there is
 *   no mechanically derivable inverse under this module's supported
 *   vocabulary (drop table / drop column / drop index / drop constraint).
 *   The correct inverse would be a DELETE, which is data manipulation, not
 *   schema DDL, and is deliberately outside what this tier promises.
 *
 * Classified by reading every migration in
 * `packages/db/migrations/*.sql` (63 files, tags 0000-0062 at this commit),
 * cross-checked by this module's own test scanning the raw SQL for the five
 * signatures above. `tierFor` throws rather than defaulting for an unknown
 * tag, because a defaulted tier would silently tell an operator a
 * destructive migration is safe to revert.
 */
export type MigrationTier = "auto-reversible" | "forward-only";

export const MIGRATION_TIERS: Readonly<Record<string, MigrationTier>> = Object.freeze({
  "0000_init_auth": "auto-reversible", // pure CREATE TABLE + FK constraints
  "0001_rls_policies": "forward-only", // CREATE POLICY
  "0002_invitation_created_at": "auto-reversible", // ADD COLUMN
  "0003_eminent_meltdown": "forward-only", // CREATE TYPE
  "0004_contacts_rls_policies": "forward-only", // CREATE POLICY
  "0005_open_lord_hawal": "auto-reversible", // CREATE TABLE + FK
  "0006_api_keys_rls_policies": "forward-only", // CREATE POLICY
  "0007_events_partitioned": "forward-only", // CREATE POLICY
  "0008_exotic_skullbuster": "auto-reversible", // CREATE TABLE + FK (csv_import_rows/csv_imports)
  "0009_csv_imports_rls_policies": "forward-only", // CREATE POLICY
  "0010_events_workspace_scoped_pk": "forward-only", // DROP CONSTRAINT
  "0011_segments": "auto-reversible", // CREATE TABLE + FK
  "0012_segments_rls_and_indexes": "forward-only", // CREATE POLICY
  "0013_campaigns": "forward-only", // CREATE TYPE + CREATE POLICY
  "0014_campaign_recipients": "forward-only", // CREATE POLICY
  "0015_sends": "forward-only", // CREATE TYPE + CREATE POLICY
  "0016_workspace_send_settings": "forward-only", // CREATE POLICY
  "0017_campaigns_fan_out_complete": "auto-reversible", // ADD COLUMN
  "0018_campaigns_scheduler_scan_policy": "forward-only", // CREATE POLICY
  "0019_campaigns_workspace_isolation_nullif_guard": "forward-only", // ALTER POLICY -- access-control expression change, same reasoning as CREATE POLICY
  "0020_send_events_partitioned": "forward-only", // CREATE POLICY
  "0021_webhook_endpoints": "forward-only", // CREATE POLICY
  "0022_sends_delivery_columns": "auto-reversible", // ADD COLUMN x9
  "0023_contacts_soft_bounce_streak": "auto-reversible", // ADD COLUMN
  "0024_campaigns_delivery_counters": "auto-reversible", // ADD COLUMN x5
  "0025_webhook_provision_error": "auto-reversible", // ADD COLUMN
  "0026_flows": "forward-only", // CREATE TYPE + CREATE POLICY
  "0027_flows_scheduler_scan_policy": "forward-only", // CREATE POLICY
  "0028_sends_flow_columns": "auto-reversible", // ADD COLUMN + ADD CONSTRAINT + CREATE UNIQUE INDEX
  "0029_contacts_timezone": "auto-reversible", // ADD COLUMN
  "0030_workspace_send_settings_timezone_quiet_hours": "auto-reversible", // ADD COLUMN x4
  "0031_flows_exit_conditions": "auto-reversible", // ADD COLUMN
  "0032_flows_segment_sweep_scan_policy": "forward-only", // CREATE POLICY
  "0033_flows_enroll_cursor": "auto-reversible", // ADD COLUMN
  "0034_flows_quiet_hours_mode_canonical": "forward-only", // irreversible data UPDATE (legacy-value normalization, not distinguishable from post-migration writes)
  "0035_csv_imports_default_timezone": "auto-reversible", // ADD COLUMN
  "0036_analytics_status_history_counts": "forward-only", // CREATE POLICY
  "0037_workspace_daily_rollup": "forward-only", // CREATE POLICY
  "0038_partition_catchup_and_maintenance_runs": "forward-only", // ATTACH PARTITION
  "0039_partition_relocation_admin_scan": "forward-only", // CREATE POLICY
  "0040_partition_maintenance_runs_seed": "forward-only", // pure data INSERT into an earlier migration's table, no derivable DDL inverse
  "0041_scan_role_bootstrap": "forward-only", // CREATE POLICY
  "0042_scan_role_grants_and_policies": "forward-only", // CREATE POLICY
  "0043_retire_admin_scan_guc_policies": "forward-only", // DROP POLICY, self-documented as "must not be reverted independently"
  "0044_workspace_isolation_fail_closed": "forward-only", // CREATE POLICY
  "0045_auth_role_grants": "forward-only", // GRANT/REVOKE only -- access-control posture change, no table/column/index/constraint inverse
  "0046_api_key_scopes_backfill": "forward-only", // irreversible data UPDATE (scope backfill, not distinguishable from a deliberately-empty key afterward)
  "0047_send_status_reconciling": "forward-only", // ALTER TYPE ... ADD VALUE
  "0048_send_status_unknown": "forward-only", // ALTER TYPE ... ADD VALUE
  "0049_send_reconciliation_columns": "auto-reversible", // ADD COLUMN x3 + CREATE INDEX x2
  "0050_send_reconciler_runs": "auto-reversible", // CREATE TABLE (+ seed INSERT into the table this same file creates -- DROP TABLE undoes both)
  "0051_sends_campaign_ambiguous_index": "auto-reversible", // CREATE INDEX
  "0052_sends_reconciling_status_index": "auto-reversible", // CREATE INDEX
  "0053_flow_segment_sweep_checkpoint": "forward-only", // CREATE POLICY
  "0054_dead_letter_jobs": "auto-reversible", // CREATE TABLE x2 + seed INSERT into a table this same file creates
  "0055_webhook_ingress_durability": "forward-only", // CREATE POLICY
  "0056_workspace_daily_rollup_dirtied_at": "auto-reversible", // ADD COLUMN + CREATE INDEX
  "0057_send_events_dedup_rebase": "forward-only", // ATTACH PARTITION + DROP CONSTRAINT
  "0058_reputation_and_ingestion_alert_state": "auto-reversible", // CREATE TABLE x2 + seed INSERT into a table this same file creates
  "0059_contact_erasure": "forward-only", // CREATE POLICY
  "0060_suppression_hash_expand": "forward-only", // CREATE POLICY
  "0061_suppression_hash_contract": "forward-only", // DROP COLUMN + DROP CONSTRAINT
  "0062_member_unique_org_user": "auto-reversible", // CREATE UNIQUE INDEX + ADD CONSTRAINT ... UNIQUE USING INDEX
  "0063_partition_retention_drops": "auto-reversible", // ADD COLUMN x3 on partition_maintenance_runs + CREATE TABLE partition_retention_drops -- pure additive shape, destroys nothing that existed before
  "0064_ops_alert_state_and_rollup_watermark": "auto-reversible", // CREATE TABLE ops_alert_state + ADD COLUMN workspace_daily_rollup.updated_at -- pure additive shape, no backfill, destroys nothing that existed before
  "0065_webhook_endpoints_scan_grant": "forward-only", // GRANT (column-level) + CREATE POLICY -- access-control posture change, same reasoning as 0045/0042 (no table/column/index/constraint of its own to derive a "drop the X" inverse from, and revoking/re-granting scan-role privileges plus a row-security policy is itself a security decision, not a schema decision)
  "0066_campaigns_version": "auto-reversible", // single ADD COLUMN with a constant default and no backfill -- the mechanical inverse (drop the column) destroys only the token this migration introduced and nothing that existed before it
  "0067_dsr_export_contact_indexes": "auto-reversible", // three plain CREATE INDEX statements (plus COMMENT ON INDEX) -- no table/column/constraint change, no backfill; dropping the three indexes destroys only bookkeeping this migration introduced and nothing pre-existing
  "0068_workspace_purge_records": "auto-reversible", // CREATE TABLE purge_records (no RLS, no FK) + ADD COLUMN organization.purgedAt -- pure additive shape, no backfill, destroys nothing that existed before
});

/**
 * Returns the tier for a shipped migration tag. Throws rather than
 * defaulting, because a defaulted tier would silently tell an operator a
 * destructive (forward-only) migration is safe to auto-revert.
 */
export function tierFor(tag: string): MigrationTier {
  const tier = MIGRATION_TIERS[tag];
  if (tier === undefined) {
    throw new Error(
      `tierFor: unknown migration tag "${tag}" -- it has not been classified in MIGRATION_TIERS (packages/db/src/migration-tiers.ts). Every migration in packages/db/migrations/meta/_journal.json must have an entry before it can be reasoned about as reversible or not.`,
    );
  }
  return tier;
}

/**
 * The contiguous run of auto-reversible tags at the END of the shipped
 * migration history, oldest-first (so the rehearsal can revert them in
 * reverse order). Reuses `readShippedMigrations` (packages/db/src/
 * migration-journal.ts, plan 14-01) as the one shared "what has shipped, in
 * what order" definition, rather than re-deriving journal order here.
 *
 * Walks backward from the newest shipped migration; stops at the first
 * forward-only tag. Returns an empty array when the newest migration is
 * itself forward-only -- there is nothing in the trailing tier to rehearse.
 */
export function newestAutoReversibleTier(migrationsFolder?: string): string[] {
  const shipped = readShippedMigrations(migrationsFolder);
  const run: string[] = [];
  for (let i = shipped.length - 1; i >= 0; i--) {
    const tag = shipped[i]?.tag;
    if (tag === undefined) break;
    if (tierFor(tag) !== "auto-reversible") break;
    run.unshift(tag);
  }
  return run;
}
