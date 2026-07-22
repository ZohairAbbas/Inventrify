import prisma from "../db.server";

/**
 * Per-SKU RTO derived from order-level courier outcomes.
 *
 * Courierify's per-SKU endpoints group on `ShipmentLineItem.sku`, which in practice is
 * almost never populated: on one production shop, 1,563 of 1,594 shipments had no line
 * items at all and not one had a SKU, so per-SKU RTO came back empty despite 624 real
 * returns. Several larger shops had zero line items across tens of thousands of shipments.
 *
 * The same figure can be reconstructed locally without any of that. Every shipment does
 * carry the Shopify order name, and Inventorify already knows which SKUs were in which
 * order (OrderLineItem, captured during the order sync). Joining the two gives per-SKU
 * shipped and returned units — no shipment line items, and no backfill.
 *
 * Everything below is pure apart from the two thin DB wrappers at the end, so the
 * arithmetic is testable without a courier feed.
 */

/** One order's outcome as reported by the courier. */
export interface OrderOutcomeRow {
  orderName: string;
  status: string;
}

/** One order line, as captured from Shopify. */
export interface OrderLineRow {
  orderName: string;
  productId: string;
  quantity: number;
}

export interface SkuRto {
  productId: string;
  /** Units on orders whose journey has finished (delivered or returned). */
  shippedUnits: number;
  returnedUnits: number;
  /** returnedUnits / shippedUnits, 0..1. */
  rtoRate: number;
}

/**
 * Courier statuses that represent a completed journey. Anything still moving is excluded
 * from both numerator and denominator: counting in-transit units as "not returned" would
 * understate the rate, and counting them as returned would overstate it.
 */
const DELIVERED = new Set(["delivered"]);
const RETURNED = new Set(["returned", "rto", "returned_to_shipper"]);

export function isResolvedStatus(status: string): boolean {
  const s = status.trim().toLowerCase();
  return DELIVERED.has(s) || RETURNED.has(s);
}

export function isReturnedStatus(status: string): boolean {
  return RETURNED.has(status.trim().toLowerCase());
}

/**
 * Attribute order outcomes to SKUs.
 *
 * `minShipped` guards against meaningless rates: one return out of two shipments is not a
 * 50% RTO SKU, and feeding that into safety stock would be worse than having no figure.
 */
export function attributeRto(
  outcomes: OrderOutcomeRow[],
  lines: OrderLineRow[],
  minShipped = 10,
): SkuRto[] {
  const statusByOrder = new Map<string, string>();
  for (const o of outcomes) {
    if (!isResolvedStatus(o.status)) continue;
    // Last write wins; outcomes are pulled newest-last.
    statusByOrder.set(o.orderName, o.status);
  }

  const shipped = new Map<string, number>();
  const returned = new Map<string, number>();

  for (const line of lines) {
    const status = statusByOrder.get(line.orderName);
    if (!status) continue; // order never shipped, or still in transit

    shipped.set(line.productId, (shipped.get(line.productId) ?? 0) + line.quantity);
    if (isReturnedStatus(status)) {
      returned.set(line.productId, (returned.get(line.productId) ?? 0) + line.quantity);
    }
  }

  const out: SkuRto[] = [];
  for (const [productId, shippedUnits] of shipped) {
    if (shippedUnits < minShipped) continue;
    const returnedUnits = returned.get(productId) ?? 0;
    out.push({
      productId,
      shippedUnits,
      returnedUnits,
      rtoRate: returnedUnits / shippedUnits,
    });
  }
  return out.sort((a, b) => b.rtoRate - a.rtoRate);
}

/**
 * Recompute derivedRtoRate for a shop from stored outcomes and order lines.
 *
 * Writes `derivedRtoRate` only. `courierRtoRate` remains the courier's own per-SKU figure
 * and still wins when present — see resolveReturnRate() for the precedence.
 *
 * The window matters more than it looks. Measured on a live store: 27.2% RTO over 30 days,
 * 43.0% over 60, 41.2% over 90. A shop whose return rate is moving that fast gets a
 * materially different safety stock depending on the window, and a 90-day average will
 * over-buy against an improving rate. 90 days is the default because it matches the demand
 * window and is stable enough to size buffers from, but a fast-moving rate wants shorter.
 */
export async function recomputeDerivedRto(
  shop: string,
  windowDays = 90,
): Promise<{ attributed: number; skipped: number }> {
  const since = new Date(Date.now() - windowDays * 86400000);

  const [outcomes, lines] = await Promise.all([
    prisma.orderOutcome.findMany({
      where: { shop, updatedAt: { gte: since } },
      select: { orderName: true, status: true },
      orderBy: { updatedAt: "asc" },
    }),
    prisma.orderLineItem.findMany({
      where: { shop, orderedAt: { gte: since } },
      select: { orderName: true, productId: true, quantity: true },
    }),
  ]);

  if (outcomes.length === 0) return { attributed: 0, skipped: 0 };

  const rates = attributeRto(outcomes, lines);

  for (const r of rates) {
    await prisma.product.update({
      where: { id: r.productId },
      data: { derivedRtoRate: r.rtoRate },
    });
  }

  // Resolve codReturnRate for everything this shop tracks, so the field the planning
  // maths reads reflects the new precedence.
  await refreshResolvedReturnRates(shop);

  return { attributed: rates.length, skipped: outcomes.length - rates.length };
}

/**
 * Recompute the resolved `codReturnRate` and its provenance for every product in a shop.
 *
 * Precedence: the courier's own per-SKU rate, then one derived from order outcomes, then a
 * local estimate. Keeping this in one place is what stopped two writers racing over the
 * same column.
 */
export async function refreshResolvedReturnRates(shop: string): Promise<number> {
  const products = await prisma.product.findMany({
    where: { shop, isArchived: false },
    select: {
      id: true,
      courierRtoRate: true,
      derivedRtoRate: true,
      estimatedRtoRate: true,
      codReturnRate: true,
      returnRateSource: true,
    },
  });

  let updated = 0;
  for (const p of products) {
    const resolved =
      p.courierRtoRate != null
        ? { rate: p.courierRtoRate, source: "courierify" }
        : p.derivedRtoRate != null
          ? { rate: p.derivedRtoRate, source: "courierify_orders" }
          : p.estimatedRtoRate != null
            ? { rate: p.estimatedRtoRate, source: "estimated" }
            : { rate: 0, source: "none" };

    const rate = Math.min(1, Math.max(0, resolved.rate));
    if (p.codReturnRate === rate && p.returnRateSource === resolved.source) continue;

    await prisma.product.update({
      where: { id: p.id },
      data: { codReturnRate: rate, returnRateSource: resolved.source },
    });
    updated++;
  }
  return updated;
}
