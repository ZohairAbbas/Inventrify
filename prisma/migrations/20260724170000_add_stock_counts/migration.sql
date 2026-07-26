-- Cycle counting: a count session and its per-product lines.
--
-- Additive only. StockCountItem cascades on its parent count, and carries a unique
-- (stockCountId, productId) so a re-scan of the same SKU updates its line instead of
-- creating a duplicate. Both tables are indexed by (shop, status) / parent for the
-- list and detail views.

-- CreateTable
CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "countNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'counting',
    "locationId" TEXT NOT NULL,
    "notes" TEXT,
    "blind" BOOLEAN NOT NULL DEFAULT true,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountItem" (
    "id" TEXT NOT NULL,
    "stockCountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "snapshotQty" INTEGER NOT NULL,
    "countedQty" INTEGER,
    "note" TEXT,

    CONSTRAINT "StockCountItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockCount_countNumber_key" ON "StockCount"("countNumber");

-- CreateIndex
CREATE INDEX "StockCount_shop_idx" ON "StockCount"("shop");

-- CreateIndex
CREATE INDEX "StockCount_shop_status_idx" ON "StockCount"("shop", "status");

-- CreateIndex
CREATE INDEX "StockCountItem_stockCountId_idx" ON "StockCountItem"("stockCountId");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountItem_stockCountId_productId_key" ON "StockCountItem"("stockCountId", "productId");

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountItem" ADD CONSTRAINT "StockCountItem_stockCountId_fkey" FOREIGN KEY ("stockCountId") REFERENCES "StockCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountItem" ADD CONSTRAINT "StockCountItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
