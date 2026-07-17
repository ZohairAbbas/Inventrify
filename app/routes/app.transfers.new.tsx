import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useCallback, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Button, Card, PageHead, SelectInput, TextArea, TextInput } from "../design";

function generateTransferNumber(): string {
  const d = new Date();
  const datePart = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TR-${datePart}-${rand}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [products, locations] = await Promise.all([
    prisma.product.findMany({ where: { shop: session.shop }, orderBy: { title: "asc" } }),
    prisma.location.findMany({
      where: { shop: session.shop, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  return { products, locations };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const fromLocationId = formData.get("fromLocationId") as string;
  const toLocationId = formData.get("toLocationId") as string;
  const notes = (formData.get("notes") as string)?.trim() || null;
  const productIds = formData.getAll("productId") as string[];
  const quantities = formData.getAll("quantity") as string[];

  if (!fromLocationId || !toLocationId) return { error: "Pick both a source and destination location" };
  if (fromLocationId === toLocationId) return { error: "Source and destination must be different locations" };
  if (productIds.length === 0) return { error: "Add at least one product" };

  const items = productIds
    .map((id, i) => ({ productId: id, quantitySent: parseInt(quantities[i] ?? "0", 10) }))
    .filter((it) => it.quantitySent > 0);

  if (items.length === 0) return { error: "Each line must have a quantity greater than zero" };

  await prisma.stockTransfer.create({
    data: {
      shop: session.shop,
      transferNumber: generateTransferNumber(),
      status: "draft",
      fromLocationId,
      toLocationId,
      notes,
      items: { create: items },
    },
  });

  return { ok: true };
};

interface LineItem {
  productId: string;
  quantity: number;
}

export default function NewStockTransfer() {
  const { products, locations } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const { theme = "emerald" } = useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  const [fromLocationId, setFromLocationId] = useState(locations[0]?.id ?? "");
  const [toLocationId, setToLocationId] = useState(locations[1]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineItem[]>([{ productId: products[0]?.id ?? "", quantity: 1 }]);

  const isBusy = fetcher.state !== "idle";
  const error = (fetcher.data as { error?: string } | undefined)?.error;

  useEffect(() => {
    if (fetcher.data && !error) {
      navigate("/app/transfers");
    }
  }, [fetcher.data, error, navigate]);

  const addLine = useCallback(() => {
    setLines((l) => [...l, { productId: products[0]?.id ?? "", quantity: 1 }]);
  }, [products]);

  const removeLine = useCallback((idx: number) => {
    setLines((l) => l.filter((_, i) => i !== idx));
  }, []);

  const updateLine = useCallback((idx: number, field: keyof LineItem, value: string) => {
    setLines((l) =>
      l.map((line, i) =>
        i === idx ? { ...line, [field]: field === "productId" ? value : parseInt(value, 10) || 0 } : line,
      ),
    );
  }, []);

  const sameLocation = !!fromLocationId && fromLocationId === toLocationId;

  const handleSubmit = useCallback(() => {
    if (lines.length === 0) return;
    const fd = new FormData();
    fd.append("fromLocationId", fromLocationId);
    fd.append("toLocationId", toLocationId);
    fd.append("notes", notes);
    lines.forEach((line) => {
      fd.append("productId", line.productId);
      fd.append("quantity", String(line.quantity));
    });
    fetcher.submit(fd, { method: "POST" });
  }, [fetcher, fromLocationId, toLocationId, notes, lines]);

  const totalUnits = lines.reduce((s, l) => s + l.quantity, 0);

  if (locations.length < 2) {
    return (
      <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
        <TitleBar title="New Stock Transfer" />
        <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
          <PageHead eyebrow="New" title="New Stock Transfer" />
          <Card padding="40px 24px">
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>Need at least two locations</div>
              <div style={{ fontSize: "13px", color: "var(--inv-muted)", marginBottom: "16px" }}>
                Stock transfers move inventory between two locations. Add or sync a second location in Shopify first.
              </div>
              <Link to="/app/transfers"><Button variant="ghost">← Back to transfers</Button></Link>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="New Stock Transfer" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead eyebrow="New" title="New Stock Transfer" />

        {error && (
          <Card padding="12px 16px" style={{ marginBottom: "16px" }}>
            <span style={{ color: "var(--inv-status-critical-fg)", fontSize: "13px" }}>{error}</span>
          </Card>
        )}

        <Card style={{ marginBottom: "14px" }}>
          <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "16px" }}>Transfer details</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div>
              <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>From location</label>
              <SelectInput value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </SelectInput>
            </div>
            <div>
              <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>To location</label>
              <SelectInput value={toLocationId} onChange={(e) => setToLocationId(e.target.value)}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </SelectInput>
            </div>
          </div>
          {sameLocation && (
            <div style={{ fontSize: "11.5px", color: "var(--inv-status-critical-fg)", marginTop: "8px" }}>
              Source and destination must be different locations.
            </div>
          )}
          <div style={{ marginTop: "16px" }}>
            <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>Notes</label>
            <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Optional notes for this transfer" />
          </div>
        </Card>

        <Card style={{ marginBottom: "14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div style={{ fontSize: "15px", fontWeight: 600 }}>Line items</div>
            <Button variant="ghost" onClick={addLine}>+ Add item</Button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {lines.map((line, idx) => (
              <div key={idx} style={{ display: "grid", gridTemplateColumns: "3fr 1fr auto", gap: "10px", alignItems: "center" }}>
                <SelectInput value={line.productId} onChange={(e) => updateLine(idx, "productId", e.target.value)}>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>{p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title}</option>
                  ))}
                </SelectInput>
                <TextInput
                  type="number"
                  min={1}
                  value={line.quantity}
                  onChange={(e) => updateLine(idx, "quantity", e.target.value)}
                />
                <button
                  onClick={() => removeLine(idx)}
                  style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-status-stockout-fg)", padding: "6px 10px", borderRadius: "8px", cursor: "pointer" }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div style={{ height: "1px", background: "var(--inv-divider)", margin: "16px 0" }} />
          <div style={{ textAlign: "right", fontSize: "15px", fontWeight: 600 }}>
            Total units: <span style={{ fontFamily: "var(--inv-font-mono)" }}>{totalUnits}</span>
          </div>
        </Card>

        <div style={{ display: "flex", gap: "9px", justifyContent: "flex-end" }}>
          <Link to="/app/transfers">
            <Button variant="ghost">Cancel</Button>
          </Link>
          <Button variant="primary" disabled={isBusy || lines.length === 0 || sameLocation} onClick={handleSubmit}>
            Create transfer
          </Button>
        </div>
      </div>
    </div>
  );
}
