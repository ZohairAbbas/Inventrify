/**
 * End-to-end check of the SalesRecord repair against a real database.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 */
import { beforeEach, describe, expect, it } from "vitest";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { applyShopRepair, planShopRepair } = await import("./sales-history-repair.server");
const { default: prisma } = await import("../db.server");

const SHOP = "repair-test.myshopify.com";
const VARIANT = "gid://shopify/ProductVariant/601";
const NOW = new Date("2026-09-18T06:00:00.000Z");
const at = (iso: string) => new Date(`${iso}T09:00:00.000Z`);
const key = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function line(orderName: string, iso: string, quantity: number, cancelled = false) {
  await prisma.orderLineItem.create({
    data: { shop: SHOP, orderName, productId: VARIANT, quantity, orderedAt: at(iso) },
  });
  await prisma.orderRegion.create({
    data: { shop: SHOP, orderName, orderedAt: at(iso), isCancelled: cancelled, units: quantity },
  });
}

beforeEach(async () => {
  await prisma.salesRecord.deleteMany({ where: { shop: SHOP } });
  await prisma.orderLineItem.deleteMany({ where: { shop: SHOP } });
  await prisma.orderRegion.deleteMany({ where: { shop: SHOP } });
  await prisma.product.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.create({ data: { shop: SHOP, timezone: "UTC" } });
  await prisma.product.create({
    data: {
      id: VARIANT,
      shop: SHOP,
      productGid: "gid://shopify/Product/6",
      title: "Shawl",
      firstSoldAt: key("2026-07-10"),
    },
  });
});

describe("sales history repair", () => {
  it("restores deleted days from order lines without touching recent or existing days", async () => {
    await line("#1", "2026-07-01", 2); // deleted by the old sync: restore
    await line("#2", "2026-07-02", 3, true); // cancelled: not demand
    await line("#3", "2026-07-05", 4); // still stored: keep as is
    await line("#4", "2026-09-01", 5); // inside the sync's window: not ours
    await prisma.salesRecord.create({
      data: { shop: SHOP, productId: VARIANT, date: key("2026-07-05"), quantity: 6 },
    });

    const plan = await planShopRepair(SHOP, NOW);
    expect(plan.restore).toEqual([{ productId: VARIANT, date: key("2026-07-01"), quantity: 2 }]);
    expect(plan.mismatchedDays).toBe(1);

    // The dry run wrote nothing.
    expect(await prisma.salesRecord.count({ where: { shop: SHOP } })).toBe(1);

    expect(await applyShopRepair(SHOP, plan)).toBe(1);
    const rows = await prisma.salesRecord.findMany({
      where: { shop: SHOP },
      orderBy: { date: "asc" },
      select: { date: true, quantity: true },
    });
    expect(rows).toEqual([
      { date: key("2026-07-01"), quantity: 2 },
      { date: key("2026-07-05"), quantity: 6 },
    ]);

    // A restored day before firstSoldAt moves it earlier, or estimates would skip it.
    const product = await prisma.product.findUniqueOrThrow({ where: { id: VARIANT } });
    expect(product.firstSoldAt).toEqual(key("2026-07-01"));

    // Idempotent: a second pass finds nothing to do.
    expect((await planShopRepair(SHOP, NOW)).restore).toHaveLength(0);
  });
});
