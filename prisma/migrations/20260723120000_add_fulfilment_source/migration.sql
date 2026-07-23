-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "courierRtoSyncedAt" TIMESTAMP(3),
ADD COLUMN     "fulfilmentSource" TEXT NOT NULL DEFAULT 'none';

