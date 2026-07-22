import prisma from "../db.server";

// Configurable per environment, like COURIERIFY_BASE_URL. The host was previously
// hardcoded, so there was no way to point staging at anything but production.
const FINANCIFY_BASE = (
  process.env.FINANCIFY_BASE_URL || "https://api.financify.app"
).replace(/\/$/, "");

interface MarginEntry {
  sku: string;
  margin: number;
  /** Landed unit cost, when Financify knows it. */
  unitCost?: number | null;
}

/**
 * Pull per-SKU margins — and unit cost where available — from Financify.
 *
 * Unit cost matters beyond reporting: it is what makes inventory value, capital tied up
 * in dead stock, and revenue-at-risk alert ranking possible. Without it those all
 * degrade to zero rather than to a guess.
 */
export async function syncFinancifyMargins(
  shop: string,
  apiKey: string,
): Promise<{ synced: number; unmatched?: number; error?: string }> {
  try {
    const response = await fetch(`${FINANCIFY_BASE}/v1/sku-margins`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ shop }),
    });

    if (!response.ok) {
      return { synced: 0, error: `Financify API error: ${response.status}` };
    }

    const body = (await response.json().catch(() => null)) as
      | MarginEntry[]
      | { rows?: MarginEntry[] }
      | null;
    const data: MarginEntry[] = Array.isArray(body) ? body : (body?.rows ?? []);

    let synced = 0;
    let unmatched = 0;

    for (const entry of data) {
      if (!entry.sku) continue;
      const updated = await prisma.product.updateMany({
        where: { shop, sku: entry.sku },
        data: {
          avgMargin: entry.margin,
          ...(entry.unitCost != null && entry.unitCost >= 0
            ? { unitCost: entry.unitCost }
            : {}),
        },
      });
      if (updated.count === 0) unmatched += 1;
      synced += updated.count;
    }

    return { synced, unmatched };
  } catch (err) {
    return {
      synced: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
