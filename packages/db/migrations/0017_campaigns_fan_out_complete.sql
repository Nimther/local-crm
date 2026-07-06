-- 04-06: campaign-kickoff worker's fan-out-completion guard (T-04-06-03) --
-- a redelivered kickoff job checks this flag before re-walking
-- campaign_recipients / re-enqueuing email-broadcast jobs.
ALTER TABLE "campaigns" ADD COLUMN "fan_out_complete" boolean DEFAULT false NOT NULL;
