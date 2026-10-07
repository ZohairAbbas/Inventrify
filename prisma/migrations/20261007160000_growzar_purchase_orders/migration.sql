-- Growzar Phase 5 (G-INV5-4): the purchase-orders feed returns each PO with its items
-- nested, so a change to an item — a receipt, a cancellation, a draft edit, whichever
-- code path wrote it — must move the PO's updatedAt. PurchaseOrderItem has no updatedAt
-- of its own; these triggers touch the parent in the same transaction instead. The feed
-- also returns the supplier's name, so renaming a supplier touches its POs.
--
-- A touch sets `growzar.touch` for its own statement only, so the no-op guard
-- (20261007130000) lets it through without loosening the guard for the rest of the
-- transaction.

CREATE TRIGGER "PurchaseOrder_keep_updated_at_on_noop"
  BEFORE UPDATE ON "PurchaseOrder"
  FOR EACH ROW EXECUTE FUNCTION growzar_keep_updated_at_on_noop();

CREATE OR REPLACE FUNCTION growzar_touch_purchase_orders(ids TEXT[]) RETURNS void AS $$
DECLARE
  prev TEXT := current_setting('growzar.touch', true);
BEGIN
  PERFORM set_config('growzar.touch', 'on', true);
  UPDATE "PurchaseOrder"
     SET "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
   WHERE id = ANY (ids);
  PERFORM set_config('growzar.touch', COALESCE(prev, ''), true);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION growzar_touch_po_from_item() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM growzar_touch_purchase_orders(ARRAY[NEW."purchaseOrderId"]);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM growzar_touch_purchase_orders(ARRAY[OLD."purchaseOrderId"]);
  ELSE
    PERFORM growzar_touch_purchase_orders(ARRAY[NEW."purchaseOrderId", OLD."purchaseOrderId"]);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PurchaseOrderItem_touch_purchase_order"
  AFTER INSERT OR UPDATE OR DELETE ON "PurchaseOrderItem"
  FOR EACH ROW EXECUTE FUNCTION growzar_touch_po_from_item();

CREATE OR REPLACE FUNCTION growzar_touch_po_from_supplier() RETURNS trigger AS $$
BEGIN
  PERFORM growzar_touch_purchase_orders(
    ARRAY(SELECT id FROM "PurchaseOrder" WHERE "supplierId" = NEW.id)
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Supplier_touch_purchase_orders_on_rename"
  AFTER UPDATE OF name ON "Supplier"
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION growzar_touch_po_from_supplier();
