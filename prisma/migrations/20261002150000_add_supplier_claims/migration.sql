-- Supplier claims for missing, damaged, defective and wrong items on purchase orders.
--
--   - SupplierClaim / SupplierClaimLine record what the supplier owes the merchant and
--     what has happened to the affected stock since.
--   - ProductLocationStock.damaged holds units in Shopify's `damaged` state. They are kept
--     out of onHand so currentStock, planning and valuation keep meaning sellable stock.
--   - PurchaseOrderReceiptLine.quantityDamaged records units that arrived damaged.
--
-- Additive only. Existing rows get damaged = 0. The next catalogue sync fills it from
-- Shopify, and subtracts it from onHand, for any shop that already uses the damaged state.

-- AlterTable
ALTER TABLE "ProductLocationStock" ADD COLUMN     "damaged" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PurchaseOrderReceiptLine" ADD COLUMN     "quantityDamaged" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "SupplierClaim" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "claimNumber" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "supplierId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "notes" TEXT,
    "submittedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierClaimLine" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" DOUBLE PRECISION NOT NULL,
    "stockSource" TEXT NOT NULL,
    "locationId" TEXT,
    "quantityWrittenOff" INTEGER NOT NULL DEFAULT 0,
    "quantityReturned" INTEGER NOT NULL DEFAULT 0,
    "quantityRestocked" INTEGER NOT NULL DEFAULT 0,
    "quantityFound" INTEGER NOT NULL DEFAULT 0,
    "decision" TEXT NOT NULL DEFAULT 'pending',
    "quantityAccepted" INTEGER NOT NULL DEFAULT 0,
    "creditAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierClaimLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierClaim_claimNumber_key" ON "SupplierClaim"("claimNumber");

-- CreateIndex
CREATE INDEX "SupplierClaim_shop_status_idx" ON "SupplierClaim"("shop", "status");

-- CreateIndex
CREATE INDEX "SupplierClaim_purchaseOrderId_idx" ON "SupplierClaim"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "SupplierClaim_supplierId_idx" ON "SupplierClaim"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierClaimLine_claimId_idx" ON "SupplierClaimLine"("claimId");

-- CreateIndex
CREATE INDEX "SupplierClaimLine_purchaseOrderItemId_idx" ON "SupplierClaimLine"("purchaseOrderItemId");

-- CreateIndex
CREATE INDEX "SupplierClaimLine_productId_idx" ON "SupplierClaimLine"("productId");

-- AddForeignKey
ALTER TABLE "SupplierClaim" ADD CONSTRAINT "SupplierClaim_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierClaim" ADD CONSTRAINT "SupplierClaim_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierClaimLine" ADD CONSTRAINT "SupplierClaimLine_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "SupplierClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierClaimLine" ADD CONSTRAINT "SupplierClaimLine_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierClaimLine" ADD CONSTRAINT "SupplierClaimLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

