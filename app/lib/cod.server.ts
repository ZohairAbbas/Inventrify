/**
 * Deciding whether an order is cash-on-delivery.
 *
 * The previous test was `gateway.includes("cod") || gateway.includes("cash")` against
 * the single legacy `gateway` field. That misses most real COD setups: Shopify populates
 * `payment_gateway_names` (an array) on modern orders, COD apps register gateways under
 * their own brand names ("Cash on Delivery (COD)" is the lucky case; "PostEx", "Bakkalim",
 * "Paiement a la livraison" are not), and localised storefronts name the gateway in the
 * local language. Under-detecting COD silently excluded those orders from the RTO maths,
 * which is the core of this product.
 *
 * Merchants can therefore declare their COD gateways explicitly in settings; the
 * heuristic is only a fallback for shops that have not configured anything yet.
 */

const COD_HINTS = [
  "cod",
  "cash on delivery",
  "cash_on_delivery",
  "cash-on-delivery",
  "cashondelivery",
  "collect on delivery",
  "postpaid",
  // Common non-English namings in Inventorify's markets.
  "paiement a la livraison",
  "paiement à la livraison",
  "الدفع عند الاستلام",
  "نقدا عند الاستلام",
  "kapida odeme",
  "kapıda ödeme",
];

/** Gateway names the merchant explicitly marked as COD, parsed from settings. */
export function parseCodGateways(configured: string | null | undefined): string[] {
  if (!configured) return [];
  return configured
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
}

export interface OrderPaymentShape {
  gateway?: string | null;
  payment_gateway_names?: string[] | null;
  financial_status?: string | null;
}

/**
 * `configuredGateways` wins when non-empty — an explicit merchant statement is always
 * more reliable than string matching. Otherwise fall back to hint matching across every
 * gateway name Shopify reports.
 */
export function isCodOrder(
  order: OrderPaymentShape,
  configuredGateways: string[] = [],
): boolean {
  const names = [
    ...(order.payment_gateway_names ?? []),
    ...(order.gateway ? [order.gateway] : []),
  ]
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .map((n) => n.toLowerCase().trim());

  if (names.length === 0) return false;

  if (configuredGateways.length > 0) {
    return names.some((n) => configuredGateways.includes(n));
  }

  return names.some((n) => COD_HINTS.some((hint) => hint.length > 2 && n.includes(hint)));
}
