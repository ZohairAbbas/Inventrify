-- CreateTable
CREATE TABLE "AlertNotification" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlertNotification_shop_idx" ON "AlertNotification"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "AlertNotification_shop_type_productId_key" ON "AlertNotification"("shop", "type", "productId");

