import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  TextField,
  Button,
  InlineStack,
  Text,
  Badge,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const supplier = await prisma.supplier.findFirst({
    where: { id: params.supplierId, shop: session.shop },
    include: {
      products: { select: { id: true, title: true, variantTitle: true, currentStock: true, sku: true } },
      purchaseOrders: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });

  if (!supplier) throw new Response("Not found", { status: 404 });
  return { supplier };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const name = (formData.get("name") as string)?.trim();
  if (!name) return { error: "Supplier name is required" };

  await prisma.supplier.updateMany({
    where: { id: params.supplierId, shop: session.shop },
    data: {
      name,
      contactName: (formData.get("contactName") as string) || null,
      email: (formData.get("email") as string) || null,
      phone: (formData.get("phone") as string) || null,
      address: (formData.get("address") as string) || null,
      leadTimeDays: parseInt(formData.get("leadTimeDays") as string, 10) || 7,
      notes: (formData.get("notes") as string) || null,
    },
  });

  return { ok: true };
};

export default function EditSupplier() {
  const { supplier } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();

  const [name, setName] = useState(supplier.name);
  const [contactName, setContactName] = useState(supplier.contactName ?? "");
  const [email, setEmail] = useState(supplier.email ?? "");
  const [phone, setPhone] = useState(supplier.phone ?? "");
  const [address, setAddress] = useState(supplier.address ?? "");
  const [leadTimeDays, setLeadTimeDays] = useState(String(supplier.leadTimeDays));
  const [notes, setNotes] = useState(supplier.notes ?? "");

  const isBusy = fetcher.state !== "idle";
  const error = (fetcher.data as { error?: string } | undefined)?.error;

  useEffect(() => {
    if (fetcher.data && !error) {
      navigate("/app/suppliers");
    }
  }, [fetcher.data, error, navigate]);

  const handleSubmit = () => {
    fetcher.submit(
      { name, contactName, email, phone, address, leadTimeDays, notes },
      { method: "POST" },
    );
  };

  const poStatusTone: Record<string, "success" | "warning" | "new"> = {
    received: "success",
    sent: "warning",
    draft: "new",
  };

  return (
    <Page>
      <TitleBar title={`Edit — ${supplier.name}`} />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {error && <Banner tone="critical">{error}</Banner>}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Supplier Details</Text>
                <TextField
                  label="Supplier Name"
                  value={name}
                  onChange={setName}
                  autoComplete="off"
                  requiredIndicator
                />
                <TextField
                  label="Contact Name"
                  value={contactName}
                  onChange={setContactName}
                  autoComplete="off"
                />
                <InlineStack gap="400">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Email"
                      value={email}
                      onChange={setEmail}
                      type="email"
                      autoComplete="email"
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Phone"
                      value={phone}
                      onChange={setPhone}
                      type="tel"
                      autoComplete="tel"
                    />
                  </div>
                </InlineStack>
                <TextField
                  label="Address"
                  value={address}
                  onChange={setAddress}
                  autoComplete="off"
                  multiline={2}
                />
                <TextField
                  label="Default Lead Time (days)"
                  value={leadTimeDays}
                  onChange={setLeadTimeDays}
                  type="number"
                  autoComplete="off"
                  min={1}
                />
                <TextField
                  label="Notes"
                  value={notes}
                  onChange={setNotes}
                  autoComplete="off"
                  multiline={3}
                />
              </BlockStack>
            </Card>
            <InlineStack gap="300" align="end">
              <Button url="/app/suppliers">Cancel</Button>
              <Button
                variant="primary"
                loading={isBusy}
                onClick={handleSubmit}
                disabled={!name.trim()}
              >
                Save Changes
              </Button>
            </InlineStack>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Linked Products ({supplier.products.length})
                </Text>
                {supplier.products.length === 0 ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    No products linked to this supplier yet.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {supplier.products.map((p) => (
                      <InlineStack key={p.id} align="space-between">
                        <BlockStack gap="050">
                          <Text as="span" variant="bodySm" fontWeight="semibold">
                            {p.title}{p.variantTitle ? ` — ${p.variantTitle}` : ""}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {p.sku ?? "No SKU"} · {p.currentStock} units
                          </Text>
                        </BlockStack>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Recent POs</Text>
                {supplier.purchaseOrders.length === 0 ? (
                  <Text as="p" variant="bodySm" tone="subdued">No purchase orders yet.</Text>
                ) : (
                  <BlockStack gap="200">
                    {supplier.purchaseOrders.map((po) => (
                      <InlineStack key={po.id} align="space-between">
                        <Button variant="plain" url={`/app/purchase-orders/${po.id}`}>
                          {po.poNumber}
                        </Button>
                        <Badge tone={poStatusTone[po.status] ?? "new"}>{po.status}</Badge>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
