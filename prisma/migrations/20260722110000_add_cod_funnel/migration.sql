-- AlterTable
ALTER TABLE "OrderRegion" ADD COLUMN     "isCancelled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isDispatched" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "confirmedOrderTag" TEXT NOT NULL DEFAULT '';

