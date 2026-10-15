import prisma from "../db.server";
import { getStockStatus } from "./forecast.server";
import { getInventoryPositions } from "./planning.server";
import { OPEN_PO_STATUSES, outstandingQuantity } from "./purchase-order-status";
import { estimateUnitPrice } from "./capital.server";
import { classifyFulfilmentStage, isRecognisedStatus, resolveOutcomeByOrder } from "./rto-attribution.server";
import type { DateRange } from "./date-range";
import { summarise, toOverviewRow, type OverviewRow, type OverviewTotals } from "./inventory-overview";

export type OverviewProductRow = OverviewRow & {
  title: string;
  variantTitle: string | null;
  sku: string | null;
  imageUrl: string | null;
};

export interface StockOverview {
  rows: OverviewProductRow[];
  totals: OverviewTotals;
  /**
   * Booked with a courier and not yet picked up. Booking fulfils the Shopify order, so
   * these units are already out of on-hand, like withCourier.
   */
  booked: { units: number; cost: number; retail: number; orders: number };
  /** Picked up by the courier and not yet delivered or returned. Already out of on-hand. */
  withCourier: { units: number; cost: number; retail: number };
  /** Returned parcels logged in the returns queue, not yet restocked or written off. */
  returnsToCheck: { units: number; cost: number };
  openPurchaseOrders: number;
}

/**
 * Every live SKU's stock, split by where the units are, with the per-SKU status the
 * dashboard filters on. Current state only — nothing here depends on a date range.
 */
/**
 * A booking with no carrier scan after this long is not waiting for a pickup; tracking has
 * most likely stopped flowing. It stays in "with courier", where it was before bookings
 * were split out, rather than inflating Booked indefinitely.
 */
export const BOOKED_WINDOW_DAYS = 7;

/**
 * Units per product on orders booked with a courier but not yet collected: the shipment's
 * latest status is a pre-pickup one (Courierify's booked/pending, or Shopify's fulfilled
 * with no carrier scan). Shopify's own tracking carries this for every shop, so it works
 * without a Courierify connection.
 */
async function getBookedUnits(shop: string): Promise<{ byProduct: Map<string, number>; orders: number }> {
  const outcomes = await prisma.orderOutcome.findMany({
    where: { shop, updatedAt: { gte: new Date(Date.now() - BOOKED_WINDOW_DAYS * 86400000) } },
    select: { orderName: true, status: true, source: true },
    // resolveOutcomeByOrder keeps the last row per order; the order must be stable.
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
  });
  const bookedOrders = [...resolveOutcomeByOrder(outcomes)]
    .filter(([, status]) => isRecognisedStatus(status) && classifyFulfilmentStage(status) === "dispatched")
    .map(([orderName]) => orderName);
  const byProduct = new Map<string, number>();
  if (bookedOrders.length === 0) return { byProduct, orders: 0 };

  const lines = await prisma.orderLineItem.findMany({
    where: { shop, orderName: { in: bookedOrders } },
    select: { productId: true, quantity: true },
  });
  for (const l of lines) byProduct.set(l.productId, (byProduct.get(l.productId) ?? 0) + l.quantity);
  return { byProduct, orders: bookedOrders.length };
}

export async function getStockOverview(
  shop: string,
  deadStock: { days: number; minUnits: number },
): Promise<StockOverview> {
  const since = new Date(Date.now() - deadStock.days * 86400000);

  const [products, positions, damagedRows, openItems, pendingReturns, soldRecently, bookedUnits] = await Promise.all([
    prisma.product.findMany({
      where: { shop, isArchived: false },
      select: {
        id: true, title: true, variantTitle: true, sku: true, imageUrl: true,
        currentStock: true, reorderPoint: true, avgDailySales: true,
        unitCost: true, price: true, avgMargin: true, fulfilledInTransit: true, fulfilmentSource: true,
      },
    }),
    getInventoryPositions(shop),
    prisma.productLocationStock.groupBy({
      by: ["productId"],
      where: { shop, damaged: { gt: 0 } },
      _sum: { damaged: true },
    }),
    // Valued at the PO line's own cost: that is what the merchant has committed to pay,
    // and it can differ from the product's current cost.
    prisma.purchaseOrderItem.findMany({
      where: { purchaseOrder: { shop, status: { in: OPEN_PO_STATUSES } } },
      select: {
        productId: true, purchaseOrderId: true, unitCost: true,
        quantityOrdered: true, quantityReceived: true, quantityCancelled: true,
      },
    }),
    prisma.returnItem.groupBy({
      by: ["productId"],
      where: { shop, status: "pending", productId: { not: null } },
      _sum: { quantity: true },
    }),
    // Analytics' dead-stock rule (getDeadStock): at least minUnits on hand and nothing
    // sold in the configured window. The same settings drive both pages.
    prisma.salesRecord.groupBy({
      by: ["productId"],
      where: { shop, date: { gte: since } },
      _sum: { quantity: true },
      having: { quantity: { _sum: { gt: 0 } } },
    }),
    getBookedUnits(shop),
  ]);

  const damagedById = new Map(damagedRows.map((r) => [r.productId, r._sum.damaged ?? 0]));
  const soldIds = new Set(soldRecently.map((r) => r.productId));
  const pendingById = new Map(
    pendingReturns.map((r) => [r.productId as string, r._sum.quantity ?? 0]),
  );

  const incomingById = new Map<string, { units: number; cost: number }>();
  const openPoIds = new Set<string>();
  for (const item of openItems) {
    const units = outstandingQuantity(item);
    if (units <= 0) continue;
    openPoIds.add(item.purchaseOrderId);
    const acc = incomingById.get(item.productId) ?? { units: 0, cost: 0 };
    acc.units += units;
    acc.cost += units * item.unitCost;
    incomingById.set(item.productId, acc);
  }

  const booked = { units: 0, cost: 0, retail: 0, orders: bookedUnits.orders };
  const withCourier = { units: 0, cost: 0, retail: 0 };
  const returnsToCheck = { units: 0, cost: 0 };

  const rows: OverviewProductRow[] = products.map((p) => {
    const pos = positions.get(p.id);
    const incoming = incomingById.get(p.id);
    // POs raised without a line cost fall back to the product's cost, so incoming stock
    // is not valued at nothing.
    const incomingUnits = incoming?.units ?? 0;
    const incomingCost = incoming && incoming.cost > 0 ? incoming.cost : incomingUnits * p.unitCost;

    const bookedHere = bookedUnits.byProduct.get(p.id) ?? 0;
    booked.units += bookedHere;
    booked.cost += bookedHere * p.unitCost;
    booked.retail += bookedHere * estimateUnitPrice(p);

    // Shopify-derived in-transit counts every shipment not yet delivered or returned,
    // bookings included, so they come out here to be counted once. Courierify's own
    // in-transit figure is forward transit only and already excludes them. Clamped
    // because in-transit is recomputed hourly and a fresh booking can land first.
    const inTransit = Math.max(
      0,
      p.fulfilledInTransit - (p.fulfilmentSource === "courierify" ? 0 : bookedHere),
    );
    withCourier.units += inTransit;
    withCourier.cost += inTransit * p.unitCost;
    withCourier.retail += inTransit * estimateUnitPrice(p);

    const pending = pendingById.get(p.id) ?? 0;
    returnsToCheck.units += pending;
    returnsToCheck.cost += pending * p.unitCost;

    return {
      ...toOverviewRow({
        id: p.id,
        onHand: p.currentStock,
        unbooked: pos?.reserved ?? 0,
        damaged: damagedById.get(p.id) ?? 0,
        incoming: incomingUnits,
        incomingCost,
        unitCost: p.unitCost,
        price: p.price,
        avgDailySales: p.avgDailySales,
        planningStatus: getStockStatus(pos?.position ?? p.currentStock, p.reorderPoint),
        deadStock: p.currentStock >= deadStock.minUnits && !soldIds.has(p.id),
      }),
      title: p.title,
      variantTitle: p.variantTitle,
      sku: p.sku,
      imageUrl: p.imageUrl,
    };
  });

  return {
    rows,
    totals: summarise(rows),
    booked,
    withCourier,
    returnsToCheck,
    openPurchaseOrders: openPoIds.size,
  };
}

export interface TopMover {
  productId: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  sold: number;
  /** Units × current price; null when the SKU has no price. */
  revenue: number | null;
}

export interface StockMovement {
  received: { units: number; damaged: number; cost: number; purchaseOrders: number };
  returnsRestocked: { units: number; cost: number };
  /** Net of every other manual movement — damage, count corrections, samples, reversals. */
  adjustments: { units: number; cost: number };
  sold: {
    units: number;
    priorUnits: number;
    /** Units × today's price, over priced SKUs only. Ignores discounts and price changes. */
    valueAtCurrentPrice: number;
  };
  topMovers: TopMover[];
}

/**
 * Stock in and out over a date range.
 *
 * Each source is counted once. PO receipts write no StockAdjustment (they move location
 * stock directly), and restocked returns are StockAdjustment(reason="return") — so
 * returns are read from that reason and excluded from the adjustments total, which would
 * otherwise count every restock twice.
 */
export async function getStockMovement(
  shop: string,
  range: Pick<DateRange, "from" | "to">,
  prior: Pick<DateRange, "from" | "to">,
): Promise<StockMovement> {
  const inRange = { gte: range.from, lt: range.to };

  const [receiptLines, adjustments, sales, priorSales] = await Promise.all([
    prisma.purchaseOrderReceiptLine.findMany({
      where: { receipt: { shop, receivedAt: inRange } },
      select: {
        quantity: true,
        quantityDamaged: true,
        receipt: { select: { purchaseOrderId: true } },
        purchaseOrderItem: { select: { unitCost: true, product: { select: { unitCost: true } } } },
      },
    }),
    prisma.stockAdjustment.findMany({
      where: { shop, createdAt: inRange },
      select: { delta: true, reason: true, product: { select: { unitCost: true } } },
    }),
    prisma.salesRecord.groupBy({
      by: ["productId"],
      where: { shop, date: inRange },
      _sum: { quantity: true },
    }),
    prisma.salesRecord.aggregate({
      where: { shop, date: { gte: prior.from, lt: prior.to } },
      _sum: { quantity: true },
    }),
  ]);

  const received = { units: 0, damaged: 0, cost: 0, purchaseOrders: 0 };
  const poIds = new Set<string>();
  for (const line of receiptLines) {
    const unitCost = line.purchaseOrderItem.unitCost > 0
      ? line.purchaseOrderItem.unitCost
      : line.purchaseOrderItem.product.unitCost;
    received.units += line.quantity;
    received.damaged += line.quantityDamaged;
    received.cost += line.quantity * unitCost;
    poIds.add(line.receipt.purchaseOrderId);
  }
  received.purchaseOrders = poIds.size;

  const returnsRestocked = { units: 0, cost: 0 };
  const other = { units: 0, cost: 0 };
  for (const a of adjustments) {
    const bucket = a.reason === "return" ? returnsRestocked : other;
    bucket.units += a.delta;
    bucket.cost += a.delta * a.product.unitCost;
  }

  const soldById = new Map(sales.map((s) => [s.productId, s._sum.quantity ?? 0]));
  const soldProducts = soldById.size
    ? await prisma.product.findMany({
        where: { shop, id: { in: [...soldById.keys()] } },
        select: { id: true, title: true, variantTitle: true, sku: true, price: true },
      })
    : [];

  let units = 0;
  for (const sold of soldById.values()) units += sold;
  let valueAtCurrentPrice = 0;
  const movers: TopMover[] = [];
  for (const p of soldProducts) {
    const sold = soldById.get(p.id) ?? 0;
    const priced = p.price != null && p.price > 0;
    if (priced) valueAtCurrentPrice += sold * (p.price as number);
    if (sold > 0) {
      movers.push({
        productId: p.id, title: p.title, variantTitle: p.variantTitle, sku: p.sku,
        sold, revenue: priced ? sold * (p.price as number) : null,
      });
    }
  }
  movers.sort((a, b) => b.sold - a.sold || a.productId.localeCompare(b.productId));

  return {
    received,
    returnsRestocked,
    adjustments: other,
    sold: { units, priorUnits: priorSales._sum.quantity ?? 0, valueAtCurrentPrice },
    topMovers: movers.slice(0, 5),
  };
}
