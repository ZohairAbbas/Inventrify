import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useRouteLoaderData } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { formatCurrency } from "../lib/format";
import prisma from "../db.server";
import {
  getStockStatus,
  calculateDaysRemaining,
} from "../lib/forecast.server";
import {
  computeProcurementPlan,
  estimateRestockRate,
  getInventoryPositions,
  resolveReturnRate,
} from "../lib/planning.server";
import { syncShopifyInventory } from "../lib/shopify-sync.server";
import { syncOrderHistory } from "../lib/order-sync.server";
import {
  generateAlerts,
  getUnreadAlerts,
  markAlertRead,
  snoozeAlert,
} from "../lib/alerts.server";
import {
  Card,
  DataTable,
  ProductThumb,
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

  const products = await prisma.product.findMany({ where: { shop, isArchived: false } });
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
    prisma.shopSettings.findUnique({
      where: { shop },
      select: {
        courierifyApiKey: true,
        coverageDays: true,
        currency: true,
        deadStockDays: true,
        deadStockMinUnits: true,
      },
    }),
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

  // Replenishment decisions are made against inventory position, not on-hand: stock
  // already on an open PO, or coming back through RTO, is supply that has been paid
  // for. Judging on currentStock alone re-flags SKUs that were ordered yesterday.
  const positions = await getInventoryPositions(shop, products.map((p) => p.id));
  const shopRestockRate = await estimateRestockRate(shop);
  const coverageDays = settings?.coverageDays ?? 30;

  const stockStatuses = products.map((p) => {
    const pos = positions.get(p.id);
    const position = pos?.position ?? p.currentStock;
    return {
      ...p,
      inventoryPosition: position,
      onOrder: pos?.onOrder ?? 0,
      rtoInbound: pos?.rtoInbound ?? 0,
      status: getStockStatus(position, p.reorderPoint),
      // No demand means no runway — not a fabricated 0.5 units/day.
      daysRemaining: calculateDaysRemaining(position, p.avgDailySales),
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
      onOrder: p.onOrder,
      suggestedQty: computeProcurementPlan({
        shipUnits: p.avgDailySales * coverageDays,
        returnRate: resolveReturnRate(p).rate,
        restockRate: shopRestockRate,
        position: p.inventoryPosition,
        safetyStock: p.safetyStock,
        moq: p.moq,
        casePackSize: p.casePackSize,
      }).orderQty,
      status: p.status,
    }))
    // SKUs with no demand have no runway; sort them last rather than treating
    // "no data" as "zero days left".
    .sort((a, b) => (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity))
    .slice(0, 5);

  // ---------- Capital tied up ----------
  //
  // COD ties up cash in two places at once: stock sitting in the warehouse, and stock
  // already shipped but not yet collected/remitted. Neither was visible anywhere, and
  // both are the actual constraint on how much can be reordered.
  //
  // Everything here is derived from unitCost, which many shops will not have populated,
  // so coverage is reported alongside the totals — a value computed over 20% of the
  // catalogue must not be presented as the inventory value.
  const withCost = products.filter((p) => p.unitCost > 0);
  const costCoverage = products.length > 0 ? withCost.length / products.length : 0;

  const stockValue = products.reduce((sum, p) => sum + p.currentStock * p.unitCost, 0);

  const deadStockSince = new Date(Date.now() - (settings?.deadStockDays ?? 60) * 86400000);
  const soldRecently = await prisma.salesRecord.groupBy({
    by: ["productId"],
    where: { shop, date: { gte: deadStockSince } },
    _sum: { quantity: true },
    having: { quantity: { _sum: { gt: 0 } } },
  });
  const movedIds = new Set(soldRecently.map((r) => r.productId));
  const deadStockValue = products
    .filter((p) => !movedIds.has(p.id) && p.currentStock >= (settings?.deadStockMinUnits ?? 20))
    .reduce((sum, p) => sum + p.currentStock * p.unitCost, 0);

  // Cash sitting with the courier: units dispatched and not yet delivered, valued at
  // estimated sale price rather than cost, since that is what is owed back.
  const codFloat = products.reduce((sum, p) => {
    const price =
      p.unitCost > 0 && p.avgMargin > 0 && p.avgMargin < 0.95
        ? p.unitCost / (1 - p.avgMargin)
        : p.unitCost;
    return sum + p.fulfilledInTransit * price;
  }, 0);

  return {
    currency: settings?.currency ?? "USD",
    capital: {
      stockValue,
      deadStockValue,
      codFloat,
      costCoverage,
      pricedSkus: withCost.length,
    },
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
  const formData = await request.formData();
  const intent = (formData.get("intent") as string) || "sync";

  // Both alert actions are shop-scoped inside the lib; an alert id alone is never
  // enough to touch another tenant's row.
  if (intent === "dismiss_alert") {
    const id = formData.get("alertId") as string;
    if (id) await markAlertRead(id, shop);
    return { intent: "dismiss_alert" as const, ok: true };
  }

  if (intent === "snooze_alert") {
    const id = formData.get("alertId") as string;
    const days = parseInt((formData.get("days") as string) ?? "7", 10);
    if (id) {
      await snoozeAlert(
        id,
        shop,
        new Date(Date.now() + (isNaN(days) ? 7 : days) * 86400000),
      );
    }
    return { intent: "snooze_alert" as const, ok: true };
  }

  const { synced, errors, archived, completed, error: syncError } =
    await syncShopifyInventory(admin, shop);
  const { recordsSynced } = await syncOrderHistory(admin, shop);
  await generateAlerts(shop);
  return {
    intent: "sync" as const,
    synced,
    errors,
    archived,
    completed,
    syncError,
    recordsSynced,
  };
};

/** Small ghost button used by the alert row actions. */
const alertActionStyle: React.CSSProperties = {
  fontSize: "11px",
  padding: "3px 8px",
  borderRadius: "7px",
  border: "1px solid var(--inv-input-border-2)",
  background: "transparent",
  color: "var(--inv-text-2)",
  cursor: "pointer",
  whiteSpace: "nowrap",
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
      // Alert actions revalidate on their own; only the sync run reports counts.
      if (d.intent !== "sync") return;
      // Report an aborted catalogue walk as a failure. Showing only the counts made a
      // partial sync look identical to a complete one.
      const msg = d.completed
        ? `Synced ${d.synced} variants · ${d.recordsSynced} sales records` +
          `${d.archived ? ` · ${d.archived} archived` : ""}` +
          `${d.errors ? ` · ${d.errors} errors` : ""}`
        : `Sync incomplete — ${d.syncError ?? "Shopify request failed"}. ` +
          `${d.synced} variants updated; nothing was archived.`;
      shopify.toast.show(msg, d.completed ? undefined : { isError: true });
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
      <div key="name" style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
        <ProductThumb src={p.imageUrl} name={p.displayName} />
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {p.displayName}
        </span>
      </div>,
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
        {p.daysRemaining === null ? "No demand" : `${p.daysRemaining}d`}
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
          <>
            <DeliveryPipeline
              pipeline={data.pipeline}
              onReviewReturns={() => navigate("/app/returns")}
            />
            {data.pipeline.delivered === 0 &&
              data.pipeline.inTransit === 0 &&
              data.pipeline.returned === 0 && (
                /* An all-zero pipeline on a connected shop means the courier has no
                   shipments for this store — not that nothing has been returned. The two
                   are otherwise indistinguishable and read as a broken integration. */
                <div
                  style={{ fontSize: "12px", color: "var(--inv-muted)", margin: "-6px 0 16px" }}
                >
                  Courierify is connected but reports no shipments for this store yet, so
                  delivery and RTO figures are empty. They will populate once shipments are
                  booked through it.
                </div>
              )}
          </>
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
                  sub={`${item.sku ?? "—"} · ${item.currentStock <= 0 ? "out of stock" : `${item.currentStock} left`} · ${item.daysRemaining === null ? "no demand" : `${item.daysRemaining}d left`}`}
                  suggestedQty={item.suggestedQty}
                  status={item.status as StockStatus}
                  createPoHref={`/app/purchase-orders/new?product=${item.productId}&qty=${item.suggestedQty}`}
                  isFirst={i === 0}
                />
              ))
            )}
          </div>

          <Card padding="17px 18px" style={{ marginBottom: "14px" }}>
            <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "4px" }}>Capital tied up</div>
            <div style={{ fontSize: "12px", color: "var(--inv-muted)", marginBottom: "14px" }}>
              Cash locked in stock and with the courier
            </div>
            {data.capital.costCoverage === 0 ? (
              <div style={{ fontSize: "12.5px", color: "var(--inv-muted)" }}>
                Add unit costs (or connect Financify) to see inventory value.
              </div>
            ) : (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: "9px" }}>
                  {[
                    ["Stock at cost", data.capital.stockValue],
                    ["Dead stock", data.capital.deadStockValue],
                    ["With courier (COD float)", data.capital.codFloat],
                  ].map(([label, value]) => (
                    <div
                      key={label as string}
                      style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "12px" }}
                    >
                      <span style={{ fontSize: "12.5px", color: "var(--inv-text-2)" }}>{label}</span>
                      <span style={{ fontFamily: "var(--inv-font-mono)", fontSize: "13px", fontWeight: 600 }}>
                        {formatCurrency(value as number, data.currency)}
                      </span>
                    </div>
                  ))}
                </div>
                {data.capital.costCoverage < 0.99 && (
                  <div style={{ fontSize: "11px", color: "var(--inv-muted)", marginTop: "10px", lineHeight: 1.5 }}>
                    Based on {data.capital.pricedSkus} of {data.totalSkus} SKUs that have a unit
                    cost ({Math.round(data.capital.costCoverage * 100)}%) — the real figures are higher.
                  </div>
                )}
              </>
            )}
          </Card>

          <Card padding="17px 18px">
            <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "4px" }}>Alerts</div>
            <div style={{ fontSize: "12px", color: "var(--inv-muted)", marginBottom: "14px" }}>
              Below reorder point or out of stock
            </div>
            {data.alerts.length === 0 ? (
              <div style={{ fontSize: "12.5px", color: "var(--inv-muted)" }}>No active alerts.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {data.alerts.slice(0, 6).map((a) => (
                  <div
                    key={a.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: "9px",
                      padding: "9px 10px",
                      borderRadius: "9px",
                      background: "var(--inv-subtle)",
                      border: "1px solid var(--inv-divider)",
                    }}
                  >
                    <span
                      title={a.severity}
                      style={{
                        marginTop: "5px",
                        width: "7px",
                        height: "7px",
                        flex: "0 0 7px",
                        borderRadius: "50%",
                        background:
                          a.severity === "critical"
                            ? "var(--inv-status-critical-dot)"
                            : a.severity === "warning"
                              ? "var(--inv-status-low-dot)"
                              : "var(--inv-divider-3)",
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "12.5px", color: "var(--inv-text-2)", lineHeight: 1.5 }}>
                        {a.message}
                      </div>
                      {a.revenueAtRisk > 0 && (
                        <div style={{ fontSize: "11px", color: "var(--inv-muted)", marginTop: "2px" }}>
                          ≈ {formatCurrency(a.revenueAtRisk, data.currency)} at risk
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
                      <button
                        title="Snooze for 7 days"
                        onClick={() =>
                          fetcher.submit(
                            { intent: "snooze_alert", alertId: a.id, days: "7" },
                            { method: "POST" },
                          )
                        }
                        style={alertActionStyle}
                      >
                        Snooze
                      </button>
                      <button
                        title="Dismiss this alert"
                        onClick={() =>
                          fetcher.submit(
                            { intent: "dismiss_alert", alertId: a.id },
                            { method: "POST" },
                          )
                        }
                        style={alertActionStyle}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))}
                {data.alerts.length > 6 && (
                  <div style={{ fontSize: "11.5px", color: "var(--inv-muted)" }}>
                    …and {data.alerts.length - 6} more
                  </div>
                )}
              </div>
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

  // Segment colors — indigo transit is distinct from the amber "low" status.
  const DELIVERED = "var(--inv-status-healthy-dot)";
  const TRANSIT = "var(--inv-transit-dot)";
  const RETURNED = "var(--inv-status-critical-fg)";
  const DAMAGED = "var(--inv-status-stockout-fg)";

  // A pipeline tile: tinted card, dotted label, big mono value, sub caption. Prototype order is
  // Stuck in-transit → Delivered → Returned → Damaged. Returned/Damaged open the returns queue.
  const tile = (opts: {
    label: string;
    value: React.ReactNode;
    sub: string;
    bg: string;
    border: string;
    fg: string;
    valueColor: string;
    onClick?: () => void;
  }) => {
    const Tag = opts.onClick ? "button" : "div";
    return (
      <Tag
        onClick={opts.onClick}
        style={{
          textAlign: "left",
          border: `1px solid ${opts.border}`,
          background: opts.bg,
          borderRadius: "13px",
          padding: "14px 15px",
          cursor: opts.onClick ? "pointer" : "default",
          font: "inherit",
        }}
      >
        <div style={{ fontSize: "11.5px", color: opts.fg, fontWeight: 600, marginBottom: "9px", display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: opts.fg, display: "inline-block" }} />
          {opts.label}
        </div>
        <div style={{ fontFamily: "var(--inv-font-mono)", fontSize: "22px", fontWeight: 600, letterSpacing: "-.5px", color: opts.valueColor }}>
          {opts.value}
        </div>
        <div style={{ fontSize: "11.5px", color: "var(--inv-text-2)", marginTop: "5px" }}>{opts.sub}</div>
      </Tag>
    );
  };

  const legend = (color: string, label: string) => (
    <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
      <span style={{ width: "9px", height: "9px", borderRadius: "3px", background: color }} />
      {label}
    </span>
  );

  return (
    <Card padding="18px 20px" style={{ marginBottom: "16px" }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "16px", marginBottom: "15px", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: "15px", fontWeight: 600, display: "flex", alignItems: "center", gap: "9px" }}>
            Delivery pipeline
            <span style={{ fontSize: "10px", fontWeight: 600, letterSpacing: ".3px", color: "var(--inv-status-healthy-fg)", background: "var(--inv-status-healthy-bg)", padding: "3px 9px", borderRadius: "20px", display: "inline-flex", alignItems: "center", gap: "5px" }}>
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "var(--inv-status-healthy-dot)", display: "inline-block" }} />
              Courierify live
            </span>
          </div>
          <div style={{ fontSize: "12px", color: "var(--inv-muted)", marginTop: "3px" }}>
            Live fulfilment snapshot · in-transit, delivered, returned &amp; damaged across tracked SKUs
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
        {tile({
          label: "Stuck in-transit",
          value: inTransit,
          sub: "units moving now",
          bg: "var(--inv-transit-bg)",
          border: "var(--inv-transit-border)",
          fg: "var(--inv-transit-fg)",
          valueColor: "var(--inv-transit-value)",
        })}
        {tile({
          label: "Delivered",
          value: delivered,
          sub: "units reached customers",
          bg: "#f4f9f6",
          border: "#dcece4",
          fg: "var(--inv-status-healthy-dot)",
          valueColor: "var(--inv-status-healthy-fg)",
        })}
        {tile({
          label: "Returned",
          value: returned,
          sub: `${returnRate.toFixed(1)}% return rate`,
          bg: "#fbf6ee",
          border: "#f0e2d0",
          fg: "var(--inv-status-critical-fg)",
          valueColor: "#a5470f",
          onClick: onReviewReturns,
        })}
        {tile({
          label: "Damaged",
          value: damaged,
          sub: `${damageRate.toFixed(1)}% of handled`,
          bg: "#fdf5f3",
          border: "#f2d9d5",
          fg: "var(--inv-status-stockout-fg)",
          valueColor: "var(--inv-status-stockout-fg)",
          onClick: onReviewReturns,
        })}
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
