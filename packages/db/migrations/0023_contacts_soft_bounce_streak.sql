-- 05-03: consecutive soft-bounce streak counter (D-10, SUBS-02). Incremented
-- on each genuinely-new soft bounce/blocked event, reset to 0 on a
-- genuinely-new delivered event; suppresses the contact once it reaches
-- SOFT_BOUNCE_SUPPRESS_THRESHOLD (3, see @mega-crm/delivery-core).
ALTER TABLE "contacts" ADD COLUMN "consecutive_soft_bounces" integer DEFAULT 0 NOT NULL;
