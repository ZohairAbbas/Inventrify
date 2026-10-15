import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useRouteLoaderData, useSearchParams, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState, type ReactNode } from "react";
import { authenticate } from "../shopify.server";
import { formatCurrencyWhole } from "../lib/format";
import prisma from "../db.server";
import { getFulfilmentBreakdown, getRtoFreshness } from "../lib/rto-attribution.server";
import { getDamagedUnitsTotal } from "../lib/damage.server";
import { previousRange, resolveDateRange } from "../lib/date-range";
import { getDashboardSparklines } from "../lib/sparklines.server";
import { greetingFor, displayShopName } from "../lib/greeting";
import { shopHour } from "../lib/tz.server";
import {
  isOverviewFilter,
  isOverviewSort,
  selectOverviewRows,
  type OverviewFilter,
  type OverviewSort,
  type OverviewStatus,
} from "../lib/inventory-overview";
import { getStockMovement, getStockOverview } from "../lib/inventory-overview.server";
import { syncShopifyInventory } from "../lib/shopify-sync.server";
import { syncOrderHistory } from "../lib/order-sync.server";
import { generateAlerts } from "../lib/alerts.server";
import {
  Card,
  DataTable,
  KpiTile,
  PageHead,
  Pill,
  PipelineCard,
  ProductThumb,
  Segmented,
  SelectInput,
  StockPositionCard,
  Toast,
  type DataTableColumn,
  type PipelineSegment,
  type StockBucket,
} from "../design";

/** Rows sent to the browser. The chip counts and tiles describe the whole catalogue. */
const ROW_LIMIT = 25;

const displayName = (p: { title: string; variantTitle: string | null }) =>
  p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const range = resolveDateRange(url.searchParams);
  const prior = previousRange(range);
  const filterParam = url.searchParams.get("status");
  const sortParam = url.searchParams.get("sort");
  const filter: OverviewFilter = isOverviewFilter(filterParam) ? filterParam : "all";
  const sort: OverviewSort = isOverviewSort(sortParam) ? sortParam : "value";

  const settings = await prisma.shopSettings.findUnique({
    where: { shop },
    select: {
      shopName: true,
      currency: true,
      timezone: true,
      deadStockDays: true,
      deadStockMinUnits: true,
    },
  });

  const [overview, movement, fulfilment, priorFulfilment, rtoFreshness, damagedUnits, sparklines] =
    await Promise.all([
      getStockOverview(shop, {
        days: settings?.deadStockDays ?? 60,
        minUnits: settings?.deadStockMinUnits ?? 20,
      }),
      getStockMovement(shop, range, prior),
      getFulfilmentBreakdown(shop, range),
      // Same length of window, immediately before this one — the basis for the return-rate
      // trend on the outcomes card.
      getFulfilmentBreakdown(shop, prior),
      getRtoFreshness(shop),
      // Windowed to match the outcome stages it is displayed beside.
      getDamagedUnitsTotal(shop, { from: range.from, to: range.to }),
      getDashboardSparklines(shop, range.days),
    ]);

  const table = selectOverviewRows(overview.rows, filter, sort, ROW_LIMIT);
  const rowById = new Map(overview.rows.map((r) => [r.id, r]));

  const timezone = settings?.timezone ?? "UTC";
  const { totals } = overview;

  return {
    range,
    filter,
    sort,
    greeting: greetingFor(shopHour(new Date(), timezone)),
    shopName: displayShopName(settings?.shopName, shop),
    todayLabel: new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      month: "short",
      day: "numeric",
    }).format(new Date()),
    currency: settings?.currency ?? "USD",
    totals,
    booked: overview.booked,
    withCourier: overview.withCourier,
    returnsToCheck: overview.returnsToCheck,
    openPurchaseOrders: overview.openPurchaseOrders,
    tableRows: table.rows.map((r) => ({
      id: r.id,
      name: displayName(r),
      sku: r.sku,
      imageUrl: r.imageUrl,
      onHand: Math.max(0, r.onHand),
      unbooked: r.unbooked,
      available: r.available,
      incoming: r.incoming,
      unitCost: r.unitCost,
      price: r.price,
      marginPct: r.marginPct,
      atCost: r.atCost,
      atRetail: r.atRetail,
      daysLeft: r.daysLeft,
      status: r.status,
    })),
    tableMatched: table.matched,
    movement: {
      ...movement,
      topMovers: movement.topMovers.map((m) => {
        const row = rowById.get(m.productId);
        return {
          productId: m.productId,
          name: displayName(m),
          sku: m.sku,
          sold: m.sold,
          revenue: m.revenue,
          // Archived since it sold: no current stock to describe.
          available: row?.available ?? null,
          daysLeft: row?.daysLeft ?? null,
          status: row?.status ?? null,
          incoming: row?.incoming ?? 0,
        };
      }),
    },
    sparklines,
    fulfilment,
    // Only the rate is needed; sending the whole prior breakdown would double the payload
    // for one number.
    priorRtoRate: priorFulfilment.rtoRate,
    rtoFreshness,
    damagedUnits,
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
  whiteSpace: "nowrap",
};

const mono: React.CSSProperties = { fontFamily: "var(--inv-font-mono)" };
const faint: React.CSSProperties = { ...mono, color: "var(--inv-faint)" };

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/** Days-of-stock pill, shared by the SKU table and Top movers. */
function StockLeft({
  status,
  daysLeft,
  incoming,
}: {
  status: OverviewStatus | null;
  daysLeft: number | null;
  incoming: number;
}) {
  if (status == null) return <span style={faint}>—</span>;
  if (status === "out") {
    return (
      <Pill
        label={incoming > 0 ? `Out · ${fmt(incoming)} coming` : "Out of stock"}
        bg="var(--inv-status-stockout-bg)"
        fg="var(--inv-status-stockout-fg)"
      />
    );
  }
  if (daysLeft == null) {
    return <Pill label={status === "slow" ? "Not selling" : "No sales"} bg="var(--inv-divider-3)" fg="var(--inv-text-2)" />;
  }
  if (status === "low") {
    return <Pill label={`${daysLeft}d`} bg="var(--inv-status-critical-bg)" fg="var(--inv-status-critical-fg)" />;
  }
  if (status === "slow") {
    return <Pill label={`${daysLeft}d · slow`} bg="var(--inv-divider-3)" fg="var(--inv-text-2)" />;
  }
  return <Pill label={`${daysLeft}d`} bg="var(--inv-status-healthy-bg)" fg="var(--inv-status-healthy-fg)" />;
}

function SectionHead({ title, caption, right }: { title: string; caption: string; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "10px", margin: "6px 0 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: "17px", fontWeight: 600, letterSpacing: "-.2px" }}>{title}</h2>
        <span style={{ fontSize: "12px", color: "var(--inv-text-2)" }}>{caption}</span>
      </div>
      {right}
    </div>
  );
}

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
    if (key === "range") {
      next.delete("from");
      next.delete("to");
    }
    setSearchParams(next, { preventScrollReset: true });
  };

  const money = (n: number) => formatCurrencyWhole(n, data.currency);
  const t = data.totals;
  const m = data.movement;
  const syncNow = () => fetcher.submit({}, { method: "POST" });

  // ---- "Inventory right now" tiles
  const margin = t.atRetail - t.pricedAtCost;
  const marginPct = t.atRetail > 0 ? Math.round((margin / t.atRetail) * 100) : null;
  const priceCoverage =
    t.pricedSkus === t.skus ? null : `${t.pricedSkus} of ${t.skus} SKUs have a price`;
  const costCoverage =
    t.costedSkus === t.skus ? `all ${t.skus} SKUs have a cost` : `${t.costedSkus} of ${t.skus} SKUs have a cost`;

  // ---- Where the stock is. Each unit sits in exactly one bucket: available and awaiting
  // booking split on-hand; damaged is excluded from on-hand by the sync; booking fulfils the
  // Shopify order, so booked units, units with the courier and returns awaiting a decision
  // have already left on-hand; incoming has not arrived.
  const buckets: StockBucket[] = [
    {
      key: "available",
      label: "Available",
      units: t.available,
      cost: t.availableCost,
      note: "On the shelf, free to sell",
      color: "var(--inv-status-healthy-dot)",
    },
    {
      key: "unbooked",
      label: "Awaiting booking",
      units: t.unbooked,
      cost: t.unbookedCost,
      note: "On open orders, not yet booked with a courier",
      color: "#7fb8a0",
    },
    {
      key: "damaged",
      label: "Damaged",
      units: t.damaged,
      cost: t.damagedCost,
      note: "Quarantined, not sellable",
      color: "var(--inv-status-stockout-dot)",
    },
    {
      key: "booked",
      label: "Booked",
      units: data.booked.units,
      cost: data.booked.cost,
      note:
        data.booked.orders > 0
          ? `${fmt(data.booked.orders)} order${data.booked.orders === 1 ? "" : "s"} awaiting courier pickup`
          : "Nothing awaiting pickup",
      color: "#e0b25c",
    },
    {
      key: "courier",
      label: "With courier",
      units: data.withCourier.units,
      cost: data.withCourier.cost,
      note: data.withCourier.units > 0 ? `${money(data.withCourier.retail)} COD to collect` : "Nothing in transit",
      color: "var(--inv-transit-dot)",
    },
    {
      key: "returns",
      label: "Returns to check",
      units: data.returnsToCheck.units,
      cost: data.returnsToCheck.cost,
      note: "Back from RTO, not yet restocked",
      color: "#9297e0",
    },
    {
      key: "incoming",
      label: "Incoming",
      units: t.incoming,
      cost: t.incomingCost,
      note:
        data.openPurchaseOrders > 0
          ? `On ${data.openPurchaseOrders} open purchase order${data.openPurchaseOrders === 1 ? "" : "s"}`
          : "No open purchase orders",
      color: "var(--inv-faint)",
    },
  ];

  // ---- SKU table
  const columns: DataTableColumn[] = [
    { header: "Product", width: "2.3fr" },
    { header: "On hand", width: ".7fr", align: "right" },
    { header: "Unbooked", width: ".8fr", align: "right" },
    { header: "Available", width: ".8fr", align: "right" },
    { header: "Incoming", width: ".8fr", align: "right" },
    { header: "Unit cost", width: ".9fr", align: "right" },
    { header: "Price", width: ".9fr", align: "right" },
    { header: "Margin", width: ".7fr", align: "right" },
    { header: "Stock @ cost", width: "1.1fr", align: "right" },
    { header: "Stock @ retail", width: "1.1fr", align: "right" },
    { header: "Stock left", width: "1.2fr", align: "right" },
  ];

  const rows = data.tableRows.map((r) => ({
    key: r.id,
    cells: [
      <div key="name" style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
        <ProductThumb src={r.imageUrl} name={r.name} size={30} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
          <div style={{ ...mono, fontSize: "11px", color: "var(--inv-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>
            {r.sku ?? "—"}
          </div>
        </div>
      </div>,
      <span key="onhand" style={mono}>{fmt(r.onHand)}</span>,
      <span key="unbooked" style={r.unbooked ? mono : faint}>{r.unbooked ? fmt(r.unbooked) : "—"}</span>,
      <span
        key="avail"
        style={{ ...mono, fontWeight: 600, color: r.available <= 0 ? "var(--inv-status-stockout-fg)" : "var(--inv-ink)" }}
      >
        {fmt(r.available)}
      </span>,
      <span key="incoming" style={r.incoming ? { ...mono, color: "var(--inv-transit-fg)" } : faint}>
        {r.incoming ? `+${fmt(r.incoming)}` : "—"}
      </span>,
      <span key="cost" style={r.unitCost > 0 ? mono : faint}>{r.unitCost > 0 ? money(r.unitCost) : "—"}</span>,
      <span key="price" style={r.price ? mono : faint}>{r.price ? money(r.price) : "—"}</span>,
      <span
        key="margin"
        style={
          r.marginPct == null
            ? faint
            : { ...mono, color: r.marginPct < 0 ? "var(--inv-status-stockout-fg)" : "var(--inv-text-2)" }
        }
      >
        {r.marginPct == null ? "—" : `${Math.round(r.marginPct * 100)}%`}
      </span>,
      <span key="atcost" style={mono}>{money(r.atCost)}</span>,
      <span key="atretail" style={r.atRetail == null ? faint : mono}>
        {r.atRetail == null ? "—" : money(r.atRetail)}
      </span>,
      <StockLeft key="left" status={r.status} daysLeft={r.daysLeft} incoming={r.incoming} />,
    ],
  }));

  const sortLabel: Record<OverviewSort, string> = {
    value: "stock value",
    days: "days of stock left",
    margin: "margin",
    available: "available units",
  };

  // ---- Period: fulfilment split into what is still moving and how the rest ended up.
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

  // Null rather than 0% when there is no prior window to compare against: history only
  // starts 60 days before install without read_all_orders.
  const soldChange =
    m.sold.priorUnits > 0 ? ((m.sold.units - m.sold.priorUnits) / m.sold.priorUnits) * 100 : null;
  const net = m.received.units + m.returnsRestocked.units + m.adjustments.units - m.sold.units;
  const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n))}`;
  const periodLabel = `the last ${data.range.days} days`;

  const moverColumns: DataTableColumn[] = [
    { header: "Product", width: "2.6fr" },
    { header: "Sold", width: ".7fr", align: "right" },
    { header: "Revenue", width: "1fr", align: "right" },
    { header: "Available", width: ".8fr", align: "right" },
    { header: "Stock left", width: "1.2fr", align: "right" },
  ];
  const moverRows = m.topMovers.map((r, i) => ({
    key: r.productId,
    cells: [
      <div key="name" style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
        <span style={{ ...mono, fontSize: "11px", color: "var(--inv-muted)", width: "14px", flex: "none" }}>{i + 1}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
          <div style={{ ...mono, fontSize: "11px", color: "var(--inv-muted)" }}>{r.sku ?? "—"}</div>
        </div>
      </div>,
      <span key="sold" style={{ ...mono, fontWeight: 600 }}>{fmt(r.sold)}</span>,
      <span key="rev" style={r.revenue == null ? faint : mono}>{r.revenue == null ? "—" : money(r.revenue)}</span>,
      <span key="avail" style={r.available == null ? faint : mono}>{r.available == null ? "—" : fmt(r.available)}</span>,
      <StockLeft key="left" status={r.status} daysLeft={r.daysLeft} incoming={r.incoming} />,
    ],
  }));

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Inventorify" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead
          eyebrow={`${data.todayLabel} · Command center`}
          title={data.shopName ? `${data.greeting}, ${data.shopName}` : data.greeting}
          right={
            <button
              type="button"
              onClick={syncNow}
              disabled={isSyncing}
              style={{
                ...ghostButton,
                fontSize: "12.5px",
                padding: "8px 13px",
                borderRadius: "var(--inv-radius-control)",
                cursor: isSyncing ? "default" : "pointer",
                opacity: isSyncing ? 0.6 : 1,
              }}
            >
              ↻ {isSyncing ? "Syncing…" : "Sync"}
            </button>
          }
        />

        {t.skus === 0 ? (
          <Card padding="40px 24px">
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>No products synced yet</div>
              <div style={{ fontSize: "13px", color: "var(--inv-muted)", marginBottom: "16px" }}>
                Sync your Shopify inventory to get started.
              </div>
              <button
                type="button"
                onClick={syncNow}
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
          <>
            {/* ============ Inventory right now ============ */}
            <SectionHead title="Inventory right now" caption="Current stock, not affected by the date range" />

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "12px", marginBottom: "14px" }}>
              <KpiTile
                label="Available to sell"
                value={fmt(t.available)}
                valueColor="var(--inv-status-healthy-fg)"
                sub={`${fmt(t.onHand)} on hand − ${fmt(t.unbooked)} awaiting booking · ${t.skus} SKUs`}
              />
              <KpiTile
                label="Booked"
                value={fmt(data.booked.units)}
                sub={
                  data.booked.units > 0
                    ? `units on ${fmt(data.booked.orders)} order${data.booked.orders === 1 ? "" : "s"} awaiting pickup` +
                      (data.booked.retail > 0 ? ` · ${money(data.booked.retail)} COD` : "")
                    : "nothing awaiting courier pickup"
                }
              />
              <KpiTile
                label="Inventory cost"
                size="currency"
                value={money(t.atCost)}
                series={data.sparklines.stockAtCost}
                sub={costCoverage}
                subColor={t.costedSkus < t.skus ? "var(--inv-status-low-fg)" : undefined}
              />
              <KpiTile
                label="Stock @ retail"
                size="currency"
                value={t.pricedSkus > 0 ? money(t.atRetail) : "—"}
                sub={
                  t.pricedSkus === 0
                    ? "Prices arrive with the next sync"
                    : `${money(margin)} potential margin${marginPct != null ? ` · ${marginPct}%` : ""}` +
                      (priceCoverage ? ` · ${priceCoverage}` : "")
                }
                subColor={t.pricedSkus > 0 && margin > 0 ? "var(--inv-status-healthy-fg)" : undefined}
              />
              <KpiTile
                label="Out of stock / Low"
                value={`${t.counts.out} / ${t.counts.low}`}
                valueColor={t.counts.out > 0 ? "var(--inv-status-stockout-fg)" : undefined}
                sub={`SKUs · ${t.counts.slow} slow or not selling`}
              />
            </div>

            <div style={{ marginBottom: "14px" }}>
              <StockPositionCard buckets={buckets} formatMoney={money} />
            </div>

            <div id="sku-table" style={{ marginBottom: "8px" }}>
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "10px" }}>
                <div>
                  <div style={{ fontSize: "15px", fontWeight: 600 }}>Inventory by SKU</div>
                  <div style={{ fontSize: "12px", color: "var(--inv-text-2)", marginTop: "3px" }}>
                    {data.tableMatched === 0
                      ? "No SKUs in this view"
                      : `Showing ${data.tableRows.length} of ${data.tableMatched} · sorted by ${sortLabel[data.sort]}`}
                  </div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" }}>
                  <Segmented
                    label="Filter by stock status"
                    tone="sunken"
                    value={data.filter}
                    onChange={(v) => setParam("status", v)}
                    options={[
                      { value: "all", label: "All", count: t.counts.all },
                      { value: "out", label: "Out of stock", count: t.counts.out },
                      { value: "low", label: "Low", count: t.counts.low },
                      { value: "slow", label: "Slow / not selling", count: t.counts.slow },
                    ]}
                  />
                  <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--inv-text-2)" }}>
                    Sort
                    <SelectInput
                      value={data.sort}
                      onChange={(e) => setParam("sort", e.target.value)}
                      style={{ width: "auto", height: "34px" }}
                    >
                      <option value="value">Stock value</option>
                      <option value="days">Days left</option>
                      <option value="margin">Margin</option>
                      <option value="available">Available</option>
                    </SelectInput>
                  </label>
                  <Link to="/app/inventory" style={ghostButton}>Full inventory →</Link>
                </div>
              </div>
              {data.tableRows.length > 0 && <DataTable columns={columns} rows={rows} minWidth="1080px" />}
            </div>

            {/* ============ In the selected period ============ */}
            <div style={{ borderTop: "1px dashed var(--inv-divider-2)", marginTop: "26px", paddingTop: "18px" }}>
              <SectionHead
                title="In the selected period"
                caption={periodLabel}
                right={
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
                }
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: "12px", marginBottom: "8px" }}>
              <KpiTile
                label="Stock in · purchase orders"
                value={signed(m.received.units)}
                valueColor={m.received.units > 0 ? "var(--inv-status-healthy-fg)" : undefined}
                sub={
                  `${money(m.received.cost)} at cost · ${m.received.purchaseOrders} PO${m.received.purchaseOrders === 1 ? "" : "s"}` +
                  (m.received.damaged > 0 ? ` · ${fmt(m.received.damaged)} arrived damaged` : "")
                }
              />
              <KpiTile
                label="Stock in · returns restocked"
                value={signed(m.returnsRestocked.units)}
                valueColor={m.returnsRestocked.units > 0 ? "var(--inv-status-healthy-fg)" : undefined}
                sub={`${money(m.returnsRestocked.cost)} at cost`}
              />
              <KpiTile
                label="Stock out · sold"
                value={signed(-m.sold.units)}
                series={data.sparklines.unitsSold}
                sparkColor="var(--inv-status-healthy-dot)"
                sub={
                  `${money(m.sold.valueAtCurrentPrice)} at current price` +
                  (soldChange != null
                    ? ` · ${soldChange >= 0 ? "▲" : "▼"} ${Math.abs(soldChange).toFixed(1)}% vs prior`
                    : "")
                }
              />
              <KpiTile
                label="Damaged & adjustments"
                value={signed(m.adjustments.units)}
                valueColor={m.adjustments.units < 0 ? "var(--inv-status-stockout-fg)" : undefined}
                sub={`${money(Math.abs(m.adjustments.cost))} at cost · net of damage, counts and corrections`}
              />
            </div>
            <div style={{ fontSize: "12px", color: "var(--inv-text-2)", marginBottom: "16px" }}>
              Net change: <span style={{ ...mono, fontWeight: 600, color: "var(--inv-ink)" }}>{signed(net)} units</span> over {periodLabel}
            </div>

            {data.rtoFreshness.warning && (
              <Card padding="12px 14px" style={{ marginBottom: "14px", borderColor: "var(--inv-status-low-dot)" }}>
                <div style={{ fontSize: "12.5px", color: "var(--inv-text-2)", lineHeight: 1.5 }}>
                  {data.rtoFreshness.warning}
                </div>
              </Card>
            )}

            {data.rtoFreshness.unrecognisedWarning && (
              <Card padding="12px 14px" style={{ marginBottom: "14px", borderColor: "var(--inv-status-low-dot)" }}>
                <div style={{ fontSize: "12.5px", color: "var(--inv-text-2)", lineHeight: 1.5 }}>
                  {data.rtoFreshness.unrecognisedWarning}
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
                    <div style={{ ...mono, fontSize: "22px", fontWeight: 600, color: "var(--inv-transit-value)", letterSpacing: "-.5px" }}>
                      {data.fulfilment.inRouteUnits.toLocaleString("en-US")}
                    </div>
                  }
                  segments={liveSegments}
                  footnote={`${money(data.withCourier.retail)} of sales is sitting with the courier as COD`}
                />
                <PipelineCard
                  title={`Outcomes · last ${data.range.days} days`}
                  subtitle={`Of ${resolved.toLocaleString("en-US")} resolved shipments`}
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

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
              <div>
                <div style={{ fontSize: "15px", fontWeight: 600 }}>Top movers</div>
                <div style={{ fontSize: "12px", color: "var(--inv-text-2)", marginTop: "3px" }}>
                  Best sellers in {periodLabel}, and how long the stock will last · revenue at current price
                </div>
              </div>
              <Link to="/app/analytics" style={ghostButton}>Analytics →</Link>
            </div>
            {moverRows.length === 0 ? (
              <Card padding="20px 18px">
                <div style={{ fontSize: "13px", color: "var(--inv-muted)", textAlign: "center" }}>No sales in {periodLabel}.</div>
              </Card>
            ) : (
              <DataTable columns={moverColumns} rows={moverRows} minWidth="620px" />
            )}
          </>
        )}
      </div>

      {toast && <Toast message={toast} onDismiss={() => setToast("")} />}
    </div>
  );
}
