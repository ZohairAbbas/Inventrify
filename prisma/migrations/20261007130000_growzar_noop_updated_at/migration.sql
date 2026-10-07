-- Growzar Phase 5 (G-INV5-1): an UPDATE that changes nothing must not move updatedAt.
--
-- The Growzar feeds sync incrementally on updatedAt (API-CONTRACT §6.2). Prisma sets
-- @updatedAt on every update it issues, and the hourly syncs rewrite rows whether or not
-- anything changed, so every row looked new every hour. This trigger keeps the old
-- updatedAt when no other column differs. A real change still moves it, whichever code
-- path wrote it.
--
-- A write meant only to move updatedAt (a "touch": a location going inactive moves its
-- stock rows) sets `growzar.touch = on` for its transaction first; see touchingUpdatedAt
-- in app/lib/growzar/feed.server.ts.
--
-- Prisma does not model triggers; they live in migrations only. Later migrations attach
-- the same function to the other tables the feeds read.

CREATE OR REPLACE FUNCTION growzar_keep_updated_at_on_noop() RETURNS trigger AS $$
BEGIN
  IF current_setting('growzar.touch', true) IS DISTINCT FROM 'on'
     AND (to_jsonb(NEW) - 'updatedAt') = (to_jsonb(OLD) - 'updatedAt') THEN
    NEW."updatedAt" := OLD."updatedAt";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Product_keep_updated_at_on_noop"
  BEFORE UPDATE ON "Product"
  FOR EACH ROW EXECUTE FUNCTION growzar_keep_updated_at_on_noop();
