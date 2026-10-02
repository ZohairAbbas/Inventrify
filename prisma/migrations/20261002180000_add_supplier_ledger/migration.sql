-- Supplier ledger: the merchant's running account with each supplier.
--
-- Append-only. The balance is the sum of the entries. Bills are posted per receipt,
-- credits when a claim is resolved, and payments, refunds and adjustments by the
-- merchant. Additive only, and nothing is backfilled: past receipts may already have
-- been paid outside the app, so inventing bills for them would show balances the merchant
-- does not owe. The merchant starts each supplier with an opening-balance adjustment.

-- CreateTable
CREATE TABLE "SupplierLedgerEntry" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "purchaseOrderId" TEXT,
    "claimId" TEXT,
    "receiptId" TEXT,
    "sourceKey" TEXT,
    "reversalOf" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierLedgerEntry_sourceKey_key" ON "SupplierLedgerEntry"("sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierLedgerEntry_reversalOf_key" ON "SupplierLedgerEntry"("reversalOf");

-- CreateIndex
CREATE INDEX "SupplierLedgerEntry_shop_supplierId_occurredAt_idx" ON "SupplierLedgerEntry"("shop", "supplierId", "occurredAt");

-- CreateIndex
CREATE INDEX "SupplierLedgerEntry_purchaseOrderId_idx" ON "SupplierLedgerEntry"("purchaseOrderId");

-- AddForeignKey
ALTER TABLE "SupplierLedgerEntry" ADD CONSTRAINT "SupplierLedgerEntry_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

