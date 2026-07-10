-- 06-04: flow-level exit conditions (D-15) -- a jsonb array of
-- {type:"segment",segmentId,mode} | {type:"event",eventName} objects
-- (flowExitConditionSchema, @mega-crm/shared-schemas), validated at the app
-- layer only (no DB constraint). Gap-fill: updateFlowDraftSchema (06-02)
-- already accepted an `exitConditions` field but 0026_flows.sql never added
-- a column to persist it.
ALTER TABLE "flows" ADD COLUMN "exit_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL;
