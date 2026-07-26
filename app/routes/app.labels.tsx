import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useRouteLoaderData } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Barcode, Button, Card, PageHead, ProductCombobox, type ComboboxProduct } from "../design";
import { isEncodable } from "../lib/barcode";

/**
 * Barcode label printing.
 *
 * The counterpart to scanning: a merchant whose goods carry no manufacturer barcode
 * generates one from the SKU, prints a sheet of labels, and sticks them on — which is
 * what turns the whole scanning workflow on for an unbranded catalogue. Labels lay out
 * with pure CSS `@media print`, so there is no PDF dependency and what previews is what
 * prints.
 */

interface LabelProduct {
  id: string;
  label: string;
  sku: string | null;
  barcode: string | null;
  /** barcode ?? sku — the value actually encoded. Null when neither can be encoded. */
  code: string | null;
  price: number | null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("product");

  // Deep-linked from the inventory drawer's "Print label". Resolved so the page opens
  // with that product already staged.
  const prefill = productId
    ? await prisma.product.findFirst({
        where: { id: productId, shop: session.shop },
        select: { id: true, title: true, variantTitle: true, sku: true, barcode: true, unitCost: true, avgMargin: true },
      })
    : null;

  const staged: LabelProduct | null = prefill
    ? {
        id: prefill.id,
        label: prefill.variantTitle ? `${prefill.title} — ${prefill.variantTitle}` : prefill.title,
        sku: prefill.sku,
        barcode: prefill.barcode,
        code: prefill.barcode || prefill.sku,
        // A rough retail price from cost and margin, only to print on the label; never a
        // figure any calculation depends on.
        price:
          prefill.unitCost > 0 && prefill.avgMargin > 0 && prefill.avgMargin < 0.95
            ? prefill.unitCost / (1 - prefill.avgMargin)
            : null,
      }
    : null;

  return { staged, currency: null as string | null };
};

interface Row {
  product: LabelProduct;
  copies: number;
}

const PRESETS = [
  { value: "sheet-3", label: "A4 sheet · 3 across", perRow: 3, labelWidth: "62mm", labelHeight: "29mm" },
  { value: "sheet-2", label: "A4 sheet · 2 across", perRow: 2, labelWidth: "95mm", labelHeight: "38mm" },
  { value: "thermal", label: "Thermal · 50×25mm", perRow: 1, labelWidth: "50mm", labelHeight: "25mm" },
] as const;

export default function Labels() {
  const { staged } = useLoaderData<typeof loader>();
  const { theme = "emerald", currency = "USD" } = useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  const [rows, setRows] = useState<Row[]>(staged && staged.code ? [{ product: staged, copies: 1 }] : []);
  const [preset, setPreset] = useState<(typeof PRESETS)[number]["value"]>("sheet-3");
  const [showPrice, setShowPrice] = useState(false);
  const [pickerValue, setPickerValue] = useState("");

  const layout = PRESETS.find((p) => p.value === preset)!;

  const [notice, setNotice] = useState<string | null>(null);

  const addProduct = (product: ComboboxProduct) => {
    const code = product.barcode || product.sku;
    if (!code || !isEncodable(code)) {
      // Common in these catalogues — 4 in 10 live products have no SKU or barcode. Say
      // so rather than silently doing nothing when the merchant picks one.
      setNotice(
        !code
          ? `${product.label} has no SKU or barcode to make a label from. Add a SKU in Shopify first.`
          : `${product.label}'s code can't be encoded (it has non-standard characters).`,
      );
      setPickerValue("");
      return;
    }
    setNotice(null);
    setRows((prev) =>
      prev.some((r) => r.product.id === product.id)
        ? prev
        : [
            ...prev,
            {
              product: {
                id: product.id,
                label: product.label,
                sku: product.sku,
                barcode: product.barcode,
                code,
                // Retail estimate computed server-side; never the raw cost, which would
                // leak margin onto a customer-facing sticker.
                price: product.retailPrice,
              },
              copies: 1,
            },
          ],
    );
    setPickerValue("");
  };

  const setCopies = (id: string, copies: number) =>
    setRows((prev) => prev.map((r) => (r.product.id === id ? { ...r, copies: Math.max(1, Math.min(200, copies)) } : r)));
  const remove = (id: string) => setRows((prev) => prev.filter((r) => r.product.id !== id));

  // The flattened label list: one entry per printed sticker.
  const labels = rows.flatMap((r) => Array.from({ length: r.copies }, () => r.product));
  const totalLabels = labels.length;

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Barcode labels">
        <button onClick={() => window.print()}>Print</button>
      </TitleBar>

      {/* Print rules: hide the whole app chrome, show only the label sheet, and size each
          label to the chosen stock. Kept inline so the page is self-contained. */}
      <style>{`
        .labels-sheet { display: grid; grid-template-columns: repeat(${layout.perRow}, 1fr); gap: 4mm; }
        .label-cell {
          width: ${layout.labelWidth}; height: ${layout.labelHeight};
          border: 1px dashed #d9d4c8; border-radius: 4px;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          padding: 2mm; box-sizing: border-box; overflow: hidden; background: #fff;
        }
        .label-name { font-size: 8pt; font-weight: 600; text-align: center; line-height: 1.1; max-height: 2.4em; overflow: hidden; color: #000; }
        .label-price { font-size: 9pt; font-weight: 700; color: #000; }
        @media print {
          @page { margin: 8mm; }
          body * { visibility: hidden; }
          #print-area, #print-area * { visibility: visible; }
          #print-area { position: absolute; left: 0; top: 0; width: 100%; }
          .label-cell { border-color: transparent; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <div className="no-print">
          <PageHead eyebrow="Generate · print · stick on" title="Barcode labels" />

          <Card style={{ marginBottom: "14px" }}>
            <div style={{ fontSize: "13px", color: "var(--inv-text-2)", lineHeight: 1.6, marginBottom: "14px" }}>
              Generates a scannable Code&nbsp;128 barcode for each product — from its Shopify barcode, or from its
              SKU when it has none — and lays the labels out for printing. Print onto label stock or plain paper,
              stick them on, and every product scans in receiving, counting and adjustments.
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "16px", alignItems: "end" }}>
              <div>
                <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>
                  Add a product
                </label>
                <ProductCombobox
                  value={pickerValue}
                  onChange={(_id, product) => product && addProduct(product)}
                  placeholder="Search or scan a product to add…"
                />
              </div>
              <div>
                <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>
                  Label size
                </label>
                <select
                  value={preset}
                  onChange={(e) => setPreset(e.target.value as typeof preset)}
                  style={{ width: "100%", height: "38px", border: "1px solid var(--inv-input-border-2)", borderRadius: "10px", padding: "0 10px", background: "#fff", color: "var(--inv-ink)", fontSize: "13px" }}
                >
                  {PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {notice && (
              <div style={{ marginTop: "12px", fontSize: "12px", color: "var(--inv-status-critical-fg)", background: "var(--inv-status-critical-bg)", borderRadius: "8px", padding: "8px 12px" }} role="alert">
                {notice}
              </div>
            )}

            <label style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "12.5px", color: "var(--inv-text-2)", marginTop: "14px", cursor: "pointer" }}>
              <input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} />
              Print price on the label
              <span style={{ color: "var(--inv-muted)", fontSize: "11.5px" }}>
                (retail estimate — only on products where it can be worked out)
              </span>
            </label>
          </Card>

          {rows.length > 0 && (
            <Card style={{ marginBottom: "14px" }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "12px" }}>
                <div style={{ fontSize: "14px", fontWeight: 600 }}>
                  {rows.length} product{rows.length === 1 ? "" : "s"} · {totalLabels} label{totalLabels === 1 ? "" : "s"}
                </div>
                <Button variant="primary" onClick={() => window.print()}>Print {totalLabels} label{totalLabels === 1 ? "" : "s"}</Button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {rows.map((r) => (
                  <div key={r.product.id} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: "12px", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--inv-divider)" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: "13px", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.product.label}</div>
                      <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", fontFamily: "var(--inv-font-mono)" }}>
                        {r.product.code}{r.product.barcode ? "" : " · from SKU"}
                      </div>
                    </div>
                    <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--inv-text-2)" }}>
                      Copies
                      <input
                        type="number"
                        min={1}
                        max={200}
                        value={r.copies}
                        onChange={(e) => setCopies(r.product.id, parseInt(e.target.value, 10) || 1)}
                        style={{ width: "62px", height: "32px", border: "1px solid var(--inv-input-border-2)", borderRadius: "8px", padding: "0 8px", textAlign: "right", fontFamily: "var(--inv-font-mono)" }}
                      />
                    </label>
                    <button
                      onClick={() => remove(r.product.id)}
                      style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-status-stockout-fg)", padding: "6px 10px", borderRadius: "8px", cursor: "pointer" }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        {rows.length === 0 ? (
          <div className="no-print">
            <Card padding="40px 24px">
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>No labels yet</div>
                <div style={{ fontSize: "13px", color: "var(--inv-muted)" }}>
                  Add a product above to generate its barcode label.
                </div>
              </div>
            </Card>
          </div>
        ) : (
          <div id="print-area">
            <div className="labels-sheet">
              {labels.map((p, i) => (
                <div className="label-cell" key={`${p.id}-${i}`}>
                  <div className="label-name">{p.label}</div>
                  <Barcode value={p.code as string} moduleWidth={1.3} height={38} fontSize={9} />
                  {showPrice && p.price != null && (
                    <div className="label-price">{formatPrice(p.price, currency)}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return amount.toFixed(0);
  }
}
