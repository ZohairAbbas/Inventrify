-- Growzar Phase 5 (G-INV5-5): the no-op updatedAt guard (20261007130000) on Supplier,
-- which the suppliers feed reads.

CREATE TRIGGER "Supplier_keep_updated_at_on_noop"
  BEFORE UPDATE ON "Supplier"
  FOR EACH ROW EXECUTE FUNCTION growzar_keep_updated_at_on_noop();
