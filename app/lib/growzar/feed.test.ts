import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sign, signingPayload } from "./signing.server";
import { createRateLimiter } from "./rate-limit.server";

const count = vi.fn();
const findSettings = vi.fn();
vi.mock("../../db.server", () => ({
  default: {
    session: { count: (...args: unknown[]) => count(...args) },
    shopSettings: { findUnique: (...args: unknown[]) => findSettings(...args) },
  },
}));

const { money, numericId, openFeed, parseFeedParams, dayLabel } = await import("./feed.server");
const { parseShopCountry, parseShopFacts } = await import("../shopify-sync.server");

const SHOP = "acme.myshopify.com";
const saved = { ...process.env };

beforeEach(() => {
  process.env.GROWZAR_URL = "https://growzar.test";
  process.env.GROWZAR_PLATFORM_KEY = "pk";
  process.env.GROWZAR_SIGNING_SECRET = "secret";
  count.mockReset().mockResolvedValue(1);
  findSettings.mockReset().mockResolvedValue({ shopTimezone: "Asia/Karachi", shopCurrency: "PKR", shopCountry: "PK" });
});
afterEach(() => {
  process.env = { ...saved };
});

function request(path: string, { signed = true } = {}) {
  const timestamp = Date.now();
  const headers = new Headers({ Authorization: "Bearer pk", "X-Growzar-Shop": SHOP });
  if (signed) {
    headers.set("X-Growzar-Timestamp", String(timestamp));
    headers.set("X-Growzar-Signature", sign("secret", signingPayload({ timestamp, method: "GET", pathWithQuery: path, body: "" })));
  }
  return new Request(`http://localhost:3016${path}`, { headers });
}

const PATH = "/api/v1/growzar/variants";
const roomy = () => createRateLimiter(10, 60_000);

describe("openFeed", () => {
  it("admits a signed request for an installed shop and returns its facts", async () => {
    const result = await openFeed(request(PATH), { limiter: roomy() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.facts).toEqual({ shop: SHOP, shopTimezone: "Asia/Karachi", shopCurrency: "PKR", shopCountry: "PK" });
      expect(result.value.params).toEqual({ updatedSince: null, limit: 200, cursor: null });
    }
  });

  it("refuses an unsigned request with 401", async () => {
    const result = await openFeed(request(PATH, { signed: false }), { limiter: roomy() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("answers 410 shop_not_connected for a shop without an install", async () => {
    count.mockResolvedValue(0);
    const result = await openFeed(request(PATH), { limiter: roomy() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(410);
      expect(await result.response.json()).toMatchObject({ errorType: "shop_not_connected" });
    }
  });

  it("reports unknown shop facts as null, never a default", async () => {
    findSettings.mockResolvedValue(null);
    const result = await openFeed(request(PATH), { limiter: roomy() });
    expect(result.ok && result.value.facts).toEqual({ shop: SHOP, shopTimezone: null, shopCurrency: null, shopCountry: null });
  });

  it("answers 429 with Retry-After once the bucket is spent", async () => {
    const limiter = createRateLimiter(1, 60_000);
    expect((await openFeed(request(PATH), { limiter })).ok).toBe(true);
    const second = await openFeed(request(PATH), { limiter });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.response.status).toBe(429);
      expect(Number(second.response.headers.get("Retry-After"))).toBeGreaterThan(0);
    }
  });

  it("fails closed with 503 when the limiter throws", async () => {
    const broken = { take: () => { throw new Error("boom"); } };
    const result = await openFeed(request(PATH), { limiter: broken });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });

  it("does not spend the bucket on unauthenticated requests", async () => {
    const limiter = createRateLimiter(1, 60_000);
    await openFeed(request(PATH, { signed: false }), { limiter });
    expect((await openFeed(request(PATH), { limiter })).ok).toBe(true);
  });

  it("rejects a bad limit with 400", async () => {
    const result = await openFeed(request(`${PATH}?limit=501`), { limiter: roomy() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });
});

describe("parseFeedParams", () => {
  const parse = (query: string) => parseFeedParams(new URL(`http://x${PATH}?${query}`));

  it("accepts updatedSince, limit and a cursor it issued", () => {
    const cursor = Buffer.from(JSON.stringify(["2026-10-01T00:00:00.000Z", "abc"])).toString("base64url");
    const result = parse(`updatedSince=2026-09-30T10:00:00Z&limit=2&cursor=${cursor}`);
    expect(result).toEqual({
      ok: true,
      value: {
        updatedSince: new Date("2026-09-30T10:00:00Z"),
        limit: 2,
        cursor: { updatedAt: new Date("2026-10-01T00:00:00.000Z"), id: "abc" },
      },
    });
  });

  it.each(["updatedSince=yesterday", "limit=0", "limit=2.5", "cursor=not-a-cursor"])("rejects %s", (query) => {
    expect(parse(query).ok).toBe(false);
  });
});

describe("money", () => {
  it("rounds to the currency's minor units and writes a decimal string", () => {
    expect(money(1250, "PKR")).toEqual({ amount: "1250.00", currency: "PKR" });
    expect(money(19.999, "USD")).toEqual({ amount: "20.00", currency: "USD" });
    expect(money(1500.4, "JPY")).toEqual({ amount: "1500", currency: "JPY" });
    expect(money(1.2345, "KWD")).toEqual({ amount: "1.235", currency: "KWD" });
  });

  it("is null when the currency is unknown, never a default", () => {
    expect(money(1250, null)).toBeNull();
    expect(money(null, "PKR")).toBeNull();
  });
});

describe("numericId", () => {
  it("strips a GID to its numeric id", () => {
    expect(numericId("gid://shopify/ProductVariant/123")).toBe("123");
    expect(numericId("gid://shopify/Location/77")).toBe("77");
    expect(numericId("456")).toBe("456");
  });

  it("refuses anything it cannot read as an id", () => {
    expect(numericId("SKU-12")).toBeNull();
    expect(numericId("")).toBeNull();
    expect(numericId(null)).toBeNull();
  });
});

describe("dayLabel", () => {
  it("labels a stored day by its calendar date", () => {
    expect(dayLabel(new Date("2026-10-06T00:00:00.000Z"))).toBe("2026-10-06");
  });
});

describe("rate limiter", () => {
  it("admits 600 a minute and frees slots as the window slides", () => {
    const limiter = createRateLimiter(600, 60_000);
    for (let i = 0; i < 600; i++) expect(limiter.take(1_000 + i).ok).toBe(true);
    expect(limiter.take(1_700).ok).toBe(false);
    expect(limiter.take(61_000).ok).toBe(true);
  });
});

describe("parseShopFacts", () => {
  it("takes currency and timezone from Shopify", () => {
    expect(parseShopFacts({ shop: { name: "Acme", currencyCode: "PKR", ianaTimezone: "Asia/Karachi" } })).toEqual({
      name: "Acme",
      shopCurrency: "PKR",
      shopTimezone: "Asia/Karachi",
    });
  });

  it("stores null rather than a guess for anything missing or malformed", () => {
    expect(parseShopFacts({ shop: { name: " ", currencyCode: null, ianaTimezone: "Mars/Olympus" } })).toEqual({
      name: null,
      shopCurrency: null,
      shopTimezone: null,
    });
  });
});

describe("parseShopCountry", () => {
  it("takes the primary location's country", () => {
    expect(parseShopCountry({ location: { address: { countryCode: "PK" } } })).toBe("PK");
  });

  it("is null when the location or its country is missing", () => {
    expect(parseShopCountry({ location: null })).toBeNull();
    expect(parseShopCountry({ location: { address: { countryCode: "" } } })).toBeNull();
  });
});
