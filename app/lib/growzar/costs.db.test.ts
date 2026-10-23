/**
 * Setting Shopify's cost per item from Growzar's Books (G-INV-C1) against a real database,
 * with Shopify faked: the preview changes nothing, a confirm needs a fresh preview of its
 * own user, an Idempotency-Key writes once, other shops' variants are refused, and
 * throttling is retried with backoff and reported per item.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 */
import type { ActionFunctionArgs } from "@remix-run/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

// --- Fake Shopify ------------------------------------------------------------------------

type FakeVariant = { cost: string | null; status: string; sku: string };
let catalogue: Map<string, FakeVariant>;
let grantedScopes: string[];
let currency: string;
/** Mutations Shopify received, by inventory item id. */
let writes: { id: string; cost: string }[];
/** Variant ids whose next N mutations are throttled. */
let throttle: Map<string, number>;

const itemGid = (variantId: string) => `gid://shopify/InventoryItem/${variantId}9`;

async function graphql(query: string, { variables }: { variables: Record<string, unknown> }) {
  const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  if (query.includes("CostWriteScopes")) {
    return reply({ data: { currentAppInstallation: { accessScopes: grantedScopes.map((handle) => ({ handle })) } } });
  }
  if (query.includes("CostVariants")) {
    const nodes = (variables.ids as string[]).map((gid) => {
      const id = gid.split("/").pop()!;
      const v = catalogue.get(id);
      if (!v) return null;
      return {
        id: gid,
        title: "Red / M",
        sku: v.sku,
        product: { title: `Shirt ${id}`, status: v.status },
        inventoryItem: { id: itemGid(id), unitCost: v.cost === null ? null : { amount: v.cost } },
      };
    });
    return reply({ data: { shop: { currencyCode: currency }, nodes } });
  }
  if (query.includes("CostSet")) {
    const id = variables.id as string;
    const variantId = [...catalogue.keys()].find((v) => itemGid(v) === id)!;
    const left = throttle.get(variantId) ?? 0;
    if (left > 0) {
      throttle.set(variantId, left - 1);
      return reply({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] });
    }
    const cost = (variables.input as { cost: string }).cost;
    writes.push({ id, cost });
    catalogue.get(variantId)!.cost = cost;
    return reply({ data: { inventoryItemUpdate: { inventoryItem: { id }, userErrors: [] } } });
  }
  throw new Error(`unexpected query: ${query}`);
}

vi.mock("../../shopify.server", () => ({
  unauthenticated: { admin: async () => ({ admin: { graphql } }) },
}));

const { default: prisma } = await import("../../db.server");
const { purgeShopData } = await import("../shop-purge.server");
const { sign, signingPayload } = await import("./signing.server");
const { forgetCostWriteScopes } = await import("./costs.server");
const previewRoute = await import("../../routes/api.v1.growzar.costs.preview");
const confirmRoute = await import("../../routes/api.v1.growzar.costs.confirm");

const SHOP = "growzar-costs-test.myshopify.com";
const USER = "usr_7f3a";

process.env.GROWZAR_URL = "https://growzar.test";
process.env.GROWZAR_PLATFORM_KEY = "growzar-pk";
process.env.GROWZAR_SIGNING_SECRET = "growzar-secret";
process.env.FINANCIFY_PLATFORM_KEY = "financify-pk";
process.env.FINANCIFY_SIGNING_SECRET = "financify-secret";

const GROWZAR = { key: "growzar-pk", secret: "growzar-secret", prefix: "Growzar" };
const FINANCIFY = { key: "financify-pk", secret: "financify-secret", prefix: "Financify" };

type Action = (args: ActionFunctionArgs) => Promise<Response> | Response;

async function post(
  action: Action,
  path: string,
  payload: unknown,
  { as = GROWZAR, user = USER, key }: { as?: typeof GROWZAR; user?: string | null; key?: string } = {},
) {
  const body = JSON.stringify(payload);
  const timestamp = Date.now();
  const headers = new Headers({
    "Content-Type": "application/json",
    Authorization: `Bearer ${as.key}`,
    [`X-${as.prefix}-Shop`]: SHOP,
    [`X-${as.prefix}-Timestamp`]: String(timestamp),
    [`X-${as.prefix}-Signature`]: sign(as.secret, signingPayload({ timestamp, method: "POST", pathWithQuery: path, body })),
  });
  if (user) headers.set("X-Growzar-User", user);
  if (key) headers.set("Idempotency-Key", key);
  const response = await action({
    request: new Request(`http://localhost${path}`, { method: "POST", headers, body }),
    params: {},
    context: {},
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

const preview = (items: unknown[], opts?: Parameters<typeof post>[3]) =>
  post(previewRoute.action, "/api/v1/growzar/costs/preview", { items }, opts);
const confirm = (previewId: string, key: string, opts?: Parameters<typeof post>[3]) =>
  post(confirmRoute.action, "/api/v1/growzar/costs/confirm", { previewId }, { key, ...opts });
const pkr = (amount: string) => ({ amount, currency: "PKR" });

beforeEach(async () => {
  await purgeShopData(SHOP);
  forgetCostWriteScopes();
  await prisma.session.create({
    data: { id: `offline_${SHOP}`, shop: SHOP, state: "", isOnline: false, accessToken: "token" },
  });
  catalogue = new Map([
    ["701", { cost: "900.0", status: "ACTIVE", sku: "SH-R-M" }],
    ["702", { cost: null, status: "DRAFT", sku: "SH-B-M" }],
    ["703", { cost: "500.0", status: "ACTIVE", sku: "SH-G-M" }],
    ["704", { cost: "100.0", status: "ARCHIVED", sku: "SH-Y-M" }],
  ]);
  for (const id of catalogue.keys()) {
    await prisma.product.create({
      data: {
        id: `gid://shopify/ProductVariant/${id}`,
        shop: SHOP,
        productGid: `gid://shopify/Product/${id}0`,
        inventoryItemId: itemGid(id),
        title: `Shirt ${id}`,
        unitCost: Number(catalogue.get(id)!.cost ?? 0),
      },
    });
  }
  grantedScopes = ["write_products", "write_inventory"];
  currency = "PKR";
  writes = [];
  throttle = new Map();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const unitCost = async (id: string) =>
  (await prisma.product.findUniqueOrThrow({ where: { id: `gid://shopify/ProductVariant/${id}` } })).unitCost;

describe("POST /api/v1/growzar/costs/preview", () => {
  it("reports set, same and refused per item, and changes nothing", async () => {
    const res = await preview([
      { variantId: "701", cost: pkr("1250.5") },
      { variantId: "702", cost: pkr("300") },
      { variantId: "703", cost: pkr("500.00") },
      { variantId: "704", cost: pkr("120") },
      { variantId: "999", cost: pkr("10") },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.previewId).toEqual(expect.any(String));
    expect(new Date(res.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(res.body.items).toEqual([
      {
        variantId: "701", title: "Shirt 701", variantTitle: "Red / M", sku: "SH-R-M",
        current: pkr("900.00"), proposed: pkr("1250.50"), change: "set",
      },
      expect.objectContaining({ variantId: "702", current: null, proposed: pkr("300.00"), change: "set" }),
      expect.objectContaining({ variantId: "703", current: pkr("500.00"), change: "same" }),
      expect.objectContaining({ variantId: "704", change: "refused", reason: "archived" }),
      expect.objectContaining({ variantId: "999", title: null, current: null, change: "refused", reason: "not_found" }),
    ]);

    expect(writes).toEqual([]);
    expect(catalogue.get("701")!.cost).toBe("900.0");
    expect(await unitCost("701")).toBe(900);
    expect(await prisma.growzarCostWrite.count({ where: { shop: SHOP } })).toBe(0);
  });

  it("refuses a bad currency or amount per item", async () => {
    const res = await preview([
      { variantId: "701", cost: { amount: "10", currency: "AED" } },
      { variantId: "702", cost: pkr("-5") },
      { variantId: "703", cost: pkr("10.125") },
      { variantId: "704", cost: pkr("ten") },
    ]);
    expect(res.body.items.map((i: { reason: string }) => i.reason)).toEqual([
      "currency_mismatch", "negative_amount", "too_many_decimals", "invalid_amount",
    ]);
    // Trailing zeros are not extra decimals.
    const ok = await preview([{ variantId: "701", cost: pkr("10.500") }]);
    expect(ok.body.items[0]).toMatchObject({ change: "set", proposed: pkr("10.50") });
  });

  it("refuses a variant of another shop", async () => {
    // Shopify returns no node for an id the shop's token cannot see.
    const res = await preview([{ variantId: "555000111", cost: pkr("10") }]);
    expect(res.body.items[0]).toMatchObject({ change: "refused", reason: "not_found" });
  });

  it("refuses a variant Inventorify has archived", async () => {
    await prisma.product.update({ where: { id: "gid://shopify/ProductVariant/701" }, data: { isArchived: true } });
    const res = await preview([{ variantId: "701", cost: pkr("10") }]);
    expect(res.body.items[0]).toMatchObject({ change: "refused", reason: "archived" });
  });

  it("rejects a malformed body, a missing user and too many items", async () => {
    expect((await preview([{ variantId: 701, cost: pkr("1") }])).status).toBe(400);
    expect((await preview([{ variantId: "701", cost: { amount: 1, currency: "PKR" } }])).status).toBe(400);
    expect((await preview([{ variantId: "701", cost: pkr("1") }, { variantId: "701", cost: pkr("2") }])).status).toBe(400);
    expect((await preview([{ variantId: "701", cost: pkr("1") }], { user: null })).status).toBe(400);
    const many = Array.from({ length: 251 }, (_, i) => ({ variantId: String(1000 + i), cost: pkr("1") }));
    expect((await preview(many)).status).toBe(400);
  });

  it("is refused where the shop has not granted the write scopes", async () => {
    grantedScopes = ["write_products"];
    const res = await preview([{ variantId: "701", cost: pkr("10") }]);
    expect(res.status).toBe(403);
    expect(res.body.errorType).toBe("forbidden");
  });

  it("does not admit Financify's key", async () => {
    const res = await preview([{ variantId: "701", cost: pkr("10") }], { as: FINANCIFY });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/growzar/costs/confirm", () => {
  async function previewed() {
    const res = await preview([
      { variantId: "701", cost: pkr("1250.50") },
      { variantId: "702", cost: pkr("300") },
      { variantId: "703", cost: pkr("500") },
      { variantId: "704", cost: pkr("120") },
    ]);
    return res.body.previewId as string;
  }

  it("writes the set items to Shopify and Inventorify, and logs who, old and new", async () => {
    const previewId = await previewed();
    const res = await confirm(previewId, "key-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Idempotency-Replayed")).toBeNull();
    expect(res.body.items).toEqual([
      { variantId: "701", result: "set" },
      { variantId: "702", result: "set" },
    ]);
    expect(res.body.summary).toEqual({ set: 2, failed: 0 });
    expect(writes).toEqual([
      { id: itemGid("701"), cost: "1250.50" },
      { id: itemGid("702"), cost: "300.00" },
    ]);
    expect(await unitCost("701")).toBe(1250.5);
    expect(await unitCost("702")).toBe(300);
    expect(await unitCost("703")).toBe(500);

    const log = await prisma.growzarCostWrite.findMany({ where: { shop: SHOP }, orderBy: { variantId: "asc" } });
    expect(log.map((l) => [l.variantId, l.oldAmount?.toString() ?? null, l.newAmount.toString(), l.actor, l.result])).toEqual([
      ["gid://shopify/ProductVariant/701", "900", "1250.5", USER, "set"],
      ["gid://shopify/ProductVariant/702", null, "300", USER, "set"],
    ]);
  });

  it("writes once for the same Idempotency-Key and replays the first result", async () => {
    const previewId = await previewed();
    const first = await confirm(previewId, "key-1");
    const again = await confirm(previewId, "key-1");
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(writes).toHaveLength(2);
    expect(await prisma.growzarCostWrite.count({ where: { shop: SHOP } })).toBe(2);
  });

  it("refuses the same key for another preview, and a second key for a used preview", async () => {
    const previewId = await previewed();
    await confirm(previewId, "key-1");
    const other = await previewed();
    const conflict = await confirm(other, "key-1");
    expect(conflict.status).toBe(409);
    expect(conflict.body.errorType).toBe("idempotency_key_conflict");

    const reused = await confirm(previewId, "key-2");
    expect(reused.status).toBe(409);
    expect(reused.body.errorType).toBe("preview_already_confirmed");
    expect(writes).toHaveLength(2);
  });

  it("refuses a confirm without a preview, or with an expired one", async () => {
    const missing = await confirm("00000000-0000-0000-0000-000000000000", "key-1");
    expect(missing.status).toBe(404);
    expect(missing.body.errorType).toBe("not_found");

    const previewId = await previewed();
    await prisma.growzarCostPreview.update({ where: { id: previewId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await confirm(previewId, "key-2");
    expect(expired.status).toBe(422);
    expect(expired.body.errorType).toBe("preview_expired");
    expect(writes).toEqual([]);
  });

  it("refuses another user's preview, and a confirm without an Idempotency-Key", async () => {
    const previewId = await previewed();
    const stranger = await confirm(previewId, "key-1", { user: "usr_other" });
    expect(stranger.status).toBe(403);
    const noKey = await post(confirmRoute.action, "/api/v1/growzar/costs/confirm", { previewId });
    expect(noKey.status).toBe(400);
    expect(noKey.body.errorType).toBe("idempotency_key_required");
    expect(writes).toEqual([]);
    // Neither spent the preview.
    expect((await confirm(previewId, "key-1")).status).toBe(200);
  });

  it("refuses a preview of another shop", async () => {
    const other = await prisma.growzarCostPreview.create({
      data: { shop: "elsewhere.myshopify.com", actor: USER, currency: "PKR", items: [], expiresAt: new Date(Date.now() + 60_000) },
    });
    const res = await confirm(other.id, "key-1");
    expect(res.status).toBe(404);
    await prisma.growzarCostPreview.delete({ where: { id: other.id } });
  });

  it("fails an item whose Shopify cost changed since the preview", async () => {
    const previewId = await previewed();
    catalogue.get("701")!.cost = "950.0";
    const res = await confirm(previewId, "key-1");
    expect(res.body.items).toEqual([
      { variantId: "701", result: "failed", reason: "changed_since_preview" },
      { variantId: "702", result: "set" },
    ]);
    expect(await unitCost("701")).toBe(900);
  });

  it("retries throttling with backoff and reports a lasting throttle per item", async () => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    // Skip only graphqlWithRetry's backoff waits, recording them.
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (ms && ms >= 1000 && ms <= 8000) {
        delays.push(ms);
        return realSetTimeout(fn, 0);
      }
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);

    const previewId = await previewed();
    throttle.set("701", 2); // recovers on the third attempt
    throttle.set("702", 99); // never recovers
    const res = await confirm(previewId, "key-1");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { variantId: "701", result: "set" },
      expect.objectContaining({ variantId: "702", result: "failed", reason: "throttled" }),
    ]);
    expect(res.body.summary).toEqual({ set: 1, failed: 1 });
    expect(delays).toEqual(expect.arrayContaining([1000, 2000, 4000, 8000]));
    expect(writes).toEqual([{ id: itemGid("701"), cost: "1250.50" }]);
    expect(await unitCost("702")).toBe(0);
    const failed = await prisma.growzarCostWrite.findFirstOrThrow({ where: { shop: SHOP, result: "failed" } });
    expect(failed.reason).toMatch(/^throttled/);
  });
});
