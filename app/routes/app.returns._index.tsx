import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { formatDate } from "../lib/format";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { applyStockDelta } from "../lib/stock.server";
import {
  Button,
  Card,
  DataTable,
  FilterChips,
  PageHead,
  Pill,
  SelectInput,
  type DataTableColumn,
} from "../design";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [returns, locations, settings] = await Promise.all([
    prisma.returnItem.findMany({
      where: { shop },
      include: { product: { select: { id: true, title: true, variantTitle: true } } },
      orderBy: [{ status: "asc" }, { returnReceivedAt: "desc" }],
    }),
    prisma.location.findMany({
      where: { shop, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    }),
    prisma.shopSettings.findUnique({ where: { shop }, select: { courierifyApiKey: true } }),
  ]);

  return { returns, locations, courierifyConnected: !!settings?.courierifyApiKey };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Resolve one or many return items. "restock" adds units back at the chosen location
  // via a StockAdjustment(reason="return"); "writeoff" records a damage adjustment (which
  // also feeds the Damaged pipeline tally). Both go through the audited, Shopify-synced path.
  if (intent === "restock" || intent === "writeoff") {
    const ids = formData.getAll("returnId") as string[];
    const locationId = (formData.get("locationId") as string) || null;
    if (ids.length === 0) return { intent, error: "No returns selected" };

    const items = await prisma.returnItem.findMany({
      where: { id: { in: ids }, shop, status: "pending" },
    });
    if (items.length === 0) return { intent, error: "Nothing to resolve" };

    let resolved = 0;
    const errors: string[] = [];

    for (const item of items) {
      if (!item.productId) {
        errors.push(`${item.sku}: no matching product`);
        continue;
      }
      if (intent === "restock") {
        const result = await applyStockDelta(
          admin,
          shop,
          item.productId,
          item.quantity,
          "return",
          `Return restocked — order ${item.shopifyOrderName ?? item.shipmentId}`,
          locationId,
        );
        if ("error" in result) {
          errors.push(`${item.sku}: ${result.error}`);
          continue;
        }
      }
      // Write-off records no stock movement (the returned unit never re-entered
      // sellable stock). It is simply marked written_off below; the Damaged pipeline
      // tally counts written-off return quantities directly (see inventory loader).

      await prisma.returnItem.update({
        where: { id: item.id },
        data: {
          status: intent === "restock" ? "restocked" : "written_off",
          locationId,
          resolvedAt: new Date(),
        },
      });
      resolved += 1;
    }

    return { intent, ok: true, resolved, errors };
  }

  return { intent, error: "Unknown action" };
};

const STATUS_TABS = [
  { value: "pending", label: "Pending" },
  { value: "restocked", label: "Restocked" },
  { value: "written_off", label: "Written off" },
  { value: "all", label: "All" },
];

const RETURN_PILL: Record<string, { bg: string; fg: string }> = {
  pending: { bg: "var(--inv-status-low-bg)", fg: "var(--inv-status-low-fg)" },
  restocked: { bg: "var(--inv-status-healthy-bg)", fg: "var(--inv-status-healthy-fg)" },
  written_off: { bg: "var(--inv-divider-3)", fg: "var(--inv-text-2)" },
};

export default function ReturnsQueue() {
  const { returns, locations, courierifyConnected } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const { timezone = "UTC", theme = "emerald" } =
    useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  const [filter, setFilter] = useState("pending");
  const [selected, setSelected] = useState<string[]>([]);
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");

  useEffect(() => {
    const r = fetcher.data as { intent?: string; ok?: boolean; error?: string; resolved?: number; errors?: string[] } | undefined;
    if (!r) return;
    if (r.error) {
      shopify.toast.show(r.error, { isError: true });
      return;
    }
    if (r.ok) {
      const errSuffix = r.errors && r.errors.length > 0 ? ` (${r.errors.length} failed)` : "";
      shopify.toast.show(`${r.resolved ?? 0} return${(r.resolved ?? 0) === 1 ? "" : "s"} resolved${errSuffix}`);
      setSelected([]);
    }
  }, [fetcher.data, shopify]);

  const list = returns.filter((r) => filter === "all" || r.status === filter);
  const pendingIds = list.filter((r) => r.status === "pending").map((r) => r.id);
  const allPendingSelected = pendingIds.length > 0 && pendingIds.every((id) => selected.includes(id));

  const toggleOne = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const toggleAll = () =>
    setSelected(allPendingSelected ? [] : pendingIds);

  const resolve = (intent: "restock" | "writeoff", ids: string[]) => {
    if (ids.length === 0) return;
    const form = new FormData();
    form.append("intent", intent);
    form.append("locationId", locationId);
    ids.forEach((id) => form.append("returnId", id));
    fetcher.submit(form, { method: "POST" });
  };

  const columns: DataTableColumn[] = [
    { header: "", width: "34px" },
    { header: "Order", width: "1fr" },
    { header: "Product", width: "2.2fr" },
    { header: "SKU", width: "1fr" },
    { header: "Qty", width: ".5fr", align: "right" },
    { header: "Reason", width: "1.1fr" },
    { header: "Received", width: "1fr" },
    { header: "Status", width: ".9fr" },
    { header: "", width: "1.8fr", align: "right" },
  ];

  const rows = list.map((r) => {
    const displayName = r.product
      ? r.product.variantTitle
        ? `${r.product.title} — ${r.product.variantTitle}`
        : r.product.title
      : <span style={{ color: "var(--inv-status-stockout-fg)" }}>Unmatched SKU</span>;
    const pill = RETURN_PILL[r.status] ?? RETURN_PILL.pending;
    return {
      key: r.id,
      cells: [
        r.status === "pending" ? (
          <input
            key="check"
            type="checkbox"
            checked={selected.includes(r.id)}
            onChange={() => toggleOne(r.id)}
          />
        ) : (
          <span key="check" />
        ),
        <span key="order" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12.5px", color: "var(--inv-text-2)" }}>
          {r.shopifyOrderName ?? "—"}
        </span>,
        <span key="name" style={{ fontWeight: 500 }}>{displayName}</span>,
        <span key="sku" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12px", color: "var(--inv-text-2)" }}>{r.sku}</span>,
        <span key="qty" style={{ fontFamily: "var(--inv-font-mono)" }}>{r.quantity}</span>,
        <span key="reason" style={{ fontSize: "12px", color: "var(--inv-muted)" }}>{r.reasonCategory ?? "—"}</span>,
        <span key="received" style={{ fontSize: "12px", color: "var(--inv-muted)" }}>
          {r.returnReceivedAt ? formatDate(r.returnReceivedAt, timezone) : "—"}
        </span>,
        <Pill key="status" label={r.status.replace("_", " ")} bg={pill.bg} fg={pill.fg} />,
        r.status === "pending" ? (
          <div key="actions" style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
            <button
              onClick={() => resolve("restock", [r.id])}
              disabled={fetcher.state !== "idle" || !r.productId}
              style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-status-healthy-fg)", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}
            >
              Restock
            </button>
            <button
              onClick={() => resolve("writeoff", [r.id])}
              disabled={fetcher.state !== "idle" || !r.productId}
              style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-status-stockout-fg)", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}
            >
              Write off
            </button>
          </div>
        ) : (
          <span key="actions" style={{ fontSize: "11.5px", color: "var(--inv-muted)", display: "block", textAlign: "right" }}>
            {r.locationId ? locations.find((l) => l.id === r.locationId)?.name ?? "" : ""}
          </span>
        ),
      ],
    };
  });

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Returns" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead
          eyebrow="returned parcels → restock or write off"
          title="Returns to Restock"
        />

        {!courierifyConnected && (
          <Card padding="16px 20px">
            <div style={{ fontSize: "13px", color: "var(--inv-muted)" }}>
              Connect Courierify in{" "}
              <Link to="/app/settings" style={{ color: "var(--inv-accent)" }}>Settings</Link>{" "}
              to automatically pull returned parcels into this queue.
            </div>
          </Card>
        )}

        <FilterChips options={STATUS_TABS} active={filter} onChange={(v) => { setFilter(v); setSelected([]); }} />

        {/* Bulk action bar — restock destination + apply to selection */}
        {filter === "pending" && pendingIds.length > 0 && (
          <Card padding="12px 16px">
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer", fontSize: "12.5px" }}>
                <input type="checkbox" checked={allPendingSelected} onChange={toggleAll} />
                Select all pending
              </label>
              {locations.length > 0 && (
                <div style={{ minWidth: "180px" }}>
                  <SelectInput value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </SelectInput>
                </div>
              )}
              <div style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
                <Button
                  variant="primary"
                  disabled={selected.length === 0 || fetcher.state !== "idle"}
                  onClick={() => resolve("restock", selected)}
                >
                  Restock {selected.length > 0 ? `(${selected.length})` : ""}
                </Button>
                <Button
                  variant="ghost"
                  disabled={selected.length === 0 || fetcher.state !== "idle"}
                  onClick={() => resolve("writeoff", selected)}
                >
                  Write off {selected.length > 0 ? `(${selected.length})` : ""}
                </Button>
              </div>
            </div>
          </Card>
        )}

        {list.length === 0 ? (
          <Card padding="40px 24px">
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>
                {filter === "pending" ? "No returns waiting" : "Nothing here"}
              </div>
              <div style={{ fontSize: "13px", color: "var(--inv-muted)" }}>
                {filter === "pending"
                  ? "Returned parcels received by Courierify will appear here to restock or write off."
                  : "No returns in this state yet."}
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
