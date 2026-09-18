/**
 * getRtoFreshness surfaces outcome statuses it does not recognise.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 */
import { beforeEach, describe, expect, it } from "vitest";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { getRtoFreshness } = await import("./rto-attribution.server");
const { default: prisma } = await import("../db.server");

const SHOP = "freshness-test.myshopify.com";

async function outcome(shipmentId: string, status: string, daysAgo = 1) {
  await prisma.orderOutcome.create({
    data: {
      shop: SHOP,
      shipmentId,
      orderName: `#${shipmentId}`,
      status,
      updatedAt: new Date(Date.now() - daysAgo * 86400000),
    },
  });
}

beforeEach(async () => {
  await prisma.orderOutcome.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.create({ data: { shop: SHOP } });
});

describe("getRtoFreshness", () => {
  it("counts recent outcomes with an unrecognised status", async () => {
    await outcome("1", "delivered");
    await outcome("2", "attempted");
    await outcome("3", "RTO Initiated");
    await outcome("4", "RTO Initiated");
    await outcome("5", "unknown", 200); // outside the 90-day window

    const f = await getRtoFreshness(SHOP);

    expect(f.unrecognisedOutcomes).toBe(2);
    expect(f.unrecognisedWarning).toContain('"RTO Initiated"');
  });

  it("stays quiet when every status is known", async () => {
    await outcome("1", "DELIVERED");
    await outcome("2", "booked");
    const f = await getRtoFreshness(SHOP);
    expect(f.unrecognisedOutcomes).toBe(0);
    expect(f.unrecognisedWarning).toBeNull();
  });
});
