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
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const name = (formData.get("name") as string)?.trim();
  if (!name) return { error: "Supplier name is required" };

  await prisma.supplier.create({
    data: {
      shop: session.shop,
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

export default function NewSupplier() {
  useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("7");
  const [notes, setNotes] = useState("");

  const isBusy = fetcher.state !== "idle";
  const error = (fetcher.data as { error?: string } | undefined)?.error;

  useEffect(() => {
    if (fetcher.data && !error) {
      navigate("/app/suppliers");
    }
  }, [fetcher.data, error, navigate]);

  const handleSubmit = () => {
    fetcher.submit(
      {
        name,
        contactName,
        email,
        phone,
        address,
        leadTimeDays,
        notes,
      },
      { method: "POST" },
    );
  };

  return (
    <Page>
      <TitleBar title="Add Supplier" />
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
                  helpText="Default days from order to delivery for this supplier"
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
                Save Supplier
              </Button>
            </InlineStack>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
