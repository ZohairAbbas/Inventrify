-- Scannable code per variant, synced from Shopify.
--
-- Nullable: plenty of catalogues carry no barcodes, and a blank is a legitimate state
-- rather than missing data. Populated by the next catalogue sync — this migration adds
-- the column only, so no shop is left with a half-filled index.
--
-- A plain (not partial) index, matching what the Prisma schema can express: a partial
-- index would be a better fit for a column that is NULL on most rows, but Prisma cannot
-- declare one, and a migration that diverges from the schema shows up as drift on every
-- subsequent `migrate dev`.

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "barcode" TEXT;

-- CreateIndex
CREATE INDEX "Product_shop_barcode_idx" ON "Product"("shop", "barcode");
