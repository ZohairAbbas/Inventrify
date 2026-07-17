import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useRouteLoaderData } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getStockStatus,
  calculateDaysRemaining,
  calculateReorderPoint,
} from "../lib/forecast.server";
import { syncShopifyInventory } from "../lib/shopify-sync.server";
import { syncOrderHistory } from "../lib/order-sync.server";
import { generateAlerts, getUnreadAlerts } from "../lib/alerts.server";
import {
  Card,
  DataTable,
  HeroBand,
  KpiCard,
  PageHead,
  ReorderRow,
  StatusBadge,
  Toast,
  type StockStatus,
} from "../design";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const products = await prisma.product.findMany({ where: { shop } });
  const alerts = await getUnreadAlerts(shop);
  const pendingPOs = await prisma.purchaseOrder.count({
    where: { shop, status: { in: ["draft", "sent"] } },
  });
  const locationCount = await prisma.location.count({ where: { shop, isActive: true } });

  const stockStatuses = products.map((p) => {
    const avgDailySales = p.avgDailySales || 0.5;
    return {
      ...p,
      status: getStockStatus(p.currentStock, p.reorderPoint),
      daysRemaining: calculateDaysRemaining(p.currentStock, avgDailySales),
      displayName: p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title,
    };
  });

  const lowStock = stockStatuses.filter((p) => p.status === "low").length;
  const critical = stockStatuses.filter(
    (p) => p.status === "critical" || p.status === "stockout",
  ).length;

  const reorderItems = stockStatuses
    .filter((p) => p.status !== "healthy")
    .map((p) => ({
      productId: p.id,
      title: p.displayName,
      sku: p.sku,
      currentStock: p.currentStock,
      reorderPoint: p.reorderPoint,
      daysRemaining: p.daysRemaining,
      suggestedQty: Math.max(
        10,
        calculateReorderPoint(p.avgDailySales || 1, p.leadTimeDays) * 2 - p.currentStock,
      ),
      status: p.status,
    }))
    .sort((a, b) => a.daysRemaining - b.daysRemaining)
    .slice(0, 5);

  return {
    totalSkus: products.length,
    lowStock,
    critical,
    pendingPOs,
    locationCount,
    stockStatuses,
    alerts,
    reorderItems,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const { synced, errors } = await syncShopifyInventory(admin, shop);
  const { recordsSynced } = await syncOrderHistory(admin, shop);
  await generateAlerts(shop);
  return { synced, errors, recordsSynced };
};

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const { theme = "emerald" } = useRouteLoaderData<typeof appLoader>("routes/app") ?? {};
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const isSyncing = fetcher.state !== "idle";
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (fetcher.data) {
      const d = fetcher.data;
      const msg = `Synced ${d.synced} variants · ${d.recordsSynced} sales records${d.errors ? ` · ${d.errors} errors` : ""}`;
      shopify.toast.show(msg);
      setToast(msg);
    }
  }, [fetcher.data, shopify]);

  const columns = [
    { header: "Product / Variant", width: "2.4fr" as const },
    { header: "SKU", width: "1fr" as const },
    { header: "Stock", width: ".7fr" as const, align: "right" as const },
    { header: "Days left", width: ".9fr" as const, align: "right" as const },
    { header: "Status", width: "1fr" as const, align: "right" as const },
  ];

  const rows = data.stockStatuses.map((p) => ({
    key: p.id,
    cells: [
      p.displayName,
      <span key="sku" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12px", color: "var(--inv-text-2)" }}>
        {p.sku ?? "—"}
      </span>,
      <span
        key="stock"
        style={{ fontFamily: "var(--inv-font-mono)", fontWeight: 600, color: p.currentStock <= 0 ? "var(--inv-status-stockout-fg)" : "var(--inv-ink)" }}
      >
        {p.currentStock}
      </span>,
      <span key="days" style={{ fontFamily: "var(--inv-font-mono)", color: "var(--inv-text-2)" }}>
        {p.daysRemaining > 900 ? "N/A" : `${p.daysRemaining}d`}
      </span>,
      <StatusBadge key="status" status={p.status as StockStatus} />,
    ],
  }));

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Inventorify" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead
          eyebrow="Command center"
          title="Good morning"
          right={
            <button
              onClick={() => fetcher.submit({}, { method: "POST" })}
              disabled={isSyncing}
              style={{
                border: "1px solid var(--inv-input-border-2)",
                background: "#fff",
                color: "var(--inv-ink)",
                fontSize: "13px",
                fontWeight: 500,
                padding: "9px 15px",
                borderRadius: "10px",
                cursor: isSyncing ? "default" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                opacity: isSyncing ? 0.6 : 1,
              }}
            >
              ↻ {isSyncing ? "Syncing…" : "Sync inventory"}
            </button>
          }
        />

        {data.critical > 0 && (
          <HeroBand
            alertLabel={`${data.alerts.length} active stock alert${data.alerts.length !== 1 ? "s" : ""}`}
            headline={
              <>
                <span style={{ color: "var(--inv-accent)" }}>{data.critical + data.lowStock} decisions</span> need
                you today
              </>
            }
            body={`${data.critical} SKUs are critical or out of stock${data.lowStock > 0 ? ` and ${data.lowStock} running low` : ""}. Your forecast-adjusted reorder queue is ready — most are one tap from a purchase order.`}
            primaryAction={{
              label: "Review reorder queue",
              onClick: () => document.getElementById("reorder-queue")?.scrollIntoView({ behavior: "smooth" }),
            }}
            secondaryAction={{
              label: "Open demand forecast",
              onClick: () => navigate("/app/forecast"),
            }}
          />
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "12px", marginBottom: "16px" }}>
          <KpiCard
            label="Total SKUs tracked"
            value={data.totalSkus}
            sub={`across ${data.locationCount} location${data.locationCount !== 1 ? "s" : ""}`}
          />
          <KpiCard
            label="Low stock"
            value={data.lowStock}
            valueColor="var(--inv-status-low-fg)"
            sub="needs attention soon"
          />
          <KpiCard
            label="Critical / stockout"
            value={data.critical}
            valueColor="var(--inv-status-critical-fg)"
            sub="Order now"
            accentBar="var(--inv-status-critical-dot)"
          />
          <KpiCard label="Pending POs" value={data.pendingPOs} sub="draft + sent" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: "14px", marginBottom: "16px" }}>
          <div
            id="reorder-queue"
            style={{ background: "#fff", border: "1px solid var(--inv-border)", borderRadius: "16px", overflow: "hidden" }}
          >
            <div
              style={{
                padding: "16px 18px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderBottom: "1px solid var(--inv-divider-3)",
              }}
            >
              <div>
                <div style={{ fontSize: "15px", fontWeight: 600 }}>Reorder queue</div>
                <div style={{ fontSize: "12px", color: "var(--inv-muted)", marginTop: "2px" }}>
                  Forecast-adjusted quantities · sorted by urgency
                </div>
              </div>
              <span
                style={{
                  fontFamily: "var(--inv-font-mono)",
                  fontSize: "11px",
                  color: "#8b877d",
                  background: "#f4f2ec",
                  padding: "4px 9px",
                  borderRadius: "7px",
                }}
              >
                {data.reorderItems.length} shown
              </span>
            </div>
            {data.reorderItems.length === 0 ? (
              <div style={{ padding: "24px 18px", fontSize: "13px", color: "var(--inv-muted)" }}>
                All your products are sufficiently stocked.
              </div>
            ) : (
              data.reorderItems.map((item, i) => (
                <ReorderRow
                  key={item.productId}
                  title={item.title}
                  sub={`${item.sku ?? "—"} · ${item.currentStock <= 0 ? "out of stock" : `${item.currentStock} left`} · ${item.daysRemaining > 900 ? "N/A" : `${item.daysRemaining}d`} left`}
                  suggestedQty={item.suggestedQty}
                  status={item.status as StockStatus}
                  createPoHref={`/app/purchase-orders/new?product=${item.productId}&qty=${item.suggestedQty}`}
                  isFirst={i === 0}
                />
              ))
            )}
          </div>

          <Card padding="17px 18px">
            <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "4px" }}>Alerts</div>
            <div style={{ fontSize: "12px", color: "var(--inv-muted)", marginBottom: "14px" }}>
              Below reorder point or out of stock
            </div>
            {data.alerts.length === 0 ? (
              <div style={{ fontSize: "12.5px", color: "var(--inv-muted)" }}>No active alerts.</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "12.5px", color: "var(--inv-text-2)", lineHeight: 1.7 }}>
                {data.alerts.slice(0, 5).map((a) => (
                  <li key={a.id}>{a.message}</li>
                ))}
                {data.alerts.length > 5 && <li>…and {data.alerts.length - 5} more</li>}
              </ul>
            )}
          </Card>
        </div>

        {data.stockStatuses.length === 0 ? (
          <Card padding="40px 24px">
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>No products synced yet</div>
              <div style={{ fontSize: "13px", color: "var(--inv-muted)", marginBottom: "16px" }}>
                Sync your Shopify inventory to get started.
              </div>
              <button
                onClick={() => fetcher.submit({}, { method: "POST" })}
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
                Sync Inventory
              </button>
            </div>
          </Card>
        ) : (
          <Card padding="0">
            <div style={{ padding: "16px 18px 12px", fontSize: "15px", fontWeight: 600 }}>Stock Status</div>
            <DataTable columns={columns} rows={rows} />
          </Card>
        )}
      </div>

      {toast && <Toast message={toast} onDismiss={() => setToast("")} />}
    </div>
  );
}
