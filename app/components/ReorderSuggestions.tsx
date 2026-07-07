import { Card, DataTable, Text, BlockStack, EmptyState, Button, InlineStack } from "@shopify/polaris";
import { Link } from "@remix-run/react";

interface ReorderItem {
  productId: string;
  title: string;
  sku: string | null;
  currentStock: number;
  reorderPoint: number;
  suggestedQty: number;
  status: string;
}

interface Props {
  items: ReorderItem[];
}

export function ReorderSuggestions({ items }: Props) {
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState
          heading="No reorder suggestions"
          image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
        >
          <p>All your products are sufficiently stocked.</p>
        </EmptyState>
      </Card>
    );
  }

  const rows = items.map((item) => [
    item.title,
    item.sku ?? "—",
    String(item.currentStock),
    String(item.reorderPoint),
    <Text as="span" fontWeight="bold" tone="caution">
      {item.suggestedQty} units
    </Text>,
    <Link to={`/app/purchase-orders/new?product=${item.productId}&qty=${item.suggestedQty}`}>
      <Button size="slim" variant="primary">Create PO</Button>
    </Link>,
  ]);

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between">
          <Text as="h2" variant="headingMd">
            Reorder Suggestions
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {items.length} SKU{items.length !== 1 ? "s" : ""} need restocking
          </Text>
        </InlineStack>
        <DataTable
          columnContentTypes={["text", "text", "numeric", "numeric", "text", "text"]}
          headings={["Product", "SKU", "Stock", "Reorder At", "Suggested Qty", "Action"]}
          rows={rows}
        />
      </BlockStack>
    </Card>
  );
}
