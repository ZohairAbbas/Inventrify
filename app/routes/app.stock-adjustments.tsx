import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { applyShopifyInventoryDelta } from "../lib/shopify-sync.server";
import { Button, Card, DataTable, PageHead, Pill, SelectInput, TextArea, type DataTableColumn } from "../design";

const REASONS = [
  { label: "Damage / Loss", value: "damage" },
  { label: "Count Correction", value: "count_correction" },
  { label: "Sample / Giveaway", value: "sample" },
  { label: "Customer Return", value: "return" },
  { label: "Other", value: "other" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [products, adjustments] = await Promise.all([
    prisma.product.findMany({
      where: { shop },
      orderBy: { title: "asc" },
      select: { id: true, title: true, variantTitle: true, sku: true, currentStock: true },
    }),
    prisma.stockAdjustment.findMany({
      where: { shop },
      include: { product: { select: { title: true, variantTitle: true, sku: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  return { products, adjustments };
};

async function applyAdjustment(
  admin: Parameters<typeof applyShopifyInventoryDelta>[0],
  shop: string,
  productId: string,
  delta: number,
  reason: string,
  note: string | null,
) {
  const product = await prisma.product.findFirst({ where: { id: productId, shop } });
  if (!product) return { error: "Product not found" };

  const newStock = product.currentStock + delta;
  if (newStock < 0) {
    return { error: `Cannot remove ${Math.abs(delta)} units — only ${product.currentStock} in stock` };
  }

  await prisma.$transaction([
    prisma.stockAdjustment.create({ data: { shop, productId, delta, reason, note } }),
    prisma.product.update({ where: { id: productId }, data: { currentStock: newStock } }),
  ]);

  const shopifySync = await applyShopifyInventoryDelta(admin, product.inventoryItemId, delta);

  return { ok: true as const, newStock, shopifySynced: shopifySync.ok, shopifyError: shopifySync.error };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = (formData.get("intent") as string) || "adjust";

  if (intent === "reverse") {
    const adjustmentId = formData.get("adjustmentId") as string;
    const original = await prisma.stockAdjustment.findFirst({ where: { id: adjustmentId, shop } });
    if (!original) return { error: "Adjustment not found" };

    return applyAdjustment(
      admin,
      shop,
      original.productId,
      -original.delta,
      "reversal",
      `Reversal of adjustment from ${original.createdAt.toLocaleDateString()}`,
    );
  }

  const productId = formData.get("productId") as string;
  const deltaStr = formData.get("delta") as string;
  const reason = formData.get("reason") as string;
  const note = (formData.get("note") as string)?.trim() || null;

  const delta = parseInt(deltaStr, 10);
  if (!productId || isNaN(delta) || delta === 0) {
    return { error: "Product and a non-zero quantity are required" };
  }
  if (!reason) {
    return { error: "Please select a reason" };
  }

  return applyAdjustment(admin, shop, productId, delta, reason, note);
};

export default function StockAdjustments() {
  const { products, adjustments } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [delta, setDelta] = useState(0);
  const [reason, setReason] = useState("count_correction");
  const [note, setNote] = useState("");

  const isBusy = fetcher.state !== "idle";
  const result = fetcher.data as Record<string, unknown> | undefined;

  useEffect(() => {
    if (result?.ok) {
      const shopifyNote = result.shopifySynced
        ? ""
        : ` (Shopify sync failed${result.shopifyError ? `: ${result.shopifyError}` : ""})`;
      shopify.toast.show(`Stock updated — new level: ${result.newStock}${shopifyNote}`);
      setDelta(0);
      setNote("");
    }
    if (result?.error) {
      shopify.toast.show(String(result.error), { isError: true });
    }
  }, [result, shopify]);

  const selectedProduct = products.find((p) => p.id === productId);
  const newStock = (selectedProduct?.currentStock ?? 0) + delta;

  const columns: DataTableColumn[] = [
    { header: "Product", width: "2fr" },
    { header: "SKU", width: "1fr" },
    { header: "Change", width: ".8fr", align: "right" },
    { header: "Reason", width: "1.2fr" },
    { header: "Note", width: "1.6fr" },
    { header: "Date", width: "1fr" },
    { header: "", width: ".9fr", align: "right" },
  ];

  const rows = adjustments.map((a) => ({
    key: a.id,
    cells: [
      <span key="n" style={{ fontWeight: 500 }}>{a.product.variantTitle ? `${a.product.title} — ${a.product.variantTitle}` : a.product.title}</span>,
      <span key="s" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12px", color: "var(--inv-text-2)" }}>{a.product.sku ?? "—"}</span>,
      <Pill
        key="d"
        label={a.delta > 0 ? `+${a.delta}` : String(a.delta)}
        bg={a.delta > 0 ? "var(--inv-status-healthy-bg)" : "var(--inv-status-stockout-bg)"}
        fg={a.delta > 0 ? "var(--inv-status-healthy-fg)" : "var(--inv-status-stockout-fg)"}
      />,
      <span key="r" style={{ fontSize: "12.5px", color: "var(--inv-text-2)" }}>{REASONS.find((r) => r.value === a.reason)?.label ?? a.reason}</span>,
      <span key="note" style={{ fontSize: "12.5px", color: "var(--inv-text-2)" }}>{a.note ?? "—"}</span>,
      <span key="date" style={{ color: "var(--inv-muted)", fontSize: "12px" }}>{new Date(a.createdAt).toLocaleDateString()}</span>,
      a.reason === "reversal" ? (
        <span key="rev" style={{ fontSize: "11px", color: "var(--inv-faint)" }}>—</span>
      ) : (
        <button
          key="rev"
          onClick={() => fetcher.submit({ intent: "reverse", adjustmentId: a.id }, { method: "POST" })}
          disabled={isBusy}
          style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}
        >
          Reverse
        </button>
      ),
    ],
  }));

  return (
    <div className="inv-root" style={{ minHeight: "100vh" }}>
      <TitleBar title="Stock Adjustments" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead eyebrow="Manual +/- with audit trail" title="Stock Adjustments" />

        <Card style={{ marginBottom: "18px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div>
              <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>Product / variant</label>
              <SelectInput value={productId} onChange={(e) => setProductId(e.target.value)}>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title}</option>
                ))}
              </SelectInput>
            </div>
            <div>
              <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>Reason</label>
              <SelectInput value={reason} onChange={(e) => setReason(e.target.value)}>
                {REASONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </SelectInput>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "flex-end", gap: "24px", marginTop: "20px", flexWrap: "wrap" }}>
            <div>
              <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>Adjustment</label>
              <div style={{ display: "flex", alignItems: "center" }}>
                <button
                  onClick={() => setDelta((d) => d - 1)}
                  style={{ width: "40px", height: "40px", border: "1px solid var(--inv-input-border-2)", borderRadius: "10px 0 0 10px", background: "#fff", fontSize: "18px", cursor: "pointer" }}
                >
                  −
                </button>
                <input
                  value={delta}
                  onChange={(e) => setDelta(parseInt(e.target.value.replace(/[^0-9-]/g, ""), 10) || 0)}
                  style={{ width: "80px", height: "40px", border: "1px solid var(--inv-input-border-2)", borderLeft: "none", borderRight: "none", textAlign: "center", fontSize: "15px", fontFamily: "var(--inv-font-mono)", fontWeight: 600, outline: "none" }}
                />
                <button
                  onClick={() => setDelta((d) => d + 1)}
                  style={{ width: "40px", height: "40px", border: "1px solid var(--inv-input-border-2)", borderRadius: "0 10px 10px 0", background: "#fff", fontSize: "18px", cursor: "pointer" }}
                >
                  +
                </button>
              </div>
            </div>
            {selectedProduct && (
              <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "14px", color: "var(--inv-text-2)", paddingBottom: "8px" }}>
                <div>
                  Current <b style={{ fontFamily: "var(--inv-font-mono)", color: "var(--inv-ink)" }}>{selectedProduct.currentStock}</b>
                </div>
                <span>→</span>
                <div>
                  New <b style={{ fontFamily: "var(--inv-font-mono)", color: newStock < 0 ? "var(--inv-status-critical-fg)" : "var(--inv-accent)" }}>{newStock}</b>
                </div>
              </div>
            )}
          </div>

          <div style={{ marginTop: "16px", maxWidth: "480px" }}>
            <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>Note (optional)</label>
            <TextArea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="e.g. 3 units found damaged in warehouse" />
          </div>

          <div style={{ marginTop: "22px" }}>
            <Button
              variant="primary"
              disabled={isBusy || !delta}
              onClick={() => fetcher.submit({ productId, delta: String(delta), reason, note }, { method: "POST" })}
            >
              Apply adjustment
            </Button>
          </div>
        </Card>

        <div style={{ fontSize: "13px", fontWeight: 600, margin: "0 0 10px" }}>Adjustment history</div>
        {adjustments.length === 0 ? (
          <Card padding="44px" style={{ textAlign: "center" }}>
            <div style={{ fontSize: "26px", marginBottom: "12px", opacity: 0.35 }}>⌛</div>
            <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "4px" }}>No adjustments yet</div>
            <div style={{ fontSize: "12.5px", color: "var(--inv-muted)" }}>
              Your audit trail appears here — every change with reason, user and timestamp.
            </div>
          </Card>
        ) : (
          <DataTable columns={columns} rows={rows} />
        )}
      </div>
    </div>
  );
}
