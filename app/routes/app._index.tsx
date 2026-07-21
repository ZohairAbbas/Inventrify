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

  // ---------- Courierify delivery pipeline (aggregate) ----------
  // Delivered/In-transit/Returned are the live per-variant snapshot Courierify syncs onto
  // Product.fulfilled*. Damaged mirrors the inventory page's tally: damage stock-adjustments
  // plus returned units written off from the queue (§7.8 of the integration contract).
  const [settings, damageTally, writeOffTally] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { shop }, select: { courierifyApiKey: true } }),
    prisma.stockAdjustment.groupBy({
      by: ["productId"],
      where: { shop, reason: "damage" },
      _sum: { delta: true },
    }),
    prisma.returnItem.groupBy({
      by: ["productId"],
      where: { shop, status: "written_off", productId: { not: null } },
      _sum: { quantity: true },
    }),
  ]);

  const courierifyConnected = !!settings?.courierifyApiKey;
  const pipeDelivered = products.reduce((sum, p) => sum + (p.fulfilledDelivered || 0), 0);
  const pipeInTransit = products.reduce((sum, p) => sum + (p.fulfilledInTransit || 0), 0);
  const pipeReturned = products.reduce((sum, p) => sum + (p.fulfilledReturned || 0), 0);
  let pipeDamaged = 0;
  for (const d of damageTally) pipeDamaged += Math.abs(d._sum.delta ?? 0);
  for (const w of writeOffTally) pipeDamaged += w._sum.quantity ?? 0;

  // Return rate over resolved shipments (delivered + returned); damage rate over all handled.
  const retDenom = pipeDelivered + pipeReturned;
  const returnRate = retDenom > 0 ? (pipeReturned / retDenom) * 100 : 0;
  const dmgDenom = pipeDelivered + pipeReturned + pipeDamaged;
  const damageRate = dmgDenom > 0 ? (pipeDamaged / dmgDenom) * 100 : 0;

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
    courierifyConnected,
    pipeline: {
      delivered: pipeDelivered,
      inTransit: pipeInTransit,
      returned: pipeReturned,
      damaged: pipeDamaged,
      returnRate,
      damageRate,
    },
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

        {data.courierifyConnected && (
          <DeliveryPipeline pipeline={data.pipeline} onReviewReturns={() => navigate("/app/returns")} />
        )}

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

type PipelineData = {
  delivered: number;
  inTransit: number;
  returned: number;
  damaged: number;
  returnRate: number;
  damageRate: number;
};

function DeliveryPipeline({
  pipeline,
  onReviewReturns,
}: {
  pipeline: PipelineData;
  onReviewReturns: () => void;
}) {
  const { delivered, inTransit, returned, damaged, returnRate, damageRate } = pipeline;
  const total = delivered + inTransit + returned + damaged || 1;
  const pct = (n: number) => (n <= 0 ? "0%" : `${Math.max(3, Math.round((n / total) * 100))}%`);

  const tile = (
    label: string,
    value: number,
    sub: string,
    color: string,
    onClick?: () => void,
  ) => {
    const Tag = onClick ? "button" : "div";
    return (
      <Tag
        onClick={onClick}
        style={{
          textAlign: "left",
          border: `1px solid ${color}`,
          background: "var(--inv-subtle)",
          borderRadius: "13px",
          padding: "14px 15px",
          cursor: onClick ? "pointer" : "default",
          font: "inherit",
        }}
      >
        <div style={{ fontSize: "11.5px", color, fontWeight: 600, marginBottom: "9px", display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: color, display: "inline-block" }} />
          {label}
        </div>
        <div style={{ fontFamily: "var(--inv-font-mono)", fontSize: "22px", fontWeight: 600, letterSpacing: "-.5px", color }}>
          {value}
        </div>
        <div style={{ fontSize: "11.5px", color: "var(--inv-text-2)", marginTop: "5px" }}>{sub}</div>
      </Tag>
    );
  };

  const legend = (color: string, label: string) => (
    <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
      <span style={{ width: "9px", height: "9px", borderRadius: "3px", background: color }} />
      {label}
    </span>
  );

  const DELIVERED = "var(--inv-status-healthy-fg)";
  const TRANSIT = "var(--inv-status-low-fg)";
  const RETURNED = "var(--inv-status-critical-fg)";
  const DAMAGED = "var(--inv-status-stockout-fg)";

  return (
    <Card padding="18px 20px" style={{ marginBottom: "16px" }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "16px", marginBottom: "15px", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: "15px", fontWeight: 600, display: "flex", alignItems: "center", gap: "9px" }}>
            Delivery pipeline
            <span style={{ fontSize: "10px", fontWeight: 600, letterSpacing: ".3px", color: DELIVERED, background: "var(--inv-status-healthy-bg)", padding: "3px 9px", borderRadius: "20px", display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: DELIVERED, display: "inline-block" }} />
              Courierify live
            </span>
          </div>
          <div style={{ fontSize: "12px", color: "var(--inv-muted)", marginTop: "3px" }}>
            Live fulfilment snapshot · delivered, in-transit, returned &amp; damaged across tracked SKUs
          </div>
        </div>
        <button
          onClick={onReviewReturns}
          style={{ border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-ink)", fontSize: "12.5px", fontWeight: 500, padding: "8px 13px", borderRadius: "9px", cursor: "pointer" }}
        >
          Review returns →
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "12px", marginBottom: "16px" }}>
        {tile("Delivered", delivered, "units reached customers", DELIVERED)}
        {tile("In-transit", inTransit, "units moving now", TRANSIT)}
        {tile("Returned", returned, `${returnRate.toFixed(1)}% return rate`, RETURNED, onReviewReturns)}
        {tile("Damaged", damaged, `${damageRate.toFixed(1)}% of handled`, DAMAGED, onReviewReturns)}
      </div>

      <div style={{ display: "flex", height: "9px", borderRadius: "6px", overflow: "hidden", background: "var(--inv-divider-3)" }}>
        <div style={{ width: pct(delivered), background: DELIVERED }} />
        <div style={{ width: pct(inTransit), background: TRANSIT }} />
        <div style={{ width: pct(returned), background: RETURNED }} />
        <div style={{ width: pct(damaged), background: DAMAGED }} />
      </div>
      <div style={{ display: "flex", gap: "18px", marginTop: "11px", fontSize: "11px", color: "var(--inv-muted)", flexWrap: "wrap" }}>
        {legend(DELIVERED, "Delivered")}
        {legend(TRANSIT, "In-transit")}
        {legend(RETURNED, "Returned")}
        {legend(DAMAGED, "Damaged")}
      </div>
    </Card>
  );
}
