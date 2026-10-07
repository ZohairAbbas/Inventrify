-- Growzar Phase 5 (G-INV5-7): the no-op updatedAt guard (20261007130000) on ReturnItem,
-- which the return-restocks feed reads. The hourly Courierify returns pull rewrites
-- rows it has already seen.

CREATE TRIGGER "ReturnItem_keep_updated_at_on_noop"
  BEFORE UPDATE ON "ReturnItem"
  FOR EACH ROW EXECUTE FUNCTION growzar_keep_updated_at_on_noop();
