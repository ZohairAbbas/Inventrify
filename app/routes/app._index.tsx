import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useRouteLoaderData, useSearchParams } from "@remix-run/react";
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
import { getFulfilmentBreakdown, getRtoFreshness } from "../lib/rto-attribution.server";
import { previousRange, resolveDateRange } from "../lib/date-range";
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
  DateRangePicker,
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
  const range = resolveDateRange(new URL(request.url).searchParams);

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
    // Windowed to match the fulfilment stages this is displayed beside. An all-time
    // damage tally under a "last N days" heading is the same mistake as the delivery
    // pipeline showing 90-day figures next to a 30-day breakdown.
    prisma.stockAdjustment.groupBy({
      by: ["productId"],
      where: {
        shop,
        reason: "damage",
        createdAt: { gte: range.from, lt: range.to },
      },
      _sum: { delta: true },
    }),
    prisma.returnItem.groupBy({
      by: ["productId"],
      where: {
        shop,
        status: "written_off",
        productId: { not: null },
        resolvedAt: { gte: range.from, lt: range.to },
      },
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
      inTransit: pos?.inTransit ?? 0,
      inTransitReturning: pos?.inTransitReturning ?? 0,
      status: getStockStatus(position, p.reorderPoint),
      // No demand means no runway — not a fabricated 0.5 units/day.
      daysRemaining: calculateDaysRemaining(position, p.avgDailySales),
      isBackordered: p.currentStock < 0,
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
        inTransitReturning: p.inTransitReturning,
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

  // Negative stock is an oversell/backorder, not negative-value inventory. Multiplying
  // it by cost subtracted real money from the total — on one live shop the inventory
  // value read Rs 194,475 less than the stock actually on the shelves.
  const stockValue = products.reduce(
    (sum, p) => sum + Math.max(0, p.currentStock) * p.unitCost,
    0,
  );

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

  const rtoFreshness = await getRtoFreshness(shop);
  const fulfilment = await getFulfilmentBreakdown(shop, range);

  // Genuinely windowed figures. Everything else on this page is current state — stock,
  // alerts, reorder suggestions — which is why the range only drives these.
  const prior = previousRange(range);
  const [periodSold, periodPrior] = await Promise.all([
    prisma.salesRecord.aggregate({
      where: { shop, date: { gte: range.from, lt: range.to } },
      _sum: { quantity: true },
    }),
    prisma.salesRecord.aggregate({
      where: { shop, date: { gte: prior.from, lt: prior.to } },
      _sum: { quantity: true },
    }),
  ]);
  const soldUnits = periodSold._sum.quantity ?? 0;
  const priorUnits = periodPrior._sum.quantity ?? 0;

  return {
    fulfilment,
    range,
    period: {
      soldUnits,
      priorUnits,
      // Null rather than 0% when there is no prior window to compare against — at 90
      // days there is none, because only 90 days are retained.
      changePct: priorUnits > 0 ? ((soldUnits - priorUnits) / priorUnits) * 100 : null,
    },
    currency: settings?.currency ?? "USD",
    rtoFreshness,
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
  const [searchParams, setSearchParams] = useSearchParams();

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

        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: "12px", flexWrap: "wrap", marginBottom: "4px",
          }}
        >
          <div style={{ fontSize: "12px", color: "var(--inv-muted)" }}>
            Sales figures below cover the selected window. Stock, alerts and reorder
            suggestions are always current.
          </div>
          <DateRangePicker
            value={data.range}
            onPreset={(days) => {
              const next = new URLSearchParams(searchParams);
              next.set("range", days);
              next.delete("from");
              next.delete("to");
              setSearchParams(next, { preventScrollReset: true });
            }}
            onCustom={(from, to) => {
              const next = new URLSearchParams(searchParams);
              next.set("from", from);
              next.set("to", to);
              next.delete("range");
              setSearchParams(next, { preventScrollReset: true });
            }}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "12px", marginBottom: "16px" }}>
          <KpiCard
            label={`Units sold — ${data.range.label}`}
            value={data.period.soldUnits.toLocaleString()}
            sub={
              data.period.changePct != null
                ? `${data.period.changePct >= 0 ? "+" : ""}${data.period.changePct.toFixed(1)}% vs prior ${data.range.days}d`
                : "no prior period to compare"
            }
            valueColor={
              data.period.changePct == null
                ? undefined
                : data.period.changePct >= 0
                  ? "var(--inv-status-healthy-fg)"
                  : "var(--inv-status-critical-fg)"
            }
          />
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
            sub={`Order now · ${data.pendingPOs} PO${data.pendingPOs !== 1 ? "s" : ""} open`}
            accentBar="var(--inv-status-critical-dot)"
          />
        </div>

        {data.rtoFreshness.warning && (
          <Card padding="12px 14px" style={{ marginBottom: "14px", borderColor: "var(--inv-status-low-dot)" }}>
            <div style={{ fontSize: "12.5px", color: "var(--inv-text-2)", lineHeight: 1.5 }}>
              {data.rtoFreshness.warning}
            </div>
          </Card>
        )}

        {data.fulfilment.stages.some((s) => s.units > 0) && (
          <Card padding="18px 20px" style={{ marginBottom: "16px" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "14px", flexWrap: "wrap", marginBottom: "4px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <div style={{ fontSize: "15px", fontWeight: 600 }}>Units by fulfilment stage</div>
                <button
                  onClick={() => navigate("/app/returns")}
                  style={{ border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-ink)", fontSize: "12px", fontWeight: 500, padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}
                >
                  Review returns →
                </button>
              </div>
              <div style={{ fontSize: "11.5px", color: "var(--inv-muted)" }}>
                {data.fulfilment.source === "courierify" ? "Courierify" : "Shopify carrier tracking"}
                {" · "}{data.range.label}
              </div>
            </div>
            <div style={{ fontSize: "12px", color: "var(--inv-muted)", marginBottom: "14px", lineHeight: 1.5 }}>
              <strong style={{ color: "var(--inv-text-2)" }}>{data.fulfilment.inRouteUnits.toLocaleString()}</strong> units
              in route — dispatched and not yet resolved. These have already left stock, and a share will be
              refused and come back.
              {data.fulfilment.rtoRate != null && (
                <> Of {data.fulfilment.resolvedUnits.toLocaleString()} resolved,{" "}
                <strong style={{ color: data.fulfilment.rtoRate >= 0.3 ? "var(--inv-status-stockout-fg)" : "var(--inv-text-2)" }}>
                  {(data.fulfilment.rtoRate * 100).toFixed(1)}%
                </strong>{" "}were not delivered.</>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: "10px" }}>
              {[
                ...data.fulfilment.stages,
                // Damage is Inventorify's own tally from stock adjustments and written-off
                // returns, not a carrier status — but it belongs in the same picture of
                // where units ended up.
                { stage: "damaged" as const, label: "Damaged", units: data.pipeline.damaged },
              ].map((st) => {
                const terminal =
                  st.stage === "delivered" || st.stage === "not_delivered" || st.stage === "damaged";
                const bad = st.stage === "not_delivered" || st.stage === "damaged";
                return (
                  <div
                    key={st.stage}
                    style={{
                      padding: "12px 13px",
                      borderRadius: "11px",
                      border: "1px solid var(--inv-divider)",
                      background: terminal ? (bad ? "#fdf5f3" : "#f4f9f6") : "var(--inv-subtle)",
                    }}
                  >
                    <div style={{ fontSize: "11.5px", color: "var(--inv-text-2)", marginBottom: "6px" }}>{st.label}</div>
                    <div style={{ fontFamily: "var(--inv-font-mono)", fontSize: "19px", fontWeight: 600, color: bad ? "var(--inv-status-stockout-fg)" : terminal ? "var(--inv-status-healthy-fg)" : "var(--inv-ink)" }}>
                      {st.units.toLocaleString()}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
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


