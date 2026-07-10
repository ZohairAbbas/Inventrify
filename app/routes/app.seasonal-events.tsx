import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Button, Card, DataTable, FormField, PageHead, ProductPicker, TextArea, TextInput, type DataTableColumn } from "../design";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [events, products] = await Promise.all([
    prisma.seasonalEvent.findMany({ where: { shop: session.shop }, orderBy: { startDate: "asc" } }),
    prisma.product.findMany({
      where: { shop: session.shop },
      orderBy: { title: "asc" },
      select: { id: true, title: true, variantTitle: true, sku: true },
    }),
  ]);
  return { events, products };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create") {
    const name = (formData.get("name") as string)?.trim();
    const startDate = formData.get("startDate") as string;
    const endDate = formData.get("endDate") as string;
    const impactMultiplier = parseFloat(formData.get("impactMultiplier") as string);
    const productIds = (formData.getAll("productIds") as string[]).join(",");
    const notes = (formData.get("notes") as string)?.trim() ?? "";

    if (!name || !startDate || !endDate || isNaN(impactMultiplier)) {
      return { error: "Name, start date, end date, and impact are required" };
    }
    if (impactMultiplier <= 0) {
      return { error: "Impact multiplier must be positive" };
    }
    if (new Date(startDate) > new Date(endDate)) {
      return { error: "Start date must be before end date" };
    }

    await prisma.seasonalEvent.create({
      data: { shop, name, startDate: new Date(startDate), endDate: new Date(endDate), impactMultiplier, productIds, notes: notes || null },
    });
    return { ok: true };
  }

  if (intent === "delete") {
    const id = formData.get("id") as string;
    await prisma.seasonalEvent.deleteMany({ where: { id, shop } });
    return { ok: true };
  }

  return { ok: true };
};

function eventStatus(event: { startDate: string; endDate: string }) {
  const now = new Date();
  const start = new Date(event.startDate);
  const end = new Date(event.endDate);
  if (now >= start && now <= end) return "active";
  if (start > now) return "upcoming";
  return "past";
}

const PRESETS = [
  { name: "Eid al-Fitr", multiplier: "1.8" },
  { name: "Eid al-Adha", multiplier: "1.8" },
  { name: "Ramadan", multiplier: "1.4" },
  { name: "Black Friday", multiplier: "2.5" },
  { name: "11.11", multiplier: "2.0" },
  { name: "White Friday", multiplier: "2.2" },
  { name: "Independence Day", multiplier: "1.5" },
  { name: "Back to School", multiplier: "1.5" },
];

export default function SeasonalEvents() {
  const { events, products } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [multiplier, setMultiplier] = useState("1.5");
  const [productIds, setProductIds] = useState<string[]>([]);
  const [notes, setNotes] = useState("");

  const isBusy = fetcher.state !== "idle";
  const result = fetcher.data as Record<string, unknown> | undefined;

  useEffect(() => {
    if (result?.ok) {
      shopify.toast.show("Saved");
      setName("");
      setStartDate("");
      setEndDate("");
      setMultiplier("1.5");
      setProductIds([]);
      setNotes("");
    }
    if (result?.error) {
      shopify.toast.show(String(result.error), { isError: true });
    }
  }, [result, shopify]);

  const activeEvent = events.find((e) => eventStatus(e) === "active");

  const pickerProducts = products.map((p) => ({
    id: p.id,
    label: p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title,
    sku: p.sku,
  }));

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    setName(preset.name);
    setMultiplier(preset.multiplier);
    shopify.toast.show(`Applied preset: ${preset.name} — adjust dates and save`);
  };

  const columns: DataTableColumn[] = [
    { header: "Event", width: "1.6fr" },
    { header: "Start", width: "1fr" },
    { header: "End", width: "1fr" },
    { header: "Multiplier", width: "1fr", align: "right" },
    { header: "Applies to", width: "1.4fr" },
    { header: "", width: ".8fr", align: "right" },
  ];

  const rows = events.map((e) => {
    const status = eventStatus(e);
    const statusColor =
      status === "active" ? "var(--inv-status-healthy-fg)" : status === "upcoming" ? "var(--inv-accent)" : "var(--inv-muted)";
    const scopedCount = e.productIds ? e.productIds.split(",").filter(Boolean).length : 0;
    return {
      key: e.id,
      cells: [
        <div key="name" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontWeight: 600 }}>{e.name}</span>
          <span style={{ fontSize: "10.5px", fontWeight: 600, color: statusColor }}>{status}</span>
        </div>,
        <span key="start" style={{ fontFamily: "var(--inv-font-mono)", color: "var(--inv-text-2)" }}>
          {new Date(e.startDate).toLocaleDateString()}
        </span>,
        <span key="end" style={{ fontFamily: "var(--inv-font-mono)", color: "var(--inv-text-2)" }}>
          {new Date(e.endDate).toLocaleDateString()}
        </span>,
        <span key="mult" style={{ fontFamily: "var(--inv-font-mono)", fontWeight: 600, color: "var(--inv-accent)" }}>
          {e.impactMultiplier}×
        </span>,
        <span key="scope" style={{ color: "var(--inv-text-2)", fontSize: "12.5px" }}>
          {scopedCount > 0 ? `${scopedCount} product${scopedCount !== 1 ? "s" : ""}` : "All products"}
        </span>,
        <button
          key="del"
          onClick={() => fetcher.submit({ intent: "delete", id: e.id }, { method: "POST" })}
          disabled={isBusy}
          style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", padding: "5px 10px", borderRadius: "8px", cursor: "pointer", color: "var(--inv-status-stockout-fg)" }}
        >
          Delete
        </button>,
      ],
    };
  });

  return (
    <div className="inv-root" style={{ minHeight: "100vh" }}>
      <TitleBar title="Seasonal Events" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead eyebrow="Demand multipliers by date range" title="Seasonal Events" />

        {activeEvent && (
          <div
            style={{
              background: "linear-gradient(135deg, var(--inv-accent-soft), #fff)",
              border: "1px solid var(--inv-accent)",
              borderRadius: "14px",
              padding: "16px 18px",
              marginBottom: "16px",
              display: "flex",
              alignItems: "center",
              gap: "14px",
            }}
          >
            <div style={{ width: "40px", height: "40px", borderRadius: "11px", background: "var(--inv-accent)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px" }}>
              ❄
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "14px", fontWeight: 600 }}>
                {activeEvent.name} — {new Date(activeEvent.startDate).toLocaleDateString()} → {new Date(activeEvent.endDate).toLocaleDateString()}
              </div>
              <div style={{ fontSize: "12.5px", color: "var(--inv-text-2)", marginTop: "2px" }}>
                Applies a {activeEvent.impactMultiplier}× demand multiplier to{" "}
                {activeEvent.productIds ? "selected" : "all"} products. Folded into every forecast.
              </div>
            </div>
            <span style={{ fontFamily: "var(--inv-font-mono)", fontSize: "20px", fontWeight: 600, color: "var(--inv-accent)" }}>
              {activeEvent.impactMultiplier}×
            </span>
          </div>
        )}

        <Card style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--inv-text-2)", marginBottom: "10px" }}>Presets — one tap to add</div>
          <div style={{ display: "flex", gap: "9px", flexWrap: "wrap" }}>
            {PRESETS.map((preset) => (
              <button
                key={preset.name}
                onClick={() => applyPreset(preset)}
                style={{
                  fontSize: "12.5px",
                  fontWeight: 500,
                  padding: "8px 14px",
                  borderRadius: "20px",
                  border: "1px dashed var(--inv-input-border-2)",
                  background: "#fff",
                  cursor: "pointer",
                  color: "#5d5a51",
                }}
              >
                + {preset.name}
              </button>
            ))}
          </div>
        </Card>

        <Card style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "4px" }}>Add seasonal event</div>
          <div style={{ fontSize: "12.5px", color: "var(--inv-muted)", marginBottom: "16px" }}>
            Applies a demand multiplier to forecasts during the event period. Scope to specific products, or leave empty to apply to all.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <FormField label="Event name">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Eid ul Fitr, Ramadan, Back to School" />
            </FormField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px" }}>
              <FormField label="Start date">
                <TextInput type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </FormField>
              <FormField label="End date">
                <TextInput type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </FormField>
              <FormField label="Demand multiplier" hint="1.5 = +50% demand">
                <TextInput type="number" min={0.1} step={0.1} value={multiplier} onChange={(e) => setMultiplier(e.target.value)} />
              </FormField>
            </div>
            <FormField label="Products (optional)" hint="Leave empty to apply to all products">
              <ProductPicker products={pickerProducts} selected={productIds} onChange={setProductIds} />
            </FormField>
            <FormField label="Notes (optional)">
              <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </FormField>
            <div>
              <Button
                variant="primary"
                disabled={isBusy || !name || !startDate || !endDate}
                onClick={() => {
                  const fd = new FormData();
                  fd.append("intent", "create");
                  fd.append("name", name);
                  fd.append("startDate", startDate);
                  fd.append("endDate", endDate);
                  fd.append("impactMultiplier", multiplier);
                  fd.append("notes", notes);
                  productIds.forEach((id) => fd.append("productIds", id));
                  fetcher.submit(fd, { method: "POST" });
                }}
              >
                + New event
              </Button>
            </div>
          </div>
        </Card>

        {events.length === 0 ? (
          <Card padding="40px 24px">
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>No seasonal events yet</div>
              <div style={{ fontSize: "13px", color: "var(--inv-muted)" }}>
                Add Eid, Ramadan, Black Friday, or any local demand event to improve your forecast accuracy.
              </div>
            </div>
          </Card>
        ) : (
          <DataTable columns={columns} rows={rows} />
        )}
      </div>
    </div>
  );
}
