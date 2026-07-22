import prisma from "../db.server";

/**
 * COD inventory planning.
 *
 * The single most consequential modelling error in the original app was treating the
 * RTO rate as a reduction in demand:
 *
 *     netDemand = grossDemand * (1 - codReturnRate)
 *
 * and presenting that as the number to plan on. At a 35% RTO rate — ordinary for
 * Pakistan, Egypt or the GCC — that tells a merchant to stock 65 units when they must
 * physically ship 100. Every unit that goes out and comes back still consumed stock for
 * the whole round trip. Planning on net demand under-buys by exactly the return rate.
 *
 * The three quantities are distinct and this module keeps them apart:
 *
 *   shipUnits       gross demand — what must physically leave the warehouse.
 *                   Drives stock cover and the reorder point.
 *   deliveredUnits  what is kept by customers. Drives revenue, never stock.
 *   procureUnits    what to buy = shipUnits - sellable units coming back from RTO
 *                   within the horizon. Returns are scheduled supply, not lost demand.
 */

/** Fraction of returned units that come back sellable, from resolved history. */
export async function estimateRestockRate(
  shop: string,
  productId?: string,
  fallback = 0.75,
): Promise<number> {
  // Omitting productId gives the shop-wide rate, which is what list views should use:
  // a per-row lookup would be one query per product.
  const scope = productId ? { shop, productId } : { shop };
  const [restocked, writtenOff] = await Promise.all([
    prisma.returnItem.aggregate({
      where: { ...scope, status: "restocked" },
      _sum: { quantity: true },
    }),
    prisma.returnItem.aggregate({
      where: { ...scope, status: "written_off" },
      _sum: { quantity: true },
    }),
  ]);

  const good = restocked._sum.quantity ?? 0;
  const bad = writtenOff._sum.quantity ?? 0;
  const total = good + bad;
  // Too small a sample is worse than the default.
  if (total < 5) return fallback;
  return good / total;
}

/**
 * Resolve the RTO rate to use, with provenance.
 *
 * Two writers used to race for `codReturnRate`: the Courierify sync (real delivery
 * outcomes) and the orders/cancelled webhook (cancellations, which are not RTOs at all).
 * Last writer won, non-deterministically. Courierify is authoritative when present.
 */
export function resolveReturnRate(product: {
  courierRtoRate: number | null;
  estimatedRtoRate: number | null;
}): { rate: number; source: "courierify" | "estimated" | "none" } {
  if (product.courierRtoRate != null) {
    return { rate: clamp01(product.courierRtoRate), source: "courierify" };
  }
  if (product.estimatedRtoRate != null) {
    return { rate: clamp01(product.estimatedRtoRate), source: "estimated" };
  }
  return { rate: 0, source: "none" };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export interface InventoryPosition {
  /** Physically present and sellable. */
  onHand: number;
  /** Committed to orders that have not shipped. */
  reserved: number;
  /** Units on purchase orders that are sent but not yet received. */
  onOrder: number;
  /** Units in RTO transit expected to return sellable. */
  rtoInbound: number;
  /**
   * What replenishment decisions must be made against:
   * onHand - reserved + onOrder + rtoInbound.
   */
  position: number;
}

/**
 * Inventory position for a set of products, in bulk.
 *
 * Every stock decision in the app previously used `currentStock` alone. That ignores
 * stock already on order, so a merchant who raised a PO yesterday gets the same
 * low-stock alert today and the bulk-PO action happily raises a second one. It also
 * ignores units currently bouncing back through RTO, which are real, scheduled supply
 * in a COD business.
 */
export async function getInventoryPositions(
  shop: string,
  productIds: string[],
): Promise<Map<string, InventoryPosition>> {
  const result = new Map<string, InventoryPosition>();
  if (productIds.length === 0) return result;

  const [products, reservedRows, onOrderRows] = await Promise.all([
    prisma.product.findMany({
      where: { shop, id: { in: productIds } },
      select: { id: true, currentStock: true },
    }),
    prisma.productLocationStock.groupBy({
      by: ["productId"],
      where: { shop, productId: { in: productIds } },
      _sum: { reserved: true },
    }),
    // Outstanding = ordered minus already received, on POs that are sent.
    prisma.purchaseOrderItem.findMany({
      where: {
        productId: { in: productIds },
        purchaseOrder: { shop, status: "sent" },
      },
      select: { productId: true, quantityOrdered: true, quantityReceived: true },
    }),
  ]);

  const reservedById = new Map(
    reservedRows.map((r) => [r.productId, r._sum.reserved ?? 0]),
  );

  const onOrderById = new Map<string, number>();
  for (const item of onOrderRows) {
    const outstanding = Math.max(0, item.quantityOrdered - item.quantityReceived);
    onOrderById.set(item.productId, (onOrderById.get(item.productId) ?? 0) + outstanding);
  }

  // Returned units already logged in the queue and not yet resolved are the concrete
  // part of RTO inbound; the fulfilment snapshot covers what is still in transit.
  const pendingReturns = await prisma.returnItem.groupBy({
    by: ["productId"],
    where: { shop, productId: { in: productIds }, status: "pending" },
    _sum: { quantity: true },
  });
  const pendingById = new Map(
    pendingReturns
      .filter((r) => r.productId != null)
      .map((r) => [r.productId as string, r._sum.quantity ?? 0]),
  );

  // One shop-wide restock rate rather than a query per product.
  const restockRate = await estimateRestockRate(shop);

  for (const p of products) {
    const pending = pendingById.get(p.id) ?? 0;
    const rtoInbound = Math.floor(pending * restockRate);
    const reserved = reservedById.get(p.id) ?? 0;
    const onOrder = onOrderById.get(p.id) ?? 0;

    result.set(p.id, {
      onHand: p.currentStock,
      reserved,
      onOrder,
      rtoInbound,
      position: p.currentStock - reserved + onOrder + rtoInbound,
    });
  }

  return result;
}

export interface ProcurementInput {
  /** Gross units expected to ship over the horizon. */
  shipUnits: number;
  /** RTO rate for this SKU. */
  returnRate: number;
  /** Share of returned units that come back sellable. */
  restockRate: number;
  /** Current inventory position (net of what is already coming). */
  position: number;
  /** Safety stock to hold on top of demand. */
  safetyStock: number;
  moq: number;
  casePackSize: number;
}

export interface ProcurementPlan {
  shipUnits: number;
  /** Units expected back from RTO, sellable, within the horizon. */
  expectedReturnsSellable: number;
  /** Raw requirement before purchasing constraints. */
  rawNeed: number;
  /** Final quantity to order, after MOQ and case-pack rounding. */
  orderQty: number;
  /** Why the final quantity differs from rawNeed, for display. */
  roundedUpTo: "none" | "moq" | "case_pack";
}

/**
 * Convert a gross shipping forecast into a purchase quantity.
 *
 * The old suggestion was `max(10, reorderPoint * 2 - currentStock)` with a hardcoded
 * floor of 10 and unitCost 0 on every line — no MOQ, no case packs, no coverage target,
 * and no awareness of stock already on order.
 */
export function computeProcurementPlan(input: ProcurementInput): ProcurementPlan {
  const shipUnits = Math.max(0, Math.ceil(input.shipUnits));

  // Units shipped that come back and can be sold again are supply, so they reduce how
  // much needs buying — but they never reduce how much needs *stocking*, which is why
  // shipUnits (not this) drives cover and the reorder point.
  const expectedReturnsSellable = Math.floor(
    shipUnits * clamp01(input.returnRate) * clamp01(input.restockRate),
  );

  const rawNeed = Math.max(
    0,
    Math.ceil(shipUnits + input.safetyStock - input.position - expectedReturnsSellable),
  );

  if (rawNeed === 0) {
    return {
      shipUnits,
      expectedReturnsSellable,
      rawNeed,
      orderQty: 0,
      roundedUpTo: "none",
    };
  }

  const moq = Math.max(1, input.moq || 1);
  const casePack = Math.max(1, input.casePackSize || 1);

  let orderQty = rawNeed;
  let roundedUpTo: ProcurementPlan["roundedUpTo"] = "none";

  if (orderQty < moq) {
    orderQty = moq;
    roundedUpTo = "moq";
  }
  if (casePack > 1 && orderQty % casePack !== 0) {
    orderQty = Math.ceil(orderQty / casePack) * casePack;
    roundedUpTo = roundedUpTo === "moq" ? "moq" : "case_pack";
  }

  return { shipUnits, expectedReturnsSellable, rawNeed, orderQty, roundedUpTo };
}

/**
 * ABC by revenue contribution (Pareto) and XYZ by demand variability.
 *
 * A single global service level applied one Z-score to the whole catalogue, so the tail
 * was stocked as carefully as the SKUs that pay the bills.
 */
export function classifyAbc(
  items: { productId: string; revenue: number }[],
): Map<string, "A" | "B" | "C"> {
  const out = new Map<string, "A" | "B" | "C">();
  const total = items.reduce((s, i) => s + i.revenue, 0);
  if (total <= 0) {
    for (const i of items) out.set(i.productId, "C");
    return out;
  }

  const sorted = [...items].sort((a, b) => b.revenue - a.revenue);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.revenue;
    const share = cumulative / total;
    out.set(item.productId, share <= 0.8 ? "A" : share <= 0.95 ? "B" : "C");
  }
  return out;
}

/** XYZ from the coefficient of variation of daily demand. */
export function classifyXyz(cv: number): "X" | "Y" | "Z" {
  if (cv <= 0.5) return "X";
  if (cv <= 1.0) return "Y";
  return "Z";
}

/**
 * Service-level Z by ABC class. A-items justify a higher fill rate than the long tail;
 * spending the same safety stock on both is what ties up cash in slow movers.
 */
export function serviceLevelZFor(
  abcClass: string | null | undefined,
  baseZ: number,
): number {
  switch (abcClass) {
    case "A":
      return Math.max(baseZ, 2.05); // ~98%
    case "B":
      return baseZ; // merchant default, typically 95%
    case "C":
      return Math.min(baseZ, 1.28); // ~90%
    default:
      return baseZ;
  }
}
