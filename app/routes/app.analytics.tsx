import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useRouteLoaderData, useSearchParams } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { resolveDateRange } from "../lib/date-range";
import { getRtoByCarrier } from "../lib/rto-attribution.server";
import {
  getSalesTrend,
  getPeriodComparison,
  getTopMovers,
  getDeadStock,
  getStatusDistribution,
  getHighReturnRateProducts,
  getRtoByRegion,
  getCodFunnel,
} from "../lib/analytics.server";
import prisma from "../db.server";
import { BarChart, Card, DataTable, DateRangePicker, KpiCard, Pill, type DataTableColumn } from "../design";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const range = resolveDateRange(new URL(request.url).searchParams);

  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const deadStockDays = settings?.deadStockDays ?? 60;
  const deadStockMinUnits = settings?.deadStockMinUnits ?? 20;

  const [trend, comparison, topMovers, deadStock, statusDist, highReturnRate, rtoByRegion, rtoByCarrier, codFunnel] =
    await Promise.all([
    getSalesTrend(shop, range),
    getPeriodComparison(shop, range),
    getTopMovers(shop, range, 10),
    // Dead stock is defined by the merchant's own no-sales threshold, not by whatever
    // window is being viewed — a 7-day view must not relabel everything as dead stock.
    getDeadStock(shop, deadStockDays, deadStockMinUnits),
    // Stock status is current state; it has no time dimension to filter.
    getStatusDistribution(shop),
    getHighReturnRateProducts(shop, 10),
    getRtoByRegion(shop, range),
    getRtoByCarrier(shop, range),
    getCodFunnel(shop, range),
  ]);

  return {
    trend, comparison, topMovers, deadStock, statusDist, highReturnRate, rtoByRegion,
    codFunnel, rtoByCarrier, range, deadStockDays,
  };
};

const SEGMENT_COLORS: Record<string, string> = {
  healthy: "var(--inv-status-healthy-dot)",
  low: "#c9a227",
  critical: "var(--inv-status-critical-dot)",
  stockout: "var(--inv-status-stockout-dot)",
};

export default function Analytics() {
  const {
    trend, comparison, topMovers, deadStock, statusDist, highReturnRate, rtoByRegion,
    codFunnel, rtoByCarrier, range, deadStockDays,
  } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { theme = "emerald" } = useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  const totalHealthy = statusDist.healthy + statusDist.low + statusDist.critical + statusDist.stockout;
  const changeColor =
    comparison.changePct == null
      ? "var(--inv-muted)"
      : comparison.changePct >= 0
        ? "var(--inv-status-healthy-fg)"
        : "var(--inv-status-critical-fg)";

  const moverColumns: DataTableColumn[] = [
    { header: "Product", width: "2.4fr" },
    { header: "SKU", width: "1.2fr" },
    { header: "Units sold", width: "1fr", align: "right" },
    { header: "Daily avg", width: "1fr", align: "right" },
    { header: "Days left", width: "1fr", align: "right" },
  ];
  const moverRows = topMovers.map((m) => ({
    key: m.product.id,
    cells: [
      <span key="n" style={{ fontWeight: 500 }}>
        {m.product.variantTitle ? `${m.product.title} — ${m.product.variantTitle}` : m.product.title}
      </span>,
      <span key="s" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12px", color: "var(--inv-text-2)" }}>{m.product.sku ?? "—"}</span>,
      <span key="u" style={{ fontFamily: "var(--inv-font-mono)", fontWeight: 600 }}>{m.totalSold}</span>,
      <span key="a" style={{ fontFamily: "var(--inv-font-mono)", color: "var(--inv-text-2)" }}>{m.product.avgDailySales.toFixed(1)}</span>,
      <span key="d" style={{ fontFamily: "var(--inv-font-mono)", color: "var(--inv-text-2)" }}>
        {m.product.currentStock > 0 && m.product.avgDailySales > 0
          ? `${Math.floor(m.product.currentStock / m.product.avgDailySales)}d`
          : "—"}
      </span>,
    ],
  }));

  const returnColumns: DataTableColumn[] = [
    { header: "Product", width: "2.4fr" },
    { header: "SKU", width: "1.2fr" },
    { header: "Return rate", width: "1fr", align: "right" },
    { header: "Daily sales", width: "1fr", align: "right" },
  ];
  const returnRows = highReturnRate.map((p) => ({
    key: p.id,
    cells: [
      <span key="n" style={{ fontWeight: 500 }}>{p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title}</span>,
      <span key="s" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12px", color: "var(--inv-text-2)" }}>{p.sku ?? "—"}</span>,
      <span key="r" style={{ fontFamily: "var(--inv-font-mono)", fontWeight: 600, color: "var(--inv-status-critical-fg)" }}>{(p.codReturnRate * 100).toFixed(0)}%</span>,
      <span key="a" style={{ fontFamily: "var(--inv-font-mono)", color: "var(--inv-text-2)" }}>{p.avgDailySales.toFixed(1)}</span>,
    ],
  }));

  const deadColumns: DataTableColumn[] = [
    { header: "Product", width: "2.6fr" },
    { header: "SKU", width: "1.2fr" },
    { header: "Units on hand", width: "1fr", align: "right" },
    { header: "Margin", width: "1fr", align: "right" },
  ];
  const deadRows = deadStock.map((p) => ({
    key: p.id,
    cells: [
      <span key="n" style={{ fontWeight: 500 }}>{p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title}</span>,
      <span key="s" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12px", color: "var(--inv-text-2)" }}>{p.sku ?? "—"}</span>,
      <span key="u" style={{ fontFamily: "var(--inv-font-mono)" }}>{p.currentStock}</span>,
      <span key="m" style={{ fontFamily: "var(--inv-font-mono)", color: p.avgMargin > 0 ? "var(--inv-text-2)" : "var(--inv-faint)" }}>
        {p.avgMargin > 0 ? `${(p.avgMargin * 100).toFixed(0)}%` : "—"}
      </span>,
    ],
  }));

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Analytics" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <div style={{ fontFamily: "var(--inv-font-mono)", fontSize: "11px", letterSpacing: "1px", color: "var(--inv-muted)", textTransform: "uppercase", marginBottom: "6px" }}>
          Inventory intelligence
        </div>
        <h1 style={{ margin: "0 0 14px", fontSize: "25px", fontWeight: 600, letterSpacing: "-.5px" }}>Analytics</h1>

        <DateRangePicker
          value={range}
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

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "12px", marginBottom: "14px" }}>
          <KpiCard
            label={`Units sold — ${range.label}`}
            value={comparison.currentTotal.toLocaleString()}
            sub={comparison.changePct != null ? `${comparison.changePct >= 0 ? "+" : ""}${comparison.changePct.toFixed(1)}% vs prior ${range.days}d` : undefined}
            valueColor={comparison.changePct != null ? changeColor : undefined}
          />
          <KpiCard
            label="Inventory health"
            value={statusDist.healthy}
            sub={`${statusDist.healthy} healthy · ${statusDist.low} low · ${statusDist.critical} crit · ${statusDist.stockout} out`}
          />
          <KpiCard
            label="Dead stock items"
            value={deadStock.length}
            // Deliberately not tied to the selected range: dead stock is defined by the
            // merchant's own threshold, so a 7-day view must not relabel the catalogue.
            sub={`no sales in ${deadStockDays}d — set in Settings`}
            valueColor="var(--inv-status-critical-fg)"
          />
        </div>

        {totalHealthy > 0 && (
          <Card style={{ marginBottom: "14px" }}>
            <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "12px" }}>Inventory health distribution</div>
            <div style={{ display: "flex", height: "34px", borderRadius: "9px", overflow: "hidden", gap: "2px" }}>
              {(["healthy", "low", "critical", "stockout"] as const).map(
                (key) =>
                  statusDist[key] > 0 && (
                    <div
                      key={key}
                      style={{
                        width: `${(statusDist[key] / totalHealthy) * 100}%`,
                        background: SEGMENT_COLORS[key],
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#fff",
                        fontSize: "11px",
                        fontWeight: 600,
                        minWidth: "34px",
                      }}
                    >
                      {statusDist[key]}
                    </div>
                  ),
              )}
            </div>
            <div style={{ display: "flex", gap: "16px", marginTop: "10px", fontSize: "11.5px", color: "var(--inv-text-2)", flexWrap: "wrap" }}>
              {(["healthy", "low", "critical", "stockout"] as const).map((key) => (
                <span key={key}>
                  <span style={{ color: SEGMENT_COLORS[key] }}>■ </span>
                  {key} {statusDist[key]}
                </span>
              ))}
            </div>
          </Card>
        )}

        <Card style={{ marginBottom: "14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "14px" }}>
            <div style={{ fontSize: "14px", fontWeight: 600 }}>Daily sales — {range.label}</div>
            <span style={{ fontSize: "11.5px", color: "var(--inv-muted)" }}>all products combined</span>
          </div>
          <BarChart values={trend.map((d) => d.quantity)} labels={[trend[0]?.date ?? "", trend[trend.length - 1]?.date ?? ""]} />
        </Card>

        {topMovers.length > 0 && (
          <div style={{ marginBottom: "14px" }}>
            <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "10px" }}>Top movers — {range.label}</div>
            <DataTable columns={moverColumns} rows={moverRows} />
          </div>
        )}

        {highReturnRate.length > 0 && (
          <div style={{ marginBottom: "14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
              <div style={{ fontSize: "14px", fontWeight: 600 }}>High COD return rates</div>
              <Pill label="Review these products" bg="var(--inv-status-low-bg)" fg="var(--inv-status-low-fg)" />
            </div>
            <DataTable columns={returnColumns} rows={returnRows} />
          </div>
        )}

        {codFunnel.placed > 0 && (
          <div style={{ marginBottom: "22px" }}>
            <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "4px" }}>COD order funnel</div>
            <div style={{ fontSize: "12px", color: "var(--inv-muted)", marginBottom: "12px" }}>
              {range.label}. Demand is recorded when an order is placed, but only dispatched
              orders consume stock — the gap is how much the demand signal is inflated.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" }}>
              {[
                ["Placed", codFunnel.placed, null],
                [
                  "Confirmed",
                  codFunnel.confirmationTracked ? codFunnel.confirmed : null,
                  codFunnel.confirmationTracked ? null : "Set a confirmed-order tag in Settings",
                ],
                ["Dispatched", codFunnel.dispatched, null],
                ["Cancelled", codFunnel.cancelled, null],
                ["Never dispatched", codFunnel.pending, null],
              ].map(([label, value, note]) => (
                <Card key={label as string} padding="13px 14px">
                  <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "4px" }}>{label}</div>
                  {value === null ? (
                    <div style={{ fontSize: "11.5px", color: "var(--inv-faint)", lineHeight: 1.4 }}>{note}</div>
                  ) : (
                    <div style={{ fontFamily: "var(--inv-font-mono)", fontSize: "19px", fontWeight: 600 }}>
                      {value as number}
                    </div>
                  )}
                </Card>
              ))}
            </div>
            {codFunnel.attritionRate > 0 && (
              <div style={{ fontSize: "12px", color: "var(--inv-muted)", marginTop: "10px", lineHeight: 1.5 }}>
                <strong style={{ color: codFunnel.attritionRate >= 0.3 ? "var(--inv-status-critical-fg)" : "var(--inv-text-2)" }}>
                  {(codFunnel.attritionRate * 100).toFixed(1)}%
                </strong>{" "}
                of COD orders that were not cancelled ({codFunnel.pending} of{" "}
                {codFunnel.placed - codFunnel.cancelled}) quietly never reached dispatch, so
                demand is overstated by roughly that much.
                {codFunnel.cancelled > 0 && (
                  <>
                    {" "}
                    The {codFunnel.cancelled} cancelled order
                    {codFunnel.cancelled === 1 ? "" : "s"} {codFunnel.cancelled === 1 ? "is" : "are"}{" "}
                    excluded — those units were already removed from demand when the
                    cancellation came in.
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {rtoByCarrier.length > 0 && (
          <div style={{ marginBottom: "22px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
              <div style={{ fontSize: "14px", fontWeight: 600 }}>RTO by carrier</div>
              <Pill label="Shopify tracking" bg="var(--inv-status-low-bg)" fg="var(--inv-status-low-fg)" />
            </div>
            <div style={{ fontSize: "12px", color: "var(--inv-muted)", marginBottom: "10px" }}>
              {range.label}, carriers with at least 10 resolved units. The spread between
              couriers on the same lane is often wider than the spread between products,
              and unlike a product mix it can be changed next week.
            </div>
            <DataTable
              columns={[
                { header: "Carrier", width: "2fr" },
                { header: "Delivered", width: "1fr", align: "right" },
                { header: "Not delivered", width: "1fr", align: "right" },
                { header: "In route", width: "1fr", align: "right" },
                { header: "RTO rate", width: "1fr", align: "right" },
              ]}
              rows={rtoByCarrier.map((c) => ({
                key: c.carrier,
                cells: [
                  <span key="c" style={{ fontWeight: 500 }}>{c.carrier}</span>,
                  <span key="d" style={{ fontFamily: "var(--inv-font-mono)" }}>{c.deliveredUnits}</span>,
                  <span key="n" style={{ fontFamily: "var(--inv-font-mono)" }}>{c.notDeliveredUnits}</span>,
                  <span key="t" style={{ fontFamily: "var(--inv-font-mono)", color: "var(--inv-text-2)" }}>{c.inRouteUnits}</span>,
                  <span
                    key="r"
                    style={{
                      fontFamily: "var(--inv-font-mono)",
                      fontWeight: 600,
                      color:
                        c.rtoRate >= 0.4
                          ? "var(--inv-status-stockout-fg)"
                          : c.rtoRate >= 0.25
                            ? "var(--inv-status-critical-fg)"
                            : "var(--inv-status-healthy-fg)",
                    }}
                  >
                    {(c.rtoRate * 100).toFixed(1)}%
                  </span>,
                ],
              }))}
            />
            {rtoByCarrier.length > 1 && (
              <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginTop: "8px" }}>
                {rtoByCarrier[0].carrier} returns{" "}
                {((rtoByCarrier[0].rtoRate - rtoByCarrier[rtoByCarrier.length - 1].rtoRate) * 100).toFixed(1)}
                {" "}points more often than {rtoByCarrier[rtoByCarrier.length - 1].carrier} on this period's volume.
              </div>
            )}
          </div>
        )}

        {rtoByRegion.length > 0 && (
          <div style={{ marginBottom: "22px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
              <div style={{ fontSize: "14px", fontWeight: 600 }}>RTO by delivery city</div>
              <Pill label="COD orders" bg="var(--inv-status-low-bg)" fg="var(--inv-status-low-fg)" />
            </div>
            <div style={{ fontSize: "12px", color: "var(--inv-muted)", marginBottom: "10px" }}>
              {range.label}, cities with at least 10 units shipped. A shop-wide average hides
              which routes are losing money.
            </div>
            <DataTable
              columns={[
                { header: "City", width: "2fr" },
                { header: "Units shipped", width: "1fr", align: "right" },
                { header: "Returned", width: "1fr", align: "right" },
                { header: "RTO rate", width: "1fr", align: "right" },
              ]}
              rows={rtoByRegion.slice(0, 15).map((r) => ({
                key: r.city,
                cells: [
                  <span key="city" style={{ fontWeight: 500 }}>{r.city}</span>,
                  <span key="shipped" style={{ fontFamily: "var(--inv-font-mono)" }}>{r.shippedUnits}</span>,
                  <span key="ret" style={{ fontFamily: "var(--inv-font-mono)" }}>{r.returnedUnits}</span>,
                  <span
                    key="rate"
                    style={{
                      fontFamily: "var(--inv-font-mono)",
                      fontWeight: 600,
                      color:
                        r.rtoRate >= 0.4
                          ? "var(--inv-status-stockout-fg)"
                          : r.rtoRate >= 0.25
                            ? "var(--inv-status-critical-fg)"
                            : "var(--inv-text-2)",
                    }}
                  >
                    {(r.rtoRate * 100).toFixed(0)}%
                  </span>,
                ],
              }))}
            />
          </div>
        )}

        {deadStock.length > 0 && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
              <div style={{ fontSize: "14px", fontWeight: 600 }}>Dead stock candidates</div>
              <Pill label="No recent sales" bg="var(--inv-status-stockout-bg)" fg="var(--inv-status-stockout-fg)" />
            </div>
            <DataTable columns={deadColumns} rows={deadRows} />
          </div>
        )}
      </div>
    </div>
  );
}
