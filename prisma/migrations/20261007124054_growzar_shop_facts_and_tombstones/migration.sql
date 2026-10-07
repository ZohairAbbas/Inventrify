-- Growzar Phase 5 (G-INV5-8): the shop's own currency, timezone and country from Shopify,
-- and a tombstone table for hard deletes reported to Growzar.
--
-- Additive only. The new ShopSettings columns are null until the next background sync.

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "shopCountry" TEXT,
ADD COLUMN     "shopCurrency" TEXT,
ADD COLUMN     "shopFactsSyncedAt" TIMESTAMP(3),
ADD COLUMN     "shopTimezone" TEXT;

-- CreateTable
CREATE TABLE "GrowzarTombstone" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "feed" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrowzarTombstone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GrowzarTombstone_shop_feed_deletedAt_idx" ON "GrowzarTombstone"("shop", "feed", "deletedAt");
