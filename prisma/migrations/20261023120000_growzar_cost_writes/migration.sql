-- G-INV-C1: Growzar's Books setting Shopify's cost per item (D-77). Three new tables:
-- previews, confirms keyed by Idempotency-Key, and the per-item write log. No backfill.

-- CreateTable
CREATE TABLE "GrowzarCostPreview" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "GrowzarCostPreview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowzarCostConfirm" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "previewId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "GrowzarCostConfirm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowzarCostWrite" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "previewId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "oldAmount" DECIMAL(18,4),
    "newAmount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrowzarCostWrite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GrowzarCostPreview_shop_createdAt_idx" ON "GrowzarCostPreview"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "GrowzarCostConfirm_previewId_idx" ON "GrowzarCostConfirm"("previewId");

-- CreateIndex
CREATE UNIQUE INDEX "GrowzarCostConfirm_shop_idempotencyKey_key" ON "GrowzarCostConfirm"("shop", "idempotencyKey");

-- CreateIndex
CREATE INDEX "GrowzarCostWrite_shop_createdAt_idx" ON "GrowzarCostWrite"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "GrowzarCostWrite_shop_variantId_idx" ON "GrowzarCostWrite"("shop", "variantId");

