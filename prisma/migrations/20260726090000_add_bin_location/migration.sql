-- Bin / shelf location within a stock location.
--
-- Free text, nullable, merchant-entered. Answers "where on the shelf is it" — the
-- question a picker or a counter has — without modelling a full bin master, which would
-- be a WMS in its own right. Additive: no existing row changes.

-- AlterTable
ALTER TABLE "ProductLocationStock" ADD COLUMN     "binLocation" TEXT;
