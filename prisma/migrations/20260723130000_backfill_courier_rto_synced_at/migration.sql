-- Backfill courierRtoSyncedAt for rates that predate the column.
--
-- Precedence now requires a courier rate to be *current*, not merely present. Rows
-- written before this column existed have no timestamp, so they would read as stale
-- immediately and hand priority to Shopify tracking despite being perfectly good data.
--
-- Seeding them at the moment of migration gives the next Courierify sync a full
-- precedence window to stamp them properly; anything the feed no longer reports then
-- ages out naturally, which is the intended behaviour.
UPDATE "Product"
SET "courierRtoSyncedAt" = NOW()
WHERE "courierRtoRate" IS NOT NULL AND "courierRtoSyncedAt" IS NULL;
