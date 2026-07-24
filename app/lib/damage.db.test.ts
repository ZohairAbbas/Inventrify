/**
 * The Damaged tally shown on the inventory pipeline and the dashboard.
 *
 * This was `Math.abs(sum(delta))` over every adjustment with reason "damage", which is
 * wrong in two ways: a *positive* adjustment tagged damage is stock coming back, not
 * being destroyed, and summing before taking the absolute value nets opposing movements
 * together. A live shop recorded +15 with the note "they were missing, they came back"
 * and both pages reported 15 damaged units against a true count of zero.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 */
import { beforeEach, describe, expect, it } from "vitest";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { getDamagedUnitsByProduct, getDamagedUnitsTotal } = await import("./damage.server");
const { default: prisma } = await import("../db.server");

const SHOP = "damage-test.myshopify.com";
const P1 = "gid://shopify/ProductVariant/dmg-1";
const P2 = "gid://shopify/ProductVariant/dmg-2";

async function product(id: string) {
  await prisma.product.create({
    data: {
      id,
      shop: SHOP,
      productGid: `gid://shopify/Product/${id}`,
      title: "Kurta",
      sku: id.slice(-5),
    },
  });
}

async function adjust(productId: string, delta: number, reason: string, createdAt?: Date) {
  await prisma.stockAdjustment.create({
    data: { shop: SHOP, productId, delta, reason, ...(createdAt ? { createdAt } : {}) },
  });
}

beforeEach(async () => {
  await prisma.stockAdjustment.deleteMany({ where: { shop: SHOP } });
  await prisma.returnItem.deleteMany({ where: { shop: SHOP } });
  await prisma.product.deleteMany({ where: { shop: SHOP } });
  await product(P1);
  await product(P2);
});

describe("getDamagedUnitsByProduct", () => {
  it("counts units removed as damage", async () => {
    await adjust(P1, -7, "damage");
    const map = await getDamagedUnitsByProduct(SHOP);
    expect(map.get(P1)).toBe(7);
  });

  it("ignores a positive adjustment tagged as damage", async () => {
    // The live case: "Miss hogaye thy wapis agaye" — found stock added back under the
    // damage reason. Nothing was destroyed, so nothing is damaged.
    await adjust(P1, 15, "damage");
    const map = await getDamagedUnitsByProduct(SHOP);
    expect(map.get(P1) ?? 0).toBe(0);
  });

  it("does not net a later correction against real damage", async () => {
    await adjust(P1, -20, "damage");
    await adjust(P1, 15, "damage");
    // 20 units were damaged. The +15 is a separate movement and must not reduce the
    // damage figure to 5 — that is what summing before abs() did.
    const map = await getDamagedUnitsByProduct(SHOP);
    expect(map.get(P1)).toBe(20);
  });

  it("ignores adjustments with other reasons", async () => {
    await adjust(P1, -9, "count_correction");
    await adjust(P1, -4, "sample");
    const map = await getDamagedUnitsByProduct(SHOP);
    expect(map.get(P1) ?? 0).toBe(0);
  });

  it("adds written-off returns to the damage tally", async () => {
    await adjust(P1, -3, "damage");
    await prisma.returnItem.create({
      data: {
        shop: SHOP, shipmentId: "s1", lineItemId: "l1", productId: P1,
        quantity: 4, status: "written_off", resolvedAt: new Date(),
      },
    });
    const map = await getDamagedUnitsByProduct(SHOP);
    expect(map.get(P1)).toBe(7);
  });

  it("ignores returns that are pending or restocked", async () => {
    await prisma.returnItem.createMany({
      data: [
        { shop: SHOP, shipmentId: "s2", lineItemId: "l2", productId: P1, quantity: 5, status: "pending" },
        { shop: SHOP, shipmentId: "s3", lineItemId: "l3", productId: P1, quantity: 6, status: "restocked", resolvedAt: new Date() },
      ],
    });
    const map = await getDamagedUnitsByProduct(SHOP);
    expect(map.get(P1) ?? 0).toBe(0);
  });

  it("keeps products separate", async () => {
    await adjust(P1, -2, "damage");
    await adjust(P2, -5, "damage");
    const map = await getDamagedUnitsByProduct(SHOP);
    expect(map.get(P1)).toBe(2);
    expect(map.get(P2)).toBe(5);
  });

  it("is scoped to the shop", async () => {
    await adjust(P1, -2, "damage");
    const map = await getDamagedUnitsByProduct("someone-else.myshopify.com");
    expect(map.size).toBe(0);
  });

  it("respects both ends of a reporting window", async () => {
    const day = 86400000;
    await adjust(P1, -1, "damage", new Date(Date.now() - 40 * day));
    await adjust(P1, -2, "damage", new Date(Date.now() - 10 * day));
    await adjust(P1, -4, "damage", new Date(Date.now() - 2 * day));

    const last30 = await getDamagedUnitsByProduct(SHOP, { from: new Date(Date.now() - 30 * day) });
    expect(last30.get(P1)).toBe(6);

    // A custom range that ends in the past must not sweep in later damage.
    const midWindow = await getDamagedUnitsByProduct(SHOP, {
      from: new Date(Date.now() - 30 * day),
      to: new Date(Date.now() - 5 * day),
    });
    expect(midWindow.get(P1)).toBe(2);
  });
});

describe("getDamagedUnitsTotal", () => {
  it("sums across products", async () => {
    await adjust(P1, -2, "damage");
    await adjust(P2, -5, "damage");
    await adjust(P2, 15, "damage"); // must not inflate the total
    expect(await getDamagedUnitsTotal(SHOP)).toBe(7);
  });

  it("is zero when nothing was damaged", async () => {
    expect(await getDamagedUnitsTotal(SHOP)).toBe(0);
  });
});
