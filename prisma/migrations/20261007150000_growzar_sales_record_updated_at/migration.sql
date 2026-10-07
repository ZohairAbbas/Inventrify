-- Growzar Phase 5 (G-INV5-3): SalesRecord gets an updatedAt, so the daily-sales feed can
-- be read incrementally. The order sync now reconciles rows in place (and keeps a day
-- that recounts to zero as a 0-unit row) instead of deleting and re-inserting them.
--
-- Existing rows take their createdAt as updatedAt: that is when their count was last
-- written, since until now every change was a delete and a fresh insert.
--
-- The UPDATE touches every row once (a few hundred thousand at most); run outside
-- 05:00–15:00 UTC. The no-op guard is attached only after it, or it would keep the
-- backfill from moving anything.

-- AlterTable
ALTER TABLE "SalesRecord" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "SalesRecord" SET "updatedAt" = "createdAt";

-- CreateIndex
CREATE INDEX "SalesRecord_shop_updatedAt_id_idx" ON "SalesRecord"("shop", "updatedAt", "id");

CREATE TRIGGER "SalesRecord_keep_updated_at_on_noop"
  BEFORE UPDATE ON "SalesRecord"
  FOR EACH ROW EXECUTE FUNCTION growzar_keep_updated_at_on_noop();
