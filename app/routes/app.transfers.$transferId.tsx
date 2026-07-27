import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { formatDate } from "../lib/format";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { applyLocationDelta } from "../lib/stock.server";
import { Button, Card, DataTable, PageHead, PrintSheet, TextInput, TransferStatusPill, type DataTableColumn } from "../design";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const transfer = await prisma.stockTransfer.findFirst({
    where: { id: params.transferId, shop: session.shop },
    include: {
      fromLocation: true,
      toLocation: true,
      items: { include: { product: true } },
    },
  });
  if (!transfer) throw new Response("Not found", { status: 404 });

  // Bin/shelf at the SOURCE location, so the pick sheet tells the picker where to pull
  // each item from. Keyed by product; missing = no bin recorded there.
  const bins = await prisma.productLocationStock.findMany({
    where: { locationId: transfer.fromLocationId, productId: { in: transfer.items.map((i) => i.productId) } },
    select: { productId: true, binLocation: true },
  });
  const binByProduct: Record<string, string | null> = Object.fromEntries(
    bins.map((b) => [b.productId, b.binLocation]),
  );

  return { transfer, binByProduct };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const transfer = await prisma.stockTransfer.findFirst({
    where: { id: params.transferId, shop },
    include: { items: true },
  });
  if (!transfer) return { ok: false as const, error: "Transfer not found", action: "" };

  if (intent === "mark_shipped") {
    if (transfer.status !== "draft") return { ok: false as const, error: "Only draft transfers can be shipped", action: "" };

    const syncFailures: string[] = [];
    for (const item of transfer.items) {
      const res = await applyLocationDelta(admin, shop, item.productId, transfer.fromLocationId, -item.quantitySent);
      if (!res.ok) return { ok: false as const, error: res.error ?? "Failed to move stock", action: "" };
      if (!res.shopifySynced && res.shopifyError) syncFailures.push(res.shopifyError);
    }

    await prisma.stockTransfer.update({
      where: { id: transfer.id },
      data: { status: "in-transit", shippedAt: new Date() },
    });

    return { ok: true as const, action: "shipped", error: "", shopifyWarn: syncFailures.length > 0 };
  }

  if (intent === "mark_received") {
    if (transfer.status !== "in-transit") return { ok: false as const, error: "Only in-transit transfers can be received", action: "" };

    const syncFailures: string[] = [];
    for (const item of transfer.items) {
      const receivedQty = parseInt(
        (formData.get(`received_${item.id}`) as string) ?? String(item.quantitySent),
        10,
      );
      if (isNaN(receivedQty) || receivedQty < 0) continue;

      if (receivedQty > 0) {
        const res = await applyLocationDelta(admin, shop, item.productId, transfer.toLocationId, receivedQty);
        if (!res.ok) return { ok: false as const, error: res.error ?? "Failed to move stock", action: "" };
        if (!res.shopifySynced && res.shopifyError) syncFailures.push(res.shopifyError);
      }
      await prisma.stockTransferItem.update({
        where: { id: item.id },
        data: { quantityReceived: receivedQty },
      });
    }

    await prisma.stockTransfer.update({
      where: { id: transfer.id },
      data: { status: "received", receivedAt: new Date() },
    });

    return { ok: true as const, action: "received", error: "", shopifyWarn: syncFailures.length > 0 };
  }

  return { ok: true as const, action: "", error: "", shopifyWarn: false };
};

export default function TransferDetail() {
  const { transfer, binByProduct } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const { timezone = "UTC", theme = "emerald" } =
    useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  const [receivedQtys, setReceivedQtys] = useState<Record<string, string>>(
    Object.fromEntries(transfer.items.map((i) => [i.id, String(i.quantitySent)])),
  );

  const isBusy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.ok) {
      const base =
        fetcher.data.action === "shipped"
          ? "Transfer shipped — source stock updated"
          : fetcher.data.action === "received"
            ? "Transfer received — destination stock updated"
            : "Transfer updated";
      const warn = fetcher.data.shopifyWarn ? " (some Shopify syncs failed — see logs)" : "";
      shopify.toast.show(base + warn);
    } else if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const columns: DataTableColumn[] = [
    { header: "Product", width: "2.4fr" },
    { header: "SKU", width: "1fr" },
    { header: "Qty sent", width: "1fr", align: "right" },
    { header: "Qty received", width: "1.2fr", align: "right" },
  ];

  const rows = transfer.items.map((item) => {
    const name = item.product.variantTitle ? `${item.product.title} — ${item.product.variantTitle}` : item.product.title;
    return {
      key: item.id,
      cells: [
        <span key="name" style={{ fontWeight: 500 }}>{name}</span>,
        <span key="sku" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12px", color: "var(--inv-text-2)" }}>
          {item.product.sku ?? "—"}
        </span>,
        <span key="sent" style={{ fontFamily: "var(--inv-font-mono)" }}>{item.quantitySent}</span>,
        transfer.status === "in-transit" ? (
          <TextInput
            key="recv"
            type="number"
            min={0}
            value={receivedQtys[item.id] ?? String(item.quantitySent)}
            onChange={(e) => setReceivedQtys((prev) => ({ ...prev, [item.id]: e.target.value }))}
            style={{ height: "32px", textAlign: "right" }}
          />
        ) : (
          <span key="recv" style={{ fontFamily: "var(--inv-font-mono)" }}>
            {transfer.status === "received" ? item.quantityReceived : "—"}
          </span>
        ),
      ],
    };
  });

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title={`Transfer ${transfer.transferNumber}`}>
        <button onClick={() => window.print()}>Print pick sheet</button>
      </TitleBar>

      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead
          eyebrow="Stock transfer"
          title={transfer.transferNumber}
          right={
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <Button variant="ghost" onClick={() => window.print()}>Print pick sheet</Button>
              <TransferStatusPill status={transfer.status} />
            </div>
          }
        />

        {/* Bin-ordered picking document. Visible as a preview; print isolates it. */}
        <PrintSheet id="transfer-pick-sheet">
          <div style={{ padding: "6px 2px 14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
              <div>
                <div style={{ fontSize: "18px", fontWeight: 700 }}>Pick sheet — {transfer.transferNumber}</div>
                <div style={{ fontSize: "12.5px", marginTop: "3px" }}>
                  Pull from <b>{transfer.fromLocation.name}</b> → deliver to <b>{transfer.toLocation.name}</b>
                </div>
              </div>
              <div style={{ fontSize: "12px", textAlign: "right" }}>
                <div>Created {formatDate(transfer.createdAt, timezone)}</div>
                <div>{transfer.items.length} line{transfer.items.length === 1 ? "" : "s"} · {transfer.items.reduce((s, i) => s + i.quantitySent, 0)} units</div>
              </div>
            </div>

            <table className="sheet-table">
              <thead>
                <tr>
                  <th style={{ width: "16%" }}>Bin</th>
                  <th style={{ width: "18%" }}>SKU</th>
                  <th>Product</th>
                  <th className="num" style={{ width: "12%" }}>Qty</th>
                  <th style={{ width: "12%" }}>Picked ✓</th>
                </tr>
              </thead>
              <tbody>
                {[...transfer.items]
                  // Order by bin so the picker walks the shelves once. Unbinned items last.
                  .sort((a, b) => {
                    const ba = binByProduct[a.productId] ?? "";
                    const bb = binByProduct[b.productId] ?? "";
                    if (ba === bb) return 0;
                    if (!ba) return 1;
                    if (!bb) return -1;
                    return ba.localeCompare(bb, undefined, { numeric: true });
                  })
                  .map((item) => {
                    const name = item.product.variantTitle ? `${item.product.title} — ${item.product.variantTitle}` : item.product.title;
                    return (
                      <tr key={item.id}>
                        <td style={{ fontFamily: "var(--inv-font-mono)" }}>{binByProduct[item.productId] || "—"}</td>
                        <td style={{ fontFamily: "var(--inv-font-mono)" }}>{item.product.sku ?? "—"}</td>
                        <td>{name}</td>
                        <td className="num" style={{ fontFamily: "var(--inv-font-mono)" }}>{item.quantitySent}</td>
                        <td></td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>

            {transfer.notes && (
              <div style={{ marginTop: "12px", fontSize: "12px" }}><b>Notes:</b> {transfer.notes}</div>
            )}
            <div style={{ marginTop: "18px", fontSize: "11.5px", display: "flex", justifyContent: "space-between" }}>
              <span>Picked by ______________________</span>
              <span>Date __________</span>
            </div>
          </div>
        </PrintSheet>

        {fetcher.data?.error && (
          <Card padding="12px 16px" style={{ marginBottom: "16px", borderColor: "var(--inv-status-critical-dot)" }}>
            <span style={{ color: "var(--inv-status-critical-fg)", fontSize: "13px" }}>{fetcher.data.error}</span>
          </Card>
        )}

        <Card style={{ marginBottom: "14px" }}>
          <div style={{ fontSize: "12.5px", color: "var(--inv-muted)", marginBottom: "18px" }}>
            Created {formatDate(transfer.createdAt, timezone)}
          </div>
          <div style={{ display: "flex", gap: "32px", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "4px" }}>From</div>
              <div style={{ fontSize: "13px" }}>{transfer.fromLocation.name}</div>
            </div>
            <div>
              <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "4px" }}>To</div>
              <div style={{ fontSize: "13px" }}>{transfer.toLocation.name}</div>
            </div>
            {transfer.shippedAt && (
              <div>
                <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "4px" }}>Shipped</div>
                <div style={{ fontSize: "13px" }}>{formatDate(transfer.shippedAt, timezone)}</div>
              </div>
            )}
            {transfer.receivedAt && (
              <div>
                <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "4px" }}>Received</div>
                <div style={{ fontSize: "13px" }}>{formatDate(transfer.receivedAt, timezone)}</div>
              </div>
            )}
            {transfer.notes && (
              <div>
                <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "4px" }}>Notes</div>
                <div style={{ fontSize: "13px" }}>{transfer.notes}</div>
              </div>
            )}
          </div>
        </Card>

        <div style={{ fontSize: "13px", fontWeight: 600, margin: "0 0 10px" }}>Line items</div>
        <div style={{ marginBottom: "18px" }}>
          <DataTable columns={columns} rows={rows} />
        </div>

        <Card style={{ marginBottom: "18px" }}>
          {transfer.status === "draft" && (
            <div>
              <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "14px" }}>
                Shipping this transfer removes the sent quantities from <b>{transfer.fromLocation.name}</b>.
              </div>
              <Button
                variant="primary"
                disabled={isBusy}
                onClick={() => fetcher.submit({ intent: "mark_shipped" }, { method: "POST" })}
              >
                Mark in-transit — remove from source
              </Button>
            </div>
          )}

          {transfer.status === "in-transit" && (
            <div>
              <div style={{ fontSize: "11.5px", color: "var(--inv-muted)", marginBottom: "14px" }}>
                Adjust received quantities above for partial delivery — any shortfall (sent − received) is treated as
                shrinkage. Confirming adds the received quantities to <b>{transfer.toLocation.name}</b>.
              </div>
              <Button
                variant="primary"
                disabled={isBusy}
                onClick={() => {
                  const data: Record<string, string> = { intent: "mark_received" };
                  transfer.items.forEach((item) => {
                    data[`received_${item.id}`] = receivedQtys[item.id] ?? String(item.quantitySent);
                  });
                  fetcher.submit(data, { method: "POST" });
                }}
              >
                Confirm received — add to destination
              </Button>
            </div>
          )}

          {transfer.status === "received" && (
            <div style={{ fontSize: "12.5px", color: "var(--inv-status-healthy-fg)", fontWeight: 500 }}>
              ✓ Received on {transfer.receivedAt ? formatDate(transfer.receivedAt, timezone) : "—"}. Stock has been moved.
            </div>
          )}
        </Card>

        <div style={{ display: "flex", gap: "9px" }}>
          <Link to="/app/transfers">
            <Button variant="ghost">← Back to Transfers</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
