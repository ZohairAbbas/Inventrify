import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useRouteLoaderData } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { formatCurrency, formatDate } from "../lib/format";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Text,
  Badge,
  Button,
  EmptyState,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const pos = await prisma.purchaseOrder.findMany({
    where: { shop: session.shop },
    include: {
      supplier: { select: { name: true } },
      items: { include: { product: { select: { title: true, variantTitle: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
  return { pos };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const poId = formData.get("poId") as string;

  if (intent === "mark_received" && poId) {
    const po = await prisma.purchaseOrder.findFirst({
      where: { id: poId, shop: session.shop },
      include: { items: true },
    });

    if (po && po.status !== "received") {
      for (const item of po.items) {
        await prisma.product.update({
          where: { id: item.productId },
          data: { currentStock: { increment: item.quantityOrdered } },
        });
      }
      await prisma.purchaseOrder.update({
        where: { id: poId },
        data: { status: "received" },
      });
    }
  }

  if (intent === "mark_sent" && poId) {
    await prisma.purchaseOrder.updateMany({
      where: { id: poId, shop: session.shop, status: "draft" },
      data: { status: "sent" },
    });
  }

  if (intent === "delete" && poId) {
    await prisma.purchaseOrder.deleteMany({
      where: { id: poId, shop: session.shop, status: "draft" },
    });
  }

  return { ok: true };
};

const statusTone: Record<string, "success" | "warning" | "info" | "new"> = {
  received: "success",
  sent: "warning",
  draft: "new",
};

export default function PurchaseOrders() {
  const { pos } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const { timezone = "UTC", currency = "USD" } =
    useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Purchase order updated");
  }, [fetcher.data, shopify]);

  const submit = (data: Record<string, string>) =>
    fetcher.submit(data, { method: "POST" });

  const rowMarkup = pos.map((po, idx) => (
    <IndexTable.Row id={po.id} key={po.id} position={idx}>
      <IndexTable.Cell>
        <Button variant="plain" url={`/app/purchase-orders/${po.id}`}>
          <Text as="span" fontWeight="semibold">{po.poNumber}</Text>
        </Button>
      </IndexTable.Cell>
      <IndexTable.Cell>{po.supplier?.name ?? "—"}</IndexTable.Cell>
      <IndexTable.Cell>{po.items.length}</IndexTable.Cell>
      <IndexTable.Cell>{formatCurrency(po.totalCost, currency)}</IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={statusTone[po.status] ?? "new"}>{po.status}</Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {formatDate(po.createdAt, timezone)}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200">
          <Button size="slim" url={`/app/purchase-orders/${po.id}`}>View</Button>
          {po.status === "draft" && (
            <Button
              size="slim"
              loading={fetcher.state !== "idle"}
              onClick={() => submit({ intent: "mark_sent", poId: po.id })}
            >
              Mark Sent
            </Button>
          )}
          {po.status === "sent" && (
            <Button
              size="slim"
              variant="primary"
              loading={fetcher.state !== "idle"}
              onClick={() => submit({ intent: "mark_received", poId: po.id })}
            >
              Mark Received
            </Button>
          )}
          {po.status === "draft" && (
            <Button
              size="slim"
              tone="critical"
              loading={fetcher.state !== "idle"}
              onClick={() => submit({ intent: "delete", poId: po.id })}
            >
              Delete
            </Button>
          )}
        </InlineStack>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page>
      <TitleBar title="Purchase Orders">
        <button variant="primary" onClick={() => navigate("/app/purchase-orders/new")}>Create PO</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <Card padding="0">
            {pos.length === 0 ? (
              <EmptyState
                heading="No purchase orders yet"
                action={{ content: "Create PO", url: "/app/purchase-orders/new" }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Create a PO from reorder suggestions on the Dashboard, or manually here.</p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "purchase order", plural: "purchase orders" }}
                itemCount={pos.length}
                headings={[
                  { title: "PO Number" },
                  { title: "Supplier" },
                  { title: "Items" },
                  { title: "Total Cost" },
                  { title: "Status" },
                  { title: "Created" },
                  { title: "Actions" },
                ]}
                selectable={false}
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
