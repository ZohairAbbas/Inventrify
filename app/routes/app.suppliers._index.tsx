import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Text,
  EmptyState,
  Button,
  Badge,
  InlineStack,
  BlockStack,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const suppliers = await prisma.supplier.findMany({
    where: { shop: session.shop },
    include: { _count: { select: { products: true, purchaseOrders: true } } },
    orderBy: { name: "asc" },
  });
  return { suppliers };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const supplierId = formData.get("supplierId") as string;

  if (supplierId) {
    // Unlink products before deleting
    await prisma.product.updateMany({
      where: { shop: session.shop, supplierId },
      data: { supplierId: null },
    });
    await prisma.purchaseOrder.updateMany({
      where: { shop: session.shop, supplierId },
      data: { supplierId: null },
    });
    await prisma.supplier.delete({ where: { id: supplierId } });
  }

  return { ok: true };
};

export default function Suppliers() {
  const { suppliers } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Supplier deleted");
  }, [fetcher.data, shopify]);

  const rowMarkup = suppliers.map((s, idx) => (
    <IndexTable.Row id={s.id} key={s.id} position={idx}>
      <IndexTable.Cell>
        <Button variant="plain" url={`/app/suppliers/${s.id}`}>
          <Text as="span" fontWeight="semibold">{s.name}</Text>
        </Button>
      </IndexTable.Cell>
      <IndexTable.Cell>{s.contactName ?? "—"}</IndexTable.Cell>
      <IndexTable.Cell>{s.email ?? "—"}</IndexTable.Cell>
      <IndexTable.Cell>{s.phone ?? "—"}</IndexTable.Cell>
      <IndexTable.Cell>{s.leadTimeDays}d</IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200">
          <Badge tone="info">{s._count.products} products</Badge>
          <Badge>{s._count.purchaseOrders} POs</Badge>
        </InlineStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200">
          <Button size="slim" url={`/app/suppliers/${s.id}`}>Edit</Button>
          <Button
            size="slim"
            tone="critical"
            loading={fetcher.state !== "idle"}
            onClick={() => fetcher.submit({ supplierId: s.id }, { method: "POST" })}
          >
            Delete
          </Button>
        </InlineStack>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page>
      <TitleBar title="Suppliers">
        <button variant="primary" onClick={() => navigate("/app/suppliers/new")}>Add Supplier</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <Card padding="0">
            {suppliers.length === 0 ? (
              <EmptyState
                heading="No suppliers yet"
                action={{ content: "Add Supplier", url: "/app/suppliers/new" }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>Add your suppliers to link them to products and purchase orders.</p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "supplier", plural: "suppliers" }}
                itemCount={suppliers.length}
                headings={[
                  { title: "Name" },
                  { title: "Contact" },
                  { title: "Email" },
                  { title: "Phone" },
                  { title: "Lead Time" },
                  { title: "Linked" },
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
