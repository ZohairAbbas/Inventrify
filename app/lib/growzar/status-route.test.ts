import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sign, signingPayload } from "./signing.server";

const count = vi.fn();
vi.mock("../../db.server", () => ({ default: { session: { count: (...args: unknown[]) => count(...args) } } }));
// The live scope check behind `costs:write`: Shopify answers with the granted handles.
const scopes = vi.fn();
const graphql = vi.fn(async () =>
  new Response(JSON.stringify({ data: { currentAppInstallation: { accessScopes: (await scopes()).map((handle: string) => ({ handle })) } } })),
);
vi.mock("../../shopify.server", () => ({ unauthenticated: { admin: async () => ({ admin: { graphql } }) } }));

const { loader } = await import("../../routes/api.v1.growzar.status");
const { GROWZAR_CAPABILITIES } = await import("./feed.server");
const { forgetCostWriteScopes } = await import("./costs.server");

const SHOP = "acme.myshopify.com";
const PATH = `/api/v1/growzar/status?shop=${SHOP}`;
const saved = { ...process.env };

beforeEach(() => {
  process.env.GROWZAR_URL = "https://growzar.test";
  process.env.GROWZAR_PLATFORM_KEY = "pk";
  process.env.GROWZAR_SIGNING_SECRET = "secret";
  process.env.APP_VERSION = "abc1234";
  count.mockReset();
  graphql.mockClear();
  scopes.mockReset().mockResolvedValue(["read_products", "write_products", "read_inventory"]);
  forgetCostWriteScopes();
});
afterEach(() => {
  process.env = { ...saved };
});

function request(signed: boolean) {
  const timestamp = Date.now();
  const headers = new Headers({ Authorization: "Bearer pk", "X-Growzar-Shop": SHOP });
  if (signed) {
    headers.set("X-Growzar-Timestamp", String(timestamp));
    headers.set("X-Growzar-Signature", sign("secret", signingPayload({ timestamp, method: "GET", pathWithQuery: PATH, body: "" })));
  }
  return new Request(`http://localhost:3016${PATH}`, { headers });
}

const call = (req: Request) => loader({ request: req, params: {}, context: {} }) as Promise<Response>;

describe("GET /api/v1/growzar/status", () => {
  it("returns the §11 shape for an installed shop", async () => {
    count.mockResolvedValue(1);
    const response = await call(request(true));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual({
      installed: true,
      appVersion: "abc1234",
      shop: SHOP,
      capabilities: GROWZAR_CAPABILITIES,
      planRelevantFeatures: [],
    });
    expect(count).toHaveBeenCalledWith({ where: { shop: SHOP, isOnline: false } });
  });

  it("reports installed: false when there is no offline session", async () => {
    count.mockResolvedValue(0);
    expect((await (await call(request(true))).json()).installed).toBe(false);
  });

  it("returns 401 to an unsigned request with a valid bearer key, without touching the DB", async () => {
    const response = await call(request(false));
    expect(response.status).toBe(401);
    expect(count).not.toHaveBeenCalled();
  });

  it("adds costs:write where Shopify confirms both write scopes, and caches the answer", async () => {
    count.mockResolvedValue(1);
    scopes.mockResolvedValue(["write_products", "write_inventory", "read_orders"]);
    const body = await (await call(request(true))).json();
    expect(body.capabilities).toEqual([...GROWZAR_CAPABILITIES, "costs:write"]);
    await call(request(true));
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("leaves costs:write out when write_inventory is missing", async () => {
    count.mockResolvedValue(1);
    expect((await (await call(request(true))).json()).capabilities).toEqual(GROWZAR_CAPABILITIES);
  });

  it("leaves costs:write out, without asking Shopify, when the shop is not installed", async () => {
    count.mockResolvedValue(0);
    expect((await (await call(request(true))).json()).capabilities).toEqual(GROWZAR_CAPABILITIES);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("leaves costs:write out when Shopify cannot be asked", async () => {
    count.mockResolvedValue(1);
    scopes.mockRejectedValue(new Error("network down"));
    expect((await (await call(request(true))).json()).capabilities).toEqual(GROWZAR_CAPABILITIES);
  });
});
