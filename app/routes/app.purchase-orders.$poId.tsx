import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { formatCurrency, formatDate } from "../lib/format";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useCallback, useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Button, Card, DataTable, PageHead, POStatusPill, PrintSheet, ProductCombobox, ProductThumb, ScanInput, SelectInput, TextArea, TextInput, type DataTableColumn } from "../design";
import {
  closePurchaseOrderRemainder,
  markPurchaseOrderSent,
  parseReceivedQuantities,
  receivePurchaseOrder,
  validateDraftLines,
  validateSupplierId,
} from "../lib/purchase-order.server";
import { outstandingQuantity } from "../lib/purchase-order-status";
import { parseFormDate } from "../lib/date-range";
import { emailPurchaseOrderToSupplier } from "../lib/purchase-order-email.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.poId, shop: session.shop },
    include: {
      supplier: true,
      items: { include: { product: true } },
      receipts: {
        include: { lines: { select: { purchaseOrderItemId: true, quantity: true } } },
        orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }],
      },
    },
  });
  if (!po) throw new Response("Not found", { status: 404 });

  // The catalogue is not loaded: the draft editor's line picker searches on demand via
  // /api/products/search. Existing lines already carry their product through `po.items`.
  const suppliers = await prisma.supplier.findMany({
    where: { shop: session.shop },
    orderBy: { name: "asc" },
  });

  return { po, suppliers };
};

/** The receiptVersion the page was rendered with; null when absent or malformed. */
function parseVersion(raw: FormDataEntryValue | null): number | null {
  if (raw === null || raw === "") return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session, sessionToken } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.poId, shop },
    include: { items: true },
  });
  if (!po) return { ok: false as const, error: "PO not found", action: "" };

  if (intent === "update_draft") {
    if (po.status !== "draft") return { ok: false as const, error: "Only draft POs can be edited", action: "" };

    const supplierId = (formData.get("supplierId") as string) || null;
    const notes = (formData.get("notes") as string)?.trim() || null;
    const productIds = formData.getAll("productId") as string[];
    const quantities = formData.getAll("quantity") as string[];
    const unitCosts = formData.getAll("unitCost") as string[];

    // Product and supplier ids come from the form, so they are attacker-controlled and
    // must be checked against this shop before anything is linked to the PO.
    const { items, error: lineError } = await validateDraftLines(
      shop,
      productIds.map((id, i) => ({
        productId: id,
        quantity: quantities[i] ?? null,
        unitCost: unitCosts[i] ?? null,
      })),
    );
    if (lineError) return { ok: false as const, error: lineError, action: "" };

    const { supplierId: ownedSupplierId, error: supplierError } = await validateSupplierId(
      shop,
      supplierId,
    );
    if (supplierError) return { ok: false as const, error: supplierError, action: "" };

    const totalCost = items.reduce((s, item) => s + item.quantityOrdered * item.unitCost, 0);

    await prisma.$transaction([
      prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: po.id } }),
      prisma.purchaseOrder.update({
        where: { id: po.id },
        data: {
          supplierId: ownedSupplierId,
          notes,
          totalCost,
          items: { create: items },
        },
      }),
    ]);

    return { ok: true as const, action: "draft_updated", error: "" };
  }

  if (intent === "mark_sent") {
    const expectedDelivery = formData.get("expectedDeliveryDate") as string;
    const parsedExpected = parseFormDate(expectedDelivery);
    if (expectedDelivery && !parsedExpected) {
      return { ok: false as const, error: "Expected delivery date is not a valid date", action: "" };
    }

    const result = await markPurchaseOrderSent(shop, po.id, parsedExpected);
    if (!result.ok) return { ok: false as const, error: result.error ?? "Could not mark sent", action: "" };
    return { ok: true as const, action: "sent", error: "" };
  }

  if (intent === "email_supplier") {
    const result = await emailPurchaseOrderToSupplier(po.id, shop);
    if (!result.ok) {
      return { ok: false as const, error: result.error ?? "Could not send the email", action: "" };
    }
    return { ok: true as const, action: `emailed:${result.emailedTo}`, error: "" };
  }

  if (intent === "mark_received") {
    const actualDelivery = formData.get("actualDeliveryDate") as string;
    const parsedActual = parseFormDate(actualDelivery);
    if (actualDelivery && !parsedActual) {
      return { ok: false as const, error: "Actual delivery date is not a valid date", action: "" };
    }

    const result = await receivePurchaseOrder(admin, shop, po.id, {
      actualDeliveryDate: parsedActual,
      locationId: (formData.get("locationId") as string) || null,
      quantities: parseReceivedQuantities(
        formData,
        po.items.map((i) => i.id),
      ),
      expectedVersion: parseVersion(formData.get("receiptVersion")),
      closeRemaining: formData.get("remainder") === "close",
      userId: sessionToken?.sub ?? null,
    });

    if (!result.ok) {
      return { ok: false as const, error: result.error ?? "Could not receive", action: "" };
    }

    // A partial failure still receives what it could; the merchant needs to know which
    // lines did not move rather than seeing an unqualified success.
    const problems = [
      ...result.lines.filter((l) => l.error).map((l) => l.error as string),
      ...result.shopifyWarnings,
      ...(result.closeSkipped ? [result.closeSkipped] : []),
    ];
    return {
      ok: true as const,
      action: `received:${result.status ?? ""}`,
      error: problems.length > 0 ? problems.join("; ") : "",
    };
  }

  if (intent === "close_remaining") {
    const result = await closePurchaseOrderRemainder(shop, po.id, {
      expectedVersion: parseVersion(formData.get("receiptVersion")),
    });
    if (!result.ok) {
      return { ok: false as const, error: result.error ?? "Could not close", action: "" };
    }
    return { ok: true as const, action: "closed", error: "" };
  }

  return { ok: true as const, action: "", error: "" };
};

interface DraftLine {
  productId: string;
  /** Held beside the id so the picker can show a chosen product without a search. */
  label: string;
  quantity: number;
  unitCost: number;
}

export default function PODetail() {
  const { po, suppliers } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const { timezone = "UTC", currency = "USD", theme = "emerald" } =
    useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  const [expectedDate, setExpectedDate] = useState(
    po.expectedDeliveryDate ? new Date(po.expectedDeliveryDate).toISOString().slice(0, 10) : "",
  );
  const [actualDate, setActualDate] = useState(new Date().toISOString().slice(0, 10));
  // Units arriving in THIS delivery, per line — not the running total. Defaults to what
  // is still outstanding, so a complete delivery is one click.
  const outstandingDefaults = () =>
    Object.fromEntries(po.items.map((i) => [i.id, String(outstandingQuantity(i))]));
  const [receivedQtys, setReceivedQtys] = useState<Record<string, string>>(outstandingDefaults);
  const [remainder, setRemainder] = useState<"keep" | "close">("keep");
  // A booked delivery bumps receiptVersion and the loader revalidates; start the next
  // delivery from the new outstanding figures rather than re-showing the last one.
  useEffect(() => {
    setReceivedQtys(outstandingDefaults());
    setRemainder("keep");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [po.receiptVersion]);

  const [isEditing, setIsEditing] = useState(false);
  const [draftSupplierId, setDraftSupplierId] = useState(po.supplierId ?? "");
  const [draftNotes, setDraftNotes] = useState(po.notes ?? "");
  const [draftLines, setDraftLines] = useState<DraftLine[]>(() =>
    po.items.map((item) => ({
      productId: item.productId,
      label: item.product.variantTitle
        ? `${item.product.title} — ${item.product.variantTitle}`
        : item.product.title,
      quantity: item.quantityOrdered,
      unitCost: item.unitCost,
    })),
  );

  const isBusy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.ok) {
      const action = fetcher.data.action;
      const msg = action.startsWith("emailed:")
        ? `Purchase order emailed to ${action.slice("emailed:".length)}`
        : action === "received:received"
          ? "Delivery received — PO complete, stock updated"
          : action === "received:partially_received"
            ? "Delivery received — the rest stays on order"
            : action === "received:closed"
              ? "Delivery received — remainder cancelled, PO closed"
              : action.startsWith("received")
                ? "Delivery received — stock updated"
                : action === "closed"
                  ? "Remaining units cancelled — PO closed"
                  : action === "draft_updated"
                    ? "Draft PO updated"
                    : "PO updated";
      // Line failures and Shopify warnings ride along on a successful receipt.
      if (fetcher.data.error) shopify.toast.show(`${msg} — but: ${fetcher.data.error}`, { isError: true });
      else shopify.toast.show(msg);
      if (fetcher.data.action === "draft_updated") setIsEditing(false);
    } else if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const addDraftLine = useCallback(() => {
    setDraftLines((l) => [...l, { productId: "", label: "", quantity: 1, unitCost: 0 }]);
  }, []);

  const removeDraftLine = useCallback((idx: number) => {
    setDraftLines((l) => l.filter((_, i) => i !== idx));
  }, []);

  const updateDraftLine = useCallback((idx: number, field: "quantity" | "unitCost", value: string) => {
    setDraftLines((l) => l.map((line, i) => (i === idx ? { ...line, [field]: parseFloat(value) || 0 } : line)));
  }, []);

  const setDraftLineProduct = useCallback(
    (idx: number, id: string, label: string, unitCost?: number) => {
      setDraftLines((l) =>
        l.map((line, i) =>
          i === idx ? { ...line, productId: id, label, unitCost: line.unitCost || unitCost || 0 } : line,
        ),
      );
    },
    [],
  );

  const draftTotal = draftLines.reduce((s, l) => s + l.quantity * l.unitCost, 0);

  const saveDraft = () => {
    const fd = new FormData();
    fd.append("intent", "update_draft");
    fd.append("supplierId", draftSupplierId);
    fd.append("notes", draftNotes);
    draftLines.forEach((line) => {
      fd.append("productId", line.productId);
      fd.append("quantity", String(line.quantity));
      fd.append("unitCost", String(line.unitCost));
    });
    fetcher.submit(fd, { method: "POST" });
  };

  const receivable = po.status === "sent" || po.status === "partially_received";

  /** This-delivery quantity as entered; blank or unparseable counts as zero. */
  const deliveryQty = (itemId: string) => {
    const n = parseInt(receivedQtys[itemId] ?? "0", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const deliveryUnits = po.items.reduce((s, i) => s + deliveryQty(i.id), 0);
  // What would still be outstanding if this delivery is booked as entered.
  const shortUnits = po.items.reduce(
    (s, i) => s + Math.max(0, outstandingQuantity(i) - deliveryQty(i.id)),
    0,
  );
  const totalOutstanding = po.items.reduce((s, i) => s + outstandingQuantity(i), 0);
  const totalCancelled = po.items.reduce((s, i) => s + i.quantityCancelled, 0);

  const columns: DataTableColumn[] = [
    { header: "Product", width: "2.2fr" },
    { header: "SKU", width: "1fr" },
    { header: "Qty ordered", width: "1fr", align: "right" },
    { header: "Qty received", width: "1.2fr", align: "right" },
    ...(receivable ? [{ header: "This delivery", width: "1.2fr", align: "right" as const }] : []),
    { header: "Unit cost", width: "1fr", align: "right" },
    { header: "Line total", width: "1.1fr", align: "right" },
  ];

  const rows = po.items.map((item) => {
    const name = item.product.variantTitle ? `${item.product.title} — ${item.product.variantTitle}` : item.product.title;
    const outstanding = outstandingQuantity(item);
    return {
      key: item.id,
      cells: [
        <div key="name" style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
          <ProductThumb src={item.product.imageUrl} name={name} size={30} />
          <span style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {name}
          </span>
        </div>,
        <span key="sku" style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12px", color: "var(--inv-text-2)" }}>
          {item.product.sku ?? "—"}
        </span>,
        <span key="ord" style={{ fontFamily: "var(--inv-font-mono)" }}>{item.quantityOrdered}</span>,
        <div key="recv" style={{ textAlign: "right" }}>
          <span style={{ fontFamily: "var(--inv-font-mono)" }}>{item.quantityReceived ?? 0}</span>
          {item.quantityCancelled > 0 ? (
            <div style={{ fontSize: "11px", color: "var(--inv-muted)" }}>{item.quantityCancelled} cancelled</div>
          ) : receivable && item.quantityReceived > 0 && outstanding > 0 ? (
            <div style={{ fontSize: "11px", color: "var(--inv-muted)" }}>{outstanding} still due</div>
          ) : null}
        </div>,
        ...(receivable
          ? [
              <TextInput
                key="delivery"
                type="number"
                min={0}
                value={receivedQtys[item.id] ?? String(outstanding)}
                onChange={(e) => setReceivedQtys((prev) => ({ ...prev, [item.id]: e.target.value }))}
                style={{ height: "32px", textAlign: "right" }}
              />,
            ]
          : []),
        <span key="cost" style={{ fontFamily: "var(--inv-font-mono)" }}>{formatCurrency(item.unitCost, currency)}</span>,
        <span key="total" style={{ fontFamily: "var(--inv-font-mono)", fontWeight: 600 }}>
          {formatCurrency(item.quantityOrdered * item.unitCost, currency)}
        </span>,
      ],
    };
  });

  return (
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
      <TitleBar title={`PO ${po.poNumber}`}>
        <button onClick={() => window.print()}>Print</button>
      </TitleBar>

      {/* Printable PO document. Print-isolated, so it replaces the old whole-page print.
          When the PO is out for delivery it gains a blank "Received" column, doubling as
          a receiving checklist; otherwise it is a clean order to send the supplier. */}
      <PrintSheet id="po-print-sheet">
        <div style={{ padding: "6px 2px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
            <div>
              <div style={{ fontSize: "18px", fontWeight: 700 }}>
                {receivable ? "Receiving sheet" : "Purchase order"} — {po.poNumber}
              </div>
              {po.supplier && (
                <div style={{ fontSize: "12.5px", marginTop: "3px" }}>
                  Supplier: <b>{po.supplier.name}</b>{po.supplier.email ? ` · ${po.supplier.email}` : ""}
                </div>
              )}
            </div>
            <div style={{ fontSize: "12px", textAlign: "right" }}>
              <div>Created {formatDate(po.createdAt, timezone)}</div>
              {po.expectedDeliveryDate && <div>Expected {formatDate(po.expectedDeliveryDate, timezone)}</div>}
            </div>
          </div>

          <table className="sheet-table">
            <thead>
              <tr>
                <th style={{ width: "16%" }}>SKU</th>
                <th>Product</th>
                <th className="num" style={{ width: "10%" }}>{po.status === "partially_received" ? "Still due" : "Qty"}</th>
                <th className="num" style={{ width: "14%" }}>Unit cost</th>
                <th className="num" style={{ width: "14%" }}>Line total</th>
                {receivable && <th style={{ width: "12%" }}>Received</th>}
              </tr>
            </thead>
            <tbody>
              {po.items.map((item) => {
                const name = item.product.variantTitle ? `${item.product.title} — ${item.product.variantTitle}` : item.product.title;
                return (
                  <tr key={item.id}>
                    <td style={{ fontFamily: "var(--inv-font-mono)" }}>{item.product.sku ?? "—"}</td>
                    <td>{name}</td>
                    <td className="num" style={{ fontFamily: "var(--inv-font-mono)" }}>
                      {po.status === "partially_received" ? outstandingQuantity(item) : item.quantityOrdered}
                    </td>
                    <td className="num" style={{ fontFamily: "var(--inv-font-mono)" }}>{formatCurrency(item.unitCost, currency)}</td>
                    <td className="num" style={{ fontFamily: "var(--inv-font-mono)" }}>{formatCurrency(item.quantityOrdered * item.unitCost, currency)}</td>
                    {receivable && <td></td>}
                  </tr>
                );
              })}
              <tr>
                <td colSpan={4} style={{ textAlign: "right", fontWeight: 700 }}>Total</td>
                <td className="num" style={{ fontWeight: 700, fontFamily: "var(--inv-font-mono)" }}>{formatCurrency(po.totalCost, currency)}</td>
                {receivable && <td></td>}
              </tr>
            </tbody>
          </table>

          {po.notes && <div style={{ marginTop: "12px", fontSize: "12px" }}><b>Notes:</b> {po.notes}</div>}
          {receivable && (
            <div style={{ marginTop: "18px", fontSize: "11.5px", display: "flex", justifyContent: "space-between" }}>
              <span>Received by ______________________</span>
              <span>Date __________</span>
            </div>
          )}
        </div>
      </PrintSheet>

      <div style={{ maxWidth: "var(--inv-content-max)", margin: "0 auto", padding: "22px var(--inv-gutter) 80px" }}>
        <PageHead
          eyebrow="Purchase order"
          title={po.poNumber}
          right={
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              {po.status === "draft" && !isEditing && (
                <Button variant="ghost" onClick={() => setIsEditing(true)}>Edit</Button>
              )}
              <POStatusPill status={po.status} />
            </div>
          }
        />

        {fetcher.data?.error && (
          <Card padding="12px 16px" style={{ marginBottom: "16px", borderColor: "var(--inv-status-critical-dot)" }}>
            <span style={{ color: "var(--inv-status-critical-fg)", fontSize: "13px" }}>{fetcher.data.error}</span>
          </Card>
        )}

        {isEditing ? (
          <>
            <Card style={{ marginBottom: "14px" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "16px" }}>Order details</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "16px" }}>
                <div>
                  <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>Supplier</label>
                  <SelectInput value={draftSupplierId} onChange={(e) => setDraftSupplierId(e.target.value)}>
                    <option value="">— No supplier —</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </SelectInput>
                </div>
                <div>
                  <label style={{ fontSize: "12px", color: "var(--inv-text-2)", display: "block", marginBottom: "6px" }}>Notes</label>
                  <TextArea value={draftNotes} onChange={(e) => setDraftNotes(e.target.value)} rows={2} />
                </div>
              </div>
            </Card>

            <Card style={{ marginBottom: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                <div style={{ fontSize: "15px", fontWeight: 600 }}>Line items</div>
                <Button variant="ghost" onClick={addDraftLine}>+ Add item</Button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {draftLines.map((line, idx) => (
                  <div key={idx} style={{ display: "grid", gridTemplateColumns: "2.2fr 1fr 1fr 1fr auto", gap: "10px", alignItems: "center" }}>
                    <ProductCombobox
                      value={line.productId}
                      valueLabel={line.label || null}
                      onChange={(id, product) => setDraftLineProduct(idx, id, product?.label ?? "", product?.unitCost)}
                    />
                    <TextInput type="number" min={1} value={line.quantity} onChange={(e) => updateDraftLine(idx, "quantity", e.target.value)} />
                    <TextInput type="number" min={0} step={0.01} value={line.unitCost} onChange={(e) => updateDraftLine(idx, "unitCost", e.target.value)} />
                    <span style={{ fontFamily: "var(--inv-font-mono)", fontSize: "13px" }}>{formatCurrency(line.quantity * line.unitCost, currency)}</span>
                    <button
                      onClick={() => removeDraftLine(idx)}
                      style={{ fontSize: "11.5px", border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-status-stockout-fg)", padding: "6px 10px", borderRadius: "8px", cursor: "pointer" }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ height: "1px", background: "var(--inv-divider)", margin: "16px 0" }} />
              <div style={{ textAlign: "right", fontSize: "15px", fontWeight: 600 }}>Total: {formatCurrency(draftTotal, currency)}</div>
            </Card>

            <div style={{ display: "flex", gap: "9px", justifyContent: "flex-end", marginBottom: "18px" }}>
              <Button variant="ghost" onClick={() => setIsEditing(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={isBusy || draftLines.length === 0 || draftLines.some((l) => !l.productId)}
                onClick={saveDraft}
              >
                Save changes
              </Button>
            </div>
          </>
        ) : (
          <>
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
          </>
        )}

        {!isEditing && (
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
              <div style={{ display: "flex", gap: "9px", flexWrap: "wrap", alignItems: "center" }}>
                <Button
                  variant="primary"
                  disabled={isBusy}
                  onClick={() => fetcher.submit({ intent: "mark_sent", expectedDeliveryDate: expectedDate }, { method: "POST" })}
                >
                  Mark as sent to supplier
                </Button>
                <EmailSupplierButton po={po} isBusy={isBusy} fetcher={fetcher} />
              </div>
            </div>
          )}

          {receivable && (
            <div>
              {po.status === "partially_received" && (
                <div style={{ fontSize: "12.5px", marginBottom: "14px" }}>
                  <b>{totalOutstanding}</b> unit{totalOutstanding === 1 ? "" : "s"} still on order from earlier
                  deliveries. Book the next delivery below when it arrives.
                </div>
              )}
              <div style={{ marginBottom: "14px" }}>
                <EmailSupplierButton po={po} isBusy={isBusy} fetcher={fetcher} />
              </div>
              <div style={{ marginBottom: "14px" }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px", marginBottom: "6px" }}>
                  <label style={{ fontSize: "12px", color: "var(--inv-text-2)" }}>Scan to count receipts</label>
                  <button
                    type="button"
                    onClick={() =>
                      setReceivedQtys(Object.fromEntries(po.items.map((i) => [i.id, "0"])))
                    }
                    style={{ fontSize: "11px", border: "1px solid var(--inv-input-border-2)", background: "#fff", color: "var(--inv-text-2)", padding: "3px 9px", borderRadius: "7px", cursor: "pointer" }}
                  >
                    Zero the counts to scan
                  </button>
                </div>
                <ScanInput
                  placeholder="Scan each item as you unpack, then press Enter"
                  hint="Each scan adds 1 to that line's quantity in this delivery. Zero the counts first, scan a run of boxes, then confirm below."
                  onScan={(scanned) => {
                    // Match the scanned product to a line on this PO and tick it up. A
                    // scanned code that is a real product but not on this PO is a wrong
                    // delivery, so it is refused rather than silently ignored.
                    const productLines = po.items.filter((i) => i.productId === scanned.id);
                    if (productLines.length === 0) {
                      shopify.toast.show(`${scanned.label} is not on this purchase order`, { isError: true });
                      return;
                    }
                    setReceivedQtys((prev) => {
                      // A product can appear on more than one line. Fill the first line
                      // that still has room before spilling onto the next, so scanning a
                      // box of N never overshoots one line while another sits empty.
                      const target =
                        productLines.find((l) => {
                          const got = parseInt(prev[l.id] ?? "0", 10);
                          return (Number.isFinite(got) ? got : 0) < outstandingQuantity(l);
                        }) ?? productLines[0];
                      const current = parseInt(prev[target.id] ?? "0", 10);
                      const next = (Number.isFinite(current) ? current : 0) + 1;
                      return { ...prev, [target.id]: String(next) };
                    });
                    shopify.toast.show(`${scanned.label} — counted`);
                  }}
                />
              </div>
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
                Enter what arrived in this delivery. Stock updates accordingly.
              </div>

              {/* Only asked when the delivery as entered leaves something outstanding. The
                  default keeps it on order: closing is the step that cannot be undone. */}
              {shortUnits > 0 && (
                <div style={{ marginBottom: "14px", padding: "10px 12px", background: "var(--inv-subtle)", borderRadius: "9px" }}>
                  <div style={{ fontSize: "12.5px", fontWeight: 600, marginBottom: "8px" }}>
                    {shortUnits} unit{shortUnits === 1 ? "" : "s"} will still be outstanding after this delivery
                  </div>
                  <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "12.5px", marginBottom: "6px", cursor: "pointer" }}>
                    <input type="radio" name="remainder" checked={remainder === "keep"} onChange={() => setRemainder("keep")} />
                    <span>
                      <b>Keep on order</b> — the supplier will send the rest. The PO stays open and the units still
                      count as incoming stock.
                    </span>
                  </label>
                  <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "12.5px", cursor: "pointer" }}>
                    <input type="radio" name="remainder" checked={remainder === "close"} onChange={() => setRemainder("close")} />
                    <span>
                      <b>Close short</b> — the supplier won't send the rest. The {shortUnits} unit{shortUnits === 1 ? "" : "s"} are
                      cancelled and the PO is closed.
                    </span>
                  </label>
                </div>
              )}

              <Button
                variant="primary"
                // A delivery of nothing that also keeps everything open would change nothing.
                disabled={isBusy || (deliveryUnits === 0 && !(shortUnits > 0 && remainder === "close"))}
                onClick={() => {
                  const data: Record<string, string> = {
                    intent: "mark_received",
                    actualDeliveryDate: actualDate,
                    receiptVersion: String(po.receiptVersion),
                    remainder: shortUnits > 0 ? remainder : "keep",
                  };
                  // The server takes running totals, so a repeated submit of this same
                  // form asks for nothing new instead of booking the delivery twice.
                  po.items.forEach((item) => {
                    data[`received_${item.id}`] = String(item.quantityReceived + deliveryQty(item.id));
                  });
                  fetcher.submit(data, { method: "POST" });
                }}
              >
                {deliveryUnits === 0
                  ? "Close short — no delivery"
                  : `Confirm ${deliveryUnits} unit${deliveryUnits === 1 ? "" : "s"} received — update stock`}
              </Button>
            </div>
          )}

          {po.status === "received" && (
            <div style={{ fontSize: "12.5px", color: "var(--inv-status-healthy-fg)", fontWeight: 500 }}>
              ✓ Received in full
              {po.receipts.length > 1
                ? ` across ${po.receipts.length} deliveries`
                : po.actualDeliveryDate
                  ? ` on ${formatDate(po.actualDeliveryDate, timezone)}`
                  : ""}
              . Stock has been updated.
            </div>
          )}

          {po.status === "closed" && (
            <div style={{ fontSize: "12.5px", color: "var(--inv-text-2)", fontWeight: 500 }}>
              Closed short — {totalCancelled} unit{totalCancelled === 1 ? " was" : "s were"} never delivered and{" "}
              {totalCancelled === 1 ? "is" : "are"} no longer expected. Everything that did arrive is in stock.
            </div>
          )}
        </Card>
        )}

        {!isEditing && po.receipts.length > 0 && (
          <Card style={{ marginBottom: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "10px" }}>Deliveries</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {po.receipts.map((receipt, idx) => {
                const units = receipt.lines.reduce((s, l) => s + l.quantity, 0);
                return (
                  <div key={receipt.id} style={{ display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "12.5px" }}>
                    <span>
                      Delivery {idx + 1} · {formatDate(receipt.receivedAt, timezone)}
                    </span>
                    <span style={{ fontFamily: "var(--inv-font-mono)", color: "var(--inv-text-2)" }}>
                      {units} unit{units === 1 ? "" : "s"} · {receipt.lines.length} line{receipt.lines.length === 1 ? "" : "s"}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {!isEditing && po.status === "partially_received" && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "18px", fontSize: "12px", color: "var(--inv-muted)" }}>
            <span>Supplier won't send the remaining {totalOutstanding} unit{totalOutstanding === 1 ? "" : "s"}?</span>
            <Button
              variant="ghost"
              disabled={isBusy}
              onClick={() => {
                if (
                  window.confirm(
                    `Close ${po.poNumber} short?\n\n${totalOutstanding} outstanding unit${totalOutstanding === 1 ? "" : "s"} will be cancelled and no longer count as incoming stock. This cannot be undone.`,
                  )
                ) {
                  fetcher.submit(
                    { intent: "close_remaining", receiptVersion: String(po.receiptVersion) },
                    { method: "POST" },
                  );
                }
              }}
            >
              Close remaining
            </Button>
          </div>
        )}

        <div style={{ display: "flex", gap: "9px" }}>
          <Link to="/app/purchase-orders">
            <Button variant="ghost">← Back to Purchase Orders</Button>
          </Link>
          <Button variant="ghost" onClick={() => window.print()}>Print PO</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Sends the order to the supplier and says what it did.
 *
 * The button is disabled with a reason rather than hidden when it cannot be used: a
 * missing supplier email is a thing the merchant can fix, and a control that silently
 * vanishes teaches nobody. Re-sending stays available — suppliers lose emails — but the
 * label makes clear it would be a repeat.
 */
function EmailSupplierButton({
  po,
  isBusy,
  fetcher,
}: {
  po: { supplier: { name: string; email: string | null } | null; emailedAt: string | Date | null; emailedTo: string | null };
  isBusy: boolean;
  fetcher: { submit: (data: Record<string, string>, opts: { method: "POST" }) => void };
}) {
  const email = po.supplier?.email?.trim() || null;
  const blocked = !po.supplier
    ? "Assign a supplier first"
    : !email
      ? `${po.supplier.name} has no email address on file`
      : null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "9px", flexWrap: "wrap" }}>
      <Button
        variant="ghost"
        disabled={isBusy || blocked !== null}
        onClick={() => fetcher.submit({ intent: "email_supplier" }, { method: "POST" })}
      >
        {po.emailedAt ? "Email again" : "Email to supplier"}
      </Button>
      <span style={{ fontSize: "11.5px", color: "var(--inv-muted)" }}>
        {blocked
          ? blocked
          : po.emailedAt
            ? `Sent to ${po.emailedTo} on ${new Date(po.emailedAt).toISOString().slice(0, 10)}`
            : `Will send to ${email}`}
      </span>
    </div>
  );
}
