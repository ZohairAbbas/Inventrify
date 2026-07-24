import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { applyLocationDelta, resolveDefaultLocationId } from "./stock.server";
import { updateLeadTimeStats } from "./lead-time.server";

/**
 * The purchase-order lifecycle, in one place.
 *
 * Receiving a PO used to be implemented twice: correctly on the detail page, and again
 * on the list page as `currentStock: { increment: quantityOrdered }`. That second path
 * skipped everything that makes a receipt real —
 *
 *   - ProductLocationStock was never touched, and since syncShopifyInventory recomputes
 *     currentStock as the sum of per-location on-hand, the received units disappeared at
 *     the next hourly sync,
 *   - Shopify was never told the stock had arrived,
 *   - quantityReceived and actualDeliveryDate stayed empty,
 *   - the supplier's lead-time statistics never saw the receipt.
 *
 * Those are exactly the "legacy" oddities recorded in docs/data-audit.md; the list page
 * was still producing them. Both routes now call the functions below, so there is only
 * one definition of what "sent" and "received" mean.
 */

export interface DraftLineInput {
  productId: string;
  quantityOrdered: number;
  unitCost: number;
}

/**
 * Validate client-submitted purchase-order lines against this shop.
 *
 * Product ids arrive from a form, so they are attacker-controlled: nothing stops a
 * crafted POST naming another tenant's variant GID, and `items: { create: [...] }` would
 * happily link it. The inventory page's bulk-PO action already guards this ("a bare
 * findMany by id is one refactor away from leaking across tenants"); the PO create, PO
 * draft-edit and transfer forms did not.
 *
 * Quantities and costs are checked here too: `parseInt("abc")` is NaN, which Prisma
 * rejects at write time with an opaque error rather than a message anyone can act on.
 */
export async function validateDraftLines(
  shop: string,
  raw: { productId: string; quantity: string | null; unitCost?: string | null }[],
): Promise<{ items: DraftLineInput[]; error?: string }> {
  if (raw.length === 0) return { items: [], error: "Add at least one product" };

  const owned = await prisma.product.findMany({
    where: { shop, id: { in: raw.map((r) => r.productId) } },
    select: { id: true },
  });
  const ownedIds = new Set(owned.map((p) => p.id));

  const items: DraftLineInput[] = [];
  for (const line of raw) {
    if (!line.productId || !ownedIds.has(line.productId)) {
      return { items: [], error: "One of the selected products is not in this shop" };
    }
    const quantityOrdered = parseInt(line.quantity ?? "", 10);
    if (!Number.isFinite(quantityOrdered) || quantityOrdered < 1) {
      return { items: [], error: "Every line needs a whole quantity of at least 1" };
    }
    const unitCost = line.unitCost === undefined ? 0 : parseFloat(line.unitCost ?? "");
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      return { items: [], error: "Unit cost must be zero or more" };
    }
    items.push({ productId: line.productId, quantityOrdered, unitCost });
  }
  return { items };
}

/** Confirm a supplier belongs to this shop; returns null for "no supplier". */
export async function validateSupplierId(
  shop: string,
  supplierId: string | null,
): Promise<{ supplierId: string | null; error?: string }> {
  if (!supplierId) return { supplierId: null };
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, shop },
    select: { id: true },
  });
  if (!supplier) return { supplierId: null, error: "That supplier is not in this shop" };
  return { supplierId: supplier.id };
}

export interface ReceiveLineResult {
  itemId: string;
  productId: string;
  /** Quantity now recorded as received on the line. */
  quantityReceived: number;
  /** Units actually moved by this receipt (may be negative when correcting downward). */
  delta: number;
  /** Set when the stock movement failed; the line's quantityReceived is left unchanged. */
  error?: string;
  /** Set when the local move succeeded but pushing it to Shopify did not. */
  shopifyError?: string;
}

export interface ReceiveResult {
  ok: boolean;
  error?: string;
  /** Per-line outcomes, for surfacing partial failures. */
  lines: ReceiveLineResult[];
  /** Lines whose stock movement failed. */
  failed: number;
  /** Lines whose stock actually moved. */
  moved: number;
  /** Local move succeeded but Shopify rejected the delta — non-fatal. */
  shopifyWarnings: string[];
  /** True when the receipt was recorded against a location rather than the aggregate. */
  locationScoped: boolean;
}

/**
 * Mark a draft PO as sent.
 *
 * `sentAt` is the whole point: lead time is measured sent -> received, never
 * createdAt -> received, because a draft can sit unsent for weeks and that delay is not
 * the supplier's. A PO sent without this stamp can never contribute to lead-time
 * statistics, and the safety stock derived from them silently loses an observation.
 */
export async function markPurchaseOrderSent(
  shop: string,
  poId: string,
  expectedDeliveryDate?: Date | null,
): Promise<{ ok: boolean; error?: string }> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, shop },
    select: { id: true, status: true },
  });
  if (!po) return { ok: false, error: "Purchase order not found" };
  if (po.status !== "draft") {
    return { ok: false, error: "Only draft purchase orders can be marked sent" };
  }

  // Guarded on status inside the write as well, so two clicks racing each other cannot
  // both stamp sentAt and reset the clock.
  const { count } = await prisma.purchaseOrder.updateMany({
    where: { id: poId, shop, status: "draft" },
    data: {
      status: "sent",
      sentAt: new Date(),
      expectedDeliveryDate: expectedDeliveryDate ?? null,
    },
  });
  if (count === 0) return { ok: false, error: "Purchase order is no longer a draft" };

  return { ok: true };
}

/**
 * Receive a purchase order, moving stock through the audited per-location path.
 *
 * `quantities` maps PurchaseOrderItem.id -> the total quantity now received on that line.
 * Omitted lines default to the full ordered quantity, which is what the list page's
 * one-click "Mark received" wants. Only the not-yet-received remainder moves, so
 * re-confirming a partially received PO cannot double-count stock.
 */
export async function receivePurchaseOrder(
  admin: AdminApiContext,
  shop: string,
  poId: string,
  options: {
    actualDeliveryDate?: Date | null;
    locationId?: string | null;
    quantities?: Record<string, number | undefined>;
  } = {},
): Promise<ReceiveResult> {
  const empty = {
    lines: [] as ReceiveLineResult[],
    failed: 0,
    moved: 0,
    shopifyWarnings: [] as string[],
    locationScoped: false,
  };

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, shop },
    include: { items: true },
  });
  if (!po) return { ok: false, error: "Purchase order not found", ...empty };
  if (po.status === "received") return { ok: false, error: "Already received", ...empty };
  if (po.items.length === 0) {
    return { ok: false, error: "This purchase order has no line items to receive", ...empty };
  }

  const receiptLocationId = await resolveDefaultLocationId(shop, options.locationId ?? null);
  const receivedAt = options.actualDeliveryDate ?? new Date();

  // Claim the PO before moving any stock.
  //
  // The status check above is a read, and a read cannot stop a second request that has
  // already passed the same read — a double-submit would run the whole receipt twice and
  // add the stock twice. Flipping the status in a guarded `updateMany` is atomic: exactly
  // one caller sees count === 1. This is the same reasoning as the unique index that
  // guards adjustment reversals.
  //
  // If nothing can then be received the claim is released below, so a failed attempt does
  // not strand the PO in `received` with an empty receipt.
  const claim = await prisma.purchaseOrder.updateMany({
    where: { id: po.id, shop, status: { not: "received" } },
    data: { status: "received", actualDeliveryDate: receivedAt },
  });
  if (claim.count === 0) return { ok: false, error: "Already received", ...empty };
  const previousStatus = po.status;

  const lines: ReceiveLineResult[] = [];
  const shopifyWarnings: string[] = [];
  let failed = 0;
  let moved = 0;

  for (const item of po.items) {
    const requested = options.quantities?.[item.id];
    // An unparseable or negative figure is not a reason to silently receive the full
    // ordered quantity — leave the line exactly as it was and say so.
    const target =
      requested === undefined
        ? item.quantityOrdered
        : Number.isFinite(requested) && (requested as number) >= 0
          ? Math.floor(requested as number)
          : null;

    if (target === null) {
      failed++;
      lines.push({
        itemId: item.id,
        productId: item.productId,
        quantityReceived: item.quantityReceived,
        delta: 0,
        error: "Invalid received quantity",
      });
      continue;
    }

    const delta = target - item.quantityReceived;

    if (delta === 0) {
      lines.push({
        itemId: item.id,
        productId: item.productId,
        quantityReceived: target,
        delta: 0,
      });
      continue;
    }

    let lineError: string | undefined;
    let lineShopifyError: string | undefined;

    if (receiptLocationId) {
      const res = await applyLocationDelta(admin, shop, item.productId, receiptLocationId, delta);
      if (!res.ok) {
        lineError = res.error ?? "Stock update failed";
      } else if (!res.shopifySynced && res.shopifyError) {
        lineShopifyError = res.shopifyError;
        shopifyWarnings.push(res.shopifyError);
      }
    } else {
      // No locations synced at all (a token predating read_locations). Fall back to the
      // aggregate count, which is what syncShopifyInventory also uses for such shops.
      try {
        await prisma.product.update({
          where: { id: item.productId },
          data: { currentStock: { increment: delta } },
        });
      } catch (err) {
        lineError = err instanceof Error ? err.message : "Stock update failed";
      }
    }

    if (lineError) {
      // The stock never moved, so the line must not claim it was received.
      failed++;
      lines.push({
        itemId: item.id,
        productId: item.productId,
        quantityReceived: item.quantityReceived,
        delta: 0,
        error: lineError,
      });
      continue;
    }

    await prisma.purchaseOrderItem.update({
      where: { id: item.id },
      data: { quantityReceived: target },
    });
    moved++;
    lines.push({
      itemId: item.id,
      productId: item.productId,
      quantityReceived: target,
      delta,
      shopifyError: lineShopifyError,
    });
  }

  // Nothing was received but something went wrong: marking the PO received would record
  // a delivery that did not happen and permanently close the receipt path.
  //
  // Keyed on `failed`, not on whether a movement was attempted — an unparseable quantity
  // fails before any movement is tried, and an earlier version of this check missed that
  // case and closed the PO anyway. A PO whose lines are all already at the right
  // quantity has failed nothing and is legitimately closed out here.
  if (failed > 0 && moved === 0) {
    // Release the claim: the PO received nothing, so leaving it marked received would
    // record a delivery that did not happen and close the receipt path for good.
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status: previousStatus, actualDeliveryDate: po.actualDeliveryDate },
    });
    return {
      ok: false,
      error: lines.find((l) => l.error)?.error ?? "No stock could be received",
      lines,
      failed,
      moved,
      shopifyWarnings,
      locationScoped: !!receiptLocationId,
    };
  }

  // Status and delivery date were already set by the claim above.

  // Lead time is measured from when the PO was actually sent. A PO received without ever
  // being marked sent contributes nothing — skipping the observation beats inventing a
  // send date and poisoning the supplier's variance.
  if (po.supplierId && po.sentAt) {
    await recordSupplierLeadTime(shop, po.supplierId, po.sentAt, receivedAt);
  }

  return {
    ok: true,
    lines,
    failed,
    moved,
    shopifyWarnings,
    locationScoped: !!receiptLocationId,
  };
}

/**
 * Fold one observed receipt into a supplier's running lead-time statistics.
 *
 * Clamped at one day: a same-day or backdated receipt is a data-entry artefact, not a
 * zero-day lead time, and a zero would drag the mean toward an unachievable figure.
 */
async function recordSupplierLeadTime(
  shop: string,
  supplierId: string,
  sentAt: Date,
  receivedAt: Date,
): Promise<void> {
  const observedDays = Math.max(
    1,
    Math.round((receivedAt.getTime() - sentAt.getTime()) / 86400000),
  );

  const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, shop } });
  if (!supplier) return;

  const stats = updateLeadTimeStats(
    {
      count: supplier.totalPosReceived,
      mean: supplier.avgActualLeadTime,
      m2: supplier.leadTimeM2,
    },
    observedDays,
  );

  await prisma.supplier.update({
    where: { id: supplierId },
    data: {
      totalPosReceived: stats.count,
      avgActualLeadTime: stats.mean,
      leadTimeM2: stats.m2,
      leadTimeVariance: stats.stdDev,
    },
  });
}

/**
 * Parse `received_<itemId>` form fields into the quantities map.
 *
 * Absent fields are left undefined so the caller's default (full ordered quantity)
 * applies; present-but-unparseable ones become NaN, which receivePurchaseOrder reports
 * as an invalid line rather than silently receiving in full.
 */
export function parseReceivedQuantities(
  formData: FormData,
  itemIds: string[],
): Record<string, number | undefined> {
  const quantities: Record<string, number | undefined> = {};
  for (const id of itemIds) {
    const raw = formData.get(`received_${id}`);
    if (raw === null) continue;
    quantities[id] = parseInt(String(raw), 10);
  }
  return quantities;
}
