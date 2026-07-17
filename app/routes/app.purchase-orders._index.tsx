import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { formatCurrency, formatDate } from "../lib/format";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Button, Card, DataTable, FilterChips, PageHead, POStatusPill, type DataTableColumn } from "../design";

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

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "received", label: "Received" },
];

export default function PurchaseOrders() {
  const { pos } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [filter, setFilter] = useState("all");
  const { timezone = "UTC", currency = "USD", theme = "emerald" } =
    useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Purchase order updated");
  }, [fetcher.data, shopify]);

  const submit = (data: Record<string, string>) => fetcher.submit(data, { method: "POST" });

  const list = pos.filter((p) => filter === "all" || p.status === filter);

  const columns: DataTableColumn[] = [
    { header: "PO number", width: "1.4fr" },
    { header: "Supplier", width: "1.2fr" },
    { header: "Items", width: ".6fr" },
    { header: "Total", width: "1.2fr" },
    { header: "Status", width: ".9fr" },
    { header: "Created", width: "1fr" },
    { header: "", width: "2fr", align: "right" },
  ];

  const rows = list.map((po) => ({
    key: po.id,
    onClick: () => navigate(`/app/purchase-orders/${po.id}`),
    cells: [
      <span key="num" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12.5px", fontWeight: 600, color: "var(--inv-accent)" }}>
        {po.poNumber}
      </span>,
      <span key="supplier">{po.supplier?.name ?? "—"}</span>,
      <span key="items" style={{ fontFamily: "var(--inv-font-mono)" }}>{po.items.length}</span>,
      <span key="total" style={{ fontFamily: "var(--inv-font-mono)" }}>{formatCurrency(po.totalCost, currency)}</span>,
      <POStatusPill key="status" status={po.status} />,
      <span key="created" style={{ color: "var(--inv-muted)", fontSize: "12px" }}>{formatDate(po.createdAt, timezone)}</span>,
      <div key="actions" style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }} onClick={(e) => e.stopPropagation()}>
        <Link to={`/app/purchase-orders/${po.id}`}>
          <button style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}>
            View
          </button>
        </Link>
        {po.status === "draft" && (
          <button
            onClick={() => submit({ intent: "mark_sent", poId: po.id })}
            disabled={fetcher.state !== "idle"}
            style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}
          >
            Mark sent
          </button>
        )}
        {po.status === "sent" && (
          <button
            onClick={() => submit({ intent: "mark_received", poId: po.id })}
            disabled={fetcher.state !== "idle"}
            style={{ fontSize: "11.5px", border: "none", background: "var(--inv-ink)", color: "#fff", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}
          >
            Mark received
          </button>
        )}
        {po.status === "draft" && (
          <button
            onClick={() => submit({ intent: "delete", poId: po.id })}
            disabled={fetcher.state !== "idle"}
            style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-status-stockout-fg)", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}
          >
            Delete
          </button>
        )}
      </div>,
    ],
  }));

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Purchase Orders" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead
          eyebrow="draft → sent → received"
          title="Purchase Orders"
          right={<Button variant="primary" onClick={() => navigate("/app/purchase-orders/new")}>+ Create PO</Button>}
        />

        <FilterChips options={STATUS_TABS} active={filter} onChange={setFilter} />

        {pos.length === 0 ? (
          <Card padding="40px 24px">
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>No purchase orders yet</div>
              <div style={{ fontSize: "13px", color: "var(--inv-muted)", marginBottom: "16px" }}>
                Create a PO from reorder suggestions on the Dashboard, or manually here.
              </div>
              <Button variant="primary" onClick={() => navigate("/app/purchase-orders/new")}>Create PO</Button>
            </div>
          </Card>
        ) : (
          <DataTable columns={columns} rows={rows} />
        )}
      </div>
    </div>
  );
}
