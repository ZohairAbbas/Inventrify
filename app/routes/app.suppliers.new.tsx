import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useNavigate, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Button, Card, FormField, TextArea, TextInput } from "../design";

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
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const { theme = "emerald" } = useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

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
    fetcher.submit({ name, contactName, email, phone, address, leadTimeDays, notes }, { method: "POST" });
  };

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Add Supplier" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        {error && (
          <Card padding="12px 16px" style={{ marginBottom: "16px" }}>
            <span style={{ color: "var(--inv-status-critical-fg)", fontSize: "13px" }}>{error}</span>
          </Card>
        )}
        <Card style={{ marginBottom: "14px" }}>
          <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "16px" }}>Supplier details</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <FormField label="Supplier name *">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} />
            </FormField>
            <FormField label="Contact name">
              <TextInput value={contactName} onChange={(e) => setContactName(e.target.value)} />
            </FormField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <FormField label="Email">
                <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </FormField>
              <FormField label="Phone">
                <TextInput type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </FormField>
            </div>
            <FormField label="Address">
              <TextArea value={address} onChange={(e) => setAddress(e.target.value)} rows={2} />
            </FormField>
            <FormField label="Default lead time (days)" hint="Applied to new products">
              <TextInput type="number" min={1} value={leadTimeDays} onChange={(e) => setLeadTimeDays(e.target.value)} style={{ maxWidth: "160px" }} />
            </FormField>
            <FormField label="Notes">
              <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
            </FormField>
          </div>
        </Card>
        <div style={{ display: "flex", gap: "9px", justifyContent: "flex-end" }}>
          <Link to="/app/suppliers">
            <Button variant="ghost">Cancel</Button>
          </Link>
          <Button variant="primary" disabled={isBusy || !name.trim()} onClick={handleSubmit}>
            Save supplier
          </Button>
        </div>
      </div>
    </div>
  );
}
