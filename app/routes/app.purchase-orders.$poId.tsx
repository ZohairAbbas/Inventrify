import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRouteLoaderData, Link } from "@remix-run/react";
import type { loader as appLoader } from "./app";
import { formatCurrency, formatDate } from "../lib/format";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useCallback, useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Button, Card, DataTable, PageHead, POStatusPill, ProductThumb, SelectInput, TextArea, TextInput, type DataTableColumn } from "../design";
import {
  markPurchaseOrderSent,
  parseReceivedQuantities,
  receivePurchaseOrder,
  validateDraftLines,
  validateSupplierId,
} from "../lib/purchase-order.server";
import { parseFormDate } from "../lib/date-range";
import { emailPurchaseOrderToSupplier } from "../lib/purchase-order-email.server";

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

  const [products, suppliers] = await Promise.all([
    prisma.product.findMany({ where: { shop: session.shop }, orderBy: { title: "asc" } }),
    prisma.supplier.findMany({ where: { shop: session.shop }, orderBy: { name: "asc" } }),
  ]);

  return { po, products, suppliers };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
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
    });

    if (!result.ok) {
      return { ok: false as const, error: result.error ?? "Could not receive", action: "" };
    }

    // A partial failure still receives what it could; the merchant needs to know which
    // lines did not move rather than seeing an unqualified success.
    const problems = [
      ...result.lines.filter((l) => l.error).map((l) => l.error as string),
      ...result.shopifyWarnings,
    ];
    return {
      ok: true as const,
      action: "received",
      error: problems.length > 0 ? problems.join("; ") : "",
    };
  }

  return { ok: true as const, action: "", error: "" };
};

interface DraftLine {
  productId: string;
  quantity: number;
  unitCost: number;
}

export default function PODetail() {
  const { po, products, suppliers } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const { timezone = "UTC", currency = "USD", theme = "emerald" } =
    useRouteLoaderData<typeof appLoader>("routes/app") ?? {};

  const [expectedDate, setExpectedDate] = useState(
    po.expectedDeliveryDate ? new Date(po.expectedDeliveryDate).toISOString().slice(0, 10) : "",
  );
  const [actualDate, setActualDate] = useState(new Date().toISOString().slice(0, 10));
  const [receivedQtys, setReceivedQtys] = useState<Record<string, string>>(
    Object.fromEntries(po.items.map((i) => [i.id, String(i.quantityOrdered)])),
  );

  const [isEditing, setIsEditing] = useState(false);
  const [draftSupplierId, setDraftSupplierId] = useState(po.supplierId ?? "");
  const [draftNotes, setDraftNotes] = useState(po.notes ?? "");
  const [draftLines, setDraftLines] = useState<DraftLine[]>(() =>
    po.items.map((item) => ({ productId: item.productId, quantity: item.quantityOrdered, unitCost: item.unitCost })),
  );

  const isBusy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.ok) {
      const action = fetcher.data.action;
      const msg = action.startsWith("emailed:")
        ? `Purchase order emailed to ${action.slice("emailed:".length)}`
        : action === "received"
          ? "PO marked as received — stock updated"
          : action === "draft_updated"
            ? "Draft PO updated"
            : "PO updated";
      shopify.toast.show(msg);
      if (fetcher.data.action === "draft_updated") setIsEditing(false);
    } else if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const addDraftLine = useCallback(() => {
    setDraftLines((l) => [...l, { productId: products[0]?.id ?? "", quantity: 1, unitCost: 0 }]);
  }, [products]);

  const removeDraftLine = useCallback((idx: number) => {
    setDraftLines((l) => l.filter((_, i) => i !== idx));
  }, []);

  const updateDraftLine = useCallback((idx: number, field: keyof DraftLine, value: string) => {
    setDraftLines((l) =>
      l.map((line, i) =>
        i === idx ? { ...line, [field]: field === "productId" ? value : parseFloat(value) || 0 } : line,
      ),
    );
  }, []);

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
    <div className="inv-root" data-theme={theme} style={{ minHeight: "100vh" }}>
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
                    <SelectInput value={line.productId} onChange={(e) => updateDraftLine(idx, "productId", e.target.value)}>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>{p.variantTitle ? `${p.title} — ${p.variantTitle}` : p.title}</option>
                      ))}
                    </SelectInput>
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
              <Button variant="primary" disabled={isBusy || draftLines.length === 0} onClick={saveDraft}>
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

          {po.status === "sent" && (
            <div>
              <div style={{ marginBottom: "14px" }}>
                <EmailSupplierButton po={po} isBusy={isBusy} fetcher={fetcher} />
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
        )}

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
