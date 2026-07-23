-- AlterTable
ALTER TABLE "OrderOutcome" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'courierify';

-- CreateIndex
CREATE INDEX "OrderOutcome_shop_source_idx" ON "OrderOutcome"("shop", "source");

