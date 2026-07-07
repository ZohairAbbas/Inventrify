import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Text,
  EmptyState,
  Filters,
  ChoiceList,
  BlockStack,
  useIndexResourceState,
  Button,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getStockStatus,
  calculateDaysRemaining,
  calculateReorderPoint,
} from "../lib/forecast.server";
import { StockStatusBadge } from "../components/StockStatusBadge";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") ?? "all";
  const search = url.searchParams.get("search") ?? "";

  const products = await prisma.product.findMany({
    where: {
      shop: session.shop,
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: "insensitive" } },
              { sku: { contains: search, mode: "insensitive" } },
              { variantTitle: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: { supplier: { select: { name: true } } },
    orderBy: { title: "asc" },
  });

  const enriched = products
    .map((p) => ({
      ...p,
      status: getStockStatus(p.currentStock, p.reorderPoint),
      daysRemaining: calculateDaysRemaining(p.currentStock, p.avgDailySales || 0.5),
      displayName: p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title,
    }))
    .filter((p) => statusFilter === "all" || p.status === statusFilter);

  return { products: enriched };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "bulk_create_pos") {
    const productIds = formData.getAll("productIds") as string[];
    if (productIds.length === 0) return { error: "No products selected" };

    for (let i = 0; i < productIds.length; i++) {
      const product = await prisma.product.findUnique({ where: { id: productIds[i] } });
      if (!product) continue;

      const suggestedQty = Math.max(
        10,
        calculateReorderPoint(product.avgDailySales || 1, product.leadTimeDays) * 2 -
          product.currentStock,
      );

      const d = new Date();
      const datePart = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
      const poNumber = `PO-${datePart}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

      await prisma.purchaseOrder.create({
        data: {
          shop: session.shop,
          poNumber,
          supplierId: product.supplierId ?? null,
          totalCost: 0,
          items: {
            create: [{ productId: product.id, quantityOrdered: suggestedQty, unitCost: 0 }],
          },
        },
      });
    }

    return redirect("/app/purchase-orders");
  }

  if (intent === "update_reorder") {
    const productId = formData.get("productId") as string;
    const reorderPoint = parseInt(formData.get("reorderPoint") as string, 10);
    const leadTimeDays = parseInt(formData.get("leadTimeDays") as string, 10);

    if (productId && !isNaN(reorderPoint)) {
      await prisma.product.update({
        where: { id: productId },
        data: { reorderPoint, leadTimeDays: isNaN(leadTimeDays) ? 7 : leadTimeDays },
      });
    }
    return { ok: true };
  }

  return { ok: true };
};

export default function Inventory() {
  const { products } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();
  const [queryValue, setQueryValue] = useState(searchParams.get("search") ?? "");
  const [statusFilter, setStatusFilter] = useState<string[]>(
    searchParams.get("status") ? [searchParams.get("status")!] : [],
  );

  const resourceName = { singular: "product", plural: "products" };
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(products);

  useEffect(() => {
    if (fetcher.data && (fetcher.data as { ok: boolean }).ok) {
      shopify.toast.show("Updated");
    }
  }, [fetcher.data, shopify]);

  const handleFiltersChange = useCallback(
    (value: string[]) => {
      setStatusFilter(value);
      setSearchParams((p) => {
        const next = new URLSearchParams(p);
        if (value.length > 0) next.set("status", value[0]);
        else next.delete("status");
        return next;
      });
    },
    [setSearchParams],
  );

  const handleQueryChange = useCallback(
    (value: string) => {
      setQueryValue(value);
      setSearchParams((p) => {
        const next = new URLSearchParams(p);
        if (value) next.set("search", value);
        else next.delete("search");
        return next;
      });
    },
    [setSearchParams],
  );

  const promotedBulkActions = [
    {
      content: "Generate POs for selected",
      onAction: () => {
        const form = new FormData();
        form.append("intent", "bulk_create_pos");
        selectedResources.forEach((id) => form.append("productIds", id));
        fetcher.submit(form, { method: "POST" });
      },
    },
  ];

  const rowMarkup = products.map((p, idx) => (
    <IndexTable.Row
      id={p.id}
      key={p.id}
      position={idx}
      selected={selectedResources.includes(p.id)}
    >
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="semibold">
          {p.displayName}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>{p.sku ?? "—"}</IndexTable.Cell>
      <IndexTable.Cell>{p.currentStock}</IndexTable.Cell>
      <IndexTable.Cell>{p.reorderPoint}</IndexTable.Cell>
      <IndexTable.Cell>
        {p.daysRemaining > 900 ? "N/A" : `${p.daysRemaining}d`}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {p.avgDailySales > 0 ? p.avgDailySales.toFixed(1) : "—"}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {p.codReturnRate > 0 ? `${(p.codReturnRate * 100).toFixed(0)}%` : "—"}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {p.avgMargin > 0 ? `${(p.avgMargin * 100).toFixed(0)}%` : "—"}
      </IndexTable.Cell>
      <IndexTable.Cell>{p.supplier?.name ?? "—"}</IndexTable.Cell>
      <IndexTable.Cell>
        <StockStatusBadge status={p.status as "healthy" | "low" | "critical" | "stockout"} />
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page fullWidth>
      <TitleBar title="Inventory" />
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <Filters
              queryValue={queryValue}
              queryPlaceholder="Search by product, variant or SKU"
              onQueryChange={handleQueryChange}
              onQueryClear={() => handleQueryChange("")}
              onClearAll={() => {
                handleQueryChange("");
                handleFiltersChange([]);
              }}
              filters={[
                {
                  key: "status",
                  label: "Status",
                  filter: (
                    <ChoiceList
                      title="Status"
                      titleHidden
                      choices={[
                        { label: "Healthy", value: "healthy" },
                        { label: "Low", value: "low" },
                        { label: "Critical", value: "critical" },
                        { label: "Stockout", value: "stockout" },
                      ]}
                      selected={statusFilter}
                      onChange={handleFiltersChange}
                    />
                  ),
                  shortcut: true,
                },
              ]}
              appliedFilters={
                statusFilter.length > 0
                  ? [{ key: "status", label: `Status: ${statusFilter[0]}`, onRemove: () => handleFiltersChange([]) }]
                  : []
              }
            />
            {products.length === 0 ? (
              <EmptyState
                heading="No products found"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Try adjusting your search or filters.</p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={resourceName}
                itemCount={products.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                promotedBulkActions={promotedBulkActions}
                headings={[
                  { title: "Product / Variant" },
                  { title: "SKU" },
                  { title: "Stock" },
                  { title: "Reorder At" },
                  { title: "Days Left" },
                  { title: "Avg Daily Sales" },
                  { title: "COD Return" },
                  { title: "Margin" },
                  { title: "Supplier" },
                  { title: "Status" },
                ]}
              >
                {rowMarkup}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
