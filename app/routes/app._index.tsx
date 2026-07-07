import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  BlockStack,
  Banner,
  DataTable,
  Card,
  Text,
  EmptyState,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect } from "react";
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
import { MetricCard } from "../components/MetricCard";
import { ReorderSuggestions } from "../components/ReorderSuggestions";
import { StockStatusBadge } from "../components/StockStatusBadge";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const products = await prisma.product.findMany({ where: { shop } });
  const alerts = await getUnreadAlerts(shop);
  const pendingPOs = await prisma.purchaseOrder.count({
    where: { shop, status: { in: ["draft", "sent"] } },
  });

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
      suggestedQty: Math.max(
        10,
        calculateReorderPoint(p.avgDailySales || 1, p.leadTimeDays) * 2 - p.currentStock,
      ),
      status: p.status,
    }));

  return {
    totalSkus: products.length,
    lowStock,
    critical,
    pendingPOs,
    stockStatuses,
    alerts,
    reorderItems,
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
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isSyncing = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data) {
      const d = fetcher.data;
      shopify.toast.show(
        `Synced ${d.synced} variants · ${d.recordsSynced} sales records${d.errors ? ` · ${d.errors} errors` : ""}`,
      );
    }
  }, [fetcher.data, shopify]);

  const tableRows = data.stockStatuses.map((p) => [
    p.displayName,
    p.sku ?? "—",
    String(p.currentStock),
    p.daysRemaining > 900 ? "N/A" : `${p.daysRemaining}d`,
    <StockStatusBadge key={p.id} status={p.status as "healthy" | "low" | "critical" | "stockout"} />,
  ]);

  return (
    <Page>
      <TitleBar title="Inventorify">
        <button
          variant="primary"
          onClick={() => fetcher.submit({}, { method: "POST" })}
          disabled={isSyncing}
        >
          {isSyncing ? "Syncing…" : "Sync Inventory"}
        </button>
      </TitleBar>

      <BlockStack gap="500">
        {data.alerts.length > 0 && (
          <Banner
            title={`${data.alerts.length} active stock alert${data.alerts.length !== 1 ? "s" : ""}`}
            tone="warning"
          >
            <ul>
              {data.alerts.slice(0, 3).map((a) => (
                <li key={a.id}>{a.message}</li>
              ))}
              {data.alerts.length > 3 && <li>…and {data.alerts.length - 3} more</li>}
            </ul>
          </Banner>
        )}

        <Layout>
          <Layout.Section variant="oneQuarter">
            <MetricCard title="Total SKUs" value={data.totalSkus} />
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <MetricCard title="Low Stock" value={data.lowStock} subtitle="Need attention" />
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <MetricCard title="Critical / Stockout" value={data.critical} subtitle="Order now" />
          </Layout.Section>
          <Layout.Section variant="oneQuarter">
            <MetricCard title="Pending POs" value={data.pendingPOs} subtitle="Draft + sent" />
          </Layout.Section>
        </Layout>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Stock Status</Text>
            {data.stockStatuses.length === 0 ? (
              <EmptyState
                heading="No products synced yet"
                action={{
                  content: "Sync Inventory",
                  onAction: () => fetcher.submit({}, { method: "POST" }),
                }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Sync your Shopify inventory to get started.</p>
              </EmptyState>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "numeric", "text", "text"]}
                headings={["Product / Variant", "SKU", "Stock", "Days Left", "Status"]}
                rows={tableRows}
              />
            )}
          </BlockStack>
        </Card>

        <ReorderSuggestions items={data.reorderItems} />
      </BlockStack>
    </Page>
  );
}
