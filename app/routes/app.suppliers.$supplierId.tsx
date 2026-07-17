import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Button, Card, FormField, POStatusPill, TextArea, TextInput } from "../design";

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
  const { theme = "emerald" } = useRouteLoaderData<typeof appLoader>("routes/app") ?? {};
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
    fetcher.submit({ name, contactName, email, phone, address, leadTimeDays, notes }, { method: "POST" });
  };

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title={`Edit — ${supplier.name}`} />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "14px", alignItems: "start" }}>
          <div>
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
                <FormField label="Default lead time (days)">
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
                Save changes
              </Button>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <Card>
              <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "10px" }}>
                Linked products ({supplier.products.length})
              </div>
              {supplier.products.length === 0 ? (
                <div style={{ fontSize: "12.5px", color: "var(--inv-muted)" }}>No products linked to this supplier yet.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {supplier.products.map((p) => (
                    <div key={p.id}>
                      <div style={{ fontSize: "12.5px", fontWeight: 600 }}>
                        {p.title}
                        {p.variantTitle ? ` — ${p.variantTitle}` : ""}
                      </div>
                      <div style={{ fontSize: "11.5px", color: "var(--inv-muted)" }}>
                        {p.sku ?? "No SKU"} · {p.currentStock} units
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "10px" }}>Recent POs</div>
              {supplier.purchaseOrders.length === 0 ? (
                <div style={{ fontSize: "12.5px", color: "var(--inv-muted)" }}>No purchase orders yet.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {supplier.purchaseOrders.map((po) => (
                    <div key={po.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <Link to={`/app/purchase-orders/${po.id}`} style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12.5px", fontWeight: 600, color: "var(--inv-accent)" }}>
                        {po.poNumber}
                      </Link>
                      <POStatusPill status={po.status} />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
