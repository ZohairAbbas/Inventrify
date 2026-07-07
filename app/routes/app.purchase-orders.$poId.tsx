import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRouteLoaderData } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { formatCurrency, formatDate } from "../lib/format";
import {
  Page,
  Layout,
  Card,
  DataTable,
  Text,
  Badge,
  BlockStack,
  InlineStack,
  Button,
  Divider,
  TextField,
  Select,
  Banner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.poId, shop: session.shop },
    include: {
      supplier: true,
      items: { include: { product: true } },
    },
  });
  if (!po) throw new Response("Not found", { status: 404 });
  return { po };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.poId, shop },
    include: { items: true },
  });
  if (!po) return { error: "PO not found" };

  if (intent === "mark_sent") {
    if (po.status !== "draft") return { error: "Only draft POs can be marked sent" };
    const expectedDelivery = formData.get("expectedDeliveryDate") as string;
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: {
        status: "sent",
        expectedDeliveryDate: expectedDelivery ? new Date(expectedDelivery) : null,
      },
    });
    return { ok: true, action: "sent" };
  }

  if (intent === "mark_received") {
    if (po.status === "received") return { error: "Already received" };
    const actualDelivery = formData.get("actualDeliveryDate") as string;

    // Update stock for each item using received quantities
    for (const item of po.items) {
      const receivedQty = parseInt(
        (formData.get(`received_${item.id}`) as string) ?? String(item.quantityOrdered),
        10,
      );
      if (isNaN(receivedQty) || receivedQty < 0) continue;

      await prisma.product.update({
        where: { id: item.productId },
        data: { currentStock: { increment: receivedQty } },
      });
      await prisma.purchaseOrderItem.update({
        where: { id: item.id },
        data: { quantityReceived: receivedQty },
      });
    }

    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: {
        status: "received",
        actualDeliveryDate: actualDelivery ? new Date(actualDelivery) : new Date(),
      },
    });

    // Update supplier lead time stats if linked
    if (po.supplierId && po.expectedDeliveryDate) {
      const sentDate =
        po.updatedAt; // approximation — when status was set to sent
      const receivedDate = actualDelivery ? new Date(actualDelivery) : new Date();
      const actualLeadDays = Math.max(
        1,
        Math.round(
          (receivedDate.getTime() - po.createdAt.getTime()) / 86400000,
        ),
      );

      const supplier = await prisma.supplier.findUnique({
        where: { id: po.supplierId },
      });
      if (supplier) {
        const totalPos = supplier.totalPosReceived + 1;
        const currentAvg = supplier.avgActualLeadTime ?? actualLeadDays;
        const newAvg =
          (currentAvg * supplier.totalPosReceived + actualLeadDays) / totalPos;

        // Running variance (Welford's online algorithm approximation)
        const diff = actualLeadDays - newAvg;
        const currentVariance = supplier.leadTimeVariance ?? 0;
        const newVariance = Math.sqrt(
          ((currentVariance * currentVariance * supplier.totalPosReceived +
            diff * diff) /
            totalPos),
        );

        await prisma.supplier.update({
          where: { id: po.supplierId },
          data: {
            totalPosReceived: totalPos,
            avgActualLeadTime: newAvg,
            leadTimeVariance: newVariance,
          },
        });
      }
    }

    return { ok: true, action: "received" };
  }

  return { ok: true };
};

const statusTone: Record<string, "success" | "warning" | "new"> = {
  received: "success",
  sent: "warning",
  draft: "new",
};

export default function PODetail() {
  const { po } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const { timezone = "UTC", currency = "USD" } =
    useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  const [expectedDate, setExpectedDate] = useState(
    po.expectedDeliveryDate
      ? new Date(po.expectedDeliveryDate).toISOString().slice(0, 10)
      : "",
  );
  const [actualDate, setActualDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [receivedQtys, setReceivedQtys] = useState<Record<string, string>>(
    Object.fromEntries(po.items.map((i) => [i.id, String(i.quantityOrdered)])),
  );

  const isBusy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.ok) {
      const msg =
        (fetcher.data as { action?: string }).action === "received"
          ? "PO marked as received — stock updated"
          : "PO updated";
      shopify.toast.show(msg);
    }
    if ((fetcher.data as { error?: string })?.error) {
      shopify.toast.show(
        (fetcher.data as { error: string }).error,
        { isError: true },
      );
    }
  }, [fetcher.data, shopify]);

  const tableRows = po.items.map((item) => {
    const name = item.product.variantTitle
      ? `${item.product.title} — ${item.product.variantTitle}`
      : item.product.title;

    return [
      name,
      item.product.sku ?? "—",
      String(item.quantityOrdered),
      po.status === "sent" ? (
        <TextField
          key={item.id}
          label=""
          labelHidden
          type="number"
          value={receivedQtys[item.id] ?? String(item.quantityOrdered)}
          onChange={(v) =>
            setReceivedQtys((prev) => ({ ...prev, [item.id]: v }))
          }
          autoComplete="off"
          min={0}
        />
      ) : (
        String(item.quantityReceived ?? 0)
      ),
      formatCurrency(item.unitCost, currency),
      formatCurrency(item.quantityOrdered * item.unitCost, currency),
    ];
  });

  return (
    <Page>
      <TitleBar title={`PO ${po.poNumber}`}>
        <button onClick={() => window.print()}>Print / PDF</button>
      </TitleBar>

      <style>{`
        @media print {
          [data-polaris-topbar], nav, [role="navigation"], .Polaris-Frame__Navigation {
            display: none !important;
          }
        }
      `}</style>

      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {(fetcher.data as { error?: string })?.error && (
              <Banner tone="critical">
                {(fetcher.data as { error: string }).error}
              </Banner>
            )}

            {/* PO Header */}
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingLg">
                      {po.poNumber}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Created {formatDate(po.createdAt, timezone)}
                    </Text>
                  </BlockStack>
                  <Badge
                    tone={statusTone[po.status] ?? "new"}
                    size="large"
                  >
                    {po.status.toUpperCase()}
                  </Badge>
                </InlineStack>

                <Divider />

                <InlineStack gap="600" wrap>
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Supplier
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {po.supplier?.name ?? "—"}
                    </Text>
                    {po.supplier?.email && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {po.supplier.email}
                      </Text>
                    )}
                  </BlockStack>
                  {po.expectedDeliveryDate && (
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Expected Delivery
                      </Text>
                      <Text as="p" variant="bodyMd">
                        {formatDate(po.expectedDeliveryDate, timezone)}
                      </Text>
                    </BlockStack>
                  )}
                  {po.actualDeliveryDate && (
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Actual Delivery
                      </Text>
                      <Text as="p" variant="bodyMd">
                        {formatDate(po.actualDeliveryDate, timezone)}
                      </Text>
                    </BlockStack>
                  )}
                  {po.notes && (
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Notes
                      </Text>
                      <Text as="p" variant="bodyMd">
                        {po.notes}
                      </Text>
                    </BlockStack>
                  )}
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Line Items */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Line Items</Text>
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                  ]}
                  headings={[
                    "Product",
                    "SKU",
                    "Qty Ordered",
                    po.status === "sent" ? "Qty Received" : "Qty Received",
                    "Unit Cost",
                    "Line Total",
                  ]}
                  rows={tableRows}
                  totals={[
                    "",
                    "",
                    "",
                    "",
                    "Total",
                    formatCurrency(po.totalCost, currency),
                  ]}
                  showTotalsInFooter
                />
              </BlockStack>
            </Card>

            {/* Actions */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Actions</Text>

                {po.status === "draft" && (
                  <BlockStack gap="300">
                    <TextField
                      label="Expected Delivery Date"
                      type="date"
                      value={expectedDate}
                      onChange={setExpectedDate}
                      autoComplete="off"
                    />
                    <InlineStack>
                      <Button
                        variant="primary"
                        loading={isBusy}
                        onClick={() =>
                          fetcher.submit(
                            { intent: "mark_sent", expectedDeliveryDate: expectedDate },
                            { method: "POST" },
                          )
                        }
                      >
                        Mark as Sent to Supplier
                      </Button>
                    </InlineStack>
                  </BlockStack>
                )}

                {po.status === "sent" && (
                  <BlockStack gap="300">
                    <TextField
                      label="Actual Delivery Date"
                      type="date"
                      value={actualDate}
                      onChange={setActualDate}
                      autoComplete="off"
                    />
                    <Text as="p" variant="bodySm" tone="subdued">
                      Adjust received quantities above if partial delivery. Stock will be updated accordingly.
                    </Text>
                    <InlineStack>
                      <Button
                        variant="primary"
                        loading={isBusy}
                        onClick={() => {
                          const data: Record<string, string> = {
                            intent: "mark_received",
                            actualDeliveryDate: actualDate,
                          };
                          po.items.forEach((item) => {
                            data[`received_${item.id}`] =
                              receivedQtys[item.id] ?? String(item.quantityOrdered);
                          });
                          fetcher.submit(data, { method: "POST" });
                        }}
                      >
                        Confirm Received — Update Stock
                      </Button>
                    </InlineStack>
                  </BlockStack>
                )}

                {po.status === "received" && (
                  <Banner tone="success">
                    This PO was received on{" "}
                    {po.actualDeliveryDate
                      ? formatDate(po.actualDeliveryDate, timezone)
                      : "—"}
                    . Stock has been updated.
                  </Banner>
                )}
              </BlockStack>
            </Card>

            <InlineStack gap="300">
              <Button url="/app/purchase-orders">← Back to Purchase Orders</Button>
              <Button onClick={() => window.print()} variant="secondary">
                Print / PDF
              </Button>
            </InlineStack>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
