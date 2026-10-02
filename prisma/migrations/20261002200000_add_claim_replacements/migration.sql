-- Claim replacements and emailed claims.
--
--   - SupplierClaimLine.remedy: credit (default; matches every existing row) or replacement.
--   - PurchaseOrder.replacesClaimId: a replacement PO for a resolved claim, one per claim.
--   - PurchaseOrderItem.replacesClaimLineId: the claim line a replacement line stands in
--     for, so undelivered replacements can be credited at the original cost.
--   - SupplierClaim.emailedAt / emailedTo: when the claim was emailed, and to whom.
--
-- Additive only.

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "replacesClaimId" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ADD COLUMN     "replacesClaimLineId" TEXT;

-- AlterTable
ALTER TABLE "SupplierClaim" ADD COLUMN     "emailedAt" TIMESTAMP(3),
ADD COLUMN     "emailedTo" TEXT;

-- AlterTable
ALTER TABLE "SupplierClaimLine" ADD COLUMN     "remedy" TEXT NOT NULL DEFAULT 'credit';

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_replacesClaimId_key" ON "PurchaseOrder"("replacesClaimId");

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_replacesClaimId_fkey" FOREIGN KEY ("replacesClaimId") REFERENCES "SupplierClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

