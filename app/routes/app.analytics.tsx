import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getSalesTrend,
  getPeriodComparison,
  getTopMovers,
  getDeadStock,
  getStatusDistribution,
  getHighReturnRateProducts,
} from "../lib/analytics.server";
import prisma from "../db.server";
import { BarChart, Card, DataTable, KpiCard, Pill, type DataTableColumn } from "../design";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const deadStockDays = settings?.deadStockDays ?? 60;
  const deadStockMinUnits = settings?.deadStockMinUnits ?? 20;

  const [trend, comparison, topMovers, deadStock, statusDist, highReturnRate] = await Promise.all([
    getSalesTrend(shop, 30),
    getPeriodComparison(shop),
    getTopMovers(shop, 30, 10),
    getDeadStock(shop, deadStockDays, deadStockMinUnits),
    getStatusDistribution(shop),
    getHighReturnRateProducts(shop, 10),
  ]);

  return { trend, comparison, topMovers, deadStock, statusDist, highReturnRate };
};

const SEGMENT_COLORS: Record<string, string> = {
  healthy: "var(--inv-status-healthy-dot)",
  low: "#c9a227",
  critical: "var(--inv-status-critical-dot)",
  stockout: "var(--inv-status-stockout-dot)",
};

export default function Analytics() {
  const { trend, comparison, topMovers, deadStock, statusDist, highReturnRate } = useLoaderData<typeof loader>();

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
    <div className="inv-root" style={{ minHeight: "100vh" }}>
      <TitleBar title="Analytics" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <div style={{ fontFamily: "var(--inv-font-mono)", fontSize: "11px", letterSpacing: "1px", color: "var(--inv-muted)", textTransform: "uppercase", marginBottom: "6px" }}>
          Inventory intelligence
        </div>
        <h1 style={{ margin: "0 0 18px", fontSize: "25px", fontWeight: 600, letterSpacing: "-.5px" }}>Analytics</h1>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "12px", marginBottom: "14px" }}>
          <KpiCard
            label="Units sold — 30d"
            value={comparison.currentTotal.toLocaleString()}
            sub={comparison.changePct != null ? `${comparison.changePct >= 0 ? "+" : ""}${comparison.changePct.toFixed(1)}% vs prior 30d` : undefined}
            valueColor={comparison.changePct != null ? changeColor : undefined}
          />
          <KpiCard
            label="Inventory health"
            value={statusDist.healthy}
            sub={`${statusDist.healthy} healthy · ${statusDist.low} low · ${statusDist.critical} crit · ${statusDist.stockout} out`}
          />
          <KpiCard label="Dead stock items" value={deadStock.length} sub="products with no recent sales" valueColor="var(--inv-status-critical-fg)" />
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
            <div style={{ fontSize: "14px", fontWeight: 600 }}>Daily sales — last 30 days</div>
            <span style={{ fontSize: "11.5px", color: "var(--inv-muted)" }}>all products combined</span>
          </div>
          <BarChart values={trend.map((d) => d.quantity)} labels={[trend[0]?.date ?? "", trend[trend.length - 1]?.date ?? ""]} />
        </Card>

        {topMovers.length > 0 && (
          <div style={{ marginBottom: "14px" }}>
            <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "10px" }}>Top movers — last 30 days</div>
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
