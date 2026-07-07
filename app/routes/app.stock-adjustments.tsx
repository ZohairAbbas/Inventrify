import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  TextField,
  Select,
  Button,
  InlineStack,
  Badge,
  DataTable,
  EmptyState,
  Banner,
  Box,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const REASONS = [
  { label: "Damage / Loss", value: "damage" },
  { label: "Count Correction", value: "count_correction" },
  { label: "Sample / Giveaway", value: "sample" },
  { label: "Customer Return", value: "return" },
  { label: "Other", value: "other" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [products, adjustments] = await Promise.all([
    prisma.product.findMany({
      where: { shop },
      orderBy: { title: "asc" },
      select: { id: true, title: true, variantTitle: true, sku: true, currentStock: true },
    }),
    prisma.stockAdjustment.findMany({
      where: { shop },
      include: { product: { select: { title: true, variantTitle: true, sku: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  return { products, adjustments };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();

  const productId = formData.get("productId") as string;
  const deltaStr = formData.get("delta") as string;
  const reason = formData.get("reason") as string;
  const note = (formData.get("note") as string)?.trim() || null;

  const delta = parseInt(deltaStr, 10);
  if (!productId || isNaN(delta) || delta === 0) {
    return { error: "Product and a non-zero quantity are required" };
  }
  if (!reason) {
    return { error: "Please select a reason" };
  }

  const product = await prisma.product.findFirst({ where: { id: productId, shop } });
  if (!product) return { error: "Product not found" };

  const newStock = product.currentStock + delta;
  if (newStock < 0) {
    return { error: `Cannot remove ${Math.abs(delta)} units — only ${product.currentStock} in stock` };
  }

  await prisma.$transaction([
    prisma.stockAdjustment.create({
      data: { shop, productId, delta, reason, note },
    }),
    prisma.product.update({
      where: { id: productId },
      data: { currentStock: newStock },
    }),
  ]);

  return { ok: true, newStock };
};

export default function StockAdjustments() {
  const { products, adjustments } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("count_correction");
  const [note, setNote] = useState("");

  const isBusy = fetcher.state !== "idle";
  const result = fetcher.data as Record<string, unknown> | undefined;

  useEffect(() => {
    if (result?.ok) {
      shopify.toast.show(`Stock updated — new level: ${result.newStock}`);
      setDelta("");
      setNote("");
    }
    if (result?.error) {
      shopify.toast.show(String(result.error), { isError: true });
    }
  }, [result, shopify]);

  const productOptions = products.map((p) => ({
    label: p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title,
    value: p.id,
  }));

  const selectedProduct = products.find((p) => p.id === productId);
  const deltaNum = parseInt(delta, 10);
  const previewStock =
    selectedProduct && !isNaN(deltaNum)
      ? selectedProduct.currentStock + deltaNum
      : null;

  const adjustmentRows = adjustments.map((a) => [
    a.product.variantTitle
      ? `${a.product.title} — ${a.product.variantTitle}`
      : a.product.title,
    a.product.sku ?? "—",
    <Badge
      key={a.id}
      tone={a.delta > 0 ? "success" : "critical"}
    >
      {a.delta > 0 ? `+${a.delta}` : String(a.delta)}
    </Badge>,
    REASONS.find((r) => r.value === a.reason)?.label ?? a.reason,
    a.note ?? "—",
    new Date(a.createdAt).toLocaleDateString(),
  ]);

  return (
    <Page>
      <TitleBar title="Stock Adjustments" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <Banner tone="info" title="Manual Stock Adjustments">
              Use this to correct stock counts, record damage, returns, or samples.
              All adjustments are logged for audit purposes.
            </Banner>

            {/* Adjustment form */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Record Adjustment</Text>
                <BlockStack gap="300">
                    <Select
                      label="Product"
                      options={productOptions}
                      value={productId}
                      onChange={setProductId}
                    />

                    {selectedProduct && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Current stock: <strong>{selectedProduct.currentStock}</strong>
                        {previewStock != null && previewStock !== selectedProduct.currentStock && (
                          <> → <strong style={{ color: previewStock < 0 ? "#d72c0d" : "#007f5f" }}>
                            {previewStock}
                          </strong></>
                        )}
                      </Text>
                    )}

                    <InlineStack gap="300" wrap={false}>
                      <div style={{ flex: 2 }}>
                        <TextField
                          label="Quantity Change"
                          type="number"
                          value={delta}
                          onChange={setDelta}
                          name="delta"
                          autoComplete="off"
                          helpText="Positive to add, negative to remove (e.g. -5 to remove 5 units)"
                          placeholder="+10 or -5"
                        />
                      </div>
                      <div style={{ flex: 2 }}>
                        <Select
                          label="Reason"
                          options={REASONS}
                          value={reason}
                          onChange={setReason}
                          name="reason"
                        />
                      </div>
                    </InlineStack>

                    <TextField
                      label="Note (optional)"
                      value={note}
                      onChange={setNote}
                      name="note"
                      autoComplete="off"
                      placeholder="e.g. 3 units found damaged in warehouse"
                      multiline={2}
                    />

                    <InlineStack>
                      <Button
                        variant="primary"
                        loading={isBusy}
                        disabled={!delta || delta === "0"}
                        onClick={() =>
                          fetcher.submit(
                            { productId, delta, reason, note },
                            { method: "POST" },
                          )
                        }
                      >
                        Apply Adjustment
                      </Button>
                    </InlineStack>
                  </BlockStack>
              </BlockStack>
            </Card>

            {/* Adjustment history */}
            <Card padding="0">
              <Box padding="400">
                <Text as="h2" variant="headingMd">Adjustment History</Text>
              </Box>
              {adjustments.length === 0 ? (
                <EmptyState
                  heading="No adjustments yet"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>Record your first adjustment above.</p>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "numeric",
                    "text",
                    "text",
                    "text",
                  ]}
                  headings={["Product", "SKU", "Change", "Reason", "Note", "Date"]}
                  rows={adjustmentRows}
                />
              )}
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
