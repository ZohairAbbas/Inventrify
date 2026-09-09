/**
 * Time-of-day greeting and the store name to address it to. Pure, so both are testable
 * without a clock or a database.
 */

/** Boundaries chosen so "morning" starts at 5am rather than midnight. */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  if (hour >= 17 && hour < 22) return "Good evening";
  return "Good evening";
}

/**
 * A displayable store name.
 *
 * Prefers the name Shopify reports, which is what the merchant actually calls their shop.
 * Until the first sync fills that in, fall back to de-slugging the myshopify domain —
 * "aziz-snowboards.myshopify.com" reads as "Aziz Snowboards", which is right often enough
 * to be better than showing a domain, and is never wrong in a damaging way.
 *
 * Returns null when neither yields anything, so callers can greet without a name rather
 * than addressing someone as "there".
 */
export function displayShopName(
  shopName: string | null | undefined,
  shopDomain: string,
): string | null {
  const given = (shopName ?? "").trim();
  if (given) return given;

  const slug = shopDomain.replace(/\.myshopify\.com$/i, "").trim();
  if (!slug) return null;

  const words = slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));

  return words.length > 0 ? words.join(" ") : null;
}
