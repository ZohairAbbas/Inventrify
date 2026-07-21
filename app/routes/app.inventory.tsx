import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import Papa from "papaparse";
import { useEffect, useRef, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { applyStockDelta } from "../lib/stock.server";
import {
  getStockStatus,
  calculateDaysRemaining,
  calculateReorderPoint,
} from "../lib/forecast.server";
import {
  Button,
  Card,
  DataTable,
  Drawer,
  FilterChips,
  PageHead,
  SelectInput,
  StatusBadge,
  Toast,
  type DataTableColumn,
  type StockStatus,
} from "../design";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") ?? "all";
  const search = url.searchParams.get("search") ?? "";
  const locationFilter = url.searchParams.get("location") ?? "all";

  const products = await prisma.product.findMany({
    where: {
      shop: session.shop,
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: "insensitive" } },
              { sku: { contains: search, mode: "insensitive" } },
              { variantTitle: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: {
      supplier: { select: { name: true } },
      locationStock: { include: { location: { select: { id: true, name: true } } } },
    },
    orderBy: { title: "asc" },
  });

  const enriched = products
    .map((p) => {
      // When a location is selected, show that location's on-hand as the "stock"
      const locLevel =
        locationFilter !== "all"
          ? p.locationStock.find((ls) => ls.locationId === locationFilter)
          : null;
      const effectiveStock = locationFilter !== "all" ? locLevel?.onHand ?? 0 : p.currentStock;
      return {
        ...p,
        effectiveStock,
        locationBreakdown: p.locationStock.map((ls) => ({
          locationId: ls.locationId,
          name: ls.location.name,
          onHand: ls.onHand,
          reserved: ls.reserved,
          available: ls.onHand - ls.reserved,
        })),
        status: getStockStatus(effectiveStock, p.reorderPoint),
        daysRemaining: calculateDaysRemaining(effectiveStock, p.avgDailySales || 0.5),
        displayName: p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title,
      };
    })
    .filter((p) => statusFilter === "all" || p.status === statusFilter)
    .filter((p) => locationFilter === "all" || p.locationBreakdown.some((l) => l.locationId === locationFilter));

  const [suppliers, locations, settings, damageTally, writeOffTally] = await Promise.all([
    prisma.supplier.findMany({
      where: { shop: session.shop },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.location.findMany({
      where: { shop: session.shop, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    }),
    prisma.shopSettings.findUnique({
      where: { shop: session.shop },
      select: { courierifyApiKey: true },
    }),
    // Damaged pipeline count = units removed via damage adjustments (§7.8)...
    prisma.stockAdjustment.groupBy({
      by: ["productId"],
      where: { shop: session.shop, reason: "damage" },
      _sum: { delta: true },
    }),
    // ...plus returned units written off from the returns queue.
    prisma.returnItem.groupBy({
      by: ["productId"],
      where: { shop: session.shop, status: "written_off", productId: { not: null } },
      _sum: { quantity: true },
    }),
  ]);

  const damageByProduct = new Map<string, number>();
  for (const d of damageTally) {
    damageByProduct.set(d.productId, Math.abs(d._sum.delta ?? 0));
  }
  for (const w of writeOffTally) {
    if (!w.productId) continue;
    damageByProduct.set(w.productId, (damageByProduct.get(w.productId) ?? 0) + (w._sum.quantity ?? 0));
  }
  const courierifyConnected = !!settings?.courierifyApiKey;

  const withPipeline = enriched.map((p) => ({
    ...p,
    damaged: damageByProduct.get(p.id) ?? 0,
  }));

  return {
    products: withPipeline,
    statusFilter,
    search,
    suppliers,
    locations,
    locationFilter,
    courierifyConnected,
  };
};

type CsvImportRow = {
  productId: string;
  reorderPoint?: number;
  leadTimeDays?: number;
  supplierName?: string;
  stock?: number;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "import_csv") {
    const rowsJson = formData.get("rows") as string;
    let rows: CsvImportRow[] = [];
    try {
      rows = JSON.parse(rowsJson);
    } catch {
      return { intent, error: "Invalid import payload" };
    }
    if (!Array.isArray(rows) || rows.length === 0) return { intent, error: "No changes to import" };

    const suppliers = await prisma.supplier.findMany({ where: { shop }, select: { id: true, name: true } });
    const supplierByName = new Map(suppliers.map((s) => [s.name.trim().toLowerCase(), s.id]));

    let reorderUpdates = 0;
    let stockChanges = 0;
    const errors: string[] = [];

    for (const row of rows) {
      if (!row.productId) continue;

      const productUpdate: Record<string, unknown> = {};
      if (typeof row.reorderPoint === "number") productUpdate.reorderPoint = row.reorderPoint;
      if (typeof row.leadTimeDays === "number") productUpdate.leadTimeDays = row.leadTimeDays;
      if (row.supplierName) {
        const supplierId = supplierByName.get(row.supplierName.trim().toLowerCase());
        if (supplierId) productUpdate.supplierId = supplierId;
      }
      if (Object.keys(productUpdate).length > 0) {
        await prisma.product.updateMany({ where: { id: row.productId, shop }, data: productUpdate });
        reorderUpdates++;
      }

      if (typeof row.stock === "number") {
        const product = await prisma.product.findFirst({ where: { id: row.productId, shop } });
        if (product) {
          const delta = row.stock - product.currentStock;
          if (delta !== 0) {
            const result = await applyStockDelta(admin, shop, row.productId, delta, "csv_import", "Bulk CSV import");
            if ("error" in result) errors.push(`${product.title}: ${result.error}`);
            else stockChanges++;
          }
        }
      }
    }

    return { intent, ok: true, reorderUpdates, stockChanges, errors };
  }

  if (intent === "bulk_create_pos") {
    const productIds = formData.getAll("productIds") as string[];
    if (productIds.length === 0) return { error: "No products selected" };

    const products = await prisma.product.findMany({ where: { id: { in: productIds } } });

    const bySupplier = new Map<string, typeof products>();
    for (const product of products) {
      const key = product.supplierId ?? "__none__";
      const group = bySupplier.get(key);
      if (group) group.push(product);
      else bySupplier.set(key, [product]);
    }

    for (const [supplierKey, group] of bySupplier) {
      const d = new Date();
      const datePart = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
      const poNumber = `PO-${datePart}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

      const items = group.map((product) => ({
        productId: product.id,
        quantityOrdered: Math.max(
          10,
          calculateReorderPoint(product.avgDailySales || 1, product.leadTimeDays) * 2 - product.currentStock,
        ),
        unitCost: 0,
      }));

      await prisma.purchaseOrder.create({
        data: {
          shop: session.shop,
          poNumber,
          supplierId: supplierKey === "__none__" ? null : supplierKey,
          totalCost: 0,
          items: { create: items },
        },
      });
    }

    return redirect("/app/purchase-orders");
  }

  if (intent === "update_supplier") {
    const productId = formData.get("productId") as string;
    const supplierId = (formData.get("supplierId") as string) || null;

    if (productId) {
      await prisma.product.updateMany({
        where: { id: productId, shop: session.shop },
        data: { supplierId },
      });
    }
    return { ok: true };
  }

  if (intent === "update_reorder") {
    const productId = formData.get("productId") as string;
    const reorderPoint = parseInt(formData.get("reorderPoint") as string, 10);
    const leadTimeDays = parseInt(formData.get("leadTimeDays") as string, 10);

    if (productId && !isNaN(reorderPoint)) {
      await prisma.product.update({
        where: { id: productId },
        data: { reorderPoint, leadTimeDays: isNaN(leadTimeDays) ? 7 : leadTimeDays },
      });
    }
    return { ok: true };
  }

  return { ok: true };
};

const STATUS_CHIPS = [
  { value: "all", label: "All" },
  { value: "healthy", label: "Healthy" },
  { value: "low", label: "Low" },
  { value: "critical", label: "Critical" },
  { value: "stockout", label: "Stockout" },
];

type CsvDiffRow = {
  productId: string;
  displayName: string;
  reorderPoint?: number;
  leadTimeDays?: number;
  supplierName?: string;
  stock?: number;
  changes: string[];
};

export default function Inventory() {
  const { products, statusFilter, search, suppliers, locations, locationFilter, courierifyConnected } = useLoaderData<typeof loader>();
  const { theme = "emerald" } = useRouteLoaderData<typeof appLoader>("routes/app") ?? {};
  const fetcher = useFetcher<typeof action>();
  const importFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [, setSearchParams] = useSearchParams();
  const [queryValue, setQueryValue] = useState(search);
  const [selected, setSelected] = useState<string[]>([]);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [supplierDraft, setSupplierDraft] = useState("");
  const [csvDiff, setCsvDiff] = useState<CsvDiffRow[] | null>(null);
  const [unmatchedCount, setUnmatchedCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (fetcher.data && (fetcher.data as { ok?: boolean }).ok) {
      shopify.toast.show("Updated");
    }
  }, [fetcher.data, shopify]);

  useEffect(() => {
    const result = importFetcher.data as
      | { intent?: string; ok?: boolean; error?: string; reorderUpdates?: number; stockChanges?: number; errors?: string[] }
      | undefined;
    if (!result || result.intent !== "import_csv") return;
    if (result.error) {
      shopify.toast.show(result.error, { isError: true });
      return;
    }
    if (result.ok) {
      const errSuffix = result.errors && result.errors.length > 0 ? ` (${result.errors.length} failed)` : "";
      shopify.toast.show(
        `Import complete — ${result.reorderUpdates ?? 0} field updates, ${result.stockChanges ?? 0} stock changes${errSuffix}`,
      );
      setCsvDiff(null);
    }
  }, [importFetcher.data, shopify]);

  const exportCsv = () => {
    const rows = products.map((p) => ({
      SKU: p.sku ?? "",
      Product: p.title,
      Variant: p.variantTitle ?? "",
      Stock: p.currentStock,
      "Reorder Point": p.reorderPoint,
      "Lead Time (days)": p.leadTimeDays,
      "COD Return Rate": p.codReturnRate,
      "Avg Margin": p.avgMargin,
      Supplier: p.supplier?.name ?? "",
    }));
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inventrify-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFileSelected = (file: File) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const bySku = new Map(products.filter((p) => p.sku).map((p) => [p.sku as string, p]));
        const diff: CsvDiffRow[] = [];
        let unmatched = 0;

        for (const row of results.data) {
          const sku = row.SKU?.trim();
          if (!sku) continue;
          const product = bySku.get(sku);
          if (!product) {
            unmatched++;
            continue;
          }

          const changes: string[] = [];
          const diffRow: CsvDiffRow = { productId: product.id, displayName: product.displayName, changes };

          const reorderPoint = row["Reorder Point"] !== undefined ? parseInt(row["Reorder Point"], 10) : NaN;
          if (!isNaN(reorderPoint) && reorderPoint !== product.reorderPoint) {
            diffRow.reorderPoint = reorderPoint;
            changes.push(`reorder ${product.reorderPoint} → ${reorderPoint}`);
          }

          const leadTimeDays = row["Lead Time (days)"] !== undefined ? parseInt(row["Lead Time (days)"], 10) : NaN;
          if (!isNaN(leadTimeDays) && leadTimeDays !== product.leadTimeDays) {
            diffRow.leadTimeDays = leadTimeDays;
            changes.push(`lead time ${product.leadTimeDays}d → ${leadTimeDays}d`);
          }

          const supplierName = row.Supplier?.trim();
          if (supplierName && supplierName !== (product.supplier?.name ?? "")) {
            diffRow.supplierName = supplierName;
            changes.push(`supplier → ${supplierName}`);
          }

          const stock = row.Stock !== undefined ? parseInt(row.Stock, 10) : NaN;
          if (!isNaN(stock) && stock !== product.currentStock) {
            diffRow.stock = stock;
            changes.push(`stock ${product.currentStock} → ${stock}`);
          }

          if (changes.length > 0) diff.push(diffRow);
        }

        setUnmatchedCount(unmatched);
        setCsvDiff(diff);
      },
    });
  };

  const confirmImport = () => {
    if (!csvDiff) return;
    importFetcher.submit(
      { intent: "import_csv", rows: JSON.stringify(csvDiff) },
      { method: "POST" },
    );
  };

  useEffect(() => {
    const t = setTimeout(() => {
      setSearchParams((p) => {
        const next = new URLSearchParams(p);
        if (queryValue) next.set("search", queryValue);
        else next.delete("search");
        return next;
      });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryValue]);

  const setStatusFilter = (value: string) => {
    setSearchParams((p) => {
      const next = new URLSearchParams(p);
      if (value !== "all") next.set("status", value);
      else next.delete("status");
      return next;
    });
  };

  const setLocationFilter = (value: string) => {
    setSearchParams((p) => {
      const next = new URLSearchParams(p);
      if (value !== "all") next.set("location", value);
      else next.delete("location");
      return next;
    });
  };

  const allSelected = products.length > 0 && selected.length === products.length;
  const toggleAll = () => setSelected(allSelected ? [] : products.map((p) => p.id));
  const toggleOne = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const generatePOs = () => {
    const form = new FormData();
    form.append("intent", "bulk_create_pos");
    selected.forEach((id) => form.append("productIds", id));
    fetcher.submit(form, { method: "POST" });
  };

  const drawerProduct = products.find((p) => p.id === drawerId);

  useEffect(() => {
    setSupplierDraft(drawerProduct?.supplierId ?? "");
  }, [drawerProduct?.id, drawerProduct?.supplierId]);

  const columns: DataTableColumn[] = [
    { header: "", width: "34px" },
    { header: "Product / Variant", width: "2.4fr" },
    { header: "SKU", width: "1fr" },
    { header: "Stock", width: ".7fr", align: "right" },
    { header: "Reorder", width: ".8fr", align: "right" },
    { header: "Days left", width: ".9fr", align: "right" },
    { header: "COD ret.", width: ".9fr", align: "right" },
    { header: "Margin", width: "1fr", align: "right" },
    { header: "Supplier", width: "1.1fr" },
    { header: "Pipeline · Courierify", width: "2fr" },
    { header: "Status", width: "1fr", align: "right" },
  ];

  // Compact fulfilment-pipeline chips. Delivered/Transit/Returned come from Courierify;
  // Damaged from Inventrify's own damage-adjustment tally. Degrades gracefully when
  // Courierify isn't connected (shows Damaged only).
  // One pipeline cell: mono value stacked over an uppercase label (prototype pipeCell).
  // Delivered/Transit are static; Returned/Damaged (when > 0) link to the returns queue.
  const pipeCell = (
    key: string,
    value: number,
    label: string,
    color: string,
    title: string,
    href?: string,
  ) => {
    const linkable = !!href && value > 0;
    const inner = (
      <>
        <div style={{ fontFamily: "var(--inv-font-mono)", fontSize: "13.5px", fontWeight: 600, lineHeight: 1.05, color: value > 0 ? color : "var(--inv-faint)" }}>
          {value}
        </div>
        <div style={{ fontSize: "8.5px", letterSpacing: ".4px", textTransform: "uppercase", color: "var(--inv-muted)", marginTop: "3px" }}>
          {label}
        </div>
      </>
    );
    const cellStyle = {
      textAlign: "center" as const,
      minWidth: "34px",
      padding: "2px 4px",
      borderRadius: "7px",
    };
    if (linkable) {
      return (
        <Link
          key={key}
          to={href}
          title={`${title} — open returns`}
          onClick={(e) => e.stopPropagation()}
          style={{ ...cellStyle, display: "block", cursor: "pointer", textDecoration: "none" }}
        >
          {inner}
        </Link>
      );
    }
    return (
      <div key={key} title={title} style={cellStyle}>
        {inner}
      </div>
    );
  };

  const rows = products.map((p) => ({
    key: p.id,
    onClick: () => setDrawerId(p.id),
    cells: [
      <input
        key="check"
        type="checkbox"
        checked={selected.includes(p.id)}
        onClick={(e) => e.stopPropagation()}
        onChange={() => toggleOne(p.id)}
      />,
      <div key="name">
        <div style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {p.displayName}
        </div>
      </div>,
      <span key="sku" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12px", color: "var(--inv-text-2)" }}>
        {p.sku ?? "—"}
      </span>,
      <span
        key="stock"
        style={{
          fontFamily: "var(--inv-font-mono)",
          fontWeight: 600,
          color: p.effectiveStock <= 0 ? "var(--inv-status-stockout-fg)" : "var(--inv-ink)",
        }}
      >
        {p.effectiveStock}
      </span>,
      <span key="reorder" style={{ fontFamily: "var(--inv-font-mono)", color: "var(--inv-muted)" }}>
        {p.reorderPoint}
      </span>,
      <span
        key="days"
        style={{ fontFamily: "var(--inv-font-mono)", color: p.daysRemaining <= 7 ? "var(--inv-status-critical-fg)" : "var(--inv-text-2)" }}
      >
        {p.daysRemaining > 900 ? "N/A" : `${p.daysRemaining}d`}
      </span>,
      <span key="cod" style={{ fontFamily: "var(--inv-font-mono)", color: "var(--inv-text-2)" }}>
        {p.codReturnRate > 0 ? `${(p.codReturnRate * 100).toFixed(0)}%` : "—"}
      </span>,
      <span key="margin" style={{ fontFamily: "var(--inv-font-mono)", color: "var(--inv-text-2)" }}>
        {p.avgMargin > 0 ? `${(p.avgMargin * 100).toFixed(0)}%` : "—"}
      </span>,
      <span key="supplier" style={{ fontSize: "12.5px", color: "var(--inv-text-2)" }}>
        {p.supplier?.name ?? "—"}
      </span>,
      <div key="pipeline" style={{ display: "flex", gap: "10px", justifyContent: "flex-start" }}>
        {courierifyConnected && pipeCell("deliv", p.fulfilledDelivered, "Deliv", "var(--inv-status-healthy-dot)", "Delivered — live snapshot")}
        {courierifyConnected && pipeCell("transit", p.fulfilledInTransit, "Transit", "var(--inv-transit-fg)", "In-transit — live now")}
        {courierifyConnected && pipeCell("ret", p.fulfilledReturned, "Ret", "var(--inv-status-critical-fg)", "Returned", "/app/returns")}
        {pipeCell("dmg", p.damaged, "Dmg", "var(--inv-status-stockout-fg)", "Damaged", "/app/returns")}
      </div>,
      <StatusBadge key="status" status={p.status as StockStatus} />,
    ],
  }));

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Inventory" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead
          eyebrow="Workhorse"
          title="Inventory"
          right={
            selected.length > 0 ? (
              <button
                onClick={generatePOs}
                style={{
                  background: "var(--inv-ink)",
                  color: "#fff",
                  border: "none",
                  fontSize: "13px",
                  fontWeight: 500,
                  padding: "9px 15px",
                  borderRadius: "10px",
                  cursor: "pointer",
                }}
              >
                Generate POs for {selected.length} selected
              </button>
            ) : (
              <div style={{ display: "flex", gap: "8px" }}>
                <Button variant="ghost" onClick={exportCsv}>
                  Export CSV
                </Button>
                <Button variant="ghost" onClick={() => fileInputRef.current?.click()}>
                  Import CSV
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileSelected(file);
                    e.target.value = "";
                  }}
                />
              </div>
            )
          }
        />

        {csvDiff && (
          <Card style={{ marginBottom: "14px" }}>
            <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "8px" }}>Import preview</div>
            {csvDiff.length === 0 ? (
              <div style={{ fontSize: "13px", color: "var(--inv-muted)" }}>
                No changes detected{unmatchedCount > 0 ? ` (${unmatchedCount} SKU${unmatchedCount !== 1 ? "s" : ""} not matched)` : ""}.
              </div>
            ) : (
              <>
                <div style={{ fontSize: "13px", color: "var(--inv-text-2)", marginBottom: "12px" }}>
                  {csvDiff.filter((r) => r.reorderPoint !== undefined || r.leadTimeDays !== undefined).length} reorder/lead-time changes ·{" "}
                  {csvDiff.filter((r) => r.supplierName !== undefined).length} supplier changes ·{" "}
                  {csvDiff.filter((r) => r.stock !== undefined).length} stock changes
                  {unmatchedCount > 0 ? ` · ${unmatchedCount} SKU${unmatchedCount !== 1 ? "s" : ""} not matched` : ""}
                </div>
                <div style={{ maxHeight: "220px", overflowY: "auto", marginBottom: "14px" }}>
                  {csvDiff.map((r) => (
                    <div key={r.productId} style={{ fontSize: "12.5px", padding: "6px 0", borderBottom: "1px solid var(--inv-divider)" }}>
                      <b>{r.displayName}</b> — {r.changes.join(", ")}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <Button variant="primary" disabled={importFetcher.state !== "idle"} onClick={confirmImport}>
                    Confirm import
                  </Button>
                  <Button variant="ghost" onClick={() => setCsvDiff(null)}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </Card>
        )}

        <div style={{ display: "flex", gap: "10px", marginBottom: "12px", alignItems: "center", flexWrap: "wrap" }}>
          <div
            style={{
              flex: 1,
              minWidth: "220px",
              display: "flex",
              alignItems: "center",
              gap: "9px",
              background: "#fff",
              border: "1px solid var(--inv-input-border)",
              borderRadius: "10px",
              padding: "0 12px",
              height: "38px",
            }}
          >
            <span style={{ color: "var(--inv-muted)" }}>⌕</span>
            <input
              value={queryValue}
              placeholder="Search product, variant or SKU"
              onChange={(e) => setQueryValue(e.target.value)}
              style={{ border: "none", outline: "none", flex: 1, fontSize: "13px", background: "transparent", color: "var(--inv-ink)" }}
            />
          </div>
          {locations.length > 1 && (
            <SelectInput
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
              style={{ width: "auto", minWidth: "170px", height: "38px" }}
            >
              <option value="all">All locations</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </SelectInput>
          )}
        </div>

        <FilterChips options={STATUS_CHIPS} active={statusFilter} onChange={setStatusFilter} />

        {products.length === 0 ? (
          <Card padding="40px 24px">
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>No products found</div>
              <div style={{ fontSize: "13px", color: "var(--inv-muted)" }}>Try adjusting your search or filters.</div>
            </div>
          </Card>
        ) : (
          <>
            <div style={{ marginBottom: "8px" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--inv-text-2)" }}>
                <input type="checkbox" checked={allSelected} onChange={toggleAll} /> Select all
              </label>
            </div>
            <DataTable columns={columns} rows={rows} />
            <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginTop: "10px", textAlign: "center" }}>
              Showing {products.length} variant{products.length !== 1 ? "s" : ""} · click a row for detail
            </div>
          </>
        )}
      </div>

      <Drawer open={!!drawerProduct} onClose={() => setDrawerId(null)}>
        {drawerProduct && (
          <div style={{ padding: "24px 26px" }}>
            <button
              onClick={() => setDrawerId(null)}
              style={{
                position: "absolute",
                top: "18px",
                right: "22px",
                border: "none",
                background: "var(--inv-divider-3)",
                width: "30px",
                height: "30px",
                borderRadius: "8px",
                cursor: "pointer",
                fontSize: "14px",
              }}
            >
              ✕
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
              <StatusBadge status={drawerProduct.status as StockStatus} />
              <span style={{ fontFamily: "var(--inv-font-mono)", fontSize: "11.5px", color: "var(--inv-muted)" }}>
                {drawerProduct.sku ?? "—"}
              </span>
            </div>
            <div style={{ fontSize: "19px", fontWeight: 600, marginBottom: "2px" }}>{drawerProduct.title}</div>
            <div style={{ fontSize: "13px", color: "var(--inv-muted)", marginBottom: "18px" }}>
              {drawerProduct.variantTitle ?? ""}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "18px" }}>
              {[
                ["Stock", String(drawerProduct.currentStock)],
                ["Reorder at", String(drawerProduct.reorderPoint)],
                ["Days left", drawerProduct.daysRemaining > 900 ? "N/A" : `${drawerProduct.daysRemaining}d`],
                ["Avg daily", `${(drawerProduct.avgDailySales || 0).toFixed(1)}/d`],
                ["COD return", drawerProduct.codReturnRate > 0 ? `${(drawerProduct.codReturnRate * 100).toFixed(0)}%` : "—"],
                ["Margin", drawerProduct.avgMargin > 0 ? `${(drawerProduct.avgMargin * 100).toFixed(0)}%` : "—"],
              ].map(([label, value]) => (
                <div key={label} style={{ background: "var(--inv-subtle)", borderRadius: "11px", padding: "12px 14px" }}>
                  <div style={{ fontSize: "11px", color: "var(--inv-muted)", marginBottom: "5px" }}>{label}</div>
                  <div style={{ fontFamily: "var(--inv-font-mono)", fontSize: "16px", fontWeight: 600 }}>{value}</div>
                </div>
              ))}
            </div>
            <div style={{ marginBottom: "18px" }}>
              <div style={{ fontSize: "11px", color: "var(--inv-muted)", marginBottom: "8px" }}>
                Fulfilment pipeline{" "}
                <span style={{ color: "var(--inv-muted)" }}>· live snapshot</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                {(courierifyConnected
                  ? [
                      ["Delivered", drawerProduct.fulfilledDelivered, "Courierify"],
                      ["In-transit", drawerProduct.fulfilledInTransit, "Courierify"],
                      ["Returned", drawerProduct.fulfilledReturned, "Courierify"],
                      ["Damaged", drawerProduct.damaged, "Adjustments"],
                    ]
                  : [["Damaged", drawerProduct.damaged, "Adjustments"]]
                ).map(([label, value, source]) => (
                  <div key={label as string} style={{ background: "var(--inv-subtle)", borderRadius: "11px", padding: "12px 14px" }}>
                    <div style={{ fontSize: "11px", color: "var(--inv-muted)", marginBottom: "5px" }}>{label}</div>
                    <div style={{ fontFamily: "var(--inv-font-mono)", fontSize: "16px", fontWeight: 600 }}>{value}</div>
                    <div style={{ fontSize: "10px", color: "var(--inv-muted)", marginTop: "3px" }}>{source}</div>
                  </div>
                ))}
              </div>
              {!courierifyConnected && (
                <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginTop: "8px" }}>
                  Connect Courierify in{" "}
                  <Link to="/app/settings" style={{ color: "var(--inv-accent)" }}>Settings</Link>{" "}
                  to see Delivered · In-transit · Returned counts.
                </div>
              )}
              {courierifyConnected && drawerProduct.damaged > 0 && (
                <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginTop: "8px" }}>
                  Damaged is tallied from{" "}
                  <Link to={`/app/stock-adjustments?product=${drawerProduct.id}`} style={{ color: "var(--inv-accent)" }}>
                    damage stock adjustments
                  </Link>.
                </div>
              )}
            </div>
            {locations.length > 1 && drawerProduct.locationBreakdown.length > 0 && (
              <div style={{ marginBottom: "18px" }}>
                <div style={{ fontSize: "11px", color: "var(--inv-muted)", marginBottom: "8px" }}>Stock by location</div>
                <div style={{ border: "1px solid var(--inv-divider)", borderRadius: "11px", overflow: "hidden" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1.6fr .8fr .8fr .8fr", gap: "0", fontSize: "11px", color: "var(--inv-muted)", padding: "8px 12px", background: "var(--inv-subtle)", borderBottom: "1px solid var(--inv-divider)" }}>
                    <span>Location</span>
                    <span style={{ textAlign: "right" }}>On hand</span>
                    <span style={{ textAlign: "right" }}>Reserved</span>
                    <span style={{ textAlign: "right" }}>Available</span>
                  </div>
                  {drawerProduct.locationBreakdown.map((l) => (
                    <div key={l.locationId} style={{ display: "grid", gridTemplateColumns: "1.6fr .8fr .8fr .8fr", gap: "0", fontSize: "12.5px", padding: "8px 12px", borderBottom: "1px solid var(--inv-divider)" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</span>
                      <span style={{ textAlign: "right", fontFamily: "var(--inv-font-mono)" }}>{l.onHand}</span>
                      <span style={{ textAlign: "right", fontFamily: "var(--inv-font-mono)", color: "var(--inv-muted)" }}>{l.reserved}</span>
                      <span style={{ textAlign: "right", fontFamily: "var(--inv-font-mono)", fontWeight: 600 }}>{l.available}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ marginBottom: "18px" }}>
              <label style={{ fontSize: "11px", color: "var(--inv-muted)", display: "block", marginBottom: "6px" }}>Supplier</label>
              <div style={{ display: "flex", gap: "8px" }}>
                <SelectInput
                  value={supplierDraft}
                  onChange={(e) => setSupplierDraft(e.target.value)}
                  style={{ height: "36px" }}
                >
                  <option value="">— No supplier —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </SelectInput>
                {supplierDraft !== (drawerProduct.supplierId ?? "") && (
                  <button
                    onClick={() =>
                      fetcher.submit(
                        { intent: "update_supplier", productId: drawerProduct.id, supplierId: supplierDraft },
                        { method: "POST" },
                      )
                    }
                    style={{ flex: "none", border: "none", background: "var(--inv-ink)", color: "#fff", fontSize: "12.5px", fontWeight: 500, padding: "0 14px", borderRadius: "9px", cursor: "pointer" }}
                  >
                    Save
                  </button>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: "9px", marginTop: "20px" }}>
              <Link to={`/app/purchase-orders/new?product=${drawerProduct.id}`}>
                <button
                  style={{
                    background: "var(--inv-ink)",
                    color: "#fff",
                    border: "none",
                    fontSize: "13px",
                    fontWeight: 500,
                    padding: "9px 15px",
                    borderRadius: "10px",
                    cursor: "pointer",
                  }}
                >
                  Create PO
                </button>
              </Link>
              <Link to={`/app/forecast?product=${drawerProduct.id}`}>
                <button
                  style={{
                    background: "#fff",
                    border: "1px solid var(--inv-input-border-2)",
                    color: "var(--inv-ink)",
                    fontSize: "13px",
                    fontWeight: 500,
                    padding: "9px 15px",
                    borderRadius: "10px",
                    cursor: "pointer",
                  }}
                >
                  Open forecast
                </button>
              </Link>
            </div>
          </div>
        )}
      </Drawer>

      {toast && <Toast message={toast} onDismiss={() => setToast("")} />}
    </div>
  );
}
