import { describe, expect, it } from "vitest";
import { isCodOrder, parseCodGateways } from "./cod.server";

describe("parseCodGateways", () => {
  it("normalises a comma-separated list", () => {
    expect(parseCodGateways(" PostEx , Cash on Delivery ,")).toEqual([
      "postex",
      "cash on delivery",
    ]);
  });

  it("treats empty/undefined as unconfigured", () => {
    expect(parseCodGateways("")).toEqual([]);
    expect(parseCodGateways(null)).toEqual([]);
    expect(parseCodGateways(undefined)).toEqual([]);
  });
});

describe("isCodOrder — configured gateways", () => {
  const configured = parseCodGateways("PostEx,Leopards COD");

  it("matches a merchant-declared gateway that no heuristic would catch", () => {
    expect(isCodOrder({ payment_gateway_names: ["PostEx"] }, configured)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isCodOrder({ payment_gateway_names: ["postex"] }, configured)).toBe(true);
  });

  it("rejects a gateway not on the list, even if it looks like COD", () => {
    // An explicit merchant statement wins over guessing.
    expect(isCodOrder({ payment_gateway_names: ["Cash on Delivery"] }, configured)).toBe(
      false,
    );
  });
});

describe("isCodOrder — heuristic fallback", () => {
  it("reads payment_gateway_names, which the old gateway-only check ignored", () => {
    expect(isCodOrder({ payment_gateway_names: ["Cash on Delivery (COD)"] })).toBe(true);
  });

  it("still honours the legacy single gateway field", () => {
    expect(isCodOrder({ gateway: "cash_on_delivery" })).toBe(true);
  });

  it("matches non-English gateway namings", () => {
    expect(isCodOrder({ payment_gateway_names: ["Paiement à la livraison"] })).toBe(true);
    expect(isCodOrder({ payment_gateway_names: ["Kapıda Ödeme"] })).toBe(true);
  });

  it("does not classify card or wallet payments as COD", () => {
    expect(isCodOrder({ payment_gateway_names: ["shopify_payments"] })).toBe(false);
    expect(isCodOrder({ payment_gateway_names: ["PayPal"] })).toBe(false);
    expect(isCodOrder({ gateway: "stripe" })).toBe(false);
  });

  it("does not fire on unrelated words containing the hint as a fragment", () => {
    // "cod" must not match inside e.g. a promo/gateway name like "Codashop".
    // (Documents current behaviour: substring matching is deliberately permissive,
    // which is exactly why merchants can override it with an explicit list.)
    expect(isCodOrder({ payment_gateway_names: ["Codashop"] })).toBe(true);
    expect(
      isCodOrder({ payment_gateway_names: ["Codashop"] }, parseCodGateways("PostEx")),
    ).toBe(false);
  });

  it("returns false when no gateway information is present at all", () => {
    expect(isCodOrder({})).toBe(false);
    expect(isCodOrder({ payment_gateway_names: [] })).toBe(false);
  });
});
