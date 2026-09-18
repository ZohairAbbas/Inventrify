/**
 * Replays fixture Shopify order pages through syncOrderHistory.
 *
 * The sync used to delete every SalesRecord from 90 days back and rebuild from what
 * Shopify returned — but without read_all_orders Shopify returns only 60 days, so days
 * 61–90 were deleted every hour and never rebuilt. These tests pin that down.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 *
 * The admin client is a stub; see shopify-sync.db.test.ts for why that is load-bearing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { DailyPoint } from "./demand.server";

// Observe what the sync hands the estimator, while still running the real one.
const estimateCalls: DailyPoint[][] = [];
vi.mock("./demand.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./demand.server")>();
  return {
    ...actual,
    estimateDemand: (records: DailyPoint[], opts: Parameters<typeof actual.estimateDemand>[1]) => {
      estimateCalls.push(records);
      return actual.estimateDemand(records, opts);
    },
  };
});

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { syncOrderHistory } = await import("./order-sync.server");
const { default: prisma } = await import("../db.server");

const SHOP = "order-sync-test.myshopify.com";
const VARIANT = "gid://shopify/ProductVariant/501";
const DAY_MS = 86400000;

/** Midnight UTC `n` days ago — the storage key for that day in a UTC shop. */
function dayKey(n: number): Date {
  const d = new Date(Date.now() - n * DAY_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Noon UTC `n` days ago, safely inside that day. */
function noon(n: number): string {
  return new Date(dayKey(n).getTime() + 12 * 3600000).toISOString();
}

let orderSeq = 0;
function order(daysAgo: number, qty: number, opts: { cancelled?: boolean } = {}) {
  orderSeq++;
  return {
    node: {
      id: `gid://shopify/Order/${orderSeq}`,
      name: `#${1000 + orderSeq}`,
      createdAt: noon(daysAgo),
      cancelledAt: opts.cancelled ? noon(daysAgo) : null,
      paymentGatewayNames: ["Cash on Delivery (COD)"],
      tags: [],
      displayFulfillmentStatus: "UNFULFILLED",
      fulfillments: [],
      shippingAddress: null,
      lineItems: {
        edges: [{ node: { variant: { id: VARIANT, sku: "SKU-501" }, quantity: qty } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

/** Stub admin: answers the access-scope query and serves `orders` as one page. */
function mockAdmin(orders: unknown[], opts: { scopes?: string[]; failOrders?: boolean } = {}) {
  const admin = {
    graphql: async (query: string) => {
      if (query.includes("accessScopes")) {
        const handles = opts.scopes ?? ["read_orders", "write_products"];
        return {
          status: 200,
          ok: true,
          json: async () => ({
            data: { currentAppInstallation: { accessScopes: handles.map((handle) => ({ handle })) } },
          }),
        };
      }
      if (opts.failOrders) {
        // 402 is what a frozen shop returns, and it is not retried.
        return { status: 402, ok: false, json: async () => ({}) };
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({
          data: { orders: { edges: orders, pageInfo: { hasNextPage: false, endCursor: null } } },
        }),
      };
    },
  } as unknown as AdminApiContext;
  return admin;
}

async function stored(): Promise<Map<number, number>> {
  const rows = await prisma.salesRecord.findMany({
    where: { shop: SHOP, productId: VARIANT },
    orderBy: { date: "asc" },
  });
  const byAge = new Map<number, number>();
  for (const r of rows) {
    byAge.set(Math.round((dayKey(0).getTime() - r.date.getTime()) / DAY_MS), r.quantity);
  }
  return byAge;
}

async function seedHistory(byAge: Record<number, number>) {
  await prisma.salesRecord.createMany({
    data: Object.entries(byAge).map(([age, quantity]) => ({
      shop: SHOP,
      productId: VARIANT,
      date: dayKey(Number(age)),
      quantity,
    })),
  });
}

beforeEach(async () => {
  await prisma.salesRecord.deleteMany({ where: { shop: SHOP } });
  await prisma.returnRateHistory.deleteMany({ where: { shop: SHOP } });
  await prisma.orderLineItem.deleteMany({ where: { shop: SHOP } });
  await prisma.orderRegion.deleteMany({ where: { shop: SHOP } });
  await prisma.orderOutcome.deleteMany({ where: { shop: SHOP } });
  await prisma.product.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.create({ data: { shop: SHOP, timezone: "UTC" } });
  await prisma.product.create({
    data: {
      id: VARIANT,
      shop: SHOP,
      productGid: "gid://shopify/Product/5",
      title: "Kurta",
      sku: "SKU-501",
      firstSoldAt: dayKey(120),
    },
  });
});

describe("syncOrderHistory without read_all_orders", () => {
  it("keeps stored history older than the 60 days Shopify returned", async () => {
    // Days 61–90 exist only in storage: Shopify will not return them.
    await seedHistory({ 61: 4, 70: 5, 89: 6, 120: 7 });

    const result = await syncOrderHistory(mockAdmin([order(10, 2), order(30, 3)]), SHOP);

    expect(result.completed).toBe(true);
    const after = await stored();
    expect(after.get(61)).toBe(4);
    expect(after.get(70)).toBe(5);
    expect(after.get(89)).toBe(6);
    expect(after.get(120)).toBe(7);
    expect(after.get(10)).toBe(2);
    expect(after.get(30)).toBe(3);
  });

  it("still rebuilds the fetched window, including a cancellation", async () => {
    // Day 20's order has since been cancelled; day 5's count was short by one; day 40
    // held a row for an order that no longer counts.
    await seedHistory({ 5: 1, 20: 4, 40: 9 });

    const result = await syncOrderHistory(
      mockAdmin([order(5, 2), order(20, 4, { cancelled: true }), order(25, 1)]),
      SHOP,
    );

    expect(result.completed).toBe(true);
    expect(result.recordsDeleted).toBe(3);
    const after = await stored();
    expect(after.get(5)).toBe(2);
    expect(after.has(20)).toBe(false);
    expect(after.has(40)).toBe(false);
    expect(after.get(25)).toBe(1);
  });

  it("does not overwrite the partly-walked boundary day, but backfills it when empty", async () => {
    // Day 60 is the edge of Shopify's window: the walk may have seen only part of it.
    await seedHistory({ 60: 8 });
    await syncOrderHistory(mockAdmin([order(60, 1), order(59, 2)]), SHOP);
    expect((await stored()).get(60)).toBe(8);

    await prisma.salesRecord.deleteMany({ where: { shop: SHOP } });
    await syncOrderHistory(mockAdmin([order(60, 1)]), SHOP);
    expect((await stored()).get(60)).toBe(1);
  });

  it("writes nothing when the walk aborts", async () => {
    await seedHistory({ 5: 3, 70: 5 });
    const result = await syncOrderHistory(mockAdmin([], { failOrders: true }), SHOP);
    expect(result.completed).toBe(false);
    expect(result.recordsDeleted).toBe(0);
    const after = await stored();
    expect(after.get(5)).toBe(3);
    expect(after.get(70)).toBe(5);
  });

  it("estimates demand from stored older days, not just the walk", async () => {
    // 3/day stored for 90 days; the walk returns only the last 59. Estimating from the
    // walk alone would present days 59–89 as zero demand.
    const history: Record<number, number> = {};
    for (let d = 1; d <= 89; d++) history[d] = 3;
    await seedHistory(history);
    const orders = [];
    for (let d = 1; d <= 58; d++) orders.push(order(d, 3));
    estimateCalls.length = 0;

    await syncOrderHistory(mockAdmin(orders), SHOP);

    expect(estimateCalls).toHaveLength(1);
    const given = estimateCalls[0];
    expect(given).toHaveLength(89);
    expect(given.every((p) => p.quantity === 3)).toBe(true);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: VARIANT } });
    expect(product.avgDailySales).toBeGreaterThan(0);
  });
});

describe("syncOrderHistory with read_all_orders", () => {
  it("reconciles the full 90-day window", async () => {
    await seedHistory({ 70: 5, 120: 7 });

    await syncOrderHistory(
      mockAdmin([order(75, 2)], { scopes: ["read_orders", "read_all_orders"] }),
      SHOP,
    );

    const after = await stored();
    // Day 70 had no order in Shopify's full answer, so its row was stale.
    expect(after.has(70)).toBe(false);
    expect(after.get(75)).toBe(2);
    expect(after.get(120)).toBe(7);
  });
});
