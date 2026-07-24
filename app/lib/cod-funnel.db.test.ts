/**
 * The COD order funnel, and specifically what "attrition" means.
 *
 * The rate was (placed - dispatched) / placed, which counts cancellations as attrition.
 * That made the card contradict itself: a "Never dispatched" tile reading 42 sat directly
 * above the sentence "9.1% of placed COD orders never reached dispatch" — 9.1% of 746
 * being 68, not 42. It also double-counted a correction, because cancelled units are
 * already removed from SalesRecord by the orders/cancelled webhook, so the claim that
 * demand is "overstated by roughly that much" was wrong by the cancellation rate.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 */
import { beforeEach, describe, expect, it } from "vitest";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { getCodFunnel } = await import("./analytics.server");
const { resolveDateRange } = await import("./date-range");
const { default: prisma } = await import("../db.server");

const SHOP = "funnel-test.myshopify.com";
const range = () => resolveDateRange(new URLSearchParams("range=30"));

let seq = 0;
async function order(opts: {
  cod?: boolean;
  dispatched?: boolean;
  cancelled?: boolean;
  confirmed?: boolean;
  daysAgo?: number;
}) {
  seq += 1;
  await prisma.orderRegion.create({
    data: {
      shop: SHOP,
      orderName: `#${1000 + seq}`,
      units: 1,
      isCod: opts.cod ?? true,
      isDispatched: opts.dispatched ?? false,
      isCancelled: opts.cancelled ?? false,
      isConfirmed: opts.confirmed ?? false,
      orderedAt: new Date(Date.now() - (opts.daysAgo ?? 5) * 86400000),
    },
  });
}

beforeEach(async () => {
  await prisma.orderRegion.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.deleteMany({ where: { shop: SHOP } });
  seq = 0;
});

describe("getCodFunnel", () => {
  it("excludes cancellations from attrition, matching the Never-dispatched tile", async () => {
    for (let i = 0; i < 90; i++) await order({ dispatched: true });
    for (let i = 0; i < 5; i++) await order({ cancelled: true });
    for (let i = 0; i < 5; i++) await order({}); // placed, never dispatched, not cancelled

    const f = await getCodFunnel(SHOP, range());

    expect(f.placed).toBe(100);
    expect(f.dispatched).toBe(90);
    expect(f.cancelled).toBe(5);
    expect(f.pending).toBe(5);
    // 5 of the 95 orders that could still have shipped — not 10 of 100, which is what
    // counting cancellations as attrition produced.
    expect(f.attritionRate).toBeCloseTo(5 / 95, 6);
  });

  it("keeps the rate consistent with pending / (placed - cancelled)", async () => {
    for (let i = 0; i < 40; i++) await order({ dispatched: true });
    for (let i = 0; i < 30; i++) await order({ cancelled: true });
    for (let i = 0; i < 10; i++) await order({});

    const f = await getCodFunnel(SHOP, range());
    // The invariant the UI relies on when it prints "N of M".
    expect(f.attritionRate).toBeCloseTo(f.pending / (f.placed - f.cancelled), 10);
  });

  it("reports zero attrition when everything dispatched", async () => {
    for (let i = 0; i < 10; i++) await order({ dispatched: true });
    const f = await getCodFunnel(SHOP, range());
    expect(f.attritionRate).toBe(0);
    expect(f.pending).toBe(0);
  });

  it("does not divide by zero when every order was cancelled", async () => {
    for (let i = 0; i < 4; i++) await order({ cancelled: true });
    const f = await getCodFunnel(SHOP, range());
    expect(f.placed).toBe(4);
    expect(f.cancelled).toBe(4);
    expect(f.attritionRate).toBe(0);
    expect(Number.isFinite(f.attritionRate)).toBe(true);
  });

  it("returns an empty funnel with no orders", async () => {
    const f = await getCodFunnel(SHOP, range());
    expect(f).toMatchObject({ placed: 0, dispatched: 0, cancelled: 0, pending: 0, attritionRate: 0 });
  });

  it("counts only COD orders", async () => {
    for (let i = 0; i < 5; i++) await order({ cod: false });
    await order({ dispatched: true });
    const f = await getCodFunnel(SHOP, range());
    expect(f.placed).toBe(1);
  });

  it("respects the reporting window", async () => {
    await order({ dispatched: true, daysAgo: 5 });
    await order({ dispatched: true, daysAgo: 120 });
    const f = await getCodFunnel(SHOP, range());
    expect(f.placed).toBe(1);
  });

  it("reports confirmation as untracked until a tag is configured", async () => {
    await order({ dispatched: true, confirmed: true });
    const untracked = await getCodFunnel(SHOP, range());
    expect(untracked.confirmationTracked).toBe(false);

    await prisma.shopSettings.create({ data: { shop: SHOP, confirmedOrderTag: "confirmed" } });
    const tracked = await getCodFunnel(SHOP, range());
    expect(tracked.confirmationTracked).toBe(true);
    expect(tracked.confirmed).toBe(1);
  });

  it("never reports negative pending when an order is both dispatched and cancelled", async () => {
    await order({ dispatched: true, cancelled: true });
    const f = await getCodFunnel(SHOP, range());
    expect(f.pending).toBe(0);
    expect(f.attritionRate).toBeGreaterThanOrEqual(0);
  });
});
