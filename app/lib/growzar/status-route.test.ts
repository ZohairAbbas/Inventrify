import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sign, signingPayload } from "./signing.server";

const count = vi.fn();
vi.mock("../../db.server", () => ({ default: { session: { count: (...args: unknown[]) => count(...args) } } }));

const { loader } = await import("../../routes/api.v1.growzar.status");

const SHOP = "acme.myshopify.com";
const PATH = `/api/v1/growzar/status?shop=${SHOP}`;
const saved = { ...process.env };

beforeEach(() => {
  process.env.GROWZAR_URL = "https://growzar.test";
  process.env.GROWZAR_PLATFORM_KEY = "pk";
  process.env.GROWZAR_SIGNING_SECRET = "secret";
  process.env.APP_VERSION = "abc1234";
  count.mockReset();
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
      capabilities: [],
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
});
