import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRouteLoaderData, useSearchParams } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { applyStockDelta } from "../lib/stock.server";
import { Button, Card, DataTable, FilterChips, PageHead, Pill, SelectInput, TextArea, type DataTableColumn } from "../design";

const REASONS = [
  { label: "Damage / Loss", value: "damage" },
  { label: "Count Correction", value: "count_correction" },
  { label: "Sample / Giveaway", value: "sample" },
  { label: "Customer Return", value: "return" },
  { label: "Other", value: "other" },
];

const PAGE_SIZE = 50;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  // The inventory drawer links here with ?product=<id> ("Damaged is tallied from damage
  // stock adjustments"). That parameter used to be ignored entirely, dropping the
  // merchant onto an unfiltered list with no indication of why.
  const requestedProductId = url.searchParams.get("product");
  const reasonFilter = url.searchParams.get("reason") ?? "all";
  const rawPage = parseInt(url.searchParams.get("page") ?? "1", 10);
  const requestedPage = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  // Validated against this shop, so a stale or hand-edited id filters to nothing rather
  // than silently showing the whole list as if no filter were applied.
  const filteredProduct = requestedProductId
    ? await prisma.product.findFirst({
        where: { id: requestedProductId, shop },
        select: { id: true, title: true, variantTitle: true },
      })
    : null;

  const where = {
    shop,
    ...(filteredProduct ? { productId: filteredProduct.id } : {}),
    ...(reasonFilter !== "all" ? { reason: reasonFilter } : {}),
  };

  // Counted before the page query so `page` can be clamped to a page that exists. Asking
  // for ?page=999 previously skipped past the end and rendered an empty table under the
  // heading "Page 999 of 4" — the number shown was clamped but the query was not.
  const totalAdjustments = await prisma.stockAdjustment.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalAdjustments / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);

  const [products, adjustments, locations] = await Promise.all([
    prisma.product.findMany({
      where: { shop },
      orderBy: { title: "asc" },
      select: { id: true, title: true, variantTitle: true, sku: true, currentStock: true },
    }),
    prisma.stockAdjustment.findMany({
      where,
      include: { product: { select: { title: true, variantTitle: true, sku: true } } },
      // createdAt alone is not a total order — several adjustments can share a timestamp
      // (a bulk CSV import writes them in the same millisecond), and a non-deterministic
      // tiebreak lets a row appear on two pages or on neither. id breaks the tie.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.location.findMany({
      where: { shop, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  // Which of the rows on this page have already been undone, so the UI can say so
  // instead of offering a Reverse button that will only ever return an error.
  const reversals = await prisma.stockAdjustment.findMany({
    where: { shop, reversalOf: { in: adjustments.map((a) => a.id) } },
    select: { reversalOf: true },
  });
  const reversedIds = reversals
    .map((r) => r.reversalOf)
    .filter((id): id is string => id !== null);

  return {
    products,
    adjustments,
    reversedIds,
    locations,
    filteredProduct,
    // Distinguishes "no such product in this shop" from "no filter requested", so the UI
    // can explain an empty list instead of looking broken.
    unknownProductFilter: !!requestedProductId && !filteredProduct,
    reasonFilter,
    page,
    totalPages,
    totalAdjustments,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = (formData.get("intent") as string) || "adjust";

  if (intent === "reverse") {
    const adjustmentId = formData.get("adjustmentId") as string;
    if (!adjustmentId) return { error: "No adjustment selected" };

    const original = await prisma.stockAdjustment.findFirst({ where: { id: adjustmentId, shop } });
    if (!original) return { error: "Adjustment not found" };
    // Reversing a reversal is a loop with no meaning — undo the original instead.
    if (original.reversalOf) {
      return { error: "This row is itself a reversal and cannot be reversed" };
    }

    // A cheap pre-check for the common case; the authoritative guard is the unique
    // index on reversalOf, which is what actually holds under concurrent submits.
    const existing = await prisma.stockAdjustment.findUnique({
      where: { reversalOf: original.id },
      select: { id: true },
    });
    if (existing) return { error: "That adjustment has already been reversed" };

    return applyStockDelta(
      admin,
      shop,
      original.productId,
      -original.delta,
      "reversal",
      `Reversal of ${original.reason} adjustment from ${original.createdAt.toISOString().slice(0, 10)}`,
      original.locationId,
      { reversalOf: original.id },
    );
  }

  const productId = formData.get("productId") as string;
  const deltaStr = formData.get("delta") as string;
  const reason = formData.get("reason") as string;
  const note = (formData.get("note") as string)?.trim() || null;
  const locationId = (formData.get("locationId") as string) || null;

  const delta = parseInt(deltaStr, 10);
  if (!productId || isNaN(delta) || delta === 0) {
    return { error: "Product and a non-zero quantity are required" };
  }
  if (!reason) {
    return { error: "Please select a reason" };
  }

  return applyStockDelta(admin, shop, productId, delta, reason, note, locationId);
};

export default function StockAdjustments() {
  const {
    products, adjustments, reversedIds, locations, filteredProduct, unknownProductFilter,
    reasonFilter, page, totalPages, totalAdjustments,
  } = useLoaderData<typeof loader>();
  const reversedSet = new Set(reversedIds);
  const { theme = "emerald" } = useRouteLoaderData<typeof appLoader>("routes/app") ?? {};
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [, setSearchParams] = useSearchParams();

  // Arriving from the inventory drawer, the SKU in question is the one you want to
  // adjust — so preselect it in the form rather than the alphabetically-first product.
  const [productId, setProductId] = useState(filteredProduct?.id ?? products[0]?.id ?? "");
  const [delta, setDelta] = useState(0);
  const [reason, setReason] = useState("count_correction");
  const [note, setNote] = useState("");
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");

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

  /** Rewrite one search param, always resetting to page 1 so a filter change cannot
   *  land on a page number that no longer exists. */
  const setParam = (key: string, value: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null || value === "" || value === "all") next.delete(key);
        else next.set(key, value);
        if (key !== "page") next.delete("page");
        return next;
      },
      { preventScrollReset: true },
    );
  };

  const filteredProductName = filteredProduct
    ? filteredProduct.variantTitle
      ? `${filteredProduct.title} — ${filteredProduct.variantTitle}`
      : filteredProduct.title
    : null;

  const historyHeading = filteredProductName
    ? `Adjustment history — ${filteredProductName}`
    : "Adjustment history";

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
      a.reversalOf ? (
        <span key="rev" title="This row undoes an earlier adjustment" style={{ fontSize: "11px", color: "var(--inv-faint)" }}>
          reversal
        </span>
      ) : reversedSet.has(a.id) ? (
        <span key="rev" title="An opposing adjustment has already been recorded" style={{ fontSize: "11px", color: "var(--inv-muted)" }}>
          reversed
        </span>
      ) : (
        <button
          key="rev"
          onClick={() => {
            const back = a.delta > 0 ? `remove ${a.delta}` : `add ${Math.abs(a.delta)}`;
            if (window.confirm(`Reverse this adjustment?\n\nThis will ${back} unit${Math.abs(a.delta) === 1 ? "" : "s"} of ${a.product.title} and push the change to Shopify.`)) {
              fetcher.submit({ intent: "reverse", adjustmentId: a.id }, { method: "POST" });
            }
          }}
          disabled={isBusy}
          style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}
        >
          Reverse
        </button>
      ),
    ],
  }));

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
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

          {locations.length > 1 && (
            <div style={{ marginTop: "16px", maxWidth: "480px" }}>
              <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>Location</label>
              <SelectInput value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </SelectInput>
            </div>
          )}

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
              onClick={() => fetcher.submit({ productId, delta: String(delta), reason, note, locationId }, { method: "POST" })}
            >
              Apply adjustment
            </Button>
          </div>
        </Card>

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", margin: "0 0 10px" }}>
          <div style={{ fontSize: "13px", fontWeight: 600 }}>{historyHeading}</div>
          <div style={{ fontSize: "11.5px", color: "var(--inv-muted)" }}>
            {totalAdjustments} adjustment{totalAdjustments === 1 ? "" : "s"}
          </div>
        </div>

        {(filteredProductName || unknownProductFilter) && (
          <Card padding="10px 14px" style={{ marginBottom: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", fontSize: "12.5px" }}>
              {unknownProductFilter ? (
                <span style={{ color: "var(--inv-status-critical-fg)" }}>
                  That product is not in this shop — showing nothing. Clear the filter to see all adjustments.
                </span>
              ) : (
                <span style={{ color: "var(--inv-text-2)" }}>
                  Filtered to <b>{filteredProductName}</b>
                </span>
              )}
              <button
                onClick={() => setParam("product", null)}
                style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", padding: "4px 9px", borderRadius: "8px", cursor: "pointer" }}
              >
                Clear filter
              </button>
            </div>
          </Card>
        )}

        <FilterChips
          options={[{ value: "all", label: "All reasons" }, ...REASONS, { value: "reversal", label: "Reversal" }]}
          active={reasonFilter}
          onChange={(value) => setParam("reason", value)}
        />

        {adjustments.length === 0 ? (
          <Card padding="44px" style={{ textAlign: "center" }}>
            <div style={{ fontSize: "26px", marginBottom: "12px", opacity: 0.35 }}>⌛</div>
            <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "4px" }}>
              {filteredProductName || reasonFilter !== "all" || unknownProductFilter
                ? "No adjustments match these filters"
                : "No adjustments yet"}
            </div>
            <div style={{ fontSize: "12.5px", color: "var(--inv-muted)" }}>
              {filteredProductName || reasonFilter !== "all" || unknownProductFilter
                ? "Try clearing the product or reason filter."
                : "Your audit trail appears here — every change with reason and timestamp."}
            </div>
          </Card>
        ) : (
          <>
            <DataTable columns={columns} rows={rows} />
            {totalPages > 1 && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", marginTop: "12px" }}>
                <Button variant="ghost" disabled={page <= 1} onClick={() => setParam("page", String(page - 1))}>
                  ← Previous
                </Button>
                <span style={{ fontSize: "12px", color: "var(--inv-muted)", fontFamily: "var(--inv-font-mono)" }}>
                  Page {page} of {totalPages}
                </span>
                <Button variant="ghost" disabled={page >= totalPages} onClick={() => setParam("page", String(page + 1))}>
                  Next →
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
