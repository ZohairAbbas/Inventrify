import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { formatCurrency } from "../lib/format";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useCallback, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Button, Card, PageHead, ProductCombobox, SelectInput, TextArea, TextInput } from "../design";
import { validateDraftLines, validateSupplierId } from "../lib/purchase-order.server";

function generatePoNumber(): string {
  const d = new Date();
  const datePart = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PO-${datePart}-${rand}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  // The catalogue is no longer loaded here: the line-item picker searches on demand via
  // /api/products/search. Only the prefilled product (arriving from a reorder link) is
  // resolved, so its name can be shown before any search runs.
  const prefilledProductId = url.searchParams.get("product");
  const prefilled = prefilledProductId
    ? await prisma.product.findFirst({
        where: { id: prefilledProductId, shop: session.shop },
        select: { id: true, title: true, variantTitle: true, unitCost: true },
      })
    : null;

  const suppliers = await prisma.supplier.findMany({
    where: { shop: session.shop },
    orderBy: { name: "asc" },
  });

  return {
    suppliers,
    prefilled: prefilled
      ? {
          id: prefilled.id,
          label: prefilled.variantTitle ? `${prefilled.title} — ${prefilled.variantTitle}` : prefilled.title,
          unitCost: prefilled.unitCost,
        }
      : null,
    prefilledQty: url.searchParams.get("qty"),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const supplierId = formData.get("supplierId") as string;
  const notes = formData.get("notes") as string;
  const productIds = formData.getAll("productId") as string[];
  const quantities = formData.getAll("quantity") as string[];
  const unitCosts = formData.getAll("unitCost") as string[];

  // Ids posted from the form are attacker-controlled; validate them against this shop
  // before linking anything to the new PO.
  const { items, error: lineError } = await validateDraftLines(
    session.shop,
    productIds.map((id, i) => ({
      productId: id,
      quantity: quantities[i] ?? null,
      unitCost: unitCosts[i] ?? null,
    })),
  );
  if (lineError) return { error: lineError };

  const { supplierId: ownedSupplierId, error: supplierError } = await validateSupplierId(
    session.shop,
    supplierId || null,
  );
  if (supplierError) return { error: supplierError };

  const totalCost = items.reduce((s, item) => s + item.quantityOrdered * item.unitCost, 0);

  await prisma.purchaseOrder.create({
    data: {
      shop: session.shop,
      poNumber: generatePoNumber(),
      supplierId: ownedSupplierId,
      notes: notes || null,
      totalCost,
      items: { create: items },
    },
  });

  return { ok: true };
};

interface LineItem {
  productId: string;
  /** Kept alongside the id so the picker can render a chosen product before searching. */
  label: string;
  quantity: number;
  unitCost: number;
}

export default function NewPurchaseOrder() {
  const { suppliers, prefilled, prefilledQty } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const { currency = "USD", theme = "emerald" } = useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  const [supplierId, setSupplierId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineItem[]>(() => {
    if (prefilled) {
      const qty = parseInt(prefilledQty ?? "", 10);
      return [{
        productId: prefilled.id,
        label: prefilled.label,
        // Seeded from the product's own cost so the PO total is not zero on arrival.
        quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
        unitCost: prefilled.unitCost,
      }];
    }
    return [{ productId: "", label: "", quantity: 1, unitCost: 0 }];
  });

  const isBusy = fetcher.state !== "idle";
  const error = (fetcher.data as { error?: string } | undefined)?.error;

  useEffect(() => {
    if (fetcher.data && !error) {
      navigate("/app/purchase-orders");
    }
  }, [fetcher.data, error, navigate]);

  const addLine = useCallback(() => {
    setLines((l) => [...l, { productId: "", label: "", quantity: 1, unitCost: 0 }]);
  }, []);

  const removeLine = useCallback((idx: number) => {
    setLines((l) => l.filter((_, i) => i !== idx));
  }, []);

  const updateLine = useCallback((idx: number, field: "quantity" | "unitCost", value: string) => {
    setLines((l) => l.map((line, i) => (i === idx ? { ...line, [field]: parseFloat(value) || 0 } : line)));
  }, []);

  const setLineProduct = useCallback((idx: number, id: string, label: string, unitCost?: number) => {
    setLines((l) =>
      l.map((line, i) =>
        i === idx
          ? { ...line, productId: id, label, unitCost: line.unitCost || unitCost || 0 }
          : line,
      ),
    );
  }, []);

  const handleSubmit = useCallback(() => {
    if (lines.length === 0) return;
    const fd = new FormData();
    fd.append("supplierId", supplierId);
    fd.append("notes", notes);
    lines.forEach((line) => {
      fd.append("productId", line.productId);
      fd.append("quantity", String(line.quantity));
      fd.append("unitCost", String(line.unitCost));
    });
    fetcher.submit(fd, { method: "POST" });
  }, [fetcher, supplierId, notes, lines]);

  const totalCost = lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Create Purchase Order" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead eyebrow="New" title="Create Purchase Order" />

        {error && (
          <Card padding="12px 16px" style={{ marginBottom: "16px" }}>
            <span style={{ color: "var(--inv-status-critical-fg)", fontSize: "13px" }}>{error}</span>
          </Card>
        )}

        <Card style={{ marginBottom: "14px" }}>
          <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "16px" }}>Order details</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "16px" }}>
            <div>
              <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>Supplier</label>
              <SelectInput value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">— No supplier —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </SelectInput>
              <div style={{ fontSize: "11px", color: "var(--inv-muted)", marginTop: "5px" }}>Add suppliers in the Suppliers section</div>
            </div>
            <div>
              <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>Notes</label>
              <TextArea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Optional notes for this purchase order"
              />
            </div>
          </div>
        </Card>

        <Card style={{ marginBottom: "14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div style={{ fontSize: "15px", fontWeight: 600 }}>Line items</div>
            <Button variant="ghost" onClick={addLine}>+ Add item</Button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {lines.map((line, idx) => (
              <div key={idx} style={{ display: "grid", gridTemplateColumns: "2.2fr 1fr 1fr 1fr auto", gap: "10px", alignItems: "center" }}>
                <ProductCombobox
                  value={line.productId}
                  valueLabel={line.label || null}
                  onChange={(id, product) => setLineProduct(idx, id, product?.label ?? "", product?.currentStock !== undefined ? undefined : undefined)}
                />
                <TextInput
                  type="number"
                  min={1}
                  value={line.quantity}
                  onChange={(e) => updateLine(idx, "quantity", e.target.value)}
                />
                <TextInput
                  type="number"
                  min={0}
                  step={0.01}
                  value={line.unitCost}
                  onChange={(e) => updateLine(idx, "unitCost", e.target.value)}
                />
                <span style={{ fontFamily: "var(--inv-font-mono)", fontSize: "13px" }}>
                  {formatCurrency(line.quantity * line.unitCost, currency)}
                </span>
                <button
                  onClick={() => removeLine(idx)}
                  style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-status-stockout-fg)", padding: "6px 10px", borderRadius: "8px", cursor: "pointer" }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div style={{ height: "1px", background: "var(--inv-divider)", margin: "16px 0" }} />
          <div style={{ textAlign: "right", fontSize: "15px", fontWeight: 600 }}>
            Total: {formatCurrency(totalCost, currency)}
          </div>
        </Card>

        <div style={{ display: "flex", gap: "9px", justifyContent: "flex-end" }}>
          <Link to="/app/purchase-orders">
            <Button variant="ghost">Cancel</Button>
          </Link>
          <Button
            variant="primary"
            disabled={isBusy || lines.length === 0 || lines.some((l) => !l.productId)}
            onClick={handleSubmit}
          >
            Create PO
          </Button>
        </div>
      </div>
    </div>
  );
}
