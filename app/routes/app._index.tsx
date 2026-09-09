import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useRouteLoaderData, useSearchParams, Link } from "@remix-run/react";
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
import { getDamagedUnitsTotal } from "../lib/damage.server";
import { previousRange, resolveDateRange } from "../lib/date-range";
import { computeCodFloat, computeStockAtCost } from "../lib/capital.server";
import { getDashboardSparklines } from "../lib/sparklines.server";
import { greetingFor, displayShopName } from "../lib/greeting";
import { shopHour } from "../lib/tz.server";
import {
  countByStatus,
  isActionFilter,
  selectActionRows,
  type ActionFilter,
} from "../lib/needs-action";
import {
  computeProcurementPlan,
  estimateRestockRate,
  getInventoryPositions,
  resolveReturnRate,
} from "../lib/planning.server";
import { syncShopifyInventory } from "../lib/shopify-sync.server";
import { syncOrderHistory } from "../lib/order-sync.server";
import { generateAlerts, getUnreadAlerts } from "../lib/alerts.server";
import {
  ActionBar,
  Card,
  CostPrompt,
  KpiTile,
  NeedsActionTable,
  PageHead,
  PipelineCard,
  Segmented,
  Toast,
  type NeedsActionRow,
  type PipelineSegment,
  type StockStatus,
} from "../design";

/** Rows sent to the browser. The counts beside the chips describe the whole catalogue. */
const ROW_LIMIT = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const range = resolveDateRange(url.searchParams);
  const filterParam = url.searchParams.get("status");
  const filter: ActionFilter = isActionFilter(filterParam) ? filterParam : "all";

  // Narrowed to the columns the aggregates below actually read.
  const products = await prisma.product.findMany({
    where: { shop, isArchived: false },
    select: {
      id: true, title: true, variantTitle: true, sku: true,
      currentStock: true, reorderPoint: true, avgDailySales: true, safetyStock: true,
      unitCost: true, avgMargin: true, moq: true, casePackSize: true,
      fulfilledInTransit: true,
      courierRtoRate: true, derivedRtoRate: true, estimatedRtoRate: true,
    },
  });

  const [settings, pipeDamaged, alerts, locationCount] = await Promise.all([
    prisma.shopSettings.findUnique({
      where: { shop },
      select: {
        shopName: true,
        coverageDays: true,
        currency: true,
        timezone: true,
      },
    }),
    // Windowed to match the fulfilment stages this is displayed beside. An all-time damage
    // tally under a "last N days" heading is the same mistake as the delivery pipeline
    // showing 90-day figures next to a 30-day breakdown.
    getDamagedUnitsTotal(shop, { from: range.from, to: range.to }),
    getUnreadAlerts(shop),
    prisma.location.count({ where: { shop, isActive: true } }),
  ]);

  // Replenishment decisions are made against inventory position, not on-hand: stock
  // already on an open PO, or coming back through RTO, is supply that has been paid for.
  const positions = await getInventoryPositions(shop);
  const shopRestockRate = await estimateRestockRate(shop);
  const coverageDays = settings?.coverageDays ?? 30;

  const stockStatuses = products.map((p) => {
    const pos = positions.get(p.id);
    const position = pos?.position ?? p.currentStock;
    return {
      ...p,
      inventoryPosition: position,
      onOrder: pos?.onOrder ?? 0,
      inTransitReturning: pos?.inTransitReturning ?? 0,
      status: getStockStatus(position, p.reorderPoint),
      // No demand means no runway — not a fabricated 0.5 units/day.
      daysRemaining: calculateDaysRemaining(position, p.avgDailySales),
      displayName: p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title,
    };
  });


  // ---------- Needs-action queue ----------
  //
  // Counts describe the whole catalogue; only ROW_LIMIT rows cross the wire. Filtering
  // happens here rather than in the browser so the two cannot disagree — a chip reading
  // "Stockout 340" beside a list holding 25 of them is the bug this shape prevents.
  const actionCounts = countByStatus(stockStatuses);

  // revenueAtRisk is what the email/WhatsApp digest already reports for the same SKU. A
  // second, locally-computed definition would disagree with it and undermine both.
  const riskByProduct = new Map(
    alerts.filter((a) => a.revenueAtRisk > 0).map((a) => [a.productId, a.revenueAtRisk]),
  );

  const actionRows: NeedsActionRow[] = selectActionRows(stockStatuses, filter, ROW_LIMIT)
    .map((p) => {
      const risk = riskByProduct.get(p.id);
      const suggestedQty = computeProcurementPlan({
        shipUnits: p.avgDailySales * coverageDays,
        returnRate: resolveReturnRate(p).rate,
        restockRate: shopRestockRate,
        position: p.inventoryPosition,
        inTransitReturning: p.inTransitReturning,
        safetyStock: p.safetyStock,
        moq: p.moq,
        casePackSize: p.casePackSize,
      }).orderQty;
      return {
        productId: p.id,
        title: p.displayName,
        sku: p.sku,
        stock: p.currentStock,
        daysRemaining: p.daysRemaining,
        status: p.status as StockStatus,
        suggestedQty,
        riskLabel: risk ? formatCurrency(risk, settings?.currency ?? "USD") : null,
        createPoHref: `/app/purchase-orders/new?product=${p.id}&qty=${suggestedQty}`,
      };
    });

  // ---------- Capital tied up ----------
  //
  // Derived from unitCost, which many shops will not have populated, so coverage is
  // reported alongside the totals — a value computed over 20% of the catalogue must not
  // be presented as the inventory value.
  const withCost = products.filter((p) => p.unitCost > 0);
  const costCoverage = products.length > 0 ? withCost.length / products.length : 0;
  const stockValue = computeStockAtCost(products);
  const codFloat = computeCodFloat(products);

  const [rtoFreshness, fulfilment, priorFulfilment, sparklines] = await Promise.all([
    getRtoFreshness(shop),
    getFulfilmentBreakdown(shop, range),
    // Same length of window, immediately before this one — the basis for the return-rate
    // trend on the outcomes card.
    getFulfilmentBreakdown(shop, previousRange(range)),
    getDashboardSparklines(shop, range.days),
  ]);

  // Genuinely windowed figures. Everything else on this page is current state.
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

  const timezone = settings?.timezone ?? "UTC";

  return {
    range,
    filter,
    greeting: greetingFor(shopHour(new Date(), timezone)),
    shopName: displayShopName(settings?.shopName, shop),
    todayLabel: new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      month: "short",
      day: "numeric",
    }).format(new Date()),
    period: {
      soldUnits,
      priorUnits,
      // Null rather than 0% when there is no prior window to compare against — at 90 days
      // there is none, because only 90 days are retained.
      changePct: priorUnits > 0 ? ((soldUnits - priorUnits) / priorUnits) * 100 : null,
    },
    currency: settings?.currency ?? "USD",
    rtoFreshness,
    sparklines,
    capital: {
      stockValue,
      codFloat,
      costCoverage,
      pricedSkus: withCost.length,
    },
    totalSkus: products.length,
    lowStock: actionCounts.low,
    // The KPI card and the ActionBar both mean "critical or worse", which is the two
    // severities the merchant cannot defer. The chips keep them apart because filtering
    // to one or the other is a different question.
    critical: actionCounts.critical + actionCounts.stockout,
    locationCount,
    actionRows,
    actionCounts,
    fulfilment,
    // Only the rate is needed; sending the whole prior breakdown would double the payload
    // for one number.
    priorRtoRate: priorFulfilment.rtoRate,
    damagedUnits: pipeDamaged,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const { synced, errors, archived, completed, error: syncError } =
    await syncShopifyInventory(admin, shop);
  const { recordsSynced } = await syncOrderHistory(admin, shop);
  await generateAlerts(shop);
  return { synced, errors, archived, completed, syncError, recordsSynced };
};

const ghostButton: React.CSSProperties = {
  border: "1px solid var(--inv-input-border-2)",
  background: "#fff",
  color: "var(--inv-ink)",
  fontSize: "12px",
  fontWeight: 500,
  padding: "7px 12px",
  borderRadius: "9px",
  cursor: "pointer",
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
    if (!fetcher.data) return;
    const d = fetcher.data;
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
  }, [fetcher.data, shopify]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    next.delete("from");
    next.delete("to");
    setSearchParams(next, { preventScrollReset: true });
  };

  const money = (n: number) => formatCurrency(n, data.currency);
  const decisions = data.critical + data.lowStock;

  // ---- fulfilment split into what is still moving and how the rest ended up.
  const stageUnits = (stage: string) =>
    data.fulfilment.stages.find((s) => s.stage === stage)?.units ?? 0;

  // All four in-route stages, so the card's total equals inRouteUnits. Dropping
  // "attempted" — a delivery tried and failed, the strongest leading indicator of an RTO —
  // would make units silently vanish from the picture.
  const liveSegments: PipelineSegment[] = (
    [
      ["dispatched", "Dispatched"],
      ["in_transit", "In transit"],
      ["out_for_delivery", "Out for delivery"],
      ["attempted", "Attempted"],
    ] as const
  ).map(([stage, label]) => ({
    key: stage,
    label,
    units: stageUnits(stage),
    fg: "var(--inv-transit-fg)",
    bg: "var(--inv-transit-bg)",
    border: "var(--inv-transit-border)",
    bar: "var(--inv-transit-value)",
  }));

  const delivered = data.fulfilment.deliveredUnits;
  const notDelivered = data.fulfilment.notDeliveredUnits;
  const resolved = delivered + notDelivered + data.damagedUnits;
  const rate = (n: number) => (resolved > 0 ? `${((n / resolved) * 100).toFixed(1)}%` : "—");

  const outcomeSegments: PipelineSegment[] = [
    {
      key: "delivered",
      label: "Delivered",
      units: delivered,
      fg: "var(--inv-status-healthy-fg)",
      bg: "var(--inv-status-healthy-bg)",
      border: "#dcece4",
      bar: "var(--inv-status-healthy-dot)",
      note: rate(delivered),
    },
    {
      key: "not_delivered",
      label: "Not delivered",
      units: notDelivered,
      fg: "var(--inv-status-critical-fg)",
      bg: "#fbf6ee",
      border: "#f0e2d0",
      bar: "var(--inv-status-critical-fg)",
      note: rate(notDelivered),
      onClick: () => navigate("/app/returns"),
    },
    {
      key: "damaged",
      label: "Damaged",
      units: data.damagedUnits,
      fg: "var(--inv-status-stockout-fg)",
      bg: "var(--inv-status-stockout-bg)",
      border: "#f2d9d5",
      bar: "var(--inv-status-stockout-fg)",
      note: rate(data.damagedUnits),
      onClick: () => navigate("/app/returns"),
    },
  ];

  // Percentage points, not percent: a return rate moving 22% → 24% is "up 2 points".
  const rtoTrend =
    data.fulfilment.rtoRate != null && data.priorRtoRate != null
      ? (data.fulfilment.rtoRate - data.priorRtoRate) * 100
      : null;

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Inventorify" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        {decisions > 0 && (
          <ActionBar
            headline={`${decisions} decision${decisions === 1 ? "" : "s"} need${decisions === 1 ? "s" : ""} you today`}
            body={`${data.critical} SKU${data.critical === 1 ? " is" : "s are"} critical or out of stock${data.lowStock > 0 ? ` and ${data.lowStock} running low` : ""} — each one below is already sized into an order.`}
            primary={{
              label: "Review reorder queue →",
              onClick: () => document.getElementById("needs-action")?.scrollIntoView({ behavior: "smooth" }),
            }}
            secondary={{ label: "Demand forecast", onClick: () => navigate("/app/forecast") }}
          />
        )}

        <PageHead
          eyebrow={`${data.todayLabel} · Command center`}
          title={data.shopName ? `${data.greeting}, ${data.shopName}` : data.greeting}
          right={
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Segmented
                label="Reporting window"
                value={data.range.preset}
                onChange={(v) => setParam("range", v)}
                options={[
                  { value: "7", label: "7d" },
                  { value: "30", label: "30d" },
                  { value: "90", label: "90d" },
                ]}
              />
              <button
                type="button"
                onClick={() => fetcher.submit({}, { method: "POST" })}
                disabled={isSyncing}
                style={{
                  border: "1px solid var(--inv-input-border-2)",
                  background: "#fff",
                  color: "var(--inv-ink)",
                  fontSize: "12.5px",
                  fontWeight: 500,
                  padding: "8px 13px",
                  borderRadius: "var(--inv-radius-control)",
                  cursor: isSyncing ? "default" : "pointer",
                  opacity: isSyncing ? 0.6 : 1,
                  whiteSpace: "nowrap",
                }}
              >
                ↻ {isSyncing ? "Syncing…" : "Sync"}
              </button>
            </div>
          }
        />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(176px,1fr))", gap: "12px", marginBottom: "16px" }}>
          <KpiTile
            label={`Units sold · last ${data.range.days}d`}
            value={data.period.soldUnits.toLocaleString()}
            series={data.sparklines.unitsSold}
            sparkColor="var(--inv-status-healthy-dot)"
            sub={
              data.period.changePct != null
                ? `${data.period.changePct >= 0 ? "▲" : "▼"} ${Math.abs(data.period.changePct).toFixed(1)}% vs prior ${data.range.days}d`
                : "no prior period to compare"
            }
            subColor={
              data.period.changePct == null
                ? undefined
                : data.period.changePct >= 0
                  ? "var(--inv-status-healthy-fg)"
                  : "var(--inv-status-critical-fg)"
            }
          />
          <KpiTile
            label="Capital tied up"
            size="currency"
            value={money(data.capital.stockValue + data.capital.codFloat)}
            series={data.sparklines.stockAtCost}
            sub={`${money(data.capital.codFloat)} with courier`}
          />
          <KpiTile
            label="In-transit · live"
            size="currency"
            value={money(data.capital.codFloat)}
            valueColor="var(--inv-transit-value)"
            series={data.sparklines.inRouteUnits}
            sparkColor="var(--inv-transit-fg)"
            sub={`${data.fulfilment.inRouteUnits.toLocaleString()} units`}
            subColor="var(--inv-transit-fg)"
          />
          <KpiTile
            label="Low stock"
            value={data.lowStock}
            valueColor="var(--inv-status-low-fg)"
            series={data.sparklines.lowStock}
            sparkColor="var(--inv-status-low-fg)"
            sub="needs attention soon"
            subColor="var(--inv-status-low-fg)"
          />
          <KpiTile
            label="Critical / stockout"
            value={data.critical}
            valueColor="var(--inv-status-stockout-fg)"
            accentBar="var(--inv-status-critical-dot)"
            series={data.sparklines.critical}
            sparkColor="var(--inv-status-stockout-fg)"
            sub={`across ${data.totalSkus} SKUs · ${data.locationCount} location${data.locationCount === 1 ? "" : "s"}`}
            subColor="var(--inv-status-critical-fg)"
          />
        </div>

        {data.rtoFreshness.warning && (
          <Card padding="12px 14px" style={{ marginBottom: "14px", borderColor: "var(--inv-status-low-dot)" }}>
            <div style={{ fontSize: "12.5px", color: "var(--inv-text-2)", lineHeight: 1.5 }}>
              {data.rtoFreshness.warning}
            </div>
          </Card>
        )}

        {(data.fulfilment.inRouteUnits > 0 || resolved > 0) && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: "14px", marginBottom: "16px" }}>
            <PipelineCard
              title="In route now"
              badge="LIVE"
              subtitle="Already out of stock, not yet resolved"
              headerRight={
                <div style={{ fontFamily: "var(--inv-font-mono)", fontSize: "22px", fontWeight: 600, color: "var(--inv-transit-value)", letterSpacing: "-.5px" }}>
                  {data.fulfilment.inRouteUnits.toLocaleString()}
                </div>
              }
              segments={liveSegments}
              footnote={`${money(data.capital.codFloat)} of stock value is sitting with the courier`}
            />
            <PipelineCard
              title={`Outcomes · last ${data.range.days} days`}
              subtitle={`Of ${resolved.toLocaleString()} resolved shipments`}
              headerRight={
                <button type="button" onClick={() => navigate("/app/returns")} style={ghostButton}>
                  Returns →
                </button>
              }
              segments={outcomeSegments}
              footnote={
                rtoTrend == null
                  ? `Source: ${data.fulfilment.source === "courierify" ? "Courierify" : "Shopify carrier tracking"}`
                  : `Return rate ${rtoTrend >= 0 ? "▲" : "▼"} ${Math.abs(rtoTrend).toFixed(1)}pt vs prior ${data.range.days} days${rtoTrend >= 1 ? " — worth a look at courier performance" : ""}`
              }
            />
          </div>
        )}

        {data.capital.costCoverage < 0.99 && (
          <CostPrompt
            coverage={`${data.capital.pricedSkus} of ${data.totalSkus} SKUs have a unit cost (${Math.round(data.capital.costCoverage * 100)}%)`}
            onAction={() => navigate("/app/settings")}
          />
        )}

        <div id="needs-action">
          {data.totalSkus === 0 ? (
            <Card padding="40px 24px">
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>No products synced yet</div>
                <div style={{ fontSize: "13px", color: "var(--inv-muted)", marginBottom: "16px" }}>
                  Sync your Shopify inventory to get started.
                </div>
                <button
                  type="button"
                  onClick={() => fetcher.submit({}, { method: "POST" })}
                  style={{
                    background: "var(--inv-ink)", color: "#fff", border: "none", fontSize: "13px",
                    fontWeight: 500, padding: "9px 15px", borderRadius: "var(--inv-radius-control)", cursor: "pointer",
                  }}
                >
                  Sync Inventory
                </button>
              </div>
            </Card>
          ) : (
            <NeedsActionTable
              rows={data.actionRows}
              filters={
                <Segmented
                  label="Filter by stock status"
                  tone="sunken"
                  value={data.filter}
                  onChange={(v) => setParam("status", v)}
                  options={[
                    { value: "all", label: "All", count: data.actionCounts.all },
                    { value: "stockout", label: "Stockout", count: data.actionCounts.stockout },
                    { value: "critical", label: "Critical", count: data.actionCounts.critical },
                    { value: "low", label: "Low", count: data.actionCounts.low },
                  ]}
                />
              }
              footer={
                data.actionCounts.all === 0
                  ? "Everything is sufficiently stocked."
                  : `Showing ${data.actionRows.length} of ${
                      data.filter === "all" ? data.actionCounts.all : data.actionCounts[data.filter]
                    } — sorted by days of cover left`
              }
              actions={
                <>
                  <Link to="/app/inventory" style={ghostButton}>Full inventory →</Link>
                  <Link to="/app/purchase-orders" style={ghostButton}>Purchase orders →</Link>
                </>
              }
            />
          )}
        </div>
      </div>

      {toast && <Toast message={toast} onDismiss={() => setToast("")} />}
    </div>
  );
}
