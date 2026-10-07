-- Growzar Phase 5 (G-INV5-2): the no-op updatedAt guard (20261007130000) on the tables
-- the stock-levels feed reads. The hourly sync upserts every stock level whether or not
-- its quantities changed.

CREATE TRIGGER "ProductLocationStock_keep_updated_at_on_noop"
  BEFORE UPDATE ON "ProductLocationStock"
  FOR EACH ROW EXECUTE FUNCTION growzar_keep_updated_at_on_noop();

CREATE TRIGGER "Location_keep_updated_at_on_noop"
  BEFORE UPDATE ON "Location"
  FOR EACH ROW EXECUTE FUNCTION growzar_keep_updated_at_on_noop();
