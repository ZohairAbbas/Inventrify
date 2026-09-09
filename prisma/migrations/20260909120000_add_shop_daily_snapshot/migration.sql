-- Daily shop-wide snapshot behind the dashboard's KPI sparklines, plus the store's
-- display name.
--
-- Additive only: one new table and one nullable column, so this is safe to apply to a
-- live database and needs no backfill. Sparklines stay hidden until a shop has ~10 days
-- of rows, and shopName falls back to the myshopify domain until the next sync fills it.
--
-- Why a separate table rather than deriving from StockSnapshot: in-route units and COD
-- float come from Product.fulfilled*, which the Courierify sync overwrites in place. No
-- history of them exists or can be reconstructed, so it has to be recorded as it happens.

-- CreateTable
CREATE TABLE "ShopDailySnapshot" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "inRouteUnits" INTEGER NOT NULL,
    "codFloat" DOUBLE PRECISION NOT NULL,
    "stockAtCost" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopDailySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopDailySnapshot_shop_date_key" ON "ShopDailySnapshot"("shop", "date");

-- CreateIndex
CREATE INDEX "ShopDailySnapshot_shop_date_idx" ON "ShopDailySnapshot"("shop", "date");

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN "shopName" TEXT;
