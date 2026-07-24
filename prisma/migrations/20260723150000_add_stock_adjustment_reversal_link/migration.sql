-- Links a reversal adjustment to the adjustment it undoes.
--
-- The unique index is the point: it makes "an adjustment can be reversed at most once"
-- a database guarantee rather than an application check, so two concurrent clicks on
-- Reverse cannot both succeed and swing stock by twice the original delta.
--
-- The column is new, so no existing row can violate the constraint. Existing reversals
-- (identified only by reason = 'reversal' and a free-text note) stay NULL and are
-- unaffected; NULLs are exempt from UNIQUE in Postgres, so any number of them coexist.

-- AlterTable
ALTER TABLE "StockAdjustment" ADD COLUMN     "reversalOf" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "StockAdjustment_reversalOf_key" ON "StockAdjustment"("reversalOf");

-- CreateIndex
CREATE INDEX "StockAdjustment_shop_reason_idx" ON "StockAdjustment"("shop", "reason");

-- CreateIndex
CREATE INDEX "StockAdjustment_shop_createdAt_idx" ON "StockAdjustment"("shop", "createdAt");
