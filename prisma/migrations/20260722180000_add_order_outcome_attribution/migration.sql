-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "derivedRtoRate" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "courierifyOutcomesCursor" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "orderedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderOutcome" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "courier" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderLineItem_shop_orderName_idx" ON "OrderLineItem"("shop", "orderName");

-- CreateIndex
CREATE INDEX "OrderLineItem_shop_productId_idx" ON "OrderLineItem"("shop", "productId");

-- CreateIndex
CREATE INDEX "OrderLineItem_shop_orderedAt_idx" ON "OrderLineItem"("shop", "orderedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineItem_shop_orderName_productId_key" ON "OrderLineItem"("shop", "orderName", "productId");

-- CreateIndex
CREATE INDEX "OrderOutcome_shop_orderName_idx" ON "OrderOutcome"("shop", "orderName");

-- CreateIndex
CREATE INDEX "OrderOutcome_shop_status_idx" ON "OrderOutcome"("shop", "status");

-- CreateIndex
CREATE INDEX "OrderOutcome_shop_updatedAt_idx" ON "OrderOutcome"("shop", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderOutcome_shop_shipmentId_key" ON "OrderOutcome"("shop", "shipmentId");

