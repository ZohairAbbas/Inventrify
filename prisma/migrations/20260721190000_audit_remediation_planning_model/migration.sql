-- AlterTable
-- dedupeKey/updatedAt are NOT NULL without a default, so they are added nullable,
-- backfilled from existing data, then tightened. Alerts predate stable identity, so
-- the key is derived as "<type>:<productId>" — exactly what the generator now emits.
ALTER TABLE "Alert" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "lastNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "revenueAtRisk" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "severity" TEXT NOT NULL DEFAULT 'info',
ADD COLUMN     "snoozedUntil" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3);

UPDATE "Alert" SET "dedupeKey" = "type" || ':' || "productId" WHERE "dedupeKey" IS NULL;
UPDATE "Alert" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;

-- Collapse any pre-existing duplicates so the unique index below can be created.
-- Keeps the most recent row per (shop, dedupeKey).
DELETE FROM "Alert" a
USING "Alert" b
WHERE a."shop" = b."shop"
  AND a."dedupeKey" = b."dedupeKey"
  AND (a."createdAt" < b."createdAt" OR (a."createdAt" = b."createdAt" AND a."id" < b."id"));

ALTER TABLE "Alert" ALTER COLUMN "dedupeKey" SET NOT NULL,
ALTER COLUMN "updatedAt" SET NOT NULL;

-- AlterTable
ALTER TABLE "Forecast" ADD COLUMN     "expectedReturnsSellable" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "method" TEXT NOT NULL DEFAULT 'moving_average',
ADD COLUMN     "pi80High" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pi80Low" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "procurementUnits" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "abcClass" TEXT,
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "cancellationRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "casePackSize" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "courierRtoRate" DOUBLE PRECISION,
ADD COLUMN     "estimatedRtoRate" DOUBLE PRECISION,
ADD COLUMN     "firstSoldAt" TIMESTAMP(3),
ADD COLUMN     "forecastBias" DOUBLE PRECISION,
ADD COLUMN     "forecastMape" DOUBLE PRECISION,
ADD COLUMN     "isArchived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "moq" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "returnRateSource" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "xyzClass" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "sentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SeasonalEvent" ADD COLUMN     "leadTimeMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0;

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "codGateways" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "coverageDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "rtoTransitDays" INTEGER NOT NULL DEFAULT 14;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "leadTimeM2" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "minOrderValue" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastAccuracy" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "horizon" INTEGER NOT NULL,
    "forecastedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "predicted" INTEGER NOT NULL,
    "actual" INTEGER,
    "evaluatedAt" TIMESTAMP(3),

    CONSTRAINT "ForecastAccuracy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookEvent_shop_topic_idx" ON "WebhookEvent"("shop", "topic");

-- CreateIndex
CREATE INDEX "WebhookEvent_receivedAt_idx" ON "WebhookEvent"("receivedAt");

-- CreateIndex
CREATE INDEX "ForecastAccuracy_shop_dueAt_idx" ON "ForecastAccuracy"("shop", "dueAt");

-- CreateIndex
CREATE INDEX "ForecastAccuracy_shop_evaluatedAt_idx" ON "ForecastAccuracy"("shop", "evaluatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ForecastAccuracy_productId_horizon_dueAt_key" ON "ForecastAccuracy"("productId", "horizon", "dueAt");

-- CreateIndex
CREATE INDEX "Alert_shop_resolvedAt_idx" ON "Alert"("shop", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_shop_dedupeKey_key" ON "Alert"("shop", "dedupeKey");

-- CreateIndex
CREATE INDEX "Product_shop_isArchived_idx" ON "Product"("shop", "isArchived");

-- AddForeignKey
ALTER TABLE "ForecastAccuracy" ADD CONSTRAINT "ForecastAccuracy_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

