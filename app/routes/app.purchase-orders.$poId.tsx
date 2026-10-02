import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { formatCurrency, formatDate } from "../lib/format";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Button, Card, DataTable, PageHead, Pill, POStatusPill, PrintSheet, ProductCombobox, ProductThumb, ScanInput, SelectInput, TextArea, TextInput, type DataTableColumn } from "../design";
import {
  closePurchaseOrderRemainder,
  markPurchaseOrderSent,
  parseReceivedQuantities,
  receivePurchaseOrder,
  validateDraftLines,
  validateSupplierId,
} from "../lib/purchase-order.server";
import { outstandingQuantity } from "../lib/purchase-order-status";
import {
  createSupplierClaim,
  disposeClaimLine,
  resolveClaim,
  submitClaim,
} from "../lib/supplier-claim.server";
import {
  CLAIM_STATUS_LABELS,
  CLAIM_TYPE_LABELS,
  CLAIM_TYPES,
  DISPOSITION_LABELS,
  effectiveClaimQuantity,
  quarantinedQuantity,
  type ClaimDisposition,
  type ClaimStatus,
  type ClaimType,
} from "../lib/supplier-claim";
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
        include: { lines: { select: { purchaseOrderItemId: true, quantity: true, quantityDamaged: true } } },
        orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }],
      },
      claims: {
        include: { lines: { orderBy: { createdAt: "asc" } } },
        orderBy: { createdAt: "asc" },
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
      damaged: Object.fromEntries(
        po.items.map((i) => {
          const raw = formData.get(`damaged_${i.id}`);
          return [i.id, raw === null || raw === "" ? 0 : parseInt(String(raw), 10)];
        }),
      ),
      closeRemaining: formData.get("remainder") === "close",
      claimMissing: formData.get("claimMissing") === "1",
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
      ...(result.claimError ? [result.claimError] : []),
    ];
    return {
      ok: true as const,
      action: `received:${result.status ?? ""}${result.claimId ? ":claim" : ""}`,
      error: problems.length > 0 ? problems.join("; ") : "",
    };
  }

  if (intent === "close_remaining") {
    const result = await closePurchaseOrderRemainder(shop, po.id, {
      expectedVersion: parseVersion(formData.get("receiptVersion")),
      claimMissing: formData.get("claimMissing") === "1",
      userId: sessionToken?.sub ?? null,
    });
    if (!result.ok) {
      return { ok: false as const, error: result.error ?? "Could not close", action: "" };
    }
    return { ok: true as const, action: result.claimId ? "closed:claim" : "closed", error: "" };
  }

  if (intent === "create_claim") {
    const result = await createSupplierClaim(admin, shop, po.id, {
      lines: po.items.map((i) => {
        const raw = formData.get(`claimQty_${i.id}`);
        return {
          purchaseOrderItemId: i.id,
          type: String(formData.get(`claimType_${i.id}`) ?? "damaged"),
          quantity: raw === null || raw === "" ? 0 : Number(raw),
          stockSource: String(formData.get(`claimSource_${i.id}`) ?? "on_hand"),
        };
      }),
      notes: (formData.get("notes") as string) || null,
      userId: sessionToken?.sub ?? null,
    });
    if (!result.ok) return { ok: false as const, error: result.error ?? "Could not open the claim", action: "" };
    return { ok: true as const, action: "claim_opened", error: result.shopifyWarnings.join("; ") };
  }

  if (intent === "dispose_claim_line") {
    const result = await disposeClaimLine(
      admin,
      shop,
      String(formData.get("lineId") ?? ""),
      String(formData.get("disposition") ?? ""),
      Number(formData.get("quantity")),
    );
    if (!result.ok) return { ok: false as const, error: result.error ?? "Could not update the claim", action: "" };
    return { ok: true as const, action: `disposed:${formData.get("disposition")}`, error: result.shopifyWarning ?? "" };
  }

  if (intent === "submit_claim") {
    const result = await submitClaim(shop, String(formData.get("claimId") ?? ""));
    if (!result.ok) return { ok: false as const, error: result.error ?? "Could not update the claim", action: "" };
    return { ok: true as const, action: "claim_submitted", error: "" };
  }

  if (intent === "resolve_claim") {
    const claimId = String(formData.get("claimId") ?? "");
    const claim = await prisma.supplierClaim.findFirst({
      where: { id: claimId, shop, purchaseOrderId: po.id },
      select: { lines: { select: { id: true } } },
    });
    if (!claim) return { ok: false as const, error: "Claim not found", action: "" };
    const result = await resolveClaim(
      shop,
      claimId,
      claim.lines.map((l) => {
        const credit = formData.get(`credit_${l.id}`);
        return {
          lineId: l.id,
          quantityAccepted: Number(formData.get(`accepted_${l.id}`)),
          // Blank means "accepted units at cost"; anything typed is taken as agreed.
          creditAmount: credit === null || credit === "" ? null : Number(credit),
        };
      }),
    );
    if (!result.ok) return { ok: false as const, error: result.error ?? "Could not resolve the claim", action: "" };
    return { ok: true as const, action: "claim_resolved", error: "" };
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
  // Units of this delivery that arrived damaged, per line.
  const [damagedQtys, setDamagedQtys] = useState<Record<string, string>>({});
  // When closing short: were the undelivered units invoiced, so the supplier owes for them?
  const [claimMissing, setClaimMissing] = useState(false);
  // A booked delivery bumps receiptVersion and the loader revalidates; start the next
  // delivery from the new outstanding figures rather than re-showing the last one.
  useEffect(() => {
    setReceivedQtys(outstandingDefaults());
    setRemainder("keep");
    setDamagedQtys({});
    setClaimMissing(false);
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
      const raw = fetcher.data.action;
      // Receipts and closes append ":claim" when they opened a supplier claim.
      const claimNote = raw.endsWith(":claim") ? " — supplier claim opened" : "";
      const action = raw.replace(/:claim$/, "");
      const messages: Record<string, string> = {
        "received:received": "Delivery received — PO complete, stock updated",
        "received:partially_received": "Delivery received — the rest stays on order",
        "received:closed": "Delivery received — remainder cancelled, PO closed",
        closed: "Remaining units cancelled — PO closed",
        claim_opened: "Supplier claim opened",
        claim_submitted: "Claim marked as sent to the supplier",
        claim_resolved: "Supplier decision recorded",
        draft_updated: "Draft PO updated",
      };
      const msg = action.startsWith("emailed:")
        ? `Purchase order emailed to ${action.slice("emailed:".length)}`
        : (messages[action] ??
          (action.startsWith("received")
            ? "Delivery received — stock updated"
            : action.startsWith("disposed:")
              ? "Claim stock updated"
              : "PO updated"));
      // Line failures and Shopify warnings ride along on a successful action.
      if (fetcher.data.error) shopify.toast.show(`${msg}${claimNote} — but: ${fetcher.data.error}`, { isError: true });
      else shopify.toast.show(`${msg}${claimNote}`);
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
  const damagedQty = (itemId: string) => {
    const n = parseInt(damagedQtys[itemId] ?? "0", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const damagedUnits = po.items.reduce((s, i) => s + damagedQty(i.id), 0);
  const damagedOver = po.items.some((i) => damagedQty(i.id) > deliveryQty(i.id));
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
    ...(receivable
      ? [
          { header: "This delivery", width: "1.2fr", align: "right" as const },
          { header: "Damaged", width: "1fr", align: "right" as const },
        ]
      : []),
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
              <TextInput
                key="damaged"
                type="number"
                min={0}
                placeholder="0"
                title="Of this delivery, units that arrived damaged. They go into quarantine, not sellable stock, and a supplier claim is opened."
                value={damagedQtys[item.id] ?? ""}
                onChange={(e) => setDamagedQtys((prev) => ({ ...prev, [item.id]: e.target.value }))}
                style={{
                  height: "32px",
                  textAlign: "right",
                  ...(damagedQty(item.id) > deliveryQty(item.id) ? { borderColor: "var(--inv-status-critical-dot)" } : {}),
                }}
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
                  {remainder === "close" && (
                    <ClaimMissingCheckbox units={shortUnits} checked={claimMissing} onChange={setClaimMissing} />
                  )}
                </div>
              )}

              {damagedUnits > 0 && (
                <div style={{ fontSize: "12px", marginBottom: "14px", color: damagedOver ? "var(--inv-status-critical-fg)" : "var(--inv-text-2)" }}>
                  {damagedOver
                    ? "Damaged units can't exceed what arrived in this delivery on that line."
                    : `${damagedUnits} damaged unit${damagedUnits === 1 ? "" : "s"} will go into quarantine — counted as received, kept out of sellable stock in Shopify — and a supplier claim will be opened for them.`}
                </div>
              )}

              <Button
                variant="primary"
                // A delivery of nothing that also keeps everything open would change nothing.
                disabled={isBusy || damagedOver || (deliveryUnits === 0 && !(shortUnits > 0 && remainder === "close"))}
                onClick={() => {
                  const data: Record<string, string> = {
                    intent: "mark_received",
                    actualDeliveryDate: actualDate,
                    receiptVersion: String(po.receiptVersion),
                    remainder: shortUnits > 0 ? remainder : "keep",
                    claimMissing: shortUnits > 0 && remainder === "close" && claimMissing ? "1" : "0",
                  };
                  // The server takes running totals, so a repeated submit of this same
                  // form asks for nothing new instead of booking the delivery twice.
                  po.items.forEach((item) => {
                    data[`received_${item.id}`] = String(item.quantityReceived + deliveryQty(item.id));
                    data[`damaged_${item.id}`] = String(damagedQty(item.id));
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
                const damaged = receipt.lines.reduce((s, l) => s + l.quantityDamaged, 0);
                return (
                  <div key={receipt.id} style={{ display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "12.5px" }}>
                    <span>
                      Delivery {idx + 1} · {formatDate(receipt.receivedAt, timezone)}
                    </span>
                    <span style={{ fontFamily: "var(--inv-font-mono)", color: "var(--inv-text-2)" }}>
                      {units} unit{units === 1 ? "" : "s"}
                      {damaged > 0 ? ` (${damaged} damaged)` : ""} · {receipt.lines.length} line
                      {receipt.lines.length === 1 ? "" : "s"}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {!isEditing && (
          <SupplierClaims
            items={po.items}
            claims={po.claims}
            canReport={po.status === "partially_received" || po.status === "received" || po.status === "closed"}
            fetcher={fetcher}
            isBusy={isBusy}
            currency={currency}
            timezone={timezone}
          />
        )}

        {!isEditing && po.status === "partially_received" && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "18px", fontSize: "12px", color: "var(--inv-muted)" }}>
            <span>Supplier won't send the remaining {totalOutstanding} unit{totalOutstanding === 1 ? "" : "s"}?</span>
            <ClaimMissingCheckbox units={totalOutstanding} checked={claimMissing} onChange={setClaimMissing} compact />
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
                    {
                      intent: "close_remaining",
                      receiptVersion: String(po.receiptVersion),
                      claimMissing: claimMissing ? "1" : "0",
                    },
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

/**
 * Whether the undelivered units of a short-closed PO become a supplier claim.
 *
 * Off by default: most of the time a short close is just a smaller order nobody was
 * billed for. It matters when the supplier invoiced the full quantity (or was paid in
 * advance) and so owes for what never came.
 */
function ClaimMissingCheckbox({
  units,
  checked,
  onChange,
  compact = false,
}: {
  units: number;
  checked: boolean;
  onChange: (v: boolean) => void;
  compact?: boolean;
}) {
  return (
    <label
      style={{
        display: "flex",
        gap: "8px",
        alignItems: "flex-start",
        fontSize: "12px",
        cursor: "pointer",
        ...(compact ? {} : { marginTop: "8px", paddingLeft: "22px" }),
      }}
    >
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        Claim the {units} missing unit{units === 1 ? "" : "s"} from the supplier
        {compact ? "" : " — they were invoiced or paid for but never sent"}
      </span>
    </label>
  );
}

type ClaimFetcher = { submit: (data: Record<string, string>, opts: { method: "POST" }) => void };

interface ClaimItem {
  id: string;
  quantityReceived: number;
  quantityCancelled: number;
  unitCost: number;
  product: { title: string; variantTitle: string | null };
}

interface ClaimLineView {
  id: string;
  purchaseOrderItemId: string;
  type: string;
  quantity: number;
  unitCost: number;
  stockSource: string;
  quantityWrittenOff: number;
  quantityReturned: number;
  quantityRestocked: number;
  quantityFound: number;
  decision: string;
  quantityAccepted: number;
  creditAmount: number;
}

interface ClaimView {
  id: string;
  claimNumber: string;
  status: string;
  notes: string | null;
  createdAt: string | Date;
  submittedAt: string | Date | null;
  lines: ClaimLineView[];
}

const CLAIM_STATUS_COLORS: Record<ClaimStatus, { bg: string; fg: string }> = {
  open: { bg: "var(--inv-status-low-bg)", fg: "var(--inv-status-low-fg)" },
  submitted: { bg: "var(--inv-status-low-bg)", fg: "var(--inv-status-low-fg)" },
  resolved: { bg: "var(--inv-status-healthy-bg)", fg: "var(--inv-status-healthy-fg)" },
};

const itemName = (item: ClaimItem | undefined) =>
  !item ? "—" : item.product.variantTitle ? `${item.product.title} — ${item.product.variantTitle}` : item.product.title;

const smallButton: React.CSSProperties = {
  fontSize: "11.5px",
  border: "1px solid var(--inv-input-border-2)",
  background: "#fff",
  padding: "5px 10px",
  borderRadius: "8px",
  cursor: "pointer",
};

/**
 * What the supplier owes for this PO: open claims, the stock each one holds, and the
 * supplier's answer. Claims for damage found while receiving, and for units missing on a
 * short close, are opened by those flows; "Report a problem" covers everything found
 * afterwards.
 */
function SupplierClaims({
  items,
  claims,
  canReport,
  fetcher,
  isBusy,
  currency,
  timezone,
}: {
  items: ClaimItem[];
  claims: ClaimView[];
  canReport: boolean;
  fetcher: ClaimFetcher;
  isBusy: boolean;
  currency: string;
  timezone: string;
}) {
  const [reporting, setReporting] = useState(false);
  const itemsById = new Map(items.map((i) => [i.id, i]));

  // A submitted report leaves the form open on failure, so a typo is fixed in place.
  const claimCount = claims.length;
  useEffect(() => setReporting(false), [claimCount]);

  if (!canReport && claims.length === 0) return null;

  return (
    <Card style={{ marginBottom: "18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600 }}>Supplier claims</div>
        {canReport && !reporting && (
          <Button variant="ghost" onClick={() => setReporting(true)}>
            Report a problem
          </Button>
        )}
      </div>

      {claims.length === 0 && !reporting && (
        <div style={{ fontSize: "12.5px", color: "var(--inv-muted)" }}>
          Missing, damaged, defective or wrong items found after receiving can be claimed from the supplier here.
        </div>
      )}

      {reporting && (
        <ReportProblemForm items={items} fetcher={fetcher} isBusy={isBusy} onCancel={() => setReporting(false)} />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        {claims.map((claim) => (
          <ClaimCard
            key={claim.id}
            claim={claim}
            itemsById={itemsById}
            fetcher={fetcher}
            isBusy={isBusy}
            currency={currency}
            timezone={timezone}
          />
        ))}
      </div>
    </Card>
  );
}

function ReportProblemForm({
  items,
  fetcher,
  isBusy,
  onCancel,
}: {
  items: ClaimItem[];
  fetcher: ClaimFetcher;
  isBusy: boolean;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<Record<string, { type: ClaimType; qty: string; source: string }>>(() =>
    Object.fromEntries(items.map((i) => [i.id, { type: "damaged" as ClaimType, qty: "", source: "on_hand" }])),
  );
  const [notes, setNotes] = useState("");
  const set = (id: string, patch: Partial<{ type: ClaimType; qty: string; source: string }>) =>
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  const anyQty = Object.values(rows).some((r) => parseInt(r.qty, 10) > 0);

  return (
    <div style={{ padding: "12px", background: "var(--inv-subtle)", borderRadius: "10px", marginBottom: "14px" }}>
      <div style={{ fontSize: "12px", color: "var(--inv-text-2)", marginBottom: "10px" }}>
        Enter a quantity on each line with a problem. Units still in sellable stock are taken out of it: damaged,
        defective and wrong items go into quarantine; missing ones are removed.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 0.8fr 1.6fr", gap: "8px", alignItems: "center", fontSize: "12px" }}>
        <span style={{ color: "var(--inv-muted)" }}>Product</span>
        <span style={{ color: "var(--inv-muted)" }}>Problem</span>
        <span style={{ color: "var(--inv-muted)" }}>Qty</span>
        <span style={{ color: "var(--inv-muted)" }}>Where are the units?</span>
        {items.map((item) => {
          const row = rows[item.id];
          return (
            <Fragment key={item.id}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {itemName(item)}
                <span style={{ color: "var(--inv-muted)" }}> · {item.quantityReceived} received</span>
              </span>
              <SelectInput value={row.type} onChange={(e) => set(item.id, { type: e.target.value as ClaimType })}>
                {CLAIM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CLAIM_TYPE_LABELS[t]}
                  </option>
                ))}
              </SelectInput>
              <TextInput type="number" min={0} placeholder="0" value={row.qty} onChange={(e) => set(item.id, { qty: e.target.value })} />
              <SelectInput value={row.source} onChange={(e) => set(item.id, { source: e.target.value })}>
                <option value="on_hand">In sellable stock — take them out</option>
                <option value="none">
                  {row.type === "missing" ? "Never delivered (short-closed)" : "Not in stock — sold or gone"}
                </option>
              </SelectInput>
            </Fragment>
          );
        })}
      </div>
      <div style={{ marginTop: "10px" }}>
        <TextArea placeholder="Notes for the claim (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </div>
      <div style={{ display: "flex", gap: "9px", justifyContent: "flex-end", marginTop: "10px" }}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={isBusy || !anyQty}
          onClick={() => {
            const data: Record<string, string> = { intent: "create_claim", notes };
            for (const item of items) {
              const row = rows[item.id];
              data[`claimQty_${item.id}`] = row.qty || "0";
              data[`claimType_${item.id}`] = row.type;
              data[`claimSource_${item.id}`] = row.source;
            }
            fetcher.submit(data, { method: "POST" });
          }}
        >
          Open claim
        </Button>
      </div>
    </div>
  );
}

function ClaimCard({
  claim,
  itemsById,
  fetcher,
  isBusy,
  currency,
  timezone,
}: {
  claim: ClaimView;
  itemsById: Map<string, ClaimItem>;
  fetcher: ClaimFetcher;
  isBusy: boolean;
  currency: string;
  timezone: string;
}) {
  const [deciding, setDeciding] = useState(false);
  const status = (claim.status as ClaimStatus) in CLAIM_STATUS_COLORS ? (claim.status as ClaimStatus) : "open";
  const resolved = status === "resolved";
  const totalCredit = claim.lines.reduce((s, l) => s + l.creditAmount, 0);
  const totalAccepted = claim.lines.reduce((s, l) => s + l.quantityAccepted, 0);
  const totalClaimed = claim.lines.reduce((s, l) => s + effectiveClaimQuantity(l), 0);

  return (
    <div style={{ border: "1px solid var(--inv-divider)", borderRadius: "10px", padding: "12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "10px" }}>
        <span style={{ fontFamily: "var(--inv-font-mono)", fontSize: "12.5px", fontWeight: 600 }}>{claim.claimNumber}</span>
        <Pill label={CLAIM_STATUS_LABELS[status]} bg={CLAIM_STATUS_COLORS[status].bg} fg={CLAIM_STATUS_COLORS[status].fg} />
        <span style={{ fontSize: "11.5px", color: "var(--inv-muted)" }}>
          Opened {formatDate(claim.createdAt, timezone)}
          {claim.submittedAt ? ` · sent ${formatDate(claim.submittedAt, timezone)}` : ""}
        </span>
      </div>
      {claim.notes && <div style={{ fontSize: "12px", marginBottom: "10px" }}>{claim.notes}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {claim.lines.map((line) => (
          <ClaimLineRow
            key={line.id}
            line={line}
            name={itemName(itemsById.get(line.purchaseOrderItemId))}
            resolved={resolved}
            fetcher={fetcher}
            isBusy={isBusy}
            currency={currency}
          />
        ))}
      </div>

      {resolved ? (
        <div style={{ fontSize: "12.5px", marginTop: "10px", color: "var(--inv-status-healthy-fg)", fontWeight: 500 }}>
          Supplier accepted {totalAccepted} of {totalClaimed} unit{totalClaimed === 1 ? "" : "s"} · credit agreed{" "}
          {formatCurrency(totalCredit, currency)}
        </div>
      ) : deciding ? (
        <DecisionForm claim={claim} itemsById={itemsById} fetcher={fetcher} isBusy={isBusy} currency={currency} onCancel={() => setDeciding(false)} />
      ) : (
        <div style={{ display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" }}>
          {status === "open" && (
            <button
              type="button"
              style={smallButton}
              disabled={isBusy}
              onClick={() => fetcher.submit({ intent: "submit_claim", claimId: claim.id }, { method: "POST" })}
            >
              Mark sent to supplier
            </button>
          )}
          <button type="button" style={smallButton} disabled={isBusy} onClick={() => setDeciding(true)}>
            Record supplier decision
          </button>
        </div>
      )}
    </div>
  );
}

function ClaimLineRow({
  line,
  name,
  resolved,
  fetcher,
  isBusy,
  currency,
}: {
  line: ClaimLineView;
  name: string;
  resolved: boolean;
  fetcher: ClaimFetcher;
  isBusy: boolean;
  currency: string;
}) {
  const held = quarantinedQuantity(line);
  const effective = effectiveClaimQuantity(line);
  const canFind = line.type === "missing" && line.stockSource === "on_hand" && !resolved && effective > 0;
  const [qty, setQty] = useState(String(held || effective));
  useEffect(() => setQty(String(held || effective)), [held, effective]);

  const dispose = (disposition: ClaimDisposition) =>
    fetcher.submit({ intent: "dispose_claim_line", lineId: line.id, disposition, quantity: qty }, { method: "POST" });

  const history = [
    line.quantityWrittenOff > 0 && `${line.quantityWrittenOff} written off`,
    line.quantityReturned > 0 && `${line.quantityReturned} returned`,
    line.quantityRestocked > 0 && `${line.quantityRestocked} restocked`,
    line.quantityFound > 0 && `${line.quantityFound} found`,
  ].filter(Boolean);

  return (
    <div style={{ fontSize: "12.5px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
        <span>
          <b>{effective}</b> × {name} · {CLAIM_TYPE_LABELS[line.type as ClaimType] ?? line.type}
          <span style={{ color: "var(--inv-muted)" }}>
            {" "}
            · {formatCurrency(line.unitCost, currency)} each
            {line.stockSource === "none" ? " · no stock held" : ""}
            {history.length > 0 ? ` · ${history.join(", ")}` : ""}
          </span>
        </span>
        <span style={{ color: "var(--inv-text-2)" }}>
          {held > 0 && <span style={{ color: "var(--inv-status-critical-fg)" }}>{held} in quarantine · </span>}
          {resolved
            ? line.decision === "rejected"
              ? "rejected"
              : `${line.quantityAccepted} accepted · ${formatCurrency(line.creditAmount, currency)}`
            : "awaiting supplier"}
        </span>
      </div>
      {(held > 0 || canFind) && (
        <div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "6px", flexWrap: "wrap" }}>
          <TextInput
            type="number"
            min={1}
            max={held || effective}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            style={{ width: "72px", height: "30px", textAlign: "right" }}
          />
          {held > 0 &&
            (["return_to_vendor", "write_off", "restock"] as ClaimDisposition[]).map((d) => (
              <button key={d} type="button" style={smallButton} disabled={isBusy} onClick={() => dispose(d)}>
                {DISPOSITION_LABELS[d]}
              </button>
            ))}
          {canFind && (
            <button type="button" style={smallButton} disabled={isBusy} onClick={() => dispose("found")}>
              Found — put back in stock
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DecisionForm({
  claim,
  itemsById,
  fetcher,
  isBusy,
  currency,
  onCancel,
}: {
  claim: ClaimView;
  itemsById: Map<string, ClaimItem>;
  fetcher: ClaimFetcher;
  isBusy: boolean;
  currency: string;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, { accepted: string; credit: string }>>(() =>
    Object.fromEntries(claim.lines.map((l) => [l.id, { accepted: String(effectiveClaimQuantity(l)), credit: "" }])),
  );
  const set = (id: string, patch: Partial<{ accepted: string; credit: string }>) =>
    setValues((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  return (
    <div style={{ marginTop: "10px", padding: "10px", background: "var(--inv-subtle)", borderRadius: "9px" }}>
      <div style={{ fontSize: "12px", color: "var(--inv-text-2)", marginBottom: "8px" }}>
        How much did the supplier accept? Leave credit blank for accepted units at cost; enter an amount if you agreed
        something else, or 0 if they are sending replacements instead.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 0.8fr 1fr", gap: "8px", alignItems: "center", fontSize: "12px" }}>
        <span style={{ color: "var(--inv-muted)" }}>Line</span>
        <span style={{ color: "var(--inv-muted)" }}>Accepted</span>
        <span style={{ color: "var(--inv-muted)" }}>Credit</span>
        {claim.lines.map((l) => {
          const v = values[l.id];
          const accepted = parseInt(v.accepted, 10);
          const atCost = (Number.isFinite(accepted) ? accepted : 0) * l.unitCost;
          return (
            <Fragment key={l.id}>
              <span>
                {effectiveClaimQuantity(l)} × {itemName(itemsById.get(l.purchaseOrderItemId))}
              </span>
              <TextInput type="number" min={0} max={effectiveClaimQuantity(l)} value={v.accepted} onChange={(e) => set(l.id, { accepted: e.target.value })} />
              <TextInput
                type="number"
                min={0}
                step={0.01}
                placeholder={formatCurrency(atCost, currency)}
                value={v.credit}
                onChange={(e) => set(l.id, { credit: e.target.value })}
              />
            </Fragment>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: "9px", justifyContent: "flex-end", marginTop: "10px" }}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={isBusy}
          onClick={() => {
            const data: Record<string, string> = { intent: "resolve_claim", claimId: claim.id };
            for (const l of claim.lines) {
              data[`accepted_${l.id}`] = values[l.id].accepted;
              data[`credit_${l.id}`] = values[l.id].credit;
            }
            fetcher.submit(data, { method: "POST" });
          }}
        >
          Save decision
        </Button>
      </div>
    </div>
  );
}
