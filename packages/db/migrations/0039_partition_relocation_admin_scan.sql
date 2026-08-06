-- 09-04 (DB-03/DB-04): a SELECT-only, admin-scan-gated permissive policy on
-- `contacts` and `sends`, mirroring the campaign_scheduler_due_scan (0018) /
-- flow_runs_due_scan (0027) / flows_segment_sweep_scan (0032) precedent for
-- cross-tenant discovery/verification scans.
--
-- `attachPartitionCheckFirst` (packages/db/src/partitions/ensure-partitions.ts)
-- sets `app.admin_scan` inside its own transaction, immediately after BEGIN.
-- PostgreSQL automatically validates a partitioned table's inherited FOREIGN
-- KEY constraints against the referenced table whenever a NON-EMPTY child is
-- attached -- for `events.contact_id -> contacts(id)` and
-- `send_events.send_id -> sends(id)`, both referenced tables carry
-- FORCE ROW LEVEL SECURITY, so without this policy the internal validation
-- scan sees zero contacts/sends rows (no single `app.current_workspace_id`
-- value can cover a DEFAULT backlog spanning many tenants at once) and every
-- such ATTACH fails with a spurious foreign key violation.
--
-- Discovered during 09-04 task 1: `attachPartitionCheckFirst` had only ever
-- been called (09-01) to attach an EMPTY newly-created month, where the FK
-- validation trivially passes regardless of RLS visibility (zero rows to
-- check). 09-04's DEFAULT relocation is the first caller that populates the
-- freestanding child with real, potentially multi-tenant rows BEFORE
-- attaching it -- a row already sitting in DEFAULT was already validated
-- against `contacts`/`sends` at its original INSERT time (the FK's
-- `ON DELETE CASCADE` guarantees it cannot have outlived its reference
-- since), so this policy does not weaken referential integrity -- it only
-- lets PostgreSQL's own redundant re-validation see the rows it needs to.
--
-- SELECT-only, gated purely on the marker GUC (no further predicate,
-- mirroring flows_segment_sweep_scan): the relocation procedure cannot
-- predict in advance which contact/send rows a given month's backlog will
-- reference. Every write in this codebase re-enters the ordinary
-- workspace_isolation policy as normal -- this policy grants read
-- visibility only, and only for the duration of the one transaction
-- attachPartitionCheckFirst runs.
--
-- Deliberately NOT paired with a NULLIF guard on contacts'/sends' EXISTING
-- workspace_isolation policy, unlike 0019's companion fix for campaigns.
-- `packages/tenant-context/src/__tests__/tenant-context.test.ts` pins
-- contacts (and, by the same SPECIFICATION.md §4.3 accounting, sends) as
-- PRE-PHASE-10 bare-cast baselines that Phase 10 / SEC-03 must convert
-- deliberately, in one coordinated migration across all twelve fail-closed
-- tables -- not as an incidental side effect of an unrelated Phase 9
-- feature. That means the caller of attachPartitionCheckFirst is
-- responsible for never handing it a connection that has previously run a
-- tenant-scoped `SET LOCAL app.current_workspace_id` (which is what makes
-- the bare cast throw on a recycled connection, per that test's own
-- documented baseline): a connection that has NEVER been tenant-scoped
-- reads the GUC as NULL, not '', and `workspace_id = NULL` in the OTHER
-- (bare-cast) policy evaluates to NULL/false rather than erroring, so the OR
-- with this admin-scan policy resolves cleanly. This is a property each
-- CALLER of ensurePartitions/attachPartitionCheckFirst must uphold -- it is
-- not something this policy, or attachPartitionCheckFirst itself, can
-- verify or enforce. Every caller in this codebase today does uphold it,
-- each with its own dedicated pool, entirely separate from the app's
-- tenant-scoped `@mega-crm/tenant-context` pool: the CLI script
-- (packages/db/scripts/relocate-default-partition-rows.ts), Task 1's own
-- test suite (a dedicated pool for the relocation calls, distinct from the
-- pool used for tenant-scoped seeding), and -- since 09-REVIEW CR-03 -- the
-- daily maintenance worker (apps/worker/src/queues/partition-maintenance.worker.ts's
-- own dedicated pool; before that fix it defaulted to the shared pool, an
-- unenforced violation of this same invariant that had not yet been
-- exploitable only because its own call path never attached a non-empty
-- child).
CREATE POLICY partition_relocation_admin_scan ON contacts
  FOR SELECT
  USING (
    current_setting('app.admin_scan', true) = 'true'
  );

CREATE POLICY partition_relocation_admin_scan ON sends
  FOR SELECT
  USING (
    current_setting('app.admin_scan', true) = 'true'
  );
