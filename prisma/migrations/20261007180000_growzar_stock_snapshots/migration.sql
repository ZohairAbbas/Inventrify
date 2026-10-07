-- Growzar Phase 5 (G-INV5-6): StockSnapshot gets observedAt (when the stock was read)
-- and updatedAt, for the stock-snapshots feed. Snapshots move from the product sync
-- (first sync of the UTC day) to a scheduled job writing one row per live variant per
-- shop-local day.
--
-- Existing rows were written by the product sync, from stock it had just read, so their
-- createdAt is both when the stock was observed and when the row was last written. No
-- history is invented: old gaps stay gaps.
--
-- The UPDATE touches every row once; run outside 05:00–15:00 UTC. The no-op guard is
-- attached after it.

ALTER TABLE "StockSnapshot" ADD COLUMN     "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "StockSnapshot" SET "observedAt" = "createdAt", "updatedAt" = "createdAt";

CREATE INDEX "StockSnapshot_shop_updatedAt_id_idx" ON "StockSnapshot"("shop", "updatedAt", "id");

CREATE TRIGGER "StockSnapshot_keep_updated_at_on_noop"
  BEFORE UPDATE ON "StockSnapshot"
  FOR EACH ROW EXECUTE FUNCTION growzar_keep_updated_at_on_noop();
