/*
  Warnings:

  - You are about to drop the column `productTags` on the `SeasonalEvent` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "SeasonalEvent" DROP COLUMN "productTags",
ADD COLUMN     "productIds" TEXT NOT NULL DEFAULT '';
