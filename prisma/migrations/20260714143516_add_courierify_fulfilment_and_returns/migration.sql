-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "fulfilledDelivered" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fulfilledInTransit" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fulfilledReturned" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fulfilmentSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "courierifyReturnsCursor" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ReturnItem" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "shopifyOrderName" TEXT,
    "sku" TEXT NOT NULL,
    "productId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "returnReceivedAt" TIMESTAMP(3),
    "reasonCategory" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "locationId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReturnItem_shop_status_idx" ON "ReturnItem"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnItem_shipmentId_sku_key" ON "ReturnItem"("shipmentId", "sku");

-- AddForeignKey
ALTER TABLE "ReturnItem" ADD CONSTRAINT "ReturnItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
