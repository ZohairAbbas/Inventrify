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
});
