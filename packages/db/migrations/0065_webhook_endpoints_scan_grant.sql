-- Phase 15 (OPS-13, plan 15-14, Task 1): a grants-only migration -- no
-- table, column, or index changes -- adding the mega_crm_scan role exactly
-- the read this plan's webhook-lag watchdog needs: a platform-wide
-- MAX(last_event_at) over workspace_webhook_endpoints.
--
-- HUMAN-APPROVED OVERRIDE of this plan's own "no new migration" prohibition
-- (15-14-PLAN.md must_haves.prohibitions: "No new migration may be added;
-- ops_alert_state from plan 15-12 is the only storage these use"). Recorded
-- here AND in 15-14-SUMMARY.md's Deviations section (Rule 4, resolved by
-- explicit human decision, not executor discretion) because the underlying
-- architectural gap is real, not a planning oversight the executor could
-- route around: as of migration 0064, `mega_crm_scan` has table-level SELECT
-- on exactly six tables (campaigns 0041; flow_runs, flows, contacts, sends,
-- organization 0042; ingress_journal 0055, narrowed to incomplete rows only)
-- -- none of which carries a server-set, platform-wide "when did a webhook
-- last arrive" signal that isn't either (a) invisible once a batch completes
-- (ingress_journal's own scan policy, by design -- see 0055's own comment)
-- or (b) derived from a provider-supplied timestamp (`sends`' delivery-fact
-- columns are written from `event.occurredAt`, which this plan's own threat
-- register (T-15-46) explicitly forbids using as the lag input). See
-- 15-14-SUMMARY.md for the full survey of rejected alternatives.
--
-- `workspace_webhook_endpoints.last_event_at` (0021_webhook_endpoints.sql)
-- is the one column that is exactly right: `debounceWebhookHealth`
-- (apps/worker/src/queues/webhook-events.worker.ts) sets it to `now()` on
-- EVERY processed webhook batch (debounced to at most once per 60s per
-- workspace, "never per event" per that function's own doc comment) --
-- server-set, never a provider timestamp, and updated regardless of which
-- event type arrived or whether that batch's ingestion later completes or
-- stays incomplete. This is a genuinely different signal from
-- `ingress_journal` (which answers "is a batch stuck", not "has anything
-- arrived at all") and from `sends` fact columns (which answer "what did
-- THIS send's own webhook evidence say", using the wrong clock).
--
-- Deliberately a COLUMN-LEVEL grant, not a table-level one (no precedent for
-- this shape elsewhere in this codebase, but the codebase's own scan-role
-- convention (0042's own header, "grant plainly whatever mega_crm_scan
-- structurally needs, nothing more") argues for the narrowest capability
-- that answers the question): this table also carries `path_token` (the
-- UNGUESSABLE pre-verification trust anchor for the public webhook URL,
-- 0021's own header comment) and `public_key`. Neither has any role in this
-- alert -- the watchdog only ever needs `MAX(last_event_at)` -- and a
-- table-level GRANT SELECT would hand mega_crm_scan read access to
-- path_token for no reason this migration can justify. Postgres supports
-- column-level SELECT privilege natively; granting only `last_event_at`
-- means even a future bug in a query issued through this role cannot leak
-- `path_token`/`public_key` -- the privilege system itself refuses it,
-- independent of what any application-level query happens to ask for.
GRANT SELECT (last_event_at) ON workspace_webhook_endpoints TO mega_crm_scan;

-- Row-visibility half: `workspace_webhook_endpoints` is RLS-FORCED (0021),
-- and a column-level grant alone does not admit any row without a matching
-- policy -- without this, every mega_crm_scan query against this table
-- returns zero rows regardless of the column grant above. Deliberately
-- UNRESTRICTED (`USING (true)`), matching `contacts_scan`/`sends_scan`
-- (0042)'s own "no per-row narrowing predicate available" reasoning: this
-- alert's whole purpose is a platform-wide MAX across every workspace, so
-- there is no workspace-scoped subset of rows that would answer the
-- question correctly. The column-level grant above is what keeps this
-- policy's row-level breadth from being a PII exposure -- unrestricted ROW
-- visibility into a table whose only VISIBLE COLUMN is a timestamp carries
-- nothing sensitive to expose.
CREATE POLICY workspace_webhook_endpoints_scan ON workspace_webhook_endpoints
  FOR SELECT TO mega_crm_scan
  USING (true);

-- Role-scopes the two existing app policies so they are excluded from the
-- scan role's query plans (0042's own precedent, re-asserted here as an
-- idempotent no-op since 0044 already applied this ALTER to both -- included
-- so this migration's own diff is self-contained evidence of the intended
-- access shape, matching 0055's identical re-assertion for ingress_journal).
ALTER POLICY workspace_isolation ON workspace_webhook_endpoints TO mega_crm_app;
ALTER POLICY webhook_endpoint_runtime_lookup ON workspace_webhook_endpoints TO mega_crm_app;
