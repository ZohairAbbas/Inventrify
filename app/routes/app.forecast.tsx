import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSearchParams, useFetcher, useRevalidator, Link } from "@remix-run/react";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { generateAndSaveForecast } from "../lib/forecast.server";
import { getUpcomingEvents } from "../lib/seasonality.server";
import { Button, Card, ForecastBar, PageHead, Stat, TogglePills } from "../design";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const selectedProductId = url.searchParams.get("product");

  const products = await prisma.product.findMany({
    where: { shop: session.shop },
    orderBy: { title: "asc" },
  });

  if (products.length === 0)
    return { products: [], selected: null, forecasts: null, upcomingEvents: [], recentSales: null };

  const product = products.find((p) => p.id === selectedProductId) ?? products[0];

  const savedForecasts = await prisma.forecast.findMany({
    where: { productId: product.id },
    orderBy: { horizon: "asc" },
  });

  const f30 = savedForecasts.find((f) => f.horizon === 30) ?? null;
  const f60 = savedForecasts.find((f) => f.horizon === 60) ?? null;
  const f90 = savedForecasts.find((f) => f.horizon === 90) ?? null;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentSales = await prisma.salesRecord.aggregate({
    where: { productId: product.id, date: { gte: thirtyDaysAgo } },
    _sum: { quantity: true },
    _count: { id: true },
  });

  const upcomingEvents = await getUpcomingEvents(session.shop, 90);

  return {
    products,
    selected: product,
    forecasts: f30 && f60 && f90 ? { f30, f60, f90 } : null,
    recentSales: {
      total: recentSales._sum.quantity ?? 0,
      days: recentSales._count.id,
    },
    upcomingEvents,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = formData.get("productId") as string;

  const product = await prisma.product.findFirst({
    where: { id: productId, shop: session.shop },
  });
  if (!product) return { error: "Product not found" };

  await generateAndSaveForecast(product.id, session.shop, product.codReturnRate);
  return { ok: true };
};

const HORIZONS = [
  { value: "30", label: "30d" },
  { value: "60", label: "60d" },
  { value: "90", label: "90d" },
];

export default function Forecast() {
  const data = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const [horizon, setHorizon] = useState("30");

  const isGenerating = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data && (fetcher.data as { ok?: boolean }).ok) {
      revalidator.revalidate();
      shopify.toast.show("Forecast updated");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  if (data.products.length === 0) {
    return (
      <div className="inv-root" style={{ minHeight: "100vh" }}>
        <TitleBar title="Demand Forecast" />
        <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
          <PageHead eyebrow="COD-adjusted · the differentiator" title="Demand Forecast" />
          <Card padding="40px 24px">
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>No products to forecast</div>
              <div style={{ fontSize: "13px", color: "var(--inv-muted)" }}>Sync your inventory from the Dashboard first.</div>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  const products = data.products as NonNullable<(typeof data.products)[number]>[];
  const upcomingEvents = data.upcomingEvents as NonNullable<(typeof data.upcomingEvents)[number]>[];
  const { selected, forecasts, recentSales } = data;
  const fc = forecasts ? forecasts[`f${horizon}` as "f30" | "f60" | "f90"] : null;
  const delivery = selected ? Math.round((1 - selected.codReturnRate) * 100) : 0;
  const confColor = fc
    ? fc.confidence >= 0.55
      ? "var(--inv-status-healthy-fg)"
      : fc.confidence >= 0.4
        ? "var(--inv-status-low-fg)"
        : "var(--inv-status-critical-fg)"
    : "var(--inv-muted)";

  return (
    <div className="inv-root" style={{ minHeight: "100vh" }}>
      <TitleBar title="Demand Forecast" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead eyebrow="COD-adjusted · the differentiator" title="Demand Forecast" />

        {upcomingEvents.length > 0 && (
          <Card padding="14px 16px" style={{ marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "6px" }}>Upcoming seasonal events</div>
            {upcomingEvents.map((e) => (
              <div key={e.id} style={{ fontSize: "12.5px", color: "var(--inv-text-2)" }}>
                <b>{e.name}</b> — {new Date(e.startDate).toLocaleDateString()} →{" "}
                {new Date(e.endDate).toLocaleDateString()} ({e.impactMultiplier}× demand)
              </div>
            ))}
          </Card>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "290px 1fr", gap: "14px", alignItems: "start" }}>
          <Card padding="0">
            <div style={{ padding: "13px 15px", borderBottom: "1px solid var(--inv-divider-3)", fontSize: "12px", fontWeight: 600, color: "var(--inv-text-2)" }}>
              Select SKU
            </div>
            <div style={{ maxHeight: "560px", overflowY: "auto" }}>
              {products.map((p) => {
                const on = p.id === selected?.id;
                const name = p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title;
                return (
                  <div
                    key={p.id}
                    onClick={() => setSearchParams({ product: p.id })}
                    style={{
                      padding: "10px 15px",
                      cursor: "pointer",
                      borderLeft: "3px solid " + (on ? "var(--inv-accent)" : "transparent"),
                      background: on ? "var(--inv-accent-soft)" : "transparent",
                    }}
                  >
                    <div style={{ fontSize: "12.5px", fontWeight: on ? 600 : 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {name}
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--inv-muted)", marginTop: "1px" }}>
                      {(p.sku || "—") + " · " + p.currentStock + " in stock"}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {selected && (
            <div>
              <Card padding="20px 22px">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", marginBottom: "16px" }}>
                  <div>
                    <div style={{ fontSize: "17px", fontWeight: 600 }}>
                      {selected.variantTitle ? `${selected.title} — ${selected.variantTitle}` : selected.title}
                    </div>
                    <div style={{ fontSize: "12.5px", color: "var(--inv-muted)", marginTop: "2px" }}>{selected.sku ?? "—"}</div>
                  </div>
                  {selected.codReturnRate > 0 ? (
                    <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--inv-accent)", background: "var(--inv-accent-soft)", padding: "4px 10px", borderRadius: "8px" }}>
                      {delivery}% delivery
                    </span>
                  ) : (
                    <span style={{ fontSize: "11px", color: "var(--inv-muted)", background: "var(--inv-divider-3)", padding: "4px 10px", borderRadius: "8px" }}>
                      No return data
                    </span>
                  )}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: "14px", paddingBottom: "18px", borderBottom: "1px solid var(--inv-divider-3)" }}>
                  <Stat label="Current stock" value={selected.currentStock} />
                  <Stat label="Safety stock" value={selected.safetyStock} />
                  <Stat label="Avg daily" value={`${selected.avgDailySales.toFixed(1)}/d`} />
                  <Stat label="Sales 30d" value={recentSales?.total ?? 0} />
                  <Stat label="Delivery" value={`${delivery}%`} />
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "18px" }}>
                  <TogglePills options={HORIZONS} active={horizon} onChange={setHorizon} />
                  {fc && (
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <span style={{ fontSize: "11.5px", color: "var(--inv-muted)" }}>confidence</span>
                      <span style={{ fontFamily: "var(--inv-font-mono)", fontSize: "15px", fontWeight: 600, color: confColor }}>
                        {(fc.confidence * 100).toFixed(0)}%
                      </span>
                    </div>
                  )}
                </div>

                {!forecasts ? (
                  <div style={{ background: "var(--inv-subtle)", border: "1px solid var(--inv-divider-3)", borderRadius: "12px", padding: "14px 16px", marginTop: "16px", fontSize: "12.5px", color: "var(--inv-text-2)" }}>
                    No forecast generated yet. Click "Generate Forecast" to calculate demand predictions from order history.
                  </div>
                ) : (
                  fc && (
                    <>
                      <ForecastBar gross={fc.grossDemand} net={fc.netDemand} />
                      <div
                        style={{
                          background: "var(--inv-subtle)",
                          border: "1px solid var(--inv-divider-3)",
                          borderRadius: "12px",
                          padding: "14px 16px",
                          marginTop: "16px",
                          fontFamily: "var(--inv-font-mono)",
                          fontSize: "12.5px",
                          color: "#5d5a51",
                          lineHeight: 1.8,
                        }}
                      >
                        <div>
                          {selected.avgDailySales.toFixed(1)} units/day × {horizon} days
                          {fc.eventMultiplier > 1 ? ` × ${fc.eventMultiplier} seasonal` : ""} = {fc.grossDemand} gross
                        </div>
                        <div>
                          {fc.grossDemand} × {delivery}% delivery rate = <b style={{ color: "var(--inv-accent)" }}>{fc.netDemand} net</b>
                        </div>
                        <div>
                          {fc.netDemand} net + {fc.safetyStockUsed} safety ={" "}
                          <b style={{ color: "var(--inv-ink)" }}>{fc.netDemand + fc.safetyStockUsed} to order</b>
                        </div>
                      </div>
                    </>
                  )
                )}

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginTop: "18px", flexWrap: "wrap" }}>
                  <Button
                    variant="primary"
                    disabled={isGenerating}
                    onClick={() => fetcher.submit({ productId: selected.id }, { method: "POST" })}
                  >
                    {isGenerating ? "Generating…" : forecasts ? "Recalculate Forecast" : "Generate Forecast"}
                  </Button>
                  {fc && (
                    <Link to={`/app/purchase-orders/new?product=${selected.id}&qty=${fc.netDemand + fc.safetyStockUsed}`}>
                      <Button variant="accent">Turn forecast into PO →</Button>
                    </Link>
                  )}
                </div>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
