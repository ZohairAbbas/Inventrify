-- AlterTable
ALTER TABLE "ReturnItem" ADD COLUMN     "city" TEXT,
ADD COLUMN     "courier" TEXT;

-- CreateTable
CREATE TABLE "OrderRegion" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "city" TEXT,
    "province" TEXT,
    "country" TEXT,
    "units" INTEGER NOT NULL DEFAULT 0,
    "isCod" BOOLEAN NOT NULL DEFAULT false,
    "orderedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderRegion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderRegion_shop_city_idx" ON "OrderRegion"("shop", "city");

-- CreateIndex
CREATE INDEX "OrderRegion_shop_orderedAt_idx" ON "OrderRegion"("shop", "orderedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderRegion_shop_orderName_key" ON "OrderRegion"("shop", "orderName");

