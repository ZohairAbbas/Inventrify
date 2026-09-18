/**
 * Replays fixture Courierify order-outcome pages through syncCourierifyOrderOutcomes.
 *
 * `fetch` is stubbed, so nothing reaches Courierify.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { syncCourierifyOrderOutcomes } = await import("./courierify.server");
const { default: prisma } = await import("../db.server");

const SHOP = "outcomes-test.myshopify.com";

type Row = { shipmentId: string; shopifyOrderName: string; status: string; updatedAt?: string | null };

/** Stub fetch: `pages` are served in order; every request URL is recorded. */
function stubCourierify(pages: Row[][]) {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      urls.push(new URL(input));
      const rows = pages[urls.length - 1] ?? [];
      return { ok: true, status: 200, json: async () => ({ timestamp: "x", rows }) };
    }),
  );
  return urls;
}

async function cursor() {
  return (await prisma.shopSettings.findUniqueOrThrow({ where: { shop: SHOP } }))
    .courierifyOutcomesCursor;
}

beforeEach(async () => {
  await prisma.orderOutcome.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.create({ data: { shop: SHOP } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncCourierifyOrderOutcomes", () => {
  it("skips a row with no updatedAt instead of stamping it now", async () => {
    stubCourierify([
      [
        { shipmentId: "s1", shopifyOrderName: "#1", status: "delivered", updatedAt: "2026-08-01T10:00:00.000Z" },
        { shipmentId: "s2", shopifyOrderName: "#2", status: "returned", updatedAt: null },
      ],
    ]);

    const result = await syncCourierifyOrderOutcomes(SHOP, "key");

    expect(result.stored).toBe(1);
    expect(result.missingTimestamp).toBe(1);
    const rows = await prisma.orderOutcome.findMany({ where: { shop: SHOP } });
    expect(rows.map((r) => r.shipmentId)).toEqual(["s1"]);
    expect(rows[0].updatedAt.toISOString()).toBe("2026-08-01T10:00:00.000Z");
    // The cursor follows the real timestamp (minus the overlap), not the wall clock.
    expect((await cursor())?.toISOString()).toBe("2026-08-01T09:59:00.000Z");
  });

  it("does not move the cursor when only untimestamped rows arrive", async () => {
    stubCourierify([[{ shipmentId: "s2", shopifyOrderName: "#2", status: "returned" }]]);
    await syncCourierifyOrderOutcomes(SHOP, "key");
    expect(await cursor()).toBeNull();
    expect(await prisma.orderOutcome.count({ where: { shop: SHOP } })).toBe(0);
  });

  it("keeps reading while pages come back full, without losing rows", async () => {
    // 5,000 rows a second apart, oldest-first as Courierify sends them, then a short page.
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    const full: Row[] = Array.from({ length: 5000 }, (_, i) => ({
      shipmentId: `f${i}`,
      shopifyOrderName: `#${i}`,
      status: "delivered",
      updatedAt: new Date(base + i * 1000).toISOString(),
    }));
    const last = full[full.length - 1].updatedAt!;
    const tail: Row[] = [
      // Re-sent from inside the overlap, as Courierify will.
      { ...full[full.length - 1] },
      { shipmentId: "t1", shopifyOrderName: "#t1", status: "returned", updatedAt: new Date(base + 6_000_000).toISOString() },
    ];
    const urls = stubCourierify([full, tail]);

    const result = await syncCourierifyOrderOutcomes(SHOP, "key");

    expect(urls).toHaveLength(2);
    expect(urls[0].searchParams.get("updatedSince")).toBeNull();
    expect(urls[1].searchParams.get("updatedSince")).toBe(
      new Date(Date.parse(last) - 60_000).toISOString(),
    );
    expect(result.error).toBeUndefined();
    expect(await prisma.orderOutcome.count({ where: { shop: SHOP } })).toBe(5001);
    expect((await cursor())?.toISOString()).toBe(new Date(base + 6_000_000 - 60_000).toISOString());
  }, 120_000);

  it("steps past a full page that falls inside the overlap instead of re-reading it", async () => {
    const start = new Date("2026-08-01T00:00:00.000Z");
    await prisma.shopSettings.update({ where: { shop: SHOP }, data: { courierifyOutcomesCursor: start } });
    // A bulk import: 5,000 rows within 30 seconds of the cursor.
    const burst: Row[] = Array.from({ length: 5000 }, (_, i) => ({
      shipmentId: `b${i}`,
      shopifyOrderName: `#${i}`,
      status: "in_transit",
      updatedAt: new Date(start.getTime() + Math.floor(i / 200) * 1000).toISOString(),
    }));
    const lastTs = burst[burst.length - 1].updatedAt!;
    const urls = stubCourierify([burst, []]);

    await syncCourierifyOrderOutcomes(SHOP, "key");

    expect(urls).toHaveLength(2);
    // Without the guard this would be `start` again, and the next run would repeat it.
    expect(urls[1].searchParams.get("updatedSince")).toBe(lastTs);
  }, 120_000);

  it("stops rather than loops when a whole page shares one timestamp", async () => {
    const start = new Date("2026-08-01T00:00:00.000Z");
    await prisma.shopSettings.update({ where: { shop: SHOP }, data: { courierifyOutcomesCursor: start } });
    const same: Row[] = Array.from({ length: 5000 }, (_, i) => ({
      shipmentId: `x${i}`,
      shopifyOrderName: `#${i}`,
      status: "booked",
      updatedAt: start.toISOString(),
    }));
    const urls = stubCourierify([same, same, same]);

    await syncCourierifyOrderOutcomes(SHOP, "key");

    expect(urls).toHaveLength(1);
    expect((await cursor())?.toISOString()).toBe(start.toISOString());
  }, 120_000);
});
