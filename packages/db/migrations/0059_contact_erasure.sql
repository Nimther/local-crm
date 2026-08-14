-- Phase 13 (CMP-04, D-01/D-04, plan 13-10) -- the synchronous half of
-- contact erasure: an "anonymized_at" marker on `contacts` plus the
-- `erasure_records` auditable-proof table. The erasure-versus-evidence
-- tension resolves via anonymisation-with-retained-evidence (the ICO
-- direction recorded in PROJECT.md): a hard DELETE destroys the ability to
-- later prove a send or a suppression was lawful, while keeping plaintext
-- PII is not lawful. Anonymizing in place -- scrubbing the PII columns,
-- keeping the row and every foreign key that points at it -- satisfies both.
--
-- anonymized_at: nullable, non-null means "this contact was erased on
-- request, its PII columns were scrubbed, and the row is retained solely so
-- the foreign keys from `sends`, `subscription_status_history`, and
-- `events` still resolve" -- which is what makes it possible to later prove
-- a send or a suppression was lawful. A partial index on (workspace_id)
-- filtered to anonymized_at IS NOT NULL keeps evidence queries over
-- anonymized rows from scanning the whole `contacts` table.
ALTER TABLE contacts ADD COLUMN anonymized_at timestamptz;

COMMENT ON COLUMN contacts.anonymized_at IS
  'CMP-04/D-01: non-null means this contact was erased on request -- its PII columns (email, first_name, last_name, phone, external_id, city, country, timezone, tags, properties) were scrubbed by the anonymizing UPDATE, and the row is retained solely so the foreign keys from sends, subscription_status_history, and events still resolve, which is what makes it possible to later prove a send or a suppression was lawful. Null means never erased.';

CREATE INDEX contacts_anonymized_workspace_idx ON contacts (workspace_id) WHERE anonymized_at IS NOT NULL;

-- No change to contacts_workspace_external_id_unique or
-- contacts_workspace_email_unique (both from migration 0003's original
-- contacts table) -- and none is needed. Postgres treats NULL as
-- distinct in a unique constraint, so any number of anonymized rows with a
-- null `email` -- and, identically, a null `external_id` -- coexist in one
-- workspace, while two LIVE rows sharing a non-null value in either column
-- still collide exactly as before. This is the discretion item CONTEXT
-- flagged (contacts unique-constraint handling for anonymized rows) and the
-- answer is that both existing constraints already have the right
-- behavior for BOTH columns -- REVIEWS.md HIGH finding 3 turned on
-- `external_id` being the column nobody had thought about when only
-- `email` was checked.

-- erasure_records: the auditable proof an erasure happened, written in the
-- SAME transaction as the anonymizing UPDATE and the suppression INSERT
-- (apps/api/src/modules/contacts/contact.repository.ts's deleteContact,
-- this plan's Task 2) -- never by the scrub job itself, so a crash cannot
-- leave an anonymized row with no record of why.
--
-- sends_scrub_cursor / events_scrub_cursor exist for plan 13-13's scrub
-- worker and are added HERE because this migration is the last unwritten
-- one that can carry them (REVIEWS.md MEDIUM finding on 13-13). That plan
-- needs a resume cursor per table and had been pointed at
-- `flow_segment_sweep_checkpoint` (0053), which cannot hold one: that table
-- is keyed `(workspace_id, flow_id)` with `flow_id uuid NOT NULL REFERENCES
-- flows(id)`, so an erasure-record id fails the foreign key. Both cursors
-- are `jsonb`, not `uuid`: the keyset over `send_events`/`sends` and
-- `events` is composite (an `occurred_at`/`created_at` timestamp plus an
-- `id`), so a single uuid column cannot express a resume position on a
-- partitioned table.
--
-- RLS: `erasure_records` gets the SAME fail-closed, role-scoped
-- `workspace_isolation` policy every other tenant-scoped table in this
-- codebase carries (the bare-cast form migration 0044 standardised,
-- mirrored verbatim from 0053's own precedent) -- this is tenant data
-- describing a tenant's own compliance action, not platform-ops metadata,
-- so it does NOT follow `dead_letter_jobs`'/`reputation_alert_state`'s
-- no-RLS precedent.
--
-- Known limitation, recorded here because silence would read as an
-- oversight: contacts hard-deleted BEFORE this migration are already gone,
-- so no anonymized-evidence trail can be retrofitted for them. CMP-04's
-- evidence guarantee applies prospectively from this migration onward.
-- There is nothing to migrate -- the rows do not exist -- so this is a
-- documentation obligation, not a backfill.
CREATE TABLE erasure_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now(),
  anonymized_at timestamptz NOT NULL,
  scrub_started_at timestamptz,
  scrub_completed_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scrubbing', 'complete', 'failed')),
  scrub_error text,
  sends_scrubbed integer NOT NULL DEFAULT 0,
  events_scrubbed integer NOT NULL DEFAULT 0,
  sends_scrub_cursor jsonb,
  events_scrub_cursor jsonb
);

COMMENT ON TABLE erasure_records IS
  'CMP-04/D-01, plan 13-10: the auditable proof an erasure ran -- written in the SAME transaction as contacts.anonymized_at being set and the workspace_suppressions insert, never by the scrub job itself, so a crash cannot leave an anonymized row with no record. status starts pending and is advanced to scrubbing/complete/failed by plan 13-13''s scrub worker. Tenant-scoped, RLS-protected like every other tenant table -- this is a tenant''s own compliance action, not platform-ops metadata.';

COMMENT ON COLUMN erasure_records.sends_scrub_cursor IS
  'Plan 13-13''s resume cursor into sends/send_events for THIS erasure''s scrub walk -- jsonb because the keyset is composite (occurred_at/created_at plus id), not a single uuid. Written by the scrub worker in the SAME transaction as that page''s UPDATE. Null means the walk over this table has not started.';

COMMENT ON COLUMN erasure_records.events_scrub_cursor IS
  'Plan 13-13''s resume cursor into events for THIS erasure''s scrub walk -- jsonb because the keyset is composite (occurred_at/created_at plus id), not a single uuid. Written by the scrub worker in the SAME transaction as that page''s UPDATE. Null means the walk over this table has not started.';

ALTER TABLE erasure_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE erasure_records FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON erasure_records TO mega_crm_app
  USING (workspace_id = current_setting('app.current_workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id')::uuid);
