-- AlterTable
ALTER TABLE "StockAdjustment" ADD COLUMN     "locationId" TEXT;

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyLocationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductLocationStock" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductLocationStock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Location_shop_idx" ON "Location"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Location_shop_shopifyLocationId_key" ON "Location"("shop", "shopifyLocationId");

-- CreateIndex
CREATE INDEX "ProductLocationStock_shop_idx" ON "ProductLocationStock"("shop");

-- CreateIndex
CREATE INDEX "ProductLocationStock_locationId_idx" ON "ProductLocationStock"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductLocationStock_productId_locationId_key" ON "ProductLocationStock"("productId", "locationId");

-- AddForeignKey
ALTER TABLE "ProductLocationStock" ADD CONSTRAINT "ProductLocationStock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductLocationStock" ADD CONSTRAINT "ProductLocationStock_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
