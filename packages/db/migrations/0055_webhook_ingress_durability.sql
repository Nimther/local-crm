-- Phase 13 (CMP-08, D-05, plan 13-01) -- ingress_journal: the durable record
-- of a verified SendGrid webhook batch, written INSIDE the request that
-- verified it, BEFORE that batch is ever enqueued. Today a batch exists only
-- as an in-flight BullMQ job -- a Redis flush, a worker crash before the job
-- is claimed, or a bad deploy loses it with no trace anywhere. This table is
-- what makes post-receipt loss replayable without any paid provider API: the
-- verified raw bytes are already on disk the instant they are trusted, and
-- the worker closes the loop by marking `ingestion_completed_at` on every
-- terminal-success path (webhook-events.worker.ts's processWebhookEventBatch,
-- this same plan).
--
-- Unlike `dead_letter_jobs` (0054, deliberately NOT tenant-scoped -- see that
-- migration's own header), this table carries tenant recipient PII in
-- `raw_batch` (the verified SendGrid event batch, which includes recipient
-- email addresses and message metadata) and therefore MUST carry the same
-- fail-closed, role-scoped RLS every other tenant-scoped table in this
-- codebase does -- the bare-cast predicate migration 0044 standardised
-- (RESEARCH.md Pitfall 1): no `NULLIF`, no `missing_ok` second argument to
-- `current_setting`, so an unscoped connection THROWS rather than silently
-- returning zero rows.
--
-- `raw_batch` is NULLABLE and `payload_purged_at timestamptz` exists
-- alongside it -- a decision, not an omission (REVIEWS.md, Codex follow-up,
-- WARNING finding 6). The retention horizon has to dispose of two different
-- things that a single unconditional DELETE would conflate: the recipient
-- PII in the raw payload, and the evidence that a batch was received and
-- never ingested. Deleting the row disposes of both at once, which means an
-- incomplete or attempt-capped batch silently stops existing the moment it
-- ages out -- taking with it the only trace that ingestion lost data, and
-- ending plan 13-11's ability to alert on it. Splitting the two
-- (`pruneIngressJournal`/`purgeExpiredIngressJournalPayloads`,
-- packages/db/src/webhooks/ingress-journal.ts) lets the payload go at the
-- horizon while the row survives as a non-PII tombstone. The CHECK below is
-- what stops the nullable column from weakening the write-time guarantee: at
-- insert time `payload_purged_at` is null, so `raw_batch` must be present,
-- exactly as `NOT NULL` would have required; the only way to reach a null
-- payload is through the purge, which sets the marker in the SAME statement.
CREATE TABLE ingress_journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  raw_batch jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  ingestion_completed_at timestamptz,
  replay_count integer NOT NULL DEFAULT 0,
  payload_purged_at timestamptz,
  CONSTRAINT ingress_journal_payload_purge_check CHECK (raw_batch IS NOT NULL OR payload_purged_at IS NOT NULL)
);

COMMENT ON TABLE ingress_journal IS
  'Durable pre-enqueue record of a verified SendGrid webhook batch (Phase 13, CMP-08, D-05). Unlike dead_letter_jobs (0054, platform-operations metadata with no workspace_id), this table carries tenant recipient PII and therefore requires ENABLE + FORCE ROW LEVEL SECURITY with the fail-closed workspace_isolation predicate every other tenant table in this codebase carries.';

COMMENT ON COLUMN ingress_journal.payload_purged_at IS
  'A non-null value means this row is a tombstone: the batch is permanently unreplayable, its raw payload has been disposed of at the retention horizon (purgeExpiredIngressJournalPayloads), and the row is retained solely so an unrecovered ingestion loss stays visible to the operator (plan 13-11''s watchdog). See ingress_journal_payload_purge_check for the invariant this column enforces jointly with raw_batch.';

ALTER TABLE ingress_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingress_journal FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON ingress_journal TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

-- Backs findStuckIngressJournalRows (packages/db/src/webhooks/ingress-journal.ts):
-- a partial index scoped to exactly the rows that query and the 13-11
-- watchdog both care about -- an incomplete batch, however old. A completed
-- row (the overwhelming majority once the system is healthy) never needs to
-- be found by this query and is excluded from the index entirely.
CREATE INDEX ingress_journal_incomplete_received_at_idx ON ingress_journal (received_at)
  WHERE ingestion_completed_at IS NULL;

-- Scan-role read access (REVIEWS.md HIGH finding 2): migration 0042's
-- `GRANT SELECT` names exactly five tables (flow_runs, flows, contacts,
-- sends, organization) and ingress_journal is not among them. Without the
-- three statements below, plan 13-11's readIngestionHealth throws
-- permission-denied on every interval, that throw is swallowed by the
-- interval's own catch, and the CMP-08 alert silently never fires -- with no
-- signal that it is not firing. This mirrors 0042's complete pattern for
-- granting an RLS-forced table to the scan role: GRANT, a role-scoped
-- CREATE POLICY carrying a narrowing predicate, and an ALTER POLICY that
-- excludes the app policy from the scan role's query plans.
GRANT SELECT ON ingress_journal TO mega_crm_scan;

-- Narrowed to `ingestion_completed_at IS NULL` -- following 0042's
-- `flow_runs_scan`/`flows_scan` narrowed form rather than the
-- `contacts_scan`/`sends_scan` `USING (true)` form, because unlike those two
-- readers this one's WHERE clause is known in advance and mirrors exactly
-- the rows the health question (13-11) is about. The scan role therefore
-- never sees a completed batch's row, only the ones the health question
-- exists to surface.
--
-- A purged tombstone row (payload_purged_at IS NOT NULL) still satisfies
-- `ingestion_completed_at IS NULL` and therefore STAYS VISIBLE to the scan
-- role through this SAME policy, unchanged -- plan 13-11 needs no additional
-- grant to count unrecoverable batches. Narrowing this predicate further
-- (for instance to also require `payload_purged_at IS NULL`) would silently
-- hide exactly the rows the operator most needs to see. Do not "tidy up"
-- this predicate later without re-reading this comment.
CREATE POLICY ingress_journal_scan ON ingress_journal
  FOR SELECT TO mega_crm_scan
  USING (ingestion_completed_at IS NULL);

-- Role-scopes the app policy so it is excluded from the scan role's query
-- plans (RESEARCH.md Pitfall 2 / 0042's own reasoning): an unscoped
-- workspace_isolation policy is combined via OR with every other permissive
-- policy applicable to a query's role, including ingress_journal_scan above
-- -- without this explicit TO clause, a mega_crm_scan query against this
-- table would ALSO have to satisfy (or error on) workspace_isolation's own
-- predicate. The CREATE POLICY above already declares `TO mega_crm_app`
-- directly, so this ALTER is an idempotent re-assertion of that same role
-- scope (0044's own precedent for a table that already carries the correct
-- scope from its own CREATE) -- included explicitly so the acceptance
-- criterion naming this exact statement is satisfied by the DDL itself, not
-- only by inspection of the CREATE POLICY clause above.
ALTER POLICY workspace_isolation ON ingress_journal TO mega_crm_app;

-- send_event_quarantine (Task 2, same migration slot) intentionally receives
-- NO grant to mega_crm_scan and NO scan policy of any kind here -- nothing in
-- this phase reads it cross-workspace. Mirrors flow_segment_sweep_checkpoint's
-- (0053) "granted NOTHING" precedent: discovery-role access is added only
-- when a real cross-workspace consumer exists, never speculatively.

-- Phase 13 (CMP-08, D-05, plan 13-01, Task 2) -- send_event_quarantine: a
-- dedicated table for a rejected SendGrid event row (bad/untrustworthy
-- occurred_at candidate, or any other future rejection reason), rather than
-- a `quarantined` column on `send_events`. Deliberately NOT folded into that
-- hot, partitioned table -- widening its rows with a rarely-populated
-- quarantine column would cost every read of the table's common case, and
-- quarantine retention needs to be pruneable independently of the
-- partitioned table's own retention policy.
--
-- `occurred_at_candidate` is TEXT, not timestamptz, and this is deliberate:
-- the value being quarantined is EXACTLY the one the platform refuses to
-- trust as a timestamp, so coercing it into a typed column would let it
-- route a partition decision -- the opposite of what quarantining it means.
CREATE TABLE send_event_quarantine (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  sg_event_id text,
  event_type text,
  raw_event jsonb NOT NULL,
  reason text NOT NULL,
  occurred_at_candidate text,
  received_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE send_event_quarantine IS
  'Rejected SendGrid event rows (Phase 13, CMP-08, D-05, plan 13-01), kept as a DEDICATED table rather than a quarantined column on send_events, so the hot partitioned table is not widened and quarantine retention can be pruned independently. No mega_crm_scan grant and no scan policy exist for this table -- nothing in this phase reads it cross-workspace (see this migration''s ingress_journal section for the contrasting case that DOES need scan access).';

ALTER TABLE send_event_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_event_quarantine FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON send_event_quarantine TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);

CREATE INDEX send_event_quarantine_workspace_received_at_idx ON send_event_quarantine (workspace_id, received_at);
