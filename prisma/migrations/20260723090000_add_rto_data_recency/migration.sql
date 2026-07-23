-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "rtoDataThrough" TIMESTAMP(3),
ADD COLUMN     "rtoOrdersAttributed" INTEGER NOT NULL DEFAULT 0;

