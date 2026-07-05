-- RLS for the new `segments` table (Phase 3 Plan 2, SEGM-01..04) -- same
-- ENABLE + FORCE + workspace_isolation triplet as every other tenant-scoped
-- table (see 0004_contacts_rls_policies.sql's comment on why FORCE is
-- required: the app role owns its own tables and Postgres exempts owners
-- from RLS by default).

ALTER TABLE segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE segments FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON segments
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);

-- GIN index on contacts.tags so the segments-core compiler's
-- `tags @> ARRAY[$N]::text[]` containment fragment (has_tag/not_has_tag,
-- SEGM-01) hits a Bitmap Index Scan instead of a sequential scan --
-- verified via this phase's RESEARCH.md benchmark. No GIN index is added on
-- contacts.properties: custom-property operators compile to `->>` text
-- extraction (Open Question 2), which a GIN index does not accelerate; the
-- preview-count statement_timeout (segment.repository.ts) is the DoS safety
-- net for pathological custom-property-heavy definitions instead.
CREATE INDEX idx_contacts_tags_gin ON contacts USING gin (tags);
