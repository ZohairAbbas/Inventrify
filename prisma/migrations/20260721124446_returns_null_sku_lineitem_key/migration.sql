-- ReturnItem: re-key on (shipmentId, lineItemId), allow null-SKU return lines.
-- Data-preserving: existing rows keep their identity by backfilling lineItemId.

-- 1) New columns (lineItemId nullable for now so existing rows can be backfilled).
ALTER TABLE "ReturnItem" ADD COLUMN "lineItemId" TEXT;
ALTER TABLE "ReturnItem" ADD COLUMN "shopifyVariantId" TEXT;
ALTER TABLE "ReturnItem" ADD COLUMN "title" TEXT;
ALTER TABLE "ReturnItem" ADD COLUMN "variantTitle" TEXT;

-- 2) Backfill lineItemId for pre-existing rows. No real Courierify line-item id exists
--    for them, so synthesize a stable, unique one from the row's own primary key.
--    (These legacy rows keyed on sku; the row id guarantees uniqueness per line.)
UPDATE "ReturnItem" SET "lineItemId" = 'legacy-' || "id" WHERE "lineItemId" IS NULL;

-- 3) Drop the old (shipmentId, sku) unique constraint.
DROP INDEX "ReturnItem_shipmentId_sku_key";

-- 4) lineItemId is now required.
ALTER TABLE "ReturnItem" ALTER COLUMN "lineItemId" SET NOT NULL;

-- 5) sku becomes nullable (SKU-less products).
ALTER TABLE "ReturnItem" ALTER COLUMN "sku" DROP NOT NULL;

-- 6) New idempotency key.
CREATE UNIQUE INDEX "ReturnItem_shipmentId_lineItemId_key" ON "ReturnItem"("shipmentId", "lineItemId");
