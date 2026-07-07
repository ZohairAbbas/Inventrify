import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useLoaderData,
  useSearchParams,
  useFetcher,
  useRevalidator,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  Select,
  InlineStack,
  Badge,
  Banner,
  EmptyState,
  Divider,
  Button,
  Box,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useCallback, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { generateAndSaveForecast } from "../lib/forecast.server";
import { getUpcomingEvents } from "../lib/seasonality.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const selectedProductId = url.searchParams.get("product");

  const products = await prisma.product.findMany({
    where: { shop: session.shop },
    orderBy: { title: "asc" },
  });

  if (products.length === 0)
    return { products: [], selected: null, forecasts: null, upcomingEvents: [] };

  const product =
    products.find((p) => p.id === selectedProductId) ?? products[0];

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

function ForecastBar({
  label,
  gross,
  net,
  max,
  confidence,
  safetyStock,
  eventMultiplier,
}: {
  label: string;
  gross: number;
  net: number;
  max: number;
  confidence: number;
  safetyStock?: number;
  eventMultiplier?: number;
}) {
  const grossPct = max > 0 ? (gross / max) * 100 : 0;
  const netPct = max > 0 ? (net / max) * 100 : 0;

  return (
    <BlockStack gap="150">
      <InlineStack align="space-between">
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          {label}
        </Text>
        <InlineStack gap="200">
          {eventMultiplier && eventMultiplier > 1.01 && (
            <Badge tone="warning">
              {eventMultiplier.toFixed(2)}× seasonal
            </Badge>
          )}
          {safetyStock != null && safetyStock > 0 && (
            <Badge tone="info">+{safetyStock} safety stock</Badge>
          )}
          <Text as="span" variant="bodySm" tone="subdued">
            {net} net / {gross} gross
          </Text>
          <Badge
            tone={
              confidence >= 0.7
                ? "success"
                : confidence >= 0.4
                  ? "warning"
                  : "critical"
            }
          >
            {(confidence * 100).toFixed(0)}% confidence
          </Badge>
        </InlineStack>
      </InlineStack>
      <div
        style={{
          background: "#f6f6f7",
          borderRadius: 6,
          height: 24,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${grossPct}%`,
            background: "#b5b5b5",
            height: "100%",
            position: "absolute",
            left: 0,
          }}
        />
        <div
          style={{
            width: `${netPct}%`,
            background: "#008060",
            height: "100%",
            position: "absolute",
            left: 0,
          }}
        />
      </div>
      <InlineStack gap="300">
        <InlineStack gap="100">
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              background: "#008060",
              borderRadius: 2,
            }}
          />
          <Text as="span" variant="bodySm">
            Net (COD-adjusted)
          </Text>
        </InlineStack>
        <InlineStack gap="100">
          <span
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              background: "#b5b5b5",
              borderRadius: 2,
            }}
          />
          <Text as="span" variant="bodySm">
            Gross demand
          </Text>
        </InlineStack>
      </InlineStack>
    </BlockStack>
  );
}

export default function Forecast() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();

  const isGenerating = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data && (fetcher.data as { ok?: boolean }).ok) {
      // Reload loader data to show freshly saved forecasts from DB
      revalidator.revalidate();
      shopify.toast.show("Forecast updated");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const handleProductChange = useCallback(
    (value: string) => setSearchParams({ product: value }),
    [setSearchParams],
  );

  if (data.products.length === 0) {
    return (
      <Page>
        <TitleBar title="Demand Forecast" />
        <EmptyState
          heading="No products to forecast"
          image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
        >
          <p>Sync your inventory from the Dashboard first.</p>
        </EmptyState>
      </Page>
    );
  }

  const { selected, forecasts, recentSales, upcomingEvents } = data;
  const options = data.products.map((p) => ({
    label: p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title,
    value: p.id,
  }));

  const maxDemand = forecasts
    ? Math.max(
        forecasts.f30.grossDemand,
        forecasts.f60.grossDemand,
        forecasts.f90.grossDemand,
        1,
      )
    : 1;

  return (
    <Page>
      <TitleBar title="Demand Forecast" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {upcomingEvents.length > 0 && (
              <Banner tone="info" title="Upcoming Seasonal Events">
                {upcomingEvents.map((e) => (
                  <p key={e.id}>
                    <strong>{e.name}</strong> —{" "}
                    {new Date(e.startDate).toLocaleDateString()} →{" "}
                    {new Date(e.endDate).toLocaleDateString()} (
                    {e.impactMultiplier}× demand)
                  </p>
                ))}
              </Banner>
            )}

            <Card>
              <BlockStack gap="400">
                <Select
                  label="Select product / variant"
                  options={options}
                  value={selected?.id ?? ""}
                  onChange={handleProductChange}
                />
                {selected && (
                  <Button
                    loading={isGenerating}
                    variant="primary"
                    onClick={() =>
                      fetcher.submit(
                        { productId: selected.id },
                        { method: "POST" },
                      )
                    }
                  >
                    {forecasts ? "Recalculate Forecast" : "Generate Forecast"}
                  </Button>
                )}
              </BlockStack>
            </Card>

            {selected && (
              <>
                {selected.codReturnRate > 0 && (
                  <Banner tone="info" title="COD Adjustment Active">
                    {(selected.codReturnRate * 100).toFixed(0)}% COD return
                    rate applied — net demand is{" "}
                    {((1 - selected.codReturnRate) * 100).toFixed(0)}% of
                    gross. This represents actual stock needed to cover real
                    deliveries.
                  </Banner>
                )}

                {!forecasts && (
                  <Banner
                    tone="warning"
                    title="No forecast generated yet"
                  >
                    Click "Generate Forecast" to calculate demand predictions
                    from order history.
                  </Banner>
                )}

                <Card>
                  <BlockStack gap="500">
                    <InlineStack align="space-between">
                      <BlockStack gap="050">
                        <Text as="h2" variant="headingMd">
                          {selected.variantTitle
                            ? `${selected.title} — ${selected.variantTitle}`
                            : selected.title}
                        </Text>
                        {selected.sku && (
                          <Text as="p" variant="bodySm" tone="subdued">
                            SKU: {selected.sku}
                          </Text>
                        )}
                      </BlockStack>
                      <Badge
                        tone={selected.codReturnRate > 0 ? "info" : "new"}
                      >
                        {selected.codReturnRate > 0
                          ? `${(selected.codReturnRate * 100).toFixed(0)}% return rate`
                          : "No return data"}
                      </Badge>
                    </InlineStack>

                    <Divider />

                    <InlineStack gap="400" wrap>
                      <BlockStack gap="050">
                        <Text as="p" variant="bodySm" tone="subdued">
                          Current Stock
                        </Text>
                        <Text as="p" variant="headingMd">
                          {selected.currentStock}
                        </Text>
                      </BlockStack>
                      <BlockStack gap="050">
                        <Text as="p" variant="bodySm" tone="subdued">
                          Safety Stock
                        </Text>
                        <Text as="p" variant="headingMd">
                          {selected.safetyStock}
                        </Text>
                      </BlockStack>
                      <BlockStack gap="050">
                        <Text as="p" variant="bodySm" tone="subdued">
                          Avg Daily Sales
                        </Text>
                        <Text as="p" variant="headingMd">
                          {selected.avgDailySales.toFixed(1)} units/day
                        </Text>
                      </BlockStack>
                      <BlockStack gap="050">
                        <Text as="p" variant="bodySm" tone="subdued">
                          Sales Last 30d
                        </Text>
                        <Text as="p" variant="headingMd">
                          {recentSales.total} units
                        </Text>
                      </BlockStack>
                      <BlockStack gap="050">
                        <Text as="p" variant="bodySm" tone="subdued">
                          Delivery Rate
                        </Text>
                        <Text as="p" variant="headingMd">
                          {((1 - selected.codReturnRate) * 100).toFixed(0)}%
                        </Text>
                      </BlockStack>
                    </InlineStack>

                    {forecasts && (
                      <>
                        <Divider />
                        <BlockStack gap="400">
                          <ForecastBar
                            label="30-day forecast"
                            gross={forecasts.f30.grossDemand}
                            net={forecasts.f30.netDemand}
                            max={maxDemand}
                            confidence={forecasts.f30.confidence}
                            safetyStock={forecasts.f30.safetyStockUsed}
                            eventMultiplier={forecasts.f30.eventMultiplier}
                          />
                          <ForecastBar
                            label="60-day forecast"
                            gross={forecasts.f60.grossDemand}
                            net={forecasts.f60.netDemand}
                            max={maxDemand}
                            confidence={forecasts.f60.confidence}
                            safetyStock={forecasts.f60.safetyStockUsed}
                            eventMultiplier={forecasts.f60.eventMultiplier}
                          />
                          <ForecastBar
                            label="90-day forecast"
                            gross={forecasts.f90.grossDemand}
                            net={forecasts.f90.netDemand}
                            max={maxDemand}
                            confidence={forecasts.f90.confidence}
                            safetyStock={forecasts.f90.safetyStockUsed}
                            eventMultiplier={forecasts.f90.eventMultiplier}
                          />
                        </BlockStack>
                        <Box paddingBlockStart="200">
                          <Text as="p" variant="bodySm" tone="subdued">
                            Last updated:{" "}
                            {new Date(forecasts.f30.createdAt).toLocaleString()}
                            {forecasts.f30.seasonalityApplied &&
                              " · Seasonality applied"}
                          </Text>
                        </Box>
                      </>
                    )}
                  </BlockStack>
                </Card>
              </>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
