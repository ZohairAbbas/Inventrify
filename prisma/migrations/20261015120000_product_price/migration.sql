-- Product.price: the variant's selling price from Shopify. Nullable — existing rows stay
-- null ("not yet known") until the next catalogue sync fills them. No backfill.
ALTER TABLE "Product" ADD COLUMN "price" DOUBLE PRECISION;
