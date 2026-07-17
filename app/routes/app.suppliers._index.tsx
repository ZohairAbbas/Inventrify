import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Button, Card, DataTable, PageHead, type DataTableColumn } from "../design";

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
  const { theme = "emerald" } = useRouteLoaderData<typeof appLoader>("routes/app") ?? {};
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Supplier deleted");
  }, [fetcher.data, shopify]);

  const columns: DataTableColumn[] = [
    { header: "Name", width: "1.3fr" },
    { header: "Contact", width: "1fr" },
    { header: "Email", width: "1.5fr" },
    { header: "Lead", width: ".7fr", align: "right" },
    { header: "On-time", width: "1.4fr" },
    { header: "Linked", width: "1.2fr", align: "right" },
    { header: "", width: "1.4fr", align: "right" },
  ];

  const rows = suppliers.map((s) => {
    const onTimePct =
      s.avgActualLeadTime != null && s.totalPosReceived > 0
        ? Math.max(0, Math.min(100, Math.round((s.leadTimeDays / s.avgActualLeadTime) * 100)))
        : null;

    return {
      key: s.id,
      cells: [
        <Link key="name" to={`/app/suppliers/${s.id}`} style={{ fontWeight: 600, color: "var(--inv-accent)" }}>
          {s.name}
        </Link>,
        <span key="contact">{s.contactName ?? "—"}</span>,
        <span key="email" style={{ color: "var(--inv-text-2)", fontSize: "12.5px" }}>{s.email ?? "—"}</span>,
        <span key="lead" style={{ fontFamily: "var(--inv-font-mono)" }}>{s.leadTimeDays}d</span>,
        onTimePct != null ? (
          <div key="ontime" style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%" }}>
            <div style={{ flex: 1, height: "6px", background: "var(--inv-divider-3)", borderRadius: "4px", overflow: "hidden", maxWidth: "90px" }}>
              <div style={{ width: `${onTimePct}%`, height: "100%", background: "var(--inv-accent)" }} />
            </div>
            <span style={{ fontFamily: "var(--inv-font-mono)", fontSize: "11.5px", color: "var(--inv-text-2)" }}>{onTimePct}%</span>
          </div>
        ) : (
          <span key="ontime" style={{ color: "var(--inv-faint)", fontSize: "11.5px" }}>no data</span>
        ),
        <span key="linked" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "11.5px", color: "var(--inv-text-2)" }}>
          {s._count.products}p · {s._count.purchaseOrders} PO
        </span>,
        <div key="actions" style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
          <Link to={`/app/suppliers/${s.id}`}>
            <button style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}>
              Edit
            </button>
          </Link>
          <button
            onClick={() => fetcher.submit({ supplierId: s.id }, { method: "POST" })}
            disabled={fetcher.state !== "idle"}
            style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-status-stockout-fg)", padding: "5px 10px", borderRadius: "8px", cursor: "pointer" }}
          >
            Delete
          </button>
        </div>,
      ],
    };
  });

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title="Suppliers" />
      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead
          eyebrow="Lead times feed forecasting"
          title="Suppliers"
          right={<Button variant="primary" onClick={() => navigate("/app/suppliers/new")}>+ Add supplier</Button>}
        />

        {suppliers.length === 0 ? (
          <Card padding="40px 24px">
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>No suppliers yet</div>
              <div style={{ fontSize: "13px", color: "var(--inv-muted)", marginBottom: "16px" }}>
                Add your suppliers to link them to products and purchase orders.
              </div>
              <Button variant="primary" onClick={() => navigate("/app/suppliers/new")}>Add Supplier</Button>
            </div>
          </Card>
        ) : (
          <DataTable columns={columns} rows={rows} />
        )}
      </div>
    </div>
  );
}
