import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useRouteLoaderData } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { formatCurrency } from "../lib/format";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  TextField,
  Select,
  Button,
  DataTable,
  Text,
  InlineStack,
  Divider,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useCallback, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

function generatePoNumber(): string {
  const d = new Date();
  const datePart = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PO-${datePart}-${rand}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const products = await prisma.product.findMany({
    where: { shop: session.shop },
    orderBy: { title: "asc" },
  });

  const suppliers = await prisma.supplier.findMany({
    where: { shop: session.shop },
    orderBy: { name: "asc" },
  });

  return {
    products,
    suppliers,
    prefilledProductId: url.searchParams.get("product"),
    prefilledQty: url.searchParams.get("qty"),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const supplierId = formData.get("supplierId") as string;
  const notes = formData.get("notes") as string;
  const productIds = formData.getAll("productId") as string[];
  const quantities = formData.getAll("quantity") as string[];
  const unitCosts = formData.getAll("unitCost") as string[];

  if (productIds.length === 0) return { error: "Add at least one product" };

  const poNumber = generatePoNumber();

  const items = productIds.map((id, i) => ({
    productId: id,
    quantityOrdered: parseInt(quantities[i] ?? "0", 10),
    unitCost: parseFloat(unitCosts[i] ?? "0"),
  }));

  const totalCost = items.reduce(
    (s, item) => s + item.quantityOrdered * item.unitCost,
    0,
  );

  await prisma.purchaseOrder.create({
    data: {
      shop: session.shop,
      poNumber,
      supplierId: supplierId || null,
      notes: notes || null,
      totalCost,
      items: { create: items },
    },
  });

  return { ok: true };
};

interface LineItem { productId: string; quantity: number; unitCost: number }

export default function NewPurchaseOrder() {
  const { products, suppliers, prefilledProductId, prefilledQty } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const { currency = "USD" } =
    useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  const [supplierId, setSupplierId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineItem[]>(() => {
    if (prefilledProductId) {
      return [{ productId: prefilledProductId, quantity: parseInt(prefilledQty ?? "10", 10), unitCost: 0 }];
    }
    return [{ productId: products[0]?.id ?? "", quantity: 1, unitCost: 0 }];
  });

  const isBusy = fetcher.state !== "idle";
  const error = (fetcher.data as { error?: string } | undefined)?.error;

  // Navigate away on success
  useEffect(() => {
    if (fetcher.data && !error) {
      navigate("/app/purchase-orders");
    }
  }, [fetcher.data, error, navigate]);

  const productOptions = products.map((p) => ({
    label: p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title,
    value: p.id,
  }));

  const supplierOptions = [
    { label: "— No supplier —", value: "" },
    ...suppliers.map((s) => ({ label: s.name, value: s.id })),
  ];

  const addLine = useCallback(() => {
    setLines((l) => [...l, { productId: products[0]?.id ?? "", quantity: 1, unitCost: 0 }]);
  }, [products]);

  const removeLine = useCallback((idx: number) => {
    setLines((l) => l.filter((_, i) => i !== idx));
  }, []);

  const updateLine = useCallback((idx: number, field: keyof LineItem, value: string) => {
    setLines((l) =>
      l.map((line, i) =>
        i === idx
          ? { ...line, [field]: field === "productId" ? value : parseFloat(value) || 0 }
          : line,
      ),
    );
  }, []);

  const handleSubmit = useCallback(() => {
    if (lines.length === 0) return;
    const fd = new FormData();
    fd.append("supplierId", supplierId);
    fd.append("notes", notes);
    lines.forEach((line) => {
      fd.append("productId", line.productId);
      fd.append("quantity", String(line.quantity));
      fd.append("unitCost", String(line.unitCost));
    });
    fetcher.submit(fd, { method: "POST" });
  }, [fetcher, supplierId, notes, lines]);

  const totalCost = lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);

  const tableRows = lines.map((line, idx) => [
    <Select
      key={`p-${idx}`}
      label=""
      labelHidden
      options={productOptions}
      value={line.productId}
      onChange={(v) => updateLine(idx, "productId", v)}
    />,
    <TextField
      key={`q-${idx}`}
      label=""
      labelHidden
      type="number"
      value={String(line.quantity)}
      onChange={(v) => updateLine(idx, "quantity", v)}
      autoComplete="off"
      min={1}
    />,
    <TextField
      key={`c-${idx}`}
      label=""
      labelHidden
      type="number"
      value={String(line.unitCost)}
      onChange={(v) => updateLine(idx, "unitCost", v)}
      prefix="$"
      autoComplete="off"
      min={0}
      step={0.01}
    />,
    formatCurrency(line.quantity * line.unitCost, currency),
    <Button key={`r-${idx}`} tone="critical" size="slim" onClick={() => removeLine(idx)}>
      Remove
    </Button>,
  ]);

  return (
    <Page>
      <TitleBar title="Create Purchase Order" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {error && <Banner tone="critical">{error}</Banner>}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Order Details</Text>
                <Select
                  label="Supplier"
                  options={supplierOptions}
                  value={supplierId}
                  onChange={setSupplierId}
                  helpText="Add suppliers in the Suppliers section"
                />
                <TextField
                  label="Notes"
                  value={notes}
                  onChange={setNotes}
                  autoComplete="off"
                  multiline={2}
                  placeholder="Optional notes for this purchase order"
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">Line Items</Text>
                  <Button onClick={addLine} size="slim">Add Item</Button>
                </InlineStack>
                <DataTable
                  columnContentTypes={["text", "numeric", "numeric", "numeric", "text"]}
                  headings={["Product", "Qty", "Unit Cost", "Line Total", ""]}
                  rows={tableRows}
                />
                <Divider />
                <InlineStack align="end">
                  <Text as="p" variant="headingMd">Total: {formatCurrency(totalCost, currency)}</Text>
                </InlineStack>
              </BlockStack>
            </Card>

            <InlineStack gap="300" align="end">
              <Button url="/app/purchase-orders">Cancel</Button>
              <Button
                variant="primary"
                loading={isBusy}
                onClick={handleSubmit}
                disabled={lines.length === 0}
              >
                Create PO
              </Button>
            </InlineStack>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
