-- Partial purchase-order receipts.
--
-- A PO used to close on its first receipt, so a short delivery could never be topped up
-- and the missing units silently dropped out of "on order". Now:
--   - PurchaseOrder.status gains `partially_received` and `closed` (status is TEXT, so no
--     DDL is needed for the new values),
--   - PurchaseOrderItem.quantityCancelled records units the merchant stopped expecting,
--   - PurchaseOrderReceipt / PurchaseOrderReceiptLine record each delivery,
--   - PurchaseOrder.receiptVersion is the compare-and-swap token that stops one delivery
--     being booked twice.
--
-- Additive only. Existing `received` POs are left as they are: some were received short
-- under the old one-shot flow, but some are the list-page legacy rows described in
-- docs/data-audit.md whose quantityReceived was never written, so inferring a cancelled
-- remainder from them would invent history.

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "receiptVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ADD COLUMN     "quantityCancelled" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PurchaseOrderReceipt" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "locationId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrderReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderReceiptLine" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "PurchaseOrderReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PurchaseOrderReceipt_shop_idx" ON "PurchaseOrderReceipt"("shop");

-- CreateIndex
CREATE INDEX "PurchaseOrderReceipt_purchaseOrderId_idx" ON "PurchaseOrderReceipt"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrderReceiptLine_receiptId_idx" ON "PurchaseOrderReceiptLine"("receiptId");

-- CreateIndex
CREATE INDEX "PurchaseOrderReceiptLine_purchaseOrderItemId_idx" ON "PurchaseOrderReceiptLine"("purchaseOrderItemId");

-- AddForeignKey
ALTER TABLE "PurchaseOrderReceipt" ADD CONSTRAINT "PurchaseOrderReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderReceiptLine" ADD CONSTRAINT "PurchaseOrderReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "PurchaseOrderReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderReceiptLine" ADD CONSTRAINT "PurchaseOrderReceiptLine_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

