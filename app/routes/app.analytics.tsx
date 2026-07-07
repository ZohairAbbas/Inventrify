import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  DataTable,
  Divider,
  Box,
} from "@shopify/polaris";
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const deadStockDays = settings?.deadStockDays ?? 60;
  const deadStockMinUnits = settings?.deadStockMinUnits ?? 20;

  const [trend, comparison, topMovers, deadStock, statusDist, highReturnRate] =
    await Promise.all([
      getSalesTrend(shop, 30),
      getPeriodComparison(shop),
      getTopMovers(shop, 30, 10),
      getDeadStock(shop, deadStockDays, deadStockMinUnits),
      getStatusDistribution(shop),
      getHighReturnRateProducts(shop, 10),
    ]);

  return {
    trend,
    comparison,
    topMovers,
    deadStock,
    statusDist,
    highReturnRate,
  };
};

function MiniBar({
  value,
  max,
  color = "#008060",
}: {
  value: number;
  max: number;
  color?: string;
}) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div
      style={{ background: color, height: 28, width: `${pct}%`, borderRadius: 3, minWidth: value > 0 ? 4 : 0 }}
    />
  );
}

export default function Analytics() {
  const { trend, comparison, topMovers, deadStock, statusDist, highReturnRate } =
    useLoaderData<typeof loader>();

  const maxTrend = Math.max(...trend.map((d) => d.quantity), 1);
  const totalHealthy =
    statusDist.healthy + statusDist.low + statusDist.critical + statusDist.stockout;

  const changeTone =
    comparison.changePct == null
      ? "subdued"
      : comparison.changePct >= 0
        ? "success"
        : "critical";

  const topMoverRows = topMovers.map((m) => [
    m.product.variantTitle
      ? `${m.product.title} — ${m.product.variantTitle}`
      : m.product.title,
    m.product.sku ?? "—",
    String(m.totalSold),
    m.product.avgDailySales.toFixed(1),
    m.product.currentStock > 0 && m.product.avgDailySales > 0
      ? `${Math.floor(m.product.currentStock / m.product.avgDailySales)}d`
      : "—",
  ]);

  const deadStockRows = deadStock.map((p) => [
    p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title,
    p.sku ?? "—",
    String(p.currentStock),
    p.avgMargin > 0 ? `${(p.avgMargin * 100).toFixed(0)}%` : "—",
  ]);

  const returnRateRows = highReturnRate.map((p) => [
    p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title,
    p.sku ?? "—",
    `${(p.codReturnRate * 100).toFixed(0)}%`,
    p.avgDailySales.toFixed(1),
  ]);

  return (
    <Page fullWidth>
      <TitleBar title="Analytics" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">

            {/* KPI Row */}
            <Layout>
              <Layout.Section variant="oneThird">
                <Card>
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued">Units Sold (Last 30d)</Text>
                    <Text as="h2" variant="headingXl">{comparison.currentTotal.toLocaleString()}</Text>
                    {comparison.changePct != null && (
                      <InlineStack gap="100">
                        <Text as="span" variant="bodySm" tone={changeTone}>
                          {comparison.changePct >= 0 ? "+" : ""}
                          {comparison.changePct.toFixed(1)}% vs prior 30d
                        </Text>
                      </InlineStack>
                    )}
                  </BlockStack>
                </Card>
              </Layout.Section>
              <Layout.Section variant="oneThird">
                <Card>
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued">Inventory Health</Text>
                    <Text as="h2" variant="headingXl">{statusDist.healthy}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      healthy · {statusDist.low} low · {statusDist.critical} critical · {statusDist.stockout} out
                    </Text>
                  </BlockStack>
                </Card>
              </Layout.Section>
              <Layout.Section variant="oneThird">
                <Card>
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued">Dead Stock Items</Text>
                    <Text as="h2" variant="headingXl">{deadStock.length}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      products with no recent sales
                    </Text>
                  </BlockStack>
                </Card>
              </Layout.Section>
            </Layout>

            {/* Inventory health bar */}
            {totalHealthy > 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Inventory Health Distribution</Text>
                  <div style={{ display: "flex", height: 32, borderRadius: 6, overflow: "hidden", gap: 2 }}>
                    {statusDist.healthy > 0 && (
                      <div
                        style={{
                          flex: statusDist.healthy,
                          background: "#007f5f",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text as="span" variant="bodySm" tone="text-inverse">{statusDist.healthy} healthy</Text>
                      </div>
                    )}
                    {statusDist.low > 0 && (
                      <div
                        style={{
                          flex: statusDist.low,
                          background: "#ffd79d",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text as="span" variant="bodySm">{statusDist.low} low</Text>
                      </div>
                    )}
                    {statusDist.critical > 0 && (
                      <div
                        style={{
                          flex: statusDist.critical,
                          background: "#f97316",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text as="span" variant="bodySm" tone="text-inverse">{statusDist.critical} critical</Text>
                      </div>
                    )}
                    {statusDist.stockout > 0 && (
                      <div
                        style={{
                          flex: statusDist.stockout,
                          background: "#d72c0d",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Text as="span" variant="bodySm" tone="text-inverse">{statusDist.stockout} out</Text>
                      </div>
                    )}
                  </div>
                </BlockStack>
              </Card>
            )}

            {/* Daily sales trend chart */}
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">Daily Sales — Last 30 Days</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    All products combined
                  </Text>
                </InlineStack>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 80 }}>
                  {trend.map((d) => (
                    <div
                      key={d.date}
                      style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}
                    >
                      <MiniBar value={d.quantity} max={maxTrend} />
                    </div>
                  ))}
                </div>
                <InlineStack align="space-between">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {trend[0]?.date}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {trend[trend.length - 1]?.date}
                  </Text>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Top movers */}
            {topMovers.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Top Movers — Last 30 Days</Text>
                  <DataTable
                    columnContentTypes={["text", "text", "numeric", "numeric", "text"]}
                    headings={["Product", "SKU", "Units Sold", "Daily Avg", "Days Left"]}
                    rows={topMoverRows}
                  />
                </BlockStack>
              </Card>
            )}

            {/* COD return rate leaders */}
            {highReturnRate.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">High COD Return Rates</Text>
                    <Badge tone="warning">Review these products</Badge>
                  </InlineStack>
                  <DataTable
                    columnContentTypes={["text", "text", "numeric", "numeric"]}
                    headings={["Product", "SKU", "Return Rate", "Daily Sales"]}
                    rows={returnRateRows}
                  />
                </BlockStack>
              </Card>
            )}

            {/* Dead stock */}
            {deadStock.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">Dead Stock Candidates</Text>
                    <Badge tone="critical">No recent sales</Badge>
                  </InlineStack>
                  <DataTable
                    columnContentTypes={["text", "text", "numeric", "text"]}
                    headings={["Product", "SKU", "Units on Hand", "Margin"]}
                    rows={deadStockRows}
                  />
                </BlockStack>
              </Card>
            )}

          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
