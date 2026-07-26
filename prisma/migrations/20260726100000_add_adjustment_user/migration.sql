-- Who made a stock adjustment.
--
-- The Shopify staff user id from the session token (`sub`). Only an id: the app has no
-- read_users scope, so a name cannot be resolved — but an id distinguishes two people in
-- the audit trail, which the "user" column always promised and never recorded. Nullable
-- and additive; existing rows and cron-driven movements stay null.

-- AlterTable
ALTER TABLE "StockAdjustment" ADD COLUMN     "createdByUserId" TEXT;
