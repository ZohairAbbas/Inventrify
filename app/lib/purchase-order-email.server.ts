import { Resend } from "resend";
import prisma from "../db.server";
import { formatCurrency } from "./format";

/**
 * Email a purchase order to its supplier.
 *
 * "Mark as sent to supplier" previously changed a status and nothing else — the
 * supplier's address was stored and displayed but never used, so the only way to
 * actually place an order was Print/PDF and a manual email. That left the app's own
 * record of "sent" describing an intention rather than an event.
 *
 * This sends the order and records what was sent and where. It deliberately does not
 * touch `sentAt`: a merchant may phone the supplier or hand over a printout, so the
 * status stays theirs to set while `emailedAt` records a delivery the app can vouch for.
 */

/**
 * Product titles, supplier names and merchant notes are all free text controlled by
 * someone other than us, and this message is sent on the merchant's behalf to a third
 * party. Escaping is not optional.
 */
function esc(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

export interface SendPoResult {
  ok: boolean;
  error?: string;
  emailedTo?: string;
}

export async function emailPurchaseOrderToSupplier(
  poId: string,
  shop: string,
): Promise<SendPoResult> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, shop },
    include: {
      supplier: true,
      items: {
        include: {
          product: { select: { title: true, variantTitle: true, sku: true } },
        },
      },
    },
  });

  if (!po) return { ok: false, error: "Purchase order not found" };
  if (po.items.length === 0) {
    return { ok: false, error: "This purchase order has no line items to send" };
  }
  if (!po.supplier) {
    return { ok: false, error: "Assign a supplier before emailing this order" };
  }

  const to = po.supplier.email?.trim();
  if (!to) {
    return { ok: false, error: `${po.supplier.name} has no email address on file` };
  }
  if (!isEmail(to)) {
    // Better to refuse than to hand an obviously broken address to the provider and
    // report a generic failure the merchant cannot act on.
    return { ok: false, error: `${po.supplier.name}'s email address looks invalid: ${to}` };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "Email is not configured on this install (RESEND_API_KEY)" };
  }

  const settings = await prisma.shopSettings.findUnique({
    where: { shop },
    select: { currency: true, notificationEmail: true },
  });
  const currency = settings?.currency ?? "USD";

  const rows = po.items
    .map((item) => {
      const name = item.product?.variantTitle
        ? `${item.product.title} — ${item.product.variantTitle}`
        : (item.product?.title ?? "Unknown product");
      const lineTotal = item.quantityOrdered * item.unitCost;
      return `
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #eee">${esc(name)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;font-family:monospace">${esc(item.product?.sku ?? "—")}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;font-family:monospace">${item.quantityOrdered}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;font-family:monospace">${esc(formatCurrency(item.unitCost, currency))}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;font-family:monospace">${esc(formatCurrency(lineTotal, currency))}</td>
        </tr>`;
    })
    .join("");

  const totalUnits = po.items.reduce((s, i) => s + i.quantityOrdered, 0);
  // Recomputed from the lines rather than trusting the stored total, so the supplier can
  // never receive a figure that disagrees with the rows above it.
  const total = po.items.reduce((s, i) => s + i.quantityOrdered * i.unitCost, 0);

  const expected = po.expectedDeliveryDate
    ? `<p style="margin:4px 0"><strong>Requested delivery:</strong> ${esc(po.expectedDeliveryDate.toISOString().slice(0, 10))}</p>`
    : "";
  const notes = po.notes
    ? `<p style="margin:14px 0 0"><strong>Notes:</strong><br>${esc(po.notes).replace(/\n/g, "<br>")}</p>`
    : "";
  const greeting = po.supplier.contactName ? `Hello ${esc(po.supplier.contactName)},` : "Hello,";

  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1b1a17;max-width:640px">
      <p>${greeting}</p>
      <p>Please find our purchase order <strong>${esc(po.poNumber)}</strong> below.</p>
      ${expected}
      <table style="border-collapse:collapse;width:100%;margin:16px 0;font-size:14px">
        <thead>
          <tr style="background:#faf9f5">
            <th style="padding:8px 10px;text-align:left">Product</th>
            <th style="padding:8px 10px;text-align:left">SKU</th>
            <th style="padding:8px 10px;text-align:right">Qty</th>
            <th style="padding:8px 10px;text-align:right">Unit cost</th>
            <th style="padding:8px 10px;text-align:right">Line total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="2" style="padding:10px;font-weight:600">Total</td>
            <td style="padding:10px;text-align:right;font-weight:600;font-family:monospace">${totalUnits}</td>
            <td></td>
            <td style="padding:10px;text-align:right;font-weight:600;font-family:monospace">${esc(formatCurrency(total, currency))}</td>
          </tr>
        </tfoot>
      </table>
      ${notes}
      <p style="margin-top:18px">Please confirm receipt and expected dispatch date.</p>
      <p style="color:#6f6c63;font-size:12px;margin-top:22px">
        Sent by ${esc(shop)} via Inventorify.
      </p>
    </div>`;

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "orders@inventorify.app",
      to,
      // Replies belong with the merchant, not with the app's sending address.
      ...(settings?.notificationEmail ? { replyTo: settings.notificationEmail } : {}),
      subject: `Purchase order ${po.poNumber} — ${totalUnits} units`,
      html,
    });

    if (error) {
      return { ok: false, error: error.message || "The email provider rejected the message" };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to send the email",
    };
  }

  // Recorded only after the provider accepted it. Marking first would let a failed send
  // look like a delivered order — the same mistake the alert dispatcher used to make.
  await prisma.purchaseOrder.update({
    where: { id: po.id },
    data: { emailedAt: new Date(), emailedTo: to },
  });

  return { ok: true, emailedTo: to };
}
