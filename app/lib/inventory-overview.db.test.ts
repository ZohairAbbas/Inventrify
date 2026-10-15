/**
 * The dashboard's "Inventory right now" and "In the selected period" figures, against a
 * real database: each unit lands in exactly one stock bucket, and each stock movement
 * is counted once.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 */
import { beforeEach, describe, expect, it } from "vitest";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { getStockMovement, getStockOverview } = await import("./inventory-overview.server");
const { default: prisma } = await import("../db.server");

const SHOP = "overview-test.myshopify.com";
const A = "gid://shopify/ProductVariant/ov-a";
const B = "gid://shopify/ProductVariant/ov-b";
const DEAD = { days: 60, minUnits: 20 };

const day = (offset: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
};
const RANGE = { from: day(-29), to: day(1) };
const PRIOR = { from: day(-59), to: day(-29) };

let locationId = "";

async function product(id: string, data: { currentStock: number; unitCost: number; price: number | null; reorderPoint?: number; avgDailySales?: number; fulfilledInTransit?: number }) {
  await prisma.product.create({
    data: { id, shop: SHOP, productGid: `gid://shopify/Product/${id}`, title: id.slice(-4), sku: id.slice(-4), ...data },
  });
}

beforeEach(async () => {
  await prisma.orderOutcome.deleteMany({ where: { shop: SHOP } });
  await prisma.orderLineItem.deleteMany({ where: { shop: SHOP } });
  await prisma.purchaseOrderReceiptLine.deleteMany({ where: { receipt: { shop: SHOP } } });
  await prisma.purchaseOrderReceipt.deleteMany({ where: { shop: SHOP } });
  await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { shop: SHOP } } });
  await prisma.purchaseOrder.deleteMany({ where: { shop: SHOP } });
  await prisma.stockAdjustment.deleteMany({ where: { shop: SHOP } });
  await prisma.returnItem.deleteMany({ where: { shop: SHOP } });
  await prisma.salesRecord.deleteMany({ where: { shop: SHOP } });
  await prisma.productLocationStock.deleteMany({ where: { shop: SHOP } });
  await prisma.product.deleteMany({ where: { shop: SHOP } });
  await prisma.location.deleteMany({ where: { shop: SHOP } });

  locationId = (
    await prisma.location.create({ data: { shop: SHOP, shopifyLocationId: "gid://shopify/Location/ov", name: "WH" } })
  ).id;
  await product(A, { currentStock: 40, unitCost: 100, price: 250, reorderPoint: 5, avgDailySales: 2, fulfilledInTransit: 3 });
  await product(B, { currentStock: 0, unitCost: 50, price: null });
  await prisma.productLocationStock.create({
    data: { shop: SHOP, productId: A, locationId, onHand: 40, reserved: 4, damaged: 2 },
  });
});

describe("getStockOverview", () => {
  it("splits stock into non-overlapping buckets", async () => {
    await prisma.purchaseOrder.create({
      data: { shop: SHOP, poNumber: "PO-OV-1", status: "sent", items: { create: [{ productId: B, quantityOrdered: 10, quantityReceived: 4, unitCost: 60 }] } },
    });
    await prisma.purchaseOrder.create({
      data: { shop: SHOP, poNumber: "PO-OV-DRAFT", status: "draft", items: { create: [{ productId: B, quantityOrdered: 99, unitCost: 60 }] } },
    });
    await prisma.returnItem.create({
      data: { shop: SHOP, shipmentId: "s1", lineItemId: "l1", productId: A, quantity: 2, status: "pending" },
    });

    const o = await getStockOverview(SHOP, DEAD);

    expect(o.totals.onHand).toBe(40);
    expect(o.totals.unbooked).toBe(4);
    expect(o.totals.available).toBe(36);
    expect(o.totals.damaged).toBe(2);
    // Outstanding on the sent PO only, valued at the PO line's cost; drafts are not incoming.
    expect(o.totals.incoming).toBe(6);
    expect(o.totals.incomingCost).toBe(360);
    expect(o.openPurchaseOrders).toBe(1);
    expect(o.withCourier).toEqual({ units: 3, cost: 300, retail: 750 });
    expect(o.booked).toEqual({ units: 0, cost: 0, retail: 0, orders: 0 });
    expect(o.returnsToCheck).toEqual({ units: 2, cost: 200 });

    // Retail over priced SKUs only: B has no price and no stock.
    expect(o.totals.atRetail).toBe(40 * 250);
    expect(o.totals.pricedSkus).toBe(1);

    const b = o.rows.find((r) => r.id === B);
    expect(b?.status).toBe("out");
    expect(b?.incoming).toBe(6);
  });

  it("splits parcels booked but not picked up out of with-courier", async () => {
    const order = async (name: string, status: string, source: string, qty: number, daysAgo = 0) => {
      const at = new Date(Date.now() - daysAgo * 86400000);
      await prisma.orderLineItem.create({
        data: { id: `li-${name}`, shop: SHOP, orderName: name, productId: A, quantity: qty, orderedAt: at },
      });
      await prisma.orderOutcome.create({
        data: { id: `oo-${name}`, shop: SHOP, shipmentId: `s-${name}`, orderName: name, status, source, updatedAt: at },
      });
    };
    // Booked via Shopify's fulfilled-with-no-scan and via Courierify's own status.
    await order("#1", "FULFILLED", "shopify", 1);
    await order("#2", "booked", "courierify", 1);
    // Picked up, and a booking stale enough that tracking has stopped: both stay with the courier.
    await order("#3", "IN_TRANSIT", "shopify", 1);
    await order("#4", "FULFILLED", "shopify", 5, 10);

    const o = await getStockOverview(SHOP, DEAD);

    expect(o.booked).toEqual({ units: 2, cost: 200, retail: 500, orders: 2 });
    // A's in-transit of 3 (Shopify-derived) included the two bookings.
    expect(o.withCourier).toEqual({ units: 1, cost: 100, retail: 250 });
    // Booking fulfils the order: on-hand and the unbooked split are untouched.
    expect(o.totals.onHand).toBe(40);
    expect(o.totals.unbooked).toBe(4);

    // Courierify's in-transit figure is forward transit only, so nothing comes off it.
    await prisma.product.update({ where: { id: A }, data: { fulfilmentSource: "courierify" } });
    expect((await getStockOverview(SHOP, DEAD)).withCourier.units).toBe(3);
  });

  it("flags slow stock with Analytics' dead-stock rule", async () => {
    // 40 units on hand, nothing sold in 60 days, but planning says healthy.
    await prisma.product.update({ where: { id: A }, data: { reorderPoint: 0 } });
    let o = await getStockOverview(SHOP, DEAD);
    expect(o.rows.find((r) => r.id === A)?.status).toBe("slow");

    await prisma.salesRecord.create({ data: { shop: SHOP, productId: A, date: day(-3), quantity: 1 } });
    o = await getStockOverview(SHOP, DEAD);
    expect(o.rows.find((r) => r.id === A)?.status).toBe("healthy");
  });
});

describe("getStockMovement", () => {
  it("counts receipts, return restocks and other adjustments once each", async () => {
    const po = await prisma.purchaseOrder.create({
      data: { shop: SHOP, poNumber: "PO-OV-2", status: "received", items: { create: [{ productId: A, quantityOrdered: 20, quantityReceived: 20, unitCost: 90 }] } },
      include: { items: true },
    });
    await prisma.purchaseOrderReceipt.create({
      data: {
        shop: SHOP, purchaseOrderId: po.id, receivedAt: day(-5),
        lines: { create: [{ purchaseOrderItemId: po.items[0].id, quantity: 20, quantityDamaged: 1 }] },
      },
    });
    // Outside the range: ignored.
    await prisma.purchaseOrderReceipt.create({
      data: {
        shop: SHOP, purchaseOrderId: po.id, receivedAt: day(-45),
        lines: { create: [{ purchaseOrderItemId: po.items[0].id, quantity: 7 }] },
      },
    });
    await prisma.stockAdjustment.createMany({
      data: [
        { shop: SHOP, productId: A, delta: 3, reason: "return" },
        { shop: SHOP, productId: A, delta: -2, reason: "damage" },
        { shop: SHOP, productId: A, delta: 1, reason: "count_correction" },
      ],
    });
    await prisma.salesRecord.createMany({
      data: [
        { shop: SHOP, productId: A, date: day(-2), quantity: 6 },
        { shop: SHOP, productId: B, date: day(-2), quantity: 4 },
        { shop: SHOP, productId: A, date: day(-40), quantity: 5 },
      ],
    });

    const m = await getStockMovement(SHOP, RANGE, PRIOR);

    expect(m.received).toEqual({ units: 20, damaged: 1, cost: 1800, purchaseOrders: 1 });
    expect(m.returnsRestocked).toEqual({ units: 3, cost: 300 });
    // Return restocks are not counted again among adjustments.
    expect(m.adjustments).toEqual({ units: -1, cost: -100 });
    expect(m.sold.units).toBe(10);
    expect(m.sold.priorUnits).toBe(5);
    // B is unpriced, so only A's units are valued.
    expect(m.sold.valueAtCurrentPrice).toBe(6 * 250);
    expect(m.topMovers.map((t) => [t.productId, t.sold, t.revenue])).toEqual([
      [A, 6, 1500],
      [B, 4, null],
    ]);
  });
});
