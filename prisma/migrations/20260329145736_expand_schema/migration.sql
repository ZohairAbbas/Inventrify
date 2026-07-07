-- AlterTable
ALTER TABLE "Forecast" ADD COLUMN     "eventMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
ADD COLUMN     "safetyStockUsed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "seasonalityApplied" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "inventoryItemId" TEXT,
ADD COLUMN     "safetyStock" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "actualDeliveryDate" TIMESTAMP(3),
ADD COLUMN     "expectedDeliveryDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ADD COLUMN     "quantityReceived" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "deadStockDays" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "deadStockMinUnits" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "notificationEmail" TEXT,
ADD COLUMN     "safetyStockDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "serviceLevel" DOUBLE PRECISION NOT NULL DEFAULT 1.65,
ADD COLUMN     "slackWebhookUrl" TEXT;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "avgActualLeadTime" DOUBLE PRECISION,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "leadTimeVariance" DOUBLE PRECISION,
ADD COLUMN     "totalPosReceived" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "StockSnapshot" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "stock" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockAdjustment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnRateHistory" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "returnRate" DOUBLE PRECISION NOT NULL,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnRateHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonalEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "impactMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "productTags" TEXT NOT NULL DEFAULT '',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeasonalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockSnapshot_shop_date_idx" ON "StockSnapshot"("shop", "date");

-- CreateIndex
CREATE UNIQUE INDEX "StockSnapshot_productId_date_key" ON "StockSnapshot"("productId", "date");

-- CreateIndex
CREATE INDEX "StockAdjustment_shop_productId_idx" ON "StockAdjustment"("shop", "productId");

-- CreateIndex
CREATE INDEX "ReturnRateHistory_shop_weekStart_idx" ON "ReturnRateHistory"("shop", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRateHistory_productId_weekStart_key" ON "ReturnRateHistory"("productId", "weekStart");

-- CreateIndex
CREATE INDEX "SeasonalEvent_shop_startDate_idx" ON "SeasonalEvent"("shop", "startDate");

-- CreateIndex
CREATE INDEX "Alert_shop_type_idx" ON "Alert"("shop", "type");

-- CreateIndex
CREATE INDEX "Product_inventoryItemId_idx" ON "Product"("inventoryItemId");

-- CreateIndex
CREATE INDEX "Product_shop_sku_idx" ON "Product"("shop", "sku");

-- CreateIndex
CREATE INDEX "PurchaseOrder_shop_status_idx" ON "PurchaseOrder"("shop", "status");

-- CreateIndex
CREATE INDEX "Supplier_shop_idx" ON "Supplier"("shop");

-- AddForeignKey
ALTER TABLE "StockSnapshot" ADD CONSTRAINT "StockSnapshot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAdjustment" ADD CONSTRAINT "StockAdjustment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRateHistory" ADD CONSTRAINT "ReturnRateHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
