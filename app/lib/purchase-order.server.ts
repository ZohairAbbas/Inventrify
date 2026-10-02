import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { applyLocationDelta, resolveDefaultLocationId } from "./stock.server";
import { updateLeadTimeStats } from "./lead-time.server";
import {
  OPEN_PO_STATUSES,
  RECEIVABLE_PO_STATUSES,
  derivePoStatus,
  outstandingQuantity,
  type POStatus,
} from "./purchase-order-status";

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
 *
 * A PO can arrive in several deliveries. Each one is a PurchaseOrderReceipt; between
 * them the PO is `partially_received` and the remainder stays on order, until either the
 * rest arrives (`received`) or the merchant stops expecting it (`closed`).
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
  /** Units moved by this receipt. Never negative: received quantities only go up. */
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
  /** The PO's status after this receipt. */
  status?: POStatus;
  /**
   * Set when `closeRemaining` was asked for but not done. A line that failed to move may
   * be stock that physically arrived; cancelling its remainder would write it off as
   * never delivered.
   */
  closeSkipped?: string;
}

const STALE_ERROR =
  "This purchase order changed since you opened it — reload the page and try again.";

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

/** Why a PO in this status cannot take a receipt or a close. */
function closedStatusError(status: string): string {
  if (status === "received") return "Already received";
  if (status === "closed") return "This purchase order is closed";
  return "This purchase order cannot be received";
}

/**
 * Claim the right to change a PO's receipt state.
 *
 * A PO can be received in several deliveries now, so the old guard — flip the status to
 * `received` before moving any stock — no longer works: the status after a delivery may
 * well still be open. Instead every receipt and close bumps `receiptVersion` with a
 * guarded `updateMany`, which is atomic: of two requests that read the same version,
 * exactly one sees count === 1. That covers both a double-submit and a second browser tab
 * that was opened before the first delivery was booked.
 */
async function claimReceiptVersion(
  db: Pick<typeof prisma, "purchaseOrder">,
  shop: string,
  poId: string,
  version: number,
  statuses: POStatus[],
): Promise<boolean> {
  const { count } = await db.purchaseOrder.updateMany({
    where: { id: poId, shop, receiptVersion: version, status: { in: statuses } },
    data: { receiptVersion: { increment: 1 } },
  });
  return count === 1;
}

/**
 * Book a delivery against a purchase order, moving stock through the audited
 * per-location path.
 *
 * `quantities` maps PurchaseOrderItem.id -> the TOTAL quantity received on that line so
 * far, including this delivery. Totals rather than increments make a repeated submit of
 * the same form harmless: the second one asks for nothing new. Omitted lines default to
 * the full ordered quantity, which is what the list page's one-click "Mark received"
 * wants; on a partially received PO that means "the rest has arrived".
 *
 * Received quantities only go up. A delivery that turns out to be short or damaged after
 * it was booked is a stock adjustment, not a rewrite of what the receipt said arrived.
 *
 * After the delivery the PO is `received` if nothing is outstanding, otherwise
 * `partially_received` and the remainder stays on order — unless `closeRemaining` says
 * the supplier will not send it, in which case the remainder is cancelled and the PO is
 * `closed`.
 */
export async function receivePurchaseOrder(
  admin: AdminApiContext,
  shop: string,
  poId: string,
  options: {
    actualDeliveryDate?: Date | null;
    locationId?: string | null;
    quantities?: Record<string, number | undefined>;
    /** The receiptVersion the caller's page was rendered with, when it has one. */
    expectedVersion?: number | null;
    /** Cancel whatever is still outstanding once this delivery is booked. */
    closeRemaining?: boolean;
    /** Shopify staff user id (session token `sub`) of whoever booked the delivery. */
    userId?: string | null;
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
  if (!RECEIVABLE_PO_STATUSES.includes(po.status as POStatus)) {
    return { ok: false, error: closedStatusError(po.status), ...empty };
  }
  if (po.items.length === 0) {
    return { ok: false, error: "This purchase order has no line items to receive", ...empty };
  }
  if (options.expectedVersion != null && options.expectedVersion !== po.receiptVersion) {
    return { ok: false, error: STALE_ERROR, ...empty };
  }

  // Work out every line's movement before touching anything, so a request that is wrong
  // on every line is turned away without claiming the PO.
  const lines: ReceiveLineResult[] = [];
  const toMove: { item: (typeof po.items)[number]; delta: number }[] = [];
  let failed = 0;

  for (const item of po.items) {
    const requested = options.quantities?.[item.id];
    // An unparseable or negative figure is not a reason to silently receive the full
    // ordered quantity — leave the line exactly as it was and say so.
    const target =
      requested === undefined
        ? Math.max(item.quantityReceived, item.quantityOrdered)
        : Number.isFinite(requested) && (requested as number) >= 0
          ? Math.floor(requested as number)
          : null;

    const error =
      target === null
        ? "Invalid received quantity"
        : target < item.quantityReceived
          ? `Received quantity cannot go below the ${item.quantityReceived} already received — record missing or damaged units as a stock adjustment`
          : null;

    if (error !== null || target === null) {
      failed++;
      lines.push({
        itemId: item.id,
        productId: item.productId,
        quantityReceived: item.quantityReceived,
        delta: 0,
        error: error ?? "Invalid received quantity",
      });
    } else if (target === item.quantityReceived) {
      lines.push({ itemId: item.id, productId: item.productId, quantityReceived: target, delta: 0 });
    } else {
      toMove.push({ item, delta: target - item.quantityReceived });
    }
  }

  if (failed > 0 && toMove.length === 0) {
    return {
      ok: false,
      error: lines.find((l) => l.error)?.error ?? "No stock could be received",
      ...empty,
      lines,
      failed,
    };
  }

  const receiptLocationId = await resolveDefaultLocationId(shop, options.locationId ?? null);
  const receivedAt = options.actualDeliveryDate ?? new Date();

  if (!(await claimReceiptVersion(prisma, shop, po.id, po.receiptVersion, RECEIVABLE_PO_STATUSES))) {
    const now = await prisma.purchaseOrder.findFirst({ where: { id: po.id }, select: { status: true } });
    const error =
      now && !RECEIVABLE_PO_STATUSES.includes(now.status as POStatus)
        ? closedStatusError(now.status)
        : STALE_ERROR;
    return { ok: false, error, ...empty };
  }

  const shopifyWarnings: string[] = [];
  const receiptLines: { purchaseOrderItemId: string; quantity: number }[] = [];
  let moved = 0;

  for (const { item, delta } of toMove) {
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

    // Incremented, not set: the database does the arithmetic, as for every other
    // stock-bearing counter in the app.
    await prisma.purchaseOrderItem.update({
      where: { id: item.id },
      data: { quantityReceived: { increment: delta } },
    });
    item.quantityReceived += delta;
    receiptLines.push({ purchaseOrderItemId: item.id, quantity: delta });
    moved++;
    lines.push({
      itemId: item.id,
      productId: item.productId,
      quantityReceived: item.quantityReceived,
      delta,
      shopifyError: lineShopifyError,
    });
  }

  // Lines that had stock to move and all failed: nothing arrived as far as the record
  // goes, so the PO stays exactly where it was (bar the version bump, which is harmless).
  if (moved === 0 && toMove.length > 0) {
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

  if (receiptLines.length > 0) {
    await prisma.purchaseOrderReceipt.create({
      data: {
        shop,
        purchaseOrderId: po.id,
        receivedAt,
        locationId: receiptLocationId,
        createdByUserId: options.userId ?? null,
        lines: { create: receiptLines },
      },
    });
  }

  let closeSkipped: string | undefined;
  if (options.closeRemaining) {
    if (failed > 0) {
      closeSkipped =
        "The remainder was left on order because some lines could not be received — fix those first, then close it";
    } else {
      await cancelOutstanding(prisma, po.items);
    }
  }

  const fresh = await prisma.purchaseOrderItem.findMany({
    where: { purchaseOrderId: po.id },
    select: { quantityOrdered: true, quantityReceived: true, quantityCancelled: true },
  });
  const status = derivePoStatus(fresh, po.status as POStatus);

  // actualDeliveryDate is the FIRST delivery; a later top-up does not move it.
  const firstDelivery = moved > 0 && po.actualDeliveryDate === null;
  await prisma.purchaseOrder.update({
    where: { id: po.id },
    data: { status, ...(firstDelivery ? { actualDeliveryDate: receivedAt } : {}) },
  });

  // Lead time is measured from when the PO was actually sent to when stock first arrived.
  // A PO received without ever being marked sent contributes nothing — skipping the
  // observation beats inventing a send date and poisoning the supplier's variance. Later
  // deliveries against the same PO are not new observations: counting a backorder as a
  // second lead time would weight one PO twice.
  if (firstDelivery && po.supplierId && po.sentAt) {
    await recordSupplierLeadTime(shop, po.supplierId, po.sentAt, receivedAt);
  }

  return {
    ok: true,
    lines,
    failed,
    moved,
    shopifyWarnings,
    locationScoped: !!receiptLocationId,
    status,
    closeSkipped,
  };
}

/** Cancel every line's outstanding remainder. */
async function cancelOutstanding(
  db: Pick<typeof prisma, "purchaseOrderItem">,
  items: { id: string; quantityOrdered: number; quantityReceived: number; quantityCancelled: number }[],
): Promise<number> {
  let cancelled = 0;
  for (const item of items) {
    const remaining = outstandingQuantity(item);
    if (remaining === 0) continue;
    await db.purchaseOrderItem.update({
      where: { id: item.id },
      data: { quantityCancelled: { increment: remaining } },
    });
    cancelled += remaining;
  }
  return cancelled;
}

/**
 * Stop expecting whatever is still outstanding on an open PO — the supplier has said the
 * rest is not coming, or the merchant has given up on it.
 *
 * The cancelled units leave "on order" (so planning reorders them from someone else) and
 * the PO becomes `closed`. Stock is not touched: cancelled units never arrived.
 */
export async function closePurchaseOrderRemainder(
  shop: string,
  poId: string,
  options: { expectedVersion?: number | null } = {},
): Promise<{ ok: boolean; error?: string; cancelled?: number }> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, shop },
    include: { items: true },
  });
  if (!po) return { ok: false, error: "Purchase order not found" };
  if (!OPEN_PO_STATUSES.includes(po.status as POStatus)) {
    return {
      ok: false,
      error:
        po.status === "draft"
          ? "A draft has nothing on order — delete it instead"
          : closedStatusError(po.status),
    };
  }
  if (options.expectedVersion != null && options.expectedVersion !== po.receiptVersion) {
    return { ok: false, error: STALE_ERROR };
  }
  if (po.items.every((i) => outstandingQuantity(i) === 0)) {
    return { ok: false, error: "Nothing is outstanding on this purchase order" };
  }

  // No Shopify call is involved, so the claim, the cancellations and the status change
  // can be one transaction.
  return prisma.$transaction(async (tx) => {
    if (!(await claimReceiptVersion(tx, shop, po.id, po.receiptVersion, OPEN_PO_STATUSES))) {
      return { ok: false, error: STALE_ERROR };
    }
    const cancelled = await cancelOutstanding(tx, po.items);
    const fresh = await tx.purchaseOrderItem.findMany({
      where: { purchaseOrderId: po.id },
      select: { quantityOrdered: true, quantityReceived: true, quantityCancelled: true },
    });
    await tx.purchaseOrder.update({
      where: { id: po.id },
      data: { status: derivePoStatus(fresh, po.status as POStatus) },
    });
    return { ok: true, cancelled };
  });
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
