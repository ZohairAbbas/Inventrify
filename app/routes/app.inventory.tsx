import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams, Link } from "@remix-run/react";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getStockStatus,
  calculateDaysRemaining,
  calculateReorderPoint,
} from "../lib/forecast.server";
import {
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
    include: { supplier: { select: { name: true } } },
    orderBy: { title: "asc" },
  });

  const enriched = products
    .map((p) => ({
      ...p,
      status: getStockStatus(p.currentStock, p.reorderPoint),
      daysRemaining: calculateDaysRemaining(p.currentStock, p.avgDailySales || 0.5),
      displayName: p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title,
    }))
    .filter((p) => statusFilter === "all" || p.status === statusFilter);

  const suppliers = await prisma.supplier.findMany({
    where: { shop: session.shop },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  return { products: enriched, statusFilter, search, suppliers };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

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

export default function Inventory() {
  const { products, statusFilter, search, suppliers } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [, setSearchParams] = useSearchParams();
  const [queryValue, setQueryValue] = useState(search);
  const [selected, setSelected] = useState<string[]>([]);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [supplierDraft, setSupplierDraft] = useState("");

  useEffect(() => {
    if (fetcher.data && (fetcher.data as { ok?: boolean }).ok) {
      shopify.toast.show("Updated");
    }
  }, [fetcher.data, shopify]);

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
    { header: "Status", width: "1fr", align: "right" },
  ];

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
          color: p.currentStock <= 0 ? "var(--inv-status-stockout-fg)" : "var(--inv-ink)",
        }}
      >
        {p.currentStock}
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
      <StatusBadge key="status" status={p.status as StockStatus} />,
    ],
  }));

  return (
    <div className="inv-root" style={{ minHeight: "100vh" }}>
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
            ) : undefined
          }
        />

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
