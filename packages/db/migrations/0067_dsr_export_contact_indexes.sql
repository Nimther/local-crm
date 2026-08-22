-- Phase 21 (DSR-02/DSR-03, plan 21-06): the three contact-scoped indexes
-- the journey sections (`flowParticipation`, `campaignMemberships`) of the
-- per-contact DSR export read against, closing the index gap
-- 21-RESEARCH.md's Common Pitfalls -> Pitfall 2 verified.
--
-- Verified state before this migration: `events` and `sends` already carry
-- leading `(workspace_id, contact_id)` indexes (`idx_events_workspace_contact_time`,
-- `idx_sends_workspace_contact_sent_at`, see SPECIFICATION.md 4.5). `flow_runs`'
-- only contact-scoped index is `flow_runs_one_active_per_contact`
-- (0026_flows.sql) -- a PARTIAL UNIQUE index restricted to
-- `WHERE status IN ('waiting', 'advancing')` -- so completed/exited/ejected
-- runs, exactly the processing history the export must show under GDPR
-- Art. 15 (D-04), are covered by nothing. `campaign_recipients`' only index
-- is its `(campaign_id, contact_id)` UNIQUE constraint
-- (`campaign_recipients_campaign_contact_unique`), which does not lead with
-- `contact_id` and cannot serve a contact-scoped lookup. `flow_run_steps`
-- has no index at all on its `flow_run_id` foreign key -- Postgres does not
-- create one automatically for a FK column, and the export's per-run step
-- walk depends on it.
--
-- REQUIREMENTS.md's out-of-scope note justifies keeping the DSR export
-- synchronous by asserting leading `(workspace_id, contact_id)` indexes
-- exist on every table it reads. Before this migration that assertion was
-- only half true; this migration is what makes it true. Phase 22's purge
-- scans the same three tables by contact and inherits the same benefit.
--
-- Plain (non-partial, non-unique) `CREATE INDEX`, not the online/
-- non-blocking build form Postgres also supports: this repository applies
-- every migration file as a single `client.query(sql)` call inside one
-- implicit transaction (see migrate-runner.mjs), and that online-build form
-- of index creation cannot run inside a transaction block at all -- using
-- it here would make this file fail at apply time on every environment.
-- No destructive DDL below, so no destructive marker is needed.
CREATE INDEX idx_flow_runs_workspace_contact ON flow_runs (workspace_id, contact_id);
--> statement-breakpoint
CREATE INDEX idx_campaign_recipients_workspace_contact ON campaign_recipients (workspace_id, contact_id);
--> statement-breakpoint
CREATE INDEX idx_flow_run_steps_flow_run_id ON flow_run_steps (flow_run_id);

COMMENT ON INDEX idx_flow_runs_workspace_contact IS
  'DSR-02/D-04 (plan 21-06): leading (workspace_id, contact_id) index backing the DSR export''s and Phase 22 purge''s unconditional flow_runs-by-contact walk -- deliberately NOT partial, unlike flow_runs_one_active_per_contact (0026), which only covers waiting/advancing.';
--> statement-breakpoint
COMMENT ON INDEX idx_campaign_recipients_workspace_contact IS
  'DSR-02/D-04 (plan 21-06): leading (workspace_id, contact_id) index backing the DSR export''s and Phase 22 purge''s campaign_recipients-by-contact walk -- the table''s only prior index led with campaign_id, not contact_id.';
--> statement-breakpoint
COMMENT ON INDEX idx_flow_run_steps_flow_run_id IS
  'DSR-02/D-04 (plan 21-06): index on the flow_run_id foreign key, which Postgres does not create automatically -- backs the DSR export''s per-run step walk (selectFlowRunStepsPage).';
