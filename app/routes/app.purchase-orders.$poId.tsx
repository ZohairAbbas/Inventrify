import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { formatCurrency, formatDate } from "../lib/format";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Button, Card, DataTable, PageHead, POStatusPill, TextInput, type DataTableColumn } from "../design";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.poId, shop: session.shop },
    include: {
      supplier: true,
      items: { include: { product: true } },
    },
  });
  if (!po) throw new Response("Not found", { status: 404 });
  return { po };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.poId, shop },
    include: { items: true },
  });
  if (!po) return { ok: false as const, error: "PO not found", action: "" };

  if (intent === "mark_sent") {
    if (po.status !== "draft") return { ok: false as const, error: "Only draft POs can be marked sent", action: "" };
    const expectedDelivery = formData.get("expectedDeliveryDate") as string;
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: {
        status: "sent",
        expectedDeliveryDate: expectedDelivery ? new Date(expectedDelivery) : null,
      },
    });
    return { ok: true as const, action: "sent", error: "" };
  }

  if (intent === "mark_received") {
    if (po.status === "received") return { ok: false as const, error: "Already received", action: "" };
    const actualDelivery = formData.get("actualDeliveryDate") as string;

    for (const item of po.items) {
      const receivedQty = parseInt(
        (formData.get(`received_${item.id}`) as string) ?? String(item.quantityOrdered),
        10,
      );
      if (isNaN(receivedQty) || receivedQty < 0) continue;

      await prisma.product.update({
        where: { id: item.productId },
        data: { currentStock: { increment: receivedQty } },
      });
      await prisma.purchaseOrderItem.update({
        where: { id: item.id },
        data: { quantityReceived: receivedQty },
      });
    }

    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: {
        status: "received",
        actualDeliveryDate: actualDelivery ? new Date(actualDelivery) : new Date(),
      },
    });

    if (po.supplierId && po.expectedDeliveryDate) {
      const receivedDate = actualDelivery ? new Date(actualDelivery) : new Date();
      const actualLeadDays = Math.max(
        1,
        Math.round((receivedDate.getTime() - po.createdAt.getTime()) / 86400000),
      );

      const supplier = await prisma.supplier.findUnique({ where: { id: po.supplierId } });
      if (supplier) {
        const totalPos = supplier.totalPosReceived + 1;
        const currentAvg = supplier.avgActualLeadTime ?? actualLeadDays;
        const newAvg = (currentAvg * supplier.totalPosReceived + actualLeadDays) / totalPos;

        const diff = actualLeadDays - newAvg;
        const currentVariance = supplier.leadTimeVariance ?? 0;
        const newVariance = Math.sqrt(
          (currentVariance * currentVariance * supplier.totalPosReceived + diff * diff) / totalPos,
        );

        await prisma.supplier.update({
          where: { id: po.supplierId },
          data: {
            totalPosReceived: totalPos,
            avgActualLeadTime: newAvg,
            leadTimeVariance: newVariance,
          },
        });
      }
    }

    return { ok: true as const, action: "received", error: "" };
  }

  return { ok: true as const, action: "", error: "" };
};

export default function PODetail() {
  const { po } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const { timezone = "UTC", currency = "USD" } =
    useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  const [expectedDate, setExpectedDate] = useState(
    po.expectedDeliveryDate ? new Date(po.expectedDeliveryDate).toISOString().slice(0, 10) : "",
  );
  const [actualDate, setActualDate] = useState(new Date().toISOString().slice(0, 10));
  const [receivedQtys, setReceivedQtys] = useState<Record<string, string>>(
    Object.fromEntries(po.items.map((i) => [i.id, String(i.quantityOrdered)])),
  );

  const isBusy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.ok) {
      const msg = fetcher.data.action === "received" ? "PO marked as received — stock updated" : "PO updated";
      shopify.toast.show(msg);
    } else if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const columns: DataTableColumn[] = [
    { header: "Product", width: "2.2fr" },
    { header: "SKU", width: "1fr" },
    { header: "Qty ordered", width: "1fr", align: "right" },
    { header: "Qty received", width: "1.2fr", align: "right" },
    { header: "Unit cost", width: "1fr", align: "right" },
    { header: "Line total", width: "1.1fr", align: "right" },
  ];

  const rows = po.items.map((item) => {
    const name = item.product.variantTitle ? `${item.product.title} — ${item.product.variantTitle}` : item.product.title;
    return {
      key: item.id,
      cells: [
        <span key="name" style={{ fontWeight: 500 }}>{name}</span>,
        <span key="sku" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12px", color: "var(--inv-text-2)" }}>
          {item.product.sku ?? "—"}
        </span>,
        <span key="ord" style={{ fontFamily: "var(--inv-font-mono)" }}>{item.quantityOrdered}</span>,
        po.status === "sent" ? (
          <TextInput
            key="recv"
            type="number"
            min={0}
            value={receivedQtys[item.id] ?? String(item.quantityOrdered)}
            onChange={(e) => setReceivedQtys((prev) => ({ ...prev, [item.id]: e.target.value }))}
            style={{ height: "32px", textAlign: "right" }}
          />
        ) : (
          <span key="recv" style={{ fontFamily: "var(--inv-font-mono)" }}>{item.quantityReceived ?? 0}</span>
        ),
        <span key="cost" style={{ fontFamily: "var(--inv-font-mono)" }}>{formatCurrency(item.unitCost, currency)}</span>,
        <span key="total" style={{ fontFamily: "var(--inv-font-mono)", fontWeight: 600 }}>
          {formatCurrency(item.quantityOrdered * item.unitCost, currency)}
        </span>,
      ],
    };
  });

  return (
    <div className="inv-root" style={{ minHeight: "100vh" }}>
      <TitleBar title={`PO ${po.poNumber}`}>
        <button onClick={() => window.print()}>Print / PDF</button>
      </TitleBar>

      <style>{`
        @media print {
          [data-polaris-topbar], nav, [role="navigation"], .Polaris-Frame__Navigation {
            display: none !important;
          }
        }
      `}</style>

      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead eyebrow="Purchase order" title={po.poNumber} right={<POStatusPill status={po.status} />} />

        {fetcher.data?.error && (
          <Card padding="12px 16px" style={{ marginBottom: "16px", borderColor: "var(--inv-status-critical-dot)" }}>
            <span style={{ color: "var(--inv-status-critical-fg)", fontSize: "13px" }}>{fetcher.data.error}</span>
          </Card>
        )}

        <Card style={{ marginBottom: "14px" }}>
          <div style={{ fontSize: "12.5px", color: "var(--inv-muted)", marginBottom: "18px" }}>
            Created {formatDate(po.createdAt, timezone)}
          </div>
          <div style={{ display: "flex", gap: "32px", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "4px" }}>Supplier</div>
              <div style={{ fontSize: "13px" }}>{po.supplier?.name ?? "—"}</div>
              {po.supplier?.email && (
                <div style={{ fontSize: "11.5px", color: "var(--inv-muted)" }}>{po.supplier.email}</div>
              )}
            </div>
            {po.expectedDeliveryDate && (
              <div>
                <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "4px" }}>Expected delivery</div>
                <div style={{ fontSize: "13px" }}>{formatDate(po.expectedDeliveryDate, timezone)}</div>
              </div>
            )}
            {po.actualDeliveryDate && (
              <div>
                <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "4px" }}>Actual delivery</div>
                <div style={{ fontSize: "13px" }}>{formatDate(po.actualDeliveryDate, timezone)}</div>
              </div>
            )}
            {po.notes && (
              <div>
                <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "4px" }}>Notes</div>
                <div style={{ fontSize: "13px" }}>{po.notes}</div>
              </div>
            )}
          </div>
        </Card>

        <div style={{ fontSize: "13px", fontWeight: 600, margin: "0 0 10px" }}>Line items</div>
        <div style={{ marginBottom: "14px" }}>
          <DataTable columns={columns} rows={rows} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 14px", background: "var(--inv-subtle)", borderRadius: "11px", marginBottom: "18px" }}>
          <span style={{ fontWeight: 600 }}>Total</span>
          <span style={{ fontFamily: "var(--inv-font-mono)", fontWeight: 600 }}>{formatCurrency(po.totalCost, currency)}</span>
        </div>

        <Card style={{ marginBottom: "18px" }}>
          {po.status === "draft" && (
            <div>
              <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>
                Expected delivery date
              </label>
              <TextInput
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
                style={{ marginBottom: "14px", maxWidth: "240px" }}
              />
              <div>
                <Button
                  variant="primary"
                  disabled={isBusy}
                  onClick={() => fetcher.submit({ intent: "mark_sent", expectedDeliveryDate: expectedDate }, { method: "POST" })}
                >
                  Mark as sent to supplier
                </Button>
              </div>
            </div>
          )}

          {po.status === "sent" && (
            <div>
              <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>
                Actual delivery date
              </label>
              <TextInput
                type="date"
                value={actualDate}
                onChange={(e) => setActualDate(e.target.value)}
                style={{ marginBottom: "8px", maxWidth: "240px" }}
              />
              <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "14px" }}>
                Adjust received quantities above for partial delivery. Stock updates accordingly.
              </div>
              <Button
                variant="primary"
                disabled={isBusy}
                onClick={() => {
                  const data: Record<string, string> = { intent: "mark_received", actualDeliveryDate: actualDate };
                  po.items.forEach((item) => {
                    data[`received_${item.id}`] = receivedQtys[item.id] ?? String(item.quantityOrdered);
                  });
                  fetcher.submit(data, { method: "POST" });
                }}
              >
                Confirm received — update stock
              </Button>
            </div>
          )}

          {po.status === "received" && (
            <div style={{ fontSize: "12.5px", color: "var(--inv-status-healthy-fg)", fontWeight: 500 }}>
              ✓ Received on {po.actualDeliveryDate ? formatDate(po.actualDeliveryDate, timezone) : "—"}. Stock has been updated.
            </div>
          )}
        </Card>

        <div style={{ display: "flex", gap: "9px" }}>
          <Link to="/app/purchase-orders">
            <Button variant="ghost">← Back to Purchase Orders</Button>
          </Link>
          <Button variant="ghost" onClick={() => window.print()}>Print / PDF</Button>
        </div>
      </div>
    </div>
  );
}
